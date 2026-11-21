'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { chromium, expect } = require('@playwright/test');
const { startServer } = require('../skills/6ak-process-review/workbench/scripts/workbench.cjs');
const { NODE_FIELDS } = require('../skills/6ak-process-review/scripts/validate-model.cjs');

// Keep the original line shared by two distinct predicates. The other paths
// exercise existing v1 content with a long condition or indirect evidence.
function inventoryFixture() {
  const primary = '仓管核对差异数量。差异超过两件送复点，差异不超过两件归档。';
  const legacy = '复点后如发现库存名称、包装批次或数量有差异，要逐一核对入库明细、签收记录和原始清单，记录核对日期、操作人及所用计量单位；当登记表上仍有一项差异未经核实时，保留原始记录，不得直接关闭差异单，并将待核对项目完整提交主管核验。';
  const premise = '已归档的登记表如果收到更正，须提交主管核验。';
  const lines = [primary, legacy, premise];
  const source = { id: 'inventory', name: '盘点说明.md', text: lines.join('\n') };
  source.sha256 = createHash('sha256').update(source.text).digest('hex');
  const claims = [];
  function fact(id, text, line) {
    claims.push({ id, text, origin: 'explicit', evidence: [{ sourceId: source.id, startLine: line, endLine: line, quote: lines[line - 1] }] });
  }
  fact('count', '仓管核对差异数量。', 1);
  fact('recount', '复点', 1);
  fact('file', '归档', 1);
  fact('review', '主管核验', 2);
  fact('above', '差异 > 2 件', 1);
  fact('at-most', '差异 ≤ 2 件', 1);
  fact('legacy', legacy, 2);
  fact('amendment', premise, 3);
  const inferredText = '库存差异登记表已归档且已收到该登记表的更正申请';
  claims.push({ id: 'inferred', text: inferredText, origin: 'inferred', evidence: [],
    premiseIds: ['amendment'], rationale: '依据登记表的归档状态和更正记录判断是否转主管。' });
  const nodes = ['count', 'recount', 'file', 'review'].map(id => ({
    id, groupId: 'check', title: claims.find(claim => claim.id === id).text, claimIds: [id],
    fields: Object.fromEntries(NODE_FIELDS.map(field => [field, field === 'actions' ? [id] : []])),
  }));
  const cases = [
    { id: 'above', from: 'count', to: 'recount', line: 1, label: '差异 > 2 件' },
    { id: 'at-most', from: 'count', to: 'file', line: 1, label: '差异 ≤ 2 件' },
    { id: 'legacy', from: 'recount', to: 'review', line: 2, label: '查看完整条件' },
    { id: 'inferred', from: 'file', to: 'review', line: 3, label: inferredText },
  ];
  const review = { status: 'not_run', reviewer: '', notes: [] };
  const model = { schemaVersion: 1, report: { id: 'branch-label-review', version: '1', title: '合成盘点流程', scope: '测试盘点登记与核验', limitations: [] },
    groups: [{ id: 'check', title: '盘点', kind: 'editorial', claimIds: [] }], nodes, claims, sources: [source],
    relations: cases.map(({ id, from, to }) => ({ id, from, to, type: 'conditional', claimIds: [id], conditionClaimIds: [id] })),
    rules: [], issues: [], coverage: lines.map((_, index) => ({ sourceId: source.id, startLine: index + 1, endLine: index + 1, disposition: 'represented',
      claimIds: claims.filter(claim => claim.evidence.some(item => item.startLine === index + 1)).map(claim => claim.id), issueIds: [], reason: '' })),
    review: { semantic: review, visual: review } };
  return { model, cases, lines };
}

