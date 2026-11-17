'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { locateDraft } = require('./locate-draft.cjs');
const { digest } = require('./index-sources.cjs');
const { initialize } = require('./review-workspace.cjs');
const { beginDraft } = require('./grouped-review-draft.cjs');

const example = require('../examples/messy-pricing.model.json');

function fixture(t) {
  const qa = path.resolve(__dirname, '../../../.qa');
  fs.mkdirSync(qa, { recursive: true });
  const project = fs.realpathSync(fs.mkdtempSync(path.join(qa, 'draft-location-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  return project;
}

function model(id) {
  const copy = structuredClone(example);
  copy.report = { ...copy.report, id, title: '合成流程 ' + id };
  return copy;
}

function workbench(task, id, workRevision, stateRevision = workRevision) {
  const stateFile = path.join(task, 'workbench', 'state.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const content = model(id);
  const modelHash = digest(JSON.stringify(content));
  fs.writeFileSync(stateFile, JSON.stringify({
    workspaceSchemaVersion: 1, taskId: id, workRevision, stateRevision, modelHash, model: content,
  }));
  return { kind: 'workbench', taskDirectory: task, projectId: id, title: content.report.title, workRevision, modelHash, stateFile };
}

function cli(script, ...args) {
  return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, script + '.cjs'), ...args], { encoding: 'utf8' }));
}

test('a formal task resolves independently of its version, and status points to its latest managed draft', t => {
  const project = fixture(t);
  const { taskDirectory } = initialize(project, model('formal-trial'));
  const draft = beginDraft(taskDirectory);
  const active = JSON.parse(fs.readFileSync(draft.modelFile));
  active.nodes[0].title = '已在当前草稿改写';
  fs.writeFileSync(draft.modelFile, JSON.stringify(active));

  const formal = { kind: 'formal', taskDirectory, projectId: 'formal-trial' };
  assert.deepEqual(cli('locate-draft', '--project', project), { status: 'unique', candidates: [formal] });
  const status = cli('grouped-review', 'status', taskDirectory);
  assert.equal(status.revision, 1);
  assert.equal(status.draft.status, 'active');
  assert.equal(status.draft.modelFile, draft.modelFile);
  assert.equal(JSON.parse(fs.readFileSync(status.draft.modelFile)).nodes[0].title, '已在当前草稿改写');
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(taskDirectory, 'revisions', '1', 'model.json'))).nodes[0].title, active.nodes[0].title);
});

test('a newer saved Workbench version stays distinct from formal publication even with the same identity', t => {
  const project = fixture(t);
  const { taskDirectory } = initialize(project, model('same-name'));
  const workbenchTask = workbench(taskDirectory, 'same-name', 23, 31);
  const formalTask = { kind: 'formal', taskDirectory, projectId: 'same-name' };
  const saved = fs.readFileSync(workbenchTask.stateFile);
  assert.deepEqual(locateDraft('--project', project), { status: 'ambiguous', candidates: [formalTask, workbenchTask] });
  assert.deepEqual(locateDraft('--task', taskDirectory, 'workbench'), { status: 'unique', candidates: [workbenchTask] });
  assert.deepEqual(locateDraft('--task', taskDirectory, 'formal'), { status: 'unique', candidates: [formalTask] });
  assert.deepEqual(fs.readFileSync(workbenchTask.stateFile), saved);
  assert.deepEqual(fs.readdirSync(path.dirname(workbenchTask.stateFile)), ['state.json']);
});

test('only direct project tasks participate in discovery and a stopped independent Workbench can be located explicitly', t => {
  const project = fixture(t);
  const independent = workbench(path.join(project, 'isolated'), 'only-workbench', 8, 12);
  fs.mkdirSync(path.join(project, 'deliverables', 'v2'), { recursive: true });
  fs.writeFileSync(path.join(project, 'deliverables', 'v2', 'model.json'), JSON.stringify(model('delivered')));
  assert.deepEqual(locateDraft('--project', project), { status: 'not-found', candidates: [] });
  assert.deepEqual(locateDraft('--task', independent.taskDirectory), { status: 'unique', candidates: [independent] });
  assert.equal(JSON.parse(fs.readFileSync(independent.stateFile)).model.report.id, 'only-workbench');
});

test('project resolution keeps alternatives and refuses corrupt identity records instead of selecting another task', t => {
  const project = fixture(t);
  const { taskDirectory } = initialize(project, model('formal-old'));
  const workbenchTask = workbench(path.join(project, '.document-review', 'workbench-new'), 'workbench-new', 80);
  assert.deepEqual(locateDraft('--project', project).candidates.map(({ kind, taskDirectory }) => [kind, taskDirectory]),
    [['formal', taskDirectory], ['workbench', workbenchTask.taskDirectory]]);
  const broken = JSON.parse(fs.readFileSync(workbenchTask.stateFile));
  broken.modelHash = '0'.repeat(64);
  fs.writeFileSync(workbenchTask.stateFile, JSON.stringify(broken));
  assert.throws(() => locateDraft('--project', project), /模型摘要无法核对/);
  assert.equal(locateDraft('--project', project, 'formal').status, 'unique');
  assert.throws(() => locateDraft('--project', '.'), /绝对项目根目录/);
});

test('older formal snapshots stay discoverable and migration redirects are only passed through for explicit tasks', t => {
  const project = fixture(t);
  const { taskDirectory } = initialize(project, model('formal-managed'));
  const old = path.join(project, '.document-review', 'pre-migration');
  fs.mkdirSync(old);
  fs.cpSync(path.join(taskDirectory, 'revisions'), path.join(old, 'revisions'), { recursive: true });
  const result = locateDraft('--task', old).candidates[0];
  assert.equal(result.legacy, true);
  assert.equal(result.projectId, 'formal-managed');
  fs.rmSync(path.join(old, 'revisions'), { recursive: true });
  fs.writeFileSync(path.join(old, 'task-location.json'), JSON.stringify({
    schemaVersion: 1, kind: 'document-review-location', projectId: 'formal-managed', taskDirectory,
  }));
  assert.equal(locateDraft('--project', project).status, 'unique');
  assert.equal(locateDraft('--task', old).candidates[0].legacy, true);
});
