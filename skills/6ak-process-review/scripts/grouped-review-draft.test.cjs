'use strict';

// Managed draft transaction regression with synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { digest } = require('./index-sources.cjs');
const { renderFlow } = require('./export-flow.cjs');
const { validateModel } = require('./validate-model.cjs');
const store = require('./grouped-review-store.cjs');
const { beginDraft, checkDraft, commitDraft, abortDraft, draftStatus } = require('./grouped-review-draft.cjs');

const fixture = () => JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/messy-pricing.model.json'), 'utf8'));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const draftFile = (task, name) => path.join(task, 'draft', name);
const ownedFiles = ['manifest.json', 'model.json', 'outcomes.json'];

function temporary(t) {
  const parent = process.env.PRICING_QA_DIR ? path.resolve(process.env.PRICING_QA_DIR) : path.resolve(os.tmpdir());
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'pricing-managed-draft-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    assert.match(path.basename(directory), /^pricing-managed-draft-/);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return directory;
}

function start(t, model = fixture()) {
  const task = path.join(temporary(t), 'task');
  store.publish(task, 0, model, { layout: 'process' });
  return task;
}

function save(task, inputs = [{ itemId: 'node.calculate', text: '合成批注：请核对算价步骤的标题。' }]) {
  const current = store.readRevision(task);
  const comments = inputs.map(input => {
    const group = current.groups.find(group => group.items.some(item => item.view.id === input.itemId));
    assert.ok(group, 'The annotation target must be displayed in the current review');
    return { id: randomUUID(), groupId: group.id, tags: ['rewrite'], ...input };
  });
  const payload = { id: randomUUID(), revision: current.revision, comments };
  store.saveBatch(task, payload);
  return payload;
}

function draftBytes(task) {
  return Object.fromEntries(ownedFiles.map(name => [name, fs.readFileSync(draftFile(task, name), 'utf8')]));
}

function complete(task, statuses = [], mutate) {
  const current = store.readRevision(task);
  const model = read(draftFile(task, 'model.json'));
  model.report.version = String(Number(current.model.report.version) + 1);
  // These comments exercise transport and transaction handling. Do not invent
  // business facts from their request text just to make a test model validate.
  for (const source of model.sources) {
    if (current.model.sources.some(old => old.id === source.id)) continue;
    if (!model.coverage.some(entry => entry.sourceId === source.id)) {
      model.coverage.push({ sourceId: source.id, startLine: 1, endLine: source.text.split('\n').length,
        disposition: 'out_of_scope', claimIds: [], issueIds: [], reason: '合成工具测试批注，不作为现行业务事实。' });
    }
  }
  if (mutate) mutate(model);
  write(draftFile(task, 'model.json'), model);
  const outcomes = read(draftFile(task, 'outcomes.json')).map((outcome, index) => {
    const comment = read(path.join(task, 'batches', outcome.batchId, 'batch.json')).comments.find(entry => entry.id === outcome.commentId);
    const target = comment.target;
    const renamed = target?.type === 'node' && model.nodes.find(entry => entry.id === target.id)?.title !==
      current.model.nodes.find(entry => entry.id === target.id)?.title;
    return {
      ...outcome, status: statuses[index] || 'applied', summary: '合成测试已核对该条批注，未确认真实业务。', groupIds: ['price-change'],
      changeTargets: renamed ? [{ type: 'node', id: target.id }] : [],
      noChangeReason: renamed ? '' : '本条为合成事务检查，不据此修改业务事实。',
    };
  });
  write(draftFile(task, 'outcomes.json'), outcomes);
  return { model, outcomes };
}

function rejectWithoutPublishing(task, action) {
  const before = store.readRevision(task).revision;
  assert.throws(action);
  assert.equal(store.readRevision(task).revision, before);
  assert.equal(fs.existsSync(path.join(task, 'revisions', String(before + 1))), false);
  assert.ok(fs.existsSync(draftFile(task, 'manifest.json')), 'A rejected candidate remains available for repair');
}

