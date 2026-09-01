# 商家首次引导六步服务端投影基线（2026-08-30）

## 已完成范围

- 服务端普通 `merchant.start` 与 `workspace.health` 共享 `onboarding_v2` 投影。
- 引导步骤明确为：工作区、连接店铺、选择商品、补充素材、生成并审核、发布。
- 每一步由服务端返回摘要、状态、入口方法和唯一 `primary_action`。
- bridge 优先消费 `onboarding_v2.current_step`，不再从旧 action 卡片猜测主入口；旧字段仍保留兼容。
- 普通引导仍为读取状态；显式目标请求继续保留已有 `merchant_intent` 幂等语义。

## 代码证据

- `apps/api/src/server.ts`
- `apps/api/src/server.e2e.test.ts`
- `apps/plugin/mcp/bridge.mjs`
- `apps/plugin/mcp/merchant-conversation-flow.test.ts`
- `.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs`

## 验证证据

- API、bridge、Marketplace bridge 和 MCP contract 定向回归：4 个文件、112 项通过。
- TypeScript 类型检查：通过。
- Merchant Studio 生产构建：通过。
- Ops Console 生产构建：通过。
- CodeGraph 同步后：750 文件、11,172 节点、46,294 条边；共享工作树仍有并行修改，索引存在 1 个待同步文件。
- `git diff --check`：通过。

## 后续仍在 todo

首次引导总 P0 尚未完成：显式附件路径的自动扫描后生成语义、完整六场景 API/bridge parity、多店铺消歧、结构化 blocker 以及真实 ChatGPT 桌面宿主证据仍需继续验收；本文件不替代原 todo 文档。
