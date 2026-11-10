'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test, after } = require('node:test');
const { digest } = require('./index-sources.cjs');
const { compareSources } = require('./compare-sources.cjs');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-source-compare-'));
after(() => {
  assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporaryRoot).startsWith('pricing-source-compare-'));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});
let fileNumber = 0;
function file(text, extension = '.md') {
  const output = path.join(temporaryRoot, String(++fileNumber) + extension);
  fs.writeFileSync(output, text);
  return output;
}
const emptyFields = () => Object.fromEntries(['role', 'system', 'trigger', 'input', 'actions', 'output', 'rules'].map(key => [key, []]));
function fixture() {
  const text = '# 调价\n由运营算价。\n提交后核对展示。\n说明。';
  return {
    schemaVersion: 1,
    report: { id: 'review', title: '调价', version: '1', scope: '测试', limitations: [] },
    sources: [{ id: 'main', name: 'main.md', text, sha256: digest(text) },
      { id: 'user-note', name: '用户补充', kind: 'user-feedback', text: '由经理复核。', sha256: digest('由经理复核。') }],
    claims: [
      { id: 'owner', text: '运营算价。', origin: 'explicit', evidence: [{ sourceId: 'main', startLine: 2, endLine: 2, quote: '由运营算价。' }] },
      { id: 'submit', text: '提交后核对展示。', origin: 'explicit', evidence: [{ sourceId: 'main', startLine: 3, endLine: 3, quote: '提交后核对展示。' }] },
      { id: 'derived-two', text: '沿用此归组。', origin: 'inferred', evidence: [], premiseIds: ['derived-one'], rationale: '沿用有依据的阅读归组。' },
      { id: 'derived-one', text: '归入算价步骤。', origin: 'inferred', evidence: [], premiseIds: ['owner'], rationale: '按动作归组。' },
      { id: 'confirmation', text: '经理复核。', origin: 'explicit', evidence: [{ sourceId: 'user-note', startLine: 1, endLine: 1, quote: '由经理复核。' }] },
    ],
    groups: [{ id: 'pricing', title: '调价', kind: 'editorial', claimIds: [] }],
    nodes: [
      { id: 'calculate', title: '算价', groupId: 'pricing', claimIds: ['owner', 'derived-two'], fields: { ...emptyFields(), role: ['owner'], actions: ['derived-two'] } },
      { id: 'check', title: '核对', groupId: 'pricing', claimIds: ['submit', 'confirmation'], fields: { ...emptyFields(), actions: ['submit'], role: ['confirmation'] } },
    ],
    relations: [{ id: 'next', from: 'calculate', to: 'check', type: 'sequence', claimIds: ['submit'], conditionClaimIds: [] }],
    rules: [], issues: [],
    coverage: [
      { sourceId: 'main', startLine: 1, endLine: 4, disposition: 'represented', claimIds: ['owner', 'submit'], issueIds: [], reason: '' },
      { sourceId: 'user-note', startLine: 1, endLine: 1, disposition: 'represented', claimIds: ['confirmation'], issueIds: [], reason: '' },
    ],
    review: { semantic: { status: 'not_run', reviewer: '', notes: [] }, visual: { status: 'not_run', reviewer: '', notes: [] } },
  };
}
const main = result => result.sources.find(source => source.sourceId === 'main');
const owner = result => main(result).evidenceChecks.find(entry => entry.claimId === 'owner');

test('normalization is unchanged; an unmapped user confirmation remains explicitly unchecked', () => {
  const model = fixture(), before = JSON.stringify(model);
  const result = compareSources(model, [{ sourceId: 'main', path: file('\uFEFF' + model.sources[0].text.replace(/\n/g, '\r\n')) }]);
  assert.equal(main(result).status, 'unchanged');
  assert.equal(owner(result).status, 'same_position');
  assert.equal(result.status, 'incomplete');
  assert.deepEqual(result.uncheckedSourceIds, ['user-note']);
  assert.equal(result.sources[1].requiresBusinessReview, null);
  assert.equal(JSON.stringify(model), before);
});

test('new surrounding text requires review even when every quote still matches in place', () => {
  const model = fixture();
  const changed = model.sources[0].text.replace('说明。', '以上仅适用于门店，其他渠道另行处理。');
  const result = compareSources(model, [{ sourceId: 'main', path: file(changed) }]);
  assert.equal(result.status, 'changed');
  assert.equal(owner(result).status, 'same_position');
  assert.equal(result.requiresCoverageReview, true);
  assert.equal(main(result).requiresBusinessReview, true);
  assert.deepEqual(result.affectedClaimIds, ['owner', 'submit', 'derived-two', 'derived-one']);
  assert.deepEqual(result.affectedObjects.nodes, ['calculate', 'check']);
  assert.deepEqual(result.affectedObjects.relations, ['next']);
  assert.deepEqual(result.affectedObjects.groups, ['pricing']);
  assert.ok(!result.affectedClaimIds.includes('confirmation'));
});

