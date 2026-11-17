import React from 'react';
import { nodeIdentity } from './node-navigation.mjs';
import { fieldLabels, relationLabels } from './structure-draft';

type Claim = {id:string;text:string;origin:string;evidence:Array<{sourceId:string;startLine:number;endLine:number;quote:string}>;premiseIds?:string[];rationale?:string;issueIds?:string[]};
type Node = {id:string;title:string;groupId:string;claimIds:string[];fields:Record<string,string[]>};
type Source = {id:string;name:string;text:string;kind?:string};
type Model = {groups:Array<{id:string;title:string}>;nodes:Node[];claims:Claim[];sources:Source[];relations:Array<{id:string;from:string;to:string;type:string;claimIds:string[];conditionClaimIds:string[]}>;rules?:Array<{id:string;title:string;claimIds:string[];parameters:Record<string,string[]>}>;issues:Array<{id:string;type?:string;status:string;question:string;impact:string;nodeIds:string[];relationIds:string[];claimIds?:string[];resolutionClaimIds?:string[]}>};
const parameterLabels:Record<string,string>={operator:'比较关系',value:'数值',unit:'单位',basis:'计算基准',scope:'适用范围',exceptions:'例外'};

export function ClaimProse({claim,model}:{claim:Claim;model:Model}) {
  const kinds=claim.evidence.map(e=>model.sources.find(s=>s.id===e.sourceId)?.kind);
  const origin=claim.origin==='unknown'?'资料未说明':claim.origin==='inferred'?'整理推断':kinds.length&&kinds.every(kind=>kind==='user-feedback')?'用户补充':kinds.includes('user-feedback')?'原文明示、用户补充':'原文明示';
  const openIssue=claim.issueIds?.some(id=>model.issues.some(issue=>issue.id===id&&issue.status==='open'));
  return <div className="structured-claim" data-claim-id={claim.id}>
    <p className="structured-claim-text">{claim.text}</p>
    {(claim.origin!=='explicit'||kinds.includes('user-feedback'))&&<span className={`claim-status ${claim.origin}${kinds.includes('user-feedback')?' feedback':''}`}>{origin}</span>}
    {claim.origin==='inferred'&&claim.rationale&&<p className="material-gap">推断理由：{claim.rationale}</p>}
    {!!claim.issueIds?.length&&<span className={`claim-status${openIssue?'':' resolved'}`}>{openIssue?'待核对':'已解决'}</span>}

  </div>;
}

export function nodeProseContext(model:Model,nodeId:string) {
  const node=model.nodes.find(n=>n.id===nodeId);
  const outgoing=model.relations.filter(r=>r.from===nodeId);
  const connected=new Set([...(node?.claimIds||[]),...outgoing.flatMap(r=>r.claimIds)]);
  const rules=(model.rules||[]).filter(rule=>rule.claimIds.some(id=>connected.has(id)));
  rules.forEach(rule=>rule.claimIds.forEach(id=>connected.add(id)));
  const issues=model.issues.filter(issue=>issue.nodeIds.includes(nodeId)||issue.relationIds.some(id=>outgoing.some(r=>r.id===id))||issue.claimIds?.some(id=>connected.has(id))||[...connected].some(id=>model.claims.find(claim=>claim.id===id)?.issueIds?.includes(issue.id)));
  return {outgoing,connected,rules,issues};
}

export function NodeProse({model,nodeId,onNode}:{model:Model;nodeId:string;onNode:(id:string)=>void}) {
  const node=model.nodes.find(n=>n.id===nodeId);if(!node)return null;
  const claims=(ids:string[])=>ids.map(id=>model.claims.find(c=>c.id===id)).filter((c):c is Claim=>!!c);
  const render=(ids:string[])=>claims(ids).map(claim=><ClaimProse key={claim.id} claim={claim} model={model}/>);
  const assigned=new Set(Object.values(node.fields).flat()),extra=node.claimIds.filter(id=>!assigned.has(id));
  const {outgoing,connected,rules,issues}=nodeProseContext(model,nodeId);
  const fields=['actions','role','system','trigger','input','output','rules'];
  const missing=fields.filter(field=>field!=='actions'&&!node.fields[field]?.length);
  return <section className="node-prose" data-testid={`node-prose-${nodeId}`}>
    <div className="structured-fields">{fields.filter(field=>field==='actions'||node.fields[field]?.length).map(field=><section className={`structured-field field-${field}`} data-node-section={field} key={field}><div className="structured-field-heading"><h4>{field==='rules'?'规则与限制':fieldLabels[field]}</h4></div>{field==='actions'&&!node.fields.actions.length?<p className="unknown-text">资料未说明操作。</p>:render(node.fields[field]||[])}</section>)}</div>
    {!!missing.length&&<p className="empty-fields">资料未说明：{missing.map(field=>field==='rules'?'规则与限制':fieldLabels[field]).join('、')}。</p>}
    {!!extra.length&&<section className="structured-field" data-node-section="supplemental"><h4>补充说明</h4>{render(extra)}</section>}
    {!!rules.length&&<section className="structured-rules" data-node-section="shared-rules"><h4>关联规则与例外</h4>{rules.map(rule=><article key={rule.id} data-rule-id={rule.id}><h5>{rule.title}</h5>{render(rule.claimIds.filter(id=>!Object.values(rule.parameters).flat().includes(id)))}{[...new Set(Object.values(rule.parameters).flat())].map(id=><section key={id}><h5>{Object.entries(rule.parameters).filter(([,ids])=>ids.includes(id)).map(([parameter])=>parameterLabels[parameter]||parameter).join(' · ')}</h5>{render([id])}</section>)}</article>)}</section>}
    <section className="structured-relations" data-node-section="relations"><h4>后续与关联</h4>{outgoing.length?outgoing.map(relation=><article key={relation.id} data-relation-id={relation.id}><div className="structured-relation-heading"><span>{relationLabels[relation.type]||relation.type}关系</span><span>→</span><button className="quiet-button related-node" data-node-link={relation.to} data-focus-key={`relation:${relation.id}:${relation.to}`} onClick={()=>onNode(relation.to)}><span className="node-identity-badge" style={{"--group-color":nodeIdentity(model,relation.to)?.color} as React.CSSProperties}>{nodeIdentity(model,relation.to)?.number}</span>{model.nodes.find(n=>n.id===relation.to)?.title||relation.to}</button></div>{relation.conditionClaimIds.length>0&&<h5>流转条件</h5>}{render(relation.conditionClaimIds)}{render(relation.claimIds.filter(id=>!relation.conditionClaimIds.includes(id)))}</article>):<p className="unknown-text">当前没有已知后续关系。</p>}</section>
    {!!issues.length&&<section className="structured-issues" data-node-section="issues"><h4>疑点与待确认</h4>{issues.map(issue=><article key={issue.id} data-issue-id={issue.id}><strong>{issue.type==='conflict'?'冲突 · ':''}{issue.question}</strong><small>{issue.status==='open'?'待确认':'已解决'}</small><p>{issue.impact}</p>{render((issue.claimIds||[]).filter(id=>!connected.has(id)))}{!!issue.resolutionClaimIds?.length&&<><h5>已确认结论</h5>{render(issue.resolutionClaimIds)}</>}</article>)}</section>}
  </section>;
}
