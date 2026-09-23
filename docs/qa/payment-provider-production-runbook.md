# 支付宝生产接入与上线门禁

## 目标

只有完成真实 provider checkout、异步回调、查单、退款和对账，并保存可审计回执后，才允许开启 `PAYMENT_MODE=provider`。

## 必需配置

通过 Secret Manager 注入，不要提交到 Git 或聊天记录：

- `ALIPAY_APP_ID`
- `ALIPAY_APP_PRIVATE_KEY` 或 `ALIPAY_APP_PRIVATE_KEY_PATH`
- `ALIPAY_PUBLIC_KEY` 或 `ALIPAY_PUBLIC_KEY_PATH`
- `PAYMENT_CALLBACK_SECRET`
- `PAYMENT_PROVIDER_API_KEY`
- `PAYMENT_PROVIDER_MERCHANT_ID`

通过生产 ConfigMap 注入：

- `PAYMENT_MODE=provider`
- `PAYMENT_PROVIDER_ADAPTERS=alipay`
- `PAYMENT_PROVIDER_CHECKOUT_API_URL=https://<payment-host>/v1/checkout`
- `PAYMENT_PROVIDER_QUERY_API_URL=https://<payment-host>/v1/query`
- `PAYMENT_PROVIDER_REFUND_QUERY_API_URL=https://<payment-host>/v1/refund/query`
- `PAYMENT_PROVIDER_REFUND_API_URL=https://<payment-host>/v1/refund`
- `PAYMENT_CALLBACK_BASE_URL=https://<merchant-host>/v1`
- `PAYMENT_RECONCILIATION_ENABLED=true`
- `PAYMENT_REFUND_ENABLED=true`
- `PAYMENT_PROTECTED_RECEIPT_HOST_DIR=/var/lib/merchant-release-security/payment-receipts`（示例绝对路径；必须位于 `/var/lib/merchant-release-security/` 下，部署前以网关 UID 100 建立、权限 0700，路径各级均不能经符号链接）

支付网关在支付宝原生 RSA2 验签和内部 API 2xx 响应后，才向该目录以 0600、排他创建模式写一份 `payment-gateway-source-receipt.v1`。收据只包含订单号、交易号、工作区、原生签名及实际验签原文的 SHA-256、分值、时间和回调 HTTP 状态；不保存原始回调、签名、密钥或付款人资料，也不写普通日志。目录未配置或权限不符时不能产生可用收据，写入失败会让支付宝收到失败响应并按其重试语义重新通知。收据本身不等于最终支付证明，必须由受保护签发器与真实 provider 查询、数据库订单和账本记录交叉核对。

同一受保护目录还会保存签名 checkout 参数、支付宝已签名查单响应（仅已付款）及退款提交响应的脱敏来源收据；退款的 `processing` 结果绝不等于退款成功。网关对这些路径仅保存哈希、金额、时间和结果，不保存原始参数、交易号、密钥或付款人资料。收据保留窗口建议为 7 天，至少覆盖证据签发、退款对账及回滚观察期；到期清理须按具体文件先核对证据引用、审批和可恢复性并留审计记录，禁止对整个目录执行盲目递归删除。当前代码尚未实现自动保留清理、回调重放/账本对账来源采集或六阶段最终签发，因此不能据此宣布支付上线门禁通过。

`PAYMENT_PROVIDER_API_KEY` 是 API 调用支付网关与网关校验请求共同使用的服务端 Bearer 密钥，ECS Compose 会把同一个 Secret 注入两端。不要再创建独立的 `PAYMENT_GATEWAY_API_KEY`，否则两个值漂移后所有 checkout/query/refund 都会返回 401。

当前 ECS HTTPS 网关对外暴露支付服务时，四个 provider URL 应为：

- `https://<merchant-host>/payment-gateway/v1/checkout`
- `https://<merchant-host>/payment-gateway/v1/query`
- `https://<merchant-host>/payment-gateway/v1/refund`
- `https://<merchant-host>/payment-gateway/v1/refund/query`

回调地址必须是公网 HTTPS，并且只允许：

- `/v1/billing/callback/alipay`
- `/v1/subscriptions/callback/alipay`

## 上线前验证

