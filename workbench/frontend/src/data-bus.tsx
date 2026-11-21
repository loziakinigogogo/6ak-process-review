import React from 'react';
import { portPoint, type LayoutDirection, type LayoutEdge, type LayoutNode, type Point, type RelationPorts } from './graph-layout.mjs';

const swap = (p: Point) => ({ x: p.y, y: p.x });
const linePath = (points: Point[]) => points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');

// Work with the flow moving right. Transpose vertical views, including card extents.
export function planDataBus(ids: string[], nodes: LayoutNode[], edges: LayoutEdge[], ports: RelationPorts, direction: LayoutDirection) {
  const orient = (p: Point) => direction === 'RIGHT' ? p : swap(p);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const members = new Set(ids);
  const relations = edges.filter(e => members.has(e.to));
  if (relations.length !== ids.length || !relations.length) return;
  const source = byId.get(relations[0].from);
  if (!source || relations.some(e => e.from !== source.id || e.dataLeafGroup === undefined || e.dataLeafGroup !== relations[0].dataLeafGroup)) return;
  const outputs = relations.map(e => orient(portPoint(source, ports.byEdge.get(e.id)!.source, direction))).sort((a,b) => a.y - b.y);
  const start = outputs[Math.floor(outputs.length / 2)];
  const tips = relations.map(e => ({ id: e.id, point: orient(portPoint(byId.get(e.to)!, ports.byEdge.get(e.id)!.target, direction)) }));
  const boxes = nodes.map(n => ({ ...orient(n), width: direction === 'RIGHT' ? n.width : n.height, height: direction === 'RIGHT' ? n.height : n.width, id: n.id }));
  const targets = boxes.filter(b => members.has(b.id));
  const left = Math.min(...targets.map(b => b.x));
  if (left - start.x < 115) return;
  const top = Math.min(...targets.map(b => b.y)), bottom = Math.max(...targets.map(b => b.y + b.height));
  const columns = [...new Set(tips.map(t => t.point.x))].sort((a,b) => a-b);
  const busX = (x: number) => x - 35;
  // Test the common feeder, each column and each tip against all measured cards.
  function clear(points: Point[]) {
    return points.slice(1).every((p,i) => {
      const a = points[i];
      return boxes.every(b => !(Math.max(a.x,p.x) > b.x + .01 && Math.min(a.x,p.x) < b.x+b.width-.01
        && Math.max(a.y,p.y) > b.y+.01 && Math.min(a.y,p.y) < b.y+b.height-.01));
    });
  }
  for (const rail of [top-44,bottom+44].sort((a,b) => Math.abs(a-start.y)-Math.abs(b-start.y))) {
    for (const offset of [.55,.28,.8]) {
      const bend = start.x + (busX(left)-start.x)*offset;
      const prefix = [start, {x:bend,y:start.y}, {x:bend,y:rail}];
      const feeder = [...prefix,{ x:busX(columns[columns.length-1]), y:rail }];
      const spines = columns.map(x => {
        const ends=tips.filter(t=>t.point.x===x).map(t=>t.point.y);
        return [{x:busX(x),y:rail},{x:busX(x),y:rail < top ? Math.max(...ends) : Math.min(...ends)}];
      });
      const branches = tips.map(({id,point}) => {
        const joint = {x:busX(point.x),y:point.y};
        return {id, tail:[joint,point], trace:[...prefix,{x:joint.x,y:rail},joint,point]};
      });
      if (![feeder,...spines,...branches.map(b => b.tail)].every(clear)) continue;
      const labels = [prefix[0], prefix[1], prefix[2]].map((a,i) => orient({x:(a.x+feeder[i+1].x)/2, y:(a.y+feeder[i+1].y)/2}));
      const label = labels.find(p => nodes.every(n => p.x+65 < n.x || p.x-65 > n.x+n.width || p.y+15 < n.y || p.y-15 > n.y+n.height));
      if (!label) continue;
      return {
        source:source.id, ids:branches.map(b=>b.id), label,
        lines:[feeder,...spines].map(line => linePath(line.map(orient))),
        joints:spines.slice(0,-1).map(line => orient(line[0])).concat(branches.filter(b=>!spines.some(line=>line[1].x===b.tail[0].x && line[1].y===b.tail[0].y)).map(b=>orient(b.tail[0]))),
        branches:branches.map(b=>({id:b.id,tail:b.tail.map(orient),trace:linePath(b.trace.map(orient))})),
      };
    }
  }
}

export type DataBus = NonNullable<ReturnType<typeof planDataBus>>;

export function DataBusOverlay({ bus, activeId, open }: { bus: DataBus; activeId?: string | null; open: () => void }) {
  const trace = bus.branches.find(b => b.id === activeId)?.trace;
  const openBus = (event: React.MouseEvent) => { event.stopPropagation(); open(); };
  return <>
    <svg className="data-bus-lines" width="1" height="1" aria-hidden="true">
      {bus.lines.map((d,i)=><g key={i}><path d={d} fill="none" stroke="#647e80" strokeWidth="1.6" strokeDasharray="5 5"/>
        <path className="nopan nodrag" d={d} fill="none" stroke="transparent" strokeWidth="10" pointerEvents="stroke" onClick={openBus}/></g>)}
      {bus.joints.map(p=><circle key={`${p.x}:${p.y}`} cx={p.x} cy={p.y} r="2.6" fill="#647e80"/>)}
      {trace && <path data-testid="data-bus-trace" d={trace} fill="none" stroke="#16816d" strokeWidth="2.4" pointerEvents="none"/>}
    </svg>
    <button type="button" className="edge-label data-bus-label nodrag nopan" data-testid="data-bus-label"
      style={{left:bus.label.x,top:bus.label.y}} onClick={openBus}>数据交付 · {bus.ids.length} 个去向</button>
  </>;
}
