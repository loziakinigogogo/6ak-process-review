'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { digest } = require('./index-sources.cjs');
const { ReviewError, pending, publish, validateCandidate } = require('./grouped-review-store.cjs');

const OWNER = 'document-review-draft';
const FILES = ['manifest.json', 'model.json', 'outcomes.json'];
const SNAPSHOT_FILES = ['model.json', 'review.json', 'state.json'];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const normalized = text => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
const comparablePath = file => process.platform === 'win32' ? file.toLowerCase() : file;

function fail(message, status = 400) { throw new ReviewError(message, status); }

function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function taskRoot(task) {
  const root = path.resolve(task);
  const info = stat(root);
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('任务目录必须是已有的普通目录，不能是符号链接。');
  if (root === path.parse(root).root || comparablePath(fs.realpathSync(root)) !== comparablePath(root)) {
    fail('任务路径不能是文件系统根目录，也不能经过符号链接。');
  }
  return root;
}

function within(root, ...parts) {
  const file = path.resolve(root, ...parts);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    fail('草稿路径越过任务目录边界。');
  }
  // Refuse symlinks/junctions at every existing component, including the leaf.
  let cursor = root;
  const segments = relative.split(path.sep);
  for (let index = 0; index < segments.length; index++) {
    cursor = path.join(cursor, segments[index]);
    const info = stat(cursor);
    if (info?.isSymbolicLink()) fail('任务路径包含符号链接，未读取、写入或删除：' + cursor);
    if (info && index < segments.length - 1 && !info.isDirectory()) fail('任务路径中的父级不是目录：' + cursor);
  }
  return file;
}

function readFile(root, ...parts) {
  const file = within(root, ...parts);
  if (!stat(file)?.isFile()) fail('缺少普通文件：' + file);
  const raw = fs.readFileSync(file, 'utf8');
  return { file, raw, sha256: digest(raw), value: JSON.parse(raw.replace(/^\uFEFF/, '')) };
}

function snapshot(root, requested) {
  const directory = within(root, 'revisions');
  if (!stat(directory)?.isDirectory()) fail('任务尚无已发布版本。');
  const revisions = fs.readdirSync(directory).filter(name => /^[1-9]\d*$/.test(name));
  for (const name of revisions) {
    if (!stat(within(root, 'revisions', name))?.isDirectory()) fail('版本路径必须是普通目录。');
  }
  const revision = requested ?? Math.max(0, ...revisions.map(Number));
  if (!Number.isSafeInteger(revision) || revision < 1) fail('任务尚无已发布版本。');
  const files = Object.fromEntries(SNAPSHOT_FILES.map(name => [name, readFile(root, 'revisions', String(revision), name)]));
  return {
    revision, directory: within(root, 'revisions', String(revision)),
    model: files['model.json'].value, review: files['review.json'].value, state: files['state.json'].value,
    hashes: Object.fromEntries(SNAPSHOT_FILES.map(name => [name, files[name].sha256])),
  };
}

function checkBatchPaths(root) {
  const directory = within(root, 'batches');
  if (!stat(directory)) return;
  if (!stat(directory).isDirectory()) fail('批注路径必须是普通目录。');
  for (const name of fs.readdirSync(directory).filter(name => UUID.test(name))) {
    readFile(root, 'batches', name, 'batch.json');
  }
}

function inspectDraft(root) {
  const directory = within(root, 'draft');
  if (!stat(directory)) return null;
  if (!stat(directory).isDirectory()) fail('draft 必须是工具管理的普通目录。');
  const names = fs.readdirSync(directory);
  for (const name of names) {
    if (!FILES.includes(name)) fail('草稿含有未知文件，已保留全部内容，请先移出：' + name);
    if (!stat(within(root, 'draft', name))?.isFile()) fail('草稿只允许普通文件：' + name);
  }
  return { directory, names };
}

