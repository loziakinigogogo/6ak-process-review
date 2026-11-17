'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createStore}=require('./workbench-store.cjs');
const {createDemoModel}=require('./workbench-demo-fixture.cjs');
const {startServer,runningService,main,WORKBENCH_PROTOCOL}=require('./workbench.cjs');
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
function setup(){const task=path.resolve('.qa/node-inputs-unit',crypto.randomUUID());return{task,store:createStore(task,{model:createDemoModel()})};}
function payload(store,extra={}){const source=store.read().model.sources[0];return{requestId:crypto.randomUUID(),nodeId:'validate',operation:'attach',baseMaterialsHash:store.materials().hash,sourceId:source.id,sourceHash:digest(source.text),startLine:1,endLine:1,...extra};}
function guard(store){const s=store.read();return{baseWorkRevision:s.workRevision,baseModelHash:s.modelHash,baseContentHash:store.context().contentTree.hash,baseMaterialsHash:store.materials().hash};}
function reference(store,extra={}){return store.createReference({...guard(store),targets:[{type:'node',id:'validate'}],allNodeMaterials:true,...extra});}
function editCandidate(store,change){const candidate=store.createCandidate();const model=JSON.parse(fs.readFileSync(candidate.modelFile,'utf8'));change(model);fs.writeFileSync(candidate.modelFile,JSON.stringify(model));const review=store.reviewCandidate(candidate.candidateId);store.applyCandidate({candidateId:candidate.candidateId,reviewHash:review.reviewHash});return candidate;}

test('direct source input is independent, exact-range deduplicated, guarded and replayable without changing business content',()=>{
 const {task,store}=setup(),before=store.read(),request=payload(store),source=before.model.sources[0];
 assert.ok(!store.materials().bindings.some(item=>item.nodeId==='validate'&&item.startLine===1));
 store.materialEdit(request);const first=store.materials(),entry=first.bindings.find(item=>item.origin==='user-attached');
 assert.ok(entry);assert.equal(entry.nodeId,'validate');assert.equal(store.read().workRevision,before.workRevision);assert.equal(store.read().modelHash,before.modelHash);assert.deepEqual(store.read().model.sources,before.model.sources);
 store.materialEdit(request);assert.equal(store.materials().hash,first.hash);
 store.materialEdit(payload(store));assert.equal(store.materials().hash,first.hash);assert.equal(store.materials().bindings.filter(item=>item.id===entry.id).length,1);
 assert.throws(()=>store.materialEdit({...request,endLine:2}),/同一个保存请求编号/);
 assert.throws(()=>store.materialEdit(payload(store,{sourceHash:'0'.repeat(64)})),/原稿版本/);
 assert.throws(()=>store.materialEdit(payload(store,{endLine:source.text.split('\n').length+1})),/行号/);
 const ref=reference(store,{materialSelection:{nodeId:'validate',sourceId:source.id,sourceHash:digest(source.text),startLine:1,endLine:1,text:source.text.split('\n')[0]}});
 assert.ok(ref.context.materials.bindings.some(item=>item.id===entry.id));assert.deepEqual(ref.context.model,store.read().model);assert.equal(ref.materialSelection.nodeId,'validate');
 assert.throws(()=>reference(store,{materialSelection:{...ref.materialSelection,nodeId:'manual'}}),/选文/);
 const draft=store.createCandidate({referenceId:ref.id});
 store.materialEdit(payload(store,{operation:'update',materialId:entry.id,endLine:2}));
 assert.equal(store.reference(ref.id).stale,true);assert.throws(()=>store.reviewCandidate(draft.candidateId),/原材料绑定已改变/);
 const updated=store.materials().entries.find(item=>item.id===entry.id);assert.equal(updated.revision,2);assert.equal(updated.revisions[0].endLine,1);assert.equal(updated.revisions[1].endLine,2);
 assert.equal(createStore(task).materials().hash,store.materials().hash);
});

test('archived or revised evidence material is never resurrected by current output, candidate apply, undo, or archive recovery',()=>{
 const {task,store}=setup();const original=store.materials().bindings.find(item=>item.nodeId==='validate');
 store.materialEdit({requestId:crypto.randomUUID(),operation:'archive',nodeId:'validate',materialId:original.id,baseMaterialsHash:store.materials().hash});
 const assertArchived=s=>{assert.ok(!s.materials().bindings.some(item=>item.id===original.id));assert.equal(s.materials().entries.find(item=>item.id===original.id).archived,true);};
 assertArchived(store);editCandidate(store,model=>{model.nodes.find(node=>node.id==='validate').title='材料与结果独立';});assertArchived(store);
 store.undo(guard(store));assertArchived(store);assertArchived(createStore(task));
 const attached=payload(store,{startLine:1,endLine:2});store.materialEdit(attached);const before=store.materials();
 fs.unlinkSync(path.join(task,'workbench/material-bindings.json'));
 const recovered=createStore(task);assertArchived(recovered);assert.ok(recovered.materials().bindings.some(item=>item.origin==='user-attached'&&item.startLine===1));assert.equal(recovered.materials().hash,before.hash);
 const hash=recovered.materials().hash;for(let i=0;i<3;i++)assert.equal(createStore(task).materials().hash,hash);
});

