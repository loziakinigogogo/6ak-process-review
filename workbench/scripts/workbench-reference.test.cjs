'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStore } = require('./workbench-store.cjs');
const { createDemoModel, createDemoPositions } = require('./workbench-demo-fixture.cjs');

const qaRoot = path.resolve(__dirname, '../../.qa');
function setup(t) {
  fs.mkdirSync(qaRoot, { recursive: true });
  const task = fs.mkdtempSync(path.join(qaRoot, 'workbench-reference-'));
  t.after(() => {
    const resolved = path.resolve(task);
    assert.ok(resolved.startsWith(qaRoot + path.sep), 'test cleanup remains within .qa');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { task, store: createStore(task, { model: createDemoModel(), positions: createDemoPositions() }) };
}
function guard(store, values = {}) {
  const state = store.read();
  return { baseWorkRevision: state.workRevision, baseModelHash: state.modelHash, ...values };
}
const selectedNode = [{ type: 'node', id: 'validate' }];
const getClaim = (state, id) => state.model.claims.find(item => item.id === id);

test('node selection keeps exact committed text, source evidence, and a portable AgentApp handoff', t => {
  const { task, store } = setup(t);
  const state = store.read();
  const claim = getClaim(state, 'validate-actions');
  const selection = { claimId: claim.id, text: claim.text.slice(0, Math.max(1, claim.text.length - 1)) };
  const saved = store.createReference(guard(store, { targets: selectedNode, selection }));
  assert.equal(saved.taskDirectory, task);
  assert.equal(saved.taskId, state.taskId);
  assert.equal(saved.workRevision, state.workRevision);
  assert.equal(saved.modelHash, state.modelHash);
  assert.deepEqual(saved.selection, selection);
  assert.deepEqual(saved.context.claims.find(item => item.id === claim.id), claim);
  assert.ok(claim.evidence.every(item => saved.context.sources.some(source => source.id === item.sourceId)));
  assert.match(saved.handoff, /引用原文：/);
  const marker = 'process-review-workbench-ref:v1 ';
  const header = JSON.parse(saved.handoff.slice(saved.handoff.indexOf(marker) + marker.length));
  assert.deepEqual(header, { taskDirectory: task, taskId: state.taskId, referenceId: saved.id,
    workRevision: state.workRevision, modelHash: state.modelHash, targets: saved.targets });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(task, 'workbench', 'references', `${saved.id}.json`), 'utf8')), saved);
});

test('a relation condition and a claim can each be referenced with their own exact selection', t => {
  const { store } = setup(t);
  const claim = getClaim(store.read(), 'validate--approval-condition');
  const selection = { claimId: claim.id, text: claim.text };
  for (const target of [{ type: 'relation', id: 'validate--approval' }, { type: 'claim', id: claim.id }]) {
    const saved = store.createReference(guard(store, { targets: [target], selection }));
    assert.deepEqual(saved.selection, selection);
    assert.equal(saved.targetObjects[0].id, target.id);
    assert.ok(saved.context.claims.some(item => item.id === claim.id));
  }
});

test('multiple targets include exact objects and enough surrounding flow to explain their relationship', t => {
  const { store } = setup(t);
  const targets = [...selectedNode, { type: 'relation', id: 'validate--approval' }];
  const saved = store.createReference(guard(store, { targets }));
  assert.deepEqual(saved.targets.map(({ type, id }) => ({ type, id })), targets);
  assert.equal(saved.targetObjects.length, 2);
  assert.deepEqual(saved.targetObjects[0], store.read().model.nodes.find(item => item.id === 'validate'));
  assert.deepEqual(saved.targetObjects[1], store.read().model.relations.find(item => item.id === 'validate--approval'));
  assert.ok(saved.context.nodes.some(item => item.id === 'approval'));
  assert.ok(saved.context.relations.some(item => item.id === 'validate--dispatch'));
  assert.ok(saved.context.issues.length > 0, 'open uncertainties remain available');
});

test('whole-flow reference has no fabricated chat message and does not alter business or UI state', t => {
  const { task, store } = setup(t);
  const before = store.read();
  const stateFile = path.join(task, 'workbench', 'state.json');
  const originalBytes = fs.readFileSync(stateFile);
  const saved = store.createReference(guard(store, { targets: [] }));
  assert.deepEqual(saved.targets, []);
  assert.deepEqual(saved.targetObjects, []);
  assert.equal(saved.selection, null);
  assert.match(saved.handoff, /整个流程/);
  assert.equal(saved.context.nodes.length, before.model.nodes.length);
  assert.equal(store.reference(saved.id).stale, false);
  assert.deepEqual(store.read(), before);
  assert.deepEqual(fs.readFileSync(stateFile), originalBytes);
  assert.deepEqual(fs.readdirSync(path.join(task, 'workbench', 'requests')), []);
  assert.deepEqual(store.read().requests, []);
});

