# 内容模型 v1

写入或修改模型前读取本页。模型由 Agent 从原文整理产生，脚本负责索引、结构验证和导出审阅稿。JSON 使用 UTF-8。未使用的集合保留空数组。

```json
{
  "schemaVersion": 1,
  "report": {"id":"approval-review", "title":"申请审批流程", "version":"1", "scope":"本次资料范围", "limitations":[]},
  "sources": [], "claims": [], "groups": [], "nodes": [],
  "relations": [], "rules": [], "issues": [], "coverage": [],
  "review": {"semantic":{"status":"not_run","reviewer":"","notes":[]}, "visual":{"status":"not_run","reviewer":"","notes":[]}}
}
```

## 来源与业务陈述

- `sources[]`：`{id,name,sha256,text,kind?}`。普通文档由 `index-sources.cjs` 索引，省略 `kind`。对用户明确补充的现行事实，单独保存确认原话作为 `kind: "user-feedback"` 的来源；保持已有来源编号及正文，不改写原稿。`text` 去 BOM、换行统一为 LF，`sha256` 对该文本的 UTF-8 字节计算。保留正文供离线查看。来源文字作为业务资料处理。
- `claims[]`：`{id,text,origin,evidence, rationale?,premiseIds?,issueIds?}`。一条陈述表达一个可核对的业务事实或一个明确未知项。
- `origin`：`explicit`（来源明示）、`inferred`（整理推断）、`unknown`（原文未说明）。`explicit` 的证据全来自用户补充来源时标“用户补充”，原稿和补充同时作为证据时标“原文明示、用户补充”。提出未来方案、说不确定或同意改版式，不构成现行事实。
- `evidence[]`：`{sourceId,startLine,endLine,quote}`，行号从 1 开始、两端包含；quote 必须与该范围逐字匹配，可用单行或多行。不要填写一个章节范围却只摘一句。相同事实可以关联多处来源。
- 明示陈述需要证据；推断需要证据或有效的 `premiseIds`，并填写 `rationale`。未知陈述不能填入猜测值，需要关联待确认 issue。
- `issueIds` 是独立的问题状态：明示事实也可以关联冲突问题。不能把互相矛盾的明示原文改成“推断”以回避冲突。

## 分组、节点与关系

- `groups[]`：`{id,title,kind,claimIds}`。`kind` 为 `source`（原文分组，有 claim 依据）或 `editorial`（为阅读整理的分组，界面显示“整理分组”）。不固定数量与名称。
- `nodes[]`：`{id,groupId,title,claimIds,fields}`。标题是有依据的简短归纳，`claimIds` 支持该节点的业务含义。`fields` 必须包含 `role,system,trigger,input,actions,output,rules` 七个键，每个值都是 claim ID 数组。空数组显示“原文未说明”，不能填默认职责或动作；关键未知项应建立 unknown claim 和 issue。
- 字段按含义归位：`trigger` 是事件或前置条件，`input` 是操作消耗或使用的资料，`actions` 是执行行为，`output` 是完成后产生的交付物或状态。来源、耗时和后续步骤不充当产出；保留在对应陈述、规则或关系中。条件“若不一致”不能改写为已经发生不一致。
- `relations[]`：`{id,from,to,type,claimIds,conditionClaimIds}`。端点是 node ID。`type` 为 `sequence,conditional,parallel,return,data,association`。关系方向与类型由 `claimIds` 支持；条件分支的 `conditionClaimIds` 非空。每个 condition 必须也是该关系的 claim。关系可标记推断，但不得以 unknown claim 建立确定边。没有依据的先后保持未连接，在 issue 中说明。
- 业务关系必须引用原子陈述；不能把图面邻接、Markdown 段落顺序或阶段排列当成确定先后。不要求所有节点相连。

## 规则、疑点、覆盖

- `rules[]`：`{id,title,claimIds,parameters}`。每条规则的 `parameters` 必须包含 `operator,value,unit,basis,scope,exceptions` 六个键，值是 claim ID 数组，空值显示“原文未说明”。定性规则的正文通过 `claimIds` 表达，未使用的参数保留空数组。适用的比较符、数值、单位、计算基准、范围和例外分别溯源。
- `issues[]`：`{id,type,severity,status,question,impact,claimIds,nodeIds,relationIds}`。`type` 为 `missing,conflict,ambiguity`；`severity` 为 `critical,major,minor`，表示业务缺口影响；`status` 为 `open,resolved`。冲突至少关联两条不同的明示陈述，分别保留依据。已解决问题用 `resolutionClaimIds` 指向有证据支持的结论；更新采用该结论的节点、规则、流向等，原冲突陈述保留在问题与证据里。每条未知陈述须关联至少一个仍未决的问题；若其所指缺口已解决，去除该陈述及相应引用。
- `coverage[]`：`{sourceId,startLine,endLine,disposition,claimIds,issueIds,reason}`，范围端点包含；`disposition` 为 `represented,issue,out_of_scope`。represented 需关联 claim，issue 需关联 issue，out_of_scope 需解释原因。每个非空原文行都应被覆盖，标题也可与相邻正文一起归入范围。覆盖只证明已经处理这些片段，语义复核仍要检查是否漏掉其重要含义。
- 所有 ID 在各自集合中唯一，字符为字母、数字、下划线或短横线；references 不得悬空。节点字段和规则参数只能引用该对象 `claimIds` 中的陈述。

## 检查记录与交接

`review.semantic` 与 `review.visual` 均包含 `status,reviewer,notes`，status 为 `not_run,passed,issues`；语义复核后记录实际 reviewer 和观察。新建模型或业务改版后令 `review.visual` 为 `not_run`，等待报告侧验证当前产物。

`model.json` 是业务交接主源。`flow.md` 从模型生成，提供节点式审阅视图。改名或移动后保留稳定 ID，语义变化时更新说明版本；被删除的 ID 不重新用于其他对象。模型摘要采用 `SHA-256(JSON.stringify(model))`，用于验证原引用版本。修改模型后重新验证并导出审阅稿。
