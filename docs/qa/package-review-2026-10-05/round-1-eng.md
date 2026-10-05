# 工程评审第一轮

日期：2026-10-05；角色：gstack plan-eng-review 原生 GPT 工程 reviewer；目标：套餐与权益包 PRD §1–15。读完技能与 review-sections，依 autoplan 跳过重复 preamble、交互提问、独立外声、日志及总报告注入；外声与总报告由 owner 执行。本报告只读源码与既有测试，没有实施、支付、生产访问或运行数据库测试。

## Step 0：Scope Challenge

接受现有范围，建议沿用目录、订单、点数、订阅及 outbox，不建立第二套销售账本。用户要求的可调价、六个月每月 500 点、首期另付、按剩余期升级、人工转账代购是固定前提。尊享额度和新增周期价格属于上架前必填批准参数，不猜值、不再作为产品方向未决项。

重写全商业模块会同时扰动私测协议、退款和模型准入，收益不足以抵消迁移风险。最小结构变更是销售投影、可复用权益包、升级事实和收款分配账；已有不可变合同继续履行。本阶段交付需求审查，不以审批文档代替真实可用性。

## 1. Architecture Review

现有层次可以保留：UI 调 API/MCP，应用服务解析业务意图，仓储在 Workspace 事务中写事实，worker 消费 outbox。目录是平台全局数据，订单与权益是租户事实，不能为了方便解析而开放租户直接写全局目录。首购依赖、当前升级与未来续期边界、晚核验和未分配款退回已在 PRD 明确，不重报。

```text
Ops Desktop / Merchant Desktop / local stdio plugin
                    |
             API/MCP schema + actor/workspace authorization
                    |
         shared Commercial Purchase / Ops Purchase service
                    |
     +--------------+------------------------------------+
     | same DB transaction, one tenant context           |
     | server-sale function -> locked current sale       |
     | checkout + immutable per-line order snapshots     |
     +--------------+------------------------------------+
                    |
         trusted payment evidence / bank receipt
                    |
     +--------------+------------------------------------+
     | receipt availability lock + Workspace lock         |
     | allocations -> dependencies -> paid facts          |
     | current period revision / upgrade event            |
     | grants + schedules + access revision + audit       |
     | durable outbox                                    |
     +--------------+------------------------------------+
                    |
        lease/cursor/retry worker -> bounded notifications
                    |
     read current entitlement -> authorization -> relay readiness
```

### E1：建单原子性必须同时满足目录最小权限 [P1，confidence 9/10]

源码依据：`commercial-purchase-service.ts:37` 为 `const sku = await this.catalog.resolveApprovedExecutableSku(...)`，`:48` 才调用 `this.orders.createFromServerSnapshot(...)`；`commercial-contract-repository.ts:514` 才进入 `withWorkspaceTransaction`。真实部署权限测试 `commercial-contract-repository.release.postgres.test.ts:115–127` 执行目录表 `REVOKE ALL` 后，仅给 merchant_app 最小 projection 的 EXECUTE。PRD §6/9要求下架与下单遵从事务顺序，但尚未明确新销售投影的事务解析及最小权限契约。

若建单继续依赖事务外快照，下架先提交后仍可能生成新单；若直接给 merchant_app 全局 SELECT/FOR UPDATE 则破坏既有权限边界。推荐 E1A：在建单事务中，通过限定函数重读当前销售状态、锁投影、验证批准版本/资格并生成快照，目录切换取得冲突写锁；复用 security-definer projection 模式并固定 search_path、拒绝 PUBLIC EXECUTE、最小返回字段。E1B：扩大应用角色权限虽简单，但引入更宽读取/修改面且违背项目边界，因此不推荐；两种方案是架构类型选择，不打覆盖分。

最小正文补丁（§6/8）：

> 新单、首购明细与报价转订单在同一 Workspace 事务内通过受控销售解析函数复核当前在售状态并锁定销售投影，保持锁至订单快照提交；上/下架和版本切换使用与之冲突的投影写锁。商家应用角色保持禁止直接访问全局目录事实表，函数固定 search_path、最小 EXECUTE、校验当前企业和商品可见性。测试必须在 migration 加真实 role bootstrap 后验证，新单与停售分别先提交时只出现对应合法结果；旧有效订单核验不重新依赖当前销售状态。

