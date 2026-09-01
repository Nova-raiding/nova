# 普通图片 Worker Handler 契约（局部完成）

日期：2026-08-31

## 已完成

Worker Outbox handler 新增 `imageGenerationRequested` 注入点，可处理 `image.generation.requested` 事件，并复用统一的：

- lease 丢失中止；
- `WorkerFailure` retryable/unknown 语义；
- callback 完成后再确认事件的调用约束。

## 验证

- `apps/worker/src/worker.test.ts` 与图片 Provider 测试：51/51 通过；
- `npm run typecheck`：通过；
- 全量 release gates：309 通过，6 跳过。

## 未完成边界

该契约目前只是 Handler 扩展点，尚未接入普通图片事件路由、执行租约仓储、真实 Provider executor、API 图片 callback 和归档恢复。因此普通图片 Durable Worker todo 仍保留在 `doc/todo`。

