# 收款事实、余款返款与来源退款实现记录

状态：代码落盘、相关 45 个单元测试通过；真实 PostgreSQL、API 接线和生产验收尚未完成。2026-10-05。

## 实现边界

- `commercial-receipt-repository.ts` 和迁移 261：真实现金独立于订单；外部身份 `source + receiving_account_ref + external_trade_id` 唯一；金额整数分、币种 CNY、真实到账时间及服务端核验时间分离。
- 同租户批次分配串行锁定所有 receipt 余额、Workspace、订单，逐项核对余额及不可变订单有效期。冻结每笔 receipt 初始 revision，允许同笔转账支付开通费与首期套餐；每项分配仍读取新的余额。足额后在同一 SqlClient 调用合同履约回调；开通订单先于依赖套餐订单。回调失败整批回滚。
- 普通过期规则取 `commercial_order_terms_v3.expires_at`，以真实到账时点判断；过期到账保留收款事实，不自动改价或伪造支付。
- 分配结果与原意图同写不可变事实，支持按幂等键取回原结果；同键不同 receipt/order/amount/actor 拒绝。触发器作为直接 SQL 写入的总额及余额后盾。
- 余款、超额付款独立返款：原付款人、申请/独立审批、余额冻结、未知外部结果保持冻结、真实外部返款流水唯一、完成同流水可重放；不伪造已支付订单。
- 未匹配收款使用受控 operationsPool 的 platform_ops 作用域记录；原事实 Workspace 为 NULL 且保持不可变。匹配追加证明并赋予余额投影租户。未知收款也可直接申请/审批/确认原付款人返款。租户没有全局收款读权。
- 收款、未匹配队列及返款列表支持时间+ID稳定游标，最大 100 项。
- 退款审批冻结源订单未用且未预留的 grant，点数余额、预留及负调整消费均扣除冻结。回收仅接受 `commercial_order_v2` 的直接 source_id、经真实 schedule 表确认的 `onboarding_schedule_v2` 和 `commercial_schedule_v3`；不会借用其他套餐或赠点。
- 回收与退款完成同事务提交；外部退款同流水重试返回已完成事实。合同周期、服务及升级恢复通过构造函数 sourceRecovery 回调在点数锁之前执行，由合同 owner 提供消费者。

## gstack 工程评审维度

| 维度 | 决策/结果 |
|---|---|
| 架构 | 现金事实、分配及返款分离；合同回调同事务，外部转账不在事务中执行；全局未匹配数据仅 Ops 作用域 |
| 代码质量 | 导出 DTO、稳定机器错误、整数分及来源约束；API/RBAC/共享注册仍由 owner 接线复核 |
| 测试 | 45 个已有单元测试通过；新增真实 PG 用例覆盖现金拆分、期限、返款、并发、同现金合款原子回滚、未知匹配及 SET ROLE 隔离；真实执行未通过环境准备阶段 |
| 性能 | 收款/订单范围锁与 bounded batch；分页索引；没有跨企业全表授予事务；压力证据尚缺 |

## 验证

通过：

```
node --import tsx scripts/run-safe-tests.ts --no-file-parallelism packages/persistence/src/commercial-refund-repository.test.ts packages/persistence/src/creative-point-lifecycle-repository.test.ts packages/persistence/src/creative-point-repository.test.ts
```

3 files、45 tests 通过。测试语义按新要求更新：纯现金累计金额用例使用 pointsToRevoke=0；真实来源回收用例要求源 grant，缺额在审批预检阶段拒绝，完成重放不二次回收。

真实 PG 准备失败：isolated runner 的 receipt 运行 `artifacts/isolated-postgres/run-yAWBLV/fixture-failed-367d2642-ebe2-4d84-b517-dccdd9d72ff2.json` 报 `ISOLATED_FIXTURE_POSTGRES_NOT_READY`，未进入断言；不是功能通过。直接调用 postgres config 也按项目门禁拒绝 `POSTGRES_ISOLATED_LAUNCHER_REQUIRED`，未绕过。

## 仍需 owner 验证

1. server 构造 receipt 的 operationsPool 与精确 Ops 权限；共享 schema/Bridge/UI 对 unknown record/match/returns 及 cursor 的完整接线。
2. server 构造退款 sourceRecovery 回调；合同取消未来期间及未发批次、升级恢复、开通资格回收必须在对应批准政策下执行。
3. role bootstrap 重放后实际 merchant_app/merchant_ops 权限、RLS、迁移完整性、真实 PG 新增测试、API 与桌面运行验收。
4. 未匹配收款/余款队列的责任人、处理期限及工单入口，与合同、发放、外部结果未知的救援工作流。
5. 101 部署、真实支付及容器/Worker/插件回归。本文不宣称这些已通过。

