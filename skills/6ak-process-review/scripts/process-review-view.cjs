'use strict';

const relationLead = {
  sequence: '接着进入',
  conditional: '满足条件时进入',
  parallel: '并行事项',
  return: '退回',
  data: '数据交付至',
  association: '相关事项',
};

const nodeFields = {
  role: '角色', trigger: '触发条件', actions: '动作', input: '输入',
  output: '产出', rules: '规则', system: '系统',
};

function claimItem(claimId, parentId, context, fieldLabel) {
  return {
    id: parentId ? parentId + '.claim.' + claimId : 'claim.' + claimId,
    target: { type: 'claim', id: claimId, context },
    presentation: { parentId, fieldLabel },
  };
}

function buildProcessGroups(model) {
  const nodesById = new Map(model.nodes.map(node => [node.id, node]));
  const relationsByNode = Map.groupBy(model.relations, relation => relation.from);
  const nodesByGroup = Map.groupBy(model.nodes, node => node.groupId);
  const unknown = new Set(model.claims.filter(claim => claim.origin === 'unknown').map(claim => claim.id));
  const recordedInIssue = new Set(model.issues.flatMap(issue => [...issue.claimIds, ...(issue.resolutionClaimIds || [])]));
  const represented = new Set(recordedInIssue);
  const nodeIdsByClaim = new Map();
  for (const node of model.nodes) {
    for (const id of node.claimIds) {
      if (!nodeIdsByClaim.has(id)) nodeIdsByClaim.set(id, []);
      nodeIdsByClaim.get(id).push(node.id);
    }
  }

  function primaryIssueParent(issue) {
    if (issue.nodeIds.length) return 'node.' + issue.nodeIds[0];
    if (issue.relationIds.length) return 'relation.' + issue.relationIds[0];
    const owners = new Set(issue.claimIds.filter(id => unknown.has(id)).flatMap(id => nodeIdsByClaim.get(id) || []));
    if (owners.size === 1) return 'node.' + [...owners][0];
    return undefined;
  }
  const issuesByParent = new Map();
  for (const issue of model.issues) {
    const primaryParent = primaryIssueParent(issue);
    // Keep the original item unchanged so saved comments retain their identity
    // and fingerprint. Other affected steps receive distinct presentation items.
    const parents = new Set([primaryParent, ...issue.nodeIds.map(id => 'node.' + id)]);
    for (const parentId of parents) {
      if (!issuesByParent.has(parentId)) issuesByParent.set(parentId, []);
      issuesByParent.get(parentId).push({ issue, primary: parentId === primaryParent });
    }
  }
  const issueItems = parentId => (issuesByParent.get(parentId) || []).map(({ issue, primary }) => ({
    id: primary ? 'issue.' + issue.id : parentId + '.issue.' + issue.id,
    target: { type: 'issue', id: issue.id },
    presentation: { parentId, ...(!primary && { canonicalItemId: 'issue.' + issue.id }) },
  }));

  function relationItems(relation, parentId) {
    const id = 'relation.' + relation.id;
    const destination = nodesById.get(relation.to);
    const conditions = new Set(relation.conditionClaimIds);
    const claims = relation.claimIds.map(claimId => {
      const field = conditions.has(claimId) ? 'conditionClaimIds' : 'claimIds';
      represented.add(claimId);
      return claimItem(claimId, id, { type: 'relation', id: relation.id, field },
        conditions.has(claimId) ? '条件' : '流转依据');
    });
    return [{
      id, target: { type: 'relation', id: relation.id },
      presentation: {
        parentId,
        text: relationLead[relation.type] + ' · ' + destination.title,
        relationType: relation.type,
        destinationItemId: 'node.' + destination.id,
        destinationGroupId: destination.groupId,
      },
    }, ...claims, ...issueItems(id)];
  }

  function nodeItems(node) {
    const id = 'node.' + node.id;
    const outgoing = relationsByNode.get(node.id) || [];
    const branchConditions = new Set(outgoing.flatMap(relation => relation.conditionClaimIds));
    const claims = [];
    const seen = new Set();
    function addClaim(claimId, field, label) {
      if (seen.has(claimId)) return;
      seen.add(claimId);
      if (unknown.has(claimId) && recordedInIssue.has(claimId)) return;
      if ((field === 'rules' || field === 'trigger') && branchConditions.has(claimId)) return;
      represented.add(claimId);
      claims.push(claimItem(claimId, id, { type: 'node', id: node.id, field }, label));
    }
    for (const [field, label] of Object.entries(nodeFields)) {
      for (const claimId of node.fields[field]) addClaim(claimId, field, label);
    }
    for (const claimId of node.claimIds) addClaim(claimId, 'claimIds');
    return [{
      id, target: { type: 'node', id: node.id },
      presentation: { text: node.title },
    }, ...claims, ...outgoing.flatMap(relation => relationItems(relation, id)), ...issueItems(id)];
  }

  const groups = model.groups.flatMap(group => {
    const items = (nodesByGroup.get(group.id) || []).flatMap(nodeItems);
    return items.length ? [{ id: group.id, title: group.title, items }] : [];
  });
  const supplementary = model.claims.filter(claim => !represented.has(claim.id)).map(claim => claimItem(claim.id));
  const unplaced = [...supplementary, ...issueItems()];
  if (unplaced.length) {
    groups.push({ id: 'review.unplaced', title: '补充说明与未定位疑点', unplaced: true, items: unplaced });
  }
  return groups;
}

module.exports = { buildProcessGroups };
