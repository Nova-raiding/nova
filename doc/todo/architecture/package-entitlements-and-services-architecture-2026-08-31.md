# 商家营销插件套餐、权益与服务履约架构设计

状态：架构评审通过，待实现；不代表已实现、可销售或可上线
版本：1.0
日期：2026-08-31
Owner：架构
上游需求：[套餐、权益与服务履约 PRD](../product/package-entitlements-and-services-prd-2026-08-31.md)

## 1. 结论

采用“不可变商业版本 + 订单/账期全量快照 + append-only 权益/资金/服务账本 + 运行时 readiness + 人工发布确认”的目标架构。现有订阅、支付、钱包、模型成本、存储配额、发布确认、工单、RLS、Outbox、Worker 和审计继续复用；套餐全权益、创作额度账本、版本化动作费率、订阅限制项、服务履约和 SLA 时钟作为新域建设。

本设计允许进入实现拆分，但当前系统与生产仍为 **NO-GO**。静态代码和架构文档不能替代真实 ChatGPT 插件、MCP、模型中转、支付、对象存储、六平台、权限、成本、容器健康与生产 canary 证据。

## 2. 约束与设计原则

1. 唯一真实路径：ChatGPT 插件入口 → Bridge/MCP → API application service → PostgreSQL/RLS/Outbox → Worker/真实外部依赖 → 商家工作流或桌面 Ops。
2. 桌面 Ops 是唯一运营配置面；手机和平板不进入设计或验收。
3. 客户端不推导价格、额度、费率、capability 或 readiness；所有事实由服务端版本/快照返回。
4. 发布后的 plan、rate、policy 和 ledger 不可原地修改或删除；变更只新增版本或冲正事件。
5. PostgreSQL 是并发、一致性和幂等最终边界；不得依赖单进程 Map 锁。
6. 外部鉴权、成本、回执或配置缺失时 fail-closed；不得直连未批准模型或回退 fixture。
7. 平台写入始终由一次性、绑定快照的交互确认票据授权；Worker 不拥有自主发布权。
8. 迁移只用 109+ expand migration；不改写 1–108，不删除业务/容器数据掩盖差异。

## 3. CodeGraph 与源码基线

2026-08-31 CodeGraph 只读快照覆盖 826 个索引文件；并行工作使 node/edge 数持续变化，因此不把易漂移计数写成架构基线。CodeGraph 只用于结构和影响面发现，所有结论已回到当前源码核对；索引或静态存在不作为运行成功证据。

| 现有能力 | 证据与可复用结论 | 目标缺口 |
|---|---|---|
| Commercial | `CommercialOffer`、订阅/订单/变更、revision、有效期 | Offer 仅覆盖价格、店铺、任务；缺全权益与不可变发布流程 |
| 旧任务权益 | `workspace_commercial_settings`、`workspace_usage_ledger`、consume/refund | 不是创作额度；无 rate/version/reservation/expiry |
| Add-on entitlement | `platform/image_generation/bulk_sync` grant/consume/refund | 无账期、快照、服务与结构资源语义 |
| 钱包与成本 | billing transactions、model usage、日预算、真实 usage/cost、action ledger | 缺与创作额度的双来源原子预占与统一 statement |
| 存储 | `StorageQuotaRepository` 原子 reserve/settle/release、物理删除证明、RLS | limit 来源不是不可变套餐快照；缺降级投影 |
| 发布 | prepare/confirm、intent hash、nonce、Worker 授权复核、unknown/reconcile | 保留安全链；只扩展 entitlement snapshot 校验和 UI |
| Support | ticket、assignee、event、revision、idempotency、RLS | 无 SLA policy/calendar/clock/breach |
| 平台/模型 | readiness、connector、relay gate、用量/成本证据 | 未形成套餐承诺投影；生产依赖仍未就绪 |
| Ops | Offer、钱包、账单、存储、support、audit 等页面 | 无版本化套餐/费率、权益实例、服务排期、SLA 队列 |

## 4. 范围和非范围

范围：商业目录、配置审批、订阅周期、权益快照与账本、品牌/店铺/主体/导入/存储准入、创作额度与钱包/成本关联、基础搭建、服务预约、SLA、readiness 投影、MCP/API、桌面 Ops、RLS/审计、迁移和上线门禁。

非范围：手机/平板、无人值守发布、通用 ERP 适配器、任意 DAG/低代码、私有化部署、人工代做营销素材、保证审核/GMV/ROI，以及把未通过生产证据的平台/模态标为可用。

## 5. 系统上下文与容器

```text
商家 / 平台运营 / 财务 / 实施 / 客服
                 |
     +-----------+------------------+
     |                              |
ChatGPT 插件/MCP App           桌面 Ops Console
     |                              |
     +---------- Bridge/MCP --------+
                    |
             API Application Layer
  +-----------------+-----------------------------+
  | Catalog | Subscription | Entitlement | Service |
  | Credit  | Wallet/Cost  | SLA         | Publish |
  +-----------------+-----------------------------+
                    |
        PostgreSQL transaction + RLS
   ledger / snapshot / audit / outbox / projection
                    |
        durable workers + lease + reconcile
  +---------+---------+---------+---------+--------+
  | Relay   | Payment | Storage | Scanner | 6 平台 |
  +---------+---------+---------+---------+--------+
```

信任边界：Bridge 只暴露批准的 merchant/Ops MCP；API 再做 capability 与 workspace scope；数据库强制 RLS；Worker 使用 service principal、保存授权快照并执行前复核；所有外部回执签名、nonce、防重放和幂等。

## 6. 领域边界与组件

### 6.1 Catalog & Configuration

- `OfferCatalogService`：plan draft/validate/impact/submit/approve/schedule/activate/retire。
- `RateCardService`：canonical action catalog、scope 解析、钱包价格引用、影响模拟和原子切换。
- `PolicyCatalogService`：服务、SLA、日历、readiness policy 的不可变版本。
- `ConfigurationApprovalService`：提交人与批准人分离、双人审批、revision、审计。

### 6.2 Subscription & Snapshot

