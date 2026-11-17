'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { describeCandidate, reverseCandidate } = require('./workbench-candidates.cjs');
const { treeOf, treeHash, publicTree, mutateTree, selectedInputs, feedbackSource, rawMaterialSource, validateCandidateInputs } = require('./workbench-content-tree.cjs');
const { collectBindings, validateArchive, sourceKey, isMaterialSource, upgradeArchive, retainBindings, mutateMaterials } = require('./workbench-material-bindings.cjs');
const { validateModel, NODE_FIELDS } = require('../../scripts/validate-model.cjs');

const clone = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
const idPattern = /^[A-Za-z0-9_-]{1,160}$/;
const collections = { node: 'nodes', relation: 'relations', claim: 'claims', rule: 'rules', issue: 'issues', group: 'groups' };
const unsafeLayoutKeys = new Set(['__proto__', 'prototype', 'constructor']);
const relationTypes = { sequence: '顺序', conditional: '条件分支', parallel: '并行', return: '返回', data: '数据交付', association: '关联' };

class WorkbenchError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.name = 'WorkbenchError';
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

function requireId(value, label = '编号') {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new WorkbenchError(`${label}格式无效。`);
  return value;
}

function layoutId(value, label) {
  requireId(value, label);
  if (unsafeLayoutKeys.has(value)) throw new WorkbenchError(`${label}格式无效。`);
  return value;
}

function layoutObject(value, label, keys) {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some(key => unsafeLayoutKeys.has(key) || (keys && !keys.includes(key)))) {
    throw new WorkbenchError(`${label}格式无效。`);
  }
  return value;
}

function layoutPoint(value, label = '节点位置') {
  layoutObject(value, label, ['x', 'y']);
  if (![value.x, value.y].every(number => Number.isFinite(number) && Math.abs(number) <= 1000000)) {
    throw new WorkbenchError(`${label}无效。`);
  }
  return { x: value.x, y: value.y };
}

// Match graph-scope.mjs: include the core group and its direct neighbours,
// then all relations whose two endpoints are visible (never a recursive walk).
function layoutScope(model, scopeId) {
  layoutId(scopeId, '布局分组');
  if (scopeId !== 'all' && !model.groups.some(group => group.id === scopeId)) throw new WorkbenchError('布局分组不存在。');
  const core = new Set(model.nodes.filter(node => scopeId === 'all' || node.groupId === scopeId).map(node => node.id));
  const nodeIds = new Set(core);
  for (const edge of model.relations) if (core.has(edge.from) || core.has(edge.to)) { nodeIds.add(edge.from); nodeIds.add(edge.to); }
  const edgeIds = new Set(model.relations.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to)).map(edge => edge.id));
  return { nodeIds, edgeIds };
}

function layoutPositions(value, nodeIds) {
  layoutObject(value, '节点位置');
  return Object.fromEntries(Object.entries(value).map(([id, position]) => {
    layoutId(id, '节点编号');
    if (!nodeIds.has(id)) throw new WorkbenchError('节点不在当前布局分组内。');
    return [id, layoutPoint(position)];
  }));
}

function layoutRoutes(value, edgeIds) {
  layoutObject(value, '连线路径');
  return Object.fromEntries(Object.entries(value).map(([id, route]) => {
    layoutId(id, '关系编号');
    if (!edgeIds.has(id)) throw new WorkbenchError('关系不在当前布局分组内。');
    layoutObject(route, '连线路径', ['points', 'label', 'geometryKey']);
    if (!Array.isArray(route.points) || route.points.length < 2 || route.points.length > 10000 ||
      typeof route.geometryKey !== 'string' || !route.geometryKey.length || route.geometryKey.length > 100000) {
      throw new WorkbenchError('连线路径无效。');
    }
    const saved = { points: route.points.map(point => layoutPoint(point, '连线坐标')), geometryKey: route.geometryKey };
    if (route.label !== undefined) {
      layoutObject(route.label, '连线标签', ['x', 'y', 'width', 'height']);
      const { x, y, width, height } = route.label;
      layoutPoint({ x, y }, '连线标签坐标');
      if (![width, height].every(number => Number.isFinite(number) && number > 0 && number <= 1000000)) throw new WorkbenchError('连线标签尺寸无效。');
      saved.label = { x, y, width, height };
    }
    return [id, saved];
  }));
}

function text(value, label, { empty = false, maximum = 20000 } = {}) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim())) {
    throw new WorkbenchError(`${label}${empty ? '' : '不能为空，且'}最多 ${maximum} 字。`);
  }
  return value.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
}

