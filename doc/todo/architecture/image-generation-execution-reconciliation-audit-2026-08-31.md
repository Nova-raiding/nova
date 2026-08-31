# 图片生成执行状态机与 reconciliation/outbox 只读架构审计

日期：2026-08-31  
审计角色：资深架构师  
范围：普通图片生成 durable execution、Transactional Outbox、Worker dispatcher、现有 reconciliation 机制  
结论：**执行租约、分页扫描和 Worker 主动 reconciliation 已落地；真实 Provider/生产环境证据仍未闭合，因此生产仍 NO-GO。**

## 1. 审计证据

| 领域 | 当前实现 | 证据 | 判定 |
|---|---|---|---|
| 图片执行状态机 | `available → leased → provider_started → completed/failed/outcome_unknown`；`leased` 可在租约过期后重领，provider 已启动或未知结果不可直接重试 | `packages/persistence/src/image-generation-execution-repository.ts:4-37,63-85` | 状态约束已具备 |
| 跨进程抢占 | Postgres `ON CONFLICT` 只允许相同 `event_id` 的 `available` 或过期 `leased` 被更新；其他事件不能接管原任务 | `packages/persistence/src/image-generation-execution-repository.ts:109-123` | 关键 CAS/事件归属已具备 |
| provider 幂等证据 | execution 保存 `provider_request_id`，数据库建 workspace 范围的唯一索引 | `packages/persistence/src/migrations/092_image_generation_executions.sql:25-28` | 数据字段已具备，真实 provider 查询未接入 |
| Worker 执行顺序 | 先 claim，再标记 `provider_started`，调用 relay，成功走结果 callback；provider 调用异常走失败 callback，callback 不确定时标记 `outcome_unknown` | `apps/worker/src/main.ts:850-886` | 主执行链已具备 |
| Outbox 投递 | dispatcher 恢复 pending、领取 lease、心跳续租；handler 异常可 retry、unknown 或 dead-letter；过期 lease 消息进入 dead-letter，数据库状态等待后续恢复 | `packages/workers/src/durable.ts:127-159,161-220` | 通用机制已具备 |
| 图片 callback | callback 校验 workspace、event、intent hash、owner token 和 `provider_started`，成功归档后将 execution 置 completed；重复成功回执可幂等收敛 | `apps/api/src/server.ts:11903-11926` | 结果落库/回执幂等已具备 |
| 现有 reconciliation | Worker 暴露图片 reconciliation；API 只负责 workspace 约束、终态收敛和证据落库，Provider 查询由 Worker 执行 | `apps/worker/src/main.ts:510-588,1236-1239`；`apps/api/src/server.ts:12161-12189` | 代码链已具备，生产 Provider 证据仍缺 |
| 图片执行扫描接口 | `ImageGenerationExecutionRepository` 提供 workspace-scoped `listPage`，使用稳定游标、扫描水位和 `provider_started/outcome_unknown` 状态过滤 | `packages/persistence/src/image-generation-execution-repository.ts:31-38,124-150`；migration 094 | P0 已实现 |
| 真实外部能力 | 本地 Worker 环境未配置可用的模型 relay API key/image model；没有 provider status 查询证据 | 本轮本地 Compose/readyz 运行证据；`doc/done/architecture/image-generation-execution-postgres-2026-08-31.md` | 生产门禁仍阻断 |

CodeGraph 当前索引：755 files、11,297 nodes、46,669 edges；状态显示 1 个 pending modified file，不能宣称索引 clean。关键调用关系已用 `codegraph status` 与源码行号交叉核对。

## 2. 当前状态机与故障窗口

```text
available
   │ claim（同 event_id，或过期 leased）
   ▼
leased ── lease 丢失/过期 ──► 可重领
   │ mark provider_started(provider_request_id)
   ▼
provider_started
   ├─ provider 明确失败 + callback ─► failed
   ├─ callback 归档并成功落库 ─────► completed
   └─ provider 已发出但结果/回执不确定 ─► outcome_unknown
                                              │
                                              └─ reconcile Worker 定时扫描并查询 Provider；生产 Provider 证据仍缺
```

关键风险不是“重复领取”本身，而是 provider 已经启动后进程、网络或 callback 任一环节失败：当前状态会正确停止自动重试，reconcile Worker 已能读取悬挂记录并查询 Provider，但真实 Provider 状态回读和生产运行证据仍未闭合。因此系统具备代码级安全停机（fail-closed）与对账路径，但尚未形成生产可运营闭环。

## 3. 已落地实现与剩余门禁

### P0：先补扫描契约，不改变 provider 语义

已在 `ImageGenerationExecutionRepository` 增加只读扫描能力：

```ts
list(input: {
  workspaceId: string
  states: Array<'provider_started' | 'outcome_unknown'>
  olderThan?: string
  limit?: number
  cursor?: string
}): Promise<{ items: ImageGenerationExecution[]; nextCursor?: string }>
```

