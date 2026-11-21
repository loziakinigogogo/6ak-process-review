# 本地流程工作台 · 0.1.4

工作台随 0.1.4 skill 安装。正式服务脚本及共享逻辑在 `skills/6ak-process-review/workbench/` 维护，本目录保留开发前端、测试与兼容入口。版本与根 `package.json` 一致，开发依赖由仓库根统一安装。安装版的操作见[工作台使用](../skills/6ak-process-review/references/workbench.md)。

工作流为“看图理解 → 补充原话与依据 → 交给 Agent 提炼 → 核对并采用候选”。显式 `demo` 使用合成调价流程，共 14 个节点、17 条关系和 2 个未决问题，不代表实际业务规则。`serve` 创建资料任务需要模型，不能静默使用示例代替。

## 启动与恢复

在维护仓库根目录运行 `npm ci`、`npm run demo:build`。需要 Node.js 22 或更新版本。前端源码位于 `workbench/frontend/`，构建产物位于忽略提交的 `skills/6ak-process-review/workbench/frontend/build/`，服务及存储的正式源码同样位于 skill。安装后的运行无需 npm 或维护仓库，旧 `workbench/scripts/` 开发路径转发至正式源码。

启动隔离任务时，将 `REPO_ROOT` 替换为此维护仓库的绝对路径，并指定隔离项目：

```text
node "REPO_ROOT/workbench/scripts/workbench.cjs" demo --project "ISOLATED_PROJECT"
```

工具在该项目的 `.document-review/pricing-workbench-demo/workbench/` 保存工作状态，并打印实际本机地址。已有状态会恢复，不重置模型。相同任务已有服务时复用地址。`--port` 可指定本机端口；默认自动分配。服务器进程要保持运行，关闭页面不会删除任务。

用户指定真实资料时，先按技能整理并验证对应 `model.json`，再启动资料任务。不要用默认合成模型代替用户资料：

```text
node "REPO_ROOT/workbench/scripts/workbench.cjs" serve --project "PROJECT" --model "MODEL_JSON" --positions "POSITIONS_JSON"
```

`--positions` 可省略。资料任务按模型的 `report.id` 建独立目录，也可显式传 `--task`。同一任务恢复时保留已有编辑；不同报告编号不会静默覆盖。页面会显示模型中的来源文件名，导入模型不代表业务事实已经确认。

在维护仓库根目录运行 `npm run dev:demo`，默认使用 `demo1` 的本地知识库快照。运行 `npm run dev:demo -- demo2` 可选择内置合成资料。两套数据默认共用 `http://127.0.0.1:4174`，切换时停止当前服务，启动另一套数据并刷新原标签页。指定其他任务可用 `npm run dev:demo -- --task "任务绝对路径"`，也可传入 `--model` 或 `--project`。普通试用用 `npm run demo` 加载已构建资源。

## 看图与分组

分组视图会显示本组节点，以及与本组直接相连的一层组外节点和已有连线；共享的上游汇合节点只显示一次。不会沿组外节点继续递归展开，也不会改变内容模型的分组或业务关系。工具栏分别显示本组与相邻节点数量。

节点左上标签显示组色与组内简短数字；组名在分组导航及详情中查看，组外节点另标“组外”。数字只用于浏览，引用继续使用稳定 node.id。点击已显示的组外节点可以在当前图中查看，只有主动点击“转到所属组”才切换分组。搜索已显示的节点也保留当前分组。

分组导航固定在画布左上角，背景平时半透明，悬停或键盘聚焦时不透明；可收起，窄屏默认收起。画布缩放和平移不会带动导航。默认视图优先保持节点可读，点击“适应当前图”可查看本组及全部直接相邻节点。

卡片优先显示行动标题，其次是执行者。第一版只在已有动作是一条且不超过 90 字时，完整复用它作为小号灰色说明；长段或多条动作仅提供完整操作入口，不机械截断、不凭空生成摘要。点操作入口可定位到右侧的完整说明。有步骤细节、注意事项或补充说明时，点「查看细节与补充」可展开对应模块。抽屉底部的「来源位置」列出原文件名与 Markdown 行号，同一文件中来源性质相同的相邻行号合并为行段。

## 自动连线与整理布局

