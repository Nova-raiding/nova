# MCP 契约、授权策略与 API Dispatch 动态清单

## 完成范围

- 新增动态测试，按当前源码实时读取 MCP 方法、授权策略注册表和 API `case` dispatch。
- 断言三者按完整 method key 集合相等，并调用 `assertMcpMethodPolicyCoverage()` 验证策略注册完整性；不依赖固定方法数量。

## 验证证据

- `npm exec vitest run tests/ops-api-surface.test.ts`：4/4 通过。
- 既有 Ops Console 全量回归：67 个测试文件、312/312 通过。
- CodeGraph：索引状态 `complete`，`pendingRefs=0`，`worktreeMismatch=null`。

## 边界

本文只归档本地契约/策略/路由清单一致性门禁。HTTP policy parity、全量生产 enforcement、真实 OIDC/RLS、decision audit、Worker authorization snapshot 与生产 canary 仍在 [`doc/todo/ops/ops-rbac-acceptance-plan-2026-08-31.md`](../../todo/ops/ops-rbac-acceptance-plan-2026-08-31.md)，不能据此宣称 RBAC 或生产上线完成。
