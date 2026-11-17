/** Reading navigation only. Material/editor drafts remain in their node-ID store. */
const NODE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const VISIT_ID = /^visit-([1-9]\d{0,12})$/;
const GROUP_COLORS = ['#477e60', '#527c9b', '#a17736', '#81709a', '#a15d70', '#608381'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validNodeId = value => typeof value === 'string' && NODE_ID.test(value);
const nonnegative = value => Number.isFinite(value) && value >= 0;
const stringList = (value, maximum = 1000) => Array.isArray(value)
  ? [...new Set(value.filter(item => typeof item === 'string' && item.length > 0 && item.length <= 512).slice(0, maximum))]
  : [];

function readingState(value, previous) {
  const base = previous || { scrollTop: 0, expandedKeys: [] };
  const input = record(value) ? value : {};
  const result = {
    scrollTop: nonnegative(input.scrollTop) ? input.scrollTop : base.scrollTop,
    expandedKeys: Object.hasOwn(input, 'expandedKeys') ? stringList(input.expandedKeys) : [...base.expandedKeys],
  };
  const focus = Object.hasOwn(input, 'focus') ? input.focus : base.focus;
  if (record(focus) && typeof focus.key === 'string' && focus.key.length > 0 && focus.key.length <= 512) {
    result.focus = { key: focus.key };
    for (const field of ['selectionStart', 'selectionEnd']) {
      if (Number.isSafeInteger(focus[field]) && focus[field] >= 0) result.focus[field] = focus[field];
    }
    if (result.focus.selectionStart !== undefined && result.focus.selectionEnd !== undefined) {
      result.focus.selectionEnd = Math.max(result.focus.selectionStart, result.focus.selectionEnd);
    }
  }
  return result;
}

function directoryState(value, previous) {
  const base = previous || { groupId: 'all', query: '', collapsedGroupIds: [], scrollTop: 0 };
  const input = record(value) ? value : {};
  return {
    groupId: validNodeId(input.groupId) ? input.groupId : base.groupId,
    query: typeof input.query === 'string' ? input.query.slice(0, 4000) : base.query,
    collapsedGroupIds: Object.hasOwn(input, 'collapsedGroupIds')
      ? stringList(input.collapsedGroupIds).filter(validNodeId) : [...base.collapsedGroupIds],
    scrollTop: nonnegative(input.scrollTop) ? input.scrollTop : base.scrollTop,
  };
}

function copyVisit(visit) {
  return {
    visitId: visit.visitId, nodeId: visit.nodeId, kind: visit.kind, originVisitId: visit.originVisitId,
    reading: readingState(visit.reading), directory: directoryState(visit.directory),
  };
}

/** An absent selection produces an empty history, never an invented node identity. */
export function createNavigation(nodeId, directory) {
  const visits = validNodeId(nodeId) ? [{
    visitId: 'visit-1', nodeId, kind: 'node', originVisitId: 'visit-1',
    reading: readingState(), directory: directoryState(directory),
  }] : [];
  return { schemaVersion: 1, visits, index: visits.length - 1, nextVisitId: visits.length + 1 };
}

/**
 * Accept either parsed local-storage data or its JSON string. Only navigation
 * fields are copied: old/deleted node IDs are retained, editor drafts are not.
 * A malformed structural history falls back as a whole rather than silently
 * reindexing visits or moving their snapshots to a different node.
 */
export function restoreNavigation(value, fallbackNodeId) {
  try {
    const input = typeof value === 'string' ? JSON.parse(value) : value;
    if (!record(input) || input.schemaVersion !== 1 || !Array.isArray(input.visits)
      || !Number.isInteger(input.index)
      || (input.visits.length ? input.index < 0 || input.index >= input.visits.length : input.index !== -1)) {
      return createNavigation(fallbackNodeId);
    }
    const ids = new Set();
    let greatest = 0;
    const visits = input.visits.map((visit, index) => {
      if (!record(visit) || !validNodeId(visit.nodeId) || typeof visit.visitId !== 'string'
        || !VISIT_ID.test(visit.visitId) || ids.has(visit.visitId)
        || !['node', 'locate'].includes(visit.kind)) throw new Error('Invalid visit');
      ids.add(visit.visitId);
      greatest = Math.max(greatest, Number(visit.visitId.slice(6)));
      const originVisitId = visit.originVisitId === undefined ? input.visits[0].visitId : visit.originVisitId;
      if (typeof originVisitId !== 'string' || !ids.has(originVisitId)) throw new Error('Invalid chain origin');
      return copyVisit({ ...visit, originVisitId });
    });
    const nextVisitId = Number.isSafeInteger(input.nextVisitId) && input.nextVisitId > greatest
      ? input.nextVisitId : greatest + 1;
    if (nextVisitId > 9999999999999) return createNavigation(fallbackNodeId);
    return { schemaVersion: 1, visits, index: input.index, nextVisitId };
  } catch {
    return createNavigation(fallbackNodeId);
  }
}

/** Return a defensive copy, so a DOM capture cannot mutate a stored visit. */
export function currentVisit(state) {
  const clean = restoreNavigation(state);
  return clean.visits[clean.index] ? copyVisit(clean.visits[clean.index]) : undefined;
}

/** Capture the current/ departing visit. Missing snapshot fields retain their prior value. */
export function captureVisit(state, snapshot) {
  const next = restoreNavigation(state);
  const visit = next.visits[next.index];
  if (!visit || !record(snapshot)) return next;
  visit.reading = readingState(snapshot.reading, visit.reading);
  visit.directory = directoryState(snapshot.directory, visit.directory);
  return next;
}

/**
 * snapshot describes the page being left. New nodes start at the top while
 * retaining the directory context. A same-node 'locate' creates a visit so the
 * caller may then capture its changed directory and return to the old filters.
 * A new branch after Back discards forward visits; IDs are never reused.
 * startChain marks an explicit directory/search/graph selection as a new origin.
 * Related-node navigation inherits that origin. A locate visit never resets it.
 */
export function navigateTo(state, nodeId, snapshot, kind = 'node', startChain = false) {
  const next = captureVisit(state, snapshot);
  if (!validNodeId(nodeId)) return next;
  const current = next.visits[next.index];
  if (current?.nodeId === nodeId && kind !== 'locate' && !startChain) return next;
  const visitId = `visit-${next.nextVisitId}`;
  const visit = {
    visitId, nodeId, kind: kind === 'locate' ? 'locate' : 'node',
    originVisitId: !current || (startChain && kind !== 'locate') ? visitId : current.originVisitId,
    reading: kind === 'locate' && current?.nodeId === nodeId ? readingState(current.reading) : readingState(),
    directory: directoryState(current?.directory || snapshot?.directory),
  };
  return { schemaVersion: 1, visits: [...next.visits.slice(0, next.index + 1), visit],
    index: next.index + 1, nextVisitId: next.nextVisitId + 1 };
}

export function navigateBack(state, snapshot) {
  const next = captureVisit(state, snapshot);
  if (next.index > 0) next.index -= 1;
  return next;
}

export function navigateOrigin(state, snapshot) {
  const next = captureVisit(state, snapshot);
  const current = next.visits[next.index];
  if (current) next.index = next.visits.findIndex(visit => visit.visitId === current.originVisitId);
  return next;
}

/** The caller supplies the full model, never its filtered directory projection. */
export function nodeIdentity(model, nodeId) {
  const nodes = Array.isArray(model?.nodes) ? model.nodes : [];
  const groups = Array.isArray(model?.groups) ? model.groups : [];
  const node = nodes.find(item => item?.id === nodeId);
  if (!node || typeof node.id !== 'string') return undefined;
  const groupIndex = groups.findIndex(group => group?.id === node.groupId);
  return {
    id: node.id, title: node.title, groupId: node.groupId,
    groupTitle: groups[groupIndex]?.title || '未分组', groupIndex,
    number: nodes.filter(item => item?.groupId === node.groupId).findIndex(item => item.id === node.id) + 1,
    color: GROUP_COLORS[(groupIndex + GROUP_COLORS.length) % GROUP_COLORS.length],
  };
}
