'use strict';

// Browser checks use only generated task data below .qa. No business task is opened.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const { startServer } = require('../workbench/scripts/workbench.cjs');
const { createDemoPositions } = require('../workbench/scripts/workbench-demo-fixture.cjs');

function obstructedPositions() {
  // The ordinary smooth-step route from validate to dispatch crosses approval.
  // Its endpoints are diagonal, so a same-column-only detour cannot pass this case.
  return {
    ...createDemoPositions(),
    approval: { x: 390, y: 410 }, recalculate: { x: 30, y: 410 },
    dispatch: { x: 600, y: 650 }, 'platform-wait': { x: 600, y: 850 },
    'verify-front': { x: 600, y: 1060 }, failure: { x: 920, y: 1060 },
    reconcile: { x: 270, y: 1280 }, archive: { x: 600, y: 1280 }, monitor: { x: 920, y: 1280 },
  };
}

async function inspectRoutes(page, relations) {
  return page.evaluate(relations => {
    const boxes = [...document.querySelectorAll('.react-flow__node')].map(node => {
      const bounds = node.querySelector('.process-card').getBoundingClientRect();
      return { id: node.dataset.id, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    });
    const collisions = [], routes = [];
    for (const edge of document.querySelectorAll('.react-flow__edge')) {
      const relation = relations.find(item => item.id === edge.dataset.id);
      const curve = edge.querySelector('path.react-flow__edge-path');
      if (!relation || !curve) continue;
      const matrix = curve.getScreenCTM(), length = curve.getTotalLength();
      if (!matrix || !length) continue;
      const obstacles = boxes.filter(box => ![relation.from, relation.to].includes(box.id));
      const hit = new Set();
      // Sample the actual browser SVG, including rounded bends. Convert to screen
      // coordinates before comparing with DOM card boxes; zoom cannot hide a hit.
      for (let distance = 0; distance <= length; distance += 1.5) {
        const point = curve.getPointAtLength(distance).matrixTransform(matrix);
        for (const box of obstacles) if (point.x > box.x + 1 && point.x < box.x + box.width - 1 && point.y > box.y + 1 && point.y < box.y + box.height - 1) {
          if (!hit.has(box.id)) collisions.push({ edge: relation.id, obstacle: box.id, point: { x: point.x, y: point.y }, box });
          hit.add(box.id);
        }
      }
      routes.push({ id: relation.id, d: curve.getAttribute('d'), length, strategy: curve.closest('[data-route-mode]')?.getAttribute('data-route-mode') });
    }
    return { boxes, routes, collisions };
  }, relations);
}

async function main() {
  const directory = path.resolve('.qa', 'workbench-layout-browser', `run-${Date.now()}`);
  const taskDirectory = path.join(directory, 'task');
  fs.mkdirSync(directory, { recursive: true });
  let app = await startServer({ taskDirectory, positions: obstructedPositions() });
  // Preserve this suite's legacy vertical routing/drag/undo scenarios. Automatic
  // and horizontal direction behavior has a separate integration browser suite.
  const fixtureFile = path.join(taskDirectory, 'workbench', 'state.json');
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  fixture.view.defaultLayoutDirection = 'DOWN';
  fs.writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2));
  const { getGraphScope } = await import('../workbench/frontend/src/graph-scope.mjs');
  const seed = app.store.read();
  // Deliberately retain an existing obstructed layout to exercise Smart routing.
  // First-open automatic ELK initialization is checked in its own browser suite.
  const visible = getGraphScope(seed.model, 'execute').visibleIds;
  app.store.updateView({ layout: { scopeId: 'execute', action: 'initialize', baseRevision: 0, baseModelHash: seed.modelHash,
    positions: Object.fromEntries(Object.entries(seed.view.positions).filter(([id]) => visible.has(id))), routes: {} } });
  // These deliberately obstructed coordinates are a manual routing fixture.
  // Automatic content-layout migration must preserve them while we test the
  // fallback obstacle router; the explicit Arrange below still releases them.
  app.store.updateView({ layout: { scopeId: 'execute', action: 'move', baseRevision: 1,
    positions: Object.fromEntries(Object.entries(seed.view.positions).filter(([id]) => visible.has(id))) } });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
  const checks = [], errors = [], routeSnapshots = [], layoutRequests = [];
  let page, context;
  const state = () => fetch(app.url + '/api/workbench/state').then(response => response.json());
  const check = name => { checks.push(name); console.log('PASS ' + name); };
  const watchPage = value => {
    page = value;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() !== 'PATCH' || !request.url().endsWith('/api/workbench/view')) return;
      const body = request.postDataJSON();
      if (body?.layout) layoutRequests.push(body.layout);
    });
  };
  const scoped = (snapshot, id = 'execute') => snapshot.view.layouts?.[id];
  const position = (snapshot, id, scopeId = 'execute') => scoped(snapshot, scopeId)?.positions?.[id] || snapshot.view.positions[id];
  const switchGroup = async id => {
    const item = page.getByTestId('group-' + id);
    if (!(await item.isVisible())) await page.getByRole('button', { name: '展开分组导航', exact: true }).click();
    await item.click();
    await expect(item).toHaveAttribute('aria-current', 'page');
    await expect.poll(async () => (await state()).view.selectedGroupId).toBe(id);
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
  };
  const fit = async () => {
    if(!(await page.getByRole('button',{name:'适应当前图',exact:true}).isVisible()))await page.getByRole('button',{name:'图工具',exact:true}).click();
    await page.getByRole('button', { name: '适应当前图', exact: true }).click();
    await page.waitForTimeout(450); // The control animates its viewport for 300 ms.
  };
  const resumeMaterial = async () => {
    await page.getByTestId('view-graph').click();
    await page.getByTestId('organize-node').click();
    await page.locator('[data-content-node-id="validate"]').getByTestId('add-content-note').click();
    return page.getByLabel('补充原话',{exact:true});
  };
  const automaticLayout = async (control, scopeId = 'execute') => {
    const button = page.getByTestId(control);
    await expect(button).toBeEnabled({ timeout: 30000 });
    const before = scoped(await state(), scopeId)?.revision || 0;
    const requestCount = layoutRequests.length;
    await button.click();
    await expect.poll(async () => scoped(await state(), scopeId)?.revision || 0, { timeout: 30000 }).toBeGreaterThan(before);
    await expect(page.getByTestId('arrange-layout')).toBeEnabled({ timeout: 30000 });
    assert.ok(layoutRequests.slice(requestCount).some(layout => layout.action === 'reset' && layout.scopeId === scopeId));
    await fit();
    return state();
  };
  const arrange = scopeId => automaticLayout('arrange-layout', scopeId);
  const undoLayout = async () => {
    const before = scoped(await state()).revision;
    await page.getByTestId('undo-layout').click();
    await expect.poll(async () => scoped(await state()).revision).toBeGreaterThan(before);
    return state();
  };
  const visibleNodePoint = async id => {
    const hit = await page.getByTestId('graph-node-' + id).evaluate(node => {
      const box = node.getBoundingClientRect();
      for (const xPart of [.5, .7, .3]) for (const yPart of [.3, .5, .7]) {
        const x = box.x + box.width * xPart, y = box.y + box.height * yPart;
        if (document.elementFromPoint(x, y)?.closest('.process-card') === node) return { x, y };
      }
      return null;
    });
    assert.ok(hit, 'interaction must hit the visible node rather than an overlay: ' + id);
    return hit;
  };
  const dragGesture = async (id, dx = 45, dy = 28) => {
    await fit();
    const hit = await visibleNodePoint(id);
    await page.mouse.move(hit.x, hit.y);
    await page.mouse.down();
    await page.mouse.move(hit.x + dx, hit.y + dy, { steps: 10 });
    await page.mouse.up();
  };
  const drag = async (id, scopeId = 'execute', dx = 45, dy = 28) => {
    const before = position(await state(), id, scopeId);
    await dragGesture(id, dx, dy);
    await expect.poll(async () => JSON.stringify(position(await state(), id, scopeId))).not.toBe(JSON.stringify(before));
    await expect(page.getByTestId('graph-node-' + id)).toHaveAttribute('data-manual', 'true');
    return position(await state(), id, scopeId);
  };
  const routesClear = async label => {
    await expect(page.locator('[data-route-mode="pending"]')).toHaveCount(0, { timeout: 30000 });
    const report = await inspectRoutes(page, (await state()).model.relations);
    routeSnapshots.push({ label, ...report });
    fs.writeFileSync(path.join(directory, 'routes.json'), JSON.stringify(routeSnapshots, null, 2));
    assert.ok(report.routes.length > 0, 'rendered SVG routes must exist');
    assert.deepEqual(report.collisions, [], label + ': SVG route enters an unrelated card');
    return report;
  };
  try {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    watchPage(await context.newPage());
    await page.goto(app.url);
    await expect(page.getByTestId('graph-node-validate')).toBeVisible();
    await expect(page.getByTestId('arrange-layout')).toBeVisible();
    const initial = await state();
    const baseline = structuredClone(initial.view.positions);
    await fit();
    const initialRoutes = await routesClear('initial diagonal obstruction');
    const boxFor = id => initialRoutes.boxes.find(box => box.id === id);
    const source = boxFor('validate'), target = boxFor('dispatch'), blocker = boxFor('approval');
    assert.equal(initialRoutes.routes.find(route => route.id === 'validate--dispatch').strategy, 'smart');
    const midY = (source.y + source.height + target.y) / 2;
    assert.ok(midY > blocker.y && midY < blocker.y + blocker.height && source.x + source.width / 2 < blocker.x + blocker.width && target.x + target.width / 2 > blocker.x, 'fixture must actually block the ordinary diagonal smooth-step route');
    await page.screenshot({ path: path.join(directory, '01-smart-routing-1440x900.png'), fullPage: false });
    check('actual SVG routes avoid unrelated cards, including a deliberately blocked diagonal edge');

    await page.getByTestId('graph-node-validate').click();
    const draftTitle = '布局调整期间保留的未保存输入';
    await (await resumeMaterial()).fill(draftTitle);
    await expect.poll(() => Object.values(app.store.buffers('content-editor')).some(buffer => buffer.draft?.text === draftTitle)).toBe(true);
    await page.getByTestId('view-graph').click();
    const beforeArrange = await state();
    const arranged = await arrange();
    assert.ok(Object.keys(scoped(arranged).positions).length > 0);
    assert.ok(Object.keys(scoped(arranged).routes || {}).length > 0, 'ELK arrangement must save at least one routed edge');
    assert.notDeepEqual(scoped(arranged).positions, baseline);
    assert.deepEqual(arranged.view.positions, baseline, 'legacy baseline remains unchanged');
    const arrangedRoutes = await routesClear('after ELK arrangement');
    assert.ok(arrangedRoutes.routes.some(route => route.strategy === 'elk'), 'at least one saved ELK route must actually render');
    await expect(await resumeMaterial()).toHaveValue(draftTitle);
    await expect(page.getByTestId('save-content')).toBeEnabled();
    await page.getByTestId('view-graph').click();
    check('ELK arrangement saves scoped positions and routes while preserving unsaved content');

    const manualPosition = await drag('manual');
    const beforePinnedArrange = await state();
    const arrangedWithManual = await arrange();
    assert.notDeepEqual(scoped(arrangedWithManual).positions.manual, manualPosition, 'arrange must recompute the user position');
    assert.deepEqual(scoped(arrangedWithManual).manualNodeIds, []);
    await expect(page.getByTestId('graph-node-manual')).toHaveAttribute('data-manual', 'false');
    await routesClear('after rearranging a manually placed node');
    check('manually placing a node saves its position and arranging again resets it');

    const laterMove = await drag('import', 'execute', -35, 38);
    const undone = await undoLayout();
    assert.deepEqual(scoped(undone).positions.import, laterMove, 'undo must preserve a manual move performed after the arrangement');
    assert.deepEqual(scoped(undone).positions.manual, manualPosition);
    assert.deepEqual(new Set(scoped(undone).manualNodeIds), new Set(['import', 'manual']));
    for (const id of Object.keys(scoped(beforePinnedArrange).positions)) if (id !== 'import') {
      assert.deepEqual(position(undone, id), position(beforePinnedArrange, id), 'undo must restore the previous position of ' + id);
    }
    check('undoing an arrangement preserves subsequent manual moves');

    const manualHit = await visibleNodePoint('manual');
    await page.mouse.click(manualHit.x, manualHit.y);
    await page.getByTestId('release-node-position').click();
    await expect.poll(async () => scoped(await state()).manualNodeIds.includes('manual')).toBe(false);
    await expect(page.getByTestId('graph-node-manual')).toHaveAttribute('data-manual', 'false');
    const released = await state();
    assert.deepEqual(scoped(released).positions.manual, manualPosition);
    assert.deepEqual(scoped(released).positions.import, laterMove);
    assert.deepEqual(scoped(released).manualNodeIds, ['import']);
    check('releasing one manual marker keeps both positions and the other mark');

    const executeLayout = structuredClone(scoped(await state()));
    const executeShared = position(await state(), 'calculate');
    await switchGroup('prepare');
    await arrange('prepare');
    await drag('calculate', 'prepare', 55, 20);
    const prepareLayout = structuredClone(scoped(await state(), 'prepare'));
    assert.deepEqual(scoped(await state()), executeLayout, 'shared node changes cannot leak into another group');
    await switchGroup('execute');
    assert.deepEqual(position(await state(), 'calculate'), executeShared);
    assert.deepEqual(scoped(await state(), 'prepare'), prepareLayout);
    check('shared nodes keep independent positions, routes and manual flags in each group');

    // Hold the layout request while navigating away. The asynchronous operation
    // may finish for its original group, but cannot update the newly opened group.
    let releaseRequest, markArrived;
    const held = new Promise(resolve => { releaseRequest = resolve; });
    const arrived = new Promise(resolve => { markArrived = resolve; });
    let heldLayout;
    await page.route('**/api/workbench/view', async route => {
      const body = route.request().postDataJSON();
      if (body?.layout?.action === 'reset') { heldLayout = body.layout; markArrived(); await held; }
      await route.continue();
    });
    try {
      await page.getByTestId('arrange-layout').click();
      let timeout;
      try { await Promise.race([arrived, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('arrange request was not issued')), 30000); })]); }
      finally { clearTimeout(timeout); }
      assert.equal(heldLayout.scopeId, 'execute');
      await switchGroup('prepare');
      releaseRequest();
      await expect.poll(async () => scoped(await state()).revision, { timeout: 30000 }).toBeGreaterThan(executeLayout.revision);
      await expect(page.getByTestId('group-prepare')).toHaveAttribute('aria-current', 'page');
      assert.deepEqual(scoped(await state(), 'prepare'), prepareLayout);
    } finally { releaseRequest(); await page.unroute('**/api/workbench/view'); }
    check('an in-flight arrangement cannot write positions into the group opened afterward');

    await switchGroup('execute');
    await expect(page.getByTestId('graph-node-import')).toHaveAttribute('data-manual', 'false');
    // Keep the endpoint of manual -> validate exposed: dragging import down
    // and left would physically cover that handle, making a clear route impossible.
    await drag('import', 'execute', 35, 0);
    await page.getByTestId('graph-node-validate').click();
    await expect(await resumeMaterial()).toHaveValue(draftTitle);
    await page.getByTestId('view-graph').click();
    const beforeReload = await state();
    await page.reload();
    await expect(await resumeMaterial()).toHaveValue(draftTitle);
    await page.getByTestId('view-graph').click();
    await expect(page.getByTestId('graph-node-import')).toHaveAttribute('data-manual', 'true');
    assert.deepEqual((await state()).view.layouts, beforeReload.view.layouts);
    assert.deepEqual((await state()).view.positions, baseline);
    await routesClear('after reload');
    await fit();
    if (await page.getByRole('button', { name: '关闭提示', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    await page.screenshot({ path: path.join(directory, '02-arranged-1440x900.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.getByRole('button', { name: '关闭节点编辑区', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭节点编辑区', exact: true }).click();
    await fit();
    await page.screenshot({ path: path.join(directory, '03-arranged-390x844.png'), fullPage: false });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'narrow viewport must not overflow the document');
    check('reload restores layouts and draft; desktop and narrow viewport screenshots are captured');

    await context.close();
    const oldURL = app.url;
    await app.close();
    app = await startServer({ taskDirectory });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    watchPage(await context.newPage());
    await page.goto(app.url);
    await expect(await resumeMaterial()).toHaveValue(draftTitle);
    await page.getByTestId('view-graph').click();
    await expect(page.getByTestId('graph-node-import')).toHaveAttribute('data-manual', 'true');
    const restarted = await state();
    assert.notEqual(app.url, oldURL);
    assert.deepEqual(restarted.view.layouts, beforeReload.view.layouts);
    assert.deepEqual(restarted.view.positions, baseline);
    assert.equal(restarted.modelHash, initial.modelHash);
    assert.equal(restarted.workRevision, beforeArrange.workRevision);
    assert.deepEqual(restarted.model, initial.model);
    assert.deepEqual(restarted.pendingEdits, initial.pendingEdits);
    assert.deepEqual(restarted.changes, initial.changes);
    assert.deepEqual(errors, []);
    check('server restart with a fresh browser restores scoped layout and draft without changing the content model');

    const beforeFailedMove = await state();
    const failedNodeId = 'manual';
    let failedMove;
    const retryPosition = () => page.getByRole('button', { name: '重试保存位置', exact: true });
    const assertPendingPosition = async () => {
      await expect.poll(async () => page.getByTestId('graph-node-' + failedNodeId).evaluate((node, expected) => {
        const matrix = new DOMMatrixReadOnly(node.closest('.react-flow__node').style.transform);
        return Math.hypot(matrix.e - expected.x, matrix.f - expected.y);
      }, failedMove.positions[failedNodeId])).toBeLessThan(.001);
      const localPending = await page.evaluate(workspaceId => JSON.parse(sessionStorage.getItem(`6ak.workbench.${workspaceId}.pending-positions`) || '{}'), beforeFailedMove.workspaceId);
      assert.deepEqual(localPending.execute[failedNodeId], failedMove.positions[failedNodeId]);
      assert.deepEqual(scoped(await state()), scoped(beforeFailedMove), 'failed move cannot alter the saved layout');
    };
    await page.route('**/api/workbench/view', async route => {
      const body = route.request().postDataJSON();
      if (route.request().method() === 'PATCH' && body?.layout?.action === 'move') {
        failedMove = body.layout;
        await route.abort('failed');
      } else await route.continue();
    });
    await dragGesture(failedNodeId, 42, 25);
    await expect(retryPosition()).toBeVisible();
    assert.equal(failedMove.scopeId, 'execute');
    assert.notDeepEqual(failedMove.positions[failedNodeId], position(beforeFailedMove, failedNodeId));
    await assertPendingPosition();
    await expect(page.getByTestId('arrange-layout')).toBeDisabled();
    await expect(page.getByTestId('reset-layout')).toBeDisabled();
    await switchGroup('prepare');
    await expect(retryPosition()).toHaveCount(0);
    assert.deepEqual(scoped(await state(), 'prepare'), scoped(beforeFailedMove, 'prepare'));
    await switchGroup('execute');
    await expect(retryPosition()).toBeVisible();
    await assertPendingPosition();
    await page.getByRole('button', { name: '关闭布局提示', exact: true }).click();
    await expect(retryPosition()).toBeVisible();
    await page.reload();
    await expect(retryPosition()).toBeVisible();
    await assertPendingPosition();
    await page.unroute('**/api/workbench/view');
    await retryPosition().click();
    await expect.poll(async () => position(await state(), failedNodeId)).toEqual(failedMove.positions[failedNodeId]);
    await expect(retryPosition()).toHaveCount(0);
    await expect(page.getByTestId('graph-node-' + failedNodeId)).toHaveAttribute('data-manual', 'true');
    const retried = await state();
    assert.ok(scoped(retried).manualNodeIds.includes(failedNodeId));
    assert.deepEqual(scoped(retried, 'prepare'), scoped(beforeFailedMove, 'prepare'));
    assert.deepEqual(retried.view.positions, baseline);
    assert.equal(retried.modelHash, initial.modelHash);
    assert.equal(retried.workRevision, initial.workRevision);
    const savedPending = await page.evaluate(workspaceId => JSON.parse(sessionStorage.getItem(`6ak.workbench.${workspaceId}.pending-positions`) || '{}'), beforeFailedMove.workspaceId);
    assert.equal(savedPending.execute?.[failedNodeId], undefined);
    assert.deepEqual(errors, []);
    check('failed position save survives group changes, dismiss and reload, then retries without altering another group or content');

    await fit();
    await page.getByTestId('graph-node-manual').click();
    const beforeKeyboard = await state();
    const keyboardNode = page.locator('.react-flow__node[data-id="manual"]');
    await expect(keyboardNode).toHaveClass(/selected/);
    await keyboardNode.focus();
    await keyboardNode.press('ArrowRight');
    const keyboardPosition = { x: position(beforeKeyboard, 'manual').x + 5, y: position(beforeKeyboard, 'manual').y };
    await expect.poll(async () => position(await state(), 'manual')).toEqual(keyboardPosition);
    await expect(page.getByTestId('graph-node-manual')).toHaveAttribute('data-manual', 'true');
    check('keyboard movement saves a five-pixel step');

    const beforeReset = await state();
    const reset = await automaticLayout('reset-layout');
    assert.notDeepEqual(position(reset, 'manual'), keyboardPosition);
    assert.deepEqual(scoped(reset).manualNodeIds, []);
    assert.deepEqual(scoped(reset, 'prepare'), scoped(beforeReset, 'prepare'));
    assert.equal(reset.modelHash, initial.modelHash);
    assert.equal(reset.workRevision, initial.workRevision);
    await expect(page.getByTestId('reset-layout')).toBeDisabled();
    const recovered = await undoLayout();
    assert.deepEqual(scoped(recovered).positions, scoped(beforeReset).positions);
    assert.deepEqual(scoped(recovered).manualNodeIds, scoped(beforeReset).manualNodeIds);
    assert.deepEqual(scoped(recovered, 'prepare'), scoped(beforeReset, 'prepare'));
    assert.deepEqual(errors, []);
    check('the reset button clears only current graph positions and undo restores manual positions and their markers');
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ passed: true, checks, errors, taskDirectory, layoutRequests }, null, 2));
    console.log('LAYOUT_BROWSER_QA=' + directory);
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: false }).catch(() => {});
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ passed: false, checks, errors, error: error.stack, taskDirectory, layoutRequests }, null, 2));
    console.error('LAYOUT_BROWSER_QA=' + directory);
    throw error;
  } finally { await browser.close(); await app.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