### E2：收款分配、返款与权益事务需统一锁序 [P1，confidence 8/10]

源码依据：`commercial-contract-repository.ts:638` 先对订单 `FOR UPDATE OF o`；`:284` 才通过 `pg_advisory_xact_lock(...,'workspace_subscription_periods_v2',workspaceId)` 串行账期；`:720` 后续锁创意点 access-state。现有注释 `:276–283` 已明确：不存在的账期行不能靠 row lock 防止并发重叠。PRD §13/14新增一个收款分配多订单、并发分配与 receipt-return，已有“并发保护”尚未规定统一锁序及余额重检位置。

真实收款去重现有证据：migration `153_commercial_contract_facts.sql:180–181` 仅规定 `UNIQUE (provider, provider_event_id)` 和 `UNIQUE (provider, nonce)`；`commercial-contract-repository.ts:680–681` 查询 `WHERE provider=$1 AND provider_event_id=$2`。这是可信 provider 回调事件幂等的基础，不能代替新增人工收款账的真实外部流水唯一性；若内部 event id 可重新生成，同笔银行款仍需外部来源/收款账户/流水号约束。该点归入 E2 收款余额守恒，不额外增加第四个 finding。

推荐 E2A：统一一个锁序，目录销售投影按 SKU 排序→收款可用余额按真实流水身份排序→Workspace 级事务锁→checkout/订单按 id 排序→当前账期→创意点状态，并让返款/退款/赠点路径采用兼容顺序。总分配加已退回及待退回冻结金额不得超过实收；审批返款即冻结可返余额，外部返款请求不在长数据库事务内执行。E2B：每条路径独立加锁会产生倒序死锁和审批后被再次分配风险，维护成本更高；推荐 E2A，human 1–2 天 / CC 1–2 小时，涉及真实并发及故障测试。

最小正文补丁（§13.2/14）：

> 冻结统一锁序并让所有调用遵守：目录销售投影（SKU 排序）→真实收款余额（外部来源/收款账户/流水身份排序）→ Workspace 事务锁 → checkout/订单（id 排序）→当前账期/权益版本→点数状态；不使用空结果 row lock 代替 Workspace 序列化。分配、已退回与待退回冻结额共同参与可用余额守恒，真实收款以可信外部来源+规范化收款账户+外部流水号全局唯一，不能通过换内部 id、幂等键或目标企业重复登记同笔款；同身份内容不一致转对账冲突，不增加可分配金额。返款审批先冻结余额，失败通过受控事件解冻，重复调用复用同一返款意图。外部返款及通知在事务外执行；遇可重试数据库冲突先查原幂等结果再有限重试，不另建业务意图。跨企业批次不得在持锁过程中切换租户上下文。

纯目录操作只锁销售投影，不再回头锁企业。无收款的建单跳过收款锁，支付授予旧单跳过销售锁；未匹配款登记/核验只锁收款，不涉及企业时跳过 Workspace；后续匹配按统一序列取得收款锁再取企业锁。凡历史退款/到期/赠点 worker 与新路径共享锁，按实现时调用图核对兼容顺序，不能只给新增方法加锁。

### 安全、分发与单点

`repository.ts:601–604` BEGIN 后用事务局部 `set_config('app.workspace_id',scope,true)`，继续复用，平台运营代购也必须指定企业而不能切换商家会话。新分配/返款/通知表需要租户外键、FORCE RLS、最小授权与 bootstrap 后回归，未匹配收款属于受限 Ops 队列，不可被普通商家枚举。没有新二进制、市场或外部分发渠道；API、worker、两端桌面应用和本地 stdio 插件按现有构建/镜像/runbook 更新，expand/兼容迁移与关新写回滚已有需求。

## 2. Code Quality Review

没有新增产品需求缺口；已有必须实现的问题均已在 PRD §2.1/4/6列明。建议用共享 schema 与显式类型表达 SKU、周期、benefit、rank、升级报价和人工分配，不把底层自由 JSON 或 request-local snapshot 当长久权限证明。订单快照应是完全展开且校验后的契约，checksum 覆盖价格、周期、全部权益和关联政策，不只 payload。

