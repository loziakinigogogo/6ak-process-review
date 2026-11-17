import type { LayoutDirection, LayoutEdge, LayoutNode, LayoutResult } from './graph-layout.mjs';

export type ComparisonDirection = LayoutDirection;
export function arrangeComparisonGraph(input: {
  nodes: readonly LayoutNode[];
  edges: readonly LayoutEdge[];
  direction?: ComparisonDirection;
}): Promise<LayoutResult>;
