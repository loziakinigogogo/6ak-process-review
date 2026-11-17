import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, getViewportForBounds, MarkerType, useKeyPress, useReactFlow, applyNodeChanges, type NodeProps, type Node as FlowNode, type Edge as FlowEdge, type NodeChange, type Viewport } from '@xyflow/react';
import { ArrowDownRight, ArrowRight, Check, ChevronDown, Copy, Download, FileText, GitBranch, History, Info, Layers3, LoaderCircle, Maximize2, Minus, Pencil, Plus, RotateCcw, Save, Search, Waypoints, X, AlertCircle, PanelRightClose, PanelRightOpen, Network, Pin, PinOff, Undo2, ListRestart } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { sourceLocationsFor } from './source-locations.mjs';
import { nodeMaterialsFor, type MaterialContext } from './node-materials.mjs';
import { getGraphScope } from './graph-scope.mjs';
import { arrangeGraph, relationPorts, routeGeometryKey, type RelationPort } from './graph-layout.mjs';
import { layoutInputKey } from './graph-layout-input.mjs';
import { ProcessEdge, ProcessHandles, measureEdgeLabel, processEdgeColor, useProcessRoutes, type ScopedLayout, type Point } from './graph-routing';
import { PRESETS, STRUCTURE_PRESETS, buildPresetTask, formatPresetHandoff } from '../../shared/workbench-presets.mjs';
import { AgentTaskPreview, type TaskQuote } from './agent-task-preview';
import { fieldLabels, relationLabels, legacyStructureHandoff, type LegacyStructureDraft } from './structure-draft';
import { NodeProse, nodeProseContext } from './node-prose';
import { NodeContent, ContentTreeRead, type ContentTree } from './node-content';
import './node-content.css';

type Claim = { id: string; text: string; origin: string; evidence: Array<{ sourceId: string; startLine: number; endLine: number; quote: string }>; premiseIds?: string[]; rationale?: string; issueIds?: string[] };
type ModelNode = { id: string; title: string; groupId: string; claimIds: string[]; fields: Record<string, string[]> };
type Relation = { id: string; from: string; to: string; type: string; claimIds: string[]; conditionClaimIds: string[] };
type Model = { report: { id: string; title: string; scope: string; limitations: string[] }; nodes: ModelNode[]; groups: Array<{ id: string; title: string; kind: string }>; claims: Claim[]; relations: Relation[]; sources: Array<{ id: string; name: string; text: string; sha256?:string; kind?: string }>; rules?: Array<{id:string;title:string;claimIds:string[];parameters:Record<string,string[]>}>; issues: Array<{ id: string; question: string; status: string; type?: string; claimIds?: string[]; resolutionClaimIds?: string[]; nodeIds: string[]; relationIds: string[]; impact: string }> };
type LayoutDirection = 'DOWN' | 'RIGHT';
type DirectionMode = 'AUTO' | LayoutDirection;
type WorkState = { workbenchProtocol?:{name:string;version:number;capabilities:string[]}; workspaceId: string; contentTree?: ContentTree; materials?: MaterialContext; contentOrigin?: { kind: 'synthetic' | 'documents'; label: string; sourceNames: string[] }; stateRevision: number; workRevision: number; modelHash: string; preferenceHash?: string; model: Model; view: { workMode?: 'read'|'edit'; contentView?: 'graph'|'content'; positions: Record<string, Point>; layouts?: Record<string, ScopedLayout>; horizontalLayouts?: Record<string, ScopedLayout>; defaultLayoutDirection?: DirectionMode; layoutDirections?: Record<string, { mode: DirectionMode; revision: number }>; manualNodeIds?: string[]; selectedGroupId?: string; selectedNodeId?: string; viewport?: Viewport }; pendingEdits: any[]; changes: any[]; updatedAt: string; lastSave?: { kind: string; message: string } };
type BranchDraft = { id: string; to: string; conditions: Array<{ id: string; text: string }> };
type Draft = { nodeId: string; nodeSnapshot: ModelNode; branchTypes: Record<string, string>; title: string; groupId: string; claims: Array<{ id: string; text: string }>; branches: BranchDraft[]; baseTitle: string; baseGroupId: string; baseClaims: Array<{ id: string; text: string }>; baseBranches: BranchDraft[]; baseWorkRevision: number; baseModelHash: string; intent: 'current' | 'proposal'; dirty: boolean; revision: number };
type Selection = { type: string; id: string; label: string };
type ChosenQuote = { text: string; claimId: string; source?: { id: string; start: number; end: number } };
type VerifiedQuote = ChosenQuote & TaskQuote;
type AgentTask = {
  presetId: string;
  task: string;
  processingTargets: Selection[];
  referenceAnchors: Selection[];
  referenceTargets: Selection[];
  quote?: VerifiedQuote;
  draft?: string;
  includeDraft: boolean;
  workRevision: number;
  modelHash: string;
};
type Toast = { text: string; kind: 'success' | 'error' | 'info' };
const groupColors = ['#477e60', '#527c9b', '#a17736', '#81709a', '#a15d70', '#608381'];
const groupStyle = (index: number) => ({ '--group-color': groupColors[(index + groupColors.length) % groupColors.length] }) as React.CSSProperties;
const clone = <T,>(value: T): T => structuredClone(value);
const stamp = () => crypto.randomUUID();
function readLocal<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
function writeLocal(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Project persistence remains authoritative. */ } }
function readPendingPositions(): Record<string, Record<string, Point>> { try { return JSON.parse(sessionStorage.getItem(cacheKey('pending-positions')) || '{}'); } catch { return {}; } }
function writePendingPositions(value: Record<string, Record<string, Point>>) { try { sessionStorage.setItem(cacheKey('pending-positions'), JSON.stringify(value)); } catch { /* The pending positions stay visible in memory for retry. */ } }
const sessionId = 'local-reviewer';
let workspaceIdentity: string | null = null;
const cacheKey = (kind: string) => `6ak.workbench.${workspaceIdentity || 'uninitialized'}.${kind}`;
// Legacy cache keys and view.layouts continue to mean the vertical layout.
const layoutViewKey = (scopeId: string, direction: LayoutDirection) => direction === 'DOWN' ? scopeId : `${scopeId}:RIGHT`;
const parseLayoutViewKey = (key: string): { scopeId: string; direction: LayoutDirection } => key.endsWith(':RIGHT') ? { scopeId: key.slice(0, -6), direction: 'RIGHT' } : { scopeId: key, direction: 'DOWN' };
const scopedLayout = (state: WorkState | null, scopeId: string, direction: LayoutDirection) => direction === 'RIGHT' ? state?.view.horizontalLayouts?.[scopeId] : state?.view.layouts?.[scopeId];

async function api<T = any>(url: string, body?: unknown, method = 'POST'): Promise<T> {
  if (body !== undefined && !workspaceIdentity) throw new Error('工作区还未载入，请稍后保存。');
  const response = await fetch(url, body === undefined ? { cache: 'no-store' } : { method, headers: { 'Content-Type': 'application/json', 'X-Workbench-Id': workspaceIdentity! }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || data.message || '操作未完成，请重试。'), { status: response.status, details: data });
  if (data.workspaceId) {
    if (workspaceIdentity && workspaceIdentity !== data.workspaceId) throw Object.assign(new Error('这个地址现在属于另一个工作区。当前输入仍保留，请重新打开目标任务。'), { status: 409, workspaceMismatch: true });
    workspaceIdentity = data.workspaceId;
  }
  return data;
}

function draftFor(state: WorkState, id: string): Draft | undefined {
  const item = state.model.nodes.find(n => n.id === id);
  if (!item) return;
  const claims = item.claimIds.map(id => state.model.claims.find(c => c.id === id)).filter((c): c is Claim => !!c).map(c => ({ id: c.id, text: c.text }));
  const branches = state.model.relations.filter(r => r.from === id).map(r => ({ id: r.id, to: r.to, conditions: r.conditionClaimIds.map(id => ({ id, text: state.model.claims.find(c => c.id === id)?.text || '' })) }));
  return { nodeId: id, nodeSnapshot: clone(item), branchTypes: Object.fromEntries(state.model.relations.filter(r => r.from === id).map(r => [r.id, r.type])), title: item.title, groupId: item.groupId, claims, branches, baseTitle: item.title, baseGroupId: item.groupId, baseClaims: clone(claims), baseBranches: clone(branches), baseWorkRevision: state.workRevision, baseModelHash: state.modelHash, intent: 'current', dirty: false, revision: Date.now() };
}