复用 `CommercialPurchaseService` 的意图入口与 `PostgresCommercialContractRepository` 的事务写入，但业务状态分支由明确服务区分首购/续期/升级/独立包，避免升级继续映射 monthly。复用点数账本和持续权益唯一 authoritative snapshot；升级修订期间保留消耗、预留和来源，worker 继续按批准政策执行重检。错误统一业务 code、可恢复 next_actions 和请求标识，金额/receipt-return 不通过客户端计算或手工改状态实现。

现有错误测试 `commercial-catalog-repository.test.ts:49` 为 `expect((await repository.resolveApprovedExecutableSku('growth')).version).toBe(3)`，在 retire 后仍通过。应改为停售拒新单、有效旧订单仍履约的两条测试，并加 PostgreSQL 对应实现；这已是已知需求，未计作本轮新缺口。复杂服务应保留销售投影/付款分配/账期修订状态图注释，历史续期 gap-lock 注释依然正确，不在重构时删除。

## 3. Test Review

项目测试框架为 Vitest + TSX 安全测试 runner，浏览器层 Playwright/gstack browse；证据来自 package.json 脚本和被读取测试的 `import { describe, expect, it } from 'vitest'`。现有 37 项通过是此前 owner 的五文件单元/fixture 运行，不是本 reviewer 重跑。PostgreSQL release 测试已有源码但依赖 `PERSISTENCE_RELEASE_DATABASE_URL`，没有环境时 `it.skip`，本轮未运行，不声称数据库 E2 通过。

下图按“行为组”而非逐代码行计数；尚未实施的功能无法声称完整分支覆盖。已有 6 组局部行为有可读测试，14 组新目标测试缺口，20 组总计；这些缺口属于实施验收要求，不等于 14 个新需求未决项。implementation 必须逐新增 if/guard/error 补分支矩阵，不能用此 30% 行为组比例当源代码覆盖率。

```text
CODE PATHS / PLANNED USER FLOWS                         EXISTING / NEW
1 Catalog read private/approved/type guard               [★★★] unit catalog + purchase-service
2 Catalog write create/approve/publish/retire/archive     [GAP] bad retire assertion; [→E2E] PostgreSQL parity
3 Sale reader <-> retire/publish ordering                [GAP] [→E2E] controlled concurrent commits + bootstrap
4 Bundle expand/version/freeze/invalid consumer          [GAP] schema/unit + [→E2E] old order unchanged
5 Shared intent -> immutable order snapshot              [★★★] contract unit:51 + purchase-service:13
6 First checkout onboarding + partial allocations       [GAP] [→E2E] two paid lines/dependency/replay
7 Eligibility/RBAC/tenant scope                          [★★★] unit guards; NEW Ops/RLS extensions [→E2E]
8 Payment mismatch/idempotent transactional grant        [★★★] contract unit:135,158; PG source:17 (not run)
9 Receipt split/merge/overpay/return freeze               [GAP] [→E2E] allocation vs allocation/return
10 Ordinary month boundaries/stack renewal               [★★★] unit:242; PG source:75,372,447 (not run)
11 New approved cycles/monthly release/expiry workers    [GAP] clock-driven [→E2E], unsupported policy rejects
12 Onboarding schedule exactly 6 × 500                   [★★★] contract unit:269; replay and UTC
13 Mutable price v1/v2 order/quote confirmation          [GAP] [→E2E] all 3 price types old/new + UI reconfirm
14 Upgrade price rational math/time/rank/chain           [GAP] pure unit property/boundaries/half-cycle
15 Upgrade period revision/increments/reservations       [GAP] [→E2E] no overlaps/no second target grant
16 Late verified quote/end/stale source/money resolution [GAP] [→E2E] paid-pending-disposition, no silent loss
17 Publish outbox -> notifications audience/dedup/read   [GAP] [→E2E] retry/relist/member removal/page cursor
18 All UI loading/empty/error/409/unknown/resume           [GAP] [→E2E] desktop 1440×900/200%/keyboard
19 stdio/HTTP/MCP/worker same allowance/zero side effect  [GAP] [→E2E] configured relay + auth/usage/cost receipts
20 Expand/migrate/rollback and old paid fulfillment      [GAP] [→E2E] mixed versions fenced, workers continue

20 groups: 6 have partial existing evidence, 14 GAP; existing tests do not prove new contracts.
★★★ means read tests exercise behavior, edges/errors; PG references mean available source only.
No prompt/content-generation algorithm change: no new LLM-quality eval requirement;
relay auth/usage/cost and commercial gating require runtime evidence, not quality evals.
```

