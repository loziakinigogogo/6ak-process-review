'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const layoutModule = import('../frontend/src/graph-layout.mjs');
const node = (id, height = 180) => ({ id, x: 31, y: 67, width: 240, height });
const edge = (id, from, to, extra = {}) => ({ id, from, to, type: 'sequence', ...extra });
const overlaps = (a, b) => a.x < b.x + b.width - .001 && a.x + a.width > b.x + .001
  && a.y < b.y + b.height - .001 && a.y + a.height > b.y + .001;

function verifyRightGeometry(input, result) {
  const nodes = input.nodes.map(n => ({ ...n, ...result.positions[n.id] }));
  for (const [index, n] of nodes.entries()) for (const other of nodes.slice(index + 1)) {
    assert.equal(overlaps(n, other), false, `${n.id} overlaps ${other.id}`);
  }
  const labels = [];
  for (const [id, route] of Object.entries(result.routes)) {
    const relation = input.edges.find(e => e.id === id);
    const from = nodes.find(n => n.id === relation.from), to = nodes.find(n => n.id === relation.to);
    for (const [point, n, source] of [[route.points[0], from, true], [route.points.at(-1), to, false]]) {
      if (relation.type === 'return') {
        assert.ok(Math.abs(point.y - n.y) < .001 && point.x > n.x && point.x < n.x + n.width, `${id} must attach to the top side`);
      } else {
        const side = n.x + (source ? n.width : 0);
        assert.ok(Math.abs(point.x - side) < .001 && point.y > n.y && point.y < n.y + n.height, `${id} must attach to the ${source ? 'right' : 'left'} side`);
      }
    }
    assert.equal(route.geometryKey, result.geometryKey);
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1], b = route.points[i];
      const vertical = Math.abs(a.x - b.x) < .001;
      assert.ok(vertical || Math.abs(a.y - b.y) < .001, `${id} must be orthogonal`);
      for (const n of nodes) {
        const hits = vertical
          ? a.x > n.x + .001 && a.x < n.x + n.width - .001 && Math.max(a.y, b.y) > n.y + .001 && Math.min(a.y, b.y) < n.y + n.height - .001
          : a.y > n.y + .001 && a.y < n.y + n.height - .001 && Math.max(a.x, b.x) > n.x + .001 && Math.min(a.x, b.x) < n.x + n.width - .001;
        assert.equal(hits, false, `${id} intersects ${n.id}`);
      }
    }
    if (route.label) {
      assert.equal(route.label.width, relation.labelWidth);
      assert.equal(route.label.height, relation.labelHeight);
      for (const box of [...nodes, ...labels]) assert.equal(overlaps(route.label, box), false, `${id} label overlaps another box`);
      labels.push(route.label);
    }
  }
}

function assertSeparateRoutes(routes, ids, endpointIndex) {
  const segments = id => routes[id].points.slice(1).map((end, index) => {
    const start = routes[id].points[index];
    const axis = Math.abs(start.x - end.x) < .001 ? 'x' : 'y';
    const along = axis === 'x' ? 'y' : 'x';
    return { axis, fixed: start[axis], low: Math.min(start[along], end[along]), high: Math.max(start[along], end[along]) };
  });
  for (const [index, first] of ids.entries()) for (const second of ids.slice(index + 1)) {
    const gap = Math.abs(routes[first].points.at(endpointIndex).y - routes[second].points.at(endpointIndex).y);
    assert.ok(gap >= 8, `${first} and ${second} must attach at distinct points`);
    for (const a of segments(first)) for (const b of segments(second)) {
      if (a.axis !== b.axis || Math.abs(a.fixed - b.fixed) >= .001) continue;
      assert.ok(Math.min(a.high, b.high) - Math.max(a.low, b.low) < .001, `${first} and ${second} must have no shared straight segment`);
    }
  }
}

test('production horizontal layout handles wider cards, branches, shortcuts, return labels and frozen input', async () => {
  const { arrangeGraph, routeGeometryKey } = await layoutModule;
  const input = {
    direction: 'RIGHT', nodes: [node('start'), node('a', 130), node('b', 216), node('c', 156), node('d', 190), node('approval', 170), node('done', 120)],
    edges: [
      ...['a', 'b', 'c', 'd'].map(id => edge(`start-${id}`, 'start', id, { type: 'conditional', label: `Channel ${id}`, labelWidth: 156, labelHeight: 24 })),
      ...['a', 'b', 'c', 'd'].map(id => edge(`${id}-approval`, id, 'approval')),
      edge('approval-done', 'approval', 'done'), edge('shortcut', 'start', 'done'),
      edge('return', 'approval', 'start', { type: 'return', label: 'Needs revision', labelWidth: 144, labelHeight: 40 }),
    ],
  };
  const before = structuredClone(input);
  input.nodes.forEach(Object.freeze); input.edges.forEach(Object.freeze);
  Object.freeze(input.nodes); Object.freeze(input.edges); Object.freeze(input);
  const result = await arrangeGraph(input);
  assert.equal(Object.keys(result.routes).length, input.edges.length);
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.ok(result.positions.start.x < result.positions[id].x);
    assert.ok(result.positions[id].x < result.positions.approval.x);
  }
  assert.ok(result.positions.approval.x < result.positions.done.x);
  verifyRightGeometry(input, result);
  assertSeparateRoutes(result.routes, ['start-a', 'start-b', 'start-c', 'start-d', 'shortcut'], 0);
  assertSeparateRoutes(result.routes, ['a-approval', 'b-approval', 'c-approval', 'd-approval'], -1);
  assert.equal(result.geometryKey, routeGeometryKey(input.nodes.map(n => ({ ...n, ...result.positions[n.id] })), input.edges, 'RIGHT'));
  assert.deepEqual(input, before);
  assert.deepEqual(await arrangeGraph({ ...input, nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() }), result);
});

