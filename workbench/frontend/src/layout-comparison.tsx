import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MarkerType, useReactFlow, getViewportForBounds, type NodeProps, type Node, type Edge, type Viewport } from '@xyflow/react';
import { ArrowRight, ArrowDown, GitBranch, AlertCircle, Layers3, ChevronDown, Network, Maximize2, PanelRightClose, PanelRightOpen, Minus, Plus, X } from 'lucide-react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './layout-comparison.css';
import { getGraphScope } from './graph-scope.mjs';
import { arrangeComparisonGraph } from './comparison-layout.mjs';
import { relationPorts, routeGeometryKey, type LayoutNode, type LayoutRoute, type RelationPort } from './graph-layout.mjs';
import { scopeLayoutEdges } from './graph-layout-input.mjs';
import { ProcessEdge, ProcessHandles, processEdgeColor, useProcessRoutes } from './graph-routing';
import { fieldLabels, relationLabels } from './structure-draft';
import { ExitComparison, graphExits, GraphGroupBadge } from './exit-comparison';
import { RelationEvidence } from './relation-evidence';
import { groupsForDisplay } from './group-labels.mjs';

type Claim = { id: string; text: string; origin: string; evidence: { sourceId: string; startLine: number; endLine: number; quote: string }[] };
type ModelNode = { id: string; title: string; groupId: string; fields: Record<string, string[]>; claimIds: string[] };
type Relation = { id: string; from: string; to: string; type: string; claimIds: string[]; conditionClaimIds: string[] };
type Model = { report: { title: string }; nodes: ModelNode[]; groups: { id: string; title: string }[]; claims: Claim[]; relations: Relation[]; sources: { id: string; name: string }[]; issues: { id: string; status: string; question: string; nodeIds: string[]; relationIds: string[] }[] };
type Layout = { positions: Record<string, { x: number; y: number }>; routes: Record<string, LayoutRoute> };
type Snapshot = { model: Model; workRevision: number; modelHash: string; sourceLabel: string; capturedAt: string; view: { selectedGroupId?: string; positions?: Layout['positions']; layouts?: Record<string, Layout> } };
type Direction = 'RIGHT' | 'DOWN';
type CardData = Record<string, unknown> & { node: ModelNode; groupIndex: number; groupTitle: string; displayNo: number; compareExits: () => void; context: boolean; role: string; actions: Claim[]; hasDetails: boolean; outgoing: number; issueCount: number; unknownCount: number; direction: Direction; open: () => void };
const colors = ['#477e60', '#527c9b', '#a17736', '#81709a', '#a15d70', '#608381'];
const groupStyle = (index: number) => ({ '--group-color': colors[(index + colors.length) % colors.length] }) as React.CSSProperties;

function CardBody({ item, selected = false }: { item: CardData; selected?: boolean }) {
  const preview = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const measure = () => setClipped(Array.from(preview.current?.querySelectorAll('p') || []).some(p => p.scrollHeight > p.clientHeight + 1));
    measure();
    const observer = new ResizeObserver(measure);
    if (preview.current) observer.observe(preview.current);
    return () => observer.disconnect();
  }, [item.actions]);
  const hasMore = item.actions.length > 2 || clipped;
  return <div className={`process-card ${selected ? 'is-selected' : ''} ${item.context ? 'context-node' : ''}`} style={groupStyle(item.groupIndex)}>
    <div className="node-eyebrow"><GraphGroupBadge groupIndex={item.groupIndex} title={item.groupTitle} number={item.displayNo} context={item.context}/></div>
    <div className="node-title">{item.node.title}</div>
    {item.role && <div className="node-role" title={item.role}>{item.role}</div>}
    <div className="node-actions" ref={preview}>
      {item.actions.length > 1 ? <ol>{item.actions.slice(0, 2).map(c => <li key={c.id}><p data-claim-id={c.id}>{c.text}</p></li>)}</ol> : item.actions[0] ? <p data-claim-id={item.actions[0].id}>{item.actions[0].text}</p> : <p className="node-action-empty">资料未说明操作</p>}
    </div>
    {(hasMore || item.hasDetails) && <div className="node-card-links">
      {hasMore && <button className="node-detail-hint node-actions-link nodrag nopan" onClick={item.open}>{item.actions.length === 1 ? '查看完整操作' : `查看全部 ${item.actions.length} 条操作`} <ArrowRight size={11} /></button>}
      {item.hasDetails && <button className="node-detail-hint nodrag nopan" onClick={item.open}>查看细节与补充 <ArrowRight size={11} /></button>}
    </div>}
    <div className="node-meta">{item.outgoing > 1 && <button className="compare-exits nodrag nopan" onClick={event => { event.stopPropagation(); item.compareExits(); }}><GitBranch size={12}/>对照 {item.outgoing} 个出口</button>}{item.issueCount > 0 ? <span className="node-issue"><AlertCircle size={11} /> {item.issueCount} 待确认</span> : item.unknownCount > 0 && <span className="node-issue"><AlertCircle size={11} /> {item.unknownCount} 项未说明</span>}</div>
  </div>;
}

