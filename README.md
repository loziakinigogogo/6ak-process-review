# 6ak Process Review

将分散的 Markdown 整理成可追溯的流程草稿，在本地网页审阅并保存批注，再由当前 Agent 对话核对和修订，交付同版 `flow.md` 和 `model.json`。

## 安装到业务项目

需要 Node.js 22 或更新版本。从 [GitHub 发布页](https://github.com/loziakinigogogo/6ak-process-review/releases) 下载独立的 `install.cjs`，保存到业务项目的 `scripts/update-6ak-process-review.cjs`。发布包读取使用 Windows 自带的 `tar.exe`，macOS 和 Linux 使用 `unzip`。

在业务项目根目录手动安装或更新到指定版本：

```powershell
node scripts/update-6ak-process-review.cjs --version 0.1.4
```

离线安装时，从可信来源取得同版 ZIP，再指定本地文件路径：

```powershell
node scripts/update-6ak-process-review.cjs --from ./6ak-process-review-v0.1.4.zip
```

安装位置为业务项目的 `.agents/skills/6ak-process-review/`。`.installation.json` 保存版本、来源和逐文件摘要。在线更新验证 GitHub 提供的包大小和 SHA-256；相同安装内容和来源返回 `unchanged`。发现安装副本有本地修改或额外文件时停止，成功更新会保留旧副本。项目内 `AGENTS.md` 可指向安装后的 `SKILL.md`，并说明业务资料的适用范围。

维护者可以从本地检出直接安装到测试项目：

```powershell
node scripts/install.cjs <业务项目根目录>
```

## 使用

在 Agent 对话里提供原稿与任务范围。按需补充术语、组织规则、现行 SOP 和评审资料，并说明各自的用途及生效范围。材料读取、证据使用与冲突处理见[整理方法](skills/6ak-process-review/references/normalization.md)。

技能运行入口见 [SKILL.md](skills/6ak-process-review/SKILL.md)。0.1.4 将流程工作台纳入安装包，包含本地服务和已构建页面，业务项目只需 Node.js，无需安装前端依赖。新任务通过「流程图／节点内容」阅读已整理的模型，把原文和补充挂到节点，再由当前 Agent 对话起草、核对并采用候选。任务保存在业务项目的 `.document-review/<项目编号>/`，完整操作见[工作台使用](skills/6ak-process-review/references/workbench.md)。

```powershell
node .agents/skills/6ak-process-review/workbench/scripts/workbench.cjs serve --project . --model ./model.json
# 恢复已存在的工作台任务
node .agents/skills/6ak-process-review/workbench/scripts/workbench.cjs serve --task ./.document-review/<项目编号>
```

旧版受管批注任务继续通过 `status` 和 `draft → check → commit` 恢复，见[旧审阅工作区](skills/6ak-process-review/references/grouped-review.md)。两种任务不会因安装更新而互相转换。交付同版 `model.json` 和从它生成的 `flow.md`，位置按用户要求或项目约定。

`model.json` 使用[内容模型 v1](skills/6ak-process-review/references/model-contract.md)。同版文字稿由模型生成。兼容的报告生成工具可直接读取交付副本中的模型，当前调价项目中的 Skill A 是一个接入方。

## 开发和验证

完整架构方案、技术演进脉络与历史试错复盘见[研发资产索引](docs/README.md)。

### 工作台维护

正式运行时维护在 `skills/6ak-process-review/workbench/`，开发前端与回归测试保留在 [`workbench/`](workbench/README.md)，旧开发命令使用薄入口调用同一运行时。流程图与节点目录读取同一模型；修改通过节点材料和候选采用完成。节点尺寸或连线结构变化后自动整理布局，保留手动固定位置、阅读视角和撤销记录。

首次在仓库根目录运行 `npm ci` 安装依赖。用同一个命令选择测试数据：

```powershell
npm run dev:demo          # demo1，冻结的知识库数据
npm run dev:demo -- demo2 # 仓库自带的合成数据
```

两套数据默认共用 [本地工作台地址](http://127.0.0.1:4174)，分别保存预览状态。切换时先在终端按 `Ctrl+C`，再运行另一条命令并刷新同一个标签页。`demo1` 使用本地 `.qa/workbench-fixtures/pricing-knowledge-base-20261113/model.json`。新检出或解压源码 ZIP 后，使用 `npm run dev:demo -- demo2` 加载内置合成资料。

已有任务使用 `npm run dev:demo -- --task "已有任务绝对路径"` 恢复。前端使用 Vite 热更新，保存仍通过本地服务。构建后试用可运行 `npm run demo:build` 和 `npm run demo`；验证命令及资料导入见[工作台说明](workbench/README.md)。

根 `package.json`、锁文件和工作台运行时版本统一为 `0.1.4`。构建产物位于技能内并忽略 Git 提交，由本地构建和发布工作流生成；安装包包含产物和第三方声明，不包含维护仓库依赖、测试脚本或本地业务资料。

### Skill 验证

```powershell
npm ci
npm run demo:check
npm run demo:build
npm test
node scripts/check-installed-workbench-browser.cjs
```

测试覆盖证据、来源更新、引用、批注、版本提交、工作区及项目安装。浏览器和报告生成的联调可在使用方的隔离任务中完成。包内开发示例目前以调价为主，跨领域语义质量需要按[评估程序](skills/6ak-process-review/evals/procedure.md)另行验证。

维护源位于 `skills/6ak-process-review/`，安装工具位于 `scripts/`。升级时同步版本，检查旧任务、旧引用和模型交付的兼容性。完成构建后运行 `npm run pack:skill -- dist` 生成发布包，macOS 和 Linux 打包需要 `zip`。推送与包版本一致的 `v<版本>` 标签后，GitHub Actions 安装开发依赖、构建、测试、打包并验证独立安装页面，随后发布 ZIP 和独立安装器。业务项目按需手动更新。[0.1.4 发布说明](docs/releases/v0.1.4.md)记录兼容范围与操作变化。
