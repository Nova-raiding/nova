# 持久平台权限补充与轮换手册

## 目的

为平台保留至少两名独立、可登录且已获持久授权的管理员，避免单一管理员失效或误撤权导致平台工作台失权。生产启动门禁要求 `AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED=true`；不得为了补角色把它临时改为 `false`。

补充或轮换授权必须走现有运营后台或 MCP 的 `ops.authorization.role.assign`。该入口会使用乐观并发 revision，并在同一数据库事务写入 `platform_role_assignments` 与 append-only `platform_role_assignment_events`。禁止直接改表、运行 seed SQL、复用本地 `API_AUTH_TOKENS`，或临时关闭生产鉴权来补角色。当前角色分配接口只验证执行者，**没有服务端双人批准机制**；第二人复核是独立操作证据，不能伪称为接口强制的批准。

## 前置条件

- 生产保持 `AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED=true` 且 `MCP_AUTHZ_MODE=enforce`。
- 至少两名既有管理员分别通过生产认可的登录方式建立真实平台会话；`ops.session` 返回非空 `identity_id`，且 `effective_permissions` 中的 `authorization.role.manage` 来自有效的 `platform_assignment`，不是单纯的网关或密码账号角色声明。
- 执行者和复核者为不同的 `identity_id`。执行者完成当前策略要求的 MFA；二人均可独立读取角色及平台审计。
- `OPS_DATABASE_URL` 使用受限 `merchant_ops` 数据库角色，授权仓储和审计写入健康。

## 补充与轮换

1. 执行者在运营后台“用户与权限 → 授权治理”输入目标的 `identity_id`，先读取角色列表及 `authorization_revision`。目标须先以本人账号登录并核对其 `ops.session.identity_id`；不要使用邮箱、登录名或网关 subject 代替持久 identity ID。
2. 执行者仅为变更单列出的目标分配批准的 `platform_admin` 或 `security_admin`，填写变更单号和原因，提交时携带刚读取的 `expected_authorization_revision`。revision 冲突时重新读取并复核，不盲目重试。
3. 执行者重新读取目标：确认 assignment 为 active、`authorization_revision` 已递增，并保存 assignment ID、revision、执行者、时间、请求 ID 及审计事件证据。
4. 另一名既有持久授权管理员用自己的独立会话核对目标身份、变更单、角色列表和追加审计事件。复核通过前，不把该目标算作可恢复管理员。现有接口没有不可伪造的第二人签核字段，因此在外部变更单中记录复核人及证据，不把 `reason` 文本当成批准证明。
5. 目标用本人账号新建会话，确认 `ops.session` 的 `canonical_roles` 与 `effective_permissions` 来自 `platform_assignment`，且拥有预期的 `authorization.role.manage`。再确认至少两名不同身份的管理员仍可独立登录和管理角色。

## 切换与回退

生产不得通过切换 `AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED` 回退。完成补充或轮换后，分别验证两名管理员可读取角色；如需验证分配能力，使用经批准的实际变更，不创建虚构测试授权。

如果任一管理员无法建立平台会话，停止后续授权变更，由另一名仍有权限的管理员通过正常入口排查 identity 映射或 assignment。若所有持久管理员均失权，停止操作并走事先批准的事故恢复流程；当前仓库没有经过服务端双人批准的零管理员 bootstrap，不得自行降级鉴权或手写 SQL。

## 明确门禁

- 只有一个管理员身份：不执行补充或轮换。
- assignment 只存在于测试、fixture、seed 或内存仓储：不算生产授权。
- 无 append-only assignment event 或无法关联变更单：不把新授权计入可恢复管理员。
- 使用 `platform_owner`：不执行；当前 canonical contract 明确不支持该角色。
- 无法通过目标真实新会话复验：不把新授权计入可恢复管理员。
- 现存有效管理员少于两名或复核者与执行者相同：停止补充/轮换，先解决恢复能力与独立复核。
