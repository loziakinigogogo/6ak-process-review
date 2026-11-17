'use strict';

const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const kinds = new Set(['raw', 'fact', 'reminder', 'proposal', 'question']);
const labels = { raw: '用户原话', fact: '现行事实补充', reminder: '用户提醒', proposal: '改进建议', question: '待确认' };
const emptyTree = () => ({ schemaVersion: 1, revision: 0, entries: [] });
const treeOf = state => state.contentTree ? { schemaVersion: state.contentTree.schemaVersion, revision: state.contentTree.revision,
  entries: state.contentTree.entries.map(({ adoptedRevisions, ...entry }) => entry) } : emptyTree();
const treeHash = state => digest(treeOf(state));
const sourceId = (id, revision) => `wb-content-${id}-r${revision}`;

function publicTree(state, nodeIds) {
  const tree = treeOf(state);
  const active = new Set([...state.model.nodes, ...state.model.relations, ...state.model.rules, ...state.model.issues]
    .flatMap(item => [...(item.claimIds || []), ...(item.resolutionClaimIds || [])]));
  const claims = new Map(state.model.claims.map(item => [item.id, item]));
  const visit = id => { for (const premise of claims.get(id)?.premiseIds || []) if (!active.has(premise)) { active.add(premise); visit(premise); } };
  [...active].forEach(visit);
  const issueIds = new Set(state.model.issues.map(issue => issue.id));
  const used = new Set([
    ...[...active].flatMap(id => (claims.get(id)?.evidence || []).map(e => e.sourceId)),
    ...state.model.coverage.filter(item => item.disposition === 'issue' && item.issueIds.some(id => issueIds.has(id))).map(item => item.sourceId),
  ]);
  return { schemaVersion: 1, revision: tree.revision, hash: treeHash(state), entries: tree.entries.filter(e => !nodeIds || nodeIds.has(e.nodeId)).map(entry => ({
    ...structuredClone(entry), adoptedRevisions: [...new Set(entry.revisions.filter(r => used.has(sourceId(entry.id, r.evidenceRevision || r.revision))).map(r => r.evidenceRevision || r.revision))],
  })) };
}

function mutateTree(state, payload, ErrorType) {
  const fail = (message, code = 400) => { throw new ErrorType(message, code); };
  const tree = structuredClone(treeOf(state));
  if (payload.baseContentRevision !== tree.revision) fail('节点补充已有新修改。你的输入仍保留，请核对最新内容后重试。', 409);
  if (!state.model.nodes.some(n => n.id === payload.nodeId)) fail('节点已不存在，输入未采用。', 409);
  const readText = (value, label, maximum, optional = false) => {
    if (typeof value !== 'string' || value.length > maximum || (!optional && !value.trim())) fail(`${label}不能为空且最多 ${maximum} 字。`);
    return value.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  };
  const at = new Date().toISOString();
  let entry;
  if (payload.operation === 'create') {
    if (tree.entries.length >= 5000) fail('当前任务补充条目过多，请先整理。');
    if (!['section', 'note'].includes(payload.entryType)) fail('请选择栏目或内容条目。');
    entry = { id: crypto.randomUUID(), nodeId: payload.nodeId, entryType: payload.entryType, parentId: null, order: 0, createdAt: at, author: 'local-user', origin: 'user-input', revision: 0, revisions: [] };
    tree.entries.push(entry);
  } else {
    entry = tree.entries.find(e => e.id === payload.entryId && e.nodeId === payload.nodeId && !e.archived);
    if (!entry) fail('补充条目已不存在，请刷新后核对。', 409);
  }
  const previousWords = JSON.stringify([entry.title, entry.text, entry.kind]);
  if (payload.operation === 'create' || payload.operation === 'update') {
    // Plain-text entry does not require categorization. An omitted property on
    // an edit preserves the old record, including its original classification.
    entry.title = readText(payload.title === undefined ? entry.title ?? '' : payload.title, '名称', 200, entry.entryType === 'note');
    entry.text = entry.entryType === 'section' ? '' : readText(payload.text === undefined ? entry.text : payload.text, '补充内容', 20000);
    entry.kind = entry.entryType === 'section' ? null : payload.kind === undefined ? entry.kind ?? 'raw' : payload.kind;
    if (entry.entryType === 'note' && !kinds.has(entry.kind)) fail('补充内容性质无效。');
    const parentId = payload.parentId === undefined ? entry.parentId : payload.parentId || null;
    if (parentId) {
      const parent = tree.entries.find(e => e.id === parentId && !e.archived && e.nodeId === entry.nodeId && e.entryType === 'section');
      if (!parent || parent.id === entry.id) fail('所属栏目无效。');
      const ancestors = new Set([entry.id]);
      let cursor = parent;
      while (cursor) { if (ancestors.has(cursor.id)) fail('栏目不能移入自身的子栏目。'); ancestors.add(cursor.id); cursor = tree.entries.find(e => e.id === cursor.parentId); }
      if (ancestors.size > 12) fail('栏目层级过深，请简化内容组织。');
    }
    if (payload.operation === 'create' || entry.parentId !== parentId) {
      entry.order = Math.max(-1, ...tree.entries.filter(e => e.nodeId === entry.nodeId && e.parentId === parentId && !e.archived && e.id !== entry.id).map(e => e.order)) + 1;
    }
    entry.parentId = parentId;
  } else if (payload.operation === 'move') {
    if (!['up', 'down'].includes(payload.direction)) fail('移动方向无效。');
    const siblings = tree.entries.filter(e => !e.archived && e.nodeId === entry.nodeId && e.parentId === entry.parentId).sort((a,b) => a.order-b.order || a.id.localeCompare(b.id));
    const index = siblings.findIndex(e => e.id === entry.id), next = index + (payload.direction === 'up' ? -1 : 1);
    if (!siblings[next]) return false;
    [siblings[index], siblings[next]] = [siblings[next], siblings[index]];
    siblings.forEach((e,i) => { e.order = i; });
  } else if (payload.operation === 'archive') {
    if (tree.entries.some(e => !e.archived && e.parentId === entry.id)) fail('请先移出栏目中的内容，再移除此栏目。');
    entry.archived = true;
  } else fail('不支持的内容操作。');
  entry.revision += 1;
  if (previousWords !== JSON.stringify([entry.title, entry.text, entry.kind])) entry.evidenceRevision = entry.revision;
  entry.updatedAt = at;
  entry.revisions.push({ revision: entry.revision, evidenceRevision: entry.evidenceRevision, title: entry.title, text: entry.text, kind: entry.kind, parentId: entry.parentId, order: entry.order, archived: !!entry.archived, author: 'local-user', at });
  tree.revision += 1;
  state.contentTree = tree;
  return { contentEntryId: entry.id, nodeId: entry.nodeId };
}

