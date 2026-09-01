# Token 用量对账单

> 2026-08-31 真实 relay 探测已取得 text/OCR 的 provider request ID、usage 和 pricing snapshot 成本证据；image、image_edit、video 尚因可计费探测保护未执行，外部账单双边核验仍未完成。

## 2026-08-31 本地对账安全增量

外部 statement 对比现在按 `providerRequestId` 逐笔比较输入、输出和总 token，并单独统计本地重复 request ID；不会再因为总量相互抵消或 Map 覆盖重复记录而误判 `balanced`。差异继续返回 `needs_review`，不触发自动扣费、退款或交付。

验证：API server 与模型结算定向回归 `49/49`、TypeScript 和 `git diff --check` 通过。真实供应商账户账单金额、image/image_edit/video 可计费探测和生产双边核验仍未完成，因此本文继续保持 `TODO / NO-GO`。

## 当前能力

API 通过 MCP 方法 `billing.model-usage.statement`（兼容旧方法
`billing.reconciliation`）返回当前 workspace 的模型用量账单。

```json
{
  "from_at": "2026-08-01T00:00:00Z",
  "to_at": "2026-09-01T00:00:00Z",
  "limit": "100"
}
```

时间范围采用左闭右开 `[from_at, to_at)`。不传时间范围时返回当前 workspace 的全部已记录模型用量。

账单包括：

- 输入、输出和总 token；
- 模态和模型；
- provider 成本与商户应收金额（内部成本仅 finance/platform_ops 可见）；
- settled、pending、manual_attention、waived 状态；
- 按 `actor_id` 的用户/操作者汇总；
- action 与钱包金额核对结果。

用户归属不信任中转站回传字段，而是由模型用量的 `action_id` 关联可信的
`action_ledger.actor_id`。没有 action 关联的记录会归入 `unknown`，并使对账状态变成
`needs_review`。

## 对账状态

| 状态 | 含义 |
| --- | --- |
| `locally_consistent` | 所有记录已结算，用户归属和可核对的钱包金额一致，但尚未完成中转站账户账单核验 |
| `balanced` | 仅在中转站账单覆盖完整且逐笔匹配通过后使用；当前不会返回 |
| `pending` | 存在待补成本或待钱包结算记录 |
| `needs_review` | 存在未知用户、孤立 action 或钱包金额不一致 |

报告中的 `reconciliation_checks` 给出异常计数：

- `unknown_actor_count`：无法从 action ledger 确定消费用户；
- `orphan_action_count`：模型用量引用的 action 不存在；
- `wallet_amount_mismatch_count`：应收金额与钱包实际扣款/差额退款不一致。

金额口径必须区分：

- `provider_cost_cny`：中转站实际成本或价格快照推导成本；
- `customer_charge_cny`：应用按商业倍率计算的应收金额；
- 钱包流水：以分为单位的实际 debit/refund。

## 当前边界

Wormhole 的 New API 提供 `/api/log/self` 用户日志接口，但该接口需要用户会话凭据与用户 ID，模型 API key 不能替代。项目已接入只读适配器：配置 `MODEL_RELAY_LOG_BASE_URL`、`MODEL_RELAY_LOG_USER_TOKEN`、`MODEL_RELAY_LOG_REFRESH_COOKIE` 和 `MODEL_RELAY_LOG_USER_ID` 后，账单接口会分页读取并按 provider request ID、token 总量执行外部核对；短期 access token 失效时会使用刷新会话换取新 token 并重试一次。未配置或核对失败时保持 `externally_unverified`，不会伪造平账。供应商账户发票/金额仍需独立账单证据。

```text
provider usage 回执 → model_usage_ledger → action ledger → billing transactions
```

不是 Wormhole 后台发票与本地账本的双边导入对账。报告将外部状态标记为 `externally_unverified`，不会伪造 `balanced`。接入时应增加 provider log snapshot，并以供应商账户、provider request ID（或双方一致的幂等键）确定性匹配；时间、模型、金额只能用于差异诊断。

## 配置方式

在项目根目录 `.env` 中设置以下变量，然后重建 API 容器：

```dotenv
MODEL_RELAY_LOG_BASE_URL=https://ai.wormholexyz.xyz
MODEL_RELAY_LOG_USER_TOKEN=你的只读用户会话 token
MODEL_RELAY_LOG_REFRESH_COOKIE=new_api_refresh=你的刷新会话值
MODEL_RELAY_LOG_SESSION_FILE=/var/lib/merchant-assets/relay-session.json
MODEL_RELAY_LOG_USER_ID=你的中转站用户 ID
```

`MODEL_RELAY_LOG_USER_TOKEN` 通常是短期凭据；配置刷新 Cookie 后，客户端会在 401 时自动刷新。New API 会轮换刷新 Cookie，因此必须把 `MODEL_RELAY_LOG_SESSION_FILE` 放在权限受限的持久卷中；本地 Compose 默认使用 `merchant-assets` 卷。不要写入账号密码，也不要把 token、刷新 Cookie 或会话文件提交到 Git。配置后运行
`docker compose --env-file .env -f infra/local/docker-compose.yml up -d --build api`，再调用
`billing.model-usage.statement`；若凭据有效，返回中会出现 provider record 数量、匹配数量和 token 差异。