- `SubscriptionActivationService`：支付成功后原子激活、period、完整 snapshot、首期 grant、audit、outbox。
- `SubscriptionRestrictionService`：来源订单/SOW restriction checklist，逐 capability 解限。
- `SubscriptionPeriodService`：月付与 legacy 年付周年锚点、续费、升级差额、暂停/恢复/降级。

### 6.3 Entitlement & Resource Admission

- `EntitlementLedgerService`：grant/reserve/settle/release/refund/expire/adjust。
- `ResourceQuotaService`：品牌、店铺、主体、首次导入 occupation 与并发准入。
- `StorageEntitlementAdapter`：把 snapshot limit 注入现有 StorageQuotaRepository。
- `EntitlementProjectionService`：余额、临期、超额、宽限和 next action。

### 6.4 Creative Credit & Money

- `CreativeCreditService`：最早到期点数 + 钱包不足额原子联合预占、真实回执结算。
- `WalletAdapter`：复用整数分账本、预算、退款；不把点数当货币。
- `ModelCostAdapter`：复用五模态 usage/cost receipt；缺成本禁止交付。
- `CommercialReconciliationService`：点数、钱包、模型成本和 action 日对账。

### 6.5 Human Service & SLA

- `OnboardingDeliveryService`：实施订单、checklist revision、证据、双边签署、warranty。
- `ServiceFulfillmentService`：allocation、booking、15 分钟结算、取消/爽约/跨期退款。
- `SlaClockService`：policy/calendar snapshot、pause/resume、merge/reopen、breach。
- `ServiceCapacityService`：负责人容量、冲突和销售 capacity gate。
- `OnboardingKnowledgeAdapter`：复用 Knowledge/Brand Asset repository，绑定偏好、来源、权利、视觉/表达版本与证据。
- `OnboardingRuleAdapter`：复用 Rule repository 的固定/品类/品牌/店铺/campaign 版本、审批、有效期和回滚。
- `OnboardingScanOrchestrator`：复用 Connector/Sync Worker，绑定平台 readiness、扫描游标、真实商品/店铺结果和外部回执；fixture/过期证据不能 passed。

上述 adapter 统一返回版本化 `evidence_ref + source/version/checksum + freshness/trust/conflict status` 并写入 checklist item。知识/规则过期、来源不可信/冲突、规则未批准，或扫描仅 fixture、游标未闭合、外部回执缺失时，item 只能 blocked，不能 passed/ready_for_acceptance/not_applicable；not_applicable 仅限订单明确排除且附合同引用。修复必须产生新 checklist revision，旧证据只读保留、不覆盖。

### 6.6 Runtime Safety

- `RuntimeReadinessProjection`：平台×能力、五模态、支付、存储、scanner 证据。
- 现有 `PublishPreparation/Confirmation/Execution/Reconciliation` 保留，只增加 snapshot/restriction admission。

## 7. 核心数据模型

### 7.1 全局商业目录与 workspace override

| 表 | 关键字段/约束 |
|---|---|
| `commercial_plan_catalog` | `id, code UNIQUE, name, status` |
| `commercial_plan_versions` | `plan_id, version, status, price_fen, billing_cycle, effective_at, checksum, revision`; `(plan_id,version)` unique；active 不可更新 |
| `plan_version_dependencies` | plan version + dependency kind/version/checksum；发布前要求全部 active 且兼容 |
| `benefit_definitions` | `code UNIQUE, kind, unit, value_type, schema_version` |
| `plan_version_benefits` | `plan_version_id, benefit_code, finite_value_json, policy_version_id`; unique |
| `rate_cards` / `rate_card_versions` | 只允许 global/plan/platform/plan+platform scope；status、currency/point unit、effective range、checksum |
| `rate_rules` | 全局 action、modality、unit、integer points、rounding、min/max、wallet_price_version；同级 scope/time 排斥约束 |
| `policy_versions` | service/SLA/calendar/readiness immutable payload + checksum |
| `configuration_approvals` | submitter、approver、decision、impact snapshot、reason；同人批准 check constraint |

以上全局表无 workspace RLS，仅 control-plane 写角色可修改。运行时 workspace role 只获授 security-barrier catalog view，可读取已发布版本及解析所需字段，不能写或读取审批敏感数据；control-plane 可另用 `commercial_catalog_reader` Repository。merchant client/DB role 不得直接 SELECT 基表，只能经 application service 得到本 workspace 已解析 snapshot。

Workspace override 独立为 `workspace_rate_card_overrides/workspace_rate_rules/workspace_configuration_approvals`，全部 `workspace_id NOT NULL + ENABLE/FORCE RLS + USING/WITH CHECK`。普通商家只经 statement 读取自己被解析后的规则，不枚举其他 workspace override。

费率解析优先级：workspace+platform > workspace > plan+platform > plan > platform > global。应用服务要求恰好命中一条，同级多条或 0 条 fail-closed；全局和 workspace 表分别用 exclusion constraint 阻止同级时间重叠。

### 7.2 Workspace 订阅和快照（RLS + FORCE RLS）

| 表 | 关键字段/约束 |
|---|---|
| `workspace_subscriptions_v2` | workspace、plan、status、previous_active_status、cancel_at_period_end、revision |
| `commercial_order_snapshots` | `workspace_id NOT NULL + order_id` unique、下单时完整权益、plan/dependency refs/checksum；immutable，支付时只引用/复制；RLS/FORCE |
| `workspace_subscription_periods` | subscription、start/end、billing anchor、plan version、natural key unique |
| `workspace_entitlement_snapshots` | period、full benefits JSON、所有引用 version/checksum、restriction revision；immutable |
| `subscription_restrictions` | source order/SOW、capability、status、acceptance ref、revision |
| `workspace_benefit_grants` | source、period、kind、amount、expires_at、plan/snapshot/rate refs、natural key |
| `workspace_benefit_ledger` | append-only event、delta、operation、grant/reservation link、version/checksum、idempotency |
| `workspace_benefit_balances` | 可重建 projection；不得作为审计事实源 |
| `commercial_operations` | operation header、intent/request hash、action、snapshot/rate refs、status、idempotency unique |
| `benefit_reservations` | operation、reservation header、total points、status、revision |
| `benefit_reservation_allocations` | reservation + grant、reserved/settled/released points；一笔 operation 可跨多个最早到期 grant |
| `wallet_holds` | operation、billing account、max amount_fen、settled/released amount、wallet pricing ref；严格不得超 hold |
| `operation_external_receipts` | provider request、usage/cost hash、verification、received_at |
| `restriction_checklists/items/events` | checklist revision/checksum/source order|SOW；item blocked capability/criteria/status/acceptance event |
| `legacy_capability_snapshots` | trialing 逐 capability allow/block、evidence ref、checksum、manual_attention |