test('inserted lines identify a unique move without applying new offsets', () => {
  const model = fixture();
  const result = compareSources(model, [{ sourceId: 'main', path: file('\n' + model.sources[0].text) }]);
  assert.equal(owner(result).status, 'moved_unique');
  assert.deepEqual(owner(result).matches, [{ startLine: 3, endLine: 3 }]);
  assert.equal(model.claims[0].evidence[0].startLine, 2);
  assert.equal(result.requiresCoverageReview, true);
});

test('repeated quotes at new positions are ambiguous, while deleted or rewritten quotes are missing', () => {
  const model = fixture();
  const ambiguous = compareSources(model, [{ sourceId: 'main', path: file('# 改版\n新说明\n由运营算价。\n由运营算价。') }]);
  assert.equal(owner(ambiguous).status, 'ambiguous');
  assert.equal(owner(ambiguous).matchCount, 2);
  const rewritten = compareSources(model, [{ sourceId: 'main', path: file('# 改版\n由采购算价。') }]);
  assert.equal(owner(rewritten).status, 'missing');
  const removed = compareSources(model, [{ sourceId: 'main', path: file('') }]);
  assert.equal(owner(removed).status, 'missing');
  assert.equal(main(removed).empty, true);
});

test('multiline quotes match complete lines, not substrings, and report reordered blocks', () => {
  const model = fixture();
  model.claims[0].evidence[0] = { sourceId: 'main', startLine: 2, endLine: 3, quote: '由运营算价。\n提交后核对展示。' };
  const result = compareSources(model, [{ sourceId: 'main', path: file('# 改版\n说明。\n由运营算价。\n提交后核对展示。') }]);
  assert.equal(owner(result).status, 'moved_unique');
  assert.deepEqual(owner(result).matches, [{ startLine: 3, endLine: 4 }]);
  const partial = compareSources(model, [{ sourceId: 'main', path: file('# 改版\n前缀由运营算价。\n提交后核对展示。') }]);
  assert.equal(owner(partial).status, 'missing');
});

test('explicit source IDs survive reordered mappings; new input is added without replacing old feedback', () => {
  const model = fixture();
  const sourceFile = file(model.sources[0].text), feedbackFile = file(model.sources[1].text), extra = file('新增规则待归纳。');
  const mappings = [{ sourceId: 'main', path: sourceFile }, { sourceId: 'user-note', path: feedbackFile }];
  assert.deepEqual(compareSources(model, mappings), compareSources(model, [...mappings].reverse()));
  assert.equal(compareSources(model, mappings).status, 'unchanged');
  const result = compareSources(model, [{ sourceId: 'new-supplement', path: extra }, mappings[0]]);
  assert.equal(result.sources.find(source => source.sourceId === 'new-supplement').status, 'added');
  assert.equal(result.sources.find(source => source.sourceId === 'new-supplement').requiresBusinessReview, true);
  assert.equal(result.sources.find(source => source.sourceId === 'user-note').status, 'unchecked');
  assert.equal(model.sources.length, 2);
});

test('duplicate, invalid and unreadable mappings fail explicitly', () => {
  const model = fixture(), sourceFile = file(model.sources[0].text);
  assert.throws(() => compareSources(model, []), /至少提供/);
  assert.throws(() => compareSources(model, [{ sourceId: 'main', path: sourceFile }, { sourceId: 'main', path: file('另一份') }]), /编号重复/);
  assert.throws(() => compareSources(model, [{ sourceId: 'main', path: sourceFile }, { sourceId: 'other', path: sourceFile }]), /同一文件/);
  assert.throws(() => compareSources(model, [{ sourceId: '../main', path: sourceFile }]), /有效的 sourceId/);
  assert.throws(() => compareSources(model, [{ sourceId: 'main', path: file('text', '.txt') }]), /Markdown/);
  assert.throws(() => compareSources(model, [{ sourceId: 'main', path: path.join(temporaryRoot, 'missing.md') }]), /无法读取/);
  const invalid = fixture(); invalid.sources[0].sha256 = 'invalid';
  assert.throws(() => compareSources(invalid, [{ sourceId: 'main', path: sourceFile }]), /基线模型无效/);
});

test('CLI prints JSON without modifying inputs; an unmatched argument fails', () => {
  const model = fixture(), sourceFile = file('\n' + model.sources[0].text);
  const modelFile = file(JSON.stringify(model), '.json');
  const before = fs.readFileSync(modelFile, 'utf8');
  const cli = path.join(__dirname, 'compare-sources.cjs');
  const result = JSON.parse(execFileSync(process.execPath, [cli, modelFile, 'main', sourceFile], { encoding: 'utf8', windowsHide: true }));
  assert.equal(result.status, 'changed');
  assert.equal(owner(result).status, 'moved_unique');
  assert.equal(fs.readFileSync(modelFile, 'utf8'), before);
  assert.equal(fs.readFileSync(sourceFile, 'utf8'), '\n' + model.sources[0].text);
  const invalid = spawnSync(process.execPath, [cli, modelFile, 'main'], { encoding: 'utf8', windowsHide: true });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /用法/);
});
