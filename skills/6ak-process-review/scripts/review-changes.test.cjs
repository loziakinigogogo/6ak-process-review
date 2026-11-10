#!/usr/bin/env node
'use strict';

// Permanent tooling regression. Every write is confined to a disposable synthetic task.
// Run: node --test skills/6ak-process-review/scripts/review-changes.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const store = require('./grouped-review-store.cjs');
const { buildReviewChanges } = require('./review-changes.cjs');
const { digest } = require('./index-sources.cjs');
const { buildProcessGroups } = require('./process-review-view.cjs');

const fixture = () => JSON.parse(fs.readFileSync(path.resolve(__dirname, '../examples/messy-pricing.model.json'), 'utf8'));
const claim = (model, id) => model.claims.find(entry => entry.id === id);
const next = model => { const copy = structuredClone(model); copy.report.version = String(Number(model.report.version) + 1); return copy; };
const key = target => target.type + ':' + target.id;

function temporary(t) {
  const root = process.env.PRICING_QA_DIR ? path.resolve(process.env.PRICING_QA_DIR) : path.join(os.tmpdir(), 'pricing-review-changes');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'run-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), root);
    assert.match(path.basename(directory), /^run-/);
    assert.equal(fs.realpathSync(directory), path.resolve(directory));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return directory;
}

function start(t, model = fixture()) {
  const task = temporary(t);
  store.publish(task, 0, model, { layout: 'process' });
  return task;
}

function save(task, itemId = 'node.calculate.claim.calculate', text = '请核对并调整这一句。') {
  const revision = store.readRevision(task);
  const group = revision.groups.find(entry => entry.items.some(item => item.view.id === itemId));
  assert.ok(group);
  const input = { id: randomUUID(), revision: revision.revision, comments: [{
    id: randomUUID(), groupId: group.id, itemId, text, tags: ['rewrite'],
  }] };
  store.saveBatch(task, input);
  return input;
}

function outcome(batch, fields = {}) {
  return { batchId: batch.id, commentId: batch.comments[0].id, status: 'applied',
    summary: '合成测试已核对。', groupIds: ['price-change'], ...fields };
}

function publishedComment(task, batch) {
  const response = store.reviewResponse(task);
  return response.batches.find(entry => entry.id === batch.id).comments[0];
}

function removeClaim(model, id) {
  model.claims = model.claims.filter(entry => entry.id !== id);
  for (const entry of model.claims) if (entry.premiseIds) entry.premiseIds = entry.premiseIds.filter(value => value !== id);
  for (const node of model.nodes) {
    node.claimIds = node.claimIds.filter(value => value !== id);
    for (const field of Object.keys(node.fields)) node.fields[field] = node.fields[field].filter(value => value !== id);
  }
  for (const coverage of model.coverage) coverage.claimIds = coverage.claimIds.filter(value => value !== id);
}

function replaceDirectEvidence(model, claimId) {
  const evidence = claim(model, claimId).evidence[0];
  const sourceId = 'replacement-' + claimId;
  const text = evidence.quote + '\n';
  model.sources.push({ id: sourceId, name: 'replacement.md', text, sha256: digest(text) });
  claim(model, claimId).evidence = [{ sourceId, startLine: 1, endLine: 1, quote: evidence.quote }];
  model.coverage.push({ sourceId, startLine: 1, endLine: 1, disposition: 'represented', claimIds: [claimId], issueIds: [], reason: '独立证据变动夹具。' });
}

test('one changed claim is counted once and retains all concrete process locations', () => {
  const before = fixture();
  const extra = before.nodes.find(node => node.id === 'submit');
  extra.claimIds.push('calculate');
  extra.fields.input.push('calculate');
  const after = next(before);
  claim(after, 'calculate').text = '调整后的合成核算句。';
  const changes = buildReviewChanges(before, after, buildProcessGroups(after));
  assert.equal(changes.contentChanges.length, 1);
  const change = changes.contentChanges[0];
  assert.equal(key(change.target), 'claim:calculate');
  assert.equal(change.id, 'claim:calculate');
  assert.equal(change.kind, 'modified');
  assert.equal(change.before, claim(before, 'calculate').text);
  assert.equal(change.after, claim(after, 'calculate').text);
  assert.deepEqual(change.locations.map(location => location.itemId).sort(), [
    'node.calculate.claim.calculate', 'node.submit.claim.calculate',
  ]);
  assert.deepEqual(change.locations.map(location => location.stepTitle).sort(), ['录入渠道后台', '核算目标价']);
  assert.ok(change.locations.every(location => location.groupId === 'price-change' && location.stepId));
});

