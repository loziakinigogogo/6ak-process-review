'use strict';

const collections = {
  source: 'sources', group: 'groups', node: 'nodes', relation: 'relations',
  claim: 'claims', rule: 'rules', issue: 'issues',
};

const equal = (first, second) => JSON.stringify(first) === JSON.stringify(second);
const byId = entries => new Map(entries.map(entry => [entry.id, entry]));
const allKeys = (a, b) => new Set([...a.keys(), ...b.keys()]);

function coverageRanges(entries) {
  const ranges = new Map();
  for (const entry of entries) {
    const id = `${entry.sourceId}:${entry.startLine}:${entry.endLine}`;
    if (!ranges.has(id)) ranges.set(id, []);
    ranges.get(id).push(entry);
  }
  return ranges;
}

function sourceDetails(source) {
  const { text, ...details } = source;
  return details;
}

function describeCandidate(before, after, nodeIds) {
  const changes = [];
  const changedIds = {};
  for (const [type, collection] of Object.entries(collections)) {
    const previous = byId(before[collection]);
    const proposed = byId(after[collection]);
    changedIds[type] = new Set();
    for (const id of allKeys(previous, proposed)) {
      const left = previous.get(id), right = proposed.get(id);
      if (equal(left, right)) continue;
      changedIds[type].add(id);
      const details = entry => entry && type === 'source' ? sourceDetails(entry) : entry;
      changes.push({ type, id, before: details(left) ?? null, after: details(right) ?? null });
    }
    const oldOrder = [...previous.keys()].filter(id => proposed.has(id));
    const newOrder = [...proposed.keys()].filter(id => previous.has(id));
    if (!equal(oldOrder, newOrder)) changes.push({ type: 'order', id: collection, before: oldOrder, after: newOrder });
  }
  for (const id of Object.keys(before.report)) {
    const left = before.report[id], right = after.report[id];
    if (!equal(left, right)) changes.push({ type: 'report', id, before: left, after: right });
  }
  const oldCoverage = coverageRanges(before.coverage), newCoverage = coverageRanges(after.coverage);
  for (const id of allKeys(oldCoverage, newCoverage)) {
    const left = oldCoverage.get(id) || [], right = newCoverage.get(id) || [];
    if (!equal(left, right)) changes.push({ type: 'coverage', id, before: left, after: right });
  }

  const affected = new Set(nodeIds);
  function context(model) {
    const claimIds = new Set(changedIds.claim);
    const relations = model.relations.filter(relation => changedIds.relation.has(relation.id) ||
      affected.has(relation.from) || affected.has(relation.to));
    const relationIds = new Set(relations.map(relation => relation.id));
    const entities = [
      ...model.nodes.filter(node => affected.has(node.id)),
      ...model.groups.filter(group => changedIds.group.has(group.id)),
      ...model.rules.filter(rule => changedIds.rule.has(rule.id)),
      ...relations,
    ];
    for (const item of entities) for (const claimId of item.claimIds) claimIds.add(claimId);
    const issues = model.issues.filter(issue => changedIds.issue.has(issue.id) ||
      (issue.status === 'open' && (issue.nodeIds.some(id => affected.has(id)) ||
        issue.relationIds.some(id => relationIds.has(id)) || issue.claimIds.some(id => claimIds.has(id)))));
    for (const issue of issues) {
      for (const claimId of [...issue.claimIds, ...(issue.resolutionClaimIds || [])]) claimIds.add(claimId);
    }
    for (const change of changes) if (change.type === 'coverage') {
      const entries = model === before ? change.before : change.after;
      for (const entry of entries) for (const id of entry.claimIds) claimIds.add(id);
    }
    const table = byId(model.claims);
    for (const claimId of claimIds) for (const id of table.get(claimId)?.premiseIds || []) claimIds.add(id);
    const claims = model.claims.filter(claim => claimIds.has(claim.id));
    const sourceIds = new Set([...changedIds.source, ...claims.flatMap(claim => claim.evidence.map(item => item.sourceId))]);
    return { claims, sources: model.sources.filter(source => sourceIds.has(source.id)).map(sourceDetails), issues };
  }
  const previous = context(before), proposed = context(after);
  const { issues: beforeIssues, ...beforeEvidence } = previous;
  const { issues: afterIssues, ...afterEvidence } = proposed;
  return { changes, evidence: { before: beforeEvidence, after: afterEvidence }, issues: { before: beforeIssues, after: afterIssues } };
}

