# Canonical 商品链产品优先级审阅与完成验收标准

审阅日期：2026-08-31  
角色：资深产品经理  
方法：`prioritization`（以生产目标为锚点，结合依赖关系、客户/运营风险、实施信心与实施成本进行 ICE 方向性排序）  
变更范围：只读审阅并新增本文件；本轮未修改业务代码、migration、数据库或运行配置。

## 1. 产品判断

目标不是“把 canonical、listing、campaign item 表建出来”，而是让商家在 ChatGPT 插件 → API/MCP → worker → 运营后台 → 发布/计费的真实链路中，始终能得到同一个、可追溯且不会跨品或跨店铺的商品事实。

因此，canonical 链路只有同时满足以下五层，才可以称为“完成”：

| 层级 | 要回答的问题 | 当前判断 |
|---|---|---|
| 数据模型 | canonical product、listing、campaign item 和 task 是否有明确关系与租户边界？ | 基本具备 |
| 关系一致性 | legacy product 与 canonical/listing/task 是否能被显式校验，冲突是否可见？ | 部分具备；已有只读一致性报告 |
| 业务落地 | 新建、读取、预检、生成、发布、计费是否都以同一 canonical 链为主源？ | 未完成；关键路径仍读 legacy Product |
| 迁移运营 | 历史数据是否完成安全回填、差异处理、重复检查和回滚演练？ | 未完成 |
| 生产证据 | PostgreSQL/RLS、真实平台回读、worker、对象存储、计费和发布 canary 是否有可审计证据？ | 未完成；不能上线 |

当前产品结论：**Canonical 链路为 TODO / NO-GO，不得迁移到 `doc/done`。**

## 2. 优先级目标与排序

### 2.1 目标与约束

首要目标：在不重写历史快照、不删除 legacy 数据、不引入跨租户或跨店铺误发布的前提下，完成按 workspace 的 canonical 安全切读。

不可牺牲的约束：

- 任何无法证明的身份都进入 `legacy_only`、`conflict` 或 `blocked`，不得按标题、图片、店铺名或第一条候选猜测。
- 历史 `context_snapshot`、`content_version`、`publish_job` 和回执保持原事实，不因切读重新绑定。
- 新标准链写入失败、旧投影失败、outbox 延迟和第三方回读失败必须可观测、可重试或可人工处理。
- 所有 API、MCP、worker 和运营查询必须先经过 workspace/brand/platform/account 权限边界。
- 代码测试通过只证明代码门禁通过，不能替代真实 PostgreSQL、对象存储、模型中转、平台和发布证据。

### 2.2 ICE 方向性排序

分数采用 1–10 相对值：Impact 为对真实链路安全和交付的影响，Confidence 为现有证据支持程度，Ease 为相对易实施度。分数用于排队，不替代门禁；P0 安全项即使 ICE 不最高也必须先做。

| 排名 | 工作项/问题 | Impact | Confidence | Ease | ICE | bucket | 产品理由与依赖 |
|---:|---|---:|---:|---:|---:|---|---|
| 1 | canonical→legacy 品牌组合关系与冲突盘点/数据库约束 | 10 | 8 | 5 | 400 | Must-do / Enabler | 先阻断跨品事实，后续回填和切读才有可信边界；依赖冲突清单与回滚方案 |
| 2 | workspace 级一致性门禁、状态指标和可检索审计 | 10 | 8 | 6 | 480 | Must-do | 没有 `verified/conflict/blocked` 的可观测结果就不能判断哪个 workspace 可切读；应先于大规模回填 |
| 3 | safe backfill：canonical→listing→campaign item→task | 9 | 8 | 5 | 360 | Enabler | 只填可证明关系，幂等、可暂停、可重跑；为 shadow read 提供输入 |
| 4 | 关键业务路径 canonical read adapter 与发布前唯一 listing gate | 10 | 7 | 4 | 280 | Must-do | 当前 task、规则预检、映射和发布仍有 legacy 旁路；这是客户实际感知的主链闭环 |
| 5 | shadow read / 双向 hash 校验与两周期稳定门禁 | 9 | 7 | 5 | 315 | Must-do | 验证 facts、listing fields、scope、版本和 context hash 一致，防止静默漂移 |
| 6 | workspace 级 cutover 开关、审计、回滚和旧投影 outbox | 10 | 6 | 3 | 180 | Must-do | 影响面大、实施成本高；必须在 1–5 完成后逐 workspace 灰度 |
| 7 | 真实 PostgreSQL/RLS、对象存储、平台回读、计费与发布 canary | 10 | 6 | 3 | 180 | Must-do / Release gate | 没有真实证据不能称上线；应跟随每个切读批次验证 |
| 8 | legacy API 输入兼容适配器与迁移期告警 | 7 | 8 | 7 | 392 | High value | 降低迁移期客户端破坏性，但不能绕过唯一 verified listing gate |
| 9 | 迁移报表、运营处理队列和人工冲突工作台 | 8 | 7 | 5 | 280 | High value | 让 `legacy_only/conflict/blocked` 可被处理，而不是沉入数据库；依赖状态审计 |
| 10 | legacy 表/字段退休与最终清理 | 6 | 9 | 2 | 108 | Defer | 只有所有 workspace 切读、历史任务终态和审计保留完成后才允许另立变更；当前不做 |

