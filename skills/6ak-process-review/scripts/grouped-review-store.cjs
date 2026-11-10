'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { digest } = require('./index-sources.cjs');
const { renderFlow } = require('./export-flow.cjs');
const { resolveTarget } = require('./resolve-reference.cjs');
const { buildProcessGroups } = require('./process-review-view.cjs');
const { buildReviewChanges, resolveOutcomeChanges, buildChangeLocations } = require('./review-changes.cjs');

const objectId = /^[A-Za-z0-9_-]+$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const tags = ['split', 'rewrite', 'incorrect', 'supplement', 'unknown'];
const statuses = ['applied', 'needs-clarification', 'left-open'];
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && objectId.test(value);
const isUuid = value => typeof value === 'string' && uuid.test(value);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

class ReviewError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function projectView(model, review) {
  const processLayout = review?.layout === 'process';
  const groups = processLayout ? buildProcessGroups(model) : review?.groups;
  if (!Array.isArray(groups) || !groups.length) throw new ReviewError('审阅稿至少需要一个内容组。');
  const targetTypes = processLayout ? ['node', 'relation', 'claim', 'issue'] : ['claim', 'issue'];
  const sources = new Map(model.sources.map(source => [source.id, source]));
  const claims = new Map(model.claims.map(claim => [claim.id, claim]));
  const groupIds = new Set();
  const itemIds = new Set();

  // Keep the stored item fingerprint compatible with existing batches. Compare
  // expanded business dependencies separately when resolving an older reference.
  function contextFingerprint(object, contextObject) {
    const dependencies = new Map();
    function visit(id) {
      if (dependencies.has(id)) return;
      const claim = claims.get(id);
      if (!claim) return;
      dependencies.set(id, claim);
      for (const premise of claim.premiseIds || []) visit(premise);
    }
    if (claims.get(object.id) === object) visit(object.id);
    for (const owner of [object, contextObject].filter(Boolean)) {
      for (const id of [...(owner.claimIds || []), ...(owner.resolutionClaimIds || [])]) visit(id);
    }
    const records = [...dependencies.values()].sort((a, b) => a.id.localeCompare(b.id));
    const sourceIds = [...new Set(records.flatMap(claim => claim.evidence.map(item => item.sourceId)))].sort();
    return digest(JSON.stringify({
      object, contextObject, claims: records,
      sources: sourceIds.map(id => {
        const source = sources.get(id);
        return { id, sha256: source.sha256, kind: source.kind };
      }),
    }));
  }

  function describeClaim(claim) {
    const evidence = claim.evidence.map(({ sourceId, ...range }) => ({
      name: sources.get(sourceId).name,
      ...range,
    }));
    const userEvidence = claim.evidence.filter(range => sources.get(range.sourceId).kind === 'user-feedback').length;
    let origin = claim.origin;
    if (origin === 'explicit' && userEvidence) origin = userEvidence === evidence.length ? 'user-feedback' : 'mixed';
    return { text: claim.text, origin, evidence, rationale: claim.rationale };
  }

  return groups.map(group => {
    if (!isObject(group) || (!processLayout && !isId(group.id)) || groupIds.has(group.id) ||
        typeof group.title !== 'string' || !group.title.trim() || !Array.isArray(group.items) || !group.items.length) {
      throw new ReviewError('审阅内容组需要唯一编号、标题和至少一个条目。');
    }
    groupIds.add(group.id);
    const items = group.items.map(item => {
      if (!isObject(item) || (!processLayout && !isId(item.id)) || itemIds.has(item.id) || !isObject(item.target) ||
          !targetTypes.includes(item.target.type) || !isId(item.target.id)) {
        throw new ReviewError('审阅条目需要唯一编号以及有效的业务引用。');
      }
      itemIds.add(item.id);
      const target = item.target;
      const { object, contextObject } = resolveTarget(model, target);
      const view = { id: item.id, type: target.type, ...(processLayout && item.presentation) };
      let fingerprintContent = { object };
      if (target.type === 'claim') {
        Object.assign(view, describeClaim(object));
        const premises = (object.premiseIds || []).map(id => claims.get(id));
        fingerprintContent = { object, contextObject, premises };
      } else if (target.type === 'issue') {
        const records = object.claimIds.map(id => claims.get(id));
        const resolutions = (object.resolutionClaimIds || []).map(id => claims.get(id));
        Object.assign(view, {
          text: object.question, impact: object.impact, status: object.status, evidence: [],
          records: records.map(describeClaim), resolutions: resolutions.map(describeClaim),
        });
        fingerprintContent = { object, records, resolutions };
      } else {
        view.evidence = [];
      }
      return {
        view, target, fingerprint: digest(JSON.stringify({ target, fingerprintContent, view })),
        contextFingerprint: contextFingerprint(object, contextObject),
      };
    });
    const fingerprint = digest(JSON.stringify([group.title, items.map(item => [item.view.id, item.fingerprint])]));
    return {
      id: group.id, title: group.title, items, fingerprint,
      contextFingerprint: digest(JSON.stringify(items.map(item => [item.view.id, item.contextFingerprint]))),
      unplaced: processLayout ? group.unplaced : undefined,
    };
  });
}

