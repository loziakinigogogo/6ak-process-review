'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderFlow } = require('../../skills/6ak-process-review/scripts/export-flow.cjs');

const title = '阶段 3｜48h 截单';
const previous = '| **阶段 2** | 待办 | 流转至**阶段 3** |';
const stage = '| **阶段 3**<br>`STAGE-3` | 截单 |';

function fixture() {
  const claim = { id: 'c', origin: 'explicit', text: '阶段 3 核对订单。', evidence: [
    { sourceId: 's', startLine: 1, endLine: 1, quote: previous }
  ] };
  return {
    groups: [{ id: 'stop', kind: 'source', title, claimIds: ['c'] }],
    claims: [claim],
    sources: [{ id: 's', name: '流程.md', text: [previous, stage].join('\n') }]
  };
}

test('a legacy editorial title is exportable verbatim with an advisory, and business numbers remain valid', () => {
  const model = structuredClone(require('../../skills/6ak-process-review/examples/messy-pricing.model.json'));
  model.groups[0].title = title;
  const legacy = renderFlow(model);
  assert.ok(legacy.markdown.includes('## ' + title));
  assert.ok(legacy.warnings.some(message => message.includes('groups.price-change.title')));
  model.groups[0].title = '48h 截单';
  const clean = renderFlow(model);
  assert.ok(clean.markdown.includes('## 48h 截单'));
  assert.ok(!clean.warnings.some(message => message.includes('groups.price-change.title')));
});

test('legacy stage titles and new business titles share one view after reordering, retaining source stage and original model', async () => {
  const { groupsForDisplay } = await import('../frontend/src/group-labels.mjs');
  const model = fixture();
  const editorial = { id: 'check', kind: 'editorial', title: '二次复核', claimIds: [] };
  model.groups.unshift(editorial);
  const before = JSON.stringify(model);
  const [, old] = groupsForDisplay(model);
  assert.equal(old.title, '48h 截单');
  assert.equal(old.sourceStage, '原文阶段 3（STAGE-3）');
  assert.equal(old.stageLocation, '流程.md · 第 2 行');
  assert.equal(JSON.stringify(model), before);
  model.groups.reverse();
  model.groups[0].title = '48h 截单';
  assert.deepEqual(groupsForDisplay(model), [old, editorial]);
});

test('formal names, unverified prefixes, and conflicting sources keep their saved title', async () => {
  const { groupsForDisplay } = await import('../frontend/src/group-labels.mjs');
  for (const change of [
    m => { m.groups[0].title = 'ISO 9001'; },
    m => { m.groups[0].title = '第 3 方复核'; },
    m => { m.groups[0].kind = 'editorial'; },
    m => { m.sources.push({ id: 'note', name: '正式名称', text: title }); },
    m => { m.claims[0].evidence[0].quote = stage; },
    m => { m.claims[0].origin = 'inferred'; },
    m => { m.claims[0].text = '阶段 30 进行复核'; },
    m => { m.sources[0].text = previous; },
    m => { m.sources[0].text = previous + '\n其他表格\n' + stage; },
    m => { m.claims.push({ ...m.claims[0], id: 'other', text: '阶段 4 交接' }); m.groups[0].claimIds.push('other'); }
  ]) {
    const model = fixture();
    change(model);
    assert.equal(groupsForDisplay(model)[0].title, model.groups[0].title);
  }
});