// Only reverse records whose present values still match the selected transaction.
// A later independent insertion or edit stays in the current model.
function reverseEntries(before, applied, current, collection, conflicts) {
  const result = new Map(current);
  for (const id of allKeys(before, applied)) {
    const oldValue = before.get(id), appliedValue = applied.get(id), currentValue = current.get(id);
    if (equal(oldValue, appliedValue) || equal(oldValue, currentValue)) continue;
    if (!equal(appliedValue, currentValue)) {
      conflicts.push({ collection, id });
      continue;
    }
    if (before.has(id)) result.set(id, oldValue);
    else result.delete(id);
  }

  const currentOrder = [...current.keys()].filter(id => result.has(id));
  const common = new Set(currentOrder.filter(id => before.has(id) && applied.has(id)));
  const oldOrder = [...before.keys()].filter(id => common.has(id));
  const appliedOrder = [...applied.keys()].filter(id => common.has(id));
  const keptOrder = currentOrder.filter(id => common.has(id));
  if (!equal(oldOrder, appliedOrder) && !equal(keptOrder, oldOrder)) {
    if (!equal(keptOrder, appliedOrder)) conflicts.push({ collection, order: true });
    else {
      let next = 0;
      for (const [index, id] of currentOrder.entries()) if (common.has(id)) currentOrder[index] = oldOrder[next++];
    }
  }
  let following = currentOrder.length;
  for (const id of [...before.keys()].reverse()) {
    if (!result.has(id)) continue;
    const index = currentOrder.indexOf(id);
    if (index < 0) currentOrder.splice(following, 0, id);
    else following = index;
  }
  return new Map(currentOrder.map(id => [id, result.get(id)]));
}

function keepSourceCoverage(model, sourceIds) {
  for (const source of model.sources.filter(entry => sourceIds.has(entry.id))) {
    const covered = new Set();
    for (const entry of model.coverage.filter(item => item.sourceId === source.id)) {
      for (let line = entry.startLine; line <= entry.endLine; line++) covered.add(line);
    }
    source.text.split('\n').forEach((value, index) => {
      const line = index + 1;
      if (!value.trim() || covered.has(line)) return;
      model.coverage.push({ sourceId: source.id, startLine: line, endLine: line, disposition: 'out_of_scope', claimIds: [], issueIds: [],
        reason: '保留已登记的来源，本次撤回后这段不再被采用为流程内容。' });
    });
  }
}

function reverseCandidate(before, applied, current) {
  const model = structuredClone(current);
  const conflicts = [];
  for (const [type, collection] of Object.entries(collections)) {
    if (type === 'source' || equal(before[collection], applied[collection])) continue;
    model[collection] = [...reverseEntries(byId(before[collection]), byId(applied[collection]), byId(current[collection]), collection, conflicts).values()];
  }
  model.report = Object.fromEntries(reverseEntries(new Map(Object.entries(before.report)), new Map(Object.entries(applied.report)),
    new Map(Object.entries(current.report)), 'report', conflicts));
  if (!equal(before.coverage, applied.coverage)) {
    const ranges = reverseEntries(coverageRanges(before.coverage), coverageRanges(applied.coverage), coverageRanges(current.coverage), 'coverage', conflicts);
    model.coverage = [...ranges.values()].flat();
  }
  const earlierSources = byId(before.sources);
  keepSourceCoverage(model, new Set(applied.sources.filter(source => !earlierSources.has(source.id)).map(source => source.id)));
  return { model, conflicts };
}

module.exports = { describeCandidate, reverseCandidate };