function manifestAt(root) {
  const inspected = inspectDraft(root);
  if (!inspected) return null;
  const saved = readFile(root, 'draft', 'manifest.json');
  const manifest = saved.value;
  if (!object(manifest) || manifest.owner !== OWNER || manifest.schemaVersion !== 1 || !UUID.test(manifest.transactionId) ||
      typeof manifest.projectId !== 'string' || !manifest.projectId || !Number.isSafeInteger(manifest.baseRevision) || manifest.baseRevision < 1 ||
      !object(manifest.baseline) || Object.keys(manifest.baseline).length !== SNAPSHOT_FILES.length ||
      SNAPSHOT_FILES.some(file => !SHA.test(manifest.baseline[file])) || !Array.isArray(manifest.comments) ||
      typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt))) {
    fail('草稿 manifest 无效；它由工具维护，请勿手工修改。');
  }
  if (manifest.batch !== null && (!object(manifest.batch) || !UUID.test(manifest.batch.id) ||
      !Number.isSafeInteger(manifest.batch.revision) || manifest.batch.revision < 1 || !SHA.test(manifest.batch.sha256))) {
    fail('草稿批次绑定无效。');
  }
  const ids = new Set();
  for (const entry of manifest.comments) {
    if (!object(entry) || !UUID.test(entry.id) || ids.has(entry.id) || !SHA.test(entry.sha256) ||
        !(entry.sourceId === null || entry.sourceId === `feedback-${manifest.batch?.id}-${entry.id}`)) fail('草稿批注绑定无效。');
    ids.add(entry.id);
  }
  if ((!manifest.batch && manifest.comments.length) || (manifest.batch && !manifest.comments.length)) fail('草稿批次与批注清单不一致。');
  return { ...inspected, manifest, manifestSha256: saved.sha256 };
}

function sourceFor(batchId, comment) {
  const text = normalized(comment.text);
  if (!text.trim()) return null;
  return {
    id: `feedback-${batchId}-${comment.id}`,
    name: `批次 ${batchId} · 批注 ${comment.id}`,
    kind: 'user-feedback', text, sha256: digest(text),
  };
}

function verifyBinding(root, manifest) {
  const base = snapshot(root, manifest.baseRevision);
  if (!equal(base.hashes, manifest.baseline) || base.model.report.id !== manifest.projectId) {
    fail('草稿基线内容摘要已变化，请保留草稿并核对原版本；不能覆盖发布。', 409);
  }
  const sources = [];
  if (manifest.batch) {
    const saved = readFile(root, 'batches', manifest.batch.id, 'batch.json');
    const batch = saved.value;
    if (saved.sha256 !== manifest.batch.sha256 || batch.id !== manifest.batch.id || batch.revision !== manifest.batch.revision ||
        batch.projectId !== manifest.projectId || batch.revision > manifest.baseRevision) fail('已保存批注或批次绑定发生变化。', 409);
    const outcomes = new Map(base.state.outcomes.map(entry => [entry.commentId, entry]));
    const expected = batch.comments.filter(comment => !outcomes.has(comment.id) || outcomes.get(comment.id).status === 'needs-clarification');
    if (!equal(expected.map(comment => comment.id), manifest.comments.map(comment => comment.id))) fail('草稿必须绑定该批次全部待处理批注。');
    expected.forEach((comment, index) => {
      const entry = manifest.comments[index];
      const source = sourceFor(batch.id, comment);
      if (entry.sha256 !== digest(JSON.stringify(comment)) || entry.sourceId !== (source?.id ?? null)) fail('草稿批注原话或来源绑定已变化。');
      if (source) sources.push(source);
    });
  }
  return { base, sources };
}

function draftInfo(root, manifest) {
  return {
    directory: within(root, 'draft'), modelFile: within(root, 'draft', 'model.json'),
    outcomesFile: within(root, 'draft', 'outcomes.json'), baseRevision: manifest.baseRevision,
    batchId: manifest.batch?.id ?? null, transactionId: manifest.transactionId,
    feedbackSources: manifest.comments.filter(comment => comment.sourceId).map(comment => ({ commentId: comment.id, sourceId: comment.sourceId })),
  };
}

function validReceipt(state) {
  return UUID.test(state.transactionId) && object(state.transactionFiles) && FILES.every(name => SHA.test(state.transactionFiles[name]));
}

function transactionFor(root, manifest) {
  const directory = within(root, 'revisions', String(manifest.baseRevision + 1));
  if (!stat(directory)) return null;
  const published = snapshot(root, manifest.baseRevision + 1);
  if (published.state.transactionId !== manifest.transactionId) return null;
  if (!validReceipt(published.state)) fail('已发布事务的恢复摘要不完整，已保留草稿。');
  return published;
}

function emptyCommittedDraft(root) {
  const active = inspectDraft(root);
  if (!active || active.names.length) return null;
  const current = snapshot(root);
  return validReceipt(current.state) ? current : null;
}