function ComparisonNode({ data, selected }: NodeProps) {
  const item = data as CardData & { ports?: RelationPort[] };
  return <div data-testid={`graph-node-${item.node.id}`}>
    <ProcessHandles nodeId={item.node.id} direction={item.direction} ports={item.ports} />
    <CardBody item={item} selected={selected} />
  </div>;
}
const nodeTypes = { process: ComparisonNode }, edgeTypes = { process: ProcessEdge };

function Comparison({ snapshot }: { snapshot: Snapshot }) {
  const { model } = snapshot;
  const [group, setGroup] = useState(model.groups.some(g => g.id === 'submit') ? 'submit' : snapshot.view.selectedGroupId || model.groups[0]?.id || 'all');
  const [directionMode, setDirectionMode] = useState<'AUTO' | Direction>('AUTO');
  const [selected, setSelected] = useState<string | null>(null);
  const [compareNodeId, setCompareNodeId] = useState<string | null>(null);
  const [selectedRelationId, setSelectedRelationId] = useState<string | null>(null);
  const selectedBranch = useRef<HTMLDivElement>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [inspector, setInspector] = useState(window.innerWidth > 760);
  const [collapsed, setCollapsed] = useState(window.innerWidth <= 760);
  const [mode, setMode] = useState<'equal' | 'fit'>('equal');
  const [viewRequest, setViewRequest] = useState(0);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [boxes, setBoxes] = useState<LayoutNode[]>([]);
  const [error, setError] = useState('');
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: .82 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const canvasReady = canvasSize.width > 0 && canvasSize.height > 0;
  const automaticDirection: Direction = canvasSize.width >= canvasSize.height ? 'RIGHT' : 'DOWN';
  const direction: Direction = directionMode === 'AUTO' ? automaticDirection : directionMode;
  const measurements = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null);
  const { setViewport: moveViewport, zoomIn, zoomOut } = useReactFlow();
  const displayGroups = useMemo(() => groupsForDisplay(model), [model]);
  const scope = useMemo(() => getGraphScope(model, group), [model, group]);
  const claimMap = useMemo(() => new Map(model.claims.map(c => [c.id, c])), [model]);
  const open = (id: string, relationId: string | null = null) => {
    setSelected(id);
    setSelectedRelationId(relationId);
    setInspector(true);
  };
  useEffect(() => { selectedBranch.current?.scrollIntoView({ block: 'nearest' }); }, [selectedRelationId]);
  const cards = useMemo(() => (scope.nodes as ModelNode[]).map(node => ({
    node, displayNo: model.nodes.filter(n => n.groupId === node.groupId).findIndex(n => n.id === node.id) + 1, compareExits: () => setCompareNodeId(node.id),
    groupIndex: model.groups.findIndex(g => g.id === node.groupId), groupTitle: displayGroups.find(g => g.id === node.groupId)?.title || node.groupId,
    context: scope.contextIds.has(node.id), direction,
    role: (node.fields.role || []).map(id => claimMap.get(id)?.text).filter(Boolean).join('、').replace(/[。.]$/, ''),
    actions: (node.fields.actions || []).map(id => claimMap.get(id)).filter((c): c is Claim => Boolean(c)),
    hasDetails: node.claimIds.some(id => !(node.fields.actions || []).includes(id)),
    outgoing: model.relations.filter(r => r.from === node.id).length,
    issueCount: model.issues.filter(i => i.status === 'open' && (i.nodeIds.includes(node.id) || i.relationIds.some(id => model.relations.some(r => r.id === id && r.from === node.id)))).length,
    unknownCount: node.claimIds.filter(id => claimMap.get(id)?.origin === 'unknown').length,
    open: () => open(node.id),
  })), [scope, model, claimMap, direction]);
  const exits = useMemo(() => graphExits(model), [model]);
  const relations = useMemo(() => scopeLayoutEdges((scope.relations as Relation[]).map(r => exits.get(r.id)!.geometry), scope.contextIds), [scope, exits]);
  const ports = useMemo(() => relationPorts(relations, boxes, direction), [relations, boxes, direction]);

  useEffect(() => {
    let cancelled = false;
    setLayout(null); setError('');
    if (!canvasReady) return;
    const measureAndArrange = async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (cancelled) return;
      const measured = cards.map(item => {
        const element = measurements.current?.querySelector<HTMLElement>(`[data-measure-id="${CSS.escape(item.node.id)}"] .process-card`);
        if (!element) throw new Error('节点尺寸尚未就绪');
        return { id: item.node.id, order: model.nodes.indexOf(item.node), x: 0, y: 0, width: element.offsetWidth, height: element.offsetHeight };
      });
      const saved = snapshot.view.layouts?.[group];
      const baseline = saved?.positions || (group === 'all' ? snapshot.view.positions : undefined);
      const validBaseline = baseline && measured.every(n => Number.isFinite(baseline[n.id]?.x) && Number.isFinite(baseline[n.id]?.y));
      const arranged = direction === 'DOWN' && validBaseline ? { positions: baseline!, routes: saved?.routes || {} } : await arrangeComparisonGraph({ nodes: measured, edges: relations, direction });
      if (!cancelled) { setBoxes(measured.map(n => ({ ...n, ...arranged.positions[n.id] }))); setLayout(arranged); }
    };
    measureAndArrange().catch(e => { if (!cancelled) setError(String(e.message || e)); });
    return () => { cancelled = true; };
  }, [cards, relations, direction, group, snapshot, canvasReady]);

  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    let resizeTimer: ReturnType<typeof setTimeout>;
    const measure = () => setCanvasSize(previous => {
      const width = element.clientWidth, height = element.clientHeight;
      return previous.width === width && previous.height === height ? previous : { width, height };
    });
    measure();
    // Wait for a resizing window or inspector to settle before changing direction.
    const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(measure, 150); });
    observer.observe(element);
    return () => { clearTimeout(resizeTimer); observer.disconnect(); };
  }, []);

  const geometryKey = useMemo(() => routeGeometryKey(boxes, relations, direction, ports), [boxes, relations, direction, ports]);
  const drawings = useProcessRoutes(boxes, relations, direction, ports, geometryKey, layout?.routes);
  const validRoutes = useMemo(() => relations.flatMap(r => layout?.routes[r.id]?.geometryKey === geometryKey ? [layout.routes[r.id]] : []), [relations, layout, geometryKey]);
  const bounds = useMemo(() => {
    if (!boxes.length) return { x: 0, y: 0, width: 1, height: 1 };
    const x = Math.min(...boxes.map(n => n.x)), y = Math.min(...boxes.map(n => n.y));
    const labels = validRoutes.flatMap(r => r.label ? [r.label] : []);
    const points = validRoutes.flatMap(r => r.points);
    const left = Math.min(x, ...labels.map(l => l.x), ...points.map(p => p.x));
    const top = Math.min(y, ...labels.map(l => l.y), ...points.map(p => p.y));
    return { x: left, y: top, width: Math.max(...boxes.map(n => n.x + n.width), ...labels.map(l => l.x + l.width), ...points.map(p => p.x)) - left, height: Math.max(...boxes.map(n => n.y + n.height), ...labels.map(l => l.y + l.height), ...points.map(p => p.y)) - top };
  }, [boxes, validRoutes]);
  const leftInset = collapsed ? 162 : 226;
  useEffect(() => {
    if (!layout) return;
    const width = Math.max(150, canvasSize.width - leftInset - 28), height = Math.max(180, canvasSize.height - 70);
    const fit = getViewportForBounds(bounds, width, height, .1, 1, .08);
    const zoom = mode === 'equal' ? .82 : fit.zoom;
    const x = leftInset + (mode === 'fit' ? fit.x : Math.max(12, (width - bounds.width * zoom) / 2) - bounds.x * zoom);
    const y = mode === 'fit' ? fit.y + 20 : 38 - bounds.y * zoom;
    moveViewport({ x, y, zoom }, { duration: 0 });
  }, [layout, bounds, canvasSize, leftInset, mode, viewRequest, moveViewport]);

  const nodes: Node[] = cards.map(item => { const box = boxes.find(n => n.id === item.node.id); return { id: item.node.id, type: 'process', position: layout?.positions[item.node.id] || { x: 0, y: 0 }, measured: box ? { width: box.width, height: box.height } : undefined, data: { ...item, ports: ports.byNode.get(item.node.id) }, selected: selected === item.node.id }; });
  const edges: Edge[] = relations.map(r => {
    const handles = ports.byEdge.get(r.id)!;
    const hovered = r.id === hoveredEdgeId;
    const highlighted = hovered || (!hoveredEdgeId && selected === r.from);
    return { id: r.id, source: r.from, target: r.to, type: 'process', sourceHandle: handles.source.id, targetHandle: handles.target.id,
      zIndex: hovered ? 1 : 0, markerEnd: { type: MarkerType.ArrowClosed, width: 17, height: 17, color: processEdgeColor(r.type, highlighted) },
      data: { kind: r.type, highlighted, accessibleName: exits.get(r.id)?.accessibleName, openRelation: () => open(r.from, r.id), label: r.label, labelWidth: r.labelWidth, labelHeight: r.labelHeight, drawing: drawings?.get(r.id) },
    };
  });
  useEffect(() => setHoveredEdgeId(null), [group, direction]);
  const visibleCount = boxes.filter(n => {
    const x = n.x * viewport.zoom + viewport.x, y = n.y * viewport.zoom + viewport.y;
    return x >= leftInset && y >= 0 && x + n.width * viewport.zoom <= canvasSize.width && y + n.height * viewport.zoom <= canvasSize.height - 40;
  }).length;
  const current = model.nodes.find(n => n.id === selected);
  const changeGroup = (id: string) => { setGroup(id); setSelected(null); };

  return <div className={`app-shell comparison-shell ${!inspector ? 'inspector-closed' : ''}`} data-direction={direction} data-direction-mode={directionMode}>
    <header className="app-header"><div className="brand"><span className="brand-mark"><Network size={20} /></span><span>6ak <span className="brand-divider">/</span><strong>流程工作台</strong></span></div><div className="header-task"><span className="task-name">{model.report.title}</span><span className="comparison-badge">布局对照 · 只读</span></div><div className="header-actions"><span className="version-badge">同一份工作稿 W{snapshot.workRevision}</span></div></header>
    <div className="workspace"><main className="canvas-section">
      <div className="canvas-toolbar"><div className="scope-title"><h1>{group === 'all' ? '完整流程' : displayGroups.find(g => g.id === group)?.title}</h1><span>{scope.coreNodes.length} 本组 · {scope.contextNodes.length} 相邻</span></div>
        <div className="comparison-directions" role="group" aria-label="流程方向"><button aria-pressed={directionMode === 'AUTO'} onClick={() => setDirectionMode('AUTO')} data-testid="direction-auto" title="根据中央画布宽高自动选择；宽高相同时使用横向">自动 · {automaticDirection === 'RIGHT' ? '横向' : '纵向'}</button><button aria-pressed={directionMode === 'DOWN'} onClick={() => setDirectionMode('DOWN')} data-testid="direction-down"><ArrowDown size={14} />纵向原版</button><button aria-pressed={directionMode === 'RIGHT'} onClick={() => setDirectionMode('RIGHT')} data-testid="direction-right"><ArrowRight size={14} />横向对照</button></div>
        <div className="canvas-tools"><button className={`secondary-button comparison-scale ${Math.abs(viewport.zoom - .82) < .001 ? 'active' : ''}`} onClick={() => { setMode('equal'); setViewRequest(n => n + 1); }} data-testid="equal-scale">等比例 82%</button><button className="secondary-button comparison-scale" onClick={() => { setMode('fit'); setViewRequest(n => n + 1); }} data-testid="fit-graph"><Maximize2 size={13} /><span>适应当前图</span></button><button className="icon-button" title={inspector ? '收起详情' : '展开详情'} aria-label={inspector ? '收起详情' : '展开详情'} onClick={() => setInspector(!inspector)}>{inspector ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button></div>
      </div>
      <div className="graph-area" ref={canvas} data-testid="comparison-canvas" aria-busy={!layout && !error}>
        <ReactFlow key={`${group}:${direction}`} nodes={layout ? nodes : []} edges={layout ? edges : []} nodeTypes={nodeTypes} edgeTypes={edgeTypes} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} minZoom={.1} maxZoom={2} onNodeClick={(_, node) => open(node.id)} onEdgeClick={(_, edge) => open(edge.source, edge.id)} onEdgeMouseEnter={(_, edge) => setHoveredEdgeId(edge.id)} onEdgeMouseLeave={() => setHoveredEdgeId(null)} onPaneClick={() => setSelected(null)} onMove={(_, next) => setViewport(next)} proOptions={{ hideAttribution: true }}>
            <Background variant={BackgroundVariant.Dots} gap={20} size={.7} color="#cbd7c7" />
        </ReactFlow>
        <nav className={`group-navigator ${collapsed ? 'is-collapsed' : ''}`} aria-label="整理分组"><button className="navigator-toggle" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}><Layers3 size={14} /><span>整理分组</span><ChevronDown size={12} /></button>{!collapsed && <div className="navigator-list"><button className={`navigator-item all-groups ${group === 'all' ? 'active' : ''}`} onClick={() => changeGroup('all')} data-testid="group-all"><Layers3 size={13} /><span>完整流程</span><small>{model.nodes.length}</small></button>{displayGroups.map((g, i) => <button className={`navigator-item ${g.id === group ? 'active' : ''}`} style={groupStyle(i)} key={g.id} onClick={() => changeGroup(g.id)} data-testid={`group-${g.id}`}><span className="navigator-index">{String(i + 1).padStart(2, '0')}</span><span>{g.title}</span><small>{model.nodes.filter(n => n.groupId === g.id).length}</small></button>)}<p className="navigator-note">分组视图同时显示直接相连的上下游。</p></div>}</nav>
        {!layout && <div className="comparison-loading" role={error ? 'alert' : 'status'}>{error || '正在整理布局…'}</div>}
        <div className="graph-legend"><span><i className="legend-line" />已知流转</span><span><i className="legend-line dashed" />返回 / 关联</span><span><i className="legend-issue" />有待确认</span></div>
        <div className="zoom-tools"><button aria-label="放大" onClick={() => zoomIn()}><Plus size={16} /></button><button aria-label="缩小" onClick={() => zoomOut()}><Minus size={16} /></button></div>
      </div>
      <footer className="canvas-footer"><span>同一内容 · 相同字号 <span className="footer-dot">·</span> 缩放 {Math.round(viewport.zoom * 100)}%</span><span data-testid="comparison-metrics">{layout ? `完整可见 ${visibleCount}/${boxes.length} 节点 · 图幅 ${Math.round(bounds.width)} × ${Math.round(bounds.height)}` : '布局计算中'}</span></footer>
    </main>
    {inspector && <aside className="inspector"><div className="inspector-header"><span className="inspector-title">节点内容</span><button className="icon-button" aria-label="关闭节点内容" onClick={() => setInspector(false)}><X size={16} /></button></div>{current ? <div className="inspector-scroll comparison-details"><div className="comparison-readonly">仅查看 · 内容与原工作台一致</div><h2>{current.title}</h2>{Object.entries(current.fields).map(([field, ids]) => ids.length > 0 && <section key={field}><h3>{fieldLabels[field] || field}</h3>{ids.map(id => { const c = claimMap.get(id); return c && <p key={id}>{c.origin === 'unknown' && <span className="comparison-unknown">未说明 · </span>}{c.text}</p>; })}</section>)}
      {model.relations.some(r => r.from === current.id) && <section><h3>后续路径</h3>{model.relations.filter(r => r.from === current.id).map(r => <div className="comparison-branch" key={r.id} ref={r.id === selectedRelationId ? selectedBranch : undefined}><p>{r.conditionClaimIds.map(id => claimMap.get(id)?.text).join('；') || relationLabels[r.type]}</p>{r.id === selectedRelationId && <RelationEvidence model={model} claimIds={r.conditionClaimIds.length ? r.conditionClaimIds : r.claimIds} />}<button onClick={() => { if (!scope.visibleIds.has(r.to)) setGroup(model.nodes.find(n => n.id === r.to)?.groupId || 'all'); open(r.to); }}><ArrowRight size={12} />{model.nodes.find(n => n.id === r.to)?.title}</button></div>)}</section>}
      {model.issues.filter(i => i.status === 'open' && (i.nodeIds.includes(current.id) || i.relationIds.some(id => model.relations.some(r => r.id === id && r.from === current.id)))).map(i => <section className="comparison-issue" key={i.id}><h3>待确认</h3><p>{i.question}</p></section>)}
      <details className="comparison-evidence"><summary>原文依据</summary>{current.claimIds.map(id => { const c = claimMap.get(id); return c?.evidence.map((e, i) => <blockquote key={`${id}-${i}`}><p>{e.quote}</p><small>{model.sources.find(s => s.id === e.sourceId)?.name || e.sourceId} · 第 {e.startLine}–{e.endLine} 行</small></blockquote>); })}</details>
    </div> : <div className="empty-inspector"><Network size={29} /><h3>选中一个节点</h3><p>查看完整操作、条件与原文依据。</p><span className="comparison-readonly">布局切换不会保存到原工作台</span></div>}</aside>}
    </div>
    {compareNodeId && <ExitComparison nodeId={compareNodeId} model={model} exits={exits} onClose={() => setCompareNodeId(null)} />}
    <div ref={measurements} className="comparison-measure" aria-hidden="true">{cards.map(item => <div data-measure-id={item.node.id} key={item.node.id}><CardBody item={item} /></div>)}</div>
  </div>;
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [error, setError] = useState('');
  useEffect(() => { fetch('/api/comparison/state', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('无法读取对照数据'); return r.json(); }).then(setSnapshot).catch(e => setError(e.message)); }, []);
  if (!snapshot) return <div className="comparison-start" role={error ? 'alert' : 'status'}>{error || '正在读取对照数据…'}</div>;
  return <ReactFlowProvider><Comparison snapshot={snapshot} /></ReactFlowProvider>;
}
createRoot(document.getElementById('root')!).render(<App />);
