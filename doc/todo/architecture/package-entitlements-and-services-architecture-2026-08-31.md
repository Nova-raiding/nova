# 商家营销插件商业化与 AI 创意点架构设计

状态：工程评审通过，可进入实现；销售与生产仍为 NO-GO
版本：2.0
日期：2026-09-01
上游需求：[商家营销插件商业化与 AI 创意点 PRD](../product/package-entitlements-and-services-prd-2026-08-31.md)

## 1. 结论与边界

本架构只实现上游 PRD，不新增价格、套餐、费率、服务政策、移动端、ERP、私有化或专项增值服务。目标是以一个版本化商业目录、一个 append-only 创意点账本和一个服务端 `CommercialAccessDecision` 替换当前任务次数、图片/平台 add-on、人民币钱包和局部 handler 门禁。

人民币收款/退款和 provider usage/cost 保持独立账本，只通过 operation id 与创意点事件关联；人民币钱包、旧任务额度和旧 add-on 均不得解锁商家业务。创意点为 0、余额未知、账本不可读或不足本次动作时，除精确恢复/控制白名单外全部 fail-closed。

本设计允许实现，但不证明已完成、可销售或可上线。真实 ChatGPT 插件、MCP、支付、模型中转、对象存储、scanner、六平台、RLS、Worker、容器健康和生产 canary 仍按 E3/E4 验收。

## 2. 冻结商业事实

- 系统接入：5000 元/次；连续 6 个月、每月 500 点；起算日和每笔到期日未批准前不得启动生产调度。
- private test SKU：1999 元/7 天；1 品牌、1 店铺、500 点、1 小时 1V1、核心功能和一次复盘；仅授权销售/Ops 可见。结束后 7 天内正式购买可抵扣 5000 元接入费；资格、重复购买和会计规则未批准前不得生产应用。
- 基础月套餐：2000 元/月；1 品牌、最多 5 店、每月 5000 点、50g、最多 5 小时 1V1、工作日 4 小时响应。
- 增长月套餐：5000 元/月；3 品牌、最多 15 店、每月 12500 点、50g、最多 10 小时 1V1、工作日 2 小时响应、每月一次复盘。
- 定制月套餐：10000 元起；品牌、店铺、点数、服务和能力必须在订单/SOW 快照中解析为具体值。
- 点包草稿：500 点/300 元、2000 点/1000 元；有效期和生产销售需批准。
- 费率草稿：标准图片 1 点/张、批注修改 1 点/张、15 秒标准视频 90 点起/条。整个 rate card 处于 `pending_business_approval`；“90 点起”的变量和文本模型费率未确定时相应动作必须阻断。

`50g` 原样保存为数量 `50` 和原始单位标签 `g`。GB/GiB 未批准前 `normalized_bytes` 为 null，存储能力保持 blocked，禁止代码或 UI 自行换算。

## 3. 设计原则

1. 真实路径：ChatGPT 插件 → Bridge/MCP → API application service → PostgreSQL/RLS/Outbox → Worker/真实依赖 → 商家工作流或 1440px 桌面 Ops。
2. 身份、workspace scope 和 RBAC 先于商业判断；商业判断先于任何业务读取、写入、hydration、入队或外部调用。
3. 每个 MCP method、HTTP method+route 和 Worker event+action 都必须在共享 exact registry 中分类；未分类即拒绝并使契约测试失败。
4. 客户端不推导价格、额度、费率、余额、capability 或 readiness。
5. published 目录、订单快照、rate、ledger、receipt 和 audit 不原地改写；变更新增版本或冲正事件。
6. PostgreSQL 是余额、并发、幂等和 tenant isolation 的最终边界；不得用进程内 Map 或 Redis 作为商业事实。
7. 缺鉴权、费率、成本、回执、配置或证据时保持 unknown/blocked，不回退 fixture 或钱包。
8. 平台写仍需交互确认票据、权限复核和真实回执；创意点准入不替代发布门禁。

## 4. 系统结构

