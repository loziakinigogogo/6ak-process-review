const assert = require('node:assert/strict');
const test = require('node:test');

test('a clear return lane avoids a forward crossing without reversing its endpoints', async () => {
  const { reduceBranchCrossings } = await import('../frontend/src/graph-smart-route.mjs');
  const back = [{x:330,y:180},{x:330,y:150},{x:30,y:150},{x:30,y:180}];
  const other = [{x:150,y:140},{x:150,y:175}];
  const input = [{id:'back', from:'b', to:'a', type:'return', points:back},
    {id:'front', from:'c', to:'d', points:other}];
  const nodes = [{id:'b', x:310, y:180, width:40,height:50}, {id:'a', x:10,y:180,width:40,height:50},
    {id:'c', x:110,y:90,width:20,height:30}];
  const improved = reduceBranchCrossings(input,nodes,'RIGHT').get('back');
  assert.ok(improved);
  assert.deepEqual(improved[0], back[0]); assert.deepEqual(improved.at(-1),back.at(-1));
  assert.ok(improved[1].y < other[0].y);
});

const obstacles = [
  { id: 'platform-wait', x: 600, y: 850, width: 200, height: 183.59375 },
  { id: 'verify-front', x: 600, y: 1060, width: 200, height: 183.59375 },
  { id: 'failure', x: 920, y: 1060, width: 200, height: 183.59375 }
];
const edge = { source: 'platform-wait', target: 'failure', sourceX: 700, sourceY: 1036.09375, targetX: 1020, targetY: 1057.5, sourcePosition: 'bottom', targetPosition: 'top' };

for (const direction of ['DOWN', 'RIGHT']) {
  test(`smart routing escapes the 26px pinned-card gap without tunnelling through a neighbour (${direction})`, async () => {
    const { getSmartEdge, pathfindingJumpPointNoDiagonal, svgDrawSmoothStepLinePath } = await import('@tisoap/react-flow-smart-edge');
    const { resolveUnobstructedSmartRoute, smartRouteIsClear } = await import('../frontend/src/graph-smart-route.mjs');
    const boxes = direction === 'DOWN' ? structuredClone(obstacles) : obstacles.map(box => ({ ...box, x: box.y, y: box.x, width: box.height, height: box.width }));
    const endpoints = direction === 'DOWN' ? { ...edge } : { ...edge, sourceX: edge.sourceY, sourceY: edge.sourceX, targetX: edge.targetY, targetY: edge.targetX, sourcePosition: 'right', targetPosition: 'left' };
    const original = JSON.stringify({ boxes, endpoints });
    const route = getSmartEdge({ ...endpoints, nodes: boxes.map(({ id, x, y, width, height }) => ({ id, position: { x, y }, measured: { width, height }, data: {} })), options: { nodePadding: 16, gridRatio: 8, generatePath: pathfindingJumpPointNoDiagonal, drawEdge: svgDrawSmoothStepLinePath({ borderRadius: 8 }) } });
    assert.ok(!(route instanceof Error));
    assert.equal(smartRouteIsClear(route, endpoints, boxes), false, 'reproduce the padded endpoint-escape tunnel');
    const repaired = resolveUnobstructedSmartRoute(route, endpoints, boxes);
    assert.ok(repaired);
    assert.notEqual(repaired.svgPathString, route.svgPathString);
    assert.equal(smartRouteIsClear(repaired, endpoints, boxes), true);
    // The repaired route must turn within the gap above / left of verify-front.
    const coordinates = repaired.points.map(point => point[direction === 'DOWN' ? 1 : 0]);
    assert.ok(Math.max(...coordinates) < 1060);
    assert.equal(JSON.stringify({ boxes, endpoints }), original);
    assert.strictEqual(resolveUnobstructedSmartRoute(repaired, endpoints, boxes), repaired, 'valid routes are returned unchanged');
  });
}

test('smart collision validation includes the segments between handles and routed points', async () => {
  const { smartRouteIsClear } = await import('../frontend/src/graph-smart-route.mjs');
  const route = { points: [[700, 1260], [1020, 1260]], svgPathString: '', edgeCenterX: 860, edgeCenterY: 1260 };
  assert.equal(smartRouteIsClear(route, edge, obstacles), false);
  assert.equal(smartRouteIsClear(route, edge, obstacles.filter(box => box.id !== 'verify-front')), true, 'source and target cards are not unrelated obstacles');
});

const point = (x, y) => ({ x, y });

