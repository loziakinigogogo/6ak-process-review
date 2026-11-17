'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const layoutModule = import('../frontend/src/graph-layout.mjs');

const node = (id, x = 80, y = 0, width = 210, height = 110) => ({ id, x, y, width, height });
const edge = (id, from, to, extra = {}) => ({ id, from, to, type: 'sequence', ...extra });
const overlaps = (a, b) => a.x < b.x + b.width - 0.001 && a.x + a.width > b.x + 0.001
  && a.y < b.y + b.height - 0.001 && a.y + a.height > b.y + 0.001;

function finalNodes(input, result) { return input.nodes.map(n => ({ ...n, ...result.positions[n.id] })); }
function assertNoOverlap(nodes, allowedPairs = []) {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    if (allowedPairs.some(pair => pair.includes(nodes[i].id) && pair.includes(nodes[j].id))) continue;
    assert.equal(overlaps(nodes[i], nodes[j]), false, `nodes ${nodes[i].id} / ${nodes[j].id} overlap`);
  }
}
function assertSafeRoutes(input, result) {
  const nodes = finalNodes(input, result);
  for (const [id, route] of Object.entries(result.routes)) {
    const relation = input.edges.find(e => e.id === id);
    const from = nodes.find(n => n.id === relation.from), to = nodes.find(n => n.id === relation.to);
    for (const [point, n, source] of [[route.points[0], from, true], [route.points.at(-1), to, false]]) {
      if (relation.type === 'return') {
        assert.ok(Math.abs(point.x - n.x) < .001 && point.y > n.y && point.y < n.y + n.height, `${id} must attach to the left side`);
      } else {
        const side = n.y + (source ? n.height : 0);
        assert.ok(Math.abs(point.y - side) < .001 && point.x > n.x && point.x < n.x + n.width, `${id} must attach to the ${source ? 'bottom' : 'top'} side`);
      }
    }
    assert.equal(route.geometryKey, result.geometryKey);
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1], b = route.points[i];
      const vertical = Math.abs(a.x - b.x) < .001;
      assert.ok(vertical || Math.abs(a.y - b.y) < .001, `route ${id} is not orthogonal`);
      for (const n of nodes) {
        // Test the open rectangle so a section touching its own port is valid.
        const hits = vertical
          ? a.x > n.x + 0.001 && a.x < n.x + n.width - 0.001 && Math.max(a.y, b.y) > n.y + 0.001 && Math.min(a.y, b.y) < n.y + n.height - 0.001
          : a.y > n.y + 0.001 && a.y < n.y + n.height - 0.001 && Math.max(a.x, b.x) > n.x + 0.001 && Math.min(a.x, b.x) < n.x + n.width - 0.001;
        assert.equal(hits, false, `route ${id} intersects node ${n.id}`);
      }
    }
    if (route.label) for (const n of nodes) assert.equal(overlaps(route.label, n), false, `label ${id} intersects ${n.id}`);
  }
}

test('ELK routes a single-column shortcut around the intervening measured node', async () => {
  const { arrangeGraph } = await layoutModule;
  const input = {
    nodes: [node('a'), node('b', 80, 220, 320, 170), node('c', 80, 440)],
    edges: [edge('a-b', 'a', 'b'), edge('b-c', 'b', 'c'), edge('a-c', 'a', 'c')],
  };
  const result = await arrangeGraph(input);
  assert.equal(Object.keys(result.routes).length, 3);
  assert.ok(result.routes['a-c'].points.length >= 4);
  assertNoOverlap(finalNodes(input, result));
  assertSafeRoutes(input, result);
});

test('branches, merge, cross-group links, and return cycles consume actual ELK sections and label bounds', async () => {
  const { arrangeGraph } = await layoutModule;
  const input = {
    nodes: [node('a'), node('b'), node('c', 0, 0, 275, 145), node('d')].map((n, index) => ({ ...n, groupId: index % 2 ? 'outside' : 'inside' })),
    edges: [
      edge('a-b', 'a', 'b', { type: 'conditional', label: '审核通过后进入下一步', labelWidth: 184, labelHeight: 34 }),
      edge('a-c', 'a', 'c', { type: 'parallel', label: '同步完成材料核对', labelWidth: 168, labelHeight: 34 }),
      edge('b-d', 'b', 'd'), edge('c-d', 'c', 'd', { type: 'data' }),
      edge('d-a', 'd', 'a', { type: 'return', label: '需要补充资料', labelWidth: 126, labelHeight: 34 }),
    ],
  };
  const result = await arrangeGraph(input);
  assert.equal(Object.keys(result.routes).length, input.edges.length);
  assert.ok(result.routes['d-a'].points.length >= 4);
  assert.ok(Math.abs(result.routes['a-b'].points[0].x - result.routes['a-c'].points[0].x) >= 8, 'branches leave the source independently');
  assert.ok(Math.abs(result.routes['b-d'].points.at(-1).x - result.routes['c-d'].points.at(-1).x) >= 8, 'branches enter the shared target independently');
  for (const relation of input.edges.filter(e => e.label)) {
    assert.equal(result.routes[relation.id].label.width, relation.labelWidth);
    assert.equal(result.routes[relation.id].label.height, relation.labelHeight);
  }
  assertNoOverlap(finalNodes(input, result));
  assertSafeRoutes(input, result);
});

