'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { createStore } = require('./workbench-store.cjs');
const { createDemoModel, createDemoPositions } = require('./workbench-demo-fixture.cjs');

const qaRoot = path.resolve(__dirname, '../../.qa');
function setup(t, positions = createDemoPositions()) {
  fs.mkdirSync(qaRoot, { recursive: true });
  const task = fs.mkdtempSync(path.join(qaRoot, 'workbench-layout-'));
  t.after(() => {
    const resolved = path.resolve(task);
    assert.ok(resolved.startsWith(qaRoot + path.sep), 'test cleanup remains within .qa');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { task, store: createStore(task, { model: createDemoModel(), positions }) };
}
function layout(store, scopeId, action, extra = {}) {
  const state = store.read();
  return store.updateView({ requestId: randomUUID(), layout: {
    scopeId, action, baseRevision: state.view.layouts[scopeId]?.revision || 0,
    ...(['arrange', 'initialize', 'reset', 'refresh', 'measure'].includes(action) ? { baseModelHash: state.modelHash } : {}), ...extra,
  } });
}
function arrange(store, scopeId, positions, routes = {}) { return layout(store, scopeId, 'arrange', { positions, routes }); }
function initialize(store, scopeId, positions, routes = {}) { return layout(store, scopeId, 'initialize', { positions, routes }); }
function move(store, scopeId, positions) { return layout(store, scopeId, 'move', { positions }); }
const route = { points: [{ x: 20, y: 30 }, { x: 20, y: 80 }, { x: 120, y: 80 }], label: { x: 45, y: 54, width: 60, height: 24 }, geometryKey: 'geometry-v1:fixed-fingerprint' };
const business = state => ({ workRevision: state.workRevision, modelHash: state.modelHash, model: state.model, changes: state.changes, pendingEdits: state.pendingEdits });
const conflict = error => error.status === 409;

test('initial local layout preserves business state and global positions without an undo to the global baseline', t => {
  const { store, task } = setup(t);
  const before = store.read();
  const positions = { validate: { x: 210, y: 130 }, dispatch: { x: 210, y: 330 } };
  const saved = initialize(store, 'execute', positions, { 'validate--dispatch': route });
  assert.equal(saved.view.layouts.execute.revision, 1);
  assert.equal(saved.view.layouts.execute.previous, undefined);
  assert.deepEqual(saved.view.layouts.execute.positions.validate, positions.validate);
  assert.deepEqual(saved.view.layouts.execute.routes['validate--dispatch'], route);
  assert.deepEqual(saved.view.positions, before.view.positions);
  assert.deepEqual(business(saved), business(before));
  const reopened = createStore(task);
  assert.deepEqual(reopened.read(), saved);
  assert.throws(() => layout(reopened, 'execute', 'undo'), conflict);
  assert.deepEqual(reopened.read(), saved);
  arrange(reopened, 'execute', { validate: { x: 250, y: 170 } });
  const restored = layout(reopened, 'execute', 'undo');
  assert.deepEqual(restored.view.layouts.execute.positions, saved.view.layouts.execute.positions);
  assert.deepEqual(business(restored), business(before));
});

test('initialize rejects existing layouts after restart or an earlier move, even with the latest scope revision', t => {
  const { store, task } = setup(t);
  const before = store.read();
  const input = { requestId: randomUUID(), layout: { scopeId: 'prepare', action: 'initialize', baseRevision: 0, baseModelHash: before.modelHash, positions: { calculate: { x: 100, y: 200 } } } };
  const saved = store.updateView(input);
  const reopened = createStore(task);
  assert.deepEqual(reopened.updateView(input), saved, 'an identical request retry remains idempotent');
  for (const baseRevision of [0, 1]) {
    assert.throws(() => reopened.updateView({ ...input, requestId: randomUUID(), layout: { ...input.layout, baseRevision } }), conflict);
    assert.deepEqual(reopened.read(), saved);
  }
  const moved = move(reopened, 'execute', { validate: { x: 333.25, y: 444.75 } });
  for (const baseRevision of [0, 1]) {
    assert.throws(() => layout(reopened, 'execute', 'initialize', { baseRevision, positions: { manual: { x: 100, y: 200 } } }), conflict);
    assert.deepEqual(reopened.read(), moved, 'an initialization cannot replace a layout created by dragging');
  }
  const edited = reopened.edit({ requestId: randomUUID(), baseWorkRevision: moved.workRevision, baseModelHash: moved.modelHash, nodeId: 'manual', title: '初始化期间修改的节点名称' });
  for (const baseModelHash of [undefined, before.modelHash]) {
    assert.throws(() => layout(reopened, 'all', 'initialize', { baseModelHash, positions: {} }), conflict);
    assert.deepEqual(reopened.read(), edited);
  }
  assert.throws(() => layout(reopened, 'all', 'initialize', { baseRevision: undefined, positions: {} }), conflict);
  assert.deepEqual(reopened.read(), edited);
});

test('initialize inherits legacy manual points exactly and cannot round or move them', t => {
  const { store } = setup(t);
  const pinnedPosition = { x: 41.123456789, y: -51.987654321 };
  const before = store.updateView({ positions: { calculate: pinnedPosition } });
  assert.throws(() => initialize(store, 'prepare', { calculate: { x: 41, y: -52 } }), conflict);
  assert.deepEqual(store.read(), before);
  const saved = initialize(store, 'prepare', { calculate: pinnedPosition, manual: { x: 240, y: 300 } });
  assert.deepEqual(saved.view.layouts.prepare.manualNodeIds, ['calculate']);
  assert.deepEqual(saved.view.layouts.prepare.positions.calculate, pinnedPosition);
  const omitted = initialize(store, 'execute', { validate: { x: 300, y: 400 } });
  assert.deepEqual(omitted.view.layouts.execute.positions.calculate, pinnedPosition, 'omitted manual points retain their exact legacy coordinates');
  assert.deepEqual(omitted.view.layouts.execute.manualNodeIds, ['calculate']);
  assert.deepEqual(omitted.view.positions, before.view.positions);
  assert.deepEqual(business(omitted), business(before));
});

test('scoped layout persists across readers and restart without moving shared nodes in other scopes', t => {
  const { store, task } = setup(t);
  const before = store.read();
  arrange(store, 'prepare', { calculate: { x: 200, y: 300 } }, { 'demand--calculate': route });
  const prepare = structuredClone(store.read().view.layouts.prepare);
  arrange(store, 'execute', { calculate: { x: 900, y: 800 } });
  arrange(store, 'all', { calculate: { x: 1400, y: 1500 } });
  move(store, 'execute', { calculate: { x: 990, y: 870 } });
  const saved = store.read();
  assert.deepEqual(saved.view.layouts.prepare, prepare);
  assert.deepEqual(saved.view.layouts.all.positions.calculate, { x: 1400, y: 1500 });
  assert.deepEqual(saved.view.layouts.execute.positions.calculate, { x: 990, y: 870 });
  assert.deepEqual(saved.view.positions, before.view.positions);
  assert.deepEqual(business(saved), business(before));
  assert.deepEqual(createStore(task).read(), saved);
  assert.deepEqual(createStore(task, { model: createDemoModel(), positions: {} }).read(), saved);
  assert.deepEqual(prepare.routes['demand--calculate'], route);
});

test('manual positions are protected until released and routes are cleared after a move', t => {
  const { store } = setup(t);
  arrange(store, 'execute', { validate: { x: 200, y: 300 } }, { 'validate--dispatch': route });
  move(store, 'execute', { validate: { x: 210, y: 330 } });
  const pinned = store.read();
  assert.deepEqual(pinned.view.layouts.execute.manualNodeIds, ['validate']);
  assert.deepEqual(pinned.view.layouts.execute.routes, {});
  assert.throws(() => arrange(store, 'execute', { validate: { x: 220, y: 400 } }), conflict);
  assert.deepEqual(store.read(), pinned);
  arrange(store, 'execute', { validate: { x: 210, y: 330 }, manual: { x: 300, y: 400 } });
  layout(store, 'execute', 'release', { nodeIds: ['validate'] });
  assert.deepEqual(store.read().view.layouts.execute.manualNodeIds, []);
  arrange(store, 'execute', { validate: { x: 220, y: 400 } });
  assert.deepEqual(store.read().view.layouts.execute.positions.validate, { x: 220, y: 400 });
});

test('reset replaces the current layout and its manual pins with undo while rejecting stale and partial requests', async t => {
  const { store, task } = setup(t);
  const { getGraphScope } = await import('../frontend/src/graph-scope.mjs');
  store.updateView({ positions: { calculate: { x: 600, y: 800 } } });
  move(store, 'prepare', { calculate: { x: 700, y: 900 } });
  const before = move(store, 'execute', { validate: { x: 300, y: 400 } });
  const visible = getGraphScope(before.model, 'execute').visibleIds;
  const positions = Object.fromEntries([...visible].map((id, index) => [id, { x: 100, y: 40 + index * 200 }]));
  const input = { requestId: randomUUID(), layout: {
    scopeId: 'execute', action: 'reset', baseRevision: before.view.layouts.execute.revision, baseModelHash: before.modelHash,
    positions, routes: { 'validate--dispatch': route },
  } };
  const partial = { ...positions };
  delete partial.validate;
  assert.deepEqual(new Set(before.view.layouts.execute.manualNodeIds), new Set(['calculate', 'validate']));
  assert.throws(() => layout(store, 'execute', 'reset', { positions: partial }));
  assert.throws(() => layout(store, 'execute', 'reset', { positions, baseRevision: input.layout.baseRevision - 1 }), conflict);
  assert.throws(() => layout(store, 'execute', 'reset', { positions, baseModelHash: undefined }), conflict);
  assert.deepEqual(store.read(), before);

  const saved = store.updateView(input);
  assert.deepEqual(saved.view.layouts.execute.positions, positions);
  assert.deepEqual(saved.view.layouts.execute.manualNodeIds, []);
  assert.deepEqual(saved.view.layouts.execute.routes, input.layout.routes);
  assert.deepEqual(saved.view.layouts.prepare, before.view.layouts.prepare);
  assert.deepEqual(saved.view.positions, before.view.positions);
  assert.deepEqual(saved.view.manualNodeIds, before.view.manualNodeIds);
  assert.deepEqual(business(saved), business(before));

  const reopened = createStore(task);
  assert.deepEqual(reopened.read(), saved);
  assert.deepEqual(reopened.updateView(input), saved);
  const restored = layout(reopened, 'execute', 'undo');
  assert.deepEqual(restored.view.layouts.execute.positions, before.view.layouts.execute.positions);
  assert.deepEqual(restored.view.layouts.execute.manualNodeIds, before.view.layouts.execute.manualNodeIds);
  assert.deepEqual(restored.view.layouts.prepare, before.view.layouts.prepare);
  assert.deepEqual(business(restored), business(before));

  const edited = reopened.edit({ requestId: randomUUID(), baseWorkRevision: restored.workRevision, baseModelHash: restored.modelHash,
    nodeId: 'validate', title: '重置计算期间修改的节点名称' });
  assert.throws(() => layout(reopened, 'execute', 'reset', { positions, baseModelHash: before.modelHash }), conflict);
  assert.deepEqual(reopened.read(), edited);
});

test('one-step arrange undo preserves later manual moves, including a move whose pin was released', t => {
  const { store, task } = setup(t);
  const original = store.read().view.positions;
  move(store, 'execute', { manual: { x: 77, y: 88 } });
  arrange(store, 'execute', { validate: { x: 1000, y: 1100 }, dispatch: { x: 1200, y: 1300 } }, { 'validate--dispatch': route });
  move(store, 'execute', { validate: { x: 1110, y: 1180 } });
  layout(store, 'execute', 'release', { nodeIds: ['validate'] });
  const reopened = createStore(task);
  layout(reopened, 'execute', 'undo');
  const restored = reopened.read();
  assert.deepEqual(restored.view.layouts.execute.positions.validate, { x: 1110, y: 1180 });
  assert.deepEqual(restored.view.layouts.execute.positions.dispatch, original.dispatch);
  assert.deepEqual(restored.view.layouts.execute.positions.manual, { x: 77, y: 88 });
  assert.deepEqual(restored.view.layouts.execute.manualNodeIds, ['manual']);
  assert.deepEqual(restored.view.layouts.execute.routes, {});
  assert.equal(restored.view.layouts.execute.previous, undefined);
  assert.throws(() => layout(reopened, 'execute', 'undo'), conflict);
  assert.deepEqual(reopened.read(), restored);
});

test('layout compare-and-swap is per scope and retries do not replay or create changes', t => {
  const { store } = setup(t);
  const before = store.read();
  const input = { requestId: randomUUID(), layout: { scopeId: 'prepare', action: 'arrange', baseRevision: 0, baseModelHash: before.modelHash, positions: { calculate: { x: 100, y: 200 } } } };
  store.updateView(input);
  arrange(store, 'execute', { manual: { x: 800, y: 800 } });
  const saved = store.read();
  assert.deepEqual(store.updateView(input), saved);
  assert.throws(() => store.updateView({ ...input, requestId: randomUUID() }), conflict);
  assert.deepEqual(store.read(), saved);
  const edited = store.edit({ requestId: randomUUID(), baseWorkRevision: saved.workRevision, baseModelHash: saved.modelHash, nodeId: 'manual', title: '布局期间修改的节点名称' });
  assert.throws(() => layout(store, 'prepare', 'arrange', { positions: { calculate: { x: 300, y: 400 } }, baseModelHash: before.modelHash }), conflict);
  assert.deepEqual(store.read(), edited);
  assert.throws(() => store.updateView({ layout: { scopeId: 'prepare', action: 'arrange', baseRevision: 1, positions: {} } }), conflict);
});

test('invalid coordinates, routes, scope membership and prototype keys fail transactionally', t => {
  const { store } = setup(t);
  const state = store.read();
  const base = { scopeId: 'prepare', action: 'arrange', baseRevision: 0, baseModelHash: state.modelHash, positions: { calculate: { x: 100, y: 200 } } };
  const cases = [
    { positions: { calculate: { x: NaN, y: 200 } } },
    { positions: { calculate: { x: Infinity, y: 200 } } },
    { positions: { calculate: { x: 1000001, y: 200 } } },
    { positions: { calculate: { x: 200, y: 300 }, validate: { x: 1, y: 2 } } },
    { scopeId: 'missing' }, { scopeId: '__proto__' }, { scopeId: 'constructor' },
    { positions: JSON.parse('{"__proto__":{"x":1,"y":2}}') },
    { positions: { calculate: JSON.parse('{"x":1,"y":2,"constructor":{}}') } },
    { positions: Object.create({ calculate: { x: 1, y: 2 } }) },
    { routes: { 'validate--dispatch': route } },
    { routes: { 'demand--calculate': { ...route, points: [{ x: 1, y: 2 }] } } },
    { routes: { 'demand--calculate': { ...route, points: [{ x: 1, y: 2 }, { x: 1, y: NaN }] } } },
    { routes: { 'demand--calculate': { ...route, label: { x: 0, y: 0, width: 0, height: 20 } } } },
    { routes: { 'demand--calculate': { ...route, geometryKey: '' } } },
    { routes: JSON.parse('{"constructor":{}}') },
    { nodeIds: ['calculate'] },
  ];
  for (const action of ['arrange', 'initialize']) for (const invalid of [...cases, { positions: undefined }]) {
    assert.throws(() => store.updateView({ selectedGroupId: 'execute', layout: { ...base, action, ...invalid } }), undefined, `${action}: ${JSON.stringify(invalid)}`);
    assert.deepEqual(store.read(), state);
  }
  assert.throws(() => layout(store, 'prepare', 'release', { nodeIds: ['validate'] }));
  assert.throws(() => store.updateView({ positions: { calculate: { x: 1, y: 2 } }, layout: base }));
  assert.deepEqual(store.read(), state);
  assert.equal({}.x, undefined);
});

test('legacy position writes remain global baselines and newly created scopes inherit known manual nodes', t => {
  const { store } = setup(t);
  const before = store.read();
  store.updateView({ positions: { calculate: { x: 41, y: 51 } } });
  assert.deepEqual(store.read().view.manualNodeIds, ['calculate']);
  assert.throws(() => arrange(store, 'prepare', { calculate: { x: 99, y: 99 } }), conflict);
  move(store, 'prepare', { manual: { x: 100, y: 150 } });
  const prepare = structuredClone(store.read().view.layouts.prepare);
  store.updateView({ positions: { calculate: { x: 67, y: 89 } } });
  assert.deepEqual(store.read().view.layouts.prepare, prepare);
  move(store, 'execute', { manual: { x: 400, y: 550 } });
  assert.deepEqual(store.read().view.layouts.execute.positions.calculate, { x: 67, y: 89 });
  assert.ok(store.read().view.layouts.execute.manualNodeIds.includes('calculate'));
  assert.deepEqual(business(store.read()), business(before));
});

function json(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function historicalView(task, before, after) {
  const id = randomUUID();
  const directory = path.join(task, 'workbench', 'transactions', id);
  fs.mkdirSync(directory);
  json(path.join(directory, 'before.json'), before);
  json(path.join(directory, 'after.json'), after);
  json(path.join(directory, 'transaction.json'), { id, operation: 'view', beforeRevision: before.stateRevision, afterRevision: after.stateRevision, beforeHash: digest(before), afterHash: digest(after) });
  json(path.join(directory, 'receipt.json'), { transactionId: id, status: 'applied' });
}

test('legacy migration infers manual differences while preserving an imported coordinate baseline', t => {
  const { store, task } = setup(t, {});
  const initial = store.read();
  delete initial.view.manualNodeIds;
  delete initial.view.layouts;
  const imported = structuredClone(initial);
  imported.stateRevision++;
  imported.view.positions = createDemoPositions();
  historicalView(task, initial, imported);
  const adjusted = structuredClone(imported);
  adjusted.stateRevision++;
  adjusted.view.positions.validate = { x: 789, y: 123 };
  historicalView(task, imported, adjusted);
  json(path.join(task, 'workbench', 'state.json'), adjusted);
  const reopened = createStore(task);
  const migrated = reopened.read();
  assert.deepEqual(migrated.view.manualNodeIds, ['validate']);
  assert.deepEqual(migrated.view.positions, adjusted.view.positions);
  assert.deepEqual(migrated.view.layouts, {});
  assert.deepEqual(business(migrated), business(initial));
  assert.equal(migrated.stateRevision, adjusted.stateRevision + 1);
  assert.deepEqual(createStore(task).read(), migrated, 'migration is only recorded once');
  assert.throws(() => initialize(reopened, 'execute', { validate: { x: 1, y: 1 } }), conflict);
  assert.deepEqual(reopened.read(), migrated);
  initialize(reopened, 'execute', { manual: { x: 444, y: 555 } });
  assert.deepEqual(reopened.read().view.layouts.execute.manualNodeIds, ['validate']);
  assert.deepEqual(reopened.read().view.layouts.execute.positions.validate, { x: 789, y: 123 });
  assert.throws(() => arrange(reopened, 'execute', { validate: { x: 1, y: 1 } }), conflict);
});

test('legacy tasks without position history keep existing coordinates unpinned; absent positions migrate safely', t => {
  const { store, task } = setup(t);
  const old = store.read();
  delete old.view.manualNodeIds;
  delete old.view.layouts;
  json(path.join(task, 'workbench', 'state.json'), old);
  let reopened = createStore(task);
  assert.deepEqual(reopened.read().view.manualNodeIds, []);
  assert.deepEqual(reopened.read().view.positions, old.view.positions);
  arrange(reopened, 'execute', { validate: { x: 50, y: 60 } });
  const noPositions = reopened.read();
  delete noPositions.view.positions;
  delete noPositions.view.manualNodeIds;
  delete noPositions.view.layouts;
  json(path.join(task, 'workbench', 'state.json'), noPositions);
  reopened = createStore(task);
  assert.deepEqual(reopened.read().view.positions, {});
  assert.deepEqual(reopened.read().view.manualNodeIds, []);
  move(reopened, 'prepare', { calculate: { x: 70, y: 80 } });
  assert.deepEqual(reopened.read().view.layouts.prepare.positions.calculate, { x: 70, y: 80 });
});

test('an interrupted prepared layout transaction is recovered without changing the business revision', t => {
  const { store, task } = setup(t);
  const before = store.read();
  const saved = arrange(store, 'execute', { validate: { x: 33, y: 44 } }, { 'validate--dispatch': route });
  const transaction = path.join(task, 'workbench', 'transactions', saved.lastTransactionId);
  fs.copyFileSync(path.join(transaction, 'before.json'), path.join(task, 'workbench', 'state.json'));
  fs.unlinkSync(path.join(transaction, 'receipt.json'));
  const restored = createStore(task).read();
  assert.deepEqual(restored, saved);
  assert.deepEqual(business(restored), business(before));
});

test('automatic refresh upgrades a saved layout while retaining pins, explicit undo and other scopes', async t => {
  const { store, task } = setup(t);
  const { getGraphScope } = await import('../frontend/src/graph-scope.mjs');
  arrange(store, 'prepare', { calculate: { x: 500, y: 500 } });
  arrange(store, 'execute', { validate: { x: 100, y: 200 } });
  move(store, 'execute', { validate: { x: 145, y: 235 } });
  const before = store.read(), saved = before.view.layouts.execute;
  const inputKey = 'elk-input:v3:DOWN:1234567890abcdef:120';
  const positions = Object.fromEntries([...getGraphScope(before.model, 'execute').visibleIds].map((id, index) => [id,
    saved.manualNodeIds.includes(id) ? saved.positions[id] : { x: 400, y: index * 220 },
  ]));
  const input = { requestId: randomUUID(), layout: { scopeId: 'execute', action: 'refresh', baseRevision: saved.revision, baseModelHash: before.modelHash, inputKey, positions, routes: {} } };
  const after = store.updateView(input);
  assert.equal(after.view.layouts.execute.inputKey, inputKey);
  assert.deepEqual(after.view.layouts.execute.manualNodeIds, saved.manualNodeIds);
  assert.deepEqual(after.view.layouts.execute.positions.validate, saved.positions.validate);
  assert.deepEqual(after.view.layouts.execute.previous, saved.previous, 'automatic maintenance must not consume explicit undo');
  assert.deepEqual(after.view.layouts.prepare, before.view.layouts.prepare);
  assert.deepEqual(business(after), business(before));
  assert.deepEqual(createStore(task).read(), after);
  assert.deepEqual(store.updateView(input), after, 'replayed request remains idempotent');
  assert.throws(() => store.updateView({ ...input, requestId: randomUUID() }), conflict);

  const partial = { ...positions }; delete partial.manual;
  assert.throws(() => layout(store, 'execute', 'refresh', { inputKey, positions: partial }));
  assert.throws(() => layout(store, 'execute', 'refresh', { inputKey, positions: { ...positions, validate: { x: 0, y: 0 } } }), conflict);
  assert.throws(() => layout(store, 'execute', 'refresh', { positions }));
  assert.throws(() => layout(store, 'execute', 'refresh', { inputKey: 'not-a-layout-signature', positions }));
  assert.deepEqual(store.read(), after);
});

test('undo adopts its final card measurement without moving positions or reintroducing a prior arrangement', async t => {
  const { store } = setup(t);
  const { getGraphScope } = await import('../frontend/src/graph-scope.mjs');
  const initial = store.read();
  const positions = Object.fromEntries([...getGraphScope(initial.model, 'execute').visibleIds].map((id, index) => [id, { x: 100, y: index * 220 }]));
  const firstKey = 'elk-input:v3:DOWN:1234567890abcdef:120';
  layout(store, 'execute', 'initialize', { positions, inputKey: firstKey });
  move(store, 'execute', { validate: { x: 900, y: 200 } });
  layout(store, 'execute', 'reset', { positions, inputKey: firstKey });
  const undone = layout(store, 'execute', 'undo');
  assert.equal(undone.view.layouts.execute.needsMeasurement, undone.modelHash);
  assert.deepEqual(undone.view.layouts.execute.positions.validate, { x: 900, y: 200 });
  const finalKey = 'elk-input:v3:DOWN:abcdef1234567890:120';
  const measured = layout(store, 'execute', 'measure', { inputKey: finalKey });
  assert.deepEqual(measured.view.layouts.execute.positions, undone.view.layouts.execute.positions);
  assert.deepEqual(measured.view.layouts.execute.manualNodeIds, undone.view.layouts.execute.manualNodeIds);
  assert.equal(measured.view.layouts.execute.previous, undefined);
  assert.equal(measured.view.layouts.execute.needsMeasurement, undefined);
  assert.equal(measured.view.layouts.execute.inputKey, finalKey);
  assert.deepEqual(business(measured), business(undone));
  assert.throws(() => layout(store, 'execute', 'measure', { inputKey: finalKey }), conflict, 'measurement-only cannot silently accept arbitrary new content');
  assert.deepEqual(store.read(), measured);
});

test('undo measurement cannot absorb later model changes or incomplete restored node coordinates', async t => {
  const { store } = setup(t, {});
  const key = 'elk-input:v3:DOWN:1234567890abcdef:120';
  layout(store, 'execute', 'initialize', { positions: { validate: { x: 100, y: 100 } }, inputKey: key });
  arrange(store, 'execute', { validate: { x: 200, y: 200 } });
  const undone = layout(store, 'execute', 'undo');
  assert.throws(() => layout(store, 'execute', 'measure', { inputKey: key }), conflict, 'missing node positions require refresh instead of adopting the signature');
  assert.deepEqual(store.read(), undone);
  const edited = store.edit({ requestId: randomUUID(), nodeId: 'validate', title: '撤销之后内容再次改变', baseWorkRevision: undone.workRevision, baseModelHash: undone.modelHash });
  assert.throws(() => layout(store, 'execute', 'measure', { inputKey: key }), conflict);
  assert.deepEqual(store.read(), edited);
  assert.throws(() => layout(store, 'execute', 'measure', { inputKey: key, baseModelHash: undone.modelHash }), conflict);
});