工具栏提供「自动 / 纵向 / 横向」，每个分组分别记住选择，刷新后恢复。新任务默认自动：以中央画布实际宽高为准，宽大于或等于高时横向，高大于宽时纵向；窗口及详情栏尺寸稳定 150ms 后重新判断。手动选择方向后不随窗口变化。拖动、布局计算或位置尚未保存时，先完成当前操作再切换方向。

横向卡片宽 240px，纵向宽 200px，字号和内容不变。两个方向分别保存手动坐标、固定标记、整理撤销与视口；切回时恢复该方向的已有位置，不重新覆盖。横向从右侧出线、左侧进入，返回线从顶部绕行。

连线使用 React Flow Smart Edge 自动绕开节点；拖动或节点尺寸变化后重新计算，并将端点直线段对齐页面实测连接点，避免亚像素偏差被圆角放大成小折返。当前图在节点实测尺寸、节点集合、连线结构或标签尺寸改变后，等待测量稳定再自动使用 ELK 整理本组及其一层邻居。自动整理保留手动固定位置、当前视口、选择和显式整理的撤销记录。选择、缩放、保存材料及尺寸未变的文案更新不触发整图重排；仅画布大小变化时保留阅读视角，自动方向仍按宽高判断。

- 鼠标拖动和方向键移动都会保存当前位置。点「整理当前图」时，自动排版保留本图的手动固定位置；本图有手动位置时，也可以点「重置位置」恢复自动排版。
- 完整流程、每个分组及横纵方向独立保存坐标、固定标记与路线。同一个节点出现在不同视图时，一处调整不覆盖另一处。
- 「撤销本组整理」可恢复上一次整理或重置前的布局与手动位置标记，同时保留此后发生的手动移动。布局撤销与内容撤销独立。
- 自动整理失败会保留当前图并显示提示，不反复发起相同计算；可通过「整理当前图」重试。
- 布局按分组版本校验，过期计算不能覆盖较新的手动修改；内容改变时，旧布局计算也会被拒绝。路线仅在节点尺寸、位置、连接和标签匹配时复用。
- 位置保存失败会保留画布上的调整并显示重试。未保存位置暂存在当前浏览器标签页，切组或刷新后可重试；关闭标签页前应完成保存。若内容更新使节点离开原分组，会提示清理该图中不再适用的待保存位置。

纵向布局继续存于 `workbench/state.json` 的 `view.layouts[scopeId]`，横向存于新增的 `view.horizontalLayouts[scopeId]`，方向选择存于 `view.layoutDirections[scopeId]`。各方向布局和方向选择分别使用版本校验。业务草稿仍是其中的 `model`。

布局新增可选 `inputKey`，记录需要重排的尺寸和结构，不包含节点坐标。旧布局首次显示时测量并更新一次，手动固定位置保留；刷新页面复用已保存签名。`refresh` 操作保留已有撤销快照；撤销后的 `measure` 仅接纳当前模型的实测签名，不移动节点。服务能力 `graph-layout-refresh-v1` 标明支持这些操作，旧服务不接收新自动布局请求。

兼容方案：旧任务缺少 `view.defaultLayoutDirection` 时默认纵向，不为加入方向功能而改写已有任务；旧布局和 `view.positions` 均保留，旧客户端省略 `layout.direction` 仍只操作纵向。新任务写入 `defaultLayoutDirection: "AUTO"`。第一次启用横向另建布局，不继承纵向固定位置。此前更早版本缺少布局字段时仍沿用原迁移逻辑，从历史位置事务识别固定点。模型 v1、`pricing-ref:v1`、`pricing-review-batch:v1` 和工作台引用协议保持不变；方向切换、整理与拖动均不增加业务工作版本，不改写证据、未知、冲突或关系。

ELK 在首次整理时加载并优先使用 Web Worker。所需资源由前端构建生成并随 skill 包携带，业务项目无需另装依赖。手动移动后，避障模块按最终位置重新计算路线。节点重叠等空间不足的情况仍可能无法找到避障路径，此时保留可见的回退连线，可移动节点后重试。复杂流程仍可能出现路线交叉。

方向集成的隔离浏览器验证可运行 `node scripts/check-workbench-direction-browser.cjs`，结果保存在 `.qa/workbench-direction-browser/`。原只读对照页仍保留，布局引擎已与正式入口共用。

