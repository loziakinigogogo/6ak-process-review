'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStore } = require('./workbench-store.cjs');
const { createDemoModel, createDemoPositions } = require('./workbench-demo-fixture.cjs');

const qaRoot = path.resolve(__dirname, '../../.qa');
const scopeModule = import('../frontend/src/graph-scope.mjs');
const conflict = error => error.status === 409;
const badInput = error => error.status === 400;
const business = state => ({ model: state.model, modelHash: state.modelHash, preferenceHash: state.preferenceHash,
  workRevision: state.workRevision, pendingEdits: state.pendingEdits, changes: state.changes, preferences: state.preferences });

function setup(t) {
  fs.mkdirSync(qaRoot, { recursive: true });
  const task = fs.mkdtempSync(path.join(qaRoot, 'workbench-directions-'));
  t.after(() => {
    assert.ok(path.resolve(task).startsWith(qaRoot + path.sep), 'cleanup stays in the isolated QA workspace');
    fs.rmSync(task, { recursive: true, force: true });
  });
  return { task, stateFile: path.join(task, 'workbench/state.json'), store: createStore(task, { model: createDemoModel(), positions: createDemoPositions() }) };
}

function updateLayout(store, scopeId, direction, action, extra = {}) {
  const state = store.read();
  const layouts = direction === 'RIGHT' ? state.view.horizontalLayouts : state.view.layouts;
  return store.updateView({ requestId: randomUUID(), layout: { scopeId, direction, action,
    baseRevision: layouts?.[scopeId]?.revision || 0,
    ...(['initialize', 'arrange', 'reset'].includes(action) ? { baseModelHash: state.modelHash } : {}), ...extra } });
}

function setDirection(store, scopeId, mode, extra = {}) {
  return store.updateView({ requestId: randomUUID(), layoutDirection: { scopeId, mode,
    baseRevision: store.read().view.layoutDirections?.[scopeId]?.revision || 0, ...extra } });
}

test('new tasks default to automatic direction while reopening a legacy task adds no fields or transaction', t => {
  const { task, stateFile, store } = setup(t);
  const modern = store.read();
  assert.equal(modern.view.defaultLayoutDirection, 'AUTO');
  assert.equal(modern.view.horizontalLayouts, undefined);
  assert.equal(modern.view.layoutDirections, undefined);
  const legacy = structuredClone(modern);
  delete legacy.view.defaultLayoutDirection;
  fs.writeFileSync(stateFile, JSON.stringify(legacy, null, 2));
  const bytes = fs.readFileSync(stateFile);
  const transactionDirectory = path.join(task, 'workbench/transactions');
  const transactions = fs.readdirSync(transactionDirectory);
  const reopened = createStore(task);
  assert.deepEqual(reopened.read(), legacy);
  assert.deepEqual(fs.readFileSync(stateFile), bytes);
  assert.deepEqual(fs.readdirSync(transactionDirectory), transactions);
  assert.equal(reopened.read().view.defaultLayoutDirection ?? 'DOWN', 'DOWN');
});

