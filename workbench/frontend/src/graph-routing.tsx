import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, Handle, Position, useUpdateNodeInternals, type EdgeProps } from '@xyflow/react';
import { routeSmartEdgeBatch, svgDrawSmoothStepLinePath, type SmartEdgeBatchItem } from '@tisoap/react-flow-smart-edge';
import { portPoint, type LayoutDirection, type LayoutEdge, type LayoutNode, type RelationPort, type RelationPorts } from './graph-layout.mjs';
import { alignRouteToHandles, CROSSING_GAP_RADIUS, findCrossingGaps, resolveUnobstructedSmartRoute, separateSharedRoute } from './graph-smart-route.mjs';

export type Point = { x: number; y: number };
export type EdgeRoute = { points: Point[]; label?: Point & { width: number; height: number }; geometryKey: string };
export type ScopedLayout = { revision: number; inputKey?: string; needsMeasurement?: string; positions: Record<string, Point>; manualNodeIds: string[]; routes: Record<string, EdgeRoute>; previous?: { positions: Record<string, Point>; manualNodeIds: string[]; routes: Record<string, EdgeRoute> } };
type Box = Point & { id: string; width: number; height: number };
type CrossingMask = { gaps: Point[]; bounds: Point & { width: number; height: number } };
type RoutedDrawing = { points: Point[]; labelCenter: Point; mode: 'elk' | 'smart'; shifted: boolean; obstacles: readonly Box[]; crossings?: CrossingMask };
type RouteData = { kind: string; highlighted: boolean; label: string; labelWidth: number; labelHeight: number; drawing?: RoutedDrawing | null };

const handlePositions = {
  DOWN: { top: Position.Top, bottom: Position.Bottom, left: Position.Left },
  RIGHT: { top: Position.Left, bottom: Position.Right, left: Position.Top },
};
const noPorts: RelationPort[] = [];

export function ProcessHandles({ nodeId, direction, ports = noPorts }: { nodeId: string; direction: LayoutDirection; ports?: RelationPort[] }) {
  const updateNodeInternals = useUpdateNodeInternals();
  const portKey = JSON.stringify(ports);
  // Reach the DOM again only when a handle changes, including after a topology edit.
  useLayoutEffect(() => updateNodeInternals(nodeId), [nodeId, direction, portKey, updateNodeInternals]);
  return ports.map(port => {
    const position = handlePositions[direction][port.side];
    const offset = position === Position.Left || position === Position.Right ? 'top' : 'left';
    return <Handle key={port.id} id={port.id} type={port.type} position={position} isConnectable={false}
      className="process-handle" style={{ [offset]: `${port.fraction * 100}%` }} />;
  });
}

// The same measured label box is sent to ELK and used by the renderer.
let measureContext: CanvasRenderingContext2D | null = null;
export function measureEdgeLabel(text: string) {
  if (!text) return { labelWidth: 0, labelHeight: 0 };
  measureContext ||= document.createElement('canvas').getContext('2d');
  if (measureContext) measureContext.font = '500 11px system-ui, sans-serif';
  let width = 0, widest = 0, lines = 1;
  for (const char of text) {
    const size = measureContext?.measureText(char).width || 11;
    if (char === '\n' || width + size > 194) { widest = Math.max(widest, width); width = char === '\n' ? 0 : size; lines++; }
    else width += size;
  }
  return { labelWidth: Math.ceil(Math.min(210, Math.max(36, widest, width) + 16)), labelHeight: Math.ceil(lines * 16 + 8) };
}