## 后续赠点消费器修正

- onboarding worker 读取批准的不可变订单 snapshot，逐笔核对赠点数量、期数、policyRef、UTC 发放规则与 source checksum；支持批准的正整数赠点及最多 24 期，不再固定拒绝非 500 点。
- 已售 500×6 保留原订单冻结值；新增 600 点版本只有批准并售出对应配置后才按 600 发放，单纯改开通费不影响赠点。
- 来源退款 frozen hold 或订单不再 paid 时，不继续发赠点；Workspace advisory 先于 schedule/points 锁。
- due 查询排除已有 dispatch/expiration 事实，避免 immutable schedule 保持 scheduled 导致小批次重复扫描已发记录而阻塞后续期数。
- 服务权益页 schedule DTO 改为真实正安全整数数量；未批准的历史六笔 500 草稿入口仍保留原规则。未发现 shared contracts 存在赠点 points:500 literal；没有修改私测抵扣协议常量。

验证通过：

```
node --import tsx scripts/run-safe-tests.ts --no-file-parallelism packages/persistence/src/onboarding-grant-dispatch-repository.test.ts packages/persistence/src/service-fulfillment-repository.test.ts
npx tsc -p packages/persistence/tsconfig.json --noEmit
```

2 files、14 tests 通过，包括 600 点批次、旧 500 点批次、过期不重发、来源未支付、数量/期数/checksum 不匹配、真实数量投影及无效数量拒绝。persistence 类型检查通过。未追加启动 PostgreSQL fixture；实际 worker 和数据库新约束仍需 owner 统一真实运行验收。

## 真实 Ops 角色授权闭包修复

QA 第二轮真实 `merchant_ops` 连接在现金分配和来源退款的 `SELECT ... FOR UPDATE commercial_orders_v2` 上观察到 42501。已经在 migration 261 及 `infra/local/ensure-app-role.sql` 末尾追加相同 `$package_commercial_runtime_acl$` 块，保留迁移后的角色重放行为。

- 授予 tenant 商业订单/期间/资格/计划/冻结和点数状态投影所需 SELECT/INSERT/UPDATE；不授予 DELETE/TRUNCATE/REFERENCES/TRIGGER。
- 不可变订单快照、支付、升级、点数来源、分配、账本、退款和赠点事实只授予 SELECT/INSERT，并撤销 UPDATE/DELETE/TRUNCATE 等权限。
- 源 grant 的 `FOR UPDATE OF g` 需要 PostgreSQL UPDATE 权限，专门授予 `UPDATE(id)`；实际 UPDATE 继续由现有不可变触发器拒绝，其他 grant 字段无新 UPDATE 授权。
- 不改变 ENABLE/FORCE RLS 或 workspace 隔离，不扩大 merchant_app 的全局目录读取；目录/通知/邀请 bootstrap 块保持独立。
- QA 已收到串行复验请求：必须使用当前迁移和 bootstrap 的真实 Ops 连接重跑完整现金→同事务授予→来源退款与隔离断言。此段记录补丁，尚不声明该轮真实角色验收通过。

### Ops 闭包复验结果

QA 的同一 owned PostgreSQL 第三轮报告 `artifacts/isolated-postgres/run-V1y0Vd/vitest.json` 中 `commercial-receipt-repository.postgres.test.ts` 已真实 passed。owner 已读取该条结果确认 assertion failureMessages 为空。

本用例实际覆盖最新 Ops 授权：订单与来源 grant 行锁成功、grant.points 修改被 42501 拒绝、grant.id 修改被 55000 不可变触发器拒绝、切换 Workspace 后订单/grant 不可见，并覆盖收款拆分/合款回滚/未知收款匹配/返款冻结及重放。

同轮完整报告仍有独立首购测试 DTO 缺少 providerOrderId 的待修复项，由 QA/owner 继续修正复验；本段只证明已通过的收款与角色断言，不将整轮报告称为通过，也不替代 HTTP/桌面/101 验收。

## 丢失响应恢复与非点数来源退款增补