test('horizontal pinned coordinates remain exact while automatic nodes avoid fixed nodes along a layer', async () => {
  const { arrangeGraph } = await layoutModule;
  const initial = {
    direction: 'RIGHT', nodes: ['a', 'b', 'c', 'd'].map(id => node(id)),
    edges: [edge('a-b', 'a', 'b'), edge('b-c', 'b', 'c'), edge('a-d', 'a', 'd')],
  };
  const baseline = await arrangeGraph(initial);
  const input = {
    ...initial,
    nodes: initial.nodes.map(n => n.id === 'a' ? { ...n, x: -213.25, y: 47.75 }
      : n.id === 'd' ? { ...n, x: -213.25 + baseline.positions.b.x - baseline.positions.a.x, y: 47.75 } : n),
    manualNodeIds: ['a', 'd'],
  };
  const before = structuredClone(input);
  const result = await arrangeGraph(input);
  for (const id of input.manualNodeIds) {
    const n = input.nodes.find(n => n.id === id);
    assert.deepEqual(result.positions[id], { x: n.x, y: n.y });
  }
  assert.ok(result.diagnostics.adjustedNodeIds.length > 0);
  assert.ok(result.diagnostics.discardedRouteIds.length > 0);
  verifyRightGeometry(input, result);
  assert.deepEqual(input, before);
});

test('a fixed horizontal blocker invalidates route reuse even when endpoint coordinates stay unchanged', async () => {
  const { arrangeGraph } = await layoutModule;
  const initial = { direction: 'RIGHT', nodes: [node('a'), node('b'), { ...node('blocker', 60), width: 40 }], edges: [edge('a-b', 'a', 'b')] };
  const baseline = await arrangeGraph(initial);
  const points = baseline.routes['a-b'].points;
  assert.equal(points.length, 2);
  const input = {
    ...initial,
    nodes: initial.nodes.map(n => n.id === 'blocker'
      ? { ...n, x: (points[0].x + points[1].x - n.width) / 2, y: points[0].y - n.height / 2 }
      : { ...n, ...baseline.positions[n.id] }),
    manualNodeIds: initial.nodes.map(n => n.id),
  };
  const result = await arrangeGraph(input);
  assert.deepEqual(result.positions.a, baseline.positions.a);
  assert.deepEqual(result.positions.b, baseline.positions.b);
  assert.equal(result.routes['a-b'], undefined);
  assert.deepEqual(result.diagnostics.discardedRouteIds, ['a-b']);
});

test('legacy vertical layout and cache keys stay byte-identical; direction separates square geometry', async () => {
  const { arrangeGraph, routeGeometryKey } = await layoutModule;
  const nodes = [{ id: 'a', x: 3, y: 3, width: 200, height: 200 }, { id: 'b', x: 7, y: 7, width: 200, height: 200 }];
  const edges = [edge('a-b', 'a', 'b', { label: 'ok', labelWidth: 40, labelHeight: 24 })];
  const legacyKey = 'elk-route:v1:72b062d46228b4ee:79';
  assert.equal(routeGeometryKey(nodes, edges), legacyKey);
  assert.equal(routeGeometryKey(nodes, edges, 'DOWN'), legacyKey);
  assert.notEqual(routeGeometryKey(nodes, edges, 'RIGHT'), legacyKey);
  const defaultResult = await arrangeGraph({ nodes, edges });
  assert.deepEqual(await arrangeGraph({ nodes, edges, direction: 'DOWN' }), defaultResult);
  // Captured before introducing direction support, with pinned ELK dependencies.
  assert.equal(createHash('sha256').update(JSON.stringify(defaultResult)).digest('hex'), 'a0d1c79499e11d593c5fa63d739e850afce140fd80e437bd75687cbe3dea1f9a');
  await assert.rejects(arrangeGraph({ nodes, edges, direction: 'AUTO' }), /Unsupported layout direction/);
  assert.throws(() => routeGeometryKey(nodes, edges, 'LEFT'), /Unsupported layout direction/);
});
