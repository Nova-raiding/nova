# MCP 发布写入 readiness 门禁（2026-08-30）

## 完成范围

- 修复 MCP `publish.confirm` 与 REST `/v1/publish-jobs` 生产行为不一致的问题。
- 生产环境在 MCP 发布确认阶段复用 `platformWriteReady(platform)`。
- 平台写入能力未通过时，在钱包访问、任务槽预留、发布任务创建和事件持久化之前返回 `PLATFORM_WRITE_NOT_READY`。
- 发布失败时不会产生发布任务或扣款副作用。

## 代码证据

- `apps/api/src/server.ts`
- `apps/api/src/security.e2e.test.ts`

## 验证证据

- `security.e2e.test.ts`：46 项通过。
- REST/MCP/API/MCP surface/平台能力定向回归：4 个文件、110 项通过。
- TypeScript 类型检查：通过。
- 发布门禁：48 个文件通过、309 项通过、6 项跳过。
- `git diff --check`：通过。

## 未宣称事项

该修复只证明服务端 fail-closed 逻辑和本地回归成立，不代表六个平台真实 OAuth、写入、回读、撤权、平台 canary 或生产宿主验收已经完成；这些仍由 release todo 门禁控制。