具体新测试：catalog sale concurrency/role parity 放 `commercial-catalog-sale.release.postgres.test.ts`；包与周期 schema 放 `commercial-catalog-repository.test.ts`/新 `commercial-benefit-bundle.test.ts`；首购分配/返款锁放 `commercial-receipt-allocation.release.postgres.test.ts`；upgrade pure math 放 `commercial-upgrade-quote.test.ts`，原子切换放 `commercial-upgrade.release.postgres.test.ts`；notification 放 `commercial-catalog-notification.e2e.test.ts`；两端流程使用现有桌面 Playwright runner 新 spec。名称为拟定实施位置，不宣称文件已存在。

CRITICAL 回归必须涵盖：有效旧单下架后可核验、新单拒绝；改价历史快照不变；已付未来续期保留；升级不重复给目标全额点；开通不重启 6 月赠点；共享 access revision 下旧预留不清空；多企业处理不跨 RLS；回滚新写关闭但旧单履约及 worker 继续。这些是修改已有流程后必须满足的行为，测试随实现加入。另对触发 grant/outbox 前后插入故障点断言事实守恒与同键恢复，未知响应必须查询原结果。

QA artifact 已单独保存到报告目录的 `eng-test-plan.md` 及 owner 指定的 `~/.gstack/projects/codexSkills/lixiaomei-main-test-plan-20261005.md`。真实 E2 测试应使用项目隔离 PostgreSQL runner，严格针对自动生成测试数据库；不直接在用户业务库改目录、插款、删数据。浏览器与本地 stdio Plugin 验收使用授权环境，不用 fixture 或静态组件存在替代。

## 4. Performance Review

销售查询应以当前投影 join 批量版本/权益包快照，避免每个列表行查历史及每项权益一次 query。包展开设定无环、最大数量和内容体积 schema 上限，目录/订单/异常队列分页，不能把全部历史读入 React。缓存以版本/revision 为键且只用于展示，写前事务验证不信任缓存可售性；可用量及资格不能长期共享缓存造成越权。

### E3：通知 fan-out 与管理页需明确工作量边界 [P2，confidence 8/10]

证据：PRD §12.2“由同事务 outbox 产生发布事件，再可靠投递商家站内通知”定义可靠性，但无每事务投递工作量及容量验收；§4仅要求分页，无列表或 worker 的硬限。现有 `commercial-contract-repository.ts:394` 已使用 `LIMIT $4` 与 cursor，可复用该分页模式。没有客户规模/生产延迟测量，不虚构线上瓶颈或吞吐数。

推荐 E3A：发布事务只产生事件，由租约 worker 分批 fan-out（可配置且有服务端硬上限），写持久 cursor/收件人唯一键；列表服务端限制 page size，fan-out 故障不会锁住目录交易。E3B：一次拉全体用户投递虽实现短，但大租户可能超时、重复投递且无法恢复游标，因此不推荐。首期工程建议列表默认 50/最大 100、通知批次最大 200；这是可调运行限制，不改变商品权益数值，实施时记录真实容量与延迟验收证据。

最小正文补丁（§12.2/14）：

> 发布事务只记录一次 outbox 事件，不遍历全体收件人；租约 worker 按持久 cursor 分批投递，每批有服务端硬上限（首期最大 200），失败续跑不得漏/重发，成员/可见性逐批重检。列表默认 50、服务端最大 100，历史/异常/通知采用稳定游标；上线记录目录、建单、分配事务耗时、锁等待、通知 backlog/最老消息、赠点延迟及容器容量证据，不以健康 200 代替性能验收。具体并发/容量通过现有生产门禁批准负载，不猜真实客户数。

## What already exists / reuse