```text
ChatGPT Plugin / Desktop Ops / HTTP callbacks
                    |
          identity + workspace + RBAC
                    |
       Exact Commercial Entry Registry
 MCP method | HTTP route | Worker event/action
                    |
          CommercialAccessService
       +------------+-------------+
       |                          |
 RECOVERY_CONTROL          merchant business
 exact whitelist       no-charge / point-charged
       |                          |
       |             available_points > 0
       |             charged: approved rate
       |             + atomic reservation
       +------------+-------------+
                    |
          CommercialUnitOfWork
 catalog snapshot / subscription / point ledger
 access revision / audit / outbox / service record
                    |
              PostgreSQL
       RLS + FORCE RLS + append-only facts
                    |
             Durable Worker
 live access-revision recheck + active reservation
                    |
       relay / storage / scanner / six platforms
```

组件职责：

- `CommercialCatalogService`：不可变 SKU/version、权益、private visibility、审批和发布。
- `RateCardService`：action catalog、草稿/审批版本和唯一费率解析；0 条、多条或未批准均阻断。
- `CommercialOrderService`：只从服务端 active version 创建订单和全量快照，不接收客户端价格/权益。
- `SubscriptionPeriodService`：只处理月账期、续费、停费和完整 entitlement snapshot。
- `CreativePointLedgerService`：grant/reserve/settle/release/refund/reverse/expire/adjust。
- `CommercialAccessService`：生成唯一 `CommercialAccessDecision`，不读取人民币钱包。
- `PaymentGrantService`：验签支付回调与 grant/access revision 原子事务。
- `ServiceFulfillmentService`：培训、1V1、复盘、响应承诺的人工排期、工时和证据；不实现未批准的取整、爽约、保修或 SLA 算法。
- `RuntimeReadinessService`：支付、五模态、存储、scanner 和六平台真实证据投影。

## 5. 精确入口注册表

共享契约定义：

```ts
type CommercialAccessClass =
  | "RECOVERY_CONTROL"
  | "POINT_REQUIRED_NO_CHARGE"
  | "POINT_CHARGED";

interface CommercialEntryRegistration {
  surface: "mcp" | "http" | "bridge" | "worker";
  key: string;
  accessClass: CommercialAccessClass;
  actionCode?: string;
  requiredCapability?: string;
}
```

`packages/contracts` 是注册表唯一源码，生成 API、Bridge 和 Worker 可消费产物及 checksum。禁止 Bridge 继续维护独立的宽泛 `READ_ONLY_METHODS` 或 onboarding 豁免。

`POST /mcp` 只是 JSON-RPC transport，不是恢复入口；准入分类作用于解析后的具体 MCP method。health/readiness 探针、内部鉴权握手和签名 machine callback 属于独立 infrastructure domain，必须使用各自固定路由、机器身份、签名/nonce 和 payload contract，不能借用 `RECOVERY_CONTROL` 绕过商家准入，也不能把 transport 本身标为恢复。

- `RECOVERY_CONTROL`：登录/会话恢复、必要 workspace bootstrap；目录/订阅/订单/账期/点数余额与到期读取；套餐购买/升级、点包下单和支付状态；验签支付回调与对账；本 workspace 数据导出和删除申请；必要客服恢复；具有独立 capability 的 Ops 财务、调账、配置诊断/修复和审计。
- `POINT_REQUIRED_NO_CHARGE`：店铺扫描、商品录入、知识库查询、在线历史浏览以及 PRD 明确不扣点的业务动作；执行前仍要求 `available_points > 0`。
- `POINT_CHARGED`：图片生成、图片批注修改、视频、文本模型及其他经批准收费动作；必须解析唯一 approved rate 并完成原子 reserve。

平台连接/授权/同步、品牌/商品/listing/任务创建、上传、规则、生成、编辑、审核、批量、发布和服务预约均不属于恢复白名单。