### 2.3 必须先验证的 leap-of-faith 假设

1. **身份可证明**：现有 legacy product 能通过显式 ID 和 scope 映射到唯一 canonical/listing，而不是依赖模糊匹配。验证物是按 workspace 的冲突报告，冲突不能被自动吞掉。
2. **双链可持续一致**：canonical facts、listing fields 和 legacy 兼容投影在真实写入/重试/并发条件下能保持可解释的一致性。验证物是连续两个 shadow 周期的 hash/版本证据。
3. **切读可回滚**：切换 canonical read mode 后，即使标准写入、旧投影、对象存储或平台回读失败，也能停止新发布并回到兼容读，不删除标准数据。验证物是带操作者、版本、时间和受影响 workspace 的演练记录。

## 3. Canonical 链路完成定义（Definition of Done）

以下条件必须全部满足；“部分满足”不得迁移文档。

### A. 数据与身份

- [ ] 每个可进入生产任务的商品都具备：`workspace_id`、`brand_id`、唯一 `canonical_product_id`。
- [x] 每个可发布的平台/店铺目标都具备唯一 `listing_id`，并能校验 `workspace + brand + canonical + platform + platform_account` 五元组。（本地 L2：`d936ed6` 事务/advisory-lock 与唯一性测试，`171e8fc` 精确发布目标测试；不代表全量数据已清理。）
- [ ] `campaign_item` 的生产目标是 `listing_id`；`legacy_product_id` 仅作追溯字段，不作为发布主键。
- [ ] canonical→legacy 的品牌组合关系有数据库级约束或等价的事务性校验；冲突数据在约束验证前已列出并有处理结果。
- [x] 未绑定或多绑定记录不会被自动猜测、覆盖或伪造为 `planned-listing:*` 生产身份。（本地 L2：`1418a10` 歧义 listing 阻断、`171e8fc` 精确目标校验及 canonical consistency 测试。）

### B. 一致性与迁移

- [x] 对每个 workspace 运行只读一致性检查，报告包含 `verified`、`legacy_only`、`conflict`、`blocked` 数量、稳定错误码和实体 ID。（本地 L2：canonical consistency coverage/report 测试；尚无真实 workspace 全量结果。）
- [x] `listing`、`campaign_item`、`task`、`publish_job` 的孤儿关系单独报告，不因从 legacy product 出发而漏报。（本地 L2：`629d05f` queue 作用域/孤儿过滤与 consistency 测试。）
- [ ] 所有活跃可发布对象和待执行任务均为 `verified`；`legacy_only/conflict/blocked` 数量为 0，或明确不在本次切读范围并被发布门禁阻断。
- [ ] backfill 具备 dry-run、幂等重跑、暂停/继续、批次审计和失败重试；只写入可证明关系，不覆盖人工维护字段。
- [ ] canonical facts 与 legacy 兼容投影、listing 与旧平台字段、task/campaign 五元组、版本/context hash 均有可重放的比较证据。