test('equal wording on different claim IDs remains two independently reviewable changes', () => {
  const before = fixture();
  claim(before, 'operator').text = claim(before, 'calculate').text;
  const after = next(before);
  for (const id of ['operator', 'calculate']) claim(after, id).text = '完全相同的新表述。';
  const changes = buildReviewChanges(before, after);
  assert.deepEqual(changes.contentChanges.map(change => key(change.target)).sort(), ['claim:calculate', 'claim:operator']);
  assert.ok(changes.contentChanges.every(change => change.after === '完全相同的新表述。'));
});

test('parent metadata and neighbouring claim edits do not mark an unchanged sentence or its evidence', () => {
  const before = fixture();
  const after = next(before);
  after.nodes.find(node => node.id === 'calculate').title = '重新命名的核算步骤';
  claim(after, 'operator').text = '仅调整旁侧角色表述。';
  const changes = buildReviewChanges(before, after);
  assert.ok(changes.contentChanges.some(change => key(change.target) === 'node:calculate'));
  assert.ok(changes.contentChanges.some(change => key(change.target) === 'claim:operator'));
  assert.ok(![...changes.contentChanges, ...changes.evidenceChanges].some(change => key(change.target) === 'claim:calculate'));
});

test('a direct evidence edit has its own category and does not inflate content changes', () => {
  const before = fixture();
  const after = next(before);
  replaceDirectEvidence(after, 'calculate');
  const changes = buildReviewChanges(before, after);
  assert.deepEqual(changes.contentChanges, []);
  assert.deepEqual(changes.evidenceChanges.map(change => key(change.target)), ['claim:calculate']);
  assert.equal(changes.evidenceChanges[0].locations[0].itemId, 'node.calculate.claim.calculate');
});

test('a removed sentence preserves its prior text and exposes no current jump location', () => {
  const before = fixture();
  const after = next(before);
  removeClaim(after, 'operator');
  const changes = buildReviewChanges(before, after);
  const removed = changes.contentChanges.find(change => key(change.target) === 'claim:operator');
  assert.ok(removed);
  assert.equal(removed.kind, 'removed');
  assert.equal(removed.before, claim(before, 'operator').text);
  assert.equal(removed.after, null);
  assert.deepEqual(removed.locations, []);
});

test('stored process projections and plain process projections produce the same reader-facing changes', t => {
  const before = fixture();
  const task = start(t, before);
  const after = next(before);
  claim(after, 'calculate').text = '存储投影与普通投影使用同一项。';
  store.publish(task, 1, after, { layout: 'process' });
  const stored = store.readRevision(task);
  assert.deepEqual(buildReviewChanges(before, after, stored.groups), buildReviewChanges(before, after, buildProcessGroups(after)));
  const response = store.reviewResponse(task);
  assert.deepEqual(response.contentChanges, buildReviewChanges(before, after).contentChanges);
  assert.deepEqual(response.evidenceChanges, buildReviewChanges(before, after).evidenceChanges);
});

