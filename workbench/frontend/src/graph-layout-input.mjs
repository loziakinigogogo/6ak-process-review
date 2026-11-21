import { dataLeafGrids, routeGeometryKey } from './graph-layout.mjs';

export function scopeLayoutEdges(edges, contextIds) {
  return edges.map(edge => {
    // Preserve a forward handoff between the two neighbours. A secondary
    // neighbour-to-neighbour edge can be routed after the group is placed.
    if (contextIds.has(edge.from) && contextIds.has(edge.to)
      && ['return', 'association', 'data'].includes(edge.type)) return { ...edge, layoutRole: 'context' };
    if (edge.type === 'return' && contextIds.has(edge.from)) return { ...edge, layoutRole: 'feedback' };
    return edge;
  });
}

/** Geometry that requires arranging nodes, independent of reading/drag state. */
export function layoutInputKey(nodes, edges, direction = 'DOWN', maxLeafDepth = 2) {
  // Moving a card changes its route, not the need to arrange the entire graph.
  // A same-sized replacement label also leaves node placement unchanged.
  const gridTags = new Map();
  for (const { ids, depth } of dataLeafGrids(edges, maxLeafDepth)) {
    for (const id of ids) gridTags.set(id, JSON.stringify([ids[0], depth]));
  }
  return routeGeometryKey(
    nodes.map(node => ({ ...node, x: 0, y: 0 })),
    edges.map(edge => ({ ...edge, label: (edge.label ? 'label' : '') + (gridTags.get(edge.to) || '') })),
    direction,
  ).replace('elk-route:', 'elk-input:');
}
