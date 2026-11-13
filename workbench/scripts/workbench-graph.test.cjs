'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const scopeModule = import('../frontend/src/graph-scope.mjs');

function fixture() {
  return {
    nodes: [
      { id: 'upper', groupId: 'before' }, { id: 'aggregate', groupId: 'before' },
      { id: 'a', groupId: 'current' }, { id: 'b', groupId: 'current' },
      { id: 'join', groupId: 'after' }, { id: 'later', groupId: 'after' },
      { id: 'unrelated', groupId: 'after' },
    ],
    relations: [
      { id: 'upper-aggregate', from: 'upper', to: 'aggregate' },
      { id: 'aggregate-a', from: 'aggregate', to: 'a', type: 'conditional' },
      { id: 'aggregate-b', from: 'aggregate', to: 'b', type: 'conditional' },
      { id: 'a-join', from: 'a', to: 'join', type: 'data' },
      { id: 'b-join', from: 'b', to: 'join', type: 'sequence' },
      { id: 'join-later', from: 'join', to: 'later' },
      { id: 'join-aggregate', from: 'join', to: 'aggregate', type: 'return' },
    ],
  };
}

test('group scope includes shared upstream and downstream nodes once, without changing the model', async () => {
  const { getGraphScope } = await scopeModule;
  const model = fixture(), original = structuredClone(model);
  const scope = getGraphScope(model, 'current');
  assert.deepEqual(scope.coreNodes.map(n => n.id), ['a', 'b']);
  assert.deepEqual(scope.contextNodes.map(n => n.id), ['aggregate', 'join']);
  assert.deepEqual(scope.nodes.map(n => n.id), ['aggregate', 'a', 'b', 'join']);
  assert.deepEqual(scope.relations.map(r => r.id), ['aggregate-a', 'aggregate-b', 'a-join', 'b-join', 'join-aggregate']);
  assert.equal(scope.crossGroupRelations.length, 4);
  assert.deepEqual(model, original);
});

test('scope expansion is exactly one hop even when relation order changes', async () => {
  const { getGraphScope } = await scopeModule;
  const model = fixture();
  const scope = getGraphScope({ ...model, relations: [...model.relations].reverse() }, 'current');
  assert.equal(scope.visibleIds.has('upper'), false);
  assert.equal(scope.visibleIds.has('later'), false);
  assert.equal(scope.visibleIds.has('unrelated'), false);
  assert.deepEqual(new Set(scope.boundaryRelations.map(r => r.id)), new Set(['upper-aggregate', 'join-later']));
});

test('all groups show original objects and relations without an outside designation', async () => {
  const { getGraphScope } = await scopeModule;
  const model = fixture(), scope = getGraphScope(model, 'all');
  assert.deepEqual(scope.nodes, model.nodes);
  assert.deepEqual(scope.relations, model.relations);
  assert.equal(scope.contextNodes.length, 0);
  assert.equal(scope.crossGroupRelations.length, 0);
  assert.equal(scope.boundaryRelations.length, 0);
});

test('empty or invalid scopes do not invent nodes or links', async () => {
  const { getGraphScope } = await scopeModule;
  const model = fixture();
  model.relations.push({ id: 'dangling', from: 'a', to: 'missing' });
  assert.equal(getGraphScope(model, 'current').visibleIds.has('missing'), false);
  assert.deepEqual(getGraphScope(model, 'missing').nodes, []);
  assert.deepEqual(getGraphScope({ nodes: [], relations: [] }, 'all').relations, []);
});