test('each direction retains its own manual positions, reset/undo history and routes across restart', async t => {
  const { task, store } = setup(t);
  const initial = store.read();
  const reference = store.createReference({ baseWorkRevision: initial.workRevision, baseModelHash: initial.modelHash,
    targets: [{ type: 'node', id: 'validate' }] });
  const pinned = { x: 14.123456789, y: -22.987654321 };
  store.updateView({ positions: { calculate: pinned } });
  const baseline = store.read();
  const down = updateLayout(store, 'execute', 'DOWN', 'initialize', {
    positions: { calculate: pinned, validate: { x: 300, y: 450 } },
  });
  const route = { points: [{ x: 240, y: 100 }, { x: 300, y: 100 }], geometryKey: 'elk-route:v2:RIGHT:test' };
  const right = updateLayout(store, 'execute', 'RIGHT', 'initialize', {
    positions: { calculate: { x: 10, y: 100 }, validate: { x: 300, y: 100 } },
    routes: { 'validate--dispatch': route },
  });
  assert.deepEqual(right.view.layouts, down.view.layouts);
  assert.equal(right.view.horizontalLayouts.execute.revision, 1);
  assert.deepEqual(right.view.horizontalLayouts.execute.manualNodeIds, [], 'horizontal does not inherit vertical pins');
  assert.deepEqual(Object.keys(right.view.horizontalLayouts.execute.positions).sort(), ['calculate', 'validate']);
  assert.deepEqual(right.view.horizontalLayouts.execute.routes['validate--dispatch'], route);
  assert.equal(right.view.horizontalLayouts.execute.previous, undefined);

  updateLayout(store, 'execute', 'RIGHT', 'move', { positions: { validate: { x: 411, y: 177 } } });
  const beforeReset = store.read();
  const { getGraphScope } = await scopeModule;
  const resetPositions = Object.fromEntries(getGraphScope(beforeReset.model, 'execute').nodes.map((node, index) => [node.id, { x: index * 280, y: 80 }]));
  const reset = updateLayout(store, 'execute', 'RIGHT', 'reset', { positions: resetPositions });
  assert.deepEqual(reset.view.horizontalLayouts.execute.manualNodeIds, []);
  assert.deepEqual(reset.view.horizontalLayouts.execute.previous.positions, beforeReset.view.horizontalLayouts.execute.positions);
  updateLayout(store, 'execute', 'RIGHT', 'move', { positions: { calculate: { x: 51, y: 93 } } });
  const restored = updateLayout(store, 'execute', 'RIGHT', 'undo');
  assert.deepEqual(restored.view.horizontalLayouts.execute.positions.validate, { x: 411, y: 177 });
  assert.deepEqual(restored.view.horizontalLayouts.execute.positions.calculate, { x: 51, y: 93 }, 'undo keeps drags made after reset');
  assert.deepEqual(new Set(restored.view.horizontalLayouts.execute.manualNodeIds), new Set(['validate', 'calculate']));
  assert.deepEqual(restored.view.horizontalLayouts.execute.routes, {});
  assert.deepEqual(restored.view.layouts, down.view.layouts);

  const released = updateLayout(store, 'execute', 'RIGHT', 'release', { nodeIds: ['calculate'] });
  assert.deepEqual(released.view.horizontalLayouts.execute.manualNodeIds, ['validate']);
  assert.deepEqual(released.view.layouts.execute.manualNodeIds, ['calculate']);
  const afterDownMove = updateLayout(store, 'execute', 'DOWN', 'move', { positions: { validate: { x: 70, y: 650 } } });
  assert.deepEqual(afterDownMove.view.horizontalLayouts, released.view.horizontalLayouts);
  assert.deepEqual(afterDownMove.view.positions, baseline.view.positions);
  assert.deepEqual(afterDownMove.view.manualNodeIds, baseline.view.manualNodeIds);
  assert.deepEqual(business(afterDownMove), business(initial));
  const reopened = createStore(task);
  assert.deepEqual(reopened.read(), afterDownMove);
  assert.equal(reopened.reference(reference.id).stale, false);
  assert.deepEqual(reopened.reference(reference.id).context, reference.context);
});

