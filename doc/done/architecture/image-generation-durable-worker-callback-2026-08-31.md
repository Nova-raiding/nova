# 普通图片 Durable Worker 回调与执行租约

## 结论

普通图片生成已完成一条可验证的异步主链路切片：API 在显式 `IMAGE_GENERATION_EXECUTION_MODE=durable` 下写入 `image.generation.requested`，generation Worker 消费事件，通过已配置的模型 Relay 执行，并回调 API 完成候选归档；API 同时校验工作区、事件 ID、意图哈希和执行 owner token。

## 已落地

- `apps/api/src/server.ts`
  - Durable admission 缺少持久化、Outbox 或执行租约配置时 fail-closed。
  - 新增图片结果回调：成功归档、失败落态、重复成功回执幂等返回。
  - 回调显式 hydration 工作区，并校验 `event_id`、`intent_hash`、执行租约状态和 `owner_token`。
  - 成功/失败回执由 API 推进执行租约终态，覆盖回调成功后 Worker 崩溃的收敛窗口。
  - 新增执行租约操作：`claim`、`provider_started`、`completed`、`failed`、`outcome_unknown`。
- `apps/worker/src/main.ts`
  - `image.generation.requested` 路由接入 generation Worker。
  - Relay 调用前抢租约，调用后回执并完成租约结算。
  - 生产环境仍要求 API、Worker token 和 signing secret，不允许绕过 API 门禁。
- `packages/persistence/src/image-generation-execution-repository.ts`
  - 内存与 PostgreSQL 租约仓储、并发/过期接管、provider-started 和终态语义。
- `packages/persistence/src/migrations/092_image_generation_executions.sql`
  - 工作区隔离、RLS、provider request 唯一约束和租约索引。
  - PostgreSQL 过期租约接管要求保持原始 `event_id`，禁止跨事件覆盖执行记录。

## 验证证据

- `npm run typecheck` 通过。
- Worker/API/AI/租约定向测试：73 项通过。
- 迁移与租约测试：21 项通过，PostgreSQL 真实库测试在未配置时跳过。
- `npm run test:release-gates`：311 项通过、6 项跳过。
- CodeGraph 同步后：755 files、11,272 nodes、46,624 edges。
- 本地 Compose 实际迁移到 092；运行角色检查为 `merchant_app superuser=false bypassrls=false`。
- 真实 RLS 探针：事务中 `ws_demo` 可见测试行，切换 `app.workspace_id=ws_other` 后可见 0 行。

## 尚未宣称完成

这份文档只覆盖代码、契约和本地 Compose 数据库/RLS 验证，不等价于生产上线。普通图片执行对账、真实生产 PostgreSQL/RLS、Redis、模型 Relay 用量/成本回执、容器健康、桌面运营后台观察和生产 canary 仍需在真实环境验收；因此全项目生产判断仍为 NO-GO。
