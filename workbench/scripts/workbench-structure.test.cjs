'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStore } = require('./workbench-store.cjs');
const { createDemoModel } = require('./workbench-demo-fixture.cjs');
const { validateModel } = require('../../skills/6ak-process-review/scripts/validate-model.cjs');

function setup(t, model = createDemoModel()) {
  const root = path.resolve(__dirname, '../../.qa');
  fs.mkdirSync(root, { recursive: true });
  const task = fs.mkdtempSync(path.join(root, 'workbench-structure-'));
  t.after(() => fs.rmSync(task, { recursive: true, force: true }));
  return createStore(task, { model });
}

function guard(store, operation) {
  const { workRevision, modelHash } = store.read();
  return { requestId: randomUUID(), baseWorkRevision: workRevision, baseModelHash: modelHash, ...(operation && { operation }) };
}

test('add node previews a stable ID without writing and records only supplied content as user evidence', t => {
  const store = setup(t);
  const before = store.read();
  const input = guard(store, {
    type: 'add-node', node: { title: '补录确认时间', groupId: 'prepare', fields: { actions: '人工登记确认时间。', input: '' } },
  });
  const preview = store.previewStructureEdit(input);
  assert.ok(preview.items.some(item => item.type === 'node' && item.id === preview.nodeId));
  assert.deepEqual(store.previewStructureEdit(input), preview);
  assert.deepEqual(store.read(), before);

  const saved = store.structureEdit(input);
  const node = saved.model.nodes.find(item => item.id === preview.nodeId);
  const claim = saved.model.claims.find(item => item.id === node.fields.actions[0]);
  assert.equal(node.title, '补录确认时间');
  assert.deepEqual(node.fields.input, []);
  assert.equal(claim.text, '人工登记确认时间。');
  assert.equal(saved.model.sources.find(item => item.id === claim.evidence[0].sourceId).kind, 'user-feedback');
  assert.deepEqual(saved.model.nodes.slice(0, -1), before.model.nodes);
  assert.deepEqual(saved.model.relations, before.model.relations);
  assert.deepEqual(store.structureEdit(input), saved);
  assert.deepEqual(store.undo(guard(store)).model, before.model);
});

test('the first manual node can be added to an existing model with no nodes or groups', t => {
  const model = createDemoModel();
  model.groups = [];
  model.nodes = [];
  model.relations = [];
  for (const issue of model.issues) {
    issue.nodeIds = [];
    issue.relationIds = [];
  }
  const store = setup(t, model);
  const input = guard(store, { type: 'add-node', node: { title: '记录口径', groupId: 'unassigned' } });
  const preview = store.previewStructureEdit(input);
  assert.deepEqual(store.read().model.groups, []);
  const saved = store.structureEdit(input);
  assert.deepEqual(saved.model.groups, [{ id: 'unassigned', title: '未分组', kind: 'editorial', claimIds: [] }]);
  assert.equal(saved.model.nodes[0].id, preview.nodeId);
  assert.deepEqual(saved.model.issues, model.issues);
  assert.deepEqual(store.undo(guard(store)).model, model);
});

test('connect requires explicit branch conditions and reconnects an edge without modifying other edges or old evidence', t => {
  const store = setup(t);
  const withoutCondition = guard(store, {
    type: 'connect', relation: { from: 'calculate', to: 'approval', type: 'conditional', description: '主管要求额外复核。' },
  });
  const before = store.read();
  assert.throws(() => store.previewStructureEdit(withoutCondition), /适用条件/);
  assert.throws(() => store.structureEdit(withoutCondition), /适用条件/);
  assert.deepEqual(store.read(), before);

  const input = guard(store, { type: 'connect', relation: { ...withoutCondition.operation.relation, condition: '资料需抽查' } });
  const preview = store.previewStructureEdit(input);
  const created = store.structureEdit(input);
  const edge = created.model.relations.find(item => item.id === preview.relationId);
  const oldCondition = created.model.claims.find(item => item.id === edge.conditionClaimIds[0]);
  assert.equal(oldCondition.text, '资料需抽查');
  assert.deepEqual(created.model.relations.slice(0, -1), before.model.relations);

  const reconnected = store.structureEdit(guard(store, {
    type: 'connect', relation: {
      id: edge.id, from: 'calculate', to: 'archive', type: 'data', description: '向档案管理员交付抽查记录。',
    },
  }));
  const revised = reconnected.model.relations.find(item => item.id === edge.id);
  assert.equal(revised.to, 'archive');
  assert.equal(revised.type, 'data');
  assert.deepEqual(revised.conditionClaimIds, []);
  assert.deepEqual(reconnected.model.claims.find(item => item.id === oldCondition.id), oldCondition);
  assert.deepEqual(reconnected.model.relations.slice(0, -1), before.model.relations);
  assert.equal(validateModel(reconnected.model).ok, true);
});