现有 `merchant.start`、`platform.connect`、`catalog.sync` 和 `content.export` 明确不是恢复入口；PRD 允许的是独立、workspace-scoped、可审计的数据导出，不是内容业务导出。实现已补齐 4 个 identity、workspace-scoped HTTP 恢复读契约：商业访问状态、商业目录、创意点余额和创意点流水。它们与 MCP/Bridge 恢复白名单等价；任一处缺少真实仓储事实时仍必须 fail-closed。

每次构建必须验证：`MCP_METHODS`、Bridge merchant tools、注册 HTTP routes、Worker event+operation 与 registry 一一对应；新入口缺分类、重复分类、checksum 不一致或收费动作缺 action code 时构建失败。HTTP 使用 exact method+normalized-path key，不允许宽泛 prefix 放行。

## 6. CommercialAccessDecision

```ts
interface CommercialAccessDecision {
  decisionId: string;
  workspaceId: string;
  accessRevision: string;
  balanceState: "known" | "unknown";
  availablePoints: number | null;
  reservedPoints: number | null;
  quotedPoints: number | null;
  rateCardVersion: string | null;
  allowed: boolean;
  code: "OK" | "CREATIVE_POINTS_EXHAUSTED"
    | "CREATIVE_POINTS_INSUFFICIENT" | "CREATIVE_POINTS_UNAVAILABLE"
    | "RATE_CARD_UNAVAILABLE" | "COMMERCIAL_ACCESS_STALE";
  nextActions: string[];
  decidedAt: string;
  requestId: string;
}
```

- 恢复/控制入口继续执行自身 RBAC、RLS、验签和幂等检查，不要求正余额。
- `balanceState=unknown`、投影缺失或账本不可读：`CREATIVE_POINTS_UNAVAILABLE`。
- 非白名单且 `availablePoints=0`：`CREATIVE_POINTS_EXHAUSTED`。
- 零扣点业务只有 `availablePoints>0` 才允许，余额不变。
- 收费动作先要求唯一 approved rate；没有时 `RATE_CARD_UNAVAILABLE`。
- 收费动作要求 `availablePoints>=quotedPoints`，否则 `CREATIVE_POINTS_INSUFFICIENT`。
- 钱包余额、旧任务余额和 add-on 余额永不参与决定；unknown 数值为 null，禁止映射成 0。

执行顺序固定为：schema → identity/session → workspace scope/RBAC → exact classification → access decision/reservation → business repository/outbox/provider。零点拒绝前不得 hydrate knowledge、创建扫描 handle、读取在线业务数据或写审计以外的业务副作用。

## 7. 数据模型

### 7.1 全局不可变目录

| 表 | 关键字段与约束 |
|---|---|
| `commercial_skus` | `id, code UNIQUE, kind, visibility`；kind 为 onboarding/monthly/recharge/private_trial |
| `commercial_sku_versions` | `sku_id, version, lifecycle, price_fen, currency, duration, payload, checksum, effective_at`；`(sku_id,version)` unique；published payload 不可改 |
| `commercial_sku_benefits` | `sku_version_id, benefit_code, quantity, raw_unit, normalized_value, policy_ref`；unique |
| `commercial_catalog_events` | submit/approve/publish/retire 的 append-only actor/reason/evidence/revision |
| `creative_point_rate_card_versions` | draft/pending_business_approval/approved/retired、checksum、生效期 |
| `creative_point_rate_rules` | `rate_version_id, action_code, integer_points, unit`；同 action/time 不重叠 |

全局目录只允许 control-plane role 写。merchant DB role 不直接读取基表，只经 application service 获得已裁剪的 public catalog 或本 workspace order snapshot。private SKU 需 capability 和 eligibility，未授权统一返回 not found。

### 7.2 Workspace 订单、订阅和服务

