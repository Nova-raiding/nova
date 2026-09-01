# 普通图片执行租约领域模型（已完成的本地部分）

日期：2026-08-31

## 已完成

新增 `ImageGenerationExecutionRepository` 与内存实现，定义普通图片任务的执行边界：

- workspace + job + event 绑定；
- `available → leased → provider_started`；
- provider 启动前允许租约过期接管；
- provider 启动后不允许自动接管；
- `outcome_unknown`、`completed`、`failed` 阻止重复 claim；
- provider request ID、attempt、错误信息和租约信息可追踪。

## 验证

- `packages/persistence/src/image-generation-execution-repository.test.ts`：2/2 通过；
- `npm run typecheck`：通过。

## 未完成边界

当前实现尚未接入 PostgreSQL、Outbox 事件、Worker executor 或图片 callback；因此普通图片 Durable Worker 相关 todo 仍保留在 `doc/todo`。

