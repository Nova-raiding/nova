# platform_ops 客户数据最小权限

状态：已接入 API 默认拒绝，2026-08-29。  
范围：客户商品、素材、内容、任务、店铺及其营销工作流数据。

## 默认策略

`platform_ops` 是平台控制面角色，不等于客户工作区营销成员。strict auth 下，平台运营访问以下 MCP/API 路由默认拒绝：

- `brand.*`、`brand-unit.*`
- `catalog.*`、`asset.*`、`content.*`、`deliverable.*`
- `feedback.*`、`knowledge.*`、`multimodal.*`
- `task.*`、`publish.*`、`sync.*`
- `platform.store.list`（客户店铺清单）；`platform.connect`、`platform.revoke` 和 `platform.store.alias.set` 属于平台账户生命周期管理，不返回商品/素材/内容，仍按平台账户管理权限与工作区作用域校验

控制面 `ops.*` 路由仍按各自的 `requireOperationsRole`、finance/support/incident 权限工作；`ops.marketing.*` 已经使用 `requireWorkspaceDataRole`，不授予 `platform_ops` 客户营销数据权限。

证据：`apps/api/src/server.ts` 的 `CUSTOMER_DATA_METHOD_PREFIXES`、`isCustomerDataMethod`、`enforceCustomerDataAccess` 和 `routeMcp` 入口门禁。

## 显式临时授权

只有受信任的身份/支持系统签发的 HMAC 票据才能临时放行。请求使用：

```text
X-Ops-Customer-Access-Grant: v1.<base64url-json>.<base64url-hmac>
```

payload 必须包含：

```json
{
  "grant_id": "grant_123456",
  "actor_id": "ops_1",
  "workspace_id": "ws_1",
  "scopes": ["customer_data.read"],
  "issued_at": 1800000000,
  "expires_at": 1800000300
}
```

校验要求：

- HMAC secret 由 `OPS_CUSTOMER_ACCESS_SIGNING_SECRET` 提供，不从请求参数读取。
- 票据 actor 必须等于已认证 principal，workspace 必须等于当前请求 workspace。
- 读路由需要 `customer_data.read`；写路由需要 `customer_data.write`；`customer_data.admin` 可覆盖二者。
- 票据不能过期，签发时间允许最多未来 60 秒，生命周期最多 15 分钟。
- 无 secret、缺票据、签名错误、范围不匹配、过期均 fail-closed。
- 票据原文不得写入日志、审计 evidence 或响应。

每次放行都写 `ops.customer_data.access` 审计，记录 actor、workspace、grant_id、方法、读写 scope 和 expiry；不记录 payload 或签名。授权服务应在支持工单/事件批准后签发票据，并在需要时提前撤销签发源或缩短 expiry。API 重启后不会保留任何本地授权状态，过期票据自然失效。

## 测试边界

`apps/api/src/server.test.ts` 覆盖：无票据拒绝、读票据不能写、合法读票据、过期拒绝、合法写票据。测试只使用内存签名材料，不连接真实数据库，不把测试值当作生产授权证据。

生产上线前仍必须由 OIDC/支持系统负责签发 secret 保护的票据，并验证审计事件持久化、撤销传播、时钟同步和 API/worker 不存在绕过 `routeMcp`/`execution-check` 的旁路。
