'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('./workbench-store.cjs');
const { createDemoModel } = require('./workbench-demo-fixture.cjs');
const { startServer, runningService, WORKBENCH_PROTOCOL } = require('./workbench.cjs');
const { validateModel } = require('../../skills/6ak-process-review/scripts/validate-model.cjs');

function setup() {
  const task = path.resolve('.qa/node-material-text-input-20261117/backend-' + crypto.randomUUID());
  return { task, store: createStore(task, { model: createDemoModel() }) };
}
function edit(store, patch) {
  const input = { requestId: crypto.randomUUID(), nodeId: 'validate', baseContentRevision: store.context().contentTree.revision, ...patch };
  return { input, state: store.contentEdit(input) };
}
function add(store, text, patch = {}) {
  const result = edit(store, { operation: 'create', entryType: 'note', text, ...patch });
  result.entry = result.state.contentTree.entries.find(entry => entry.id === result.state.receipts['content:' + result.input.requestId].contentEntryId);
  return result;
}
function guard(store) {
  const state = store.read();
  return { baseWorkRevision: state.workRevision, baseModelHash: state.modelHash,
    baseContentHash: store.context().contentTree.hash, baseMaterialsHash: store.materials().hash };
}
function reference(store) {
  return store.createReference({ ...guard(store), targets: [{ type: 'node', id: 'validate' }], allNodeMaterials: true });
}
function writeModel(candidate, transform) {
  const model = JSON.parse(fs.readFileSync(candidate.modelFile, 'utf8'));
  transform(model);
  assert.equal(validateModel(model).ok, true, JSON.stringify(validateModel(model)));
  fs.writeFileSync(candidate.modelFile, JSON.stringify(model));
  return model;
}

test('plain text alone saves neutral raw material with exact words and stable replay receipts', () => {
  const { task, store } = setup(), before = store.read();
  const words = '  校验后由财务专员复核。\r\n\r\n不要改写这段原话。  ';
  const first = add(store, words);
  assert.equal(first.entry.text, words.replace(/\r\n/g, '\n'));
  assert.equal(first.entry.kind, 'raw');
  assert.equal(first.entry.title, '');
  assert.equal(first.entry.parentId, null);
  assert.equal(first.entry.nodeId, 'validate');
  assert.equal(first.entry.revisions[0].kind, 'raw');
  const second = add(store, '另一节点的独立输入', { nodeId: 'manual' });
  const replay = store.contentEdit(first.input);
  assert.equal(replay.receipts['content:' + first.input.requestId].contentEntryId, first.entry.id);
  assert.equal(replay.receipts['content:' + first.input.requestId].nodeId, 'validate');
  assert.notEqual(first.entry.id, second.entry.id);
  assert.equal(replay.contentTree.entries.length, 2);
  assert.equal(replay.modelHash, before.modelHash);
  assert.equal(replay.workRevision, before.workRevision);
  assert.deepEqual(replay.model, before.model);
  assert.deepEqual(createStore(task).read().contentTree, replay.contentTree);
  assert.throws(() => store.contentEdit({ ...first.input, text: '同号不同内容' }), /同一个保存请求编号/);
  for (const text of ['', ' \n\t\r\n ', '长'.repeat(20001)]) assert.throws(() => add(store, text), /不能为空且最多 20000/);
  assert.equal(add(store, '长'.repeat(20000)).entry.text.length, 20000);
});

test('text-only edits preserve legacy titles, categories and hierarchy; all kinds remain in node handoff', () => {
  const { store } = setup();
  edit(store, { operation: 'create', entryType: 'section', title: '旧栏目' });
  const section = store.read().contentTree.entries[0];
  for (const kind of ['fact', 'reminder', 'proposal', 'question']) {
    const { entry } = add(store, `${kind} 的原话`, { title: `旧标题 ${kind}`, kind, parentId: section.id });
    edit(store, { operation: 'update', entryId: entry.id, text: `${kind} 的修订原话` });
    const updated = store.read().contentTree.entries.find(item => item.id === entry.id);
    assert.equal(updated.title, entry.title);
    assert.equal(updated.kind, kind);
    assert.equal(updated.parentId, section.id);
    assert.equal(updated.revisions[0].text, entry.text);
    assert.equal(updated.revisions.length, 2);
  }
  add(store, '没有分类的新原话');
  const ref = reference(store), candidate = store.createCandidate({ referenceId: ref.id });
  assert.deepEqual(new Set(ref.contentInputs.map(input => input.kind)), new Set(['fact', 'reminder', 'proposal', 'question', 'raw']));
  assert.equal(candidate.feedbackSources.length, 1);
  assert.equal(candidate.rawMaterialSources.length, 1);
  assert.match(candidate.feedbackSources[0].name, /^用户补充/);
  assert.match(candidate.rawMaterialSources[0].name, /^用户原话/);
  assert.equal(candidate.rawMaterialSources[0].text, '没有分类的新原话');
  assert.ok(!candidate.contentInputs.some(input => input.kind === 'fact' && input.text === '没有分类的新原话'));
});