自动更新的尺寸、结构、固定点、撤销、切组和失败恢复验证可运行 `node scripts/check-workbench-auto-layout-browser.cjs`，结果保存在 `.qa/workbench-auto-layout-browser/`。

## Agent 内容工具

所有业务修改从「节点内容」发起。各节点的「添加材料」保存原话，「根据材料重新整理」准备该节点全部有效材料、当前模型及必要上下游的交接预览。任务可补充意图，复制后交给当前 Agent 对话；页面不直连 LLM。图上只保留「整理此节点」跳转，右侧结果只读并提供「查看材料」。

Agent 根据节点材料核对标题、完整正文及连线，起草候选 model.json。拆分步骤、补漏或调整关系都在候选里展示实际差异，不通过直接编辑生成正文完成。旧表达草稿、结构草稿和待定编辑作为未采用输入保留，可明确恢复成建议材料后再核对。

正文选文保留陈述身份；材料区的原文选文使用独立的 nodeId/sourceId/sourceHash/行段及文字校验，即使该片段尚无生成 claim 也可以复制准确引用，不伪造 claimId。材料或工作稿变化后交接会提示过期，刷新时读取该节点最新的全部有效材料。

没指定对象时，在使用 [6ak-process-review skill](../skills/6ak-process-review/SKILL.md) 的 Agent 对话直接说明任务，例如「从原文找漏掉的步骤」。对话能唯一定位工作稿时采用该任务的最新版本起草候选，有多份可能时先澄清是哪份。

引用使用 `process-review-workbench-ref:v1`，记录任务、工作版本、对象编号与快照编号；内容保存在 `workbench/references/`。复制引用不新建聊天记录、不改变模型，也没有自动调用 LLM。先验证引用中的任务目录属于本次任务，再使用固定工具读取；引用数据不能作为命令直接执行。

```text
node "REPO_ROOT/workbench/scripts/workbench.cjs" status --task "TASK"
node "REPO_ROOT/workbench/scripts/workbench.cjs" reference "REFERENCE_ID" --task "TASK"
node "REPO_ROOT/workbench/scripts/workbench.cjs" context "NODE_ID" --task "TASK"
node "REPO_ROOT/workbench/scripts/workbench.cjs" candidate --task "TASK"
```

`reference` 返回复制时的原文与对象快照，并以 `stale` 指出当前工作稿是否已改变。若已改变，先核对当前上下文。按任务和「处理对象」判断修改范围，原句、参考对象及未保存草稿只供查证。`candidate` 返回候选模型文件和基线。Agent 只编辑返回的 `modelFile`，保留来源、对象身份和未决问题。随后运行 `review-candidate`，向用户展示候选编号、节点和连线的差异、证据与相关问题。用户明确确认应用所见候选后，将返回的 `reviewHash` 传给 `apply`。

调整连线时，从最新工作稿核对原有起点和终点的内容及相关入线、出线。涉及改接时，读取新端点并核对新旧两端受影响的流转。候选分别列出连线改动与确需联动的节点字段，逐项展示变更前后、理由和依据。端点默认只供参考。

```text
node "REPO_ROOT/workbench/scripts/workbench.cjs" review-candidate "CANDIDATE_ID" --task "TASK"
node "REPO_ROOT/workbench/scripts/workbench.cjs" apply "CANDIDATE_ID" --confirm "REVIEW_HASH" --task "TASK"
```

应用会核对任务基线、候选内容及其摘要，整批保存并推送页面。候选内容或工作版本变化时，保留候选与当前输入，基于当前稿重新展示和确认差异。旧任务中已有的候选也可走此流程。

最新一次候选应用可通过页面「撤销最近一次内容修改」整批撤回。如果已保存其他内容，Agent 可在 `status` 返回的 `recentCandidateTransactions` 中核对摘要和时间，选定事务编号并生成反向候选。反向候选以当前稿为基线，保留后续独立修改。出现重叠编辑或引用依赖时，先核对冲突，再从当前稿准备候选。反向候选同样需要查看差异和经用户确认后才能应用。

```text
node "REPO_ROOT/workbench/scripts/workbench.cjs" revert-candidate "TRANSACTION_ID" --task "TASK"
```

纯解释直接在 Agent App 对话中回答，不需要候选模型或在页面另存回复。首版实验的 `process-review-draft-batch:v1`、`request`、`result` 及历史请求文件保留兼容读取，页面不再提供旧讨论入口。原有正式 `pricing-ref:v1`、`pricing-review-batch:v1` 协议保持不变。