function selectedInputs(state, ids, ErrorType) {
  if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length) throw new ErrorType('补充引用条目无效。');
  return ids.map(id => {
    const entry = treeOf(state).entries.find(e => e.id === id && !e.archived && e.entryType === 'note');
    if (!entry) throw new ErrorType('所选补充条目已不存在，请重新选择。', 409);
    return { id: entry.id, nodeId: entry.nodeId, revision: entry.evidenceRevision || entry.revision, entryRevision: entry.revision, title: entry.title, text: entry.text, kind: entry.kind, kindLabel: labels[entry.kind], author: entry.author, updatedAt: entry.updatedAt };
  });
}

function feedbackSource(input) {
  if (input.kind !== 'fact') return null;
  return { id: sourceId(input.id, input.revision), name: `用户补充 · ${input.title || input.nodeId} · 第 ${input.revision} 版`, text: input.text, sha256: digest(input.text), kind: 'user-feedback' };
}

function rawMaterialSource(input) {
  if (input.kind !== 'raw') return null;
  // This is a verifiable source snapshot, not an assertion that the words are
  // current facts. Keep it separate from the legacy fact-only feedbackSources.
  return { id: sourceId(input.id, input.revision), name: `用户原话 · ${input.title || input.nodeId} · 第 ${input.revision} 版`, text: input.text, sha256: digest(input.text), kind: 'user-feedback' };
}

function validateCandidateInputs(state, metadata, model, ErrorType) {
  if (metadata.baseContentHash !== undefined && metadata.baseContentHash !== treeHash(state)) {
    throw new ErrorType('节点补充已改变。请保留候选，读取最新补充后重新起草和核对。', 409);
  }
  if (metadata.baseContentHash === undefined && treeOf(state).revision > 0) {
    throw new ErrorType('旧候选未包含当前节点补充，请从最新内容重新起草。', 409);
  }
  const inputs = metadata.contentInputs || [];
  const actual = selectedInputs(state, inputs.map(e => e.id), ErrorType);
  if (inputs.length !== actual.length || inputs.some((input, index) => Object.keys(actual[index]).some(key => input[key] !== actual[index][key]))) {
    throw new ErrorType('候选的补充材料快照与真实挂载版本不一致，请重新创建候选。', 409);
  }
  const existing = new Set(state.model.sources.map(s => s.id));
  const allowed = new Map(inputs.map(input => feedbackSource(input) || rawMaterialSource(input)).filter(Boolean).map(s => [s.id,s]));
  for (const source of model.sources) if (source.id.startsWith('wb-content-') && !existing.has(source.id)) {
    const expected = allowed.get(source.id);
    if (!expected || Object.keys(expected).some(key => source[key] !== expected[key])) throw new ErrorType('候选引用的用户材料与所选原话版本不一致；提醒、建议和问题不能直接作为现行事实来源。', 422);
  }
}

module.exports = { treeOf, treeHash, publicTree, mutateTree, selectedInputs, feedbackSource, rawMaterialSource, validateCandidateInputs };
