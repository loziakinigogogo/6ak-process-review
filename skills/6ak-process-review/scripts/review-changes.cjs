'use strict';

// Presentation changes are intentionally separate from the conservative
// fingerprints used to decide whether an old annotation needs another review.
const { buildProcessGroups } = require('./process-review-view.cjs');

const collections = { claim: 'claims', node: 'nodes', relation: 'relations', rule: 'rules', issue: 'issues', group: 'groups' };
const relationLabels = { sequence: '顺序', conditional: '条件', parallel: '并行', return: '退回', data: '数据交付', association: '关联' };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const keyOf = target => `${target.type}:${target.id}`;
const normalizeLines = text => String(text).replace(/\r\n?/g, '\n');
const sorted = values => [...(values || [])].sort();
const table = (model, type) => new Map((model?.[collections[type]] || []).map(item => [item.id, item]));

function objectFor(model, target) {
  return table(model, target.type).get(target.id);
}

function textFor(model, target) {
  const object = objectFor(model, target);
  if (!object) return null;
  if (target.type === 'claim') return object.text;
  if (target.type === 'issue') return object.question;
  if (target.type === 'relation') {
    const nodes = table(model, 'node');
    return `${nodes.get(object.from)?.title || object.from} → ${nodes.get(object.to)?.title || object.to}（${relationLabels[object.type] || object.type}）`;
  }
  return object.title;
}

function semantic(object, type, sharedClaims) {
  if (!object) return null;
  const retained = ids => sorted(ids).filter(id => sharedClaims.has(id));
  const fields = values => Object.fromEntries(Object.entries(values || {}).map(([name, ids]) => [name, retained(ids)]));
  if (type === 'claim') return { text: object.text, origin: object.origin, rationale: object.rationale, issueIds: sorted(object.issueIds) };
  // A newly written claim is counted once as content. Merely attaching that
  // new claim to its steps must not create a second "changed step" count.
  if (type === 'node') return { title: object.title, groupId: object.groupId, claimIds: retained(object.claimIds), fields: fields(object.fields) };
  if (type === 'relation') return {
    from: object.from, to: object.to, type: object.type,
    claimIds: retained(object.claimIds), conditionClaimIds: sorted(object.conditionClaimIds),
  };
  if (type === 'rule') return { title: object.title, claimIds: retained(object.claimIds), parameters: fields(object.parameters) };
  if (type === 'group') return { title: object.title, kind: object.kind, claimIds: retained(object.claimIds) };
  return {
    question: object.question, impact: object.impact, type: object.type, severity: object.severity, status: object.status,
    claimIds: retained(object.claimIds), nodeIds: sorted(object.nodeIds), relationIds: sorted(object.relationIds),
    resolutionClaimIds: sorted(object.resolutionClaimIds),
  };
}

function directEvidence(model, claim) {
  if (!claim) return null;
  const sources = new Map(model.sources.map(source => [source.id, source]));
  // "source" is not a change target; only the source actually cited by this
  // claim contributes. Its siblings' quotations and parent node do not.
  return {
    evidence: claim.evidence,
    premiseIds: sorted(claim.premiseIds),
    sources: sorted(new Set(claim.evidence.map(entry => entry.sourceId))).map(id => {
      const source = sources.get(id);
      return { id, sha256: source?.sha256, kind: source?.kind, name: source?.name };
    }),
  };
}