test('begin creates only the managed files, resets inherited checks, and resumes without overwriting edits', t => {
  const original = fixture();
  original.review.semantic = { status: 'passed', reviewer: '合成测试', notes: ['原版检查记录。'] };
  original.review.visual = { status: 'passed', reviewer: '合成测试', notes: ['原版展示检查记录。'] };
  const task = start(t, original);
  const started = beginDraft(task);
  assert.equal(started.status, 'created');
  assert.equal(started.baseRevision, 1);
  assert.ok(started.transactionId);
  assert.equal(path.resolve(started.directory), path.join(task, 'draft'));
  assert.deepEqual(fs.readdirSync(started.directory).sort(), [...ownedFiles].sort());
  const candidate = read(draftFile(task, 'model.json'));
  assert.deepEqual(candidate.sources, original.sources);
  assert.deepEqual(candidate.nodes, original.nodes);
  assert.equal(candidate.review.semantic.status, 'not_run');
  assert.equal(candidate.review.visual.status, 'not_run');
  assert.deepEqual(read(draftFile(task, 'outcomes.json')), []);
  candidate.nodes[0].title = '尚未完成的标题编辑';
  write(draftFile(task, 'model.json'), candidate);
  const edited = draftBytes(task);
  const resumed = beginDraft(task);
  assert.equal(resumed.status, 'resumed');
  assert.equal(resumed.transactionId, started.transactionId);
  assert.deepEqual(draftBytes(task), edited);
  assert.ok(draftStatus(task));
  assert.deepEqual(store.readRevision(task, 1).model, original);
});

test('batch drafts preserve complete saved comment text and require deliberate outcomes and source coverage', t => {
  const task = start(t);
  const batch = save(task, [
    { itemId: 'node.calculate', text: '第一行反馈。\r\n第二行反馈。' },
    { itemId: 'node.submit', text: '', tags: ['unknown'] },
  ]);
  const started = beginDraft(task, batch.id);
  assert.equal(started.batchId, batch.id);
  const candidate = read(draftFile(task, 'model.json'));
  const added = candidate.sources.filter(source => source.kind === 'user-feedback');
  assert.equal(added.length, 1, 'A mark-only annotation must not fabricate a source sentence');
  assert.equal(added[0].text, '第一行反馈。\n第二行反馈。');
  assert.equal(added[0].sha256, digest(added[0].text));
  assert.equal(candidate.claims.length, fixture().claims.length, 'Preparing a draft does not interpret feedback into claims');
  assert.ok(!candidate.coverage.some(entry => entry.sourceId === added[0].id), 'Coverage is an explicit review decision');
  const outcomes = read(draftFile(task, 'outcomes.json'));
  assert.deepEqual(outcomes.map(outcome => outcome.commentId), batch.comments.map(comment => comment.id));
  assert.ok(outcomes.every(outcome => outcome.batchId === batch.id && outcome.status === '' && outcome.summary === ''));
  const checked = checkDraft(task);
  assert.equal(checked.ok, false);
  assert.ok(checked.errors.length > 0);
  rejectWithoutPublishing(task, () => commitDraft(task));
  const other = save(task);
  const before = draftBytes(task);
  assert.throws(() => beginDraft(task, { batchId: other.id }));
  assert.deepEqual(draftBytes(task), before);
});