test('return cycles preserve the downward main-process order regardless of node IDs or main-edge type', async () => {
  const { arrangeGraph } = await layoutModule;
  for (const type of ['sequence', 'conditional', 'parallel']) {
    // The intermediate node sorts first, which previously made ELK reverse the
    // start-to-middle edge instead of the semantic return edge during layering.
    const input = {
      nodes: [node('z-start'), node('a-middle'), node('m-end')],
      edges: [edge('main-1', 'z-start', 'a-middle', { type }), edge('main-2', 'a-middle', 'm-end', { type }),
        edge('return', 'm-end', 'z-start', { type: 'return' })],
    };
    const snapshot = structuredClone(input);
    const result = await arrangeGraph(input);
    assert.ok(result.positions['z-start'].y < result.positions['a-middle'].y, `${type}: start must precede middle`);
    assert.ok(result.positions['a-middle'].y < result.positions['m-end'].y, `${type}: middle must precede end`);
    assert.equal(Object.keys(result.routes).length, 3);
    assertSafeRoutes(input, result);
    assert.deepEqual(input, snapshot);
  }
});

test('secondary data and association cycles do not reverse the main-process direction', async () => {
  const { arrangeGraph } = await layoutModule;
  for (const type of ['data', 'association']) {
    const input = {
      nodes: [node('z-start'), node('a-middle'), node('m-end')],
      edges: [edge('main-1', 'z-start', 'a-middle'), edge('main-2', 'a-middle', 'm-end'),
        edge('secondary', 'm-end', 'z-start', { type })],
    };
    const snapshot = structuredClone(input);
    const result = await arrangeGraph(input);
    assert.ok(result.positions['z-start'].y < result.positions['a-middle'].y, `${type}: start must precede middle`);
    assert.ok(result.positions['a-middle'].y < result.positions['m-end'].y, `${type}: middle must precede end`);
    assertSafeRoutes(input, result);
    assert.deepEqual(input, snapshot);
  }
});

test('manual coordinates remain exact while automatic nodes avoid fixed and automatic obstacles', async () => {
  const { arrangeGraph } = await layoutModule;
  const initial = {
    nodes: [node('a'), node('b'), node('c'), node('d')],
    edges: [edge('a-b', 'a', 'b'), edge('b-c', 'b', 'c'), edge('a-d', 'a', 'd')],
  };
  const baseline = await arrangeGraph(initial);
  const input = {
    nodes: initial.nodes.map(n => n.id === 'a' ? { ...n, x: -213.25, y: 47.75 }
      : n.id === 'd' ? { ...n, x: -213.25, y: 47.75 + baseline.positions.b.y - baseline.positions.a.y } : n),
    edges: initial.edges, manualNodeIds: ['a', 'd'],
  };
  const result = await arrangeGraph(input);
  for (const id of input.manualNodeIds) {
    const n = input.nodes.find(item => item.id === id);
    assert.deepEqual(result.positions[id], { x: n.x, y: n.y });
  }
  assertNoOverlap(finalNodes(input, result));
  assertSafeRoutes(input, result);
  assert.ok(result.diagnostics.adjustedNodeIds.length > 0);
  assert.ok(result.diagnostics.discardedRouteIds.length > 0);
});

test('a manual blocker invalidates an ELK route even when both endpoint positions are unchanged', async () => {
  const { arrangeGraph } = await layoutModule;
  const initial = { nodes: [node('a'), node('b'), node('blocker', 0, 0, 60, 40)], edges: [edge('a-b', 'a', 'b')] };
  const baseline = await arrangeGraph(initial);
  const path = baseline.routes['a-b'].points;
  assert.equal(path.length, 2);
  const input = {
    nodes: initial.nodes.map(n => n.id === 'blocker'
      ? { ...n, x: path[0].x - n.width / 2, y: (path[0].y + path[1].y - n.height) / 2 }
      : { ...n, ...baseline.positions[n.id] }),
    edges: initial.edges, manualNodeIds: initial.nodes.map(n => n.id),
  };
  const result = await arrangeGraph(input);
  assert.deepEqual(result.positions.a, baseline.positions.a);
  assert.deepEqual(result.positions.b, baseline.positions.b);
  assert.equal(result.routes['a-b'], undefined);
  assert.deepEqual(result.diagnostics.discardedRouteIds, ['a-b']);
});

