# 模型用量自动结算 Worker 闭环

日期：2026-08-31

## 已完成范围

本条只证明应用内的自动结算闭环，不代表已完成中转站外部账单对账或生产上线：

```text
reconcile worker
  → signed POST /v1/internal/model-usage/reconciliation
  → workspace-scoped claim lease
  → settle / retry / manual_attention
  → durable model usage + action ledger + operation audit
```

- MCP `billing.model-usage.reconciliation.run` 与 worker 入口共用 `runModelUsageReconciliation`。
- REST 入口只接受 worker token、workspace header 和 worker workspace signature。
- 每个 workspace 独立执行；单 workspace 失败记录为该 workspace 的失败，不阻塞其他 workspace。
- claim 使用租约和 revision；重复运行不会重复结算钱包或模型用量。
- 成本缺失、钱包结算失败和达到重试上限仍保持 `pending_cost`、`pending_wallet` 或 `manual_attention`，不会伪造成功。
- worker 通过 `MODEL_USAGE_RECONCILIATION_INTERVAL_MS` 配置调度周期，默认 5 分钟。

## 验证证据

- `npm run typecheck` 通过。
- `npx vitest run apps/worker/src/worker.test.ts apps/api/src/server.test.ts apps/api/src/model-usage-settlement.test.ts --no-file-parallelism`：3 个测试文件、68 个测试通过。
- 全量 release gates：48 个测试文件通过、1 个跳过；309 个测试通过、6 个跳过。
- CodeGraph 已同步当前变更。

## 未完成边界

以下仍保留在 todo，不得由本条文档推断为完成：

- 真实中转站用户日志/供应商发票的双边完整对账；
- 真实 PostgreSQL 无跳过迁移验收；
- 生产 API、Redis、密钥管理和告警配置；
- 真实 ChatGPT 宿主、平台 OAuth、支付、对象存储和容量 canary。

