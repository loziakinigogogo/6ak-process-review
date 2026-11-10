#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { digest } = require('./index-sources.cjs');
const { validateModel } = require('./validate-model.cjs');

const nodeFields = {
  role: '角色', system: '系统', trigger: '触发条件', input: '输入',
  actions: '动作', output: '产出', rules: '规则'
};
const ruleFields = {
  operator: '比较符', value: '数值', unit: '单位', basis: '计算基准', scope: '范围', exceptions: '例外'
};
const relationNames = {
  sequence: '顺序', conditional: '条件分支', parallel: '并行', return: '回退', data: '数据交付', association: '关联'
};
const issueNames = { missing: '缺失', conflict: '冲突', ambiguity: '歧义' };
const severityNames = { critical: '关键', major: '重要', minor: '次要' };

function inline(value) {
  return String(value).replace(/\s+/g, ' ').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_\[\]~|]/g, '\\$&');
}

function quoteBlock(text) {
  const longest = (text.match(/`+/g) || []).reduce((size, run) => Math.max(size, run.length), 2);
  const fence = '`'.repeat(longest + 1);
  return [fence + 'text', text, fence];
}

function renderFlow(model) {
  const validation = validateModel(model);
  if (!validation.ok) throw Error('模型无效\n' + validation.errors.map(error => '- ' + error).join('\n'));

  const modelSha256 = digest(JSON.stringify(model));
  const sources = new Map(model.sources.map(source => [source.id, source]));
  const claims = new Map(model.claims.map(claim => [claim.id, claim]));
  const nodes = new Map(model.nodes.map(node => [node.id, node]));
  const issueById = new Map(model.issues.map(issue => [issue.id, issue]));
  const usedClaims = new Set();
  const excerpts = new Map();
  for (const claim of model.claims) {
    for (const evidence of claim.evidence) {
      const key = `${evidence.sourceId}-L${evidence.startLine}-L${evidence.endLine}`;
      if (excerpts.has(key)) continue;
      const source = sources.get(evidence.sourceId);
      const lineRange = evidence.startLine === evidence.endLine
        ? `第 ${evidence.startLine} 行` : `第 ${evidence.startLine}–${evidence.endLine} 行`;
      excerpts.set(key, { key, label: `${inline(source.name)} · ${lineRange}`, quote: evidence.quote });
    }
  }

  const objectId = (type, id) => '`' + type + ':' + id + '`';
  const anchor = (type, id) => `<a id="${type}-${id}"></a>`;
  const nodeLink = id => `[${inline(nodes.get(id).title)}](#node-${id}) ${objectId('node', id)}`;
  const issueLink = id => {
    const issue = issueById.get(id);
    const label = issue.status === 'resolved' ? '已澄清' : issueNames[issue.type] + '待确认';
    return `[${label}](#issue-${id}) ${objectId('issue', id)}`;
  };
  function claimText(id) {
    usedClaims.add(id);
    const claim = claims.get(id);
    let origin;
    if (claim.origin === 'inferred') origin = '整理推断';
    else if (claim.origin === 'unknown') origin = '原文未说明';
    else {
      const feedbackCount = claim.evidence.filter(evidence => sources.get(evidence.sourceId).kind === 'user-feedback').length;
      if (!feedbackCount) origin = '原文明示';
      else origin = feedbackCount === claim.evidence.length ? '用户补充' : '原文明示、用户补充';
    }
    const citations = claim.evidence.map(evidence => {
      const key = `${evidence.sourceId}-L${evidence.startLine}-L${evidence.endLine}`;
      return `[${excerpts.get(key).label}](#evidence-${key})`;
    });
    const tags = [origin, ...citations, ...(claim.issueIds || []).map(issueLink), objectId('claim', id)];
    const reason = claim.origin === 'inferred' ? `（推断理由：${inline(claim.rationale)}）` : '';
    const premises = claim.premiseIds?.length
      ? `（前提：${claim.premiseIds.map(id => objectId('claim', id)).join('、')}）` : '';
    return `${inline(claim.text)}〔${tags.join(' · ')}〕${reason}${premises}`;
  }

  const lines = [
    `# ${inline(model.report.title)}`, '',
    `**范围** ${inline(model.report.scope)}`, '',
    `**说明版本** ${inline(model.report.version)} · **项目** ${inline(model.report.id)} · **待确认** ${model.issues.filter(issue => issue.status === 'open').length} 项`, '',
    '**审阅方式** 可在当前聊天引用节点标题、连线两端或下方的标识来说明要改哪里。本文由同版本的 `model.json` 生成。', ''
  ];
  if (model.report.limitations.length) {
    lines.push('## 资料范围与局限', '', ...model.report.limitations.map(item => `- ${inline(item)}`), '');
  }
  if (!model.nodes.length) lines.push('## 流程', '', '当前资料不足以建立可追溯的业务节点，具体缺口见下方疑点。', '');

  for (const group of model.groups) {
    const label = group.kind === 'editorial' ? '整理分组' : '原文分组';
    lines.push(`## ${inline(group.title)}〔${label}〕`, '', objectId('group', group.id), '');
    for (const id of group.claimIds) lines.push(`- 分组依据　${claimText(id)}`);
    if (group.claimIds.length) lines.push('');
    for (const node of model.nodes.filter(node => node.groupId === group.id)) {
      lines.push(anchor('node', node.id), `### ${inline(node.title)}`, '', objectId('node', node.id), '');
      const fieldClaims = new Set();
      for (const [field, title] of Object.entries(nodeFields)) {
        const ids = node.fields[field];
        if (!ids.length) continue;
        for (const id of ids) fieldClaims.add(id);
        lines.push(`- **${title}** ${ids.map(claimText).join('；')}`);
      }
      for (const id of node.claimIds.filter(id => !fieldClaims.has(id))) lines.push(`- **补充说明** ${claimText(id)}`);
      const outgoing = model.relations.filter(relation => relation.from === node.id);
      if (outgoing.length) lines.push('- **后续与关联**');
      for (const relation of outgoing) {
        lines.push(`  - ${relationNames[relation.type]} → ${nodeLink(relation.to)} ${objectId('relation', relation.id)}`);
        for (const id of relation.claimIds) {
          const label = relation.conditionClaimIds.includes(id) ? '**条件** ' : '';
          lines.push(`    - ${label}${claimText(id)}`);
        }
      }
      const relatedIssues = model.issues.filter(issue => issue.nodeIds.includes(node.id));
      if (relatedIssues.length) lines.push(`- **相关疑点** ${relatedIssues.map(issue => issueLink(issue.id)).join('、')}`);
      lines.push('');
    }
  }

  if (model.rules.length) lines.push('## 业务规则', '');
  for (const rule of model.rules) {
    lines.push(anchor('rule', rule.id), `### ${inline(rule.title)}`, '', objectId('rule', rule.id), '');
    for (const id of rule.claimIds) {
      const fields = Object.entries(ruleFields).filter(([field]) => rule.parameters[field].includes(id)).map(([, label]) => label);
      lines.push(`- ${fields.length ? '**' + fields.join('、') + '** ' : ''}${claimText(id)}`);
    }
    const missing = Object.entries(ruleFields).filter(([field]) => !rule.parameters[field].length).map(([, label]) => label);
    if (missing.length) lines.push(`- **未交代的参数** ${missing.join('、')}`);
    lines.push('');
  }

  lines.push('## 疑点与澄清', '');
  if (!model.issues.length) lines.push('本次整理未登记疑点。', '');
  for (const issue of model.issues) {
    const status = issue.status === 'resolved' ? '已澄清' : '待确认';
    lines.push(anchor('issue', issue.id), `### ${inline(issue.question)}`, '',
      `${objectId('issue', issue.id)} · ${status} · ${severityNames[issue.severity]}${issueNames[issue.type]}`, '',
      `- **${issue.status === 'resolved' ? '原影响' : '影响'}** ${inline(issue.impact)}`);
    for (const id of issue.resolutionClaimIds || []) lines.push(`- **澄清结论** ${claimText(id)}`);
    for (const id of issue.claimIds) lines.push(`- **${issue.status === 'resolved' ? '原始记录' : '现有记录'}** ${claimText(id)}`);
    if (issue.nodeIds.length) lines.push(`- **涉及节点** ${issue.nodeIds.map(nodeLink).join('、')}`);
    if (issue.relationIds.length) lines.push(`- **涉及流转** ${issue.relationIds.map(id => objectId('relation', id)).join('、')}`);
    lines.push('');
  }

  const supplemental = model.claims.filter(claim => !usedClaims.has(claim.id));
  if (supplemental.length) lines.push('## 其他已记录陈述', '', ...supplemental.map(claim => `- ${claimText(claim.id)}`), '');

  lines.push('## 依据摘录', '');
  if (!excerpts.size) lines.push('当前模型没有可引用的原文摘录。', '');
  for (const { key, label, quote } of excerpts.values()) {
    lines.push(anchor('evidence', key), `### ${label}`, '', ...quoteBlock(quote), '');
  }
  lines.push(`模型 SHA-256　\`${modelSha256}\``, '');
  return { markdown: lines.join('\n'), modelSha256, warnings: validation.warnings };
}

function exportFlow(inputFile, outputFile) {
  const input = path.resolve(inputFile);
  const output = path.resolve(outputFile);
  if (path.extname(input).toLowerCase() !== '.json' || path.extname(output).toLowerCase() !== '.md') {
    throw Error('输入需要 .json 模型，输出需要 .md 审阅稿。');
  }
  const model = JSON.parse(fs.readFileSync(input, 'utf8').replace(/^\uFEFF/, ''));
  const { markdown, ...details } = renderFlow(model);
  if (fs.existsSync(output)) {
    const existing = fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (model.sources.some(source => source.sha256 === digest(existing))) {
      throw Error('输出目标已有原始来源内容，请换一个输出路径。');
    }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = path.join(path.dirname(output), `.${path.basename(output)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, markdown, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, output);
  } catch (cause) {
    try { fs.unlinkSync(temporary); } catch {}
    throw cause;
  }
  return { output, ...details };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw Error('用法: node export-flow.cjs <model.json> <flow.md>');
    console.log(JSON.stringify(exportFlow(process.argv[2], process.argv[3]), null, 2));
  } catch (cause) {
    console.error(cause.message);
    process.exitCode = 1;
  }
}

module.exports = { renderFlow, exportFlow };
