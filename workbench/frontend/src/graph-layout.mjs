/** Layout changes presentation only. Business nodes and relations are never mutated. */
const NODE_GAP = 40;
const ROUTE_CLEARANCE = 8;
const EPSILON = 0.001;
const compareIds = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const samePoint = (a, b) => Math.abs(a.x - b.x) < EPSILON && Math.abs(a.y - b.y) < EPSILON;
const finitePoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y);

/** A compact, deterministic cache fingerprint, not an authenticity/security check. */
export function routeGeometryKey(nodes, edges) {
  const value = JSON.stringify([
    [...nodes].sort(compareIds).map(n => [n.id, n.x, n.y, n.width, n.height]),
    [...edges].sort(compareIds).map(e => [e.id, e.from, e.to, e.type || 'sequence', e.label || '', e.labelWidth || 0, e.labelHeight || 0]),
  ]);
  let first = 0x811c9dc5, second = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second ^= second >>> 13;
  }
  return `elk-route:v1:${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}:${value.length}`;
}

async function runElk(graph) {
  // Both large ELK chunks are lazy. Vite emits a separate worker asset; Node tests
  // use the bundled implementation and never resolve the Vite-only ?worker import.
  if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
    let elk;
    let worker;
    try {
      const [{ default: ELK }, { default: ElkWorker }] = await Promise.all([
        import('elkjs/lib/elk-api.js'), import('elkjs/lib/elk-worker.min.js?worker'),
      ]);
      worker = new ElkWorker();
      const workerFailure = new Promise((_, reject) => {
        worker.addEventListener('error', () => reject(new Error('ELK worker failed')), { once: true });
        worker.addEventListener('messageerror', () => reject(new Error('ELK worker message failed')), { once: true });
      });
      elk = new ELK({ algorithms: ['layered'], workerFactory: () => worker });
      const result = await Promise.race([elk.layout(graph), workerFailure]);
      return { result, workerUsed: true };
    } catch {
      // A browser policy or unavailable Worker must not disable the arrange action.
    } finally {
      if (elk) elk.terminateWorker();
      else worker?.terminate();
    }
  }
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const elk = new ELK({ algorithms: ['layered'] });
  // The bundled adapter uses an in-process worker without terminate().
  return { result: await elk.layout(graph), workerUsed: false };
}

function validateInput(nodes, edges) {
  const ids = new Set();
  for (const node of nodes) {
    if (typeof node.id !== 'string' || !node.id || ids.has(node.id)) throw new Error('Layout node IDs must be unique non-empty strings.');
    if (!finitePoint(node) || !Number.isFinite(node.width) || !Number.isFinite(node.height) || node.width <= 0 || node.height <= 0) {
      throw new Error(`Layout node ${node.id} needs finite coordinates and positive measured dimensions.`);
    }
    ids.add(node.id);
  }
  const edgeIds = new Set();
  for (const edge of edges) {
    if (typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id)) throw new Error('Layout edge IDs must be unique non-empty strings.');
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error(`Layout edge ${edge.id} has a missing endpoint.`);
    if (edge.label && (!Number.isFinite(edge.labelWidth) || !Number.isFinite(edge.labelHeight) || edge.labelWidth <= 0 || edge.labelHeight <= 0)) {
      throw new Error(`Layout edge ${edge.id} needs positive measured label dimensions.`);
    }
    edgeIds.add(edge.id);
  }
}

function overlaps(a, b, gap = 0) {
  return a.x < b.x + b.width + gap - EPSILON && a.x + a.width + gap > b.x + EPSILON
    && a.y < b.y + b.height + gap - EPSILON && a.y + a.height + gap > b.y + EPSILON;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 0;
}

