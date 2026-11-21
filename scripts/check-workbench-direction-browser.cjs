'use strict';

// Every task and screenshot in this integration check is synthetic and isolated.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const { startServer } = require('../workbench/scripts/workbench.cjs');
const { createStore } = require('../workbench/scripts/workbench-store.cjs');
const { createDemoModel, createDemoPositions } = require('../workbench/scripts/workbench-demo-fixture.cjs');

const layout = (state, direction, scope = 'execute') => (direction === 'RIGHT' ? state.view.horizontalLayouts : state.view.layouts)?.[scope];
const business = state => ({ model: state.model, modelHash: state.modelHash, workRevision: state.workRevision, pendingEdits: state.pendingEdits, changes: state.changes });

async function renderedGeometry(page, relations, direction) {
  return page.evaluate(({ relations, direction }) => {
    const boxes = [...document.querySelectorAll('.react-flow__node')].map(node => {
      const card = node.querySelector('.process-card');
      const rect = card.getBoundingClientRect();
      return { id: node.dataset.id, x: rect.x, y: rect.y, width: rect.width, height: rect.height, cardWidth: card.offsetWidth, nodeWidth: node.offsetWidth };
    });
    const collisions = [], endpoints = [], routes = [], cuts = [];
    for (const element of document.querySelectorAll('.react-flow__edge')) {
      const relation = relations.find(edge => edge.id === element.dataset.id);
      const curve = element.querySelector('path.react-flow__edge-path');
      if (!relation || !curve) continue;
      const transform = curve.getScreenCTM(), length = curve.getTotalLength();
      if (!transform || !length) continue;
      const source = boxes.find(box => box.id === relation.from), target = boxes.find(box => box.id === relation.to);
      const portError = (point, box, from) => {
        const isReturn = relation.type === 'return';
        const horizontal = direction === 'RIGHT' ? isReturn : !isReturn;
        const along = horizontal ? point.x : point.y;
        const low = horizontal ? box.x : box.y;
        const high = low + (horizontal ? box.width : box.height);
        const side = horizontal ? box.y + (!isReturn && from ? box.height : 0) : box.x + (!isReturn && from ? box.width : 0);
        return Math.max(low - along, along - high, Math.abs((horizontal ? point.y : point.x) - side));
      };
      const points = [];
      for (let distance = 0; distance < length; distance += 2) points.push(curve.getPointAtLength(distance));
      points.push(curve.getPointAtLength(length));
      const first = points[0], last = points.at(-1);
      endpoints.push({
        id: relation.id, start: { x: first.x, y: first.y }, end: { x: last.x, y: last.y },
        startError: portError(first.matrixTransform(transform), source, true), endError: portError(last.matrixTransform(transform), target, false),
      });
      const hit = new Set();
      for (const sample of points) {
        const point = sample.matrixTransform(transform);
        for (const box of boxes) if (![relation.from, relation.to].includes(box.id)
          && point.x > box.x + 1 && point.x < box.x + box.width - 1 && point.y > box.y + 1 && point.y < box.y + box.height - 1) hit.add(box.id);
      }
      for (const obstacle of hit) collisions.push({ edge: relation.id, obstacle });
      const runs = [];
      for (let index = 1; index < points.length; index++) {
        const a = points[index - 1], b = points[index];
        // React Flow snaps the ELK endpoints to measured handles. A fraction
        // of a graph pixel of drift can appear on an otherwise straight run.
        const axis = Math.abs(a.x - b.x) < .12 ? 'x' : Math.abs(a.y - b.y) < .12 ? 'y' : null;
        if (!axis) continue; // Rounded corners have no straight run.
        const along = axis === 'x' ? 'y' : 'x';
        const low = Math.min(a[along], b[along]), high = Math.max(a[along], b[along]);
        const previous = runs.at(-1);
        if (previous?.axis === axis && Math.abs(previous.position - a[axis]) < .75 && low <= previous.high && high >= previous.low) {
          previous.low = Math.min(previous.low, low);
          previous.high = Math.max(previous.high, high);
        } else {
          runs.push({ axis, position: a[axis], low, high });
        }
      }
      const drawing = curve.closest('[data-route-mode]');
      const maskId = curve.getAttribute('mask')?.match(/^url\(#([^)]+)\)$/)?.[1];
      const interaction = element.querySelector('path.react-flow__edge-interaction');
      const mask = maskId && document.getElementById(maskId);
      const circles = mask ? [...mask.querySelectorAll('circle')] : [];
      const crossingCount = Number(drawing.dataset.crossingCount || 0);
      routes.push({ id: relation.id, strategy: drawing.dataset.routeMode, runs, crossingCount });
      for (const circle of circles) {
        const x = circle.cx.baseVal.value, y = circle.cy.baseVal.value, radius = circle.r.baseVal.value;
        const screen = new DOMPoint(x, y).matrixTransform(transform);
        const screenRadius = radius * Math.hypot(transform.a, transform.b);
        cuts.push({ id: relation.id, x, y, radius, screenX: screen.x, screenY: screen.y,
          isMaskCut: getComputedStyle(mask).maskType === 'luminance' && getComputedStyle(circle).fill === 'rgb(0, 0, 0)',
          interactionIsWhole: interaction?.getAttribute('d') === curve.getAttribute('d') && !interaction?.getAttribute('mask'),
          touchesCard: boxes.some(box => screen.x + screenRadius >= box.x && screen.x - screenRadius <= box.x + box.width
            && screen.y + screenRadius >= box.y && screen.y - screenRadius <= box.y + box.height),
        });
      }
    }
    const coincident = [];
    for (const [index, first] of routes.entries()) for (const second of routes.slice(index + 1)) {
      let length = 0;
      for (const a of first.runs) for (const b of second.runs) {
        if (a.axis !== b.axis || Math.abs(a.position - b.position) > 1) continue;
        length = Math.max(length, Math.min(a.high, b.high) - Math.max(a.low, b.low));
      }
      if (length >= 12) coincident.push({ first: first.id, second: second.id, length });
    }
    const runAt = (run, { x, y }) => {
      const constant = run.axis === 'x' ? x : y, varying = run.axis === 'x' ? y : x;
      return Math.abs(run.position - constant) < 1 && varying > run.low + 2 && varying < run.high - 2;
    };
    const crossings = cuts.map(cut => {
      const interrupted = routes.find(route => route.id === cut.id);
      const unbroken = routes.filter(route => route !== interrupted && route.runs.some(other => runAt(other, cut)
        && interrupted.runs.some(run => run.axis !== other.axis && runAt(run, cut)))).map(route => route.id);
      const cutsHere = cuts.filter(other => Math.hypot(cut.x - other.x, cut.y - other.y) < 1).length;
      return { ...cut, unbroken, cutsHere };
    });
    const intersections = [];
    for (const [index, first] of routes.entries()) for (const second of routes.slice(index + 1)) {
      for (const a of first.runs) for (const b of second.runs) {
        if (a.axis === b.axis) continue;
        const point = a.axis === 'x' ? { x:a.position, y:b.position } : { x:b.position, y:a.position };
        if (runAt(a, point) && runAt(b, point)) intersections.push(point);
      }
    }
    return { boxes, collisions, endpoints, routes: routes.map(({ runs, ...route }) => route), coincident, crossings, intersections };
  }, { relations, direction });
}

function assertSeparateBranches(report) {
  const pairs = [
    ['start', 'validate--approval', 'validate--dispatch'],
    ['start', 'approval--dispatch', 'approval--recalculate'],
    ['end', 'validate--dispatch', 'approval--dispatch'],
    ['end', 'manual--validate', 'import--validate'],
  ];
  for (const [side, first, second] of pairs) {
    const a = report.endpoints.find(endpoint => endpoint.id === first)?.[side];
    const b = report.endpoints.find(endpoint => endpoint.id === second)?.[side];
    assert.ok(a && b, `both ${first} and ${second} must render`);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 8, `${first} and ${second} need separate ${side} points`);
  }
  assert.deepEqual(report.coincident, [], 'no pair of routes can share a straight segment of at least 12 graph pixels');
}

function assertCrossings(report) {
  for (const p of report.intersections) {
    assert.ok(report.crossings.some(c => Math.hypot(c.x - p.x, c.y - p.y) < 2), 'a rendered orthogonal crossing must have a visible gap');
  }
  for (const route of report.routes) {
    assert.equal(route.crossingCount, report.crossings.filter(crossing => crossing.id === route.id).length);
  }
  for (const crossing of report.crossings) {
    assert.equal(crossing.cutsHere, 1, 'only one line should be cut at an intersection');
    assert.ok(crossing.unbroken.length > 0, 'the gap must sit on an orthogonal crossing');
    assert.ok(crossing.radius > 0 && crossing.radius <= 12, 'crossing gaps must be small');
    assert.ok(crossing.isMaskCut && crossing.interactionIsWhole, 'mask the visible stroke and leave its interaction path intact');
    assert.equal(crossing.touchesCard, false, 'masks must leave card connections intact');
  }
}

async function main() {
  const directory = path.resolve('.qa/workbench-direction-browser', `run-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  const { getGraphScope } = await import('../workbench/frontend/src/graph-scope.mjs');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
  const checks = [], errors = [], requests = [], metrics = {}, geometry = [];
  let app, context, page, scenario;
  const state = () => fetch(app.url + '/api/workbench/state').then(response => response.json());
  const check = name => { checks.push(name); console.log('PASS ' + name); };
  const closeTask = async () => { if (context) { await context.close(); context = null; } if (app) { await app.close(); app = null; } };
  const openTask = async (name, viewport, prepare) => {
    await closeTask(); scenario = name;
    const taskDirectory = path.join(directory, name, 'task');
    if (prepare) await prepare(taskDirectory);
    app = await startServer({ taskDirectory });
    context = await browser.newContext({ viewport });
    page = await context.newPage();
    page.on('pageerror', error => errors.push({ scenario: name, error: error.message }));
    page.on('request', request => {
      if (request.method() !== 'PATCH' || !request.url().endsWith('/api/workbench/view')) return;
      const body = request.postDataJSON();
      if (body.layout || body.layoutDirection) requests.push({ scenario: name, layout: body.layout, preference: body.layoutDirection });
    });
    const seed = await state();
    await page.goto(app.url);
    return seed;
  };
  const ready = async (direction, scope = 'execute') => {
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-direction', direction, { timeout: 30000 });
    await expect.poll(async () => layout(await state(), direction, scope)?.revision || 0, { timeout: 30000 }).toBeGreaterThan(0);
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await expect(page.getByTestId('arrange-layout')).toBeEnabled({ timeout: 30000 });
    const count = getGraphScope((await state()).model, scope).nodes.length;
    await expect(page.locator('.react-flow__node')).toHaveCount(count);
    await expect.poll(() => page.locator('.react-flow__node').evaluateAll(nodes => [...new Set(nodes.map(node => node.offsetWidth))])).toEqual([direction === 'RIGHT' ? 240 : 200]);
    await expect(page.locator('[data-route-mode="pending"]')).toHaveCount(0, { timeout: 30000 });
  };
  const selectDirection = async (mode, resolved, scope = 'execute') => {
    await page.getByTestId('layout-direction').selectOption(mode);
    await expect.poll(async () => (await state()).view.layoutDirections?.[scope]?.mode).toBe(mode);
    await expect(page.getByTestId('layout-direction')).toHaveValue(mode);
    await ready(resolved, scope);
  };
  const switchGroup = async (scope, direction) => {
    const item = page.getByTestId('group-' + scope);
    if (!(await item.isVisible())) await page.getByRole('button', { name: '展开分组导航', exact: true }).click();
    await item.click();
    await expect(item).toHaveAttribute('aria-current', 'page');
    await ready(direction, scope);
  };
  const fit = async () => {
    await page.getByRole('button', { name: '适应当前图', exact: true }).click();
    await page.waitForTimeout(150);
  };
  const assertGeometry = async (label, direction) => {
    await fit();
    const report = await renderedGeometry(page, (await state()).model.relations, direction);
    geometry.push({ label, direction, ...report });
    assert.ok(report.routes.length > 0);
    assert.deepEqual(report.collisions, [], label + ': routes must avoid unrelated cards');
    for (const endpoint of report.endpoints) {
      assert.ok(endpoint.startError < 6 && endpoint.endError < 6, `${label}: ${endpoint.id} must attach at the correct direction ports`);
    }
    for (const box of report.boxes) assert.equal(box.cardWidth, box.nodeWidth, 'node wrapper must match rendered card width');
    await page.screenshot({ path: path.join(directory, label + '.png') });
    return report;
  };
  const dragGesture = async (id, dx = 32, dy = -24) => {
    await fit();
    const hit = await page.getByTestId('graph-node-' + id).evaluate(card => {
      const box = card.getBoundingClientRect();
      for (const xp of [.5, .7, .3]) for (const yp of [.3, .5, .7]) {
        const x = box.x + box.width * xp, y = box.y + box.height * yp;
        if (document.elementFromPoint(x, y)?.closest('.process-card') === card) return { x, y };
      }
      return null;
    });
    assert.ok(hit, `drag target ${id} must be visible`);
    await page.mouse.move(hit.x, hit.y); await page.mouse.down();
    await page.mouse.move(hit.x + dx, hit.y + dy, { steps: 8 }); await page.mouse.up();
  };
  const drag = async (id, direction, dx = 32, dy = -24) => {
    const before = layout(await state(), direction).positions[id];
    await dragGesture(id, dx, dy);
    await expect.poll(async () => layout(await state(), direction).positions[id]).not.toEqual(before);
    await expect(page.getByTestId('graph-node-' + id)).toHaveAttribute('data-manual', 'true');
    await expect(page.getByTestId('arrange-layout')).toBeEnabled({ timeout: 30000 });
    return layout(await state(), direction).positions[id];
  };
  const assertClickGeometry = async (id, direction) => {
    const before = await state();
    const layoutRequests = requests.length;
    const title = before.model.nodes.find(node => node.id === id).title;
    const node = page.getByTestId('graph-node-' + id);
    const routeURL = '**/api/workbench/view';
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const isSelection = request => request.method() === 'PATCH' && request.url().endsWith('/api/workbench/view') && request.postDataJSON()?.selectedNodeId === id;
    const holdSelection = async route => {
      if (isSelection(route.request())) await gate;
      await route.continue();
    };
    await page.route(routeURL, holdSelection);
    await page.getByTestId('graph-canvas').evaluate(canvas => {
      const changes = { pending: [], alteredPaths: [], alteredMasks: [], dragging: [] };
      const note = (list, id) => { if (!list.includes(id)) list.push(id); };
      const observer = new MutationObserver(records => {
        for (const { target, attributeName, oldValue } of records) {
          if (attributeName === 'data-route-mode' && (target.dataset.routeMode === 'pending' || oldValue === 'pending')) note(changes.pending, target.dataset.routeId);
          if (attributeName === 'd' && target.matches('.react-flow__edge-path') && target.getAttribute('d') !== oldValue) note(changes.alteredPaths, target.closest('[data-route-id]').dataset.routeId);
          if (attributeName === 'mask' && target.matches('.react-flow__edge-path') && target.getAttribute('mask') !== oldValue) note(changes.alteredMasks, target.closest('[data-route-id]').dataset.routeId);
          if (attributeName === 'class' && target.matches('.react-flow__node') && (target.classList.contains('dragging') || oldValue?.split(' ').includes('dragging'))) note(changes.dragging, target.dataset.id);
        }
      });
      observer.observe(canvas, { attributes: true, attributeOldValue: true, attributeFilter: ['d', 'mask', 'data-route-mode', 'class'], subtree: true });
      window.inspectClickGeometry = stop => {
        if (stop) observer.disconnect();
        return changes;
      };
    });
    try {
      const savedSelection = page.waitForResponse(response => isSelection(response.request()));
      await node.locator('.node-title').click();
      await expect(page.getByTestId('node-title')).toHaveText(title);
      await expect(node).toHaveClass(/\bis-selected\b/);
      const waitingForSave = await page.evaluate(() => window.inspectClickGeometry(false));
      release();
      assert.ok((await savedSelection).ok());
      await page.waitForTimeout(150); // Capture the interim frame and any scheduled recompute.
      const afterSave = await page.evaluate(() => window.inspectClickGeometry(true));
      metrics[`click-${id}`] = { waitingForSave, afterSave };
      const noChanges = { pending: [], alteredPaths: [], alteredMasks: [], dragging: [] };
      assert.deepEqual(waitingForSave, noChanges, 'clicking a card must not drag it or change edge geometry');
      assert.deepEqual(afterSave, noChanges, 'persisting the selection must keep existing routes on screen');
      const after = await state();
      assert.equal(after.view.selectedNodeId, id);
      assert.deepEqual(layout(after, direction), layout(before, direction));
      assert.equal(requests.length, layoutRequests, 'clicking a card must not request a layout update');
    } finally {
      release();
      await page.unroute(routeURL, holdSelection);
    }
  };
  const assertBusiness = async seed => assert.deepEqual(business(await state()), business(seed), 'layout operations must not change business content or revision');
  const saveSummary = extra => fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ checks, errors, requests, metrics, geometry, ...extra }, null, 2));

  try {
    // Keep a portrait canvas to verify AUTO selects DOWN, then expands to RIGHT when wider.
    const seed = await openTask('new-auto-task', { width: 820, height: 1000 });
    assert.equal(seed.view.defaultLayoutDirection, 'AUTO');
    await ready('DOWN');
    await expect(page.getByTestId('layout-direction')).toHaveValue('AUTO');
    metrics.narrowCanvas = await page.getByTestId('graph-canvas').evaluate(node => ({ width: node.clientWidth, height: node.clientHeight }));
    assert.ok(metrics.narrowCanvas.width < metrics.narrowCanvas.height, 'the canvas is portrait');
    await assertGeometry('01-auto-vertical', 'DOWN');
    const verticalPosition = await drag('manual', 'DOWN');
    const vertical = structuredClone(layout(await state(), 'DOWN'));
    await page.setViewportSize({ width: 1920, height: 927 });
    await ready('RIGHT');
    assert.deepEqual(layout(await state(), 'DOWN'), vertical);
    assert.deepEqual(layout(await state(), 'RIGHT').manualNodeIds, []);
    await assertGeometry('02-auto-horizontal', 'RIGHT');
    check('new tasks choose direction from actual canvas dimensions;240/200px cards and ports render correctly');

    await selectDirection('RIGHT', 'RIGHT');
    const horizontalPosition = await drag('manual', 'RIGHT', -28, 22);
    const horizontal = structuredClone(layout(await state(), 'RIGHT'));
    await page.setViewportSize({ width: 820, height: 1000 });
    await ready('RIGHT');
    await expect(page.getByTestId('layout-direction')).toHaveValue('RIGHT');
    await page.reload(); await ready('RIGHT');
    await expect(page.getByTestId('layout-direction')).toHaveValue('RIGHT');
    assert.deepEqual(layout(await state(), 'RIGHT'), horizontal);
    await selectDirection('AUTO', 'DOWN');
    assert.deepEqual(layout(await state(), 'DOWN'), vertical);
    assert.deepEqual(layout(await state(), 'DOWN').positions.manual, verticalPosition);
    await selectDirection('RIGHT', 'RIGHT');
    assert.deepEqual(layout(await state(), 'RIGHT'), horizontal);
    assert.deepEqual(layout(await state(), 'RIGHT').positions.manual, horizontalPosition);
    check('manual preference survives resize/reload and direction changes restore separate saved positions and manual flags');

    const beforeReset = await state();
    await page.getByTestId('reset-layout').click();
    await expect.poll(async () => layout(await state(), 'RIGHT').revision, { timeout: 30000 }).toBeGreaterThan(horizontal.revision);
    await ready('RIGHT');
    assert.deepEqual(layout(await state(), 'RIGHT').manualNodeIds, []);
    assert.deepEqual(layout(await state(), 'DOWN'), layout(beforeReset, 'DOWN'));
    const resetRevision = layout(await state(), 'RIGHT').revision;
    await page.getByTestId('undo-layout').click();
    await expect.poll(async () => layout(await state(), 'RIGHT').revision).toBeGreaterThan(resetRevision);
    await ready('RIGHT');
    assert.deepEqual(layout(await state(), 'RIGHT').positions, horizontal.positions);
    assert.deepEqual(layout(await state(), 'RIGHT').manualNodeIds, horizontal.manualNodeIds);
    assert.deepEqual(layout(await state(), 'DOWN'), vertical);
    check('reset and undo are isolated to the current orientation');

    await page.setViewportSize({ width: 1920, height: 927 }); await ready('RIGHT');
    const executeLayout = structuredClone(layout(await state(), 'RIGHT'));
    await switchGroup('prepare', 'RIGHT');
    await expect(page.getByTestId('layout-direction')).toHaveValue('AUTO');
    await selectDirection('DOWN', 'DOWN', 'prepare');
    const prepareLayout = structuredClone(layout(await state(), 'DOWN', 'prepare'));
    await switchGroup('execute', 'RIGHT');
    await expect(page.getByTestId('layout-direction')).toHaveValue('RIGHT');
    assert.deepEqual(layout(await state(), 'RIGHT'), executeLayout);
    assert.deepEqual(layout(await state(), 'DOWN', 'prepare'), prepareLayout);
    await selectDirection('AUTO', 'RIGHT');
    await page.setViewportSize({ width: 1200, height: 1000 }); await ready('RIGHT');
    await page.getByRole('button', { name: '打开节点详情', exact: true }).click(); await ready('DOWN');
    await page.getByRole('button', { name: '收起节点详情', exact: true }).click(); await ready('RIGHT');
    await assertBusiness(seed);
    assert.deepEqual((await state()).view.positions, seed.view.positions);
    check('direction preferences are per group; automatic mode follows editor width without modifying content or imported positions');

    const pendingSeed = await openTask('pending-horizontal-move', { width: 820, height: 1000 });
    await ready('DOWN');
    const pendingVertical = structuredClone(layout(await state(), 'DOWN'));
    await page.setViewportSize({ width: 1920, height: 927 }); await ready('RIGHT');
    const pendingHorizontal = structuredClone(layout(await state(), 'RIGHT'));
    const pendingNode = 'manual';
    let failedMove;
    await page.route('**/api/workbench/view', async route => {
      const body = route.request().postDataJSON();
      if (!failedMove && body?.layout?.action === 'move' && body.layout.direction === 'RIGHT') {
        failedMove = body.layout;
        return route.abort('failed');
      }
      return route.continue();
    });
    const pendingCache = () => page.evaluate(workspaceId => JSON.parse(sessionStorage.getItem(`6ak.workbench.${workspaceId}.pending-positions`) || '{}'), pendingSeed.workspaceId);
    const assertPendingRight = async () => {
      assert.ok(failedMove?.positions[pendingNode], 'the failed request must capture the horizontal node position');
      await expect.poll(() => page.getByTestId('graph-node-' + pendingNode).evaluate((card, expected) => {
        const matrix = new DOMMatrixReadOnly(card.closest('.react-flow__node').style.transform);
        return Math.hypot(matrix.e - expected.x, matrix.f - expected.y);
      }, failedMove.positions[pendingNode])).toBeLessThan(.001);
      assert.deepEqual((await pendingCache())['execute:RIGHT'][pendingNode], failedMove.positions[pendingNode]);
      assert.deepEqual(layout(await state(), 'RIGHT'), pendingHorizontal, 'a failed move cannot change the horizontal saved layout');
      assert.deepEqual(layout(await state(), 'DOWN'), pendingVertical, 'a horizontal pending move cannot change the vertical layout');
    };
    await dragGesture(pendingNode, 30, -22);
    const retryPosition = page.getByRole('button', { name: '重试保存位置', exact: true });
    await expect(retryPosition).toBeVisible();
    await expect(page.getByTestId('layout-direction')).toBeDisabled();
    await assertPendingRight();
    await page.setViewportSize({ width: 820, height: 1000 });
    await expect.poll(() => page.getByTestId('graph-canvas').evaluate(node => node.clientHeight > node.clientWidth)).toBe(true);
    await page.waitForTimeout(350); // Let the responsive direction debounce settle.
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-direction', 'RIGHT');
    await assertPendingRight();
    await page.screenshot({ path: path.join(directory, '04-pending-horizontal-retained.png') });
    await page.reload(); await ready('DOWN');
    assert.deepEqual((await pendingCache())['execute:RIGHT'][pendingNode], failedMove.positions[pendingNode]);
    await expect(page.getByTestId('layout-direction')).toBeEnabled();
    await page.getByTestId('layout-direction').selectOption('RIGHT');
    await expect.poll(async () => (await state()).view.layoutDirections?.execute?.mode).toBe('RIGHT');
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-direction', 'RIGHT');
    await expect(retryPosition).toBeVisible();
    await expect(page.getByTestId('layout-direction')).toBeDisabled();
    await assertPendingRight();
    await retryPosition.click();
    await expect.poll(async () => layout(await state(), 'RIGHT').positions[pendingNode]).toEqual(failedMove.positions[pendingNode]);
    await ready('RIGHT');
    await expect(retryPosition).toHaveCount(0);
    await expect(page.getByTestId('layout-direction')).toBeEnabled();
    assert.equal((await pendingCache())['execute:RIGHT']?.[pendingNode], undefined);
    assert.deepEqual(layout(await state(), 'DOWN'), pendingVertical);
    await assertBusiness(pendingSeed);
    await page.unroute('**/api/workbench/view');
    check('failed horizontal moves survive resize and reload in their own direction cache; retry saves only RIGHT');

    const branchSeed = await openTask('horizontal-branch-visibility', { width: 1920, height: 927 });
    await ready('RIGHT');
    const beforeArrange = layout(await state(), 'RIGHT').revision;
    await page.getByTestId('arrange-layout').click();
    await expect.poll(async () => layout(await state(), 'RIGHT').revision).toBeGreaterThan(beforeArrange);
    await ready('RIGHT');
    const arrangedBranches = await assertGeometry('05-horizontal-branch-arranged', 'RIGHT');
    assertSeparateBranches(arrangedBranches);
    assertCrossings(arrangedBranches);
    assert.ok(arrangedBranches.routes.some(route => route.strategy === 'elk'), 'arrangement must exercise saved ELK routes');
    const branchPath = id => page.locator(`[data-route-id="${id}"] .react-flow__edge-path`);
    const hoverPoint = await branchPath('validate--dispatch').evaluate(curve => {
      for (const ratio of [.5, .35, .65]) {
        const { x, y } = curve.getPointAtLength(curve.getTotalLength() * ratio).matrixTransform(curve.getScreenCTM());
        if (document.elementFromPoint(x, y)?.closest('.react-flow__edge')?.dataset.id === 'validate--dispatch') return { x, y };
      }
    });
    assert.ok(hoverPoint, 'a branch must be individually reachable by the pointer');
    await page.mouse.move(hoverPoint.x, hoverPoint.y);
    await expect(branchPath('validate--dispatch')).toHaveCSS('stroke', 'rgb(22, 129, 109)');
    await expect(branchPath('validate--approval')).toHaveCSS('stroke', 'rgb(100, 126, 128)');
    await page.mouse.move(5, 5);
    await assertClickGeometry('approval', 'RIGHT');
    await drag('approval', 'RIGHT', 32, -24);
    await ready('RIGHT');
    const movedBranches = await assertGeometry('06-horizontal-branch-moved', 'RIGHT');
    assertSeparateBranches(movedBranches);
    assertCrossings(movedBranches);
    assert.ok(movedBranches.routes.some(route => route.strategy === 'smart'), 'dragging must exercise live obstacle routing');
    await assertClickGeometry('dispatch', 'RIGHT');
    await assertBusiness(branchSeed);
    check('horizontal branches and joins use separate ports and remain stable through selection after arrangement and a manual move');
    // Pin a horizontal connection across the only direct corridor between the
    // other two cards. This fixture remains crossed when ordinary fan-outs improve.
    const crossingScope = 'crossing';
    await openTask('forced-orthogonal-crossing', { width: 1920, height: 927 }, taskDirectory => {
      const model = createDemoModel();
      model.groups.push({ id: crossingScope, title: '交叉处显示', kind: 'editorial', claimIds: [] });
      const points = { west:{x:0,y:300}, east:{x:1500,y:300}, above:{x:450,y:0}, below:{x:800,y:650} };
      for (const id of Object.keys(points)) model.nodes.push({ ...structuredClone(model.nodes[0]), id, groupId: crossingScope });
      const link = model.relations.find(r => r.type === 'sequence');
      for (const [from,to] of [['west','east'],['above','below']]) model.relations.push({ ...structuredClone(link), id: from+'--'+to, from, to });
      const store = createStore(taskDirectory, {model, initialGroupId:crossingScope});
      const original = store.read();
      const view = {scopeId:crossingScope, direction:'RIGHT', positions:points};
      store.updateView({layout:{...view, action:'initialize', baseRevision:0, baseModelHash:original.modelHash, routes:{}}});
      store.updateView({layout:{...view, action:'move', baseRevision:1}});
    });
    await ready('RIGHT', crossingScope);
    const forced = await assertGeometry('07-forced-orthogonal-crossing','RIGHT');
    assert.equal(forced.intersections.length,1, 'the pinned fixture must produce exactly one actual crossing');
    assertCrossings(forced);
    const { screenX, screenY } = forced.crossings[0];
    await page.mouse.move(screenX, screenY);
    await page.mouse.wheel(0, -460);
    await page.waitForTimeout(180);
    await page.mouse.move(5, 5);
    const { width, height } = page.viewportSize();
    await page.screenshot({ path: path.join(directory, '07-crossing-detail.png'), clip: {
      x: Math.round(Math.max(0, Math.min(width - 520, screenX - 260))),
      y: Math.round(Math.max(0, Math.min(height - 320, screenY - 160))), width: 520, height: 320,
    } });
    check('perpendicular crossings have a single stroke gap and uninterrupted hit targets');

    let legacySaved;
    const legacy = await openTask('legacy-vertical-task', { width: 1920, height: 927 }, taskDirectory => {
      const model = createDemoModel();
      const positions = Object.fromEntries(Object.entries(createDemoPositions()).map(([id, point]) => [id, { x: point.x * 2, y: point.y * 2 }]));
      const store = createStore(taskDirectory, { model, positions, initialGroupId: 'execute' });
      const original = store.read();
      const visible = getGraphScope(model, 'execute').visibleIds;
      store.updateView({ layout: { scopeId: 'execute', action: 'initialize', baseRevision: 0, baseModelHash: original.modelHash, positions: Object.fromEntries(Object.entries(positions).filter(([id]) => visible.has(id))), routes: {} } });
      const stateFile = path.join(taskDirectory, 'workbench/state.json');
      const snapshot = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      delete snapshot.view.defaultLayoutDirection;
      delete snapshot.view.layoutDirections;
      delete snapshot.view.horizontalLayouts;
      fs.writeFileSync(stateFile, JSON.stringify(snapshot, null, 2));
      legacySaved = structuredClone(snapshot.view.layouts);
    });
    await ready('DOWN');
    await expect(page.getByTestId('layout-direction')).toHaveValue('DOWN');
    assert.deepEqual((await state()).view.layouts, legacySaved);
    assert.equal((await state()).view.defaultLayoutDirection, undefined);
    assert.equal((await state()).view.horizontalLayouts, undefined);
    await page.screenshot({ path: path.join(directory, '03-legacy-vertical-preserved.png') });
    await selectDirection('AUTO', 'RIGHT');
    assert.deepEqual((await state()).view.layouts, legacySaved);
    await assertBusiness(legacy);
    assert.deepEqual(errors, []);
    check('legacy tasks retain vertical coordinates and default until the user explicitly enables automatic direction');
    saveSummary({ passed: true });
    console.log('DIRECTION_BROWSER_QA=' + directory);
  } catch (error) {
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    saveSummary({ passed: false, scenario, error: error.stack });
    console.error('DIRECTION_BROWSER_QA=' + directory); throw error;
  } finally { await closeTask(); await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
