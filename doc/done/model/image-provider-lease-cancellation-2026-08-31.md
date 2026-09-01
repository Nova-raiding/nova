# 图片 Provider 租约取消（已完成的本地能力）

日期：2026-08-31

## 已完成

`ImageGenerator.generate` 支持可选的 Worker `AbortSignal`。当 Worker 租约丢失或执行被取消时，relay 请求会被中止；原有 provider 超时、网络中断和响应不确定语义保持为 `MODEL_PROVIDER_OUTCOME_UNKNOWN`，并要求后续对账，不会自动重复调用模型。

## 验证

- `packages/ai/src/image-generator.test.ts`：13/13 通过；
- `npm run typecheck`：通过。

## 边界

该能力只是图片 Worker 的基础设施，不代表普通图片生成已经完成 Durable Outbox、执行租约、结果 callback、归档恢复或真实生产验收。相关主任务继续保留在 `doc/todo`。

