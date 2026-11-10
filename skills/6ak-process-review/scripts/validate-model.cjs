#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { digest } = require('./index-sources.cjs');
const NODE_FIELDS = ['role', 'system', 'trigger', 'input', 'actions', 'output', 'rules'];
const RULE_FIELDS = ['operator', 'value', 'unit', 'basis', 'scope', 'exceptions'];
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

function validateModel(model) {
  const errors = [], warnings = [];
  const fail = (at, message) => errors.push(`${at}: ${message}`);
  const str = (value, at, required = true) => { if (typeof value !== 'string' || (required && !value.trim())) { fail(at, required ? '需要非空字符串' : '需要字符串'); return false; } return true; };
  const keys = (obj, allowed, at) => { if (!object(obj)) { fail(at, '需要对象'); return false; } for (const key of Object.keys(obj)) if (!allowed.includes(key)) fail(`${at}.${key}`, '不支持的字段；不会静默忽略'); return true; };
  const list = (value, at) => { if (!Array.isArray(value)) { fail(at, '需要数组'); return []; } return value; };
  const enumValue = (value, allowed, at) => { if (!allowed.includes(value)) fail(at, `应为 ${allowed.join(' / ')}`); };
  const stringList = (value, at) => { for (const [i, item] of list(value, at).entries()) str(item, `${at}[${i}]`); };
  const tables = {};
  if (!keys(model, ['schemaVersion', 'report', 'sources', 'claims', 'groups', 'nodes', 'relations', 'rules', 'issues', 'coverage', 'review'], 'model')) return { ok: false, errors, warnings };
  if (model.schemaVersion !== 1) fail('schemaVersion', '仅支持内容模型 v1');
  for (const name of ['sources', 'claims', 'groups', 'nodes', 'relations', 'rules', 'issues']) {
    const map = new Map();
    for (const [i, item] of list(model[name], name).entries()) {
      if (!object(item)) { fail(`${name}[${i}]`, '需要对象'); continue; }
      if (typeof item.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(item.id)) fail(`${name}[${i}].id`, '需要字母、数字、短横线或下划线 ID');
      else if (map.has(item.id)) fail(`${name}[${i}].id`, `重复 ID ${item.id}`);
      else map.set(item.id, item);
    }
    tables[name] = map;
  }
  const refs = (value, table, at, minimum = 0) => {
    const ids = list(value, at);
    if (ids.length < minimum) fail(at, `至少需要 ${minimum} 个引用`);
    const seen = new Set();
    for (const id of ids) {
      if (typeof id !== 'string' || !tables[table].has(id)) fail(at, `不存在的 ${table} 引用 ${String(id)}`);
      if (seen.has(id)) fail(at, `重复引用 ${String(id)}`);
      seen.add(id);
    }
    return ids;
  };
  const claims = (value, at, minimum = 0) => refs(value, 'claims', at, minimum);
  if (keys(model.report, ['id', 'title', 'version', 'scope', 'limitations'], 'report')) {
    for (const field of ['id', 'title', 'version', 'scope']) str(model.report[field], `report.${field}`);
    stringList(model.report.limitations, 'report.limitations');
  }
  if (!tables.sources.size) fail('sources', '至少需要一个来源');
  for (const [id, source] of tables.sources) {
    const at = `sources.${id}`;
    keys(source, ['id', 'name', 'sha256', 'text', 'kind'], at); str(source.name, `${at}.name`);
    if (source.kind !== undefined) enumValue(source.kind, ['user-feedback'], `${at}.kind`);
    if (str(source.text, `${at}.text`)) {
      if (source.text.includes('\r') || source.text.startsWith('\uFEFF')) fail(`${at}.text`, '请用索引脚本统一 LF 并去 BOM');
      if (source.sha256 !== digest(source.text)) fail(`${at}.sha256`, '来源内容摘要不一致');
    }
  }
  const range = (entry, at) => {
    const source = tables.sources.get(entry.sourceId);
    if (!source || typeof source.text !== 'string') { fail(`${at}.sourceId`, '来源不存在或正文无效'); return null; }
    const lines = source.text.split('\n');
    if (!Number.isInteger(entry.startLine) || !Number.isInteger(entry.endLine) || entry.startLine < 1 || entry.endLine < entry.startLine || entry.endLine > lines.length) { fail(at, '原文行范围无效'); return null; }
    return lines.slice(entry.startLine - 1, entry.endLine).join('\n');
  };
  for (const [id, claim] of tables.claims) {
    const at = `claims.${id}`;
    keys(claim, ['id', 'text', 'origin', 'evidence', 'rationale', 'premiseIds', 'issueIds'], at);
    str(claim.text, `${at}.text`); enumValue(claim.origin, ['explicit', 'inferred', 'unknown'], `${at}.origin`);
    const evidence = list(claim.evidence, `${at}.evidence`);
    for (const [i, entry] of evidence.entries()) {
      const where = `${at}.evidence[${i}]`;
      if (!keys(entry, ['sourceId', 'startLine', 'endLine', 'quote'], where)) continue;
      const expected = range(entry, where);
      if (str(entry.quote, `${where}.quote`) && expected !== null && entry.quote !== expected) fail(`${where}.quote`, '与指定原文行不匹配');
    }
    const premises = claims(claim.premiseIds || [], `${at}.premiseIds`);
    const issues = refs(claim.issueIds || [], 'issues', `${at}.issueIds`);
    if (premises.includes(id)) fail(at, '不能以自身为推断前提');
    if (claim.origin === 'explicit' && !evidence.length) fail(at, '原文明示必须有原文证据');
    if (claim.origin === 'explicit' && premises.length) fail(at, '明示陈述不使用推断前提');
    if (claim.origin === 'inferred') {
      str(claim.rationale, `${at}.rationale`);
      if (!evidence.length && !premises.length) fail(at, '推断需要证据或前提');
      if (premises.some(p => tables.claims.get(p)?.origin === 'unknown')) fail(at, '不能以未知项作确定推断前提');
    }
    if (claim.origin === 'unknown' && !issues.some(issueId => tables.issues.get(issueId)?.status === 'open')) fail(at, '未知项需要关联未决问题');
  }
  // Reject circular reasoning even when every premise ID exists.
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) { fail(`claims.${id}`, '推断前提存在循环'); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const p of Array.isArray(tables.claims.get(id)?.premiseIds) ? tables.claims.get(id).premiseIds : []) if (tables.claims.has(p)) visit(p);
    visiting.delete(id); visited.add(id);
  }
  for (const id of tables.claims.keys()) visit(id);
  for (const [id, group] of tables.groups) {
    const at = `groups.${id}`; keys(group, ['id', 'title', 'kind', 'claimIds'], at); str(group.title, `${at}.title`);
    enumValue(group.kind, ['source', 'editorial'], `${at}.kind`); claims(group.claimIds, `${at}.claimIds`, group.kind === 'source' ? 1 : 0);
  }
  function fields(obj, names, supported, at) {
    if (!keys(obj, names, at)) return;
    for (const name of names) for (const id of claims(obj[name], `${at}.${name}`)) if (!supported.includes(id)) fail(`${at}.${name}`, `${id} 未列入对象 claimIds`);
  }
  for (const [id, node] of tables.nodes) {
    const at = `nodes.${id}`; keys(node, ['id', 'groupId', 'title', 'claimIds', 'fields'], at); str(node.title, `${at}.title`);
    if (!tables.groups.has(node.groupId)) fail(`${at}.groupId`, '分组不存在');
    const supported = claims(node.claimIds, `${at}.claimIds`, 1); fields(node.fields, NODE_FIELDS, supported, `${at}.fields`);
  }
  for (const [id, relation] of tables.relations) {
    const at = `relations.${id}`; keys(relation, ['id', 'from', 'to', 'type', 'claimIds', 'conditionClaimIds'], at);
    for (const key of ['from', 'to']) if (!tables.nodes.has(relation[key])) fail(`${at}.${key}`, '节点不存在');
    enumValue(relation.type, ['sequence', 'conditional', 'parallel', 'return', 'data', 'association'], `${at}.type`);
    const supported = claims(relation.claimIds, `${at}.claimIds`, 1);
    for (const c of supported) if (tables.claims.get(c)?.origin === 'unknown') fail(at, '不能用未知项建立业务关系');
    for (const c of claims(relation.conditionClaimIds, `${at}.conditionClaimIds`, relation.type === 'conditional' ? 1 : 0)) if (!supported.includes(c)) fail(at, `条件 ${c} 未列入关系 claimIds`);
  }
  for (const [id, rule] of tables.rules) {
    const at = `rules.${id}`; keys(rule, ['id', 'title', 'claimIds', 'parameters'], at); str(rule.title, `${at}.title`);
    const supported = claims(rule.claimIds, `${at}.claimIds`, 1); fields(rule.parameters, RULE_FIELDS, supported, `${at}.parameters`);
  }
  for (const [id, issue] of tables.issues) {
    const at = `issues.${id}`; keys(issue, ['id', 'type', 'severity', 'status', 'question', 'impact', 'claimIds', 'nodeIds', 'relationIds', 'resolutionClaimIds'], at);
    enumValue(issue.type, ['missing', 'conflict', 'ambiguity'], `${at}.type`); enumValue(issue.severity, ['critical', 'major', 'minor'], `${at}.severity`); enumValue(issue.status, ['open', 'resolved'], `${at}.status`);
    str(issue.question, `${at}.question`); str(issue.impact, `${at}.impact`);
    const supported = claims(issue.claimIds, `${at}.claimIds`); refs(issue.nodeIds, 'nodes', `${at}.nodeIds`); refs(issue.relationIds, 'relations', `${at}.relationIds`);
    if (issue.type === 'conflict' && supported.filter(c => tables.claims.get(c)?.origin === 'explicit').length < 2) fail(at, '冲突必须保留至少两条明示陈述');
    if (issue.status === 'resolved') {
      const resolutions = claims(issue.resolutionClaimIds, `${at}.resolutionClaimIds`, 1);
      for (const c of resolutions) if (tables.claims.get(c)?.origin !== 'explicit') fail(at, '确认依据需要原文明示的补充或确认资料');
    } else if (issue.resolutionClaimIds !== undefined) claims(issue.resolutionClaimIds, `${at}.resolutionClaimIds`);
  }
  const covered = new Map([...tables.sources].map(([id]) => [id, new Set()]));
  for (const [i, entry] of list(model.coverage, 'coverage').entries()) {
    const at = `coverage[${i}]`;
    if (!keys(entry, ['sourceId', 'startLine', 'endLine', 'disposition', 'claimIds', 'issueIds', 'reason'], at)) continue;
    if (range(entry, at) !== null) for (let n = entry.startLine; n <= entry.endLine; n++) covered.get(entry.sourceId).add(n);
    enumValue(entry.disposition, ['represented', 'issue', 'out_of_scope'], `${at}.disposition`);
    claims(entry.claimIds, `${at}.claimIds`, entry.disposition === 'represented' ? 1 : 0);
    refs(entry.issueIds, 'issues', `${at}.issueIds`, entry.disposition === 'issue' ? 1 : 0);
    str(entry.reason, `${at}.reason`, entry.disposition === 'out_of_scope');
  }
  for (const [id, source] of tables.sources) if (typeof source.text === 'string') {
    const uncovered = source.text.split('\n').map((line, i) => line.trim() && !covered.get(id).has(i + 1) ? i + 1 : null).filter(Boolean);
    if (uncovered.length) fail(`coverage.${id}`, `非空原文行未交代: ${uncovered.slice(0, 24).join(', ')}${uncovered.length > 24 ? ' …' : ''}`);
  }
  if (keys(model.review, ['semantic', 'visual'], 'review')) for (const mode of ['semantic', 'visual']) {
    const item = model.review[mode], at = `review.${mode}`;
    if (!keys(item, ['status', 'reviewer', 'notes'], at)) continue;
    enumValue(item.status, ['not_run', 'passed', 'issues'], `${at}.status`); str(item.reviewer, `${at}.reviewer`, item.status !== 'not_run'); stringList(item.notes, `${at}.notes`);
    if (item.status !== 'not_run' && (!Array.isArray(item.notes) || !item.notes.length)) fail(at, '已进行的复核需记录实际观察');
    if (item.status !== 'passed') warnings.push(`${at}: ${item.status === 'not_run' ? '尚未实测' : '存在待处理检查问题'}`);
  }
  if (!tables.nodes.size && (!Array.isArray(model.report?.limitations) || !model.report.limitations.length || ![...tables.issues.values()].some(i => i.status === 'open'))) fail('nodes', '无可建模节点时须说明局限并列出未决问题');
  const open = [...tables.issues.values()].filter(i => i.status === 'open').length;
  if (open) warnings.push(`保留 ${open} 个未决业务问题；不等同于报告校验失败`);
  return { ok: !errors.length, errors, warnings };
}
if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw Error('用法: node validate-model.cjs <model.json>');
    const model = JSON.parse(fs.readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
    const result = validateModel(model); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } catch (cause) { console.error(cause.message); process.exitCode = 1; }
}
module.exports = { validateModel, NODE_FIELDS, RULE_FIELDS };