test('directional layouts use independent scope revisions and reject stale or invalid writes atomically', t => {
  const { store } = setup(t);
  const before = store.read();
  const request = { requestId: randomUUID(), layout: { scopeId: 'execute', direction: 'RIGHT', action: 'initialize',
    baseRevision: 0, baseModelHash: before.modelHash, positions: { validate: { x: 260, y: 20 } } } };
  const first = store.updateView(request);
  assert.deepEqual(store.updateView(request), first, 'request retry is idempotent');
  for (const revision of [0, 1]) assert.throws(() => store.updateView({ ...request, requestId: randomUUID(),
    layout: { ...request.layout, baseRevision: revision } }), conflict);
  assert.throws(() => updateLayout(store, 'execute', 'RIGHT', 'move', { baseRevision: 0, positions: { validate: { x: 600, y: 20 } } }), conflict);

  // An old client that omits direction still addresses only the vertical map.
  const down = store.updateView({ requestId: randomUUID(), layout: { scopeId: 'execute', action: 'move',
    baseRevision: 0, positions: { validate: { x: 30, y: 400 } } } });
  assert.deepEqual(down.view.horizontalLayouts, first.view.horizontalLayouts);
  const prepared = updateLayout(store, 'prepare', 'RIGHT', 'initialize', { positions: { calculate: { x: 70, y: 50 } } });
  assert.deepEqual(prepared.view.horizontalLayouts.execute, first.view.horizontalLayouts.execute);
  assert.equal(prepared.view.horizontalLayouts.prepare.revision, 1);
  for (const direction of ['AUTO', 'UP', '', null, 2]) {
    assert.throws(() => updateLayout(store, 'execute', direction, 'move', { positions: { validate: { x: 0, y: 0 } } }), badInput);
    assert.deepEqual(store.read(), prepared);
  }
  assert.throws(() => updateLayout(store, 'execute', 'RIGHT', 'arrange', { baseModelHash: 'stale', positions: {} }), conflict);
  assert.throws(() => updateLayout(store, 'execute', 'RIGHT', 'move', { positions: { 'verify-orders': { x: 0, y: 0 } } }), badInput);
  assert.deepEqual(store.read(), prepared);
  assert.deepEqual(business(prepared), business(before));
});

test('direction preferences persist per scope with CAS while leaving both layouts and business references intact', t => {
  const { task, store } = setup(t);
  const initial = store.read();
  const right = updateLayout(store, 'execute', 'RIGHT', 'initialize', { positions: { validate: { x: 40, y: 80 } } });
  const reference = store.createReference({ baseWorkRevision: initial.workRevision, baseModelHash: initial.modelHash, targets: [] });
  const preference = { requestId: randomUUID(), layoutDirection: { scopeId: 'execute', mode: 'RIGHT', baseRevision: 0 } };
  const first = store.updateView(preference);
  assert.deepEqual(first.view.layoutDirections.execute, { mode: 'RIGHT', revision: 1 });
  assert.deepEqual(store.updateView(preference), first);
  assert.throws(() => setDirection(store, 'execute', 'DOWN', { baseRevision: 0 }), conflict);
  setDirection(store, 'prepare', 'DOWN');
  setDirection(store, 'execute', 'AUTO');
  const last = setDirection(store, 'all', 'RIGHT');
  assert.deepEqual(last.view.layoutDirections, { execute: { mode: 'AUTO', revision: 2 }, prepare: { mode: 'DOWN', revision: 1 }, all: { mode: 'RIGHT', revision: 1 } });
  assert.deepEqual(last.view.layouts, right.view.layouts);
  assert.deepEqual(last.view.horizontalLayouts, right.view.horizontalLayouts);
  assert.deepEqual(business(last), business(initial));
  assert.deepEqual(createStore(task).read(), last);
  assert.equal(store.reference(reference.id).stale, false);

  for (const mode of ['UP', '', null, 1]) {
    assert.throws(() => setDirection(store, 'execute', mode), badInput);
    assert.deepEqual(store.read(), last);
  }
  for (const scopeId of ['missing', '__proto__', 'constructor']) assert.throws(() => setDirection(store, scopeId, 'DOWN'), badInput);
  for (const baseRevision of [undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => setDirection(store, 'execute', 'DOWN', { baseRevision }), conflict);
  }
  assert.throws(() => setDirection(store, 'execute', 'DOWN', { unknown: true }), badInput);
  for (const extra of [{ positions: {} }, { layout: { scopeId: 'execute', direction: 'RIGHT', action: 'move', baseRevision: 1, positions: { validate: { x: 1, y: 2 } } } }]) {
    assert.throws(() => store.updateView({ ...extra, layoutDirection: { scopeId: 'execute', mode: 'DOWN', baseRevision: 2 } }), badInput);
  }
  assert.deepEqual(store.read(), last);
});
