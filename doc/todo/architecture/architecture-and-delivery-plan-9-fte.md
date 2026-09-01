# 商家营销内容助手：9 人架构与三周交付方案

版本：v1.0 Final  
日期：2026-08-22  
输入基线：[产品 PRD v1.4](../product/PRD-merchant-marketing-codex-final.md)
评审方法：gstack Autoplan（CEO → Design → Engineering → DX）+ 独立工程经理复审  
团队与周期：9 名全职，15 个工作日，AI vibe coding  
容量策略：Release 1 按 50 家并发采购和验收；架构可扩至 500，按 50→100→250→500 分波扩容

## 1. 最终结论

采用“一个 Codex Plugin 入口 + 模块化单体 MCP/API + 三个平台连接器 + 四类隔离 Worker + PostgreSQL/Outbox + Redis/队列 + 对象存储”的架构。业务代码保留一个仓库和一套公共契约，运行时按 API、同步、生成、发布、对账横向扩展，不在三周内拆微服务。

9 人按纵向功能模块负责，每人对需求、schema、Skill、API/Worker、测试、文档和运行结果端到端负责。P1 负责公共契约但不承包所有基础设施实现；P9 从 Day 3 开始维护每日可运行纵向薄切，不能等 Day 8 才开始总集成；P8 从 Day 2 开始并行建设 contract test、黄金集和容量脚本。

三周承诺是 Engineering RC + 50 家容量门禁 + 四个 schema profile 分别判定 Ready/Conditional/Blocked。平台审批不受研发控制；没有生产权限的 profile 可以完成开发和测试证据，但必须保持 Feature Flag 关闭，不得伪报生产可用。

## 2. gstack 多轮讨论与决策

### Round 1：CEO / Scope Review

讨论：三周、9 人、六平台、授权同步、生成审核、版本、确认后发布、50→500 扩容是否同时成立。

结论：

- 保留六平台 P0，因为是用户明确的业务边界；上线结论按 JD、Taobao、Tmall、Pinduoduo、XHS、Douyin 六 profile 独立签署。
- 保留单商品、单店铺、单目标平台任务原子；多平台请求拆成独立子任务。
- Release 1 只按 50 家并发采购和验收；500 家是扩容目标，不占用三周 RC 的生产放行门槛。
- 最终图片、视频、批量多商品、定时无人值守发布、复杂 RBAC 继续后置。

评分：范围清晰度 9/10；商业证据 6/10；三周可控性 7/10。

### Round 2：Design / Interaction Review

讨论：对话主界面能否安全承载授权、事实确认、版本 diff 和线上发布。

结论：

- 对话是完整 P0 主流程；结构化卡片只是增强，必须有 Markdown/JSON 文本降级。
- 明确四级确认：事实确认、制作方案确认、最终内容确认、平台写入二次确认。
- 所有长任务返回 Job ID、排队位置、预计等待、可恢复状态，不能把异步执行显示为页面“卡死”。
- stale 远端快照、Token 失效、平台驳回和 unknown 状态必须有独立 UI/文本状态和恢复动作。

评分：主流程 9/10；错误恢复 9/10；无障碍/文本降级 8/10。

### Round 3：Engineering Review

讨论：模块边界、事务、幂等、租户隔离、平台差异、性能和测试。

结论：

- 模块化单体是三周内正确复杂度；API 无状态多副本，四类 Worker 独立部署。
- PostgreSQL 是业务真相；Redis 只做缓存/限流/短状态；Transactional Outbox 保证已接收 Job 可重建。
- `PlatformConnector` 统一行为，不抹平平台字段；canonical value、raw value、mapping version 同时保留。
- 发布确认事务锁定 ContentVersion 和 PlatformRemoteSnapshot，创建唯一 PublishJob 和 outbox；timeout/unknown 先对账后重试。
- 所有 DB 查询、缓存键、队列 envelope、对象路径和日志均包含 workspace scope。
- 首期 50 profile 与目标 500 profile 必须成为显式配置，不能在三份文档中混用阈值。