| 表 | 关键字段与约束 |
|---|---|
| `commercial_orders_v2` | workspace、SKU/version、金额分、币种、provider、status、created_by、idempotency/request hash |
| `commercial_order_snapshots_v2` | workspace/order unique、完整权益和版本/checksum；immutable |
| `workspace_subscription_periods_v2` | workspace、order snapshot、period start/end、status、revision |
| `workspace_entitlement_snapshots_v2` | period、resolved benefits、catalog/rate/policy refs/checksum；immutable |
| `onboarding_point_grant_schedules` | onboarding order、sequence 1..6、due_at、policy ref、status；自然键 unique |
| `private_trial_eligibilities` | workspace/customer、approved_by/evidence、expires_at、revision |
| `private_trial_credits` | trial order 和正式接入订单各自 unique；应用状态、审批/会计 evidence |
| `workspace_service_commitments` | order/period、training count、1V1 minutes、review cadence、response label、snapshot |
| `workspace_service_fulfillment_events` | schedule/start/complete/cancel/adjust 的 append-only minutes/evidence/actor |

定制套餐在订单创建前必须把数量解析为有限整数。未批准的预约取消、爽约、15 分钟取整、保修期或自动 SLA 时钟不进入表约束和状态机。

### 7.3 创意点账本

| 表 | 职责 |
|---|---|
| `creative_point_grants` | source kind/order/period、granted points、starts/expires、catalog/policy refs |
| `creative_point_operations` | action、intent/request hash、rate/snapshot refs、status、幂等键 |
| `creative_point_reservations` | operation、total points、status、revision |
| `creative_point_reservation_allocations` | reservation 到一个或多个最早到期 grant 的分配 |
| `creative_point_ledger_events` | 所有点数事实，append-only |
| `creative_point_provider_receipts` | provider request、usage/cost hash、验证和关联 operation；immutable |
| `creative_point_grant_balances` | 每 grant 可重建 projection，支持加锁和最快到期消费 |
| `commercial_access_state` | workspace 当前 available/reserved/balance state/access revision 投影 |
| `commercial_access_decisions` | 被阻断请求及所有写/Worker 决策的 append-only 审计 |

账本事件守恒：

| event | available delta | reserved delta | consumed delta |
|---|---:|---:|---:|
| grant | +N | 0 | 0 |
| reserve | -N | +N | 0 |
| settle | 0 | -N | +N |
| release | +N | -N | 0 |
| refund/reverse | +N | 0 | -N |
| expire | -N | 0 | 0 |
| adjust | ±N | 0 | 0 |

约束和索引：

- 所有点数为整数；projection 的 available/reserved/consumed 不得为负。
- operation 唯一键为 `(workspace_id, operation_kind, idempotency_key)`；保存 request hash，同 key 不同 intent 返回 409。
- grant 自然键：月套餐 `subscription_period_id+benefit_code`；接入赠点 `onboarding_order_id+sequence`；充值 `payment_order_id+benefit_code`；试用 `trial_order_id+benefit_code`；调账 `approval_id+sequence`。
- allocation `(reservation_id,grant_id)` unique；receipt `(provider,provider_request_id)` unique。
- 所有 workspace parent 提供 `(workspace_id,id)` unique，child 使用包含 workspace_id 的复合 FK，数据库阻止跨租户引用。
- workspace 表全部 `ENABLE ROW LEVEL SECURITY`、`FORCE ROW LEVEL SECURITY`，同时定义 `USING` 和 `WITH CHECK`。
- ledger/event/receipt 表通过 role revoke 和 row/statement trigger 禁止 UPDATE、DELETE、TRUNCATE；冲正只追加事件。
- statement 索引 `(workspace_id,created_at DESC,id DESC)`，使用 keyset pagination。
- 可消费 grant 索引 `(workspace_id,status,expires_at,created_at,id)`；先锁 workspace access state，再按 `expires_at NULLS LAST,created_at,id` 锁 grant，不能用 `SKIP LOCKED` 跳过更早到期来源。

`commercial_access_state` 和 grant balance 是可重建投影，不是审计事实。任何 grant/reserve/settle/release/refund/expire/adjust 和影响准入的订阅变更，都在同一事务递增 `access_revision`。

## 8. 核心事务与并发

### 8.1 收费业务动作

