import { routeGeometryKey } from './graph-layout.mjs';

/** Geometry that requires arranging nodes, independent of reading/drag state. */
export function layoutInputKey(nodes, edges, direction = 'DOWN') {
  // Moving a card changes its route, not the need to arrange the entire graph.
  // A same-sized replacement label also leaves node placement unchanged.
  return routeGeometryKey(
    nodes.map(node => ({ id: node.id, x: 0, y: 0, width: node.width, height: node.height })),
    edges.map(edge => ({ ...edge, label: edge.label ? 'label' : '' })),
    direction,
  ).replace('elk-route:', 'elk-input:');
}
