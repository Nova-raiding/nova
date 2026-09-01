# gstack Engineering Review：500 家商家并发增量评审 v1.3

日期：2026-08-22  
评审目标：`PRD-merchant-marketing-codex-final.md` v1.4  
新增范围：500 个不同商家工作区同时在线并可操作；保持 9 名全职、15 个工作日、四个 schema profile 和模块化单体。

## 结论

`DONE_WITH_CONCERNS`：500 家同时在线对该 I/O 型系统可行，不需要微服务或 GPU。v1.2 的单逻辑服务需要升级为无状态 API 多副本、隔离 Worker 池、统一数据库连接预算、租户公平调度和可重复容量测试。15 日仍只在 Day 0 已有等价预发布资源、平台/模型配额和四 profile 门禁时成立；本文是设计评审，不是已经通过 500 并发的运行证据。

## Step 0：Scope Challenge

- 目标不是把 500 家商家变成 500 个同步平台请求，而是让 500 个工作区都能交互、提交操作、收到唯一 job ID，并在配额约束下公平完成。
- 最小完整改动：现有模块化单体保持不拆；API 无状态多副本；同步/生成/发布/对账四类队列和 Worker 隔离；PostgreSQL 前置连接池；增加容量合同、压测和分波上线。
- 不引入 Kafka、自研调度器、多区域双活或 Kubernetes 强依赖。可使用任一托管容器/自动扩缩平台、托管 PostgreSQL、Redis/队列和对象存储。
- 变更触及多个部署组件，但它们是已有逻辑模块的运行形态，不新增业务微服务；复杂度与 500 并发目标匹配。

## 1. Architecture Review

### A1. “500 在线”没有负载语义（P0，confidence 10/10）

证据：v1.2 NFR 只有“20 个试点工作区”，没有会话数、RPS、作业突发和延迟口径。  
修订：v1.3 以 500 活跃工作区、750 连接余量、150 RPS 持续、300 RPS 突发和 500 作业/分钟共同定义容量，不允许只用登录态通过验收。

### A2. 单运行实例会形成入口与会话单点（P0，confidence 9/10）

证据：旧架构图由 Plugin 直接进入单个“MCP 模块化单体”，没有 Edge/LB、无状态约束和最小副本。  
修订：增加托管 DNS/TLS/WAF/L7 LB，MCP/API 最少 3 个无状态副本、最多 12 个；业务状态全部持久化，不使用内存会话或粘性路由。

### A3. 同步、生成和发布共享 Worker 会相互饿死（P0，confidence 9/10）

证据：旧架构把同步发布编排和 Worker 合为一个节点；大店同步或模型慢调用可占满并发。  
修订：使用同步、生成、发布、对账四类隔离队列/Worker；发布确认和 unknown 对账有独立容量；按 workspace/platform/account 公平调度，单租户默认最多占 10%。

### A4. 副本扩容可能先耗尽数据库连接（P0，confidence 9/10）

证据：旧配置只有 `database_pool_size: 30`，没有“副本数 × 每副本连接数”的全局预算。  
修订：HA PostgreSQL 前置连接池代理；50 家试点可使用 API 每副本 20、Worker 每副本 5，目标 500 profile 固定 API 每副本 12、Worker 每副本 3；数据库后端连接总预算不超过 300，80% 使用率告警。

### A5. 自有扩容不能提高平台与模型额度（P0，confidence 10/10）

证据：四 profile 和模型配置原先只有待填写 quota，没有与 500 商家负载绑定的证据。  
修订：平台应用总配额、店铺限制、模型 RPM/TPM/并发成为 Day 0 和 Go/No-Go 门禁；系统承诺可靠接收、排队与反馈，不承诺绕过配额即时完成 500 次外部写入。

Architecture：5 个问题全部回写 PRD、配置和架构图；无未关闭设计决策。

## 2. Code Quality / Contract Review

本节记录评审当时的基线：当时仍是文档项目，没有实现代码、语言栈或测试框架，因此不能据此声称通过代码质量检查。当前实现证据以 `doc/todo/quality/implementation-status.md` 和最新 CI/Compose 结果为准；实现合同仍保留以下约束：