订单创建在同一 workspace PostgreSQL 事务内经受限 catalog view 读取已发布版本，并原子写 order + `commercial_order_snapshots`；支付激活禁止按 current catalog 重算，只引用该租户快照生成 subscription snapshot。

### 7.3 资源、实施和服务

| 表 | 关键字段/约束 |
|---|---|
| `workspace_resource_occupations` | kind/resource/status/activated_at/snapshot/source checksum；workspace+kind+resource unique |
| `workspace_business_subjects` | jurisdiction、registration type、encrypted lookup hash、status；RLS |
| `onboarding_delivery_orders/items/signoffs` | checklist checksum、evidence level/ref、双边 signer、revision；evidence FK 到可信证据注册表 |
| `implementation_import_consumptions` | implementation order + kind + canonical identity unique、consumed_at、source checksum；删除不返还 |
| `service_allocations` | kind、period、minutes/count、reserved/settled、policy version |
| `service_bookings/events` | start/end、status、participants、evidence、idempotency、revision |
| `workspace_service_owners` | primary/backup、capacity、生效期 |
| `support_sla_policies/calendars` | immutable version；calendar dates |
| `support_sla_clocks/events` | ticket occurrence、deadline、pause duration、breach、policy/calendar checksum |

所有 workspace 表：`workspace_id NOT NULL`、FK、ENABLE/FORCE RLS、USING + WITH CHECK。ledger/event 对应用角色拒绝 UPDATE/DELETE；冲正只追加新行。金额整数分、点数整数、字节 bigint、时长整数分钟。

联合预占由 `CommercialUnitOfWork` 提供 transaction-scoped repositories；Credit、Wallet、Action、Audit 和 Outbox primitive 全部接收同一个 `SqlClient`。固定锁顺序：subscription/snapshot → grants（expires_at,id）→ wallet budget/account → operation/hold。禁止串联两个 `withWorkspaceTransaction` 冒充原子性。现有 billing debit 不能直接作为 hold：新增 capped `wallet_holds`，`settled_amount_fen <= max_amount_fen` 数据库约束；现有 billing transaction 仅在 hold settle/refund 时生成兼容流水。

钱包统一口径为 `available_balance_fen = SUM(billing_transactions signed amount) - SUM(active wallet_holds remaining amount)`。所有消费、充值退款预留、余额/预算查询均锁同一 wallet account 并计算 active holds；现有 debit/settleDebit/refundDebit 的所有调用迁入 hold-aware adapter，禁止旁路。hold settle/release 与兼容 billing transaction、action/audit/outbox 在同一 SqlClient 事务，使用 operation/hold idempotency key，并由对账验证 ledger balance、active holds、available balance 恒等式。

## 8. 关键状态机

### 8.1 配置

```text
draft -> validating -> pending_approval -> scheduled -> active -> retired
  ^          |               |               |            \
  |          v               v               +----------> disabled
  +-------- approval rejected / new draft revision
```

`rejected` 是 approval decision，不是持久配置状态；拒绝后以新 revision 回到 draft。持久状态严格为 PRD 的 `draft/validating/pending_approval/scheduled/active/retired/disabled`。业务 payload、dependency refs 和 checksum 在进入 pending_approval 后不可修改；生命周期状态只可通过 expected revision CAS + approval + append-only config event 转换。retire/disable 只改变新引用资格，不修改历史内容；订单和在途动作仍可读取历史版本。编辑 active 只创建新 draft。

### 8.2 订阅

```text
payment + restrictions? -> active_restricted --all blocking accepted--> active
             |                    |                                      |
             +--------- pause/past_due <------ restore -----------------+
                                      |
                        period end cancel / contract end
                                      v
                              canceled / expired
```

分项 restriction accepted 后对应 capability 可先恢复，但状态在全部 blocking item 通过前仍为 active_restricted。状态能力矩阵严格复用 PRD FR-COM-001A。

Checklist/item/event 使用 expected revision CAS。单项 acceptance 与 capability projection 同事务；最后一个 blocking item accepted 时以 subscription revision CAS 转 active。trialing 只读取 `legacy_capability_snapshots`，无 evidence 的 capability 为 blocked/manual_attention。

基础搭建 acceptance 事务读取 `commercial_order_snapshots` 中版本化赠点数量和 365 天政策，发放身份固定为 `implementation_order_id + benefit_code + grant_reason=onboarding_acceptance`，保证一订单只赠一次；accepted revision/checksum 仅作为不可变 source ref，不参与唯一键。事务先 CAS 首次 accepted，并逐 item 校验 `evidence_ref` 指向可信证据注册表中同 workspace、item/capability、release/image digest 的未过期记录，且达到合同要求的 E3/E4；缺失、过期、跨租户/跨版本、签名失败或等级不足均拒绝。然后检查 grant 不存在，再原子写 signoff、grant、ledger、audit、tenant outbox；数值不得硬编码。rejected/旧 revision 不发放，后续 checklist revision 返回原 grant，额外发放只能走双人审批 adjustment。退款按 PRD 使未消费部分失效/冲正，已消费历史保留。

### 8.3 权益与结算

```text
grant -> reserve -> settle
          |   |        |
          |   +------> release
          |            |
          +----------> unknown -> reconcile -> settle/release/refund
settled -------------------------------> refund/reverse
grant remaining ----------------------> expire
```

每个事件携带 plan version、snapshot、rate card/rule、checksum。状态转换通过唯一幂等键和 `FOR UPDATE`；不同意图复用 key 返回 409。

账本 `unknown/manual_attention` 时 reservation/hold 继续占用并从可用余额扣除，正式内容不可交付，商家端显示“结算核对中、不可重试”及 statement/request id，Ops 显示 receipt 查询、超时和受控终结动作；客户端没有 release/retry 按钮，只有查询进度或联系支持。