评分：架构 9/10；安全与一致性 9/10；性能 8/10；实施证据 3/10（当前仍无业务代码）。

### Round 4：DX / Delivery Review

讨论：9 人如何用 AI vibe coding 并行而不产生不可合并的九套实现。

结论：

- Day 2 前冻结公共 schema、状态机、错误码、Job envelope、Connector contract 和 fixture。
- 每个模块必须有本地 mock/fixture；开发不等待真实平台网络才能跑测试。
- P2/P3/P4 只实现 adapter，不复制 OAuth、安全、重试、日志和状态机公共代码。
- P9 从 Day 3 维护每日 E2E；Day 5、9、14 是强制集成点。
- AI 生成代码必须通过类型检查、lint、unit/contract/E2E，并由 Owner 解释和负责。

评分：模块可并行性 8/10；集成策略 9/10；开发者上手 7/10。

### 独立工程经理复审

独立视角确认架构方向正确，同时提出四个高风险：P1/P8 过载、P3 同时承担淘宝/天猫双 profile、P9 集成过晚、50 与 500 配置漂移。最终方案通过职责拆分、Day 3 纵向薄切、质量左移和双 capacity profile 关闭这些设计问题；平台审批和真实运行证据仍保留为外部门禁。

## 3. 总体架构

可视化架构图：[merchant-system-architecture.html](../../done/architecture/merchant-system-architecture.html)

```text
┌──────────────────────────────── Codex App ────────────────────────────────┐
│ Merchant Plugin                                                          │
│  ├─ Entry Skill / 内部 Skills                                            │
│  └─ 对话 + 授权/事实/diff/检查/发布回执卡片（均有文本降级）               │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │ HTTPS / workspace identity
┌───────────────────────────────▼───────────────────────────────────────────┐
│ DNS / TLS / WAF / L7 Load Balancer                                       │
└───────────────────────────────┬───────────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────────┐
│ Stateless MCP/API：2 副本起步 → 12                                       │
│ Workspace/Auth │ Assets │ Task │ Rules │ Review │ Version │ Publish API   │
└──────────────┬───────────────┬───────────────┬────────────────────────────┘
               │               │               │
     ┌─────────▼──────┐ ┌──────▼──────┐ ┌─────▼────────────────┐
     │ HA PostgreSQL  │ │ Redis / Queue│ │ Object Storage + KMS │
     │ Pooler + Outbox│ │ 4 isolated   │ │ 原件/预览/交付包      │
     └─────────┬──────┘ └──────┬──────┘ └──────────────────────┘
               │               │
               │      ┌────────┼───────────┬──────────────┐
               │      ▼        ▼           ▼              ▼
               │   Sync W   Generate W   Publish W     Reconcile W
               │      │        │           │              │
               │      │        └── Model Adapter          │
               │      └──────────── Connector Gateway ─────┘
               │                   │
               │        JD │ Taobao/Tmall │ Pinduoduo
               │
               └──────── Audit / OTEL / Metrics / Logs / Alerts
```

## 4. 模块边界与接口

| 模块 | 责任 | 禁止越界 |
|---|---|---|
| Plugin/Interaction | 安装、对话入口、卡片和文本降级 | 不保存业务真相、不直接持有平台 Token |
| Workspace/Identity | 工作区、actor、角色、服务端 scope | 不让客户端传入的 workspace_id 绕过服务端授权 |
| Credential Vault | OAuth state/PKCE、Token 加密引用、刷新/撤权 | 不向 Skill、日志、导出包返回明文 Token |
| Connector Gateway | 统一授权/读/写/查询/撤权 contract | 不强制三个平台使用相同 raw schema |
| Commerce Domain | 品牌、店铺、商品、SKU、事实来源和确认 | 不从名称自动合并跨平台商品 |
| Task/Generation | 快照、追问、方向、方案和内容生成 | 不读取会变化的最新事实替换任务快照 |
| Rule/Review | 确定性检查、模型 finding、阻断和人工确认 | 不把模型判断当平台或法律最终合规 |
| Version/Delivery | 不可变版本、diff、恢复、manifest、ZIP | 不覆盖 delivered 版本或原始文件 |
| Publish Orchestrator | 二次确认、PublishJob、幂等、回读和对账 | unknown 状态不得直接重试写入 |

