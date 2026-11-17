'use strict';
const crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const sourceKey=source=>`${source.id}:${digest(source.text)}`;
const isMaterialSource=source=>source.kind!=='user-feedback'||!source.id.startsWith('wb-content-');

function collectBindings(model) {
  const claims=new Map(model.claims.map(claim=>[claim.id,claim]));
  const sources=new Map(model.sources.filter(isMaterialSource).map(source=>[source.id,source]));
  const bindings=[];
  for(const node of model.nodes){
    const ids=new Set(node.claimIds);
    for(const relation of model.relations.filter(edge=>edge.from===node.id))for(const id of [...relation.claimIds,...relation.conditionClaimIds])ids.add(id);
    const visited=new Set();
    const visit=id=>{if(visited.has(id))return;visited.add(id);for(const premise of claims.get(id)?.premiseIds||[]){ids.add(premise);visit(premise);}};
    let size;
    do{size=ids.size;
      for(const rule of model.rules||[])if(rule.claimIds.some(id=>ids.has(id)))for(const id of [...rule.claimIds,...Object.values(rule.parameters||{}).flat()])ids.add(id);
      for(const issue of model.issues||[])if(issue.nodeIds.includes(node.id)||issue.claimIds?.some(id=>ids.has(id)))for(const id of [...(issue.claimIds||[]),...(issue.resolutionClaimIds||[])])ids.add(id);
      [...ids].forEach(visit);
    }while(ids.size!==size);
    for(const id of ids)for(const evidence of claims.get(id)?.evidence||[]){
      const source=sources.get(evidence.sourceId);if(!source)continue;
      const {startLine,endLine}=evidence;
      if(!Number.isInteger(startLine)||!Number.isInteger(endLine)||startLine<1||endLine<startLine||endLine>source.text.split('\n').length)continue;
      bindings.push({nodeId:node.id,sourceId:source.id,sourceHash:digest(source.text),startLine,endLine});
    }
  }
  return mergeBindings(bindings);
}

function mergeBindings(...lists){
  const groups=new Map();
  for(const binding of lists.flat()){
    const key=JSON.stringify([binding.nodeId,binding.sourceId,binding.sourceHash]);
    const ranges=groups.get(key)||[];ranges.push(binding);groups.set(key,ranges);
  }
  const result=[];
  for(const key of [...groups.keys()].sort()){
    const merged=[];
    for(const binding of groups.get(key).sort((a,b)=>a.startLine-b.startLine||a.endLine-b.endLine)){
      const previous=merged.at(-1);
      if(previous&&binding.startLine<=previous.endLine+1)previous.endLine=Math.max(previous.endLine,binding.endLine);
      else merged.push({...binding});
    }
    result.push(...merged);
  }
  return result;
}

