#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ReviewError, pending, publish, readJson, readRevision, reviewResponse, saveBatch } = require('./grouped-review-store.cjs');
const { beginDraft, checkDraft, commitDraft, abortDraft, draftStatus } = require('./grouped-review-draft.cjs');
const { initialize, migrate, resolveTask } = require('./review-workspace.cjs');

const assets = path.join(__dirname, '..', 'assets', 'grouped-review');
const pages = {
  '/': ['index.html', 'text/html'],
  '/styles.css': ['styles.css', 'text/css'],
  '/review.js': ['review.js', 'application/javascript'],
};
const downloads = {
  '/download/flow.md': ['flow.md', 'text/markdown'],
  '/download/model.json': ['model.json', 'application/json'],
};
const maxBody = 256 * 1024;

function send(response, status, type, body, attachment) {
  response.writeHead(status, {
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'X-Content-Type-Options': 'nosniff',
    ...(attachment ? { 'Content-Disposition': 'attachment; filename="' + attachment + '"' } : {}),
  });
  response.end(body);
}

function sendJson(response, status, data) {
  send(response, status, 'application/json', JSON.stringify(data));
}

async function parseBatch(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= maxBody) chunks.push(chunk);
  }
  if (size > maxBody) throw new ReviewError('本批批注过长，请分两次保存。', 413);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ReviewError('批注格式有误，请重新保存。');
  }
}

function serve(task, port) {
  task = resolveTask(task);
  readRevision(task);
  const server = http.createServer(async (request, response) => {
    const host = '127.0.0.1:' + server.address().port;
    if (request.headers.host !== host) {
      sendJson(response, 403, { error: '请使用服务显示的本机地址。' });
      return;
    }
    try {
      const currentTask = resolveTask(task);
      if (request.method === 'GET') {
        if (request.url === '/api/review') {
          sendJson(response, 200, reviewResponse(currentTask));
          return;
        }
        if (request.url === '/api/version') {
          // The revision directory is visible only after the complete snapshot is published.
          const directory = path.join(currentTask, 'revisions');
          const revision = Math.max(0, ...fs.readdirSync(directory, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name)).map(entry => Number(entry.name)));
          sendJson(response, 200, { revision });
          return;
        }
        if (Object.hasOwn(pages, request.url)) {
          const [file, type] = pages[request.url];
          send(response, 200, type, fs.readFileSync(path.join(assets, file)));
          return;
        }
        const [downloadPath, query] = request.url.split('?', 2);
        if (Object.hasOwn(downloads, downloadPath)) {
          const revision = query === undefined ? undefined : Number(/^revision=([1-9]\d*)$/.exec(query)?.[1]);
          if (revision !== undefined && !Number.isSafeInteger(revision)) throw new ReviewError('下载版本无效。');
          const [file, type] = downloads[downloadPath];
          let directory;
          try {
            directory = readRevision(currentTask, revision).directory;
          } catch (error) {
            if (error.code === 'ENOENT') throw new ReviewError('找不到该版本的审阅稿。', 404);
            throw error;
          }
          send(response, 200, type, fs.readFileSync(path.join(directory, file)), file);
          return;
        }
      }
      if (request.method === 'POST' && request.url === '/api/batches') {
        if (request.headers.origin !== 'http://' + host ||
            !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
          throw new ReviewError('请从当前审阅页面保存批注。', 403);
        }
        sendJson(response, 201, saveBatch(currentTask, await parseBatch(request)));
        return;
      }
      sendJson(response, 404, { error: '这个入口不存在。' });
    } catch (error) {
      if (!(error instanceof ReviewError)) console.error(error);
      sendJson(response, error.status || 500, {
        error: error instanceof ReviewError ? error.message : '无法读取或写入任务目录。请查看本地服务日志。',
      });
    }
  });
  server.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('审阅页 http://127.0.0.1:' + server.address().port + '/');
    console.log('任务目录 ' + task);
  });
}

if (require.main === module) {
  try {
    const [command, directory, ...args] = process.argv.slice(2);
    if (!directory) throw new Error('缺少项目根目录或任务目录。');
    const print = value => console.log(JSON.stringify(value, null, 2));
    if (command === 'init' && (args.length === 1 || args.length === 2)) {
      print(initialize(path.resolve(directory), readJson(args[0]), args[1] ? readJson(args[1]) : undefined));
    } else if (command === 'migrate' && args.length === 1) {
      print(migrate(path.resolve(directory), args[0]));
    } else {
    const task = command === 'publish' && !fs.existsSync(directory) ? path.resolve(directory) : resolveTask(directory);
    if (command === 'serve' && args.length <= 1) {
      const port = Number(args[0] || 0);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口号无效。');
      serve(task, port);
    } else if (command === 'pending' && args.length === 0) {
      print(pending(task));
    } else if (command === 'draft' && (args.length === 0 || (args.length === 2 && args[0] === '--batch'))) {
      print(beginDraft(task, { batchId: args[1] }));
    } else if (command === 'check' && args.length === 0) {
      const result = checkDraft(task);
      print(result);
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'commit' && args.length === 0) {
      print(commitDraft(task));
    } else if (command === 'abort' && args.length === 0) {
      print(abortDraft(task));
    } else if (command === 'status' && args.length === 0) {
      const current = pending(task);
      print({ taskDirectory: task, projectId: current.projectId, revision: current.revision,
        draft: draftStatus(task), pendingBatches: current.batches.map(batch => ({
          id: batch.id, revision: batch.revision, comments: batch.comments.length,
        })) });
    } else if (command === 'batch' && args.length === 3) {
      const [batchId, projectId, revision] = args;
      if (!/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw new Error('批注引用的原轮次无效。');
      console.log(JSON.stringify(pending(task, { batchId, projectId, revision: Number(revision) }), null, 2));
    } else if (command === 'publish' && (args.length === 3 || args.length === 4)) {
      if (fs.existsSync(path.join(task, 'task.json'))) {
        throw new ReviewError('受管任务请使用 draft → check → commit，不能直接指定候选文件发布。');
      }
      const [base, modelFile, reviewFile, outcomesFile] = args;
      if (!/^(0|[1-9]\d*)$/.test(base)) throw new Error('请提供当前审阅版本号，首次发布使用 0。');
      console.log(JSON.stringify(publish(task, Number(base), readJson(modelFile), readJson(reviewFile),
        outcomesFile ? readJson(outcomesFile) : []), null, 2));
    } else {
      throw new Error([
        'node grouped-review.cjs init <项目根目录> <模型> [审阅分组，默认 process]',
        'node grouped-review.cjs migrate <项目根目录> <旧任务目录> （迁移前停止旧服务）',
        'node grouped-review.cjs draft <任务目录> [--batch <批次 ID>]',
        'node grouped-review.cjs check|commit|abort|status <任务目录>',
        'node grouped-review.cjs publish <任务目录> <当前版本号> <模型> <审阅分组> [处理结果]',
        'node grouped-review.cjs serve <任务目录> [端口]',
        'node grouped-review.cjs pending <任务目录>',
        'node grouped-review.cjs batch <任务目录> <批次 ID> <项目 ID> <原审阅轮次>',
      ].join('\n'));
    }
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