| Existing | Reuse | Required change |
|---|---|---|
| FinancePage catalog editor | 同入口与组件 | 在售+草稿双状态、共享 schema、真实权益/周期字段 |
| catalog tables / events | 不可变历史及批准内容 | 新销售投影/独立包，PG与内存语义一致 |
| CommercialPurchaseService | 共享意图入口 | 同事务销售解析、首购依赖、显式升级 |
| contract repository / Workspace transaction | 快照、支付与授予事务 | receipt allocations、统一锁序及 period revision |
| creative point ledger/lifecycle | 消耗、预留、到期、赠点 | 补增量与月发放政策，保留旧来源 |
| approved/refund flow | 已付订单退款/补偿 | 未分配款单独 receipt-return，不伪造订单 |
| commercial transfer verification Ops client | 支付核验入口 | 指定客户开户/代购与分配摘要 |
| outbox and existing worker infrastructure | durable after-commit delivery | audience cursor/fan-out/dedup/死信查询 |
| local plugin/Bridge + release gates | 原有入口与门禁 | 同 Workspace 准入、真实中转证据及安全回滚 |

## Failure-mode registry

表中测试与救援是实施要求，除明确“既有局部”外尚未实现/运行；所有新增路径均有可见错误或状态设计，没有允许静默丢失的分支。

| Path | Real failure | Rescue/error | User visible | Evidence/log | Required test |
|---|---|---|---|---|---|
| 1 catalog read | DB unavailable | 明确 unavailable，禁新购 | 目录失败+retry | request/query cause | existing guards + DB outage |
| 2 catalog mutate | constraint/conflict | rollback，409 preserve form | 发布阻断/差异 | revision/idempotency/audit | PG publish/parity |
| 3 sale-to-order | retire wins before insert | transaction rejects new order | 商品已下架 | sale revision/order intent | E1 concurrent commits |
| 4 bundle expand | unknown/cyclic consumer | draft allowed, publish denied | 配置字段原因 | policy/checksum | invalid schema/old snapshot |
| 5 create order | response lost after commit | query original key | 结果待确认/原单 | key/hash/order | double submit/lost response |
| 6 first checkout | only subscription paid | no grant until onboarding | 已分配待依赖 | line/dependency/allocation | split/merge payment |
| 7 auth | membership removed | deny before external call | 权限不足 | actor/workspace decision | RLS/bootstrap/stdio |
| 8 payment grant | outbox insert fails | atomic rollback + same receipt retry | 待核验/待授予 | provider fact/order/key | injected DB failure |
| 9 receipt/return | concurrent spend same balance | common lock + freeze | 未分配余额/待处置 | receipt/allocation/return | E2 concurrent distribution |
| 10 renewal | simultaneous period insert | Workspace lock | future contract distinct | period/revision | existing PG source + extension |
| 11 cycles/worker | outage misses due grant | catch-up unique grant, original expiry | 赠点漏发 queue | schedule/due/lease | restart/month-end/expired |
| 12 onboarding | duplicate verify | one eligibility/unique six schedule | 开通完成 once | onboarding source | replay + multi order |
| 13 mutable price | price changed before payment | reconfirm server order | 更新提示+new amount | sale/snapshot versions | all 3 price types |
| 14 quote | rank/period/zero invalid | explicit blocked quote | 原因与续购/人工入口 | algorithm/rational time | unit math/boundary |
| 15 upgrade grant | source revision changes | paid disposition, no second grant | 已收款待处置 | quote/source/target | current+future concurrency |
| 16 late verify | original period ended | explicit financial resolution | 负责人/next step | paidAt/verifiedAt/end | no expired entitlement |
| 17 notifications | worker crashes mid batch | cursor/unique replay | pending delivery state | event/recipient/lease | E3 fan-out recovery |
| 18 UI | session/network unknown | preserve draft/original order | error/unknown/resume | request/order | desktop a11y/errors |
| 19 runtime guard | relay config missing | fail-closed, no model call | readiness blocker | auth/usage/cost/error | real configured relay gate |
| 20 deploy rollback | old instance bypasses projection | fence new writes, keep fulfillment | read/old order restored | candidate/version/gates | mixed-version rollback |

资金事实真实到账但授予事务失败时须保持可重试证据与待授予/待处置状态；DB整体不可用不能伪称已持久核验成功，恢复后按银行/可信 provider source 重建同一幂等意图。返款外部结果未知保持冻结及待核实，不按 timeout 判断未返款重新发送。日志保存受控证据引用，避免银行卡/密码/凭证正文。

