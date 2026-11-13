export type Point = { x: number; y: number };
export type LayoutNode = Point & { id: string; width: number; height: number };
export type LayoutEdge = { id: string; from: string; to: string; type?: string; label?: string; labelWidth?: number; labelHeight?: number };
export type LayoutRoute = {
  points: Point[];
  /** ELK label rectangle: x/y are its top-left corner. */
  label?: Point & { width: number; height: number };
  geometryKey: string;
};
export type LayoutResult = {
  positions: Record<string, Point>;
  /** Missing routes require obstacle routing against the final node positions. */
  routes: Record<string, LayoutRoute>;
  geometryKey: string;
  diagnostics: {
    engine: 'elk-layered';
    workerUsed: boolean;
    manualNodeIds: string[];
    adjustedNodeIds: string[];
    overlappingManualPairs: string[][];
    discardedRouteIds: string[];
  };
};
export function routeGeometryKey(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): string;
export function arrangeGraph(input: {
  nodes: readonly LayoutNode[];
  edges: readonly LayoutEdge[];
  manualNodeIds?: readonly string[];
}): Promise<LayoutResult>;