### 8.4 发布

```text
prepare -> ready_for_confirmation -> confirmed -> publishing -> delivered
   |              |                    |              |
 blocked     confirmation_expired  revision drift  rejected/unknown
                                                    -> reconcile/manual_attention
```

Worker 执行前 snapshot、restriction、actor、内容、对象和远端 revision 任一漂移，票据失效并重新 prepare。无有效票据的平台写入数必须为 0。

### 8.5 实施、预约与 SLA

```text
实施: pending_payment -> pending_install -> workspace_bound -> configuring
      -> blocked -> configuring | ready_for_acceptance
      -> rejected -> configuring | accepted -> warranty -> closed

预约: unallocated -> schedulable -> scheduled -> in_progress
      -> completed | cancelled | no_show

SLA: on_track -> at_risk -> breached -> resolved
       |             |
       +-> paused ---+
```

所有转换使用 expected revision、allowed-transition table 和 append event；非法转换 409。实施 accepted 后立即进入 30 天 warranty，只有到期且无未决 P0/P1 才 closed。预约完成/取消/爽约和 SLA pause/resume/breach 不允许直接 UPDATE 终态投影。

## 9. 创作额度、钱包与成本事务

```text
1. 解析 snapshot + 唯一 rate rule + wallet price
2. 估算 max points / max amount_fen
3. `CommercialUnitOfWork` BEGIN；按固定顺序锁 snapshot、earliest-expiry grants、wallet budget/account
4. 写 operation header、多 grant allocation、capped wallet hold
5. 用同一 SqlClient 写 action ledger + audit + tenant outbox；COMMIT
6. Worker 通过 relay 调用 provider
7. 验证真实 usage/cost receipt
8. BEGIN; settle each original source; release delta; write outbox; COMMIT
9. deliver content only after settled
```

- 钱包授权为 workspace scoped、最长 90 天、单次/月预算；每次 10 分钟确认票据。
- 点数与人民币分别按各自规则舍入，不存在点数兑人民币汇率。
- 任一预占失败全部回滚；动作不可部分交付。
- Provider 成功但 receipt/cost 未知：资金保持 reserved、内容不交付，24 小时对账后人工只能 settle、证明未执行 release、或原路 refund/reverse。
- 跨账期退款：钱包原路；点数回原 grant，过期则建立 30 天 `refund_credit`，仍引用原版本。
- 对账键：`workspace + operation_id + provider_request_id + receipt_hash`；每日验证 credit ledger、wallet、model usage/cost、action projection 总和。
- 模型执行使用 `operation_execution_attempts` 和 lease。外调前先持久化 attempt，并在 provider 支持时把 operation id 作为 provider idempotency key。只有收到可证明“请求未被 provider 接收”的失败才允许同 operation 重试；timeout、连接断开、请求后 Worker 崩溃或 provider 不支持幂等均进入 unknown，保持 credit/wallet reserved，禁止再次调用，只能查询 receipt、reconcile 或受控人工终结。稳定 outbox key 不等于 provider 幂等。

## 10. 资源准入和降级

资源创建与 occupation、snapshot `FOR UPDATE` 和审计同事务。品牌按 active、店铺按 platform+remote id 的有效绑定、主体按加密自然身份、导入按 canonical product/content hash 计数。

降级生效时按 `activated_at,id` 保留额度内最早对象，其余 over-limit。对象级 enforcement：超额品牌阻断其生成/上传/发布；超额店铺允许读但阻断写/新授权；超额主体阻断新绑定及其发布；存储超额只阻断新增持久化对象，既有 clean/approved 资产仍可人工确认发布；余额不足只阻断相应生成或预约。宽限前后同一安全门禁，不删除历史。

首次导入不复用普通月度 occupation 计数：事务锁 implementation order entitlement snapshot，窗口 `starts_at=configuring`，`ends_at=min(accepted_at, paid_at+60d)`；延期必须引用已批准的新 snapshot。只有成功 canonical product id 或 scan-passed、persisted content hash 写 `implementation_import_consumptions`；retry/update/delete/reimport 同 identity 不重复消费、不返还。

### 10.1 存储 limit 原子切换

扩展现有 StorageQuotaRepository，新增 transaction-scoped `setLimitInTransaction(workspace, snapshot_id, expected_revision, limit_bytes)`；`workspace_storage_quotas` 增加 `entitlement_snapshot_id, limit_revision, enforcement`。新 snapshot 激活事务同时 CAS 更新 limit，保留所有 reservation/used bytes：升级立即放宽；降级若已超额标 over_limit，不删除并按口径 A 阻断新增持久化对象。reserve 必须读取数据库当前 snapshot/limit，不接受调用方传入的旧 limit；snapshot 不一致 fail-closed。同步 Worker 只做对账/修复告警，绝不承担正确性窗口或异步生效。

## 11. 服务履约与 SLA

- 预约在 allocation 上原子预占；完成按有效分钟向上取整 15 分钟且不超过预约时长。
- 服务方迟到/取消不计费；客户迟到按有效时间，爽约按预约；超时需新确认和预占。
- booking、cancel、no_show、complete、manual reversal 均 append event，禁止直接改余额。
- ticket 创建时冻结 policy/calendar/version/checksum。只有首次响应前 15 分钟的授权优先级纠错可从 created_at 重算一次。
- waiting_customer 必须存在明确客户行动项；客户消息或恢复事件继续剩余时钟。
- 合并保留各 clock、父单显示最早 deadline；重开建立新 occurrence，不改历史。
- SLA deadline 由事件驱动增量计算，定时 Worker 只推进 at_risk/breached，不把自动回复计为人工响应。
- 月度 SLA 报告使用 `sla_reporting_runs/results/exclusions`：分母为当月首次进入终态的应计 first-response clock；仅合同 N/A、首次响应前合并的重复子单、审计标记 test ticket 可排除；deadline 已过但月末未终结计失败。次月第 3 个工作日截止，结果绑定 policy/calendar/report cutoff/checksum。迟到事件只产生 correction run 并关联原 run，禁止覆盖原报告。

## 12. MCP/API 契约