- API handler 无本地会话依赖；每次调用显式携带 `workspace_id / actor_id / request_id / idempotency_key`。
- 长任务只同步完成鉴权、校验、快照与入队；返回 `job_id / state / queue_position / estimated_wait / retry_after`，不占住对话请求等待平台或模型。
- 四类 Worker 共享 job envelope、错误码、trace 和 outbox 语义，不复制四套状态机；只隔离部署、队列和并发预算。
- 缓存键、对象存储路径、队列分区键和数据库查询必须包含 workspace scope；跨工作区结果即 P0。
- 自动扩缩配置、连接预算和队列权重必须版本化并进入发布 manifest，避免软件未变但容量配置漂移。
- 过载路径显式返回可重试状态和预计等待；禁止超时、丢请求或把排队显示成失败。

Code Quality：需求级合同完整；TypeScript build/typecheck、Vitest 单元/E2E 和 Compose 运行态证据已具备。生产级 500 负载、真实平台 canary 和 6 小时云稳定性仍是外部门禁。

## 3. Test Review

当前已具备 Vitest、HTTP/Compose 验收和容量 workload runner；PRD 17.5 和本节仍是实现及上线必须满足的覆盖合同。

```text
代码/运行路径                                      500 商家用户流程
Edge → API 多副本                                  500 会话建立与操作 [→LOAD+E2E]
  ├── 正常路由/健康摘除 [代码+Compose 已测]           ├── 150 RPS 30 分钟 [云上待测]
  ├── 单副本重启/连接恢复 [脚本已具备/云上待测]       └── 300 RPS 60 秒突发 [云上待测]
  └── 身份限流/请求过大 [代码+自动化已测]

API → Outbox → 四类队列                            500 作业同时提交 [→LOAD+E2E]
  ├── 唯一 job/幂等 [代码+自动化已测]                ├── P95 接收 ≤2 秒 [云上待测]
  ├── 队列暂不可用/重建 [代码+Compose 已测]           ├── 不丢失、不重复 [云上待测]
  └── sync/generate/publish/reconcile 隔离 [代码已测]  └── 排队/配额等待可见 [代码已测]

调度 → Worker → 外部依赖                           噪声租户与平台限流 [→LOAD+FAULT]
  ├── workspace 公平/批次上限 [代码+自动化已测]       ├── 其他租户 P95 退化 ≤20% [云上待测]
  ├── 模型/平台 429/timeout [代码+自动化已测]         ├── 状态可恢复，不误报成功 [云上待测]
  └── 同店同商品 lease lock [代码+自动化已测]        └── 重复发布 0 [真实平台待测]

连接池 → HA PostgreSQL/Redis                       6 小时稳定性 [→LOAD+FAULT]
  ├── 300 后端连接预算/池满 [配置+自动化已测]         ├── 无连接或内存泄漏 [云上待测]
  ├── Redis 短故障/outbox 重放 [代码+Compose 已测]     ├── 已接收作业不丢 [云上待测]
  └── API/Worker 滚动重启 [脚本已具备/云上待测]        └── 任务最终收敛 [云上待测]
```

必须新增的实现级测试：

1. 500 虚拟工作区目标负载与 300 RPS 突发。
2. 500 个异步作业在 60 秒内提交，job ID 唯一且 outbox/队列计数一致。
3. 1 个工作区 10 倍流量，大店同步不能饿死其他租户和发布确认。
4. API/四类 Worker 重启、Redis 短故障、数据库池满、模型/平台 429 和 timeout。
5. 6 小时稳定性、内存/连接/队龄趋势与积压收敛。
6. 至少 50 个随机工作区的数据、缓存、日志、对象路径和事件隔离抽检。

代码路径已完成并有本地/Compose 证据；只有真实云报告、真实平台/模型配额和真实平台写入回读，才能关闭生产级门禁。

## 4. Performance Review

### P1. 入口容量和重任务吞吐必须分开

API 只承诺快速鉴权、校验、快照和接收；生成、同步与发布完成时间受上游配额影响。否则 500 个慢请求会耗尽连接和内存。

### P2. 扩缩容以用户结果和队龄驱动

API 同时看 CPU、并发连接和 P95；Worker 看各队列最老作业、深度和上游额度。只看 CPU 会漏掉 I/O 等待型饱和。

### P3. 数据库是最可能的自有瓶颈

所有高频查询带 workspace 复合索引；列表分页、同步批量 upsert；连接池代理限制后端连接；监控池等待、锁、慢查询、IOPS 和事务时长。

### P4. 500 商家意味着成本也要背压

每工作区每天 100 任务的理论上限是 50,000 任务/日。模型额度、单任务成本、对象存储和平台请求都要按 workspace 计量；超额排队或拒绝时给出原因，不能无限重试。

Performance：4 个问题全部写入容量合同、配置和放行门禁。