- `findReceiptByExternalIdentity(workspaceId|null, actorId, identity)` 按原始收款人和完整外部流水 tuple 查询；`getReturnByRequestId(workspaceId|null, actorId, returnId)` 只查询原返款申请人的 intent。actor 由 API 鉴权注入，未知租户使用独立 Ops scope，不用假 Workspace，也不通过余额猜测成功。
- 真实 PG 测试追加原 actor/其他 actor/其他租户拒绝、未匹配收款和 external_unknown 返款恢复断言。这些新增断言等待 QA 下一轮实际执行。
- QA 第四轮发现真实首购授予追加 `commercial_access_decisions_v2` 缺 SELECT/INSERT；已在 261 与 bootstrap 的相同只追加授权块补齐。此轮收款 fixture 的 completed point operation 缺 completed_at，违反既有 CHECK，已修 fixture。所有借出的 SQL client 以 finally release；不删除业务数据绕过失败。
- 新独占 `commercial-source-refund-blockers.release.postgres.test.ts` 共 5 个默认跳过的 PG cases：真实来源服务预约/完成阻断（2）；已授予点数合同零点撤销阻断；未启用未来套餐合同/计划取消且独立赠点保留；已付套餐依赖阻断开通费撤销。
- 服务来源 fixture 通过真实 ServiceFulfillmentRepository 建立绑定不可变订单与权益快照的 allocation/events；退款申请、审批和完成使用实际 merchant_ops 连接。历史 bootstrap 保持服务事实写门禁，因此服务造数采用 fixture writer，并不宣称生产服务写操作可用。此门禁已报告整合 owner。

`npx tsc --noEmit -p packages/persistence/tsconfig.json` exit 0，日志 `/tmp/receipt-source-tsc.log`。未启动额外 Docker/PG fixture；QA 负责串行真实 PG 复验与 manifest。持续功能/品牌/存储消耗的来源归属不能由任意 metadata 证明，仍需交易 owner 的真实 consumer/fail-closed 闭环，不纳入此处成功声明。

### 服务 consumer 审计后收口（取代上一段 fixture writer 临时方案）

整合 owner 确认 PRD 已授权真实服务 consumer。迁移 154 原始 ACL 已提供 Ops 写，而兼容 bootstrap 将其降为只读；当前 API `ops.commercial.service-allocation.create` 另有 `commercial.service_fulfillment.write` 独立能力、真实客户 `commercial.service-boundary.accept` 审计、协议版本/checksum 校验，不需要 merchant_app 扩大服务写权限。

261 与 bootstrap 的 `$commercial_service_runtime_acl$` 恢复原 Ops SELECT/INSERT 以及 allocation 列级 UPDATE(revision,status,used_quantity,updated_at)；events 仍不可更新/删除。App 继续无服务写。create 与 append 采用来源交易同 workspace advisory 锁顺序，来源被冻结、过期或 superseded 时拒绝新的履约；create 核对 immutable order checksum、冻结服务 code/unit 与正量 approved 权益，并限制累计分配不超过来源 quota。

新 PG 文件已改为实际 merchant_ops 创建/预约/开始/完成服务，无 superuser 服务造数。服务 cases 内还覆盖超过冻结 5 小时的分配拒绝、错误 checksum 拒绝、App 无 INSERT、Ops event UPDATE 42501、其他 Workspace 不可见。5 个 PG cases 已交 QA 串行执行，尚不声明运行通过。

`/tmp/receipt-service-final-tsc.log` persistence 类型检查 exit 0；`/tmp/receipt-service-unit.log` worker/service 两文件 14 tests passed。现有 server 客户边界确认门禁保持，无新增未授权客户接受记录。

最终新 blockers PG 文件扩为 7 cases：另增加实际 App 来源点数 reserve/settle（2），查询关联真实月套餐 source grant 的 point allocations 为正后，验证来源退款批准拒绝、余额/冻结/结算投影不变、无 source hold/adjustment。此为真实账本消费者反例，不声称产生真实中转模型请求或成本；旧 refund PG 的 149 段只覆盖回收/注入回滚/不足来源，并非真实 reserved/settled 消费。`/tmp/receipt-seven-tsc.log` 类型检查 exit 0。QA manifest 已通知更新默认跳过数量至 7。

### 当前品牌/店铺/存储来源恢复最小读取权限

按交易 owner 的真实 source-usage 预检需求，261/bootstrap 追加相同 `$commercial_source_usage_acl$`：Ops 只增 brands.workspace_id、platform_accounts.workspace_id/token_state、brand_store_bindings.workspace_id/platform/platform_account_id/status、workspace_storage_quotas.workspace_id/used_bytes/reserved_bytes 的 SELECT，及 quota.limit_bytes 列级 UPDATE 以支持 FOR UPDATE 行锁。不改 RLS，不新增消费计量 used_bytes/reserved_bytes 写；不撤销已有 approved 更广读取以破坏其他 surface。已交 eng_review/QA 按冻结 source preflight 统一真实 Ops 运行验证；没有运行重复全仓类型检查，也未以静态权限 SQL 宣称真实成功。