### 12.0 通用响应封套

所有卡片/页面 DTO 使用同一封套：

```text
{
  data: T | null,
  status: ok | partial | blocked | error | unknown,
  asOf: ISO timestamp,
  freshness: fresh | stale | expired | unknown,
  revision: integer | null,
  errors: [{ code, fieldPath?, message, retryable }],
  blockedReasons: [{ code, capability?, evidenceRef?, nextAction }],
  nextAction: { type, label, method?, href? } | null,
  operation: { operationId, taskId?, status, statusHref, pollAfterMs?, terminal,
               progress?: { completed, total, unit }, result?: object, resultRef?: string,
               error?: { code, message, retryable }, updatedAt } | null,
  requestId: string
}
```

`data=null` 只与 blocked/error/unknown 合法；数值 0 是已知业务值，必须同时给 unit/status，绝不代表 missing/unlimited。partial 必须逐字段给 error/unknown 标记；客户端不得把过期或读取失败渲染为 0、空数据或 ready。

异步 operation 状态固定为 `queued/running/succeeded/failed/unknown/manual_attention/canceled`：`queued→running|canceled`，`running→succeeded|failed|unknown`，`unknown→succeeded|failed|manual_attention`；终态为 succeeded/failed/manual_attention/canceled。`ops.operation.get/commercial.operation.get` 返回上述完整 operation DTO；terminal=true 时停止轮询，succeeded 必须给 result 或 resultRef，其他终态必须给 error/nextAction。客户端不得自动重试 unknown/manual_attention；`retryable=true` 也只显示需用户明确发起新 intent 的 nextAction。

Readiness 使用双层 canonical contract：证据生命周期 `unconfigured/configured/unverified/canary_passed/expired/blocked/error/unknown`；商家 capability 投影 `not_configured/read_only/ready/degraded/blocked/error/unknown`。确定映射：unconfigured→not_configured；configured/unverified→blocked(reason=verification_required)；有效 read canary 但无 write capability→read_only；全部 required write evidence 有效→ready；硬依赖 expired/blocked→blocked；证据读取失败→error；证据缺失/聚合不确定→unknown。多依赖 fail-closed 优先级为 `blocked > error > unknown > degraded > ready/read_only`；degraded 仅在所有安全硬门禁有效、允许的安全子集可执行但存在非阻断近期错误时使用。API 只返回服务端最终投影，客户端不聚合。

### 12.1 商家读与动作

- 扩展 `workspace.commercial.get`、`subscription.get`、`billing.status`、`workspace.usage.get` 返回 plan/period/snapshot/restrictions/结构额度/双账本/readiness/blocked reasons。
- 新增 `entitlement.statement`，游标分页 grant/reserve/settle/release/refund/expire/adjust。
- 复用 `publish.batch.prepare/confirm/get`，增加 snapshot/restriction revision、estimated points/money、preview hash/expiry。
- 服务：`service.commitment.get`、`service.booking.list/create/cancel`、`support.sla.get`。

### 12.2 Ops

- Plan：`version.list/get/create/update-draft/validate/impact-preview/submit/approve/reject/schedule/retire`。
- Rate：`rate-card.list/get/create-draft/update-draft/validate/impact-preview/submit/approve/reject/schedule/disable/history` 与 `action-catalog.get`。
- Workspace：`entitlement.get/override.validate/override.apply/adjust/statement`。
- Delivery/Service：`onboarding.delivery.list/get/item.update/submit/accept/reject`；`service.allocation.list/adjust`；`service.booking.list/create/cancel/complete/no-show`；`service.review.list/create/accept`。
- SLA：`support.sla.policy.list/get/create-draft/validate/approve/schedule`；`support.sla.calendar.list/get/create-draft/update-draft/validate/approve/schedule/retire`；`support.sla.clock.list/detail/override`；`support.sla.violation.list`。
- Readiness：`runtime.readiness.list/detail`、`evidence.get/approve/reject/expire`。
- Async：`ops.operation.get`；商家可见动作使用 `commercial.operation.get`。影响预览、canary、unknown reconcile 等响应必须返回 operationId/statusHref；客户端轮询状态而不重放 mutation，requestId 只用于追踪。

List 请求统一 cursor/limit（1–100）、server sort enum、filter schema；响应返回 items/nextCursor/totalEstimate?。Validate 返回字段级 `fieldPath/code/message`；409 返回 server revision + safe diff + rebase token；403 返回 capability/scope/requestId/恢复动作；审批冲突、同人审批和异步 impact/canary task 均有明确 status/pollAfter/terminal error。

所有写请求：`expected_revision, idempotency_key, reason`，高风险写另带 approval ref；返回 server labels、units、limits、version/effectiveAt、nextAction、requestId。REST 只保留支付/OAuth/provider 回调、Worker、scanner、ERP webhook 等机器入口，最终调用同一 application service。

Idempotency key 由 `scope_type + scope_id + actor + method + stable_client_intent_id` 生成并唯一；workspace 操作用 `workspace/<workspace_id>`，control-plane 用 `global/commercial-platform`（或明确的全局资源 id）。同一用户意图的双击、超时和网络重试复用同一 key，字段/对象变化即创建新 intent。成功/确定业务失败后 key 终结；unknown 通过 operation status 查询，禁止创建新意图重放。409 时客户端保留输入，刷新 server revision，展示 diff；用户明确 rebase/重新确认后生成新 intent/key，定时发布竞争同样遵循此流程。

发布 confirmation ticket 持久化 `entitlement_snapshot_id/revision/checksum`、restriction revision、authorization revision、content/object/remote revision、intent hash、nonce、expires_at。消费票据与写 publish outbox 在同一 PostgreSQL 事务；Worker 重新解析当前事实逐项比较，任何漂移（即使新权益更高）都把任务终结为 invalidated/reprepare，不能重试平台写。批量最多 50 项，每项独立 scope/ticket/receipt；unknown 只进入 reconcile。

## 13. 授权、审计与隐私

