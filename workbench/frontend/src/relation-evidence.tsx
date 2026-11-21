import React from 'react';

type Evidence = { sourceId: string; startLine: number; endLine: number; quote: string };
type Claim = { id: string; origin: string; premiseIds?: string[]; evidence: Evidence[]; rationale?: string };
type EvidenceModel = { claims: Claim[]; sources: { id: string; name: string; kind?: string }[] };

export function RelationEvidence({ model, claimIds }: { model: EvidenceModel; claimIds: string[] }) {
  const byId = new Map(model.claims.map(claim => [claim.id, claim]));
  const quotes = new Map<string, Evidence>();
  const reasons: string[] = [];
  // An inferred condition can have only premises, including other inferences.
  const ids = new Set(claimIds);
  for (const id of ids) {
    const claim = byId.get(id);
    if (!claim) continue;
    if (claim.origin === 'inferred' && claim.rationale) reasons.push(claim.rationale);
    for (const premise of claim.premiseIds || []) ids.add(premise);
    for (const item of claim.evidence) {
      quotes.set(JSON.stringify([item.sourceId, item.startLine, item.endLine]), item);
    }
  }
  return <section className="relation-evidence" aria-label="连线原文依据">
    <h3>原文依据</h3>
    {reasons.map((reason, index) => <p key={index}>整理推断 · {reason}</p>)}
    {[...quotes].map(([key, item]) => {
      const source = model.sources.find(entry => entry.id === item.sourceId);
      const lines = item.startLine === item.endLine ? item.startLine : `${item.startLine}–${item.endLine}`;
      return <blockquote key={key}>
        <cite>{source?.kind === 'user-feedback' && '用户补充 · '}{source?.name || item.sourceId} · 第 {lines} 行</cite>
        <p>{item.quote}</p>
      </blockquote>;
    })}
    {!quotes.size && <p>暂无可定位的原文。</p>}
  </section>;
}
