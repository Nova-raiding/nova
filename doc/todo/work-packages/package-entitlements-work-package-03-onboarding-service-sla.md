# 工作包 03：基础搭建、知识导入、服务履约与 SLA

主责：开发者 3（后端/业务流程）
依据：[PRD](../product/package-entitlements-and-services-prd-2026-08-31.md)、[架构](../architecture/package-entitlements-and-services-architecture-2026-08-31.md)

## 目标

把一次性 5000 元基础搭建、知识/品牌/规则/扫描交付、1V1/培训/复盘和 2/4 小时首次响应变成有证据、有工时、有容量约束的履约系统。

## 范围

- implementation order、checklist/item/event、双边签署、restriction、accepted→warranty→closed。
- accepted 同事务读取订单快照赠点政策，一订单只发一次 2000 点/365 天 grant。
- Knowledge/Brand/Rule/Scan adapters，source/version/checksum/freshness/trust/conflict evidence。
- 企业主体、首次导入窗口（configuring 至 accepted 或支付后 60 天较早）、canonical identity 幂等。
- service allocation/booking/events、15 分钟舍入、取消/爽约/延期/跨期 refund_service。
- SLA policy/calendar/clock、waiting_customer、merge/reopen、at-risk/breach、monthly report/correction、主备负责人和容量。

## CodeGraph 复用证据

- `packages/persistence/src/support-repository.ts`、`packages/contracts/src/ops/support.ts`、`apps/api/src/ops/support-service.ts`。
- `packages/knowledge/src/knowledge.ts`、`knowledge-hydration-repository.ts`、`brand-unit-repository.ts`、`rule-repository.ts`。
- `packages/connectors/src/readiness.ts`、`capability-evidence.ts`、`platform-preflight.ts`；现有 Ops support/knowledge/rule 页面。
- 复用 workspace transaction/RLS/audit/outbox/lease；service booking、allocation、calendar/SLA 为净新增。

## 验收

1. 状态转换使用 revision CAS；旧 checklist/revision 409；无效、过期、fixture、冲突证据不能 accepted。
2. acceptance evidence 必须绑定 workspace/item/capability/release/digest、E3/E4 等级和未过期签名；缺失不发赠点。
3. 一订单一赠点自然键；重复签署返回原 grant；拒绝只生成新 revision，不重复发放。
4. 并发预约不超卖；实际有效时长向上取整 15 分钟且不超过预约；服务方取消释放，客户爽约按规则结算。
5. SLA clock 绑定创建时 policy/calendar；自动回复不算人工；暂停、重开、合并、违约和 correction run 可重建。
6. 排班容量达到未来 30 天可排分钟 80% 即阻断新承诺；服务记录完整率 100%。

## 估算、依赖与风险

- 估算：68–91 人日（C0–C6；三条 lane 并行约 6–8 周）。
- 依赖工作包 01 的 snapshot/grant/service policy 和工作包 02 的 readiness/evidence 契约；工作包 05 只负责建立/验证 E3/E4 环境，03 的实现和 E1/E2 可先行，最终 E4 由 05 统筹验收。
- 风险：证据来源不可信、扫描游标未闭合、预约跨期退款、日历变更追溯、负责人离职导致超售。

## 不包含

手机/平板、私有化、通用 ERP/DAG、人工清洗历史素材、人工代做内容、平台连接器本身和无人值守发布。
