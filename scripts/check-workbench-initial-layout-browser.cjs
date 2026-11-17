'use strict';

// Every task in this check is generated below .qa. Never open business history.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const { startServer } = require('../workbench/scripts/workbench.cjs');
const { createDemoModel, createDemoPositions } = require('../workbench/scripts/workbench-demo-fixture.cjs');

const outlierPositions = () => ({ ...createDemoPositions(), 'verify-front': { x: 420, y: 6000 } });
const scoped = (snapshot, id = 'execute') => snapshot.view.layouts?.[id];
const point = (snapshot, nodeId, scopeId = 'execute') => scoped(snapshot, scopeId)?.positions[nodeId] || snapshot.view.positions[nodeId];

function sameVisibleScopeModel() {
  const model = createDemoModel();
  model.report.id = 'same-visible-scopes-synthetic';
  model.report.title = '相同可见节点的分组切换 · 合成测试';
  model.groups = ['group-a', 'group-b'].map((id, index) => ({ id, title: `合成分组 ${index + 1}`, kind: 'editorial', claimIds: [] }));
  model.nodes = model.nodes.filter(node => ['manual', 'validate'].includes(node.id));
  model.nodes.forEach((node, index) => { node.groupId = model.groups[index].id; });
  model.relations = model.relations.filter(edge => edge.id === 'manual--validate');
  const retained = new Set([...model.nodes, ...model.relations].flatMap(item => item.claimIds));
  model.claims = model.claims.filter(claim => retained.has(claim.id));
  model.rules = []; model.issues = [];
  model.coverage = model.coverage.map(entry => {
    const claimIds = entry.claimIds.filter(id => retained.has(id));
    return { ...entry, claimIds, issueIds: [], disposition: claimIds.length ? 'represented' : 'out_of_scope', reason: claimIds.length ? '' : '此合成测试仅保留两个相连节点，以验证分组布局独立性。' };
  });
  return model;
}

function geometryMetrics(positions, nodeIds, heights, terminalEdge) {
  const intervals = nodeIds.map(id => ({ top: positions[id].y, bottom: positions[id].y + (heights[id] || 113) })).sort((a, b) => a.top - b.top);
  let bottom = intervals[0].bottom, maximumEmptyBand = 0;
  for (const next of intervals.slice(1)) {
    maximumEmptyBand = Math.max(maximumEmptyBand, next.top - bottom);
    bottom = Math.max(bottom, next.bottom);
  }
  const a = positions[terminalEdge.from], b = positions[terminalEdge.to];
  return {
    maximumEmptyBand,
    verticalSpan: bottom - intervals[0].top,
    terminalBranchSpan: Math.hypot(a.x - b.x, a.y - b.y),
  };
}

