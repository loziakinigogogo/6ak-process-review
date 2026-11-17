#!/usr/bin/env node
'use strict';
const { publicTree } = require('./workbench-content-tree.cjs');

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const { createStore } = require('./workbench-store.cjs');
const { createDemoModel, createDemoPositions } = require('./workbench-demo-fixture.cjs');
const { renderFlow } = require('../../scripts/export-flow.cjs');

const WORKBENCH_ROOT = path.resolve(__dirname, '..');
const { version: WORKBENCH_VERSION } = require('../package.json');
const WORKBENCH_PROTOCOL = Object.freeze({name:'6ak-workbench',version:2,capabilities:['node-materials-v1','source-material-edit-v1','all-node-materials-reference-v1','content-revisions-v1','candidate-material-guards-v1','node-material-text-v1','graph-layout-refresh-v1']});
const compatibleProtocol = value => value?.name===WORKBENCH_PROTOCOL.name&&value.version===WORKBENCH_PROTOCOL.version&&WORKBENCH_PROTOCOL.capabilities.every(capability=>value.capabilities?.includes(capability));
const BUILD = path.join(WORKBENCH_ROOT, 'frontend', 'build');
const DEMO_ID = 'pricing-workbench-demo';

function send(response, code, value, type = 'application/json; charset=utf-8', extra = {}) {
  const body = type.startsWith('application/json') ? JSON.stringify(value) : value;
  response.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  response.end(body);
}

async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error('本次输入过长，请分次保存。'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('请求中的 JSON 格式不正确。'), { status: 400 }); }
}

function runtimeFile(taskDirectory) { return path.join(taskDirectory, 'workbench', 'runtime.json'); }