function longExitsFixture() {
  const { model } = inventoryFixture();
  const preamble = '仓管按批次核对到货清单、签收回执和盘点记录，确认品名、数量、计量单位以及收货人与登记表一致，完成核对后再检查该批次的复点标记。';
  const unsigned = preamble + '若仓库复点栏缺少签名';
  const unsealed = preamble + '若封签编号与原登记不符';
  const lines = [
    '仓管按批次核对盘点表与签收记录；复点员记录复点数量，记录员登记异常批次与货位。主管核验后关闭盘点记录。',
    unsigned + '，交复点员复点。',
    unsealed + '，交复点员复点。',
    unsealed + '，同时由记录员登记异常。',
    '复点员将复点记录交主管，记录员也将异常登记交主管核验。',
    '若缺少复点记录，主管退回仓管核对盘点差异。',
    '其它仓储作业包括抽样、验收、入库、移库与出库。'
  ];
  const source = model.sources[0];
  source.text = lines.join('\n');
  source.sha256 = createHash('sha256').update(source.text).digest('hex');
  const groupTitles = ['差异核对', '抽样', '验收', '入库', '移库', '出库', '主管核验'];
  model.groups = groupTitles.map((title, index) => ({ id: 'g' + (index + 1), title, kind: 'editorial', claimIds: [] }));
  model.claims = [];
  function fact(id, text, line) {
    model.claims.push({ id, text, origin: 'explicit', evidence: [{ sourceId: source.id, startLine: line, endLine: line, quote: lines[line - 1] }] });
  }
  const stages = [
    ['count', '核对盘点差异', 'g1', 1], ['z-recount', '复点', 'g1', 1], ['a-file', '登记异常', 'g1', 1],
    ...groupTitles.slice(1, 6).map((title, i) => ['operation-' + i, title, 'g' + (i + 2), 7]),
    ['review', '主管核验', 'g7', 1]
  ];
  const descriptions = {
    count: '按批次核对盘点表与签收记录。', 'z-recount': '复点员记录复点数量。',
    'a-file': '记录员登记异常批次与货位。', review: '主管核验后关闭盘点记录。'
  };
  model.nodes = stages.map(([id, title, groupId, line]) => {
    fact(id, descriptions[id] || title, line);
    return { id, title, groupId, claimIds: [id], fields: Object.fromEntries(NODE_FIELDS.map(field => [field, field === 'actions' ? [id] : []])) };
  });
  const exits = [
    { id: 'signature', to: 'z-recount', text: unsigned, line: 2 },
    { id: 'seal', to: 'z-recount', text: unsealed, line: 3 },
    { id: 'record', to: 'a-file', text: unsealed, line: 4 }
  ];
  model.relations = exits.map(({ id, to, text, line }) => {
    fact(id, text, line);
    return { id, from: 'count', to, type: 'conditional', claimIds: [id], conditionClaimIds: [id] };
  });
  for (const [id, from, to, type, label, line] of [
    ['recount-review', 'z-recount', 'review', 'sequence', '将复点记录交主管', 5],
    ['file-review', 'a-file', 'review', 'sequence', '将异常登记交主管', 5],
    ['back', 'review', 'count', 'return', '缺少复点记录', 6]
  ]) {
    fact(id, label, line);
    model.relations.push({ id, from, to, type, claimIds: [id], conditionClaimIds: type === 'return' ? [id] : [] });
  }
  model.coverage = lines.map((_, index) => ({ sourceId: source.id, startLine: index + 1, endLine: index + 1, disposition: 'represented',
    claimIds: model.claims.filter(claim => claim.evidence[0].startLine === index + 1).map(claim => claim.id), issueIds: [], reason: '' }));
  return { model, exits, lines };
}

async function readyDirection(page, direction) {
  await page.getByTestId('layout-direction').selectOption(direction);
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toHaveAttribute('data-direction', direction);
  await expect(canvas).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByTestId('arrange-layout')).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('[data-route-mode="pending"]')).toHaveCount(0);
}

async function screenshotGraph(page, file) {
  const closeInspector = page.getByRole('button', { name: '关闭节点详情' });
  if (await closeInspector.isVisible()) await closeInspector.click();
  await page.getByRole('button', { name: '适应当前图' }).click();
  await expect.poll(() => page.locator('.process-card').evaluateAll(cards => cards.every(card => {
    const rect = card.getBoundingClientRect(), area = card.closest('.graph-area').getBoundingClientRect();
    const center = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return rect.left >= area.left && rect.right <= area.right && rect.top >= area.top && rect.bottom <= area.bottom && center?.closest('.process-card') === card;
  }))).toBe(true);
  await page.mouse.move(3, 3);
  await page.screenshot({ path: file, animations: 'disabled' });
}

