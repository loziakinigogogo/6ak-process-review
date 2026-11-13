type ScopedNode = { id: string; groupId: string };
type ScopedRelation = { id: string; from: string; to: string };
export type GraphScope<N extends ScopedNode, R extends ScopedRelation> = {
  coreNodes: N[]; contextNodes: N[]; nodes: N[]; relations: R[];
  coreIds: Set<string>; contextIds: Set<string>; visibleIds: Set<string>;
  crossGroupRelations: R[]; boundaryRelations: R[];
};
export function getGraphScope<N extends ScopedNode, R extends ScopedRelation>(
  model: { nodes: N[]; relations: R[] }, groupId: string,
): GraphScope<N, R>;
