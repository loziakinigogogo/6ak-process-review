#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { digest } = require('./index-sources.cjs');
const { validateModel, NODE_FIELDS, RULE_FIELDS } = require('./validate-model.cjs');

const collections = { node: 'nodes', relation: 'relations', rule: 'rules', issue: 'issues', claim: 'claims' };
const prefix = 'pricing-ref:v1 ';

function parseReference(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim().replace(/^>\s*/, ''));
  const tokens = lines.filter(line => line.startsWith('pricing-ref:'));
  if (tokens.length !== 1 || !tokens[0].startsWith(prefix)) {
    throw Error('请提供一条完整的 pricing-ref:v1 引用。');
  }
  let reference;
  try { reference = JSON.parse(tokens[0].slice(prefix.length)); }
  catch { throw Error('引用格式不完整，请从报告重新复制。'); }
  if (!reference || typeof reference !== 'object' || Array.isArray(reference) ||
    typeof reference.reportId !== 'string' || typeof reference.modelSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(reference.modelSha256) ||
    typeof reference.type !== 'string' || !Object.hasOwn(collections, reference.type) ||
    typeof reference.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(reference.id)) {
    throw Error('引用的项目、版本、对象类型或编号无效。');
  }
  return reference;
}

function contextClaimIds(context, object) {
  const { type, field } = context;
  if (field === undefined) return [...object.claimIds, ...(object.resolutionClaimIds || [])];
  if (field === 'claimIds') return object.claimIds;
  if (type === 'node' && NODE_FIELDS.includes(field)) return object.fields[field];
  if (type === 'rule' && RULE_FIELDS.includes(field)) return object.parameters[field];
  if (type === 'relation' && field === 'conditionClaimIds') return object.conditionClaimIds;
  if (type === 'issue' && field === 'resolutionClaimIds') return object.resolutionClaimIds || [];
  throw Error('引用的上下文字段无效。');
}

function resolveReference(model, text) {
  const reference = parseReference(text);
  const validation = validateModel(model);
  if (!validation.ok) throw Error('模型无效\n' + validation.errors.join('\n'));
  if (reference.reportId !== model.report.id) throw Error('引用属于其他项目，请使用对应流程模型。');
  if (reference.modelSha256 !== digest(JSON.stringify(model))) {
    throw Error('引用来自其他版本，请核对旧版对象及当前对象后再修改。');
  }
  return resolveTarget(model, reference);
}

function resolveTarget(model, reference) {
  const object = model[collections[reference.type]].find(item => item.id === reference.id);
  if (!object) throw Error(`当前版本不存在所引用的 ${reference.type} 对象。`);
  const result = { reference, object };
  const context = reference.context;
  if (context !== undefined) {
    if (reference.type !== 'claim' || !context || typeof context !== 'object' || Array.isArray(context) ||
      !['node', 'relation', 'rule', 'issue'].includes(context.type) || typeof context.id !== 'string') {
      throw Error('引用的上下文无效。');
    }
    const contextObject = model[collections[context.type]].find(item => item.id === context.id);
    if (!contextObject || !contextClaimIds(context, contextObject).includes(reference.id)) {
      throw Error('所引用的陈述不属于指定对象或字段。');
    }
    result.contextObject = contextObject;
  }
  return result;
}

if (require.main === module) {
  try {
    const [modelFile, referenceFile] = process.argv.slice(2);
    if (process.argv.length !== 4) throw Error('用法: node resolve-reference.cjs <model.json> <reference.txt 或 ->');
    const model = JSON.parse(fs.readFileSync(modelFile, 'utf8').replace(/^\uFEFF/, ''));
    const text = fs.readFileSync(referenceFile === '-' ? 0 : referenceFile, 'utf8');
    console.log(JSON.stringify(resolveReference(model, text), null, 2));
  } catch (cause) {
    console.error(cause.message);
    process.exitCode = 1;
  }
}

module.exports = { resolveReference, resolveTarget };
