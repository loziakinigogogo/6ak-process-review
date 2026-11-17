'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const load=()=>import('../frontend/src/node-materials.mjs');
test('node materials use exact source lines, merge overlaps, include condition/premise evidence and never substitute processed wording',async()=>{
  const {nodeMaterialsFor}=await load();
  const evidence=(startLine,endLine,sourceId='doc')=>({sourceId,startLine,endLine,quote:'not used as reconstructed source'});
  const model={nodes:[{id:'a',claimIds:['action','inference','unlocated','invalid']}],relations:[{from:'a',claimIds:['condition'],conditionClaimIds:['condition']}],sources:[{id:'doc',name:'合成原稿',text:'标题\n原稿第一行\n原稿第二行\n条件原话\n间隔\n推断前提\n末尾'}],claims:[
    {id:'action',text:'改写后的动作',evidence:[evidence(2,3),evidence(3,3)]},
    {id:'condition',text:'改写后的条件',evidence:[evidence(4,4)]},
    {id:'inference',text:'整理推断',evidence:[],premiseIds:['premise']},
    {id:'premise',text:'不是原文',evidence:[evidence(6,6)]},
    {id:'unlocated',text:'无依据内容',evidence:[]},
    {id:'invalid',text:'不能伪造原文',evidence:[evidence(20,21)]},
  ]};
  const before=structuredClone(model),result=nodeMaterialsFor(model,'a');
  assert.deepEqual(result.excerpts.map(item=>[item.startLine,item.endLine,item.text]),[[2,4,'原稿第一行\n原稿第二行\n条件原话'],[6,6,'推断前提']]);
  assert.deepEqual(result.unlocatedClaimIds,['inference','unlocated']);assert.equal(result.unavailable.length,1);assert.deepEqual(model,before);
  assert.ok(result.excerpts.every(item=>!item.text.includes('改写后')));
});
test('attached feedback is not duplicated as source documents; other manual sources retain their own identity',async()=>{
  const {nodeMaterialsFor}=await load();
  const model={nodes:[{id:'a',claimIds:['adopted','manual']}],relations:[],sources:[{id:'wb-content-attachment-r1',name:'用户补充',kind:'user-feedback',text:'原话'},{id:'manual-source',name:'用户直接修订',kind:'user-feedback',text:'修订输入'}],claims:[{id:'adopted',evidence:[{sourceId:'wb-content-attachment-r1',startLine:1,endLine:1}]},{id:'manual',evidence:[{sourceId:'manual-source',startLine:1,endLine:1}]}]};
  const result=nodeMaterialsFor(model,'a',{entries:[{id:'attachment',nodeId:'a',revisions:[{revision:1}]}]});
  assert.deepEqual(result.excerpts,[]);assert.deepEqual(result.feedbackReferences,[{sourceId:'manual-source',name:'用户直接修订'}]);
});
test('persistent bindings display historical source lines without current claims, and never resolve a different source hash',async()=>{
  const {nodeMaterialsFor}=await load();
  const source={id:'doc',name:'原稿',text:'保留的原话\n另一行',sha256:'a'.repeat(64)};
  const model={nodes:[{id:'a',claimIds:[]}],relations:[],claims:[],sources:[]};
  const materials={bindings:[{nodeId:'a',sourceId:'doc',sourceHash:source.sha256,startLine:1,endLine:1}],sources:[source]};
  assert.equal(nodeMaterialsFor(model,'a',undefined,materials).excerpts[0].text,'保留的原话');
  const mismatched={...materials,sources:[{...source,text:'冒充同一原稿',sha256:'b'.repeat(64)}]};
  const rejected=nodeMaterialsFor(model,'a',undefined,mismatched);assert.deepEqual(rejected.excerpts,[]);assert.equal(rejected.unavailable.length,1);
});
