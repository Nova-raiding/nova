# 普通图片执行租约 PostgreSQL 持久化（已完成的本地部分）

日期：2026-08-31

## 已完成

- 新增迁移 092：`image_generation_executions`；
- workspace 强制 RLS；
- `(workspace_id, job_id)` 主键和图片任务外键；
- provider request ID 唯一索引；
- lease/provider_started/unknown/completed/failed 状态约束；
- `PostgresImageGenerationExecutionRepository`；
- 发布元数据与连续迁移链同步到 092。

## 验证

- 迁移、完整性、repository 测试：21/21 通过；
- `npm run typecheck`：通过；
- `npm run release:metadata:validate`：通过；
- CodeGraph 已同步。

## 未完成边界

尚未接入 API admission、`image.generation.requested` Outbox、Worker executor、结果 callback、归档恢复和真实 PostgreSQL 并发运行证据，普通图片生成 todo 仍保留在 `doc/todo`。