function centerOnFreeSegment(points: Point[], width: number, height: number, obstacles: Box[], fallback: Point): Point {
  const candidates: Array<Point & { score: number }> = [];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    const length = Math.hypot(a.x - b.x, a.y - b.y);
    if (length < 24) continue;
    for (const ratio of [.5, .3, .7]) {
      const x = a.x + (b.x - a.x) * ratio, y = a.y + (b.y - a.y) * ratio;
      if (obstacles.some(box => x + width / 2 + 5 > box.x && x - width / 2 - 5 < box.x + box.width && y + height / 2 + 5 > box.y && y - height / 2 - 5 < box.y + box.height)) continue;
      candidates.push({ x, y, score: length + (Math.abs(a.y - b.y) < 1 ? 50 : 0) - Math.hypot(x - fallback.x, y - fallback.y) * .15 });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || fallback;
}

const drawSmartPath = svgDrawSmoothStepLinePath({ borderRadius: 2 });

function buildDrawings(nodes: LayoutNode[], edges: LayoutEdge[], direction: LayoutDirection, ports: RelationPorts, geometryKey: string, savedRoutes?: Record<string, EdgeRoute>) {
  const byNode = new Map(nodes.map(node => [node.id, node]));
  const drawings = new Map<string, RoutedDrawing | null>();
  const uncached: SmartEdgeBatchItem[] = [];
  const orderedEdges = [...edges].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const edge of orderedEdges) {
    const from = byNode.get(edge.from), to = byNode.get(edge.to);
    if (!from || !to || savedRoutes?.[edge.id]?.geometryKey === geometryKey) continue;
    const { source, target } = ports.byEdge.get(edge.id)!;
    const start = portPoint(from, source, direction), end = portPoint(to, target, direction);
    uncached.push({ id: edge.id, source: edge.from, target: edge.to, sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y,
      sourcePosition: handlePositions[direction][source.side], targetPosition: handlePositions[direction][target.side],
      preset: 'smoothstep', options: { nodePadding: 16, gridRatio: 8, borderRadius: 2 } });
  }
  const smartRoutes = routeSmartEdgeBatch(nodes.map(({ id, x, y, width, height }) => ({ id, position: { x, y }, measured: { width, height }, data: {} })), uncached);
  const previousPaths: Point[][] = [];
  const labelObstacles = [...nodes];
  const addDrawing = (edge: LayoutEdge, points: Point[], origin: Point, mode: RoutedDrawing['mode'], label?: EdgeRoute['label']) => {
    const shifted = separateSharedRoute(points, previousPaths, nodes);
    const { labelWidth = 0, labelHeight = 0 } = edge;
    const labelCenter = edge.label && (!label || shifted !== points)
      ? centerOnFreeSegment(shifted, labelWidth, labelHeight, labelObstacles, origin) : origin;
    previousPaths.push(shifted);
    if (edge.label) labelObstacles.push({ id: edge.id, x: labelCenter.x - labelWidth / 2, y: labelCenter.y - labelHeight / 2, width: labelWidth, height: labelHeight });
    drawings.set(edge.id, { points: shifted, labelCenter, mode, shifted: shifted !== points, obstacles: nodes });
  };
  for (const edge of orderedEdges) {
    const route = savedRoutes?.[edge.id];
    if (route?.geometryKey !== geometryKey) continue;
    const { points, label } = route;
    const start = points[0], end = points[points.length - 1];
    const center = label ? { x: label.x + label.width / 2, y: label.y + label.height / 2 } : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    addDrawing(edge, points, center, 'elk', label);
  }
  const edgeById = new Map(edges.map(edge => [edge.id, edge]));
  for (const request of uncached) {
    const route = smartRoutes[request.id];
    const clear = route?.kind === 'routed' && resolveUnobstructedSmartRoute(route, request, nodes);
    if (!clear) { drawings.set(request.id, null); continue; }
    const points = [{ x: request.sourceX, y: request.sourceY }, ...clear.points.map(([x, y]) => ({ x, y })), { x: request.targetX, y: request.targetY }];
    addDrawing(edgeById.get(request.id)!, points, { x: clear.edgeCenterX, y: clear.edgeCenterY }, 'smart');
  }
  const routed = orderedEdges.flatMap(edge => {
    const drawing = drawings.get(edge.id);
    return drawing ? [{ id: edge.id, type: edge.type, points: drawing.points }] : [];
  });
  for (const [id, gaps] of findCrossingGaps(routed, direction, labelObstacles)) {
    const drawing = drawings.get(id)!;
    const xs = drawing.points.map(point => point.x), ys = drawing.points.map(point => point.y);
    // Allow for the snapped handle and arrowhead outside the polyline bounds.
    const padding = 24;
    const x = Math.min(...xs) - padding, y = Math.min(...ys) - padding;
    drawing.crossings = { gaps, bounds: { x, y, width: Math.max(...xs) + padding - x, height: Math.max(...ys) + padding - y } };
  }
  return drawings;
}