test('whole-node handoff includes all raw input natures and retains old wording revisions without treating questions as facts',()=>{
 const {task,store}=setup();for(const kind of ['fact','reminder','proposal','question'])store.contentEdit({requestId:crypto.randomUUID(),operation:'create',nodeId:'validate',entryType:'note',kind,title:kind,text:`${kind} 原始内容`,baseContentRevision:store.context().contentTree.revision});
 const first=reference(store);assert.equal(first.contentInputs.length,4);assert.deepEqual(new Set(first.contentInputs.map(item=>item.kind)),new Set(['fact','reminder','proposal','question']));
 const candidate=store.createCandidate({referenceId:first.id});assert.equal(candidate.feedbackSources.length,1);assert.equal(candidate.feedbackSources[0].text,'fact 原始内容');
 const note=first.contentInputs.find(item=>item.kind==='question');store.contentEdit({requestId:crypto.randomUUID(),operation:'update',nodeId:'validate',entryId:note.id,entryType:'note',kind:'question',title:'question',text:'修订后的问题，仍未确认',baseContentRevision:store.context().contentTree.revision});
 assert.equal(store.reference(first.id).stale,true);assert.throws(()=>store.reviewCandidate(candidate.candidateId),/节点补充已改变/);
 const reopened=createStore(task),entry=reopened.context().contentTree.entries.find(item=>item.id===note.id);assert.equal(entry.revisions.length,2);assert.equal(entry.revisions[0].text,'question 原始内容');assert.equal(reference(reopened).contentInputs.find(item=>item.id===note.id).text,'修订后的问题，仍未确认');
});

test('HTTP exposes verifiable capabilities and source editing returns the same materials snapshot as context',async()=>{
 const {task}=setup(),app=await startServer({taskDirectory:task});
 try{
  const health=await fetch(app.url+'/api/health').then(r=>r.json());assert.deepEqual(health.workbenchProtocol,WORKBENCH_PROTOCOL);assert.equal((await runningService(task)).compatible,true);
  const initial=await fetch(app.url+'/api/workbench/state').then(r=>r.json());assert.deepEqual(initial.workbenchProtocol,WORKBENCH_PROTOCOL);
  const result=await fetch(app.url+'/api/workbench/materials',{method:'POST',headers:{Origin:app.url,'X-Workbench-Id':initial.workspaceId,'Content-Type':'application/json'},body:JSON.stringify(payload(app.store))});assert.equal(result.status,200);const saved=await result.json();
  const context=await fetch(app.url+'/api/workbench/context?nodeId=validate').then(r=>r.json());assert.equal(saved.materials.hash,context.materials.hash);assert.equal(saved.modelHash,initial.modelHash);assert.equal(saved.workRevision,initial.workRevision);
 }finally{await app.close();}
});

test('v1 archive migration preserves business identity and invalidates versioned old inputs while unversioned legacy references stay readable',()=>{
 const {task,store}=setup(),state=store.read(),current=store.materials(),ref=reference(store);
 const bindings=current.bindings.map(({nodeId,sourceId,sourceHash,startLine,endLine})=>({nodeId,sourceId,sourceHash,startLine,endLine}));
 const legacy={schemaVersion:1,revision:current.revision,bindings};fs.writeFileSync(path.join(task,'workbench/material-bindings.json'),JSON.stringify(legacy));
 const refFile=path.join(task,'workbench/references',ref.id+'.json'),saved=JSON.parse(fs.readFileSync(refFile,'utf8'));saved.materialsHash=digest(JSON.stringify(legacy));fs.writeFileSync(refFile,JSON.stringify(saved));
 const migrated=createStore(task);assert.equal(migrated.read().workRevision,state.workRevision);assert.equal(migrated.read().modelHash,state.modelHash);assert.equal(migrated.materials().schemaVersion,2);assert.equal(migrated.reference(ref.id).stale,true);
 delete saved.materialsHash;fs.writeFileSync(refFile,JSON.stringify(saved));assert.equal(migrated.reference(ref.id).stale,false);
 assert.equal(createStore(task).materials().hash,migrated.materials().hash);
});

test('service reuse detects a live old backend and refuses new writes or silent reuse',async()=>{
 const {task}=setup(),http=require('node:http');const instanceId=crypto.randomUUID();
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,taskDirectory:task,instanceId}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
 fs.writeFileSync(path.join(task,'workbench/runtime.json'),JSON.stringify({url,instanceId,workspaceId:'legacy'}));
 try{assert.equal((await runningService(task)).compatible,false);await assert.rejects(()=>main(['serve','--task',task]),/旧工作台/);await assert.rejects(()=>main(['candidate','--task',task]),/服务尚未更新/);}finally{await new Promise(resolve=>server.close(resolve));}
});