### 4.1 Connector Contract

```text
authorize / handle_callback / refresh_or_reauthorize / revoke
list_stores / full_sync_products / incremental_sync_products
get_product / map_to_canonical / validate_platform_schema
create_product / update_product / query_publish_status / normalize_error
```

每个方法统一返回 `workspace_id / platform / account_id / request_id / mapping_version / raw_payload_ref / normalized_error`；淘宝与天猫共享连接器基础，但 schema、fixture、规则和 readiness 分开。

### 4.2 Job Envelope

```text
job_id, job_type, workspace_id, actor_id, platform, account_id,
task_id, content_version_id, remote_snapshot_id, idempotency_key,
attempt, trace_id, created_at, not_before, quota_class
```

同步、生成、发布、对账共享 envelope 和错误分类，只隔离队列、Worker 和并发预算。

## 5. 关键数据流与时序

### 5.1 授权与同步

```text
User → Plugin → API: connect(platform)
API → OAuth State Store: save state/PKCE/workspace
API → Platform: redirect official authorization
Platform → Callback: code + state
Callback → Vault: verify state, exchange and encrypt token
Callback → Outbox: enqueue initial sync
Sync Worker → Platform: paged product/SKU reads
Sync Worker → Domain: canonical + raw + mapping version
Domain → User: conflict/missing/source confirmation
```

### 5.2 内容生成

```text
User Request → Entity Resolve → Missing/Conflict Check
             → Immutable Task Snapshot → 3 Directions
             → Plan Confirmation → Generation Queue
             → Model JSON Schema → Deterministic Review
             → Model Findings → User Revision/Approval
             → ContentVersion + Manifest
```

### 5.3 确认后发布

```text
User opens diff
  → API refreshes PlatformRemoteSnapshot
  → deterministic preflight
  → user second confirmation
  → DB transaction:
       lock ContentVersion + RemoteSnapshot
       validate confirmation token/hash
       create unique PublishJob
       append outbox event
  → Publish Worker calls platform
       success  → read back → compare → receipt
       rejected → field error → editable retry candidate
       timeout  → publish_unknown → Reconcile Worker → query before retry
```

## 6. 数据与状态设计

核心实体：Workspace、Actor、PlatformAccount、CredentialRef、Store、Brand、CommerceProduct、SKU、FactField、SourceAsset、RulePack、MappingVersion、Task、TaskSnapshot、CreativeDirection、ContentVersion、ReviewFinding、Approval、PlatformRemoteSnapshot、PublishJob、PublishReceipt、AuditEvent。

关键不变量：

- 一切业务读写受 `workspace_id` 服务端约束。
- 内容版本保存事实、规则、映射、软件、模型和远端快照组成的版本向量。
- delivered/published 版本只读；恢复旧版本会创建新版本。
- 一个 confirmation token 只能创建一个 PublishJob。
- 同店同商品写串行；不同平台子任务互不共享发布状态。
- accepted Job 不丢、重复发布为 0、跨工作区泄漏为 0。

## 7. 运行与扩容架构

| 阶段 | 并发工作区 | API | Worker | PostgreSQL | Redis | 对象存储 | 放行负载 |
|---|---:|---|---|---|---|---|---|
| Release 1 | 50 | 2×2C/4G | 6 个起步副本 | HA 4C/16G | HA 4G | 1 TB | 30/60 RPS，50 jobs/min |
| Wave 100 | 100 | 2–3×2C/4G | 按队龄扩 | 4C/16G | 4G | 2 TB | 实测后签署 |
| Wave 250 | 250 | 3–6×4C/8G | 四池独立扩 | 8C/32G | 8G | 3 TB | 实测后签署 |
| Target 500 | 500 | 3–12×4C/8G | 最大 40 副本 | 8C/32G 起 | 8G | 5 TB | 150/300 RPS，500 jobs/min |

