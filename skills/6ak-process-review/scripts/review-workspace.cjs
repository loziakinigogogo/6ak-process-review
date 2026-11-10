'use strict';

// The workspace lifecycle is independent of the business vocabulary in a model.
const fs = require('node:fs');
const path = require('node:path');
const { digest } = require('./index-sources.cjs');
const { renderFlow } = require('./export-flow.cjs');
const { ReviewError, publish, readJson, readRevision } = require('./grouped-review-store.cjs');

const workspaceName = '.document-review';
const locationFile = 'task-location.json';
const snapshotFiles = ['model.json', 'review.json', 'flow.md', 'state.json'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

function assertPlain(file, type) {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || !(type === 'directory' ? info.isDirectory() : info.isFile())) {
    throw new ReviewError('工作区路径必须是普通' + (type === 'directory' ? '目录' : '文件') + '，不接受链接：' + file);
  }
}

function inside(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new ReviewError('路径不在指定工作目录内：' + file);
  }
  return file;
}

function taskDirectory(projectRoot, projectId) {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(projectId)) throw new ReviewError('项目编号不能用作安全的任务目录名。');
  const root = fs.realpathSync(path.resolve(projectRoot));
  assertPlain(root, 'directory');
  const workspace = inside(root, path.join(root, workspaceName));
  if (fs.existsSync(workspace)) assertPlain(workspace, 'directory');
  return inside(workspace, path.join(workspace, projectId));
}

function resolveTask(directory) {
  const task = path.resolve(directory);
  assertPlain(task, 'directory');
  const redirectFile = path.join(task, locationFile);
  if (!fs.existsSync(redirectFile)) return task;
  assertPlain(redirectFile, 'file');
  const redirect = readJson(redirectFile);
  if (redirect.schemaVersion !== 1 || redirect.kind !== 'document-review-location' ||
      typeof redirect.taskDirectory !== 'string' || !path.isAbsolute(redirect.taskDirectory)) {
    throw new ReviewError('旧任务位置记录无效。');
  }
  const target = path.resolve(redirect.taskDirectory);
  assertPlain(target, 'directory');
  const metadata = taskMetadata(target);
  if (metadata.projectId !== redirect.projectId || metadata.migratedFrom !== task ||
      readRevision(target).model.report.id !== redirect.projectId) {
    throw new ReviewError('迁移目标与旧批注项目不一致。');
  }
  return target;
}

function taskMetadata(task) {
  const file = path.join(task, 'task.json');
  assertPlain(file, 'file');
  const data = readJson(file);
  if (data.schemaVersion !== 1 || data.kind !== 'document-review-task' ||
      typeof data.projectRoot !== 'string' || !path.isAbsolute(data.projectRoot) ||
      taskDirectory(data.projectRoot, data.projectId) !== task) throw new ReviewError('目标任务位置记录无效，保留旧目录。');
  return data;
}

function metadata(projectRoot, projectId, extra = {}) {
  return { schemaVersion: 1, kind: 'document-review-task', projectRoot: fs.realpathSync(projectRoot), projectId, ...extra };
}

function prepareStaging(task, operation, data) {
  const workspace = path.dirname(task);
  fs.mkdirSync(workspace, { recursive: true });
  // One recoverable staging directory per task/operation, never one per retry.
  const staging = inside(workspace, path.join(workspace, '.' + operation + '-' + data.projectId));
  if (!fs.existsSync(staging)) fs.mkdirSync(staging);
  assertPlain(staging, 'directory');
  const file = path.join(staging, 'task.json');
  if (!fs.existsSync(file)) {
    if (fs.readdirSync(staging).length) throw new ReviewError('恢复目录缺少归属记录，已保留：' + staging);
    writeJson(file, data);
  } else {
    assertPlain(file, 'file');
    if (JSON.stringify(readJson(file)) !== JSON.stringify(data)) throw new ReviewError('已有不同输入的恢复目录，未覆盖：' + staging, 409);
  }
  return staging;
}

function verifyStagingContents(staging, relativeFiles) {
  const allowed = new Set(['task.json', ...relativeFiles]);
  function visit(directory) {
    assertPlain(directory, 'directory');
    for (const name of fs.readdirSync(directory)) {
      const file = inside(staging, path.join(directory, name));
      const relative = path.relative(staging, file);
      const info = fs.lstatSync(file);
      if (info.isDirectory() && !info.isSymbolicLink() && [...allowed].some(entry => entry.startsWith(relative + path.sep))) visit(file);
      else {
        assertPlain(file, 'file');
        if (!allowed.has(relative)) throw new ReviewError('恢复目录含未知文件，已保留：' + file);
      }
    }
  }
  visit(staging);
}