| 能力 | 建议 capability |
|---|---|
| 套餐读/草稿/批准/发布 | `billing.offer.read/update/approve/publish` |
| 费率读/草稿/影响/批准/发布 | `billing.rate.read` / `billing.rate.update` / `billing.rate.impact` / `billing.rate.approve` / `billing.rate.publish` |
| 权益查看/人工调整 | `billing.entitlement.read/adjust` |
| 服务履约/排期 | `service.delivery.read/update` |
| SLA policy 读/写/批准 | `support.sla.read` / `support.sla.update` / `support.sla.approve` |
| SLA calendar 读/写/批准 | `support.sla.calendar.read` / `support.sla.calendar.update` / `support.sla.calendar.approve` |
| SLA clock override | `support.sla.override` |
| readiness 证据 | `runtime.evidence.read/approve` |
| SOW/集成项目 | `integration.project.read/update/approve` |

套餐发布、费率批准、人工赠点/扣点、大额冲正、ERP 写权限和高风险 override 双人审批。审计保存 actor、workspace、before/after、reason、evidence、revision、effectiveAt、idempotency/request id；不保存 token、API key、Cookie、合同正文、证照原文或素材字节。

前端授权矩阵：套餐/费率列表读、草稿编辑、影响预览、批准、发布分别映射对应 `billing.*` capability；权益页 read 与 adjust 分离；服务排期、SLA override、readiness evidence 各用独立 capability。无 read 权限不挂载路由/数据请求；有 read 无 write 时进入明确只读并隐藏危险动作；运行中 403 清除相关缓存，显示缺失 capability/scope/requestId 与返回/刷新权限动作。平台聚合态只读脱敏数据，进入 workspace 深链前重新校验 scope 并清空前一 workspace 查询缓存。

## 13.1 前端容器与共享契约

- ChatGPT：`PlanEntitlementCard`、`DualLedgerCard`、`StructuralQuotaCard`、`CapabilityReadinessCard`、`ServiceCard`、`PublishConfirmationCard`，由 merchant BFF aggregator 一次返回裁剪 DTO；复杂账单深链现有 recharge MCP app。
- Ops 路由：`/commercial/plans/:version`、`/commercial/rates/:version`、`/workspaces/:id/entitlements`、`/services/schedule`、`/support/sla`、`/runtime/readiness`，支持可授权深链和返回位置恢复。
- Query key 必须包含 workspace id + resource + revision/filter；plan/rate global cache 与 workspace cache 分离。workspace 切换先 cancel in-flight、清除敏感缓存/表单/selection，再加载新 scope；mutation success 由 server event/revision 精确失效。
- OpenAPI/MCP schema 生成 TypeScript type、enum 和 validator；canonical action/catalog、label、unit、limit 全由服务端/共享生成包消费。ESLint/contract test 禁止前端本地套餐数值、费率、状态或 capability 总数副本。
- 聚合层只返回页面需要字段；合同正文、PII、token、对象地址和审批敏感信息在服务端裁剪，不依赖 CSS 隐藏。

## 13.2 WCAG 2.2 AA 组件约束

- 状态组件必须文字+图标，正文/状态对比度 ≥4.5:1；图标按钮和行操作有可访问名称。
- mutation error 先聚焦错误摘要，摘要链接字段，字段用 `aria-describedby`；成功/余额/readiness 用 polite `aria-live`，阻断/发布失败用 assertive alert。
- 表格采用可预测 tab/方向键模型；drawer/modal 捕获并恢复触发点焦点、Esc 可关闭（不可取消的安全确认除外），sticky/overlay 不遮挡焦点。
- 等效 320 CSS px（通常 400% zoom）下满足 Reflow、不丢关键动作且无双向滚动（二维数据表例外并提供可访问替代）；交互目标至少 24×24 CSS px 或满足 WCAG 允许的间距/文本内联例外；Focus Not Obscured (Minimum) 要求焦点项不被 sticky/overlay 完全遮挡。尊重 reduced-motion；loading skeleton 不朗读为业务值。E3 用键盘+屏幕阅读器真实路径验收。

## 14. Outbox、Worker 与并发

租户事件：snapshot created、benefit granted/reserved/settled/released/expired、quota exceeded、restriction accepted、service completed、SLA warning/breached、onboarding accepted，继续使用现有强制 workspace 的 outbox。

全局 plan/rate/policy published 使用独立 `control_plane_outbox`，不伪造 workspace。Dispatcher 按 `(global_event_id, workspace_id)` 游标生成租户级 cache-invalidation/revalidation fan-out；批次、幂等、lease、重试/死信可恢复。目录版本 active 事务与 control-plane event 同事务；运行时写仍以数据库版本/checksum 复核，不依赖 fan-out 及时性。

新增 Worker：周期发放/到期、降级、SLA scan、服务提醒、四账对账、snapshot-storage 同步、migration backfill/shadow compare。全部使用 durable outbox、workspace 公平 claim、lease/heartbeat、稳定事件键、重试/死信和 service principal；Redis 丢失不丢事实。

| 场景 | 唯一键/锁 |
|---|---|
| 支付激活 | provider event id；锁 order/subscription |
| 周期发放 | subscription + benefit + period |
| 预占/结算 | workspace + operation + source；锁 grants/wallet |
| 资源占用 | workspace + kind + resource；锁 snapshot |
| 服务预约 | allocation + booking idempotency；排期冲突 exclusion |
| SLA | ticket + occurrence + policy revision；event sequence |
| 发布 | confirmation nonce + intent/snapshot hash |

## 15. 迁移 109+

```text
109 Expand schema/RLS/roles
110 Catalog + policy immutable versions
111 Subscription period/snapshot/restriction
112 Entitlement V2 ledger + projections
113 Resource occupations/business subjects/import
114 Service/onboarding/SLA
115 Outbox events/workers/projections
116 Backfill procedures + reconciliation views
117 Dual-write/shadow/cutover flags
```

阶段：Expand → Backfill → Shadow read → Dual-write → workspace canary Cutover → 至少一完整月度周期后 Contract。迁移号以合并时实际最新 migration 顺延，不抢占并行变更编号。

### 15.1 Legacy opening