扩容依据：API 看 CPU、P95 和连接数；Worker 看队龄、深度和上游配额；数据库看连接池、CPU、IO、锁和慢查询。平台/模型额度不会因为增加服务器自动提高，必须与计算资源一起验收。

## 8. 9 人任务划分

| 人员 | 主模块 | 15 日最终交付 | 关键接口 | Backup/Reviewer |
|---|---|---|---|---|
| P1 | 架构与公共平台 | Plugin、MCP skeleton、Workspace/Auth、OAuth/Vault 公共层、Connector contract、CI/CD、配置事实源 | Workspace context、Connector SDK、error/job envelope | Backup P5；与 P9 互审 |
| P2 | 京东纵向模块 | JD OAuth、全量/增量同步、mapping、规则、创建/更新、状态/错误、fixture/E2E | Connector contract、CommerceProduct | Reviewer P3/P8 |
| P3 | 淘宝/天猫纵向模块 | TOP OAuth 公共能力；淘宝和天猫分别完成 schema、fixture、同步、写入、状态和规则 | 两个独立 CapabilityEvidence profile | Reviewer P2/P4；P4 协助边界样例 |
| P4 | 拼多多纵向模块 | PDD OAuth、同步、mapping、规则、创建/更新、状态/错误、fixture/E2E | Connector contract、CommerceProduct | Reviewer P3/P5 |
| P5 | 商业数据与资产 | Brand/Store/Product/SKU、FactField/Source、跨平台绑定、同步冲突、数据库 migration | canonical/raw/mapping version | Backup P1；Reviewer P4/P6 |
| P6 | 任务与 AI 内容 | TaskSnapshot、实体解析、渐进追问、3 方向、方案、详情页/Brief、模型 adapter/eval | JSON Schema、Prompt bundle、ContentVersion candidate | Reviewer P5/P8 |
| P7 | 文件、交互、版本与交付 | 上传解析、对象存储、确认卡片/文本降级、局部修改、diff/恢复、manifest/ZIP | SourceAsset、ContentVersion、signed URL | Backup P9；Reviewer P6/P9 |
| P8 | 规则、检查与质量平台 | RulePack、deterministic validator、model finding、黄金集、contract/security/load/fault tests、质量门禁 | Finding schema、test harness、capacity report | Reviewer P2/P6；质量否决权 |
| P9 | 发布编排、集成与 Release | Worker/queue、PublishJob、outbox、幂等、remote hash、unknown 对账、每日 E2E、灰度/回滚/runbook | Job envelope、PublishReceipt、Feature Flag | Backup P7；与 P1 互审 |

### 8.1 工作量平衡规则

- P1 的云资源落地由 P9 分担 Worker/队列，P5 分担数据库 migration，P8 分担观测仪表盘，避免 P1 成为底座单点。
- P3 的淘宝/天猫共享 OAuth 和传输层，但 fixture、schema、规则和上线证据分别维护；P2/P4 各提供一天交叉 review 支援。
- P8 不独自编写全部测试：每位 Owner 写本模块 unit/contract 测试，P8 只负责框架、黄金集、跨模块 E2E、容量和放行。
- P9 维护集成主线，但不能替其他 Owner 修复所有 adapter；缺陷回到模块 Owner，当日闭环。

### 8.2 固定 Reviewer 环

```text
P1 ↔ P9   P2 ↔ P3   P3 ↔ P4   P4 ↔ P5
P5 ↔ P6   P6 ↔ P8   P7 ↔ P9   P8 ↔ P2
```

公共 schema、状态机、错误码和 config schema 只由 P1 合并；发布状态机/outbox 由 P9 合并；规则严重度和放行逻辑由 P8 合并。

## 9. 15 个工作日排期

### Day 0：开钟门禁（不计入 15 日）

- 六 profile 开发者应用、测试店铺、OAuth 回调域名和目标 scope 可用。
- 每个 profile 完成最小 authorize/read/create-or-update/query 探针并保存 fixture。
- 模型、云资源和 50 家 profile 配额可用。
- 平台/法务/安全/规则 Owner 明确。

任一 profile 不满足时，该 profile 标记 Blocked；不允许用 mock 宣称其生产 Ready。