// Count the shared length along both polylines, including paths made up of
// multiple grid steps on one straight run.
function sharedLength(one, two) {
  let length = 0;
  for (const [fixed, moving] of [['x', 'y'], ['y', 'x']]) {
    for (let i = 1; i < one.length; i++) {
      const a = one[i - 1], b = one[i];
      if (a[fixed] !== b[fixed]) continue;
      for (let j = 1; j < two.length; j++) {
        const c = two[j - 1], d = two[j];
        if (c[fixed] !== d[fixed] || Math.abs(a[fixed] - c[fixed]) >= 9) continue;
        const start = Math.max(Math.min(a[moving], b[moving]), Math.min(c[moving], d[moving]));
        const end = Math.min(Math.max(a[moving], b[moving]), Math.max(c[moving], d[moving]));
        length += Math.max(end - start, 0);
      }
    }
  }
  return length;
}

for (const direction of ['RIGHT', 'DOWN']) {
  test(`shared routing corridors separate even with already distinct ports (${direction})`, async () => {
    const { getSmartEdge, pathfindingJumpPointNoDiagonal, svgDrawSmoothStepLinePath } = await import('@tisoap/react-flow-smart-edge');
    const { separateSharedRoute, smartRouteIsClear } = await import('../frontend/src/graph-smart-route.mjs');
    const orient = ({ x, y }) => direction === 'RIGHT' ? { x, y } : { x: y, y: x };
    const rightBoxes = [
      ['input', 0, 500], ['top', 250, 0], ['middle', 250, 250], ['bottom', 250, 500],
      ['target-top', 690, 35], ['target-middle', 690, 275], ['target-bottom', 690, 500],
    ].map(([id, x, y]) => ({ id, x, y, width: 200, height: 118 }));
    const boxes = rightBoxes.map(box => ({ id: box.id, ...orient(box), width: direction === 'RIGHT' ? box.width : box.height, height: direction === 'RIGHT' ? box.height : box.width }));
    const nodes = boxes.map(({ id, x, y, width, height }) => ({ id, position: { x, y }, measured: { width, height }, data: {} }));
    const paths = [
      ['input', 'top', 0, 0], ['input', 'middle', 22, 0], ['input', 'bottom', 44, 0],
      ['top', 'target-top', 0, -22], ['top', 'target-middle', 22, -22],
      ['middle', 'target-top', 0, 0], ['middle', 'target-middle', 22, 0],
      ['bottom', 'target-top', -22, 22], ['bottom', 'target-middle', 0, 22], ['bottom', 'target-bottom', 22, 0],
    ].map(([source, target, startOffset, endOffset]) => {
      const from = rightBoxes.find(box => box.id === source), to = rightBoxes.find(box => box.id === target);
      const start = orient(point(from.x + from.width + 2.5, from.y + from.height / 2 + startOffset));
      const end = orient(point(to.x - 2.5, to.y + to.height / 2 + endOffset));
      const endpoints = { source, target, sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y,
        sourcePosition: direction === 'RIGHT' ? 'right' : 'bottom', targetPosition: direction === 'RIGHT' ? 'left' : 'top' };
      const routed = getSmartEdge({ ...endpoints, nodes, options: { nodePadding: 16, gridRatio: 8, generatePath: pathfindingJumpPointNoDiagonal, drawEdge: svgDrawSmoothStepLinePath({ borderRadius: 8 }) } });
      assert.ok(!(routed instanceof Error));
      return { endpoints, points: [start, ...routed.points.map(([x, y]) => point(x, y)), end] };
    });
    const sharedIn = all => all.flatMap((points, index) => all.slice(index + 1).map(other => sharedLength(points, other)));
    assert.ok(Math.max(...sharedIn(paths.map(path => path.points))) >= 180, 'reproduce long overlaps away from the distinct ports');

    const accepted = [];
    const original = JSON.stringify({ paths, boxes });
    for (const { endpoints, points } of paths) {
      const separated = separateSharedRoute(points, accepted, boxes);
      assert.deepEqual(separated[0], points[0]);
      assert.deepEqual(separated.at(-1), points.at(-1));
      assert.ok(separated.slice(1).every((current, i) => current.x === separated[i].x || current.y === separated[i].y));
      assert.ok(smartRouteIsClear({ points: separated.slice(1, -1).map(({ x, y }) => [x, y]) }, endpoints, boxes));
      accepted.push(separated);
    }
    assert.ok(Math.max(...sharedIn(accepted)) < 24, 'separate the apparent trunks without taking over adjacent lanes');
    assert.equal(JSON.stringify({ paths, boxes }), original);
  });
}