- Offer revision 生成 legacy plan version；订单/订阅形成 inferred snapshot。
- `legacy_task`: granted=includedTasks；consumed=本期未 refund ledger units；remaining=max(0, granted-consumed)。used>granted 保留 over_limit/manual_attention；monthly_tasks_used 只校验。
- checksum 覆盖来源行版本和**按 ledger id 排序**的本期未退款 row hash；legacy_task grant 唯一键固定为 `subscription_id + legacy_task + period_start`，通用回填自然键保证重跑不发两次。
- 旧月付 task 当前子周期末停止；历史年付按原周年锚点每月幂等发到 paid-through。缺 paid-through 只建立包含 cutover 的一期，`ends_at=min(next_anchor,cutover+30d)`；禁止任何后续自动或人工发放/延长，除非先形成经批准的新合同或新目录订阅快照。
- 无 expiry 旧 entitlement：月付当前期末，年付 paid-through；缺失则 cutover+30d/manual_attention。
- 旧 ledger 不重写；opening 是投影。旧在途在旧侧收口并关联 V2；切点后退款写 V2 冲正并引用原交易。
- 历史年付子周期：Asia/Shanghai 原 period_start 日与时刻为永久锚点，第 n 期直接从原锚点+n 月；缺日截月末但后续仍保留原日；`ends_at=min(next_anchor,paid_through)`，partial 不补齐；cutover 只迁包含切点的一期。
- 所有回填自然键：`source_table + source_id + target_kind + period`。Legacy add-on 的 granted/used/remaining 原样迁移并采用 PRD 确定 expiry。切点前 pending order/change 仍由旧路径完成或显式取消，完成后原子生成 V2 snapshot；切点后只建 V2。
- Trialing capability opening 从合同、旧配置和 capability evidence 生成逐能力 snapshot；自然键 `subscription_id+capability+source_revision`，checksum 覆盖 evidence hash。缺证据 blocked/manual_attention；非零 manual_attention 禁止 cutover。

### 15.2 结构资源 migration opening

- 品牌：回填现有 active/archived 状态和最早可信 activated_at；店铺：以 platform+remote id 绑定回填；主体：从已有已验证登记身份生成 encrypted hash；存储：以 quota totals/reservations/对象 reconciliation 回填。
- 首次导入仅对可追溯实施订单窗口内、已成功 canonical product/content hash 回填 consumption；无可靠 order/identity 不猜测消费，进入 manual_attention 并阻断相关 cutover。
- 缺 remote id、激活时间或状态时标 `inferred/manual_attention`；activated_at 可取最早不可变审计事件，仍缺则取 source created_at 并标 inferred。每条 occupation 保存 source row id/version/checksum。
- Cutover gate：资源 count、storage used/reserved、over-limit selection、trialing capability、import consumption 均与旧事实/对象清单对平，差异和 manual_attention 为 0。

事实源：Expand/Backfill/Shadow/Dual-write 全阶段读旧；每次旧写和 V2 投影在同一数据库事务，不能以 outbox 最终一致冒充 dual-write。只有 workspace Cutover 后读 V2，旧侧继续兼容投影。Cutover 与 legacy rollback 均要求 shadow diff=0、冲突=0、账本/资源对账平且旧侧仍同步。

V2 workspace 禁止回滚到不理解 V2 契约的旧应用二进制；“切旧读”只允许尚由旧事实完整覆盖的 legacy workspace。已产生 V2-only plan/credit/restriction/service/SLA 的 workspace 只能使用兼容当前契约的 V2 projection/前向修复，缺权益时 fail-closed。Contract 仅在每 workspace 至少一完整月度周期且所有回滚证据门禁通过后执行，旧审计/账本永不删除。

## 16. 失败模式与 fail-closed

| 失败 | 行为 |
|---|---|
| 无 active plan/rate/policy 或解析多条 | 阻止下单/动作，Ops 配置告警 |
| 支付签名/金额/nonce 冲突 | 不激活、不发权益 |
| Relay/模型鉴权缺失 | 不直连、不伪生成 |
| usage/cost receipt 缺失 | reserved + 禁止交付 + reconcile |
| 存储/KMS/scanner 异常 | quarantine；不进入生成/发布 |
| entitlement snapshot 缺失 | 503/409，不回退 UI 常量 |
| 平台未配置/证据过期 | capability blocked/read_only |
| 平台写结果 unknown | reconcile/manual_attention，不自动重发 |
| SLA calendar 缺失 | 不虚构 deadline，进入配置阻断 |
| Worker lease 过期/重复事件 | 新 owner 恢复；幂等重放 |
| migration checksum 差异 | 停止该 workspace cutover，人工处理 |

## 17. 性能、容量与可观测性

- 商家 entitlement snapshot p95 ≤ 300ms；Ops 列表 p95 ≤ 800ms；预占事务 p95 ≤ 200ms（不含外部调用）。
- statement 使用 `(workspace_id, created_at DESC, id DESC)` keyset pagination；禁止全表 offset。
- SLA/expiry Worker 分片按 workspace hash，公平 claim，批量 100–500 可调；任务不得持锁跨外部调用。
- plan/rate active 版本可缓存 60 秒，但激活/停用事件主动失效；写路径在数据库复核 version/checksum。
- 指标：grant/settlement/reconcile 差异、unknown 年龄、quota拒绝、SLA at-risk/breach、restriction aging、publish invalidation、migration shadow diff、RLS deny、Worker lag/dead-letter。
- trace 贯穿 ChatGPT request id、MCP operation、outbox event、provider/platform request、ledger link；日志只含引用和 hash，不含密钥/正文。
- 容量 gate 将售出 1V1/培训/SLA 承诺与负责人可排班分钟比较；超容量套餐发布/订单激活 fail-closed。

容量验收基线（上线前可经批准提高、不得降低）：10,000 workspace；每 workspace 20 品牌、100 店铺、100,000 资产；全局 200 并发生成预占、50 并发确认发布、20 个 Worker 副本；24 小时 soak。错误率 <0.1%，账本/配额差异 0，P0 数据错误 0；队列峰值 10,000 后 15 分钟内回落到 <100，单 workspace 不得连续占用超过 5 个 claim 批次；数据库连接使用率 <80%，只读副本 lag p99 <5 秒且写入/准入只读主库。人工服务 capacity 以未来 30 天可排班分钟的 80% 为销售上限，超过即阻断新承诺。