test('legacy outcomes resolve against the processing revision and report later edits and removal honestly', t => {
  const before = fixture();
  const task = start(t, before);
  const batch = save(task);
  const processed = next(before);
  claim(processed, 'calculate').text = '本批处理时采用的表述。';
  store.publish(task, 1, processed, { layout: 'process' }, [outcome(batch)]);
  const first = publishedComment(task, batch);
  assert.equal(first.outcome.mappingSource, 'derived');
  assert.equal(first.resultChanges.length, 1);
  assert.equal(first.resultChanges[0].outcomeRevision, 2);
  assert.equal(first.resultChanges[0].state, 'current');
  const later = next(processed);
  claim(later, 'calculate').text = '后来另一轮再次修改的表述。';
  store.publish(task, 2, later, { layout: 'process' });
  const changed = publishedComment(task, batch).resultChanges[0];
  assert.equal(changed.state, 'changed');
  assert.equal(changed.outcomeRevision, 2);
  assert.equal(changed.before, claim(before, 'calculate').text);
  assert.equal(changed.after, claim(processed, 'calculate').text);
  assert.equal(changed.currentText, claim(later, 'calculate').text);
  const removed = next(later);
  removeClaim(removed, 'calculate');
  store.publish(task, 3, removed, { layout: 'process' });
  const gone = publishedComment(task, batch).resultChanges[0];
  assert.equal(gone.state, 'removed');
  assert.deepEqual(gone.locations, []);
  assert.equal(gone.after, claim(processed, 'calculate').text);
});

test('legacy feedback provenance maps new claims without treating other changes in the same group as results', t => {
  const before = fixture();
  const task = start(t, before);
  const feedback = '17:30 发送调数通知。\r\n随后合并操作。';
  const batch = save(task, 'node.calculate', feedback);
  const processed = next(before);
  const sourceText = feedback.replace(/\r\n/g, '\n');
  processed.sources.push({ id: 'feedback-exact', kind: 'user-feedback', name: '本批补充', text: sourceText, sha256: digest(sourceText) });
  processed.claims.push({ id: 'feedback-time', text: '17:30 发送调数通知。', origin: 'explicit', evidence: [
    { sourceId: 'feedback-exact', startLine: 1, endLine: 1, quote: '17:30 发送调数通知。' },
  ] });
  processed.nodes[0].claimIds.push('feedback-time');
  processed.nodes[0].fields.actions.push('feedback-time');
  processed.coverage.push({ sourceId: 'feedback-exact', startLine: 1, endLine: 2, disposition: 'represented', claimIds: ['feedback-time'], issueIds: [], reason: '合成来源。' });
  claim(processed, 'check').text = '同组另一条无关的修改。';
  store.publish(task, 1, processed, { layout: 'process' }, [outcome(batch)]);
  const record = publishedComment(task, batch);
  assert.equal(record.outcome.mappingSource, 'derived');
  assert.deepEqual(record.resultChanges.map(change => key(change.target)), ['claim:feedback-time']);
});

test('legacy group-only outcomes without a provable result do not invent a link to unrelated changes', t => {
  const before = fixture();
  const task = start(t, before);
  const batch = save(task, 'node.calculate');
  const processed = next(before);
  claim(processed, 'check').text = '这里只调整同组另一节点。';
  store.publish(task, 1, processed, { layout: 'process' }, [outcome(batch)]);
  const record = publishedComment(task, batch);
  assert.equal(record.outcome.mappingSource, 'unavailable');
  assert.deepEqual(record.resultChanges, []);
});

test('legacy direct-evidence-only results remain traceable without becoming wording changes', t => {
  const before = fixture();
  const task = start(t, before);
  const batch = save(task);
  const processed = next(before);
  replaceDirectEvidence(processed, 'calculate');
  store.publish(task, 1, processed, { layout: 'process' }, [outcome(batch)]);
  const response = store.reviewResponse(task);
  assert.deepEqual(response.contentChanges, []);
  assert.deepEqual(response.evidenceChanges.map(change => key(change.target)), ['claim:calculate']);
  const record = publishedComment(task, batch);
  assert.equal(record.outcome.mappingSource, 'derived');
  assert.deepEqual(record.resultChanges.map(change => key(change.target)), ['claim:calculate']);
  assert.equal(record.resultChanges[0].state, 'current');
});