function initialize(projectRoot, model, review = { layout: 'process' }) {
  // Validate before making a task directory. Never overwrite another task.
  renderFlow(model);
  const task = taskDirectory(projectRoot, model.report.id);
  if (fs.existsSync(task)) throw new ReviewError('任务已存在，请使用 status 或 draft：' + task, 409);
  const staging = prepareStaging(task, 'init', metadata(projectRoot, model.report.id, { initialInputSha256: digest(JSON.stringify({ model, review })) }));
  const files = snapshotFiles.map(file => path.join('revisions', '1', file));
  verifyStagingContents(staging, files);
  if (fs.existsSync(path.join(staging, 'revisions', '1'))) {
    const saved = readRevision(staging);
    if (saved.revision !== 1 || JSON.stringify(saved.model) !== JSON.stringify(model) ||
        JSON.stringify(readJson(path.join(saved.directory, 'review.json'))) !== JSON.stringify(review)) {
      throw new ReviewError('初稿恢复目录与输入不一致，已保留：' + staging);
    }
    inventory(staging);
  } else {
    publish(staging, 0, model, review);
  }
  fs.renameSync(staging, task);
  return { taskDirectory: task, revision: 1, directory: path.join(task, 'revisions', '1') };
}

function inventory(task) {
  assertPlain(task, 'directory');
  const records = [];
  const add = relative => {
    const file = inside(task, path.join(task, relative));
    assertPlain(file, 'file');
    records.push({ relative, sha256: digest(fs.readFileSync(file)) });
  };
  const revisions = path.join(task, 'revisions');
  assertPlain(revisions, 'directory');
  const numbers = fs.readdirSync(revisions).sort((a, b) => Number(a) - Number(b));
  if (!numbers.length || numbers.some((value, index) => value !== String(index + 1))) {
    throw new ReviewError('版本目录含非连续版本或未完成发布，请先检查，迁移不会删除这些文件。');
  }
  let projectId;
  for (const number of numbers) {
    const directory = path.join(revisions, number);
    assertPlain(directory, 'directory');
    if (fs.readdirSync(directory).sort().join('|') !== [...snapshotFiles].sort().join('|')) {
      throw new ReviewError('版本目录包含未识别文件，迁移已停止：' + directory);
    }
    snapshotFiles.forEach(file => add(path.join('revisions', number, file)));
    const current = readRevision(task, Number(number));
    projectId ??= current.model.report.id;
    if (projectId !== current.model.report.id || fs.readFileSync(path.join(directory, 'flow.md'), 'utf8') !== renderFlow(current.model).markdown) {
      throw new ReviewError('历史版本的项目或同版文档校验失败：' + number);
    }
  }
  const batches = path.join(task, 'batches');
  if (fs.existsSync(batches)) {
    assertPlain(batches, 'directory');
    for (const id of fs.readdirSync(batches)) {
      if (!uuid.test(id)) throw new ReviewError('批次目录含未完成写入或未知文件，请先检查。');
      const directory = path.join(batches, id);
      assertPlain(directory, 'directory');
      if (fs.readdirSync(directory).join('|') !== 'batch.json') throw new ReviewError('批次目录含未识别文件：' + id);
      add(path.join('batches', id, 'batch.json'));
      const batch = readJson(path.join(directory, 'batch.json'));
      if (batch.id !== id || batch.projectId !== projectId ||
          batch.modelSha256 !== digest(JSON.stringify(readRevision(task, batch.revision).model))) {
        throw new ReviewError('批次与原版模型不一致：' + id);
      }
    }
  }
  return { projectId, records };
}

function verifyCopies(task, records) {
  for (const record of records) {
    const file = inside(task, path.join(task, record.relative));
    assertPlain(path.dirname(file), 'directory');
    assertPlain(file, 'file');
    if (digest(fs.readFileSync(file)) !== record.sha256) throw new ReviewError('迁移期间文件发生变化，保留原目录：' + file, 409);
  }
}