## Failure Modes

| 路径 | 现实失败 | 测试 | 错误处理 | 用户结果 |
|---|---|---|---|---|
| Edge/API | 单副本退出或扩容未就绪 | 负载 + 重启 | 健康摘除、最少 3 副本 | 当前操作重试，已接收 job 不丢 |
| Admission | 500 请求抢同一 DB/队列资源 | 突发测试 | 连接预算、限流、outbox | 返回 job 或明确过载，不静默超时 |
| Fair scheduler | 大店同步占满 Worker | 噪声租户 | 隔离池、workspace 份额 | 其他商家仍可确认和查询 |
| Database | 副本扩容导致连接池满 | 故障注入 | pooler、超时、告警、背压 | 可重试，不出现全站雪崩 |
| Queue/Redis | Redis 短暂不可用或消息丢失 | 故障注入 | DB outbox 重建队列 | 不重复发布，状态最终收敛 |
| Model/platform | 429、配额不足、长时间审核 | contract + load | 配额调度、retry_after、熔断 | 显示等待/受理/审核中，不误报失败或成功 |
| Tenant isolation | 缓存键或对象路径漏 workspace | 安全 + load | 强制 scope、授权和审计 | 发现 1 次即全量 No-Go |

设计层没有“无测试 + 无错误处理 + 静默失败”的遗漏；实现证据仍是发布门禁。

## What Already Exists

- 复用 v1.2 的 Plugin、模块化 MCP、Connector、transactional outbox、版本、幂等和对账设计。
- 复用托管 WAF/LB、容器扩缩、PostgreSQL、pooler、Redis/队列、对象存储和 OTEL，不自研基础设施。
- 当前不存在业务代码、压测脚本、部署环境或真实容量报告。

## NOT in Scope

- 多区域双活和跨地域容灾：500 并发不要求，先做单区域 HA 与备份恢复。
- Kafka、Service Mesh 和业务微服务拆分：当前吞吐不构成引入条件。
- 自建 GPU/模型推理：P0 调用批准的模型 API。
- 一次性向 500 家真实商家开放：先 6–9 家试点，再按 10/50/100/250/500 分波。
- 保证 500 次平台写入即时完成：外部应用和店铺配额不由本系统控制。

## Parallelization

| Lane | Owner | 工作 | 依赖 |
|---|---|---|---|
| A Runtime | P1 + P5 backup | Edge、无状态 API、连接池、HA 数据层、扩缩容 | Day 2 容量合同 |
| B Workload | P9 + P7 backup | 四类队列/Worker、公平调度、outbox、配额和恢复 | Job/状态 contract |
| C Quality | P8 | 压测数据、脚本、指标、故障注入和报告 | A/B 可部署切片 |

Day 2 冻结合同；A/B 从 Day 3 并行，C 每日阶梯测试；Day 11 合并做 100/250，Day 12 做 500 目标负载，Day 13 做突发与 6 小时稳定性，Day 14 做滚动重启和回归。

## Implementation Tasks

Synthesized from this review's findings. Run with Codex; checkbox as you ship.

- [x] **T1 (P1, human: ~1d / Codex: ~2h)** — Capacity contract — 固化 500 会话、150/300 RPS、500 作业突发及指标口径
  - Surfaced by: Architecture A1 — 登录数不能证明在线操作容量。
  - Files: `tests/load/`, `config/capacity/`, `doc/runbooks/`
  - Verify: 同一 workload profile 可在 CI/预发布重复执行并生成版本化报告。
- [x] **T2 (P1, human: ~2d / Codex: ~4h)** — Stateless runtime — 部署 WAF/LB 和 3–12 个无状态 MCP/API 副本
  - Surfaced by: Architecture A2 — 单实例是入口和会话单点。
  - Files: `infra/kubernetes/overlays/`, `infra/kubernetes/base/api.yaml`, `tests/fault/`
  - Verify: 仓库合同已验证 target-500 使用 12 个 API 副本、RollingUpdate 且 `maxUnavailable: 0`、readiness probe 存在且无粘性会话配置；500 会话下滚动删除任一 API 副本、已接收作业不丢且 P95 达标仍需真实预发布/云报告。
- [x] **T3 (P1, human: ~2d / Codex: ~5h)** — Workload isolation — 拆分四类 Worker 队列并实现 workspace 公平调度
  - Surfaced by: Architecture A3 — 大店同步会饿死发布与对账。
  - Files: `mcp/workers/`, `mcp/queues/`, `mcp/scheduler/`, `tests/load/`
  - Verify: 噪声租户测试中其他租户 P95 退化 ≤20%，重复发布和丢 job 均为 0。