function validateArchive(value,ErrorType=Error){
  if(!value||![1,2].includes(value.schemaVersion)||!Number.isSafeInteger(value.revision)||value.revision<1||!Array.isArray(value.bindings)||value.bindings.some(item=>!item||typeof item.nodeId!=='string'||typeof item.sourceId!=='string'||!/^[a-f0-9]{64}$/.test(item.sourceHash)||!Number.isInteger(item.startLine)||!Number.isInteger(item.endLine)||item.startLine<1||item.endLine<item.startLine))throw new ErrorType('原材料绑定格式不受支持，已保留文件。',422);
  if(value.schemaVersion===2&&value.bindings.some(item=>typeof item.id!=='string'||!Number.isSafeInteger(item.revision)||item.revision<1||!Array.isArray(item.revisions)||!item.revisions.length))throw new ErrorType('原材料历史格式不受支持，已保留文件。',422);
  return value;
}
const coordinates=entry=>({nodeId:entry.nodeId,sourceId:entry.sourceId,sourceHash:entry.sourceHash,startLine:entry.startLine,endLine:entry.endLine});
const sameRange=(a,b)=>JSON.stringify(coordinates(a))===JSON.stringify(coordinates(b));
function revisionOf(entry,at,author){return{...coordinates(entry),revision:entry.revision,archived:!!entry.archived,at,author};}
function upgradeArchive(value,at=new Date().toISOString()){
  if(value?.schemaVersion===2)return structuredClone(value);
  return {schemaVersion:2,revision:value?.revision||1,bindings:(value?.bindings||[]).map(binding=>{
    const entry={...binding,id:`material-${digest(JSON.stringify(coordinates(binding))).slice(0,24)}`,revision:1,origin:'model-evidence',author:'import',createdAt:at,updatedAt:at,archived:false};
    return {...entry,revisions:[revisionOf(entry,at,'import')]};
  })};
}
function retainBindings(archive,models,at=new Date().toISOString()){
  let changed=false;
  const sources=new Map(models.flatMap(model=>model.sources).map(source=>[sourceKey(source),source]));
  for(const binding of models.flatMap(collectBindings)){
    // Output evidence is merged into ranges. Subtract every known historical
    // range before retaining gaps: an adjacent new line must not bring back an
    // archived or superseded input hidden inside the merged evidence range.
    const known=archive.bindings.flatMap(entry=>[entry,...entry.revisions]).filter(old=>old.nodeId===binding.nodeId&&old.sourceId===binding.sourceId&&old.sourceHash===binding.sourceHash&&old.endLine>=binding.startLine&&old.startLine<=binding.endLine).sort((a,b)=>a.startLine-b.startLine||a.endLine-b.endLine);
    const gaps=[];let start=binding.startLine;
    for(const old of known){if(old.startLine>start)gaps.push({startLine:start,endLine:old.startLine-1});start=Math.max(start,old.endLine+1);if(start>binding.endLine)break;}
    if(start<=binding.endLine)gaps.push({startLine:start,endLine:binding.endLine});
    for(const range of gaps){
      const next={...binding,...range};
      const entry={...next,id:`material-${digest(JSON.stringify(coordinates(next))).slice(0,24)}`,revision:1,origin:sources.get(`${next.sourceId}:${next.sourceHash}`)?.kind==='user-feedback'?'legacy-feedback':'model-evidence',author:'import',createdAt:at,updatedAt:at,archived:false};
      archive.bindings.push({...entry,revisions:[revisionOf(entry,at,'import')]});changed=true;
    }
  }
  return changed;
}
function mutateMaterials(archive,payload,state,sources,ErrorType){
  const fail=(message,code=400)=>{throw new ErrorType(message,code);};
  if(!state.model.nodes.some(node=>node.id===payload.nodeId))fail('节点已不存在，材料未保存。',409);
  let entry;
  if(payload.operation!=='attach'){
    entry=archive.bindings.find(item=>item.id===payload.materialId&&item.nodeId===payload.nodeId&&!item.archived);
    if(!entry)fail('原文材料已不存在，请核对最新材料后重试。',409);
    if(entry.origin==='legacy-feedback')fail('历史用户原话只读，请新增材料说明需要更正的内容。',409);
  }
  if(payload.operation==='attach'||payload.operation==='update'){
    const source=sources.find(item=>item.id===payload.sourceId&&item.kind!=='user-feedback'&&digest(item.text)===payload.sourceHash);
    if(!source)fail('原稿版本不匹配，请从当前任务的原稿中选择。',409);
    const {startLine,endLine}=payload;
    if(!Number.isInteger(startLine)||!Number.isInteger(endLine)||startLine<1||endLine<startLine||endLine>source.text.split('\n').length)fail('原文行号超出来源范围。');
    const next={nodeId:payload.nodeId,sourceId:source.id,sourceHash:digest(source.text),startLine,endLine};
    const duplicate=archive.bindings.find(item=>!item.archived&&sameRange(item,next));
    if(duplicate){if(payload.operation==='attach'||duplicate.id===entry?.id)return{unchanged:true,entry:duplicate};fail('本节点已挂载相同原文片段，请保留现有条目。',409);}
    if(payload.operation==='attach'){
      if(archive.bindings.length>=10000)fail('材料数量过多，请先整理已有材料。');
      entry={id:crypto.randomUUID(),nodeId:payload.nodeId,revision:0,origin:'user-attached',author:'local-user',createdAt:new Date().toISOString(),revisions:[]};archive.bindings.push(entry);
    }
    Object.assign(entry,next,{archived:false});
  }else if(payload.operation==='archive')entry.archived=true;
  else fail('不支持的原文材料操作。');
  const at=new Date().toISOString();entry.revision++;entry.updatedAt=at;entry.revisions.push(revisionOf(entry,at,'local-user'));archive.revision++;
  return {entry};
}
module.exports={collectBindings,mergeBindings,validateArchive,sourceKey,isMaterialSource,upgradeArchive,retainBindings,mutateMaterials};
