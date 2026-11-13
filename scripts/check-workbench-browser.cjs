'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { chromium, expect } = require('@playwright/test');
const { startServer } = require('../workbench/scripts/workbench.cjs');

async function main() {
  const { getGraphScope } = await import('../workbench/frontend/src/graph-scope.mjs');
  const directory = path.resolve('.qa', 'workbench-browser', `run-${Date.now()}`);
  fs.mkdirSync(directory, { recursive: true });
  let app = await startServer({ taskDirectory: path.join(directory, 'task') });
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined);
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
  const checks = [], errors = [];
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const state = () => fetch(app.url + '/api/workbench/state').then(r => r.json());
    const mutate = async (route, body, expected = 200) => {
      const response = await fetch(app.url + '/api/workbench/' + route, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Workbench-Id': app.runtime.workspaceId }, body: JSON.stringify(body) });
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    };
    const title = () => page.getByTestId('node-title');
    const save = () => page.getByTestId('save-node');
    const check = name => { checks.push(name); console.log('PASS ' + name); };

    await page.goto(app.url);
    await expect(page.getByTestId('graph-node-validate')).toBeVisible();
    const initialState = await state();
    const initialScope = getGraphScope(initialState.model, 'execute');
    await expect(page.locator('.process-card')).toHaveCount(initialScope.nodes.length);
    await page.getByTestId('graph-node-validate').click();
    await expect(title()).toHaveValue('校验降幅');
    await page.screenshot({ path: path.join(directory, '01-initial.png') });
    check('initial graph and selected node render');

    for (const node of initialScope.contextNodes) await expect(page.getByTestId('graph-node-' + node.id)).toHaveAttribute('data-context', 'true');
    for (const edge of initialScope.crossGroupRelations) await expect(page.locator(`.react-flow__edge[data-id="${edge.id}"]`)).toHaveCount(1);
    const outside = initialScope.contextNodes[0];
    assert.ok(outside, 'synthetic group must exercise a cross-group connection');
    const insideColor = await page.getByTestId('graph-node-validate').locator('.group-badge').evaluate(el => getComputedStyle(el).backgroundColor);
    const outsideColor = await page.getByTestId('graph-node-' + outside.id).locator('.group-badge').evaluate(el => getComputedStyle(el).backgroundColor);
    assert.notEqual(insideColor, outsideColor);
    await expect(page.getByTestId('graph-node-' + outside.id)).toContainText('组外');
    check('one-hop cross-group nodes and their links are shown with group identity');

    const navigation = page.getByTestId('group-navigator');
    const navBefore = await navigation.boundingBox();
    const quietSurface = await navigation.evaluate(el => getComputedStyle(el).backgroundColor);
    await navigation.hover();
    await expect.poll(() => navigation.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(quietSurface);
    await page.getByRole('button', { name: '缩小', exact: true }).click();
    const navAfter = await navigation.boundingBox();
    assert.equal(navBefore.x, navAfter.x); assert.equal(navBefore.y, navAfter.y);
    assert.equal(await page.locator('.navigation-rail').count(), 0);
    const graphBox = await page.getByTestId('graph-canvas').boundingBox();
    assert.equal(graphBox.x, 0); assert.ok(graphBox.width >= 1000); assert.ok(graphBox.y <= 100);
    check('group navigation floats over the enlarged canvas and responds to hover');

    await page.getByRole('button', { name: '适应当前图', exact: true }).click();
    await page.getByTestId('graph-node-' + outside.id).click();
    await expect(title()).toHaveValue(outside.title);
    await expect(page.getByTestId('group-execute')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('jump-to-group').click();
    await expect(page.getByTestId('group-' + outside.groupId)).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('group-execute').click();
    await page.getByTestId('graph-node-validate').click();
    assert.equal((await state()).modelHash, initialState.modelHash);
    check('outside nodes can be inspected in place and explicitly opened in their own group');

    await title().fill('核对本轮降幅');
    await page.getByTestId('condition-validate--dispatch-condition').fill('降幅 ≤ 25%');
    await page.getByTestId('condition-validate--approval-condition').fill('降幅 > 25%');
    await save().click();
    await expect(save()).toBeDisabled();
    await expect.poll(async () => (await state()).model.nodes.find(n => n.id === 'validate').title).toBe('核对本轮降幅');
    await expect(page.getByTestId('graph-node-validate')).toContainText('核对本轮降幅');
    await page.reload();
    await expect(title()).toHaveValue('核对本轮降幅');
    assert.ok((await state()).model.claims.some(c => c.text === '降幅 ≤ 25%'));
    check('node title and both branch conditions persist and reload');

    await title().fill('尚未提交的用户输入');
    await expect.poll(async () => Object.values(app.store.buffers('local-reviewer')).some(b => b.draft.title === '尚未提交的用户输入')).toBe(true);
    await page.getByTestId('graph-node-manual').click();
    await page.getByTestId('graph-node-validate').click();
    await expect(title()).toHaveValue('尚未提交的用户输入');
    await page.reload();
    await expect(title()).toHaveValue('尚未提交的用户输入');
    check('unfinished input survives node switching and reload');

    await page.getByLabel('修改性质').selectOption('proposal');
    await save().click();
    await expect.poll(async () => (await state()).pendingEdits.length).toBe(1);
    assert.equal((await state()).model.nodes.find(n => n.id === 'validate').title, '核对本轮降幅');
    await expect(title()).toHaveValue('尚未提交的用户输入');
    await expect(save()).toBeEnabled();
    await page.getByLabel('修改性质').selectOption('current');
    await save().click();
    await expect(save()).toBeDisabled();
    assert.equal((await state()).pendingEdits.length, 0);
    check('pending proposal is separate, preserved, and can be adopted');

    const oldCandidate = await mutate('candidates', {});
    await title().fill('用户的新版本');
    await save().click();
    await expect(save()).toBeDisabled();
    await mutate('apply', { candidateId: oldCandidate.candidateId }, 409);
    assert.equal((await state()).model.nodes.find(n => n.id === 'validate').title, '用户的新版本');
    check('stale Agent candidate cannot overwrite a user save');

    await title().fill('Agent 更新期间继续输入');
    const candidate = await mutate('candidates', {});
    const model = JSON.parse(fs.readFileSync(candidate.modelFile, 'utf8'));
    model.nodes.find(n => n.id === 'manual').title = 'Agent 整理后的单条录入';
    fs.writeFileSync(candidate.modelFile, JSON.stringify(model, null, 2));
    await mutate('apply', { candidateId: candidate.candidateId, summary: '浏览器验证：改名但保留原来源' });
    await expect(page.getByTestId('graph-node-manual')).toContainText('Agent 整理后的单条录入');
    await expect(title()).toHaveValue('Agent 更新期间继续输入');
    check('Agent update arrives through SSE without erasing current input');
    await page.getByRole('button', { name: '还原输入', exact: true }).click();
    await expect(save()).toBeDisabled();

    let releaseResponse;
    const held = new Promise(resolve => { releaseResponse = resolve; });
    let saveArrived;
    const arrived = new Promise(resolve => { saveArrived = resolve; });
    await page.route('**/api/workbench/edits', async route => {
      const response = await route.fetch(); saveArrived(); await held; await route.fulfill({ response });
    });
    await title().fill('提交时的标题');
    await save().click();
    await arrived;
    await title().fill('保存期间新输入的标题');
    releaseResponse();
    await expect(save()).toBeEnabled();
    await expect(title()).toHaveValue('保存期间新输入的标题');
    assert.equal((await state()).model.nodes.find(n => n.id === 'validate').title, '提交时的标题');
    await page.unroute('**/api/workbench/edits');
    await save().click();
    await expect(save()).toBeDisabled();
    assert.equal((await state()).model.nodes.find(n => n.id === 'validate').title, '保存期间新输入的标题');
    check('typing during an in-flight save is retained and remains saveable');

    const beforeReference = await state();
    await expect(page.getByTestId('discussion-input')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '讨论', exact: true })).toHaveCount(0);
    await page.getByTestId('copy-reference').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('process-review-workbench-ref:v1');
    let copied = await page.evaluate(() => navigator.clipboard.readText());
    let referenceRecord = JSON.parse(copied.split('process-review-workbench-ref:v1 ')[1]);
    const snapshot = await fetch(app.url + '/api/workbench/references/' + referenceRecord.referenceId).then(r => r.json());
    assert.equal(snapshot.targets[0].id, 'validate');
    assert.equal((await state()).modelHash, beforeReference.modelHash);
    assert.equal((await state()).workRevision, beforeReference.workRevision);
    assert.deepEqual((await state()).requests, beforeReference.requests);
    check('copying a node reference needs no webpage chat and does not change business content');

    const action = page.getByLabel('操作说明 1', { exact: true });
    const selectedText = (await action.inputValue()).slice(0, 10);
    await action.evaluate(el => { el.focus(); el.setSelectionRange(0, 10); el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    await page.getByRole('button', { name: '复制所选文字引用', exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('claim');
    copied = await page.evaluate(() => navigator.clipboard.readText());
    referenceRecord = JSON.parse(copied.split('process-review-workbench-ref:v1 ')[1]);
    const quote = await fetch(app.url + '/api/workbench/references/' + referenceRecord.referenceId).then(r => r.json());
    assert.equal(quote.selection.text, selectedText);
    check('selected saved wording produces an exact claim reference');
    await page.screenshot({ path: path.join(directory, '02-reference.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(directory, '03-narrow.png') });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check('narrow viewport has no document overflow');
    await page.setViewportSize({ width: 1440, height: 900 });
    await title().fill('网络失败时仍保留的输入');
    await page.route('**/api/workbench/edits', route => route.abort('failed'));
    await save().click();
    await expect(page.locator('.save-error')).toBeVisible();
    await expect(title()).toHaveValue('网络失败时仍保留的输入');
    assert.equal((await state()).model.nodes.find(n => n.id === 'validate').title, '保存期间新输入的标题');
    await page.unroute('**/api/workbench/edits');
    await save().click();
    await expect(save()).toBeDisabled();
    await page.getByTestId('undo').click();
    await expect(title()).toHaveValue('保存期间新输入的标题');
    check('failed save retains input and a successful edit can be undone');

    const scopedPosition = snapshot => snapshot.view.layouts?.execute?.positions.manual || snapshot.view.positions.manual;
    const beforePosition = scopedPosition(await state());
    const dragSnapshots = [];
    const captureDragState = async label => {
      dragSnapshots.push(await page.evaluate(label => {
        const node = document.querySelector('[data-testid="graph-node-manual"]');
        const box = node.getBoundingClientRect();
        const x = box.x + box.width / 2, y = box.y + 25;
        const hit = document.elementFromPoint(x, y);
        const wrapper = node.closest('.react-flow__node');
        return { label, viewport: document.querySelector('.react-flow__viewport').getAttribute('style'), graph: document.querySelector('.graph-area').getBoundingClientRect().toJSON(), manual: box.toJSON(), wrapper: { style: wrapper.getAttribute('style'), visibility: getComputedStyle(wrapper).visibility, pointerEvents: getComputedStyle(wrapper).pointerEvents }, hit: hit?.outerHTML.slice(0, 300), hitNodeId: hit?.closest('.react-flow__node')?.getAttribute('data-id') };
      }, label));
      fs.writeFileSync(path.join(directory, 'drag-diagnostics.json'), JSON.stringify(dragSnapshots, null, 2));
    };
    await captureDragState('before-fit');
    await page.getByRole('button', { name: '适应当前图', exact: true }).click();
    await page.waitForTimeout(400);
    await captureDragState('after-fit');
    await expect(page.getByTestId('graph-node-manual')).toBeVisible();
    assert.equal(dragSnapshots.at(-1).hitNodeId, 'manual', 'the drag must hit a visible node, not the canvas beneath it');
    const box = await page.getByTestId('graph-node-manual').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 25);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 45, box.y + 45, { steps: 8 });
    await page.mouse.up();
    await captureDragState('after-drag');
    await expect.poll(async () => scopedPosition(await state()).x).not.toBe(beforePosition.x);
    check('dragged node position persists independently of content');

    await page.getByTestId('graph-node-validate').click();
    await title().fill('跨端口重开仍能恢复的编辑稿');
    await expect.poll(async () => Object.values(app.store.buffers('local-reviewer')).some(b => b.draft.title === '跨端口重开仍能恢复的编辑稿')).toBe(true);
    await context.close();
    const previousURL = app.url;
    await app.close();
    app = await startServer({ taskDirectory: path.join(directory, 'task') });
    const freshContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await freshContext.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.url);
    await expect(title()).toHaveValue('跨端口重开仍能恢复的编辑稿');
    assert.notEqual(app.url, previousURL);
    check('server restart on another port restores file-backed input without browser cache');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ checks, errors, passed: true, taskDirectory: app.runtime.taskDirectory }, null, 2));
    console.log('BROWSER_QA=' + directory);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ checks, errors, passed: false, error: error.stack }, null, 2));
    console.error('BROWSER_QA=' + directory);
    throw error;
  } finally { await browser.close(); await app.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
