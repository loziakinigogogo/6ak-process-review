'use strict';

// All interaction checks use a generated synthetic task under .qa.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium, expect } = require('@playwright/test');
const { startComparison } = require('../workbench/scripts/compare-layout.cjs');
const { createDemoModel, createDemoPositions } = require('../workbench/scripts/workbench-demo-fixture.cjs');

async function main() {
  const directory = path.resolve('.qa/layout-comparison', `browser-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  const stateFile = path.join(directory, 'synthetic-state.json');
  // Imported positions deliberately differ from automatic layout, with room for
  // the current expanded cards; this checks preservation without overlaps.
  const importedPositions = Object.fromEntries(Object.entries(createDemoPositions()).map(([id, p]) => [id, { x: p.x * 2, y: p.y * 2 }]));
  const fixture = { model: createDemoModel(), workRevision: 0, view: { selectedGroupId: 'execute', layouts: { execute: { positions: importedPositions, routes: {} } } } };
  fs.writeFileSync(stateFile, JSON.stringify(fixture, null, 2));
  const before = fs.readFileSync(stateFile, 'utf8');
  const { getGraphScope } = await import('../workbench/frontend/src/graph-scope.mjs');
  const scope = getGraphScope(fixture.model, 'execute');
  const app = await startComparison({ stateFile, port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 927 } });
  const errors = [], writes = [], checks = [], metrics = {};
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/') && request.method() !== 'GET') writes.push(request.method() + ' ' + request.url()); });
  const ready = async () => {
    await expect(page.getByTestId('comparison-canvas')).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await expect(page.locator('.react-flow__node')).toHaveCount(scope.nodes.length);
    await expect(page.locator('[data-route-mode="pending"]')).toHaveCount(0, { timeout: 30000 });
  };
  const dimensions = () => page.locator('.react-flow__node').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.id, { width: node.offsetWidth, height: node.offsetHeight }])));
  const cardContent = () => page.locator('.react-flow__node').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.id,
    ['.node-title', '.node-role', '.node-actions'].map(selector => { const element = node.querySelector(selector); return element ? { text: element.textContent, fontSize: getComputedStyle(element).fontSize, lineHeight: getComputedStyle(element).lineHeight } : null; })
  ])));
  const assertCardGeometry = async expectedWidth => {
    const boxes = await page.locator('.react-flow__node').evaluateAll(nodes => nodes.map(node => {
      const card = node.querySelector('.process-card');
      const measured = document.querySelector(`[data-measure-id="${CSS.escape(node.dataset.id)}"] .process-card`);
      const matrix = new DOMMatrixReadOnly(node.style.transform);
      return { id: node.dataset.id, x: matrix.e, y: matrix.f, width: node.offsetWidth, height: node.offsetHeight,
        cardWidth: card.offsetWidth, cardHeight: card.offsetHeight, measuredWidth: measured.offsetWidth, measuredHeight: measured.offsetHeight };
    }));
    for (const box of boxes) {
      assert.equal(box.width, expectedWidth, `${box.id} wrapper width`);
      assert.equal(box.cardWidth, expectedWidth, `${box.id} rendered card width`);
      assert.equal(box.measuredWidth, expectedWidth, `${box.id} layout measurement width`);
      assert.equal(box.cardHeight, box.height, `${box.id} card fits its wrapper`);
      assert.equal(box.measuredHeight, box.height, `${box.id} layout uses the rendered height`);
    }
    for (const [index, a] of boxes.entries()) for (const b of boxes.slice(index + 1)) {
      assert.equal(a.x < b.x + b.width - .001 && a.x + a.width > b.x + .001
        && a.y < b.y + b.height - .001 && a.y + a.height > b.y + .001, false, `${a.id} overlaps ${b.id}`);
    }
  };
  const viewportZoom = () => page.locator('.react-flow__viewport').evaluate(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).a);
  const shell = page.locator('.comparison-shell');
  const canvasDimensions = () => page.getByTestId('comparison-canvas').evaluate(node => ({ width: node.clientWidth, height: node.clientHeight }));
  const directionReady = async direction => {
    await expect(shell).toHaveAttribute('data-direction', direction);
    await ready();
  };
  try {
    await page.goto(app.url + '/comparison.html');
    await directionReady('RIGHT');
    await expect(page.getByTestId('direction-auto')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('direction-right')).toHaveAttribute('aria-pressed', 'false');
    await expect(shell).toHaveAttribute('data-direction-mode', 'AUTO');
    await expect.poll(viewportZoom).toBeCloseTo(.82, 2);
    const rightDimensions = await dimensions();
    const originalContent = await cardContent();
    await assertCardGeometry(240);
    metrics.right = await page.getByTestId('comparison-metrics').textContent();
    await page.screenshot({ path: path.join(directory, '01-horizontal-equal.png') });
    checks.push('automatic horizontal uses measured 240px cards without overlaps at 82%');

    // Leave room for the header, toolbar and footer so the canvas becomes
    // portrait with the inspector open and landscape again when it closes.
    await page.setViewportSize({ width: 1280, height: 1080 });
    await expect.poll(async () => { const size = await canvasDimensions(); return size.width < size.height; },
      { message: 'the test viewport must produce a portrait canvas with the inspector open' }).toBe(true);
    await directionReady('DOWN');
    metrics.autoTallCanvas = await canvasDimensions();
    await assertCardGeometry(200);
    const downDimensions = await dimensions();
    assert.deepEqual(await cardContent(), originalContent, 'automatic orientation preserves text and typography');
    await page.screenshot({ path: path.join(directory, '05-auto-portrait-canvas.png') });
    await page.getByRole('button', { name: '收起详情', exact: true }).click();
    await directionReady('RIGHT');
    await assertCardGeometry(240);
    assert.deepEqual(await dimensions(), rightDimensions, 'automatic roundtrip restores horizontal dimensions');
    metrics.autoExpandedCanvas = await canvasDimensions();
    assert.ok(metrics.autoExpandedCanvas.width > metrics.autoExpandedCanvas.height);
    await page.getByRole('button', { name: '展开详情', exact: true }).click();
    await directionReady('DOWN');
    checks.push('automatic direction follows actual canvas dimensions on resize and inspector collapse/expand');

    await page.getByTestId('direction-right').click();
    await directionReady('RIGHT');
    await expect(shell).toHaveAttribute('data-direction-mode', 'RIGHT');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => { const size = await canvasDimensions(); return size.width < size.height; }).toBe(true);
    await directionReady('RIGHT');
    await expect(page.getByTestId('direction-right')).toHaveAttribute('aria-pressed', 'true');
    // On a narrow viewport the open inspector overlays the toolbar.
    await page.getByRole('button', { name: '关闭节点内容', exact: true }).click();
    await page.getByTestId('direction-auto').click();
    await directionReady('DOWN');
    await expect(shell).toHaveAttribute('data-direction-mode', 'AUTO');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(directory, '06-auto-mobile.png') });
    await page.setViewportSize({ width: 1920, height: 927 });
    await directionReady('RIGHT');
    await page.getByRole('button', { name: '展开详情', exact: true }).click();
    await directionReady('RIGHT');
    checks.push('manual direction survives portrait resize; returning to automatic resumes responsive orientation');

    await page.getByTestId('direction-down').click();
    await ready();
    await expect.poll(viewportZoom).toBeCloseTo(.82, 2);
    await assertCardGeometry(200);
    assert.deepEqual(await dimensions(), downDimensions, 'manual vertical restores original 200px card dimensions');
    assert.deepEqual(await cardContent(), originalContent, 'manual orientation preserves text and typography');
    const positions = await page.locator('.react-flow__node').evaluateAll(nodes => Object.fromEntries(nodes.map(node => { const m = new DOMMatrixReadOnly(node.style.transform); return [node.dataset.id, { x: m.e, y: m.f }]; })));
    for (const node of scope.nodes) assert.deepEqual(positions[node.id], fixture.view.layouts.execute.positions[node.id]);
    metrics.down = await page.getByTestId('comparison-metrics').textContent();
    await page.screenshot({ path: path.join(directory, '02-vertical-original.png') });
    checks.push('vertical preserves original snapshot positions, 200px widths, content, typography and 82% zoom');

    await page.getByTestId('direction-right').click(); await ready();
    await assertCardGeometry(240);
    assert.deepEqual(await dimensions(), rightDimensions, 'manual roundtrip restores horizontal dimensions');
    await page.getByTestId('fit-graph').click();
    await expect.poll(viewportZoom).toBeLessThanOrEqual(1);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(directory, '03-horizontal-fit.png') });
    const fitZoom = await viewportZoom();
    await page.getByRole('button', { name: '放大', exact: true }).click();
    await expect.poll(viewportZoom).toBeGreaterThan(fitZoom);
    await page.getByTestId('fit-graph').click();
    await expect.poll(viewportZoom).toBeCloseTo(fitZoom, 3);
    await page.getByTestId(`graph-node-${scope.coreNodes[0].id}`).click();
    await expect(page.locator('.comparison-details h2')).toHaveText(scope.coreNodes[0].title);
    await expect(page.locator('.comparison-details')).toContainText('仅查看');
    await page.getByRole('button', { name: '收起详情', exact: true }).click();
    await expect(page.locator('.inspector')).toHaveCount(0);
    checks.push('fit and repeated fit after zoom, node inspection and inspector collapse work');

    await page.getByTestId('group-all').click();
    await expect(page.getByTestId('comparison-canvas')).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await expect(page.locator('.react-flow__node')).toHaveCount(fixture.model.nodes.length);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(directory, '04-mobile.png') });
    checks.push('group switching and narrow viewport render without document overflow');

    assert.equal((await fetch(app.url + '/api/comparison/state', { method: 'PATCH', body: '{}' })).status, 405);
    assert.equal((await fetch(app.url + '/api/workbench/state')).status, 404);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before, 'the source snapshot must remain byte-identical');
    assert.deepEqual(writes, []); assert.deepEqual(errors, []);
    checks.push('no browser writes; API rejects mutation; input file is byte-identical; no page errors');
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ passed: true, checks, metrics, errors, writes }, null, 2));
    console.log(JSON.stringify({ directory, checks, metrics }, null, 2));
  } catch (error) {
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ passed: false, error: error.stack, checks, errors, writes, metrics }, null, 2));
    console.error('COMPARISON_QA=' + directory); throw error;
  } finally { await browser.close(); await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
