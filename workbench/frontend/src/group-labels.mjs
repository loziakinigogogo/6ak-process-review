// A source stage can have a different number from the group's reading position.
// Recognise the legacy "阶段 N｜业务名称" form only when the source also
// treats the stage as a separate identifier. A general number-prefix rule
// would corrupt names such as "48h 截单" or "阶段 2 验证方案".
const legacyTitle = /^阶段\s*([0-9]+)\s*[|｜]\s*(\S.*)$/u;
const claimStage = /^阶段\s*([0-9]+)(?![0-9])/u;
const stageCell = /^\s*\|\s*(?:\*\*)?阶段\s*([0-9]+)(?:\*\*)?\s*(?:<br\s*\/?\s*>\s*`?(STAGE-[0-9]+)`?\s*)?\|/iu;

function stageFromEvidence(stage, claim, sources) {
  const marker = new RegExp('阶段\\s*' + stage + '(?![0-9])', 'u');
  for (const evidence of claim.evidence) {
    const source = sources.get(evidence.sourceId);
    if (!source?.text || !marker.test(evidence.quote)) continue;
    const lines = source.text.split(/\r?\n/);
    if (lines.slice(evidence.startLine - 1, evidence.endLine).join('\n') !== evidence.quote) continue;
    // Some tables cite the preceding row's handoff to this stage. Include the
    // adjacent row only for that explicit handoff, never a distant table.
    const namesNextStage = new RegExp('(?:流转至|转入)\\s*\\**阶段\\s*' + stage + '(?![0-9])', 'u').test(evidence.quote);
    const end = Math.min(lines.length, evidence.endLine + Number(namesNextStage));
    for (let index = evidence.startLine - 1; index < end; index++) {
      const cell = stageCell.exec(lines[index]);
      if (cell?.[1] !== stage) continue;
      return { sourceStage: '原文阶段 ' + stage + (cell[2] ? '（' + cell[2] + '）' : ''),
        stageLocation: source.name + ' · 第 ' + (index + 1) + ' 行' };
    }
  }
}

export function groupsForDisplay(model) {
  if (!model) return [];
  const sources = new Map(model.sources.map(source => [source.id, source]));
  const claims = new Map(model.claims.map(claim => [claim.id, claim]));
  return model.groups.map(group => {
    if (group.kind !== 'source') return group;
    const prefix = legacyTitle.exec(group.title);
    // Keep a full formal name, including a user-supplied name with a pipe.
    if (prefix && model.sources.some(source => source.text?.includes(group.title))) return group;
    const evidence = (group.claimIds || []).map(id => claims.get(id)).filter(claim => claim?.origin === 'explicit');
    const numbers = new Set(evidence.map(claim => claimStage.exec(claim.text)?.[1]).filter(Boolean));
    const [stage] = numbers;
    if (numbers.size !== 1 || (prefix && stage !== prefix[1])) return group;
    for (const claim of evidence) {
      if (claimStage.exec(claim.text)?.[1] !== stage) continue;
      const detail = stageFromEvidence(stage, claim, sources);
      if (detail) return { ...group, title: prefix?.[2] ?? group.title, ...detail };
    }
    return group;
  });
}
