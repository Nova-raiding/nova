# Release gate script 唯一性

日期：2026-08-31

## 结论

已修复 `package.json` 中重复定义 `test:release-gates` 的发布门禁漂移。现在只保留包含迁移 083–100 验收的完整命令；新增质量契约测试会从原始 JSON 文本检查该脚本名只能出现一次，避免 JSON 解析静默覆盖旧定义。

## 验证证据

- `npm run test:release-gates -- --run tests/quality-entrypoints.test.ts`：57 个测试文件通过、1 个跳过；323 项通过、6 项跳过。
- `npm run typecheck -- --pretty false`：通过。
- `git diff --check`：通过。

该项只证明仓库与 CI 门禁的确定性，不解除真实 PostgreSQL、平台、支付、模型中转、云资源、正式 ChatGPT 宿主和生产签名证据门禁。