function cleanupLegacy(legacy, task, records) {
  if (!Array.isArray(records) || !records.length) throw new ReviewError('迁移清单缺失，保留旧副本。');
  for (const record of records) {
    const parts = typeof record.relative === 'string' ? record.relative.split(/[\\/]/) : [];
    if (parts.length !== 3 || !/^[a-f0-9]{64}$/.test(record.sha256) ||
        !(parts[0] === 'revisions' && /^[1-9]\d*$/.test(parts[1]) && snapshotFiles.includes(parts[2]) ||
          parts[0] === 'batches' && uuid.test(parts[1]) && parts[2] === 'batch.json')) {
      throw new ReviewError('迁移清单含不属于历史记录的文件，未清理。');
    }
  }
  verifyCopies(task, records);
  const remaining = records.filter(record => {
    const parts = record.relative.split(/[\\/]/);
    for (let length = 1; length < parts.length; length++) {
      const directory = inside(legacy, path.join(legacy, ...parts.slice(0, length)));
      if (fs.existsSync(directory)) assertPlain(directory, 'directory');
    }
    return fs.existsSync(inside(legacy, path.join(legacy, record.relative)));
  });
  verifyCopies(legacy, remaining);
  // Unlink only the known, byte-identical files. Missing entries are a resumed cleanup.
  for (const record of remaining) fs.unlinkSync(inside(legacy, path.join(legacy, record.relative)));
  const directories = [...new Set(records.map(record => path.dirname(path.join(legacy, record.relative))))];
  for (const directory of directories) if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(inside(legacy, directory));
  for (const name of ['revisions', 'batches']) {
    const directory = inside(legacy, path.join(legacy, name));
    if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  }
}

function finishMigration(legacy, task, records, migrated) {
  const result = { taskDirectory: task, migrated, revision: readRevision(task).revision, verifiedFiles: records.length, legacyDirectory: legacy };
  try { cleanupLegacy(legacy, task, records); }
  catch (error) { result.cleanupPending = true; result.warning = '已迁移，旧副本清理未完成，可重试 migrate：' + error.message; }
  result.retainedLegacyEntries = fs.readdirSync(legacy).filter(name => name !== locationFile);
  return result;
}

function migrate(projectRoot, legacyDirectory) {
  const legacy = path.resolve(legacyDirectory);
  const resolved = resolveTask(legacy);
  if (resolved !== legacy) return finishMigration(legacy, resolved, readJson(path.join(legacy, locationFile)).files, false);
  if (fs.existsSync(path.join(legacy, 'draft'))) throw new ReviewError('请先提交或放弃旧任务草稿，再迁移。');
  const { projectId, records } = inventory(legacy);
  const task = taskDirectory(projectRoot, projectId);
  if (task === legacy) return { taskDirectory: task, migrated: false, reason: 'already-managed' };
  fs.mkdirSync(path.dirname(task), { recursive: true });
  if (fs.existsSync(task)) {
    // Resume an interruption after destination publication, before redirect creation.
    assertPlain(task, 'directory');
    const stored = taskMetadata(task);
    if (stored.migratedFrom !== legacy || stored.projectId !== projectId) throw new ReviewError('目标任务已存在，不能合并或覆盖。', 409);
    verifyCopies(task, records);
  } else {
    const staging = prepareStaging(task, 'migrate', metadata(projectRoot, projectId, {
      migratedFrom: legacy, migrationInventorySha256: digest(JSON.stringify(records)),
    }));
    try {
      verifyStagingContents(staging, records.map(record => record.relative));
      for (const record of records) {
        const destination = inside(staging, path.join(staging, record.relative));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (fs.existsSync(destination)) verifyCopies(staging, [record]);
        else fs.copyFileSync(path.join(legacy, record.relative), destination, fs.constants.COPYFILE_EXCL);
      }
      verifyCopies(staging, records);
      fs.renameSync(staging, task);
    } catch (error) {
      // Retry the same command to resume this fixed path. Never remove unknown files.
      error.message += '\n迁移恢复目录（如仍存在）：' + staging;
      throw error;
    }
  }
  verifyCopies(legacy, records);
  writeJson(path.join(legacy, locationFile), { schemaVersion: 1, kind: 'document-review-location', projectId, taskDirectory: task, files: records });
  // Delete only byte-verified, enumerated copies after the destination and redirect exist.
  // No recursive removal and no deletion of legacy scripts or user-created candidates.
  return finishMigration(legacy, task, records, true);
}

module.exports = { workspaceName, taskDirectory, resolveTask, initialize, migrate };
