# 0.1.4 工作台开发基线整合说明

> [!IMPORTANT]
> **状态：🏁 当前代码基线说明 (CURRENT INTEGRATION BASELINE)**  
> **产生日期**：2026-11-13  
> **提交节点**：`341dd84` Merge standalone workbench as v0.1.4 development foundation  
> **核心成果**：将 `local-workbench-demo` 源码与测试正式合入根目录 `workbench/`，确立 `0.1.4-dev.0` 开发基线，通过 136 项完整回归。

---

## 一、整合目的与边界

将 `local-workbench-demo` 的源码、测试和研究记录合入当前仓库，继续打磨 UI。工作台暂不接入可安装 skill，不发布版本，不更新业务项目安装副本。

### 代码边界
* `workbench/frontend/`：保存 React Flow、Vite、自动避障和 ELK 前端源码。
* `workbench/scripts/`：保存本地服务、内容存储、引用协议、合成模型和测试。
* `workbench/README.md`：保存独立工作台的开发与使用说明。
* `scripts/check-workbench*.cjs`：保存浏览器回归测试入口。
* 独立工作台标记为 `0.1.4-dev.0`，根 `package.json` 保持现有 skill 发布版本 `0.1.3`。
* 正式 `skills/6ak-process-review/` 内容恢复为整合前的状态。工作台单向复用其中的模型校验和文字稿导出工具；skill 不依赖 `workbench/`，安装和打包不包含工作台。
* 前端构建产物、node_modules、演示任务及测试截图不入 Git；源码、锁文件、测试、说明和研究记录纳入版本管理。

---

## 二、数据与任务路径

* 旧演示任务中已有修改事务和引用快照；引用绑定任务绝对路径，浏览器缓存身份也来自路径。此次不改动任务路径和历史内容。
* 清理 demo worktree 的 Git 登记、源码副本及临时分支，保留原路径下的 `.qa/` 数据。原 `.qa/worktrees/local-workbench-demo/` 随后仅是历史数据容器，不再是 Git worktree。
* 继续试用的任务路径：  
  `D:/workspace/6ak-process-review/.qa/worktrees/local-workbench-demo/.qa/pricing-knowledge-project/.document-review/amazon-pricing-knowledge-workbench`
* 新服务从当前仓库 `workbench/scripts/workbench.cjs` 启动，仍使用 `127.0.0.1:4313`。

---

## 三、验证结果

* 主目录 `npm test`：**136/136 全部通过**；`demo:check`、`demo:build` 通过。
* 三项浏览器回归测试合计 38/38 全部通过：
  * `.qa/workbench-browser/run-1794542596922/summary.json`
  * `.qa/workbench-layout-browser/run-1794542599623/summary.json`
  * `.qa/workbench-initial-layout-browser/run-1794542599579/summary.json`
* 独立 Vite 开发入口已启动验证，health 版本为 `0.1.4-dev.0`。
* 正式 skill 文件清单和本地验证 ZIP 的逐文件摘要均与整合前完全一致。
