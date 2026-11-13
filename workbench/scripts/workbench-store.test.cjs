'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStore } = require('./workbench-store.cjs');
const { createDemoModel, createDemoPositions } = require('./workbench-demo-fixture.cjs');
const { validateModel } = require('../../skills/6ak-process-review/scripts/validate-model.cjs');

const qaRoot = path.resolve(__dirname, '../../.qa');
function setup(t, model = createDemoModel()) {
  fs.mkdirSync(qaRoot, { recursive: true });
  const task = fs.mkdtempSync(path.join(qaRoot, 'workbench-store-'));
  t.after(() => {
    const resolved = path.resolve(task);
    assert.ok(resolved.startsWith(qaRoot + path.sep), 'test cleanup remains within .qa');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { task, store: createStore(task, { model, positions: createDemoPositions() }) };
}
function guard(store, values = {}) {
  const state = store.read();
  return { requestId: randomUUID(), baseWorkRevision: state.workRevision, baseModelHash: state.modelHash, ...values };
}
const node = (state, id = 'validate') => state.model.nodes.find(item => item.id === id);
const claim = (state, id) => state.model.claims.find(item => item.id === id);

test('demo fixture has evidenced alternative paths, a return, and preserved unknowns', () => {
  const model = createDemoModel();
  assert.equal(validateModel(model).ok, true);
  assert.equal(model.nodes.length, 14);
  assert.equal(Object.keys(createDemoPositions()).length, model.nodes.length);
  const low = model.relations.find(item => item.id === 'validate--dispatch');
  const high = model.relations.find(item => item.id === 'validate--approval');
  assert.equal(low.to, 'dispatch');
  assert.equal(high.to, 'approval');
  assert.ok(model.relations.some(item => item.type === 'return'));
  assert.ok(model.relations.some(item => item.type === 'data'));
  assert.ok(model.relations.some(item => item.type === 'association'));
  assert.equal(model.issues.filter(item => item.status === 'open').length, 2);
  assert.match(model.sources[0].text, /合成演示|构造/);
});

test('direct edit persists the complete node and both branch conditions across reopening', async t => {
  const { task, store } = setup(t);
  const edited = await store.edit(guard(store, {
    nodeId: 'validate', title: '检查调价幅度', intent: 'current',
    claims: [{ id: 'validate-actions', text: '逐项检查价格字段，并记录本次检查结果。' }],
    branches: [
      { id: 'validate--dispatch', to: 'dispatch', conditions: [{ id: 'validate--dispatch-condition', text: '降幅 ≤ 25%' }] },
      { id: 'validate--approval', to: 'approval', conditions: [{ id: 'validate--approval-condition', text: '降幅 > 25%' }] },
    ],
  }));
  assert.equal(node(edited).title, '检查调价幅度');
  assert.equal(validateModel(edited.model).ok, true);
  const action = node(edited).fields.actions.map(id => claim(edited, id).text).join('\n');
  assert.match(action, /逐项检查价格字段/);
  const conditions = edited.model.relations.filter(item => item.from === 'validate')
    .flatMap(item => item.conditionClaimIds.map(id => claim(edited, id).text));
  assert.deepEqual(new Set(conditions), new Set(['降幅 ≤ 25%', '降幅 > 25%']));
  const restored = createStore(task, { model: createDemoModel(), positions: createDemoPositions() }).read();
  assert.equal(restored.workRevision, edited.workRevision);
  assert.equal(restored.modelHash, edited.modelHash);
  assert.deepEqual(restored.model, edited.model);
});

test('changed wording cites the user input without rewriting the old source or claim', async t => {
  const { store } = setup(t);
  const before = store.read();
  const edited = await store.edit(guard(store, {
    nodeId: 'validate', intent: 'current', claims: [{ id: 'validate-actions', text: '检查后记录操作人员与检查时间。' }],
  }));
  assert.deepEqual(edited.model.sources.find(item => item.id === 'demo-guide'), before.model.sources[0]);
  assert.deepEqual(claim(edited, 'validate-actions'), claim(before, 'validate-actions'));
  const newAction = node(edited).fields.actions.map(id => claim(edited, id)).find(item => item.text === '检查后记录操作人员与检查时间。');
  assert.ok(newAction);
  assert.notEqual(newAction.id, 'validate-actions');
  for (const ref of newAction.evidence) {
    const source = edited.model.sources.find(item => item.id === ref.sourceId);
    assert.equal(source.kind, 'user-feedback');
    assert.match(source.text, /检查后记录操作人员与检查时间/);
  }
  assert.equal(validateModel(edited.model).ok, true);
});

test('a bad last branch cannot leave earlier changes partially applied', async t => {
  const { store } = setup(t);
  const before = store.read();
  await assert.rejects(async () => store.edit(guard(store, {
    nodeId: 'validate', title: '不应被部分保存', intent: 'current',
    branches: [
      { id: 'validate--dispatch', to: 'dispatch', conditions: [{ id: 'validate--dispatch-condition', text: '降幅 ≤ 24%' }] },
      { id: 'validate--approval', to: 'missing-node', conditions: [{ id: 'validate--approval-condition', text: '降幅 > 24%' }] },
    ],
  })));
  assert.equal(store.read().workRevision, before.workRevision);
  assert.deepEqual(store.read().model, before.model);
});

test('stale work revisions reject a lost update and retain the current model', async t => {
  const { store } = setup(t);
  const stale = guard(store, { nodeId: 'validate', title: '旧客户端名称', intent: 'current' });
  await store.edit(guard(store, { nodeId: 'validate', title: '最新名称', intent: 'current' }));
  await assert.rejects(async () => store.edit(stale), error => error.status === 409 || error.statusCode === 409);
  assert.equal(node(store.read()).title, '最新名称');
});

test('retrying a successfully saved request does not create a second content change', async t => {
  const { store } = setup(t);
  const payload = guard(store, { nodeId: 'validate', title: '幂等保存', intent: 'current' });
  const once = await store.edit(payload);
  await store.edit(payload);
  assert.equal(store.read().workRevision, once.workRevision);
  assert.equal(store.read().modelHash, once.modelHash);
});

test('a proposal is durable while the effective model stays unchanged', async t => {
  const { store, task } = setup(t);
  const before = store.read();
  await store.edit(guard(store, { nodeId: 'validate', title: '拟议的新校验方式', intent: 'proposal' }));
  const pending = createStore(task, { model: createDemoModel() }).read();
  assert.deepEqual(pending.model, before.model);
  assert.ok(pending.pendingEdits.length > 0);
  assert.match(JSON.stringify(pending.pendingEdits), /拟议的新校验方式/);
});

test('buffers recover independently and an older save cannot replace newer input', async t => {
  const { store, task } = setup(t);
  const before = store.read();
  await store.saveBuffer({ sessionId: 'test-reader', nodeId: 'validate', revision: 5, draft: { title: '写到一半的内容' } });
  try {
    await store.saveBuffer({ sessionId: 'test-reader', nodeId: 'validate', revision: 4, draft: { title: '较旧输入' } });
  } catch (error) {
    assert.ok(error.status === 409 || error.statusCode === 409);
  }
  const reopened = createStore(task, { model: createDemoModel() });
  const buffers = await reopened.buffers('test-reader');
  assert.equal(buffers.validate.revision, 5);
  assert.equal(buffers.validate.draft.title, '写到一半的内容');
  assert.equal(reopened.read().workRevision, before.workRevision);
  assert.equal(reopened.read().modelHash, before.modelHash);
});

test('undo reverts the content change while preserving subsequently saved layout and questions', async t => {
  const { store } = setup(t);
  const beforeTitle = node(store.read()).title;
  await store.edit(guard(store, { nodeId: 'validate', title: '临时名称', intent: 'current' }));
  const editedRevision = store.read().workRevision;
  await store.updateView({ positions: { validate: { x: 180, y: 260 } } });
  assert.equal(store.read().workRevision, editedRevision);
  const request = await store.createRequest({ text: '为什么有两个出口？', targets: [{ type: 'node', id: 'validate' }] });
  await store.undo(guard(store));
  const after = store.read();
  assert.equal(node(after).title, beforeTitle);
  assert.deepEqual(after.view.positions.validate, { x: 180, y: 260 });
  assert.ok(after.requests.some(item => item.id === request.id));
});

test('candidate apply shares version protection with direct editing', async t => {
  const { store } = setup(t);
  const candidate = await store.createCandidate({});
  const proposed = JSON.parse(fs.readFileSync(candidate.modelFile, 'utf8'));
  proposed.nodes.find(item => item.id === 'validate').title = 'Agent 的旧建议';
  fs.writeFileSync(candidate.modelFile, JSON.stringify(proposed));
  await store.edit(guard(store, { nodeId: 'validate', title: '用户刚修改的名称', intent: 'current' }));
  await assert.rejects(async () => store.applyCandidate({ candidateId: candidate.candidateId, requestId: randomUUID() }), error => error.status === 409 || error.statusCode === 409);
  assert.equal(node(store.read()).title, '用户刚修改的名称');
  assert.equal(JSON.parse(fs.readFileSync(candidate.modelFile, 'utf8')).nodes.find(item => item.id === 'validate').title, 'Agent 的旧建议');
});

test('a valid candidate updates the same durable model and does not rewrite source text', async t => {
  const { store, task } = setup(t);
  const sources = store.read().model.sources;
  const candidate = await store.createCandidate({});
  const proposed = JSON.parse(fs.readFileSync(candidate.modelFile, 'utf8'));
  proposed.nodes.find(item => item.id === 'validate').title = 'Agent 整理后的检查步骤';
  fs.writeFileSync(candidate.modelFile, JSON.stringify(proposed));
  await store.applyCandidate({ candidateId: candidate.candidateId, requestId: randomUUID() });
  const restored = createStore(task, { model: createDemoModel() }).read();
  assert.equal(node(restored).title, 'Agent 整理后的检查步骤');
  assert.deepEqual(restored.model.sources, sources);
  assert.equal(validateModel(restored.model).ok, true);
});

test('direct editing refuses a shared claim rather than silently changing another node', async t => {
  const model = createDemoModel();
  const other = model.nodes.find(item => item.id === 'manual');
  other.claimIds.push('validate-actions');
  other.fields.rules.push('validate-actions');
  assert.equal(validateModel(model).ok, true);
  const { store } = setup(t, model);
  const before = store.read();
  await assert.rejects(async () => store.edit(guard(store, {
    nodeId: 'validate', intent: 'current', claims: [{ id: 'validate-actions', text: '只应该修改这一处。' }],
  })));
  assert.deepEqual(store.read().model, before.model);
});

test('a prepared transaction resumes after interruption before state replacement', async t => {
  const { store, task } = setup(t);
  const payload = guard(store, { nodeId: 'validate', title: '恢复后的完整修改', intent: 'current' });
  const applied = await store.edit(payload);
  const directory = path.join(task, 'workbench', 'transactions', applied.lastTransactionId);
  // Reproduce the durable artifacts at the point after prepare but before the
  // atomic state replacement. No actual business task is used by this test.
  fs.copyFileSync(path.join(directory, 'before.json'), path.join(task, 'workbench', 'state.json'));
  fs.unlinkSync(path.join(directory, 'receipt.json'));
  const recovered = createStore(task, { model: createDemoModel() });
  assert.equal(node(recovered.read()).title, '恢复后的完整修改');
  assert.equal(recovered.read().workRevision, applied.workRevision);
  assert.equal(recovered.read().modelHash, applied.modelHash);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json'), 'utf8')).status, 'applied');
  await recovered.edit(payload);
  assert.equal(recovered.read().workRevision, applied.workRevision);
});

test('an interruption after state replacement repairs the receipt without replaying content', async t => {
  const { store, task } = setup(t);
  const applied = await store.edit(guard(store, { nodeId: 'validate', title: '已写入但回执中断', intent: 'current' }));
  const directory = path.join(task, 'workbench', 'transactions', applied.lastTransactionId);
  fs.unlinkSync(path.join(directory, 'receipt.json'));
  const recovered = createStore(task, { model: createDemoModel() }).read();
  assert.deepEqual(recovered.model, applied.model);
  assert.equal(recovered.stateRevision, applied.stateRevision);
  assert.equal(recovered.workRevision, applied.workRevision);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'receipt.json'), 'utf8')).status, 'applied');
});