export function useProcessRoutes(nodes: LayoutNode[], edges: LayoutEdge[], direction: LayoutDirection, ports: RelationPorts, geometryKey: string, savedRoutes?: Record<string, EdgeRoute>) {
  // Saving a selection returns fresh JSON, including copies of identical saved routes.
  const drawingKey = useMemo(() => {
    const routeIds = Object.keys(savedRoutes || {}).filter(id => savedRoutes?.[id].geometryKey === geometryKey).sort();
    const routes = routeIds.map(id => {
      const { points, label } = savedRoutes![id];
      return [id, points.map(({ x, y }) => [x, y]), label && [label.x, label.y, label.width, label.height]];
    });
    return JSON.stringify([geometryKey, routes]);
  }, [geometryKey, savedRoutes]);
  const [snapshot, setSnapshot] = useState<{ key: string; drawings: ReturnType<typeof buildDrawings> }>();
  const inputs = useRef<{ key: string; args: Parameters<typeof buildDrawings> }>({ key: drawingKey, args: [nodes, edges, direction, ports, geometryKey, savedRoutes] });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(timer.current); timer.current = undefined; }, []);
  useEffect(() => {
    inputs.current = { key: drawingKey, args: [nodes, edges, direction, ports, geometryKey, savedRoutes] };
    if (timer.current !== undefined) return;
    // Keep updating during a drag by taking the latest geometry each time the timer fires.
    timer.current = setTimeout(() => {
      timer.current = undefined;
      const { key, args } = inputs.current;
      setSnapshot({ key, drawings: buildDrawings(...args) });
    }, 25);
    // The key covers the layout inputs and the saved routes for that geometry.
  }, [drawingKey]);
  return snapshot?.key === drawingKey ? snapshot.drawings : undefined;
}

export function processEdgeColor(kind: string, highlighted: boolean) {
  return highlighted ? '#16816d' : kind === 'return' ? '#a0773e' : '#647e80';
}

function EdgeDrawing({ props, path, labelCenter, mode, crossings }: { props: EdgeProps; path: string; labelCenter: Point; mode: string; crossings?: CrossingMask }) {
  const data = props.data as RouteData;
  const highlighted = props.selected || data.highlighted;
  const isReturn = data.kind === 'return';
  const maskId = `edge-crossings-${useId()}`;
  return <>
    <g data-route-mode={mode} data-route-id={props.id} data-crossing-count={crossings?.gaps.length}>
      {crossings && <defs><mask id={maskId} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" {...crossings.bounds}>
        <rect {...crossings.bounds} fill="white" />
        {crossings.gaps.map(({ x, y }) => <circle key={`${x}:${y}`} cx={x} cy={y} r={CROSSING_GAP_RADIUS} fill="black" />)}
      </mask></defs>}
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} interactionWidth={10} mask={crossings ? `url(#${maskId})` : undefined} style={{ stroke: processEdgeColor(data.kind, highlighted), strokeWidth: highlighted ? 2.4 : 1.6, strokeDasharray: isReturn || ['data', 'association'].includes(data.kind) ? '5 5' : undefined, opacity: mode === 'pending' ? .45 : 1 }} />
    </g>
    {data.label && <EdgeLabelRenderer><div data-edge-label={props.id} className={`edge-label nodrag nopan ${highlighted ? 'selected' : ''} ${isReturn ? 'return-label' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${labelCenter.x}px, ${labelCenter.y}px)`, width: data.labelWidth, minHeight: data.labelHeight }} title={mode === 'fallback' ? `${data.label}（路径空间不足，可移动节点后重试）` : data.label}>{data.label}</div></EdgeLabelRenderer>}
  </>;
}

export function ProcessEdge(props: EdgeProps) {
  const data = props.data as RouteData;
  const drawing = data.drawing;
  const first = drawing?.points[0], last = drawing?.points.at(-1);
  // Snap the card-boundary endpoints to React Flow's measured outer handle edges.
  const matchesHandles = first && last && Math.hypot(first.x - props.sourceX, first.y - props.sourceY) < 4 && Math.hypot(last.x - props.targetX, last.y - props.targetY) < 4;
  if (!drawing || !matchesHandles) {
    const [path, x, y] = getSmoothStepPath({ ...props, borderRadius: 8, offset: 28 });
    return <EdgeDrawing props={props} path={path} labelCenter={{ x, y }} mode={drawing === null ? 'fallback' : 'pending'} />;
  }
  const start = { x: props.sourceX, y: props.sourceY }, end = { x: props.targetX, y: props.targetY };
  const aligned = alignRouteToHandles(drawing.points, props, drawing.obstacles);
  // Keep the obstacle route if a tight corridor forbids realignment. Render it
  // without rounding, so the subpixel endpoint correction cannot become a jog.
  const points = aligned || [start, ...drawing.points.slice(1, -1), end];
  const path = drawing.mode === 'elk' || drawing.shifted || !aligned ? points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
    : drawSmartPath(start, end, points.slice(1, -1).map(({ x, y }) => [x, y]));
  return <EdgeDrawing props={props} path={path} labelCenter={drawing.labelCenter} mode={drawing.mode} crossings={drawing.crossings} />;
}
