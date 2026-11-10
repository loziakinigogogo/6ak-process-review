#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
function indexSources(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) throw Error('至少提供一个 Markdown 文件。');
  const seen = new Set();
  return { schemaVersion: 1, sources: inputs.map((file, i) => {
    const absolute = path.resolve(file);
    if (seen.has(absolute.toLowerCase())) throw Error(`输入重复: ${file}`);
    seen.add(absolute.toLowerCase());
    if (!/\.md(?:own)?$/i.test(file) && !/\.markdown$/i.test(file)) throw Error(`需要 Markdown 文件: ${file}`);
    let text;
    try { text = fs.readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); }
    catch (cause) { throw Error(`无法读取 ${file}: ${cause.message}`); }
    if (!text.trim()) throw Error(`输入为空: ${file}`);
    return { id: `source-${i + 1}`, name: path.basename(file), sha256: digest(text), text };
  }) };
}
if (require.main === module) {
  try {
    const [output, ...inputs] = process.argv.slice(2);
    if (!output || !inputs.length) throw Error('用法: node index-sources.cjs <sources.json> <input.md> [other.md ...]');
    if (inputs.some(file => path.resolve(file).toLowerCase() === path.resolve(output).toLowerCase())) throw Error('输出不得覆盖原文。');
    const result = indexSources(inputs);
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', 'utf8');
    console.log(JSON.stringify({ output: path.resolve(output), sources: result.sources.map(({ text, ...meta }) => ({ ...meta, lines: text.split('\n').length })) }, null, 2));
  } catch (cause) { console.error(cause.message); process.exitCode = 1; }
}
module.exports = { indexSources, digest };