async function runningService(taskDirectory) {
  try {
    const saved = JSON.parse(fs.readFileSync(runtimeFile(taskDirectory), 'utf8'));
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(saved.url)) return null;
    const response = await fetch(`${saved.url}/api/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json();
    if (response.ok && health.taskDirectory === taskDirectory && health.instanceId === saved.instanceId) return {...saved,workbenchProtocol:health.workbenchProtocol,compatible:compatibleProtocol(health.workbenchProtocol)};
  } catch { /* A stale runtime record is replaced only after a new service starts. */ }
  return null;
}

async function startServer({ taskDirectory, port = 0, dev = false, model, positions, writeRuntime = true, developmentFrontend } = {}) {
  if (dev && !developmentFrontend) throw Error('安装版不包含开发环境；请使用 serve 恢复任务，或 demo 查看合成示例。');
  taskDirectory = path.resolve(taskDirectory);
  if (fs.existsSync(path.join(taskDirectory, 'task.json')) && !fs.existsSync(path.join(taskDirectory, 'workbench', 'state.json'))) {
    throw new Error('此 demo 不自动接管正式审阅任务。请使用隔离项目，并按需传入模型副本。');
  }
  fs.mkdirSync(taskDirectory, { recursive: true });
  const canonicalTask = fs.realpathSync.native(taskDirectory);
  const workspaceId = createHash('sha256').update(process.platform === 'win32' ? canonicalTask.toLowerCase() : canonicalTask).digest('hex');
  const instanceId = randomUUID();
  const startLock = path.join(taskDirectory, '.workbench-server.lock');
  // Service ownership is independent of UI refreshes and content revisions.
  try {
    fs.writeFileSync(startLock, JSON.stringify({ pid: process.pid, instanceId }), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(startLock, 'utf8')); } catch {}
    let alive = true;
    try { if (!Number.isInteger(owner?.pid)) throw Error(); process.kill(owner.pid, 0); }
    catch (cause) { if (cause.code !== 'EPERM') alive = false; }
    if (alive) throw new Error('此任务已有工作台进程，请使用 status 查看地址；如正在启动，请稍后重试。');
    fs.unlinkSync(startLock);
    fs.writeFileSync(startLock, JSON.stringify({ pid: process.pid, instanceId }), { flag: 'wx' });
  }

  const releaseLock = () => {
    try { if (JSON.parse(fs.readFileSync(startLock, 'utf8')).instanceId === instanceId) fs.unlinkSync(startLock); } catch {}
  };
  let store;
  try {
    const existingState = path.join(taskDirectory, 'workbench', 'state.json');
    if (model && fs.existsSync(existingState) && JSON.parse(fs.readFileSync(existingState, 'utf8')).model?.report?.id !== model.report?.id) {
      throw new Error('此任务已保存另一份流程模型。请为导入资料指定独立 --task，原任务不会被覆盖。');
    }
    store = createStore(taskDirectory, { model: model || createDemoModel(), positions: positions || (model ? {} : createDemoPositions()), initialGroupId: model ? (model.groups?.[0]?.id || 'all') : 'execute' });
  }
  catch (error) { releaseLock(); throw error; }
  const stateWithIdentity = state => ({ ...state, contentTree: publicTree(state), materials: store.materials(), workspaceId, workbenchProtocol:WORKBENCH_PROTOCOL, contentOrigin: {
    kind: state.model.report.id === DEMO_ID ? 'synthetic' : 'documents',
    label: state.model.report.id === DEMO_ID ? '合成演示' : '资料流程',
    sourceNames: [...new Set(state.model.sources.filter(source => source.kind !== 'user-feedback').map(source => source.name))],
  } });
  const clients = new Set();
  let vite;
  let localURL = '';
  const broadcast = () => {
    const state = store.read();
    const data = JSON.stringify({ stateRevision: state.stateRevision, workRevision: state.workRevision, modelHash: state.modelHash });
    for (const client of clients) client.write(`event: state\ndata: ${data}\n\n`);
  };

  const server = http.createServer(async (request, response) => {
    const host = request.headers.host;
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    if (host !== expectedHost && host !== `localhost:${server.address()?.port}`) return send(response, 403, { error: '请使用工作台显示的本机地址。' });
    const url = new URL(request.url, localURL || `http://${expectedHost}`);
    try {
        if (url.pathname === '/api/health') return send(response, 200, { ok: true, taskDirectory, workspaceId, instanceId, dev, version: WORKBENCH_VERSION, workbenchProtocol:WORKBENCH_PROTOCOL });
      if (request.method === 'GET' && url.pathname === '/api/workbench/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        response.write('retry: 1200\n\n');
        clients.add(response);
        request.on('close', () => clients.delete(response));
        const state = store.read();
        response.write(`event: state\ndata: ${JSON.stringify({ stateRevision: state.stateRevision, workRevision: state.workRevision })}\n\n`);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/workbench/state') return send(response, 200, stateWithIdentity(store.read()));
      if (request.method === 'GET' && url.pathname === '/api/workbench/buffers') return send(response, 200, store.buffers(url.searchParams.get('sessionId') || 'default'));
      if (request.method === 'GET' && url.pathname === '/api/workbench/context') return send(response, 200, store.context(url.searchParams.get('nodeId') || undefined));
      if (request.method === 'GET' && url.pathname.startsWith('/api/workbench/references/')) return send(response, 200, store.reference(decodeURIComponent(url.pathname.slice('/api/workbench/references/'.length))));
      const candidateReview = request.method === 'GET' && /^\/api\/workbench\/candidates\/([^/]+)\/review$/.exec(url.pathname);
      if (candidateReview) return send(response, 200, store.reviewCandidate(decodeURIComponent(candidateReview[1])));
      if (request.method === 'GET' && url.pathname === '/api/model') {
        const state = store.read();
        return send(response, 200, state.model, 'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename="model.json"', 'X-Work-Revision': String(state.workRevision) });
      }
      if (request.method === 'GET' && url.pathname === '/api/flow') {
        const state = store.read();
        return send(response, 200, renderFlow(state.model).markdown, 'text/markdown; charset=utf-8', { 'Content-Disposition': 'attachment; filename="flow.md"', 'X-Work-Revision': String(state.workRevision) });
      }
      if (url.pathname.startsWith('/api/')) {
        const routes = {
          'POST /api/workbench/edits': 'edit',
          'POST /api/workbench/content': 'contentEdit',
          'POST /api/workbench/materials': 'materialEdit',
          'POST /api/workbench/structure-edits/preview': 'previewStructureEdit',
          'POST /api/workbench/structure-edits': 'structureEdit',
          'POST /api/workbench/undo': 'undo',
          'PUT /api/workbench/buffers': 'saveBuffer',
          'PATCH /api/workbench/view': 'updateView',
          'POST /api/workbench/requests': 'createRequest',
          'POST /api/workbench/references': 'createReference',
          'POST /api/workbench/results': 'saveResult',
          'POST /api/workbench/candidates': 'createCandidate',
          'POST /api/workbench/revert-candidates': 'createRevertCandidate',
          'POST /api/workbench/apply': 'applyCandidate',
        };
        const method = routes[`${request.method} ${url.pathname}`];
        if (!method) return send(response, 404, { error: '没有这个工作台接口。' });
        if (request.headers.origin !== `http://${host}` || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
          return send(response, 403, { error: '请从当前工作台或固定内容工具保存。' });
        }
        if (request.headers['x-workbench-id'] !== workspaceId) return send(response, 409, { error: '工作台任务已切换，本次写入已拒绝。请先保留当前输入，再重新打开任务页面。', code: 'WORKSPACE_CHANGED' });
        const input = await bodyOf(request);
        const result = await store[method](input);
        send(response, 200, result && typeof result.workRevision === 'number' && result.model ? stateWithIdentity(result) : result);
        if (!['saveBuffer', 'createCandidate', 'createReference', 'previewStructureEdit', 'createRevertCandidate'].includes(method)) broadcast();
        return;
      }
      if (vite) return vite.middlewares(request, response, () => send(response, 404, '找不到页面', 'text/plain; charset=utf-8'));
      if (!['GET', 'HEAD'].includes(request.method)) return send(response, 405, { error: '不支持这个请求方法。' });
      let relative;
      try { relative = decodeURIComponent(url.pathname); } catch { return send(response, 400, { error: '地址格式不正确。' }); }
      const requested = path.resolve(BUILD, '.' + relative);
      if (!requested.startsWith(BUILD + path.sep) && requested !== BUILD) return send(response, 403, { error: '无效资源路径。' });
      const file = relative === '/' ? path.join(BUILD, 'index.html') : requested;
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(response, 404, '页面资源不存在，请先运行 npm run demo:build。', 'text/plain; charset=utf-8');
      const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
      return send(response, 200, fs.readFileSync(file), types[path.extname(file)] || 'application/octet-stream');
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      send(response, error.status || error.statusCode || 400, { error: error.message, code: error.code, details: error.details });
    }
  });

  try {
    if (dev) {
      const { createServer } = await import('vite');
      vite = await createServer({ configFile: path.join(developmentFrontend, 'vite.config.mjs'), server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    localURL = `http://127.0.0.1:${server.address().port}`;
    const runtime = { url: localURL, taskDirectory, workspaceId, instanceId, pid: process.pid, dev, startedAt: new Date().toISOString() };
    if (writeRuntime) fs.writeFileSync(runtimeFile(taskDirectory), JSON.stringify(runtime, null, 2) + '\n');
    const heartbeat = setInterval(() => { for (const client of clients) client.write(': heartbeat\n\n'); }, 15000);
    heartbeat.unref();
    const close = async () => {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
      if (vite) await vite.close();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
      releaseLock();
      try { if (JSON.parse(fs.readFileSync(runtimeFile(taskDirectory), 'utf8')).instanceId === instanceId) fs.unlinkSync(runtimeFile(taskDirectory)); } catch {}
    };
    return { server, store, url: localURL, runtime, close, broadcast };
  } catch (error) {
    if (vite) await vite.close();
    server.close();
    releaseLock();
    throw error;
  }
}

function argsOf(args) {
  const options = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (!['project', 'task', 'port', 'model', 'positions', 'input', 'confirm', 'reference'].includes(key) || !args[i + 1]) throw Error('未知或缺值的参数：' + args[i]);
      options[key] = args[++i];
    } else positional.push(args[i]);
  }
  return { options, positional };
}

