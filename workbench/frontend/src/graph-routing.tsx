import React, { useMemo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { useSmartEdgePath } from '@tisoap/react-flow-smart-edge';

export type Point = { x: number; y: number };
export type EdgeRoute = { points: Point[]; label?: Point & { width: number; height: number }; geometryKey: string };
export type ScopedLayout = { revision: number; positions: Record<string, Point>; manualNodeIds: string[]; routes: Record<string, EdgeRoute>; previous?: { positions: Record<string, Point>; manualNodeIds: string[]; routes: Record<string, EdgeRoute> } };
type Box = Point & { width: number; height: number };
type RouteData = { kind: string; highlighted: boolean; label: string; labelWidth: number; labelHeight: number; route?: EdgeRoute; obstacles: Box[] };

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

function EdgeDrawing({ props, path, labelCenter, mode }: { props: EdgeProps; path: string; labelCenter: Point; mode: string }) {
  const data = props.data as RouteData;
  const highlighted = props.selected || data.highlighted;
  const isReturn = data.kind === 'return';
  return <>
    <g data-route-mode={mode} data-route-id={props.id}>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={{ stroke: highlighted ? '#16816d' : isReturn ? '#a0773e' : '#7c9294', strokeWidth: highlighted ? 2.2 : 1.45, strokeDasharray: isReturn || ['data', 'association'].includes(data.kind) ? '5 5' : undefined, opacity: mode === 'pending' ? .45 : 1 }} />
    </g>
    {data.label && <EdgeLabelRenderer><div data-edge-label={props.id} className={`edge-label nodrag nopan ${highlighted ? 'selected' : ''} ${isReturn ? 'return-label' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${labelCenter.x}px, ${labelCenter.y}px)`, width: data.labelWidth, minHeight: data.labelHeight }} title={mode === 'fallback' ? `${data.label}（路径空间不足，可移动节点后重试）` : data.label}>{data.label}</div></EdgeLabelRenderer>}
  </>;
}

function SmartProcessEdge(props: EdgeProps) {
  const data = props.data as RouteData;
  const { route } = useSmartEdgePath({ ...props, preset: 'smoothstep' });
  const [nativePath, x, y] = getSmoothStepPath({ ...props, borderRadius: 8, offset: 28 });
  const drawing = useMemo(() => {
    if (!route || route.kind !== 'routed') return { path: nativePath, labelCenter: { x, y }, mode: route ? 'fallback' : 'pending' };
    const points = [{ x: props.sourceX, y: props.sourceY }, ...route.points.map(([x, y]) => ({ x, y })), { x: props.targetX, y: props.targetY }];
    return { path: route.svgPathString, labelCenter: centerOnFreeSegment(points, data.labelWidth, data.labelHeight, data.obstacles, { x: route.edgeCenterX, y: route.edgeCenterY }), mode: 'smart' };
  }, [route, nativePath, x, y, props.sourceX, props.sourceY, props.targetX, props.targetY, data]);
  return <EdgeDrawing props={props} {...drawing} />;
}

export function ProcessEdge(props: EdgeProps) {
  const data = props.data as RouteData;
  const route = data.route;
  // A moved endpoint may precede the new geometry signature by one render.
  const first = route?.points[0], last = route?.points.at(-1);
  // React Flow's 5px handles sit just outside the card boundary. ELK ports are
  // at the boundary; snap only that small offset to the measured handle center.
  const matchesHandles = first && last && Math.hypot(first.x - props.sourceX, first.y - props.sourceY) < 4 && Math.hypot(last.x - props.targetX, last.y - props.targetY) < 4;
  if (!route || !matchesHandles) return <SmartProcessEdge {...props} />;
  const points = route.points.map(point => ({ ...point }));
  points[0] = { x: props.sourceX, y: props.sourceY };
  points[points.length - 1] = { x: props.targetX, y: props.targetY };
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const labelCenter = route.label ? { x: route.label.x + route.label.width / 2, y: route.label.y + route.label.height / 2 } : centerOnFreeSegment(route.points, data.labelWidth, data.labelHeight, data.obstacles, { x: (first.x + last.x) / 2, y: (first.y + last.y) / 2 });
  return <EdgeDrawing props={props} path={path} labelCenter={labelCenter} mode="elk" />;
}