test('editing one field on an existing connection keeps independent evidence and skips unchanged saves', t => {
  const model = createDemoModel();
  const original = model.relations.find(edge => edge.id === 'calculate--manual');
  original.conditionClaimIds.push('manual-trigger');
  original.claimIds.push('manual-trigger');
  const oldDescription = model.claims.find(claim => claim.id === original.claimIds[0]).text;
  const oldConditions = original.conditionClaimIds.map(id => model.claims.find(claim => claim.id === id).text).join('；');
  const store = setup(t, model);
  const before = store.read();
  const revise = (description, condition) => guard(store, {
    type: 'connect', relation: {
      id: original.id, from: original.from, to: original.to, type: original.type, description, condition,
    },
  });

  const same = revise(oldDescription, oldConditions);
  const preview = store.previewStructureEdit(same);
  assert.deepEqual(preview.items, []);
  assert.deepEqual(store.structureEdit(same), before);
  assert.throws(() => store.structureEdit(revise(oldDescription, '经负责人核准')), /说明仍包含旧条件/);
  assert.deepEqual(store.read(), before);

  const description = '核对后将资料交给下一环节。';
  const revised = store.structureEdit(revise(description, oldConditions));
  const connection = revised.model.relations.find(edge => edge.id === original.id);
  assert.deepEqual(connection.conditionClaimIds, original.conditionClaimIds);
  assert.ok(connection.claimIds.includes('manual-trigger'));
  const detailId = connection.claimIds[0];
  const savedDescription = revised.model.claims.find(claim => claim.id === detailId).text;

  const changedCondition = store.structureEdit(revise(savedDescription, '经负责人核准'));
  const final = changedCondition.model.relations.find(edge => edge.id === original.id);
  assert.equal(final.claimIds[0], detailId);
  assert.equal(final.conditionClaimIds.length, 1);
  assert.equal(changedCondition.model.claims.find(claim => claim.id === final.conditionClaimIds[0]).text, '经负责人核准');
  assert.deepEqual(changedCondition.model.claims.find(claim => claim.id === 'manual-trigger'),
    before.model.claims.find(claim => claim.id === 'manual-trigger'));
});

test('insertion replaces only the selected unconditional path and rejects migrating existing actions', t => {
  const model = createDemoModel();
  const sequence = 'demand--calculate';
  model.issues[0].relationIds.push(sequence);
  const store = setup(t, model);
  const insert = { type: 'insert-step', relationId: sequence, node: { title: '复核调价资料', groupId: 'prepare' } };
  const before = store.read();
  assert.throws(() => store.structureEdit(guard(store, { ...insert, relationId: 'reconcile--calculate' })), /无条件顺序线/);
  assert.throws(() => store.structureEdit(guard(store, {
    ...insert, updates: [{ nodeId: 'demand', claimId: 'demand-actions', text: '把本节点操作移到新节点。' }],
  })), /已有活动/);
  assert.deepEqual(store.read(), before);

  const input = guard(store, {
    ...insert, updates: [{ nodeId: 'calculate', claimId: 'calculate-trigger', text: '调价资料复核后开始测算。' }],
  });
  const preview = store.previewStructureEdit(input);
  const after = store.structureEdit(input);
  const replacement = after.model.relations.filter(item => preview.relationIds.includes(item.id));
  assert.deepEqual(replacement.map(({ from, to, type }) => [from, to, type]), [
    ['demand', preview.nodeId, 'sequence'], [preview.nodeId, 'calculate', 'sequence'],
  ]);
  assert.deepEqual(after.model.relations.filter(item => !preview.relationIds.includes(item.id)),
    model.relations.filter(item => item.id !== sequence));
  assert.deepEqual(after.model.issues[0].relationIds, preview.relationIds);
  assert.equal(after.model.issues[0].status, 'open');
  const downstream = after.model.nodes.find(item => item.id === 'calculate');
  const currentTrigger = after.model.claims.find(item => item.id === downstream.fields.trigger[0]);
  assert.equal(currentTrigger.text, '调价资料复核后开始测算。');
  assert.equal(validateModel(after.model).ok, true);
  assert.deepEqual(store.undo(guard(store)).model, before.model);
});
