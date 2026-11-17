#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createDemoModel } = require('./workbench-demo-fixture.cjs');

const FRONTEND = path.resolve(__dirname, '..', 'frontend');

function send(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

/** Read a frozen snapshot directly: never initialize or migrate a task store. */
async function startComparison({ stateFile, synthetic = false, port = 4175 } = {}) {
  if (Boolean(stateFile) === Boolean(synthetic)) throw new Error('请指定 --state <state.json> 或 --synthetic，二者只能选择一个。');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须为 0 到 65535 之间的整数。');

  const snapshot = synthetic
    ? { model: createDemoModel(), view: { selectedGroupId: 'execute' }, workRevision: 0 }
    : JSON.parse(fs.readFileSync(path.resolve(stateFile), 'utf8'));
  const model = snapshot.model;
  if (!model?.report || !Array.isArray(model.nodes) || !Array.isArray(model.relations)
    || !Array.isArray(model.groups) || !Array.isArray(model.claims)) {
    throw new Error('需要含有 model 的工作台 state.json 快照。');
  }
  const selectedGroupId = snapshot.view?.selectedGroupId;
  const payload = {
    model,
    view: {
      selectedGroupId: selectedGroupId === 'all' || model.groups.some(group => group.id === selectedGroupId)
        ? selectedGroupId : (model.groups[0]?.id || 'all'),
      positions: snapshot.view?.positions || {},
      layouts: snapshot.view?.layouts || {},
    },
    workRevision: Number.isInteger(snapshot.workRevision) ? snapshot.workRevision : 0,
    modelHash: snapshot.modelHash || createHash('sha256').update(JSON.stringify(model)).digest('hex'),
    sourceLabel: synthetic ? '合成演示资料' : '工作稿只读快照',
    capturedAt: new Date().toISOString(),
  };

  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: path.join(FRONTEND, 'vite.config.mjs'),
    root: FRONTEND,
    cacheDir: path.resolve(FRONTEND, '..', '..', '.qa', 'layout-comparison-vite'),
    appType: 'mpa',
    server: { host: '127.0.0.1', port, strictPort: true, open: false, cors: false },
    plugins: [{
      name: 'read-only-layout-comparison',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const actualPort = server.httpServer?.address()?.port;
          if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(request.headers.host)) {
            return send(response, 403, { error: '请使用预览显示的本机地址。' });
          }
          const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
          if (pathname === '/api' || pathname.startsWith('/api/')) {
            if (request.method !== 'GET') return send(response, 405, { error: '对照预览仅供阅读。' }, { Allow: 'GET' });
            if (pathname === '/api/comparison/state') return send(response, 200, payload);
            return send(response, 404, { error: '没有这个对照预览接口。' });
          }
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            return send(response, 405, { error: '对照预览仅供阅读。' }, { Allow: 'GET, HEAD' });
          }
          if (pathname === '/') {
            response.writeHead(302, { Location: '/comparison.html', 'Cache-Control': 'no-store' });
            return response.end();
          }
          next();
        });
      },
    }],
  });
  try {
    await vite.listen();
    const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
    return { url, close: () => vite.close() };
  } catch (error) {
    await vite.close();
    throw error;
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：node workbench/scripts/compare-layout.cjs --state <state.json> [--port 4175]\n      node workbench/scripts/compare-layout.cjs --synthetic [--port 4175]\n读取一次快照并启动独立只读对照预览，不保存布局或修改原任务。');
    return;
  }
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--synthetic') options.synthetic = true;
    else if ((argument === '--state' || argument === '--port') && args[index + 1] && !args[index + 1].startsWith('--')) {
      const value = args[++index];
      if (argument === '--state') options.stateFile = value;
      else options.port = Number(value);
    } else throw new Error('未知或缺值的参数：' + argument);
  }
  const app = await startComparison(options);
  console.log(`布局对照预览：${app.url}/comparison.html`);
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await app.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { startComparison };
