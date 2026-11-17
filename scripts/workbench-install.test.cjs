'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { install, inventory, readRelease, sourceFiles } = require('./install.cjs');
const { pack } = require('./pack.cjs');
const runFile = promisify(execFile);

test('installed release serves assets and material/candidate tools with Node alone and restores existing task data', { timeout: 60000 }, async t => {
  const qa = path.resolve('.qa', 'installed-workbench', 'run-' + randomUUID());
  const project = path.join(qa, 'isolated-project');
  fs.mkdirSync(project, { recursive: true });
  const archive = pack(qa);
  const release = readRelease(fs.readFileSync(archive.output));
  const installed = install(project, release);
  const entry = path.join(installed.target, 'workbench', 'scripts', 'workbench.cjs');
  const guard = path.join(qa, 'node-runtime-only.cjs');
  // The package is tested inside .qa, but cannot accidentally resolve modules
  // from repository/node_modules or any maintenance source outside the skill.
  fs.writeFileSync(guard, `const Module=require('node:module'),path=require('node:path');
const root=path.resolve(process.env.SKILL_PACKAGE_ROOT),resolve=Module._resolveFilename;
Module._resolveFilename=function(...args){const result=resolve.apply(this,args);if(path.isAbsolute(result)&&result!==root&&!result.startsWith(root+path.sep))throw Error('Package escaped installed runtime: '+result);return result;};
`);
  const environment = { ...process.env, SKILL_PACKAGE_ROOT: installed.target, NODE_PATH: '' };
  const cli = async args => {
    const { stdout } = await runFile(process.execPath, ['--require', guard, entry, ...args], { cwd: project, env: environment, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  let service;
  const stop = async () => {
    if (!service || service.exitCode !== null || service.signalCode) return;
    const closed = new Promise(resolve => service.once('exit', resolve));
    service.kill(); await closed;
  };
  t.after(stop);
  const start = args => new Promise((resolve, reject) => {
    service = spawn(process.execPath, ['--require', guard, entry, ...args], { cwd: project, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => reject(Error('Installed service did not start: ' + stderr)), 15000);
    service.once('error', error => { clearTimeout(timer); reject(error); });
    service.once('exit', code => { clearTimeout(timer); reject(Error('Installed service exited ' + code + ': ' + stderr)); });
    service.stderr.on('data', data => { stderr += data; });
    service.stdout.on('data', data => { stdout += data; const found = /WORKBENCH_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(stdout); if (found) { clearTimeout(timer); resolve(found[1]); } });
  });
  const files = inventory(installed.target);
  assert.ok(!Object.keys(files).some(name => /(?:node_modules|\.qa|comparison|\.test\.cjs|selftest\.cjs)/.test(name)));
  const modelFile = path.join(installed.target, 'examples', 'messy-pricing.model.json');
  const inputModel = JSON.parse(fs.readFileSync(modelFile));
  let url = await start(['serve', '--project', project, '--model', modelFile]);
  const task = path.join(project, '.document-review', inputModel.report.id);
  let state = await fetch(url + '/api/workbench/state').then(r => r.json());
  assert.deepEqual(state.model, inputModel);
  const health = await fetch(url + '/api/health').then(r => r.json());
  assert.equal(health.version, installed.version);
  assert.equal(health.dev, false);
  assert.ok(health.workbenchProtocol.capabilities.includes('graph-layout-refresh-v1'));
  const page = await fetch(url).then(r => r.text());
  assert.match(page, /<div id="root"><\/div>/);
  const htmlAssets = [...page.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
  assert.ok(htmlAssets.length >= 2);
  for (const asset of Object.keys(files).filter(name => name.startsWith('workbench/frontend/build/assets/'))) {
    const resource = await fetch(url + '/assets/' + path.basename(asset));
    assert.equal(resource.status, 200, asset);
    assert.deepEqual(Buffer.from(await resource.arrayBuffer()), fs.readFileSync(path.join(installed.target, asset)));
  }
  const nodeId = state.model.nodes[0].id;
  const words = '保存的合成测试原话。\n\n只作为节点材料，不自动改写业务正文。';
  const inputFile = path.join(qa, 'material-input.json');
  fs.writeFileSync(inputFile, JSON.stringify({ requestId: randomUUID(), operation: 'create', entryType: 'note', nodeId, text: words, baseContentRevision: state.contentTree.revision }));
  const saved = await cli(['content', '--task', task, '--input', inputFile]);
  assert.equal(saved.workRevision, state.workRevision);
  assert.equal(saved.contentTree.entries.at(-1).kind, 'raw');
  assert.equal(saved.contentTree.entries.at(-1).text, words);
  const referenceResponse = await fetch(url + '/api/workbench/references', { method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json', 'X-Workbench-Id': saved.workspaceId },
    body: JSON.stringify({ baseWorkRevision: saved.workRevision, baseModelHash: saved.modelHash,
      baseContentHash: saved.contentTree.hash, baseMaterialsHash: saved.materials.hash,
      targets: [{ type: 'node', id: nodeId }], allNodeMaterials: true }) });
  assert.equal(referenceResponse.status, 200);
  const reference = await referenceResponse.json();
  const recalled = await cli(['reference', reference.id, '--task', task]);
  assert.equal(recalled.contentInputs[0].text, words);
  const candidate = await cli(['candidate', '--reference', reference.id, '--task', task]);
  assert.equal(candidate.rawMaterialSources[0].text, words);
  const next = JSON.parse(fs.readFileSync(candidate.modelFile));
  next.nodes[0].title += '（合成核对）';
  fs.writeFileSync(candidate.modelFile, JSON.stringify(next, null, 2));
  const reviewed = await cli(['review-candidate', candidate.candidateId, '--task', task]);
  assert.ok(reviewed.reviewHash);
  const adopted = await cli(['apply', candidate.candidateId, '--confirm', reviewed.reviewHash, '--task', task]);
  assert.equal(adopted.workRevision, state.workRevision + 1);
  assert.equal(adopted.model.review.semantic.status, 'not_run');
  assert.equal(adopted.model.review.visual.status, 'not_run');
  const adoptedModel = { ...next, review: adopted.model.review };
  assert.deepEqual(adopted.model, adoptedModel);
  assert.equal(adopted.contentTree.entries.at(-1).text, words);
  assert.deepEqual(await fetch(url + '/api/model').then(r => r.json()), adoptedModel);
  assert.match(await fetch(url + '/api/flow').then(r => r.text()), /合成核对/);
  await stop();
  url = await start(['serve', '--task', task]);
  state = await fetch(url + '/api/workbench/state').then(r => r.json());
  assert.deepEqual(state.model, adoptedModel);
  assert.equal(state.workRevision, adopted.workRevision);
  assert.equal(state.contentTree.entries.at(-1).text, words);
  assert.equal((await cli(['status', '--task', task])).modelHash, state.modelHash);
  await assert.rejects(cli(['dev', '--task', task]), /安装版不包含开发环境/);
  await assert.rejects(cli(['serve', '--task', path.join(project, 'nonexistent-task')]), /新资料任务需要 --model/);
  fs.writeFileSync(path.join(qa, 'report.json'), JSON.stringify({ passed: true, version: installed.version, archiveBytes: fs.statSync(archive.output).size, installedFiles: Object.keys(files).length, task, checks: ['Node-only module isolation', 'all bundled HTTP assets', 'raw material save', 'candidate review and apply', 'flow/model export', 'task restart retention', 'development and missing-model guards'] }, null, 2));
});

test('local packaging refuses a missing workbench build instead of publishing an unusable UI', () => {
  const fixture = path.resolve('.qa', 'installed-workbench', 'incomplete-' + randomUUID());
  fs.mkdirSync(path.join(fixture, 'workbench/scripts'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'SKILL.md'), 'synthetic');
  fs.writeFileSync(path.join(fixture, 'workbench/scripts/workbench.cjs'), 'synthetic');
  assert.throws(() => sourceFiles(fixture), /工作台资源未构建完整/);
});
