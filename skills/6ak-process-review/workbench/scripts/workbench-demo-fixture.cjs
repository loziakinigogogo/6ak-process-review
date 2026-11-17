'use strict';

const { createHash } = require('node:crypto');
const { NODE_FIELDS, RULE_FIELDS } = require('../../scripts/validate-model.cjs');

// All facts below are deliberately synthetic. They exercise the editor without
// importing an actual business project's documents, feedback, or task history.
function createDemoModel() {
  const sourceId = 'demo-guide';
  const lines = [
    '调价与生效核验 · 合成演示资料',
    '本资料由工具开发者构造，仅用于测试流程图、编辑与保存；不代表 Amazon 或任何组织的真实规则。',
  ];
  const model = {
    schemaVersion: 1,
    report: {
      id: 'pricing-workbench-demo', title: '调价与生效核验', version: '1',
      scope: '演示从调价需求、录入和审批到平台生效核验的工作过程。',
      limitations: [
        '合成演示资料；所有角色、阈值与流程均不代表真实业务规定。',
        '平台失败后的重试办法，以及价格不一致时的暂停规则，故意保留为待确认项。',
        '三个分组用于阅读组织，其排列不自动构成业务时序。',
      ],
    },
    sources: [], claims: [],
    groups: [
      { id: 'prepare', title: '需求与测算', kind: 'editorial', claimIds: [] },
      { id: 'execute', title: '录入与审批', kind: 'editorial', claimIds: [] },
      { id: 'verify', title: '生效与跟踪', kind: 'editorial', claimIds: [] },
    ],
    nodes: [], relations: [], rules: [], issues: [],
    coverage: [
      { sourceId, startLine: 1, endLine: 2, disposition: 'out_of_scope', claimIds: [], issueIds: [], reason: '标题与演示用途声明，不构成业务执行步骤。' },
    ],
    review: {
      semantic: { status: 'not_run', reviewer: '', notes: ['合成数据用于功能验证；业务有效性不作声明。'] },
      visual: { status: 'not_run', reviewer: '', notes: [] },
    },
  };
  function evidence(line) {
    return { sourceId, startLine: line, endLine: line, quote: lines[line - 1] };
  }
  function statement(id, text, sourceText = text, extra = {}) {
    lines.push(sourceText);
    const line = lines.length;
    model.claims.push({ id, text, origin: 'explicit', evidence: [evidence(line)], ...extra });
    model.coverage.push({ sourceId, startLine: line, endLine: line, disposition: 'represented', claimIds: [id], issueIds: [], reason: '' });
    return id;
  }
  function node(id, title, groupId, values) {
    const fields = Object.fromEntries(NODE_FIELDS.map(field => [field, []]));
    const claimIds = [];
    for (const [field, text] of Object.entries(values)) {
      if (!text) continue;
      const cid = statement(id + '-' + field, text, title + '｜' + text);
      fields[field].push(cid);
      claimIds.push(cid);
    }
    const result = { id, groupId, title, claimIds, fields };
    model.nodes.push(result);
    return result;
  }
  function relation(id, from, to, type, sourceText, conditionText) {
    const cid = statement(id + '-flow', sourceText);
    const claimIds = [cid], conditionClaimIds = [];
    if (conditionText) {
      const conditionId = id + '-condition';
      model.claims.push({ id: conditionId, text: conditionText, origin: 'explicit', evidence: [evidence(lines.length)] });
      model.coverage.at(-1).claimIds.push(conditionId);
      claimIds.push(conditionId);
      conditionClaimIds.push(conditionId);
    }
    model.relations.push({ id, from, to, type, claimIds, conditionClaimIds });
  }
  function missing(id, question, impact, ownerId, text) {
    const cid = statement(id + '-unknown', text, text, { origin: 'unknown', issueIds: [id] });
    const owner = model.nodes.find(item => item.id === ownerId);
    owner.claimIds.push(cid);
    owner.fields.rules.push(cid);
    model.issues.push({ id, type: 'missing', severity: 'major', status: 'open', question, impact, claimIds: [cid], nodeIds: [ownerId], relationIds: [] });
    model.coverage.at(-1).disposition = 'issue';
    model.coverage.at(-1).issueIds.push(id);
  }

  node('demand', '记录调价需求', 'prepare', {
    role: '运营专员', system: '调价台账', trigger: '收到商品调价需求。',
    input: '商品编号、当前售价和调价原因。',
    actions: '记录本次调价的商品范围与期望生效时间。', output: '一条可追踪的调价任务。',
  });
  node('calculate', '测算目标售价', 'prepare', {
    role: '运营专员', system: '测算表', trigger: '调价任务已记录。',
    input: '当前售价、成本、费用与预期利润。',
    actions: '计算目标售价；本示例以当前售价为基准计算降幅。',
    output: '目标售价与降幅。', rules: '降幅＝（当前售价－目标售价）÷当前售价；当前售价必须大于零。',
  });
  node('manual', '单条录入', 'execute', {
    role: '运营专员', system: '调价后台', trigger: '选择单条录入通道。',
    input: '一个商品的目标售价与降幅。',
    actions: '在后台填写商品编号、目标售价与生效时间。', output: '待校验的单条调价记录。',
  });
  node('import', '文件导入', 'execute', {
    role: '运营专员', system: '调价后台', trigger: '选择文件导入通道。',
    input: '按模板整理的商品调价表。',
    actions: '上传调价表并核对导入结果中的商品编号与价格。', output: '待校验的批量调价记录。',
  });
  node('validate', '校验降幅', 'execute', {
    role: '调价系统', system: '调价后台', trigger: '单条录入或文件导入完成，任一通道均可进入校验。',
    input: '目标售价、当前售价与计算出的降幅。',
    actions: '检查价格字段是否有效，并根据降幅决定是否需要审批。',
    output: '校验结果与后续处理路径。',
    rules: '按出口条件选择后续路径，等号边界以各出口的条件原句为准。',
  });
  node('approval', '主管审批', 'execute', {
    role: '运营主管', system: '审批工作台', trigger: '校验结果要求进入主管审批。',
    input: '目标售价、降幅与调价原因。',
    actions: '核对调价原因与目标价格，选择通过或退回并记录说明。',
    output: '通过或退回的审批记录。',
  });
  node('recalculate', '重新测算', 'execute', {
    role: '运营专员', system: '测算表', trigger: '主管退回本次调价。',
    input: '退回说明与原测算记录。', actions: '根据退回说明修订目标售价与降幅。',
    output: '修订后的单条调价资料。',
  });
  node('dispatch', '异步下发', 'execute', {
    role: '调价系统', system: '下发队列', trigger: '校验无需审批，或审批已经通过。',
    input: '可执行的调价记录。', actions: '把调价请求提交到平台接口，并保存请求编号。',
    output: '请求编号与待处理状态。', rules: '请求提交不等于前台售价已经生效。',
  });
  node('platform-wait', '等待平台回执', 'execute', {
    role: '调价系统', system: '平台接口', trigger: '请求已提交。', input: '请求编号。',
    actions: '查询平台回执，区分成功、失败与仍在处理中。', output: '平台回执状态。',
    rules: '仍在处理中时继续等待，不宣称生效。',
  });
  node('verify-front', '核验前台价格', 'verify', {
    role: '运营专员', system: '商品前台', trigger: '平台返回处理成功。',
    input: '目标售价、商品链接和成功回执。', actions: '打开商品页面，比较展示价与目标售价。',
    output: '价格一致或不一致的核验记录。',
  });
  node('reconcile', '记录价格差异', 'verify', {
    role: '运营专员', system: '调价台账', trigger: '前台展示价与目标售价不一致。',
    input: '展示价、目标售价、回执和截图。', actions: '记录差异并把核验信息反馈给测算人员。',
    output: '一条待处理的价格差异记录。',
  });
  node('archive', '完成并留档', 'verify', {
    role: '运营专员', system: '调价台账', trigger: '前台展示价与目标售价一致。',
    input: '一致的核验记录。', actions: '记录完成时间与实际生效售价。', output: '本次调价的完成记录。',
  });
  node('monitor', '日终抽查', 'verify', {
    role: '值班运营', system: '商品前台', trigger: '每个工作日结束前。',
    input: '当天调价台账。', actions: '独立抽查当天已调价商品的展示价。',
    output: '日终抽查记录。', rules: '日终抽查是独立计划，不作为每笔调价完成的前置步骤。',
  });
  node('failure', '记录平台失败', 'verify', {
    role: '运营专员', system: '调价台账', trigger: '平台返回处理失败。',
    input: '失败回执与请求编号。', actions: '保留失败原因并标记该调价尚未完成。',
    output: '失败记录与待处理任务。',
  });

  relation('demand--calculate', 'demand', 'calculate', 'sequence', '调价需求记录完成后，由运营专员测算目标售价。');
  relation('calculate--manual', 'calculate', 'manual', 'conditional', '测算完成且选择单条录入时，进入单条录入；两种录入通道任选其一。', '选择单条录入');
  relation('calculate--import', 'calculate', 'import', 'conditional', '测算完成且选择文件导入时，进入文件导入；两种录入通道任选其一。', '选择文件导入');
  relation('manual--validate', 'manual', 'validate', 'sequence', '单条录入完成后进入校验降幅，无需等待文件导入。');
  relation('import--validate', 'import', 'validate', 'sequence', '文件导入完成后进入校验降幅，无需等待单条录入。');
  relation('validate--dispatch', 'validate', 'dispatch', 'conditional', '校验通过且降幅 ≤ 30% 时，直接进入异步下发。', '降幅 ≤ 30%');
  relation('validate--approval', 'validate', 'approval', 'conditional', '校验通过且降幅 > 30% 时，进入主管审批。', '降幅 > 30%');
  relation('approval--dispatch', 'approval', 'dispatch', 'conditional', '主管审批通过后进入异步下发。', '审批通过');
  relation('approval--recalculate', 'approval', 'recalculate', 'conditional', '主管审批退回后，由运营专员重新测算。', '审批退回');
  relation('recalculate--manual', 'recalculate', 'manual', 'return', '重新测算完成后返回单条录入，沿原校验路径重新处理。');
  relation('dispatch--platform-wait', 'dispatch', 'platform-wait', 'sequence', '异步下发提交请求后，进入等待平台回执。');
  relation('platform-wait--verify-front', 'platform-wait', 'verify-front', 'conditional', '平台回执为处理成功时，进入前台价格核验。', '平台处理成功');
  relation('platform-wait--failure', 'platform-wait', 'failure', 'conditional', '平台回执为处理失败时，进入记录平台失败。', '平台处理失败');
  relation('verify-front--archive', 'verify-front', 'archive', 'conditional', '核验发现展示价与目标售价一致时，完成并留档。', '价格一致');
  relation('verify-front--reconcile', 'verify-front', 'reconcile', 'conditional', '核验发现展示价与目标售价不一致时，记录价格差异。', '价格不一致');
  relation('reconcile--calculate', 'reconcile', 'calculate', 'data', '价格差异记录向测算人员提供核验信息；此数据反馈不自动发起新一轮测算。');
  relation('monitor--verify-front', 'monitor', 'verify-front', 'association', '日终抽查与前台核验使用相同的商品展示价信息，但二者不存在固定的执行先后。');

  const ruleClaim = statement('positive-base-price', '计算降幅时，作为分母的当前售价必须大于零。');
  model.rules.push({
    id: 'valid-base-price', title: '降幅计算前提', claimIds: [ruleClaim],
    parameters: Object.fromEntries(RULE_FIELDS.map(field => [field, field === 'basis' ? [ruleClaim] : []])),
  });
  missing('retry-policy', '平台处理失败后，由谁决定重试，最多重试几次？', '失败记录之后的处理仍需明确，不能自动补出重试回路。', 'failure', '本演示资料未说明平台失败后的重试次数、间隔与升级负责人。');
  missing('mismatch-hold', '价格不一致时，是否需要暂停该商品的后续调价？', '差异记录可以保留，但是否阻断后续任务尚无依据。', 'reconcile', '本演示资料未说明价格不一致时是否暂停后续调价。');

  const text = lines.join('\n');
  model.sources.push({ id: sourceId, name: '合成调价流程演示材料', text, sha256: createHash('sha256').update(text).digest('hex') });
  return model;
}

function createDemoPositions() {
  return {
    demand: { x: 225, y: -440 }, calculate: { x: 225, y: -220 },
    manual: { x: 60, y: 0 }, import: { x: 390, y: 0 },
    validate: { x: 225, y: 170 }, approval: { x: 30, y: 360 },
    recalculate: { x: 30, y: 550 }, dispatch: { x: 420, y: 550 },
    'platform-wait': { x: 420, y: 740 },
    'verify-front': { x: 420, y: 960 }, failure: { x: 750, y: 960 },
    reconcile: { x: 90, y: 1180 }, archive: { x: 420, y: 1180 }, monitor: { x: 750, y: 1180 },
  };
}

module.exports = { createDemoModel, createDemoPositions };
