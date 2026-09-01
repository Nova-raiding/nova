# 权限矩阵动态覆盖

## 结论

已完成权限矩阵前端测试覆盖的本地切片。域测试遍历实时 `domainReadCapabilities`，角色 fail-closed 测试遍历 contracts 的 `CANONICAL_ROLES`，避免新增域或角色后继续通过旧硬编码测试。

## 验证

- authorization projection、PermissionMatrix、权限 UX 定向回归：19/19 通过。
- managed session 缺失服务端 projection 时，所有 canonical role 均 deny-all。
- 显式 deny 优先级、13 个当前域的读取投影均有覆盖。
- TypeScript、diff check、CodeGraph sync 通过；CodeGraph index complete，`pendingRefs=0`，`worktreeMismatch=null`。

## 边界

该文档只证明前端 projection 与测试动态覆盖，不证明真实 OIDC、多角色生产数据库/RLS、浏览器全尺寸可访问性和 production canary；整体上线结论仍由 RBAC TODO 验收计划控制。
