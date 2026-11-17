'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createStore } = require('./workbench-store.cjs');
const { createDemoModel } = require('./workbench-demo-fixture.cjs');
const { NODE_FIELDS, validateModel } = require('../../skills/6ak-process-review/scripts/validate-model.cjs');

const qaRoot = path.resolve(__dirname, '../../.qa');
const title = '0.1.4 节点结构编辑合成验收';

function fixture(id) {
  const model = {
    schemaVersion: 1,
    report: { id, title, version: '1', scope: '07 节点结构编辑评审中的独立合成场景', limitations: [] },
    groups: [{ id: 'ops', title: '处理', kind: 'editorial', claimIds: [] }, { id: 'delivery', title: '交付', kind: 'editorial', claimIds: [] }],
    sources: [], claims: [], nodes: [], relations: [], rules: [], issues: [], coverage: [],
    review: { semantic: { status: 'not_run', reviewer: '', notes: [] }, visual: { status: 'not_run', reviewer: '', notes: [] } },
  };
  function source(id, value, kind) {
    const entry = { id, name: id, sha256: createHash('sha256').update(value).digest('hex'), text: value };
    if (kind) entry.kind = kind;
    model.sources.push(entry);
    for (const [index, line] of value.split('\n').entries()) {
      if (line.trim()) model.coverage.push({ sourceId: id, startLine: index + 1, endLine: index + 1, disposition: 'out_of_scope', claimIds: [], issueIds: [], reason: '合成验收初稿尚未采用。' });
    }
    return id;
  }
  function statement(id, text, sourceId, line = 1) {
    return addStatement(model, id, text, sourceId, line);
  }
  function issue(id, question, nodeIds, claimIds = [], type = 'missing') {
    model.issues.push({ id, type, severity: 'major', status: 'open', question, impact: question, claimIds, nodeIds, relationIds: [] });
    for (const claim of model.claims.filter(item => claimIds.includes(item.id))) (claim.issueIds ||= []).push(id);
  }
  return { model, source, statement, issue };
}

function addStatement(model, id, text, sourceId, line = 1) {
  const original = model.sources.find(item => item.id === sourceId);
  const quote = original.text.split('\n')[line - 1];
  model.claims.push({ id, text, origin: 'explicit', evidence: [{ sourceId, startLine: line, endLine: line, quote }] });
  const coverage = model.coverage.find(item => item.sourceId === sourceId && item.startLine === line);
  coverage.disposition = 'represented';
  coverage.reason = '';
  coverage.claimIds.push(id);
  return id;
}

function node(id, title, values, groupId = 'ops') {
  const fields = Object.fromEntries(NODE_FIELDS.map(field => [field, values[field] || []]));
  return { id, title, groupId, fields, claimIds: [...new Set(Object.values(fields).flat())] };
}

function relation(id, from, to, type, claims, conditions = []) {
  return { id, from, to, type, claimIds: claims, conditionClaimIds: conditions };
}

