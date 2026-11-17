'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = import('../frontend/src/node-navigation.mjs');
const snapshot = (scrollTop, groupId, query = '') => ({
  reading: { scrollTop, expandedKeys: ['materials', `at-${scrollTop}`], focus: { key: 'raw-input', selectionStart: 2, selectionEnd: 6 } },
  directory: { groupId, query, collapsedGroupIds: ['other-group'], scrollTop: scrollTop / 2 },
});

test('A → B → C returns each visit reading, focus and directory context without rolling back node drafts', async () => {
  const { createNavigation, navigateTo, navigateBack, navigateOrigin, currentVisit } = await load;
  const drafts = { A: 'latest A words', B: 'new B input' };
  let state = createNavigation('A', { groupId: 'first', query: 'original filter' });
  const initial = structuredClone(state);
  state = navigateTo(state, 'B', snapshot(410, 'first', 'A filter'));
  state = navigateTo(state, 'C', snapshot(820, 'second', 'B filter'));
  drafts.A = 'A newer input arrived while C was open';
  const atC = structuredClone(state);
  state = navigateBack(state, snapshot(33, 'third'));
  assert.equal(currentVisit(state).nodeId, 'B');
  assert.deepEqual(currentVisit(state).reading, snapshot(820, 'second').reading);
  assert.deepEqual(currentVisit(state).directory, snapshot(820, 'second', 'B filter').directory);
  state = navigateBack(state);
  assert.equal(currentVisit(state).nodeId, 'A');
  assert.deepEqual(currentVisit(state).reading, snapshot(410, 'first').reading);
  assert.equal(currentVisit(state).directory.query, 'A filter');
  assert.deepEqual(currentVisit(navigateOrigin(atC, snapshot(55, 'third'))), currentVisit(state));
  assert.equal(drafts.A, 'A newer input arrived while C was open');
  assert.ok(!JSON.stringify(state).includes('draft'));
  assert.equal(initial.visits[0].reading.scrollTop, 0, 'operations do not mutate their inputs');
  assert.equal(atC.visits[2].reading.scrollTop, 0);
});

test('repeated nodes and loops have independent visits; branching after back never reuses a visit ID', async () => {
  const { createNavigation, navigateTo, navigateBack, currentVisit } = await load;
  let state = createNavigation('A');
  state = navigateTo(state, 'B', snapshot(11, 'g'));
  state = navigateTo(state, 'A', snapshot(22, 'g'));
  assert.deepEqual(state.visits.map(visit => visit.nodeId), ['A', 'B', 'A']);
  assert.notEqual(state.visits[0].visitId, state.visits[2].visitId);
  state = navigateTo(state, 'C', snapshot(333, 'g'));
  state = navigateBack(state);
  assert.equal(currentVisit(state).reading.scrollTop, 333, 'second A restores its own reading');
  const discardedId = state.visits[3].visitId;
  state = navigateBack(state);
  state = navigateTo(state, 'D', snapshot(24, 'g'));
  assert.deepEqual(state.visits.map(visit => visit.nodeId), ['A', 'B', 'D']);
  assert.notEqual(currentVisit(state).visitId, discardedId);
  assert.equal(state.visits[0].reading.scrollTop, 11, 'first A is not overwritten by later A');
});

test('same-node locate creates a returnable directory context while ordinary same-node selection stays put', async () => {
  const { createNavigation, captureVisit, navigateTo, navigateBack, currentVisit } = await load;
  let state = createNavigation('outside', { groupId: 'prior-group', query: 'keep my filter', collapsedGroupIds: ['target-group'], scrollTop: 90 });
  state = captureVisit(state, { reading: { scrollTop: 500, expandedKeys: ['materials'] } });
  const ordinary = navigateTo(state, 'outside', { reading: { scrollTop: 501 } });
  assert.equal(ordinary.visits.length, 1);
  const locating = navigateTo(ordinary, 'outside', undefined, 'locate');
  assert.equal(locating.visits.length, 2);
  assert.equal(currentVisit(locating).reading.scrollTop, 501);
  const located = captureVisit(locating, { directory: { groupId: 'target-group', query: '', collapsedGroupIds: [], scrollTop: 12 } });
  assert.equal(currentVisit(located).directory.groupId, 'target-group');
  const back = currentVisit(navigateBack(located));
  assert.deepEqual(back.directory, state.visits[0].directory);
  assert.equal(back.reading.scrollTop, 501);
});

