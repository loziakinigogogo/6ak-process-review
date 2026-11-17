import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { captureVisit, currentVisit, navigateBack, navigateOrigin, navigateTo, restoreNavigation, type DirectoryState, type NavigationState, type ReadingFocus, type VisitSnapshot } from './node-navigation.mjs';

/** Visit snapshots contain reading state only; material drafts have their own node keys. */
export function useNodeWorkspace({workspaceId,selectedNodeId,visible,ready,onSelect,onStorageError}:{workspaceId:string;selectedNodeId?:string;visible:boolean;ready:boolean;onSelect:(id:string)=>void;onStorageError:()=>void}) {
  const key=`6ak.workbench.${workspaceId}.node-workspace-navigation`;
  const [navigation,setNavigation]=useState(()=>{try{return restoreNavigation(localStorage.getItem(key),selectedNodeId);}catch{return restoreNavigation(null,selectedNodeId);}});
  const navigationRef=useRef(navigation);
  const workspaceScroll=useRef<HTMLDivElement>(null),directoryScroll=useRef<HTMLDivElement>(null);
  const lastFocus=useRef<ReadingFocus|undefined>(undefined);
  const lastFocusedElement=useRef<HTMLElement|null>(null);
  const restorePending=useRef(true),restoring=useRef(false),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const persistFailure=useRef(false),previousVisible=useRef(visible);
  const current=currentVisit(navigation),directory=current?.directory||{groupId:'all',query:'',collapsedGroupIds:[],scrollTop:0};
  const readingKey=(element:HTMLDetailsElement,index:number)=>element.dataset.readingKey||element.closest<HTMLElement>('[data-material-id]')?.dataset.materialId&&`material:${element.closest<HTMLElement>('[data-material-id]')!.dataset.materialId}:${element.className}`||element.closest<HTMLElement>('[data-content-id]')?.dataset.contentId&&`note:${element.closest<HTMLElement>('[data-content-id]')!.dataset.contentId}:${element.className}`||`details:${index}`;
  const focusFor=(element:Element|null):ReadingFocus|undefined=>{
    if(!(element instanceof HTMLElement)||!workspaceScroll.current?.contains(element))return lastFocus.current;
    const label=element.getAttribute('aria-label'),testId=element.dataset.testid;
    const focusKey=element.dataset.focusKey||(label?`label:${label}`:testId?`test:${testId}`:undefined);
    if(!focusKey)return lastFocus.current;
    const input=element as HTMLInputElement;
    return {key:focusKey,...(typeof input.selectionStart==='number'?{selectionStart:input.selectionStart,selectionEnd:input.selectionEnd||input.selectionStart}:{})};
  };
  const snapshot=():VisitSnapshot=>({reading:{scrollTop:workspaceScroll.current?.scrollTop||0,expandedKeys:[...(workspaceScroll.current?.querySelectorAll<HTMLDetailsElement>('details')||[])].flatMap((detail,index)=>detail.open?[readingKey(detail,index)]:[]),focus:focusFor(workspaceScroll.current?.contains(document.activeElement)?document.activeElement:lastFocusedElement.current)||null},directory:{...currentVisit(navigationRef.current)?.directory,scrollTop:directoryScroll.current?.scrollTop||0}});
  const save=(next:NavigationState,render=true)=>{
    navigationRef.current=next;if(render)setNavigation(next);
    try{localStorage.setItem(key,JSON.stringify(next));}catch{if(!persistFailure.current){persistFailure.current=true;onStorageError();}}
  };
  const capture=()=>{if(restoring.current||!previousVisible.current)return;save(captureVisit(navigationRef.current,snapshot()),false);};
  const queueCapture=()=>{clearTimeout(timer.current);timer.current=setTimeout(capture,100);};
  const switchTo=(next:NavigationState)=>{clearTimeout(timer.current);restorePending.current=true;lastFocus.current=undefined;lastFocusedElement.current=null;save(next);const visit=currentVisit(next);if(visit)onSelect(visit.nodeId);};
  const navigate=(nodeId:string,startChain=false)=>switchTo(navigateTo(navigationRef.current,nodeId,snapshot(),'node',startChain));
  const back=()=>switchTo(navigateBack(navigationRef.current,snapshot()));
  const origin=()=>switchTo(navigateOrigin(navigationRef.current,snapshot()));
  const visitAt=(index:number)=>{const next=captureVisit(navigationRef.current,snapshot());if(index>=0&&index<next.visits.length){next.index=index;switchTo(next);}};
  const changeDirectory=(patch:Partial<DirectoryState>)=>{save(captureVisit(navigationRef.current,{...snapshot(),directory:{...currentVisit(navigationRef.current)?.directory,...patch}}));if(patch.scrollTop!==undefined&&directoryScroll.current)directoryScroll.current.scrollTop=patch.scrollTop;};
  const locate=(groupId:string)=>{
    const active=currentVisit(navigationRef.current);if(!active)return;
    const next=navigateTo(navigationRef.current,active.nodeId,snapshot(),'locate');
    switchTo(captureVisit(next,{directory:{groupId,query:'',collapsedGroupIds:active.directory.collapsedGroupIds.filter(id=>id!==groupId),scrollTop:0}}));
  };
  useLayoutEffect(()=>{
    if(!visible){previousVisible.current=false;return;}
    const entering=!previousVisible.current;previousVisible.current=true;
    if(selectedNodeId&&currentVisit(navigationRef.current)?.nodeId!==selectedNodeId){switchTo(navigateTo(navigationRef.current,selectedNodeId,entering?undefined:snapshot(),'node',true));return;}
    if(entering)restorePending.current=true;
  },[visible,selectedNodeId]);
  useLayoutEffect(()=>{
    if(!visible||!ready||!restorePending.current||!current)return;
    restoring.current=true;
    let second=0;
    const first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>{
      const active=currentVisit(navigationRef.current);if(!active||active.visitId!==current.visitId){restoring.current=false;return;}
      workspaceScroll.current?.querySelectorAll<HTMLDetailsElement>('details').forEach((detail,index)=>{detail.open=active.reading.expandedKeys.includes(readingKey(detail,index));});
      if(directoryScroll.current)directoryScroll.current.scrollTop=active.directory.scrollTop;
      if(workspaceScroll.current)workspaceScroll.current.scrollTop=active.reading.scrollTop;
      const focus=active.reading.focus;
      if(focus){const element=[...(workspaceScroll.current?.querySelectorAll<HTMLElement>('[aria-label],[data-testid],[data-focus-key]')||[])].find(item=>item.dataset.focusKey===focus.key||`label:${item.getAttribute('aria-label')}`===focus.key||`test:${item.dataset.testid}`===focus.key);
        if(element){element.focus({preventScroll:true});if(focus.selectionStart!==undefined&&(element instanceof HTMLInputElement||element instanceof HTMLTextAreaElement)){try{element.setSelectionRange(focus.selectionStart,focus.selectionEnd??focus.selectionStart);}catch{}}}lastFocus.current=focus;}
      restorePending.current=false;restoring.current=false;
    });});
    return()=>{cancelAnimationFrame(first);cancelAnimationFrame(second);restoring.current=false;};
  },[current?.visitId,visible,selectedNodeId,ready]);
  useEffect(()=>{const element=workspaceScroll.current;const changed=()=>queueCapture();element?.addEventListener('toggle',changed,true);return()=>element?.removeEventListener('toggle',changed,true);},[key]);
  useEffect(()=>{const leave=()=>capture();const beforeHide=()=>{capture();clearTimeout(timer.current);};window.addEventListener('pagehide',leave);window.addEventListener('6ak:capture-node-workspace',beforeHide);return()=>{clearTimeout(timer.current);capture();window.removeEventListener('pagehide',leave);window.removeEventListener('6ak:capture-node-workspace',beforeHide);};},[key]);
  return {navigation,current,directory,workspaceScroll,directoryScroll,navigate,back,origin,visitAt,locate,changeDirectory,capture,queueCapture,trackFocus:()=>{if(document.activeElement instanceof HTMLElement&&workspaceScroll.current?.contains(document.activeElement))lastFocusedElement.current=document.activeElement;lastFocus.current=focusFor(document.activeElement);queueCapture();}};
}
