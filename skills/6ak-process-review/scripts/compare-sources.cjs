#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { digest } = require('./index-sources.cjs');
const { validateModel } = require('./validate-model.cjs');

const sourceIdPattern = /^[A-Za-z0-9_-]+$/;
const normalize = text => text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

function affected(model, directClaimIds) {
  const ids = new Set(directClaimIds);
  let grew;
  do {
    grew = false;
    for (const claim of model.claims) {
      if (!ids.has(claim.id) && (claim.premiseIds || []).some(id => ids.has(id))) {
        ids.add(claim.id);
        grew = true;
      }
    }
  } while (grew);
  const touches = object => [...object.claimIds, ...(object.resolutionClaimIds || [])].some(id => ids.has(id));
  const nodes = model.nodes.filter(touches).map(node => node.id);
  const relations = model.relations.filter(touches).map(relation => relation.id);
  const nodeIds = new Set(nodes), relationIds = new Set(relations);
  return {
    directClaimIds: model.claims.filter(claim => directClaimIds.includes(claim.id)).map(claim => claim.id),
    affectedClaimIds: model.claims.filter(claim => ids.has(claim.id)).map(claim => claim.id),
    affectedObjects: {
      groups: model.groups.filter(group => touches(group) || model.nodes.some(node => node.groupId === group.id && nodeIds.has(node.id))).map(group => group.id),
      nodes,
      relations,
      rules: model.rules.filter(touches).map(rule => rule.id),
      issues: model.issues.filter(issue => touches(issue) || issue.nodeIds.some(id => nodeIds.has(id)) || issue.relationIds.some(id => relationIds.has(id))).map(issue => issue.id),
    },
  };
}

function checkEvidence(model, sourceId, text) {
  const lines = text.split('\n');
  const matchesByQuote = new Map();
  return model.claims.flatMap(claim => claim.evidence.flatMap((evidence, evidenceIndex) => {
    if (evidence.sourceId !== sourceId) return [];
    if (!matchesByQuote.has(evidence.quote)) {
      const count = evidence.quote.split('\n').length;
      const matches = [];
      for (let index = 0; index + count <= lines.length; index++) {
        if (lines.slice(index, index + count).join('\n') === evidence.quote) {
          matches.push({ startLine: index + 1, endLine: index + count });
        }
      }
      matchesByQuote.set(evidence.quote, matches);
    }
    const matches = matchesByQuote.get(evidence.quote);
    const samePosition = matches.some(match => match.startLine === evidence.startLine && match.endLine === evidence.endLine);
    return [{
      claimId: claim.id,
      evidenceIndex,
      original: { startLine: evidence.startLine, endLine: evidence.endLine },
      quoteSha256: digest(evidence.quote),
      status: samePosition ? 'same_position' : matches.length === 1 ? 'moved_unique' : matches.length ? 'ambiguous' : 'missing',
      matchCount: matches.length,
      matches,
    }];
  }));
}