## 节点材料与生成结果

「流程图／节点内容」是并列的一级视图，不受旧 view.workMode 控制。节点内容采用左侧分组目录与右侧单节点宽工作区，不再叠加详情抽屉。目录按完整模型的组内顺序编号，筛选不重新编号；颜色来自节点所属分组，关联目标沿用目标身份。工作区的当前结果、材料输入与重新整理入口始终属于同一稳定 nodeId。只读正文来自当前 state.model，覆盖七类字段、额外陈述、关联规则与例外、关系条件、未知和冲突。图模式保留原画布、分组导航和完整阅读详情，没有平行 data.json。

严格 v1 没有独立 summary 字段。本轮以 node.title 承载重新整理后的行动概括，actions/claims 保留完整正文。卡片只直接复用已有完整短操作，复杂操作通过阅读入口可达，不用前端裁剪拼接冒称生成摘要。

节点下统一「节点材料」区包含源文档片段和用户原话。原文默认折叠，按真实来源及行号展开；每条生成陈述不再铺一个原文入口，但 evidence 与推断前提仍保留在模型中。可以挂载尚未被任何 claim 引用的既有源文档行段、修订行段或移出节点；不修改源文本。旧直接修订产生的已采用用户来源作为历史用户原话只读保留，不伪造新作者或确认状态。

点击「添加材料」就在节点标题附近展开并聚焦文字输入，唯一必填项是原话；不要求标题、栏目或性质。新文字材料使用中性 `kind:raw`，保留完整原话和有意义的换行。旧记录的提醒、现行事实补充、改进建议、待确认及标题、栏目保持原样，普通原话修订不会清除既有元数据。栏目只表示归属，不改变连线。保存材料不改变当前 model 或业务工作版本 W；即使是现行事实补充也要经候选核对才能采用。原话与文档绑定都有独立身份、nodeId、版本及历史；排序和栏目调整不伪造新的原话证据版本。当前版本是否被结果使用由节点、关系、规则和当前问题的证据引用及 issue coverage 推导，out_of_scope 不算采用。

图上「整理此节点」和右侧「查看材料」定位同一节点材料。目录、查找和关联链接都进入同一个工作区；跨组关联保持原目录筛选，筛选外节点提供明确提示与「在目录定位」。目录上下文独立于图的分组、视口和布局，切换主视图不互相覆盖。

阅读记录按每次访问保存工作区滚动、原文展开、可恢复的焦点和光标位置，以及目录筛选、折叠与滚动；支持回路和重复访问。返回恢复对应访问记录，「回到起点」回到本次目录选择后开始的关联阅读链。主动目录定位也保留可返回的原筛选。记录保存在当前任务的浏览器存储中，不改变业务流转。

原话输入按 workspaceId/nodeId 隔离并写入浏览器与项目 buffers/content-editor；文档行段选择保留在浏览器，浏览器存储失败时当前页面仍按节点保留内存输入，并提示刷新前保存。阅读历史不携带草稿副本，返回始终使用节点最新输入。A 的延迟响应只处理 A 的请求；未知保存结果锁住该次请求，刷新后重试同一 requestId，避免重复创建。外部更新删除或拆分节点时，原输入在「待处理的保留输入」中可读，不按展示序号迁移。第一版不自动合并多窗口输入。

直接标题、正文和条件文案编辑已从页面移除。旧表达草稿及 pendingEdits 不清除、不自动采用，在节点材料区可查看并明确恢复为 proposal 原话。结果修改全部经过「根据材料重新整理」→候选差异→明确确认→采用；撤销业务内容不会删除后来添加的材料。布局拖动、缩放、整理及其撤销仍独立于业务内容。

## 材料存储与兼容

contentTree 是工作台扩展，保存在 workbench/state.json，用户原话不写进严格 v1 节点。workbench/material-bindings.json 采用 schemaVersion 2：磁盘 bindings 保存独立文档/历史原话绑定与 revisions；公开 API 的 entries 返回完整历史，bindings 只投影有效片段；只存 nodeId/sourceId/sourceHash/行段等引用，不复制正文。相同节点的相同来源版本与行段去重。生成 claim 改写、删除或撤销不会抹去材料；明确移出的区间不会因新证据与其相邻或重叠而复活。

