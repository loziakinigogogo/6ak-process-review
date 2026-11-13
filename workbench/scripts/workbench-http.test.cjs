'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { startServer, runningService } = require('./workbench.cjs');
const { validateModel } = require('../../skills/6ak-process-review/scripts/validate-model.cjs');
const { createDemoModel } = require('./workbench-demo-fixture.cjs');

const qaRoot = path.resolve(process.env.PRICING_QA_DIR || path.join(__dirname, '..', '..', '.qa'), 'workbench-http');
fs.mkdirSync(qaRoot, { recursive: true });
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(qaRoot, 'run-'));
  const app = await startServer({ taskDirectory: directory });
  t.after(async () => { await app.close(); });
  const state = await (await fetch(app.url + '/api/workbench/state')).json();
  assert.equal(typeof state.workspaceId, 'string');
  assert.ok(state.workspaceId.length > 0);
  const request = async (route, input, method = 'POST', origin = app.url) => fetch(app.url + route, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Workbench-Id': state.workspaceId }, body: JSON.stringify(input),
  });
  return { app, directory, request, workspaceId: state.workspaceId };
}

test('HTTP: copying a reference stores a snapshot without creating a conversation or content change', async t => {
  const { app, request } = await fixture(t);
  const before = app.store.read();
  const response = await request('/api/workbench/references', { baseWorkRevision: before.workRevision, baseModelHash: before.modelHash, targets: [{ type: 'node', id: 'validate' }] });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.match(saved.handoff, /process-review-workbench-ref:v1/);
  const fetched = await fetch(app.url + '/api/workbench/references/' + saved.id).then(r => r.json());
  assert.equal(fetched.targets[0].id, 'validate');
  assert.equal(fetched.stale, false);
  assert.deepEqual(app.store.read(), before);
  const state = await fetch(app.url + '/api/workbench/state').then(r => r.json());
  assert.equal(state.contentOrigin.kind, 'synthetic');
  assert.deepEqual(state.contentOrigin.sourceNames, before.model.sources.map(source => source.name));
});

test('HTTP: an imported model has its own identity and cannot silently reuse a synthetic task', async t => {
  const { app, directory } = await fixture(t);
  const before = app.store.read();
  await app.close();
  const imported = createDemoModel();
  imported.report.id = 'isolated-import-format-test';
  await assert.rejects(startServer({ taskDirectory: directory, model: imported }), /另一份流程模型/);
  const importedDirectory = fs.mkdtempSync(path.join(qaRoot, 'import-'));
  const importedApp = await startServer({ taskDirectory: importedDirectory, model: imported });
  t.after(() => importedApp.close());
  const state = await fetch(importedApp.url + '/api/workbench/state').then(r => r.json());
  assert.equal(state.model.report.id, imported.report.id);
  assert.equal(state.contentOrigin.kind, 'documents');
  assert.deepEqual(state.view.positions, {});
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'workbench', 'state.json'), 'utf8')).modelHash, before.modelHash);
});

