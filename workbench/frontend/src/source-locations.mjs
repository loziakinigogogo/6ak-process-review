/** Compact evidence locations without joining gaps or mixing evidence origins. */
export function sourceLocationsFor(claims, sources) {
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const groups = new Map();
  for (const claim of claims) {
    for (const evidence of claim.evidence.length ? claim.evidence : [null]) {
      const source = evidence && sourceById.get(evidence.sourceId);
      const origin = ['unknown', 'inferred'].includes(claim.origin) ? claim.origin
        : source?.kind === 'user-feedback' ? 'feedback' : 'explicit';
      const maxLine = source?.text.split('\n').length || 0;
      const valid = evidence && Number.isInteger(evidence.startLine) && Number.isInteger(evidence.endLine)
        && evidence.startLine > 0 && evidence.endLine >= evidence.startLine && evidence.endLine <= maxLine;
      const status = !evidence ? 'missing' : valid ? 'valid' : 'invalid';
      const key = JSON.stringify([evidence?.sourceId || null, origin, status]);
      const group = groups.get(key) || { key, name: source?.name || evidence?.sourceId || '', origin, status, ranges: [] };
      if (valid) group.ranges.push([evidence.startLine, evidence.endLine]);
      groups.set(key, group);
    }
  }
  return [...groups.values()].map(group => {
    const merged = [];
    for (const range of group.ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      const previous = merged.at(-1);
      if (previous && range[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], range[1]);
      else merged.push([...range]);
    }
    const lines = merged.map(([start, end]) => start === end ? `${start}` : `${start}–${end}`).join('、');
    const label = group.status === 'missing' ? '暂无原文行号'
      : `${group.name} · ${group.status === 'invalid' ? '原文行号待核对' : `第 ${lines} 行`}`;
    return { key: group.key, label, origin: group.origin };
  });
}