test('identical feedback text in one processing round needs unique source attribution before assigning new results', t => {
  for (const uniqueSources of [false, true]) {
    const before = fixture();
    const task = start(t, before);
    const feedback = '两个对象分别补充一项说明。';
    const batch = { id: randomUUID(), revision: 1, comments: ['node.calculate', 'node.check'].map(itemId => ({
      id: randomUUID(), groupId: 'price-change', itemId, text: feedback, tags: ['supplement'],
    })) };
    store.saveBatch(task, batch);
    const processed = next(before);
    for (let index = 0; index < batch.comments.length; index++) {
      const comment = batch.comments[index];
      const sourceId = uniqueSources ? 'feedback-' + comment.id : 'feedback-shared';
      if (!processed.sources.some(source => source.id === sourceId)) {
        processed.sources.push({ id: sourceId, name: sourceId, kind: 'user-feedback', text: feedback, sha256: digest(feedback) });
        processed.coverage.push({ sourceId, startLine: 1, endLine: 1, disposition: 'represented', claimIds: [], issueIds: [], reason: '同原话归属夹具。' });
      }
      const id = 'new-result-' + index;
      processed.claims.push({ id, text: '对象 ' + index + ' 的新增说明。', origin: 'explicit', evidence: [
        { sourceId, startLine: 1, endLine: 1, quote: feedback },
      ] });
      const node = processed.nodes.find(node => 'node.' + node.id === comment.itemId);
      node.claimIds.push(id); node.fields.actions.push(id);
      processed.coverage.find(entry => entry.sourceId === sourceId).claimIds.push(id);
    }
    store.publish(task, 1, processed, { layout: 'process' }, batch.comments.map(comment => ({
      batchId: batch.id, commentId: comment.id, status: 'applied', summary: '合成补充已处理。', groupIds: ['price-change'],
    })));
    const records = store.reviewResponse(task).batches.find(entry => entry.id === batch.id).comments;
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      assert.deepEqual(record.resultChanges.map(change => key(change.target)), uniqueSources ? ['claim:new-result-' + index] : []);
      if (!uniqueSources) assert.equal(record.outcome.mappingIncomplete, true, 'Ambiguous identical text must be disclosed, not guessed');
    }
  }
});

test('explicit targets reject absent, unchanged, duplicate, and malformed objects without publishing', t => {
  const before = fixture();
  const task = start(t, before);
  const batch = save(task);
  const processed = next(before);
  claim(processed, 'calculate').text = '合法的本轮实际修改。';
  const invalid = [
    [{ type: 'claim', id: 'missing-object' }],
    [{ type: 'claim', id: 'operator' }],
    [{ type: 'claim', id: 'calculate' }, { type: 'claim', id: 'calculate' }],
    [{ type: 'source', id: 'source-1' }],
    [{ type: 'claim', id: '../calculate' }],
  ];
  for (const changeTargets of invalid) {
    assert.throws(() => store.publish(task, 1, processed, { layout: 'process' }, [outcome(batch, { changeTargets })]), undefined, JSON.stringify(changeTargets));
    assert.equal(store.readRevision(task).revision, 1);
  }
  store.publish(task, 1, processed, { layout: 'process' }, [outcome(batch, { changeTargets: [{ type: 'claim', id: 'calculate' }] })]);
  const record = publishedComment(task, batch);
  assert.equal(record.outcome.mappingSource, 'explicit');
  assert.deepEqual(record.resultChanges.map(change => key(change.target)), ['claim:calculate']);
});

test('explicit removal is a valid result and its terminal mapping cannot be rewritten later', t => {
  const before = fixture();
  const task = start(t, before);
  const batch = save(task, 'node.calculate.claim.operator');
  const processed = next(before);
  removeClaim(processed, 'operator');
  const result = outcome(batch, { changeTargets: [{ type: 'claim', id: 'operator' }] });
  store.publish(task, 1, processed, { layout: 'process' }, [result]);
  const record = publishedComment(task, batch).resultChanges[0];
  assert.equal(record.kind, 'removed');
  assert.equal(record.state, 'removed');
  assert.deepEqual(record.locations, []);
  const later = next(processed);
  claim(later, 'calculate').text = '后续修改。';
  assert.throws(() => store.publish(task, 2, later, { layout: 'process' }, [outcome(batch, { changeTargets: [{ type: 'claim', id: 'calculate' }] })]));
  assert.equal(store.readRevision(task).revision, 2);
});