test('raw fact, suggestion and question stay verbatim through candidate review, adoption and undo', () => {
  const { store } = setup(), before = store.read();
  const text = '校验结果由财务专员复核。\n建议未来增加自动提醒。\n失败后的复核时限是否明确？';
  const { entry } = add(store, text);
  const ref = reference(store), candidate = store.createCandidate({ referenceId: ref.id });
  assert.equal(candidate.feedbackSources.length, 0);
  assert.equal(candidate.rawMaterialSources.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(candidate.modelFile, 'utf8')), before.model, 'source snapshots do not auto-adopt any words');
  const source = candidate.rawMaterialSources[0], lines = text.split('\n');
  assert.equal(source.sha256, crypto.createHash('sha256').update(text).digest('hex'));
  const proposed = writeModel(candidate, model => {
    model.sources.push(source);
    model.claims.push(
      { id: 'raw-review-action', text: lines[0], origin: 'explicit', evidence: [{ sourceId: source.id, startLine: 1, endLine: 1, quote: lines[0] }] },
      { id: 'raw-review-deadline', text: '失败后的复核时限尚待确认。', origin: 'unknown', evidence: [{ sourceId: source.id, startLine: 3, endLine: 3, quote: lines[2] }], issueIds: ['raw-deadline-question'] },
    );
    model.issues.push({ id: 'raw-deadline-question', type: 'missing', severity: 'minor', status: 'open', question: lines[2], impact: '无法确定复核时限。', claimIds: ['raw-review-deadline'], nodeIds: ['validate'], relationIds: [] });
    const node = model.nodes.find(node => node.id === 'validate');
    node.claimIds.push('raw-review-action', 'raw-review-deadline');
    node.fields.actions.push('raw-review-action');
    node.fields.rules.push('raw-review-deadline');
    model.coverage.push(
      { sourceId: source.id, startLine: 1, endLine: 1, disposition: 'represented', claimIds: ['raw-review-action'], issueIds: [], reason: '原话明确补充当前动作。' },
      { sourceId: source.id, startLine: 2, endLine: 2, disposition: 'out_of_scope', claimIds: [], issueIds: [], reason: '未来建议，不作为现行动作。' },
      { sourceId: source.id, startLine: 3, endLine: 3, disposition: 'issue', claimIds: ['raw-review-deadline'], issueIds: ['raw-deadline-question'], reason: '保持疑问，待确认。' },
    );
  });
  const review = store.reviewCandidate(candidate.candidateId);
  assert.ok(review.changes.length);
  store.applyCandidate({ candidateId: candidate.candidateId, reviewHash: review.reviewHash });
  assert.deepEqual({ ...store.read().model, review: proposed.review }, proposed);
  assert.equal(store.read().model.review.semantic.status, 'not_run');
  let adopted = store.context().contentTree.entries.find(item => item.id === entry.id);
  assert.equal(adopted.kind, 'raw');
  assert.equal(adopted.text, text);
  assert.deepEqual(adopted.adoptedRevisions, [1]);
  assert.deepEqual(store.read().model.relations, before.model.relations, 'a question must not create a determined connection');
  assert.equal(store.read().model.claims.some(claim => claim.text.includes('增加自动提醒')), false);
  add(store, '采用后继续新增，撤销结果不能丢失材料。');
  store.undo(guard(store));
  assert.deepEqual(store.read().model, before.model);
  assert.equal(store.read().contentTree.entries.length, 2);
  adopted = store.context().contentTree.entries.find(item => item.id === entry.id);
  assert.deepEqual(adopted.adoptedRevisions, []);
  assert.equal(adopted.kind, 'raw');
});

