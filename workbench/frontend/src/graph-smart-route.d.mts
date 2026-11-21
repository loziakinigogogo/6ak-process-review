import type { EdgeProps } from '@xyflow/react';

type SmartRoute = { points: number[][]; svgPathString: string; edgeCenterX: number; edgeCenterY: number };
type RouteEdge = Pick<EdgeProps, 'source' | 'target' | 'sourceX' | 'sourceY' | 'targetX' | 'targetY' | 'sourcePosition' | 'targetPosition'>;
type Obstacle = { id: string; x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };
type CrossingRoute = { id: string; type?: string; points: readonly Point[] };
export function reduceBranchCrossings(routes: readonly (CrossingRoute & { from: string; to: string })[], nodes: readonly Obstacle[], direction: 'DOWN' | 'RIGHT'): Map<string, Point[]>;
export const CROSSING_GAP_RADIUS: number;
export function alignRouteToHandles(points: readonly Point[], edge: RouteEdge, obstacles?: readonly Obstacle[]): Point[] | null;
export function findCrossingGaps(routes: readonly CrossingRoute[], direction: 'DOWN' | 'RIGHT', obstacles?: readonly Omit<Obstacle, 'id'>[]): Map<string, Point[]>;
export function separateSharedRoute(points: Point[], previousPaths: readonly (readonly Point[])[], obstacles: readonly Obstacle[]): Point[];
export function smartRouteIsClear(route: SmartRoute, edge: RouteEdge, obstacles: Obstacle[]): boolean;
export function resolveUnobstructedSmartRoute(route: SmartRoute, edge: RouteEdge, obstacles: Obstacle[]): SmartRoute | null;
