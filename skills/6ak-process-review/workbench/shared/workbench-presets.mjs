export const PRESETS = Object.freeze([
  Object.freeze({
    id: 'split-by-condition',
    label: '按条件或渠道拆分',
    instruction: '核对原文和我的补充，找出按不同条件或渠道执行的活动。说明共用动作、各路适用条件、旧入线和出口的归属、各自交付内容，以及共同下游的启动条件。分别核对条件边界、覆盖范围和汇合规则。两条数据交付线本身无法确定是否择一、等齐或分别处理。',
  }),
  Object.freeze({
    id: 'split-steps',
    label: '拆成连续步骤',
    instruction: '将原节点已经描述的活动拆成有依据的前后步骤。给出各步的操作、职责、输入、结果及顺序依据。逐条核对旧入线、正常出口、失败返回和数据交付。发现流程中已有同一步时，按节点 ID、实际活动和上下游核对后复用。若附有插入草稿，可沿用其中内容并按拆分核对影响范围。',
  }),
  Object.freeze({
    id: 'enrich-from-source',
    label: '从原文补充节点信息',
    instruction: '回查本任务原文，包括当前节点尚未引用的相关段落。查找遗漏的职责、触发、输入、操作、产出和规则，基于当前工作稿给出字段级修改和出处。保留用户已有修订，遇到冲突并列展示双方。没有新增依据时说明检索结果。',
  }),
]);

export const STRUCTURE_PRESETS = Object.freeze([
  Object.freeze({
    id: 'propose-node',
    label: '起草新节点',
    instruction: '根据我的说明和本任务原文，起草缺失的活动。先核对是否已有相同步骤，再提出节点标题、操作及有依据的职责、输入和产出。选中的节点或连线用于定位上下文。节点有依据而衔接尚未确认时，单独起草节点，将衔接列为待确认事项。只有我明确要求在选中的无条件顺序线上补一步且顺序有依据时，才随候选预览该路径的替换，保留其他连线。',
  }),
  Object.freeze({
    id: 'revise-connections',
    label: '调整连线',
    instruction: '按我的说明和本任务原文，核对现有节点间的流向。列出需新增、改接或移除的关系，逐条说明端点、类型、条件及依据。保留无关的节点和关系，只有明确要求增加活动时才把新节点纳入候选。关系或条件未确认时，将相关变动留作待定。',
  }),
]);

export const normalizationInstruction = '节点材料是输入，当前 model.json 是流程图、节点正文与右侧预览共同的输出。先完整读取该节点有效挂载的源文档片段、用户原话及已有性质和版本，再结合当前模型与上下游整理。kind=raw 是未分类的用户原话，必须纳入任务上下文，不默认当作事实、提醒或建议，也不要求用户先分类。候选返回的 rawMaterialSources 提供原话来源快照，feedbackSources 保留旧版明确事实来源；可追溯来源不等于内容已核实，user-feedback 仅标明用户来源。按当次要求和原话实际含义起草，不擅自把建议写成现状；疑问与冲突继续表达为未知或问题，含混时在现有对话澄清，不新增自动分类或对话记忆。保存材料不等于采用业务变更。核对 node.title 的行动概括、fields/claims.text 的完整正文和 relations 的端点、类型与条件；v1 没有独立 summary 字段，不添加未知字段，不把截断正文当摘要。按角色、触发、输入、动作、输出、规则与例外拆分长表格或复合段落，claims.text 写成完整可核对的业务陈述；去掉纯 HTML/Markdown 排版噪声，保留真实代码、路径、否定、范围、阈值和条件。改写或移除生成陈述不能删除节点挂载材料。逐字来源和证据不改；推断、未知与冲突分别保留，提醒、问题、历史未采用草稿和未来建议不能擅自变成现行事实。生成候选 model.json 并逐项展示差异，复核后经明确确认再采用；材料或工作版本变化时重新读取并起草。';

const reviewInstructions = [
  normalizationInstruction,
  '先用工作台引用核对任务和工作版本。引用过期时，基于最新工作稿核对对象和影响范围。',
  '涉及连线时，先在当前工作稿核对原有起点与终点的节点内容及相关入线、出线。改接时同时读取新端点的最新内容和相关流转，核对新旧端点的实际影响。端点供查证。把确需联动修改的节点字段与连线改动分开列进候选，逐项写明修改前后、理由和依据，供我核对。',
  '先给出候选差异，涵盖实际改动的节点、连线和上下游字段。注明原文、用户确认或推断的依据，保留原有来源、未知和冲突。把影响本次提交的未知留在待定方案里，独立成立的改动可单列候选。',
  '使用 review-candidate 核对候选，展示候选编号及差异。等我明确确认应用所见候选后，再使用该次核对返回的 reviewHash 应用。版本或候选内容变化时，重新展示差异并确认。',
].join('\n');

