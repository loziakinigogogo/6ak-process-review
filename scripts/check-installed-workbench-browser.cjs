'use strict';

// Release gate: the browser and Agent CLI use only the installed ZIP runtime.
// Every task and test word is synthetic and lives in its own .qa directory.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium, expect } = require('@playwright/test');
const { pack } = require('./pack.cjs');
const { inventory } = require('./install.cjs');
const runFile = promisify(execFile);

async function main() {
  const directory = path.resolve('.qa/installed-workbench-browser', `run-${Date.now()}`);
  const project = path.join(directory, 'isolated-project');
  fs.mkdirSync(project, { recursive: true });
  const result = { directory, checks: [], errors: [], failedAssets: [], assets: [], workers: [], services: [] };
  let browser, context, page, service, url, task, environment, entry;
  const check = name => { result.checks.push(name); console.log('PASS ' + name); };
  const json = async endpoint => {
    const response = await fetch(url + endpoint);
    assert.equal(response.status, 200, endpoint);
    return response.json();
  };
  const state = () => json('/api/workbench/state');
  const cli = async (...args) => JSON.parse((await runFile(process.execPath,
    ['--require', path.join(directory, 'installed-only.cjs'), entry, ...args, '--task', task],
    { cwd: project, env: environment, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout);
  const stop = async () => {
    if (!service || service.exitCode !== null || service.signalCode) return;
    const child = service;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Installed service did not stop')); }, 10000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
    service = null;
  };
  const start = args => new Promise((resolve, reject) => {
    const log = { args, stdout: '', stderr: '', pid: null };
    result.services.push(log);
    service = spawn(process.execPath, ['--require', path.join(directory, 'installed-only.cjs'), entry, ...args],
      { cwd: project, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    log.pid = service.pid;
    const timer = setTimeout(() => reject(Error('Installed service did not start: ' + log.stderr)), 20000);
    service.once('error', error => { clearTimeout(timer); reject(error); });
    service.once('exit', code => { clearTimeout(timer); reject(Error(`Installed service exited ${code}: ${log.stderr}`)); });
    service.stderr.on('data', data => { log.stderr += data; });
    service.stdout.on('data', data => {
      log.stdout += data;
      const found = /WORKBENCH_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(log.stdout);
      if (found) { clearTimeout(timer); resolve(found[1]); }
    });
  });
  const openBrowser = async () => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => result.errors.push(error.message));
    page.on('worker', worker => result.workers.push(worker.url()));
    page.on('response', response => {
      const resource = new URL(response.url());
      if (!resource.pathname.startsWith('/assets/')) return;
      result.assets.push({ url: response.url(), status: response.status() });
      if (!response.ok()) result.failedAssets.push({ url: response.url(), status: response.status() });
    });
    page.on('requestfailed', request => {
      if (new URL(request.url()).pathname.startsWith('/assets/')) result.failedAssets.push({ url: request.url(), error: request.failure()?.errorText });
    });
    await page.goto(url);
  };
  const awaitGraph = async () => {
    await page.getByTestId('view-graph').click();
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('aria-busy', 'false', { timeout: 30000 });
    await expect.poll(async () => {
      const s = await state();
      return Object.values({ ...s.view.layouts, ...s.view.horizontalLayouts }).some(layout => !!layout.inputKey);
    }, { timeout: 30000 }).toBe(true);
    await expect(page.getByTestId('arrange-layout')).toBeEnabled({ timeout: 30000 });
    await expect(page.locator('[data-route-mode="pending"]')).toHaveCount(0, { timeout: 30000 });
    await expect(page.locator('[data-route-mode="elk"]').first()).toBeAttached();
  };
  try {
    const release = pack(directory);
    result.release = release;
    const installer = path.join(project, 'update-6ak-process-review.cjs');
    fs.copyFileSync(path.resolve(__dirname, 'install.cjs'), installer);
    const installation = JSON.parse((await runFile(process.execPath, [installer, '--from', release.output],
      { cwd: project, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout);
    assert.equal(installation.status, 'installed');
    assert.equal(installation.version, require('../package.json').version);
    entry = path.join(installation.target, 'workbench/scripts/workbench.cjs');
    const installedFiles = inventory(installation.target);
    assert.ok(!Object.keys(installedFiles).some(name => /(?:node_modules|\.qa|demo1_raw_file|comparison|\.test\.cjs|selftest\.cjs)/.test(name)));
    fs.writeFileSync(path.join(directory, 'installed-only.cjs'), `const Module=require('node:module'),path=require('node:path');
const root=path.resolve(process.env.SKILL_PACKAGE_ROOT),resolve=Module._resolveFilename;
Module._resolveFilename=function(...args){const file=resolve.apply(this,args);if(path.isAbsolute(file)&&file!==root&&!file.startsWith(root+path.sep))throw Error('Backend escaped installed skill: '+file);return file;};
`);
    environment = { ...process.env, NODE_PATH: '', SKILL_PACKAGE_ROOT: installation.target };
    url = await start(['demo', '--project', project]);
    const health = await json('/api/health');
    assert.equal(health.version, installation.version);
    assert.equal(health.dev, false);
    assert.ok(health.workbenchProtocol.capabilities.includes('node-material-text-v1'));
    assert.ok(health.workbenchProtocol.capabilities.includes('graph-layout-refresh-v1'));
    task = health.taskDirectory;
    assert.equal(path.dirname(path.dirname(task)), project);
    result.health = health;
    const baseline = await state();
    assert.equal(baseline.contentOrigin.kind, 'synthetic');
    check('Standalone installer installs the ZIP and its Node-only CLI starts the released synthetic workbench');

    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
      (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : undefined),
    headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
    await openBrowser();
    await awaitGraph();
    await expect.poll(() => result.workers.some(value => /\/assets\/elk-worker/.test(value)), { timeout: 30000 }).toBe(true);
    assert.ok(result.assets.some(resource => /\/assets\/elk-api/.test(resource.url)));
    assert.ok(result.assets.some(resource => /\.css$/.test(resource.url)));
    assert.deepEqual(result.failedAssets, []);
    await page.screenshot({ path: path.join(directory, '01-installed-graph.png'), fullPage: false });
    check('Installed production HTML, CSS, application chunks and ELK Web Worker render a measured graph with reusable routes');

    await page.getByTestId('view-content').click();
    await page.getByTestId('directory-scope').selectOption('all');
    await page.getByTestId('directory-node-validate').click();
    const panel = page.locator('[data-content-node-id="validate"]');
    await expect(page.getByTestId('node-workspace')).toHaveAttribute('data-current-node-id', 'validate');
    await panel.getByTestId('add-content-note').click();
    const form = page.getByTestId('content-composer');
    const words = '本步骤完成后记录核对编号。\n\n这条补充仅用于合成安装验证。';
    await expect(form.getByLabel('补充原话', { exact: true })).toBeFocused();
    await form.getByLabel('补充原话', { exact: true }).fill(words);
    await form.getByTestId('save-content').click();
    await expect(form).toBeHidden();
    await expect(page.getByTestId('content-save-receipt')).toContainText('已添加');
    const saved = await state();
    const material = saved.contentTree.entries.find(item => item.nodeId === 'validate' && item.text === words);
    assert.ok(material);
    assert.equal(material.kind, 'raw');
    assert.equal(saved.modelHash, baseline.modelHash);
    assert.equal(saved.workRevision, baseline.workRevision);
    check('Real UI saves exact multiline raw words to the selected node without modifying generated content');

    await panel.getByTestId('refine-node-materials').click();
    await expect(page.getByTestId('agent-task-preview')).toBeVisible();
    await page.getByTestId('confirm-agent-task').click();
    await expect(page.getByTestId('agent-task-preview')).toBeHidden();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('process-review-workbench-ref:v1 ');
    const handoff = await page.evaluate(() => navigator.clipboard.readText());
    const marker = 'process-review-workbench-ref:v1 ';
    const header = JSON.parse(handoff.slice(handoff.indexOf(marker) + marker.length).split('\n')[0]);
    const reference = await cli('reference', header.referenceId);
    assert.ok(reference.contentInputs.some(item => item.id === material.id && item.kind === 'raw' && item.text === words));
    const candidate = await cli('candidate', '--reference', header.referenceId);
    const source = candidate.rawMaterialSources.find(item => item.text === words);
    assert.ok(source);
    const model = JSON.parse(fs.readFileSync(candidate.modelFile, 'utf8'));
    model.sources.push(source);
    const claim = { id: 'installed-package-check-number', text: words.split('\n')[0], origin: 'explicit',
      evidence: [{ sourceId: source.id, startLine: 1, endLine: 1, quote: words.split('\n')[0] }] };
    model.claims.push(claim);
    model.coverage.push({ sourceId: source.id, startLine: 1, endLine: 1, disposition: 'represented', claimIds: [claim.id], issueIds: [], reason: '合成用户补充' },
      { sourceId: source.id, startLine: 2, endLine: 3, disposition: 'out_of_scope', claimIds: [], issueIds: [], reason: '合成安装验证说明，不是业务步骤。' });
    const node = model.nodes.find(item => item.id === 'validate');
    node.title = '校验降幅并记录核对编号';
    node.claimIds.push(claim.id);
    node.fields.actions.push(claim.id);
    fs.writeFileSync(candidate.modelFile, JSON.stringify(model, null, 2));
    const reviewed = await cli('review-candidate', candidate.candidateId);
    assert.ok(reviewed.changes.length);
    assert.ok(reviewed.reviewHash);
    await cli('apply', candidate.candidateId, '--confirm', reviewed.reviewHash);
    await expect(page.getByTestId('workspace-node-title')).toHaveText(node.title);
    await expect(panel.getByTestId('node-prose-validate')).toContainText(claim.text);
    await expect(panel.locator(`[data-content-id="${material.id}"]`)).toContainText('已用于当前结果');
    const adopted = await state();
    assert.equal(adopted.workRevision, baseline.workRevision + 1);
    assert.deepEqual(adopted.model.issues, baseline.model.issues);
    assert.deepEqual(adopted.model.sources[0], baseline.model.sources[0]);
    assert.equal(adopted.contentTree.entries.find(item => item.id === material.id).text, words);
    const modelResponse = await fetch(url + '/api/model');
    const flowResponse = await fetch(url + '/api/flow');
    assert.equal(modelResponse.status, 200);
    assert.equal(flowResponse.status, 200);
    assert.equal(modelResponse.headers.get('x-work-revision'), String(adopted.workRevision));
    assert.equal(flowResponse.headers.get('x-work-revision'), String(adopted.workRevision));
    assert.deepEqual(await modelResponse.json(), adopted.model);
    const flow = await flowResponse.text();
    assert.ok(flow.includes(claim.text));
    assert.ok(flow.includes(node.title));
    fs.writeFileSync(path.join(directory, 'exported-flow.md'), flow);
    fs.writeFileSync(path.join(directory, 'adopted-model.json'), JSON.stringify(adopted.model, null, 2));
    await page.screenshot({ path: path.join(directory, '02-installed-adopted-content.png'), fullPage: false });
    await awaitGraph();
    await expect(page.getByTestId('graph-node-validate')).toContainText(node.title);
    check('UI handoff and installed CLI candidate/review/apply update both views and same-version model/flow exports while retaining evidence and unknowns');

    await page.getByTestId('view-content').click();
    await panel.getByTestId('add-content-note').click();
    const unfinished = '重启后继续填写的合成输入。\n第二行尚未保存。';
    await form.getByLabel('补充原话', { exact: true }).fill(unfinished);
    await expect.poll(async () => Object.values(await json('/api/workbench/buffers?sessionId=content-editor'))
      .some(item => item.draft?.nodeId === 'validate' && item.draft.text === unfinished)).toBe(true);
    await context.close();
    context = null;
    await stop();
    url = await start(['serve', '--task', task]);
    const restored = await state();
    assert.equal(restored.modelHash, adopted.modelHash);
    assert.equal(restored.workRevision, adopted.workRevision);
    assert.deepEqual(restored.contentTree, adopted.contentTree);
    await openBrowser();
    await page.getByTestId('view-content').click();
    await expect(page.getByTestId('workspace-node-title')).toHaveText(node.title);
    await page.locator('[data-content-node-id="validate"]').getByTestId('add-content-note').click();
    await expect(page.getByTestId('content-composer').getByLabel('补充原话', { exact: true })).toHaveValue(unfinished);
    await expect(page.locator(`[data-content-id="${material.id}"]`)).toContainText('已用于当前结果');
    await page.screenshot({ path: path.join(directory, '03-installed-restarted-input.png'), fullPage: false });
    assert.deepEqual(inventory(installation.target), installedFiles, 'runtime state belongs to the project, not the installed skill');
    assert.deepEqual(result.failedAssets, []);
    assert.deepEqual(result.errors, []);
    check('Restarting the installed CLI restores adopted content, original material and unfinished input in a fresh browser without changing package files');
    result.passed = true;
  } catch (error) {
    result.passed = false;
    result.failure = error.stack || String(error);
    await page?.screenshot({ path: path.join(directory, 'failure.png'), fullPage: false }).catch(() => {});
  } finally {
    if (browser) await browser.close();
    try { await stop(); } catch (error) { result.passed = false; result.stopFailure = error.message; }
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ directory, passed: result.passed, checks: result.checks.length, errors: result.errors, failure: result.failure, stopFailure: result.stopFailure }, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