function nodeDraftText(draft: Draft, model: Model): string {
  const lines = [`W${draft.baseWorkRevision} · ${draft.baseTitle}`];
  if (draft.title !== draft.baseTitle) lines.push(`图上名称：${draft.title}`);
  if (draft.groupId !== draft.baseGroupId) lines.push(`整理分组：${model.groups.find(group => group.id === draft.groupId)?.title || draft.groupId}`);
  for (const claim of draft.claims) {
    const previous = draft.baseClaims.find(item => item.id === claim.id);
    if (previous?.text === claim.text) continue;
    const field = Object.keys(draft.nodeSnapshot.fields).find(key => draft.nodeSnapshot.fields[key].includes(claim.id));
    lines.push(`${field ? fieldLabels[field] : '节点内容'}：将「${previous?.text || ''}」改为「${claim.text}」`);
  }
  for (const branch of draft.branches) {
    const previous = draft.baseBranches.find(item => item.id === branch.id);
    if (previous?.to !== branch.to) lines.push(`待议出口去向：${model.nodes.find(node => node.id === branch.to)?.title || '尚未选择'}`);
    for (const condition of branch.conditions) {
      const previousCondition = previous?.conditions.find(item => item.id === condition.id);
      if (previousCondition?.text !== condition.text) lines.push(`待议条件：将「${previousCondition?.text || ''}」改为「${condition.text}」`);
    }
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

function AgentControl({ busy, target, onPreset, onLegacy, onMaterials }: {
  busy: boolean;
  target: Selection;
  onPreset: (id: string) => void;
  onLegacy?: () => void;
  onMaterials?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const controlId = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const choose = (action: () => void) => {
    action();
    setOpen(false);
    trigger.current?.focus();
  };
  return <div className="agent-control" data-target-type={target.type} ref={container}>
    <div className="agent-target" id={`${controlId}-target`}>
      <span>{target.type === 'relation' ? '当前连线' : '当前节点'}</span>
      <strong data-testid="agent-target">{target.label}</strong>
    </div>
    <button className="primary-button agent-action" ref={trigger} disabled={busy} aria-expanded={open} aria-controls={open ? `${controlId}-instructions` : undefined}
      aria-describedby={`${controlId}-target`} data-testid="agent-action" onClick={() => setOpen(!open)}>
      {busy && <LoaderCircle size={13} className="spin" />}<span>交给 Agent</span><ChevronDown size={13} />
    </button>
    {open && <div className="agent-instructions" id={`${controlId}-instructions`} role="group" aria-label="Agent 指令">
      {onMaterials&&<button data-testid="refine-node-materials" disabled={busy} onClick={()=>choose(onMaterials)}>提炼这些材料</button>}
      {[...STRUCTURE_PRESETS, ...PRESETS].map(preset => <button key={preset.id} disabled={busy} data-testid={`preset-${preset.id}`} onClick={() => choose(() => onPreset(preset.id))}>{preset.label}</button>)}
      {onLegacy && <button className="legacy-agent-draft" data-testid="copy-legacy-structure-draft" onClick={() => choose(onLegacy)}>复制上次的结构草稿</button>}
    </div>}
  </div>;
}

function resolveAgentTarget(model: Model, item: Selection): Selection | undefined {
  if (item.type === 'node') {
    const node = model.nodes.find(entry => entry.id === item.id);
    return node && { ...item, label: node.title };
  }
  const edge = item.type === 'relation' && model.relations.find(entry => entry.id === item.id);
  if (!edge) return;
  const from = model.nodes.find(node => node.id === edge.from)?.title || edge.from;
  const to = model.nodes.find(node => node.id === edge.to)?.title || edge.to;
  return { ...item, label: `${from} → ${to}（${relationLabels[edge.type] || edge.type}）` };
}

function relationReferenceTargets(model: Model, processingTargets: Selection[], referenceAnchors: Selection[]): Selection[] {
  const processingKeys = new Set(processingTargets.map(target => `${target.type}:${target.id}`));
  const references = new Map<string, Selection>();
  for (const target of referenceAnchors) references.set(`${target.type}:${target.id}`, target);
  for (const target of [...processingTargets, ...referenceAnchors]) {
    if (target.type !== 'relation') continue;
    const edge = model.relations.find(relation => relation.id === target.id);
    if (!edge) continue;
    for (const id of [edge.from, edge.to]) {
      const node = model.nodes.find(node => node.id === id);
      if (node) references.set(`node:${id}`, { type: 'node', id, label: node.title });
    }
  }
  return [...references.values()].filter(target => !processingKeys.has(`${target.type}:${target.id}`));
}

function verifyAgentQuote(model: Model, selected: ChosenQuote | null | undefined): VerifiedQuote | undefined {
  if (!selected?.text.trim()) return;
  const claim = model.claims.find(item => item.id === selected.claimId);
  if (!claim) return;
  const source = selected.source;
  if (!source) return claim.text.includes(selected.text) ? selected : undefined;
  const evidence = claim.evidence.find(item => item.sourceId === source.id && item.startLine === source.start && item.endLine === source.end);
  if (!evidence?.quote.includes(selected.text)) return;
  const name = model.sources.find(item => item.id === source.id)?.name || source.id;
  return { ...selected, sourceLabel: `${name} · 第 ${source.start}${source.end !== source.start ? `–${source.end}` : ''} 行` };
}

function hasStructureChanges(draft: Draft) {
  return draft.groupId !== draft.baseGroupId || draft.branches.some(branch =>
    draft.baseBranches.find(item => item.id === branch.id)?.to !== branch.to);
}

function textChanges(draft: Draft) {
  const claims = draft.claims.filter(claim => draft.baseClaims.find(item => item.id === claim.id)?.text !== claim.text);
  const branches = draft.branches.map(branch => {
    const original = draft.baseBranches.find(item => item.id === branch.id);
    return { id: branch.id, conditions: branch.conditions.filter(condition =>
      original?.conditions.find(item => item.id === condition.id)?.text !== condition.text) };
  }).filter(branch => branch.conditions.length);
  return {
    ...(draft.title !== draft.baseTitle ? { title: draft.title } : {}),
    ...(claims.length ? { claims } : {}),
    ...(branches.length ? { branches } : {}),
  };
}

// A save can finish while the user is already writing the next sentence.
// Carry only those subsequent edits onto the exact revision that was saved.
function carryNewerInput(submitted: Draft, latest: Draft, saved: WorkState): Draft | undefined {
  const result = draftFor(saved, submitted.nodeId); if (!result) return;
  result.title = latest.title !== submitted.title ? latest.title : result.title;
  result.groupId = latest.groupId !== submitted.groupId ? latest.groupId : result.groupId;
  for (const claim of latest.claims) {
    if (submitted.claims.find(c => c.id === claim.id)?.text === claim.text) continue;
    let mappedId = result.claims.find(c => c.id === claim.id)?.id;
    if (!mappedId) for (const [field, ids] of Object.entries(submitted.nodeSnapshot?.fields || {})) {
      const index = ids.indexOf(claim.id);
      if (index >= 0 && result.nodeSnapshot.fields[field]?.length === ids.length) mappedId = result.nodeSnapshot.fields[field][index];
    }
    const mapped = result.claims.find(c => c.id === mappedId); if (!mapped) return;
    mapped.text = claim.text;
  }
  for (const branch of latest.branches) {
    const old = submitted.branches.find(b => b.id === branch.id);
    if (JSON.stringify(old) === JSON.stringify(branch)) continue;
    const mapped = result.branches.find(b => b.id === branch.id); if (!mapped || !old || mapped.conditions.length !== old.conditions.length) return;
    if (branch.to !== old.to) mapped.to = branch.to;
    for (const condition of branch.conditions) {
      const index = old.conditions.findIndex(c => c.id === condition.id); if (index < 0) return;
      if (condition.text !== old.conditions[index].text) mapped.conditions[index].text = condition.text;
    }
  }
  result.intent = latest.intent; result.dirty = true; result.revision = Math.max(Date.now(), latest.revision + 1);
  return result;
}

function CompactTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const element = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const textarea = element.current;
    if (!textarea || CSS.supports('field-sizing', 'content')) return;
    let width = 0;
    const resize = () => {
      if (!textarea.offsetWidth || textarea.offsetWidth === width) return;
      width = textarea.offsetWidth;
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [props.value, props.readOnly]);
  return <textarea {...props} className={['compact-textarea', props.className].filter(Boolean).join(' ')} rows={1} ref={element} />;
}

function ProcessCard({ data, selected }: NodeProps) {
  const item = data as { title: string; role: string; actions: Claim[]; hasDetails: boolean; onActions: () => void; onDetails: () => void; groupIndex: number; groupTitle: string; displayNo: number; context: boolean; issueCount: number; unknownCount: number; changed: boolean; draft: boolean; outgoing: number };
  // Until a separately evidenced editorial summary exists, show a complete short
  // source statement only. Long or multiple operations remain in full in details.
  const summary = item.actions.length === 1 && item.actions[0].text.length <= 90 ? item.actions[0] : null;
  return <div className={`process-card ${selected ? 'is-selected' : ''} ${item.context ? 'context-node' : ''} ${item.draft ? 'has-draft' : ''}`} style={groupStyle(item.groupIndex)} data-testid={`graph-node-${String(data.nodeId)}`} data-group-id={String(data.groupId)} data-context={item.context ? 'true' : 'false'} data-manual={data.manual ? 'true' : 'false'}>
    <ProcessHandles nodeId={String(data.nodeId)} direction={data.direction as LayoutDirection} ports={data.ports as RelationPort[] | undefined} />
    <div className="node-eyebrow"><span className="node-group-badge group-badge" title={item.groupTitle} aria-label={`${item.groupTitle}，组内 ${item.displayNo} 号`}><b>{item.displayNo}</b></span>{item.context && <span className="context-badge">组外</span>}{item.changed && <i className="changed-dot" title="本轮已修改" />}{Boolean(data.manual) && <Pin size={12} className="node-pin" aria-label="已固定位置" />}</div>
    <div className="node-title">{item.title}</div>
    {item.role && <div className="node-role" title={item.role}>{item.role}</div>}
    {summary && <div className="node-actions" aria-label="操作说明"><p data-claim-id={summary.id}>{summary.text}</p></div>}
    {(item.actions.length > 0 || item.hasDetails) && <div className="node-card-links">
      {item.actions.length > 0 && !summary && <button type="button" className="node-detail-hint node-actions-link nodrag nopan" onClick={event => { event.stopPropagation(); item.onActions(); }}>{item.actions.length === 1 ? '查看完整操作' : `查看全部 ${item.actions.length} 条操作`} <ArrowRight size={11}/></button>}
      {item.hasDetails && <button type="button" className="node-detail-hint nodrag nopan" onClick={event=>{event.stopPropagation();item.onDetails();}}>查看节点详情 <ArrowRight size={11}/></button>}
    </div>}
    <div className="node-meta"><span>{item.outgoing > 1 ? <><GitBranch size={11}/> {item.outgoing} 条路径</> : null}</span>{item.issueCount > 0 && <span className="node-issue"><AlertCircle size={11}/> {item.issueCount} 待确认</span>}{!item.issueCount && item.unknownCount > 0 && <span className="node-issue"><AlertCircle size={11}/> {item.unknownCount} 项未说明</span>}{item.draft && <span className="node-draft">有待恢复输入</span>}</div>
  </div>;
}

const nodeTypes = { process: ProcessCard };
const edgeTypes = { process: ProcessEdge };

function Workbench() {
  const [state, setState] = useState<WorkState | null>(null);
  const [loadingError, setLoadingError] = useState('');
  const [connected, setConnected] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [group, setGroup] = useState('all');
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [bufferStatus, setBufferStatus] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [proseLocation,setProseLocation] = useState<{nodeId:string;section:string;revision:number}|null>(null);
  const [contentView, setContentView] = useState<'graph'|'content'>('graph');
  const [composeRequest, setComposeRequest] = useState(0);
  const [expandedDetailsId, setExpandedDetailsId] = useState<string | null>(null);
  const [actionsFocusId, setActionsFocusId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 760);
  const [narrowWindow, setNarrowWindow] = useState(() => window.innerWidth <= 760);
  const contentViewRef=useRef(contentView);contentViewRef.current=contentView;
  const graphBox=useRef<{width:number;height:number}|null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => window.innerWidth <= 760);
  const [selection, setSelection] = useState<Selection[]>([]);
  const [chosenText, setChosenText] = useState<ChosenQuote | null>(null);
  const [agentTask, setAgentTask] = useState<AgentTask | null>(null);
  const agentTaskReturnFocus = useRef<HTMLButtonElement | null>(null);
  const [agentTaskError, setAgentTaskError] = useState('');
  const [agentTaskFallback, setAgentTaskFallback] = useState('');
  const [copyBusy, setCopyBusy] = useState(false);
  const [referenceFallback, setReferenceFallback] = useState('');
  const [legacyStructureDraft, setLegacyStructureDraft] = useState<LegacyStructureDraft | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [graphToolsOpen, setGraphToolsOpen] = useState(false);
  const [flowNodes, setFlowNodes] = useState<FlowNode[]>([]);
  const [layoutOperation, setLayoutOperation] = useState<string | null>(null);
  const [layoutMessage, setLayoutError] = useState('');
  const [moveVersion, setMoveVersion] = useState(0);
  const [movingCount, setMovingCount] = useState(0);
  const [direction, setDirection] = useState<LayoutDirection>('DOWN');
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [savingDirection, setSavingDirection] = useState(false);
  const [draggingNode, setDraggingNode] = useState(false);
  const directionMode = state?.view.layoutDirections?.[group]?.mode || state?.view.defaultLayoutDirection || 'DOWN';
  const automaticDirection: LayoutDirection = canvasSize.width >= canvasSize.height ? 'RIGHT' : 'DOWN';
  const desiredDirection = directionMode === 'AUTO' ? automaticDirection : directionMode;
  const canvasReady = canvasSize.width > 0 && canvasSize.height > 0;
  const viewKey = layoutViewKey(group, direction);
  const cardWidth = direction === 'RIGHT' ? 240 : 200;
  const positionOverrides = useRef<Record<string, Record<string, Point>>>({});
  const moveQueue = useRef<Promise<void>>(Promise.resolve());
  const layoutRequest = useRef(0);
  const initialLayoutAttempts = useRef(new Set<string>());
  const automaticLayoutAttempts = useRef(new Set<string>());
  const layoutError = layoutMessage || (!movingCount && Object.keys(positionOverrides.current[viewKey] || {}).length ? '此图有尚未保存的位置，请重试保存。' : '');
  const rf = useReactFlow();
  const selectingMultiple = useKeyPress('Shift');
  const stateRef = useRef(state); stateRef.current = state;
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const bufferTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const initialized = useRef(false);
  const restorationComplete = useRef(false);
  const viewInitialized = useRef<string>('');
  const graphElement = useRef<HTMLDivElement>(null);
  const actionsHeading = useRef<HTMLHeadingElement>(null);
  const viewportFrame = useRef<number | null>(null);
  const viewportRequest = useRef(0);
  const groupRef = useRef(group); groupRef.current = group;
  const directionRef = useRef(direction); directionRef.current = direction;
  const viewKeyRef = useRef(viewKey); viewKeyRef.current = viewKey;
  const navigationCollapsedRef = useRef(navigationCollapsed); navigationCollapsedRef.current = navigationCollapsed;
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightFetch = useRef(0);
  const [lastSavedAt, setLastSavedAt] = useState('');

  const notify = useCallback((text: string, kind: Toast['kind'] = 'success') => setToast({ text, kind }), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 5500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 760px)');
    const collapseNavigation = () => { setNarrowWindow(narrow.matches); if (narrow.matches) setNavigationCollapsed(true); };
    narrow.addEventListener('change', collapseNavigation);
    return () => narrow.removeEventListener('change', collapseNavigation);
  }, []);
  const acceptState = useCallback((next: WorkState) => {
    if (stateRef.current && next.stateRevision < stateRef.current.stateRevision) return;
    if (stateRef.current && next.modelHash !== stateRef.current.modelHash) {
      let removed = 0;
      for (const [key, positions] of Object.entries(positionOverrides.current)) {
        const { scopeId } = parseLayoutViewKey(key);
        const visible = getGraphScope(next.model, scopeId).visibleIds;
        for (const id of Object.keys(positions)) if (!visible.has(id)) { delete positions[id]; removed++; }
      }
      if (removed) {
        writePendingPositions(positionOverrides.current); setMoveVersion(value => value + 1);
        notify('流程结构已更新，已清理离开原分组的待保存位置。其他位置仍保留。', 'info');
      }
    }
    stateRef.current = next;
    setState(previous => !previous || next.stateRevision >= previous.stateRevision ? next : previous);
    setDrafts(previous => {
      const nextDrafts = { ...previous };
      for (const [id, draft] of Object.entries(previous)) if (!draft.dirty) { const refreshed = draftFor(next, id); if (refreshed) nextDrafts[id] = refreshed; }
      return nextDrafts;
    });
  }, [notify]);

  const fetchState = useCallback(async () => {
    const request = ++inflightFetch.current;
    try {
      const next = await api<WorkState>('/api/workbench/state');
      if (request !== inflightFetch.current) return;
      const localBuffers = !initialized.current ? readLocal<Record<string, Draft>>(cacheKey('drafts'), {}) : {};
      acceptState(next); setLoadingError('');
      if (!initialized.current) {
        initialized.current = true;
        setContentView(next.view.contentView || 'graph');
        const storedStructure = readLocal<LegacyStructureDraft | null>(cacheKey('structure-draft'), null);
        if (storedStructure?.requestId && storedStructure.operation) setLegacyStructureDraft(storedStructure);
        const pending = readPendingPositions();
        positionOverrides.current = {};
        for (const [key, positions] of Object.entries(pending)) {
          const { scopeId, direction: pendingDirection } = parseLayoutViewKey(key);
          if (scopeId !== 'all' && !next.model.groups.some(g => g.id === scopeId)) continue;
          const ids = getGraphScope(next.model, scopeId).visibleIds;
          const retained = Object.entries(positions || {}).filter(([id, point]) => {
            const saved = scopedLayout(next, scopeId, pendingDirection)?.positions[id] || (pendingDirection === 'DOWN' ? next.view.positions[id] : undefined);
            return ids.has(id) && point && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 1000000 && Math.abs(point.y) <= 1000000 && (saved?.x !== point.x || saved?.y !== point.y);
          });
          if (retained.length) positionOverrides.current[key] = Object.fromEntries(retained);
        }
        writePendingPositions(positionOverrides.current);
        setMoveVersion(value => value + 1);
        const selected = next.view.selectedNodeId || readLocal<string | null>(cacheKey('selected'), null);
        const savedGroup = readLocal<string | null>(cacheKey('group'), null) || next.view.selectedGroupId;
        const focus = next.model.nodes.find(n => n.id === selected) || (next.contentOrigin?.kind === 'synthetic' ? next.model.nodes.find(n => n.id === 'validate') : undefined) || next.model.nodes.find(n => n.groupId === savedGroup) || next.model.nodes[0];
        setSelectedId(focus?.id || null);
        setGroup(savedGroup && (savedGroup === 'all' || next.model.groups.some(g => g.id === savedGroup)) ? savedGroup : focus?.groupId || 'all');
        const diskBuffers = await api<Record<string, any>>(`/api/workbench/buffers?sessionId=${encodeURIComponent(sessionId)}`).catch(() => ({}));
        const restored: Record<string, Draft> = {};
        for (const [id, entry] of Object.entries(diskBuffers)) { const d = (entry as any)?.draft || entry; if (d?.dirty && d?.nodeId) restored[d.nodeId] = d; }
        for (const [id, d] of Object.entries(localBuffers)) if (d?.dirty && (!restored[id] || d.revision > restored[id].revision)) restored[id] = d;
        restorationComplete.current = true;
        setDrafts(current => ({ ...restored, ...current }));
        if (Object.keys(restored).length) notify(`已恢复 ${Object.keys(restored).length} 个节点的编辑稿`, 'info');
      }
    } catch (cause) { if (!stateRef.current) setLoadingError((cause as Error).message); else if ((cause as any).workspaceMismatch) { setConnected(false); setError((cause as Error).message); notify((cause as Error).message, 'error'); } }
  }, [acceptState, notify]);

  useEffect(() => { void fetchState(); const events = new EventSource('/api/workbench/events'); events.onopen = () => setConnected(true); events.onerror = () => setConnected(false); events.addEventListener('state', () => { void fetchState(); }); const focus = () => { void fetchState(); }; window.addEventListener('focus', focus); return () => { events.close(); window.removeEventListener('focus', focus); }; }, [fetchState]);
  useEffect(() => { if (state && restorationComplete.current) writeLocal(cacheKey('drafts'), drafts); }, [drafts, state?.workspaceId]);
  const persistBuffer = useCallback(async (draft: Draft) => {
    const isCurrent = () => !draftsRef.current[draft.nodeId] || draftsRef.current[draft.nodeId].revision === draft.revision;
    if (isCurrent()) setBufferStatus(previous => ({ ...previous, [draft.nodeId]: 'saving' }));
    try { await api('/api/workbench/buffers', { sessionId, nodeId: draft.nodeId, revision: draft.revision, draft }, 'PUT'); if (isCurrent()) setBufferStatus(previous => ({ ...previous, [draft.nodeId]: 'saved' })); }
    catch (cause) { if (isCurrent()) { setBufferStatus(previous => ({ ...previous, [draft.nodeId]: (cause as any).status === 409 ? 'conflict' : 'local' })); if ((cause as any).status === 409 && selectedRef.current === draft.nodeId) setError('另一窗口保存了较新的编辑稿。本窗口的输入仍已保留，请核对后保存节点。'); } }
  }, []);
  const updateDraft = useCallback((id: string, change: (draft: Draft) => void) => {
    const currentState = stateRef.current; if (!currentState) return;
    const next = clone(draftsRef.current[id] || draftFor(currentState, id)); if (!next) return;
    change(next); next.dirty = true; next.revision = Math.max(Date.now(), next.revision + 1);
    draftsRef.current = { ...draftsRef.current, [id]: next }; setDrafts(draftsRef.current);
    setBufferStatus(previous => ({ ...previous, [id]: 'editing' }));
    const oldTimer = bufferTimers.current.get(id); if (oldTimer) clearTimeout(oldTimer);
    bufferTimers.current.set(id, setTimeout(() => { bufferTimers.current.delete(id); void persistBuffer(next); }, 650));
    setError('');
  }, [persistBuffer]);

  const currentNode = state?.model.nodes.find(n => n.id === selectedId) || drafts[selectedId || '']?.nodeSnapshot;
  const draft = currentNode && state ? drafts[selectedId!] || draftFor(state, selectedId!) : undefined;
  const editingCopy = !!currentNode && editingNodeId === currentNode.id;
  useEffect(() => { if (editingCopy && currentNode) setExpandedDetailsId(currentNode.id); }, [editingCopy, currentNode?.id]);
  useLayoutEffect(() => {
    if (!actionsFocusId || actionsFocusId !== selectedId || !inspectorOpen || !actionsHeading.current) return;
    actionsHeading.current.focus({ preventScroll: true });
    actionsHeading.current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    setActionsFocusId(null);
  }, [actionsFocusId, selectedId, inspectorOpen]);
  const displayFields = currentNode?.fields || {};
  const selectedIssues = state ? nodeProseContext(state.model,selectedId||'').issues.filter(issue=>issue.status==='open') : [];
  const selectedClaims = currentNode?.claimIds.map(id => state?.model.claims.find(c => c.id === id)).filter((c): c is Claim => !!c) || [];
  const currentGroup = state?.model.groups.find(g => g.id === group);
  const scope = useMemo(() => getGraphScope(state?.model || { nodes: [], relations: [] }, group), [state?.model, group]);
  const geometryEdges = useMemo(() => (scope.relations as Relation[]).map(relation => {
    const label = relation.conditionClaimIds.map(id => state?.model.claims.find(c => c.id === id)?.text || '').join('；') || (['return', 'data', 'association'].includes(relation.type) ? relationLabels[relation.type] : '');
    return { id: relation.id, from: relation.from, to: relation.to, type: relation.type, label, ...measureEdgeLabel(label) };
  }), [scope.relations, state?.model]);
  const ports = useMemo(() => relationPorts(geometryEdges), [geometryEdges]);
  const visibleModelNodes = scope.nodes as ModelNode[];
  const visibleIds = scope.visibleIds;
  const crossRelations = scope.crossGroupRelations as Relation[];
  const currentLayout = scopedLayout(state, group, direction);
  const supportsLayoutRefresh = !!state?.workbenchProtocol?.capabilities.includes('graph-layout-refresh-v1');
  const initialLayoutKey = `${state?.workspaceId}:${viewKey}:${state?.modelHash}`;
  const directionReady = (directionMode !== 'AUTO' || canvasReady) && direction === desiredDirection;
  const needsInitialLayout = !!state && directionReady && !currentLayout && visibleIds.size > 0 && !movingCount && !Object.keys(positionOverrides.current[viewKey] || {}).length;
  const awaitingInitialLayout = needsInitialLayout && (!initialLayoutAttempts.current.has(initialLayoutKey) || layoutOperation === 'initialize');
  const awaitingInitialLayoutRef = useRef(awaitingInitialLayout); awaitingInitialLayoutRef.current = awaitingInitialLayout;
  const manualNodeIds = currentLayout?.manualNodeIds || (direction === 'DOWN' ? state?.view.manualNodeIds : []) || [];

  useEffect(() => {
    if (!state || (directionMode === 'AUTO' && !canvasReady) || movingCount || draggingNode || layoutOperation || savingDirection || Object.keys(positionOverrides.current[viewKey] || {}).length) return;
    setDirection(desiredDirection);
  }, [state, directionMode, canvasReady, movingCount, draggingNode, layoutOperation, savingDirection, viewKey, desiredDirection, moveVersion]);

  const changeLayoutDirection = async (mode: DirectionMode) => {
    const current = stateRef.current, scopeId = groupRef.current;
    if (!current || savingDirection || layoutOperation || movingCount || draggingNode || Object.keys(positionOverrides.current[viewKeyRef.current] || {}).length) return;
    setSavingDirection(true); setLayoutError('');
    try {
      const next = await api<WorkState>('/api/workbench/view', { layoutDirection: { scopeId, mode, baseRevision: current.view.layoutDirections?.[scopeId]?.revision || 0 } }, 'PATCH');
      acceptState(next);
    } catch (cause) { setLayoutError(`方向设置尚未保存：${(cause as Error).message}`); void fetchState(); }
    finally { setSavingDirection(false); }
  };
  const searchResults = useMemo(() => { if (!search.trim() || !state) return []; const q = search.trim().toLowerCase(); return state.model.nodes.filter(n => n.title.toLowerCase().includes(q) || n.claimIds.some(id => state.model.claims.find(c => c.id === id)?.text.toLowerCase().includes(q))).slice(0, 8); }, [search, state?.model]);

  useEffect(() => {
    if (!state) return;
    const next: FlowNode[] = visibleModelNodes.map((item, index) => ({
      id: item.id, type: 'process', position: positionOverrides.current[viewKey]?.[item.id] || currentLayout?.positions[item.id] || (direction === 'DOWN' ? state.view.positions[item.id] : undefined) || { x: (index % 3) * 300 + 30, y: Math.floor(index / 3) * 260 + 30 },
      selected: item.id === selectedId || selection.some(s => s.type === 'node' && s.id === item.id),
      data: {
        nodeId: item.id, title: item.title, direction, ports: ports.byNode.get(item.id),
        onActions: () => { focusNode(item.id, false); setActionsFocusId(item.id); },
        onDetails: () => { focusNode(item.id, false); setExpandedDetailsId(item.id); },
        actions: (item.fields.actions || []).map(id => state.model.claims.find(c => c.id === id)).filter(Boolean),
        hasDetails: item.claimIds.some(id => !(item.fields.actions || []).includes(id)),
        role: (item.fields.role || []).map(id => state.model.claims.find(c => c.id === id)?.text).filter(Boolean).join('、').replace(/[。.]$/, ''),
        groupId: item.groupId, groupIndex: state.model.groups.findIndex(g => g.id === item.groupId),
        groupTitle: state.model.groups.find(g => g.id === item.groupId)?.title || item.groupId,
        displayNo: state.model.nodes.filter(n => n.groupId === item.groupId).findIndex(n => n.id === item.id) + 1,
        context: scope.contextIds.has(item.id),
        issueCount: nodeProseContext(state.model,item.id).issues.filter(issue=>issue.status==='open').length,
        unknownCount: item.claimIds.filter(id => state.model.claims.some(c => c.id === id && c.origin === 'unknown')).length,
        changed: (state.changes || []).slice(0, 1).some(c => c.nodeIds?.includes(item.id) || c.targetIds?.includes(item.id) || c.nodeId === item.id),
        draft: !!drafts[item.id]?.dirty, outgoing: state.model.relations.filter(r => r.from === item.id).length,
        incoming: state.model.relations.filter(r => r.to === item.id).length,
      },
    }));
    for (const node of next) {
      node.data.layoutScopeId = group;
      node.data.layoutViewKey = viewKey;
      node.data.layoutModelHash = state.modelHash;
      node.data.manual = manualNodeIds.includes(node.id) || !!positionOverrides.current[viewKey]?.[node.id];
    }
    setFlowNodes(previous => next.map(n => {
      const old = previous.find(p => p.id === n.id);
      // Preserve React Flow's measurements during content updates. Clearing them
      // hides unchanged DOM nodes until a resize observation happens again.
      return old?.data.layoutViewKey === viewKey ? { ...n, measured: old.measured, ...(old.dragging ? { position: old.position, dragging: true } : {}) } : n;
    }));
  }, [state, visibleModelNodes, selectedId, drafts, selection, scope.contextIds, ports, group, direction, viewKey, moveVersion]);

  const geometryNodes = useMemo(() => flowNodes.map(node => ({ id: node.id, ...node.position, width: node.measured?.width || cardWidth, height: node.measured?.height || 113 })), [flowNodes, cardWidth]);
  const geometryKey = useMemo(() => routeGeometryKey(geometryNodes, geometryEdges, direction, ports), [geometryNodes, geometryEdges, direction, ports]);
  const measuredInputKey = useMemo(() => layoutInputKey(geometryNodes, geometryEdges, direction), [geometryNodes, geometryEdges, direction]);
  const measuredInputKeyRef = useRef(measuredInputKey); measuredInputKeyRef.current = measuredInputKey;
  const drawings = useProcessRoutes(geometryNodes, geometryEdges, direction, ports, geometryKey, currentLayout?.routes);

  const edges = useMemo<FlowEdge[]>(() => {
    if (!state) return [];
    const selectedRelations = new Set(selection.filter(item => item.type === 'relation').map(item => item.id));
    return geometryEdges.map(relation => {
      const selected = selectedRelations.has(relation.id);
      const hovered = relation.id === hoveredEdgeId;
      const highlighted = selected || hovered || (!hoveredEdgeId && !selectedRelations.size && relation.from === selectedId);
      const handles = ports.byEdge.get(relation.id)!;
      return { id: relation.id, source: relation.from, target: relation.to, type: 'process',
        sourceHandle: handles.source.id, targetHandle: handles.target.id,
        selected, zIndex: hovered ? 1 : 0, markerEnd: { type: MarkerType.ArrowClosed, width: 17, height: 17, color: processEdgeColor(relation.type, highlighted) },
        data: { kind: relation.type, highlighted, label: relation.label, labelWidth: relation.labelWidth,
          labelHeight: relation.labelHeight, drawing: drawings?.get(relation.id) } };
    });
  }, [state?.model, geometryEdges, ports, drawings, selection, selectedId, hoveredEdgeId]);
  useEffect(() => setHoveredEdgeId(null), [viewKey]);

  const persistView = useCallback(async (patch: Record<string, unknown>) => { try { const next = await api<WorkState>('/api/workbench/view', patch, 'PATCH'); acceptState(next); } catch { notify('布局尚未保存，内容修改不受影响。', 'error'); } }, [acceptState, notify]);

  const saveMovedPositions = useCallback((scopeId: string, positions: Record<string, Point>, layoutDirection = directionRef.current) => {
    const key = layoutViewKey(scopeId, layoutDirection);
    layoutRequest.current++;
    setLayoutOperation(null);
    positionOverrides.current[key] = { ...positionOverrides.current[key], ...clone(positions) };
    writePendingPositions(positionOverrides.current);
    setMoveVersion(value => value + 1); setMovingCount(value => value + 1); setLayoutError('');
    moveQueue.current = moveQueue.current.then(async () => {
      const current = stateRef.current;
      if (!current) return;
      try {
        const next = await api<WorkState>('/api/workbench/view', { layout: { scopeId, direction: layoutDirection, action: 'move', baseRevision: scopedLayout(current, scopeId, layoutDirection)?.revision || 0, positions } }, 'PATCH');
        acceptState(next);
        for (const [id, position] of Object.entries(positions)) if (JSON.stringify(positionOverrides.current[key]?.[id]) === JSON.stringify(position)) delete positionOverrides.current[key][id];
        writePendingPositions(positionOverrides.current);
        setMoveVersion(value => value + 1);
      } catch (cause) {
        setLayoutError(`位置尚未保存：${(cause as Error).message}`);
        void fetchState();
      }
    }).finally(() => setMovingCount(value => value - 1));
  }, [acceptState, fetchState]);

  const readMeasuredLayoutNodes = () => {
    const current = stateRef.current;
    const nodes = rf.getNodes();
    if (!current || nodes.length !== visibleIds.size || nodes.some(node => !visibleIds.has(node.id) || node.data.layoutViewKey !== viewKey || node.data.layoutModelHash !== current.modelHash || node.measured?.width !== cardWidth || !node.measured?.height || node.dragging)) return null;
    const elements = new Map([...graphElement.current?.querySelectorAll<HTMLElement>('.react-flow__node') || []].map(element => [element.dataset.id, element]));
    if (nodes.some(node => {
      const element = elements.get(node.id);
      return !element || element.offsetWidth !== node.measured!.width || element.offsetHeight !== node.measured!.height;
    })) return null;
    return nodes.map(node => ({ id: node.id, ...node.position, width: node.measured!.width!, height: node.measured!.height! }));
  };

  const runLayout = async (action: 'initialize' | 'arrange' | 'reset' | 'undo' | 'release' | 'refresh' | 'measure') => {
    const initial = stateRef.current;
    if (!initial || movingCount || savingDirection || draggingNode || Object.keys(positionOverrides.current[viewKey] || {}).length) return;
    const measuredNodes = readMeasuredLayoutNodes();
    const automatic = action === 'refresh' || action === 'measure';
    if (automatic && (!supportsLayoutRefresh || contentViewRef.current !== 'graph' || !measuredNodes)) return;
    const inputKey = measuredNodes ? layoutInputKey(measuredNodes, geometryEdges, direction) : measuredInputKey;
    const scopeId = group, layoutDirection = direction, key = viewKey, request = ++layoutRequest.current;
    const layout = scopedLayout(initial, scopeId, layoutDirection);
    const baseRevision = layout?.revision || 0;
    const attemptKey = `${initial.workspaceId}:${key}:${baseRevision}:${initial.modelHash}:${inputKey}`;
    let canceled = false;
    if (automatic) {
      if (!layout || automaticLayoutAttempts.current.has(attemptKey)) return;
      automaticLayoutAttempts.current.add(attemptKey);
    }
    if (action === 'initialize') {
      if (layout || initialLayoutAttempts.current.has(initialLayoutKey)) return;
      initialLayoutAttempts.current.add(initialLayoutKey);
    }
    setLayoutOperation(action); setLayoutError('');
    try {
      let patch: Record<string, unknown> = { scopeId, direction: layoutDirection, action: action === 'arrange' ? 'reset' : action, baseRevision };
      if (supportsLayoutRefresh && action !== 'release') patch = { ...patch, inputKey, baseModelHash: initial.modelHash };
      if (action === 'arrange' || action === 'reset' || action === 'initialize' || action === 'refresh') {
        const nodes = (measuredNodes || rf.getNodes().filter(node => visibleIds.has(node.id)).map(node => ({ id: node.id, ...node.position, width: node.measured?.width || cardWidth, height: node.measured?.height || 113 })))
          .map(node => ({ ...node, ...(action === 'initialize' && layoutDirection === 'DOWN' ? initial.view.positions[node.id] : {}) }));
        const pinned = action === 'refresh' ? layout?.manualNodeIds || [] : action === 'initialize' && layoutDirection === 'DOWN' ? initial.view.manualNodeIds || [] : [];
        const result = await arrangeGraph({ nodes, edges: geometryEdges, direction: layoutDirection, manualNodeIds: pinned });
        if (request !== layoutRequest.current || viewKeyRef.current !== key) return;
        // A resize/content update can finish while the worker is arranging.
        // Discard that result before it can overwrite newer measured geometry.
        if (!readMeasuredLayoutNodes() || measuredInputKeyRef.current !== inputKey) { canceled = true; return; }
        patch = { ...patch, baseModelHash: initial.modelHash, positions: result.positions, routes: result.routes };
      } else if (action === 'release') patch.nodeIds = selectedRef.current ? [selectedRef.current] : [];
      const latest = stateRef.current;
      if (latest?.modelHash !== initial.modelHash || (scopedLayout(latest, scopeId, layoutDirection)?.revision || 0) !== baseRevision) {
        if (automatic || action === 'initialize') { canceled = true; return; }
        throw new Error('内容或位置已有更新，请基于当前图重新整理。');
      }
      const next = await api<WorkState>('/api/workbench/view', { layout: patch }, 'PATCH');
      acceptState(next);
      if (request !== layoutRequest.current || viewKeyRef.current !== key) return;
      if (action !== 'release' && !automatic) {
        const savedViews = readLocal<Record<string, Viewport>>(cacheKey('viewport-scope-v2'), {});
        delete savedViews[key]; writeLocal(cacheKey('viewport-scope-v2'), savedViews);
        requestAnimationFrame(() => {
          if (request === layoutRequest.current && viewKeyRef.current === key) frameViewport('initialize');
        });
      }
      if (action !== 'initialize' && !automatic) notify(action === 'arrange' || action === 'reset' ? '已重新整理当前图，清除手动固定位置；可撤销恢复' : action === 'undo' ? '已撤销整理，后续手动调整仍保留' : '已解除固定，下次整理会包含此节点');
    } catch (cause) {
      if (request === layoutRequest.current && viewKeyRef.current === key) setLayoutError(action === 'initialize' ? `本组布局尚未生成，可点击“整理当前图”重试。${(cause as Error).message}` : automatic ? `自动整理尚未完成，可点击“整理当前图”重试。${(cause as Error).message}` : (cause as Error).message);
      void fetchState();
    } finally {
      // A canceled calculation can be retried on return; a failed request waits
      // for an explicit retry instead of writing again on every state event.
      if (automatic && (canceled || request !== layoutRequest.current)) automaticLayoutAttempts.current.delete(attemptKey);
      if (action === 'initialize' && (canceled || request !== layoutRequest.current) && !scopedLayout(stateRef.current, scopeId, layoutDirection)) {
        initialLayoutAttempts.current.delete(initialLayoutKey);
        setMoveVersion(value => value + 1);
      }
      if (request === layoutRequest.current) setLayoutOperation(null);
    }
  };

  useEffect(() => { layoutRequest.current++; setLayoutOperation(null); setLayoutError(''); setDraggingNode(false); }, [viewKey, contentView]);

  useEffect(() => {
    if (contentView !== 'graph' || !needsInitialLayout || layoutOperation || initialLayoutAttempts.current.has(initialLayoutKey) || !readMeasuredLayoutNodes()) return;
    const timer = setTimeout(() => { if (readMeasuredLayoutNodes()) void runLayout('initialize'); }, 220);
    return () => clearTimeout(timer);
  }, [initialLayoutKey, needsInitialLayout, layoutOperation, measuredInputKey, flowNodes, moveVersion, contentView]);

  useEffect(() => {
    if (contentView !== 'graph' || !supportsLayoutRefresh || !currentLayout || !directionReady || layoutOperation || movingCount || savingDirection || draggingNode || Object.keys(positionOverrides.current[viewKey] || {}).length || !readMeasuredLayoutNodes()) return;
    const retainPositions = currentLayout.needsMeasurement === state?.modelHash && [...visibleIds].every(id => currentLayout.positions[id]);
    if (!currentLayout.needsMeasurement && currentLayout.inputKey === measuredInputKey) return;
    const attemptKey = `${state?.workspaceId}:${viewKey}:${currentLayout.revision}:${state?.modelHash}:${measuredInputKey}`;
    if (automaticLayoutAttempts.current.has(attemptKey)) return;
    // Coalesce ResizeObserver and React Flow updates; selection and viewport
    // events do not change the input signature and therefore never rearrange.
    const timer = setTimeout(() => { if (readMeasuredLayoutNodes()) void runLayout(retainPositions ? 'measure' : 'refresh'); }, 220);
    return () => clearTimeout(timer);
  }, [contentView, supportsLayoutRefresh, currentLayout, directionReady, layoutOperation, movingCount, savingDirection, draggingNode, viewKey, state?.modelHash, measuredInputKey, flowNodes, moveVersion]);

  const focusNode = useCallback((id: string, changeGroup = true, revealInspector = true) => {
    const s = stateRef.current; const n = s?.model.nodes.find(n => n.id === id); if (!s || !n) return;
    const previousDraft = selectedRef.current ? draftsRef.current[selectedRef.current] : undefined; if (previousDraft?.dirty) { const timer = bufferTimers.current.get(previousDraft.nodeId); if (timer) clearTimeout(timer); void persistBuffer(previousDraft); }
    setSelectedId(id); setSelection([{ type: 'node', id, label: n.title }]); if (revealInspector) setInspectorOpen(true); setError(''); setSearch(''); setChosenText(null);
    writeLocal(cacheKey('selected'), id);
    if (changeGroup) { setGroup(n.groupId); writeLocal(cacheKey('group'), n.groupId); }
    void persistView({ selectedNodeId: id, ...(changeGroup ? { selectedGroupId: n.groupId } : {}) });
  }, [persistBuffer, persistView]);

  const changeGroup = useCallback((id: string) => {
    setConnectionsOpen(false);
    if (id !== 'all' && stateRef.current?.model.nodes.find(n => n.id === selectedRef.current)?.groupId !== id) {
      const first = stateRef.current?.model.nodes.find(n => n.groupId === id);
      if (first) { focusNode(first.id, true, false); setSelection([]); return; }
    }
    setGroup(id); writeLocal(cacheKey('group'), id); void persistView({ selectedGroupId: id });
  }, [persistView, focusNode]);

  const frameViewport = useCallback((mode: 'initialize' | 'resize' | 'fit') => {
    const request = ++viewportRequest.current;
    if (viewportFrame.current !== null) cancelAnimationFrame(viewportFrame.current);
    let previousSize = '', stableFrames = 0;
    const measure = () => {
      if (request !== viewportRequest.current) return;
      const element = graphElement.current, currentState = stateRef.current;
      if (!element || !currentState) return;
      if (awaitingInitialLayoutRef.current) return;
      const area = element.getBoundingClientRect();
      const currentGroup = groupRef.current;
      const currentDirection = directionRef.current, key = layoutViewKey(currentGroup, currentDirection);
      const projection = getGraphScope(currentState.model, currentGroup);
      const ids = projection.visibleIds;
      const nodes = rf.getNodes().filter(n => ids.has(n.id));
      if (!ids.size) return;
      // A breakpoint changes the graph box and React Flow measurements separately.
      // Wait for consecutive layout frames, then use the actual box, not cached store dimensions.
      const size = `${area.width}:${area.height}:${nodes.length}`;
      stableFrames = size === previousSize ? stableFrames + 1 : 0;
      previousSize = size;
      if (area.width < 80 || area.height < 80 || nodes.length !== ids.size || nodes.some(n => n.data.layoutViewKey !== key) || stableFrames < 2) {
        viewportFrame.current = requestAnimationFrame(measure); return;
      }
      const framedNodes = mode === 'fit' || currentGroup === 'all' ? nodes : nodes.filter(node => projection.coreIds.has(node.id));
      const boxes = framedNodes.map(node => {
        const nodeElement = [...element.querySelectorAll<HTMLElement>('.react-flow__node')].find(e => e.dataset.id === node.id);
        return { x: node.position.x, y: node.position.y, width: nodeElement?.offsetWidth || node.measured?.width || 200, height: nodeElement?.offsetHeight || node.measured?.height || 96 };
      });
      const left = Math.min(...boxes.map(b => b.x)), top = Math.min(...boxes.map(b => b.y));
      const bounds = { x: left, y: top, width: Math.max(...boxes.map(b => b.x + b.width)) - left, height: Math.max(...boxes.map(b => b.y + b.height)) - top };
      const saved = mode === 'initialize' ? readLocal<Record<string, Viewport & { scoped?: boolean }>>(cacheKey('viewport-scope-v2'), {})[key] : null;
      // A different window may have created the local layout since this browser
      // saved a zoom for global coordinates. Do not reuse that coordinate frame.
      const validSaved = saved && !!saved.scoped === !!scopedLayout(currentState, currentGroup, currentDirection) && [saved.x, saved.y, saved.zoom].every(Number.isFinite) && saved.zoom >= .25 && saved.zoom <= 1.7;
      let viewport: Viewport;
      const leftInset = !navigationCollapsedRef.current && area.width > 600 ? 220 : 16;
      const availableWidth = Math.max(100, area.width - leftInset - 16);
      if (validSaved) viewport = saved;
      else if (currentGroup === 'all' && mode !== 'fit') {
        const origin = nodes.find(n => n.id === selectedRef.current) || nodes[0];
        viewport = { x: leftInset + availableWidth / 2 - (origin.position.x + (origin.measured?.width || (currentDirection === 'RIGHT' ? 240 : 200)) / 2) * .9, y: 70 - origin.position.y * .9, zoom: .9 };
      } else {
        viewport = getViewportForBounds(bounds, availableWidth, area.height, mode === 'fit' ? .25 : .82, 1, .14);
        viewport.x += leftInset;
        if (mode !== 'fit' && (bounds.height * viewport.zoom > area.height - 80 || bounds.width * viewport.zoom > availableWidth - 40)) {
          const origin = nodes.find(node => node.id === selectedRef.current) || framedNodes[0];
          viewport.x = leftInset + availableWidth / 2 - (origin.position.x + (origin.measured?.width || 200) / 2) * viewport.zoom;
          viewport.y = Math.min(230, area.height * .32) - (origin.position.y + (origin.measured?.height || 113) / 2) * viewport.zoom;
        }
      }
      viewInitialized.current = key;
      viewportFrame.current = null;
      // Cancel any earlier animated target; a completed fit must describe this exact box.
      void rf.setViewport(viewport, { duration: 0 });
    };
    viewportFrame.current = requestAnimationFrame(measure);
  }, [rf]);

  useEffect(() => {
    if (state && flowNodes.length && directionReady && !awaitingInitialLayout && viewInitialized.current !== viewKey) frameViewport('initialize');
  }, [Boolean(state), flowNodes, viewKey, directionReady, awaitingInitialLayout, frameViewport]);

  useEffect(() => {
    const element = graphElement.current; if (!element) return;
    let resizeTimer: ReturnType<typeof setTimeout>;
    const measure = () => {
      if(contentViewRef.current==='content')return;
      const area = element.getBoundingClientRect();
      setCanvasSize(previous => previous.width === area.width && previous.height === area.height ? previous : { width: area.width, height: area.height });
    };
    measure();
    const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(measure, 150); });
    observer.observe(element);
    return () => { clearTimeout(resizeTimer); observer.disconnect(); viewportRequest.current++; if (viewportFrame.current !== null) cancelAnimationFrame(viewportFrame.current); };
  }, [Boolean(state), frameViewport]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    if (viewKeyRef.current !== viewKey) return;
    setFlowNodes(nodes => applyNodeChanges(changes, nodes));
    const settled: Record<string, Point> = {};
    for (const change of changes) if (change.type === 'position' && change.dragging === false && change.position) settled[change.id] = change.position;
    if (Object.keys(settled).length) saveMovedPositions(group, settled, direction);
  }, [saveMovedPositions, group, direction, viewKey]);
  const onGraphSelectionChange = useCallback(({ nodes, edges: selectedEdges }: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
    if (!selectingMultiple || nodes.length + selectedEdges.length < 2) return;
    const next = [...nodes.map(n => ({ type: 'node', id: n.id, label: String(n.data.title) })), ...selectedEdges.map(e => ({ type: 'relation', id: e.id, label: '所选连接' }))];
    setSelection(previous => previous.length === next.length && previous.every((s, i) => s.type === next[i].type && s.id === next[i].id) ? previous : next);
  }, [selectingMultiple]);

  const focusRelation = useCallback((id: string, scrollToBranch = true) => {
    const model = stateRef.current?.model;
    const edge = model?.relations.find(item => item.id === id);
    if (!model || !edge) return;
    if (edge.from !== selectedRef.current) focusNode(edge.from, false);
    else setInspectorOpen(true);
    const target = resolveAgentTarget(model, { type: 'relation', id, label: '' });
    if (target) setSelection([target]);
    if (scrollToBranch) setTimeout(() => document.querySelector(`[data-branch-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 100);
  }, [focusNode]);

  const selectedRelationId = selection.length === 1 && selection[0].type === 'relation' ? selection[0].id : undefined;
  useEffect(() => {
    if (!selectedRelationId) return;
    const relation = state?.model.relations.find(item => item.id === selectedRelationId);
    if (relation && relation.from !== selectedId) focusRelation(relation.id, false);
  }, [state?.model, selectedRelationId, selectedId, focusRelation]);

  function focusGraphObjectOnKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!(event.target instanceof Element) || event.target.closest('button, input, textarea, select, [contenteditable]')) return;
    const item = event.target.closest<HTMLElement>('.react-flow__node[data-id], .react-flow__edge[data-id]');
    const id = item?.dataset.id;
    if (!item || !id) return;
    if (item.classList.contains('react-flow__node')) focusNode(id, false);
    else focusRelation(id);
  }

  async function clearDraft(id: string) {
    const s = stateRef.current; if (!s) return;
    const next = draftFor(s, id); if (!next) return;
    next.revision = Math.max(Date.now(), (draftsRef.current[id]?.revision || 0) + 1);
    const timer = bufferTimers.current.get(id); if (timer) clearTimeout(timer);
    draftsRef.current = { ...draftsRef.current, [id]: next }; setDrafts(draftsRef.current); setError(''); await persistBuffer(next);
  }

  function restoreCopyText() {
    if (!draft) return;
    if (!hasStructureChanges(draft)) { void clearDraft(draft.nodeId); return; }
    updateDraft(draft.nodeId, next => {
      next.title = next.baseTitle;
      next.claims = clone(next.baseClaims);
      for (const branch of next.branches) {
        branch.conditions = clone(next.baseBranches.find(item => item.id === branch.id)?.conditions || []);
      }
    });
  }

  async function saveNode() {
    if (!draft || !state || !currentNode) return;
    const corrections = textChanges(draft);
    if (!Object.keys(corrections).length) return;
    const submitted = clone(draft);
    submitted.groupId = submitted.baseGroupId;
    for (const branch of submitted.branches) {
      const original = submitted.baseBranches.find(item => item.id === branch.id);
      if (original) branch.to = original.to;
    }
    setSaving(true); setError('');
    try {
      const next = await api<WorkState>('/api/workbench/edits', {
        requestId: stamp(), baseWorkRevision: draft.baseWorkRevision, baseModelHash: draft.baseModelHash,
        nodeId: draft.nodeId, scope: 'copy', ...corrections, intent: draft.intent,
      });
      acceptState(next);
      const latest = draftsRef.current[draft.nodeId] || submitted;
      if (next.lastSave?.kind === 'pending') {
        const retained = { ...clone(latest), baseWorkRevision: next.workRevision, baseModelHash: next.modelHash, revision: Math.max(Date.now(), latest.revision + 1) };
        draftsRef.current = { ...draftsRef.current, [draft.nodeId]: retained }; setDrafts(draftsRef.current); await persistBuffer(retained);
      } else if (latest.revision !== submitted.revision || hasStructureChanges(latest)) {
        const retained = carryNewerInput(submitted, latest, next);
        if (retained) { draftsRef.current = { ...draftsRef.current, [draft.nodeId]: retained }; setDrafts(draftsRef.current); await persistBuffer(retained); }
        else setError('已保存提交时的内容。随后输入已保留；部分原句身份变化，请复制相关引用，在 AgentApp 中核对后继续。');
      } else await clearDraft(draft.nodeId);
      setLastSavedAt(new Date().toISOString());
      notify(next.lastSave?.message || (draft.intent === 'proposal' ? '待定建议已保存，可以稍后继续整理。' : '文案已保存。'));
    } catch (cause) { const error = cause as Error & { status?: number }; setError(error.status === 409 ? `工作稿已有新修改。你的输入已保留，重新核对后再保存。${error.message}` : error.message); }
    finally { setSaving(false); }
  }

  function rebaseDraft() {
    if (!state || !draft) return;
    const latest = draftFor(state, draft.nodeId); if (!latest) return;
    const corrections = textChanges(draft);
    const oldTargets = draft.branches.filter(branch => draft.baseBranches.find(item => item.id === branch.id)?.to !== branch.to);
    const missingClaim = corrections.claims?.some(claim => !latest.claims.some(item => item.id === claim.id));
    const missingCondition = corrections.branches?.some(branch => {
      const current = latest.branches.find(item => item.id === branch.id);
      return !current || branch.conditions.some(condition => !current.conditions.some(item => item.id === condition.id));
    });
    if (missingClaim || missingCondition || oldTargets.some(branch => !latest.branches.some(item => item.id === branch.id))) {
      setError('部分原句或连接身份已经改变。输入仍已保留，请复制相关引用，在 AgentApp 中核对这些修改。');
      return;
    }
    latest.title = corrections.title ?? latest.title;
    if (draft.groupId !== draft.baseGroupId) latest.groupId = draft.groupId;
    for (const edit of corrections.claims || []) latest.claims.find(claim => claim.id === edit.id)!.text = edit.text;
    for (const branch of corrections.branches || []) {
      const current = latest.branches.find(item => item.id === branch.id)!;
      for (const edit of branch.conditions) current.conditions.find(condition => condition.id === edit.id)!.text = edit.text;
    }
    for (const branch of oldTargets) latest.branches.find(item => item.id === branch.id)!.to = branch.to;
    latest.dirty = true; latest.intent = draft.intent; latest.revision = Math.max(Date.now(), draft.revision + 1);
    draftsRef.current = { ...draftsRef.current, [latest.nodeId]: latest }; setDrafts(draftsRef.current); void persistBuffer(latest); setError(''); notify('已保留你的修改，请核对字段后再次保存。', 'info');
  }

  function restorePending(pending: any) {
    if (!state || !pending.original?.node) return;
    const original = pending.original;
    const originalState = { ...state, workRevision: original.workRevision, modelHash: original.modelHash, model: { ...state.model, nodes: original.nodes, relations: original.relations, claims: original.claims } } as WorkState;
    const restored = draftFor(originalState, pending.nodeId); if (!restored) return;
    const input = pending.input || {};
    if (input.title !== undefined) restored.title = input.title;
    if (input.groupId !== undefined) restored.groupId = input.groupId;
    for (const edit of input.claims || []) { const c = restored.claims.find(c => c.id === edit.id); if (c) c.text = edit.text; }
    for (const edit of input.branches || []) { const b = restored.branches.find(b => b.id === edit.id); if (b) { if (edit.to !== undefined) b.to = edit.to; for (const editCondition of edit.conditions || []) { const c = b.conditions.find(c => c.id === editCondition.id); if (c) c.text = editCondition.text; } } }
    if (original.modelHash === state.modelHash) { restored.baseWorkRevision = state.workRevision; restored.baseModelHash = state.modelHash; }
    restored.intent = 'proposal'; restored.dirty = true; restored.revision = Math.max(Date.now(), (draftsRef.current[pending.nodeId]?.revision || 0) + 1);
    setContentView('content');setEditingNodeId(pending.nodeId);
    draftsRef.current = { ...draftsRef.current, [pending.nodeId]: restored }; setDrafts(draftsRef.current); void persistBuffer(restored); setError(''); notify('待定建议已恢复到表单，可以继续编辑。', 'info');
  }

  async function undo() {
    if (!state) return;
    try { const next = await api<WorkState>('/api/workbench/undo', { requestId: stamp(), baseWorkRevision: state.workRevision, baseModelHash: state.modelHash }); acceptState(next); notify('已撤销最近一次内容修改，编辑中的输入仍保留。'); }
    catch (cause) { notify((cause as Error).message, 'error'); }
  }

  async function createReference(targets: Selection[], base: { workRevision: number; modelHash: string }, quote?: VerifiedQuote) {
    const requestTargets = new Map(targets.map(({ type, id }) => [`${type}:${id}`, { type, id }]));
    if (quote) requestTargets.set(`claim:${quote.claimId}`, { type: 'claim', id: quote.claimId });
    const selection = quote && !quote.source && quote.text.length <= 20000 ? { text: quote.text, claimId: quote.claimId } : undefined;
    const result = await api('/api/workbench/references', { targets: [...requestTargets.values()], baseWorkRevision: base.workRevision,
      baseModelHash: base.modelHash, ...(selection ? { selection } : {}) });
    const reference = typeof result.handoff === 'string' ? result.handoff : typeof result.reference === 'string' ? result.reference : '';
    if (!reference) throw new Error('没有取得可复制的引用，请重试。');
    return reference;
  }

  async function copyReference(targets?: Selection[], quote = chosenText) {
    if (!state || copyBusy) return;
    const verified = verifyAgentQuote(state.model, quote);
    if (quote && !verified) {
      notify('所选文字还未保存。请先保存节点，再复制这段文字的引用。', 'info'); return;
    }
    const selectedTargets = targets || (selection.length ? selection : currentNode ? [{ type: 'node', id: currentNode.id, label: currentNode.title }] : []);
    setCopyBusy(true);
    try {
      const reference = await createReference(selectedTargets, state, verified);
      const value = verified && (verified.source || verified.text.length > 20000) ? `引用原文：${verified.text}\n${reference}` : reference;
      try { await navigator.clipboard.writeText(value); setReferenceFallback(''); notify('已复制已保存内容的引用。回到 AgentApp 粘贴即可继续。'); }
      catch { setReferenceFallback(value); notify('引用已生成，请在弹出的内容中手动复制。', 'info'); }
    } catch (cause) { notify((cause as Error).message, 'error'); }
    finally { setCopyBusy(false); }
  }

  function prepareAgentTask(presetId: string, legacy?: ReturnType<typeof legacyStructureHandoff>, explicitTarget?: Selection) {
    const target = explicitTarget || agentTarget;
    if (!state || !target || copyBusy) return;
    agentTaskReturnFocus.current = document.activeElement?.closest('.agent-control')?.querySelector<HTMLButtonElement>('[data-testid="agent-action"]') || null;
    const processingTargets = legacy || presetId === 'propose-node' ? [] : [target];
    const referenceAnchors = legacy ? legacy.targets.map(item => resolveAgentTarget(state.model, item) || item)
      : processingTargets.length ? [] : [target];
    const referenceTargets = relationReferenceTargets(state.model, processingTargets, referenceAnchors);
    const includeSelection = !explicitTarget || (explicitTarget.type === 'node' && explicitTarget.id === selectedId);
    const quote = includeSelection ? verifyAgentQuote(state.model, chosenText) : undefined;
    const targetDraft = explicitTarget ? (drafts[explicitTarget.id]?.dirty ? nodeDraftText(drafts[explicitTarget.id], state.model) : '') : handoffText;
    const input = legacy?.draft || [targetDraft, includeSelection && chosenText && !quote ? `未保存的选中文字\n${chosenText.text}` : ''].filter(Boolean).join('\n\n');
    const task = legacy ? '请核对上次的结构草稿，结合原文整理候选并列出需要确认的问题。'
      : buildPresetTask({ presetId, processingTargets, referenceTargets: referenceAnchors });
    setToast(null);
    setAgentTaskError('');
    setAgentTaskFallback('');
    setAgentTask({ presetId, task, processingTargets, referenceAnchors, referenceTargets, quote, draft: input,
      includeDraft: Boolean(legacy?.draft), workRevision: state.workRevision, modelHash: state.modelHash });
  }

  function updateAgentTask(change: Partial<AgentTask>) {
    setAgentTask(current => current ? { ...current, ...change } : current);
    setAgentTaskFallback('');
    setAgentTaskError('');
  }

  function closeAgentTask() {
    setAgentTask(null);
    const trigger = agentTaskReturnFocus.current;
    requestAnimationFrame(() => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); });
  }

  function refreshAgentTask() {
    if (!state || !agentTask || copyBusy) return;
    const quote = verifyAgentQuote(state.model, agentTask.quote);
    if (agentTask.quote && !quote) {
      setAgentTaskError('原句已无法在当前工作稿中核对。请先移除选文，再重新核对引用。');
      return;
    }
    const changes: string[] = [];
    const refreshTargets = (target: Selection) => {
      const current = resolveAgentTarget(state.model, target);
      if (!current) {
        changes.push(`已移除失效对象「${target.label}」。`);
        return [];
      }
      if (current.label !== target.label) changes.push(`「${target.label}」已更新为「${current.label}」。`);
      return [current];
    };
    const processingTargets = agentTask.processingTargets.flatMap(refreshTargets);
    const referenceAnchors = agentTask.referenceAnchors.flatMap(refreshTargets);
    const referenceTargets = relationReferenceTargets(state.model, processingTargets, referenceAnchors);
    if (!changes.length && (referenceTargets.length !== agentTask.referenceTargets.length || referenceTargets.some((target, index) => {
      const previous = agentTask.referenceTargets[index];
      return target.id !== previous?.id || target.type !== previous.type || target.label !== previous.label;
    }))) changes.push('连线两端的参考节点已更新。');
    const previousTask = buildPresetTask({ ...agentTask, referenceTargets: agentTask.referenceAnchors });
    const task = agentTask.task === previousTask
      ? buildPresetTask({ presetId: agentTask.presetId, processingTargets, referenceTargets: referenceAnchors }) : agentTask.task;
    updateAgentTask({ task, processingTargets, referenceAnchors, referenceTargets, quote, workRevision: state.workRevision, modelHash: state.modelHash });
    if (changes.length) setAgentTaskError(`${changes.join('')}请核对任务文字和处理范围后再复制。`);
  }

  async function confirmAgentTask() {
    const latest = stateRef.current;
    if (!agentTask || !latest || copyBusy || !agentTask.task.trim()) return;
    if (latest.workRevision !== agentTask.workRevision || latest.modelHash !== agentTask.modelHash) return;
    setCopyBusy(true);
    setAgentTaskError('');
    setAgentTaskFallback('');
    try {
      const { presetId, task, processingTargets, referenceTargets, quote, includeDraft, draft } = agentTask;
      const reference = await createReference([...processingTargets, ...referenceTargets], agentTask, quote);
      const value = formatPresetHandoff({ presetId, reference, task, processingTargets, referenceTargets,
        quote: quote ? { text: quote.text, claimId: quote.claimId, sourceLabel: quote.sourceLabel } : undefined,
        draft: includeDraft ? draft : undefined });
      try {
        await navigator.clipboard.writeText(value);
        closeAgentTask();
        notify('已复制任务，可粘贴到 Agent 对话。');
      } catch {
        setAgentTaskFallback(value);
      }
    } catch (cause) {
      const error = cause as Error & { status?: number };
      setAgentTaskError(error.message);
      if (error.status === 409) void fetchState();
    } finally { setCopyBusy(false); }
  }

  function captureText(event: React.SyntheticEvent) {
    const element = event.target;
    if (!(element instanceof Element)) return;
    const selection = window.getSelection();
    const selected = element instanceof HTMLTextAreaElement ? element.value.slice(element.selectionStart, element.selectionEnd) : selection?.toString() || '';
    const anchor = selection?.anchorNode;
    const quoteElement = element instanceof HTMLTextAreaElement ? element : anchor instanceof Element ? anchor : anchor?.parentElement || element;
    const target = quoteElement.closest<HTMLElement>('[data-claim-id]');
    const claimId = target?.dataset.claimId;
    if (!target || !claimId) return;
    if (!selected.trim()) { if (element.closest('[data-claim-id]')) setChosenText(null); return; }
    const sourceId = target.dataset.quoteSource;
    const source = sourceId ? { id: sourceId, start: Number(target.dataset.quoteStart), end: Number(target.dataset.quoteEnd) } : undefined;
    setChosenText({ text: selected, claimId, source });
  }

  if (!state) return <div className="loading-screen"><div className="brand-mark"><Waypoints size={26} /></div><h1>流程工作台</h1>{loadingError ? <><p className="error-text">{loadingError}</p><button className="primary-button" onClick={() => void fetchState()}>重新连接</button></> : <p><LoaderCircle size={16} className="spin" /> 正在恢复你的工作内容</p>}</div>;

  const sourceNames = state.contentOrigin?.sourceNames?.length ? state.contentOrigin.sourceNames : state.model.sources.filter(source => source.kind !== 'user-feedback').map(source => source.name);
  const sourceLabel = state.contentOrigin?.label || (state.contentOrigin?.kind === 'synthetic' ? '合成演示资料' : '任务资料');
  const incoming = state.model.relations.filter(r => r.to === selectedId);
  const outgoing = new Map(state.model.relations.filter(relation => relation.from === selectedId).map(relation => [relation.id, relation]));
  const branchRows = [...outgoing.values()].map(relation => ({
    id: relation.id, to: relation.to, conditions: relation.conditionClaimIds.map(id => ({ id, text: state.model.claims.find(claim => claim.id === id)?.text || '' })),
  }));
  const detailFields = Object.keys(displayFields).filter(field => field !== 'actions');
  const assignedClaimIds = new Set(Object.values(displayFields).flat());
  const supplementalClaims = (draftFor(state, selectedId || '')?.claims || []).filter(claim => !assignedClaimIds.has(claim.id));
  const originLabels: Record<string, string> = { explicit: '原文明示', inferred: '整理推断', unknown: '资料未说明', feedback: '用户补充' };
  const sourceLocations = sourceLocationsFor(selectedClaims, state.model.sources);

  const draftStatus = !draft?.dirty ? '与工作稿一致' : bufferStatus[selectedId!] === 'saved' ? '编辑稿已保存' : bufferStatus[selectedId!] === 'conflict' ? '另一窗口有较新编辑稿' : bufferStatus[selectedId!] === 'local' ? '输入保留在此浏览器' : '正在保留编辑稿…';
  const savedNode = state.model.nodes.find(node => node.id === selectedId);
  const agentTarget = (selectedRelationId ? resolveAgentTarget(state.model, { type: 'relation', id: selectedRelationId, label: '' }) : undefined)
    || (savedNode ? { type: 'node', id: savedNode.id, label: savedNode.title } : undefined);
  const draftNodeIds = agentTarget?.type === 'relation' ? relationReferenceTargets(state.model, [agentTarget], []).map(item => item.id)
    : savedNode ? [savedNode.id] : [];
  const handoffText = [...draftNodeIds].map(id => drafts[id]).filter(item => item?.dirty)
    .map(item => nodeDraftText(item, state.model)).filter(Boolean).join('\n\n');
  const retainedStructure = !!draft && hasStructureChanges(draft);
  const hasTextChanges = !!draft && !!Object.keys(textChanges(draft)).length;
  const agentTaskStale = !!agentTask && (agentTask.workRevision !== state.workRevision || agentTask.modelHash !== state.modelHash);
  const agentTaskMissingTargets = agentTaskStale && !!agentTask && [...agentTask.processingTargets, ...agentTask.referenceAnchors]
    .some(target => !resolveAgentTarget(state.model, target));

  const readingDraft = savedNode ? draftFor(state, savedNode.id) : undefined;
  const showContent = contentView === 'content';
  const chooseContentView = (view: 'graph'|'content') => {
    if(view===contentView)return;
    if(view==='content'){const rect=graphElement.current?.getBoundingClientRect();if(rect)graphBox.current={width:rect.width,height:rect.height};}
    else {window.dispatchEvent(new Event('6ak:capture-node-workspace'));if(savedNode&&!visibleIds.has(savedNode.id))focusNode(savedNode.id,true);}
    contentViewRef.current=view;setContentView(view);void persistView({contentView:view});
  };
  const locateProse = (section:string) => {
    if(!savedNode)return;
    if(!showContent)chooseContentView('content');
    if(section==='rules'&&!savedNode.fields.rules.length){
      const assigned=new Set(Object.values(savedNode.fields).flat());
      section=nodeProseContext(state.model,savedNode.id).rules.length?'shared-rules':savedNode.claimIds.some(id=>!assigned.has(id))?'supplemental':'materials';
    }
    setProseLocation({nodeId:savedNode.id,section,revision:Date.now()});
  };
  const materialsEnabled=state.workbenchProtocol?.name==='6ak-workbench'&&state.workbenchProtocol.version>=2
    &&['node-materials-v1','source-material-edit-v1','all-node-materials-reference-v1','candidate-material-guards-v1','node-material-text-v1'].every(capability=>state.workbenchProtocol?.capabilities.includes(capability))
    &&state.materials?.schemaVersion===2&&!!state.contentTree;
  const legacyNodeIds=[...new Set([...state.model.nodes.map(item=>item.id),...Object.keys(drafts),...(state.pendingEdits||[]).map(item=>item.nodeId||item.targetId||item.payload?.nodeId).filter(Boolean)])];
  const legacyInputs=Object.fromEntries(legacyNodeIds.map(id=>{const item={id};
    const inputs:Array<{id:string;label:string;text:string}>=[];
    const old=drafts[item.id];
    if(old?.dirty)inputs.push({id:'expression-draft',label:'旧版未保存的表达草稿',text:'旧版未采用输入，仅作修改建议，不能作为已核实事实。\n'+(nodeDraftText(old,state.model)||JSON.stringify({title:old.title,claims:old.claims,branches:old.branches},null,2))});
    for(const pending of state.pendingEdits||[])if(pending.nodeId===item.id||pending.targetId===item.id||pending.payload?.nodeId===item.id)inputs.push({id:pending.id||String(inputs.length),label:'以前保存的待定建议',text:'历史待定建议，尚未采用。\n'+JSON.stringify(pending.input||pending.payload||pending,null,2)});
    if(legacyStructureDraft&&item.id===savedNode?.id)inputs.push({id:'legacy-structure',label:'以前保留的结构草稿',text:'历史结构草稿，仅作待核对建议。\n'+JSON.stringify(legacyStructureDraft,null,2)});
    return [item.id,inputs];
  }));
  const nodeActions = savedNode&&<div className="node-context-actions"><button className="secondary-button" data-testid="organize-node" onClick={()=>locateProse('materials')}><FileText size={14}/>整理此节点</button></div>;

  return <div className={`app-shell ${inspectorOpen&&!showContent ? '' : 'inspector-closed'}`} data-layout-direction={direction} data-content-view={showContent ? 'content' : 'graph'}>
    <header className="app-header">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); changeGroup('all'); }} aria-label="查看完整流程"><span className="brand-mark"><Waypoints size={21} /></span><span>6ak<span className="brand-divider">/</span><strong>流程工作台</strong></span></a>
      <div className="header-task"><span className="task-name">{state.model.report.title}</span><button className="source-badge" onClick={() => setSourcesOpen(!sourcesOpen)} aria-label="查看任务资料来源"><FileText size={11} />{sourceLabel}<ChevronDown size={11} /></button></div>
      <div className="header-actions">
        <span className={`connection-status ${connected ? 'online' : ''}`}><i />{connected ? '本地已连接' : '连接暂时中断'}</span>
        <span className="version-badge">工作稿 W{state.workRevision}</span>
        <button className={`icon-button ${historyOpen ? 'active' : ''}`} title="查看修改记录" aria-label="查看修改记录" onClick={() => setHistoryOpen(!historyOpen)}><History size={17} /></button>
        <a className="secondary-button export-button" href="/api/model" download="model.json" title="导出当前已采用的 v1 模型；未采用补充随任务保存"><Download size={14} /> 导出模型</a>
      </div>
    </header>

    <div className="workspace">
      <main className="canvas-section">
        <div className="canvas-toolbar">
          {<div className="content-view-switch" role="group" aria-label="主视图"><button aria-pressed={!showContent} data-testid="view-graph" onClick={() => chooseContentView('graph')}>流程图</button><button aria-pressed={showContent} data-testid="view-content" onClick={() => chooseContentView('content')}>节点内容</button></div>}
          {!showContent&&<div className="search-wrap"><Search size={14} /><input aria-label="查找节点" placeholder="查找节点或内容" value={search} onChange={e => setSearch(e.target.value)} />{search && <button className="clear-search" aria-label="清除查找" onClick={() => setSearch('')}><X size={13} /></button>}{search.trim() && <div className="search-results">{searchResults.length ? searchResults.map(n => <button key={n.id} onClick={() => focusNode(n.id,!visibleIds.has(n.id))}><span>{n.title}</span><small>{state.model.groups.find(g => g.id === n.groupId)?.title}</small><ArrowRight size={13} /></button>) : <p>没有找到匹配节点。试试其他名称或内容。</p>}</div>}</div>}
          <div className="canvas-tools">
            {!showContent && <div className="graph-tool-menu" data-open={graphToolsOpen}><button className="graph-tool-toggle" aria-expanded={graphToolsOpen} aria-controls="graph-tool-items" onClick={()=>setGraphToolsOpen(open=>!open)}>图工具<ChevronDown size={12}/></button><div className="graph-tool-items" id="graph-tool-items">
            <select className="layout-direction" aria-label="流程图方向" data-testid="layout-direction" value={directionMode} disabled={savingDirection || !!layoutOperation || movingCount > 0 || draggingNode || !!Object.keys(positionOverrides.current[viewKey] || {}).length} onChange={event => void changeLayoutDirection(event.target.value as DirectionMode)} title="自动按画布宽高选择；每个分组分别记住设置">
              <option value="AUTO">自动 · {automaticDirection === 'RIGHT' ? '横向' : '纵向'}</option><option value="DOWN">纵向</option><option value="RIGHT">横向</option>
            </select>
            <button className="quiet-button arrange-layout" data-testid="arrange-layout" aria-label="整理当前图" title="重新整理当前图，覆盖手动位置；可撤销恢复" disabled={!directionReady || savingDirection || awaitingInitialLayout || !!layoutOperation || movingCount > 0 || !!Object.keys(positionOverrides.current[viewKey] || {}).length} onClick={() => void runLayout('arrange')}>{layoutOperation === 'arrange' || awaitingInitialLayout ? <LoaderCircle size={14} className="spin" /> : <Network size={14} />}<span>整理当前图</span></button>
            <button className="quiet-button reset-layout" data-testid="reset-layout" aria-label="重置位置" title="重置当前图全部位置（含固定节点），可撤销恢复" disabled={!directionReady || savingDirection || !manualNodeIds.length || awaitingInitialLayout || !!layoutOperation || movingCount > 0 || !!Object.keys(positionOverrides.current[viewKey] || {}).length} onClick={() => void runLayout('reset')}><ListRestart size={16} /><span>重置位置</span></button>
            <button className="icon-button" data-testid="undo-layout" aria-label="撤销本组整理" title="撤销本组整理" disabled={!directionReady || savingDirection || !currentLayout?.previous || !!layoutOperation || movingCount > 0} onClick={() => void runLayout('undo')}><Undo2 size={16} /></button>
            <button className="icon-button" title="适应当前图" aria-label="适应当前图" onClick={() => frameViewport('fit')}><Maximize2 size={16} /></button>
            </div></div>}
            <button className="quiet-button copy-top" disabled={copyBusy} onClick={() => void copyReference()} data-testid="copy-reference" aria-label="复制引用" title="复制已保存内容的引用"><Copy size={14} /><span>复制引用</span></button>
            <button className="icon-button" title="撤销最近一次内容修改" aria-label="撤销最近一次内容修改" onClick={() => void undo()} data-testid="undo"><RotateCcw size={16} /></button>

            {!showContent&&<button className="icon-button" title={inspectorOpen ? '收起节点详情' : '打开节点详情'} aria-label={inspectorOpen ? '收起节点详情' : '打开节点详情'} onClick={() => setInspectorOpen(!inspectorOpen)}>{inspectorOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</button>}
          </div>
        </div>
        <div className="canvas-stage">
        <div className={`graph-area${showContent ? ' is-covered' : ''}${awaitingInitialLayout ? ' is-initializing' : ''}`} ref={graphElement} style={showContent&&graphBox.current?{width:graphBox.current.width,height:graphBox.current.height,flex:"none"}:undefined} data-testid="graph-canvas" data-direction={direction} onKeyDownCapture={focusGraphObjectOnKey} aria-busy={awaitingInitialLayout || !directionReady}>
          {!showContent && <div className="graph-node-actions">{nodeActions}</div>}
          <nav className={`group-navigator ${navigationCollapsed ? 'is-collapsed' : ''}`} aria-label="流程分组导航" data-testid="group-navigator">
            <button className="navigator-toggle" aria-label={navigationCollapsed ? '展开分组导航' : '收起分组导航'} aria-expanded={!navigationCollapsed} onClick={() => setNavigationCollapsed(!navigationCollapsed)}><Layers3 size={15} /><span>整理分组</span><ChevronDown size={13} /></button>
            {!navigationCollapsed && <div className="navigator-list"><button className={`navigator-item all-groups ${group === 'all' ? 'active' : ''}`} aria-current={group === 'all' ? 'page' : undefined} onClick={() => changeGroup('all')} data-testid="group-all"><Layers3 size={13} /><span>完整流程</span><small>{state.model.nodes.length}</small></button>{state.model.groups.map((g, i) => <button key={g.id} style={groupStyle(i)} className={`navigator-item ${group === g.id ? 'active' : ''}`} aria-current={group === g.id ? 'page' : undefined} onClick={() => changeGroup(g.id)} data-testid={`group-${g.id}`}><span className="navigator-index">{String(i + 1).padStart(2, '0')}</span><span>{g.title}</span><small>{state.model.nodes.filter(n => n.groupId === g.id).length}</small></button>)}<p className="navigator-note">分组视图同时显示直接相连的上下游。</p></div>}
          </nav>
          <ReactFlow key={viewKey} nodes={flowNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onNodeClick={(_event, node) => focusNode(node.id, false)} onEdgeMouseEnter={(_event, edge) => setHoveredEdgeId(edge.id)} onEdgeMouseLeave={() => setHoveredEdgeId(null)} onEdgeClick={(_event, edge) => focusRelation(edge.id)} onNodeDragStart={() => { layoutRequest.current++; setLayoutOperation(null); setDraggingNode(true); }} onNodeDragStop={() => setDraggingNode(false)} onMoveEnd={(_event, viewport) => { if (viewTimer.current) clearTimeout(viewTimer.current); viewTimer.current = setTimeout(() => { if (viewKeyRef.current !== viewKey || !!currentLayout !== !!scopedLayout(stateRef.current, group, direction)) return; const key = cacheKey('viewport-scope-v2'); writeLocal(key, { ...readLocal<Record<string, Viewport>>(key, {}), [viewKey]: { ...viewport, scoped: !!currentLayout } }); }, 200); }} onSelectionChange={onGraphSelectionChange} onPaneClick={() => { setSelectedId(null); setSelection([]); setChosenText(null); setEditingNodeId(null); setError(''); }} minZoom={.25} maxZoom={1.7} nodesDraggable nodesConnectable={false} deleteKeyCode={null} selectionKeyCode="Shift" multiSelectionKeyCode="Shift" attributionPosition="bottom-right" proOptions={{ hideAttribution: true }} defaultViewport={{ x: 100, y: 50, zoom: .88 }}>
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#cbd5d0" />
          </ReactFlow>
          {awaitingInitialLayout && <div className="layout-loading" role="status"><LoaderCircle size={15} className="spin" />正在整理本组与相邻节点…</div>}
          {layoutError && <div className="layout-error" role="alert"><AlertCircle size={14} /><span>{layoutError}</span>{Object.keys(positionOverrides.current[viewKey] || {}).length > 0 && <button onClick={() => saveMovedPositions(group, { ...positionOverrides.current[viewKey] }, direction)}>重试保存位置</button>}<button aria-label="关闭布局提示" onClick={() => setLayoutError('')}><X size={13} /></button></div>}
          <div className="graph-legend"><span><i className="legend-line" /> 已知流转</span><span><i className="legend-line dashed" /> 返回 / 关联</span><span><i className="legend-issue" /> 有待确认</span></div>
          <div className="zoom-tools"><button aria-label="放大" onClick={() => void rf.zoomIn({ duration: 150 })}><Plus size={16} /></button><button aria-label="缩小" onClick={() => void rf.zoomOut({ duration: 150 })}><Minus size={16} /></button></div>
          {selection.length > 1 && <button className="selection-chip" disabled={copyBusy} onClick={() => void copyReference()}><Copy size={14} /> 复制这 {selection.length} 个对象的引用 <ArrowRight size={13} /></button>}
        </div>
        <NodeContent nodes={state.model.nodes} groups={state.model.groups} claimText={id=>state.model.claims.find(claim=>claim.id===id)?.text||''}
          nodeNumber={item=>state.model.nodes.filter(n=>n.groupId===item.groupId).findIndex(n=>n.id===item.id)+1}
          onSelect={id=>focusNode(id,false,false)} onMaterialEdit={()=>{}}
          enabled={materialsEnabled} materials={state.materials} sources={state.model.sources} legacyInputs={legacyInputs}
          location={proseLocation} visible={showContent} workspaceId={state.workspaceId} node={savedNode} tree={state.contentTree} materialsHash={state.materials?.hash} workRevision={state.workRevision} modelHash={state.modelHash} api={api} onState={acceptState} onNotify={notify} composeRequest={composeRequest}
          onCapture={captureText} renderNodeBody={(item,onNavigate)=><NodeProse model={state.model} nodeId={item.id} onNode={onNavigate}/>}

          materialsFor={id=>nodeMaterialsFor(state.model,id,state.contentTree,state.materials)}/>

        </div>
        <div className="canvas-footer"><span>{showContent ? `目录含 ${state.model.nodes.length} 个节点，阅读路径不改变业务流转` : <>{group === 'all' ? '全部节点与模型已有关系' : `${scope.coreNodes.length} 个本组节点 + ${scope.contextNodes.length} 个直接相邻节点`}<span className="footer-dot">·</span>Shift + 拖动可框选</>}</span>{!showContent && crossRelations.length > 0 && <button className={connectionsOpen ? 'active' : ''} onClick={() => setConnectionsOpen(!connectionsOpen)}><ArrowDownRight size={13} /> {crossRelations.length} 条跨组联系 <ChevronDown size={12} /></button>}</div>
        {!showContent && connectionsOpen && <div className="connections-popover"><div className="popover-heading">跨组联系<button className="icon-button" onClick={() => setConnectionsOpen(false)} aria-label="关闭跨组联系"><X size={14} /></button></div>{crossRelations.map(r => <button key={r.id} onClick={() => { focusNode(scope.coreIds.has(r.from) ? r.to : r.from, false); setConnectionsOpen(false); }}><span>{state.model.nodes.find(n => n.id === r.from)?.title}</span><ArrowRight size={13} /><span>{state.model.nodes.find(n => n.id === r.to)?.title}</span><small>{relationLabels[r.type]}</small></button>)}</div>}
      </main>

      {!showContent && inspectorOpen && <aside className={`inspector is-reading-copy`} data-testid="node-inspector" aria-label="节点详情">
        <div className="inspector-header">
          <div className="inspector-title"><FileText size={14} /> {showContent ? '节点预览' : '节点详情'}</div>
          {savedNode && <button className="inspector-copy" data-testid="view-node-materials" onClick={()=>locateProse('materials')}><FileText size={13}/>查看材料</button>}
          {savedNode && <button className="icon-button" disabled={copyBusy} aria-label="复制当前节点引用" title="复制当前节点引用"
            onClick={() => void copyReference([{ type: 'node', id: savedNode.id, label: savedNode.title }], null)}><Copy size={14} /></button>}
          <button className="icon-button" aria-label="关闭节点详情" onClick={() => setInspectorOpen(false)}><X size={16} /></button>
        </div>
        {currentNode && draft ? <>
          <div className="inspector-overview">
            <div className="inspector-heading">
              <label className="field-title" htmlFor="node-title">图上名称</label>
              <CompactTextarea id="node-title" data-testid="node-title" className="node-name-input" value={savedNode?.title || currentNode.title} readOnly />
            </div>
            <div className="node-context"><span className="inspector-group group-badge" style={groupStyle(state.model.groups.findIndex(g => g.id === currentNode.groupId))}>{String(state.model.groups.findIndex(g => g.id === currentNode.groupId) + 1).padStart(2, '0')} · {state.model.groups.find(g => g.id === currentNode.groupId)?.title}</span>{scope.contextIds.has(currentNode.id) ? <button className="jump-group" onClick={() => focusNode(currentNode.id, true)} data-testid="jump-to-group">组外 · 转到所属组 <ArrowRight size={12} /></button> : <span className="node-context-id" title={currentNode.id}>{currentNode.id}</span>}</div>

          </div>
          <div className="inspector-scroll" onMouseUp={captureText} onSelect={captureText}>
            {showContent ? <section className="node-compact-preview" data-testid="node-preview">
              <p className="preview-role">{(savedNode?.fields.role||[]).map(id=>state.model.claims.find(c=>c.id===id)?.text).filter(Boolean).join('、')||'执行者未说明'}</p>
              {(savedNode?.fields.actions||[]).length ? <ol className="preview-actions">{savedNode!.fields.actions.map(id=><li key={id} data-claim-id={id}>{state.model.claims.find(claim=>claim.id===id)?.text}</li>)}</ol> : <p className="unknown-text">资料未说明操作。</p>}
              <button className="quiet-button" onClick={()=>locateProse('actions')}>查看完整正文</button>
              <h3>后续与关联</h3>{branchRows.length?branchRows.map(branch=><button className="preview-path" key={branch.id} onClick={()=>locateProse('relations')}><span>{branch.conditions.map(c=>c.text).join('；')||relationLabels[outgoing.get(branch.id)?.type||'sequence']} → {state.model.nodes.find(n=>n.id===branch.to)?.title}</span></button>):<p className="unknown-text">当前没有已知后续关系。</p>}
              {!!selectedIssues.length&&<><h3>待确认 · {selectedIssues.length}</h3>{selectedIssues.map(issue=><button className="preview-issue" key={issue.id} onClick={()=>locateProse('issues')}>{issue.question}</button>)}</>}
              <button className="quiet-button" onClick={()=>locateProse('rules')}>查看规则与例外</button>
            </section> : <>
            {manualNodeIds.includes(currentNode.id) && <div className="manual-position"><Pin size={12} /><span>此图中已手动定位，整理时会重置</span><button data-testid="release-node-position" disabled={!!layoutOperation || movingCount > 0} onClick={() => void runLayout('release')}><PinOff size={12} />解除固定</button></div>}
            {incoming.length > 0 && <div className="incoming-summary"><span>来自</span>{incoming.map(r => <button key={r.id} onClick={() => focusNode(r.from, !visibleIds.has(r.from))}>{state.model.nodes.find(n => n.id === r.from)?.title}<ArrowDownRight size={11} /></button>)}</div>}
            <section className="editor-section">
              <div className="section-title"><h2 ref={actionsHeading} tabIndex={-1} className="inspector-actions-heading">操作说明</h2></div>
              {displayFields.actions?.length ? <ol className="inspector-actions" role="list">
                {displayFields.actions.map((claimId, index) => <li key={claimId}>
                  <label className="claim-editor" data-claim-id={claimId}>
                    <span className="action-index" aria-hidden="true">{index + 1}.</span>
                    <CompactTextarea readOnly aria-label={`操作说明 ${index + 1}`} data-testid={`claim-${claimId}`} value={readingDraft?.claims.find(c => c.id === claimId)?.text || ''} onChange={event => updateDraft(currentNode.id, next => { const claim = next.claims.find(c => c.id === claimId); if (claim) claim.text = event.target.value; })} />
                  </label>
                </li>)}
              </ol> : <p className="empty-hint">原文尚未说明动作。</p>}
            </section>
            <section className="editor-section" data-testid="node-details" key={`details-${currentNode.id}`}>
              <details className="full-details" open={expandedDetailsId === currentNode.id} onToggle={event => { const open = event.currentTarget.open; setExpandedDetailsId(previous => open ? currentNode.id : previous === currentNode.id ? null : previous); }}><summary>细节与补充<ChevronDown size={13} /></summary>

                {detailFields.map(field => <div className="detail-field" key={field} data-field={field}><h3>{fieldLabels[field] || field}</h3>{displayFields[field].length ? displayFields[field].map((claimId, index) => <CompactTextarea readOnly key={claimId} data-claim-id={claimId} aria-label={`${fieldLabels[field] || field} ${index + 1}`} value={readingDraft?.claims.find(c => c.id === claimId)?.text || ''} onChange={e => updateDraft(currentNode.id, d => { const c = d.claims.find(c => c.id === claimId); if (c) c.text = e.target.value; })} />) : <p className="unknown-text">资料未说明</p>}</div>)}
                {supplementalClaims.length > 0 && <div className="detail-field"><h3>补充说明</h3>{supplementalClaims.map((claim, index) => <CompactTextarea key={claim.id} data-claim-id={claim.id} aria-label={`补充说明 ${index + 1}`} readOnly value={claim.text} onChange={e => updateDraft(currentNode.id, d => { const c = d.claims.find(c => c.id === claim.id); if (c) c.text = e.target.value; })} />)}</div>}
                {!detailFields.length && !supplementalClaims.length && <p className="empty-hint">暂无细节与补充。</p>}
              </details>
            </section>
            <section className="editor-section paths-section">
              <div className="section-title"><h2>完成后走向 <span className="count-badge">{outgoing.size}</span></h2></div>
              {branchRows.length ? branchRows.map((branch, index) => {
                const relation = outgoing.get(branch.id);
                const destination = state.model.nodes.find(node => node.id === relation?.to);
                const label = relation && destination ? `${currentNode.title} → ${destination.title}` : undefined;
                const relationType = relation?.type || draft.branchTypes?.[branch.id] || 'sequence';
                const isSelected = selection.some(item => item.type === 'relation' && item.id === branch.id);
                return <div className={`branch-editor ${isSelected ? 'highlighted' : ''}`} key={branch.id} data-branch-id={branch.id}>
                  <div className="branch-heading"><span className="path-dot" /><span title={relationLabels[relationType]}>{index + 1}</span><small>{relationLabels[relationType]}</small></div>
                  {relation && label && <button className="branch-selector" data-testid={`select-relation-${branch.id}`}
                    aria-label={`选择连线 ${label}（${relationLabels[relationType] || relationType}）`} aria-pressed={isSelected}
                    onClick={() => {
                      if (selectedRelationId === relation.id && savedNode) setSelection([{ type: 'node', id: savedNode.id, label: savedNode.title }]);
                      else focusRelation(relation.id, false);
                    }}>
                    <span>{label}</span><small>{isSelected ? '已选中' : relationLabels[relationType] || relationType}</small>
                  </button>}
                  {branch.conditions.length ? branch.conditions.map((condition, conditionIndex) => <label className="branch-condition" key={condition.id} data-claim-id={condition.id}>
                    <span>条件</span>
                    <CompactTextarea readOnly aria-label={`路径 ${index + 1} 条件 ${conditionIndex + 1}`} data-testid={`condition-${condition.id}`} value={state.model.claims.find(c => c.id === condition.id)?.text || condition.text} onChange={event => updateDraft(currentNode.id, next => {
                      const item = next.branches.find(entry => entry.id === branch.id)?.conditions.find(entry => entry.id === condition.id);
                      if (item) item.text = event.target.value;
                    })} />
                  </label>) : <p className="unconditional">{relationType === 'sequence' ? '完成本步骤后' : `${relationLabels[relationType]}关系，未单列条件`}</p>}
                  <div className="branch-destination">
                    <ArrowRight size={13} /><span>前往</span>
                    {destination ? <button className="branch-target" data-testid={`destination-${branch.id}`} onClick={() => focusNode(destination.id, !visibleIds.has(destination.id))}>{destination.title}</button>
                      : <span className="branch-target">连线已从此节点移除</span>}
                  </div>
                </div>;
              }) : <p className="empty-hint">当前没有已知后续关系。</p>}
            </section>
            {selectedIssues.length > 0 && <section className="issues-section"><h2><AlertCircle size={14} /> 这里还有待确认</h2>{selectedIssues.map(issue => <button key={issue.id} onClick={() => void copyReference([{ type: 'issue', id: issue.id, label: issue.question }], null)} title="复制此疑点引用"><span>{issue.question}</span><Copy size={13} /></button>)}</section>}
            </>}
            {(legacyInputs[currentNode.id]||[]).length>0&&<p className="reader-draft-hint">有以前保留的未采用输入 <button onClick={()=>locateProse('materials')}>到节点材料中查看</button></p>}
            <section className="source-locations" data-testid="source-locations" aria-label="来源位置"><h2><FileText size={13} /> 来源位置</h2>
              {sourceLocations.map(location => <div className="source-location" key={location.key}>
                <span>{location.label}</span><span className={`origin-badge ${location.origin}`}>{originLabels[location.origin] || location.origin}</span>
              </div>)}
            </section>

            {chosenText && <button className="quote-selection" disabled={copyBusy} onClick={() => void copyReference([{ type: 'claim', id: chosenText.claimId, label: chosenText.text }])}><Copy size={13} /> 复制所选文字引用</button>}
          </div>

        </> : <div className="empty-inspector"><Waypoints size={30} /><h2>选中一个节点</h2><p>选择节点或连线可查看对应内容。</p><button className="secondary-button" disabled={copyBusy} onClick={() => void copyReference([], null)}><Copy size={14} /> 复制完整流程引用</button></div>}

      </aside>}
    </div>

    {agentTask && <AgentTaskPreview task={agentTask.task} revision={agentTask.workRevision} targets={agentTask.processingTargets}
      materials={agentTask.referenceTargets} quote={agentTask.quote} draft={agentTask.draft} includeDraft={agentTask.includeDraft}
      busy={copyBusy} stale={agentTaskStale} hasMissingTargets={agentTaskMissingTargets} error={agentTaskError} fallback={agentTaskStale ? '' : agentTaskFallback}
      onTaskChange={task => updateAgentTask({ task })} onIncludeDraft={includeDraft => updateAgentTask({ includeDraft })}
      onRemoveQuote={() => updateAgentTask({ quote: undefined })} onRefresh={refreshAgentTask} onCancel={closeAgentTask}
      onConfirm={() => void confirmAgentTask()} />}
    {sourcesOpen && <div className="source-panel"><div className="popover-heading"><span><FileText size={15} /> 任务资料来源</span><button className="icon-button" aria-label="关闭资料来源" onClick={() => setSourcesOpen(false)}><X size={15} /></button></div><p className="source-origin-label">{sourceLabel}</p>{sourceNames.map((name, index) => <div className="source-file" key={`${name}-${index}`}><FileText size={14} /><span>{name}</span></div>)}{state.model.report.scope && <p className="source-scope">{state.model.report.scope}</p>}{state.model.report.limitations?.length > 0 && <div className="source-limitations"><strong>阅读边界</strong>{state.model.report.limitations.map((item, index) => <p key={index}>{item}</p>)}</div>}</div>}
    {referenceFallback && <div className="reference-dialog-backdrop" onClick={() => setReferenceFallback('')}><section className="reference-dialog" role="dialog" aria-modal="true" aria-label="手动复制引用" onClick={event => event.stopPropagation()}><div className="popover-heading"><span><Copy size={15} /> 手动复制引用</span><button className="icon-button" aria-label="关闭引用" onClick={() => setReferenceFallback('')}><X size={15} /></button></div><p>复制以下内容，回到 AgentApp 的当前对话粘贴。</p><textarea aria-label="复制引用内容" data-testid="reference-fallback" readOnly autoFocus value={referenceFallback} onFocus={event => event.target.select()} /><button className="primary-button" onClick={() => setReferenceFallback('')}>完成</button></section></div>}
    {historyOpen && <div className="history-panel"><div className="popover-heading"><span><History size={16} /> 修改记录</span><button className="icon-button" aria-label="关闭修改记录" onClick={() => setHistoryOpen(false)}><X size={15} /></button></div><p className="history-intro">内容修改会生成记录；保存不代表业务事实已核实。</p>{(state.changes || []).length ? state.changes.slice(0, 20).map((change, i) => <article key={change.id || i}><span className="history-dot" /><div><strong>{change.summary || change.message || '工作稿已更新'}</strong><p>{change.actor === 'agent' ? 'Agent 协助' : '直接编辑'}<span>·</span>{change.at || change.createdAt ? new Date(change.at || change.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : `记录 ${state.changes.length - i}`}</p>{(change.items || []).filter((item: any) => item.before !== item.after).slice(0, 6).map((item: any, index: number) => <div className="change-comparison" key={index}><small>{item.label || item.id}</small>{item.before && <del>{item.before}</del>}{item.after && <ins>{item.after}</ins>}</div>)}{change.details && <small>{typeof change.details === 'string' ? change.details : JSON.stringify(change.details)}</small>}</div></article>) : <div className="empty-history"><History size={25} /><p>还没有内容修改</p><span>修改一个节点并保存，记录会出现在这里。</span></div>}</div>}
    {toast && <div className={`toast ${toast.kind}`} role="status">{toast.kind === 'error' ? <AlertCircle size={17} /> : toast.kind === 'info' ? <Info size={17} /> : <Check size={17} />}<span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={13} /></button></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><ReactFlowProvider><Workbench /></ReactFlowProvider></React.StrictMode>);
