'use strict';

// Use isolated synthetic tasks. This check never opens the user's preview task.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { chromium, expect } = require('@playwright/test');
const { startServer } = require('../workbench/scripts/workbench.cjs');

const layout = (state, scope = 'execute') => state.view.layouts?.[scope];
const business = state => ({ model: state.model, modelHash: state.modelHash, workRevision: state.workRevision,
  pendingEdits: state.pendingEdits, changes: state.changes, contentTree: state.contentTree, materials: state.materials });

async function main() {
  const directory = path.resolve('.qa/workbench-auto-layout-browser', `run-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  const checks = [], errors = [], requests = [], measurements = [];
  let app, context, page, scenario;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
    (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
  headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
  const state = () => fetch(app.url + '/api/workbench/state').then(response => response.json());
  const request = async (endpoint, body, method = 'POST') => {
    const response = await fetch(app.url + '/api/workbench/' + endpoint, { method,
      headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Workbench-Id': app.runtime.workspaceId }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const guard = async values => { const s = await state(); return { requestId: randomUUID(), baseWorkRevision: s.workRevision, baseModelHash: s.modelHash, ...values }; };
  const editTitle = async title => request('edits', await guard({ nodeId: 'validate', title, intent: 'current', scope: 'copy' }));
  const check = name => { checks.push(name); console.log('PASS ' + name); };
  const closeTask = async () => { if (context) { await context.close(); context = null; } if (app) { await app.close(); app = null; } };
  const openTask = async (name, prepare) => {
    await closeTask(); scenario = name;
    const taskDirectory = path.join(directory, name, 'task');
    app = await startServer({ taskDirectory, dev: process.env.AUTO_LAYOUT_DEV === '1' });
    const file = path.join(taskDirectory, 'workbench/state.json'), fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
    fixture.view.defaultLayoutDirection = 'DOWN';
    fs.writeFileSync(file, JSON.stringify(fixture, null, 2));
    if (prepare) await prepare();
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push({ scenario: name, message: error.message }));
    page.on('request', value => {
      if (value.method() !== 'PATCH' || !value.url().endsWith('/api/workbench/view')) return;
      const body = value.postDataJSON();
      if (body.layout) requests.push({ scenario: name, ...body.layout });
    });
    await page.goto(app.url);
  };
  const ready = async (scope = 'execute') => {
    await expect.poll(async () => typeof layout(await state(), scope)?.inputKey, { timeout: 30000 }).toBe('string');
    await expect.poll(async () => !!layout(await state(), scope)?.needsMeasurement, { timeout: 30000 }).toBe(false);
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await expect(page.getByTestId('arrange-layout')).toBeEnabled({ timeout: 30000 });
    await expect(page.locator('[data-route-mode="pending"]')).toHaveCount(0, { timeout: 30000 });
    return layout(await state(), scope);
  };
  const settled = async (scope = 'execute') => {
    await ready(scope);
    const before = layout(await state(), scope);
    await page.waitForTimeout(1100); // Includes debounce, DOM observation, and SSE round trip.
    assert.deepEqual(layout(await state(), scope), before, 'stable geometry must not schedule another layout write');
    return before;
  };
  const refreshed = async before => {
    await expect.poll(async () => layout(await state())?.revision || 0, { timeout: 30000 }).toBeGreaterThan(before.revision);
    const result = await settled();
    assert.notEqual(result.inputKey, before.inputKey);
    return result;
  };
  const viewport = () => page.locator('.react-flow__viewport').evaluate(element => {
    const m = new DOMMatrixReadOnly(getComputedStyle(element).transform); return { x: m.e, y: m.f, zoom: m.a };
  });
  const boxes = () => page.locator('.react-flow__node').evaluateAll(elements => elements.map(element => {
    const m = new DOMMatrixReadOnly(element.style.transform);
    return { id: element.dataset.id, x: m.e, y: m.f, width: element.offsetWidth, height: element.offsetHeight };
  }));
  const clearBoxes = async label => {
    const values = await boxes(), collisions = [];
    for (const [i, a] of values.entries()) for (const b of values.slice(i + 1)) {
      if (a.x < b.x + b.width - 1 && a.x + a.width > b.x + 1 && a.y < b.y + b.height - 1 && a.y + a.height > b.y + 1) collisions.push([a.id, b.id]);
    }
    measurements.push({ label, boxes: values, collisions }); assert.deepEqual(collisions, [], label);
  };
  const switchGroup = async scope => {
    const item = page.getByTestId('group-' + scope);
    if (!(await item.isVisible())) await page.getByRole('button', { name: '展开分组导航', exact: true }).click();
    await item.click(); await expect(item).toHaveAttribute('aria-current', 'page'); await settled(scope);
  };
  const holdRefresh = async () => {
    let release, arrived, finished;
    const gate = new Promise(resolve => { release = resolve; });
    const at = new Promise(resolve => { arrived = resolve; });
    const done = new Promise(resolve => { finished = resolve; });
    let held = false;
    const handler = async route => {
      const body = route.request().postDataJSON();
      if (body?.layout?.action !== 'refresh' || held) return route.continue();
      held = true; arrived(body.layout); await gate;
      const response = await route.fetch(); await route.fulfill({ response }); finished(response.status());
    };
    await page.route('**/api/workbench/view', handler);
    const timeout = async promise => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Held refresh timed out')), 25000); })]); }
      finally { clearTimeout(timer); }
    };
    return { arrived: () => timeout(at), release, finished: () => timeout(done), remove: () => page.unroute('**/api/workbench/view', handler) };
  };
  try {
    await openTask('lifecycle');
    const initial = await state(), first = await settled();
    assert.deepEqual(business(await state()), business(initial));
    assert.equal(first.previous, undefined);
    assert.equal(requests.filter(r => r.scenario === scenario && r.action === 'initialize').length, 1);
    await clearBoxes('initial');
    check('first measured layout persists an input signature and stabilizes without changing content');

    const beforeHeight = (await boxes()).find(n => n.id === 'validate').height;
    const beforeViewport = await viewport();
    const changed = await editTitle('校验全部调价输入与跨部门复核结果并逐项记录异常信息');
    const afterTitle = await refreshed(first);
    assert.ok((await boxes()).find(n => n.id === 'validate').height > beforeHeight, 'fixture must change real DOM height');
    assert.deepEqual(await viewport(), beforeViewport, 'automatic refresh must not fit or move the viewport');
    assert.deepEqual(business(await state()), business(changed));
    await clearBoxes('title-expanded');
    await page.screenshot({ path: path.join(directory, '01-auto-refreshed.png'), fullPage: false });
    check('a real SSE content update changes measured card height and refreshes positions once without stealing viewport');

    await editTitle('核验全部调价输入与跨部门复核结果并逐项记录异常信息');
    await expect(page.getByTestId('graph-node-validate')).toContainText('核验全部');
    await page.waitForTimeout(900);
    assert.deepEqual(layout(await state()), afterTitle, 'same-size text change does not require another arrangement');
    await page.setViewportSize({ width: 1500, height: 920 }); await page.waitForTimeout(900);
    assert.deepEqual(layout(await state()), afterTitle, 'canvas-only resize must not write geometry');
    if (await page.getByRole('button', { name: '收起节点详情', exact: true }).isVisible()) {
      await page.getByRole('button', { name: '收起节点详情', exact: true }).click();
      await page.waitForTimeout(600);
      await page.getByRole('button', { name: '打开节点详情', exact: true }).click();
      await page.waitForTimeout(600);
      assert.deepEqual(layout(await state()), afterTitle, 'opening and closing a detail drawer must not arrange unchanged cards');
    }
    await page.reload(); await settled();
    assert.deepEqual(layout(await state()), afterTitle, 'reload uses persisted signature');
    check('same-size text, canvas-only resize, drawer toggles and reload keep the saved layout stable');

    const pin = { x: afterTitle.positions.manual.x + 55, y: afterTitle.positions.manual.y - 60 };
    await request('view', { layout: { scopeId: 'execute', action: 'move', baseRevision: afterTitle.revision, positions: { manual: pin } } }, 'PATCH');
    await expect(page.getByTestId('graph-node-manual')).toHaveAttribute('data-manual', 'true');
    const moved = await settled();
    assert.equal(moved.inputKey, afterTitle.inputKey);
    assert.deepEqual(moved.positions.manual, pin);
    const expanded = await editTitle('核验全部调价输入与跨部门复核结果并逐项记录异常信息以及处置结果和处理记录');
    const afterPinned = await refreshed(moved);
    assert.deepEqual(afterPinned.positions.manual, pin);
    assert.ok(afterPinned.manualNodeIds.includes('manual'));
    assert.deepEqual(business(await state()), business(expanded));
    check('a saved manual move is not auto-rearranged and survives the next content-driven refresh');

    await page.getByTestId('arrange-layout').click();
    await expect.poll(async () => layout(await state()).revision).toBeGreaterThan(afterPinned.revision);
    const arranged = await settled();
    assert.deepEqual(arranged.manualNodeIds, afterPinned.manualNodeIds);
    assert.deepEqual(arranged.positions.manual, pin);
    assert.ok(arranged.previous);
    const undoSnapshot = structuredClone(arranged.previous);
    await editTitle('核验调价');
    const afterAuto = await refreshed(arranged);
    assert.deepEqual(afterAuto.previous, undoSnapshot, 'automatic refresh must not replace the explicit arrangement undo');
    await page.getByTestId('undo-layout').click();
    await expect.poll(async () => layout(await state()).revision).toBeGreaterThan(afterAuto.revision);
    const undone = await settled();
    assert.deepEqual(undone.positions.manual, pin);
    assert.ok(undone.manualNodeIds.includes('manual'));
    assert.equal(undone.previous, undefined);
    await page.reload(); await settled(); assert.deepEqual(layout(await state()), undone);
    check('automatic refresh preserves explicit undo and undo is not immediately undone by the scheduler or reload');

    const topologyBefore = layout(await state());
    const added = await request('structure-edits', await guard({ operation: { type: 'add-node', node: { title: '记录合成复核结论', groupId: 'execute', fields: { actions: '登记本次复核结果。' } } } }));
    const newNode = added.model.nodes.find(n => !expanded.model.nodes.some(old => old.id === n.id));
    assert.ok(newNode);
    await refreshed(topologyBefore);
    const relationBefore = layout(await state());
    const connected = await request('structure-edits', await guard({ operation: { type: 'connect', relation: { from: 'validate', to: newNode.id, type: 'sequence', description: '校验完成后登记本次复核结果。' } } }));
    const afterTopology = await refreshed(relationBefore);
    await expect(page.getByTestId('graph-node-' + newNode.id)).toBeVisible();
    const newRelation = connected.model.relations.find(edge => !added.model.relations.some(old => old.id === edge.id));
    assert.ok(newRelation);
    await expect(page.locator(`.react-flow__edge[data-id="${newRelation.id}"] path.react-flow__edge-path`)).toHaveCount(1);
    assert.ok(afterTopology.positions[newNode.id]);
    assert.deepEqual(business(await state()), business(connected));
    await clearBoxes('topology-added');
    check('new nodes and relations trigger measured automatic layout while keeping all generated content intact');

    const hold = await holdRefresh();
    await editTitle('核验全部输入以及复核结论并登记本次合成流程的特殊处理结果');
    await hold.arrived();
    await switchGroup('prepare');
    const otherLayout = layout(await state(), 'prepare'), otherViewport = await viewport();
    hold.release(); await hold.finished(); await hold.remove(); await page.waitForTimeout(800);
    assert.deepEqual(layout(await state(), 'prepare'), otherLayout);
    assert.deepEqual(await viewport(), otherViewport);
    await switchGroup('execute');
    check('an in-flight refresh belongs to its original group and cannot replace the new group or its viewport');

    const movingHold = await holdRefresh();
    await editTitle('核验调价输入');
    const heldGeometry = await movingHold.arrived();
    const whileHeld = await state(), latestPin = { x: layout(whileHeld).positions.manual.x + 68, y: layout(whileHeld).positions.manual.y - 40 };
    await request('view', { layout: { scopeId: 'execute', action: 'move', baseRevision: layout(whileHeld).revision, positions: { manual: latestPin } } }, 'PATCH');
    movingHold.release();
    assert.equal(await movingHold.finished(), 409, 'layout revision guard must reject the older automatic write');
    await movingHold.remove();
    await expect.poll(async () => layout(await state()).inputKey, { timeout: 30000 }).toBe(heldGeometry.inputKey);
    const afterRace = await settled();
    assert.deepEqual(afterRace.positions.manual, latestPin);
    assert.ok(afterRace.manualNodeIds.includes('manual'));
    check('a newer manual move wins over an in-flight automatic write and the latest measured layout converges');

    await page.getByTestId('view-content').click();
    await expect(page.getByTestId('node-workspace')).toBeVisible();
    const hiddenBefore = layout(await state());
    await editTitle('核验调价输入并完成本次业务资料和复核结果的完整登记');
    await page.waitForTimeout(900);
    assert.deepEqual(layout(await state()), hiddenBefore, 'hidden graph must wait for its real dimensions');
    await page.getByTestId('view-graph').click();
    await refreshed(hiddenBefore);
    check('updates made while reading node content wait until the visible graph can be measured');

    await openTask('full-vertical', async () => request('view', { selectedGroupId: 'all' }, 'PATCH'));
    const full = await settled('all');
    assert.equal(Object.keys(full.positions).length, (await state()).model.nodes.length);
    assert.equal(requests.filter(r => r.scenario === scenario && r.scopeId === 'all' && r.action === 'initialize').length, 1);
    await page.reload(); await settled('all'); assert.deepEqual(layout(await state(), 'all'), full);
    check('the full vertical graph also initializes from real measurements once and stays stable after reload');

    await openTask('legacy-saved', async () => {
      const before = await state();
      await request('view', { layout: { scopeId: 'execute', action: 'move', baseRevision: 0, positions: { manual: { x: 81, y: 49 } } } }, 'PATCH');
      assert.equal(layout(await state()).inputKey, undefined);
      assert.equal((await state()).modelHash, before.modelHash);
    });
    const legacy = await settled();
    assert.deepEqual(legacy.positions.manual, { x: 81, y: 49 });
    assert.equal(requests.filter(r => r.scenario === scenario && r.action === 'refresh').length, 1);
    await page.reload(); await settled(); assert.deepEqual(layout(await state()), legacy);
    check('old saved layouts migrate once after measurement and preserve their manual coordinates');

    await openTask('failure-recovery'); await settled();
    let rejected = 0;
    const reject = async route => {
      if (route.request().postDataJSON()?.layout?.action !== 'refresh') return route.continue();
      rejected++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '合成布局服务暂不可用' }) });
    };
    await page.route('**/api/workbench/view', reject);
    const beforeFailure = await state();
    await editTitle('核验全部输入及复核结果并记录所有需要后续跟踪处理的内容');
    await expect(page.locator('.layout-error')).toBeVisible();
    await page.waitForTimeout(1400); assert.equal(rejected, 1, 'failed same-input refresh must not retry indefinitely');
    assert.deepEqual(layout(await state()), layout(beforeFailure));
    await page.unroute('**/api/workbench/view', reject);
    await page.getByTestId('arrange-layout').click();
    await expect.poll(async () => layout(await state()).revision).toBeGreaterThan(layout(beforeFailure).revision);
    await settled(); await expect(page.locator('.layout-error')).toHaveCount(0);
    check('a failed automatic update remains visible without a retry loop and manual arrangement recovers');

    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ passed: true, checks, errors, requests, measurements }, null, 2));
    console.log(JSON.stringify({ directory, checks: checks.length, errors: errors.length }));
  } catch (error) {
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: false }).catch(() => {});
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ passed: false, error: error.stack, checks, errors, requests, measurements }, null, 2));
    throw error;
  } finally { await closeTask(); await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