## Implementation Tasks

任务是已有需求的工程实现与本轮补严，不是假装本轮改好了业务。仅任务 artifact，新 TODO 0，无理由为自助降级/自动扣款/新商城扩范围。

- [ ] **ENG1 P1，human 1 天 / CC 1 小时**：受控同事务销售解析、投影锁与 bootstrap 权限；源 E1；文件 commercial-purchase-service.ts、commercial-contract-repository.ts、新 migration、role bootstrap；验 E1并发/RLS。
- [ ] **ENG2 P1，human 2 天 / CC 2 小时**：冻结收款/Workspace/订单/权益锁序与返款余额冻结；源 E2；文件 commercial-contract-repository.ts、新 receipt repository、refund repository；验分配/退回并发、同笔流水换内部ID重录拒绝、失败恢复。
- [ ] **ENG3 P2，human 半天 / CC 30 分钟**：实现通知 lease/cursor/hard limit、所有列表分页与可观测；源 E3；文件 API/MCP catalog/notifications、worker、两端 UI；验批次崩溃/成员撤回/大列表。
- [ ] **ENG4 P1，human 2 天 / CC 2 小时**：实现14组新行为测试及CRITICAL回归；源 Test Review；拟定文件见 §3；验安全 runner/隔离 PG/真实桌面/std io/容器门禁。

## Implementation dependency / parallelization

| Step | Modules | Depends on |
|---|---|---|
| schema/consumer/policy contract | contracts, application | — |
| sales/receipt/upgrade persistence | persistence, application, API | frozen contract |
| Ops + Merchant presentation | ops-console, merchant-studio | frozen contract + APIs |
| notification/schedule workers | workers, persistence | persistence |
| runtime proof/migration gates | tests, infra, plugin | all above |

项目要求唯一主工作目录 main，不创建平行 worktree。工程落地按契约→数据库/应用→API→两端UI/worker→owner整合验证顺序；只读审查/契约验收设计可以并行，涉及同一持久化模块的写入顺序执行。不同 UI 模块理论可分 lane，但不以此建议违背项目约束或让未经 owner 复核 agent 直接合入。

## NOT in scope

- 自助降级、跨周期升级、自动扣款：本期已显式禁用，另需批准合同。
- 钱包、多币种、隐式余额抵扣：用户没有要求，收款异常走原付款方返款/新有效订单。
- 重写身份、退款、账本、全站设计：复用现有机制，避免侵入无关商业链路。
- 移动适配、公开插件市场、真实 ChatGPT OAuth：项目明确排除。
- 实际转账、为真实客户开通、发布生产：本任务是需求审查，验收需实施后真实证据。

## Completion Summary

- Step 0：scope accepted as-is。
- Architecture：2 个正文补严 finding（E1、E2），未计已在 PRD 的现存 bug。
- Code Quality：0 个新增需求缺口，既有需实现项已核对。
- Tests：图已产出，14 组新目标测试缺口、6 组现有局部证据；不声称100%源代码覆盖。
- Performance：1 个正文补严 finding（E3）。
- NOT scope / reuse / failure modes / tasks / QA artifact：完整写出。
- Failure modes：3 项相关设计开放，推荐补丁已给；其余由已明确政策和拟定测试覆盖；实际功能未验收。
- Outside voice：owner后续负责独立CLI，未声称Claude跨模型。
- Parallelization：主目录顺序实施，不开 worktree。
- Lake：推荐3/3完整选项，保留业务前提，未增加旁路功能。
- DURABLE LEARNING：role bootstrap 会收回目录直接访问权限，销售竞争锁必须保留 security-definer 最小投影边界；测试裸迁移权限不足以证明实际角色可用性。

**状态 DONE_WITH_CONCERNS：审查完成；正文补严 closed 0 / open 3。owner整合E1–E3后须独立复审。14组测试为实施门禁，不作为产品方向未决；无需用户再答尊享额度或新增周期值，缺值商品不可上架。**

owner同步：E1–E3已进入PRD §16，采用本报告收款先于Workspace的一致序列。本轮以审查时版本列open 3作为审计记录，修订后的实际closed/open由owner独立复审冻结。