### C. 业务链路

- [ ] 新建商品、listing、campaign、task、内容生成、规则预检、发布准备和计费关联使用统一 canonical scope。
- [x] legacy `product_id` 兼容请求必须先解析到唯一 `verified listing`；0 个或多个候选均 fail-closed，并返回可修复错误。（本地 L2：`171e8fc` 精确 platform/account listing 目标、`1418a10` 多绑定阻断、`629d05f` queue 过滤测试。）
- [x] worker 不得绕过 API execution gate；执行、用量、发布回执至少可追溯到 task、campaign item、canonical、listing 和 context hash。（本地 L2：`6378205` receipt/usage trace 测试及既有 execution binding 回归；未证明真实 worker/平台链路。）
- [ ] 新任务读取 canonical facts，平台字段读取 listing，店铺身份读取 platform account；历史任务继续读取冻结快照。
- [ ] 标准链写入与旧投影同步失败有 outbox/retry/reconciliation，且不制造“已发布但来源不明”的成功状态。

本轮核对说明：以上勾选仅表示已有本地 L2 代码/测试证据，不等同于预发布或生产完成。真实 workspace canary、生产 PostgreSQL/RLS 攻击矩阵、全量 backfill（含 unresolved 处理与重试）以及 shadow/cutover 前后指标仍未完成，原因是当前缺少真实 workspace 数据、目标环境和可审计运行证据；相关条目必须保持未完成。

### D. 权限、真实环境与发布

- [ ] workspace、brand、platform account 的跨租户和跨品攻击矩阵在真实 PostgreSQL/RLS 下通过。
- [ ] 至少一个真实 workspace 完成标准链 create → task → context snapshot → generation/content → publish preflight → receipt/usage 的端到端 canary；不能用 fixture 代替。
- [ ] 对象存储、模型中转、平台 OAuth/回读、计费和发布均有 request ID、用量/成本、错误和回滚证据；配置缺失必须 fail-closed。
- [ ] API/MCP、worker、数据库迁移、告警、备份恢复和发布门禁均在目标部署环境 healthy。
- [ ] 有切读前后指标、审计日志、release ID、commit/image digest、操作者、workspace、时间和回滚演练记录。

## 4. 完成度分级（对外口径）

| 级别 | 名称 | 必须满足 | 可否写入 `doc/done` |
|---|---|---|---|
| L0 | 设计/审计 | 有目标链、风险、数据契约和未完成项 | 否，留在 `doc/todo` |
| L1 | 代码骨架 | 表、接口、纯函数、内存测试或静态契约存在 | 否 |
| L2 | 本地可验证 | 类型、单测、API 测试、迁移测试和本地容器验证通过 | 否；只能标“本地通过” |
| L3 | 预发布闭环 | 真实 PostgreSQL/RLS、worker、对象存储、模型中转/平台沙箱、双周期 shadow 和故障演练通过 | 否，除非项目定义将预发布作为完成且生产门禁另列；本项目不采用该口径 |
| L4 | 生产可上线 | 所有 DoD、真实 canary、发布门禁、回滚和审计证据通过 | 是，且文档状态改为 `DONE` |

当前依据：一致性纯函数和 MCP dry-run 已属于 L1/L2 能力；关键应用读取源仍有 legacy 旁路，生产第三方证据不足，因此不是 L3/L4。

## 5. TODO → DONE 迁移规则

### 5.1 允许迁移的必要条件

只有当同一个功能 TODO 文档的所有验收项均有证据时，才允许迁移；不能因为“代码已经存在”或“测试绿色”提前移动。

迁移前必须在原 TODO 文档补齐：

1. 完成日期、实现范围和明确的非目标。
2. 代码、migration、API/MCP 契约、测试、运行环境和监控证据链接。
3. 每个 workspace/批次的状态、冲突数、阻断数和未覆盖范围。
4. 真实环境的 release ID、commit、镜像 digest、数据库迁移版本和 canary 结果。
5. 回滚演练结果及遗留风险；遗留风险若会阻止安全发布，则不能迁移。

### 5.2 迁移动作

