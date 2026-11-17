import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, FilePlus2, X } from 'lucide-react';
import type { MaterialContext, MaterialEntry, MaterialSource } from './node-materials.mjs';

export type MaterialSelection = {nodeId:string;sourceId:string;sourceHash:string;startLine:number;endLine:number;text:string};
type Input = {requestId:string;operation:'attach'|'update'|'archive';materialId?:string;sourceId:string;sourceHash:string;startLine:number;endLine:number;baseMaterialsHash:string;pending?:boolean};
// Retain unsaved ranges across keyed editor remounts even when browser storage fails.
const sourceInputs=new Map<string,Input|null>();
function readInput(key:string):Input|null {if(sourceInputs.has(key))return sourceInputs.get(key)||null;try{return JSON.parse(localStorage.getItem(key)||'null');}catch{return null;}}
export function retainedSourceInputs(workspaceId:string):Record<string,Input>{const prefix=`6ak.workbench.${workspaceId}.source-material-input.`;const result:Record<string,Input>={};try{for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i)!;if(key.startsWith(prefix)){const value=readInput(key);if(value)result[key.slice(prefix.length)]=value;}}}catch{}for(const [key,value] of sourceInputs)if(key.startsWith(prefix)){if(value)result[key.slice(prefix.length)]=value;else delete result[key.slice(prefix.length)];}return result;}
type Props = {nodeId:string;nodeTitle:string;workspaceId:string;materials?:MaterialContext;sources:MaterialSource[];enabled:boolean;api:<T=any>(url:string,body?:unknown,method?:string)=>Promise<T>;onState:(state:any)=>void;onNotify:(text:string,kind?:'info'|'success'|'error')=>void;onCopy:(selection:MaterialSelection)=>Promise<void>};