```text
BEGIN
1. lock commercial_access_state
2. read active subscription/entitlement snapshot
3. resolve exactly one approved rate rule
4. lock spendable grants by earliest expiry/id
5. validate known balance and available >= quote
6. insert operation + reservation + allocations
7. append reserve ledger events
8. update projections + access_revision
9. write decision audit + tenant outbox with snapshot
COMMIT
```

外部调用只能发生在提交后。provider 明确未执行时 release；已经执行但 receipt/cost 不确定时保持 reserved，禁止交付和重调，进入 reconcile。

reservation 不因普通技术超时自动释放。grant 在 reservation 后到期时，settle 仍结算原 allocation；release 若发现原 grant 已到期，则 release 与 expire 在同一事务完成，不重新产生可用点。

### 8.2 零扣点业务

只读动作在 dispatch 前读取一次权威 decision。会写 DB 或入队的零扣点动作必须在同一 transaction 锁 access state、验证 `available_points>0`，并把 decision snapshot 与业务写/outbox 一起提交，避免检查后耗尽的 TOCTOU。

### 8.3 支付到恢复

```text
verified callback
→ unique provider event/nonce
→ verify order snapshot checksum + SKU + amount + currency
→ mark order paid
→ activate monthly period / create grant or approved schedule
→ append grant events
→ update balance + increment access_revision
→ audit + outbox
→ COMMIT
```

以上使用一个 workspace PostgreSQL transaction 和同一个 `SqlClient`。grant 或 outbox 失败时 paid 更新一起回滚，provider 重放安全返回同一结果。

- 月套餐：支付/续费回调创建当期 grant，到 period end 失效。
- 点包：回调创建整包 grant；有效期未批准前不允许生产售卖。
- private trial：回调创建 500 点并绑定 7 天 period。
- 接入服务：只有起算/到期政策批准后才能创建 6 条 schedule；周期 Worker 的自然键保证每月 500 点只发一次。

支付成功不等于恢复。API/UI 只有在 grant 到账并得到新 access revision 后显示 `RECOVERED`；`paid-but-ungranted` 进入 Ops 阻断队列。

### 8.4 Worker 执行复核

业务 outbox payload 保存 `decision_id, access_revision, balance_state, rate_card_version, quoted_points, reservation_id, entitlement_snapshot_id/checksum, request_id, trace_id`。

Worker 外调前同时验证：原有 authorization snapshot、当前 access revision、entitlement snapshot/checksum、收费 reservation、rate version 和 runtime readiness。任一漂移返回 `COMMERCIAL_ACCESS_STALE`，不调用 relay、scanner、storage 或平台。恢复控制 Worker（支付/grant/expire/reconcile/export/delete/Ops recovery）使用 exact registry 分类，不因零点停止维护账本和恢复链路。

Worker 必须区分“记录已发生的 provider outcome”与“发起新的 provider dispatch”。零点或 revision 漂移后，已外调请求的验签 completion/receipt 仍必须入账并进入 settle/unknown/reconcile，以保存真实事实；但不得再次外调、自动重试或把内容交付给商家。只有新的、通过当前 decision 且绑定 active reservation 的 dispatch 才能调用 provider。completion handler 与 delivery handler 使用不同 registry key、不同 capability 和不同 outbox event。

## 9. API、MCP 与 Bridge 契约

统一响应包含：

```text
data | null
status: ok | blocked | error | unknown
accessDecision
revision
asOf/freshness
errors[{code,fieldPath?,message,retryable}]
nextActions[]
operation{id,status,statusHref,pollAfterMs?,terminal}
requestId
```

商业恢复接口覆盖：access decision、public catalog、subscription/order/period、point balance/expiry/statement、套餐/升级/点包下单、payment status、数据导出/删除、客服恢复。收费动作确认返回 server rate version、quoted points、执行后预计余额；无 approved rate 不提供确认能力。

上线切换前，旧 `subscription.order.create`、subscription change/upgrade 路径和允许客户端输入任意金额的 `billing.recharge.create` 必须在服务端 registry/catalog 中 `enabled=false`。只有从 active V2 SKU version 读取价格、权益和币种并生成 immutable snapshot 的 V2 下单方法可以进入恢复白名单；客户端不得提交金额、点数或权益字段。

