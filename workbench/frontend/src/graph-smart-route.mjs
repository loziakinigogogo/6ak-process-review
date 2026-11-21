import { getSmartEdge, pathfindingJumpPointNoDiagonal, svgDrawSmoothStepLinePath } from '@tisoap/react-flow-smart-edge';

const POINT_EPSILON = .01;
const LANE_GAP = 10;
const MIN_SHARED_RUN = 12;
const LANE_OFFSETS = [LANE_GAP, -LANE_GAP, 2 * LANE_GAP, -2 * LANE_GAP, 3 * LANE_GAP, -3 * LANE_GAP, 4 * LANE_GAP, -4 * LANE_GAP];
export const CROSSING_GAP_RADIUS = 5.5;
const CROSSING_CLEARANCE = CROSSING_GAP_RADIUS + 3;
const secondaryTypes = new Set(['return', 'data', 'association']);

function segmentEntersBox(a, b, box, inset = .5) {
  let start = 0, end = 1;
  for (const [axis, size] of [['x', 'width'], ['y', 'height']]) {
    const low = box[axis] + inset, high = box[axis] + box[size] - inset;
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-8) {
      if (a[axis] <= low || a[axis] >= high) return false;
    } else {
      const one = (low - a[axis]) / delta, two = (high - a[axis]) / delta;
      start = Math.max(start, Math.min(one, two));
      end = Math.min(end, Math.max(one, two));
      if (start >= end) return false;
    }
  }
  return start < end;
}

function sameCoordinate(a, b) {
  return Math.abs(a - b) < POINT_EPSILON;
}

function compactPolyline(points) {
  const compact = [];
  for (const point of points) {
    const previous = compact.at(-2), last = compact.at(-1);
    if (last && last.x === point.x && last.y === point.y) continue;
    if (previous && last) {
      const straight = ['x', 'y'].some(axis => {
        const along = axis === 'x' ? 'y' : 'x';
        return sameCoordinate(previous[axis], last[axis]) && sameCoordinate(last[axis], point[axis])
          && (last[along] - previous[along]) * (point[along] - last[along]) > 0;
      });
      if (straight) compact.pop();
    }
    compact.push(point);
  }
  return compact;
}

const handleDirections = {
  left: { along: 'x', across: 'y', sign: -1 },
  right: { along: 'x', across: 'y', sign: 1 },
  top: { along: 'y', across: 'x', sign: -1 },
  bottom: { along: 'y', across: 'x', sign: 1 },
};

/**
 * Card sizes are rounded by React Flow, but its handle bounds retain subpixels.
 * Move the complete endpoint runs, not just their endpoints: feeding even a
 * 0.25px diagonal to the rounded orthogonal renderer creates a visible S bend.
 * Return null when the adjustment cannot keep an outward, unobstructed route.
 */
