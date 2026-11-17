import { arrangeGraph } from './graph-layout.mjs';

/**
 * Keep the read-only preview on the same direction-aware production layout.
 * Its original default remains horizontal; production callers default to DOWN.
 */
export async function arrangeComparisonGraph({ nodes, edges, direction = 'RIGHT' }) {
  return arrangeGraph({ nodes, edges, direction });
}