- [x] **T4 (P1, human: ~1d / Codex: ~3h)** — Database budget — 配置 pooler、300 后端连接预算和连接/锁/慢查询告警
  - Surfaced by: Architecture A4 — 横向扩容会乘法放大数据库连接。
  - Files: `deploy/database/`, `config/production/`, `ops/dashboards/`
  - Verify: 代码、生产配置合同、Kubernetes 资源限制和 preflight 已证明最大副本配置预算为 264/300，并要求 80% 告警；真实云 pooler 池满背压和慢查询报告仍需预发布签署。
- [x] **T5 (P1, human: ~1d / Codex: ~2h)** — Quota boundary — 将平台与模型额度接入 admission、调度和用户等待状态
  - Surfaced by: Architecture A5 — 服务器扩容不能提高外部配额。
  - Files: `mcp/quotas/`, `mcp/connectors/`, `mcp/models/`, `tests/contracts/`
  - Verify: 429/低额度下请求可靠排队、retry_after 可见、同店写串行且不误报成功。
- 备注：T1/T3/T4/T5 的代码合同、容量 profile、Redis 原子计数、连接预算和自动化测试已完成；噪声租户 P95、官方平台/模型额度、pooler 池满和 500 作业/分钟仍需真实预发布环境报告，不能由本地测试替代。
- T1/T6 工具合同已落地：`tests/capacity-workload.ts` 固定 50/500 profile，并对真实云模式强制 HTTPS、持续 30 分钟、稳定 6 小时和显式确认；它只覆盖自有 API/Job admission，不能替代四平台 canary、模型额度和正式 capacity evidence。
- [ ] **T6 (P1, human: ~2d / Codex: ~4h)** — Capacity evidence — 完成目标、突发、故障、噪声租户和 6 小时稳定性测试
  - Surfaced by: Test/Performance Review — 当前没有实现级容量证据。
  - Files: `tests/load/`, `tests/fault/`, `evidence/capacity/`
  - Verify: PRD 15.1 全部阈值通过，报告绑定 RC 软件、配置、环境和数据版本。

### Local evidence reconciliation (2026-09-01)

以下是已由本地代码/测试证实的合同级证据，不等同于目标部署放行：

- Domain、connector、job、task、fact、publish 状态和重放合同：`cd5b0b6`，定向测试通过。
- Capacity evidence schema、duration/tenant/fault/steady-state 一致性：`01744fe`，定向测试 11/11 通过。
- Durable storage/备份证据字段及 artifact checksum：`57b7e03`，定向测试 5/5 通过。
- Worker migration/source manifest freshness：`eb815ea`，定向测试 2/2 通过。
- Health/ready correlation 与观测终态去重：`4a3b4fc`，定向测试 4/4 通过；覆盖 request/trace/workspace/job/connector/receipt 关联、敏感字段不泄露和依赖失败时非 200 readiness。

上述四项只证明本地合同和证据门禁可拒绝不完整/过期/不一致输入，不证明目标环境已经运行通过。仍未勾选 T6：50 家真实负载/故障/soak、真实连续 6 小时运行、噪声租户指标、目标部署报告、真实平台 canary、模型/支付/外部 OAuth 证据均未由本地测试替代。

## Completion Summary

- Step 0：保留模块化单体和 9 人/15 日，运行形态升级，不引入微服务。
- Architecture Review：5 个问题，全部写回。
- Code Quality Review：0 个代码级结论；6 条实现合同已定义。
- Test Review：覆盖图已产出；T2 的本地无状态部署合同、T3 Worker 公平调度、T5 配额 admission 已有实现级测试，T1/T2/T4/T6 的真实云运行证据仍待外部环境。
- Performance Review：4 个问题，全部写回；本地/Compose 结果继续明确标记为 `cloudGate=false`。
- NOT in scope：5 项已写。
- What already exists：复用 v1.2 设计和托管基础设施。
- Failure modes：0 个设计层静默关键缺口；实现证据待关闭。
- Outside voice：当前运行于 Codex，跳过嵌套 Codex 自审。
- Parallelization：3 lanes，A/B 并行，C 持续验证。
- Verdict：条件通过；没有 500 并发实测报告前不得宣称已支持 500 家生产在线。

NO UNRESOLVED PRODUCT OR ARCHITECTURE DECISIONS