test('raw conflicting facts can retain both explicit sources and an open conflict without recategorizing the material', () => {
  const { store } = setup();
  const { entry } = add(store, '校验降幅由财务专员负责。');
  const candidate = store.createCandidate({ referenceId: reference(store).id }), source = candidate.rawMaterialSources[0];
  writeModel(candidate, model => {
    model.sources.push(source);
    const old = model.claims.find(claim => claim.id === 'validate-role');
    old.issueIds = [...(old.issueIds || []), 'raw-role-conflict'];
    model.claims.push({ id: 'raw-conflicting-role', text: source.text, origin: 'explicit', evidence: [{ sourceId: source.id, startLine: 1, endLine: 1, quote: source.text }], issueIds: ['raw-role-conflict'] });
    model.issues.push({ id: 'raw-role-conflict', type: 'conflict', severity: 'major', status: 'open', question: '此环节由调价系统还是财务专员负责？', impact: '负责人需核对。', claimIds: [old.id, 'raw-conflicting-role'], nodeIds: ['validate'], relationIds: [] });
    const node = model.nodes.find(node => node.id === 'validate');
    node.claimIds.push('raw-conflicting-role'); node.fields.role.push('raw-conflicting-role');
    model.coverage.push({ sourceId: source.id, startLine: 1, endLine: 1, disposition: 'issue', claimIds: ['raw-conflicting-role'], issueIds: ['raw-role-conflict'], reason: '保留双方明示依据，尚未确认负责人。' });
  });
  const review = store.reviewCandidate(candidate.candidateId);
  store.applyCandidate({ candidateId: candidate.candidateId, reviewHash: review.reviewHash });
  assert.equal(store.read().model.issues.find(issue => issue.id === 'raw-role-conflict').status, 'open');
  assert.equal(store.read().model.claims.find(claim => claim.id === 'validate-role').text, '调价系统');
  assert.equal(store.read().contentTree.entries.find(item => item.id === entry.id).kind, 'raw');
});

test('a raw question used only by a current issue counts as used; an out-of-scope suggestion does not', () => {
  const { store } = setup();
  const question = add(store, '失败后是否需要再次复核？').entry;
  const suggestion = add(store, '建议未来增加自动提醒。').entry;
  const candidate = store.createCandidate({ referenceId: reference(store).id });
  writeModel(candidate, model => {
    model.sources.push(...candidate.rawMaterialSources);
    const questionSource = candidate.rawMaterialSources.find(source => source.id.includes(question.id));
    const suggestionSource = candidate.rawMaterialSources.find(source => source.id.includes(suggestion.id));
    model.issues.push({ id: 'raw-question-only', type: 'missing', severity: 'minor', status: 'open', question: question.text, impact: '失败后复核方式待确认。', claimIds: [], nodeIds: ['validate'], relationIds: [] });
    model.coverage.push(
      { sourceId: questionSource.id, startLine: 1, endLine: 1, disposition: 'issue', claimIds: [], issueIds: ['raw-question-only'], reason: '该原话用于当前待确认问题，没有形成确定动作。' },
      { sourceId: suggestionSource.id, startLine: 1, endLine: 1, disposition: 'out_of_scope', claimIds: [], issueIds: [], reason: '未来建议未采用。' },
    );
  });
  const review = store.reviewCandidate(candidate.candidateId);
  store.applyCandidate({ candidateId: candidate.candidateId, reviewHash: review.reviewHash });
  const entries = store.context().contentTree.entries;
  assert.deepEqual(entries.find(entry => entry.id === question.id).adoptedRevisions, [1]);
  assert.deepEqual(entries.find(entry => entry.id === suggestion.id).adoptedRevisions, []);
  assert.ok(entries.every(entry => entry.kind === 'raw'));
});