function avoidFixedNodes(nodes, desired, manualIds) {
  const positions = Object.fromEntries(nodes.filter(n => manualIds.has(n.id)).map(n => [n.id, { x: n.x, y: n.y }]));
  const occupied = nodes.filter(n => manualIds.has(n.id)).map(n => ({ ...n }));
  const automatic = nodes.filter(n => !manualIds.has(n.id)).sort((a, b) => desired[a.id].y - desired[b.id].y || desired[a.id].x - desired[b.id].x || compareIds(a, b));
  for (const node of automatic) {
    const proposed = { ...node, ...desired[node.id] };
    // Preserve ELK's vertical layers, moving only along a layer when a manual
    // obstacle occupies it. The outermost candidate always provides free space.
    const xs = [...new Set([proposed.x, ...occupied.flatMap(n => [n.x - NODE_GAP - node.width, n.x + n.width + NODE_GAP])])]
      .sort((a, b) => Math.abs(a - proposed.x) - Math.abs(b - proposed.x) || a - b);
    const x = xs.find(candidate => !occupied.some(other => overlaps({ ...proposed, x: candidate }, other, NODE_GAP)));
    positions[node.id] = { x, y: proposed.y };
    occupied.push({ ...proposed, x });
  }
  return positions;
}

function endpoint(node, edge, source) {
  if (edge.type === 'return') return { x: node.x, y: node.y + node.height / 2 };
  return { x: node.x + node.width / 2, y: node.y + (source ? node.height : 0) };
}

function sectionPoints(sections, start, end, shift) {
  if (!sections?.length) return null;
  const remaining = sections.map(section => [section.startPoint, ...(section.bendPoints || []), section.endPoint]
    .map(p => ({ x: p.x + shift.x, y: p.y + shift.y })));
  const points = [start];
  while (remaining.length) {
    const tail = points[points.length - 1];
    const index = remaining.findIndex(section => samePoint(section[0], tail) || samePoint(section[section.length - 1], tail));
    if (index < 0) return null;
    const [section] = remaining.splice(index, 1);
    if (!samePoint(section[0], tail)) section.reverse();
    points.push(...section.slice(1));
  }
  if (!samePoint(points[points.length - 1], end)) return null;
  return points.filter((point, index) => !index || !samePoint(point, points[index - 1]));
}

function segmentHitsRect(a, b, rect, padding) {
  const left = rect.x - padding + EPSILON, right = rect.x + rect.width + padding - EPSILON;
  const top = rect.y - padding + EPSILON, bottom = rect.y + rect.height + padding - EPSILON;
  if (Math.abs(a.x - b.x) < EPSILON) return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
  if (Math.abs(a.y - b.y) < EPSILON) return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
  return true; // Only orthogonal ELK sections are reusable.
}

function safeRoute(points, edge, nodes, label, acceptedLabels) {
  if (!points || points.length < 2 || !points.every(finitePoint)) return false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (Math.abs(a.x - b.x) >= EPSILON && Math.abs(a.y - b.y) >= EPSILON) return false;
    if (nodes.some(n => segmentHitsRect(a, b, n, n.id === edge.from || n.id === edge.to ? 0 : ROUTE_CLEARANCE))) return false;
  }
  if (label && (!finitePoint(label) || !Number.isFinite(label.width) || !Number.isFinite(label.height)
    || nodes.some(n => overlaps(label, n, 4)) || acceptedLabels.some(other => overlaps(label, other, 4)))) return false;
  return true;
}

/**
 * ELK layered does not pin nodes. First compute an ordinary layered layout, then
 * restore manual coordinates exactly and pack automatic nodes around them.
 * Sections and labels are reused only after validation against the FINAL graph.
 * Omitted routes must be computed by the caller's obstacle router (SmartEdge).
 */