- 将**已完全满足** DoD 的文档从 `doc/todo/data/` 移到 `doc/done/data/`，保留原文件名和历史证据。
- 在文档顶部增加 `状态：DONE / L4 / 可上线`，并注明迁移日期。
- 在 `doc/todo/data/` 增加一条指向 done 文档的迁移索引，避免旧引用失效；如果项目的目录规则要求 todo 文件完全消失，则在 `doc/README.md` 保留唯一索引。
- 同一功能若只有一部分完成，不拆成“假 done”；继续留在 todo，并将已完成子项与剩余门禁分开记录。
- 迁移后运行文档链接检查、CodeGraph 同步、全量测试、发布门禁和目标环境健康检查；任一失败都回退文档状态，不回退或删除业务数据。

### 5.3 禁止迁移的情形

- 只有内存仓储、fixture、源码契约测试或本地 Compose 证据。
- canonical 一致性报告存在 `legacy_only/conflict/blocked`，但没有明确不在范围内且被发布门禁阻断。
- 关键路径仍能直接从 legacy Product 读取并执行生成/发布。
- 真实 Relay/API Key、图片/文本模型、对象存储、平台账号、计费或告警配置缺失。
- 只完成 backfill 但没有 shadow read、双周期稳定、切读回滚或历史快照保护证据。
- 为了通过门禁删除数据、清空 legacy 字段、重写历史 snapshot、伪造回执或删除 `docs`/`todo` 记录。

## 6. 当前状态与下一步验收队列

| 阶段 | 当前状态 | 下一项可交付结果 | 完成后再做什么 |
|---|---|---|---|
| 冲突盘点与组合约束 | TODO | workspace 级冲突清单、非破坏性约束方案和回滚脚本/演练 | 才能批准 safe backfill |
| safe backfill | TODO | dry-run 与幂等回填报告，所有 unresolved 进入人工队列 | 才能开启 shadow read |
| shadow read/一致性门禁 | 部分已有只读报告 | facts、listing、scope、版本 hash 的连续检查与阻断指标 | 才能选择 workspace cutover |
| canonical 业务切读 | TODO | task/规则/发布/计费路径不再绕过 canonical scope | 才能进入预发布 canary |
| workspace cutover/rollback | TODO | 开关、审计、灰度、回滚演练和旧投影补偿 | 才能做生产 canary |
| 生产上线 | NO-GO | 真实依赖、真实 canary、发布门禁和证据包 | 全部通过后迁移 `doc/done/data/` |

## 7. 审阅依据

## 2026-08-31 执行门禁增量

- 发布 worker 的 `GET /v1/publish-jobs/:id/execution-check` 与媒体读取接口现在在返回平台凭证或媒体前，重新读取当前 canonical product/facts/listing/read mode，并复用任务 scope 校验；canonical mapping、facts、唯一 listing 缺失或 scope 漂移时 fail-closed，不能仅凭旧 `canonicalBinding` 执行。
- API E2E `53/53`、application service `109/109`、TypeScript 和差异检查通过；该证据仍为本地/fixture，真实平台 connector、生产 RLS、正式宿主和 canary 未完成，因此仍不得迁移到 `doc/done`。
- 任务派生动作补齐同一门禁：`task.sku.split` 与同商品/同平台/同店铺的 `task.clone` 在创建新任务前重新解析当前 canonical scope；若 read mode 已要求 canonical 或 listing/facts/scope 发生变化，则 fail-closed，不复制过期绑定。API 相关回归 74/74、TypeScript 通过。

- [商品数据链与需求矩阵架构审计](architecture-data-chain-audit-2026-08-29.md)：指出 legacy Product 仍是多个关键路径的事实源，canonical→legacy 品牌组合约束和切读未完成。
- [Canonical 一致性报告](canonical-product-consistency-report-2026-08-29.md)：定义了 `verified/legacy_only/conflict/blocked` 和只读、不可猜测的检查口径。
- [Canonical 切读设计](canonical-product-cutover-design-2026-08-29.md)：定义 expand → backfill → shadow read → consistency gate → cutover → retire，以及历史快照和回滚边界。
- `packages/application/src/canonical-product-consistency.ts`：当前只读一致性判定的稳定状态与错误码实现。
- `packages/persistence/src/canonical-product-backfill.ts`：当前只计划和写入可证明的 canonical product 映射，不能据此证明 listing/task/campaign 已完成切读。
- `apps/api/src/server.ts`：存在 `canonical.product.consistency` 与标准批量目标校验，但仍保留 legacy 兼容路径，不能据此宣称统一主源已完成。
- CodeGraph 当前索引：755 files、11,306 nodes、46,731 edges；存在 1 个 pending modified file，不能把索引状态写成完全 clean。