### Week 1：合同冻结与可运行纵向薄切

| Day | 全队里程碑 | 重点 Owner |
|---|---|---|
| D1 | fixture/配额/异常样例复核；建立 repo、CI、模块 skeleton | P1、P2–P4、P8 |
| D2 | 冻结 domain schema、Connector、Job、错误、状态机、50/500 capacity profiles | P1、P5、P8、P9 |
| D3 | Plugin 安装；2 API 副本；六 profile OAuth stub；mock 纵向 E2E | P1、P2–P4、P9 |
| D4 | 六 profile 商品读/mapping；Brand/Product/SKU；上传降级 | P2–P5、P7 |
| D5 | 全量/增量同步、冲突确认；Demo 1：真实/沙箱商品进入可追溯快照 | P2–P5、P8、P9 |

Week 1 Exit：每个 profile 至少一个商品可授权、读取、映射和确认；mock 发布链可跑；contract tests 绿。

### Week 2：内容闭环与确认后发布

| Day | 全队里程碑 | 重点 Owner |
|---|---|---|
| D6 | 任务快照、实体消歧、渐进追问、平台子任务 | P5、P6、P7 |
| D7 | 3 方向、方案、详情页/Brief、规则快照和 Eval baseline | P6、P8 |
| D8 | 六 profile 预检/写 adapter、二次确认、PublishJob、四 Worker 池 | P2–P4、P8、P9 |
| D9 | 状态查询/回读、业务驳回、timeout unknown、幂等与对账 E2E | P2–P4、P7、P9 |
| D10 | 局部修改、版本恢复、回执、manifest/ZIP；功能冻结；Demo 2 | P6、P7、P8、P9 |

Week 2 Exit：六 profile 至少在测试环境各完成授权→同步→生成→检查→确认→创建/更新→回读；未获权限者以 contract evidence 标记 Blocked。

### Week 3：质量、50 家容量与 canary

| Day | 全队里程碑 | 重点 Owner |
|---|---|---|
| D11 | 50 黄金样例、安全/权限/回调、50 并发基线、平台 429/5xx 故障 | P8 主导，全员修复 |
| D12 | 6–9 家引导式走查；50 workspace、30 RPS、50 jobs/min | 产品、P6–P9 |
| D13 | 噪声租户、60 RPS、连接池、队列公平、6h soak；RC1 | P1、P8、P9 |
| D14 | 六 profile 回归；副本重启、撤权、回滚、备份恢复、删除演练 | 全员，P9 Release |
| D15 | Ready profile 各 1 家低风险 canary，观察 2h；签署验收 | P1、P2–P4、P8、P9 |

Week 3 Exit：功能、50 家容量和运行门禁分别签署；500 家不在首期资源上虚假验收。

## 10. 依赖图与关键路径

```text
D0 平台权限/fixture
       │
       ▼
P1 公共契约 ─────────────┬───────────────┐
       │                 │               │
       ▼                 ▼               ▼
P2/P3/P4 Connectors → P5 Domain → P6 Task/Generation
       │                 │               │
       └──────────────┬──┴───────┬───────┘
                      ▼          ▼
                 P8 Review    P7 Version/File
                      └────┬─────┘
                           ▼
                    P9 Publish/Release
```

关键路径：D0 → D2 contracts → D5 sync snapshot → D7 content → D9 publish E2E → D10 freeze → D13 RC → D15 canary。

延误规则：关键路径延误超过 1 天，先削减高级预览、复杂 diff、推荐型问题和 P1 风格规则；不得削减六 profile 读取证据、事实来源、SKU/价格/权限检查、二次确认、幂等、对账、租户隔离和回滚。

## 11. 测试覆盖方案

