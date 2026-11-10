'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { buildProcessGroups } = require('./process-review-view.cjs');
const { publish, readRevision, saveBatch, pending } = require('./grouped-review-store.cjs');

function fixture() {
  const model = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/messy-pricing.model.json'), 'utf8'));
  model.groups.push({ id: 'other', title: '后续核验', kind: 'editorial', claimIds: [] });
  model.nodes.find(node => node.id === 'check').groupId = 'other';
  model.issues[0].nodeIds = ['submit', 'calculate', 'check'];
  return model;
}

function temporary(t) {
  const root = path.resolve(process.env.PRICING_QA_DIR || path.join(os.tmpdir(), 'pricing-review-projection'));
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'issue-alias-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), root);
    assert.ok(path.basename(directory).startsWith('issue-alias-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('a multi-step issue is visible at every affected step with unique IDs and one business target', () => {
  const model = fixture(), before = JSON.stringify(model);
  const items = buildProcessGroups(model).flatMap(group => group.items);
  const issues = items.filter(item => item.target.type === 'issue' && item.target.id === 'threshold-conflict');
  assert.equal(issues.length, 3);
  assert.deepEqual(new Set(issues.map(item => item.presentation.parentId)), new Set(['node.submit', 'node.calculate', 'node.check']));
  assert.equal(new Set(items.map(item => item.id)).size, items.length, 'Every generated DOM anchor has a distinct item ID');
  const canonical = issues.find(item => item.id === 'issue.threshold-conflict');
  assert.deepEqual(canonical, {
    id: 'issue.threshold-conflict', target: { type: 'issue', id: 'threshold-conflict' },
    presentation: { parentId: 'node.submit' },
  });
  for (const alias of issues.filter(item => item !== canonical)) {
    assert.equal(alias.presentation.canonicalItemId, canonical.id);
    assert.deepEqual(alias.target, canonical.target);
  }
  assert.equal(JSON.stringify(model), before, 'Projection does not edit the business model');
});

test('single-step, relation, inferred-owner and unplaced issue identities stay compatible', () => {
  const model = fixture();
  model.issues[0].nodeIds = [];
  model.issues[0].relationIds = ['calculate-submit', 'submit-check'];
  model.issues[1].nodeIds = [];
  let items = buildProcessGroups(model).flatMap(group => group.items);
  assert.deepEqual(items.find(item => item.id === 'issue.threshold-conflict').presentation, { parentId: 'relation.calculate-submit' });
  assert.deepEqual(items.find(item => item.id === 'issue.mismatch-missing').presentation, { parentId: 'node.check' });
  model.issues[0].relationIds = [];
  const groups = buildProcessGroups(model);
  assert.equal(groups.find(group => group.id === 'review.unplaced').items.find(item => item.id === 'issue.threshold-conflict').target.id, 'threshold-conflict');
  model.issues[0].nodeIds = ['submit'];
  items = buildProcessGroups(model).flatMap(group => group.items);
  assert.equal(items.filter(item => item.target.id === 'threshold-conflict').length, 1);
});

test('legacy issue fingerprints and comments survive aliases and unchanged releases', t => {
  const task = temporary(t), model = fixture();
  publish(task, 0, model, { layout: 'process' });
  const first = readRevision(task);
  const locations = first.groups.flatMap(group => group.items.map(item => ({ group, item })));
  const canonical = locations.find(({ item }) => item.view.id === 'issue.threshold-conflict');
  // Captured from this fixture before multi-step issue aliases were introduced.
  assert.equal(canonical.item.fingerprint, '8a7052855d2ab71364f7ede209c65a436a4a751b1beef33b8ef3d269ef53e603');
  const alias = locations.find(({ item }) => item.view.id === 'node.check.issue.threshold-conflict');
  const batchId = randomUUID();
  saveBatch(task, {
    id: batchId, revision: 1,
    comments: [canonical, alias].map(({ group, item }) => ({
      id: randomUUID(), groupId: group.id, itemId: item.view.id, tags: ['unknown'], text: '待业务确认',
    })),
  });
  let comments = pending(task).batches.find(batch => batch.id === batchId).comments;
  assert.ok(comments.every(comment => comment.targetState === 'current'));
  assert.ok(comments.every(comment => comment.target.type === 'issue' && comment.target.id === 'threshold-conflict'));
  assert.notEqual(comments[0].itemId, comments[1].itemId, 'The selected reading location is retained');
  model.report.version = '2';
  publish(task, 1, model, { layout: 'process' });
  comments = pending(task).batches.find(batch => batch.id === batchId).comments;
  assert.ok(comments.every(comment => comment.targetState === 'unchanged'));
  model.issues[0].question += '请核对适用通道。';
  publish(task, 2, model, { layout: 'process' });
  comments = pending(task).batches.find(batch => batch.id === batchId).comments;
  assert.ok(comments.every(comment => comment.targetState === 'changed'), 'Changing the shared issue invalidates both occurrence snapshots');
});

// A minimal DOM is sufficient to exercise pure index selection and change text.
// Interaction, actual DOM layout and drawer navigation are browser-check scope.
function browserLogic() {
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; }
    set textContent(value) { this.children = [String(value)]; }
    get textContent() { return this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    append(...children) { this.children.push(...children); }
    addEventListener() {}
  }
  const elements = new Map();
  const context = vm.createContext({
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
      createElement: tag => new Element(tag), addEventListener() {},
    },
    window: { addEventListener() {} },
    setInterval() {},
    fetch: () => new Promise(() => {}),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/grouped-review/review.js'), 'utf8'), context);
  return context;
}

test('the open-issue index counts business issues once and prefers the original anchor', () => {
  const context = browserLogic();
  context.groups = [
    { id: 'first', items: [
      { id: 'node.a.issue.shared', canonicalItemId: 'issue.shared', type: 'issue', status: 'open' },
      { id: 'issue.distinct', type: 'issue', status: 'open' },
    ] },
    { id: 'second', items: [{ id: 'issue.shared', type: 'issue', status: 'open' }] },
    { id: 'third', items: [{ id: 'node.c.issue.shared', canonicalItemId: 'issue.shared', type: 'issue', status: 'open' }] },
    { id: 'closed', items: [{ id: 'issue.resolved', type: 'issue', status: 'resolved' }] },
  ];
  const index = vm.runInContext('openIssueLocations(groups)', context);
  assert.equal(index.length, 2);
  assert.equal(index[0].group.id, 'second');
  assert.equal(index[0].item.id, 'issue.shared');
  assert.equal(index[1].item.id, 'issue.distinct');
  context.groups.splice(1, 1);
  assert.equal(vm.runInContext('openIssueLocations(groups)', context).length, 2, 'An alias remains navigable when no original occurrence is present');
});

test('context-only revision changes show safe explanatory text and link to the current item', () => {
  const context = browserLogic();
  context.groups = [{ id: 'g', items: [{ id: 'node.a.claim.fact', text: '当前陈述' }] }];
  context.changes = [{ kind: 'context', groupId: 'g', itemId: 'node.a.claim.fact', summary: '<img src=x onerror=alert(1)> 原文依据已更新' }];
  const result = vm.runInContext('review = { groups }; renderChanges(changes, groups[0])', context);
  assert.match(result.textContent, /依据或上下文已更新/);
  assert.match(result.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(result.textContent, /修改前|修改后|undefined/);
  const descendants = element => element.children.filter(child => typeof child !== 'string').flatMap(child => [child, ...descendants(child)]);
  const children = descendants(result);
  assert.equal(children.filter(child => child.tagName === 'IMG').length, 0);
  assert.equal(children.find(child => child.tagName === 'A').href, '#item-node.a.claim.fact');
});