test('explicit selection starts a related-reading chain without erasing earlier visits or locate directory context', async () => {
  const { createNavigation, captureVisit, navigateTo, navigateBack, navigateOrigin, currentVisit, restoreNavigation } = await load;
  let state = createNavigation('Z');
  state = navigateTo(state, 'A', snapshot(99, 'Z-group'), 'node', true);
  const origin = currentVisit(state).visitId;
  state = navigateTo(state, 'B', snapshot(111, 'A-group', 'A-filter'));
  state = navigateTo(state, 'C', snapshot(222, 'B-group'));
  assert.equal(currentVisit(state).originVisitId, origin);
  const returned = navigateOrigin(state, snapshot(333, 'C-group'));
  assert.equal(currentVisit(returned).nodeId, 'A');
  assert.equal(currentVisit(returned).reading.scrollTop, 111);
  assert.equal(returned.visits[3].reading.scrollTop, 333);
  const previous = navigateBack(returned);
  assert.equal(currentVisit(previous).nodeId, 'Z');
  assert.equal(currentVisit(previous).reading.scrollTop, 99);
  const locating = navigateTo(state, 'C', snapshot(334, 'A-group', 'hidden target'), 'locate', true);
  assert.equal(currentVisit(locating).originVisitId, origin, 'locating never starts a new related chain');
  const located = captureVisit(locating, { directory: { groupId: 'C-group', query: '', scrollTop: 9 } });
  assert.equal(currentVisit(navigateBack(located)).directory.query, 'hidden target');
  assert.equal(currentVisit(navigateOrigin(located)).nodeId, 'A');
  const reselected = navigateTo(returned, 'A', snapshot(112, 'A-group'), 'node', true);
  assert.notEqual(currentVisit(reselected).visitId, origin);
  assert.equal(currentVisit(reselected).originVisitId, currentVisit(reselected).visitId);
  const legacy = structuredClone(state);
  legacy.visits.forEach(visit => delete visit.originVisitId);
  assert.equal(currentVisit(navigateOrigin(restoreNavigation(legacy, 'fallback'))).nodeId, 'Z', 'old records keep their original first-visit origin');
});

test('restore retains deleted node identities and strips foreign payloads without sharing mutable references', async () => {
  const { createNavigation, captureVisit, navigateTo, restoreNavigation, currentVisit, nodeIdentity } = await load;
  let state = navigateTo(createNavigation('A'), 'deleted-node', snapshot(12, 'old-group'));
  state = captureVisit(state, snapshot(42, 'removed-group'));
  const saved = JSON.parse(JSON.stringify(state));
  saved.drafts = { A: 'must never restore as draft' };
  saved.visits[1].draft = { text: 'obsolete words' };
  saved.visits[1].reading.draft = 'not reading state';
  const restored = restoreNavigation(saved, 'replacement-node');
  assert.equal(currentVisit(restored).nodeId, 'deleted-node');
  assert.equal(nodeIdentity({ nodes: [], groups: [] }, currentVisit(restored).nodeId), undefined);
  assert.ok(!JSON.stringify(restored).includes('draft'));
  saved.visits[1].reading.expandedKeys.push('outside mutation');
  const returned = currentVisit(restored); returned.reading.expandedKeys.push('caller mutation');
  assert.deepEqual(restored.visits[1].reading.expandedKeys, ['materials', 'at-42']);
  assert.deepEqual(restoreNavigation(JSON.stringify(restored), 'fallback'), restored);
});