function locations(groups) {
  return new Map(groups.flatMap(group => group.items.map(item => [item.view.id, { group, item }])));
}

function displayItem(view) {
  if (view.status === 'resolved') return view.resolutions.map(resolution => resolution.text).join('\n');
  return view.text;
}

function compareGroups(previous, next) {
  if (!previous) return [];
  const previousGroups = new Map(previous.map(group => [group.id, group]));
  const previousItems = locations(previous);
  const nextGroups = new Map(next.map(group => [group.id, group]));
  const nextItems = locations(next);
  const changes = [];
  for (const group of next) {
    const oldGroup = previousGroups.get(group.id);
    if (!oldGroup || oldGroup.title !== group.title) {
      changes.push({ groupId: group.id, before: oldGroup?.title ?? null, after: group.title });
    }
    for (const item of group.items) {
      const old = previousItems.get(item.view.id);
      const before = old ? displayItem(old.item.view) : null;
      const after = displayItem(item.view);
      if (before !== after) changes.push({ groupId: group.id, itemId: item.view.id, before, after });
      else if (old && (old.item.contextFingerprint !== item.contextFingerprint || old.item.fingerprint !== item.fingerprint)) {
        changes.push({
          kind: 'context', groupId: group.id, itemId: item.view.id, before, after,
          summary: '正文措辞未变，但原文版本、依据位置或所引用业务内容已更新，请重新核对。',
        });
      }
      if (old && old.group.id !== group.id && oldGroup && nextGroups.has(old.group.id)) {
        changes.push({
          kind: 'move', groupId: group.id, itemId: item.view.id, fromGroupId: old.group.id,
          before: old.group.title, after: group.title,
        });
      }
    }
  }
  for (const group of previous) {
    if (!nextGroups.has(group.id)) {
      changes.push({ groupId: group.id, before: group.title, after: null });
      continue;
    }
    for (const item of group.items) {
      if (!nextItems.has(item.view.id)) {
        changes.push({ groupId: group.id, itemId: item.view.id, before: displayItem(item.view), after: null });
      }
    }
  }
  return changes;
}

function readBatches(task) {
  const directory = path.join(task, 'batches');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && isUuid(entry.name))
    .map(entry => readJson(path.join(directory, entry.name, 'batch.json')))
    .sort((left, right) => left.savedAt.localeCompare(right.savedAt) || left.id.localeCompare(right.id));
}

function latestRevision(task) {
  const directory = path.join(task, 'revisions');
  if (!fs.existsSync(directory)) return 0;
  return Math.max(0, ...fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))
    .map(entry => Number(entry.name)));
}

function readRevision(task, revision = latestRevision(task)) {
  if (!revision) throw new ReviewError('这个任务目录还没有审阅稿。');
  const directory = path.join(task, 'revisions', String(revision));
  const model = readJson(path.join(directory, 'model.json'));
  const review = readJson(path.join(directory, 'review.json'));
  return {
    revision, directory, model, groups: projectView(model, review),
    layout: review.layout === 'process' ? 'process' : undefined,
    ...readJson(path.join(directory, 'state.json')),
  };
}