async function exerciseLongExits(browser, directory, result) {
  const { model, exits, lines } = longExitsFixture();
  const app = await startServer({ taskDirectory: path.join(directory, 'long-exits'), model });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const card = id => page.getByTestId('graph-node-' + id);
  const label = id => page.locator(`[data-edge-label="${id}"]`);
  const dialog = page.getByRole('dialog', { name: '出口对照' });
  const compare = page.getByTestId('compare-exits-count');
  const focusFailures = [];
  try {
    page.on('pageerror', error => result.errors.push(error.message));
    await page.goto(app.url);
    for (const direction of ['RIGHT', 'DOWN']) {
      await readyDirection(page, direction);
      await expect(compare).toBeVisible();
      await expect(label('back')).toHaveText('缺少复点记录');
      const positions = app.store.read().view[direction === 'RIGHT' ? 'horizontalLayouts' : 'layouts'].g1.positions;
      const first = positions['z-recount'], second = positions['a-file'];
      const across = direction === 'RIGHT' ? 'y' : 'x';
      const along = direction === 'RIGHT' ? 'x' : 'y';
      assert.ok(first[across] < second[across], `${direction}: the lower numbered sibling appears first`);
      assert.ok(Math.abs(first[along] - second[along]) <= 2, `${direction}: siblings share a rank`);
      const firstGroup = card('count'), seventhGroup = card('review');
      const color = element => element.style.getPropertyValue('--group-color');
      assert.equal(await firstGroup.evaluate(color), await seventhGroup.evaluate(color));
      await expect(firstGroup).toContainText(/第\s*1\s*组/);
      await expect(seventhGroup).toContainText(/第\s*7\s*组/);
      await expect(card('z-recount').locator('.node-number')).toHaveText(/组内\s*2\s*号/);
      await expect(card('a-file').locator('.node-number')).toHaveText(/组内\s*3\s*号/);
      result.checks.push({ direction, scenario: 'same-layer order, cross-group identities and return edge', positions: { first, second } });
      const labels = await Promise.all(exits.map(item => label(item.id).innerText()));
      assert.equal(new Set(labels).size, 3);
      const sameTarget = await Promise.all(['signature', 'seal'].map(id => label(id).boundingBox()));
      assert.ok(sameTarget[0][across] < sameTarget[1][across], `${direction}: exit A appears before B at their shared destination`);
      for (const [index, item] of exits.entries()) {
        const destination = model.nodes.find(node => node.id === item.to).title;
        assert.match(labels[index], new RegExp('^[A-Z]\\s*→\\s*' + destination + '$'));
      }
      await screenshotGraph(page, path.join(directory, 'graph-' + direction + '.png'));
      await compare.focus();
      await page.keyboard.press('Enter');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('[data-exit-id]')).toHaveCount(3);
      for (const item of exits) {
        const row = dialog.locator(`[data-exit-id="${item.id}"]`);
        await expect(row).toContainText(item.text);
        await expect(row).toContainText(model.nodes.find(node => node.id === item.to).title);
        assert.equal(await row.getByText('多个去向共用此条件，待核对').count(), item.id === 'signature' ? 0 : 1);
        await row.getByText('查看原文依据').click();
        const evidence = row.getByRole('region', { name: '连线原文依据' });
        await expect(evidence.locator('blockquote p')).toHaveText(lines[item.line - 1]);
        await expect(evidence.locator('cite')).toHaveText('盘点说明.md · 第 ' + item.line + ' 行');
        await row.getByText('查看原文依据').click();
      }
      if (direction === 'RIGHT') {
        await page.screenshot({ path: path.join(directory, 'exit-comparison.png') });
        await page.setViewportSize({ width: 412, height: 800 });
        const bounds = await dialog.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 413, 'dialog fits a narrow viewport');
        await expect(dialog.locator('[data-exit-id="record"]')).toContainText(exits[2].text);
        await page.screenshot({ path: path.join(directory, 'narrow-dialog.png') });
        await page.setViewportSize({ width: 1440, height: 960 });
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      if (!await compare.evaluate(button => document.activeElement === button)) focusFailures.push(direction);
      await label('seal').click();
      const selected = page.locator('[data-branch-id="seal"]');
      await expect(selected.getByRole('region', { name: '连线原文依据' }).locator('blockquote p')).toHaveText(lines[2]);
      result.checks.push({ direction, scenario: 'long exits, shared destination, suffix and evidence', labels });
    }
    await screenshotGraph(page, path.join(directory, 'before-pin.png'));
    const handle = await card('z-recount').locator('.node-title').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 52, handle.y + handle.height / 2 + 30, { steps: 8 });
    await page.mouse.up();
    await expect(card('z-recount')).toHaveAttribute('data-manual', 'true');
    const saved = () => app.store.read().view.layouts.g1;
    const before = saved();
    await page.getByTestId('arrange-layout').click();
    await expect.poll(() => saved().revision).toBeGreaterThan(before.revision);
    assert.deepEqual(saved().positions['z-recount'], before.positions['z-recount']);
    assert.ok(saved().manualNodeIds.includes('z-recount'));
    result.checks.push({ scenario: 'explicit arrangement preserves pinned node', position: before.positions['z-recount'] });
    await page.getByTestId('reset-layout').click();
    await expect.poll(() => saved().manualNodeIds).not.toContain('z-recount');
    await page.getByTestId('undo-layout').click();
    await expect.poll(() => saved().manualNodeIds).toContain('z-recount');
    assert.deepEqual(saved().positions['z-recount'], before.positions['z-recount']);
    result.checks.push({ scenario: 'reset clears pins; undo restores pin and coordinates' });
    assert.deepEqual(focusFailures, [], 'closing the comparison returns keyboard focus to its launcher');
    assert.deepEqual(app.store.read().model, model);
  } catch (error) {
    await page.screenshot({ path: path.join(directory, 'failure-long-exits.png') }).catch(() => {});
    throw error;
  } finally {
    await page.close();
    await app.close();
  }
}