function describeProperties(type, before, after) {
  const labels = {
    title: '标题', origin: '陈述依据类型', rationale: '推断说明', issueIds: '关联疑点', groupId: '所属阶段',
    claimIds: '引用陈述', fields: '陈述所在栏目', from: '流转起点', to: '流转终点', type: type === 'issue' ? '疑点类型' : '关系类型',
    conditionClaimIds: '分支条件', parameters: '规则参数', kind: '阶段依据类型', impact: '影响说明',
    severity: '严重程度', status: '疑点状态', nodeIds: '涉及步骤', relationIds: '涉及关系', resolutionClaimIds: '澄清依据',
  };
  const words = { explicit: '原文明示', inferred: '整理推断', unknown: '原文未说明', open: '待确认', resolved: '已澄清' };
  const changes = Object.keys(after).filter(field => !['text', 'question'].includes(field) && !same(before[field], after[field]));
  const propertyChanges = changes.map(field => ({
    field, label: labels[field] || field,
    before: ['origin', 'status'].includes(field) ? words[before[field]] || before[field] : before[field] ?? null,
    after: ['origin', 'status'].includes(field) ? words[after[field]] || after[field] : after[field] ?? null,
  }));
  const precise = propertyChanges.filter(change => ['origin', 'status'].includes(change.field))
    .map(change => `${change.label}由「${change.before}」改为「${change.after}」`);
  const remaining = propertyChanges.filter(change => !['origin', 'status'].includes(change.field));
  if (remaining.length) precise.push(`${remaining.map(change => change.label).join('、')}已更新`);
  return { propertyChanges, summary: precise.length ? precise.join('；') + '。' : undefined };
}

function locationIndex(model, suppliedGroups) {
  const groups = suppliedGroups || buildProcessGroups(model);
  const nodes = table(model, 'node');
  const relations = table(model, 'relation');
  const result = new Map();
  const add = (target, location) => {
    const key = keyOf(target);
    if (!result.has(key)) result.set(key, []);
    if (!result.get(key).some(old => old.groupId === location.groupId && old.itemId === location.itemId)) result.get(key).push(location);
  };
  for (const group of groups) {
    add({ type: 'group', id: group.id }, { groupId: group.id, itemId: null, stepId: null, stepTitle: null });
    for (const item of group.items) {
      if (!item.target) continue;
      const view = item.view || { id: item.id, ...item.presentation };
      const { target } = item;
      let nodeId;
      if (target.type === 'node') nodeId = target.id;
      else if (target.type === 'relation') nodeId = relations.get(target.id)?.from;
      else if (target.context?.type === 'node') nodeId = target.context.id;
      else if (target.context?.type === 'relation') nodeId = relations.get(target.context.id)?.from;
      else if (view.parentId?.startsWith('node.')) nodeId = view.parentId.slice(5);
      else if (view.parentId?.startsWith('relation.')) nodeId = relations.get(view.parentId.slice(9))?.from;
      add(target, { groupId: group.id, itemId: view.id, stepId: nodeId ? 'node.' + nodeId : null, stepTitle: nodes.get(nodeId)?.title ?? null });
    }
  }
  return result;
}

function buildReviewChanges(previousModel, model, groups) {
  const contentChanges = [], evidenceChanges = [];
  if (!previousModel) return { contentChanges, evidenceChanges };
  const previousClaims = table(previousModel, 'claim');
  const nextClaims = table(model, 'claim');
  const sharedClaims = new Set([...previousClaims.keys()].filter(id => nextClaims.has(id)));
  const locations = locationIndex(model, groups);
  for (const type of Object.keys(collections)) {
    const previous = table(previousModel, type), next = table(model, type);
    const ids = [...next.keys(), ...[...previous.keys()].filter(id => !next.has(id))];
    for (const id of ids) {
      const before = previous.get(id), after = next.get(id);
      const target = { type, id }, identity = keyOf(target);
      const beforeSemantic = semantic(before, type, sharedClaims), afterSemantic = semantic(after, type, sharedClaims);
      const contentChanged = !before || !after || !same(beforeSemantic, afterSemantic);
      const evidenceChanged = type === 'claim' && before && after && !same(directEvidence(previousModel, before), directEvidence(model, after));
      if (!contentChanged && !evidenceChanged) continue;
      const entry = {
        id: identity, target, kind: !before ? 'added' : !after ? 'removed' : 'modified',
        before: textFor(previousModel, target), after: textFor(model, target),
        locations: locations.get(identity) || [], category: contentChanged ? 'content' : 'evidence',
      };
      if (evidenceChanged) entry.evidenceChanged = true;
      if (contentChanged && before && after) {
        const properties = describeProperties(type, beforeSemantic, afterSemantic);
        if (properties.propertyChanges.length) {
          entry.structureChanged = true;
          Object.assign(entry, properties, { structureBefore: beforeSemantic, structureAfter: afterSemantic });
        }
      } else if (!contentChanged) {
        entry.summary = '正文措辞未改，直接引用的证据或来源已更新。';
      }
      (contentChanged ? contentChanges : evidenceChanges).push(entry);
    }
  }
  return { contentChanges, evidenceChanges };
}