function setup(t, model) {
  fs.mkdirSync(qaRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(qaRoot, 'workbench-014-case-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = validateModel(model);
  assert.equal(result.ok, true, result.errors.join('\n'));
  return { store: createStore(directory, { model }), directory };
}

function atVersion(store, extra = {}) {
  const { workRevision, modelHash } = store.read();
  return { requestId: randomUUID(), baseWorkRevision: workRevision, baseModelHash: modelHash, ...extra };
}

function stage(store, change) {
  const candidate = store.createCandidate({});
  const model = JSON.parse(fs.readFileSync(candidate.modelFile, 'utf8'));
  change(model);
  fs.writeFileSync(candidate.modelFile, JSON.stringify(model));
  return candidate;
}

function review(store, candidate) {
  const result = store.reviewCandidate(candidate.candidateId);
  assert.equal(result.candidateId, candidate.candidateId);
  assert.match(result.reviewHash, /^[a-f0-9]{64}$/);
  assert.ok(result.items.length);
  return result;
}

function apply(store, reviewed) {
  return store.applyCandidate({ candidateId: reviewed.candidateId, reviewHash: reviewed.reviewHash, requestId: randomUUID() });
}

const findNode = (model, id) => model.nodes.find(item => item.id === id);
const conflict = error => error.status === 409 || error.statusCode === 409;

test('07 场景 1：两类报修各自交付，未定的合单细则保留', t => {
  const f = fixture('independent-intake');
  f.source('p12', '平台告警由监控员核对编号并发送告警记录。\n热线报修由客服核对编号并发送报修记录。\n调度每收到一份有效记录即可建单；重复记录并入同一工单。');
  const alert = f.statement('alert-work', '监控员核对编号并交付告警记录。', 'p12');
  const hotline = f.statement('hotline-work', '客服核对编号并交付报修记录。', 'p12', 2);
  const trigger = f.statement('intake-trigger', '收到一份有效记录即可建单；重复记录并入当次工单。', 'p12', 3);
  f.model.nodes.push(node('a', '接收故障线索', { actions: [alert, hotline] }), node('c', '建单派工', { trigger: [trigger] }, 'delivery'));
  f.model.relations.push(relation('a-c', 'a', 'c', 'data', [alert, hotline]));
  f.issue('merge-detail', '去重判据和合单人是谁？', ['c']);
  const { store } = setup(t, f.model);
  const old = atVersion(store);
  const ref = store.createReference({ ...old, targets: [{ type: 'node', id: 'a' }] });
  const candidate = stage(store, model => {
    model.nodes[0] = node('a', '接收监控告警', { actions: [alert] });
    model.nodes.push(node('hotline', '接收热线报修', { actions: [hotline] }));
    model.relations = [relation('a-c', 'a', 'c', 'data', [alert]), relation('hotline-c', 'hotline', 'c', 'data', [hotline])];
  });
  const reviewed = review(store, candidate);
  assert.deepEqual(store.read().model, f.model, 'review is not application');
  assert.throws(() => store.applyCandidate({ candidateId: candidate.candidateId }));
  const committed = apply(store, reviewed);
  assert.deepEqual(committed.model.relations.map(({ from, type }) => [from, type]), [['a', 'data'], ['hotline', 'data']]);
  assert.deepEqual(findNode(committed.model, 'c'), findNode(f.model, 'c'));
  assert.deepEqual(committed.model.issues, f.model.issues);
  assert.deepEqual(committed.model.sources, f.model.sources);
  assert.equal(store.reference(ref.id).stale, true);
  assert.deepEqual(store.reference(ref.id).targetObjects[0].fields.actions, [alert, hotline]);
});

test('07 场景 2：检修阈值可独立补充，复运和返修拓扑保留', t => {
  const f = fixture('inspection-threshold');
  f.source('p4-p9', '所有检修先登记，预计时长拆机后可修订。\n预计停机不超过四小时的检修由班组自检；超过四小时另需安全员复核。\n全部适用检查通过后复运；检查失败返回返修。');
  const register = f.statement('register', '所有检修先登记。', 'p4-p9');
  const inspect = f.statement('inspect', '班组完成自检。', 'p4-p9', 2);
  const activate = f.statement('activate', '全部适用检查通过后才复运。', 'p4-p9', 3);
  const failed = f.statement('failed', '检查失败返回返修。', 'p4-p9', 3);
  f.model.nodes.push(node('d', '登记', { actions: [register] }), node('a', '检查', { actions: [inspect] }), node('c', '复运', { trigger: [activate] }, 'delivery'), node('r', '返修', { trigger: [failed] }));
  f.model.relations.push(relation('d-a', 'd', 'a', 'sequence', [register]), relation('a-c', 'a', 'c', 'sequence', [activate]), relation('a-r', 'a', 'r', 'return', [failed]));
  f.issue('after-rework', '返修后重做哪些检查？', ['a', 'r']);
  f.issue('estimate-stage', '时长判定时点及跨阈值补检如何处理？', ['a']);
  const { store } = setup(t, f.model);
  const candidate = stage(store, model => {
    const rule = addStatement(model, 'inspection-limit', '预计停机不超过四小时做自检，超过四小时另需安全员复核。', 'p4-p9', 2);
    findNode(model, 'a').fields.rules.push(rule);
    findNode(model, 'a').claimIds.push(rule);
  });
  const reviewed = review(store, candidate);
  assert.ok(reviewed.items.every(item => item.type !== 'relation'));
  const next = apply(store, reviewed);
  assert.deepEqual(next.model.relations, f.model.relations);
  assert.deepEqual(next.model.issues, f.model.issues);
  assert.deepEqual(findNode(next.model, 'a').fields.rules, ['inspection-limit']);
});

test('07 场景 3：插一步只改选定顺序线，签发迁移仍需独立核对', async t => {
  const f = fixture('lab-report');
  f.source('manual', '检验员完成检测并录入，授权签字人复核签发。\n客服收到正式报告后通知委托方。\n交付检测记录与正式报告归档。');
  const recorded = f.statement('recorded', '完成检测并录入。', 'manual');
  const signed = f.statement('signed', '授权签字人复核签发。', 'manual');
  const notified = f.statement('notified', '收到正式报告后通知。', 'manual', 2);
  const archived = f.statement('archived', '交付检测记录与正式报告归档。', 'manual', 3);
  f.model.nodes.push(node('a', '检测及出具报告', { actions: [recorded, signed] }), node('c', '通知委托方', { input: [notified] }, 'delivery'), node('d', '归档', { input: [archived] }, 'delivery'));
  f.model.relations.push(relation('a-c', 'a', 'c', 'sequence', [notified]), relation('a-d', 'a', 'd', 'data', [archived]));
  f.issue('report-delivery', '拆分后哪一步交付正式报告用于归档？', ['a', 'd']);
  const { store } = setup(t, f.model);
  const newNode = { title: '复核签发', groupId: 'ops', fields: { role: '授权签字人' } };
  const draft = atVersion(store, { operation: { type: 'insert-step', relationId: 'a-c', node: newNode } });
  assert.throws(() => store.previewStructureEdit({ ...draft, operation: { ...draft.operation, relationId: 'a-d' } }));
  assert.throws(() => store.previewStructureEdit({ ...draft, operation: { ...draft.operation, updates: [{ nodeId: 'a', claimId: signed, text: '签发已迁移。' }] } }));
  const preview = store.previewStructureEdit(draft);
  assert.ok(preview.nodeId);
  assert.ok(preview.items.some(item => item.type === 'relation'));
  assert.deepEqual(store.read().model, f.model);
  const { formatPresetHandoff } = await import('../shared/workbench-presets.mjs');
  const ref = store.createReference({ ...draft, targets: [{ type: 'node', id: 'a' }, { type: 'relation', id: 'a-c' }] });
  const handoff = formatPresetHandoff({ presetId: 'split-steps', reference: ref.handoff, draft: newNode.title });
  assert.match(handoff, /先给出候选差异/);
  assert.match(handoff, /未保存草稿[\s\S]+复核签发/);
  assert.deepEqual(store.read().model.relations, f.model.relations);
  assert.deepEqual(findNode(store.read().model, 'a').fields.actions, [recorded, signed]);
});

test('07 场景 4：过期拆分复用已手动插入的 N，撤销后 N 仍存在', t => {
  const f = fixture('refund-reuse');
  f.source('refund', '运营核对退款依据，审核通过后提交财务付款。\n依据不足退回客服补件。\n财务收到运营提交的已审核申请后开始付款。');
  const check = f.statement('check', '核对退款依据。', 'refund');
  const submit = f.statement('submit', '审核通过后提交财务付款。', 'refund');
  const finance = f.statement('finance', '收到运营提交的已审核申请后开始。', 'refund', 3);
  const missing = f.statement('missing', '依据不足退回客服补件。', 'refund', 2);
  f.model.nodes.push(node('a', '审核并提交退款', { actions: [check, submit] }), node('c', '财务付款', { trigger: [finance] }, 'delivery'), node('b', '客服补件', { trigger: [missing] }));
  f.model.relations.push(relation('a-c', 'a', 'c', 'sequence', [submit]), relation('a-b', 'a', 'b', 'return', [missing]));
  const { store } = setup(t, f.model);
  store.saveBuffer({ sessionId: 'case', nodeId: 'a', revision: 1, draft: { text: '提交前由组长复核大额退款' } });
  const old = stage(store, model => { model.nodes.push(node('old-n', '提交退款申请', { actions: [submit] })); });
  const oldReview = review(store, old);
  const insertion = atVersion(store, { operation: { type: 'insert-step', relationId: 'a-c', node: { title: '提交退款申请', groupId: 'ops' } } });
  const { nodeId } = store.previewStructureEdit(insertion);
  const manuallySaved = store.structureEdit(insertion);
  assert.ok(findNode(manuallySaved.model, nodeId));
  assert.throws(() => apply(store, oldReview), conflict);
  const revised = stage(store, model => {
    const a = findNode(model, 'a'), n = findNode(model, nodeId);
    a.fields.actions = [check];
    a.claimIds = [check];
    n.fields.actions.push(submit);
    n.claimIds.push(submit);
  });
  const next = apply(store, review(store, revised));
  assert.equal(next.model.nodes.filter(n => n.title === '提交退款申请').length, 1);
  assert.deepEqual(next.model.relations, manuallySaved.model.relations);
  assert.equal(next.model.relations.find(r => r.id === 'a-b').from, 'a');
  assert.equal(store.buffers('case').a.draft.text, '提交前由组长复核大额退款');
  assert.deepEqual(store.undo(atVersion(store)).model, manuallySaved.model);
});

function repairFixture(id) {
  const f = fixture(id);
  f.source('s1', '维修员检查后出具报告。\n完成后归档。');
  f.source('u1', '班长复核后出具报告。', 'user-feedback');
  f.source('s2', '报告须附设备编号及测量记录。');
  const original = f.statement('original', '维修员检查后出具报告。', 's1');
  const revised = f.statement('current', '班长复核后出具报告。', 'u1');
  const archive = f.statement('archive', '完成后归档。', 's1', 2);
  f.model.nodes.push(node('report', '检修报告', { actions: [original, revised] }), node('archive', '归档', { actions: [archive] }, 'delivery'));
  f.issue('report-owner', '如何核对两种报告职责？', ['report'], [original, revised], 'conflict');
  f.issue('review-failed', '复核不通过如何处理？', ['report']);
  return f;
}

function addAttachment(model) {
  const id = addStatement(model, 'attachment', '报告须附设备编号及测量记录。', 's2');
  findNode(model, 'report').fields.output.push(id);
  findNode(model, 'report').claimIds.push(id);
}

test('07 场景 5：旧候选及确认不能覆盖 W13，包括无关修改', async t => {
  for (const target of ['report', 'archive']) {
    await t.test(target, sub => {
      const f = repairFixture(`repair-${target}`);
      const { store } = setup(sub, f.model);
      const buffer = { text: '紧急维修由值班班长复核' };
      store.saveBuffer({ sessionId: 'case', nodeId: 'report', revision: 1, draft: buffer });
      const old = stage(store, addAttachment);
      const oldReview = review(store, old);
      const newTitle = target === 'report' ? '设备维修记录' : '保存归档记录';
      const latest = store.edit(atVersion(store, { nodeId: target, title: newTitle, intent: 'current' }));
      assert.throws(() => apply(store, oldReview), conflict);
      assert.ok(fs.existsSync(old.modelFile));
      const revised = stage(store, addAttachment);
      const fresh = review(store, revised);
      assert.equal(fresh.baseWorkRevision, latest.workRevision);
      assert.notEqual(fresh.reviewHash, oldReview.reviewHash);
      const next = apply(store, fresh);
      assert.equal(findNode(next.model, target).title, newTitle);
      assert.deepEqual(findNode(next.model, 'report').fields.output, ['attachment']);
      assert.deepEqual(next.model.issues, f.model.issues);
      assert.deepEqual(next.model.sources.slice(0, f.model.sources.length), f.model.sources);
      assert.deepEqual(store.buffers('case').report.draft, buffer);
    });
  }
});

function returnFixture(id) {
  const f = fixture(id);
  f.source('original', '客服审核退货。\n财务登记退货到账。\n物流负责退件登记。');
  f.source('user', '仓库核验实物后决定是否入库。', 'user-feedback');
  f.source('quantity', '入库后把实收数量回传财务。');
  const service = f.statement('service', '客服审核退货。', 'original');
  const warehouse = f.statement('warehouse', '仓库核验实物后决定是否入库。', 'user');
  const finance = f.statement('finance', '财务登记退货到账。', 'original', 2);
  const logistics = f.statement('logistics', '物流负责退件登记。', 'original', 3);
  f.model.nodes.push(node('warehouse', '退货入库', { actions: [service, warehouse] }), node('finance', '财务记录', { actions: [finance] }, 'delivery'), node('logistics', '登记退件', { actions: [logistics] }));
  f.issue('return-owner', '客服与仓库分别有何决定权限？', ['warehouse'], [service, warehouse], 'conflict');
  return f;
}

function addQuantityHandoff(model) {
  const id = addStatement(model, 'quantity-handoff', '入库后把实收数量回传财务。', 'quantity');
  findNode(model, 'warehouse').claimIds.push(id);
  findNode(model, 'warehouse').fields.output.push(id);
  findNode(model, 'finance').claimIds.push(id);
  findNode(model, 'finance').fields.input.push(id);
  model.relations.push(relation('warehouse-finance', 'warehouse', 'finance', 'data', [id]));
}

test('07 场景 6：撤回实收数量整批修改，保留布局、草稿和后续独立提交', async t => {
  for (const laterContent of [false, true]) {
    await t.test(laterContent ? '反向候选保留 T22' : '最新事务整次撤销', sub => {
      const f = returnFixture(laterContent ? 'return-reverse' : 'return-undo');
      const { store } = setup(sub, f.model);
      const committed = apply(store, review(store, stage(store, addQuantityHandoff)));
      const transactionId = committed.changes[0].id;
      const positions = { warehouse: { x: 100, y: 250 }, finance: { x: 420, y: 250 } };
      store.updateView({ positions });
      const unsaved = { text: '破损件拍照并记录箱号' };
      store.saveBuffer({ sessionId: 'case', nodeId: 'warehouse', revision: 2, draft: unsaved });
      let result;
      if (laterContent) {
        store.edit(atVersion(store, { nodeId: 'logistics', title: '物流专员登记退件', intent: 'current' }));
        const reverse = store.createRevertCandidate({ transactionId });
        assert.ok(store.read().model.relations.some(rel => rel.id === 'warehouse-finance'));
        result = apply(store, review(store, reverse));
        assert.equal(findNode(result.model, 'logistics').title, '物流专员登记退件');
      } else {
        result = store.undo(atVersion(store));
        assert.deepEqual(result.model, f.model);
      }
      assert.ok(result.workRevision > committed.workRevision);
      assert.deepEqual(findNode(result.model, 'warehouse'), findNode(f.model, 'warehouse'));
      assert.deepEqual(findNode(result.model, 'finance'), findNode(f.model, 'finance'));
      assert.deepEqual(result.model.relations, f.model.relations);
      assert.deepEqual(result.model.issues, f.model.issues);
      assert.deepEqual(result.view.positions, positions);
      assert.deepEqual(store.buffers('case').warehouse.draft, unsaved);
    });
  }
});

test('手动新增、接线和改接的预览与保存使用同一结构操作', t => {
  const { store } = setup(t, createDemoModel());
  const add = atVersion(store, { operation: { type: 'add-node', node: { title: '复核工单', groupId: 'prepare', fields: { actions: '运营复核工单信息。' } } } });
  const addition = store.previewStructureEdit(add);
  assert.equal(findNode(store.read().model, addition.nodeId), undefined);
  const added = store.structureEdit(add);
  assert.equal(findNode(added.model, addition.nodeId).title, '复核工单');
  assert.equal(store.structureEdit(add).workRevision, added.workRevision);
  const join = atVersion(store, { operation: { type: 'connect', relation: { from: addition.nodeId, to: 'validate', type: 'conditional', description: '复核通过后提交校验。', condition: '已通过复核' } } });
  const edge = store.previewStructureEdit(join);
  const joined = store.structureEdit(join);
  assert.equal(joined.model.relations.find(rel => rel.id === edge.relationId).to, 'validate');
  const reconnect = atVersion(store, { operation: { type: 'connect', relation: { id: edge.relationId, from: addition.nodeId, to: 'calculate', type: 'sequence', description: '复核完成后交给测算。' } } });
  const next = store.structureEdit(reconnect);
  const reconnected = next.model.relations.find(rel => rel.id === edge.relationId);
  assert.equal(reconnected.to, 'calculate');
  assert.deepEqual(reconnected.conditionClaimIds, []);
  assert.deepEqual(store.undo(atVersion(store)).model, joined.model);
});

test('三个预设保留引用，草稿只在明确提供时加入，候选变更必须重审', async t => {
  const { PRESETS, formatPresetHandoff } = await import('../shared/workbench-presets.mjs');
  const { store } = setup(t, createDemoModel());
  const ref = store.createReference({ ...atVersion(store), targets: [{ type: 'node', id: 'validate' }] });
  assert.deepEqual(PRESETS.map(preset => preset.id), ['split-by-condition', 'split-steps', 'enrich-from-source']);
  for (const { id, label } of PRESETS) {
    const handoff = formatPresetHandoff({ presetId: id, reference: ref.handoff });
    assert.ok(handoff.startsWith(label));
    assert.ok(handoff.includes(ref.handoff));
    assert.doesNotMatch(handoff, /我主动附上的未保存草稿/);
  }
  const candidate = stage(store, model => { findNode(model, 'validate').title = '所见候选'; });
  const staged = review(store, candidate);
  const changed = JSON.parse(fs.readFileSync(candidate.modelFile, 'utf8'));
  findNode(changed, 'validate').title = '确认后又被更改';
  fs.writeFileSync(candidate.modelFile, JSON.stringify(changed));
  assert.throws(() => apply(store, staged), conflict);
  assert.notEqual(findNode(store.read().model, 'validate').title, '确认后又被更改');
});

test('已确认的任务先于预设说明，处理范围与引用材料分别交接', async t => {
  const { buildPresetTask, formatPresetHandoff } = await import('../shared/workbench-presets.mjs');
  const model = createDemoModel();
  const { store } = setup(t, model);
  const processing = { type: 'node', id: 'validate', label: '校验降幅' };
  const anchor = { type: 'relation', id: 'manual--validate', label: '单条录入 → 校验降幅' };
  const processingTargets = [processing];
  const referenceTargets = [anchor];
  const seed = buildPresetTask({ presetId: 'split-steps', processingTargets, referenceTargets });
  assert.match(seed, /核对「校验降幅」/);
  assert.doesNotMatch(seed, /单条录入/);

  const claimId = findNode(model, 'validate').fields.actions[0];
  const claim = model.claims.find(item => item.id === claimId);
  const quote = { claimId, text: claim.text.slice(0, 8), sourceLabel: '验收资料 · 第 4 行' };
  const selected = store.createReference(atVersion(store, {
    targets: [processing, anchor, { type: 'claim', id: claimId }], selection: { claimId, text: quote.text },
  }));
  const task = '请核对校验和审批能否独立。\n只列建议，别调整旧连线。';
  const draft = '审批人还未确认。\n第二行保留。';
  const handoff = formatPresetHandoff({ presetId: 'split-steps', reference: selected.handoff, task, draft,
    processingTargets, referenceTargets: [processing, anchor], quote });
  const [first, scope, materials] = handoff.split('\n\n');
  assert.equal(first, task);
  assert.match(scope, /^拟处理对象\n- 节点 "校验降幅"（node validate）$/);
  assert.match(materials, /^参考材料\n- 连线 "单条录入 → 校验降幅"（relation manual--validate）/);
  assert.ok(materials.includes(`选中的原句（陈述 ${claimId}，${quote.sourceLabel}）：${JSON.stringify(quote.text)}`));
  assert.ok(materials.includes(JSON.stringify(draft)));
  assert.doesNotMatch(materials, /引用原文：/);
  assert.ok(materials.includes(selected.handoff.split('\n').at(-1)));
  assert.match(handoff, /参考材料及版本化引用用于定位和核对，不能自动扩大修改范围/);
  assert.match(handoff, /等我明确确认应用所见候选后/);
  assert.deepEqual(store.read().model, model);
});

test('未指定处理对象的预设只给定位任务，未附草稿时不加入材料', async t => {
  const { PRESETS, STRUCTURE_PRESETS, buildPresetTask, formatPresetHandoff } = await import('../shared/workbench-presets.mjs');
  const model = createDemoModel();
  const { store } = setup(t, model);
  const anchor = { type: 'node', id: 'validate', label: '校验降幅' };
  const reference = store.createReference(atVersion(store, { targets: [anchor] }));
  for (const { id: presetId } of [...PRESETS, ...STRUCTURE_PRESETS]) {
    const task = buildPresetTask({ presetId, referenceTargets: [anchor] });
    assert.match(task, /^请参考「校验降幅」和原文，先核对涉及的对象/);
    assert.match(buildPresetTask({ presetId }), /^请查阅本任务原文，先核对涉及的对象/);
    const handoff = formatPresetHandoff({ presetId, reference: reference.handoff, task, referenceTargets: [anchor] });
    assert.match(handoff, /拟处理对象\n按任务描述定位。范围不明时先核对并提出建议。/);
    assert.match(handoff, /参考材料\n- 节点 "校验降幅"（node validate）/);
    assert.doesNotMatch(handoff, /我主动附上的未保存草稿/);
  }
  assert.throws(() => formatPresetHandoff({ presetId: 'split-steps', reference: reference.handoff, task: '  ' }), /一条要交给 Agent 的任务/);
});

test('连线交接只处理所选关系，两端节点供核对，改接需验证新端点影响', async t => {
  const { buildPresetTask, formatPresetHandoff } = await import('../shared/workbench-presets.mjs');
  const model = createDemoModel();
  const { store } = setup(t, model);
  const processingTargets = [{ type: 'relation', id: 'manual--validate', label: '单条录入 → 校验降幅' }];
  const referenceTargets = [
    { type: 'node', id: 'manual', label: '单条录入' },
    { type: 'node', id: 'validate', label: '校验降幅' },
  ];
  const reference = store.createReference(atVersion(store, { targets: [...processingTargets, ...referenceTargets] }));
  const selection = { presetId: 'revise-connections', processingTargets, referenceTargets };
  const task = buildPresetTask(selection);
  assert.match(task, /单列确需联动修订的节点字段/);
  const handoff = formatPresetHandoff({ ...selection, reference: reference.handoff, task });
  const [, processing, materials] = handoff.split('\n\n');
  assert.match(processing, /^拟处理对象\n- 连线 "单条录入 → 校验降幅"（relation manual--validate）$/);
  assert.match(materials, /^参考材料\n- 节点 "单条录入"（node manual）\n- 节点 "校验降幅"（node validate）/);
  assert.deepEqual(reference.targets.map(({ type, id }) => [type, id]), [['relation', 'manual--validate'], ['node', 'manual'], ['node', 'validate']]);
  assert.match(handoff, /读取新端点的最新内容和相关流转，核对新旧端点的实际影响/);
  assert.match(handoff, /把确需联动修改的节点字段与连线改动分开列进候选，逐项写明修改前后、理由和依据/);
  assert.deepEqual(store.read().model, model);
});

test('Agent 分别起草新节点与连线，连线候选绑定独立确认的版本', async t => {
  const { STRUCTURE_PRESETS, formatPresetHandoff } = await import('../shared/workbench-presets.mjs');
  assert.deepEqual(STRUCTURE_PRESETS.map(preset => preset.id), ['propose-node', 'revise-connections']);
  const f = fixture('agent-node-then-relation');
  f.source('guide', '仓库登记收货单，登记后由财务核对。\n质检员填写复检记录。');
  f.source('follow-up', '复检记录交付财务核对。', 'user-feedback');
  const record = f.statement('receipt-record', '仓库登记收货单。', 'guide');
  const verify = f.statement('finance-check', '登记后由财务核对。', 'guide');
  f.model.nodes.push(node('receipt', '登记收货单', { actions: [record] }), node('finance', '财务核对', { actions: [verify] }, 'delivery'));
  f.model.relations.push(relation('receipt-finance', 'receipt', 'finance', 'sequence', [verify]));
  const { store } = setup(t, f.model);

  const pathReference = store.createReference(atVersion(store, { targets: [{ type: 'relation', id: 'receipt-finance' }] }));
  const addRequest = formatPresetHandoff({ presetId: 'propose-node', reference: pathReference.handoff });
  assert.match(addRequest, /^起草新节点/);
  assert.ok(addRequest.includes(pathReference.handoff));
  assert.match(addRequest, /衔接尚未确认时，单独起草节点/);
  assert.match(addRequest, /明确要求在选中的无条件顺序线上补一步且顺序有依据/);
  const addition = stage(store, model => {
    const check = addStatement(model, 'quality-check', '质检员填写复检记录。', 'guide', 2);
    model.nodes.push(node('recheck', '填写复检记录', { actions: [check] }));
    model.issues.push({ id: 'recheck-route', type: 'missing', severity: 'minor', status: 'open', question: '复检记录应交给谁？', impact: '复检后的衔接待确认。', claimIds: [], nodeIds: ['recheck'], relationIds: [] });
  });
  const additionReview = review(store, addition);
  assert.ok(additionReview.items.some(item => item.type === 'node' && item.id === 'recheck'));
  assert.ok(additionReview.items.every(item => item.type !== 'relation'));
  assert.deepEqual(store.read().model, f.model);
  const added = apply(store, additionReview);
  assert.deepEqual(added.model.relations, f.model.relations);
  assert.equal(added.model.issues[0].status, 'open');

  const nodeReference = store.createReference(atVersion(store, { targets: [{ type: 'node', id: 'recheck' }] }));
  const connectRequest = formatPresetHandoff({ presetId: 'revise-connections', reference: nodeReference.handoff });
  assert.match(connectRequest, /^调整连线/);
  assert.ok(connectRequest.includes(nodeReference.handoff));
  assert.match(connectRequest, /明确要求增加活动时才把新节点纳入候选/);
  assert.match(connectRequest, /reviewHash/);
  function draftConnection(model) {
    const handoff = addStatement(model, 'recheck-handoff', '复检记录交付财务核对。', 'follow-up');
    model.relations.push(relation('recheck-finance', 'recheck', 'finance', 'data', [handoff]));
    const issue = model.issues.find(item => item.id === 'recheck-route');
    issue.status = 'resolved';
    issue.claimIds.push(handoff);
    issue.relationIds.push('recheck-finance');
    issue.resolutionClaimIds = [handoff];
  }
  const oldReview = review(store, stage(store, draftConnection));
  const corrected = store.edit(atVersion(store, { nodeId: 'finance', title: '财务复核', intent: 'current' }));
  assert.throws(() => apply(store, oldReview), conflict);
  const updatedReview = review(store, stage(store, draftConnection));
  assert.equal(updatedReview.baseWorkRevision, corrected.workRevision);
  assert.notEqual(updatedReview.reviewHash, oldReview.reviewHash);
  assert.ok(updatedReview.items.every(item => item.type !== 'node'));
  const connected = apply(store, updatedReview);
  assert.deepEqual(connected.model.nodes, corrected.model.nodes);
  assert.deepEqual(connected.model.relations, [...f.model.relations, relation('recheck-finance', 'recheck', 'finance', 'data', ['recheck-handoff'])]);
  assert.equal(connected.model.issues[0].status, 'resolved');
  assert.deepEqual(store.undo(atVersion(store)).model, corrected.model);
});

test('直接修订文案拒绝结构变动，保留本节点以前保存的结构建议', async t => {
  for (const [description, change] of [
    ['分组调整', { groupId: 'prepare' }],
    ['连线去向', { branches: [{ id: 'validate--dispatch', to: 'calculate' }] }],
  ]) {
    await t.test(description, sub => {
      const { store } = setup(sub, createDemoModel());
      const edit = (input) => store.edit(atVersion(store, { nodeId: 'validate', ...input }));
      const legacy = edit({ intent: 'proposal', ...change });
      const previousProposal = legacy.pendingEdits[0];
      assert.throws(() => edit({ scope: 'copy', intent: 'current', ...change }), /交给 Agent/);
      assert.throws(() => edit({ scope: 'copy', intent: 'proposal', ...change }), /交给 Agent/);
      assert.deepEqual(store.read(), legacy);

      const corrected = edit({ scope: 'copy', intent: 'current', title: '检查并校验' });
      assert.deepEqual(corrected.pendingEdits, [previousProposal]);
      assert.equal(findNode(corrected.model, 'validate').groupId, findNode(legacy.model, 'validate').groupId);
      assert.deepEqual(corrected.model.relations, legacy.model.relations);

      edit({ scope: 'copy', intent: 'proposal', title: '第一份文案建议' });
      const replaced = edit({ scope: 'copy', intent: 'proposal', title: '第二份文案建议' });
      assert.equal(replaced.pendingEdits.length, 2);
      assert.deepEqual(replaced.pendingEdits[0], previousProposal);
      assert.equal(replaced.pendingEdits[1].input.title, '第二份文案建议');
      assert.deepEqual(edit({ scope: 'copy', intent: 'current', title: '按要求检查' }).pendingEdits, [previousProposal]);
    });
  }
});

test('旧版待定文案携带原去向时仍可由新的文案建议替换', t => {
  const { store } = setup(t, createDemoModel());
  const nodeId = 'validate';
  store.edit(atVersion(store, { nodeId, intent: 'proposal', branches: [{ id: 'validate--dispatch', to: 'dispatch',
    conditions: [{ id: 'validate--dispatch-condition', text: '降幅不超过 30%' }] }] }));
  const latest = store.edit(atVersion(store, { nodeId, scope: 'copy', intent: 'proposal', title: '核对降幅' }));
  assert.equal(latest.pendingEdits.length, 1);
  assert.equal(latest.pendingEdits[0].input.title, '核对降幅');
});
