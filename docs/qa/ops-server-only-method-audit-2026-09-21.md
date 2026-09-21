# Ops server-only 方法审查（2026-09-21）

范围：`ops.feature-flag.*` 五个方法，以及 `ops.platform.store.record.create`。本次只补测试和审计记录，不修改业务逻辑。

## 结论

这些方法保持 server-only 是有意设计，不是遗漏的 Ops Console 页面：功能开关控制面需要 MFA/审批式操作入口；人工店铺登记会扩大商家工作区可用的店铺边界，当前仅允许平台运营通过已认证 API/MCP 调用。`scripts/audit-ops-surface.mjs` 将它们列入显式 `SERVER_ONLY_METHODS`，并要求它们不被误报为“缺少前端调用”。

## 权限与范围证据

| 方法 | 读写 | capability / scope | 关键限制 |
| --- | --- | --- | --- |
| `ops.feature-flags.list` | 读 | `feature_flag.read` / platform | support、platform operator/admin 可读 |
| `ops.feature-flag.events` | 读 | `feature_flag.read` / platform | 只读不可变事件历史 |
| `ops.feature-flag.evaluate` | 读 | `feature_flag.read` / platform policy | 普通租户只能评估自身 identity/workspace；平台读者可指定目标 workspace |
| `ops.feature-flag.upsert` | 写 | `feature_flag.update` / platform | platform operator；reason + idempotency；revision 由仓储校验 |
| `ops.feature-flag.emergency.set` | 写 | `feature_flag.administer` / platform | platform admin；reason + idempotency + MFA；allow/deny 均审计 |
| `ops.platform.store.record.create` | 写 | `store.connection.update` / platform | 仅 platform operator；目标 workspace 必须存在；请求头与参数 workspace 必须一致 |

## 租户隔离和人工店铺语义

- 功能开关的普通租户评估不能读取其他 workspace 或其他 identity；平台读者的跨 workspace 评估属于明确的平台控制面能力。
- 人工店铺登记拒绝 workspace workbench 和商家角色，且拒绝缺字段不是其主要安全边界：完整、合法参数也必须以 `AUTHZ_WORKBENCH_MISMATCH` 拒绝。
- `ops.platform.store.record.create` 只写 credential-free 的 `manually_registered` 记录，不写 token、scope、授权时间或 vault 凭据；官方模式不会把该记录当作已绑定店铺。
- 目标 workspace 不存在返回 `WORKSPACE_NOT_FOUND`；请求头与参数不一致返回 `WORKSPACE_SCOPE_MISMATCH`。

## 审计和隐藏证据

- 功能开关写操作通过授权审计记录 allow/deny；写入必须携带 reason、幂等键，紧急操作另需 MFA。
- 人工店铺登记同时产生平台授权决策审计和 workspace operation audit，后者保留运营 reason、目标账户和 credential-free 状态。
- 五个功能开关方法及人工店铺登记均保持在 merchant `tools/list` 之外；`ops.platform.store.record.create` 也不出现在普通 `platform.store.record.create` 商家方法名下。
- 本次新增的 service 测试覆盖：读/写/紧急角色分离、平台读者与租户读者的 workspace 边界；既有 E2E 覆盖人工店铺登记的权限、租户、审计、商家隐藏和人工模式闭环。

## 当前仍需关注但不在本次修改范围

1. 功能开关 server-only 的审批/MFA 入口目前没有桌面 UI；这是设计约束，不应被当作普通页面缺失，但上线 runbook 必须保留 API/MCP 调用和审计查询路径。
2. 功能开关仓储的多租户保证依赖 platform scope 设计；若未来允许 workspace-scoped flag，应新增持久化层 RLS/范围测试，不能仅放宽 handler 角色。
3. 本审查未改变业务逻辑，也未声称完成真实生产 IdP 或真实平台授权验收。