Memory 与 Postgres 实现必须保持 workspace scope；Postgres 使用 `(updated_at, job_id)` 稳定游标和上限，不能把全表扫描放入请求链路。只读列表应返回 `providerRequestId`、`eventId`、更新时间和错误证据，不返回私有图片 URL。

### P0：图片 reconciliation worker/API 内部契约（已实现）

新增 worker-only 的批量 reconcile 入口，建议语义为 `POST /v1/internal/image-generation-executions/reconcile`：

1. Worker 按 workspace 分页读取 `provider_started/outcome_unknown`。
2. API 先读取持久化 job 与 execution，校验同一 workspace、event、intent hash。
3. 若 job 已有已归档 outputs 且 job 为 `succeeded`，只做幂等 `completed` 收敛，不再次调用 provider。
4. 若 job 已是受信任的终态失败，做幂等 `failed` 收敛，并保留原错误/审计证据。
5. 其余状态进入 `manual_attention`/`reconciliation_required`，不得盲目重新生成。

### P1：只有 provider 提供可验证查询时，才允许自动判定未知结果（代码已实现，真实 Provider 待接入）

provider adapter 必须提供真实的 `queryStatus(providerRequestId)`，并保存 request/response 摘要、时间、provider operation id、错误码和成本证据。建议映射：

| Provider 查询结果 | 本地动作 |
|---|---|
| 明确 succeeded 且可获取/验证 artifact | 走与 callback 相同的归档与 completed 事务路径 |
| 明确 failed，且 provider 保证未产出 | failed + 幂等退款/结算补偿 |
| processing/404/timeout/权限错误 | 保持 outcome_unknown，退避后重查或转人工 |
| 结果与本地 intent/hash 不匹配 | 安全拒绝，写安全审计，人工处理 |

没有真实 status API 或 provider request id 时，禁止把 timeout 推断为 failed，也禁止自动重试 provider。

### P1：补观测与运营入口（部分已实现）

至少记录并可按 workspace 查询：`provider_started_age`、`outcome_unknown_count`、`reconciliation_attempts`、最近查询结果、人工接管原因、退款/结算状态。桌面运营后台只提供刷新、查询、人工标记/补偿等受控动作；不提供“未知结果直接重试”按钮。

## 4. 明确边界与不应做的事

- 不把 Redis 队列重放当作图片 reconciliation；Outbox 只负责可靠投递，不能证明 provider 没有执行。
- 不通过再次调用生成接口解决 `outcome_unknown`；这会造成重复生成、重复扣费或重复资产。
- 不用本地 fixture、内存 Map、静态 migration 或 HTTP 200 代替真实 provider 成功证据。
- 不把“execution completed”提前到 provider callback 之前；必须先完成 workspace 校验、intent/hash 校验和 artifact 归档。
- 不把 `provider_started` 的过期 lease 当作可抢占 lease；当前状态机的保护应保持不变。
- 不在本轮审计中修改代码、迁移、UI 或生产配置。

## 5. 验收门槛

完成上述 P0/P1 后，至少需要以下证据才能从 todo 迁移到 done：

1. Memory、Postgres repository 的跨 workspace、分页、并发 CAS 和重复 reconcile 测试。
2. 进程在 provider 已启动后崩溃，重启后 reconciliation 能恢复或安全转人工；不能重复调用 provider。
3. callback 与 reconciliation 并发时只产生一个终态、一次归档、一次计费/退款结果。
4. 真正的 PostgreSQL + RLS + 多副本 Worker 演练，包含 migration 092 已应用的运行证据。
5. 配置真实 relay/provider 后的 request、provider request id、usage、cost、error 和 artifact 归档证据。
6. 桌面运营后台可观察悬挂任务，未知结果下重试动作被关闭；浏览器验收和容器健康检查通过。

## 6. 最终判断

当前适合标记为：**代码链已完成，真实 Provider/生产运行证据未完成，生产 NO-GO**。本地可验证的下一步是接入经批准的 Provider status API 并完成 PostgreSQL + RLS + 多副本演练；在此之前不应把 fixture 或空扫描结果宣称为生产闭环。

## 7. 2026-08-31 实现与验证记录

- CodeGraph 已重新同步：773 files、10,769 nodes、40,218 edges，无 pending refs。
- 定向回归通过：7 个测试文件、111 项测试通过，覆盖 Memory/Postgres 扫描、游标租户隔离、迁移 092/094、Worker 查询/超时/请求 ID 校验、Provider status fail-closed 和 API 契约。
- Merchant Studio 类型检查和 Docker 构建通过；Compose 服务健康。
- 真实本地 worker-only API 调用使用 Bearer token + workspace HMAC 成功返回 `checked=0`、`read_only_provider_policy=true`、证据提交 endpoint；未伪造 Provider 成功记录。
- 仍未迁移到 `doc/done`：真实 Provider request/status/usage/cost/artifact、多副本 PostgreSQL/RLS 演练、callback 与 reconciliation 并发实测、运营台悬挂任务浏览器验收尚未全部闭合。