function beginDraft(task, options = {}) {
  const root = taskRoot(task);
  const batchId = typeof options === 'string' ? options : options?.batchId;
  if (batchId !== undefined && batchId !== null && !UUID.test(batchId)) fail('批次编号需要是已保存的 UUID。');
  const active = manifestAt(root);
  if (active) {
    if ((active.manifest.batch?.id ?? null) !== (batchId ?? null)) fail('已有其他批次的草稿，不能覆盖；请先提交或放弃该草稿。', 409);
    return { status: transactionFor(root, active.manifest) ? 'committed-cleanup-pending' : 'resumed', ...draftInfo(root, active.manifest) };
  }
  checkBatchPaths(root);
  const current = snapshot(root);
  // Validate the starting snapshot through the same read-only publication gate.
  validateCandidate(root, current.revision, current.model, current.review, []);
  let batch = null, selected = [], savedComments = new Map();
  if (batchId) {
    const saved = readFile(root, 'batches', batchId, 'batch.json');
    if (saved.value.id !== batchId || saved.value.projectId !== current.model.report.id) fail('批次不属于当前任务。');
    // Validate its historical snapshot before resolving old references.
    snapshot(root, saved.value.revision);
    const resolved = pending(root, { batchId, projectId: current.model.report.id, revision: saved.value.revision });
    selected = resolved.batches.find(entry => entry.id === batchId)?.comments || [];
    if (!selected.length) return { status: 'already-processed', batchId, revision: current.revision, outcomes: resolved.requestedBatch.outcomes };
    batch = { id: batchId, revision: saved.value.revision, sha256: saved.sha256 };
    savedComments = new Map(saved.value.comments.map(comment => [comment.id, comment]));
  }
  const model = structuredClone(current.model);
  const sources = new Map(model.sources.map(source => [source.id, source]));
  const comments = selected.map(comment => {
    const savedComment = savedComments.get(comment.id);
    const source = sourceFor(batchId, savedComment);
    if (source) {
      if (sources.has(source.id) && !equal(sources.get(source.id), source)) fail('批注来源编号已被其他内容占用：' + source.id);
      if (!sources.has(source.id)) model.sources.push(source);
    }
    return { id: comment.id, sha256: digest(JSON.stringify(savedComment)), sourceId: source?.id ?? null };
  });
  for (const mode of ['semantic', 'visual']) model.review[mode] = {
    status: 'not_run', reviewer: '', notes: ['本次草稿尚未完成相应复核；旧版检查记录保留在原版本中。'],
  };
  const manifest = {
    owner: OWNER, schemaVersion: 1, transactionId: randomUUID(), projectId: current.model.report.id,
    baseRevision: current.revision, baseline: current.hashes, batch, comments, createdAt: new Date().toISOString(),
  };
  const outcomes = selected.map(comment => ({
    batchId, commentId: comment.id, status: '', summary: '', groupIds: comment.currentGroupId ? [comment.currentGroupId] : [],
    changeTargets: [], noChangeReason: '',
  }));
  const directory = within(root, 'draft');
  try { fs.mkdirSync(directory); }
  catch (error) { if (error.code === 'EEXIST') fail('另一个草稿已创建，未覆盖。', 409); throw error; }
  // Write ownership first. An interrupted creation remains recoverable by abort;
  // never silently replace a user's partially edited model on resume.
  for (const [name, value] of [['manifest.json', manifest], ['model.json', model], ['outcomes.json', outcomes]]) {
    fs.writeFileSync(within(root, 'draft', name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  }
  return { status: 'created', ...draftInfo(root, manifest), comments: selected };
}

function diffObjects(before, after) {
  const objects = [];
  for (const collection of ['claims', 'groups', 'nodes', 'relations', 'rules', 'issues']) {
    const old = new Map((before[collection] || []).map(entry => [entry.id, entry]));
    const next = new Map((after[collection] || []).filter(object).map(entry => [entry.id, entry]));
    for (const [id, value] of next) {
      if (!old.has(id)) objects.push({ collection, id, kind: 'added' });
      else if (!equal(old.get(id), value)) objects.push({ collection, id, kind: 'changed' });
    }
    for (const id of old.keys()) if (!next.has(id)) objects.push({ collection, id, kind: 'removed' });
    const oldOrder = [...old.keys()].filter(id => next.has(id));
    const newOrder = [...next.keys()].filter(id => old.has(id));
    if (!equal(oldOrder, newOrder)) objects.push({ collection, kind: 'reordered', ids: newOrder });
  }
  const oldSources = new Map((before.sources || []).map(entry => [entry.id, entry]));
  const newSources = new Map((Array.isArray(after.sources) ? after.sources : []).filter(object).map(entry => [entry.id, entry]));
  const sources = [];
  for (const [id, value] of newSources) {
    const original = oldSources.get(id);
    if (!original || !equal(original, value)) sources.push({
      id, kind: original ? 'changed' : 'added', beforeSha256: original?.sha256 ?? null, afterSha256: value.sha256,
    });
  }
  for (const [id, value] of oldSources) if (!newSources.has(id)) sources.push({ id, kind: 'removed', beforeSha256: value.sha256, afterSha256: null });
  const metadata = ['schemaVersion', 'report', 'review', 'coverage'].filter(key => !equal(before[key], after[key]));
  return { objects, sources, metadata };
}

function assess(root) {
  const active = manifestAt(root);
  if (!active) fail('没有活跃草稿，请先创建草稿。');
  const { manifest } = active;
  const { base, sources } = verifyBinding(root, manifest);
  const current = snapshot(root);
  if (current.revision !== manifest.baseRevision || !equal(current.hashes, manifest.baseline)) fail('草稿基线已过期，请先保留修改并重新创建草稿。', 409);
  checkBatchPaths(root);
  const modelFile = readFile(root, 'draft', 'model.json');
  const outcomesFile = readFile(root, 'draft', 'outcomes.json');
  const model = modelFile.value;
  const outcomes = outcomesFile.value;
  const errors = [], warnings = ['这里只校验数据和引用一致性，不代表业务语义已复核通过。'];
  const nextSources = new Map((Array.isArray(model?.sources) ? model.sources : []).filter(object).map(source => [source.id, source]));
  for (const source of base.model.sources) {
    if (!nextSources.has(source.id)) errors.push('不可删除已有来源：' + source.id);
    else if ((manifest.batch || source.kind === 'user-feedback') && !equal(nextSources.get(source.id), source)) errors.push('不可改写已保存的原始来源：' + source.id);
  }
  for (const source of sources) if (!equal(nextSources.get(source.id), source)) errors.push('自动提取的批注原话来源缺失或被修改：' + source.id);
  const expected = manifest.comments.map(comment => comment.id);
  const supplied = Array.isArray(outcomes) ? outcomes : [];
  const provided = supplied.filter(object).map(outcome => outcome.commentId);
  const missing = expected.filter(id => !provided.includes(id));
  const unexpected = supplied.filter(outcome => !object(outcome) || outcome.batchId !== manifest.batch?.id || !expected.includes(outcome.commentId))
    .map(outcome => object(outcome) ? outcome.commentId ?? null : null);
  if (missing.length) errors.push('尚未为全部选中批注填写处理结果：' + missing.join(', '));
  if (unexpected.length) errors.push('处理结果混入了草稿未绑定的批注或批次。');
  if (!Array.isArray(outcomes)) errors.push('outcomes.json 必须是处理结果数组。');
  for (const outcome of supplied.filter(object)) {
    if (outcome.status === 'applied' && !outcome.changeTargets?.length &&
        (typeof outcome.noChangeReason !== 'string' || !outcome.noChangeReason.trim())) {
      errors.push('已落实批注需要填写明确的 changeTargets 修改落点；若本次无需改动，请填写 noChangeReason：' + outcome.commentId);
    }
  }
  let candidate;
  try { candidate = validateCandidate(root, manifest.baseRevision, model, base.review, outcomes); }
  catch (error) { errors.push(error.message); }
  if (candidate?.warnings) warnings.push(...candidate.warnings);
  let changes = { objects: [], sources: [], metadata: [] };
  try { if (object(model)) changes = diffObjects(base.model, model); }
  catch { /* Invalid structures are reported by the shared model validator. */ }
  return {
    report: { ok: errors.length === 0, ...draftInfo(root, manifest), errors, warnings, changes,
      outcomes: { expected, provided, missing, unexpected } },
    manifest, model, outcomes, base,
    transactionFiles: { 'manifest.json': active.manifestSha256, 'model.json': modelFile.sha256, 'outcomes.json': outcomesFile.sha256 },
  };
}

function checkDraft(task) {
  try { return assess(taskRoot(task)).report; }
  catch (error) { return { ok: false, errors: [error.message], warnings: ['这里只校验数据和引用一致性，不代表业务语义已复核通过。'] }; }
}

function cleanup(root, transactionFiles) {
  const active = inspectDraft(root);
  if (!active) return;
  // Validate everything before unlinking anything. On retry, refuse to discard
  // edits made after the transaction was published, including partial cleanup.
  if (transactionFiles) for (const name of active.names) {
    if (readFile(root, 'draft', name).sha256 !== transactionFiles[name]) fail('已发布后草稿文件又有修改，已保留，请核对：' + name, 409);
  }
  for (const name of ['model.json', 'outcomes.json', 'manifest.json']) {
    const file = within(root, 'draft', name);
    if (stat(file)) fs.unlinkSync(file);
  }
  fs.rmdirSync(within(root, 'draft'));
}

function finishCommit(root, published, replayed) {
  const result = {
    status: replayed ? 'already-committed' : 'committed', revision: published.revision,
    directory: published.directory, transactionId: published.state.transactionId,
  };
  try { cleanup(root, published.state.transactionFiles); }
  catch (error) { return { ...result, cleanupPending: true, warning: '版本已发布，草稿清理未完成：' + error.message }; }
  return result;
}

function commitDraft(task) {
  const root = taskRoot(task);
  const empty = emptyCommittedDraft(root);
  if (empty) return finishCommit(root, empty, true);
  const active = manifestAt(root);
  if (!active) {
    const current = snapshot(root);
    if (validReceipt(current.state)) return {
      status: 'already-committed', revision: current.revision, directory: current.directory, transactionId: current.state.transactionId,
    };
    fail('没有活跃草稿，请先创建草稿。');
  }
  const previous = transactionFor(root, active.manifest);
  if (previous) return finishCommit(root, previous, true);
  const checked = assess(root);
  if (!checked.report.ok) fail('草稿检查未通过：\n' + checked.report.errors.join('\n'));
  const transactionFiles = checked.transactionFiles;
  for (const name of FILES) if (readFile(root, 'draft', name).sha256 !== transactionFiles[name]) fail('检查期间草稿文件有变化，未发布，请重新检查。', 409);
  // Recheck the exact base immediately before the synchronous atomic publish.
  const latest = snapshot(root);
  if (latest.revision !== checked.manifest.baseRevision || !equal(latest.hashes, checked.manifest.baseline)) fail('草稿基线已变化，未发布。', 409);
  try {
    publish(root, checked.manifest.baseRevision, checked.model, checked.base.review, checked.outcomes, {
      transactionId: checked.manifest.transactionId, transactionFiles,
    });
  } catch (error) {
    const concurrent = transactionFor(root, checked.manifest);
    if (concurrent) return finishCommit(root, concurrent, true);
    throw error;
  }
  return finishCommit(root, snapshot(root, checked.manifest.baseRevision + 1), false);
}

function abortDraft(task) {
  const root = taskRoot(task);
  const empty = emptyCommittedDraft(root);
  if (empty) return finishCommit(root, empty, true);
  const active = manifestAt(root);
  if (!active) return { status: 'none' };
  const committed = transactionFor(root, active.manifest);
  if (committed) return finishCommit(root, committed, true);
  const { transactionId } = active.manifest;
  cleanup(root);
  return { status: 'aborted', transactionId };
}

function draftStatus(task) {
  const root = taskRoot(task);
  const empty = emptyCommittedDraft(root);
  if (empty) return { status: 'committed-cleanup-pending', exists: true, directory: within(root, 'draft'),
    currentRevision: empty.revision, transactionId: empty.state.transactionId, stale: false };
  const active = manifestAt(root);
  if (!active) return { status: 'none', exists: false };
  const committed = transactionFor(root, active.manifest);
  const current = snapshot(root);
  const stale = current.revision !== active.manifest.baseRevision || !equal(current.hashes, active.manifest.baseline);
  return {
    status: committed ? 'committed-cleanup-pending' : active.names.length !== FILES.length ? 'incomplete' : stale ? 'stale' : 'active',
    exists: true, ...draftInfo(root, active.manifest), currentRevision: current.revision, stale,
  };
}

module.exports = { beginDraft, checkDraft, commitDraft, abortDraft, draftStatus };