async function main() {
  const { getGraphScope } = await import('../workbench/frontend/src/graph-scope.mjs');
  const directory = path.resolve('.qa', 'workbench-initial-layout-browser', `run-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
  const checks = [], errors = [], layoutRequests = [], metrics = {}, tasks = [];
  const servedScripts = new Set();
  let app, context, page, scenario;
  const state = () => fetch(app.url + '/api/workbench/state').then(response => response.json());
  const check = name => { checks.push(name); console.log('PASS ' + name); };
  const writeSummary = extra => fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ checks, errors, layoutRequests, metrics, tasks, servedScripts: [...servedScripts], ...extra }, null, 2));
  const closeTask = async () => {
    if (context) { await context.close(); context = undefined; }
    if (app) { await app.close(); app = undefined; }
  };
  const openTask = async (name, prepare, options = {}) => {
    await closeTask();
    scenario = name;
    const taskDirectory = path.join(directory, name, 'task');
    app = await startServer({ taskDirectory, positions: outlierPositions(), ...options });
    // These fixtures retain the legacy vertical initialization contract;
    // automatic and horizontal direction are exercised in their own suite.
    const fixtureFile = path.join(taskDirectory, 'workbench', 'state.json');
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    fixture.view.defaultLayoutDirection = 'DOWN';
    fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2));
    tasks.push(taskDirectory);
    if (prepare) await prepare(app);
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', error => errors.push({ scenario: name, message: error.message }));
    page.on('response', response => {
      const asset = new URL(response.url()).pathname;
      if (asset.startsWith('/assets/') && asset.endsWith('.js')) servedScripts.add(asset);
    });
    page.on('request', request => {
      if (request.method() !== 'PATCH' || !request.url().endsWith('/api/workbench/view')) return;
      const body = request.postDataJSON();
      if (body?.layout) layoutRequests.push({ scenario: name, ...body.layout });
    });
    return state();
  };
  const patchView = async body => {
    const response = await fetch(app.url + '/api/workbench/view', {
      method: 'PATCH', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Workbench-Id': app.runtime.workspaceId }, body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const switchGroup = async id => {
    const item = page.getByTestId('group-' + id);
    if (!(await item.isVisible())) await page.getByRole('button', { name: '展开分组导航', exact: true }).click();
    await item.click();
    await expect(item).toHaveAttribute('aria-current', 'page');
    await expect.poll(async () => (await state()).view.selectedGroupId).toBe(id);
  };
  const awaitLayout = async (id = 'execute') => {
    await expect.poll(async () => scoped(await state(), id)?.revision || 0, { timeout: 30000 }).toBeGreaterThan(0);
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await expect(page.getByTestId('arrange-layout')).toBeEnabled({ timeout: 30000 });
    return scoped(await state(), id);
  };
  const requestsFor = (name, id = 'execute') => layoutRequests.filter(request => request.scenario === name && request.scopeId === id && request.action === 'initialize');
  const assertContentUnchanged = (before, after) => {
    assert.equal(after.modelHash, before.modelHash);
    assert.equal(after.workRevision, before.workRevision);
    assert.deepEqual(after.model, before.model);
    assert.deepEqual(after.pendingEdits, before.pendingEdits);
    assert.deepEqual(after.changes, before.changes);
    assert.deepEqual(after.view.positions, before.view.positions, 'initializing a group must preserve imported baseline coordinates');
  };
  const assertRenderedPoint = async (id, expected) => {
    await expect.poll(() => page.getByTestId('graph-node-' + id).evaluate((node, expected) => {
      const matrix = new DOMMatrixReadOnly(node.closest('.react-flow__node').style.transform);
      return Math.hypot(matrix.e - expected.x, matrix.f - expected.y);
    }, expected)).toBeLessThan(.001);
  };
  const readViewport = () => page.locator('.react-flow__viewport').evaluate(node => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
    return { x: matrix.e, y: matrix.f, zoom: matrix.a };
  });
  const holdInitialization = async (scopeId = 'execute') => {
    let release, markArrived, markFinished, heldLayout;
    const gate = new Promise(resolve => { release = resolve; });
    const arrived = new Promise(resolve => { markArrived = resolve; });
    const finished = new Promise(resolve => { markFinished = resolve; });
    await page.route('**/api/workbench/view', async route => {
      const body = route.request().postDataJSON();
      if (body?.layout?.action !== 'initialize' || body.layout.scopeId !== scopeId) return route.continue();
      heldLayout = body.layout;
      markArrived();
      await gate;
      const response = await route.fetch();
      await route.fulfill({ response });
      markFinished(response.status());
    });
    return {
      release,
      request: () => heldLayout,
      async arrived() {
        let timer;
        try { await Promise.race([arrived, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('initialization request was not issued')), 30000); })]); }
        finally { clearTimeout(timer); }
      },
      async finished() {
        let timer;
        try { return await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('held initialization request did not finish')), 30000); })]); }
        finally { clearTimeout(timer); }
      },
    };
  };

  try {
    const initial = await openTask('first-open-outlier');
    assert.deepEqual(initial.view.layouts, {}, 'fixture must begin with imported coordinates and no scoped layout');
    const scope = getGraphScope(initial.model, 'execute');
    assert.ok(scope.contextIds.has('verify-front'), 'the outlier must be a direct group-external neighbour');
    assert.ok(!scope.relations.some(edge => edge.from === 'verify-front'), 'the outlier must be terminal inside this reading scope');
    await page.goto(app.url);
    const firstLayout = structuredClone(await awaitLayout());
    assert.equal(firstLayout.revision, 1);
    assert.equal(firstLayout.previous, undefined, 'automatic first layout must not create an explicit-arrange undo entry');
    assert.ok(Object.keys(firstLayout.routes).length > 0, 'initialization must persist ELK edge routes');
    await expect(page.getByTestId('undo-layout')).toBeDisabled();
    await expect(page.getByTestId('graph-node-verify-front')).toHaveAttribute('data-context', 'true');
    await assertRenderedPoint('verify-front', firstLayout.positions['verify-front']);
    const heights = await page.locator('.react-flow__node').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.id, node.offsetHeight])));
    const terminalEdge = initial.model.relations.find(edge => edge.id === 'platform-wait--verify-front');
    const before = geometryMetrics(initial.view.positions, scope.nodes.map(node => node.id), heights, terminalEdge);
    const after = geometryMetrics(firstLayout.positions, scope.nodes.map(node => node.id), heights, terminalEdge);
    assert.ok(before.maximumEmptyBand > 4000, 'the fixture must reproduce the large empty band from global coordinates');
    assert.ok(after.maximumEmptyBand < before.maximumEmptyBand * .4, 'first open must reduce the largest empty band substantially');
    assert.ok(after.terminalBranchSpan < before.terminalBranchSpan * .4, 'first open must shorten the long terminal branch substantially');
    const zoom = () => page.locator('.react-flow__viewport').evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).a);
    await expect.poll(zoom).toBeGreaterThanOrEqual(.8);
    metrics.firstOpen = { before, after, defaultZoom: await zoom(), coreNodeCount: scope.coreNodes.length, contextNodeCount: scope.contextNodes.length };
    assert.equal(requestsFor(scenario).length, 1);
    assert.equal(requestsFor(scenario)[0].baseRevision, 0);
    assert.equal(requestsFor(scenario)[0].baseModelHash, initial.modelHash);
    assertContentUnchanged(initial, await state());
    await expect(page.locator('[data-route-mode="pending"]')).toHaveCount(0, { timeout: 30000 });
    await page.screenshot({ path: path.join(directory, '01-first-open-1440x900.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    const closeInspector = page.getByRole('button', { name: '关闭节点编辑区', exact: true });
    if (await closeInspector.isVisible()) await closeInspector.click();
    await expect.poll(zoom).toBeGreaterThanOrEqual(.8);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(directory, '02-first-open-390x844.png'), fullPage: false });
    await page.setViewportSize({ width: 1440, height: 900 });
    check('first open automatically saves a compact scoped layout, with readable default zoom and no undo snapshot');

    await switchGroup('prepare');
    await awaitLayout('prepare');
    assert.deepEqual(scoped(await state()), firstLayout);
    const beforeSharedMove = await state();
    const sharedPoint = { x: point(beforeSharedMove, 'calculate', 'prepare').x + 73, y: point(beforeSharedMove, 'calculate', 'prepare').y + 29 };
    await patchView({ layout: { action: 'move', scopeId: 'prepare', baseRevision: scoped(beforeSharedMove, 'prepare').revision, positions: { calculate: sharedPoint } } });
    await assertRenderedPoint('calculate', sharedPoint);
    const prepareLayout = structuredClone(scoped(await state(), 'prepare'));
    assert.deepEqual(scoped(await state()), firstLayout, 'a shared node position cannot leak back to the first group');
    await switchGroup('execute');
    await assertRenderedPoint('calculate', firstLayout.positions.calculate);
    await page.reload();
    await awaitLayout();
    await assertRenderedPoint('verify-front', firstLayout.positions['verify-front']);
    assert.deepEqual(scoped(await state()), firstLayout);
    assert.deepEqual(scoped(await state(), 'prepare'), prepareLayout);
    assert.equal(requestsFor(scenario).length, 1, 'returning and reloading must not repeat initialization');
    assert.equal(requestsFor(scenario, 'prepare').length, 1);
    assertContentUnchanged(initial, await state());
    check('group changes and reload preserve initialized layouts and independent shared-node positions');

    const savedTask = app.runtime.taskDirectory;
    const beforeRestart = await state();
    await context.close(); context = undefined;
    await app.close();
    app = await startServer({ taskDirectory: savedTask });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    page.on('pageerror', error => errors.push({ scenario, message: error.message }));
    await page.goto(app.url);
    await awaitLayout();
    await assertRenderedPoint('verify-front', firstLayout.positions['verify-front']);
    assert.deepEqual((await state()).view.layouts, beforeRestart.view.layouts);
    assertContentUnchanged(initial, await state());
    check('a fresh browser after server restart restores the saved local layout without altering the model');

    const migratedCache = await openTask('legacy-viewport-cache', server => {
      const baseline = server.store.read();
      server.store.updateView({ layout: { action: 'initialize', scopeId: 'execute', baseRevision: 0, baseModelHash: baseline.modelHash, positions: firstLayout.positions, routes: firstLayout.routes, inputKey: firstLayout.inputKey } });
    });
    // Seed the old cache on this origin before the application has opened. This
    // reproduces a second browser tab whose global-coordinate viewport predates
    // the scoped layout already saved by another tab.
    await page.goto(app.url + '/api/workbench/state');
    await page.evaluate(workspaceId => localStorage.setItem(`6ak.workbench.${workspaceId}.viewport-scope-v2`, JSON.stringify({ execute: { x: -900, y: -4400, zoom: .25 } })), migratedCache.workspaceId);
    const cachedViewport = () => page.evaluate(workspaceId => JSON.parse(localStorage.getItem(`6ak.workbench.${workspaceId}.viewport-scope-v2`) || '{}').execute, migratedCache.workspaceId);
    assert.equal((await cachedViewport()).scoped, undefined, 'the fixture must contain an unmarked legacy viewport');
    await page.goto(app.url);
    await awaitLayout();
    await expect.poll(async () => (await readViewport()).zoom).toBeGreaterThanOrEqual(.8);
    await expect.poll(async () => (await cachedViewport())?.scoped).toBe(true);
    const recoveredZoom = (await readViewport()).zoom;
    assert.deepEqual(scoped(await state()), scoped(migratedCache));
    assert.equal(requestsFor(scenario).length, 0, 'discarding an obsolete viewport must not initialize the layout again');
    await page.getByRole('button', { name: '适应当前图', exact: true }).click();
    await expect.poll(async () => (await readViewport()).zoom).toBeLessThan(.8);
    await expect.poll(async () => (await cachedViewport())?.zoom).toBeLessThan(.8);
    assert.equal((await cachedViewport()).scoped, true);
    const deliberateFit = await cachedViewport();
    await page.reload();
    await awaitLayout();
    await expect.poll(async () => Math.abs((await readViewport()).zoom - deliberateFit.zoom)).toBeLessThan(.001);
    await expect.poll(async () => {
      const restored = await readViewport();
      return Math.hypot(restored.x - deliberateFit.x, restored.y - deliberateFit.y);
    }).toBeLessThan(.01);
    assert.deepEqual(scoped(await state()), scoped(migratedCache));
    assert.equal(requestsFor(scenario).length, 0);
    assertContentUnchanged(migratedCache, await state());
    metrics.viewportCacheMigration = { legacyZoom: .25, recoveredZoom, deliberateFit, restored: await readViewport() };
    check('legacy global-coordinate viewport caches are discarded while explicit scoped fit views survive reload');

    const manualPoint = { x: 91, y: 37 };
    const legacy = await openTask('legacy-manual', server => server.store.updateView({ positions: { manual: manualPoint } }));
    assert.deepEqual(legacy.view.layouts, {});
    assert.ok(legacy.view.manualNodeIds.includes('manual'));
    await page.goto(app.url);
    const pinned = await awaitLayout();
    assert.deepEqual(pinned.positions.manual, manualPoint);
    assert.ok(pinned.manualNodeIds.includes('manual'));
    assert.equal(pinned.previous, undefined);
    await expect(page.getByTestId('graph-node-manual')).toHaveAttribute('data-manual', 'true');
    await assertRenderedPoint('manual', manualPoint);
    assertContentUnchanged(legacy, await state());
    check('legacy manually positioned nodes keep exact coordinates during first initialization');

    const saved = await openTask('already-saved', server => server.store.updateView({ layout: { action: 'move', scopeId: 'execute', baseRevision: 0, positions: { manual: { x: 178, y: 82 } } } }));
    await page.goto(app.url);
    await expect.poll(async () => typeof scoped(await state()).inputKey).toBe('string');
    await expect(page.getByTestId('arrange-layout')).toBeEnabled();
    await assertRenderedPoint('manual', scoped(saved).positions.manual);
    const upgradedSaved = structuredClone(scoped(await state()));
    assert.equal(upgradedSaved.revision, scoped(saved).revision + 1);
    assert.deepEqual(upgradedSaved.positions.manual, scoped(saved).positions.manual);
    await switchGroup('prepare'); await awaitLayout('prepare');
    await switchGroup('execute'); await page.reload();
    await expect(page.getByTestId('arrange-layout')).toBeEnabled();
    assert.deepEqual(scoped(await state()), upgradedSaved);
    assert.equal(requestsFor(scenario).length, 0);
    assertContentUnchanged(saved, await state());
    check('an existing scoped layout upgrades once after measurement, keeps manual coordinates and stays stable on return/reload');

    const legacySharedPoint = { x: 43, y: 117 }, otherScopePoint = { x: 410, y: 273 };
    const sameVisible = await openTask('same-visible-scopes', server => {
      server.store.updateView({ positions: { manual: legacySharedPoint } });
      server.store.updateView({ layout: { action: 'move', scopeId: 'group-a', baseRevision: 0, positions: { manual: otherScopePoint } } });
    }, { model: sameVisibleScopeModel(), positions: { manual: { x: 40, y: 0 }, validate: { x: 40, y: 250 } } });
    assert.deepEqual([...getGraphScope(sameVisible.model, 'group-a').visibleIds].sort(), [...getGraphScope(sameVisible.model, 'group-b').visibleIds].sort());
    assert.notDeepEqual(scoped(sameVisible, 'group-a').positions.manual, sameVisible.view.positions.manual);
    await page.goto(app.url);
    await expect.poll(async () => typeof scoped(await state(), 'group-a').inputKey).toBe('string');
    await expect(page.getByTestId('arrange-layout')).toBeEnabled();
    await assertRenderedPoint('manual', otherScopePoint);
    const measuredGroupA = structuredClone(scoped(await state(), 'group-a'));
    await switchGroup('group-b');
    const secondScope = await awaitLayout('group-b');
    assert.deepEqual(secondScope.positions.manual, legacySharedPoint, 'the new scope must initialize from its legacy manual position, not the previous scope DOM position');
    assert.ok(secondScope.manualNodeIds.includes('manual'));
    assert.equal(secondScope.previous, undefined);
    await assertRenderedPoint('manual', legacySharedPoint);
    assert.deepEqual(scoped(await state(), 'group-a'), measuredGroupA);
    assert.equal(requestsFor(scenario, 'group-a').length, 0);
    assert.equal(requestsFor(scenario, 'group-b').length, 1);
    assert.deepEqual(requestsFor(scenario, 'group-b')[0].positions.manual, legacySharedPoint);
    await switchGroup('group-a');
    await assertRenderedPoint('manual', otherScopePoint);
    await switchGroup('group-b'); await page.reload();
    await awaitLayout('group-b');
    await assertRenderedPoint('manual', legacySharedPoint);
    assert.equal(requestsFor(scenario, 'group-b').length, 1);
    assertContentUnchanged(sameVisible, await state());
    check('groups sharing exactly the same visible nodes initialize with their own legacy pinned coordinates');

    const pending = await openTask('pending-position');
    const pendingPoint = { x: 122, y: 49 };
    await page.addInitScript(({ workspaceId, point }) => sessionStorage.setItem(`6ak.workbench.${workspaceId}.pending-positions`, JSON.stringify({ execute: { manual: point } })), { workspaceId: pending.workspaceId, point: pendingPoint });
    await page.goto(app.url);
    await expect(page.getByRole('button', { name: '重试保存位置', exact: true })).toBeVisible();
    await expect(page.getByTestId('arrange-layout')).toBeDisabled();
    await assertRenderedPoint('manual', pendingPoint);
    assert.equal(scoped(await state()), undefined);
    assert.equal(requestsFor(scenario).length, 0);
    await page.getByRole('button', { name: '重试保存位置', exact: true }).click();
    await awaitLayout();
    assert.deepEqual(point(await state(), 'manual'), pendingPoint);
    assert.equal(requestsFor(scenario).length, 0);
    assertContentUnchanged(pending, await state());
    check('a pending manual move prevents automatic initialization and can be saved unchanged');

    const asynchronous = await openTask('switch-during-initialize');
    const switched = await holdInitialization();
    try {
      await page.goto(app.url);
      await switched.arrived();
      assert.equal(switched.request().scopeId, 'execute');
      await switchGroup('prepare');
      switched.release();
      assert.equal(await switched.finished(), 200);
      await awaitLayout('prepare');
      await expect(page.getByTestId('group-prepare')).toHaveAttribute('aria-current', 'page');
      const completed = await state();
      assert.equal(scoped(completed).revision, 1);
      assert.equal(scoped(completed, 'prepare').revision, 1);
      await assertRenderedPoint('calculate', scoped(completed, 'prepare').positions.calculate);
      assertContentUnchanged(asynchronous, completed);
    } finally { switched.release(); await page.unroute('**/api/workbench/view'); }
    check('initialization finishing after a group switch keeps its original scope and the newly selected group');

    const conflictBaseline = await openTask('manual-wins-initialize-race');
    const conflicted = await holdInitialization();
    try {
      await page.goto(app.url);
      await conflicted.arrived();
      const winner = { x: 157, y: 61 };
      await patchView({ layout: { action: 'move', scopeId: 'execute', baseRevision: 0, positions: { manual: winner } } });
      const savedWinner = structuredClone(scoped(await state()));
      conflicted.release();
      assert.equal(await conflicted.finished(), 409, 'CAS must reject stale first initialization after a manual save');
      await expect.poll(async () => typeof scoped(await state()).inputKey).toBe('string');
      await expect(page.getByTestId('arrange-layout')).toBeEnabled();
      await assertRenderedPoint('manual', winner);
      const measuredWinner = structuredClone(scoped(await state()));
      assert.deepEqual(measuredWinner.positions.manual, savedWinner.positions.manual);
      assert.ok(measuredWinner.manualNodeIds.includes('manual'));
      await page.reload();
      await expect(page.getByTestId('arrange-layout')).toBeEnabled();
      assert.deepEqual(scoped(await state()), measuredWinner);
      assert.equal(requestsFor(scenario).length, 1, 'a losing initialization cannot retry over a saved manual layout');
      assertContentUnchanged(conflictBaseline, await state());
    } finally { conflicted.release(); await page.unroute('**/api/workbench/view'); }
    check('a manual save wins an initialization race through revision compare-and-swap');

    const completeGraph = await openTask('all-scope', server => server.store.updateView({ selectedGroupId: 'all' }));
    await page.goto(app.url);
    await expect(page.getByTestId('group-all')).toHaveAttribute('aria-current', 'page');
    const fullLayout = await awaitLayout('all');
    assert.ok(fullLayout.inputKey);
    assert.notDeepEqual(fullLayout.positions, completeGraph.view.positions);
    assert.equal(requestsFor(scenario, 'all').length, 1);
    assertContentUnchanged(completeGraph, await state());
    check('the full vertical graph also initializes automatically while preserving the imported baseline and content');

    assert.deepEqual(errors, []);
    writeSummary({ passed: true });
    console.log('INITIAL_LAYOUT_BROWSER_QA=' + directory);
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: false }).catch(() => {});
    writeSummary({ passed: false, scenario, error: error.stack });
    console.error('INITIAL_LAYOUT_BROWSER_QA=' + directory);
    throw error;
  } finally { await closeTask(); await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
