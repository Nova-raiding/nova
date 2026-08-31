# 图片生成回调与执行租约接口后端审查

审查对象：`apps/api/src/server.ts` 中普通图片 Durable Worker 的结果回调和执行租约接口。

审查原则：以 API 多实例、Worker 重试、PostgreSQL/RLS 和模型调用不可重复为上线边界。

## 结论

当前实现不建议作为生产 GO。鉴权边界、工作区 hydration、请求事件绑定、成功/错误互斥和回调后执行租约收敛已有代码修复；归档对象与业务快照仍是跨资源提交协议，真实 PostgreSQL/RLS、跨进程故障注入和 Provider 证据尚未闭合。

## 发现

### P1：Worker 路由跳过 hydration，回调直接读取 API 进程内投影（已修复，待跨进程证据）

证据：`server.ts:11760` 将 Worker 路由排除在普通 workspace hydration 之外；`server.ts:11889` 随后直接调用 `service.getImageGenerationJob(workspaceId, jobId)`。

影响：当回调落到另一台 API 实例、API 刚重启，或本实例尚未加载任务快照时，真实 durable job 已存在于 PostgreSQL，但进程内 `service` 不可见，回调会返回 `IMAGE_GENERATION_JOB_NOT_FOUND`。这会使 Worker 重试，且不能证明结果已被归档。

最小修复方向：回调入口先按 workspace/job 从 durable business snapshot 恢复并校验版本；成功归档和失败落态都必须基于该恢复后的对象。执行租约接口也要校验任务是否存在，不能只依赖租约表。

### P1：归档、任务快照和候选事件不是一个原子提交（代码已补偿，跨资源原子性仍受限）

证据：`server.ts:11911` 先调用 `archiveGeneratedImages`；`server.ts:11912` 再单独调用可选的 `persistSnapshotAndEvent`。

影响：对象上传、素材快照/事件和内存任务状态可能已成功，但任务快照或候选事件写入失败。重试时 `server.ts:11895-11896` 会把已归档任务当成 `already_completed` 返回，导致 `product.image_candidates_generated` 永远缺失，形成“对象存在但业务事件不可对账”的裂缝。跨实例还可能重复尝试或看不到结果。

当前修复：`persistImageGenerationCompletion` 通过同一 `persistSnapshotAndEvent` 事务写入任务快照和候选事件；重试在 `already_completed` 分支先重放该写入，依赖 outbox `(workspace, aggregate, event_type, sequence)` 唯一约束实现幂等，不再直接跳过缺失事件。对象归档仍不可能与 PostgreSQL 事务真正跨资源原子化，失败必须继续进入对账。

### P1：claim 接口未验证 event_id 属于目标任务（已修复，待真实 PostgreSQL/RLS）

证据：`server.ts:11925-11929` 仅检查 `event_id` 非空后，将调用者提供的 `jobId/eventId` 直接传给 `repository.claim`；这里没有读取 outbox 并确认事件类型为 `image.generation.requested`、aggregate 与 job 一致、intent hash 一致。

影响：持有 Worker 凭据的调用者可以为任意已知任务创建一个绑定到伪造 event id 的租约。PostgreSQL 外键只能约束 job 存在，不能证明 event 是该任务的合法请求事件；这会污染执行审计，并可能让合法事件因同一 job 的租约被占用而进入 BUSY/unknown。

最小修复方向：claim 前在同一 workspace 事务内校验任务快照和请求事件，或者让租约表以真实请求事件的数据库外键/唯一约束承载绑定；拒绝未知 event、错误 event type、错误 aggregate 和 intent mismatch。

### P1：回调成功后、execution=completed 前崩溃时无法自动收敛（已修复，待故障注入）

证据：Worker 在 `apps/worker/src/main.ts:871` 先调用结果回调，随后才在 `:872` 调用执行租约 `completed`；API 回调 `server.ts:11895-11896` 只返回 `already_completed`，不会更新执行租约。

影响：若 API 已归档并返回 200，Worker 在 `completed` 请求前崩溃，重试事件会先执行 claim；执行租约已经是 `provider_started`，repository 会拒绝再次 claim 并报告 provider outcome unknown。由于回调本身不携带/校验 owner token，也不负责完成租约，任务业务状态和执行状态永久分裂。

最小修复方向：让“回调接受结果 + execution terminal completed”具备同一个可重放的 durable 收敛路径；至少应允许持有合法事件绑定的恢复流程把 `provider_started` 收敛到 completed，且不能重新调用 provider。

### P2：错误回执与成功图片同时存在时未拒绝歧义输入（已修复，待完整 schema 矩阵）

证据：`server.ts:11898-11907` 只要 `input.error` 是对象就优先写失败状态；即使同一请求同时带有 `images`，也会静默丢弃图片。

影响：上游协议错误、代理拼接错误或恶意回执可能把成功结果标记为失败，且调用者得到 200 accepted。回执协议应要求 success/error 恰好二选一。

## 最小必要测试矩阵

以下测试是上线前的最低集合；现有 `packages/persistence/src/image-generation-execution-repository.test.ts` 已覆盖内存租约的抢占、provider_started 后禁止 takeover、不同 event 拒绝，但不能替代 API 端到端测试。