export function alignRouteToHandles(points, edge, obstacles = []) {
  if (points.length < 2) return null;
  const source = handleDirections[edge.sourcePosition], target = handleDirections[edge.targetPosition];
  if (!source || !target) return null;
  const start = { x: edge.sourceX, y: edge.sourceY }, end = { x: edge.targetX, y: edge.targetY };
  const original = compactPolyline(points);
  const first = original[0], last = original.at(-1);
  let leadEnd = 1, trailStart = original.length - 1;
  while (leadEnd < original.length && sameCoordinate(original[leadEnd][source.across], first[source.across])) leadEnd++;
  while (trailStart > 0 && sameCoordinate(original[trailStart - 1][target.across], last[target.across])) trailStart--;
  let adjusted;
  if (source.along === target.along && (leadEnd > trailStart
    || (leadEnd === trailStart && Math.abs(first[source.across] - last[source.across]) < 4))) {
    // A previously straight route can acquire different subpixel offsets at
    // either end. Put its small orthogonal join in the free middle corridor.
    const middle = (start[source.along] + end[source.along]) / 2;
    adjusted = [start, { ...start, [source.along]: middle }, { ...end, [source.along]: middle }, end];
  } else {
    adjusted = original.map((point, index) => ({ ...point,
      ...(index < leadEnd ? { [source.across]: start[source.across] } : {}),
      ...(index >= trailStart ? { [target.across]: end[target.across] } : {}),
    }));
    adjusted[0] = start; adjusted[adjusted.length - 1] = end;
    // The grid's first/last cell can sit behind the measured outer handle.
    // Drop only cells on the endpoint run, leaving its real turn untouched.
    while (adjusted.length > 2 && sameCoordinate(adjusted[1][source.across], start[source.across])
      && sameCoordinate(adjusted[2][source.across], start[source.across])
      && (adjusted[1][source.along] - start[source.along]) * source.sign <= POINT_EPSILON) adjusted.splice(1, 1);
    while (adjusted.length > 2 && sameCoordinate(adjusted.at(-2)[target.across], end[target.across])
      && sameCoordinate(adjusted.at(-3)[target.across], end[target.across])
      && (adjusted.at(-2)[target.along] - end[target.along]) * target.sign <= POINT_EPSILON) adjusted.splice(-2, 1);
  }
  adjusted = compactPolyline(adjusted);
  if (adjusted.length < 2 || !sameCoordinate(adjusted[1][source.across], start[source.across])
    || !sameCoordinate(adjusted.at(-2)[target.across], end[target.across])
    || (adjusted[1][source.along] - start[source.along]) * source.sign <= POINT_EPSILON
    || (adjusted.at(-2)[target.along] - end[target.along]) * target.sign <= POINT_EPSILON) return null;
  for (let index = 1; index < adjusted.length; index++) {
    const a = adjusted[index - 1], b = adjusted[index];
    if ((!sameCoordinate(a.x, b.x) && !sameCoordinate(a.y, b.y))
      || obstacles.some(box => segmentEntersBox(a, b, box, 0))) return null;
  }
  return adjusted;
}

function orthogonalSegments(points) {
  const segments = [];
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index], b = points[index + 1];
    const axis = sameCoordinate(a.x, b.x) ? 'x' : sameCoordinate(a.y, b.y) ? 'y' : null;
    if (!axis) continue;
    const along = axis === 'x' ? 'y' : 'x';
    const start = Math.min(a[along], b[along]), end = Math.max(a[along], b[along]);
    if (end - start < POINT_EPSILON) continue;
    segments.push({ axis, coordinate: a[axis], start, end });
  }
  return segments;
}

/** Find display-only gaps at crossings between separate orthogonal routes. */
export function findCrossingGaps(routes, direction, obstacles = []) {
  const segments = routes.flatMap(route => orthogonalSegments(compactPolyline(route.points)).map(segment => ({
    ...segment, id: route.id, secondary: secondaryTypes.has(route.type),
  })));
  const horizontal = segments.filter(segment => segment.axis === 'y');
  const vertical = segments.filter(segment => segment.axis === 'x');
  const crossings = [];
  const pointsByRoute = new Map(routes.map(route => [route.id, []]));
  for (const h of horizontal) {
    for (const v of vertical) {
      if (h.id === v.id) continue;
      const x = v.coordinate, y = h.coordinate;
      const clearance = Math.min(x - h.start, h.end - x, y - v.start, v.end - y);
      if (clearance < POINT_EPSILON) continue;
      const point = { x, y };
      pointsByRoute.get(h.id).push(point);
      pointsByRoute.get(v.id).push(point);
      if (clearance < CROSSING_CLEARANCE) continue;
      const under = h.secondary === v.secondary ? (direction === 'RIGHT' ? v : h) : (h.secondary ? h : v);
      crossings.push({ point, id: under.id });
    }
  }

  const gaps = new Map();
  crossings.sort((a, b) => a.point.x - b.point.x || a.point.y - b.point.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const { point, id } of crossings) {
    const { x, y } = point;
    if (obstacles.some(box => x >= box.x - CROSSING_GAP_RADIUS && x <= box.x + box.width + CROSSING_GAP_RADIUS
      && y >= box.y - CROSSING_GAP_RADIUS && y <= box.y + box.height + CROSSING_GAP_RADIUS)) continue;
    // One gap must leave nearby crossings and the little run between gaps legible.
    const gapPoints = gaps.get(id) || [];
    if (gapPoints.some(other => Math.hypot(x - other.x, y - other.y) < 2 * CROSSING_GAP_RADIUS + 2)) continue;
    if (pointsByRoute.get(id).some(other => {
      const distance = Math.hypot(x - other.x, y - other.y);
      return POINT_EPSILON < distance && distance < CROSSING_CLEARANCE;
    })) continue;
    gapPoints.push(point);
    gaps.set(id, gapPoints);
  }
  return gaps;
}