// Validate and derive a publication without writing anything. Managed drafts and
// the legacy publish command deliberately share this gate.
function validateCandidate(task, base, model, review, outcomes = []) {
  if (!Number.isSafeInteger(base) || base < 0 || base !== latestRevision(task)) {
    throw new ReviewError('审阅稿已更新。请重新读取当前版，再处理批注。', 409);
  }
  const rendered = renderFlow(model);
  const groups = projectView(model, review);
  const current = base ? readRevision(task, base) : null;
  if (current && current.model.report.id !== model.report.id) throw new ReviewError('新版模型属于其他任务。');
  const contentDelta = buildReviewChanges(current?.model, model, groups);
  const changedTargets = new Set([...contentDelta.contentChanges, ...contentDelta.evidenceChanges].map(change => change.id));

  const currentOutcomes = new Map((current?.outcomes || []).map(outcome => [outcome.commentId, outcome]));
  const batchComments = new Map(readBatches(task).map(batch => [batch.id, new Set(batch.comments.map(comment => comment.id))]));
  const groupIds = new Set(groups.map(group => group.id));
  const processed = new Set();
  if (!Array.isArray(outcomes)) throw new ReviewError('处理结果需要是批注结果数组。');
  for (const outcome of outcomes) {
    if (!isObject(outcome) || !batchComments.get(outcome.batchId)?.has(outcome.commentId) ||
        processed.has(outcome.commentId) || !statuses.includes(outcome.status) ||
        typeof outcome.summary !== 'string' || !outcome.summary.trim() ||
        !Array.isArray(outcome.groupIds) || outcome.groupIds.some(id => !groupIds.has(id))) {
      throw new ReviewError('批注处理结果必须对应已保存批注，并指向新版中存在的内容组。');
    }
    processed.add(outcome.commentId);
    const existing = currentOutcomes.get(outcome.commentId);
    if (existing && existing.status !== 'needs-clarification') {
      const same = existing.batchId === outcome.batchId && existing.status === outcome.status &&
        existing.summary === outcome.summary && JSON.stringify(existing.groupIds) === JSON.stringify(outcome.groupIds) &&
        JSON.stringify(existing.changeTargets) === JSON.stringify(outcome.changeTargets) && existing.noChangeReason === outcome.noChangeReason;
      if (!same) throw new ReviewError('这条批注已有处理结果，不能覆盖。新的修订请另留批注。', 409);
      continue;
    }
    if (outcome.changeTargets !== undefined) {
      const seenTargets = new Set();
      if (!Array.isArray(outcome.changeTargets)) throw new ReviewError('修改落点需要是对象引用数组。');
      for (const target of outcome.changeTargets) {
        const key = isObject(target) ? target.type + ':' + target.id : '';
        if (!isObject(target) || Object.keys(target).some(name => !['type', 'id'].includes(name)) ||
            !isId(target.id) || !changedTargets.has(key) || seenTargets.has(key)) {
          throw new ReviewError('修改落点必须唯一，并对应本轮确实发生内容或直接依据变化的对象。');
        }
        seenTargets.add(key);
      }
    }
    if (outcome.noChangeReason !== undefined && typeof outcome.noChangeReason !== 'string') throw new ReviewError('未改正文的原因需要是文字。');
    currentOutcomes.set(outcome.commentId, { ...outcome, revision: base + 1 });
  }
  return {
    ...rendered, groups, outcomes: [...currentOutcomes.values()],
    changes: compareGroups(current?.groups, groups),
  };
}

function publish(task, base, model, review, outcomes = [], options = {}) {
  const candidate = validateCandidate(task, base, model, review, outcomes);
  if (options.transactionId !== undefined && !isUuid(options.transactionId)) {
    throw new ReviewError('草稿事务编号无效。');
  }
  if (options.transactionFiles !== undefined && (!options.transactionId || !isObject(options.transactionFiles) ||
      Object.keys(options.transactionFiles).length !== 3 ||
      !['manifest.json', 'model.json', 'outcomes.json'].every(file => /^[a-f0-9]{64}$/.test(options.transactionFiles[file])))) {
    throw new ReviewError('草稿事务文件摘要无效。');
  }
  const revisions = path.join(task, 'revisions');
  fs.mkdirSync(revisions, { recursive: true });
  const staging = fs.mkdtempSync(path.join(revisions, '.draft-'));
  const destination = path.join(revisions, String(base + 1));
  try {
    writeJson(path.join(staging, 'model.json'), model);
    writeJson(path.join(staging, 'review.json'), review);
    fs.writeFileSync(path.join(staging, 'flow.md'), candidate.markdown, { flag: 'wx' });
    writeJson(path.join(staging, 'state.json'), {
      outcomes: candidate.outcomes,
      changes: candidate.changes,
      ...(options.transactionId ? { transactionId: options.transactionId } : {}),
      ...(options.transactionFiles ? { transactionFiles: options.transactionFiles } : {}),
    });
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      if (fs.existsSync(destination)) throw new ReviewError('另一份修订已发布，请重新读取当前版。', 409);
      throw error;
    }
  } finally {
    for (const file of ['model.json', 'review.json', 'flow.md', 'state.json']) {
      fs.rmSync(path.join(staging, file), { force: true });
    }
    if (fs.existsSync(staging)) fs.rmdirSync(staging);
  }
  return { revision: base + 1, directory: destination };
}

