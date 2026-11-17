export type ReadingFocus = { key: string; selectionStart?: number; selectionEnd?: number };
export type ReadingState = { scrollTop: number; expandedKeys: string[]; focus?: ReadingFocus };
export type DirectoryState = { groupId: string; query: string; collapsedGroupIds: string[]; scrollTop: number };
export type NavigationVisit = { visitId: string; nodeId: string; kind: 'node' | 'locate'; originVisitId: string; reading: ReadingState; directory: DirectoryState };
export type NavigationState = { schemaVersion: 1; visits: NavigationVisit[]; index: number; nextVisitId: number };
export type VisitSnapshot = { reading?: Partial<Omit<ReadingState, 'focus'>> & { focus?: ReadingFocus | null }; directory?: Partial<DirectoryState> };
export type NodeIdentity = { id: string; title: string; groupId: string; groupTitle: string; groupIndex: number; number: number; color: string };
export type IdentityModel = { nodes: Array<{ id: string; title: string; groupId: string }>; groups: Array<{ id: string; title: string }> };

export function createNavigation(nodeId?: string | null, directory?: Partial<DirectoryState>): NavigationState;
export function restoreNavigation(value: unknown, fallbackNodeId?: string | null): NavigationState;
export function currentVisit(state: NavigationState): NavigationVisit | undefined;
export function captureVisit(state: NavigationState, snapshot?: VisitSnapshot): NavigationState;
export function navigateTo(state: NavigationState, nodeId: string, snapshot?: VisitSnapshot, kind?: 'node' | 'locate', startChain?: boolean): NavigationState;
export function navigateBack(state: NavigationState, snapshot?: VisitSnapshot): NavigationState;
export function navigateOrigin(state: NavigationState, snapshot?: VisitSnapshot): NavigationState;
export function nodeIdentity(model: IdentityModel, nodeId: string): NodeIdentity | undefined;