test('adopting one pending edit retains the other node proposal and its original context', async t => {
  const { store } = setup(t);
  await store.edit(guard(store, { nodeId: 'validate', title: '校验改法待讨论', intent: 'proposal' }));
  await store.edit(guard(store, { nodeId: 'manual', title: '录入改法待讨论', intent: 'proposal' }));
  const other = structuredClone(store.read().pendingEdits.find(item => item.nodeId === 'manual'));
  await store.edit(guard(store, { nodeId: 'validate', title: '已经采用的名称', intent: 'current' }));
  const after = store.read();
  assert.equal(node(after).title, '已经采用的名称');
  assert.ok(!after.pendingEdits.some(item => item.nodeId === 'validate'));
  assert.deepEqual(after.pendingEdits.find(item => item.nodeId === 'manual'), other);
});

test('a changed condition no longer cites the old threshold as current relationship support', async t => {
  const { store } = setup(t);
  const old = store.read();
  const changed = await store.edit(guard(store, {
    nodeId: 'validate', intent: 'current', branches: [
      { id: 'validate--dispatch', to: 'dispatch', conditions: [{ id: 'validate--dispatch-condition', text: '降幅 ≤ 25%' }] },
    ],
  }));
  const edge = changed.model.relations.find(item => item.id === 'validate--dispatch');
  assert.ok(!edge.claimIds.includes('validate--dispatch-flow'));
  assert.ok(!edge.claimIds.includes('validate--dispatch-condition'));
  const support = edge.claimIds.map(id => claim(changed, id).text).join('\n');
  assert.match(support, /25%/);
  assert.doesNotMatch(support, /30%/);
  assert.deepEqual(claim(changed, 'validate--dispatch-flow'), claim(old, 'validate--dispatch-flow'));
  assert.equal(validateModel(changed.model).ok, true);
});

