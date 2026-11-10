#!/usr/bin/env node
'use strict';

// Tooling regression only: these synthetic cases do not confirm real business rules.
// Run: node --test skills/6ak-process-review/scripts/selftest.cjs
// Set PRICING_QA_DIR to a writable parent directory for isolated, cleaned-up tasks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { indexSources, digest } = require('./index-sources.cjs');
const { validateModel } = require('./validate-model.cjs');
const { renderFlow } = require('./export-flow.cjs');
const { resolveReference } = require('./resolve-reference.cjs');
const { pending, publish, readRevision, reviewResponse, saveBatch } = require('./grouped-review-store.cjs');

const fixturePath = path.resolve(__dirname, '../examples/messy-pricing.model.json');
const fixture = () => JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const review = () => ({ layout: 'process' });

function temporary(t) {
  const root = process.env.PRICING_QA_DIR
    ? path.resolve(process.env.PRICING_QA_DIR)
    : path.join(os.tmpdir(), 'process-review-tooling');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'run-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), root);
    assert.match(path.basename(directory), /^run-/);
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return directory;
}

function valid(model) {
  const result = validateModel(model);
  assert.equal(result.ok, true, result.errors.join('\n'));
  return result;
}

function rejection(action, expression, status) {
  assert.throws(action, error => {
    assert.match(error.message, expression);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

function start(t, model = fixture()) {
  const task = temporary(t);
  assert.equal(publish(task, 0, model, review()).revision, 1);
  return task;
}

function comment(task, itemId, options = {}) {
  const snapshot = readRevision(task);
  const group = snapshot.groups.find(entry => entry.items.some(item => item.view.id === itemId));
  assert.ok(group, 'The chosen review object must actually be displayed');
  return { id: randomUUID(), groupId: group.id, itemId, tags: ['rewrite'], text: '合成测试批注：请核对这处表达。', ...options };
}

function save(task, comments) {
  const input = { id: randomUUID(), revision: readRevision(task).revision, comments };
  assert.deepEqual(saveBatch(task, input), { id: input.id });
  return input;
}

function nextVersion(model, version) {
  const next = structuredClone(model);
  next.report.version = String(version);
  return next;
}

function sourceUpdate() {
  const model = fixture();
  const lines = model.sources[0].text.split('\n');
  // Move whole source paragraphs, keeping their facts and business IDs intact.
  model.sources[0].text = [lines[0], '', lines[5], lines[2], lines[4], lines[3], lines[6], ''].join('\n');
  model.sources[0].sha256 = digest(model.sources[0].text);
  const newLine = new Map([[3, 4], [4, 6], [5, 5], [6, 3], [7, 7]]);
  for (const claim of model.claims) for (const evidence of claim.evidence) {
    evidence.startLine = newLine.get(evidence.startLine);
    evidence.endLine = newLine.get(evidence.endLine);
  }
  model.coverage = [
    { sourceId: 'source-1', startLine: 1, endLine: 1, disposition: 'out_of_scope', claimIds: [], issueIds: [], reason: '示例标题。' },
    { sourceId: 'source-1', startLine: 3, endLine: 3, disposition: 'issue', claimIds: ['approval-20'], issueIds: ['threshold-conflict'], reason: '保留原有冲突一方。' },
    { sourceId: 'source-1', startLine: 4, endLine: 4, disposition: 'represented', claimIds: ['calculate', 'operator'], issueIds: [], reason: '' },
    { sourceId: 'source-1', startLine: 5, endLine: 5, disposition: 'issue', claimIds: ['approval-15'], issueIds: ['threshold-conflict'], reason: '保留原有冲突另一方。' },
    { sourceId: 'source-1', startLine: 6, endLine: 6, disposition: 'represented', claimIds: ['submit', 'system', 'check', 'submission-before-check'], issueIds: [], reason: '' },
    { sourceId: 'source-1', startLine: 7, endLine: 7, disposition: 'issue', claimIds: ['unknown-mismatch'], issueIds: ['mismatch-missing'], reason: '异常处置仍未说明。' },
  ];
  const text = '# 留存补充\n核算结果保存到报价单。\n';
  model.sources.push({ id: 'source-appendix', name: 'appendix.md', text, sha256: digest(text) });
  model.claims.push({ id: 'calculation-record', text: '核算结果保存到报价单。', origin: 'explicit', evidence: [
    { sourceId: 'source-appendix', startLine: 2, endLine: 2, quote: '核算结果保存到报价单。' },
  ] });
  const calculation = model.nodes.find(node => node.id === 'calculate');
  calculation.claimIds.push('calculation-record');
  calculation.fields.output.push('calculation-record');
  model.coverage.push({ sourceId: 'source-appendix', startLine: 1, endLine: 2, disposition: 'represented', claimIds: ['calculation-record'], issueIds: [], reason: '留存补充已纳入。' });
  model.report.version = '2';
  return model;
}

test('synthetic partial workflow preserves conflict and unknown states without claiming semantic review', () => {
  const model = fixture();
  const before = JSON.stringify(model);
  const result = valid(model);
  assert.ok(result.warnings.some(warning => /未决/.test(warning)));
  assert.equal(model.issues.find(issue => issue.type === 'conflict').status, 'open');
  assert.equal(model.claims.find(claim => claim.id === 'unknown-mismatch').origin, 'unknown');
  assert.equal(model.review.semantic.status, 'not_run');
  assert.equal(JSON.stringify(model), before);
});

test('source indexing accepts an additional document and normalizes only encoding and newlines', t => {
  const directory = temporary(t);
  const original = path.join(directory, 'original.md');
  const appendix = path.join(directory, 'appendix.md');
  fs.writeFileSync(original, '\uFEFF# 合成原稿\r\n\r\n由运营核算。\r');
  fs.writeFileSync(appendix, '补充：核算结果留存。\n');
  const first = indexSources([original]);
  const expanded = indexSources([original, appendix]);
  assert.deepEqual(expanded.sources[0], first.sources[0]);
  assert.equal(expanded.sources.length, 2);
  assert.equal(expanded.sources[0].text, '# 合成原稿\n\n由运营核算。\n');
  assert.equal(expanded.sources[1].text, '补充：核算结果留存。\n');
  assert.equal(expanded.sources[1].sha256, digest(expanded.sources[1].text));
  rejection(() => indexSources([original, original]), /重复/);
});

test('reordered paragraphs and an added source remain valid with updated evidence and stable business IDs', t => {
  const initial = fixture();
  const updated = sourceUpdate();
  valid(updated);
  assert.deepEqual(updated.nodes.map(node => node.id), initial.nodes.map(node => node.id));
  assert.deepEqual(updated.relations, initial.relations, 'Source paragraph order must not create business ordering');
  assert.deepEqual(updated.issues, initial.issues, 'A new source must not silently resolve unrelated questions');
  assert.equal(updated.claims.find(claim => claim.id === 'calculate').evidence[0].startLine, 4);
  assert.equal(updated.claims.find(claim => claim.id === 'submit').evidence[0].startLine, 6);
  const task = start(t, initial);
  publish(task, 1, updated, review());
  const saved = readRevision(task);
  assert.deepEqual(saved.model.sources, updated.sources);
  const flow = fs.readFileSync(path.join(saved.directory, 'flow.md'), 'utf8');
  assert.ok(flow.includes('核算结果保存到报价单'));
  assert.ok(flow.includes('第 4 行'));
  assert.equal(readRevision(task, 1).model.sources[0].text, initial.sources[0].text);
});

test('changed source digests, stale quotations, and shifted but unreconciled lines are rejected at publication', t => {
  const task = start(t);
  const invalid = [
    [model => { model.sources[0].text += '新资料尚未核对。\n'; }, /sources\.source-1\.sha256/],
    [model => { model.claims[0].evidence[0].quote = '原文不存在的句子'; }, /claims\.calculate\.evidence\[0\]\.quote/],
    [model => { model.sources[0].text = '\n' + model.sources[0].text; model.sources[0].sha256 = digest(model.sources[0].text); }, /与指定原文行不匹配/],
  ];
  for (const [mutate, expected] of invalid) {
    const model = fixture();
    mutate(model);
    const result = validateModel(model);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), expected);
    rejection(() => publish(task, 1, model, review()), expected);
    assert.equal(readRevision(task).revision, 1);
    assert.equal(fs.existsSync(path.join(task, 'revisions', '2')), false);
  }
});

test('each published flow is derived from its own immutable model snapshot and digest', t => {
  const task = start(t);
  const initialDirectory = readRevision(task).directory;
  const initialFlow = fs.readFileSync(path.join(initialDirectory, 'flow.md'), 'utf8');
  publish(task, 1, sourceUpdate(), review());
  for (const revision of [1, 2]) {
    const snapshot = readRevision(task, revision);
    const flow = fs.readFileSync(path.join(snapshot.directory, 'flow.md'), 'utf8');
    assert.equal(flow, renderFlow(snapshot.model).markdown);
    assert.ok(flow.includes(digest(JSON.stringify(snapshot.model))));
    assert.equal(snapshot.model.review.semantic.status, 'not_run');
  }
  assert.equal(fs.readFileSync(path.join(initialDirectory, 'flow.md'), 'utf8'), initialFlow);
});

test('saved annotations distinguish current, unchanged, and changed targets across revisions', t => {
  const model = fixture();
  const task = start(t, model);
  const input = save(task, [comment(task, 'node.calculate.claim.calculate')]);
  const reference = { batchId: input.id, projectId: model.report.id, revision: 1 };
  assert.equal(pending(task, reference).batches[0].comments[0].targetState, 'current');
  publish(task, 1, nextVersion(model, 2), review());
  assert.equal(pending(task, reference).batches[0].comments[0].targetState, 'unchanged');
  const changed = sourceUpdate();
  changed.report.version = '3';
  publish(task, 2, changed, review());
  const result = pending(task, reference);
  assert.equal(result.batches[0].comments[0].targetState, 'changed');
  assert.equal(result.batches[0].comments[0].target.id, 'calculate');
  assert.equal(result.batches[0].originalDirectory, path.join(task, 'revisions', '1'));
  rejection(() => pending(task, { ...reference, projectId: 'another-project' }), /找不到/);
  rejection(() => pending(task, { ...reference, revision: 2 }), /找不到/);
});

test('a whole-step annotation becomes changed when an attached assertion changes but the node object does not', t => {
  const original = fixture();
  const task = start(t, original);
  save(task, [comment(task, 'node.calculate')]);
  const changed = nextVersion(original, 2);
  changed.claims.find(claim => claim.id === 'calculate').text = '运营在改价前核算目标价。';
  assert.deepEqual(changed.nodes, original.nodes);
  valid(changed);
  publish(task, 1, changed, review());
  assert.equal(pending(task).batches[0].comments[0].targetState, 'changed');
});

test('a new limitation elsewhere in the same source makes an unchanged quotation require review', t => {
  const original = fixture();
  const task = start(t, original);
  save(task, [comment(task, 'node.calculate.claim.calculate')]);
  const changed = nextVersion(original, 2);
  const text = '补充限制：本说明仅适用于渠道 X 的日常调价。';
  changed.sources[0].text += text + '\n';
  changed.sources[0].sha256 = digest(changed.sources[0].text);
  changed.claims.push({ id: 'source-scope-limit', text, origin: 'explicit', evidence: [
    { sourceId: 'source-1', startLine: 8, endLine: 8, quote: text },
  ] });
  changed.coverage.push({ sourceId: 'source-1', startLine: 8, endLine: 8, disposition: 'represented', claimIds: ['source-scope-limit'], issueIds: [], reason: '' });
  assert.deepEqual(changed.claims.find(claim => claim.id === 'calculate'), original.claims.find(claim => claim.id === 'calculate'));
  assert.deepEqual(changed.nodes, original.nodes);
  valid(changed);
  publish(task, 1, changed, review());
  assert.equal(pending(task).batches[0].comments[0].targetState, 'changed');
});

test('evidence-only line relocation is visible as a context change even when wording and IDs stay stable', t => {
  const original = fixture();
  const task = start(t, original);
  save(task, [comment(task, 'node.calculate'), comment(task, 'node.calculate.claim.calculate')]);
  const reordered = sourceUpdate();
  const changed = nextVersion(original, 2);
  changed.sources = [reordered.sources[0]];
  changed.claims = reordered.claims.filter(claim => claim.id !== 'calculation-record');
  changed.coverage = reordered.coverage.filter(entry => entry.sourceId === 'source-1');
  assert.deepEqual(changed.nodes, original.nodes);
  assert.equal(changed.claims.find(claim => claim.id === 'calculate').text, original.claims.find(claim => claim.id === 'calculate').text);
  valid(changed);
  publish(task, 1, changed, review());
  assert.deepEqual(pending(task).batches[0].comments.map(entry => entry.targetState), ['changed', 'changed']);
  const changes = reviewResponse(task).changes;
  assert.ok(changes.some(change => change.kind === 'context' && change.itemId === 'node.calculate.claim.calculate'),
    'Readers must be able to find evidence-only changes without a wording diff');
});

test('moving and renaming a step preserves stable target IDs and exposes the old reading context', t => {
  const model = fixture();
  model.groups.push({ id: 'verification', title: '核验', kind: 'editorial', claimIds: [] });
  model.nodes.find(node => node.id === 'check').groupId = 'verification';
  const task = start(t, model);
  const input = save(task, [comment(task, 'node.calculate')]);
  const changed = nextVersion(model, 2);
  const calculation = changed.nodes.find(node => node.id === 'calculate');
  calculation.groupId = 'verification';
  calculation.title = '记录核算目标价';
  publish(task, 1, changed, review());
  const annotation = pending(task).batches[0].comments[0];
  assert.equal(annotation.id, input.comments[0].id);
  assert.deepEqual(annotation.target, { type: 'node', id: 'calculate' });
  assert.equal(annotation.itemText, '核算目标价');
  assert.equal(annotation.currentGroupId, 'verification');
  assert.equal(annotation.targetState, 'changed');
  const current = reviewResponse(task);
  assert.ok(current.changes.some(change => change.itemId === 'node.calculate' && change.kind === 'move'));
  assert.ok(current.changes.some(change => change.itemId === 'node.calculate' && change.before === '核算目标价' && change.after === '记录核算目标价'));
  assert.deepEqual(readRevision(task).model.relations, model.relations);
});

test('identical text annotations retain the chosen object and exact selected substring', t => {
  const model = fixture();
  const second = structuredClone(model.claims.find(claim => claim.id === 'calculate'));
  second.id = 'same-words-other-step';
  model.claims.push(second);
  const submission = model.nodes.find(node => node.id === 'submit');
  submission.claimIds.push(second.id);
  submission.fields.actions.push(second.id);
  const task = start(t, model);
  const startOffset = second.text.indexOf('运营');
  const selection = { start: startOffset, end: startOffset + 2, text: '运营' };
  const input = save(task, [comment(task, 'node.submit.claim.same-words-other-step', { selection })]);
  const saved = pending(task).batches[0].comments[0];
  assert.equal(saved.target.id, second.id);
  assert.equal(saved.target.context.id, 'submit');
  assert.deepEqual(saved.selection, selection);
  const invalid = { id: randomUUID(), revision: 1, comments: [
    comment(task, 'node.calculate.claim.calculate', { selection: { ...selection, text: '销售' } }),
  ] };
  rejection(() => saveBatch(task, invalid), /选中文字/);
  assert.deepEqual(reviewResponse(task).batches.map(batch => batch.id), [input.id]);
});

test('retrying the same saved batch is idempotent, while changed retries and reused comment IDs are rejected', t => {
  const task = start(t);
  const input = save(task, [comment(task, 'node.calculate')]);
  const batchFile = path.join(task, 'batches', input.id, 'batch.json');
  const bytes = fs.readFileSync(batchFile, 'utf8');
  assert.deepEqual(saveBatch(task, structuredClone(input)), { id: input.id });
  const changed = structuredClone(input);
  changed.comments[0].text = '不得覆盖原先批次。';
  rejection(() => saveBatch(task, changed), /不能覆盖/, 409);
  rejection(() => saveBatch(task, { ...input, id: randomUUID() }), /批注需要/);
  publish(task, 1, nextVersion(fixture(), 2), review());
  assert.deepEqual(saveBatch(task, structuredClone(input)), { id: input.id });
  assert.equal(fs.readFileSync(batchFile, 'utf8'), bytes);
  assert.equal(reviewResponse(task).batches.length, 1);
  const stale = { id: randomUUID(), revision: 1, comments: [comment(task, 'node.calculate')] };
  rejection(() => saveBatch(task, stale), /审阅稿已更新/, 409);
  assert.equal(reviewResponse(task).batches.length, 1);
});

test('stale publication and duplicate outcome entries do not create a new revision', t => {
  const task = start(t);
  const input = save(task, [comment(task, 'node.calculate')]);
  const outcome = { batchId: input.id, commentId: input.comments[0].id, status: 'applied', summary: '合成表达已核对。', groupIds: ['price-change'] };
  rejection(() => publish(task, 1, fixture(), review(), [outcome, outcome]), /处理结果必须/);
  assert.equal(readRevision(task).revision, 1);
  publish(task, 1, nextVersion(fixture(), 2), review(), [outcome]);
  rejection(() => publish(task, 1, nextVersion(fixture(), 2), review(), [outcome]), /审阅稿已更新/, 409);
  assert.equal(readRevision(task).revision, 2);
  assert.equal(readRevision(task).outcomes.length, 1);
});

test('two rounds preserve outcomes and keep clarification pending without resolving business issues', t => {
  const task = start(t);
  const input = save(task, [
    comment(task, 'node.calculate'),
    comment(task, 'node.submit'),
    comment(task, 'issue.mismatch-missing', { tags: ['unknown'], text: '' }),
  ]);
  const statuses = ['applied', 'needs-clarification', 'left-open'];
  const outcomes = input.comments.map((entry, index) => ({
    batchId: input.id, commentId: entry.id, status: statuses[index], summary: '合成测试处理记录。', groupIds: ['price-change'],
  }));
  publish(task, 1, nextVersion(fixture(), 2), review(), outcomes);
  const reference = { batchId: input.id, projectId: fixture().report.id, revision: 1 };
  const awaiting = pending(task, reference);
  assert.deepEqual(awaiting.batches[0].comments.map(entry => entry.id), [input.comments[1].id]);
  assert.equal(awaiting.requestedBatch.outcomes.length, 3);
  assert.equal(readRevision(task).model.issues.find(issue => issue.id === 'mismatch-missing').status, 'open');
  publish(task, 2, nextVersion(fixture(), 3), review(), [{ ...outcomes[1], status: 'applied', summary: '进一步澄清后落实表达。' }]);
  assert.equal(pending(task, reference).batches.length, 0);
  const latest = reviewResponse(task).batches[0].comments;
  assert.deepEqual(latest.map(entry => entry.outcome.status), ['applied', 'applied', 'left-open']);
  assert.equal(readRevision(task, 2).outcomes[1].status, 'needs-clarification');
  assert.deepEqual(readRevision(task).model.issues, fixture().issues);
});

test('terminal outcomes retain their original revision on identical replay and reject a different replay', t => {
  for (const status of ['applied', 'left-open']) {
    const task = start(t);
    const input = save(task, [comment(task, 'node.calculate')]);
    const outcome = { batchId: input.id, commentId: input.comments[0].id, status, summary: '首次处理。', groupIds: ['price-change'] };
    publish(task, 1, nextVersion(fixture(), 2), review(), [outcome]);
    const original = structuredClone(readRevision(task).outcomes[0]);
    assert.equal(pending(task).batches.length, 0);
    publish(task, 2, nextVersion(fixture(), 3), review(), [structuredClone(outcome)]);
    assert.deepEqual(readRevision(task).outcomes[0], original, 'Identical replay must retain the first processing revision');
    const base = readRevision(task).revision;
    rejection(() => publish(task, base, nextVersion(fixture(), 4), review(), [
      { ...outcome, status: 'needs-clarification', summary: '重复调用不应覆盖已经完成的记录。' },
    ]), /已有处理结果|不能覆盖/);
    assert.equal(readRevision(task).revision, base);
    assert.deepEqual(readRevision(task).outcomes[0], original);
  }
});

test('old report references resolve against their original snapshot and reject a different model revision', t => {
  const model = fixture();
  const task = start(t, model);
  const reference = 'pricing-ref:v1 ' + JSON.stringify({ reportId: model.report.id, modelSha256: digest(JSON.stringify(model)), type: 'node', id: 'calculate' });
  publish(task, 1, sourceUpdate(), review());
  assert.equal(resolveReference(readRevision(task, 1).model, reference).object.id, 'calculate');
  rejection(() => resolveReference(readRevision(task).model, reference), /其他版本/);
  assert.equal(readRevision(task).model.nodes.find(node => node.id === 'calculate').id, 'calculate');
});