### 第五轮真实 PG 失败后的 fixture 修正

QA `run-5BmbDr` 中收款本体 passed，但收款库 FORCE cleanup 产生 unhandled 57P01；来源 blockers 7 个 case 均被真实 approved/effectiveAt guard 提前拒绝，不能当作退款成功证据。已将 blockers checkout/payment 时间设为真实目录发布完成之后读取的 PostgreSQL `clock_timestamp()`，不修改任何业务 guard，服务周期即时生效而不倒填历史有效时间。

两个 owned PG 文件都取消 DROP FORCE。结束所有 owned pools 后轮询 pg_stat_activity 确认 backend 退出，最多 100×25ms；仍存活则明确失败，不通过捕获忽略错误制造绿色。receipt 的 admin 以 finally end；blockers 全部 pool end 使用 allSettled 后逐个传播错误，admin finally end。新文件测试数仍为 7，已交 QA 下一轮合计 22 个 PG cases。此轮未启动额外 fixture，避免与正在运行的桌面验收冲突。

### C6 原履约义务精准读取

新增 receipts.getReturn(workspaceId|null,returnId) 给服务器在独立 finance capability 检查后精准取 approved/pending/unknown 返款事实，不要求 completing finance 等于原 maker；原 getReturnByRequestId 仍是 maker-only 的响应恢复接口。NULL 查询限定未匹配 Ops scope 和精确 ID，不能扩大 App 全局读取。

服务 repo 新增 getAllocation(workspaceId,allocationId) 及 getSourceOrderObligation(workspaceId,orderSnapshotId)，后者只从精确不可变快照关联已 paid、冻结 SKU approved/executable 的订单返回 orderId/sourceChecksum；不通过目录当前销售状态或 limit 列表推断原始履约义务。

`commercial-obligation-getters.test.ts` 3 tests passed，日志 `/tmp/commercial-obligation-getters-unit.log`，覆盖独立 finance 原 maker 不同、精确 ID/租户不存在、NULL Ops scope 不读 base pool/无 Ops pool 拒绝、paid/approved source guard。没有改动正在 QA 的 PG files，没有启动 PG。以上是接口级单测，C6 真 MCP/桌面生产资格仍由整合 owner 验收。

### 第七轮真实 PG 已验证

QA `artifacts/isolated-postgres/run-Sgzgj1/vitest.json` 整轮 22/22 passed、无 skip/unhandled；owner 已读取自己的 receipt 1 和 source blockers 7 assertion results 均 passed。服务 scheduled/completed、来源点 reserved/settled、零点取消拒绝、未来合同取消、开通费 paid 依赖及实际 Ops 权限/租户反例现有真实 PostgreSQL 成功证据。

### 历史前缀余额兼容修复

全门禁真实 254/255 API bridge 发现新 points.refreshBalance/allocate 无条件读取 migration 261 的 source hold 表。新 shared `hasCommercialRelationForVerifiedPrefix` 同 client 精准查 public relation；关系缺失时读取完整 schema_migrations，并核对真实连续 history 的 migration name/checksum 与 bundled release 全链。只有 tail 早于该关系引入版本且 history 完全可信时才使用历史无该关系 SQL；263 或已应用引入迁移却缺表、空/缺口/NULL/checksum 不符 history 均 fail closed。不 catch 42P01 当零，不用环境布尔或单 maxVersion 放行。

当前完整 schema 的余额和分配仍扣除真实未释放 hold。helper 8 + points 11 共19 unit passed，`/tmp/commercial-prefix-points-unit.log`；persistence tsc exit 0 `/tmp/commercial-prefix-points-tsc.log`。worker/原订单 owner 复用此 same-client helper，完整 API bridge 仍由 root 统一重跑。

同类旧前缀问题也存在于 owned lifecycle 到期余额重算和通用负调整，已用同一可信 schema helper 修正：完整 schema 保持真实冻结扣减；generic sourceOrderId 未设置时不解析不存在的 V3 schedule 表，指定 source 则按实际可信关系保留 exact commercial/order/onboarding schedule 来源约束。不会扩大来源退款到无关赠点。

最后 schema/points/lifecycle/refund 4 files 共 53 tests passed `/tmp/commercial-prefix-lifecycle-unit.log`；persistence tsc exit 0 `/tmp/commercial-prefix-lifecycle-tsc.log`。显式拒绝所有 NULL checksum，包括历史 014 name-only alias，以免 migration runner 的历史迁移例外被当成运行期无冻结证明。未启动 fixture；统一真实 API bridge 复验待 root。