```text
CODE PATHS                                      USER FLOWS
Plugin → API                                    安装/连接 [E2E]
  ├─ auth success/deny/state mismatch             ├─ OAuth 成功/拒绝/过期
  └─ workspace scope/IDOR                         └─ 撤权后历史只读

Connector → Domain                              商品同步 [Contract+E2E]
  ├─ full/incremental/partial failure             ├─ 0/1/5000 商品
  ├─ raw/canonical/mapping drift                   └─ SKU/价格/图片冲突确认
  └─ token/429/5xx/timeout

Task → Model → Review                           内容生产 [Eval+E2E]
  ├─ missing/conflict/stale facts                 ├─ 渐进追问 ≤4
  ├─ JSON schema/repair/timeout                    ├─ 局部修改/恢复
  └─ deterministic P0/model finding               └─ P0 阻断不能 approved

Confirm → Outbox → Publish → Reconcile          发布 [Contract+Fault+E2E]
  ├─ duplicate confirm/stale hash                  ├─ 明确 diff/二次确认
  ├─ crash before/after platform call              ├─ rejection 可修复
  └─ timeout unknown/query-before-retry             └─ 0 重复创建

Runtime                                         50 家容量 [Load+Fault]
  ├─ 30/60 RPS, 50 jobs/min                       ├─ P95/P99/5xx
  ├─ noise tenant/queue fairness                   ├─ 其他租户退化 ≤20%
  └─ 6h soak/API-Worker-Redis-DB faults            └─ job loss/leak/duplicate = 0
```

测试责任：模块 Owner 负责 unit + contract；P8 负责黄金集/Eval/安全/负载框架；P9 负责跨模块 E2E、故障和发布演练。

## 12. Failure Modes 与恢复

| 失败 | 系统处理 | 用户结果 | Owner |
|---|---|---|---|
| OAuth state 不匹配/Token 失效 | 拒绝回调或停止新调用，要求重连 | 明确平台/店铺和恢复入口 | P1 + adapter Owner |
| 同步部分失败/游标中断 | 成功批次提交，失败对象单独重试 | 显示进度和失败清单 | P2–P5 |
| 模型超时/JSON 非法 | 最多修复 2 次，之后保留快照可重试 | 不生成空白成功记录 | P6 |
| P0 finding 未解决 | 状态机拒绝 approved/publish | 显示证据、规则和修复入口 | P8 |
| 重复确认/Worker 崩溃 | 唯一 PublishJob + outbox 重放 | 同一确认不重复创建 | P9 |
| 平台超时 unknown | 对账 Worker 查询后再决定重试 | 显示“状态确认中” | P9 + adapter Owner |
| 远端商品已变化 | confirmation token 失效 | 刷新 diff 后重新确认 | P7/P9 |
| Redis/队列短故障 | DB Outbox 重建队列 | 已接收 Job 不丢 | P1/P9 |
| 单租户洪峰 | workspace 公平调度/背压 | 其他商家仍可查询和确认 | P8/P9 |
| 跨 workspace 访问 | 拒绝、审计、P0 告警 | 全量 No-Go | P1/P8 |

## 13. What Already Exists

- 已完成最终 PRD、平台/数据/状态/容量合同、生产配置字段和可维护 Mermaid/Excalidraw 图。
- 可复用 Codex Plugin/Skills/MCP 宿主能力，以及托管 PostgreSQL、Redis/队列、对象存储、KMS、WAF/LB 和 OTEL。
- 本节记录计划评审时的初始基线：当时没有业务代码、测试框架、真实平台权限证明或容量报告；当前实现进度和运行证据以 `doc/todo/quality/implementation-status.md` 为准，真实平台与云容量门禁仍不能由文档或本地 fixture 代替。

## 14. NOT in Scope

- 微服务、Kafka、Service Mesh、多区域双活、自建 GPU。
- 最终图片/视频渲染、批量多商品、无人值守定时发布。
- 复杂企业审批流、完整 RBAC、广告账户发布和高风险品类。
- 在首期 50 家资源上宣称已通过 500 家容量。

## 15. Definition of Done

