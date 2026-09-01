# 工作包 04：桌面 Ops 与 ChatGPT 商家前端

主责：开发者 4（前端）
依据：[PRD](../product/package-entitlements-and-services-prd-2026-08-31.md)、[架构](../architecture/package-entitlements-and-services-architecture-2026-08-31.md)

## 目标

在桌面 1440px 工作台和正式 ChatGPT 插件中消费同一服务端契约，完整呈现套餐、双账本、结构额度、readiness、服务和发布确认，不维护任何商业常量。

## 范围

- DTO envelope、状态/operation polling、分页、partial/error/unknown、409 rebase、403 恢复、workspace cache isolation。
- Ops 路由：套餐版本、动作费率、workspace 权益、服务排期、SLA、readiness/证据抽屉。
- 套餐/费率 draft→validate→impact→approve→schedule/disable；影响快照、历史、审计、双人审批。
- 六类 ChatGPT 卡片：PlanEntitlement、DualLedger、StructuralQuota、CapabilityReadiness、Service、PublishConfirmation。
- WCAG 2.2 AA：文字+图标、4.5:1、24×24、焦点、错误摘要/`aria-describedby`、live region、320 CSS px/400% reflow、屏幕阅读器。

## CodeGraph 复用证据

- `apps/ops-console/src/api/opsClient.ts`、`opsDomainClients.ts`、`useOpsConsoleModel.ts`、navigation/page registry、AuthorizationProvider/PermissionGate。
- `FinancePage.tsx`、`OfferTable.tsx`、`ConfigurationCenterSection.tsx`、reconciliation/finance/audit drawers。
- `SupportPage`、`ModelStatusSection`、`PlatformReadinessSection`、`apps/plugin/mcp/bridge.mjs`、`recharge.html`。
- 既有 OpsDataState、OpsPageError、Audit Center、publish prepare/confirm UI；OfferTable 只能作布局参考，不复用可变语义。

## 验收

1. 前端类型、enum、action catalog、label/unit/limit 全由共享 OpenAPI/MCP schema 生成；CI 检测本地套餐/费率/capability 常量。
2. active v3 编辑只产生 draft v4；过期 impact、同人审批、重叠费率、revision 冲突显示服务端字段错误和 diff。
3. unknown/manual_attention 保持占用，不显示 0/已通过/删除，不提供自动重试；operation terminal 时停止轮询并展示 result/error/nextAction。
4. workspace 切换取消请求、清敏感缓存；无 read 不发请求，有 read 无 write 只读；403 返回 capability/scope/requestId。
5. ChatGPT 卡片不搬运 Ops JSON；发布卡准确显示商品/平台/店铺/diff/预计扣点/扣款/hash/expiry，未确认绝不写平台。
6. E3 通过 1440px 桌面浏览器、正式 ChatGPT、键盘和屏幕阅读器路径。

## 估算、依赖与风险

- 估算：78 前端人日（D0–D7，按一名主责开发者的总投入核算；如临时借调前端，只缩短日历工期，不改变责任边界）。
- 依赖工作包 01/02/03 的 DTO、capability、operation、readiness、statement、service/SLA API。
- 风险：2,485 行集中 hook、2,324 行 Bridge、CSP/structured content、Ant Design 默认可访问性不足、`?? 0` 误导。

## 不包含

后端/数据库/迁移、真实供应商接入、ERP/DAG、全站重设计、手机/平板和商业政策重新决策。