### 17.1 E4 证据契约

`runtime_evidence` 必须绑定 release id、Git commit、image digest、environment、workspace/test account、platform/modality/capability、request/response receipt hash、provider/platform id、签发者/验证者、签名、issued_at/expires_at、nonce 和 replay status。证据只能放行同一 release/digest、同一 capability scope；跨租户/跨版本不可复用。到期、签名失败、nonce 重放或关联 release 变化，readiness 原子降为 expired/blocked 并撤销新 confirmation；历史回执只读保留。

### 17.2 产品成功指标投影

| 指标 | 事件/分母/窗口 | Ops 动作 |
|---|---|---|
| 5 工作日验收率 | 新 paid workspace 中 5 个工作日内 accepted 数/应实施数，按 calendar version | 周/月底看板；低于 90% 告警 |
| 服务记录完整率 | completed service 中参与人、纪要、证据、行动项、客户确认齐全数/全部 completed | 目标 100%，缺项阻止终结 |
| 退款/争议率 | 套餐权益相关已确认 refund/dispute workspace 数/同期付费 workspace，滚动 90 天 | >1% 告警与原因分组 |
| 批准版本覆盖率 | 对外渲染字段带 active/历史合法 plan snapshot ref 数/全部套餐字段 | 目标 100%，无 ref 阻断响应 |
| readiness 误报率 | 标为 ready 后 E4 校验失败或无有效证据的 capability 次数/ready 投影次数 | 目标 0，立即降级/告警 |

投影由 accepted/service/refund/dispute/render/readiness append event 构建，保存 asOf、calendar/report version 和可重放 checksum；Ops 提供趋势、分子分母和 drill-down，修正只新增 reporting run。

## 18. 测试架构与验收证据

```text
E4  production canary / real receipt             少量、高风险
E3  ChatGPT + desktop Ops + real sandbox E2E
E2  PostgreSQL/RLS/Worker/service integration
E1  unit/property/state/contract
E0  static code and document                     不能证明完成
```

- 单元/属性：状态机、日历、rate scope、周年锚点、舍入、退款、幂等 identity。
- 真库：RLS 正负、append-only、exclusion/unique、200 并发准入、outbox 原子性、migration 重跑。
- API/MCP：Bridge allowlist、schema、权限、revision/409、error/unknown、服务端 labels/units。
- E3：正式 ChatGPT 插件和 1440px 桌面 Ops，键盘/屏幕阅读器/WCAG 2.2 AA、loading/error/partial/恢复。
- E4：支付、五模态 relay usage/cost、对象存储删除、scanner、新鲜 platform canary、发布 readback。
- 灾难恢复：备份还原、Redis 丢失、Worker 崩溃、lease 接管、旧/V2 读 flag 回滚、账本重建。
- 容量/长稳：按 §17 固定 workload 跑 24 小时，验证错误率、队列恢复、连接/副本、租户公平和服务容量阈值。

P0 阻断：跨租户成功、重复发放/扣款、额度超卖、模型成本缺失仍交付、fixture 投影生产可用、无票据 Worker 写平台、unknown 自动重试写、scanner 失效仍发布、SLA 自动回复计人工响应、宽限删除数据、migration 差异强切流。

## 19. 实施计划与依赖

1. 契约先行：共享 schema、状态/错误码、capability、action catalog；补 E1 契约测试。
2. 数据底座：109+ catalog/snapshot/ledger/resource/service/SLA 表、RLS、append-only、审计。
3. Catalog/Ops：plan/rate/policy 版本、校验、影响、审批、调度；无前端常量。
4. Subscription/Entitlement：激活原子事务、period、restriction、grant、admission、projection。
5. Credit/Cost：双来源预占、receipt settle、退款、unknown、四账对账。
6. Resource/Storage：brand/store/subject/import occupation、snapshot limit adapter、降级。
7. Service/SLA：onboarding、booking、clock、capacity、队列。
8. Runtime/UI：商家卡片、Ops 工作台、readiness 证据、发布 snapshot gate。
9. Migration：backfill、shadow、dual-write、workspace canary、一个完整周期观察。
10. Release：类型/单元/API/真库/桌面/ChatGPT/容器/迁移/恢复/E4 canary 全门禁。

依赖顺序：共享契约 → 数据/RLS → immutable catalog → snapshot/ledger → 各业务域 → UI → migration cutover。任何 lane 不得绕过上游事实源自行维护套餐常量。

## 20. 回滚和上线门禁

- 应用回滚：legacy workspace 且满足 §15 对平门禁时可按 workspace 切旧读；V2-only workspace 禁止旧二进制/旧语义回滚，只能 V2 projection 或前向修复；禁止删除 V2 ledger。
- 配置回滚：创建新版本引用旧内容，经新审批定时生效；不重新激活历史 version。
- 数据回滚：expand migration 保留旧表；禁止 destructive down migration。结构问题用 forward fix。
- 外部写回滚：停用 capability/readiness，暂停队列；unknown 进入 reconcile，不批量自动重发。
- 发布门禁：迁移完整性/RLS/并发/契约/桌面/ChatGPT/容器健康/备份恢复/支付/relay/cost/storage/scanner/六平台逐格证据均通过。

当前阻断证据包括模型中转密钥、六平台真实连接器、真实支付、托管对象存储以及部分 scanner/容器健康与生产 canary。未通过前，IMPLEMENTATION 可进行，SALES/PRODUCTION 保持 NO-GO。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | NOT RUN | 产品经理与运营销售完成角色评审，不冒充 CEO skill 运行 |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | NOT RUN | 本任务使用六角色多 Agent 评审 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 多轮修复 RLS、原子账本、状态机、迁移、证据、性能、回滚和前端契约；六角色最终 PASS |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | NOT RUN | 前端负责人已独立覆盖桌面 Ops、ChatGPT DTO、授权与 WCAG 2.2 AA |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | NOT RUN | 本需求不以开发者体验为目标面 |

- **VERDICT:** ENG CLEARED — 产品需求与架构文档可进入实现拆分；IMPLEMENTATION/SALES/PRODUCTION 仍为 NO-GO，必须通过文档中的真实运行门禁。

NO UNRESOLVED DECISIONS