test('overlapping manual nodes are preserved and reported, without moving automatic nodes into them', async () => {
  const { arrangeGraph } = await layoutModule;
  const input = { nodes: [node('a', -30, -20), node('b', -30, -20), node('c')], edges: [edge('a-c', 'a', 'c')], manualNodeIds: ['a', 'b'] };
  const result = await arrangeGraph(input);
  assert.deepEqual(result.positions.a, { x: -30, y: -20 });
  assert.deepEqual(result.positions.b, { x: -30, y: -20 });
  assert.deepEqual(result.diagnostics.overlappingManualPairs, [['a', 'b']]);
  assertNoOverlap(finalNodes(input, result), [['a', 'b']]);
  assertSafeRoutes(input, result);
});

test('a fixed node covering only an ELK label also invalidates its route', async () => {
  const { arrangeGraph } = await layoutModule;
  const initial = {
    nodes: [node('a'), node('b'), node('blocker', 0, 0, 20, 20)],
    edges: [edge('a-b', 'a', 'b', { label: 'measured label', labelWidth: 170, labelHeight: 34 })],
  };
  const baseline = await arrangeGraph(initial);
  const label = baseline.routes['a-b'].label;
  const input = {
    nodes: initial.nodes.map(n => n.id === 'blocker'
      ? { ...n, x: label.x + label.width / 2 - n.width / 2, y: label.y + label.height / 2 - n.height / 2 }
      : { ...n, ...baseline.positions[n.id] }),
    edges: initial.edges, manualNodeIds: initial.nodes.map(n => n.id),
  };
  const result = await arrangeGraph(input);
  assert.equal(result.routes['a-b'], undefined);
  assert.deepEqual(result.diagnostics.discardedRouteIds, ['a-b']);
});

test('layout is deterministic across input order and does not mutate frozen business data', async () => {
  const { arrangeGraph } = await layoutModule;
  const input = { nodes: [node('z'), node('a'), node('b')], edges: [edge('zb', 'z', 'b'), edge('za', 'z', 'a')] };
  const snapshot = structuredClone(input);
  for (const n of input.nodes) Object.freeze(n);
  for (const e of input.edges) Object.freeze(e);
  Object.freeze(input.nodes); Object.freeze(input.edges); Object.freeze(input);
  const first = await arrangeGraph(input);
  const second = await arrangeGraph({ nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() });
  assert.deepEqual(first, second);
  assert.deepEqual(input, snapshot);
});

test('route fingerprints invalidate for geometry, obstacles, connections, type, or measured label changes', async () => {
  const { routeGeometryKey } = await layoutModule;
  const nodes = [node('a'), node('b'), node('obstacle')];
  const edges = [edge('a-b', 'a', 'b', { label: 'yes', labelWidth: 50, labelHeight: 24 })];
  const key = routeGeometryKey(nodes, edges);
  assert.ok(key.length < 100);
  assert.equal(routeGeometryKey([...nodes].reverse(), edges), key);
  for (const property of ['x', 'y', 'width', 'height']) {
    assert.notEqual(routeGeometryKey(nodes.map(n => n.id === 'obstacle' ? { ...n, [property]: n[property] + 0.25 } : n), edges), key);
  }
  for (const change of [{ from: 'obstacle' }, { to: 'obstacle' }, { type: 'return' }, { label: 'no' }, { labelWidth: 60 }, { labelHeight: 28 }]) {
    assert.notEqual(routeGeometryKey(nodes, [{ ...edges[0], ...change }]), key);
  }
  assert.notEqual(routeGeometryKey(nodes, [...edges, edge('b-a', 'b', 'a')]), key);
});

test('empty graphs work; invalid measurement and dangling connections fail before layout', async () => {
  const { arrangeGraph } = await layoutModule;
  const empty = await arrangeGraph({ nodes: [], edges: [] });
  assert.deepEqual(empty.positions, {}); assert.deepEqual(empty.routes, {});
  await assert.rejects(arrangeGraph({ nodes: [node('a', 0, 0, 0)], edges: [] }), /measured dimensions/);
  await assert.rejects(arrangeGraph({ nodes: [node('a')], edges: [edge('a-b', 'a', 'b')] }), /missing endpoint/);
  await assert.rejects(arrangeGraph({ nodes: [node('a'), node('b')], edges: [edge('a-b', 'a', 'b', { label: 'needs measurement' })] }), /measured label dimensions/);
});
