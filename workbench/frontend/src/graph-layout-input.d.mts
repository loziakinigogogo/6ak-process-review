import type { LayoutNode, LayoutEdge, LayoutDirection } from './graph-layout.mjs';
export function scopeLayoutEdges<E extends LayoutEdge>(edges: readonly E[], contextIds: ReadonlySet<string>): Array<E & { layoutRole?: 'context' | 'feedback' }>;
export function layoutInputKey(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], direction?: LayoutDirection, maxLeafDepth?: number): string;
