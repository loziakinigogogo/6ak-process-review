'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStore } = require('./workbench-store.cjs');
const { publicTree } = require('./workbench-content-tree.cjs');
const { createDemoModel } = require('./workbench-demo-fixture.cjs');
const { validateModel } = require('../../skills/6ak-process-review/scripts/validate-model.cjs');

function setup() {
  const directory = path.resolve('.qa', 'content-tree-unit', randomUUID());
  return { directory, store: createStore(directory, { model: createDemoModel() }) };
}
function change(store, patch) { return store.contentEdit({ requestId: randomUUID(), nodeId: 'validate', baseContentRevision: publicTree(store.read()).revision, ...patch }); }
function add(store, kind, text, parentId = null) { change(store, { operation: 'create', entryType: 'note', kind, text, title: '', parentId }); return publicTree(store.read()).entries.at(-1); }
function reference(store, entries) { const state=store.read(); return store.createReference({ baseWorkRevision:state.workRevision,baseModelHash:state.modelHash,baseContentHash:publicTree(state).hash,targets:[{type:'node',id:'validate'}],contentEntryIds:entries.map(e=>e.id) }); }
function useFeedback(candidate) {
  const model=JSON.parse(fs.readFileSync(candidate.modelFile));
  const source=candidate.feedbackSources[0];
  model.sources.push(source);
  const claim={id:'attached-role',text:'财务专员',origin:'explicit',evidence:[{sourceId:source.id,startLine:1,endLine:1,quote:source.text}]};
  model.claims.push(claim);
  model.coverage.push({sourceId:source.id,startLine:1,endLine:1,disposition:'represented',claimIds:[claim.id],issueIds:[],reason:'本轮用户补充'});
  const node=model.nodes.find(n=>n.id==='validate'); node.claimIds.push(claim.id);node.fields.role=[claim.id];
  fs.writeFileSync(candidate.modelFile,JSON.stringify(model));
  return model;
}

test('free content and hierarchy persist separately from v1; updates preserve original words and stale saves reject', () => {
  const {store,directory}=setup();const before=store.read();
  change(store,{operation:'create',entryType:'section',title:'平台差异'});const section=publicTree(store.read()).entries[0];
  const note=add(store,'reminder','这里容易漏填币种。',section.id);
  change(store,{operation:'update',entryId:note.id,parentId:section.id,title:'录入提醒',kind:'reminder',text:'录入前核对币种。'});
  const after=createStore(directory).read();
  assert.equal(after.workRevision,before.workRevision);assert.deepEqual(after.model,before.model);assert.equal(validateModel(after.model).ok,true);
  assert.equal(publicTree(after).entries[1].revisions[0].text,'这里容易漏填币种。');assert.equal(publicTree(after).entries[1].text,'录入前核对币种。');
  assert.equal(publicTree(after).entries[1].parentId,section.id);
  assert.throws(()=>store.contentEdit({nodeId:'validate',baseContentRevision:0,operation:'update',entryId:note.id,title:'',kind:'fact',text:'覆盖'}),/已有新修改/);
  assert.throws(()=>change(store,{operation:'update',entryId:section.id,title:'循环',parentId:section.id}),/栏目无效/);
});

test('precise handoff preserves all natures, only current fact exposes a source, and accepted versions derive from live evidence', () => {
  const {store}=setup();const fact=add(store,'fact','这个环节实际由财务专员负责。');const proposal=add(store,'proposal','建议以后增加主管复核。');const question=add(store,'question','是否应由财务负责？');
  const ref=reference(store,[fact,proposal,question]);const candidate=store.createCandidate({referenceId:ref.id});
  assert.equal(candidate.contentInputs.length,3);assert.equal(candidate.feedbackSources.length,1);assert.equal(candidate.feedbackSources[0].text,fact.text);
  useFeedback(candidate);const review=store.reviewCandidate(candidate.candidateId);
  assert.ok(review.changes.length);store.applyCandidate({candidateId:candidate.candidateId,reviewHash:review.reviewHash});
  assert.deepEqual(publicTree(store.read()).entries[0].adoptedRevisions,[1]);assert.deepEqual(publicTree(store.read()).entries[1].adoptedRevisions,[]);
  change(store,{operation:'update',entryId:fact.id,title:'',kind:'fact',text:'现由财务组负责人负责。'});
  const updated=store.read();assert.equal(publicTree(updated).entries[0].revision,2);assert.deepEqual(publicTree(updated).entries[0].adoptedRevisions,[1]);
  const reminder=add(store,'reminder','后来新增的提醒');
  store.undo({baseWorkRevision:store.read().workRevision,baseModelHash:store.read().modelHash});
  assert.ok(publicTree(store.read()).entries.some(e=>e.id===reminder.id));assert.deepEqual(publicTree(store.read()).entries[0].adoptedRevisions,[]);
});

test('content revision makes references and candidates stale without changing business W', () => {
  const {store}=setup();const fact=add(store,'fact','该步由财务负责。');const ref=reference(store,[fact]);const candidate=store.createCandidate({referenceId:ref.id});useFeedback(candidate);
  const review=store.reviewCandidate(candidate.candidateId);const version=store.read().workRevision;
  change(store,{operation:'update',entryId:fact.id,title:'',kind:'fact',text:'该步由运营负责。'});
  assert.equal(store.read().workRevision,version);assert.equal(store.reference(ref.id).stale,true);
  assert.throws(()=>store.createCandidate({referenceId:ref.id}),/过期/);
  assert.throws(()=>store.applyCandidate({candidateId:candidate.candidateId,reviewHash:review.reviewHash}),/节点补充已改变/);
});

test('suggestion cannot masquerade as a typed current-fact source', () => {
  const {store}=setup();const note=add(store,'proposal','建议财务复核。');const candidate=store.createCandidate({contentEntryIds:[note.id]});
  const model=JSON.parse(fs.readFileSync(candidate.modelFile));const crypto=require('node:crypto');
  const source={id:`wb-content-${note.id}-r1`,name:'伪装事实',text:note.text,sha256:crypto.createHash('sha256').update(note.text).digest('hex'),kind:'user-feedback'};
  model.sources.push(source);model.coverage.push({sourceId:source.id,startLine:1,endLine:1,disposition:'out_of_scope',claimIds:[],issueIds:[],reason:'测试伪装'});
  fs.writeFileSync(candidate.modelFile,JSON.stringify(model));assert.throws(()=>store.reviewCandidate(candidate.candidateId),/不能直接作为现行事实来源/);
});