所有写请求携带 `expected_revision, idempotency_key, reason`；高风险 Ops 写另带 approval/evidence。409 返回 server revision 和 safe diff，客户端保留输入；unknown 只轮询原 operation，禁止自动创建新 intent。

Bridge 行为：

- 调用业务 tool 前取得服务端 access decision；API/MCP 仍是权威门禁，Bridge 结果不能放宽。
- 0/unknown 时 tools 和卡片只提供恢复白名单；`merchant.start` 不写 intent、不返回其他可执行业务 action。
- 错误稳定映射 exhausted/insufficient/unavailable/stale/rate unavailable，展示 requestId、余额状态和 next action。
- 插件本地不得存套餐、费率、白名单或钱包解锁常量。

Ops capability 至少拆分为目录 read/draft/approve/publish、费率 read/draft/approve/publish、point read/adjust、private SKU read/grant、payment reconcile、service fulfillment、access recovery、audit。无 read 权限不挂载路由或请求数据；有 read 无 write 时隐藏 mutation，不用 disabled 表单泄露能力。

## 10. 服务、存储与 readiness

服务履约只保存套餐/订单承诺、人工排期、实际工时、培训/复盘记录、参与人和证据。工时不得因未批准政策自动按 15 分钟取整，不自动判爽约、保修或退款。工作日响应目标作为版本化合同标签展示；缺工作日历时不自动计算 SLA deadline。

存储 adapter 只能消费 entitlement snapshot 的已批准 `normalized_bytes`。单位未决、snapshot 缺失或 revision 不匹配时 reserve fail-closed；不得回退环境变量或全局 5GB。降级不删除已有对象，超限时阻断新增持久化对象。

模型必须走配置的中转链路并保存真实 request/usage/cost/error；费用是内部成本证据，不向商家钱包扣款。缺 usage/cost receipt 时点数保持 reserved、内容不交付。平台写继续使用 prepare/confirm/reconcile，缺真实回执或 readiness 时 blocked/unknown。

## 11. Legacy 迁移

本轮实现在合并时依据最新序列落了 migration 144（创意点账本/访问状态/RLS）、146（不可变商业目录/费率草案）和 148（reservation 费率版本与 allocation 边界的前向加固）；145、147 为同期独立安全迁移，不属于本商业批次。144 保持首次提交后的不可变字节，新约束只能通过 148 向前迁移；编号仍必须在每次合并时读取最新值再顺延。以下为剩余逻辑批次：

```text
N   immutable catalog/rate contract
N+1 creative-point ledger/access state/RLS
N+2 V2 order/snapshot/subscription/private SKU/grant schedule
N+3 service fulfillment/audit/outbox
N+4 backfill evidence/shadow/cutover/reconciliation views
N+5 legacy write fences/contract migration
```

阶段：Expand → seed draft catalog → backfill evidence → shadow decision → explicit workspace canary → drain legacy operations → V2 cutover → Contract。

- `includedTasks/monthly_tasks_used` 不转换成创意点。
- 钱包余额不转换成创意点，不再创建业务 debit；只保留查账、退款和对账。
- platform/image/bulk add-on 不转换成创意点，停止新消费。
- 旧 subscription order/change 与任意金额 recharge 路径先置 `enabled=false`；V2 订单/点包支付闭环和 identity HTTP recovery parity 验证完成后才允许 cutover。
- 旧 task、wallet、add-on、action、订单和支付事实不删除、不重写。
- 旧订阅只作为 evidence。没有合法 V2 grant 的 workspace 在新门禁下余额为 0；只能通过购买/续费/充值或有审批证据的 Ops adjustment 恢复。
- 不做 task→point dual-write；两者没有合法换算关系。
- 切换前 drain 旧在途；unknown/reconciliation/manual attention 非零时不切换。
- 切换后只有 V2 order/grant/access revision 是准入事实，禁止回滚到钱包或任务额度解锁的旧应用。
- Contract migration 只停止旧写和隐藏旧 UI；历史表和审计永久保留。