## 2026-08-31 durable reservation 复核

新增 migration 117 与 execution reservation API，Provider 调用前已形成可持久化 operation key，并传递到 relay 幂等请求头；已存在 reservation 的过期执行不再允许普通 claim 重派，避免把 Provider 已受理但本地回执未落库的窗口误判为可重试。当前仍没有独立 operation 状态表、dispatching fence、真实 Provider query/replay 和跨进程故障注入证据，因此本项只记录为本地实现增量，不改变 `TODO / NO-GO` 判定。

本轮进一步落地 `provider_reserved` 与 `provider_dispatching` 状态，并要求 dispatch fence 在 Provider 外呼前提交；失败/超时可从 dispatching 进入 unknown，旧租约不能普通接管。migration 119 已注册到可执行迁移链，并补齐发布元数据、历史尾部断言和 release-gates 专项测试；该实现仍属于 execution 内的渐进式 fence，不等同于独立 Provider operation 事实源，真实恢复与外部幂等证据仍缺。
# 2026-08-31 实现增量

- 已修复 Worker → API reconciliation evidence 的确定性协议断裂：Worker 现在发送服务端强制要求的 `idempotency_key`，并透传候选中的 `query_attempt`；幂等键由 `job_id/execution_attempt/query_attempt/provider_request_id` 规范化哈希生成，同一 Provider 观测可安全重放，意图变化仍由 API 按幂等冲突拒绝。Worker 定向测试 43/43、TypeScript、`git diff --check`、CodeGraph 通过。
- durable query backoff 已补齐：API 读取任务最新 evidence 并在 `next_attempt_at` 前过滤，Worker 对 processing/unknown 计算有界指数退避并持久化回传；仍未宣称对账闭环完成，真实 Provider 状态回读、生产对象存储/计费证据和多副本并发验收仍在 TODO。

## 2026-09-01 Provider 状态与索引事实复核

- 当前执行状态链已实际扩展为 `leased → provider_reserved → provider_dispatching → provider_started`；`provider_dispatching` 外呼前由 Worker 通过 `begin_provider_dispatch` 持久化，Provider 异常/超时可进入 `outcome_unknown`，已有 reservation 的执行不会被普通 claim 重派。
- migration 119 `image_generation_execution_dispatch_fence.sql` 已注册在 `loadMigrations()`，并已纳入 release metadata、历史尾部断言和 release-gates 专项测试；此前本文件所述“没有 dispatching fence/仍停留在 migration 117”的描述仅为历史记录，不是当前状态。
- CodeGraph 本次复核后为 **861 files / 12,199 nodes / 45,668 edges**，`codegraph status .` 报告 index up to date；该索引证明源码关系可追踪，不证明真实数据库或 Provider 运行成功。
- 当前仍缺：真实 Provider request/status/query/replay 与幂等计数、双副本 PostgreSQL/RLS 并发及崩溃恢复、usage/cost/settlement 唯一关联、正式 ChatGPT Host/OIDC/canary 和桌面浏览器全流程证据。因此本文件继续保持 **TODO / NO-GO**，不迁移到 `doc/done`。

## 2026-09-01 Provider 状态投影事实矩阵

以当前源码和 CodeGraph 为准，投影边界如下：

| 边界 | 当前事实 | 未闭合项 |
|---|---|---|
| Worker/执行仓储 | `provider_reserved` 与 `provider_dispatching` 已进入持久化状态链；Provider 外呼前写入 dispatch fence；unknown 不普通重派 | 真实 Provider 幂等、跨进程崩溃与 PostgreSQL/RLS 并发 |
| REST 详情 | 已返回执行状态、Provider request ID、attempt 和 reconciliation 标记 | 正式宿主与真实数据运行证据 |
| REST 列表 | `publicImageJob` 当前不读取 execution repository，未形成 execution state 列表投影 | 补齐列表 payload 与 API 契约测试 |
| Ops reconciliation queue | 当前只读取 `provider_started/outcome_unknown` | 纳入 `provider_reserved/provider_dispatching` 并验证队列/权限边界 |
| Merchant/Ops UI | 两端字典已覆盖四个真实 Provider 状态；unknown 禁止重复生成 | 列表/队列上游投影、1440px 正式桌面流程 |
| CodeGraph | 统计为 **861 files / 12,199 nodes / 45,672 edges**，但最近 status 报告 `Added: 1 files` 待索引 | 动态 operation 字符串和 pending file 仍需运行态/索引收敛证据 |

因此当前是“状态机与前端字典已落地、列表/队列投影未闭合”，不是完整 reconciliation 上线；本文继续 **TODO / NO-GO**。
