# 工作台反馈改造记录：交互减负与真实资料接入

> [!TIP]
> **状态：✅ 已实现 / 关键交互重塑 (IMPLEMENTED)**  
> **产生日期**：2026-11-13  
> **分支**：`codex/local-workbench-demo`（基于 v0.1.3）  
> **对应代码**：`workbench/frontend/src/main.tsx`、`workbench/scripts/workbench-store.cjs`  
> **核心成果**：全局改浅色；**砍掉网页内嵌讨论框，改为“复制引用”回 Agent App**；将演示数据从合成数据切换为 37 节点真实知识库。

---

## 一、交互重大转向

1. **主题调整**：深色主体改为浅色。画布、节点、编辑区、来源、修改记录、未决问题及提示统一调整为高可读浅色调。
2. **彻底移除网页内嵌讨论框**：删除网页内讨论 tab、意见输入框和回复历史。用户在 Agent App 原有对话沟通。
3. **引入“复制引用”闭环**：保留直接编辑，并提供“复制引用”：选中节点、连线或已保存文字，复制带工作版本的对象引用，在 Agent App 粘贴并说明问题。复制引用不生成聊天请求，也不改变业务模型。
4. **切换真实资料模型**：把 4313 预览由合成资料切换为用户指定 `knowledge_base` 的资料模型。旧合成任务仍保留，真实资料任务独立保存。

---

## 二、真实取材与模型构成

* **取材根目录**：`D:\workspace\pricing_process_review\knowledge_base`
* **取材来源**：
  * 主流程取自 `pricing_process_sop.md`；
  * 职责和规则取自 `sales_organization_and_rules.md`；
  * 链路边界交叉核对 `platform_confirm_checklist.md`；
  * 其余来源为 `pricing_risk_review.md`、`special_platform_interview_guide.md`、`README.md`，以及 archive 下两份 2026-11-11 核验记录。
  * 8 个来源全文与摘要核对一致。整改建议、访谈问题、历史预填不作为已实施现状。
* **模型规模**：6 组、37 节点、51 条关系、13 条规则、20 个未决问题。
  * 覆盖需求与底价、算价与配额、通道校验与审批、平台生效与出单、通途拉单与巡检、告警与履约处置。
  * 平台工具成功与前台生效分开；组织折扣权限与领星系统阈值分开；单人豁免保留待核；正常本地仓储履约限定自发货，不把 FBA 画入该路径。

---

## 三、文件组织

相对测试 worktree 路径：
* `.qa/pricing-knowledge-import/model.json`：初始资料模型
* `.qa/pricing-knowledge-import/flow.md`：同版流程文稿
* `.qa/pricing-knowledge-import/positions.json`：初始布局
* `.qa/pricing-knowledge-import/content-review.md`：逐文件取材与业务复核记录
* `.qa/pricing-knowledge-project/.document-review/amazon-pricing-knowledge-workbench/workbench/state.json`：当前可编辑工作状态

页面保存后的模型以 `workbench/state.json` 中的 model 为准，顶部“导出模型”下载当前稿。原知识库文件、业务项目安装副本及其审阅历史均未改写，也没有发布新技能版本。