test('HTTP: only current-origin mutations may write; invalid JSON does not change the model', async t => {
  const { app, request, workspaceId } = await fixture(t);
  const before = app.store.read();
  const edit = { requestId: randomUUID(), baseWorkRevision: before.workRevision, baseModelHash: before.modelHash, nodeId: 'validate', title: '不应保存' };
  assert.equal((await request('/api/workbench/edits', edit, 'POST', 'https://foreign.example')).status, 403);
  const invalid = await fetch(app.url + '/api/workbench/edits', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Workbench-Id': workspaceId }, body: '{' });
  assert.equal(invalid.status, 400);
  assert.equal(app.store.read().modelHash, before.modelHash);
  const health = await fetch(app.url + '/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).workspaceId, workspaceId);
});

test('HTTP: save emits a data event, downloaded model matches state, and stale writes fail', async t => {
  const { app, request } = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const timeout = setTimeout(() => controller.abort(), 5000);
  t.after(() => clearTimeout(timeout));
  const events = await fetch(app.url + '/api/workbench/events', { signal: controller.signal });
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  await reader.read();
  const before = app.store.read();
  const edit = { requestId: randomUUID(), baseWorkRevision: before.workRevision, baseModelHash: before.modelHash, nodeId: 'validate', title: '核对本次降幅' };
  const savedResponse = await request('/api/workbench/edits', edit);
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.equal(saved.model.nodes.find(node => node.id === 'validate').title, edit.title);
  let update = '';
  while (!update.includes('"workRevision":' + saved.workRevision)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    update += decoder.decode(chunk.value, { stream: true });
  }
  assert.match(update, /event: state/);
  assert.match(update, new RegExp('"workRevision":' + saved.workRevision));
  const downloaded = await (await fetch(app.url + '/api/model')).json();
  assert.deepEqual(downloaded, saved.model);
  assert.equal(validateModel(downloaded).ok, true);
  assert.equal((await request('/api/workbench/edits', { ...edit, requestId: randomUUID(), title: '旧版本覆盖' })).status, 409);
  controller.abort();
  await reader.cancel().catch(() => {});
});

test('HTTP: runtime identifies the running task and restart restores persisted edits', async t => {
  const { app, directory, request, workspaceId } = await fixture(t);
  const runtime = await runningService(directory);
  assert.equal(runtime.url, app.url);
  const before = app.store.read();
  const response = await request('/api/workbench/edits', { requestId: randomUUID(), baseWorkRevision: before.workRevision, baseModelHash: before.modelHash, nodeId: 'manual', title: '手工录入目标售价' });
  assert.equal(response.status, 200);
  await app.close();
  const restarted = await startServer({ taskDirectory: directory });
  t.after(() => restarted.close());
  assert.equal(restarted.store.read().model.nodes.find(node => node.id === 'manual').title, '手工录入目标售价');
  assert.equal(restarted.store.read().modelHash, (await response.json()).modelHash);
  assert.equal((await (await fetch(restarted.url + '/api/workbench/state')).json()).workspaceId, workspaceId);
});

test('HTTP: an old page cannot save into another task with the same model and revision', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const firstState = first.app.store.read();
  const secondState = second.app.store.read();
  assert.equal(firstState.modelHash, secondState.modelHash);
  assert.equal(firstState.workRevision, secondState.workRevision);
  assert.equal(firstState.taskId, secondState.taskId);
  assert.notEqual(first.workspaceId, second.workspaceId);
  const input = { requestId: randomUUID(), baseWorkRevision: firstState.workRevision, baseModelHash: firstState.modelHash, nodeId: 'validate', title: '来自旧任务页面的输入' };
  const response = await fetch(second.app.url + '/api/workbench/edits', {
    method: 'POST', headers: { Origin: second.app.url, 'Content-Type': 'application/json', 'X-Workbench-Id': first.workspaceId }, body: JSON.stringify(input),
  });
  assert.equal(response.status, 409);
  assert.equal(second.app.store.read().modelHash, secondState.modelHash);
  assert.equal(second.app.store.read().workRevision, secondState.workRevision);
  assert.equal(first.app.store.read().modelHash, firstState.modelHash);
  assert.equal((await second.request('/api/workbench/edits', { ...input, requestId: randomUUID() })).status, 200);
});

test('HTTP: mutations without a workspace identity cannot edit, cache inputs, or change the view', async t => {
  const { app } = await fixture(t);
  const before = app.store.read();
  const cases = [
    ['POST', '/api/workbench/edits', { requestId: randomUUID(), baseWorkRevision: before.workRevision, baseModelHash: before.modelHash, nodeId: 'validate', title: '无任务身份的保存' }],
    ['PUT', '/api/workbench/buffers', { sessionId: 'identity-test', nodeId: 'validate', revision: 1, draft: { title: '无任务身份的输入' } }],
    ['PATCH', '/api/workbench/view', { selectedGroupId: 'verify' }],
  ];
  for (const [method, route, input] of cases) {
    const response = await fetch(app.url + route, { method, headers: { Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 409, method + ' ' + route);
  }
  assert.equal(app.store.read().stateRevision, before.stateRevision);
  assert.deepEqual(app.store.buffers('identity-test'), {});
});

test('HTTP: a formal task cannot be initialized with the synthetic demo model', async () => {
  const directory = fs.mkdtempSync(path.join(qaRoot, 'formal-'));
  const originalTask = JSON.stringify({ id: 'existing-business-task', status: 'reviewing', source: 'original.txt' }, null, 2) + '\n';
  fs.writeFileSync(path.join(directory, 'task.json'), originalTask);
  await assert.rejects(startServer({ taskDirectory: directory }), /不自动接管正式审阅任务/);
  assert.equal(fs.readFileSync(path.join(directory, 'task.json'), 'utf8'), originalTask);
  assert.equal(fs.existsSync(path.join(directory, 'workbench')), false);
  assert.equal(fs.existsSync(path.join(directory, '.workbench-server.lock')), false);
});

test('HTTP: first local layout has no undo, survives restart, and cannot replace a saved or manually moved layout', async t => {
  const { app, request, directory, workspaceId } = await fixture(t);
  const before = app.store.read();
  const input = { requestId: randomUUID(), layout: {
    scopeId: 'execute', action: 'initialize', baseRevision: 0, baseModelHash: before.modelHash,
    positions: { validate: { x: 410, y: 510 } },
    routes: { 'validate--dispatch': { points: [{ x: 650, y: 550 }, { x: 700, y: 550 }], geometryKey: 'http-initial-layout' } },
  } };
  assert.equal((await request('/api/workbench/view', { ...input, layout: { ...input.layout, baseModelHash: undefined } }, 'PATCH')).status, 409);
  assert.deepEqual(app.store.read(), before);
  const response = await request('/api/workbench/view', input, 'PATCH');
  assert.equal(response.status, 200);
  const initialized = await response.json();
  assert.equal(initialized.view.layouts.execute.revision, 1);
  assert.equal(initialized.view.layouts.execute.previous, undefined);
  assert.deepEqual(initialized.view.positions, before.view.positions);
  assert.equal(initialized.modelHash, before.modelHash);
  assert.equal(initialized.workRevision, before.workRevision);
  assert.deepEqual(initialized.model, before.model);
  assert.deepEqual(initialized.changes, before.changes);
  const initializedState = app.store.read();
  assert.equal((await request('/api/workbench/view', { layout: { scopeId: 'execute', action: 'undo', baseRevision: 1 } }, 'PATCH')).status, 409);
  assert.equal((await request('/api/workbench/view', { ...input, requestId: randomUUID() }, 'PATCH')).status, 409);
  assert.deepEqual(app.store.read(), initializedState);
  const movedResponse = await request('/api/workbench/view', { layout: { scopeId: 'prepare', action: 'move', baseRevision: 0, positions: { calculate: { x: 73.125, y: 94.875 } } } }, 'PATCH');
  assert.equal(movedResponse.status, 200);
  const moved = app.store.read();
  for (const baseRevision of [0, 1]) {
    assert.equal((await request('/api/workbench/view', { requestId: randomUUID(), layout: { ...input.layout, scopeId: 'prepare', baseRevision, positions: { calculate: { x: 200, y: 300 } }, routes: {} } }, 'PATCH')).status, 409);
    assert.deepEqual(app.store.read(), moved);
  }
  await app.close();
  const restarted = await startServer({ taskDirectory: directory });
  t.after(() => restarted.close());
  assert.deepEqual(restarted.store.read(), moved);
  const duplicate = await fetch(restarted.url + '/api/workbench/view', {
    method: 'PATCH', headers: { Origin: restarted.url, 'Content-Type': 'application/json', 'X-Workbench-Id': workspaceId },
    body: JSON.stringify({ ...input, requestId: randomUUID(), layout: { ...input.layout, baseRevision: 1 } }),
  });
  assert.equal(duplicate.status, 409, 'a fresh revision cannot authorize initialization over an existing layout');
  assert.deepEqual(restarted.store.read(), moved);
});

test('HTTP: scoped layout saves survive restart, reject stale arrangements, and leave content revisions unchanged', async t => {
  const { app, request, directory } = await fixture(t);
  const before = app.store.read();
  const input = { requestId: randomUUID(), layout: {
    scopeId: 'execute', action: 'arrange', baseRevision: 0, baseModelHash: before.modelHash,
    positions: { validate: { x: 410, y: 510 } },
    routes: { 'validate--dispatch': { points: [{ x: 650, y: 550 }, { x: 700, y: 550 }, { x: 700, y: 650 }], geometryKey: 'http-layout-geometry' } },
  } };
  const response = await request('/api/workbench/view', input, 'PATCH');
  assert.equal(response.status, 200);
  const arranged = await response.json();
  assert.equal(arranged.workRevision, before.workRevision);
  assert.equal(arranged.modelHash, before.modelHash);
  assert.equal(arranged.view.layouts.execute.revision, 1);
  assert.deepEqual(arranged.view.positions, before.view.positions);
  assert.equal((await request('/api/workbench/view', { ...input, requestId: randomUUID() }, 'PATCH')).status, 409);
  const moved = await request('/api/workbench/view', { layout: { scopeId: 'execute', action: 'move', baseRevision: 1, positions: { validate: { x: 470, y: 580 } } } }, 'PATCH');
  assert.equal(moved.status, 200);
  assert.deepEqual((await moved.json()).view.layouts.execute.manualNodeIds, ['validate']);
  const invalid = JSON.parse('{"layout":{"scopeId":"execute","action":"move","baseRevision":2,"positions":{"__proto__":{"x":1,"y":2}}}}');
  assert.equal((await request('/api/workbench/view', invalid, 'PATCH')).status, 400);
  const persisted = app.store.read();
  await app.close();
  const restarted = await startServer({ taskDirectory: directory });
  t.after(() => restarted.close());
  assert.deepEqual(restarted.store.read(), persisted);
  const reread = await fetch(restarted.url + '/api/workbench/state').then(result => result.json());
  assert.deepEqual(reread.view.layouts.execute.positions.validate, { x: 470, y: 580 });
  assert.deepEqual(reread.view.layouts.execute.routes, {});
  assert.equal(reread.workRevision, before.workRevision);
  assert.equal(reread.modelHash, before.modelHash);
});