1. 运行 `tests/payment-gateway-alipay.test.ts` 和 `apps/api/src/production-readiness.e2e.test.ts`。
2. 在隔离生产等价环境使用真实支付宝沙箱或商户小额金额完成 checkout。
3. 保存订单号哈希、provider 交易号哈希、金额、时间、request/trace id 和回调验签结果。
4. 验证重复回调不会重复到账，金额或 workspace 不匹配会拒绝。
5. 使用 provider query 确认订单状态与本地账务一致。
6. 对同一订单执行退款；只有同步响应包含支付宝 `fund_change=Y` 才可直接关单，否则保留钱包预留。
7. 等待至少 10 秒后执行 reconciliation；只有退款查询返回 `refund_status=REFUND_SUCCESS` 且订单号、退款请求号、金额均匹配，才确认退款成功。
8. 确认无 pending、unknown、金额差异或未释放退款预留。

## Fail-closed 条件

任一密钥、HTTPS 地址、provider 响应签名、回调签名、查单结果、退款结果或对账结果缺失时，保持 provider 不可用并返回明确错误；不得降级为本地 fixture 成功。

## 上线证据

上线审批必须附带 checkout、callback、callback replay、query、refund、reconciliation 六类证据。只有六类全部为 pass，且 API、worker、数据库和回调入口健康，才可将支付能力标记为 GO。

每一步必须保存独立的、受保护目录内的原始回执。对应的 JSON 索引至少包含 `kind=payment`、精确的 `operation`（`checkout`、`callback`、`callback_replay`、`provider_query`、`reconciliation`、`refund`）、`release_id`、`deployment_nonce`、相同的 `order_id_sha256`、金额分值 `amount_fen`、真实 `observed_at`、非空 `provider_request_id`、`simulated=false` 和结果 `outcome`。除 checkout 外还须包含与总证据一致的 `provider_trade_id_sha256`。结果依次为 `created`、`accepted`、`idempotent`、`paid`、`balanced`、`succeeded`。不要把支付宝密钥、完整交易号或支付人资料写入回执。

这些字段与文件哈希只是发布门禁的**一致性校验**，不是支付事实的自动证明。签发人必须从真实网关响应、验签后的回调、订单/账本只读查询和退款查询分别采集原始记录，核对同一订单与金额后，才可签发最终 payment evidence；测试代码中的签名辅助函数、手工填写的 `pass` 或网页截图都不能充当生产签发。当前仓库仅有部分受保护来源采集，没有完整六阶段生产采集和签发器；在其安装并运行、六份真实回执齐备前，该门禁保持 NO-GO。

### 受控采证顺序（不允许脚本代替付款人或审批人）

1. 发布 owner 在独立的小额真实商家工作区执行一次真实 `billing.recharge.create`，记录 release/nonce、订单号及金额；从网关 UID 100 私有目录读取对应 `checkout` 来源收据，只记录其 SHA-256 与受保护路径，不将付款链接或凭据写进报告。
2. 付款人通过真实支付宝完成付款。等待网关的 `alipay_native_notify` 来源收据，确认原生验签、API 2xx、相同订单/工作区/金额及 `paid`；受保护签发器必须与订单/账本只读记录关联，不能仅凭回调 HTTP 200 判定到账。
3. 在相同原生回调体的授权重放窗口内由 owner 控制一次重放；必须保存 API 的实际幂等响应和重放前后账本交易计数，不得把另一份网关 callback 收据直接写作 `idempotent`。
4. 通过 API 的真实 provider query 对同单查单。核对网关 `provider_query` 来源收据、支付宝交易号哈希、金额和订单已付款状态；若签名、金额或订单不匹配即停止。
5. 由独立授权人批准并发起同单真实退款。网关 `refund` 来源收据只能证明提交结果；`processing` 必须保持未完成。等待至少 10 秒，经 provider refund query 返回匹配订单、退款请求号、金额且 `REFUND_SUCCESS` 后，再以账本只读查询核对唯一退款/预留释放状态。
6. 最后执行已授权的 reconciliation，保存真实 provider 查询与数据库账本前后状态、租户边界和审计 ID。只有无 pending/unknown/金额差异，且六阶段各自的来源收据/数据库记录均与同一订单相符，才允许离线受保护签发器生成最终 Ed25519 证据。当前缺少第 3、5、6 步的受保护自动采集及最终签发器，生产门禁仍为 NO-GO；不得手填 `pass` JSON 或使用本地 fixture 替代。

`billing.recharge.create` 的一分测试只覆盖钱包充值，且要求专用工作区、`PAYMENT_ONE_FEN_TEST_ENABLED=true`、匹配的 `PAYMENT_ONE_FEN_TEST_WORKSPACE_ID` 和 `real-pay-test-` 幂等键。套餐购买走 `subscription.order.create`，必须另外核对真实 SKU、金额、签名回调与生效后的权益，不得用充值回执声称套餐购买已验收。不要为了采证而开启全局一分支付或绕过最低金额限制。