async function main() {
  const directory = path.resolve('.qa/branch-label-browser', `run-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  const { model, cases, lines } = inventoryFixture();
  const result = { checks: [], errors: [] };
  const app = await startServer({ taskDirectory: path.join(directory, 'task'), model });
  let browser, page;
  try {
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined), headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', error => result.errors.push(error.message));
    await page.goto(app.url);
    for (const direction of ['RIGHT', 'DOWN']) {
      await readyDirection(page, direction);
      await page.getByRole('button', { name: '适应当前图' }).click();
      for (const item of cases) {
        const label = page.locator(`[data-edge-label="${item.id}"]`);
        await expect(label).toHaveText(item.label);
        const box = await label.evaluate(element => ({ width: element.offsetWidth, height: element.offsetHeight }));
        assert.ok(box.height <= 40 && box.width <= 210, JSON.stringify(box));
        if (item.id === 'inferred') assert.equal(box.height, 40, 'complete two-line predicate');
        if (direction === 'RIGHT') await label.click();
        else { await label.focus(); await page.keyboard.press('Enter'); }
        const branch = page.locator(`[data-branch-id="${item.id}"]`);
        await expect(branch.getByTestId(`select-relation-${item.id}`)).toHaveAttribute('aria-pressed', 'true');
        await expect(branch.getByTestId(`condition-${item.id}`)).toHaveValue(model.claims.find(claim => claim.id === item.id).text);
        const evidence = branch.getByRole('region', { name: '连线原文依据' });
        await expect(evidence.locator('cite')).toHaveText(`盘点说明.md · 第 ${item.line} 行`);
        await expect(evidence.locator('blockquote p')).toHaveText(lines[item.line - 1]);
        await expect(page.getByRole('region', { name: '连线原文依据' })).toHaveCount(1);
        if (item.id === 'inferred') await expect(evidence).toContainText(model.claims.find(claim => claim.id === item.id).rationale);
        result.checks.push({ direction, id: item.id, label: item.label, ...box, line: item.line });
      }
      if (direction === 'RIGHT') {
        const pathElement = page.locator('[data-route-id="above"] .react-flow__edge-path');
        const point = await pathElement.evaluate(curve => {
          for (const ratio of [.2, .8, .35, .65, .1, .9]) {
            const point = curve.getPointAtLength(curve.getTotalLength() * ratio).matrixTransform(curve.getScreenCTM());
            if (document.elementFromPoint(point.x, point.y)?.closest('.react-flow__edge')?.dataset.id === 'above') {
              return { x: point.x, y: point.y };
            }
          }
        });
        assert.ok(point, 'an unobstructed segment of the line is clickable');
        await page.mouse.click(point.x, point.y);
        const branch = page.locator('[data-branch-id="above"]');
        await expect(branch.getByTestId('select-relation-above')).toHaveAttribute('aria-pressed', 'true');
        await expect(branch.getByRole('region', { name: '连线原文依据' }).locator('blockquote p')).toHaveText(lines[0]);
        result.checks.push({ direction, id: 'above', target: 'line' });
      }
      await page.screenshot({ path: path.join(directory, direction + '.png') });
    }
    await exerciseLongExits(browser, directory, result);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(app.store.read().model, model);
    result.passed = true;
  } catch (error) {
    result.error = error.stack;
    if (page) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    console.log('BRANCH_LABEL_QA=' + directory);
    if (browser) await browser.close();
    await app.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