test('lane separation preserves perpendicular crossings and routes through a narrow pinned corridor', async () => {
  const { separateSharedRoute } = await import('../frontend/src/graph-smart-route.mjs');
  const route = [point(0, 0), point(50, 0), point(50, 120), point(100, 120)];
  const crossing = [point(0, 60), point(100, 60)];
  const sharing = [point(10, 10), point(50, 10), point(50, 110), point(110, 110)];
  const pinned = [
    { id: 'left', x: -10, y: 20, width: 55, height: 80 },
    { id: 'right', x: 55, y: 20, width: 65, height: 80 },
  ];
  assert.strictEqual(separateSharedRoute(route, [crossing], []), route);
  assert.notDeepEqual(separateSharedRoute(route, [sharing], []), route);
  assert.strictEqual(separateSharedRoute(route, [sharing], pinned), route);
});

test('perpendicular crossings break only the route across the reading direction, including at grid subdivisions', async () => {
  const { findCrossingGaps } = await import('../frontend/src/graph-smart-route.mjs');
  const horizontal = { id: 'horizontal', points: [point(100, 40), point(50, 40), point(50, 40), point(0, 40)] };
  const vertical = { id: 'vertical', points: [point(50, 0), point(50, 40), point(50, 100)] };
  const routes = [horizontal, vertical];
  for (const route of routes) {
    route.points.forEach(Object.freeze);
    Object.freeze(route.points);
    Object.freeze(route);
  }
  assert.deepEqual(findCrossingGaps(Object.freeze(routes), 'RIGHT'), new Map([['vertical', [point(50, 40)]]]));
  assert.deepEqual(findCrossingGaps([...routes].reverse(), 'DOWN'), new Map([['horizontal', [point(50, 40)]]]));
  assert.deepEqual(findCrossingGaps([{ ...horizontal, type: 'return' }, vertical], 'RIGHT'), new Map([['horizontal', [point(50, 40)]]]));
  assert.deepEqual(findCrossingGaps([horizontal, { ...vertical, type: 'data' }], 'DOWN'), new Map([['vertical', [point(50, 40)]]]));
});

test('crossing gaps leave shared endpoints, corners, labels, and collinear runs intact', async () => {
  const { findCrossingGaps } = await import('../frontend/src/graph-smart-route.mjs');
  const horizontal = { id: 'horizontal', points: [point(0, 40), point(100, 40)] };
  const meeting = { id: 'meeting', points: [point(40, 0), point(40, 40)] };
  const nearCorner = { id: 'near-corner', points: [point(50, 0), point(50, 46), point(100, 46)] };
  const sameRun = { id: 'same-run', points: [point(30, 40), point(90, 40)] };
  const nearEnd = { id: 'near-end', points: [point(94, 0), point(94, 100)] };
  const vertical = { id: 'vertical', points: [point(75, 0), point(75, 100)] };
  const routes = [horizontal, meeting, nearCorner, sameRun, nearEnd];
  // Evaluate each geometry independently so crossings between the fixtures do not contribute.
  for (const route of routes.slice(1)) assert.equal(findCrossingGaps([horizontal, route], 'RIGHT').size, 0, route.id);
  assert.deepEqual(findCrossingGaps([horizontal, vertical], 'RIGHT'), new Map([['vertical', [point(75, 40)]]]));
  assert.equal(findCrossingGaps([horizontal, vertical], 'RIGHT', [{ x: 66, y: 30, width: 20, height: 7 }]).size, 0);
  assert.equal(findCrossingGaps([{ id: 'self', points: [point(0, 40), point(100, 40), point(100, 80), point(50, 80), point(50, 0)] }], 'RIGHT').size, 0);
});

test('nearby crossings prevent a gap from swallowing another route crossing or combining gaps', async () => {
  const { findCrossingGaps } = await import('../frontend/src/graph-smart-route.mjs');
  const horizontal = [20, 31, 49, 54, 75].map(y => ({ id: `horizontal-${y}`, points: [point(0, y), point(100, y)] }));
  const vertical = { id: 'vertical', points: [point(50, 0), point(50, 100)] };
  const routes = [vertical, ...horizontal];
  const expected = new Map([['vertical', [point(50, 20), point(50, 75)]]]);
  assert.deepEqual(findCrossingGaps(routes, 'RIGHT'), expected);
  assert.deepEqual(findCrossingGaps([...routes].reverse(), 'RIGHT'), expected);
});

