/** A group is a reading scope, not a boundary in the business process. */
export function getGraphScope(model, groupId) {
  const knownIds = new Set(model.nodes.map(node => node.id));
  const coreNodes = model.nodes.filter(node => groupId === 'all' || node.groupId === groupId);
  const coreIds = new Set(coreNodes.map(node => node.id));
  const visibleIds = new Set(coreIds);
  const validRelations = model.relations.filter(edge => knownIds.has(edge.from) && knownIds.has(edge.to));
  const crossGroupRelations = [];
  // Always test against the original core set, never the growing visible set.
  // Shared upstream aggregators appear once, without recursively revealing a whole graph.
  for (const edge of validRelations) {
    const fromCore = coreIds.has(edge.from), toCore = coreIds.has(edge.to);
    if (fromCore || toCore) { visibleIds.add(edge.from); visibleIds.add(edge.to); }
    if (fromCore !== toCore) crossGroupRelations.push(edge);
  }
  const nodes = model.nodes.filter(node => visibleIds.has(node.id));
  const contextNodes = nodes.filter(node => !coreIds.has(node.id));
  return {
    coreNodes, contextNodes, nodes,
    coreIds, contextIds: new Set(contextNodes.map(node => node.id)), visibleIds,
    relations: validRelations.filter(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to)),
    crossGroupRelations,
    boundaryRelations: validRelations.filter(edge => visibleIds.has(edge.from) !== visibleIds.has(edge.to)),
  };
}