| 优先级 | 测试 | 断言 | 运行层级 |
|---|---|---|---|
| P1 | 回调跨实例恢复 | API A 创建 job，API B 只从 PostgreSQL hydration 后接受回调；不依赖 A 的内存 Map | 真实 PostgreSQL + 两进程 |
| P1 | 回调幂等补偿 | 首次归档后模拟 snapshot/event 失败；重复同一回调必须补齐缺失事件，不能只返回 already_completed | 真实 PostgreSQL + 可注入故障 |
| P1 | claim 事件绑定 | 伪造 event、错误 aggregate、错误 event type、错误 intent 均拒绝；合法 event 才能 claim | API HTTP + PostgreSQL/RLS |
| P1 | 回调后崩溃恢复 | 回调已接受、completed 未提交后重试；不再次调用 provider，执行状态最终 completed | Worker/API 故障注入 |
| P1 | 租户隔离 | workspace A 的 token/signature 不能读取或 claim workspace B 的 job；RLS 与 API 返回均验证 | 真实 PostgreSQL/RLS |
| P2 | 回执 schema | `error + images`、空 error、超长 code/message、非字符串 images 均按协议拒绝 | API HTTP |
| P2 | 归档失败收敛 | MIME/签名/大小/下载失败后状态为 reconciliation required，重试不会再次调用 provider | API + 对象存储故障注入 |
| P2 | 并发回调 | 相同事件并发 N 次只产生一组资产、一个候选事件、一个终态 | 两个 API 进程 + PostgreSQL |

## 当前实现与验证记录（2026-08-31）

- CodeGraph 已同步并用于追踪回调、租约、归档和 Worker 调用链。
- `git diff --check` 通过。
- `apps/api/src/server.ts` 已在回调入口 hydration；claim 校验请求事件类型、aggregate 和 intent hash；重复成功回调会补写快照/候选事件并收敛执行租约；`error + images` 会拒绝。
- `apps/api/src/server.test.ts` 增加回调补偿契约断言；既有图片租约、Worker、迁移和 API 定向测试通过。
- 本轮类型检查、品牌权限 E2E、CodeGraph 同步和 Compose 健康检查通过；图片回调/租约/对账定向测试 5 个文件、85 项通过；本地真实 PostgreSQL 执行迁移 092/094/096/097 与 migration integrity release 测试 5 个文件、7 项通过。
- 图片回调的真实双 API 进程、PostgreSQL/RLS 故障注入、对象存储联合恢复和 provider 回执尚未执行。

### 2026-09-01 Provider dispatch 状态事实校正

- 当前源码与迁移契约已进一步落地 `provider_reserved`、`provider_dispatching`；Worker 只有在 `begin_provider_dispatch` 成功提交后才允许外呼 Provider，异常/超时可从 dispatching 进入 `outcome_unknown`。migration 119 已注册并纳入发布契约。
- 本文件早先未包含上述 dispatching 状态的记录属于历史快照，不代表当前实现；真实 PostgreSQL/RLS、多副本故障注入、Provider query/replay/幂等、对象存储和账务关联证据仍缺，结论继续为 **TODO / NO-GO**。

## 2026-08-31 回调协议收紧增量

- 新增 `packages/contracts/src/image-generation-callback.ts`，API 与 Worker 共用严格回调 schema：成功图片与错误互斥、错误必须包含非空 `code/message`、图片引用仅允许 HTTPS 或 image data URI、ID/错误字段有长度与控制字符边界、未知字段拒绝。
- API 接收后再次校验，Worker 发送前校验；图片 Provider status 在失败分支前统一校验 response request ID，避免错误响应绕过任务绑定。
- Worker-only 图片结果、执行租约、reconciliation evidence 和 continuation 路由在读取进程内 service 前执行 workspace hydration，补齐冷 API 副本恢复路径。
- 定向 callback/API/Worker/AI 回归 110 项通过，TypeScript 与差异检查通过。该增量仍不包含真实双 API、PostgreSQL/RLS、Provider、对象存储和故障注入证据，继续保持 `TODO / NO-GO`。

## 上线门禁

上述真实跨进程、PostgreSQL/RLS、归档补偿和 Provider 证据未完成前，文档和功能都应留在 `doc/todo`，不能迁移到 `doc/done`，也不能将普通图片 Durable Worker 标记为生产 ready。

## 2026-08-31 Provider operation reservation 增量

执行租约新增 workspace-scoped 的 `provider_operation_key` 持久字段和 migration 117；Worker 在调用图片 Provider 前先通过 API 预约该 key，AI adapter 将其作为 relay `Idempotency-Key`。Memory/Postgres claim 均禁止带 reservation 的过期 lease 被普通 Worker 接管；旧的无 reservation lease 保留原有接管兼容性。重复 reservation 返回同一 key，终态转换保留该 key。

本地仓储、迁移、AI adapter 定向回归 26/26 通过，根全量回归 397 个测试文件通过、17 个跳过，2629 项通过、35 项跳过；类型检查通过。该增量仍缺真实 Provider 幂等语义、双 Worker/双 API 崩溃恢复、PostgreSQL/RLS 并发和账务唯一关联证据，继续保持 `TODO / NO-GO`。
