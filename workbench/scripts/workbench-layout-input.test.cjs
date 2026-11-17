'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('layout inputs ignore positions, reading flags and equal-sized text while tracking actual layout geometry', async () => {
  const { layoutInputKey } = await import('../frontend/src/graph-layout-input.mjs');
  const nodes = [
    { id: 'a', x: 20, y: 30, width: 240, height: 150 },
    { id: 'b', x: 400, y: 40, width: 240, height: 130 },
  ];
  const edges = [{ id: 'a-b', from: 'a', to: 'b', type: 'conditional', label: '原条件', labelWidth: 60, labelHeight: 24 }];
  const key = layoutInputKey(nodes, edges, 'RIGHT');
  assert.equal(layoutInputKey(nodes.map(node => ({ ...node, x: node.x + 100, y: node.y - 80, selected: true, manual: true })).reverse(), edges, 'RIGHT'), key);
  assert.equal(layoutInputKey(nodes, [{ ...edges[0], label: '新条件' }], 'RIGHT'), key);
  for (const changed of [
    nodes.map(node => node.id === 'a' ? { ...node, height: 190 } : node),
    [...nodes, { id: 'c', x: 0, y: 0, width: 240, height: 150 }],
  ]) assert.notEqual(layoutInputKey(changed, edges, 'RIGHT'), key);
  for (const changed of [
    [{ ...edges[0], from: 'b', to: 'a' }],
    [{ ...edges[0], type: 'return' }],
    [{ ...edges[0], labelWidth: 100 }],
    [{ ...edges[0], labelHeight: 40 }],
    [],
  ]) assert.notEqual(layoutInputKey(nodes, changed, 'RIGHT'), key);
  assert.notEqual(layoutInputKey(nodes, edges, 'DOWN'), key);
});
