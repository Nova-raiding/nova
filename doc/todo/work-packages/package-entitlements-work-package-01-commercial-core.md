# 工作包 01：共享商业契约、目录、订单快照与创意点账本

主责：后端/数据库 owner

唯一需求依据：[商家营销插件商业化与 AI 创意点 PRD](../product/package-entitlements-and-services-prd-2026-08-31.md)

实现约束依据：[商业化架构](../architecture/package-entitlements-and-services-architecture-2026-08-31.md)

## 目标与冻结顺序

先建立全链唯一的商业事实和共享契约，再允许工作包 02–05 接入。冻结顺序为：

1. 精确 operation registry 与错误 envelope。
2. 不可变商业目录、版本和批准状态。
3. 订单/支付快照、订阅账期与权益快照。
4. append-only 创意点账本、余额投影和 access revision。
5. `CommercialAccessDecision`、quote/reservation 与事务 outbox。

任何后续实现不得以人民币钱包、任务次数、图片 entitlement、通用 add-on 或前端常量替代创意点准入。

## 范围

- 共享 operation registry：每个 HTTP route、MCP method 和 Worker action 必须精确归类为 `RECOVERY_CONTROL`、`POINT_REQUIRED_NO_CHARGE` 或 `POINT_CHARGED`；未知入口默认拒绝并使契约测试失败。
- 共享 DTO：access decision、balance state、quote、reservation、ledger entry、catalog/SKU/version、order/snapshot、subscription period、grant schedule、service commitment、error/next action。
- 全局商业目录：5000 元一次性接入、1999 元/7 天 private test、2000/5000/10000 元起月套餐、500 点/300 元和 2000 点/1000 元充值包，以及 PRD 中保持待批准的动作费率。
- Workspace 合同事实：订单不可变快照、订阅账期、品牌/店铺/存储/服务权益快照、6 笔每月 500 点赠点计划、private SKU 资格与抵扣事实。
- 创意点事实：grant、reserve、settle、release、refund/reverse、expire、adjust、multi-grant allocation、provider receipt、可重建 balance projection 和 access revision。
- `CommercialAccessDecision`：明确区分 `EXHAUSTED`、`INSUFFICIENT`、`UNAVAILABLE`、`STALE`、`RATE_CARD_UNAVAILABLE` 与允许状态；人民币收款/退款和 provider usage/cost 只以 operation id 关联证据，永不解除门禁。
- 租户表的 `workspace_id`、复合租户外键、`ENABLE/FORCE RLS`、`USING/WITH CHECK`、索引、幂等键、审计与 outbox；账本/事件表禁止应用角色 UPDATE/DELETE/TRUNCATE。

## 明确不迁移的旧语义

- `includedTasks`、`monthly_tasks_used`、旧 usage、人民币 wallet、图片 entitlement 和通用 addon 只保留为 legacy 只读对账历史。
- 任何 legacy 数值都不得生成、赠送或导入创意点；legacy 来源不得贡献 `available_points`。
- 不实现人民币与创意点联合预占、人民币余额兜底或 PRD 未批准的套餐周期、期限、费率与服务政策。

## 事务与并发验收

1. 支付回调的 provider event/nonce、order paid、订阅/账期/权益快照、应到账 grant、balance projection、access revision、private credit、audit 和 outbox 在同一数据库事务提交；禁止出现 paid 已提交但 grant 未提交。
2. 收费动作按最早到期顺序锁定 grant 并原子预占；不足不拆单，且在任何业务写、入队、存储预留或 provider 调用前拒绝。
3. provider 已执行而结算未知时 reservation 保持 `reserved/unknown`，不得交付、释放或重复调用；由对账明确 settle/release。
4. 余额投影可由 append-only ledger 完整重建；重建值、在线投影和 allocations 必须完全一致。
5. private SKU 无资格时隐藏存在；有资格时 7 天周期、500 点和抵扣事实幂等、可审计。
6. “50g”、6×500 日期、“90 点起”变量和文本费率未获业务确认时保持未批准/阻断，不在代码或 seed 中猜测。

## DX 与测试交付

- 提供共享 schema、示例 envelope、错误 golden matrix 和可生成的全入口分类清单；OpenAPI、MCP contracts、Bridge manifest 与 Worker action manifest 必须 parity。
- 提供仅用于 E1/E2 的确定性场景：positive、zero、insufficient、unknown、paid-but-ungranted、stale；fixture 必须显著标识且不能形成 E3/E4 成功证据。
- E1：逐字段目录、状态机、幂等、精确白名单、private 隐藏、错误 envelope 和 registry 穷举测试。
- E2：真 PostgreSQL 验证 FORCE RLS、append-only、跨租户、支付/grant/revision 原子性、200 并发预占、到期顺序、outbox 回滚和投影重建。

## 依赖、风险与完成定义

- 本包是 02–05 的契约前置；支付 provider、Relay、平台和 UI 实现不在本包。
- 风险集中在旧多账本语义、支付/grant 原子边界、并发超卖、到期顺序和未知结算；不得以删业务数据或回退内存仓储掩盖差异。
- 完成条件：E1/E2 全部通过，registry 无未分类入口，真实 PostgreSQL/RLS 证据可复核；静态代码、内存服务和 fixture 不算功能完成或可销售。

## 不包含

专项增值服务产品化、ERP/PIM、私有化、任意 DAG、人工代做、未批准的退款/宽限/保留政策，以及手机或平板适配。