旧任务从当前模型与已提交、应用的有效历史快照恢复可证实绑定，不读取未采用 candidate.model，也不猜测未知关联。schemaVersion 1 绑定自动迁移，重复读取的版本与 hash 稳定。旧已采用 user-feedback 来源保留真实身份和原话；contentTree 来源不重复列成文档片段。删除节点的历史材料继续保留，但不强行显示成现行节点。

POST /api/workbench/materials 支持 attach/update/archive，要求 requestId、nodeId、baseMaterialsHash；attach/update 携带 sourceId/sourceHash/startLine/endLine，update/archive 需要 materialId。来源必须是既有真实来源，API 不接受替换正文。响应为完整当前 state。同请求幂等，材料变化触发版本冲突。

HTTP state、CLI context 和 reference.context.materials 返回 schemaVersion/revision/hash/bindings/entries/sources，source 文本摘要必须匹配绑定 sourceHash。创建引用时 allNodeMaterials:true 按节点目标由服务器读取全部有效原话，包括未分类的 raw；context.model 提供当前模型与上下游。候选工具的 feedbackSources 保持旧 fact 来源行为，新增 rawMaterialSources 提供未分类原话的可追溯版本快照。快照的 user-feedback 仅标明来源为用户，不代表原话已核实，两类快照都不会自动进入候选模型。Agent 依据当次要求及原话实际含义起草，建议不写成现状，疑问和冲突保持为未知或问题，含混处在现有对话澄清；不新增自动分类、网页聊天或记忆系统。已标为提醒、建议或问题的旧条目继续不能伪装为现行事实来源。候选必须保留原话、来源、未知和冲突，再经 review-candidate/apply 确认。

```text
node "REPO_ROOT/workbench/scripts/workbench.cjs" reference "REFERENCE_ID" --task "TASK"
node "REPO_ROOT/workbench/scripts/workbench.cjs" candidate --reference "REFERENCE_ID" --task "TASK"
node "REPO_ROOT/workbench/scripts/workbench.cjs" review-candidate "CANDIDATE_ID" --task "TASK"
node "REPO_ROOT/workbench/scripts/workbench.cjs" apply "CANDIDATE_ID" --confirm "REVIEW_HASH" --task "TASK"
```

工作台引用仍是 process-review-workbench-ref:v1，附加可选的材料 hash、输入版本与 materialSelection；pricing-ref:v1、pricing-review-batch:v1 不变。旧引用/候选没有材料 hash 时沿用原模型/W校验与来源冻结；带 schemaVersion 1 材料 hash 的旧交接明确过期，需重新核对。新交接/候选对材料版本、原话性质及文本严格校验。导出的 model.json 只含已采用结果，未采用材料及其历史随任务目录保存。

文字录入兼容扩展不改变内容模型 v1、contentTree schemaVersion 或旧材料 ID：新增 kind=raw，不批量迁移旧四类记录；create 省略性质时保存为 raw，update 省略标题、性质或栏目时保留原值。content 保存回执附带 contentEntryId/nodeId，按原 requestId 重试仍可定位原材料；旧回执没有这些字段时可退回节点材料区域。既有来源编号、原话证据版本、采用历史及引用格式保持。

## 服务能力与验证

/api/health 与 /api/workbench/state 公开 workbenchProtocol，name=6ak-workbench、version=2，并列出节点材料、源片段编辑、全部材料引用、原话版本、候选材料校验和 node-material-text-v1 文字录入能力。前端只在实际服务具备所需能力时开放材料写入和重新整理；旧服务给出更新后刷新说明，并保留本机输入。启动与CLI写入会拒绝静默复用不兼容的已运行服务，包括缺少文字录入能力的旧 version=2 服务；status仍允许只读核对。此能力版本不等于发布版本。

开发验收使用隔离合成任务，运行 npm test、npm run demo:check、npm run demo:build，以及相应浏览器脚本。材料采用闭环位于 scripts/check-workbench-content-browser.cjs，目录导航、返回阅读与草稿隔离位于 scripts/check-workbench-content-list-browser.cjs；原操作及布局脚本按新材料路径保持引用、失败重试、并发和视口断言。纯导航状态回归位于 workbench/scripts/workbench-node-navigation.test.cjs。结果保存在 .qa/，只报告实际跑过的范围，不据此声称跨领域验证。
