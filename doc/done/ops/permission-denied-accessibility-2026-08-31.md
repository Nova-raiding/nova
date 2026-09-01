# 运营台权限拒绝状态可访问性补强

## 完成范围

`AccessDeniedResult` 的权限证据区现在使用 `role="alert"` 和 `aria-live="assertive"`，主动播报缺失 capability、当前 scope 与 request ID；返回总览、刷新权限两个恢复动作保持键盘可达。

## 验证证据

- `permissionUx.test.tsx`：6/6 通过，覆盖身份、工作台、范围、只读、拒绝能力与 request ID。
- `npm run typecheck`：通过。
- `npm run build:ops-console`：通过。
- `git diff --check`：通过。
- 完整 Ops Console 回归：67 个测试文件、312/312 通过。

## 边界

本文只归档权限拒绝页的前端可访问性子能力。真实 OIDC 403、request/trace ID 全链路传播、PostgreSQL/RLS 和桌面角色矩阵仍在 [`doc/todo/ops/ops-rbac-ui-design-2026-08-31.md`](../../todo/ops/ops-rbac-ui-design-2026-08-31.md)，不得据此宣称 RBAC 或生产上线完成。