**产品最终结论：本文件定义完成和迁移门槛，不代表功能已完成；在 L4 证据齐全前，所有 canonical 数据链文档继续保留在 `doc/todo/data/`。**

## 2026-08-31 真实 workspace 冲突复核

- `ws_demo` 仍有历史任务与商品平台账号不一致（`TASK_ACCOUNT_MISMATCH`）。现有 backfill remediation 仅安全支持 `MISSING_BRAND`，因此本轮不伪造修复结果、不直接改任务或标记冲突已解决；需先补充任务级 remediation 契约，或由运营确认后通过新任务承接执行。该项继续阻断 shadow/cutover，Canonical 仍为 `TODO / NO-GO`。

## 2026-08-31 执行增量

- 新增 migration 099 `canonical_legacy_brand_integrity`：旧 `products.data.brandId` 通过生成列投影为 `brand_id`，并以 `NOT VALID` 复合外键阻断新的跨品牌 canonical 映射；历史记录不被重写。
- 本地 Compose 已真实升级到 migration 099，约束/索引存在；本地冲突探针为 0 条，迁移测试 44/44、发布门禁 320/320（另 6 项跳过）通过。
- `readyz` 当前返回 PostgreSQL/Redis ready，但 MCP 未携带有效 Bearer token 时返回 `UNAUTHENTICATED`，说明鉴权门禁生效；同一运行态仍明确报告五模态 API key 缺失、六平台未配置和生产 evidence 未配置，因此不能迁移为 L4。
- 下一项仍是历史冲突清单与 canonical 业务切读，不执行未经生产数据与回滚证据支持的全局 `VALIDATE CONSTRAINT`。
- 2026-08-31 实现增量：`canonical.product.read_mode=canonical_read` 已从标题优化扩展到 `task.create`。无唯一 canonical 映射或 canonical facts 缺失时返回稳定 409；补齐唯一 canonical product、facts 和 listing 后，任务创建结果携带 `brandId/canonicalProductId/listingId` scope。API/application 定向回归 57/57、TypeScript、差异检查和 CodeGraph 通过。批量任务、发布准备、真实 workspace 连续 shadow 与生产 RLS 仍未完成。
- 2026-08-31 实现增量：单个和批量 `publish.prepare` 已接入动作前 canonical scope 复核；当前 `canonical_read` 下会重新校验唯一 canonical product、facts、listing 及任务的 product/platform/store/listing 绑定，历史任务不能凭旧 binding 直接进入发布预览。API 相关定向回归 57/57、TypeScript、差异检查和 CodeGraph 通过。真实平台回读、连续 shadow、生产 RLS 和发布 canary 仍未完成。
- 2026-08-31 真实 workspace 复核：`ws_demo` 仍有历史任务与商品平台账号不一致（`TASK_ACCOUNT_MISMATCH`）。现有 backfill remediation 仅安全支持 `MISSING_BRAND`，因此本轮不伪造修复结果、不直接改任务或标记冲突已解决；需先补充任务级 remediation 契约，或由运营确认后通过新任务承接执行。该项继续阻断 shadow/cutover，Canonical 仍为 `TODO / NO-GO`。
- 2026-08-31 实现增量：`task.clone` 已支持同商品账号漂移的显式 fresh-task 承接；`target_account_id` 现在会触发 Canonical scope rebind，定向回归 180/180、TypeScript、CodeGraph 通过。该动作不修改原任务，不能减少现有历史冲突计数；生产 OIDC、真实平台店铺确认、连续 shadow 与 canary 仍未完成。
