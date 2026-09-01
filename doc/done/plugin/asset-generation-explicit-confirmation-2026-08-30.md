# 素材图片生成显式确认门禁（2026-08-30）

## 完成范围

- 素材安全扫描和权益检查通过后，图片续跑进入 `awaiting_confirmation`，不再直接进入可执行状态。
- 新增 MCP `asset.generation.confirm`；只有商家确认后才持久化 `asset.generation_continuations.ready` 事件。
- Worker 忽略确认等待事件，只消费确认后产生的 `ready` 事件，因此不会在商家确认前调用图片模型。
- 同步更新 MCP 契约、bridge、Marketplace 镜像、Worker 事件白名单和发布工具数量。

## 代码证据

- `packages/application/src/service.ts`
- `packages/contracts/src/mcp.ts`
- `apps/api/src/server.ts`
- `apps/worker/src/handler.ts`
- `apps/worker/src/main.ts`
- `apps/plugin/mcp/bridge.mjs`

## 验证证据

- 素材扫描 Worker、MCP bridge、Worker handler、MCP 契约和插件清单：5 个文件、103 项通过。
- 发布工具数量更新为 147，MCP 契约方法数量更新为 227。

## 未宣称事项

该修复证明本地服务端、Worker 和 MCP 的显式确认边界成立，不代表真实图片模型、真实 Codex App 附件入口或生产平台能力已经验收。
