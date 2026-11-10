# 6ak-process-review 技能开发

维护可独立安装的 `skills/6ak-process-review/`。技能运行需要的规范、脚本、模板和示例均位于该目录，工具路径相对技能目录解析。用户原稿、业务背景及输出位置由任务传入。

业务项目在 `.agents/skills/6ak-process-review/` 安装有版本记录的副本。修改技能时在本仓库维护源修改并运行 `npm test`。开发时可通过 `node scripts/install.cjs <测试项目根目录>` 安装。发布时递增 `package.json` 的版本，业务项目使用独立安装器选择版本手动更新。

任务历史归业务项目所有。开发验证使用隔离的合成任务，测试结果保存在 `.qa/`。兼容内容模型 v1、已有任务目录以及 `pricing-ref:v1`、`pricing-review-batch:v1` 引用；协议调整需要明确的兼容或迁移方案。

跨领域能力按 `skills/6ak-process-review/evals/procedure.md` 验证。记录实际测过的范围。修改整理规则时同时核对证据、未知及冲突的表达。