- 六 profile 分别记录 capability evidence 和 Ready/Conditional/Blocked。
- 所有 P0 事实引用可追溯；黄金集 P0 漏检为 0。
- 发布必须二次确认；accepted Job 丢失、重复发布和跨 workspace 泄漏均为 0。
- 50 家 profile 的 30/60 RPS、50 jobs/min、噪声租户、6h soak 和故障注入通过。
- API/Worker 重启、撤权、回滚、备份恢复、数据删除和写 kill switch 已演练。
- 配置、migration、schema、Prompt、规则、mapping、连接器和交付包均有版本。
- 非 Owner 可依据 runbook 定位 task/job、关闭平台写入并完成恢复。

## 16. Implementation Tasks

- [x] T1 P1/P5/P9：冻结 domain、Connector、Job、error、state、capacity profile 契约。
  - 本地证据：`cd5b0b6` 的 domain/task/fact/publish、connector/job contract tests 已通过；capacity profile 合同与 `eb815ea` release freshness simulation 已通过，worker migration tail 与 source manifest digest 不一致时会 fail-closed。真实目标部署仍不由此项声明覆盖。
- [x] T2 P2/P3/P4：六 profile fixture、contract tests 和 capability evidence。
  - 本地证据：`f2cef8d` 六平台 raw/canonical golden fixture、`5efe003`/`be29b31` registry/policy parity、`6db5ab5` rendered configuration evidence tests 已通过；真实平台能力授权与目标部署证据仍需外部验证。
- [x] T3 P1/P5/P7：Workspace scope、Vault、PostgreSQL migration、对象存储与版本。
  - 本地证据：`d936ed6` canonical/listing workspace 与唯一性测试、`0938909` migration chain integrity、`57b7e03` object-storage evidence gate 已通过；真实 Vault、目标对象存储和部署环境证据仍需外部签署。
- [ ] T4 P6/P8：Task snapshot、Prompt schema、黄金集、deterministic/model review。
- [x] T5 P7/P9：diff、二次确认、PublishJob、outbox、remote hash、receipt。
  - 本地证据：`cd5b0b6` publish state/confirmation/reconciliation tests、`279d7ab` prepare-confirm contract、`6378205` receipt/usage trace contract 已通过；真实平台写后回读和部署 canary 仍未完成。
- [ ] T6 P1/P8/P9：50 家 load/fault/soak、观测、runbook、回滚与 canary。
  - 本地门禁证据：`4a3b4fc` health correlation contract 已通过，覆盖 request/trace/workspace/job/connector/receipt 关联、敏感字段隔离、依赖失败时 health/readyz 非 200 和观测终态去重；`01744fe` capacity evidence gate 已通过，校验 duration/metrics 一致性、租户隔离、故障注入、队列收敛和过期时间；`57b7e03` storage evidence gate 已通过，校验版本/来源绑定、配置 checksum、保留策略、隔离恢复及 artifact checksum。
  - 上述均为本地合同/证据格式门禁，不是运行结果。真实 50 家负载、噪声租户指标、故障恢复、连续 6 小时 soak、目标部署、回滚演练和 canary 仍未完成。
- [ ] T7 全员：Day 5/9/14 集成门禁和模块级缺陷清零。

## GSTACK REVIEW REPORT

| Review | Runs | Status | Findings |
|---|---:|---|---|
| CEO / Scope | 1 | CLEAR | 六平台保留；单商品任务；50 首发、500 目标；多模态和无人值守后置 |
| Design / Interaction | 1 | CLEAR | 对话主流程、卡片增强、四级确认和错误恢复已锁定 |
| Engineering | 2 | CLEAR WITH GATES | 模块化单体、四 Worker、Outbox、幂等、租户隔离和双 capacity profile 已锁定 |
| DX / Delivery | 1 | CLEAR | Day 2 contract freeze、Day 3 每日 E2E、模块 Owner 端到端负责 |
| Outside Voice | 1 | CONCERNS FOLDED | P1/P8 过载、P3 双 profile、集成后置和配置漂移已回写；平台审批仍为外部门禁 |

**VERDICT:** 架构和 9 人分工可进入开发；15 日承诺以 Day 0 权限/fixture 门禁、Day 10 功能冻结、Day 13 50 家容量门禁和 Day 15 分 profile canary 为条件。500 家必须在扩容前使用目标配置重新压测。

NO UNRESOLVED DECISIONS