function parallelOverlap(a, b) {
  if (a.axis !== b.axis || Math.abs(a.coordinate - b.coordinate) >= LANE_GAP - POINT_EPSILON) return 0;
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/** Compare clear orthogonal lanes against the paths the reader will actually see. */
export function reduceBranchCrossings(routes, nodes, direction) {
  const chosen = new Map(routes.map(r => [r.id, orthogonalSegments(compactPolyline(r.points))]));
  const updated = new Map(), counts = new Map();
  for (const r of routes) counts.set(r.from, (counts.get(r.from) || 0) + 1);
  for (const r of routes) {
    const feedback = r.type === 'return';
    if (!feedback && counts.get(r.from) < 4) continue;
    const a = r.points[0], b = r.points.at(-1);
    const axis = (direction === 'RIGHT') !== feedback ? 'x' : 'y';
    const gap = b[axis] - a[axis];
    if (!feedback && gap < 64) continue;
    const occupied = [...chosen].filter(([id]) => id !== r.id).flatMap(([, segments]) => segments);
    const quality = segments => {
      let crossings = 0;
      for (const s of segments) for (const t of occupied) {
        if (s.axis !== t.axis && s.coordinate > t.start + POINT_EPSILON && s.coordinate < t.end - POINT_EPSILON
          && t.coordinate > s.start + POINT_EPSILON && t.coordinate < s.end - POINT_EPSILON) crossings++;
      }
      return { crossings, overlap: overlapScore(segments, occupied), length: segments.reduce((sum, s) => sum + s.end - s.start, 0) };
    };
    const base = quality(chosen.get(r.id));
    if (!base.crossings && base.overlap < MIN_SHARED_RUN) continue;
    let best = base;
    // Forward branches turn at different depths in the free inter-layer corridor.
    // A return may turn outside its endpoints or just beyond an obstructing card.
    const count = Math.min(24, Math.floor(gap / 16));
    const lanes = feedback
      ? [...new Set([Math.min(a[axis], b[axis]), ...nodes.map(n => n[axis])].map(v => v - 30))]
        .filter(v => v < Math.min(a[axis], b[axis]) - 8)
      : Array.from({ length: count }, (_, i) => a[axis] + 16 + i * (gap - 32) / (count - 1));
    for (const lane of lanes) {
      const points = compactPolyline([a, { ...a, [axis]: lane }, { ...b, [axis]: lane }, b]);
      if (points.slice(1).some((p,i) => nodes.some(n => segmentEntersBox(points[i],p,n,n.id === r.from || n.id === r.to ? .2 : -6)))) continue;
      const segments = orthogonalSegments(points), cost = quality(segments);
      if (cost.length > base.length * 1.5 + 64 || cost.overlap > base.overlap + POINT_EPSILON) continue;
      if (cost.crossings < best.crossings || (cost.crossings === best.crossings && (cost.overlap < best.overlap - POINT_EPSILON
        || (Math.abs(cost.overlap - best.overlap) < POINT_EPSILON && cost.length < best.length - 1)))) {
        best = cost;
        chosen.set(r.id, segments);
        updated.set(r.id, points);
      }
    }
  }
  return updated;
}

function overlapScore(segments, occupied) {
  let score = 0;
  for (const segment of segments) {
    for (const other of occupied) score += parallelOverlap(segment, other);
  }
  return score;
}

/** Shift shared interior runs while preserving the handles and avoiding cards. */
export function separateSharedRoute(points, previousPaths, obstacles) {
  if (!previousPaths.length) return points;
  const current = compactPolyline(points);
  const occupied = previousPaths.flatMap(path => orthogonalSegments(compactPolyline(path)));
  if (!occupied.length) return points;

  let shifted = false;
  for (let index = 1; index < current.length - 2; index++) {
    const section = current.slice(index - 1, index + 3);
    const segments = orthogonalSegments(section);
    // Both neighbouring segments must run perpendicular to this run to move
    // its bends without changing the directions of those segments.
    if (segments.length !== 3) continue;
    const [before, run, after] = segments;
    if (before.axis === run.axis || after.axis === run.axis || !occupied.some(other => parallelOverlap(run, other) >= MIN_SHARED_RUN)) continue;
    const { axis } = run;
    const [from, originalStart, originalEnd, to] = section;
    let score = overlapScore(segments, occupied);
    let bestStart = originalStart, bestEnd = originalEnd;
    for (const offset of LANE_OFFSETS) {
      const start = { ...originalStart, [axis]: originalStart[axis] + offset };
      const end = { ...originalEnd, [axis]: originalEnd[axis] + offset };
      if ((start[axis] - from[axis]) * (originalStart[axis] - from[axis]) <= 0
        || (to[axis] - end[axis]) * (to[axis] - originalEnd[axis]) <= 0) continue;
      if (obstacles.some(box => segmentEntersBox(from, start, box, 0) || segmentEntersBox(start, end, box, 0) || segmentEntersBox(end, to, box, 0))) continue;
      const candidateScore = overlapScore(orthogonalSegments([from, start, end, to]), occupied);
      if (candidateScore < score - POINT_EPSILON) {
        score = candidateScore;
        bestStart = start;
        bestEnd = end;
        shifted = true;
        if (score < POINT_EPSILON) break;
      }
    }
    current[index] = bestStart;
    current[index + 1] = bestEnd;
  }
  return shifted ? current : points;
}

export function smartRouteIsClear(route, edge, obstacles) {
  const points = [{ x: edge.sourceX, y: edge.sourceY }, ...route.points.map(([x, y]) => ({ x, y })), { x: edge.targetX, y: edge.targetY }];
  return !obstacles.some(box => box.id !== edge.source && box.id !== edge.target && points.some((point, index) => index > 0 && segmentEntersBox(points[index - 1], point, box)));
}

export function resolveUnobstructedSmartRoute(route, edge, obstacles) {
  if (smartRouteIsClear(route, edge, obstacles)) return route;
  // With tightly spaced pinned cards, padded boxes can overlap. The router's
  // endpoint escape then opens a tunnel through the neighbouring card. Retry
  // only such invalid routes with enough grid resolution to use the real gap.
  const nodes = obstacles.map(({ id, x, y, width, height }) => ({ id, position: { x, y }, measured: { width, height }, data: {} }));
  for (const [nodePadding, gridRatio] of [[8, 4], [4, 2]]) {
    const candidate = getSmartEdge({ ...edge, nodes, options: { nodePadding, gridRatio, generatePath: pathfindingJumpPointNoDiagonal, drawEdge: svgDrawSmoothStepLinePath({ borderRadius: 2 }) } });
    if (!(candidate instanceof Error) && smartRouteIsClear(candidate, edge, obstacles)) return candidate;
  }
  return null;
}
