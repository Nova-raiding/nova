# 工作包 01：商业目录、订阅快照与权益账本核心

主责：开发者 1（后端/数据库）
依据：[PRD](../product/package-entitlements-and-services-prd-2026-08-31.md)、[架构](../architecture/package-entitlements-and-services-architecture-2026-08-31.md)

## 目标

把价格、套餐额度、创作点、动作费率、钱包价格、服务/SLA policy 变成平台运营后台可配置且不可变的商业事实，并在订单创建时冻结完整快照，在运行时提供可审计权益准入。

## 范围

- `commercial_plan_catalog/versions`、benefit schema、policy/rate card、workspace override、审批、影响预览、定时生效/停用。
- `commercial_order_snapshots`、subscription periods/status/restrictions、active_restricted 分项解限。
- 创作额度 grant/reserve/settle/release/refund/expire/adjust，最早到期扣减。
- `commercial_operations`、multi-grant allocation、capped `wallet_holds`、消费工作包 02 提供的真实 model usage/cost receipt 并完成客户账本绑定。
- 品牌/店铺/主体/首次导入 occupation 与 30 天降级门禁；套餐驱动 storage limit CAS。
- MCP/REST application service、RLS/FORCE、audit、tenant/control-plane outbox。

## CodeGraph 复用证据

- `packages/persistence/src/commercial-extensions-repository.ts`、`subscription-repository.ts`、`entitlement-repository.ts`、`usage-repository.ts`、`billing-repository.ts`、`storage-quota-repository.ts`。
- 现有 `CommercialOffer`、支付回调幂等、ModelUsage/action ledger、StorageQuota reserve/settle/physical deletion、RLS transaction、Outbox/Worker。
- 现有 Offer 只有价格/店铺/任务；旧 task 不得换算为创作额度；现有 debit 必须迁入 hold-aware adapter。

## 交付物与验收

1. 109+ migrations、schema、约束、RLS/FORCE、权限、索引和 rollback/restore 脚本。
2. plan/rate/policy 版本 API：active/history 不可改；同 scope/action/time 0 或多条 fail-closed；提交人与批准人分离。
3. 下单快照不可变；支付只引用快照；激活、首期 grant、audit/outbox 同事务。
4. credit+wallet 原子预占与 capped hold；`available = ledger - active_holds`；provider unknown 保持 reserved、禁止重试/交付。
5. 并发 200 请求下品牌/店铺/额度不超卖；存储 limit 与 snapshot 同事务切换；删除无 receipt 不释放。
6. 每笔账本含 plan/snapshot/rate/rule/checksum，可从 append-only ledger 重建。

## 估算与依赖

- 估算：56–82 人日（含 A1–A5、集成测试；主责人日约 30–45，协同人日另计）。
- 先决：共享 DTO/action catalog、真实 PostgreSQL/RLS 角色、支付契约和工作包 02 的 relay receipt schema（可先用契约测试，不等待 E4）。
- 被依赖：工作包 02、03、04、05 均依赖 plan/snapshot/ledger 契约。

## 风险与不包含

风险：旧 Offer 可变语义、跨 grant/wallet 锁顺序、月中升级、legacy opening、storage limit 调用方旁路。
不包含：Ops UI、平台连接器、支付/模型供应商接入、人工服务履约、任意 ERP/DAG、手机/平板。

## 完成定义

E1 状态/契约测试、E2 真库/RLS/并发/迁移测试通过；CodeGraph 重新 sync 且 affected tests 清零；无 fixture 或内存仓储作为生产证据。
