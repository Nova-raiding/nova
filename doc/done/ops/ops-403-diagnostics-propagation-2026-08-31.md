# Ops 403 诊断证据传播

## 完成范围

- 模型层按数据集保留服务端错误的 `requestId`、`traceId`、`code` 和安全 details。
- 受管会话读取失败时，统一权限拒绝页消费真实 `ops.session` 错误证据并展示请求 ID、追踪 ID、决策原因。
- 没有实际错误证据时不生成或伪造 request/trace ID；客户端预判拒绝仍只显示 capability 与 scope。
- 权限证据区使用 `role="alert"` 与 `aria-live="assertive"`，可被辅助技术播报。

## 验证证据

- 权限 UX 与 model helper 回归：2 个测试文件、18/18 通过。
- `npm run typecheck`：通过。
- Ops Console 生产构建：通过。
- `git diff --check`：通过。

## 边界

真实 OIDC 403、网关 request/trace ID 注入、持久 decision audit、RLS 和生产桌面角色矩阵仍在 [`doc/todo/ops/ops-rbac-acceptance-plan-2026-08-31.md`](../../todo/ops/ops-rbac-acceptance-plan-2026-08-31.md)，本文不代表生产 RBAC 完成。
