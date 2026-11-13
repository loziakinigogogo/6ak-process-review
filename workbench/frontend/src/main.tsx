import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Handle, Position, getViewportForBounds, MarkerType, useReactFlow, applyNodeChanges, type NodeProps, type Node as FlowNode, type Edge as FlowEdge, type NodeChange, type Viewport } from '@xyflow/react';
import { SmartEdgeProvider, type SmartEdgeProviderOptions } from '@tisoap/react-flow-smart-edge';
import { ArrowDownRight, ArrowRight, Check, ChevronDown, Copy, Download, FileText, GitBranch, History, Info, Layers3, LoaderCircle, Maximize2, Minus, Plus, RotateCcw, Save, Search, Waypoints, X, AlertCircle, PanelRightClose, PanelRightOpen, Network, Pin, PinOff, Undo2 } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { getGraphScope } from './graph-scope.mjs';
import { arrangeGraph, routeGeometryKey } from './graph-layout.mjs';
import { ProcessEdge, measureEdgeLabel, type ScopedLayout, type Point } from './graph-routing';

type Claim = { id: string; text: string; origin: string; evidence: Array<{ sourceId: string; startLine: number; endLine: number; quote: string }>; issueIds?: string[] };
type ModelNode = { id: string; title: string; groupId: string; claimIds: string[]; fields: Record<string, string[]> };
type Relation = { id: string; from: string; to: string; type: string; claimIds: string[]; conditionClaimIds: string[] };
type Model = { report: { id: string; title: string; scope: string; limitations: string[] }; nodes: ModelNode[]; groups: Array<{ id: string; title: string; kind: string }>; claims: Claim[]; relations: Relation[]; sources: Array<{ id: string; name: string; text: string; kind?: string }>; issues: Array<{ id: string; question: string; status: string; nodeIds: string[]; relationIds: string[]; impact: string }> };
type WorkState = { workspaceId: string; contentOrigin?: { kind: 'synthetic' | 'documents'; label: string; sourceNames: string[] }; stateRevision: number; workRevision: number; modelHash: string; preferenceHash?: string; model: Model; view: { positions: Record<string, Point>; layouts?: Record<string, ScopedLayout>; manualNodeIds?: string[]; selectedGroupId?: string; selectedNodeId?: string; viewport?: Viewport }; pendingEdits: any[]; changes: any[]; updatedAt: string; lastSave?: { kind: string; message: string } };
type BranchDraft = { id: string; to: string; conditions: Array<{ id: string; text: string }> };
type Draft = { nodeId: string; nodeSnapshot: ModelNode; branchTypes: Record<string, string>; title: string; groupId: string; claims: Array<{ id: string; text: string }>; branches: BranchDraft[]; baseTitle: string; baseGroupId: string; baseClaims: Array<{ id: string; text: string }>; baseBranches: BranchDraft[]; baseWorkRevision: number; baseModelHash: string; intent: 'current' | 'proposal'; dirty: boolean; revision: number };
type Selection = { type: string; id: string; label: string };
type Toast = { text: string; kind: 'success' | 'error' | 'info' };
const fieldLabels: Record<string, string> = { role: '负责人', system: '工具 / 系统', trigger: '触发条件', input: '输入资料', actions: '操作说明', output: '完成结果', rules: '注意事项' };
const relationLabels: Record<string, string> = { sequence: '顺序', conditional: '条件', parallel: '并行', return: '返回', data: '数据交付', association: '关联' };
const routingOptions: SmartEdgeProviderOptions = { preset: 'smoothstep', nodePadding: 16, gridRatio: 8, borderRadius: 8, routeOnlyWhenBlocked: false, routeWhileDragging: true, debounceMs: 25 };
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
  useLayoutEffect(() => { if (element.current) { element.current.style.height = 'auto'; element.current.style.height = `${Math.min(160, element.current.scrollHeight)}px`; } }, [props.value]);
  return <textarea {...props} rows={1} ref={element} />;
}

function ProcessCard({ data, selected }: NodeProps) {
  const item = data as { title: string; role: string; groupIndex: number; groupTitle: string; context: boolean; issueCount: number; unknownCount: number; changed: boolean; draft: boolean; incoming: number; outgoing: number };
  return <div className={`process-card ${selected ? 'is-selected' : ''} ${item.context ? 'context-node' : ''} ${item.draft ? 'has-draft' : ''}`} style={groupStyle(item.groupIndex)} data-testid={`graph-node-${String(data.nodeId)}`} data-group-id={String(data.groupId)} data-context={item.context ? 'true' : 'false'} data-manual={data.manual ? 'true' : 'false'}>
    <Handle id="top" type="target" position={Position.Top} />
    <Handle id="left-target" type="target" position={Position.Left} />
    <div className="node-eyebrow"><span className="node-group-badge group-badge" title={`${item.groupIndex + 1} 组 · ${item.groupTitle}`}><b>{String(item.groupIndex + 1).padStart(2, '0')}</b><span>{item.groupTitle}</span></span>{item.context && <span className="context-badge">组外</span>}{item.changed && <i className="changed-dot" title="本轮已修改" />}</div>
    <div className="node-title">{item.title}{Boolean(data.manual) && <Pin size={12} className="node-pin" aria-label="已固定位置" />}</div>
    {item.role && <div className="node-role" title={item.role}>{item.role}</div>}
    <div className="node-meta"><span>{item.outgoing > 1 ? <><GitBranch size={11} /> {item.outgoing} 条路径</> : <><ArrowDownRight size={11} /> 查看步骤</>}</span>{item.issueCount > 0 && <span className="node-issue"><AlertCircle size={11} /> {item.issueCount} 待确认</span>}{!item.issueCount && item.unknownCount > 0 && <span className="node-issue"><AlertCircle size={11} /> {item.unknownCount} 项未说明</span>}{item.draft && <span className="node-draft">编辑中</span>}</div>
    <Handle id="bottom" type="source" position={Position.Bottom} />
    <Handle id="left-source" type="source" position={Position.Left} />
  </div>;
}

const nodeTypes = { process: ProcessCard };
const edgeTypes = { process: ProcessEdge };

