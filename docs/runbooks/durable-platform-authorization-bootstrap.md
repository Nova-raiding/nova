# 持久平台权限首次启用手册

## 目的

在设置 `AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED=true` 前，为真实 OIDC 身份建立至少一个可恢复的平台授权管理员，避免平台工作台因持久角色表为空而全部失权。

初始化必须走现有运营后台或 MCP 的 `ops.authorization.role.assign`。该入口会使用乐观并发 revision，并在同一数据库事务写入 `platform_role_assignments` 与 append-only `platform_role_assignment_events`。禁止直接改表、运行 seed SQL、复用本地 `API_AUTH_TOKENS`，或临时关闭生产鉴权来补角色。

## 前置条件

- 生产仍保持 `AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED=false`，但 `MCP_AUTHZ_MODE=enforce`。
- 真实 OIDC 管理员已成功登录平台工作台，且 `ops.session` 返回非空 `identity_id`。
- 操作者完成 MFA，当前网关角色允许 `authorization.role.manage`。
- `OPS_DATABASE_URL` 使用受限 `merchant_ops` 数据库角色，授权仓储和审计写入健康。

## 初始化

1. 在运营后台“用户与权限 → 授权治理”输入目标的 `identity_id`，先读取角色列表及 `authorization_revision`。不要使用邮箱、登录名或网关 subject 代替持久 identity ID。
2. 给第一位真实管理员授予 `platform_admin`，填写可追溯的变更单号和原因。提交必须携带刚读取的 `expected_authorization_revision`。
3. 给另一位独立身份授予 `security_admin`，同样填写变更单号和原因。两人分离用于账号失效和误撤权恢复。
4. 重新读取两位身份：确认 assignment 为 active、`authorization_revision` 已递增，并记录 assignment ID、revision、操作者、时间及审计事件证据。
5. 分别用两位身份新建会话，确认 `ops.session` 的 `canonical_roles` 与 `effective_permissions` 来自 `platform_assignment`；两者均应包含 `authorization.role.manage`。

## 切换与回退

只有以上证据完整时，才把 `AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED` 改为 `true` 并滚动发布。发布后必须再次验证两位管理员可读取和分配角色，再结束变更窗口。

如果发布后任一管理员无法建立平台会话，应立即回滚本次配置发布至 `false`，排查 identity 映射或 assignment，而不是手写 SQL。修复和复验完成后才能再次开启。

## 明确门禁

- 只有一个管理员身份：不切换。
- assignment 只存在于测试、fixture、seed 或内存仓储：不切换。
- 无 append-only assignment event 或无法关联变更单：不切换。
- 使用 `platform_owner`：不切换；当前 canonical contract 明确不支持该角色。
- 无法通过真实 OIDC 新会话复验：不切换。
