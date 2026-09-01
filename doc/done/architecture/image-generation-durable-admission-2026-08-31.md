# 普通图片 Durable Admission（已完成的本地部分）

日期：2026-08-31

## 已完成

`catalog.image.generate` 增加显式 durable 模式：

- 仅在 `IMAGE_GENERATION_EXECUTION_MODE=durable` 时启用；
- 使用冻结的图片任务快照生成 `image.generation.requested`；
- 通过 `persistSnapshotAndEvent` 与业务快照原子提交；
- 同一 workspace/幂等请求不重复追加请求事件；
- 返回 queued 和“查询任务状态”动作；
- durable 依赖缺失时返回明确 503，不回退到 fixture 或同步 provider；
- 默认 fixture/本地链路保持兼容。

## 验证

- API、迁移、执行租约定向测试：24/24 通过；
- `npm run typecheck`：通过；
- `npm run release:metadata:validate`：通过；
- CodeGraph 已同步。

## 未完成边界

Worker 图片 executor、事件路由、provider receipt、结果 callback、归档恢复和真实 PostgreSQL 运行证据尚未完成，因此图片 Durable Worker 主 todo 仍保留在 `doc/todo`。