test('check reports object changes and incomplete, duplicate or foreign batch outcomes cannot publish', t => {
  const task = start(t);
  const batch = save(task, [
    { itemId: 'node.calculate', text: '请核对第一处。' },
    { itemId: 'node.submit', text: '请核对第二处。' },
  ]);
  const foreign = save(task, [{ itemId: 'node.check', text: '另一批的意见。' }]);
  beginDraft(task, { batchId: batch.id });
  const candidate = complete(task, [], model => { model.nodes.find(node => node.id === 'calculate').title = '核算并记录目标价'; });
  const good = checkDraft(task);
  assert.equal(good.ok, true, good.errors.join('\n'));
  assert.ok(JSON.stringify(good.changes.objects).includes('calculate'), 'The diff identifies the changed business object');
  assert.ok(JSON.stringify(good.changes.sources).includes('feedback-'), 'New feedback sources are represented in the diff');
  write(draftFile(task, 'outcomes.json'), candidate.outcomes.slice(0, 1));
  const missing = checkDraft(task);
  assert.equal(missing.ok, false);
  assert.ok(JSON.stringify(missing.outcomes.missing).includes(batch.comments[1].id));
  rejectWithoutPublishing(task, () => commitDraft(task));
  write(draftFile(task, 'outcomes.json'), [...candidate.outcomes, {
    batchId: foreign.id, commentId: foreign.comments[0].id, status: 'applied', summary: '不能混入另一批。', groupIds: ['price-change'],
  }]);
  const unexpected = checkDraft(task);
  assert.equal(unexpected.ok, false);
  assert.ok(JSON.stringify(unexpected.outcomes.unexpected).includes(foreign.comments[0].id));
  rejectWithoutPublishing(task, () => commitDraft(task));
  write(draftFile(task, 'outcomes.json'), [...candidate.outcomes, candidate.outcomes[0]]);
  assert.equal(checkDraft(task).ok, false);
  rejectWithoutPublishing(task, () => commitDraft(task));
});

test('even a structurally valid rewrite of an existing source is rejected while processing a feedback batch', t => {
  const task = start(t);
  const batch = save(task);
  beginDraft(task, { batchId: batch.id });
  complete(task, [], model => {
    const source = model.sources[0];
    const line = source.text.split('\n').length;
    source.text += '测试新增限制，不应通过反馈草稿改写原文。\n';
    source.sha256 = digest(source.text);
    model.coverage.push({ sourceId: source.id, startLine: line, endLine: line,
      disposition: 'out_of_scope', claimIds: [], issueIds: [], reason: '仅验证原文不可替换。' });
  });
  const structurallyValid = validateModel(read(draftFile(task, 'model.json')));
  assert.equal(structurallyValid.ok, true, structurallyValid.errors.join('\n'));
  const checked = checkDraft(task);
  assert.equal(checked.ok, false);
  assert.match(checked.errors.join('\n'), /来源|原文/);
  rejectWithoutPublishing(task, () => commitDraft(task));
});

test('managed applied outcomes require concrete result targets or an explicit no-change explanation', t => {
  const task = start(t);
  const batch = save(task);
  beginDraft(task, { batchId: batch.id });
  const prepared = complete(task);
  prepared.outcomes[0].changeTargets = [];
  prepared.outcomes[0].noChangeReason = '';
  write(draftFile(task, 'outcomes.json'), prepared.outcomes);
  assert.equal(checkDraft(task).ok, false);
  rejectWithoutPublishing(task, () => commitDraft(task));
  prepared.outcomes[0].noChangeReason = '已核对该意见；现有表述准确，本轮无需修改正文。';
  write(draftFile(task, 'outcomes.json'), prepared.outcomes);
  assert.equal(checkDraft(task).ok, true);
  assert.equal(commitDraft(task).revision, 2);
  const saved = store.reviewResponse(task).batches[0].comments[0];
  assert.deepEqual(saved.resultChanges, []);
  assert.equal(saved.outcome.noChangeReason, prepared.outcomes[0].noChangeReason);
});

test('published snapshots changed in place or superseded by another publication invalidate the baseline lock', t => {
  for (const mode of ['model', 'review', 'state', 'new-revision']) {
    const task = path.join(temporary(t), mode);
    store.publish(task, 0, fixture(), { layout: 'process' });
    beginDraft(task);
    complete(task);
    const current = store.readRevision(task);
    if (mode === 'new-revision') {
      const next = structuredClone(current.model); next.report.version = '2';
      store.publish(task, 1, next, { layout: 'process' });
    } else {
      const file = path.join(current.directory, mode + '.json');
      // A whitespace-only edit leaves parsed data valid but breaks the exact
      // published-file snapshot that the transaction was based on.
      fs.appendFileSync(file, '\n');
    }
    const checked = checkDraft(task);
    assert.equal(checked.ok, false, mode + ' must invalidate the captured baseline');
    rejectWithoutPublishing(task, () => commitDraft(task));
  }
});

