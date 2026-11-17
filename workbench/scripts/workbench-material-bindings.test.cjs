'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createStore}=require('./workbench-store.cjs');
const {createDemoModel}=require('./workbench-demo-fixture.cjs');
const {collectBindings}=require('./workbench-material-bindings.cjs');
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
function setup(){const task=path.resolve('.qa/material-bindings-unit',crypto.randomUUID());return{task,store:createStore(task,{model:createDemoModel()}),file:path.join(task,'workbench/material-bindings.json')};}
function guard(store){const s=store.read();return{baseWorkRevision:s.workRevision,baseModelHash:s.modelHash};}
function ref(store){return store.createReference({...guard(store),targets:[{type:'node',id:'validate'}],baseMaterialsHash:store.materials().hash});}
function apply(store,candidate){const review=store.reviewCandidate(candidate.candidateId);return store.applyCandidate({candidateId:candidate.candidateId,reviewHash:review.reviewHash});}
function addSource(model,id,text){const source={id,name:id,text,sha256:digest(text)};model.sources.push(source);const claim={id:`${id}-claim`,text,origin:'explicit',evidence:[{sourceId:id,startLine:1,endLine:1,quote:text}]};model.claims.push(claim);model.coverage.push({sourceId:id,startLine:1,endLine:1,disposition:'represented',claimIds:[claim.id],issueIds:[],reason:'合成测试原稿'});const node=model.nodes.find(n=>n.id==='validate');node.claimIds.push(claim.id);node.fields.role=[claim.id];return source;}
const includesRole=materials=>materials.bindings.some(b=>b.nodeId==='validate'&&b.sourceId==='demo-guide'&&b.startLine<=28&&b.endLine>=28);

test('raw materials survive replacing a result and removing its claim, reopen, reference and undo without read version churn',()=>{
  const {task,store,file}=setup(),initial=store.materials();
  const candidate=store.createCandidate(),model=read(candidate.modelFile),node=model.nodes.find(n=>n.id==='validate');
  node.claimIds=node.claimIds.filter(id=>id!=='validate-role');node.fields.role=['manual-role'];node.claimIds.push('manual-role');write(candidate.modelFile,model);
  apply(store,candidate);
  assert.equal(includesRole({bindings:collectBindings(store.read().model)}),false,'fixture really removed the active evidence association');
  assert.equal(includesRole(store.materials()),true);
  const reopened=createStore(task),snapshot=ref(reopened);
  assert.equal(includesRole(snapshot.context.materials),true);
  for(const binding of snapshot.context.materials.bindings){const source=snapshot.context.materials.sources.find(s=>s.id===binding.sourceId&&digest(s.text)===binding.sourceHash);assert.ok(source,'each binding resolves to the exact original source');assert.ok(snapshot.context.sources.some(s=>s.id===source.id&&s.text===source.text));}
  assert.equal(reopened.materials().hash,store.materials().hash);assert.equal(reopened.materials().revision,store.materials().revision);
  const bytes=fs.readFileSync(file,'utf8');for(let i=0;i<3;i++)createStore(task).context('validate');assert.equal(fs.readFileSync(file,'utf8'),bytes);
  assert.ok(!bytes.includes('调价系统'),'sidecar stores no raw body');
  reopened.undo(guard(reopened));assert.equal(includesRole(reopened.materials()),true);assert.ok(reopened.materials().revision>=initial.revision);
});

test('old tasks recover only committed snapshot associations; draft candidates and invented missing history are excluded',()=>{
  const {task,store,file}=setup(),candidate=store.createCandidate(),model=read(candidate.modelFile),node=model.nodes.find(n=>n.id==='validate');
  node.claimIds=node.claimIds.filter(id=>id!=='validate-role');node.fields.role=[];write(candidate.modelFile,model);apply(store,candidate);
  const unadopted=store.createCandidate(),draft=read(unadopted.modelFile);addSource(draft,'unadopted-doc','这份候选原稿从未被采用');write(unadopted.modelFile,draft);
  fs.unlinkSync(file);
  const migrated=createStore(task),materials=migrated.materials();assert.equal(includesRole(materials),true);assert.ok(!materials.bindings.some(b=>b.sourceId==='unadopted-doc'));
  assert.equal(createStore(task).materials().hash,materials.hash);
  const currentOnly=structuredClone(model),noHistory=path.resolve('.qa/material-bindings-unit',crypto.randomUUID());
  const old=createStore(noHistory,{model:currentOnly});fs.unlinkSync(path.join(noHistory,'workbench/material-bindings.json'));
  assert.equal(includesRole(createStore(noHistory).materials()),false,'missing history cannot invent an old node-to-source association');assert.deepEqual(old.read().model,currentOnly);
});

test('a source introduced by an adopted candidate remains available after undo and cannot be rewritten using its old id',()=>{
  const {task,store}=setup(),candidate=store.createCandidate(),model=read(candidate.modelFile);
  const original=addSource(model,'later-original','这是随后挂载并采用过的真实合成原稿');write(candidate.modelFile,model);apply(store,candidate);store.undo(guard(store));
  assert.ok(!store.read().model.sources.some(s=>s.id===original.id));
  const reopened=createStore(task),materials=reopened.context('validate').materials;
  assert.ok(materials.bindings.some(b=>b.sourceId===original.id));assert.deepEqual(materials.sources.find(s=>s.id===original.id),original);
  const modified=reopened.createCandidate(),bad=read(modified.modelFile);addSource(bad,original.id,'同一个来源身份却被替换的内容');write(modified.modelFile,bad);
  assert.throws(()=>reopened.reviewCandidate(modified.candidateId),/历史挂载的原始来源/);
});

test('legacy references and candidates without materials hash remain usable; new material guards reject stale versions',()=>{
  const {task,store}=setup(),reference=ref(store),referenceFile=path.join(task,'workbench/references',`${reference.id}.json`),legacy=read(referenceFile);
  delete legacy.materialsHash;delete legacy.context.materials;write(referenceFile,legacy);assert.equal(store.reference(reference.id).stale,false);
  const candidate=store.createCandidate({referenceId:reference.id}),metadata=read(candidate.metaFile);delete metadata.baseMaterialsHash;write(candidate.metaFile,metadata);
  const model=read(candidate.modelFile);model.nodes.find(n=>n.id==='validate').title='兼容候选的表达修订';write(candidate.modelFile,model);apply(store,candidate);
  assert.equal(store.read().model.nodes.find(n=>n.id==='validate').title,'兼容候选的表达修订');
  assert.throws(()=>store.createReference({...guard(store),targets:[],baseMaterialsHash:'0'.repeat(64)}),/原材料绑定已有变化/);
  const stale=store.createCandidate(),badMeta=read(stale.metaFile);badMeta.baseMaterialsHash='0'.repeat(64);write(stale.metaFile,badMeta);assert.throws(()=>store.reviewCandidate(stale.candidateId),/原材料绑定已改变/);
});
