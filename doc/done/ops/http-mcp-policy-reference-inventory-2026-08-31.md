# HTTP 与 MCP 授权策略引用清单

## 完成范围

- HTTP identity operation 的 `mcpMethod` 现在由测试同时校验当前 `MCP_METHODS` 集合和 `MCP_METHOD_POLICIES` 注册表。
- identity 与 machine HTTP policy 的引用约束、重复 operation、OpenAPI operation 覆盖和精确路径匹配继续受测试保护。
- identity 数量改为从当前 registry 动态计算，避免新增路由后测试静默失真。

## 验证证据

- `http-authz.test.ts` + `authz.test.ts`：17/17 通过。
- `npm run typecheck`：通过。
- `git diff --check`：通过。

## 边界

本文只归档 HTTP/MCP 契约层的静态 parity。运行时逐路由 capability/scope/obligation、真实 OIDC、生产 RLS、审计 sink 和 canary 仍在 [`doc/todo/ops/ops-rbac-acceptance-plan-2026-08-31.md`](../../todo/ops/ops-rbac-acceptance-plan-2026-08-31.md)。