test('new adjacent and overlapping evidence retains only gaps outside archived and superseded input ranges',()=>{
 const {upgradeArchive,retainBindings,mutateMaterials}=require('./workbench-material-bindings.cjs');
 const source={id:'range-source',name:'range-source',text:Array.from({length:10},(_,i)=>`原稿第${i+1}行`).join('\n')},sourceHash=digest(source.text);
 const modelFor=ranges=>({sources:[source],nodes:[{id:'n',claimIds:ranges.map((_,i)=>'c'+i)}],claims:ranges.map(([startLine,endLine],i)=>({id:'c'+i,evidence:[{sourceId:source.id,startLine,endLine,quote:source.text.split('\n').slice(startLine-1,endLine).join('\n')}]})),relations:[],rules:[],issues:[]});
 const archiveFor=(startLine,endLine)=>upgradeArchive({schemaVersion:1,revision:1,bindings:[{nodeId:'n',sourceId:source.id,sourceHash,startLine,endLine}]});
 const archived=archiveFor(1,2);archived.bindings[0].archived=true;
 assert.equal(retainBindings(archived,[modelFor([[1,2],[3,3]])]),true);
 assert.deepEqual(archived.bindings.filter(item=>!item.archived).map(item=>[item.startLine,item.endLine]),[[3,3]]);
 retainBindings(archived,[modelFor([[2,5]])]);
 assert.deepEqual(archived.bindings.filter(item=>!item.archived).map(item=>[item.startLine,item.endLine]),[[3,3],[4,5]]);
 assert.equal(retainBindings(archived,[modelFor([[1,5]])]),false,'reading repeated output cannot resurrect or duplicate known ranges');
 const revised=archiveFor(2,4),entry=revised.bindings[0];entry.startLine=8;entry.endLine=9;entry.revision=2;entry.revisions.push({nodeId:'n',sourceId:source.id,sourceHash,startLine:8,endLine:9,revision:2,archived:false});
 retainBindings(revised,[modelFor([[1,6]])]);
 assert.deepEqual(revised.bindings.map(item=>[item.startLine,item.endLine]),[[8,9],[1,1],[5,6]],'both sides of a superseded range are split without reviving the old middle');
 mutateMaterials(archived,{operation:'attach',nodeId:'n',sourceId:source.id,sourceHash,startLine:1,endLine:2},{model:modelFor([])},[source],Error);
 assert.ok(archived.bindings.some(item=>!item.archived&&item.origin==='user-attached'&&item.startLine===1&&item.endLine===2),'an explicit user reattachment remains allowed');
});

test('legacy adopted direct edits retain genuine user words as read-only node inputs after their output is replaced',()=>{
 const {task,store}=setup(),words='旧版直接修订的真实原话，必须保留而非冒充原稿。';
 store.edit({...guard(store),requestId:crypto.randomUUID(),nodeId:'validate',intent:'current',claims:[{id:'validate-actions',text:words}]});
 const source=store.read().model.sources.find(item=>item.kind==='user-feedback'&&item.text===words),entry=store.materials().bindings.find(item=>item.sourceId===source.id);
 assert.ok(source);assert.equal(entry.origin,'legacy-feedback');assert.equal(store.context('validate').contentTree.entries.length,0,'migration must not invent a contentTree author or history');
 editCandidate(store,model=>{const node=model.nodes.find(item=>item.id==='validate');node.claimIds=node.claimIds.filter(id=>!model.claims.find(claim=>claim.id===id)?.evidence.some(e=>e.sourceId===source.id));node.claimIds.push('validate-actions');node.fields.actions=['validate-actions'];});
 const file=path.join(task,'workbench/material-bindings.json'),archive=JSON.parse(fs.readFileSync(file,'utf8'));archive.bindings=archive.bindings.filter(item=>item.sourceId!==source.id);fs.writeFileSync(file,JSON.stringify(archive));
 const reopened=createStore(task),restored=reopened.materials().bindings.find(item=>item.sourceId===source.id);assert.ok(restored,'already initialized v2 archives also recover committed old words');
 const ref=reference(reopened);assert.equal(ref.context.materials.sources.find(item=>item.id===source.id).text,words);assert.ok(ref.context.materials.bindings.some(item=>item.nodeId==='validate'&&item.sourceId===source.id));
 assert.throws(()=>reopened.materialEdit(payload(reopened,{operation:'update',materialId:restored.id,sourceId:source.id,sourceHash:digest(source.text)})),/历史用户原话只读/);
 assert.throws(()=>reopened.materialEdit(payload(reopened,{operation:'attach',sourceId:source.id,sourceHash:digest(source.text)})),/原稿版本/);
 assert.equal(reopened.materials().hash,createStore(task).materials().hash);
});