## 12. 失败模式

| 失败 | 行为 |
|---|---|
| 余额投影/ledger 不可读 | `CREATIVE_POINTS_UNAVAILABLE`；无业务副作用 |
| 已知 0 点 | `CREATIVE_POINTS_EXHAUSTED` |
| 不足 quote | `CREATIVE_POINTS_INSUFFICIENT`；无 reserve/provider |
| rate 0 条、多条或未批准 | `RATE_CARD_UNAVAILABLE` |
| callback 重放 | 返回同 order/grant/access revision，不重复 grant |
| callback 金额/币种/SKU 不符 | 不 paid、不 grant；审计告警 |
| 支付回调本地事务失败 | 整体回滚，等待安全重试 |
| 并发争抢最后点数 | workspace state 串行锁；不得负数或双扣 |
| provider 明确失败 | release 原 reservation |
| provider 结果未知 | 保持 reserved；禁交付、禁重调、进入 reconcile |
| access revision 漂移 | Worker 拒绝且不外调 |
| private SKU 枚举 | 未授权统一 not found |
| 跨租户引用/RLS | 数据库拒绝并产生安全审计 |
| Redis/Worker 故障 | PostgreSQL/outbox 事实保留，恢复后幂等投递 |
| 赠点/点包有效期未批准 | SKU/schedule 不生产激活 |
| 50g 单位未批准 | storage readiness blocked |

## 13. 性能与可观测性

- access hot path 读取 workspace 单行 projection；写路径仍在数据库锁定并复核，不依赖缓存正确性。
- ledger statement 使用 keyset，不用全表 offset；Ops 列表查询必须 workspace-first 索引。
- 外部调用不持有数据库锁；reserve 事务短小，provider 通过 outbox 后置执行。
- expiry/grant/reconcile Worker 按 workspace 公平 claim、lease/heartbeat、稳定自然键和 dead-letter；Redis 丢失不丢事实。
- 指标：商业拒绝按 code/action/surface、unknown 年龄、active reservation 年龄、paid-but-ungranted、重复 callback、ledger/projection diff、grant schedule lag、access stale、registry miss、RLS deny、Worker lag/dead-letter。
- trace 串联 ChatGPT request、MCP operation、decision、reservation、outbox、provider/platform request 和 ledger；日志只保存引用/hash，不保存密钥、prompt、客户素材或原始支付 payload。
- 性能门槛先在真实基线和容量测试中冻结，不能把未经验证的 p95、workspace 数或容量比例写成产品承诺。

## 14. 测试与验收证据

### E1 单元/契约

1. 目录逐字段验证 PRD 的全部价格、点数、品牌/店铺、50g 原始单位、服务和 private 可见性。
2. access decision 真值表覆盖 0、不足、unknown、positive/no-charge、rate unavailable、stale。
3. MCP/HTTP/Bridge/Worker registry totality、唯一性和 checksum parity；新增未分类入口构建失败。
4. ledger 状态机、守恒 property、最早到期、多 grant allocation、expire/release/refund/reverse。
5. private SKU 不可发现性、资格、7 天和抵扣幂等；未批准会计规则阻断。
6. 禁止前端、Bridge 和 application 出现生产套餐/费率/钱包解锁副本。

### E2 真 PostgreSQL

1. migration 重跑、forward fix、复合 FK、check、unique、索引。
2. merchant app、worker、Ops 和 table owner 下的 RLS/FORCE 正负测试。
3. ledger/event/receipt UPDATE、DELETE、TRUNCATE 全失败。
4. 并发 reserve 最后一批点，无负余额、双扣或错误消费顺序。
5. callback 并发/重放/金额冲突以及 paid+grant+revision+outbox 原子性。
6. 6×500 schedule 并发和重跑；政策未批准时不调度。
7. provider unknown reservation 对账；无证据不得 release。
8. 零点拒绝后业务 DB row、outbox、provider、scanner、storage 副作用均为 0。
9. legacy task/wallet/add-on 不产生 V2 point event。