test('candidate source and node snapshots are guarded; revised or archived raw input invalidates prior review', () => {
  const { store } = setup();
  const { entry } = add(store, '可核对的原话。');
  const ref = reference(store), candidate = store.createCandidate({ referenceId: ref.id });
  const model = JSON.parse(fs.readFileSync(candidate.modelFile, 'utf8'));
  const forged = { ...candidate.rawMaterialSources[0], name: '伪装为事实来源' };
  model.sources.push(forged);
  model.coverage.push({ sourceId: forged.id, startLine: 1, endLine: 1, disposition: 'out_of_scope', claimIds: [], issueIds: [], reason: '测试原话身份约束。' });
  fs.writeFileSync(candidate.modelFile, JSON.stringify(model));
  assert.throws(() => store.reviewCandidate(candidate.candidateId), /与所选原话版本不一致/);
  model.sources[model.sources.length - 1] = candidate.rawMaterialSources[0];
  fs.writeFileSync(candidate.modelFile, JSON.stringify(model));
  const metadata = JSON.parse(fs.readFileSync(candidate.metaFile, 'utf8'));
  metadata.contentInputs[0].nodeId = 'manual';
  fs.writeFileSync(candidate.metaFile, JSON.stringify(metadata));
  assert.throws(() => store.reviewCandidate(candidate.candidateId), /真实挂载版本不一致/);
  metadata.contentInputs[0].nodeId = entry.nodeId;
  fs.writeFileSync(candidate.metaFile, JSON.stringify(metadata));
  const reviewed = store.reviewCandidate(candidate.candidateId);
  edit(store, { operation: 'update', entryId: entry.id, text: '已修订的原话。' });
  assert.equal(store.reference(ref.id).stale, true);
  assert.throws(() => store.applyCandidate({ candidateId: candidate.candidateId, reviewHash: reviewed.reviewHash }), /节点补充已改变/);
  const revised = store.read().contentTree.entries.find(item => item.id === entry.id), beforeArchive = store.read();
  assert.equal(revised.kind, 'raw');
  assert.equal(revised.revisions[0].text, entry.text);
  edit(store, { operation: 'archive', entryId: entry.id });
  const archived = store.read().contentTree.entries.find(item => item.id === entry.id);
  assert.equal(archived.archived, true);
  assert.equal(archived.revisions.length, 3);
  assert.equal(store.read().workRevision, beforeArchive.workRevision);
  assert.equal(store.read().modelHash, beforeArchive.modelHash);
  assert.deepEqual(reference(store).contentInputs, []);
});

test('HTTP text capability saves text-only material and returns usable node-wide reference and candidate snapshots', async () => {
  const { task } = setup(), app = await startServer({ taskDirectory: task });
  try {
    const health = await fetch(app.url + '/api/health').then(response => response.json());
    assert.ok(health.workbenchProtocol.capabilities.includes('node-material-text-v1'));
    assert.equal(health.workbenchProtocol.version, 2);
    const state = await fetch(app.url + '/api/workbench/state').then(response => response.json());
    const post = async (endpoint, input) => {
      const response = await fetch(app.url + '/api/workbench/' + endpoint, { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Workbench-Id': state.workspaceId }, body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() };
    };
    const request = { requestId: crypto.randomUUID(), operation: 'create', entryType: 'note', nodeId: 'validate', text: '第一段原话。\n\n第二段原话。', baseContentRevision: 0 };
    const saved = await post('content', request);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.modelHash, state.modelHash);
    assert.equal(saved.body.workRevision, state.workRevision);
    const entry = saved.body.contentTree.entries[0];
    assert.equal(entry.kind, 'raw'); assert.equal(entry.text, request.text);
    const retry = await post('content', request);
    assert.equal(retry.status, 200); assert.equal(retry.body.contentTree.entries.length, 1);
    assert.equal(retry.body.receipts['content:' + request.requestId].contentEntryId, entry.id);
    const ref = await post('references', { ...guard(app.store), targets: [{ type: 'node', id: 'validate' }], allNodeMaterials: true });
    assert.equal(ref.status, 200); assert.equal(ref.body.contentInputs[0].text, request.text);
    const reread = await fetch(app.url + '/api/workbench/references/' + ref.body.id).then(response => response.json());
    assert.equal(reread.stale, false); assert.equal(reread.contentInputs[0].kind, 'raw');
    const candidate = await post('candidates', { referenceId: ref.body.id });
    assert.equal(candidate.status, 200); assert.equal(candidate.body.rawMaterialSources[0].text, request.text);
    assert.equal(candidate.body.feedbackSources.length, 0);
    assert.equal((await runningService(task)).compatible, true);
  } finally { await app.close(); }
});

test('a running protocol-2 backend without text support is explicitly incompatible', async () => {
  const { task } = setup(), http = require('node:http'), instanceId = crypto.randomUUID();
  const oldProtocol = { ...WORKBENCH_PROTOCOL, capabilities: WORKBENCH_PROTOCOL.capabilities.filter(value => value !== 'node-material-text-v1') };
  const server = http.createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true, taskDirectory: task, instanceId, workbenchProtocol: oldProtocol })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  fs.writeFileSync(path.join(task, 'workbench/runtime.json'), JSON.stringify({ url, instanceId, workspaceId: 'old-v2' }));
  try { assert.equal((await runningService(task)).compatible, false); }
  finally { await new Promise(resolve => server.close(resolve)); }
});