test('references retain their original snapshot across edits, reopening, and mutations of returned data', t => {
  const { task, store } = setup(t);
  const saved = store.createReference(guard(store, { targets: selectedNode }));
  const original = structuredClone(saved);
  saved.context.node.title = '外部误改';
  saved.targets[0].label = '外部误改';
  const changed = store.edit(guard(store, { requestId: randomUUID(), nodeId: 'validate', title: '用户修改后的幅度检查', intent: 'current' }));
  const reopened = createStore(task);
  const read = reopened.reference(saved.id);
  assert.equal(read.stale, true);
  assert.equal(read.currentWorkRevision, changed.workRevision);
  assert.equal(read.currentModelHash, changed.modelHash);
  const { currentWorkRevision, currentModelHash, stale, ...snapshot } = read;
  assert.deepEqual(snapshot, original);
  assert.notEqual(read.context.node.title, changed.model.nodes.find(item => item.id === 'validate').title);
  assert.equal(read.context.workRevision, original.workRevision);
});

test('layout changes do not make an unchanged content snapshot stale', t => {
  const { store } = setup(t);
  const saved = store.createReference(guard(store, { targets: selectedNode }));
  store.updateView({ requestId: randomUUID(), positions: { validate: { x: 300, y: 700 } } });
  assert.equal(store.reference(saved.id).stale, false);
});

test('unknown objects and unsafe reference IDs are rejected without producing snapshots', t => {
  const { task, store } = setup(t);
  for (const targets of [[{ type: 'node', id: 'does-not-exist' }], [{ type: 'source', id: 'demo-guide' }], [{ type: 'node', id: '../state' }]]) {
    assert.throws(() => store.createReference(guard(store, { targets })));
  }
  assert.throws(() => store.reference('../state'), error => error.status === 400);
  assert.throws(() => store.reference(randomUUID()), error => error.status === 404);
  assert.deepEqual(fs.readdirSync(path.join(task, 'workbench', 'references')), []);
});

test('edited, unrelated, or unowned selected text cannot masquerade as a saved quote', t => {
  const { task, store } = setup(t);
  const condition = getClaim(store.read(), 'validate--approval-condition');
  const action = getClaim(store.read(), 'validate-actions');
  const invalid = [
    { targets: selectedNode, selection: { claimId: action.id, text: `${action.text}用户尚未保存的增补` } },
    { targets: selectedNode, selection: { claimId: condition.id, text: condition.text } },
    { targets: [], selection: { claimId: action.id, text: action.text } },
    { targets: [{ type: 'claim', id: action.id }], selection: { claimId: condition.id, text: condition.text } },
    { targets: selectedNode, selection: { claimId: action.id, text: ' ' } },
  ];
  for (const payload of invalid) assert.throws(() => store.createReference(guard(store, payload)), /先保存/);
  assert.deepEqual(fs.readdirSync(path.join(task, 'workbench', 'references')), []);
});

test('stale revision or hash cannot create a snapshot falsely attributed to the current view', t => {
  const { task, store } = setup(t);
  const old = guard(store, { targets: selectedNode });
  store.edit(guard(store, { requestId: randomUUID(), nodeId: 'validate', title: '新版检查标题', intent: 'current' }));
  assert.throws(() => store.createReference(old), error => error.status === 409);
  assert.throws(() => store.createReference(guard(store, { targets: selectedNode, baseModelHash: old.baseModelHash })), error => error.status === 409);
  assert.deepEqual(fs.readdirSync(path.join(task, 'workbench', 'references')), []);
  assert.deepEqual(store.read().requests, []);
});

test('a retained historical claim reference carries its own evidence after active wording is replaced', t => {
  const { store } = setup(t);
  const claim = structuredClone(getClaim(store.read(), 'validate-actions'));
  store.edit(guard(store, { requestId: randomUUID(), nodeId: 'validate', intent: 'current', claims: [{ id: claim.id, text: '改写后的用户陈述。' }] }));
  const saved = store.createReference(guard(store, { targets: [{ type: 'claim', id: claim.id }], selection: { claimId: claim.id, text: claim.text } }));
  assert.deepEqual(saved.targetObjects[0], claim);
  assert.deepEqual(saved.context.claims.find(item => item.id === claim.id), claim);
  assert.ok(claim.evidence.every(item => saved.context.sources.some(source => source.id === item.sourceId)));
});