function resultState(processedModel, currentModel, target) {
  const current = objectFor(currentModel, target);
  if (!current) return 'removed';
  const processed = objectFor(processedModel, target);
  if (!processed || !same(processed, current)) return 'changed';
  if (target.type === 'claim' && !same(directEvidence(processedModel, processed), directEvidence(currentModel, current))) return 'changed';
  return 'current';
}

function resolveOutcomeChanges({ comment, outcome, beforeModel, processedModel, currentModel, currentGroups,
  peerComments = [comment], delta = buildReviewChanges(beforeModel, processedModel), currentLocations = locationIndex(currentModel, currentGroups) }) {
  const changes = new Map([...delta.contentChanges, ...delta.evidenceChanges].map(change => [change.id, change]));
  let changeTargets, mappingSource, mappingNote;
  if (Array.isArray(outcome.changeTargets)) {
    changeTargets = outcome.changeTargets;
    mappingSource = 'explicit';
  } else {
    const candidates = new Map();
    const original = comment.target && changes.get(keyOf(comment.target));
    if (original) candidates.set(original.id, original.target);
    // This fallback is intentionally narrow: a saved feedback source must
    // reproduce the exact comment, and a changed claim must actually cite it.
    const peers = peerComments.filter(peer => normalizeLines(peer.text) === normalizeLines(comment.text));
    if (!peers.some(peer => peer.id === comment.id)) peers.push(comment);
    const exactSources = processedModel.sources.filter(source => source.kind === 'user-feedback' &&
      normalizeLines(source.text) === normalizeLines(comment.text));
    const owners = source => peers.filter(peer => source.id.includes(peer.id) || source.name.includes(peer.id));
    const identified = exactSources.filter(source => {
      const matches = owners(source);
      return matches.length === 1 && matches[0].id === comment.id;
    });
    const usableSources = identified.length ? identified : peers.length === 1
      ? exactSources.filter(source => !owners(source).length) : [];
    if (peers.length > 1 && exactSources.some(source => owners(source).length !== 1)) {
      mappingNote = '同轮有相同原话的批注；无法唯一归属的修改未自动关联，请按原批注核对。';
    }
    const sourceIds = new Set(usableSources.map(source => source.id));
    if (sourceIds.size) for (const change of delta.contentChanges) {
      if (change.target.type !== 'claim') continue;
      const claim = objectFor(processedModel, change.target);
      if (claim?.evidence.some(entry => sourceIds.has(entry.sourceId))) candidates.set(change.id, change.target);
    }
    changeTargets = [...candidates.values()];
    mappingSource = changeTargets.length ? 'derived' : 'unavailable';
  }
  const resultChanges = changeTargets.flatMap(target => {
    const change = changes.get(keyOf(target));
    if (!change) return [];
    return [{
      ...change, outcomeRevision: outcome.revision, state: resultState(processedModel, currentModel, target),
      currentText: textFor(currentModel, target), locations: currentLocations.get(change.id) || [],
    }];
  });
  return { changeTargets, mappingSource, resultChanges, ...(mappingNote ? { mappingNote, mappingIncomplete: true } : {}) };
}

module.exports = { buildReviewChanges, resolveOutcomeChanges, buildChangeLocations: locationIndex };