export async function arrangeGraph({ nodes, edges, manualNodeIds = [] }) {
  validateInput(nodes, edges);
  const orderedNodes = [...nodes].sort(compareIds), orderedEdges = [...edges].sort(compareIds);
  const manualIds = new Set(manualNodeIds);
  const internalIds = new Map(orderedNodes.map((n, i) => [n.id, `n${i}`]));
  const graph = {
    id: 'layout-root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.edgeRouting': 'ORTHOGONAL',
      'elk.randomSeed': '1', 'elk.padding': '[top=48,left=48,bottom=48,right=48]',
      'elk.spacing.nodeNode': '80', 'elk.spacing.componentComponent': '80', 'elk.spacing.edgeNode': '24', 'elk.spacing.edgeEdge': '20',
      'elk.layered.spacing.nodeNodeBetweenLayers': '48', 'elk.layered.spacing.edgeNodeBetweenLayers': '28',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '20', 'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.favorStraightEdges': 'true', 'elk.separateConnectedComponents': 'true',
    },
    children: orderedNodes.map(node => {
      const id = internalIds.get(node.id);
      const port = (side, name, x, y) => ({ id: `${id}:${name}`, x, y, width: 0, height: 0, layoutOptions: { 'elk.port.side': side } });
      return {
        id, width: node.width, height: node.height, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
        ports: [port('NORTH', 'top', node.width / 2, 0), port('SOUTH', 'bottom', node.width / 2, node.height),
          port('WEST', 'left-source', 0, node.height / 2), port('WEST', 'left-target', 0, node.height / 2)],
      };
    }),
    edges: orderedEdges.map((edge, index) => ({
      id: `e${index}`, sources: [`${internalIds.get(edge.from)}:${edge.type === 'return' ? 'left-source' : 'bottom'}`],
      targets: [`${internalIds.get(edge.to)}:${edge.type === 'return' ? 'left-target' : 'top'}`],
      // Cycle breaking should reverse a return/secondary link in the layout,
      // preserving downward process flow. Original relation endpoints stay intact.
      layoutOptions: { 'elk.layered.priority.direction': edge.type === 'return' ? '0'
        : ['sequence', 'conditional', 'parallel'].includes(edge.type || 'sequence') ? '100' : '1' },
      ...(edge.label ? { labels: [{ text: edge.label, width: edge.labelWidth, height: edge.labelHeight,
        layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' } }] } : {}),
    })),
  };
  const { result, workerUsed } = nodes.length ? await runElk(graph) : { result: { children: [], edges: [] }, workerUsed: false };
  const elkNodes = new Map(result.children.map(n => [n.id, n]));
  const pinned = orderedNodes.filter(n => manualIds.has(n.id));
  const shift = {
    x: median(pinned.map(n => n.x - elkNodes.get(internalIds.get(n.id)).x)),
    y: median(pinned.map(n => n.y - elkNodes.get(internalIds.get(n.id)).y)),
  };
  const desired = Object.fromEntries(orderedNodes.map(n => {
    const position = elkNodes.get(internalIds.get(n.id));
    if (!finitePoint(position)) throw new Error(`ELK did not position node ${n.id}.`);
    return [n.id, { x: position.x + shift.x, y: position.y + shift.y }];
  }));
  const positions = avoidFixedNodes(orderedNodes, desired, manualIds);
  const finalNodes = orderedNodes.map(n => ({ ...n, ...positions[n.id] }));
  const byId = new Map(finalNodes.map(n => [n.id, n]));
  const geometryKey = routeGeometryKey(finalNodes, orderedEdges);
  const elkEdges = new Map((result.edges || []).map(e => [e.id, e]));
  const routes = {}, acceptedLabels = [], discardedRouteIds = [];
  for (const [index, edge] of orderedEdges.entries()) {
    const elkEdge = elkEdges.get(`e${index}`);
    const points = sectionPoints(elkEdge?.sections, endpoint(byId.get(edge.from), edge, true), endpoint(byId.get(edge.to), edge, false), shift);
    const rawLabel = elkEdge?.labels?.[0];
    // ELK's label x/y are the top-left corner, not the ReactFlow label center.
    const label = rawLabel && { x: rawLabel.x + shift.x, y: rawLabel.y + shift.y, width: rawLabel.width, height: rawLabel.height };
    if ((edge.label && !label) || !safeRoute(points, edge, finalNodes, label, acceptedLabels)) { discardedRouteIds.push(edge.id); continue; }
    Object.defineProperty(routes, edge.id, { value: { points, ...(label ? { label } : {}), geometryKey }, enumerable: true });
    if (label) acceptedLabels.push(label);
  }
  return {
    positions, routes, geometryKey,
    diagnostics: {
      engine: 'elk-layered', workerUsed, manualNodeIds: pinned.map(n => n.id),
      adjustedNodeIds: orderedNodes.filter(n => !samePoint(positions[n.id], desired[n.id])).map(n => n.id),
      overlappingManualPairs: pinned.flatMap((a, index) => pinned.slice(index + 1).filter(b => overlaps(a, b)).map(b => [a.id, b.id])),
      discardedRouteIds,
    },
  };
}