test('saved batch text and generated feedback sources cannot be changed behind the transaction', t => {
  const task = start(t);
  const batch = save(task);
  beginDraft(task, { batchId: batch.id });
  complete(task);
  const batchFile = path.join(task, 'batches', batch.id, 'batch.json');
  const originalBytes = fs.readFileSync(batchFile, 'utf8');
  fs.appendFileSync(batchFile, '\n');
  assert.equal(checkDraft(task).ok, false);
  rejectWithoutPublishing(task, () => commitDraft(task));
  fs.writeFileSync(batchFile, originalBytes);
  const candidate = read(draftFile(task, 'model.json'));
  const feedback = candidate.sources.find(source => source.kind === 'user-feedback');
  feedback.text = '错误地把用户原话替换成整理结论。';
  feedback.sha256 = digest(feedback.text);
  write(draftFile(task, 'model.json'), candidate);
  assert.equal(checkDraft(task).ok, false);
  rejectWithoutPublishing(task, () => commitDraft(task));
});

test('two committed rounds preserve history, unresolved business issues and matching exports; retries do not publish', t => {
  const task = start(t);
  const originalBytes = fs.readFileSync(path.join(task, 'revisions', '1', 'model.json'), 'utf8');
  const first = save(task, [
    { itemId: 'node.calculate', text: '第一轮调整标题。' },
    { itemId: 'node.submit', text: '第一轮暂不确定。' },
  ]);
  const transaction = beginDraft(task, { batchId: first.id });
  const prepared = complete(task, ['applied', 'left-open'], model => { model.nodes[0].title = '第一轮核算目标价'; });
  assert.equal(checkDraft(task).ok, true);
  const committed = commitDraft(task);
  assert.equal(committed.revision, 2);
  assert.equal(committed.transactionId, transaction.transactionId);
  assert.equal(fs.existsSync(path.join(task, 'draft')), false);
  assert.deepEqual(store.readRevision(task).model, prepared.model);
  const replayed = commitDraft(task);
  assert.equal(replayed.revision, 2);
  assert.equal(replayed.transactionId, committed.transactionId);
  assert.equal(store.readRevision(task).revision, 2);
  const completedBatch = beginDraft(task, { batchId: first.id });
  assert.equal(completedBatch.status, 'already-processed');
  assert.equal(fs.existsSync(path.join(task, 'draft')), false);
  const second = save(task, [{ itemId: 'node.check', text: '', tags: ['unknown'] }]);
  beginDraft(task, { batchId: second.id });
  const secondPrepared = complete(task, ['left-open']);
  assert.equal(secondPrepared.model.sources.length, prepared.model.sources.length, 'A mark-only follow-up adds no invented source');
  const secondCommit = commitDraft(task);
  assert.equal(secondCommit.revision, 3);
  const latest = store.readRevision(task);
  assert.equal(latest.outcomes.length, 3);
  assert.equal(latest.outcomes.find(outcome => outcome.commentId === first.comments[0].id).status, 'applied');
  assert.equal(latest.outcomes.find(outcome => outcome.commentId === first.comments[1].id).status, 'left-open');
  assert.equal(latest.outcomes.find(outcome => outcome.commentId === second.comments[0].id).status, 'left-open');
  assert.deepEqual(latest.model.issues, fixture().issues, 'Recording an uncertain response must not resolve a business issue');
  assert.equal(fs.readFileSync(path.join(task, 'revisions', '1', 'model.json'), 'utf8'), originalBytes);
  const flow = fs.readFileSync(path.join(latest.directory, 'flow.md'), 'utf8');
  assert.equal(flow, renderFlow(latest.model).markdown);
  assert.ok(flow.includes(digest(JSON.stringify(latest.model))));
});