// Diagnostic only: a matching quote does not establish unchanged business meaning.
// The caller must explicitly associate each file with a source ID; input order is not identity.
function compareSources(model, mappings) {
  const validation = validateModel(model);
  if (!validation.ok) throw Error('基线模型无效\n' + validation.errors.join('\n'));
  if (!Array.isArray(mappings) || !mappings.length) throw Error('至少提供一组 sourceId 与 Markdown 路径。');
  const mapped = new Map(), paths = new Set();
  for (const mapping of mappings) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
        Object.keys(mapping).some(key => !['sourceId', 'path'].includes(key)) ||
        typeof mapping.sourceId !== 'string' || !sourceIdPattern.test(mapping.sourceId) ||
        typeof mapping.path !== 'string' || !mapping.path.trim()) {
      throw Error('来源映射需要有效的 sourceId 和 Markdown 文件 path。');
    }
    if (mapped.has(mapping.sourceId)) throw Error('来源编号重复: ' + mapping.sourceId);
    if (!/\.(?:md|mdown|markdown)$/i.test(mapping.path)) throw Error('需要 Markdown 文件: ' + mapping.path);
    const absolute = path.resolve(mapping.path);
    const pathKey = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (paths.has(pathKey)) throw Error('同一文件不能映射为多个来源: ' + absolute);
    paths.add(pathKey);
    let text;
    try { text = normalize(fs.readFileSync(absolute, 'utf8')); }
    catch (cause) { throw Error('无法读取 ' + absolute + ': ' + cause.message); }
    mapped.set(mapping.sourceId, { path: absolute, text, sha256: digest(text) });
  }

  const sources = model.sources.map(source => {
    const current = mapped.get(source.id);
    if (!current) return {
      sourceId: source.id, name: source.name, kind: source.kind || 'document', status: 'unchecked',
      previousSha256: source.sha256, requiresCoverageReview: null, requiresBusinessReview: null,
      evidenceChecks: [], ...affected(model, []),
    };
    const changed = source.sha256 !== current.sha256;
    const directClaimIds = changed
      ? model.claims.filter(claim => claim.evidence.some(evidence => evidence.sourceId === source.id)).map(claim => claim.id)
      : [];
    return {
      sourceId: source.id, name: source.name, kind: source.kind || 'document', path: current.path,
      status: changed ? 'changed' : 'unchanged', previousSha256: source.sha256, currentSha256: current.sha256,
      previousLineCount: source.text.split('\n').length, currentLineCount: current.text.split('\n').length,
      empty: !current.text.trim(), requiresCoverageReview: changed, requiresBusinessReview: changed,
      evidenceChecks: checkEvidence(model, source.id, current.text), ...affected(model, directClaimIds),
    };
  });
  const previousIds = new Set(model.sources.map(source => source.id));
  for (const [sourceId, current] of mapped) {
    if (previousIds.has(sourceId)) continue;
    sources.push({
      sourceId, name: path.basename(current.path), path: current.path, status: 'added',
      currentSha256: current.sha256, currentLineCount: current.text.split('\n').length,
      empty: !current.text.trim(), requiresCoverageReview: true, requiresBusinessReview: true,
      evidenceChecks: [], ...affected(model, []),
    });
  }
  const changed = sources.some(source => ['changed', 'added'].includes(source.status));
  const uncheckedSourceIds = sources.filter(source => source.status === 'unchecked').map(source => source.sourceId);
  const directClaimIds = [...new Set(sources.flatMap(source => source.directClaimIds))];
  return {
    schemaVersion: 1,
    reportId: model.report.id,
    baselineModelSha256: digest(JSON.stringify(model)),
    status: changed ? 'changed' : uncheckedSourceIds.length ? 'incomplete' : 'unchanged',
    uncheckedSourceIds,
    requiresCoverageReview: changed,
    requiresBusinessReview: changed,
    ...affected(model, directClaimIds),
    sources,
    notes: [
      '本结果只诊断来源快照、引用位置与依赖范围，不修改模型、业务解释、选区或批注。',
      '原文全文变化均需重新核对覆盖；即使引用原位匹配或唯一移动，也不能据此认定业务含义未变。',
      '未映射来源未检查；新增来源需另行归纳。移除整个来源、替换用户补充或迁移对象编号须显式处理。',
    ],
  };
}

if (require.main === module) {
  try {
    const [modelFile, ...pairs] = process.argv.slice(2);
    if (!modelFile || !pairs.length || pairs.length % 2) {
      throw Error('用法: node compare-sources.cjs <model.json> <sourceId> <input.md> [<sourceId> <input.md> ...]');
    }
    const model = JSON.parse(normalize(fs.readFileSync(modelFile, 'utf8')));
    const mappings = [];
    for (let index = 0; index < pairs.length; index += 2) mappings.push({ sourceId: pairs[index], path: pairs[index + 1] });
    console.log(JSON.stringify(compareSources(model, mappings), null, 2));
  } catch (cause) {
    console.error(cause.message);
    process.exitCode = 1;
  }
}

module.exports = { compareSources };