for (const direction of ['RIGHT', 'DOWN']) {
  test(`fractional measured handles keep routed endpoint runs straight (${direction})`, async () => {
    const { routeSmartEdgeBatch, svgDrawSmoothStepLinePath } = await import('@tisoap/react-flow-smart-edge');
    const { alignRouteToHandles } = await import('../frontend/src/graph-smart-route.mjs');
    const orient = ({ x, y }) => direction === 'RIGHT' ? { x, y } : { x: y, y: x };
    const boxes = [
      { id: 'a', x: 147, y: 62, width: 240, height: 121 },
      { id: 'b', x: 680, y: 263, width: 240, height: 201 },
    ].map(box => direction === 'RIGHT' ? box : { ...box, ...orient(box), width: box.height, height: box.width });
    const start = orient(point(387, 122.5)), end = orient(point(680, 315.26));
    const request = { id: 'edge', source: 'a', target: 'b', sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y,
      sourcePosition: direction === 'RIGHT' ? 'right' : 'bottom', targetPosition: direction === 'RIGHT' ? 'left' : 'top',
      preset: 'smoothstep', options: { nodePadding: 16, gridRatio: 8, borderRadius: 2 } };
    const routed = routeSmartEdgeBatch(boxes.map(({ id, x, y, width, height }) => ({ id, position: { x, y }, measured: { width, height }, data: {} })), [request]).edge;
    const points = [start, ...routed.points.map(([x, y]) => point(x, y)), end];
    const actualStart = orient(point(389.5, 122.75)), actualEnd = orient(point(677.5, 315.5));
    const actual = { ...request, sourceX: actualStart.x, sourceY: actualStart.y, targetX: actualEnd.x, targetY: actualEnd.y };
    const across = direction === 'RIGHT' ? 'y' : 'x';
    assert.notEqual(points[1][across], actualStart[across], 'reproduce rounded-dimension / fractional-handle mismatch');
    const oldPath = svgDrawSmoothStepLinePath({ borderRadius: 2 })(actualStart, actualEnd, routed.points);
    const before = JSON.stringify({ points, boxes, actual });
    const aligned = alignRouteToHandles(points, actual, boxes);
    assert.ok(aligned);
    assert.deepEqual(aligned[0], actualStart); assert.deepEqual(aligned.at(-1), actualEnd);
    assert.equal(aligned[1][across], actualStart[across]);
    assert.equal(aligned.at(-2)[across], actualEnd[across]);
    assert.ok(aligned.slice(1).every((p, i) => p.x === aligned[i].x || p.y === aligned[i].y));
    assert.notEqual(svgDrawSmoothStepLinePath({ borderRadius: 2 })(actualStart, actualEnd, aligned.slice(1, -1).map(({ x, y }) => [x, y])), oldPath);
    assert.equal(JSON.stringify({ points, boxes, actual }), before, 'cached routes and obstacle snapshot remain untouched');
  });
}

test('handle alignment trims inward grid cells and preserves returned and shared-lane routes', async () => {
  const { alignRouteToHandles, separateSharedRoute } = await import('../frontend/src/graph-smart-route.mjs');
  const right = { source: 'a', target: 'b', sourceX: 102.5, sourceY: 50.25, targetX: 297.5, targetY: 150.25, sourcePosition: 'right', targetPosition: 'left' };
  const points = [point(100, 50), point(100, 50), point(120, 50), point(120, 150), point(300, 150)];
  const original = JSON.stringify(points);
  const shared = [point(110, 60), point(120, 60), point(120, 140), point(290, 140)];
  const shifted = separateSharedRoute(points, [shared], []);
  for (const route of [points, shifted]) {
    const aligned = alignRouteToHandles(route, right);
    assert.ok(aligned); assert.ok(aligned[1].x > right.sourceX);
    assert.equal(aligned[1].y, right.sourceY); assert.equal(aligned.at(-2).y, right.targetY);
  }
  assert.equal(JSON.stringify(points), original);
  const returning = [point(100, 50), point(40, 50), point(40, 150), point(100, 150)];
  const result = alignRouteToHandles(returning, { ...right, sourceX: 97.5, targetX: 97.5, sourcePosition: 'left' });
  assert.ok(result); assert.equal(result[1].x, 40); assert.equal(result[2].x, 40);
});

test('straight route endpoint correction uses an orthogonal middle join, avoiding card collisions', async () => {
  const { alignRouteToHandles } = await import('../frontend/src/graph-smart-route.mjs');
  const points = Object.freeze([Object.freeze(point(100, 50)), Object.freeze(point(300, 50))]);
  const edge = { source: 'a', target: 'b', sourceX: 102.5, sourceY: 50.25, targetX: 297.5, targetY: 49.75, sourcePosition: 'right', targetPosition: 'left' };
  const result = alignRouteToHandles(points, edge);
  assert.deepEqual(result, [point(102.5, 50.25), point(200, 50.25), point(200, 49.75), point(297.5, 49.75)]);
  assert.equal(alignRouteToHandles(points, edge, [{ id: 'obstacle', x: 150, y: 50, width: 60, height: 10 }]), null, 'do not repair through an adjacent card');
  assert.equal(alignRouteToHandles(points, { ...edge, sourcePosition: 'left' }), null, 'do not invent a route leaving into its source');
});