test('a retry after publication but before draft cleanup finishes the same transaction once', t => {
  const task = start(t);
  const batch = save(task);
  beginDraft(task, { batchId: batch.id });
  complete(task);
  const retained = draftBytes(task);
  const committed = commitDraft(task);
  assert.equal(committed.revision, 2);
  // Restore only the exact three transaction files to model a process stopping
  // after atomic publication but before cleanup. No published file is changed.
  fs.mkdirSync(path.join(task, 'draft'));
  for (const [name, text] of Object.entries(retained)) fs.writeFileSync(draftFile(task, name), text);
  const retried = commitDraft(task);
  assert.equal(retried.revision, 2);
  assert.equal(retried.transactionId, committed.transactionId);
  assert.equal(store.readRevision(task).revision, 2);
  assert.equal(fs.existsSync(path.join(task, 'draft')), false);
});

test('cleanup recovery refuses altered leftover files and never overwrites an already published transaction', t => {
  const task = start(t);
  beginDraft(task);
  complete(task);
  const retained = draftBytes(task);
  const committed = commitDraft(task);
  fs.mkdirSync(path.join(task, 'draft'));
  for (const [name, text] of Object.entries(retained)) fs.writeFileSync(draftFile(task, name), text);
  fs.appendFileSync(draftFile(task, 'model.json'), '\n');
  const changed = fs.readFileSync(draftFile(task, 'model.json'), 'utf8');
  const retry = commitDraft(task);
  assert.equal(retry.revision, committed.revision);
  assert.equal(retry.cleanupPending, true);
  assert.equal(store.readRevision(task).revision, committed.revision);
  assert.equal(fs.readFileSync(draftFile(task, 'model.json'), 'utf8'), changed);
});

test('an empty draft left by a directory-removal failure is cleaned on retry without publishing again', t => {
  const task = start(t);
  const started = beginDraft(task);
  complete(task);
  const directory = path.join(task, 'draft');
  const originalRmdir = fs.rmdirSync;
  let interrupted = false, committed;
  try {
    fs.rmdirSync = function (target, ...args) {
      if (!interrupted && path.resolve(target) === directory) {
        interrupted = true;
        const error = new Error('Synthetic interruption removing the empty draft directory');
        error.code = 'EBUSY';
        throw error;
      }
      return originalRmdir.call(fs, target, ...args);
    };
    committed = commitDraft(task);
  } finally {
    fs.rmdirSync = originalRmdir;
  }
  assert.equal(interrupted, true);
  assert.equal(committed.revision, 2);
  assert.equal(committed.cleanupPending, true);
  assert.deepEqual(fs.readdirSync(directory), []);
  const replayed = commitDraft(task);
  assert.equal(replayed.revision, 2);
  assert.equal(replayed.transactionId, started.transactionId);
  assert.equal(store.readRevision(task).revision, 2);
  assert.equal(fs.existsSync(directory), false);
});

test('abort preserves unknown files and all transaction files before refusing; a clean abort removes only the draft', t => {
  const task = start(t);
  beginDraft(task);
  const before = draftBytes(task);
  const unknown = draftFile(task, 'reader-notes.txt');
  fs.writeFileSync(unknown, '这份人工笔记不能随草稿一起删除。');
  assert.throws(() => abortDraft(task));
  assert.equal(fs.readFileSync(unknown, 'utf8'), '这份人工笔记不能随草稿一起删除。');
  assert.deepEqual(draftBytes(task), before, 'Preflight must finish before any managed file is deleted');
  fs.unlinkSync(unknown);
  abortDraft(task);
  assert.equal(fs.existsSync(path.join(task, 'draft')), false);
  assert.equal(store.readRevision(task).revision, 1);
});

test('abort refuses a draft directory junction or symlink and preserves its destination', t => {
  const task = start(t);
  beginDraft(task);
  const before = draftBytes(task);
  const original = path.join(task, 'draft');
  const destination = path.join(path.dirname(task), 'linked-draft-target');
  assert.equal(path.dirname(destination), path.dirname(task));
  fs.renameSync(original, destination);
  fs.symlinkSync(destination, original, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => abortDraft(task));
  assert.ok(fs.lstatSync(original).isSymbolicLink());
  for (const [name, bytes] of Object.entries(before)) assert.equal(fs.readFileSync(path.join(destination, name), 'utf8'), bytes);
  assert.equal(store.readRevision(task).revision, 1);
});