function Workbench() {
  const [state, setState] = useState<WorkState | null>(null);
  const [loadingError, setLoadingError] = useState('');
  const [connected, setConnected] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [group, setGroup] = useState('all');
  const [search, setSearch] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [bufferStatus, setBufferStatus] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth > 760);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => window.innerWidth <= 760);
  const [selection, setSelection] = useState<Selection[]>([]);
  const [chosenText, setChosenText] = useState<{ text: string; claimId: string } | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const [referenceFallback, setReferenceFallback] = useState('');
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [flowNodes, setFlowNodes] = useState<FlowNode[]>([]);
  const [layoutOperation, setLayoutOperation] = useState<string | null>(null);
  const [layoutMessage, setLayoutError] = useState('');
  const [moveVersion, setMoveVersion] = useState(0);
  const [movingCount, setMovingCount] = useState(0);
  const positionOverrides = useRef<Record<string, Record<string, Point>>>({});
  const moveQueue = useRef<Promise<void>>(Promise.resolve());
  const layoutRequest = useRef(0);
  const initialLayoutAttempts = useRef(new Set<string>());
  const layoutError = layoutMessage || (!movingCount && Object.keys(positionOverrides.current[group] || {}).length ? '此图有尚未保存的位置，请重试保存。' : '');
  const rf = useReactFlow();
  const stateRef = useRef(state); stateRef.current = state;
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const bufferTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const initialized = useRef(false);
  const restorationComplete = useRef(false);
  const viewInitialized = useRef<string>('');
  const graphElement = useRef<HTMLDivElement>(null);
  const viewportFrame = useRef<number | null>(null);
  const viewportRequest = useRef(0);
  const groupRef = useRef(group); groupRef.current = group;
  const navigationCollapsedRef = useRef(navigationCollapsed); navigationCollapsedRef.current = navigationCollapsed;
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightFetch = useRef(0);
  const [lastSavedAt, setLastSavedAt] = useState('');

  const notify = useCallback((text: string, kind: Toast['kind'] = 'success') => setToast({ text, kind }), []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 5500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 760px)');
    const collapseNavigation = () => { if (narrow.matches) setNavigationCollapsed(true); };
    narrow.addEventListener('change', collapseNavigation);
    return () => narrow.removeEventListener('change', collapseNavigation);
  }, []);
  const acceptState = useCallback((next: WorkState) => {
    if (stateRef.current && next.stateRevision < stateRef.current.stateRevision) return;
    if (stateRef.current && next.modelHash !== stateRef.current.modelHash) {
      let removed = 0;
      for (const [scopeId, positions] of Object.entries(positionOverrides.current)) {
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
        const pending = readPendingPositions();
        positionOverrides.current = {};
        for (const [scopeId, positions] of Object.entries(pending)) {
          if (scopeId !== 'all' && !next.model.groups.some(g => g.id === scopeId)) continue;
          const ids = getGraphScope(next.model, scopeId).visibleIds;
          const retained = Object.entries(positions || {}).filter(([id, point]) => {
            const saved = next.view.layouts?.[scopeId]?.positions[id] || next.view.positions[id];
            return ids.has(id) && point && Number.isFinite(point.x) && Number.isFinite(point.y) && Math.abs(point.x) <= 1000000 && Math.abs(point.y) <= 1000000 && (saved?.x !== point.x || saved?.y !== point.y);
          });
          if (retained.length) positionOverrides.current[scopeId] = Object.fromEntries(retained);
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
        for (const [id, entry] of Object.entries(diskBuffers)) { const d = (entry as any)?.draft || entry; if (d?.dirty && d?.nodeId && next.model.nodes.some(n => n.id === d.nodeId)) restored[d.nodeId] = d; }
        for (const [id, d] of Object.entries(localBuffers)) if (d?.dirty && next.model.nodes.some(n => n.id === id) && (!restored[id] || d.revision > restored[id].revision)) restored[id] = d;
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
  const displayFields = draft?.dirty && draft.nodeSnapshot ? draft.nodeSnapshot.fields : currentNode?.fields || {};
  const selectedIssues = state?.model.issues.filter(i => i.status === 'open' && (i.nodeIds.includes(selectedId || '') || i.relationIds.some(id => state.model.relations.find(r => r.id === id)?.from === selectedId))) || [];
  const selectedClaims = currentNode?.claimIds.map(id => state?.model.claims.find(c => c.id === id)).filter((c): c is Claim => !!c) || [];
  const currentGroup = state?.model.groups.find(g => g.id === group);
  const scope = useMemo(() => getGraphScope(state?.model || { nodes: [], relations: [] }, group), [state?.model, group]);
  const visibleModelNodes = scope.nodes as ModelNode[];
  const visibleIds = scope.visibleIds;
  const crossRelations = scope.crossGroupRelations as Relation[];
  const currentLayout = state?.view.layouts?.[group];
  const initialLayoutKey = `${state?.workspaceId}:${group}:${state?.modelHash}`;
  const needsInitialLayout = !!state && group !== 'all' && !currentLayout && visibleIds.size > 0 && !movingCount && !Object.keys(positionOverrides.current[group] || {}).length;
  const awaitingInitialLayout = needsInitialLayout && (!initialLayoutAttempts.current.has(initialLayoutKey) || layoutOperation === 'initialize');
  const awaitingInitialLayoutRef = useRef(awaitingInitialLayout); awaitingInitialLayoutRef.current = awaitingInitialLayout;
  const manualNodeIds = currentLayout?.manualNodeIds || state?.view.manualNodeIds || [];
  const searchResults = useMemo(() => { if (!search.trim() || !state) return []; const q = search.trim().toLowerCase(); return state.model.nodes.filter(n => n.title.toLowerCase().includes(q) || n.claimIds.some(id => state.model.claims.find(c => c.id === id)?.text.toLowerCase().includes(q))).slice(0, 8); }, [search, state?.model]);

  useEffect(() => {
    if (!state) return;
    const next: FlowNode[] = visibleModelNodes.map((item, index) => ({
      id: item.id, type: 'process', position: positionOverrides.current[group]?.[item.id] || currentLayout?.positions[item.id] || state.view.positions[item.id] || { x: (index % 3) * 280 + 30, y: Math.floor(index / 3) * 180 + 30 },
      selected: item.id === selectedId || selection.some(s => s.type === 'node' && s.id === item.id),
      data: { nodeId: item.id, title: item.title, role: (item.fields.role || []).map(id => state.model.claims.find(c => c.id === id)?.text).filter(Boolean).join('、').replace(/[。.]$/, ''), groupId: item.groupId, groupIndex: state.model.groups.findIndex(g => g.id === item.groupId), groupTitle: state.model.groups.find(g => g.id === item.groupId)?.title || item.groupId, context: scope.contextIds.has(item.id), issueCount: state.model.issues.filter(i => i.status === 'open' && (i.nodeIds.includes(item.id) || i.relationIds.some(id => state.model.relations.some(r => r.id === id && r.from === item.id)))).length, unknownCount: item.claimIds.filter(id => state.model.claims.some(c => c.id === id && c.origin === 'unknown')).length, changed: (state.changes || []).slice(0, 1).some(c => c.nodeIds?.includes(item.id) || c.targetIds?.includes(item.id) || c.nodeId === item.id), draft: !!drafts[item.id]?.dirty, outgoing: state.model.relations.filter(r => r.from === item.id).length, incoming: state.model.relations.filter(r => r.to === item.id).length },
    }));
    for (const node of next) {
      node.data.layoutScopeId = group;
      node.data.manual = manualNodeIds.includes(node.id) || !!positionOverrides.current[group]?.[node.id];
    }
    setFlowNodes(previous => next.map(n => {
      const old = previous.find(p => p.id === n.id);
      // Preserve React Flow's measurements during content updates. Clearing them
      // hides unchanged DOM nodes until a resize observation happens again.
      return old ? { ...n, measured: old.measured, ...(old.dragging ? { position: old.position, dragging: true } : {}) } : n;
    }));
  }, [state, visibleModelNodes, selectedId, drafts, selection, scope.contextIds, group, moveVersion]);

  const geometryNodes = useMemo(() => flowNodes.map(node => ({ id: node.id, ...node.position, width: node.measured?.width || 200, height: node.measured?.height || 113 })), [flowNodes]);
  const geometryEdges = useMemo(() => (scope.relations as Relation[]).map(relation => {
    const label = relation.conditionClaimIds.map(id => state?.model.claims.find(c => c.id === id)?.text || '').join('；') || (['return', 'data', 'association'].includes(relation.type) ? relationLabels[relation.type] : '');
    return { id: relation.id, from: relation.from, to: relation.to, type: relation.type, label, ...measureEdgeLabel(label) };
  }), [scope.relations, state?.model]);
  const geometryKey = useMemo(() => routeGeometryKey(geometryNodes, geometryEdges), [geometryNodes, geometryEdges]);

  const edges = useMemo<FlowEdge[]>(() => {
    if (!state) return [];
    return geometryEdges.map(r => ({ id: r.id, source: r.from, target: r.to, type: 'process', sourceHandle: r.type === 'return' ? 'left-source' : 'bottom', targetHandle: r.type === 'return' ? 'left-target' : 'top', selected: selection.some(s => s.type === 'relation' && s.id === r.id), markerEnd: { type: MarkerType.ArrowClosed, width: 17, height: 17, color: r.from === selectedId ? '#16816d' : '#7c9294' }, data: { kind: r.type, highlighted: r.from === selectedId, obstacles: geometryNodes, label: r.label, labelWidth: r.labelWidth, labelHeight: r.labelHeight, route: currentLayout?.routes[r.id]?.geometryKey === geometryKey ? currentLayout.routes[r.id] : undefined } }));
  }, [state?.model, geometryEdges, geometryNodes, geometryKey, currentLayout, selection, selectedId]);

  const persistView = useCallback(async (patch: Record<string, unknown>) => { try { const next = await api<WorkState>('/api/workbench/view', patch, 'PATCH'); acceptState(next); } catch { notify('布局尚未保存，内容修改不受影响。', 'error'); } }, [acceptState, notify]);

  const saveMovedPositions = useCallback((scopeId: string, positions: Record<string, Point>) => {
    layoutRequest.current++;
    setLayoutOperation(null);
    positionOverrides.current[scopeId] = { ...positionOverrides.current[scopeId], ...clone(positions) };
    writePendingPositions(positionOverrides.current);
    setMoveVersion(value => value + 1); setMovingCount(value => value + 1); setLayoutError('');
    moveQueue.current = moveQueue.current.then(async () => {
      const current = stateRef.current;
      if (!current) return;
      try {
        const next = await api<WorkState>('/api/workbench/view', { layout: { scopeId, action: 'move', baseRevision: current.view.layouts?.[scopeId]?.revision || 0, positions } }, 'PATCH');
        acceptState(next);
        for (const [id, position] of Object.entries(positions)) if (JSON.stringify(positionOverrides.current[scopeId]?.[id]) === JSON.stringify(position)) delete positionOverrides.current[scopeId][id];
        writePendingPositions(positionOverrides.current);
        setMoveVersion(value => value + 1);
      } catch (cause) {
        setLayoutError(`位置尚未保存：${(cause as Error).message}`);
        void fetchState();
      }
    }).finally(() => setMovingCount(value => value - 1));
  }, [acceptState, fetchState]);

  const runLayout = async (action: 'initialize' | 'arrange' | 'undo' | 'release') => {
    const initial = stateRef.current;
    if (!initial || movingCount || Object.keys(positionOverrides.current[group] || {}).length) return;
    const scopeId = group, request = ++layoutRequest.current;
    const layout = initial.view.layouts?.[scopeId];
    const baseRevision = layout?.revision || 0;
    if (action === 'initialize') {
      if (layout || initialLayoutAttempts.current.has(initialLayoutKey)) return;
      initialLayoutAttempts.current.add(initialLayoutKey);
    }
    setLayoutOperation(action); setLayoutError('');
    try {
      let patch: Record<string, unknown> = { scopeId, action, baseRevision };
      if (action === 'arrange' || action === 'initialize') {
        const nodes = rf.getNodes().filter(node => visibleIds.has(node.id)).map(node => ({ id: node.id, ...(action === 'initialize' ? initial.view.positions[node.id] || node.position : node.position), width: node.measured?.width || 200, height: node.measured?.height || 113 }));
        const result = await arrangeGraph({ nodes, edges: geometryEdges, manualNodeIds: layout?.manualNodeIds || initial.view.manualNodeIds || [] });
        if (request !== layoutRequest.current || groupRef.current !== scopeId) return;
        patch = { ...patch, baseModelHash: initial.modelHash, positions: result.positions, routes: result.routes };
      } else if (action === 'release') patch.nodeIds = selectedRef.current ? [selectedRef.current] : [];
      const latest = stateRef.current;
      if (latest?.modelHash !== initial.modelHash || (latest?.view.layouts?.[scopeId]?.revision || 0) !== baseRevision) throw new Error('内容或位置已有更新，请基于当前图重新整理。');
      const next = await api<WorkState>('/api/workbench/view', { layout: patch }, 'PATCH');
      acceptState(next);
      if (request !== layoutRequest.current || groupRef.current !== scopeId) return;
      if (action !== 'release') {
        const savedViews = readLocal<Record<string, Viewport>>(cacheKey('viewport-scope-v2'), {});
        delete savedViews[scopeId]; writeLocal(cacheKey('viewport-scope-v2'), savedViews);
        requestAnimationFrame(() => {
          if (request === layoutRequest.current && groupRef.current === scopeId) frameViewport('initialize');
        });
      }
      if (action !== 'initialize') notify(action === 'arrange' ? `已整理当前图，保留 ${next.view.layouts?.[scopeId]?.manualNodeIds.length || 0} 个固定位置` : action === 'undo' ? '已撤销整理，后续手动调整仍保留' : '已解除固定，下次整理会包含此节点');
    } catch (cause) {
      if (request === layoutRequest.current && groupRef.current === scopeId) setLayoutError(action === 'initialize' ? `本组布局尚未生成，可点击“整理当前图”重试。${(cause as Error).message}` : (cause as Error).message);
      void fetchState();
    } finally {
      // A canceled calculation can be retried on return; a failed request waits
      // for an explicit retry instead of writing again on every state event.
      if (action === 'initialize' && request !== layoutRequest.current && !stateRef.current?.view.layouts?.[scopeId]) {
        initialLayoutAttempts.current.delete(initialLayoutKey);
        setMoveVersion(value => value + 1);
      }
      if (request === layoutRequest.current) setLayoutOperation(null);
    }
  };

  useEffect(() => { layoutRequest.current++; setLayoutOperation(null); setLayoutError(''); }, [group]);

  useEffect(() => {
    if (!needsInitialLayout || layoutOperation || initialLayoutAttempts.current.has(initialLayoutKey)) return;
    const nodes = rf.getNodes();
    // Counts alone are insufficient: adjacent groups can have equal-sized scopes.
    // Wait for the current IDs and real card measurements before calling ELK.
    if (nodes.length !== visibleIds.size || nodes.some(node => !visibleIds.has(node.id) || node.data.layoutScopeId !== group || !node.measured?.width || !node.measured?.height || node.dragging)) return;
    void runLayout('initialize');
  }, [initialLayoutKey, needsInitialLayout, layoutOperation, flowNodes, moveVersion]);

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
      const first = stateRef.current?.model.nodes.find(n => n.groupId === id); if (first) { focusNode(first.id, true, false); return; }
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
      const projection = getGraphScope(currentState.model, currentGroup);
      const ids = projection.visibleIds;
      const nodes = rf.getNodes().filter(n => ids.has(n.id));
      if (!ids.size) return;
      // A breakpoint changes the graph box and React Flow measurements separately.
      // Wait for consecutive layout frames, then use the actual box, not cached store dimensions.
      const size = `${area.width}:${area.height}:${nodes.length}`;
      stableFrames = size === previousSize ? stableFrames + 1 : 0;
      previousSize = size;
      if (area.width < 80 || area.height < 80 || nodes.length !== ids.size || stableFrames < 2) {
        viewportFrame.current = requestAnimationFrame(measure); return;
      }
      const framedNodes = mode === 'fit' || currentGroup === 'all' ? nodes : nodes.filter(node => projection.coreIds.has(node.id));
      const boxes = framedNodes.map(node => {
        const nodeElement = [...element.querySelectorAll<HTMLElement>('.react-flow__node')].find(e => e.dataset.id === node.id);
        return { x: node.position.x, y: node.position.y, width: nodeElement?.offsetWidth || node.measured?.width || 200, height: nodeElement?.offsetHeight || node.measured?.height || 96 };
      });
      const left = Math.min(...boxes.map(b => b.x)), top = Math.min(...boxes.map(b => b.y));
      const bounds = { x: left, y: top, width: Math.max(...boxes.map(b => b.x + b.width)) - left, height: Math.max(...boxes.map(b => b.y + b.height)) - top };
      const saved = mode === 'initialize' ? readLocal<Record<string, Viewport & { scoped?: boolean }>>(cacheKey('viewport-scope-v2'), {})[currentGroup] : null;
      // A different window may have created the local layout since this browser
      // saved a zoom for global coordinates. Do not reuse that coordinate frame.
      const validSaved = saved && !!saved.scoped === !!currentState.view.layouts?.[currentGroup] && [saved.x, saved.y, saved.zoom].every(Number.isFinite) && saved.zoom >= .25 && saved.zoom <= 1.7;
      let viewport: Viewport;
      const leftInset = !navigationCollapsedRef.current && area.width > 600 ? 220 : 16;
      const availableWidth = Math.max(100, area.width - leftInset - 16);
      if (validSaved) viewport = saved;
      else if (currentGroup === 'all' && mode !== 'fit') {
        const origin = nodes.find(n => n.id === selectedRef.current) || nodes[0];
        viewport = { x: leftInset + availableWidth / 2 - (origin.position.x + 100) * .9, y: 70 - origin.position.y * .9, zoom: .9 };
      } else {
        viewport = getViewportForBounds(bounds, availableWidth, area.height, mode === 'fit' ? .25 : .82, 1, .14);
        viewport.x += leftInset;
        if (mode !== 'fit' && (bounds.height * viewport.zoom > area.height - 80 || bounds.width * viewport.zoom > availableWidth - 40)) {
          const origin = nodes.find(node => node.id === selectedRef.current) || framedNodes[0];
          viewport.x = leftInset + availableWidth / 2 - (origin.position.x + (origin.measured?.width || 200) / 2) * viewport.zoom;
          viewport.y = Math.min(230, area.height * .32) - (origin.position.y + (origin.measured?.height || 113) / 2) * viewport.zoom;
        }
      }
      viewInitialized.current = currentGroup;
      viewportFrame.current = null;
      // Cancel any earlier animated target; a completed fit must describe this exact box.
      void rf.setViewport(viewport, { duration: 0 });
    };
    viewportFrame.current = requestAnimationFrame(measure);
  }, [rf]);

  useEffect(() => {
    if (state && flowNodes.length && !awaitingInitialLayout && viewInitialized.current !== group) frameViewport('initialize');
  }, [Boolean(state), flowNodes.length, group, awaitingInitialLayout, frameViewport]);

  useEffect(() => {
    const element = graphElement.current; if (!element) return;
    let previousSize = '';
    const observer = new ResizeObserver(() => {
      const area = element.getBoundingClientRect(), size = `${area.width}:${area.height}`;
      if (previousSize && size !== previousSize && viewInitialized.current === groupRef.current) frameViewport('resize');
      previousSize = size;
    });
    observer.observe(element);
    return () => { observer.disconnect(); viewportRequest.current++; if (viewportFrame.current !== null) cancelAnimationFrame(viewportFrame.current); };
  }, [Boolean(state), frameViewport]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setFlowNodes(nodes => applyNodeChanges(changes, nodes));
    const settled: Record<string, Point> = {};
    for (const change of changes) if (change.type === 'position' && change.dragging === false && change.position) settled[change.id] = change.position;
    if (Object.keys(settled).length) saveMovedPositions(groupRef.current, settled);
  }, [saveMovedPositions]);
  const onGraphSelectionChange = useCallback(({ nodes, edges: selectedEdges }: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
    if (nodes.length < 2 && selectedEdges.length < 2) return;
    const next = [...nodes.map(n => ({ type: 'node', id: n.id, label: String(n.data.title) })), ...selectedEdges.map(e => ({ type: 'relation', id: e.id, label: '所选连接' }))];
    setSelection(previous => previous.length === next.length && previous.every((s, i) => s.type === next[i].type && s.id === next[i].id) ? previous : next);
  }, []);

  async function clearDraft(id: string) {
    const s = stateRef.current; if (!s) return;
    const next = draftFor(s, id); if (!next) return;
    next.revision = Math.max(Date.now(), (draftsRef.current[id]?.revision || 0) + 1);
    const timer = bufferTimers.current.get(id); if (timer) clearTimeout(timer);
    draftsRef.current = { ...draftsRef.current, [id]: next }; setDrafts(draftsRef.current); setError(''); await persistBuffer(next);
  }

  async function saveNode() {
    if (!draft || !state || !currentNode) return;
    const submitted = clone(draft);
    setSaving(true); setError('');
    try {
      const changedClaims = draft.claims.filter(c => draft.baseClaims.find(old => old.id === c.id)?.text !== c.text);
      const changedBranches = draft.branches.filter(b => JSON.stringify(draft.baseBranches.find(old => old.id === b.id)) !== JSON.stringify(b));
      const next = await api<WorkState>('/api/workbench/edits', { requestId: stamp(), baseWorkRevision: draft.baseWorkRevision, baseModelHash: draft.baseModelHash, nodeId: draft.nodeId, ...(draft.title !== draft.baseTitle ? { title: draft.title } : {}), ...(draft.groupId !== draft.baseGroupId ? { groupId: draft.groupId } : {}), ...(changedClaims.length ? { claims: changedClaims } : {}), ...(changedBranches.length ? { branches: changedBranches } : {}), intent: draft.intent });
      acceptState(next);
      const latest = draftsRef.current[draft.nodeId] || submitted;
      if (next.lastSave?.kind === 'pending') {
        const retained = { ...clone(latest), baseWorkRevision: next.workRevision, baseModelHash: next.modelHash, revision: Math.max(Date.now(), latest.revision + 1) };
        draftsRef.current = { ...draftsRef.current, [draft.nodeId]: retained }; setDrafts(draftsRef.current); await persistBuffer(retained);
      } else if (latest.revision !== submitted.revision) {
        const retained = carryNewerInput(submitted, latest, next);
        if (retained) { draftsRef.current = { ...draftsRef.current, [draft.nodeId]: retained }; setDrafts(draftsRef.current); await persistBuffer(retained); }
        else setError('已保存提交时的内容。随后输入已保留；部分原句身份变化，请复制相关引用，在 AgentApp 中核对后继续。');
      } else await clearDraft(draft.nodeId);
      setLastSavedAt(new Date().toISOString());
      notify(next.lastSave?.message || (draft.intent === 'proposal' ? '待定建议已保存，可以稍后继续整理。' : '节点已保存，图与详情已同步。'));
    } catch (cause) { const error = cause as Error & { status?: number }; setError(error.status === 409 ? `工作稿已有新修改。你的输入已保留，重新核对后再保存。${error.message}` : error.message); }
    finally { setSaving(false); }
  }

  function rebaseDraft() {
    if (!state || !draft) return;
    const latest = draftFor(state, draft.nodeId); if (!latest) return;
    const change = { title: draft.title !== draft.baseTitle ? draft.title : latest.title, groupId: draft.groupId !== draft.baseGroupId ? draft.groupId : latest.groupId };
    const edits = draft.claims.filter(c => draft.baseClaims.find(old => old.id === c.id)?.text !== c.text);
    const missing = edits.filter(c => !latest.claims.some(n => n.id === c.id));
    const editedBranches = draft.branches.filter(b => JSON.stringify(b) !== JSON.stringify(draft.baseBranches.find(old => old.id === b.id)));
    const missingBranches = editedBranches.some(b => { const current = latest.branches.find(n => n.id === b.id); return !current || b.conditions.some(c => !current.conditions.some(n => n.id === c.id)) || (b.to && !state.model.nodes.some(n => n.id === b.to)); });
    if (missing.length || missingBranches) { setError('部分原句或连接身份已经改变。输入仍已保留，请复制相关引用，在 AgentApp 中核对这些修改。'); return; }
    latest.title = change.title; latest.groupId = change.groupId;
    for (const item of edits) { const c = latest.claims.find(c => c.id === item.id); if (c) c.text = item.text; }
    for (const branch of draft.branches) if (JSON.stringify(branch) !== JSON.stringify(draft.baseBranches.find(b => b.id === branch.id))) { const target = latest.branches.find(b => b.id === branch.id); if (target) { target.to = branch.to; target.conditions = clone(branch.conditions); } }
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
    draftsRef.current = { ...draftsRef.current, [pending.nodeId]: restored }; setDrafts(draftsRef.current); void persistBuffer(restored); setError(''); notify('待定建议已恢复到表单，可以继续编辑。', 'info');
  }

  async function undo() {
    if (!state) return;
    try { const next = await api<WorkState>('/api/workbench/undo', { requestId: stamp(), baseWorkRevision: state.workRevision, baseModelHash: state.modelHash }); acceptState(next); notify('已撤销最近一次内容修改，编辑中的输入仍保留。'); }
    catch (cause) { notify((cause as Error).message, 'error'); }
  }

  async function copyReference(targets?: Selection[], quote: typeof chosenText = chosenText) {
    if (!state || copyBusy) return;
    if (quote && !state.model.claims.find(claim => claim.id === quote.claimId)?.text.includes(quote.text)) {
      notify('所选文字还未保存。请先保存节点，再复制这段文字的引用。', 'info'); return;
    }
    const selectedTargets = targets || (selection.length ? selection : currentNode ? [{ type: 'node', id: currentNode.id, label: currentNode.title }] : []);
    const referenceTargets = quote && !selectedTargets.some(t => t.type === 'claim' && t.id === quote.claimId) ? [...selectedTargets, { type: 'claim', id: quote.claimId, label: quote.text }] : selectedTargets;
    setCopyBusy(true);
    try {
      const result = await api('/api/workbench/references', { targets: referenceTargets.map(({ type, id }) => ({ type, id })), baseWorkRevision: state.workRevision, baseModelHash: state.modelHash, ...(quote ? { selection: quote } : {}) });
      const value = typeof result.handoff === 'string' ? result.handoff : typeof result.reference === 'string' ? result.reference : '';
      if (!value) throw new Error('没有取得可复制的引用，请重试。');
      try { await navigator.clipboard.writeText(value); setReferenceFallback(''); notify('已复制已保存内容的引用。回到 AgentApp 粘贴即可继续。'); }
      catch { setReferenceFallback(value); notify('引用已生成，请在弹出的内容中手动复制。', 'info'); }
    } catch (cause) { notify((cause as Error).message, 'error'); }
    finally { setCopyBusy(false); }
  }

  function captureText(event: React.MouseEvent) {
    const element = event.target as HTMLElement;
    const selected = element instanceof HTMLTextAreaElement ? element.value.slice(element.selectionStart, element.selectionEnd) : window.getSelection()?.toString() || '';
    if (!selected.trim()) return;
    const target = element.closest('[data-claim-id]') as HTMLElement | null;
    if (target) setChosenText({ text: selected, claimId: target.dataset.claimId || '' });
  }

  if (!state) return <div className="loading-screen"><div className="brand-mark"><Waypoints size={26} /></div><h1>流程工作台</h1>{loadingError ? <><p className="error-text">{loadingError}</p><button className="primary-button" onClick={() => void fetchState()}>重新连接</button></> : <p><LoaderCircle size={16} className="spin" /> 正在恢复你的工作内容</p>}</div>;

  const sourceNames = state.contentOrigin?.sourceNames?.length ? state.contentOrigin.sourceNames : state.model.sources.filter(source => source.kind !== 'user-feedback').map(source => source.name);
  const sourceLabel = state.contentOrigin?.label || (state.contentOrigin?.kind === 'synthetic' ? '合成演示资料' : '任务资料');
  const incoming = state.model.relations.filter(r => r.to === selectedId);
  const sourceIds = [...new Set(selectedClaims.flatMap(c => c.evidence.map(e => e.sourceId)))];
  const draftStatus = !draft?.dirty ? '与工作稿一致' : bufferStatus[selectedId!] === 'saved' ? '编辑稿已保存' : bufferStatus[selectedId!] === 'conflict' ? '另一窗口有较新编辑稿' : bufferStatus[selectedId!] === 'local' ? '输入保留在此浏览器' : '正在保留编辑稿…';

  return <div className={`app-shell ${inspectorOpen ? '' : 'inspector-closed'}`}>
    <header className="app-header">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); changeGroup('all'); }} aria-label="查看完整流程"><span className="brand-mark"><Waypoints size={21} /></span><span>6ak<span className="brand-divider">/</span><strong>流程工作台</strong></span></a>
      <div className="header-task"><span className="task-name">{state.model.report.title}</span><button className="source-badge" onClick={() => setSourcesOpen(!sourcesOpen)} aria-label="查看任务资料来源"><FileText size={11} />{sourceLabel}<ChevronDown size={11} /></button></div>
      <div className="header-actions"><span className={`connection-status ${connected ? 'online' : ''}`}><i />{connected ? '本地已连接' : '连接暂时中断'}</span><span className="version-badge">工作稿 W{state.workRevision}</span><button className={`icon-button ${historyOpen ? 'active' : ''}`} title="查看修改记录" aria-label="查看修改记录" onClick={() => setHistoryOpen(!historyOpen)}><History size={17} /></button><a className="secondary-button export-button" href="/api/model" download="model.json"><Download size={14} /> 导出模型</a></div>
    </header>

    <div className="workspace">
      <main className="canvas-section">
        <div className="canvas-toolbar"><div className="scope-title"><h1>{currentGroup?.title || '完整流程'}</h1><span>{scope.coreNodes.length} {group === 'all' ? '节点' : '本组'}{scope.contextNodes.length > 0 && <> · {scope.contextNodes.length} 相邻</>}</span></div><div className="search-wrap"><Search size={14} /><input aria-label="查找节点" placeholder="查找节点或内容" value={search} onChange={e => setSearch(e.target.value)} />{search && <button className="clear-search" aria-label="清除查找" onClick={() => setSearch('')}><X size={13} /></button>}{search.trim() && <div className="search-results">{searchResults.length ? searchResults.map(n => <button key={n.id} onClick={() => focusNode(n.id, !visibleIds.has(n.id))}><span>{n.title}</span><small>{state.model.groups.find(g => g.id === n.groupId)?.title}</small><ArrowRight size={13} /></button>) : <p>没有找到匹配节点。试试其他名称或内容。</p>}</div>}</div><div className="canvas-tools"><button className="quiet-button arrange-layout" data-testid="arrange-layout" aria-label="整理当前图" title="整理当前图，保留手动固定位置" disabled={awaitingInitialLayout || !!layoutOperation || movingCount > 0 || !!Object.keys(positionOverrides.current[group] || {}).length} onClick={() => void runLayout('arrange')}>{layoutOperation === 'arrange' || awaitingInitialLayout ? <LoaderCircle size={14} className="spin" /> : <Network size={14} />}<span>整理当前图</span></button><button className="icon-button" data-testid="undo-layout" aria-label="撤销本组整理" title="撤销本组整理" disabled={!currentLayout?.previous || !!layoutOperation || movingCount > 0} onClick={() => void runLayout('undo')}><Undo2 size={16} /></button><button className="quiet-button copy-top" disabled={copyBusy} onClick={() => void copyReference()} data-testid="copy-reference" title="复制已保存内容的引用">{copyBusy ? <LoaderCircle size={14} className="spin" /> : <Copy size={14} />}<span>复制引用</span></button><span className="canvas-hint">拖动画布 · 滚轮缩放</span><button className="icon-button" title="撤销最近一次内容修改" aria-label="撤销最近一次内容修改" onClick={() => void undo()} data-testid="undo"><RotateCcw size={16} /></button><button className="icon-button" title="适应当前图" aria-label="适应当前图" onClick={() => frameViewport('fit')}><Maximize2 size={16} /></button><button className="icon-button" title={inspectorOpen ? '收起编辑区' : '打开编辑区'} aria-label={inspectorOpen ? '收起编辑区' : '打开编辑区'} onClick={() => setInspectorOpen(!inspectorOpen)}>{inspectorOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}</button></div></div>
        <div className={`graph-area${awaitingInitialLayout ? ' is-initializing' : ''}`} ref={graphElement} data-testid="graph-canvas" aria-busy={awaitingInitialLayout}>
          <nav className={`group-navigator ${navigationCollapsed ? 'is-collapsed' : ''}`} aria-label="流程分组导航" data-testid="group-navigator">
            <button className="navigator-toggle" aria-label={navigationCollapsed ? '展开分组导航' : '收起分组导航'} aria-expanded={!navigationCollapsed} onClick={() => setNavigationCollapsed(!navigationCollapsed)}><Layers3 size={15} /><span>整理分组</span><ChevronDown size={13} /></button>
            {!navigationCollapsed && <div className="navigator-list"><button className={`navigator-item all-groups ${group === 'all' ? 'active' : ''}`} aria-current={group === 'all' ? 'page' : undefined} onClick={() => changeGroup('all')} data-testid="group-all"><Layers3 size={13} /><span>完整流程</span><small>{state.model.nodes.length}</small></button>{state.model.groups.map((g, i) => <button key={g.id} style={groupStyle(i)} className={`navigator-item ${group === g.id ? 'active' : ''}`} aria-current={group === g.id ? 'page' : undefined} onClick={() => changeGroup(g.id)} data-testid={`group-${g.id}`}><span className="navigator-index">{String(i + 1).padStart(2, '0')}</span><span>{g.title}</span><small>{state.model.nodes.filter(n => n.groupId === g.id).length}</small></button>)}<p className="navigator-note">分组视图同时显示直接相连的上下游。</p></div>}
          </nav>
          <SmartEdgeProvider nodes={flowNodes} options={routingOptions} key={group}><ReactFlow nodes={flowNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onNodeClick={(_event, node) => focusNode(node.id, false)} onEdgeClick={(_event, edge) => { const r = state.model.relations.find(r => r.id === edge.id)!; focusNode(r.from, false); setSelection([{ type: 'relation', id: r.id, label: `${state.model.nodes.find(n => n.id === r.from)?.title} → ${state.model.nodes.find(n => n.id === r.to)?.title}` }]); setTimeout(() => document.querySelector(`[data-branch-id="${r.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 100); }} onNodeDragStart={() => { layoutRequest.current++; setLayoutOperation(null); }} onMoveEnd={(_event, viewport) => { if (viewTimer.current) clearTimeout(viewTimer.current); viewTimer.current = setTimeout(() => { if (!!currentLayout !== !!stateRef.current?.view.layouts?.[group]) return; const key = cacheKey('viewport-scope-v2'); writeLocal(key, { ...readLocal<Record<string, Viewport>>(key, {}), [group]: { ...viewport, scoped: !!currentLayout } }); }, 200); }} onSelectionChange={onGraphSelectionChange} minZoom={.25} maxZoom={1.7} nodesConnectable={false} deleteKeyCode={null} selectionKeyCode="Shift" multiSelectionKeyCode="Shift" attributionPosition="bottom-right" proOptions={{ hideAttribution: true }} defaultViewport={{ x: 100, y: 50, zoom: .88 }}>
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#cbd5d0" />
          </ReactFlow></SmartEdgeProvider>
          {awaitingInitialLayout && <div className="layout-loading" role="status"><LoaderCircle size={15} className="spin" />正在整理本组与相邻节点…</div>}
          {layoutError && <div className="layout-error" role="alert"><AlertCircle size={14} /><span>{layoutError}</span>{Object.keys(positionOverrides.current[group] || {}).length > 0 && <button onClick={() => saveMovedPositions(group, { ...positionOverrides.current[group] })}>重试保存位置</button>}<button aria-label="关闭布局提示" onClick={() => setLayoutError('')}><X size={13} /></button></div>}
          <div className="graph-legend"><span><i className="legend-line" /> 已知流转</span><span><i className="legend-line dashed" /> 返回 / 关联</span><span><i className="legend-issue" /> 有待确认</span></div>
          <div className="zoom-tools"><button aria-label="放大" onClick={() => void rf.zoomIn({ duration: 150 })}><Plus size={16} /></button><button aria-label="缩小" onClick={() => void rf.zoomOut({ duration: 150 })}><Minus size={16} /></button></div>
          {selection.length > 1 && <button className="selection-chip" disabled={copyBusy} onClick={() => void copyReference()}><Copy size={14} /> 复制这 {selection.length} 个对象的引用 <ArrowRight size={13} /></button>}
        </div>
        <div className="canvas-footer"><span>{group === 'all' ? '全部节点与模型已有关系' : `${scope.coreNodes.length} 个本组节点 + ${scope.contextNodes.length} 个直接相邻节点`}<span className="footer-dot">·</span>Shift + 拖动可框选</span>{crossRelations.length > 0 && <button className={connectionsOpen ? 'active' : ''} onClick={() => setConnectionsOpen(!connectionsOpen)}><ArrowDownRight size={13} /> {crossRelations.length} 条跨组联系 <ChevronDown size={12} /></button>}</div>
        {connectionsOpen && <div className="connections-popover"><div className="popover-heading">跨组联系<button className="icon-button" onClick={() => setConnectionsOpen(false)} aria-label="关闭跨组联系"><X size={14} /></button></div>{crossRelations.map(r => <button key={r.id} onClick={() => { focusNode(scope.coreIds.has(r.from) ? r.to : r.from, false); setConnectionsOpen(false); }}><span>{state.model.nodes.find(n => n.id === r.from)?.title}</span><ArrowRight size={13} /><span>{state.model.nodes.find(n => n.id === r.to)?.title}</span><small>{relationLabels[r.type]}</small></button>)}</div>}
      </main>

      {inspectorOpen && <aside className="inspector" data-testid="node-inspector"><div className="inspector-header"><div className="inspector-title"><FileText size={14} /> 节点内容</div><button className="inspector-copy" disabled={copyBusy || !currentNode} onClick={() => void copyReference(currentNode ? [{ type: 'node', id: currentNode.id, label: currentNode.title }] : [], null)} aria-label="复制当前节点引用"><Copy size={13} /> 复制引用</button><button className="icon-button" aria-label="关闭节点编辑区" onClick={() => setInspectorOpen(false)}><X size={16} /></button></div>
        {currentNode && draft ? <>
          <div className="inspector-scroll" onMouseUp={captureText}>
            <div className="node-context"><span className="inspector-group group-badge" style={groupStyle(state.model.groups.findIndex(g => g.id === currentNode.groupId))}>{String(state.model.groups.findIndex(g => g.id === currentNode.groupId) + 1).padStart(2, '0')} · {state.model.groups.find(g => g.id === currentNode.groupId)?.title}</span>{scope.contextIds.has(currentNode.id) ? <button className="jump-group" onClick={() => focusNode(currentNode.id, true)} data-testid="jump-to-group">组外 · 转到所属组 <ArrowRight size={12} /></button> : <span className="node-context-id" title={currentNode.id}>{currentNode.id}</span>}</div>
            {manualNodeIds.includes(currentNode.id) && <div className="manual-position"><Pin size={12} /><span>此图中已固定位置</span><button data-testid="release-node-position" disabled={!!layoutOperation || movingCount > 0} onClick={() => void runLayout('release')}><PinOff size={12} />解除固定</button></div>}
            <label className="field-title" htmlFor="node-title">图上名称</label><input id="node-title" data-testid="node-title" className="node-name-input" value={draft.title} onChange={e => updateDraft(currentNode.id, d => { d.title = e.target.value; })} />
            <label className="group-field">整理分组<select aria-label="节点所属整理分组" value={draft.groupId} onChange={e => updateDraft(currentNode.id, d => { d.groupId = e.target.value; })}>{state.model.groups.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}</select><ChevronDown size={12} /></label>
            {incoming.length > 0 && <div className="incoming-summary"><span>来自</span>{incoming.map(r => <button key={r.id} onClick={() => focusNode(r.from, !visibleIds.has(r.from))}>{state.model.nodes.find(n => n.id === r.from)?.title}<ArrowDownRight size={11} /></button>)}</div>}
            <section className="editor-section"><div className="section-title"><h2>操作说明</h2></div>{(displayFields.actions || []).map((claimId, index) => <label className="claim-editor" key={claimId} data-claim-id={claimId}><span className="action-index">{String(index + 1).padStart(2, '0')}</span><CompactTextarea aria-label={`操作说明 ${index + 1}`} data-testid={`claim-${claimId}`} rows={3} value={draft.claims.find(c => c.id === claimId)?.text || ''} onChange={e => updateDraft(currentNode.id, d => { const c = d.claims.find(c => c.id === claimId); if (c) c.text = e.target.value; })} /></label>)}{!displayFields.actions?.length && <p className="empty-hint">原文尚未说明动作。可复制节点引用，在 AgentApp 中补充资料。</p>}
              <details className="full-details"><summary>输入、职责与完成结果<ChevronDown size={13} /></summary>{['role', 'system', 'trigger', 'input', 'output', 'rules'].map(field => <div className="detail-field" key={field}><label>{fieldLabels[field]}</label>{(displayFields[field] || []).length ? displayFields[field].map((claimId, index) => <CompactTextarea key={claimId} data-claim-id={claimId} aria-label={`${fieldLabels[field]} ${index + 1}`} rows={2} value={draft.claims.find(c => c.id === claimId)?.text || ''} onChange={e => updateDraft(currentNode.id, d => { const c = d.claims.find(c => c.id === claimId); if (c) c.text = e.target.value; })} />) : <p className="unknown-text">资料未说明</p>}</div>)}</details>
            </section>
            <section className="editor-section paths-section"><div className="section-title"><h2>完成后走向 <span className="count-badge">{draft.branches.length}</span></h2><GitBranch size={15} /></div>{draft.branches.length ? draft.branches.map((branch, index) => { const relation = state.model.relations.find(r => r.id === branch.id); const relationType = relation?.type || draft.branchTypes?.[branch.id] || 'sequence'; return <div className={`branch-editor ${selection.some(s => s.id === branch.id) ? 'highlighted' : ''}`} key={branch.id} data-branch-id={branch.id}><div className="branch-heading"><span className="path-dot" /><span title={relationLabels[relationType]}>{index + 1}</span><small>{relationLabels[relationType]}</small></div>{branch.conditions.length ? branch.conditions.map((c, conditionIndex) => <label className="branch-condition" key={c.id}><span>条件</span><CompactTextarea rows={2} aria-label={`路径 ${index + 1} 条件 ${conditionIndex + 1}`} data-testid={`condition-${c.id}`} value={c.text} onChange={e => updateDraft(currentNode.id, d => { const item = d.branches.find(b => b.id === branch.id)?.conditions.find(item => item.id === c.id); if (item) item.text = e.target.value; })} /></label>) : <p className="unconditional">{relationType === 'sequence' ? '完成本步骤后' : `${relationLabels[relationType]}关系，未单列条件`}</p>}<label className="branch-destination"><ArrowRight size={13} /><span>前往</span><select aria-label={`路径 ${index + 1} 去向`} data-testid={`destination-${branch.id}`} value={branch.to} onChange={e => updateDraft(currentNode.id, d => { d.branches.find(b => b.id === branch.id)!.to = e.target.value; })}><option value="">选择目标节点</option>{branch.to && !state.model.nodes.some(n => n.id === branch.to) && <option value={branch.to}>原目标已移除 · {branch.to}</option>}{state.model.nodes.map(n => <option key={n.id} value={n.id}>{n.title}</option>)}</select><ChevronDown size={12} /></label></div>; }) : <p className="empty-hint">当前没有已知后续关系。</p>}</section>
            {selectedIssues.length > 0 && <section className="issues-section"><h2><AlertCircle size={14} /> 这里还有待确认</h2>{selectedIssues.map(issue => <button key={issue.id} onClick={() => void copyReference([{ type: 'issue', id: issue.id, label: issue.question }], null)} title="复制此疑点引用"><span>{issue.question}</span><Copy size={13} /></button>)}</section>}
            <details className="sources-section"><summary><FileText size={13} /> 查看原文与依据 <span>{sourceIds.length}</span><ChevronDown size={13} /></summary>{selectedClaims.map(c => <div className="source-claim" key={c.id}><span className={`origin-badge ${c.origin}`}>{c.origin === 'unknown' ? '资料未说明' : c.origin === 'inferred' ? '整理推断' : c.evidence.every(e => state.model.sources.find(s => s.id === e.sourceId)?.kind === 'user-feedback') ? '用户补充' : '原文明示'}</span><p data-claim-id={c.id}>{c.text}</p>{c.evidence.map((e, i) => <blockquote key={i}><small>{state.model.sources.find(s => s.id === e.sourceId)?.name} · 第 {e.startLine} 行</small>{e.quote}</blockquote>)}</div>)}</details>
            {(state.pendingEdits || []).filter(p => p.nodeId === currentNode.id || p.targetId === currentNode.id || p.payload?.nodeId === currentNode.id).map((p, index) => <div className="pending-note" key={p.id || index}><AlertCircle size={14} /><div><strong>已保存的待定编辑</strong><p>{p.reason || p.summary || '尚未采用为当前流程内容。'}</p>{(p.title || p.payload?.title || p.input?.title) && <p>{p.title || p.payload?.title || p.input?.title}</p>}<details><summary>查看保存内容</summary>{(p.input?.claims || []).map((c: any) => <p key={c.id}>{c.text || '（内容留空）'}</p>)}{(p.input?.branches || []).map((b: any) => <p key={b.id}>{b.conditions?.map((c: any) => c.text || '（条件留空）').join('；')} → {state.model.nodes.find(n => n.id === b.to)?.title || b.to || '（尚未选择目标）'}</p>)}</details><button className="quiet-button" disabled={draft.dirty} title={draft.dirty ? "先保存或还原当前输入，再恢复这份建议" : undefined} onClick={() => restorePending(p)}>继续编辑这份建议</button></div></div>)}
            {chosenText && <button className="quote-selection" disabled={copyBusy} onClick={() => void copyReference([{ type: 'claim', id: chosenText.claimId, label: chosenText.text }])}><Copy size={13} /> 复制所选文字引用</button>}
          </div>
          <div className="inspector-savebar">{!error && draft.dirty && draft.baseWorkRevision !== state.workRevision && <div className="save-error stale-draft" role="status"><Info size={15} /><div>工作稿有了新修改。你的输入仍保留。<button onClick={rebaseDraft}>以最新工作稿重新核对</button></div></div>}{error && <div className="save-error" role="alert"><AlertCircle size={15} /><div>{error}{error.includes('新修改') && <button onClick={rebaseDraft}>以最新工作稿重新核对</button>}</div></div>}<div className="save-options"><select aria-label="修改性质" value={draft.intent} onChange={e => updateDraft(currentNode.id, d => { d.intent = e.target.value as Draft['intent']; })}><option value="current">修订本轮流程草稿</option><option value="proposal">先保存为待定建议</option></select><span className={`buffer-status ${bufferStatus[selectedId!] === 'local' ? 'local' : ''}`}>{draft?.dirty ? <i /> : <Check size={11} />}{draftStatus}</span></div><div className="save-buttons"><button className="secondary-button" disabled={!draft.dirty || saving} onClick={() => void clearDraft(currentNode.id)}>还原输入</button><button className="primary-button" data-testid="save-node" disabled={!draft.dirty || saving} onClick={() => void saveNode()}>{saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{saving ? '正在保存' : '保存节点'}</button></div></div>
        </> : <div className="empty-inspector"><Waypoints size={30} /><h2>选中一个节点</h2><p>查看动作、编辑说明，或沿着路径理解流程。</p><button className="secondary-button" disabled={copyBusy} onClick={() => void copyReference([], null)}><Copy size={14} /> 复制完整流程引用</button></div>}

      </aside>}
    </div>

    {sourcesOpen && <div className="source-panel"><div className="popover-heading"><span><FileText size={15} /> 任务资料来源</span><button className="icon-button" aria-label="关闭资料来源" onClick={() => setSourcesOpen(false)}><X size={15} /></button></div><p className="source-origin-label">{sourceLabel}</p>{sourceNames.map((name, index) => <div className="source-file" key={`${name}-${index}`}><FileText size={14} /><span>{name}</span></div>)}{state.model.report.scope && <p className="source-scope">{state.model.report.scope}</p>}{state.model.report.limitations?.length > 0 && <div className="source-limitations"><strong>阅读边界</strong>{state.model.report.limitations.map((item, index) => <p key={index}>{item}</p>)}</div>}</div>}
    {referenceFallback && <div className="reference-dialog-backdrop" onClick={() => setReferenceFallback('')}><section className="reference-dialog" role="dialog" aria-modal="true" aria-label="手动复制引用" onClick={event => event.stopPropagation()}><div className="popover-heading"><span><Copy size={15} /> 手动复制引用</span><button className="icon-button" aria-label="关闭引用" onClick={() => setReferenceFallback('')}><X size={15} /></button></div><p>复制以下内容，回到 AgentApp 的当前对话粘贴。</p><textarea aria-label="复制引用内容" data-testid="reference-fallback" readOnly autoFocus value={referenceFallback} onFocus={event => event.target.select()} /><button className="primary-button" onClick={() => setReferenceFallback('')}>完成</button></section></div>}
    {historyOpen && <div className="history-panel"><div className="popover-heading"><span><History size={16} /> 修改记录</span><button className="icon-button" aria-label="关闭修改记录" onClick={() => setHistoryOpen(false)}><X size={15} /></button></div><p className="history-intro">内容修改会生成记录；保存不代表业务事实已核实。</p>{(state.changes || []).length ? state.changes.slice(0, 20).map((change, i) => <article key={change.id || i}><span className="history-dot" /><div><strong>{change.summary || change.message || '工作稿已更新'}</strong><p>{change.actor === 'agent' ? 'Agent 协助' : '直接编辑'}<span>·</span>{change.at || change.createdAt ? new Date(change.at || change.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : `记录 ${state.changes.length - i}`}</p>{(change.items || []).filter((item: any) => item.before !== item.after).slice(0, 6).map((item: any, index: number) => <div className="change-comparison" key={index}><small>{item.label || item.id}</small>{item.before && <del>{item.before}</del>}{item.after && <ins>{item.after}</ins>}</div>)}{change.details && <small>{typeof change.details === 'string' ? change.details : JSON.stringify(change.details)}</small>}</div></article>) : <div className="empty-history"><History size={25} /><p>还没有内容修改</p><span>修改一个节点并保存，记录会出现在这里。</span></div>}</div>}
    {toast && <div className={`toast ${toast.kind}`} role="status">{toast.kind === 'error' ? <AlertCircle size={17} /> : toast.kind === 'info' ? <Info size={17} /> : <Check size={17} />}<span>{toast.text}</span><button aria-label="关闭提示" onClick={() => setToast(null)}><X size={13} /></button></div>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><ReactFlowProvider><Workbench /></ReactFlowProvider></React.StrictMode>);
