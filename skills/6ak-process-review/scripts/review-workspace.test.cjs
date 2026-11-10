'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { initialize, migrate, resolveTask, taskDirectory } = require('./review-workspace.cjs');
const { publish, readRevision, readJson, saveBatch, pending } = require('./grouped-review-store.cjs');

const fixture = () => readJson(path.join(__dirname, '../examples/messy-pricing.model.json'));
function temporary(t) {
  const parent = path.resolve(process.env.PRICING_QA_DIR || os.tmpdir());
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'document-review-workspace-'));
  t.after(() => {
    assert.equal(path.dirname(root), parent);
    assert.match(path.basename(root), /^document-review-workspace-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function legacy(t) {
  const root = temporary(t);
  const task = path.join(root, 'old-task');
  publish(task, 0, fixture(), { layout: 'process' });
  const batch = { id: randomUUID(), revision: 1, comments: [{
    id: randomUUID(), groupId: 'price-change', itemId: 'node.calculate', tags: ['rewrite'], text: '请核对当前说明。',
  }] };
  saveBatch(task, batch);
  const model = fixture();
  model.report.version = '2';
  publish(task, 1, model, { layout: 'process' });
  return { root, task, batch };
}

test('init keeps independent projects under the explicit project root and refuses overwrites', t => {
  const root = temporary(t);
  const model = fixture();
  const first = initialize(root, model);
  assert.equal(first.taskDirectory, path.join(root, '.document-review', model.report.id));
  assert.equal(readRevision(first.taskDirectory).revision, 1);
  assert.equal(readJson(path.join(first.taskDirectory, 'task.json')).projectRoot, root);
  assert.throws(() => initialize(root, model), /任务已存在/);
  model.report.id = 'another-document';
  assert.notEqual(initialize(root, model).taskDirectory, first.taskDirectory);
  for (const id of ['../escape', 'a/b', 'CON', '']) assert.throws(() => taskDirectory(root, id), /项目编号/);
});

test('migration preserves snapshots and old batch references, removes only verified copies, and retains unrelated files', t => {
  const { root, task, batch } = legacy(t);
  const before = fs.readFileSync(path.join(task, 'revisions/2/model.json'));
  fs.writeFileSync(path.join(task, 'old-helper.cjs'), 'historical helper, never execute');
  const result = migrate(root, task);
  assert.equal(result.verifiedFiles, 9);
  assert.deepEqual(fs.readFileSync(path.join(result.taskDirectory, 'revisions/2/model.json')), before);
  assert.equal(fs.existsSync(path.join(task, 'revisions')), false);
  assert.deepEqual(fs.readdirSync(task).sort(), ['old-helper.cjs', 'task-location.json']);
  assert.equal(resolveTask(task), result.taskDirectory);
  const original = pending(resolveTask(task), { batchId: batch.id, projectId: fixture().report.id, revision: 1 });
  assert.equal(original.batches[0].comments[0].targetState, 'unchanged');
  assert.equal(migrate(root, task).migrated, false);
});

test('migration rejects a corrupt historical flow without moving or deleting any original', t => {
  const { root, task } = legacy(t);
  fs.appendFileSync(path.join(task, 'revisions/1/flow.md'), '\nwrong version');
  assert.throws(() => migrate(root, task), /同版文档校验失败/);
  assert.equal(fs.existsSync(path.join(task, 'revisions/2/model.json')), true);
  assert.equal(fs.existsSync(path.join(task, 'task-location.json')), false);
  assert.equal(fs.existsSync(taskDirectory(root, fixture().report.id)), false);
});

test('migration refuses active drafts, target collisions, and unknown files inside immutable snapshots', t => {
  const { root, task } = legacy(t);
  fs.mkdirSync(path.join(task, 'draft'));
  assert.throws(() => migrate(root, task), /提交或放弃/);
  fs.rmdirSync(path.join(task, 'draft'));
  fs.writeFileSync(path.join(task, 'revisions/1/notes.txt'), 'keep');
  assert.throws(() => migrate(root, task), /未识别文件/);
  fs.unlinkSync(path.join(task, 'revisions/1/notes.txt'));
  initialize(root, fixture());
  assert.throws(() => migrate(root, task));
  assert.equal(readRevision(task).revision, 2);
});

test('migration resumes after destination was completed but the redirect was not yet written', t => {
  const { root, task } = legacy(t);
  const target = taskDirectory(root, fixture().report.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(task, target, { recursive: true });
  fs.writeFileSync(path.join(target, 'task.json'), JSON.stringify({
    schemaVersion: 1, kind: 'document-review-task', projectRoot: root, projectId: fixture().report.id, migratedFrom: task,
  }));
  assert.equal(migrate(root, task).migrated, true);
  assert.equal(resolveTask(task), target);
});

test('workspace junctions cannot redirect initialization outside the project', t => {
  const root = temporary(t);
  const outside = temporary(t);
  fs.symlinkSync(outside, path.join(root, '.document-review'), 'junction');
  assert.throws(() => initialize(root, fixture()), /不接受链接/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('managed CLI status follows old references while direct publish is rejected', t => {
  const { root, task } = legacy(t);
  const target = migrate(root, task).taskDirectory;
  const cli = path.join(__dirname, 'grouped-review.cjs');
  const status = spawnSync(process.execPath, [cli, 'status', task], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).taskDirectory, target);
  const publishAttempt = spawnSync(process.execPath, [cli, 'publish', target, '2',
    path.join(target, 'revisions/2/model.json'), path.join(target, 'revisions/2/review.json')], { encoding: 'utf8' });
  assert.equal(publishAttempt.status, 1);
  assert.match(publishAttempt.stderr, /draft.*check.*commit/);
  assert.equal(readRevision(target).revision, 2);
});

test('migration recovery rejects incomplete destination metadata before redirecting or deleting legacy snapshots', t => {
  const { root, task } = legacy(t);
  const target = taskDirectory(root, fixture().report.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(task, target, { recursive: true });
  // This satisfies only the old two-field resume guard, but cannot be resolved
  // as a managed task. A recovery must validate the same contract as resolveTask.
  fs.writeFileSync(path.join(target, 'task.json'), JSON.stringify({
    projectId: fixture().report.id, migratedFrom: task,
  }));
  const before = fs.readFileSync(path.join(task, 'revisions/2/model.json'), 'utf8');
  assert.throws(() => migrate(root, task));
  assert.equal(fs.existsSync(path.join(task, 'task-location.json')), false);
  assert.equal(fs.readFileSync(path.join(task, 'revisions/2/model.json'), 'utf8'), before);
});

test('migration resumes a cleanup interrupted after redirect creation without deleting unrelated files', t => {
  const { root, task } = legacy(t);
  const target = taskDirectory(root, fixture().report.id);
  fs.writeFileSync(path.join(task, 'reader-notes.txt'), '保留人工笔记。');
  const originalUnlink = fs.unlinkSync;
  let interrupted = false, deleted = 0, initial;
  try {
    fs.unlinkSync = function (file, ...args) {
      if (path.resolve(file).startsWith(path.join(task, 'revisions') + path.sep)) {
        if (!interrupted && deleted === 1) {
          interrupted = true;
          const error = new Error('Synthetic interruption after redirect creation');
          error.code = 'EBUSY';
          throw error;
        }
        deleted++;
      }
      return originalUnlink.call(fs, file, ...args);
    };
    initial = migrate(root, task);
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(interrupted, true);
  assert.equal(deleted, 1, 'The interruption occurs after a partial cleanup');
  assert.equal(initial.cleanupPending, true);
  assert.equal(initial.migrated, true);
  assert.ok(initial.warning);
  assert.equal(resolveTask(task), target);
  assert.equal(readRevision(target).revision, 2);
  assert.equal(fs.existsSync(path.join(task, 'revisions')), true);
  migrate(root, task);
  assert.equal(fs.existsSync(path.join(task, 'revisions')), false, 'Retry must finish only the previously verified cleanup');
  assert.equal(fs.existsSync(path.join(task, 'batches')), false);
  assert.equal(fs.readFileSync(path.join(task, 'reader-notes.txt'), 'utf8'), '保留人工笔记。');
  assert.equal(readRevision(target).revision, 2);
});

test('initialization interrupted while writing task metadata can be retried without leaving an unmanaged published task', t => {
  const root = temporary(t);
  const model = fixture();
  const originalWrite = fs.writeFileSync;
  let interrupted = false;
  try {
    fs.writeFileSync = function (file, ...args) {
      if (!interrupted && path.basename(file) === 'task.json' && path.resolve(file).startsWith(root + path.sep)) {
        interrupted = true;
        const error = new Error('Synthetic task-metadata write failure');
        error.code = 'EIO';
        throw error;
      }
      return originalWrite.call(fs, file, ...args);
    };
    assert.throws(() => initialize(root, model));
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.equal(interrupted, true);
  const resumed = initialize(root, model);
  assert.equal(readRevision(resumed.taskDirectory).revision, 1);
  const metadata = readJson(path.join(resumed.taskDirectory, 'task.json'));
  assert.equal(metadata.kind, 'document-review-task');
  assert.equal(metadata.projectId, model.report.id);
});