test('a changed destination uses new relationship evidence and preserves the old assertion separately', async t => {
  const { store } = setup(t);
  const old = store.read();
  const changed = await store.edit(guard(store, {
    nodeId: 'validate', intent: 'current', branches: [{ id: 'validate--dispatch', to: 'failure' }],
  }));
  const edge = changed.model.relations.find(item => item.id === 'validate--dispatch');
  assert.equal(edge.to, 'failure');
  assert.ok(!edge.claimIds.includes('validate--dispatch-flow'));
  const newRelationClaim = edge.claimIds.filter(id => !edge.conditionClaimIds.includes(id)).map(id => claim(changed, id));
  assert.ok(newRelationClaim.some(item => item.text.includes('记录平台失败')));
  assert.ok(newRelationClaim.every(item => item.evidence.every(ref => changed.model.sources.find(source => source.id === ref.sourceId).kind === 'user-feedback')));
  assert.deepEqual(claim(changed, 'validate--dispatch-flow'), claim(old, 'validate--dispatch-flow'));
});

test('request context remains readable after the selected node is changed', async t => {
  const { store, task } = setup(t);
  const request = await store.createRequest({ text: '这一步的依据是什么？', targets: [{ type: 'node', id: 'validate' }] });
  assert.match(request.handoff, /process-review-draft-batch:v1/);
  const originalContext = structuredClone(request.context);
  await store.edit(guard(store, { nodeId: 'validate', title: '后来的名称', intent: 'current' }));
  const reopened = createStore(task, { model: createDemoModel() }).read();
  assert.deepEqual(reopened.requests.find(item => item.id === request.id).context, originalContext);
  assert.equal(originalContext.node.title, '校验降幅');
});

