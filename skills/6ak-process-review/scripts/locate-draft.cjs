'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { digest } = require('./index-sources.cjs');
const { taskDirectory, workspaceName } = require('./review-workspace.cjs');
const { validateModel } = require('./validate-model.cjs');

const taskName = /^[A-Za-z0-9_-]+$/;
const revisionName = /^[1-9]\d*$/;
const isTaskId = value => typeof value === 'string' && taskName.test(value);

function plain(file, type) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!(type === 'directory' ? stat.isDirectory() : stat.isFile())) {
    throw new Error(`定位工作稿需要普通${type === 'directory' ? '目录' : '文件'}，不能读取链接：${file}`);
  }
  return true;
}

function readJson(file) {
  if (!plain(file, 'file')) return undefined;
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error('工作稿定位记录不是有效的 JSON：' + file);
  }
}

function formalTask(task, exact) {
  const location = readJson(path.join(task, 'task-location.json'));
  if (location !== undefined) {
    if (location?.schemaVersion !== 1 || location.kind !== 'document-review-location' || !isTaskId(location.projectId) ||
      typeof location.taskDirectory !== 'string' || !path.isAbsolute(location.taskDirectory)) {
      throw new Error('旧审阅任务的位置记录无法核对：' + task);
    }
    // Leave redirects to the formal status command, which validates both sides.
    // Scanning a project does not chase or count the same task's old location.
    return exact ? { kind: 'formal', taskDirectory: task, projectId: location.projectId, legacy: true } : undefined;
  }
  const metadata = readJson(path.join(task, 'task.json'));
  if (metadata !== undefined) {
    const projectRoot = path.dirname(path.dirname(task));
    if (metadata?.schemaVersion !== 1 || metadata.kind !== 'document-review-task' ||
      typeof metadata.projectRoot !== 'string' || !path.isAbsolute(metadata.projectRoot) ||
      path.resolve(metadata.projectRoot) !== projectRoot || taskDirectory(projectRoot, metadata.projectId) !== task) {
      throw new Error('正式审阅任务的身份或位置不一致：' + task);
    }
    return { kind: 'formal', taskDirectory: task, projectId: metadata.projectId };
  }
  const revisions = path.join(task, 'revisions');
  if (!plain(revisions, 'directory')) return;
  const newest = fs.readdirSync(revisions, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && revisionName.test(entry.name))
    .map(entry => Number(entry.name)).filter(Number.isSafeInteger).reduce((latest, current) => Math.max(latest, current), 0);
  if (!newest) return;
  const base = path.join(revisions, String(newest));
  const model = readJson(path.join(base, 'model.json'));
  if (!isTaskId(model?.report?.id) || !plain(path.join(base, 'review.json'), 'file') ||
    !plain(path.join(base, 'state.json'), 'file')) {
    throw new Error('旧审阅任务的已发布快照不完整：' + task);
  }
  return { kind: 'formal', taskDirectory: task, projectId: model.report.id, title: model.report.title, legacy: true };
}

function workbenchTask(task) {
  const workbench = path.join(task, 'workbench');
  if (!plain(workbench, 'directory')) return;
  const stateFile = path.join(workbench, 'state.json');
  const state = readJson(stateFile);
  if (state === undefined) return;
  if (state?.workspaceSchemaVersion !== 1 || !Number.isSafeInteger(state.workRevision) || state.workRevision < 1 ||
    !Number.isSafeInteger(state.stateRevision) || state.stateRevision < state.workRevision ||
    !isTaskId(state.taskId) || state.model?.report?.id !== state.taskId ||
    digest(JSON.stringify(state.model)) !== state.modelHash || !validateModel(state.model).ok) {
    throw new Error('独立工作台的工作稿身份、版本或模型摘要无法核对：' + stateFile);
  }
  return { kind: 'workbench', taskDirectory: task, projectId: state.taskId, title: state.model.report.title,
    workRevision: state.workRevision, modelHash: state.modelHash, stateFile };
}

function locateDraft(mode, location, kind) {
  if (!['--project', '--task'].includes(mode) || typeof location !== 'string' || !path.isAbsolute(location) ||
    (kind !== undefined && !['formal', 'workbench'].includes(kind))) {
    throw new Error('用法：node locate-draft.cjs --project <绝对项目根目录> 或 --task <绝对任务目录> [--kind formal|workbench]');
  }
  const directory = path.resolve(location);
  if (directory === path.parse(directory).root || !plain(directory, 'directory')) throw new Error('请使用本次任务明确关联的已有项目或任务目录。');
  const root = fs.realpathSync(directory);
  const workspace = path.join(root, workspaceName);
  const exact = mode === '--task';
  const tasks = exact ? [root] : plain(workspace, 'directory')
    ? fs.readdirSync(workspace, { withFileTypes: true }).filter(entry => entry.isDirectory() && taskName.test(entry.name))
      .map(entry => path.join(workspace, entry.name)).sort() : [];
  const candidates = [];
  for (const task of tasks) {
    const formal = kind === 'workbench' ? undefined : formalTask(task, exact);
    const workbench = kind === 'formal' ? undefined : workbenchTask(task);
    if (formal) candidates.push(formal);
    if (workbench) candidates.push(workbench);
  }
  return { status: candidates.length === 1 ? 'unique' : candidates.length ? 'ambiguous' : 'not-found', candidates };
}

if (require.main === module) {
  try {
    const [mode, location, flag, kind, ...extra] = process.argv.slice(2);
    if (extra.length || (flag !== undefined && (flag !== '--kind' || !kind))) throw new Error('选用任务类型时需传入 --kind formal 或 --kind workbench。');
    console.log(JSON.stringify(locateDraft(mode, location, kind), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { locateDraft };