function saveBatch(task, input) {
  if (!isObject(input) || !isUuid(input.id) || !Number.isSafeInteger(input.revision) ||
      !Array.isArray(input.comments) || input.comments.length < 1 || input.comments.length > 100) {
    throw new ReviewError('请选择 1 到 100 条批注保存。');
  }
  const requestHash = digest(JSON.stringify(input));
  const directory = path.join(task, 'batches');
  const destination = path.join(directory, input.id);
  function retry() {
    if (readJson(path.join(destination, 'batch.json')).requestHash !== requestHash) {
      throw new ReviewError('该批次已保存，不能覆盖。', 409);
    }
    return { id: input.id };
  }
  if (fs.existsSync(destination)) return retry();
  const current = readRevision(task);
  if (input.revision !== current.revision) {
    throw new ReviewError('审阅稿已更新。请核对新版内容后重新标注，这批草稿还在页面里。', 409);
  }
  const groups = new Map(current.groups.map(group => [group.id, group]));
  const commentIds = new Set(readBatches(task).flatMap(batch => batch.comments.map(comment => comment.id)));
  const comments = input.comments.map(comment => {
    if (!isObject(comment) || !isUuid(comment.id) || commentIds.has(comment.id) ||
        !Array.isArray(comment.tags) || comment.tags.some(tag => !tags.includes(tag)) ||
        typeof comment.text !== 'string' || comment.text.length > 6000 ||
        (!comment.text.trim() && !comment.tags.length)) {
      throw new ReviewError('批注需要一段说明或一个标记，单条说明最多 6000 字。');
    }
    commentIds.add(comment.id);
    const group = groups.get(comment.groupId);
    const item = group?.items.find(candidate => candidate.view.id === comment.itemId);
    if (!group || (comment.itemId !== undefined && !item)) throw new ReviewError('批注的位置不在当前审阅稿中。');
    let selection;
    if (comment.selection !== undefined) {
      const { start, end, text } = comment.selection || {};
      if (item?.view.type !== 'claim' || !Number.isInteger(start) || !Number.isInteger(end) ||
          start < 0 || end <= start || end > item.view.text.length || typeof text !== 'string' ||
          !text.trim() || item.view.text.slice(start, end) !== text) {
        throw new ReviewError('选中文字与当前审阅稿不一致，请重新选中原句。');
      }
      selection = { start, end, text };
    }
    return {
      id: comment.id, groupId: group.id, groupTitle: group.title,
      itemId: item?.view.id, itemText: item?.view.text,
      target: item?.target, fingerprint: item?.fingerprint ?? group.fingerprint,
      tags: [...new Set(comment.tags)], text: comment.text.trim(), selection,
    };
  });
  fs.mkdirSync(directory, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(directory, '.draft-'));
  try {
    writeJson(path.join(temporary, 'batch.json'), {
      id: input.id, revision: current.revision, savedAt: new Date().toISOString(), requestHash,
      projectId: current.model.report.id, modelSha256: digest(JSON.stringify(current.model)), comments,
    });
    try {
      fs.renameSync(temporary, destination);
    } catch (error) {
      if (fs.existsSync(destination)) return retry();
      throw error;
    }
  } finally {
    fs.rmSync(path.join(temporary, 'batch.json'), { force: true });
    if (fs.existsSync(temporary)) fs.rmdirSync(temporary);
  }
  return { id: input.id };
}