async function main(args, development = {}) {
  const requestedCommand = args.shift() || 'demo';
  const command = requestedCommand === 'dev-demo' ? 'dev' : requestedCommand;
  if (command === 'dev' && !development.developmentFrontend) throw Error('安装版不包含开发环境；请使用 serve 恢复任务，或 demo 查看合成示例。');
  const { options, positional } = argsOf(args);
  const customTarget = options.model || options.task || options.project;
  const useDemoPreset = requestedCommand === 'dev-demo' && !customTarget;
  if (requestedCommand === 'dev-demo' && positional.length) {
    if (positional.length !== 1 || !['demo1', 'demo2'].includes(positional[0])) throw Error('请选择 demo1 或 demo2，例如 npm run dev:demo -- demo2。');
    if (customTarget) throw Error('指定 --model、--task 或 --project 时，请省略 demo1 或 demo2。');
  }
  if (useDemoPreset) {
    options.port ??= '4174';
    if (positional[0] !== 'demo2') {
      options.model = path.join(development.frozenDemoDirectory, 'model.json');
      options.task = path.join(development.frozenDemoDirectory, 'preview-task');
      if (!fs.existsSync(options.model)) throw Error(`找不到本地知识库测试模型：${options.model}。请恢复冻结快照，或运行 npm run dev:demo -- demo2 使用内置合成数据。`);
    }
  }
  const project = path.resolve(options.project || path.join(process.cwd(), '.qa', 'workbench-demo-project'));
  const model = options.model ? JSON.parse(fs.readFileSync(path.resolve(options.model), 'utf8')) : undefined;
  const taskId = model?.report?.id || DEMO_ID;
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) throw Error('模型报告编号不能作为任务目录名，请检查 report.id。');
  const taskDirectory = path.resolve(options.task || path.join(project, '.document-review', taskId));
  const existing = await runningService(taskDirectory);
  if (['demo', 'dev', 'serve'].includes(command)) {
    const port = options.port === undefined ? 0 : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('端口必须为 0 到 65535 之间的整数。');
    if (existing) {
      if(!existing.compatible)throw Error(`当前 ${existing.url} 仍在运行旧工作台，不能复用。请先保留输入并停止该任务旧服务，再用当前命令启动；原任务资料不会被覆盖。`);
      if (useDemoPreset && (!existing.dev || (port && Number(new URL(existing.url).port) !== port))) {
        throw Error(`所选测试任务正在 ${existing.url} 运行。请在原终端停止该服务，再用当前命令启动开发预览。`);
      }
      if (model) {
        const current = await fetch(existing.url + '/api/workbench/state').then(response => response.json());
        if (current.model?.report?.id !== model.report.id) throw Error('当前服务属于另一份流程，请为资料指定独立 --task。');
      }
      console.log(JSON.stringify({ ...existing, status: 'reused' }, null, 2)); return;
    }
    const positions = options.positions ? JSON.parse(fs.readFileSync(path.resolve(options.positions), 'utf8')) : undefined;
    if (command === 'serve' && !model && !fs.existsSync(path.join(taskDirectory, 'workbench', 'state.json'))) throw Error('新资料任务需要 --model；恢复任务请指定已有 --task。合成示例请显式使用 demo。');
    const app = await startServer({ taskDirectory, port, dev: command === 'dev', model, positions, developmentFrontend: development.developmentFrontend });
    console.log('流程整理工作台 ' + app.url);
    console.log((app.store.read().model.report.id === DEMO_ID ? '合成演示资料' : '已载入资料流程') + '；工作草稿保存在 ' + taskDirectory);
    console.log('WORKBENCH_URL=' + app.url);
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await app.close(); process.exitCode = 0; };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  if (!existing) throw Error('工作台尚未启动。请先执行 demo 或 serve，并传入相同 --task。');
  if(!existing.compatible&&command!=='status')throw Error(`当前 ${existing.url} 的服务尚未更新，请保留输入并重启该任务工作台后再操作。`);
  let endpoint;
  let method = 'GET';
  let body;
  if (command === 'status') endpoint = '/api/workbench/state';
  else if (command === 'context') endpoint = '/api/workbench/context' + (positional[0] ? '?nodeId=' + encodeURIComponent(positional[0]) : '');
  else if (command === 'reference') { if (!positional[0]) throw Error('reference 需要引用编号。'); endpoint = '/api/workbench/references/' + encodeURIComponent(positional[0]); }
  else if (command === 'candidate') { endpoint = '/api/workbench/candidates'; method = 'POST'; body = options.input ? JSON.parse(fs.readFileSync(path.resolve(options.input), 'utf8')) : {}; if (options.reference) body.referenceId = options.reference; }
  else if (command === 'content') { endpoint = '/api/workbench/content'; method = 'POST'; if (!options.input) throw Error('content 需要 --input <JSON文件>。'); body = JSON.parse(fs.readFileSync(path.resolve(options.input), 'utf8')); }
  else if (command === 'materials') { endpoint = '/api/workbench/materials'; method = 'POST'; if (!options.input) throw Error('materials 需要 --input <JSON文件>。'); body = JSON.parse(fs.readFileSync(path.resolve(options.input), 'utf8')); }
  else if (command === 'review-candidate') {
    if (!positional[0]) throw Error('review-candidate 需要候选编号。');
    endpoint = '/api/workbench/candidates/' + encodeURIComponent(positional[0]) + '/review';
  }
  else if (command === 'apply') {
    if (!positional[0] || !options.confirm) throw Error('请先展示 review-candidate 的差异。用户确认后，使用 apply <candidateId> --confirm <reviewHash>。');
    endpoint = '/api/workbench/apply'; method = 'POST';
    body = { candidateId: positional[0], reviewHash: options.confirm };
  }
  else if (command === 'revert-candidate') {
    if (!positional[0]) throw Error('revert-candidate 需要已应用的候选事务编号。');
    endpoint = '/api/workbench/revert-candidates'; method = 'POST'; body = { transactionId: positional[0] };
  }
  else if (command === 'result') { endpoint = '/api/workbench/results'; method = 'POST'; if (!options.input) throw Error('result 需要 --input <JSON文件>。'); body = JSON.parse(fs.readFileSync(path.resolve(options.input), 'utf8')); }
  else if (command === 'request') { endpoint = '/api/workbench/state'; }
  else throw Error('命令：demo | dev | dev-demo [demo1|demo2] | serve | status | context [nodeId] | reference <referenceId> | content --input <JSON> | materials --input <JSON> | candidate [--reference <referenceId>] | review-candidate <candidateId> | apply <candidateId> --confirm <reviewHash> | revert-candidate <transactionId> | result --input <JSON> | request <requestId>');
  const response = await fetch(existing.url + endpoint, { method, headers: { Origin: existing.url, 'X-Workbench-Id': existing.workspaceId, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) {
    const detail = ['review-candidate', 'apply', 'revert-candidate'].includes(command) && result.details;
    throw Error((result.error || '工作台操作失败。') + (detail ? '\n' + JSON.stringify(detail, null, 2) : ''));
  }
  if (command === 'status') {
    const recentCandidateTransactions = (result.changes || []).filter(change => change.kind === 'candidate').slice(0, 20)
      .map(({ id, summary, at, undoable }) => ({ transactionId: id, summary, at, undoable }));
    console.log(JSON.stringify({ taskDirectory, url: existing.url, workRevision: result.workRevision, stateRevision: result.stateRevision,
      modelHash: result.modelHash, workbenchProtocol:result.workbenchProtocol, compatible:compatibleProtocol(result.workbenchProtocol), materialsRevision:result.materials?.revision, materialsHash:result.materials?.hash, contentRevision: result.contentTree?.revision || 0, contentHash: result.contentTree?.hash, pendingEdits: result.pendingEdits.length, requests: result.requests.length, recentCandidateTransactions }, null, 2));
  } else if (command === 'request') {
    const item = result.requests.find(item => item.id === positional[0]);
    if (!item) throw Error('没有找到这个请求。');
    console.log(JSON.stringify(item, null, 2));
  } else console.log(JSON.stringify(result, null, 2));
}

module.exports = { startServer, runningService, main, WORKBENCH_PROTOCOL, compatibleProtocol };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
