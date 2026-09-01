# 前端统一授权投影审计

## 结论

已完成前端权限判断源码审计切片。导航、页面、hook 和 action handler 使用 `AuthorizationProjection` 的 capability/scope 结果；raw role 仅用于显示、canonical adapter 或服务端返回结构校验。

## 例外

`apps/ops-console/src/api/opsDomainClients.ts` 中的 `scope.role` 仅校验服务端返回的财务 scope 结构和分页字段，不决定授权、不扩展权限，保留为 schema guard。

## 验证

- 按 RBAC TODO 审计正则扫描，未发现授权型 raw role 判断。
- authorization projection、权限矩阵和权限 UX 定向回归 19/19 通过。
- TypeScript、CodeGraph sync 通过；CodeGraph index complete，`pendingRefs=0`，`worktreeMismatch=null`。

## 边界

该切片不替代真实 OIDC claim 映射、PostgreSQL/RLS、生产浏览器矩阵和 canary 验收。
