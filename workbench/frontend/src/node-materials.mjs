/** Read-only source projection. Processed claim wording is never used as source text. */
export function nodeMaterialsFor(model, nodeId, contentTree, materials) {
  const node = model.nodes.find(item => item.id === nodeId);
  if (!node) return { excerpts: [], unlocatedClaimIds: [], unavailable: [], feedbackReferences: [] };
  const claimById = new Map(model.claims.map(claim => [claim.id, claim]));
  const sourceById = new Map(model.sources.map(source => [source.id, source]));
  const ids = new Set(node.claimIds || []);
  for (const relation of model.relations.filter(item => item.from === nodeId)) {
    for (const id of [...(relation.claimIds || []), ...(relation.conditionClaimIds || [])]) ids.add(id);
  }
  const visited = new Set();
  function include(id) {
    if (visited.has(id)) return;
    visited.add(id);
    for (const premise of claimById.get(id)?.premiseIds || []) { ids.add(premise); include(premise); }
  }
  [...ids].forEach(include);
  const attachedSources = new Set((contentTree?.entries || []).filter(entry => entry.nodeId === nodeId).flatMap(entry =>
    (entry.revisions || []).map(revision => `wb-content-${entry.id}-r${revision.evidenceRevision || revision.revision}`)));
  const ranges = new Map(), unavailable = new Map(), feedback = new Map(), unlocated = [];
  const sourceVersions = new Map([...model.sources, ...(materials?.sources || [])].map(source => [`${source.id}:${source.sha256 || ''}`, source]));
  function addRange(source, sourceId, start, end, expectedHash) {
    const lines = source?.text?.split('\n');
    if (!lines || (expectedHash && source.sha256 !== expectedHash) || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
      const label = `${source?.name || sourceId} · 第 ${start}–${end} 行`;
      unavailable.set(label, { sourceId, label }); return;
    }
    const key = `${source.id}:${source.sha256 || ''}`;
    const list = ranges.get(key) || [];
    list.push([start, end]); ranges.set(key, list);
  }
  for (const binding of materials?.bindings || []) if (binding.nodeId === nodeId) {
    const source = sourceVersions.get(`${binding.sourceId}:${binding.sourceHash}`);
    addRange(source, binding.sourceId, binding.startLine, binding.endLine, binding.sourceHash);
  }
  for (const id of ids) {
    const claim = claimById.get(id);
    if (!claim?.evidence?.length) { unlocated.push(id); continue; }
    for (const evidence of claim.evidence) {
      const source = sourceById.get(evidence.sourceId);
      if (source?.kind === 'user-feedback') {
        if (!attachedSources.has(source.id)) feedback.set(source.id, { sourceId: source.id, name: source.name });
        continue;
      }
      // A present archive is authoritative, including explicit removal. Only
      // legacy states without an archive recover the associations from output.
      if (!materials) addRange(source, evidence.sourceId, evidence.startLine, evidence.endLine);
    }
  }
  const excerpts = [];
  for (const [key, source] of sourceVersions) {
    const merged = [];
    for (const [start, end] of (ranges.get(key) || []).sort((a,b) => a[0]-b[0] || a[1]-b[1])) {
      const last = merged.at(-1);
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
      else merged.push([start,end]);
    }
    const lines = source.text.split('\n');
    for (const [startLine,endLine] of merged) excerpts.push({ key: `${key}:${startLine}:${endLine}`, sourceId: source.id, sourceHash: source.sha256, name: source.name, startLine, endLine,
      text: lines.slice(startLine-1,endLine).join('\n'), label: `${source.name} · 第 ${startLine===endLine?startLine:`${startLine}–${endLine}`} 行` });
  }
  return { excerpts, unlocatedClaimIds: unlocated, unavailable: [...unavailable.values()], feedbackReferences: [...feedback.values()] };
}
