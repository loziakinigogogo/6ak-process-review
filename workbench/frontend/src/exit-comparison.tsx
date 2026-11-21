import React, { useLayoutEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { edgeLabelBox } from './graph-routing';
import { RelationEvidence } from './relation-evidence';
import { relationLabels } from './structure-draft';

type Relation = { id: string; from: string; to: string; type: string; claimIds: string[]; conditionClaimIds: string[] };
type Claim = React.ComponentProps<typeof RelationEvidence>['model']['claims'][number] & { text: string; issueIds?: string[] };
type Model = {
  groups: { id: string; title: string }[];
  nodes: { id: string; title: string; groupId: string }[];
  relations: Relation[];
  claims: Claim[];
  sources: React.ComponentProps<typeof RelationEvidence>['model']['sources'];
  issues: { id: string; status: string; question: string; relationIds: string[]; claimIds?: string[] }[];
};

export function GraphGroupBadge({ groupIndex, title, number, context }: { groupIndex: number; title: string; number: number; context: boolean }) {
  return <><span className="node-group-badge group-badge" title={title}><strong>{context ? '来自第' : '第'} {groupIndex + 1} 组</strong><span>{title}</span></span><span className="node-number">组内 <b>{number}</b> 号</span></>;
}

function exitLetter(index: number): string {
  const letter = String.fromCharCode(65 + index % 26);
  return index < 26 ? letter : exitLetter(Math.floor(index / 26) - 1) + letter;
}

// Use the full adopted model so filtering out a neighbour cannot rename an exit.
export function graphExits(model: Model = { groups: [], nodes: [], relations: [], sources: [], claims: [], issues: [] }) {
  const groups = new Map(model.groups.map((group, index) => [group.id, index + 1]));
  const counts = new Map<string, number>();
  const nodes = new Map(model.nodes.map((node, order) => {
    const number = (counts.get(node.groupId) || 0) + 1;
    counts.set(node.groupId, number);
    return [node.id, { ...node, order, number, group: groups.get(node.groupId) }];
  }));
  const claims = new Map(model.claims.map(claim => [claim.id, claim]));
  const siblings = new Map<string, Relation[]>();
  const incoming = new Map<string, number>();
  for (const relation of model.relations) {
    incoming.set(relation.to, (incoming.get(relation.to) || 0) + 1);
    if (!siblings.has(relation.from)) siblings.set(relation.from, []);
    siblings.get(relation.from)!.push(relation);
  }
  return new Map([...siblings].flatMap(([from, relations]) => {
    const signatures = new Map<string, Set<string>>();
    const rows = relations.map((relation, index) => {
      const conditions = relation.conditionClaimIds.map(id => claims.get(id)!).filter(Boolean);
      const signature = JSON.stringify(conditions.map(claim => claim.text.trim()).sort());
      if (relation.type === 'conditional' && conditions.length) {
        if (!signatures.has(signature)) signatures.set(signature, new Set());
        signatures.get(signature)!.add(relation.to);
      }
      const code = exitLetter(index);
      const destination = nodes.get(relation.to)!;
      const predicate = conditions.map(claim => claim.text).join('；');
      const text = predicate || (['return', 'data', 'association'].includes(relation.type) ? relationLabels[relation.type] : '');
      const fallback = relations.length > 1 ? edgeLabelBox(`${code} → ${destination.title}`, `${code} → ${destination.group}组${destination.number}号`).label : '查看完整条件';
      const box = edgeLabelBox(text, fallback);
      const dataLeafGroup = relation.type === 'data' && !conditions.length && incoming.get(relation.to) === 1 && !siblings.has(relation.to)
        ? destination.groupId : undefined;
      const geometry = { id: relation.id, from, to: relation.to, type: relation.type, dataLeafGroup, fromOrder: nodes.get(from)!.order, toOrder: destination.order, exitOrder: index, ...box };
      const accessibleName = `${nodes.get(from)!.title}，出口 ${code}，前往${destination.title}，查看连线详情`;
      return { relation, code, destination, conditions, signature, geometry, accessibleName };
    });
    return rows.map(row => [row.relation.id, { ...row, shared: row.relation.type === 'conditional' && (signatures.get(row.signature)?.size || 0) > 1 }] as const);
  }));
}

export function ExitComparison({ model, nodeId, exits, relationIds, onClose }: {
  model: Model; nodeId: string; exits: ReturnType<typeof graphExits>; relationIds?: readonly string[]; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = model.nodes.find(node => node.id === nodeId)?.title;
  const rows = [...exits.values()].filter(exit => exit.relation.from === nodeId && (!relationIds || relationIds.includes(exit.relation.id)));
  useLayoutEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    return () => {
      element.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      else if (opener?.dataset.testid) document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(opener.dataset.testid)}"]`)?.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className="exit-dialog" aria-label="出口对照" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><div><small>出口对照</small><h2>{title}</h2></div><button className="icon-button" aria-label="关闭出口对照" onClick={onClose}><X size={18}/></button></header>
    <div className="exit-dialog-body">
      {rows.map(({ relation, code, destination, conditions, shared }) => {
        const issues = model.issues.filter(issue => issue.status === 'open' && (issue.relationIds.includes(relation.id)
          || conditions.some(claim => claim.issueIds?.includes(issue.id) || issue.claimIds?.includes(claim.id))));
        return <article key={relation.id} data-exit-id={relation.id}>
          <div className="exit-target"><b className="exit-letter">{code}</b><div><strong>{destination.title}</strong>
            <small>第 {destination.group} 组 · 组内 {destination.number} 号 · {relationLabels[relation.type]}</small></div></div>
          <div className="exit-predicate">
            {conditions.length ? conditions.map(claim => <p key={claim.id}>{claim.origin === 'inferred' && <em>整理推断 · </em>}{claim.text}</p>) : <p>{relationLabels[relation.type]}关系，未单列条件</p>}
            {shared && <small className="exit-note">多个去向共用此条件，待核对</small>}
            {issues.map(issue => <small className="exit-note" key={issue.id}>待确认 · {issue.question}</small>)}
            <details><summary>查看原文依据</summary><RelationEvidence model={model} claimIds={conditions.length ? relation.conditionClaimIds : relation.claimIds}/></details>
          </div>
        </article>;
      })}
    </div>
  </dialog>;
}