/** The form owns only a source/range selection. Source text is never edited. */
export function SourceMaterialEditor({nodeId,nodeTitle,workspaceId,materials,sources,enabled,api,onState,onNotify,onCopy}:Props) {
  const key=`6ak.workbench.${workspaceId}.source-material-input.${nodeId}`;
  const [form,setForm]=useState<Input|null>(()=>readInput(key));
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[selection,setSelection]=useState<MaterialSelection|null>(null);
  const [open,setOpen]=useState(!!form);
  const editor=useRef<HTMLFormElement>(null);
  const [focusRequest,setFocusRequest]=useState(0);
  useEffect(()=>{const sync=(event:Event)=>{if(event instanceof CustomEvent&&event.detail?.key!==key)return;const saved=readInput(key);setForm(saved);if(!saved)setOpen(false);};window.addEventListener('6ak:source-input-changed',sync);window.addEventListener('storage',sync);return()=>{window.removeEventListener('6ak:source-input-changed',sync);window.removeEventListener('storage',sync);};},[key]);
  const sourceOptions=sources.filter(source=>source.kind!=='user-feedback');
  const versions=[...sourceOptions,...(materials?.sources||[])];
  const sourceFor=(id:string,hash?:string)=>versions.find(source=>source.id===id&&(!hash||source.sha256===hash));
  const entries=(materials?.entries||[]).filter(entry=>entry.nodeId===nodeId&&!entry.archived);
  const archived=(materials?.entries||[]).filter(entry=>entry.nodeId===nodeId&&entry.archived);
  const store=(next:Input|null)=>{sourceInputs.set(key,next);setForm(next);try{if(next)localStorage.setItem(key,JSON.stringify(next));else localStorage.removeItem(key);}catch{setError('浏览器暂不能保留输入；当前页面切换节点仍可继续，刷新前请先保存材料。');}window.dispatchEvent(new CustomEvent('6ak:source-input-changed',{detail:{key}}));};
  const begin=(entry?:MaterialEntry)=>{
    if(!enabled)return;
    if(form){setOpen(true);setFocusRequest(value=>value+1);return;}
    const source=entry?sourceFor(entry.sourceId,entry.sourceHash):sourceOptions[0];
    if(!source){setError('当前没有可挂载的源文档，请先添加原话材料。');return;}
    store({requestId:crypto.randomUUID(),operation:entry?'update':'attach',materialId:entry?.id,sourceId:source.id,sourceHash:source.sha256||'',startLine:entry?.startLine||1,endLine:entry?.endLine||1,baseMaterialsHash:materials?.hash||''});setOpen(true);setFocusRequest(value=>value+1);setError('');
  };
  useEffect(()=>{if(open&&focusRequest)requestAnimationFrame(()=>{editor.current?.scrollIntoView({block:'nearest'});editor.current?.querySelector<HTMLSelectElement>('select')?.focus({preventScroll:true});});},[focusRequest]);
  const update=(patch:Partial<Input>)=>{if(!form||form.pending||busy)return;store({...form,...patch,requestId:crypto.randomUUID()});};
  const submit=async(input=form)=>{
    if(!input||busy||!enabled)return;
    setBusy(true);setError('');store({...input,pending:true});
    try{const next=await api('/api/workbench/materials',{...input,nodeId,pending:undefined});onState(next);const latest=readInput(key);if(!latest||latest.requestId===input.requestId){store(null);setOpen(false);}onNotify('节点材料已保存；现行节点结果未自动改变。');}
    catch(cause){if((cause as {status?:number}).status){const latest=readInput(key);if(latest?.requestId===input.requestId)store({...input,pending:false});}setError((cause as Error).message);}
    finally{setBusy(false);}
  };
  const archive=(entry:MaterialEntry)=>{
    if(form){setOpen(true);setError('请先处理已保留的文档片段输入，再移除材料。');return;}
    void submit({requestId:crypto.randomUUID(),operation:'archive',materialId:entry.id,sourceId:entry.sourceId,sourceHash:entry.sourceHash,startLine:entry.startLine,endLine:entry.endLine,baseMaterialsHash:materials?.hash||''});
  };
  const capture=(event:React.MouseEvent<HTMLElement>,entry:MaterialEntry)=>{
    const selected=window.getSelection();const text=selected?.toString().trim();
    if(!text||!selected?.rangeCount){setSelection(null);return;}
    const range=selected.getRangeAt(0),element=event.currentTarget;
    if(!element.contains(range.startContainer)||!element.contains(range.endContainer)){setSelection(null);return;}
    setSelection({nodeId,sourceId:entry.sourceId,sourceHash:entry.sourceHash,startLine:entry.startLine,endLine:entry.endLine,text});
  };
  const chosen=form&&sourceFor(form.sourceId,form.sourceHash),lines=chosen?.text.split('\n')||[];
  const valid=!!form&&Number.isInteger(form.startLine)&&Number.isInteger(form.endLine)&&form.startLine>=1&&form.endLine>=form.startLine&&form.endLine<=lines.length;
  const stale=!!form&&form.baseMaterialsHash!==materials?.hash;
  return <section className="source-materials" aria-label="源文档片段">
    <div className="content-section-title"><h4>源文档片段</h4>{enabled&&<button className="secondary-button" data-testid="add-source-material" onClick={()=>begin()}><FilePlus2 size={14}/>挂载文档片段</button>}</div>
    {open&&form&&<form ref={editor} className="content-composer source-material-composer" data-testid="source-material-composer" data-editor-node-id={nodeId} onSubmit={event=>{event.preventDefault();void submit();}}>
      <fieldset disabled={busy||form.pending||!enabled}>
        <div className="content-section-title"><strong>{form.materialId?'修订文档片段':'挂载文档片段'}</strong><button type="button" className="icon-button" aria-label="收起文档片段输入" onClick={()=>setOpen(false)}><X size={14}/></button></div>
        <p className="composer-target">材料归属「{nodeTitle}」；选取真实行段，原文保持只读。</p>
        <label>源文档<select aria-label="材料源文档" value={form.sourceId} onChange={event=>{const source=sourceOptions.find(item=>item.id===event.target.value)!;update({sourceId:source.id,sourceHash:source.sha256||'',startLine:1,endLine:1});}}>{sourceOptions.map(source=><option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
        <div className="content-form-row"><label>起始行<input type="number" aria-label="材料起始行" min={1} max={lines.length} value={form.startLine} onChange={event=>update({startLine:Number(event.target.value)})}/></label><label>结束行<input type="number" aria-label="材料结束行" min={1} max={lines.length} value={form.endLine} onChange={event=>update({endLine:Number(event.target.value)})}/></label></div>
        <details className="source-material-document"><summary>查阅文档行号 · {lines.length} 行</summary><pre>{lines.map((line,index)=>`${index+1}  ${line}`).join('\n')}</pre></details>
        {valid?<pre className="source-material-preview" data-testid="source-material-preview">{lines.slice(form.startLine-1,form.endLine).join('\n')}</pre>:<p className="content-error">请选择文档内有效的起止行。</p>}
        {stale&&!form.pending&&<p className="content-conflict">材料有了新修改，输入仍保留。<button type="button" className="quiet-button" onClick={()=>update({baseMaterialsHash:materials?.hash||''})}>已核对，继续保存</button></p>}
        <footer><span>选择保留在此浏览器</span><button type="button" className="secondary-button" onClick={()=>{store(null);setOpen(false);setError('');}}>放弃输入</button><button className="primary-button" data-testid="save-source-material" disabled={!valid||stale}>保存材料</button></footer>
      </fieldset>
      {form.pending&&!busy&&<p className="content-conflict">上次保存结果尚未确认，输入已保留。<button type="button" className="primary-button" data-testid="retry-source-material" onClick={()=>void submit()}>确认上次保存结果</button></p>}
    </form>}
    {!open&&form&&<button className="quiet-button" onClick={()=>setOpen(true)}>继续未完成的文档片段输入</button>}
    {error&&<p className="content-error" role="alert">{error}</p>}
    {entries.map(entry=>{const source=sourceFor(entry.sourceId,entry.sourceHash),legacy=source?.kind==='user-feedback',text=source?.text.split('\n').slice(entry.startLine-1,entry.endLine).join('\n');return <article className="source-material-entry" key={entry.id} data-material-id={entry.id}>
      <details className="source-material" data-source-id={entry.sourceId} data-source-hash={entry.sourceHash} data-start-line={entry.startLine} data-end-line={entry.endLine}>
        <summary><span>{legacy?'历史用户原话 · ':''}{source?.name||entry.sourceId} · 第 {entry.startLine===entry.endLine?entry.startLine:`${entry.startLine}–${entry.endLine}`} 行</span><ChevronDown size={13}/></summary>
        {text!==undefined?<p className="source-material-text" data-testid="source-material-text" data-material-node-id={nodeId} onMouseUp={event=>capture(event,entry)}>{text}</p>:<p className="material-gap">来源版本暂不可读取，保留原绑定，需核对材料。</p>}
      </details>
      <div className="content-entry-origin"><span>材料版本 {entry.revision} · {entry.adoptedRevisions?.includes(entry.revision)?'已用于当前结果':entry.adoptedRevisions?.length?'材料已更新 · 等待重新整理':'待核对整理'}</span>{enabled&&!legacy&&<><button onClick={()=>begin(entry)}>修订片段</button><button onClick={()=>archive(entry)} disabled={busy}>移出节点</button></>}</div>
      {!!entry.revisions?.length&&entry.revisions.length>1&&<details className="content-revisions"><summary>片段修改记录 · {entry.revisions.length}</summary>{entry.revisions.map(revision=><p key={revision.revision}>版本 {revision.revision} · {revision.sourceId} · 第 {revision.startLine}–{revision.endLine} 行{revision.archived?' · 已移出':''}</p>)}</details>}
    </article>;})}
    {!entries.length&&<p className="content-empty">尚未挂载源文档片段。可以直接选取文档行段，或添加原话材料。</p>}
    {selection&&enabled&&<button className="quiet-button" data-testid="copy-material-selection" onClick={()=>void onCopy(selection)}><Copy size={13}/>复制所选原文引用</button>}
    {!!archived.length&&<details className="content-revisions"><summary>已移出的材料 · {archived.length}</summary>{archived.map(entry=><p key={entry.id}>{sourceFor(entry.sourceId,entry.sourceHash)?.name||entry.sourceId} · 第 {entry.startLine}–{entry.endLine} 行 · 记录保留</p>)}</details>}
  </section>;
}
