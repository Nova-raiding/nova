# Store Nova 上线续验记录 · 2026-09-15

时间：2026-09-15 12:20 +08:00（owner 合并复验进行中）
范围：ChatGPT 插件/MCP 身份与余额、支付对账、PostgreSQL/RLS、桌面后台、扫描器和发布门禁。

## 判定

**NO-GO。** 当前候选为 `2d1038f6` 合并 `origin/main@cc2fd361` 及后续修复，尚未提交、推送或部署。旧分支、旧共享部署或不可用 artifact 的结果不能作为当前候选验收。

远端后续增量已独立审至固定 `d457fea6`：保留他人交付上传定位改动，不覆盖 UI/CSS；迁移 211 与其真实 PostgreSQL/RLS 门禁仍待整合。当前全量检查仅针对第一合并点，不能作为第二合并点完成证据。

## 本轮已通过

- owner 合并定向测试：12 文件、326 项通过；后续 API/契约/账务组合 8 文件、296 项通过；统一生产 OAuth 门禁 3 文件、65 项通过。
- `npm run test:postgres:isolated`：新建 PostgreSQL 17/Redis，20 文件、21 项通过。插件 bridge 必须返回真实余额 `available_points=500/reserved_points=0/settled_points=0`，没有通过删除数量断言掩盖回归；canonical OAuth 买家、重复回调只入账一次、另一成员订单不可见均通过。
- 当前可用证据：`artifacts/isolated-postgres/run-kbRPAs/run-result.json`、`vitest.json`，run ID `fb321582-360f-461e-93a4-22320862b0f6`。owner 独立复查两个精确容器 ID 均已不存在，`leftRunning=[]`，未触碰共享容器或业务环境。
- owner 独立运行支付对账 probe 通过：`artifacts/payment-reconciliation/run-8WKIz9/run-result.json`，run ID `529605d3-cef3-43ab-96b2-3769e8419862`。真实 API/签名 worker/PG application role/Redis 验证行锁超时 5,059 ms 返回 `attention_required/55P03`、账本不变、恢复只入账一次；四类真实 PG 审计投影故障保留正确支付/退款/释放状态和事务 outbox 事实。源指纹一致、两个精确隔离容器已复查不存在。provider 为独立 localhost stub，真实支付/模型调用均为 0。

## 当前阻断

- 最后一次 owner 支付重跑：`artifacts/payment-reconciliation/run-9UDlfU/run-result.json`，run ID `57ab363a-8874-4cb5-93f7-0742db42f4a8`，通过；行锁仍由 blocker 持有时 5,525 ms 返回原始 `55P03`，源指纹一致，恢复幂等与四类审计投影故障均通过。两个精确 fixture 容器再次独立复查不存在，真实支付/模型调用为 0。该证据不包含尚待合并的迁移 211。

1. 支付对账的历史失败 `artifacts/payment-reconciliation/run-uGyez2/run-result.json` 已保留；修复后 probe 通过，但最终整合后的全量检查尚未完成，不能扩大为真实支付宝闭环已验收。
2. ClamAV daemon、Nginx 上传边界、PG17 迁移镜像和商家浏览器隔离补丁尚待 owner 最终整体验证。此前默认商家测试误连 101 SSH 隧道，已排除出候选验收。
3. 最终候选尚未冻结，全量检查、隔离支付/桌面验收尚未完成；共享 101 仍为旧部署和迁移尾 209，不能代表新源码。
4. 真实 ChatGPT 宿主身份、支付宝小额支付/callback/query/refund、知识库生产跨副本检索、五模态中转成本/错误证据和部署后 canary 仍是独立上线门禁；localhost provider stub 不替代真实支付。

## GO 前的唯一顺序

先修复本轮运行失败并冻结候选，完成同源指纹下的全量检查和隔离验收；再备份/恢复演练数据库、部署迁移 210 与精确镜像并复核版本；最后完成真实 ChatGPT/支付宝/知识库/中转模型 canary 和目标生产 launch preflight。任何一步未通过都保持 NO-GO。