### E3 正式表面

- 正式 ChatGPT 插件逐 merchant tool 验证零点、unknown、恢复白名单、充值后新 revision 恢复和 Bridge/MCP/API parity。
- 1440×900 Ops 验证目录、private SKU、rate、ledger、阻断队列、paid-but-ungranted、RBAC、深链、刷新、loading/error/empty/unknown、键盘和 WCAG 2.2 AA。
- 真 PostgreSQL、durable Worker、支付 sandbox、对象存储、scanner 和配置的模型中转环境，不使用 memory/fixture 成功证据。

### E4 生产门禁证据

- 支付签名、防重、金额/币种/SKU、grant 和 access revision 的真实回执。
- 五模态 relay 的真实鉴权、request、usage、cost、error；无批准费率的动作保持 blocked。
- 六平台逐能力 canary、平台写回读、对象存储删除证明、scanner 新鲜度、备份恢复和容器健康。
- 跨租户成功、重复 grant/扣点、负余额、缺成本仍交付、零点仍有业务副作用、无票据平台写、unknown 自动重调任一出现均为 P0 阻断。

## 15. 实施顺序

```text
WP0 shared contract + exact registry
 ├─ WP1 schema/RLS/append-only/ledger repository
 ├─ WP2 immutable catalog/rate/private SKU
 └─ WP3 CommercialAccessDecision service

WP1 + WP2 + WP3
 ├─ WP4 payment→snapshot→grant→revision
 ├─ WP5 MCP/HTTP/Bridge/Worker enforcement
 ├─ WP6 service fulfillment + storage unresolved-unit gate
 └─ WP7 desktop Ops + Plugin recovery UI

WP4 + WP5
 └─ WP8 legacy shadow/cutover/reconciliation

WP6 + WP7 + WP8
 └─ WP9 E2/E3/E4, concurrency, container and release gates
```

共享契约和 schema 先行。各 lane 不得自行维护套餐、费率、白名单或余额；owner 合并后必须重新运行完整类型、契约、真库、浏览器、容器和 release-gate 验证。

## 16. 回滚和上线门禁

- 应用回滚只能回到理解 V2 契约且仍执行创意点默认拒绝的版本。禁止回滚到任务额度、add-on 或钱包解锁。
- 配置回滚创建引用旧内容的新版本并重新审批，不更新或重新激活历史 published row。
- 数据修复使用 forward migration/append adjustment，不做 destructive down migration，不删除 V2 ledger。
- 外部故障停用相应 readiness/capability 并暂停业务队列；unknown 进入 reconcile，不批量自动重调。
- legacy workspace 只有在仍由旧事实完整覆盖、尚未产生 V2-only grant/operation 且 shadow diff 为 0 时才能暂缓切换；已经切换只能前向修复。

销售/生产保持 NO-GO，直到：

1. 业务确认 6×500 的起算/到期、50g 单位、private test 资格/抵扣和“90 点起”变量。
2. 财务批准点包、rate card、provider 成本和会计处理。
3. 法务批准退款、宽限、数据保留/删除；未批准条款不得实现为隐藏规则。
4. 真实支付、点数账本、中转、平台、存储、导出、RLS、Worker 和发布门禁达到 PRD 指定 E3/E4。
5. registry coverage、ledger reconciliation、migration shadow diff 和 manual attention 均为 0。

## 17. 工程评审记录

旧架构因钱包联合预占、365 天赠点、30 天保修、15 分钟服务取整、SLA 算法、legacy task 换点、annual 套餐、固定旧迁移编号和钱包/点数双账本 UI 与已批准 PRD 冲突，结论作废。

本版采用：不可变目录和订单快照、单一创意点 append-only ledger、exact registry、服务端默认拒绝 decision、支付到 grant/access revision 原子事务、Worker 双重复核、RLS/FORCE、无换算 legacy cutover 和 E1–E4 真实证据。

**PHASE 3 VERDICT：ENG CLEARED。**

实现可以开始；销售与生产在第 16 节全部门禁通过前保持 **NO-GO**。