test('invalid persisted values safely fall back and malformed reading values are normalized', async () => {
  const { createNavigation, restoreNavigation, captureVisit, currentVisit, navigateBack, navigateOrigin } = await load;
  const good = createNavigation('A');
  const hostile = {}; Object.defineProperty(hostile, 'schemaVersion', { get() { throw Error('getter'); } });
  const malformed = [null, undefined, '{broken json', 'null', [], { schemaVersion: 9 }, { ...good, index: 4 },
    { ...good, visits: [good.visits[0], good.visits[0]], index: 1 },
    { ...good, visits: [{ ...good.visits[0], nodeId: '' }] }, hostile];
  for (const value of malformed) assert.deepEqual(restoreNavigation(value, 'safe-node'), createNavigation('safe-node'));
  const dirty = JSON.parse(JSON.stringify(good));
  dirty.visits[0].reading = { scrollTop: -10, expandedKeys: ['materials', null, 'materials', {}], focus: { key: 'input', selectionStart: 5, selectionEnd: 2 } };
  dirty.visits[0].directory = { groupId: {}, query: 12, collapsedGroupIds: [null, 'g', 'g'], scrollTop: Infinity };
  const normalized = currentVisit(restoreNavigation(dirty, 'safe-node'));
  assert.deepEqual(normalized.reading, { scrollTop: 0, expandedKeys: ['materials'], focus: { key: 'input', selectionStart: 5, selectionEnd: 5 } });
  assert.deepEqual(normalized.directory, { groupId: 'all', query: '', collapsedGroupIds: ['g'], scrollTop: 0 });
  const noFocus = captureVisit(restoreNavigation(dirty), { reading: { focus: null } });
  assert.equal(currentVisit(noFocus).reading.focus, undefined);
  assert.deepEqual(navigateBack(createNavigation()), createNavigation());
  assert.deepEqual(navigateOrigin(good), good);
});

test('node identity uses full-model group order, target color and stable IDs rather than filtered numbering', async () => {
  const { nodeIdentity } = await load;
  const model = { groups: [{ id: 'green', title: '第一组' }, { id: 'blue', title: '第二组' }], nodes: [
    { id: 'g-1', groupId: 'green', title: '一' }, { id: 'b-1', groupId: 'blue', title: '蓝一' },
    { id: 'g-2', groupId: 'green', title: '二' }, { id: 'g-3', groupId: 'green', title: '三' },
  ] };
  const filteredIds = ['g-3', 'b-1'];
  const identities = filteredIds.map(id => nodeIdentity(model, id));
  assert.equal(identities[0].number, 3); assert.equal(identities[1].number, 1);
  assert.equal(identities[0].color, '#477e60'); assert.equal(identities[1].color, '#527c9b');
  assert.equal(identities[1].groupTitle, '第二组'); assert.equal(identities[1].groupIndex, 1);
  const shifted = { ...model, nodes: model.nodes.filter(node => node.id !== 'g-1') };
  assert.equal(nodeIdentity(shifted, 'g-3').number, 2); assert.equal(nodeIdentity(shifted, 'g-3').id, 'g-3');
  const main = fs.readFileSync(path.join(__dirname, '../frontend/src/main.tsx'), 'utf8');
  const palette = main.match(/const groupColors = \[([^\]]+)\]/)[1].match(/#[0-9a-f]{6}/g);
  const allGroups = palette.map((_, index) => ({ id: `group-${index}`, title: `组${index}` }));
  const allNodes = allGroups.map(group => ({ id: `node-${group.id}`, groupId: group.id, title: group.title }));
  assert.deepEqual(allNodes.map(node => nodeIdentity({ nodes: allNodes, groups: allGroups }, node.id).color), palette, 'shared identity palette matches the existing graph');
});
