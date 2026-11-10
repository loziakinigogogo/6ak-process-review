# 6ak Process Review

将分散的 Markdown 整理成可追溯的流程草稿，在本地网页审阅并保存批注，再由当前 Agent 对话核对和修订，交付同版 `flow.md` 和 `model.json`。

## 安装到业务项目

需要 Node.js 22 或更新版本。从 [GitHub 发布页](https://github.com/loziakinigogogo/6ak-process-review/releases) 下载独立的 `install.cjs`，保存到业务项目的 `scripts/update-6ak-process-review.cjs`。发布包读取使用 Windows 自带的 `tar.exe`，macOS 和 Linux 使用 `unzip`。

在业务项目根目录手动安装或更新到指定版本：

```powershell
node scripts/update-6ak-process-review.cjs --version 0.1.3
```

离线安装时，从可信来源取得同版 ZIP，再指定本地文件路径：

```powershell
node scripts/update-6ak-process-review.cjs --from ./6ak-process-review-v0.1.3.zip
```

安装位置为业务项目的 `.agents/skills/6ak-process-review/`。`.installation.json` 保存版本、来源和逐文件摘要。在线更新验证 GitHub 提供的包大小和 SHA-256；相同安装内容和来源返回 `unchanged`。发现安装副本有本地修改或额外文件时停止，成功更新会保留旧副本。项目内 `AGENTS.md` 可指向安装后的 `SKILL.md`，并说明业务资料的适用范围。

维护者可以从本地检出直接安装到测试项目：

```powershell
node scripts/install.cjs <业务项目根目录>
```

## 使用

在 Agent 对话里提供原稿与任务范围。按需补充术语、组织规则、现行 SOP 和评审资料，并说明各自的用途及生效范围。材料读取、证据使用与冲突处理见[整理方法](skills/6ak-process-review/references/normalization.md)。

技能运行入口见 [SKILL.md](skills/6ak-process-review/SKILL.md)。审阅记录写入业务项目的 `.document-review/<项目编号>/`，已有任务通过 `status` 恢复，通过 `draft → check → commit` 发布修订。交付文件复制到用户指定或项目约定的位置，默认使用 `deliverables/<项目编号>/v<版本>/`。网页、批注与交付见[审阅工作区](skills/6ak-process-review/references/grouped-review.md)。

`model.json` 使用[内容模型 v1](skills/6ak-process-review/references/model-contract.md)。同版文字稿由模型生成。兼容的报告生成工具可直接读取交付副本中的模型，当前调价项目中的 Skill A 是一个接入方。

## 开发和验证

```powershell
npm test
```

测试覆盖证据、来源更新、引用、批注、版本提交、工作区及项目安装。浏览器和报告生成的联调可在使用方的隔离任务中完成。包内开发示例目前以调价为主，跨领域语义质量需要按[评估程序](skills/6ak-process-review/evals/procedure.md)另行验证。

维护源位于 `skills/6ak-process-review/`，安装工具位于 `scripts/`。升级时递增 `package.json` 的版本，检查旧任务、旧引用和模型交付的兼容性。运行 `npm run pack:skill -- dist` 构建本地发布包，macOS 和 Linux 打包需要 `zip`。推送与包版本一致的 `v<版本>` 标签后，GitHub Actions 重新测试、打包并发布 ZIP 和独立安装器。业务项目按需执行更新命令。
