'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const comparisonModule = import('../frontend/src/comparison-layout.mjs');
const layoutModule = import('../frontend/src/graph-layout.mjs');
const overlaps = (a, b) => a.x < b.x + b.width - .001 && a.x + a.width > b.x + .001
  && a.y < b.y + b.height - .001 && a.y + a.height > b.y + .001;

function fixture() {
  const node = (id, height = 180) => ({ id, x: 27, y: 63, width: 200, height });
  const branch = id => ({ id: `start-${id}`, from: 'start', to: id, type: 'conditional', label: `Synthetic channel ${id}`, labelWidth: 156, labelHeight: 24 });
  return {
    nodes: [node('start'), node('a', 150), node('b', 208), node('c', 175), node('d', 192), node('approval', 160), node('done', 120)],
    edges: [
      ...['a', 'b', 'c', 'd'].map(branch),
      ...['a', 'b', 'c', 'd'].map(id => ({ id: `${id}-approval`, from: id, to: 'approval', type: 'sequence' })),
      { id: 'approval-done', from: 'approval', to: 'done', type: 'sequence' },
      { id: 'return', from: 'approval', to: 'start', type: 'return', label: 'Synthetic revision', labelWidth: 140, labelHeight: 24 },
    ],
  };
}

function verifyGeometry(input, result, direction) {
  const nodes = input.nodes.map(node => ({ ...node, ...result.positions[node.id] }));
  for (const [index, node] of nodes.entries()) for (const other of nodes.slice(index + 1)) {
    assert.equal(overlaps(node, other), false, `${node.id} overlaps ${other.id}`);
  }
  const labels = [];
  for (const [id, route] of Object.entries(result.routes)) {
    const edge = input.edges.find(edge => edge.id === id);
    const from = nodes.find(node => node.id === edge.from), to = nodes.find(node => node.id === edge.to);
    const isReturn = edge.type === 'return';
    const horizontalSide = direction === 'RIGHT' ? isReturn : !isReturn;
    for (const [point, node, source] of [[route.points[0], from, true], [route.points.at(-1), to, false]]) {
      const along = horizontalSide ? point.x : point.y;
      const low = horizontalSide ? node.x : node.y;
      const high = low + (horizontalSide ? node.width : node.height);
      const offset = source && !isReturn ? (horizontalSide ? node.height : node.width) : 0;
      const side = (horizontalSide ? node.y : node.x) + offset;
      assert.ok(along > low && along < high && Math.abs((horizontalSide ? point.y : point.x) - side) < .001, `${id} attaches to the correct card side`);
    }
    assert.equal(route.geometryKey, result.geometryKey);
    for (let index = 1; index < route.points.length; index++) {
      const a = route.points[index - 1], b = route.points[index];
      const vertical = Math.abs(a.x - b.x) < .001;
      assert.ok(vertical || Math.abs(a.y - b.y) < .001, `${id} must remain orthogonal`);
      for (const node of nodes) {
        const hits = vertical
          ? a.x > node.x + .001 && a.x < node.x + node.width - .001 && Math.max(a.y, b.y) > node.y + .001 && Math.min(a.y, b.y) < node.y + node.height - .001
          : a.y > node.y + .001 && a.y < node.y + node.height - .001 && Math.max(a.x, b.x) > node.x + .001 && Math.min(a.x, b.x) < node.x + node.width - .001;
        assert.equal(hits, false, `${id} intersects ${node.id}`);
      }
    }
    if (route.label) {
      assert.equal(route.label.width, edge.labelWidth);
      assert.equal(route.label.height, edge.labelHeight);
      for (const box of [...nodes, ...labels]) assert.equal(overlaps(route.label, box), false, `${id} label overlaps another box`);
      labels.push(route.label);
    }
  }
}

test('horizontal comparison preserves card dimensions, branch/chain order, label bounds, and return ports', async () => {
  const { arrangeComparisonGraph } = await comparisonModule;
  const { routeGeometryKey } = await layoutModule;
  const input = fixture(), before = structuredClone(input);
  const result = await arrangeComparisonGraph(input);
  assert.equal(Object.keys(result.routes).length, input.edges.length);
  for (const id of ['a', 'b', 'c', 'd']) {
    assert.ok(result.positions.start.x < result.positions[id].x);
    assert.ok(result.positions[id].x < result.positions.approval.x);
  }
  assert.ok(result.positions.approval.x < result.positions.done.x);
  verifyGeometry(input, result, 'RIGHT');
  assert.equal(result.geometryKey, routeGeometryKey(input.nodes.map(node => ({ ...node, ...result.positions[node.id] })), input.edges, 'RIGHT'));
  assert.deepEqual(input, before, 'comparison must not mutate the source model or its positions');
});

test('vertical comparison exactly matches the existing automatic layout', async () => {
  const { arrangeComparisonGraph } = await comparisonModule;
  const { arrangeGraph } = await layoutModule;
  const input = fixture();
  const expected = await arrangeGraph(input);
  const actual = await arrangeComparisonGraph({ ...input, direction: 'DOWN' });
  assert.deepEqual(actual, expected);
  verifyGeometry(input, actual, 'DOWN');
});

test('comparison accepts an empty graph and rejects unknown directions', async () => {
  const { arrangeComparisonGraph } = await comparisonModule;
  const result = await arrangeComparisonGraph({ nodes: [], edges: [] });
  assert.deepEqual(result.positions, {});
  assert.deepEqual(result.routes, {});
  await assert.rejects(arrangeComparisonGraph({ ...fixture(), direction: 'UP' }), /Unsupported layout direction/);
});