function getPreset(presetId) {
  const preset = PRESETS.find(item => item.id === presetId) ?? STRUCTURE_PRESETS.find(item => item.id === presetId);
  if (!preset) throw new Error('请选择有效的 Agent 指令。');
  return preset;
}

function subject(targets) {
  return targets.map(({ label }) => `「${label}」`).join('、');
}

export function buildPresetTask({ presetId, processingTargets = [], referenceTargets = [] }) {
  getPreset(presetId);
  const selected = subject(processingTargets);
  const context = subject(referenceTargets);
  const inspect = selected ? `请核对${selected}及相关原文` : context
    ? `请参考${context}和原文，先核对涉及的对象` : '请查阅本任务原文，先核对涉及的对象';
  switch (presetId) {
    case 'propose-node':
      return `${inspect}，找出有依据的遗漏活动并起草新节点。衔接未证实时，可先给出独立节点候选。`;
    case 'revise-connections':
      return `${inspect}，列出有依据的连线调整，并单列确需联动修订的节点字段。`;
    case 'split-by-condition':
      return `${inspect}，判断是否需要按条件或渠道拆分，给出建议并说明旧连线如何处理。`;
    case 'split-steps':
      return `${inspect}，判断已有活动是否应拆成连续步骤，给出顺序依据和建议。`;
    case 'enrich-from-source':
      return `${inspect}，列出有原文依据的遗漏信息和补充建议。`;
  }
}

function describeTarget({ type, id, label }) {
  const kind = { node: '节点', relation: '连线', claim: '陈述', issue: '问题', rule: '规则' }[type] || '对象';
  return `- ${kind} ${JSON.stringify(label)}（${type} ${id}）`;
}

function removeDuplicateQuote(reference, quote) {
  const prefix = `\n引用原文：${quote.text}\nprocess-review-workbench-ref:v1 `;
  const match = reference.lastIndexOf(prefix);
  if (match === -1) return reference;
  return reference.slice(0, match) + '\nprocess-review-workbench-ref:v1 ' + reference.slice(match + prefix.length);
}

export function formatPresetHandoff({ presetId, reference, draft, task, processingTargets = [], referenceTargets = [], quote }) {
  const preset = getPreset(presetId);
  if (typeof reference !== 'string' || !reference.trim()) throw new Error('需要已保存内容的工作台引用。');
  if (draft !== undefined && typeof draft !== 'string') throw new TypeError('草稿必须为文字。');

  const draftText = draft?.trim()
    ? '以下为我主动附上的未保存草稿，独立于引用快照。仅供理解修改意图，业务事实仍需核实。\n' + JSON.stringify(draft) : '';
  if (task === undefined) {
    return [preset.label, preset.instruction, reviewInstructions, reference, draftText].filter(Boolean).join('\n\n');
  }
  if (typeof task !== 'string' || !task.trim()) throw new Error('请保留一条要交给 Agent 的任务。');

  const processing = processingTargets.map(describeTarget);
  const materials = referenceTargets.filter(item => !processingTargets.some(target =>
    target.type === item.type && target.id === item.id)).map(describeTarget);
  if (quote) {
    const location = quote.sourceLabel ? `，${quote.sourceLabel}` : '';
    materials.push(`- 选中的原句（陈述 ${quote.claimId}${location}）：${JSON.stringify(quote.text)}`);
  }
  const guidance = [
    '以我确认的任务和拟处理范围为准。参考材料及版本化引用用于定位和核对，不能自动扩大修改范围。',
    '缺少影响候选的事实时先核对原文，仍不明确就列为待确认或提出具体问题。',
    `按需使用「${preset.label}」的核对方法：${preset.instruction}`,
    reviewInstructions,
  ].join('\n');
  return [
    task,
    ['拟处理对象', ...(processing.length ? processing : ['按任务描述定位。范围不明时先核对并提出建议。'])].join('\n'),
    ['参考材料', ...materials, ...(draftText ? [draftText] : []), quote ? removeDuplicateQuote(reference, quote) : reference].join('\n'),
    guidance,
  ].join('\n\n');
}
