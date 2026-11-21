export type Point = { x: number; y: number };
export type LayoutDirection = 'DOWN' | 'RIGHT';
export type LayoutNode = Point & { id: string; width: number; height: number; order?: number };
export type LayoutEdge = { id: string; from: string; to: string; type?: string; label?: string; labelWidth?: number; labelHeight?: number; fromOrder?: number; toOrder?: number; exitOrder?: number; dataLeafGroup?: string; layoutRole?: 'context' | 'feedback' };
export function dataLeafGrids(edges: readonly LayoutEdge[], maxDepth: number, pinned?: readonly string[]): { ids: string[]; depth: number }[];
export type RelationPort = { id: string; type: 'source' | 'target'; side: 'top' | 'bottom' | 'left'; fraction: number };
export type RelationPorts = {
  byNode: Map<string, RelationPort[]>;
  byEdge: Map<string, { source: RelationPort; target: RelationPort }>;
  spread: boolean;
};
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
export function relationPorts(edges: readonly LayoutEdge[], nodes?: readonly LayoutNode[], direction?: LayoutDirection): RelationPorts;
export function portPoint(node: LayoutNode, port: RelationPort, direction?: LayoutDirection): Point;
export function routeGeometryKey(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], direction?: LayoutDirection, ports?: RelationPorts): string;
export function arrangeGraph(input: {
  nodes: readonly LayoutNode[];
  edges: readonly LayoutEdge[];
  manualNodeIds?: readonly string[];
  maxLeafDepth?: number;
  direction?: LayoutDirection;
}): Promise<LayoutResult>;
