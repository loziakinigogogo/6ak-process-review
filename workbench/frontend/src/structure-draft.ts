export const fieldLabels: Record<string, string> = {
  role: '负责人',
  system: '工具 / 系统',
  trigger: '触发条件',
  input: '输入资料',
  actions: '操作说明',
  output: '完成结果',
  rules: '注意事项',
};

export const relationLabels: Record<string, string> = {
  sequence: '顺序',
  conditional: '条件',
  parallel: '并行',
  return: '返回',
  data: '数据交付',
  association: '关联',
};

type NodeInput = { title: string; groupId: string; fields?: Record<string, string> };
type Connection = { id?: string; from: string; to: string; type: string; description: string; condition?: string };
type RelatedUpdate = { nodeId: string; claimId: string; text: string };
type Operation = { type: 'add-node'; node: NodeInput }
  | { type: 'connect'; relation: Connection }
  | { type: 'insert-step'; relationId: string; node: NodeInput; updates?: RelatedUpdate[] };

export type LegacyStructureDraft = { requestId: string; baseWorkRevision: number; operation: Operation };

type StructureModel = {
  nodes: Array<{ id: string; title: string }>;
  relations: Array<{ id: string; from: string; to: string }>;
  groups: Array<{ id: string; title: string }>;
  claims: Array<{ id: string; text: string }>;
};

export function legacyStructureHandoff(draft: LegacyStructureDraft, model: StructureModel) {
  const { operation } = draft;
  const title = (id: string) => model.nodes.find(node => node.id === id)?.title || id;
  const targets: Array<{ type: 'node' | 'relation'; id: string; label: string }> = [];
  const focusEdge = (id?: string) => {
    const edge = model.relations.find(relation => relation.id === id);
    if (edge) targets.push({ type: 'relation', id: edge.id, label: `${title(edge.from)} → ${title(edge.to)}` });
    return edge;
  };

  if (operation.type === 'connect') {
    const { id, from, to, type, description, condition } = operation.relation;
    focusEdge(id);
    for (const endpoint of new Set([from, to])) {
      if (model.nodes.some(node => node.id === endpoint)) targets.push({ type: 'node', id: endpoint, label: title(endpoint) });
    }
    const lines = [
      `W${draft.baseWorkRevision} · ${id ? '改接' : '增加连线'}草稿`,
      `${from ? title(from) : '尚未选择起点'} → ${to ? title(to) : '尚未选择终点'}（${relationLabels[type] || type}）`,
      description,
      condition && `适用条件 · ${condition}`,
    ];
    return { presetId: 'revise-connections', targets, draft: lines.filter(Boolean).join('\n') };
  }

  const label = operation.type === 'insert-step' ? '插入步骤' : '新增节点';
  const lines = [`W${draft.baseWorkRevision} · ${label}草稿`];
  if (operation.type === 'insert-step') {
    const edge = focusEdge(operation.relationId);
    lines.push(`原顺序线 · ${edge ? `${title(edge.from)} → ${title(edge.to)}` : operation.relationId}`);
  }
  const { title: draftTitle, groupId, fields } = operation.node;
  if (draftTitle) lines.push(`新节点 · ${draftTitle}`);
  const group = model.groups.find(item => item.id === groupId);
  if (group) lines.push(`整理分组 · ${group.title}`);
  for (const [field, text] of Object.entries(fields || {})) if (text) lines.push(`${fieldLabels[field] || field} · ${text}`);
  if (operation.type === 'insert-step') {
    for (const update of operation.updates || []) {
      const original = model.claims.find(claim => claim.id === update.claimId)?.text || update.claimId;
      lines.push(`${title(update.nodeId)} · 将「${original}」改为「${update.text}」`);
    }
  }
  return { presetId: 'propose-node', targets, draft: lines.join('\n') };
}