function safeDirectory(directory) {
  if (fs.existsSync(directory)) {
    const info = fs.lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkbenchError('工作目录必须是普通目录。', 400);
  } else fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function readJson(file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new WorkbenchError('工作文件不能是链接。');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function atomicJson(file, value) {
  safeDirectory(path.dirname(file));
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new WorkbenchError('工作文件不能是链接。');
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function assertModel(model) {
  const result = validateModel(model);
  if (!result.ok) throw new WorkbenchError(`流程数据未通过检查：\n${result.errors.join('\n')}`, 422, result);
  return result;
}

function differences(before, after) {
  const items = [];
  const nodeIds = new Set();
  const changedClaims = new Set();
  for (const [type, collection] of Object.entries(collections)) {
    const old = new Map(before[collection].map(item => [item.id, item]));
    const current = new Map(after[collection].map(item => [item.id, item]));
    for (const id of new Set([...old.keys(), ...current.keys()])) {
      const left = old.get(id), right = current.get(id);
      if (JSON.stringify(left) === JSON.stringify(right)) continue;
      const label = right?.title || right?.question || left?.title || left?.question || id;
      items.push({ type, id, label, before: left?.text || left?.title || (type === 'relation' && left ? `${left.from} → ${left.to}` : null), after: right?.text || right?.title || (type === 'relation' && right ? `${right.from} → ${right.to}` : null) });
      if (type === 'node') nodeIds.add(id);
      if (type === 'relation') for (const edge of [left, right].filter(Boolean)) { nodeIds.add(edge.from); nodeIds.add(edge.to); }
      if (type === 'claim') changedClaims.add(id);
      if (type === 'rule') for (const rule of [left, right].filter(Boolean)) for (const claimId of rule.claimIds) changedClaims.add(claimId);
      if (type === 'issue') for (const issue of [left, right].filter(Boolean)) for (const nodeId of issue.nodeIds) nodeIds.add(nodeId);
      if (type === 'group') for (const model of [before, after]) for (const node of model.nodes) if (node.groupId === id) nodeIds.add(node.id);
    }
  }
  // A changed premise or rule parameter can affect a node whose own text did
  // not change. Include that dependency closure in the review locations.
  let expanded;
  do {
    expanded = false;
    for (const model of [before, after]) {
      for (const claim of model.claims) if (!changedClaims.has(claim.id) && claim.premiseIds?.some(id => changedClaims.has(id))) {
        changedClaims.add(claim.id); expanded = true;
      }
      for (const rule of model.rules) if (rule.claimIds.some(id => changedClaims.has(id))) {
        for (const id of rule.claimIds) if (!changedClaims.has(id)) { changedClaims.add(id); expanded = true; }
      }
    }
  } while (expanded);
  for (const model of [before, after]) {
    for (const node of model.nodes) if (node.claimIds.some(id => changedClaims.has(id))) nodeIds.add(node.id);
    for (const edge of model.relations) if (edge.claimIds.some(id => changedClaims.has(id))) { nodeIds.add(edge.from); nodeIds.add(edge.to); }
  }
  return { items, nodeIds: [...nodeIds] };
}

function resetReview(model) {
  for (const mode of ['semantic', 'visual']) model.review[mode] = {
    status: 'not_run', reviewer: '', notes: ['工作稿有新修改，尚未重新完成相应复核。'],
  };
}

function createStore(taskDirectory, options = {}) {
  const taskRoot = path.resolve(taskDirectory);
  safeDirectory(taskRoot);
  const root = safeDirectory(path.join(taskRoot, 'workbench'));
  const stateFile = path.join(root, 'state.json');
  const transactionRoot = safeDirectory(path.join(root, 'transactions'));
  const candidateRoot = safeDirectory(path.join(root, 'candidates'));
  const requestRoot = safeDirectory(path.join(root, 'requests'));
  const referenceRoot = safeDirectory(path.join(root, 'references'));
  const bufferRoot = safeDirectory(path.join(root, 'buffers'));
  const lockFile = path.join(root, 'write.lock');
  const materialFile = path.join(root, 'material-bindings.json');
  const materialSources = new Map();

  function rememberSources(model) { for (const source of model.sources) if (isMaterialSource(source)) materialSources.set(sourceKey(source), clone(source)); }
  function historicalModels(state) {
    const models = [];
    for (const id of fs.readdirSync(transactionRoot).filter(name => idPattern.test(name))) {
      const directory = path.join(transactionRoot, id);
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) continue;
      const metaFile = path.join(directory, 'transaction.json'), receiptFile = path.join(directory, 'receipt.json');
      if (!fs.existsSync(metaFile) || !fs.existsSync(receiptFile)) continue;
      const meta = readJson(metaFile), receipt = readJson(receiptFile);
      if (meta.id !== id || receipt.transactionId !== id || receipt.status !== 'applied' || state.receipts?.[meta.receiptKey]?.transactionId !== id || meta.afterRevision > state.stateRevision) continue;
      for (const side of ['before', 'after']) {
        const file = path.join(directory, `${side}.json`); if (!fs.existsSync(file)) continue;
        const snapshot = readJson(file);
        if (hash(snapshot) !== meta[`${side}Hash`] || snapshot.taskId !== state.taskId || snapshot.model?.report?.id !== state.taskId || hash(snapshot.model) !== snapshot.modelHash || !validateModel(snapshot.model).ok) continue;
        models.push(snapshot.model);
      }
    }
    return models;
  }
  function retainMaterials(models) {
    const previous = fs.existsSync(materialFile) ? validateArchive(readJson(materialFile), WorkbenchError) : null;
    models.forEach(rememberSources);
    const archive=upgradeArchive(previous);
    const changed=retainBindings(archive,models);
    if(changed&&previous)archive.revision++;
    if(!previous||previous.schemaVersion!==2||changed)atomicJson(materialFile,archive);
  }
  function recoverMaterialArchive(state){
    if(fs.existsSync(materialFile))return;
    let latest=null;
    for(const id of fs.readdirSync(transactionRoot).filter(name=>idPattern.test(name))){
      const directory=path.join(transactionRoot,id);
      if(!fs.lstatSync(directory).isDirectory()||fs.lstatSync(directory).isSymbolicLink())continue;
      const metaFile=path.join(directory,'transaction.json'),receiptFile=path.join(directory,'receipt.json'),file=path.join(directory,'materials-after.json');
      if(!fs.existsSync(metaFile)||!fs.existsSync(receiptFile)||!fs.existsSync(file))continue;
      const meta=readJson(metaFile),receipt=readJson(receiptFile);
      if(meta.id!==id||receipt.transactionId!==id||receipt.status!=='applied'||state.receipts?.[meta.receiptKey]?.transactionId!==id||meta.afterRevision>state.stateRevision||!meta.materialsHash)continue;
      const archive=validateArchive(readJson(file),WorkbenchError);
      if(hash(archive)!==meta.materialsHash)throw new WorkbenchError('历史材料摘要不一致，已保留文件。',422);
      if(!latest||archive.revision>latest.revision)latest=archive;
    }
    if(latest)atomicJson(materialFile,latest);
  }
  function materialSnapshot(state, nodeIds) {
    const stored = upgradeArchive(fs.existsSync(materialFile) ? validateArchive(readJson(materialFile), WorkbenchError) : null);
    rememberSources(state.model);
    const allRanges=stored.bindings.flatMap(entry=>[entry,...entry.revisions]);
    if (allRanges.some(binding => !materialSources.has(`${binding.sourceId}:${binding.sourceHash}`))) historicalModels(state).forEach(rememberSources);
    const visible = nodeIds || new Set(state.model.nodes.map(node => node.id));
    const used=collectBindings(state.model);
    const entries=stored.bindings.filter(entry=>visible.has(entry.nodeId)).map(entry=>({...entry,adoptedRevisions:entry.revisions.filter(revision=>!revision.archived&&used.some(binding=>binding.nodeId===entry.nodeId&&binding.sourceId===revision.sourceId&&binding.sourceHash===revision.sourceHash&&binding.startLine>=revision.startLine&&binding.endLine<=revision.endLine)).map(revision=>revision.revision)}));
    const bindings=entries.filter(entry=>!entry.archived);
    const sources = [...new Set(entries.flatMap(entry=>[entry,...entry.revisions]).map(binding => `${binding.sourceId}:${binding.sourceHash}`))].map(key => materialSources.get(key)).filter(Boolean);
    return clone({ schemaVersion: 2, revision: stored.revision, hash: hash(stored), bindings, entries, sources });
  }

  function withLock(action) {
    let lock;
    const token = crypto.randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        lock = fs.openSync(lockFile, 'wx');
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token, createdAt: now() }));
        fs.closeSync(lock);
        lock = undefined;
        break;
      } catch (error) {
        if (lock !== undefined) { fs.closeSync(lock); lock = undefined; }
        if (error.code !== 'EEXIST') throw error;
        let owner;
        try { owner = readJson(lockFile); } catch { throw new WorkbenchError('工作稿写入锁状态不完整，请保留文件并重启服务。', 423); }
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (cause) { if (cause.code === 'ESRCH') alive = false; }
        if (alive || attempt === 1) throw new WorkbenchError('工作稿正在保存，请稍后重试。', 423);
        fs.unlinkSync(lockFile);
      }
    }
    try { return action(); }
    finally {
      if (fs.existsSync(lockFile)) {
        const owner = readJson(lockFile);
        if (owner.token === token) fs.unlinkSync(lockFile);
      }
    }
  }

  function load() {
    const state = readJson(stateFile);
    if (state.workspaceSchemaVersion !== 1 || !Number.isSafeInteger(state.stateRevision) || !Number.isSafeInteger(state.workRevision)) {
      throw new WorkbenchError('工作稿格式不受支持，已保留原文件。', 422);
    }
    if (hash(state.model) !== state.modelHash) throw new WorkbenchError('工作稿模型摘要不一致，已保留文件，请恢复最近事务。', 409);
    if (state.contentTree && (state.contentTree.schemaVersion !== 1 || !Number.isSafeInteger(state.contentTree.revision) || !Array.isArray(state.contentTree.entries))) throw new WorkbenchError('节点补充格式不受支持，已保留原文件。', 422);
    return state;
  }

  function recover() {
    if (!fs.existsSync(stateFile)) return;
    let state = load();
    const records = fs.readdirSync(transactionRoot).filter(name => idPattern.test(name)).map(name => {
      const directory = path.join(transactionRoot, name);
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new WorkbenchError('事务目录无效。');
      const metaFile = path.join(directory, 'transaction.json');
      return fs.existsSync(metaFile) ? { directory, meta: readJson(metaFile) } : null;
    }).filter(Boolean).sort((a, b) => a.meta.afterRevision - b.meta.afterRevision);
    for (const { directory, meta } of records) {
      const receiptFile = path.join(directory, 'receipt.json');
      if (fs.existsSync(receiptFile)) continue;
      const after = readJson(path.join(directory, 'after.json'));
      if (hash(after) !== meta.afterHash) throw new WorkbenchError('恢复事务摘要不一致，已保留原文件。', 422);
      if (hash(state) === meta.beforeHash) {
        assertModel(after.model);
        atomicJson(stateFile, after);
        state = after;
      }
      if (hash(state) === meta.afterHash || state.receipts?.[meta.receiptKey]?.transactionId === meta.id) {
        if(meta.materialsHash){
          const archive=readJson(path.join(directory,'materials-after.json'));
          if(hash(archive)!==meta.materialsHash)throw new WorkbenchError('原文材料恢复摘要不一致，已保留文件。',422);
          const current=fs.existsSync(materialFile)?validateArchive(readJson(materialFile),WorkbenchError):null;
          if(!current||current.revision<=archive.revision)atomicJson(materialFile,archive);
        }
        atomicJson(receiptFile, { transactionId: meta.id, status: 'applied', recoveredAt: now() });
      } else if (state.stateRevision < meta.afterRevision) {
        throw new WorkbenchError('检测到尚未完成且基线不同的保存事务，请保留工作稿并核对。', 409);
      }
    }
  }

  withLock(() => {
    if (!fs.existsSync(stateFile)) {
      if (!options.model) throw new WorkbenchError('工作台尚未初始化，需要初始内容模型。', 404);
      assertModel(options.model);
      const model = clone(options.model);
      atomicJson(stateFile, {
        workspaceSchemaVersion: 1, taskId: model.report.id,
        stateRevision: 1, workRevision: 1, modelHash: hash(model), preferenceHash: hash({}),
        basePublishedRevision: model.report.version, basePublishedHash: hash(model),
        model, pendingEdits: [], view: { positions: layoutPositions(options.positions || {}, new Set(model.nodes.map(node => node.id))), manualNodeIds: [], layouts: {}, defaultLayoutDirection: 'AUTO', selectedGroupId: options.initialGroupId || model.groups[0]?.id || 'all' },
        preferences: {}, requests: [], changes: [], receipts: {}, lastTransactionId: null,
        createdAt: now(), updatedAt: now(), lastSave: { kind: 'applied', message: '工作稿已载入' },
      });
    }
    recover();
    const initialized = load();
    assertModel(initialized.model);
    recoverMaterialArchive(initialized);
    retainMaterials([...historicalModels(initialized), initialized.model]);
  });

  function base(state, payload) {
    if (!Number.isSafeInteger(payload.baseWorkRevision) || typeof payload.baseModelHash !== 'string') {
      throw new WorkbenchError('缺少当前工作版本，请重新读取工作稿后保存。', 409);
    }
    if (payload.baseWorkRevision !== state.workRevision || payload.baseModelHash !== state.modelHash ||
      (payload.basePreferenceHash !== undefined && payload.basePreferenceHash !== state.preferenceHash)) {
      throw new WorkbenchError('工作稿已有新修改。你的输入仍保留，请核对新版后重新保存。', 409, {
        currentWorkRevision: state.workRevision, currentModelHash: state.modelHash, currentPreferenceHash: state.preferenceHash,
      });
    }
  }

  function transaction(operation, payload, change) {
    if (!object(payload)) throw new WorkbenchError('保存内容格式无效。');
    const requestId = requireId(payload.requestId || crypto.randomUUID(), '保存请求编号');
    const receiptKey = `${operation}:${requestId}`;
    return withLock(() => {
      recover();
      const before = load();
      if (before.receipts[receiptKey]) {
        if (before.receipts[receiptKey].payloadHash && before.receipts[receiptKey].payloadHash !== hash(payload)) {
          throw new WorkbenchError('同一个保存请求编号不能提交不同内容，请重新保存。', 409);
        }
        return clone(before);
      }
      const after = clone(before);
      const id = crypto.randomUUID();
      const result = change(after, before, id) || {};
      if (result.unchanged) return clone(before);
      const contentChanged = JSON.stringify(before.model) !== JSON.stringify(after.model) || JSON.stringify(before.pendingEdits) !== JSON.stringify(after.pendingEdits);
      after.stateRevision = before.stateRevision + 1;
      after.workRevision = before.workRevision + (contentChanged ? 1 : 0);
      after.modelHash = hash(after.model);
      after.preferenceHash = hash(after.preferences);
      after.updatedAt = now();
      after.lastTransactionId = id;
      after.receipts[receiptKey] = { transactionId: id, payloadHash: hash(payload), stateRevision: after.stateRevision, workRevision: after.workRevision,
        ...(result.contentEntryId ? { contentEntryId: result.contentEntryId, nodeId: result.nodeId } : {}) };
      if (contentChanged) {
        assertModel(after.model);
        const diff = differences(before.model, after.model);
        after.changes.unshift({ id, actor: result.actor || 'user', summary: result.summary || '更新工作稿', nodeIds: result.nodeIds || diff.nodeIds, at: after.updatedAt, items: diff.items, undoable: operation !== 'undo', kind: operation });
      }
      const directory = safeDirectory(path.join(transactionRoot, id));
      atomicJson(path.join(directory, 'before.json'), before);
      atomicJson(path.join(directory, 'after.json'), after);
      if(result.materials)atomicJson(path.join(directory,'materials-after.json'),result.materials);
      atomicJson(path.join(directory, 'transaction.json'), {
        id, receiptKey, operation, contentChanged, beforeHash: hash(before), afterHash: hash(after),
        beforeRevision: before.stateRevision, afterRevision: after.stateRevision, createdAt: after.updatedAt,
        ...(result.materials?{materialsHash:hash(result.materials)}:{}),
      });
      atomicJson(stateFile, after);
      if(result.materials)atomicJson(materialFile,result.materials);
      atomicJson(path.join(directory, 'receipt.json'), { transactionId: id, status: 'applied', appliedAt: now() });
      if (contentChanged) retainMaterials([before.model, after.model]);
      return clone(after);
    });
  }

  function targetsFor(state, targets = []) {
    if (!Array.isArray(targets) || targets.length > 100) throw new WorkbenchError('引用对象格式无效。');
    return targets.map(target => {
      if (!object(target) || !Object.hasOwn(collections, target.type)) throw new WorkbenchError('引用类型无效。');
      requireId(target.id, '引用对象');
      const entry = state.model[collections[target.type]].find(item => item.id === target.id);
      if (!entry) throw new WorkbenchError('引用对象已不存在，请重新定位。', 409);
      return { type: target.type, id: target.id, label: entry.title || entry.question || entry.text || `${entry.from} → ${entry.to}` };
    });
  }

  function contextFrom(state, nodeId) {
    if (nodeId !== undefined && nodeId !== null) {
      requireId(nodeId, '节点编号');
      if (!state.model.nodes.some(node => node.id === nodeId)) throw new WorkbenchError('节点不存在。', 404);
    }
    const model = state.model;
    const relations = nodeId ? model.relations.filter(edge => edge.from === nodeId || edge.to === nodeId) : model.relations;
    const ids = nodeId ? new Set([nodeId, ...relations.flatMap(edge => [edge.from, edge.to])]) : new Set(model.nodes.map(node => node.id));
    const nodes = model.nodes.filter(node => ids.has(node.id));
    const edgeIds = new Set(relations.map(edge => edge.id));
    const issues = model.issues.filter(issue => !nodeId || issue.nodeIds.some(id => ids.has(id)) || issue.relationIds.some(id => edgeIds.has(id)));
    const claimIds = new Set([...nodes, ...relations, ...issues].flatMap(item => [...(item.claimIds || []), ...(item.resolutionClaimIds || [])]));
    const claimTable = new Map(model.claims.map(claim => [claim.id, claim]));
    function visit(id) { for (const premise of claimTable.get(id)?.premiseIds || []) if (!claimIds.has(premise)) { claimIds.add(premise); visit(premise); } }
    for (const id of [...claimIds]) visit(id);
    const claims = model.claims.filter(claim => claimIds.has(claim.id));
    const sourceIds = new Set(claims.flatMap(claim => claim.evidence.map(item => item.sourceId)));
    const materials = materialSnapshot(state, ids);
    const contextSources = new Map([...model.sources.filter(source => sourceIds.has(source.id)), ...materials.sources].map(source => [sourceKey(source), source]));
    return clone({ taskId: state.taskId, workRevision: state.workRevision, modelHash: state.modelHash, preferenceHash: state.preferenceHash,
      report: model.report, node: nodeId ? nodes.find(node => node.id === nodeId) : null,
      nodes, relations, claims, sources: [...contextSources.values()], materials, issues,
      rules: model.rules.filter(rule => rule.claimIds.some(id => claimIds.has(id))),
      pendingEdits: state.pendingEdits.filter(edit => !nodeId || edit.nodeId === nodeId), preferences: state.preferences,
      contentTree: publicTree(state, ids),
    });
  }

  function edit(payload) {
    return transaction('edit', payload, (state, before, transactionId) => {
      base(before, payload);
      const nodeId = requireId(payload.nodeId, '节点编号');
      const node = state.model.nodes.find(item => item.id === nodeId);
      if (!node) throw new WorkbenchError('节点已不存在。', 404);
      if (payload.intent !== undefined && !['current', 'proposal'].includes(payload.intent)) throw new WorkbenchError('编辑性质无效。');
      if (payload.scope !== undefined && payload.scope !== 'copy') throw new WorkbenchError('编辑范围无效。');
      const copyOnly = payload.scope === 'copy';
      if (copyOnly && Object.hasOwn(payload, 'groupId')) throw new WorkbenchError('分组调整请交给 Agent 核对。');
      if (payload.title !== undefined) text(payload.title, '节点名称', { empty: true, maximum: 200 });
      if (payload.groupId !== undefined && !state.model.groups.some(group => group.id === payload.groupId)) throw new WorkbenchError('整理分组不存在。');
      if (payload.claims !== undefined && !Array.isArray(payload.claims)) throw new WorkbenchError('详情格式无效。');
      if (payload.branches !== undefined && !Array.isArray(payload.branches)) throw new WorkbenchError('出口格式无效。');
      const claims = payload.claims || [], branches = payload.branches || [];
      const seen = new Set();
      let incomplete = payload.title !== undefined && !payload.title.trim();
      for (const entry of claims) {
        if (!object(entry) || !node.claimIds.includes(entry.id) || seen.has(entry.id)) throw new WorkbenchError('详情包含重复或不属于本节点的原句。');
        seen.add(entry.id);
        text(entry.text, '详情内容', { empty: true });
        incomplete ||= !entry.text.trim();
      }
      seen.clear();
      for (const row of branches) {
        if (!object(row) || seen.has(row.id)) throw new WorkbenchError('出口编号重复或格式无效。');
        if (copyOnly && Object.hasOwn(row, 'to')) throw new WorkbenchError('连线去向调整请交给 Agent 核对。');
        seen.add(row.id);
        const edge = state.model.relations.find(edge => edge.id === row.id && edge.from === nodeId);
        if (!edge) throw new WorkbenchError('出口不属于此节点。');
        if (row.to !== undefined) {
          if (row.to === '') incomplete = true;
          else if (!state.model.nodes.some(node => node.id === row.to)) throw new WorkbenchError('出口目标不存在。');
        }
        if (row.conditions !== undefined && !Array.isArray(row.conditions)) throw new WorkbenchError('条件格式无效。');
        const conditionIds = new Set();
        for (const condition of row.conditions || []) {
          if (!object(condition) || !edge.conditionClaimIds.includes(condition.id) || conditionIds.has(condition.id)) throw new WorkbenchError('条件包含重复或不属于此出口的原句。');
          conditionIds.add(condition.id);
          text(condition.text, '出口条件', { empty: true });
          incomplete ||= !condition.text.trim();
        }
      }
      const keepPending = pending => {
        if (pending.nodeId !== nodeId) return true;
        const input = pending.input;
        if (!copyOnly || !object(input)) return false;
        const original = pending.original;
        if (Object.hasOwn(input, 'groupId') && input.groupId !== original?.node?.groupId) return true;
        const originalEdges = Array.isArray(original?.relations) ? original.relations : [];
        return Array.isArray(input.branches) && input.branches.some(row => object(row) && Object.hasOwn(row, 'to') &&
          row.to !== originalEdges.find(edge => edge.id === row.id)?.to);
      };
      if (payload.intent === 'proposal' || incomplete) {
        state.pendingEdits = state.pendingEdits.filter(keepPending);
        const original = contextFrom(before, nodeId);
        original.pendingEdits = [];
        state.pendingEdits.push({ id: transactionId, nodeId, baseWorkRevision: before.workRevision, baseModelHash: before.modelHash,
          original, input: clone(payload), reason: incomplete ? '内容尚未填写完整' : '待讨论的改法', createdAt: now() });
        state.lastSave = { kind: 'pending', message: '编辑稿已保存，尚未采用到流程。' };
        return { summary: `保存「${node.title}」的待定编辑`, nodeIds: [nodeId] };
      }
      const { addClaim, replaceClaim } = manualClaims(state.model, transactionId);
      if (payload.title !== undefined) node.title = payload.title.trim();
      if (payload.groupId !== undefined) node.groupId = payload.groupId;
      for (const entry of claims) replaceClaim(node, entry.id, entry.text, 'node');
      for (const row of branches) {
        const edge = state.model.relations.find(edge => edge.id === row.id);
        const original = clone(edge);
        for (const condition of row.conditions || []) replaceClaim(edge, condition.id, condition.text, 'relation');
        if (row.to !== undefined) edge.to = row.to;
        if (original.to !== edge.to || JSON.stringify(original.conditionClaimIds) !== JSON.stringify(edge.conditionClaimIds)) {
          const target = state.model.nodes.find(node => node.id === edge.to);
          const conditions = edge.conditionClaimIds.map(id => state.model.claims.find(claim => claim.id === id).text);
          const relationClaim = addClaim(`用户提交的出口设置：从「${node.title}」进入「${target.title}」；关系类型：${edge.type}。${conditions.length ? `\n条件：${conditions.join('；')}` : ''}`);
          edge.claimIds = [...new Set([relationClaim, ...edge.conditionClaimIds])];
        }
      }
      state.pendingEdits = state.pendingEdits.filter(keepPending);
      if (JSON.stringify(state.model) !== JSON.stringify(before.model)) resetReview(state.model);
      if (JSON.stringify(state.model) === JSON.stringify(before.model) && JSON.stringify(state.pendingEdits) === JSON.stringify(before.pendingEdits)) return { unchanged: true };
      state.lastSave = { kind: 'applied', message: '修改已保存到流程草稿。' };
      return { summary: `修改「${node.title}」`, nodeIds: [nodeId] };
    });
  }

  function manualClaims(model, transactionId) {
    let serial = 0;
    const addClaim = value => {
      const suffix = `${transactionId}-${++serial}`;
      const sourceId = `feedback-${suffix}`, id = `manual-${suffix}`;
      const content = text(value, '用户修订内容');
      const source = { id: sourceId, name: '用户在工作台的直接修订', kind: 'user-feedback', text: content, sha256: hash(content) };
      const evidence = { sourceId, startLine: 1, endLine: content.split('\n').length, quote: content };
      model.sources.push(source);
      model.claims.push({ id, text: content, origin: 'explicit', evidence: [evidence], rationale: '用户直接修订的工作稿内容，尚未完成业务语义复核。' });
      model.coverage.push({ sourceId, startLine: 1, endLine: evidence.endLine, disposition: 'represented', claimIds: [id], issueIds: [], reason: '保存用户手动输入及其当前工作稿表述。' });
      return id;
    };
    const assertUnshared = (claimId, ownerType, ownerId) => {
      const others = [];
      for (const entry of model.nodes) if (entry.claimIds.includes(claimId) && !(ownerType === 'node' && entry.id === ownerId)) others.push(entry.title);
      for (const entry of model.relations) if (entry.claimIds.includes(claimId) && !(ownerType === 'relation' && entry.id === ownerId)) others.push(`${entry.from} → ${entry.to}`);
      for (const entry of [...model.rules, ...model.groups]) if (entry.claimIds.includes(claimId)) others.push(entry.title);
      for (const entry of model.claims) if (entry.premiseIds?.includes(claimId)) others.push(entry.text);
      for (const entry of model.issues) if (entry.resolutionClaimIds?.includes(claimId)) others.push(entry.question);
      if (others.length) throw new WorkbenchError('这段内容还被其他步骤、规则或推断使用。输入已保留，请把相关内容一起交给 Agent 核对。', 409, { sharedClaimId: claimId, affected: others });
    };
    const replaceClaim = (owner, claimId, value, ownerType) => {
      const old = model.claims.find(claim => claim.id === claimId);
      const content = text(value, '内容');
      if (old.text === content) return claimId;
      assertUnshared(claimId, ownerType, owner.id);
      const replacementId = addClaim(content);
      const replacement = model.claims.find(claim => claim.id === replacementId);
      if (old.issueIds?.length) replacement.issueIds = [...old.issueIds];
      owner.claimIds = owner.claimIds.map(id => id === claimId ? replacementId : id);
      if (owner.fields) for (const field of Object.keys(owner.fields)) owner.fields[field] = owner.fields[field].map(id => id === claimId ? replacementId : id);
      if (owner.conditionClaimIds) owner.conditionClaimIds = owner.conditionClaimIds.map(id => id === claimId ? replacementId : id);
      for (const issue of model.issues) if (issue.status === 'open' && issue.claimIds.includes(claimId) && !issue.claimIds.includes(replacementId)) issue.claimIds.push(replacementId);
      return replacementId;
    };
    return { addClaim, replaceClaim };
  }

  function draftStructure(model, payload) {
    const seed = hash(requireId(payload.requestId, '保存请求编号')).slice(0, 32);
    const operation = layoutObject(payload.operation, '结构调整');
    const { addClaim, replaceClaim } = manualClaims(model, `structure-${seed}`);
    const nodeId = `node-${seed}`, relationId = `relation-${seed}`;
    function findNode(id) {
      requireId(id, '节点编号');
      const node = model.nodes.find(item => item.id === id);
      if (!node) throw new WorkbenchError('连线端点已不存在。', 404);
      return node;
    }
    function addNode(input) {
      layoutObject(input, '新节点', ['title', 'groupId', 'fields']);
      const title = text(input.title, '节点名称', { maximum: 200 }).trim();
      const groupId = input.groupId;
      if (!model.groups.length && groupId === 'unassigned') {
        model.groups.push({ id: groupId, title: '未分组', kind: 'editorial', claimIds: [] });
      }
      if (!model.groups.some(group => group.id === groupId)) throw new WorkbenchError('请选择有效的整理分组。');
      const values = input.fields === undefined ? {} : layoutObject(input.fields, '节点详情', NODE_FIELDS);
      const fields = Object.fromEntries(NODE_FIELDS.map(field => [field, []]));
      const claimIds = [addClaim(title)];
      for (const [field, value] of Object.entries(values)) {
        const content = text(value, '节点详情', { empty: true });
        if (!content.trim()) continue;
        const id = addClaim(content);
        fields[field].push(id);
        claimIds.push(id);
      }
      const node = { id: nodeId, title, groupId, claimIds, fields };
      model.nodes.push(node);
      return node;
    }
    function addRelationDescription(from, to, type, description) {
      return addClaim(`从「${from.title}」到「${to.title}」的${relationTypes[type]}关系。${description ? '\n' + description : ''}`);
    }
    function buildRelation(id, from, to, type, description, condition = '') {
      const conditionClaimIds = condition.trim() ? [addClaim(condition)] : [];
      return { id, from: from.id, to: to.id, type, claimIds: [addRelationDescription(from, to, type, description), ...conditionClaimIds], conditionClaimIds };
    }
    function reviseRelation(previous, from, to, input) {
      const lookup = new Map(model.claims.map(claim => [claim.id, claim.text]));
      const detailIds = previous.claimIds.filter(id => !previous.conditionClaimIds.includes(id));
      const oldDescription = detailIds.map(id => lookup.get(id)).join('\n');
      const oldConditions = previous.conditionClaimIds.map(id => lookup.get(id));
      const keepDescription = input.description === oldDescription;
      const keepConditions = input.condition === undefined || input.condition === oldConditions.join('；');
      if (keepDescription && keepConditions) return previous;
      const condition = keepConditions ? '' : text(input.condition, '关系条件', { empty: true });
      if (!keepConditions && !condition.trim() && previous.type === 'conditional') throw new WorkbenchError('请填写此条件分支的适用条件。');
      if (keepDescription && !keepConditions && oldConditions.some(old => oldDescription.includes(old) && !condition.includes(old))) {
        throw new WorkbenchError('关系说明仍包含旧条件，请同时核对并修订关系说明。');
      }
      const description = keepDescription ? '' : text(input.description, '关系说明');
      const descriptionIds = keepDescription ? detailIds : [addRelationDescription(from, to, previous.type, description)];
      const conditionClaimIds = keepConditions ? previous.conditionClaimIds : condition.trim() ? [addClaim(condition)] : [];
      if (!descriptionIds.length && !conditionClaimIds.length) throw new WorkbenchError('请填写此关系的依据。');
      return { ...previous, claimIds: [...descriptionIds, ...conditionClaimIds], conditionClaimIds };
    }
    switch (operation.type) {
      case 'add-node': {
        layoutObject(operation, '新增节点', ['type', 'node']);
        const node = addNode(operation.node);
        return { summary: `新增节点「${node.title}」`, nodeId };
      }
      case 'connect': {
        layoutObject(operation, '接线', ['type', 'relation']);
        const input = layoutObject(operation.relation, '关系', ['id', 'from', 'to', 'type', 'description', 'condition']);
        const from = findNode(input.from), to = findNode(input.to);
        if (typeof input.type !== 'string' || !Object.hasOwn(relationTypes, input.type)) throw new WorkbenchError('请选择有效的关系类型。');
        let index = -1;
        if (input.id !== undefined) {
          requireId(input.id, '关系编号');
          index = model.relations.findIndex(edge => edge.id === input.id);
          if (index < 0) throw new WorkbenchError('要改接的关系已不存在。', 404);
        }
        const previous = model.relations[index];
        let relation;
        if (previous && previous.from === from.id && previous.to === to.id && previous.type === input.type) {
          relation = reviseRelation(previous, from, to, input);
          if (relation === previous) return { relationId: previous.id, unchanged: true };
        } else {
          const description = text(input.description, '关系说明');
          const condition = input.condition === undefined ? '' : text(input.condition, '关系条件', { empty: true });
          if (input.type === 'conditional' && !condition.trim()) throw new WorkbenchError('请填写此条件分支的适用条件。');
          relation = buildRelation(input.id ?? relationId, from, to, input.type, description, condition);
        }
        if (index < 0) model.relations.push(relation);
        else model.relations[index] = relation;
        return { summary: `${index < 0 ? '新增' : '改接'}「${from.title} → ${to.title}」`, relationId: relation.id };
      }
      case 'insert-step': {
        layoutObject(operation, '插入步骤', ['type', 'relationId', 'node', 'description', 'updates']);
        const index = model.relations.findIndex(edge => edge.id === requireId(operation.relationId, '关系编号'));
        if (index < 0) throw new WorkbenchError('要插入步骤的连线已不存在。', 404);
        const previous = model.relations[index];
        if (previous.type !== 'sequence' || previous.conditionClaimIds.length) throw new WorkbenchError('只能在无条件顺序线上插入步骤。');
        const from = findNode(previous.from), to = findNode(previous.to);
        const node = addNode(operation.node);
        const description = operation.description === undefined ? '' : text(operation.description, '顺序关系说明', { empty: true });
        if (operation.updates !== undefined && !Array.isArray(operation.updates)) throw new WorkbenchError('关联字段格式无效。');
        const seen = new Set();
        for (const row of operation.updates || []) {
          layoutObject(row, '关联字段', ['nodeId', 'claimId', 'text']);
          const owner = row.nodeId === from.id ? from : row.nodeId === to.id ? to : null;
          if (!owner || seen.has(row.claimId) || owner.fields.actions.includes(row.claimId) ||
              !['trigger', 'input', 'output'].some(field => owner.fields[field].includes(row.claimId))) {
            throw new WorkbenchError('插入只能调整原连线两端的触发、输入和产出字段。拆出已有活动请交给 Agent 核对。');
          }
          seen.add(row.claimId);
          replaceClaim(owner, row.claimId, row.text, 'node');
        }
        const relationIds = [relationId, `${relationId}-next`];
        const left = buildRelation(relationIds[0], from, node, 'sequence', description);
        const right = buildRelation(relationIds[1], node, to, 'sequence', description);
        model.relations.splice(index, 1, left, right);
        // Keep earlier issues and their evidence attached to the replacement path.
        for (const issue of model.issues) {
          issue.relationIds = issue.relationIds.flatMap(id => id === previous.id ? relationIds : [id]);
        }
        return { summary: `在「${from.title}」与「${to.title}」之间插入「${node.title}」`, nodeId, relationIds };
      }
      default:
        throw new WorkbenchError('结构调整类型无效。');
    }
  }

  function previewStructureEdit(payload) {
    if (!object(payload)) throw new WorkbenchError('结构调整格式无效。');
    const before = load();
    base(before, payload);
    const proposed = clone(before.model);
    const result = draftStructure(proposed, payload);
    assertModel(proposed);
    return { ...result, ...differences(before.model, proposed) };
  }

  function structureEdit(payload) {
    return transaction('structure-edit', payload, (state, before) => {
      base(before, payload);
      const result = draftStructure(state.model, payload);
      if (result.unchanged) return result;
      resetReview(state.model);
      state.lastSave = { kind: 'applied', message: '结构调整已保存到流程草稿。' };
      return result;
    });
  }

  function undo(payload) {
    return transaction('undo', payload, (state, before) => {
      base(before, payload);
      const change = before.changes.find(change => change.undoable);
      if (!change) throw new WorkbenchError('没有可撤销的内容修改。');
      const directory = path.join(transactionRoot, requireId(change.id));
      const previous = readJson(path.join(directory, 'before.json'));
      const applied = readJson(path.join(directory, 'after.json'));
      if (hash(before.model) !== hash(applied.model) || JSON.stringify(before.pendingEdits) !== JSON.stringify(applied.pendingEdits)) {
        throw new WorkbenchError('内容已在这次修改之后改变，不能直接覆盖。请先核对修改历史。', 409);
      }
      state.model = previous.model;
      state.pendingEdits = previous.pendingEdits;
      for (const entry of state.changes) if (entry.id === change.id) entry.undoable = false;
      if (change.kind === 'candidate') for (const request of state.requests) {
        if (request.appliedWorkRevision === applied.workRevision) {
          request.status = request.result ? 'answered' : 'saved';
          request.revertedWorkRevision = before.workRevision + 1;
          delete request.appliedWorkRevision;
        }
      }
      state.lastSave = { kind: 'undo', message: '已撤销最近一次内容修改，布局与引用保留。' };
      return { summary: `撤销：${change.summary}`, nodeIds: change.nodeIds };
    });
  }

  function saveBuffer(payload) {
    if (!object(payload)) throw new WorkbenchError('编辑缓存格式无效。');
    const sessionId = requireId(payload.sessionId, '会话编号'), nodeId = requireId(payload.nodeId, '节点编号');
    if (!Number.isSafeInteger(payload.revision) || payload.revision < 1) throw new WorkbenchError('输入版本无效。');
    if (payload.draft !== null && !object(payload.draft)) throw new WorkbenchError('编辑缓存必须是对象。');
    if (JSON.stringify(payload.draft).length > 200000) throw new WorkbenchError('编辑缓存过长。', 413);
    return withLock(() => {
      const state = load();
      if (!state.model.nodes.some(node => node.id === nodeId)) throw new WorkbenchError('节点不存在；输入仍保留在浏览器。', 404);
      const directory = safeDirectory(path.join(bufferRoot, sessionId));
      const file = path.join(directory, `${nodeId}.json`);
      const previous = fs.existsSync(file) ? readJson(file) : null;
      if (previous && payload.revision < previous.revision) throw new WorkbenchError('较新的输入已保存，忽略旧输入。', 409, previous);
      if (previous && payload.revision === previous.revision) {
        if (JSON.stringify(previous.draft) === JSON.stringify(payload.draft)) return clone(previous);
        throw new WorkbenchError('同一输入版本包含不同内容。', 409, previous);
      }
      const buffer = { sessionId, nodeId, revision: payload.revision, draft: clone(payload.draft), updatedAt: now() };
      atomicJson(file, buffer);
      return clone(buffer);
    });
  }

  function buffers(sessionId) {
    const directory = path.join(bufferRoot, requireId(sessionId, '会话编号'));
    if (!fs.existsSync(directory)) return {};
    safeDirectory(directory);
    const result = {};
    for (const name of fs.readdirSync(directory)) if (/^[A-Za-z0-9_-]+\.json$/.test(name)) {
      const value = readJson(path.join(directory, name));
      Object.defineProperty(result, value.nodeId, { value, enumerable: true, configurable: true, writable: true });
    }
    return result;
  }

  function updateView(payload) {
    return transaction('view', payload, state => {
      if (payload.positions !== undefined && payload.layout !== undefined) throw new WorkbenchError('全局位置与分组布局不能同时保存。');
      if (payload.layoutDirection !== undefined && (payload.positions !== undefined || payload.layout !== undefined)) {
        throw new WorkbenchError('布局方向与节点位置不能同时保存。');
      }
      if (payload.positions !== undefined) {
        const positions = layoutPositions(payload.positions, new Set(state.model.nodes.map(node => node.id)));
        Object.assign(state.view.positions, positions);
        state.view.manualNodeIds = [...new Set([...state.view.manualNodeIds, ...Object.keys(positions)])];
      }
      if (payload.layout !== undefined) updateLayout(state, payload.layout);
      if (payload.layoutDirection !== undefined) updateLayoutDirection(state, payload.layoutDirection);
      if (payload.selectedGroupId !== undefined) {
        if (payload.selectedGroupId !== 'all' && !state.model.groups.some(group => group.id === payload.selectedGroupId)) throw new WorkbenchError('整理分组不存在。');
        state.view.selectedGroupId = payload.selectedGroupId;
      }
      if (payload.selectedNodeId !== undefined) {
        if (payload.selectedNodeId !== null && !state.model.nodes.some(node => node.id === payload.selectedNodeId)) throw new WorkbenchError('节点不存在。');
        state.view.selectedNodeId = payload.selectedNodeId;
      }
      if (payload.workMode !== undefined) {
        if (!['read', 'edit'].includes(payload.workMode)) throw new WorkbenchError('工作形态无效。');
        state.view.workMode = payload.workMode;
      }
      if (payload.contentView !== undefined) {
        if (!['graph', 'content'].includes(payload.contentView)) throw new WorkbenchError('内容视图无效。');
        state.view.contentView = payload.contentView;
      }
      if (payload.viewport !== undefined) {
        const viewport = payload.viewport;
        if (!object(viewport) || !Number.isFinite(viewport.x) || !Number.isFinite(viewport.y) || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0 || viewport.zoom > 10) throw new WorkbenchError('视口无效。');
        state.view.viewport = { x: viewport.x, y: viewport.y, zoom: viewport.zoom };
      }
      if (payload.preferences !== undefined) {
        if (!object(payload.preferences) || JSON.stringify(payload.preferences).length > 10000) throw new WorkbenchError('整理偏好格式无效。');
        state.preferences = { ...state.preferences, ...clone(payload.preferences) };
      }
      state.lastSave = { kind: 'view', message: '阅读位置与展示设置已保存。' };
    });
  }

  function updateLayoutDirection(state, input) {
    layoutObject(input, '布局方向', ['scopeId', 'mode', 'baseRevision']);
    const { scopeId, mode } = input;
    layoutScope(state.model, scopeId);
    if (!['AUTO', 'DOWN', 'RIGHT'].includes(mode)) throw new WorkbenchError('布局方向无效。');
    const revision = state.view.layoutDirections?.[scopeId]?.revision || 0;
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision !== revision) {
      throw new WorkbenchError('当前分组的方向设置已有新修改，请读取最新设置后重试。', 409, { scopeId, currentDirectionRevision: revision });
    }
    state.view.layoutDirections ||= {};
    state.view.layoutDirections[scopeId] = { mode, revision: revision + 1 };
  }

  function updateLayout(state, input) {
    layoutObject(input, '布局操作', ['scopeId', 'direction', 'action', 'baseRevision', 'baseModelHash', 'positions', 'routes', 'nodeIds', 'inputKey']);
    const { scopeId, action, direction = 'DOWN' } = input;
    if (!['DOWN', 'RIGHT'].includes(direction)) throw new WorkbenchError('布局方向无效。');
    const { nodeIds, edgeIds } = layoutScope(state.model, scopeId);
    if (!['move', 'initialize', 'arrange', 'reset', 'undo', 'release', 'refresh', 'measure'].includes(action)) throw new WorkbenchError('布局操作无效。');
    // Keep the original map and omitted-direction API as the vertical baseline.
    // Each horizontal scope owns independent revisions, manual points and undo.
    const layoutKey = direction === 'RIGHT' ? 'horizontalLayouts' : 'layouts';
    const layouts = state.view[layoutKey] || {};
    const current = layouts[scopeId];
    const revision = current?.revision || 0;
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision !== revision) {
      throw new WorkbenchError('当前分组的布局已有新修改，请读取最新布局后重试。', 409, { scopeId, currentLayoutRevision: revision });
    }
    if (action === 'initialize' && Object.hasOwn(layouts, scopeId)) {
      throw new WorkbenchError('当前分组已有保存的布局，不能重新初始化。', 409, { scopeId, currentLayoutRevision: revision });
    }
    const automatic = ['arrange', 'reset', 'initialize', 'refresh'].includes(action);
    if ((automatic || action === 'measure' || input.inputKey !== undefined) && input.baseModelHash !== state.modelHash) {
      throw new WorkbenchError('流程内容已改变，请基于当前流程重新整理布局。', 409, { currentModelHash: state.modelHash });
    }
    if (input.inputKey !== undefined && (typeof input.inputKey !== 'string' || input.inputKey.length > 128 || !/^elk-input:v\d+:(?:RIGHT:|DOWN:)?[a-f0-9]{16}:\d+$/.test(input.inputKey))) {
      throw new WorkbenchError('布局测量签名无效。');
    }
    if (['refresh', 'measure'].includes(action) && (!current || !input.inputKey)) throw new WorkbenchError('自动更新需要已有布局与实测签名。');
    if (action === 'measure' && (current.needsMeasurement !== state.modelHash || [...nodeIds].some(id => !Object.hasOwn(current.positions, id)))) {
      throw new WorkbenchError('流程结构已有变化，需要重新整理布局。', 409);
    }
    if (input.baseModelHash !== undefined && input.baseModelHash !== state.modelHash) {
      throw new WorkbenchError('流程内容已改变，请重新读取布局。', 409, { currentModelHash: state.modelHash });
    }
    if ((action !== 'move' && !automatic && input.positions !== undefined) ||
      (!automatic && input.routes !== undefined) || (action !== 'release' && input.nodeIds !== undefined)) {
      throw new WorkbenchError('布局操作包含不适用的字段。');
    }
    const positions = input.positions === undefined ? undefined : layoutPositions(input.positions, nodeIds);
    const routes = input.routes === undefined ? {} : layoutRoutes(input.routes, edgeIds);
    if ((action === 'move' || automatic) && !positions) throw new WorkbenchError('缺少节点位置。');
    if (['reset', 'refresh'].includes(action) && [...nodeIds].some(id => !Object.hasOwn(positions, id))) throw new WorkbenchError('整理位置必须包含当前图的全部节点。');
    if (action === 'move' && !Object.keys(positions).length) throw new WorkbenchError('请选择要移动的节点。');
    let released;
    if (action === 'release') {
      if (!Array.isArray(input.nodeIds) || !input.nodeIds.length) throw new WorkbenchError('请选择要解除固定的节点。');
      released = new Set(input.nodeIds.map(id => {
        layoutId(id, '节点编号');
        if (!nodeIds.has(id)) throw new WorkbenchError('节点不在当前布局分组内。');
        return id;
      }));
    }
    const filterPositions = values => Object.fromEntries(Object.entries(values).filter(([id]) => nodeIds.has(id)));
    const layout = current || {
      revision: 0, positions: direction === 'RIGHT' ? {} : filterPositions(state.view.positions),
      manualNodeIds: direction === 'RIGHT' ? [] : state.view.manualNodeIds.filter(id => nodeIds.has(id)), routes: {},
    };
    // Content edits may change group membership while keeping the old layout
    // useful. Keep only entries that can still be shown in the current scope.
    layout.positions = filterPositions(layout.positions);
    layout.manualNodeIds = layout.manualNodeIds.filter(id => nodeIds.has(id));
    layout.routes = Object.fromEntries(Object.entries(layout.routes).filter(([id]) => edgeIds.has(id)));
    if (automatic) {
      for (const id of layout.manualNodeIds) if (action !== 'reset' && Object.hasOwn(positions, id) &&
        (!layout.positions[id] || positions[id].x !== layout.positions[id].x || positions[id].y !== layout.positions[id].y)) {
        throw new WorkbenchError('手动固定的节点不能被自动整理移动，请先解除固定。', 409, { scopeId, nodeId: id });
      }
      // The first local layout replaces the imported global display baseline.
      // Only an explicit later arrangement offers a one-step undo snapshot.
      if (action === 'arrange' || action === 'reset') layout.previous = clone({ positions: layout.positions, manualNodeIds: layout.manualNodeIds, routes: layout.routes });
      if (action === 'reset') layout.manualNodeIds = [];
      Object.assign(layout.positions, positions);
      layout.routes = routes;
    } else if (action === 'move') {
      Object.assign(layout.positions, positions);
      layout.manualNodeIds = [...new Set([...layout.manualNodeIds, ...Object.keys(positions)])];
      layout.routes = {};
      // Rebase the one-step undo snapshot on later manual work. Undoing the
      // arrangement must never undo a drag performed after that arrangement.
      if (layout.previous) {
        Object.assign(layout.previous.positions, positions);
        layout.previous.manualNodeIds = [...new Set([...layout.previous.manualNodeIds, ...Object.keys(positions)])];
        layout.previous.routes = {};
      }
    } else if (action === 'release') {
      layout.manualNodeIds = layout.manualNodeIds.filter(id => !released.has(id));
      if (layout.previous) layout.previous.manualNodeIds = layout.previous.manualNodeIds.filter(id => !released.has(id));
    } else if (action === 'undo') {
      if (!layout.previous) throw new WorkbenchError('当前分组没有可撤销的布局整理。', 409);
      layout.positions = filterPositions(layout.previous.positions);
      layout.manualNodeIds = layout.previous.manualNodeIds.filter(id => nodeIds.has(id));
      // Route validity also depends on model text and measured geometry. Let
      // the renderer recompute it after undo instead of reviving old bends.
      layout.routes = {};
      delete layout.previous;
      // Restoring manual badges may change the measured card height. Adopt that
      // measurement without undoing the user's explicit position restoration.
      if (layout.inputKey || input.inputKey) layout.needsMeasurement = state.modelHash;
    }
    if (input.inputKey !== undefined) layout.inputKey = input.inputKey;
    if (automatic || action === 'measure') delete layout.needsMeasurement;
    layout.revision = revision + 1;
    layouts[scopeId] = layout;
    state.view[layoutKey] = layouts;
  }

  function migrateLegacyView() {
    const current = load();
    if (object(current.view?.positions) && object(current.view.layouts) && Array.isArray(current.view.manualNodeIds)) return;
    transaction('view-migration', {}, state => {
      if (object(state.view?.positions) && object(state.view.layouts) && Array.isArray(state.view.manualNodeIds)) return { unchanged: true };
      state.view ||= {};
      state.view.positions ||= {};
      const known = new Set(state.model.nodes.map(node => node.id));
      const manual = new Set((state.view.manualNodeIds || []).filter(id => known.has(id) && !unsafeLayoutKeys.has(id)));
      for (const name of fs.readdirSync(transactionRoot).filter(name => idPattern.test(name))) {
        const directory = path.join(transactionRoot, name);
        if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) throw new WorkbenchError('事务目录无效。');
        const metaFile = path.join(directory, 'transaction.json');
        if (!fs.existsSync(metaFile) || !fs.existsSync(path.join(directory, 'receipt.json'))) continue;
        const meta = readJson(metaFile);
        if (meta.operation !== 'view' || meta.afterRevision > state.stateRevision) continue;
        const before = readJson(path.join(directory, 'before.json'));
        const after = readJson(path.join(directory, 'after.json'));
        if (!object(after.view?.positions)) continue;
        const beforePositions = object(before.view?.positions) ? before.view.positions : {};
        const changes = Object.entries(after.view.positions).filter(([id, point]) => known.has(id) &&
          !unsafeLayoutKeys.has(id) && object(point) && Number.isFinite(point.x) && Number.isFinite(point.y) &&
          (beforePositions[id]?.x !== point.x || beforePositions[id]?.y !== point.y));
        // A full coordinate import/replacement is a baseline, not evidence
        // that every node was manually pinned. Use the historical model here:
        // later node additions must not turn an old import into manual work.
        const historicalNodes = after.model?.nodes || [];
        const fullReplacement = historicalNodes.length > 0 && historicalNodes.every(node => {
          const point = after.view.positions[node.id], previous = beforePositions[node.id];
          return object(point) && Number.isFinite(point.x) && Number.isFinite(point.y) &&
            (previous?.x !== point.x || previous?.y !== point.y);
        });
        if (fullReplacement) continue;
        for (const [id] of changes) manual.add(id);
      }
      state.view.manualNodeIds = [...manual];
      state.view.layouts ||= {};
    });
  }

  function createRequest(payload) {
    if (!object(payload)) throw new WorkbenchError('问题格式无效。');
    const id = requireId(payload.requestId || crypto.randomUUID(), '请求编号');
    const content = text(payload.text, '问题或修改意见');
    const state = transaction('request', { ...payload, requestId: id }, (state, before) => {
      const targets = targetsFor(before, payload.targets || []);
      const selectedNodes = new Set();
      for (const target of targets) {
        if (target.type === 'node') selectedNodes.add(target.id);
        if (target.type === 'relation') {
          const relation = before.model.relations.find(edge => edge.id === target.id);
          selectedNodes.add(relation.from); selectedNodes.add(relation.to);
        }
      }
      const reference = { taskDirectory: taskRoot, taskId: before.taskId, requestId: id, workRevision: before.workRevision, modelHash: before.modelHash };
      const request = {
        id, text: content, targets, selection: payload.selection ? clone(payload.selection) : null,
        status: 'saved', createdAt: now(), workRevision: before.workRevision, modelHash: before.modelHash,
        context: selectedNodes.size === 1 ? contextFrom(before, [...selectedNodes][0]) : contextFrom(before),
        targetObjects: targets.map(target => clone(before.model[collections[target.type]].find(item => item.id === target.id))),
        handoff: `${before.model.report.title} · ${targets.map(target => target.label).join('、') || '整个流程'}\n${content}\nprocess-review-draft-batch:v1 ${JSON.stringify(reference)}`,
      };
      atomicJson(path.join(safeDirectory(path.join(requestRoot, id)), 'request.json'), request);
      state.requests.unshift(request);
    });
    return clone(state.requests.find(request => request.id === id));
  }

  function createReference(payload) {
    if (!object(payload)) throw new WorkbenchError('引用内容格式无效。');
    return withLock(() => {
      recover();
      const state = load();
      base(state, payload);
      if (payload.baseMaterialsHash !== undefined && payload.baseMaterialsHash !== materialSnapshot(state).hash) throw new WorkbenchError('节点原材料绑定已有变化，请重新核对交接。', 409);
      if (payload.baseContentHash !== undefined && payload.baseContentHash !== treeHash(state)) throw new WorkbenchError('节点补充已有新修改，请重新核对交接内容。', 409);
      const targets = targetsFor(state, payload.targets === undefined ? [] : payload.targets);
      if(payload.allNodeMaterials!==undefined&&typeof payload.allNodeMaterials!=='boolean')throw new WorkbenchError('节点材料选择格式无效。');
      const materialNodes=new Set(targets.filter(target=>target.type==='node').map(target=>target.id));
      if(payload.allNodeMaterials&&!materialNodes.size)throw new WorkbenchError('请选择需要整理材料的节点。');
      const contentIds=payload.allNodeMaterials?treeOf(state).entries.filter(entry=>materialNodes.has(entry.nodeId)&&entry.entryType==='note'&&!entry.archived).map(entry=>entry.id):payload.contentEntryIds||[];
      const contentInputs = selectedInputs(state, contentIds, WorkbenchError);
      const targetObjects = targets.map(target => clone(state.model[collections[target.type]].find(item => item.id === target.id)));
      let selection = null;
      let materialSelection=null;
      if(payload.materialSelection){
        const picked=payload.materialSelection,snapshot=materialSnapshot(state,materialNodes);
        const source=snapshot.sources.find(item=>item.id===picked.sourceId&&hash(item.text)===picked.sourceHash);
        const valid=snapshot.bindings.some(binding=>binding.nodeId===picked.nodeId&&binding.sourceId===picked.sourceId&&binding.sourceHash===picked.sourceHash&&Number.isInteger(picked.startLine)&&Number.isInteger(picked.endLine)&&picked.startLine>=binding.startLine&&picked.endLine<=binding.endLine&&picked.endLine>=picked.startLine);
        if(!valid||!source||typeof picked.text!=='string'||!picked.text.trim()||picked.text.length>20000||!source.text.split('\n').slice(picked.startLine-1,picked.endLine).join('\n').includes(picked.text))throw new WorkbenchError('选文与该节点已挂载的原文材料不一致，请重新选择。',409);
        materialSelection={nodeId:picked.nodeId,sourceId:picked.sourceId,sourceHash:picked.sourceHash,startLine:picked.startLine,endLine:picked.endLine,text:picked.text};
      }
      if (payload.selection !== undefined && payload.selection !== null) {
        const selected = payload.selection;
        if (!object(selected) || typeof selected.text !== 'string' || !selected.text.trim() || selected.text.length > 20000) {
          throw new WorkbenchError('选文格式无效，请先保存修改，再从已保存内容中选取原文。');
        }
        requireId(selected.claimId, '选文陈述编号');
        const claim = state.model.claims.find(item => item.id === selected.claimId);
        const belongsToTarget = targets.some((target, index) =>
          (target.type === 'claim' && target.id === selected.claimId) ||
          (['node', 'relation'].includes(target.type) && targetObjects[index].claimIds.includes(selected.claimId)));
        if (!claim || !belongsToTarget || !claim.text.includes(selected.text)) {
          throw new WorkbenchError('选文与所引用的已保存原文不一致，请先保存修改，再重新选择引用。', 409);
        }
        // Preserve the exact selected text; normalizing it would allow an
        // unsaved or otherwise different quote to masquerade as saved content.
        selection = { text: selected.text, claimId: selected.claimId };
      }
      const selectedNodes = new Set();
      for (const input of contentInputs) selectedNodes.add(input.nodeId);
      for (const target of targets) {
        if (target.type === 'node') selectedNodes.add(target.id);
        if (target.type === 'relation') {
          const edge = state.model.relations.find(item => item.id === target.id);
          selectedNodes.add(edge.from); selectedNodes.add(edge.to);
        }
      }
      const context = selectedNodes.size === 1 ? contextFrom(state, [...selectedNodes][0]) : contextFrom(state);
      if(payload.allNodeMaterials)context.model=clone(state.model);
      // An explicit claim may be retained as historical evidence rather than
      // attached to a current node. Include the selected object's own evidence
      // even when the ordinary graph context would not reach it.
      const claimIds = new Set(context.claims.map(item => item.id));
      const claimTable = new Map(state.model.claims.map(item => [item.id, item]));
      const additional = [];
      for (const [index, target] of targets.entries()) {
        if (target.type === 'claim') additional.push(target.id);
        else additional.push(...(targetObjects[index].claimIds || []), ...(targetObjects[index].resolutionClaimIds || []));
      }
      function includeClaim(id) {
        if (claimIds.has(id)) return;
        const claim = claimTable.get(id);
        if (!claim) return;
        claimIds.add(id);
        context.claims.push(clone(claim));
        for (const premiseId of claim.premiseIds || []) includeClaim(premiseId);
      }
      additional.forEach(includeClaim);
      const sourceIds = new Set(context.claims.flatMap(claim => claim.evidence.map(item => item.sourceId)));
      context.sources = clone([...new Map([...state.model.sources.filter(source => sourceIds.has(source.id)), ...context.materials.sources].map(source => [sourceKey(source), source])).values()]);
      const id = crypto.randomUUID();
      const header = { taskDirectory: taskRoot, taskId: state.taskId, referenceId: id,
        workRevision: state.workRevision, modelHash: state.modelHash, contentHash: treeHash(state), materialsHash: context.materials.hash, contentEntryIds: contentInputs.map(e => e.id), targets };
      const saved = { id, taskDirectory: taskRoot, taskId: state.taskId,
        workRevision: state.workRevision, modelHash: state.modelHash, targets, selection, materialSelection, allNodeMaterials:!!payload.allNodeMaterials,
        createdAt: now(), context, targetObjects, contentHash: treeHash(state), materialsHash: context.materials.hash, contentInputs,
        handoff: `${state.model.report.title} · ${targets.map(target => target.label).join('、') || '整个流程'}${selection ? `\n引用原文：${selection.text}` : ''}\nprocess-review-workbench-ref:v1 ${JSON.stringify(header)}`,
      };
      atomicJson(path.join(referenceRoot, `${id}.json`), saved);
      return clone(saved);
    });
  }

  function reference(id) {
    requireId(id, '引用编号');
    const file = path.join(referenceRoot, `${id}.json`);
    if (!fs.existsSync(file)) throw new WorkbenchError('引用快照不存在。', 404);
    let saved;
    try { saved = readJson(file); }
    catch (error) {
      if (error instanceof SyntaxError) throw new WorkbenchError('引用快照格式损坏，原文件已保留。', 422);
      throw error;
    }
    const current = load();
    if (!object(saved) || saved.id !== id || saved.taskId !== current.taskId || saved.taskDirectory !== taskRoot ||
      !Number.isSafeInteger(saved.workRevision) || saved.workRevision < 1 ||
      typeof saved.modelHash !== 'string' || !/^[a-f0-9]{64}$/.test(saved.modelHash) ||
      saved.context?.workRevision !== saved.workRevision || saved.context?.modelHash !== saved.modelHash) {
      throw new WorkbenchError('引用快照与任务或版本记录不一致，原文件已保留。', 422);
    }
    return clone({ ...saved, currentWorkRevision: current.workRevision, currentModelHash: current.modelHash,
      currentContentHash: treeHash(current), currentMaterialsHash: materialSnapshot(current).hash, stale: saved.workRevision !== current.workRevision || saved.modelHash !== current.modelHash || (saved.contentHash !== undefined && saved.contentHash !== treeHash(current)) || (saved.materialsHash !== undefined && saved.materialsHash !== materialSnapshot(current).hash) });
  }

  function writeCandidate(state, { model = state.model, requestId = null, revertsTransactionId, contentInputs = [] } = {}) {
    const candidateId = crypto.randomUUID();
    const directory = safeDirectory(path.join(candidateRoot, candidateId));
    const metadata = { candidateId, taskId: state.taskId, requestId,
      baseWorkRevision: state.workRevision, baseModelHash: state.modelHash, basePreferenceHash: state.preferenceHash, createdAt: now(),
      baseContentHash: treeHash(state), baseMaterialsHash: materialSnapshot(state).hash, contentInputs,
      ...(revertsTransactionId && { revertsTransactionId }),
    };
    const modelFile = path.join(directory, 'model.json'), metaFile = path.join(directory, 'metadata.json');
    atomicJson(modelFile, model);
    atomicJson(path.join(directory, 'base-model.json'), state.model);
    atomicJson(metaFile, metadata);
    const feedbackSources = contentInputs.map(feedbackSource).filter(Boolean);
    const rawMaterialSources = contentInputs.map(rawMaterialSource).filter(Boolean);
    return { ...metadata, modelFile, metaFile, feedbackSources, rawMaterialSources,
      contentInstructions: '完整读取 contentInputs 的原话、稳定节点 ID 和版本。kind=raw 表示用户未分类，不是现行事实认证；不要改写材料的性质。feedbackSources 保留旧版明确事实来源，rawMaterialSources 提供未分类原话的可追溯来源快照；两者均不自动写入候选。user-feedback 只标明用户来源，不代表已核实。根据当次要求及原话含义，按需将正确来源、逐字证据和 claims/coverage 加入候选；建议不能改写成现状，疑问与冲突保留为未知或问题，含混处在现有对话澄清，不依靠自动分类。旧提醒、建议与问题不能直接作为现行事实来源。保持原有未知和冲突；查看差异并确认后应用。' };
  }

  function createCandidate(payload = {}) {
    if (!object(payload)) throw new WorkbenchError('候选请求格式无效。');
    return withLock(() => {
      recover();
      const state = load();
      if (payload.requestId && !state.requests.some(request => request.id === payload.requestId)) throw new WorkbenchError('问题请求不存在。', 404);
      let ids = payload.contentEntryIds || [];
      if (payload.referenceId) {
        const saved = reference(payload.referenceId);
        if (saved.stale) throw new WorkbenchError('交接引用已过期，请读取最新节点及补充后重新交接。', 409);
        ids = saved.contentInputs?.map(e => e.id) || [];
      }
      const contentInputs = selectedInputs(state, ids, WorkbenchError);
      return writeCandidate(state, { requestId: payload.requestId || null, contentInputs });
    });
  }

  function createRevertCandidate(payload) {
    if (!object(payload)) throw new WorkbenchError('反向候选请求格式无效。');
    const transactionId = requireId(payload.transactionId, '事务编号');
    return withLock(() => {
      recover();
      const state = load();
      if (!state.changes.some(change => change.id === transactionId && change.kind === 'candidate')) {
        throw new WorkbenchError('找不到已应用的 Agent 候选事务。', 404);
      }
      const directory = safeDirectory(path.join(transactionRoot, transactionId));
      const metadata = readJson(path.join(directory, 'transaction.json'));
      const before = readJson(path.join(directory, 'before.json'));
      const applied = readJson(path.join(directory, 'after.json'));
      if (metadata.id !== transactionId || metadata.operation !== 'candidate' || metadata.contentChanged !== true ||
        before.taskId !== state.taskId || applied.taskId !== state.taskId || hash(before) !== metadata.beforeHash || hash(applied) !== metadata.afterHash) {
        throw new WorkbenchError('事务记录与当前任务或保存时的摘要不一致，请先核对。', 409);
      }
      const { model, conflicts } = reverseCandidate(before.model, applied.model, state.model);
      if (conflicts.length) {
        throw new WorkbenchError('后续修改与要撤回的内容重叠。请先核对冲突，再从当前工作稿起草反向候选。', 409, { conflicts });
      }
      if (hash(model) === state.modelHash) throw new WorkbenchError('这次事务的修改已撤回，没有新的内容变化。', 409);
      try { assertModel(model); }
      catch (error) {
        if (!(error instanceof WorkbenchError)) throw error;
        throw new WorkbenchError('撤回会影响后续内容引用。请先核对依赖，再从当前工作稿起草反向候选。', 409, error.details);
      }
      return writeCandidate(state, { model, revertsTransactionId: transactionId });
    });
  }

  function candidateSnapshot(state, candidateId) {
    const directory = path.join(candidateRoot, candidateId);
    if (!fs.existsSync(directory)) throw new WorkbenchError('候选不存在。', 404);
    if (!fs.lstatSync(directory).isDirectory()) throw new WorkbenchError('候选目录必须是普通目录。');
    const metadata = readJson(path.join(directory, 'metadata.json'));
    const original = readJson(path.join(directory, 'base-model.json'));
    if (!object(metadata) || metadata.candidateId !== candidateId || metadata.taskId !== state.taskId ||
      metadata.taskId !== original?.report?.id || hash(original) !== metadata.baseModelHash) {
      throw new WorkbenchError('候选的工具基线记录已改变，请保留修改并重新创建候选。', 409);
    }
    base(state, metadata);
    let model;
    try { model = readJson(path.join(directory, 'model.json')); }
    catch (error) {
      if (error instanceof SyntaxError) throw new WorkbenchError('候选模型尚不是完整 JSON，已保留候选和当前工作稿。', 422);
      throw error;
    }
    assertModel(model);
    validateCandidateInputs(state, metadata, model, WorkbenchError);
    if (metadata.baseMaterialsHash !== undefined && metadata.baseMaterialsHash !== materialSnapshot(state).hash) throw new WorkbenchError('节点原材料绑定已改变，请重新起草和核对候选。', 409);
    const savedBindings = validateArchive(readJson(materialFile), WorkbenchError).bindings.flatMap(entry=>[entry,...(entry.revisions||[])]);
    for (const source of model.sources.filter(isMaterialSource)) if (savedBindings.some(binding => binding.sourceId === source.id && binding.sourceHash !== hash(source.text))) throw new WorkbenchError('候选不能改写历史挂载的原始来源。', 422);
    if (model.report.id !== state.taskId) throw new WorkbenchError('候选属于其他任务。');
    if (model.report.version !== state.model.report.version) throw new WorkbenchError('工作稿应用不能改写正式版本号。');
    const sources = new Map(model.sources.map(source => [source.id, source]));
    for (const existing of state.model.sources) {
      if (JSON.stringify(sources.get(existing.id)) !== JSON.stringify(existing)) {
        throw new WorkbenchError('候选不能删除或修改已经保存的原始来源。', 422);
      }
    }
    const { taskId, baseWorkRevision, baseModelHash, basePreferenceHash, baseContentHash, baseMaterialsHash, contentInputs, requestId, revertsTransactionId } = metadata;
    const identity = { candidateId, taskId, baseWorkRevision, baseModelHash, basePreferenceHash, baseContentHash, baseMaterialsHash, contentInputs, requestId, revertsTransactionId };
    return { metadata, model, identity, reviewHash: hash({ ...identity, model }) };
  }

  function reviewCandidate(value) {
    const candidateId = requireId(value, '候选编号');
    const state = load();
    const { model, identity, reviewHash } = candidateSnapshot(state, candidateId);
    const { items, nodeIds } = differences(state.model, model);
    const description = describeCandidate(state.model, model, nodeIds);
    return { ...identity, reviewHash, items, nodeIds, ...description, canApply: description.changes.length > 0 };
  }

  function applyCandidate(payload) {
    if (!object(payload)) throw new WorkbenchError('候选应用格式无效。');
    const candidateId = requireId(payload.candidateId, '候选编号');
    const { reviewHash } = payload;
    if (typeof reviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(reviewHash)) {
      throw new WorkbenchError('请先查看候选差异，取得用户应用确认后再提供该候选的确认摘要。', 409);
    }
    const summary = payload.summary ? text(payload.summary, '修改说明', { maximum: 1000 }) : undefined;
    return transaction('candidate', { requestId: candidateId, reviewHash, summary }, (state, before) => {
      const snapshot = candidateSnapshot(before, candidateId);
      if (reviewHash !== snapshot.reviewHash) {
        throw new WorkbenchError('候选内容与已查看的差异不一致，请重新查看并确认。', 409);
      }
      const { metadata, model } = snapshot;
      if (hash({ ...model, review: before.model.review }) === before.modelHash) return { unchanged: true };
      resetReview(model);
      state.model = model;
      const request = metadata.requestId ? state.requests.find(request => request.id === metadata.requestId) : null;
      if (request) { request.status = 'applied'; request.appliedWorkRevision = before.workRevision + 1; }
      state.lastSave = { kind: 'applied', message: '已应用经确认的 Agent 候选。' };
      const action = metadata.revertsTransactionId ? 'Agent 应用反向修订' : 'Agent 更新流程草稿';
      return { actor: 'agent', summary: summary ?? action };
    });
  }

  function saveResult(payload) {
    if (!object(payload)) throw new WorkbenchError('回答格式无效。');
    const requestId = requireId(payload.requestId, '问题编号');
    const content = text(payload.text, '回答');
    const updated = transaction('result', { ...payload, requestId: payload.operationId || crypto.randomUUID() }, (state, before) => {
      const request = state.requests.find(request => request.id === requestId);
      if (!request) throw new WorkbenchError('问题请求不存在。', 404);
      const result = { text: content, targets: targetsFor(before, payload.targets || []), actor: 'agent', createdAt: now() };
      request.results = [...(request.results || []), result];
      request.result = result;
      if (request.status !== 'applied') request.status = 'answered';
    });
    return clone(updated.requests.find(request => request.id === requestId));
  }

  migrateLegacyView();
  function contentEdit(payload) {
    return transaction('content', payload, (state, before) => {
      const result = mutateTree(state, payload, WorkbenchError);
      if (!result) return { unchanged: true };
      state.lastSave = { kind: 'content', message: '节点补充已保存，现行流程未自动改变。' };
      return result;
    });
  }
  function materialEdit(payload){
    return transaction('materials',payload,(state,before)=>{
      if(payload.baseMaterialsHash!==materialSnapshot(before).hash)throw new WorkbenchError('节点材料已有更新。输入仍保留，请核对最新材料后重试。',409);
      const archive=upgradeArchive(validateArchive(readJson(materialFile),WorkbenchError));
      materialSnapshot(before); // Populate historical source versions without copying text into the sidecar.
      const result=mutateMaterials(archive,payload,before,[...materialSources.values()],WorkbenchError);
      if(result.unchanged)return{unchanged:true};
      state.lastSave={kind:'materials',message:'节点材料已保存，当前整理结果未自动改变。'};
      return{materials:archive};
    });
  }
  return {
    read: () => clone(load()), materials: () => materialSnapshot(load()), materialEdit, contentEdit, edit, previewStructureEdit, structureEdit, undo, saveBuffer, buffers, updateView, createRequest, createReference, reference,
    context: nodeId => contextFrom(load(), nodeId), createCandidate, reviewCandidate, applyCandidate, createRevertCandidate, saveResult,
  };
}

module.exports = { createStore, WorkbenchError };
