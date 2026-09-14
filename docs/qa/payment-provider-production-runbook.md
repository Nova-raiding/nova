# 支付宝生产接入与上线门禁

## 目标

只有完成真实 provider checkout、异步回调、查单、退款和对账，并保存可审计回执后，才允许开启 `PAYMENT_MODE=provider`。

## 必需配置

通过 Secret Manager 注入，不要提交到 Git 或聊天记录：

- `ALIPAY_APP_ID`
- `ALIPAY_APP_PRIVATE_KEY` 或 `ALIPAY_APP_PRIVATE_KEY_PATH`
- `ALIPAY_PUBLIC_KEY` 或 `ALIPAY_PUBLIC_KEY_PATH`
- `PAYMENT_GATEWAY_API_KEY`
- `PAYMENT_CALLBACK_SECRET`
- `PAYMENT_PROVIDER_API_KEY`
- `PAYMENT_PROVIDER_MERCHANT_ID`

通过生产 ConfigMap 注入：

- `PAYMENT_MODE=provider`
- `PAYMENT_PROVIDER_ADAPTERS=alipay`
- `PAYMENT_PROVIDER_CHECKOUT_API_URL=https://<payment-host>/v1/checkout`
- `PAYMENT_PROVIDER_QUERY_API_URL=https://<payment-host>/v1/query`
- `PAYMENT_PROVIDER_REFUND_API_URL=https://<payment-host>/v1/refund`
- `PAYMENT_CALLBACK_BASE_URL=https://<merchant-host>/v1`
- `PAYMENT_RECONCILIATION_ENABLED=true`
- `PAYMENT_REFUND_ENABLED=true`

回调地址必须是公网 HTTPS，并且只允许：

- `/v1/billing/callback/alipay`
- `/v1/subscriptions/callback/alipay`

## 上线前验证

1. 运行 `tests/payment-gateway-alipay.test.ts` 和 `apps/api/src/production-readiness.e2e.test.ts`。
2. 在隔离生产等价环境使用真实支付宝沙箱或商户小额金额完成 checkout。
3. 保存订单号哈希、provider 交易号哈希、金额、时间、request/trace id 和回调验签结果。
4. 验证重复回调不会重复到账，金额或 workspace 不匹配会拒绝。
5. 使用 provider query 确认订单状态与本地账务一致。
6. 对同一订单执行退款，确认 provider 状态、本地流水和余额补偿一致。
7. 执行 reconciliation，确认无 pending、unknown 或金额差异记录。

## Fail-closed 条件

任一密钥、HTTPS 地址、provider 响应签名、回调签名、查单结果、退款结果或对账结果缺失时，保持 provider 不可用并返回明确错误；不得降级为本地 fixture 成功。

## 上线证据

上线审批必须附带 checkout、callback、callback replay、query、refund、reconciliation 六类证据。只有六类全部为 pass，且 API、worker、数据库和回调入口健康，才可将支付能力标记为 GO。