function reviewResponse(task) {
  const current = readRevision(task);
  const { id, title, scope, version } = current.model.report;
  const outcomes = new Map(current.outcomes.map(outcome => [outcome.commentId, outcome]));
  const savedBatches = readBatches(task);
  const commentsByRevision = new Map();
  for (const batch of savedBatches) for (const comment of batch.comments) {
    const revision = outcomes.get(comment.id)?.revision;
    if (!revision) continue;
    if (!commentsByRevision.has(revision)) commentsByRevision.set(revision, []);
    commentsByRevision.get(revision).push(comment);
  }
  const snapshots = new Map([[current.revision, current]]);
  const getSnapshot = revision => {
    if (!revision) return null;
    if (!snapshots.has(revision)) snapshots.set(revision, readRevision(task, revision));
    return snapshots.get(revision);
  };
  const contentDelta = buildReviewChanges(getSnapshot(current.revision - 1)?.model, current.model, current.groups);
  const deltas = new Map([[current.revision, contentDelta]]);
  const currentLocations = buildChangeLocations(current.model, current.groups);
  const getDelta = revision => {
    if (!deltas.has(revision)) {
      const processed = getSnapshot(revision);
      deltas.set(revision, buildReviewChanges(getSnapshot(revision - 1)?.model, processed.model, processed.groups));
    }
    return deltas.get(revision);
  };
  function displayComment(comment) {
    const { target, fingerprint, ...visible } = comment;
    const outcome = outcomes.get(comment.id);
    if (!outcome) return visible;
    const mapped = resolveOutcomeChanges({
      comment, outcome, beforeModel: getSnapshot(outcome.revision - 1)?.model,
      processedModel: getSnapshot(outcome.revision).model, currentModel: current.model, currentGroups: current.groups,
      peerComments: commentsByRevision.get(outcome.revision),
      delta: getDelta(outcome.revision), currentLocations,
    });
    return { ...visible, outcome: { ...outcome, changeTargets: mapped.changeTargets, mappingSource: mapped.mappingSource,
      ...(mapped.mappingNote ? { mappingNote: mapped.mappingNote, mappingIncomplete: true } : {}) }, resultChanges: mapped.resultChanges };
  }
  const batches = savedBatches.map(({ id: batchId, projectId, revision, savedAt, comments }) => ({
    id: batchId, revision, savedAt,
    handoff: '请处理这批流程草稿批注。\n\npricing-review-batch:v1 ' + JSON.stringify({
      taskDirectory: path.resolve(task), projectId, batchId, revision,
    }),
    comments: comments.map(displayComment),
  }));
  return {
    project: { id, title, scope, modelVersion: version }, revision: current.revision, batches,
    layout: current.layout,
    groups: current.groups.map(({ id: groupId, title: groupTitle, items, unplaced }) => ({
      id: groupId, title: groupTitle, items: items.map(item => item.view), unplaced,
    })),
    changes: current.changes, ...contentDelta,
  };
}

function pending(task, reference) {
  const current = readRevision(task);
  const outcomes = new Map(current.outcomes.map(outcome => [outcome.commentId, outcome]));
  const groups = new Map(current.groups.map(group => [group.id, group]));
  const items = locations(current.groups);
  const snapshots = new Map([[current.revision, current]]);
  let saved = readBatches(task);
  let requestedBatch;
  if (reference) {
    const match = saved.find(batch => batch.id === reference.batchId && batch.revision === reference.revision &&
      batch.projectId === reference.projectId && batch.projectId === current.model.report.id);
    if (!match) throw new ReviewError('该任务中找不到与引用项目、批次和原轮次一致的批注。');
    saved = [match];
    requestedBatch = {
      id: match.id,
      revision: match.revision,
      outcomes: match.comments.map(comment => outcomes.get(comment.id)).filter(Boolean),
    };
  }
  const batches = [];
  for (const batch of saved) {
    const pendingComments = batch.comments.filter(comment => {
      const outcome = outcomes.get(comment.id);
      return !outcome || outcome.status === 'needs-clarification';
    });
    if (!pendingComments.length) continue;
    if (!snapshots.has(batch.revision)) snapshots.set(batch.revision, readRevision(task, batch.revision));
    const original = snapshots.get(batch.revision);
    const sameProject = batch.projectId === current.model.report.id && batch.projectId === original.model.report.id;
    const verified = sameProject && batch.modelSha256 === digest(JSON.stringify(original.model));
    const comments = pendingComments.map(comment => {
      const location = comment.itemId ? items.get(comment.itemId) : null;
      const target = comment.itemId ? location?.item : groups.get(comment.groupId);
      const originalGroup = original.groups.find(group => group.id === comment.groupId);
      const originalTarget = comment.itemId ? originalGroup?.items.find(item => item.view.id === comment.itemId) : originalGroup;
      const matching = verified && originalTarget?.fingerprint === comment.fingerprint &&
        target?.fingerprint === comment.fingerprint &&
        originalTarget?.contextFingerprint === target?.contextFingerprint;
      const outcome = outcomes.get(comment.id);
      return {
        ...comment, outcome,
        targetState: matching ? (batch.revision === current.revision ? 'current' : 'unchanged') : 'changed',
        currentGroupId: location?.group.id ?? groups.get(comment.groupId)?.id,
      };
    });
    batches.push({ id: batch.id, revision: batch.revision, originalDirectory: original.directory, comments });
  }
  return { projectId: current.model.report.id, revision: current.revision, directory: current.directory, requestedBatch, batches };
}

module.exports = { ReviewError, pending, publish, readJson, readRevision, reviewResponse, saveBatch, validateCandidate };