test('Agent rule edits appear in the difference list and identify the related nodes', async t => {
  const model = createDemoModel();
  model.rules.push({
    id: 'test-linked-rule', title: '测试用规则关联', claimIds: ['validate-actions', 'calculate-actions'],
    parameters: { operator: [], value: [], unit: [], basis: ['validate-actions'], scope: [], exceptions: [] },
  });
  const { store } = setup(t, model);
  const candidate = await store.createCandidate({});
  const proposed = JSON.parse(fs.readFileSync(candidate.modelFile, 'utf8'));
  proposed.rules.find(item => item.id === 'test-linked-rule').parameters.basis = ['calculate-actions'];
  fs.writeFileSync(candidate.modelFile, JSON.stringify(proposed));
  const state = await store.applyCandidate({ candidateId: candidate.candidateId, requestId: randomUUID() });
  const change = state.changes[0];
  assert.ok(change.items.some(item => item.type === 'rule' && item.id === 'test-linked-rule'));
  assert.ok(change.nodeIds.includes('validate'));
  assert.ok(change.nodeIds.includes('calculate'));
});

test('a changed premise identifies nodes using its inferred dependent claim', async t => {
  const model = createDemoModel();
  const derived = {
    id: 'test-derived-guidance', text: '按校验要求核对测算记录。', origin: 'inferred', evidence: [],
    premiseIds: ['validate-actions'], rationale: '仅用于验证依赖影响传播的合成陈述。',
  };
  model.claims.push(derived);
  const calculate = model.nodes.find(item => item.id === 'calculate');
  calculate.claimIds.push(derived.id);
  calculate.fields.rules.push(derived.id);
  const { store } = setup(t, model);
  const candidate = await store.createCandidate({});
  const proposed = JSON.parse(fs.readFileSync(candidate.modelFile, 'utf8'));
  // The rephrasing is supported by the same original source. The test concerns
  // dependency visibility rather than inventing a new business assertion.
  proposed.claims.find(item => item.id === 'validate-actions').text = '检查价格字段的有效性，按降幅判断审批要求。';
  fs.writeFileSync(candidate.modelFile, JSON.stringify(proposed));
  const state = await store.applyCandidate({ candidateId: candidate.candidateId, requestId: randomUUID() });
  assert.ok(state.changes[0].nodeIds.includes('validate'));
  assert.ok(state.changes[0].nodeIds.includes('calculate'));
});

test('the same save identifier cannot silently accept a different edit', async t => {
  const { store } = setup(t);
  const payload = guard(store, { nodeId: 'validate', title: '第一次内容', intent: 'current' });
  await store.edit(payload);
  await assert.rejects(async () => store.edit({ ...payload, title: '同编号的另一份内容' }), error => error.status === 409 || error.statusCode === 409);
  assert.equal(node(store.read()).title, '第一次内容');
});
