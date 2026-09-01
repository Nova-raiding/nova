# 工作包 04：桌面 Ops 与 ChatGPT 商业化体验

主责：前端 owner

唯一需求依据：[商家营销插件商业化与 AI 创意点 PRD](../product/package-entitlements-and-services-prd-2026-08-31.md)

实现约束依据：[商业化架构](../architecture/package-entitlements-and-services-architecture-2026-08-31.md)

## 目标与冻结顺序

在工作包 01/02 的服务端契约稳定后，用同一 DTO 实现正式 ChatGPT 插件恢复体验和 1440px 桌面 Ops 工作台。前端不维护价格、点数、费率、单位、状态或 capability 的生产常量，也不承担安全门禁。

实现顺序：

1. 共享 DTO parser、错误 envelope 和 capability 投影。
2. ChatGPT 零点阻断/恢复与收费确认。
3. Ops“阻断与恢复”默认视图。
4. Workspace 权益、创意点账本、商业目录、订单支付、费率和服务履约。
5. 权限、深链、异步状态、可访问性与真实浏览器验收。

## ChatGPT 插件范围

- 首先显示服务端 `CommercialAccessDecision`；零点/unknown/不足/stale 时只显示余额/到期、冻结点包、升级、支付状态、导出和客服恢复。
- 收费动作确认显示服务端费率版本、预计点数和执行后余额；无批准费率不渲染确认按钮。
- Bridge structured content 中稳定呈现 code、requestId、balance state、revision 和 nextAction；不把 unknown 显示为 0，不显示未授权人民币充值金额。
- 充值支付成功后仍显示 `paid-but-ungranted`，直到 grant 到账并取得新的通过 decision 才显示 `RECOVERED`。
- 不把 Ops JSON、内部成本、凭据、审计敏感字段或其他 workspace 信息暴露给商家。

## 1440px 桌面 Ops 信息架构

`账务与商业配置` 下固定为：

- 阻断与恢复（默认）。
- Workspace 权益。
- 创意点账本。
- 商业目录。
- 订单与支付。
- 创意点费率。
- 服务履约。

首屏只显示可行动汇总：阻断/unknown、paid-but-ungranted、待履约；详情使用高密度表格与 Drawer。URL 保存 view、workspace、筛选、排序和目标记录；刷新/深链不得丢失上下文。

核心组件包括 `CommercialAccessStatusBar`、`AccessBlockQueueTable`、`AccessRecoveryDrawer`、`WorkspaceEntitlementTable`、`CreativePointsLedgerTable`、`CommercialCatalogTable`、`PrivateTrialSkuPanel`、`CreativePointRateTable`、`RechargeOrderTable`、`ServiceFulfillmentTable`、`CommercialErrorSummary` 和 revision conflict 提示。

## 权限、状态与错误

- 目录草稿/发布、费率草稿/批准、点数读取/调账、private SKU、支付对账、服务履约和门禁恢复分别消费服务端 capability；无 read 不发请求，有 read 无 write 使用只读展示。
- private SKU 无 read capability 时整块、计数、筛选项和搜索提示全部隐藏。
- 独立呈现 `EXHAUSTED`、`INSUFFICIENT`、`UNAVAILABLE`、`STALE`、`RATE_CARD_UNAVAILABLE`、`RECOVERED`；状态同时使用图标、文字和 code。
- 409 保留用户输入并展示 old/new revision；异步 operation 明确 loading/success/error/unknown，终态停止轮询。
- workspace 切换取消旧请求、清理敏感缓存；请求和错误保留 requestId/traceId/nextAction，禁止 `?? 0` 或空数组掩盖失败。

## 可访问性与视觉验收

- 只验收 1440px 桌面，不增加手机、平板或营销落地页要求。
- 页面有唯一 H1；表格排序提供 `aria-sort`；控件名称包含 SKU/action；错误摘要聚焦并链接字段；Drawer 关闭后焦点返回触发行。
- 状态更新使用 polite live region；正文对比度至少 4.5:1；键盘可完成筛选、打开详情、批准/修复和返回流程。
- 使用仓库 React/Ant Design 和桌面设计系统；禁止营销式 KPI、Card 套 Tabs 套 Table，以及用 disabled 表单伪装只读权限。

## DX 与验收

1. 建立商业 DTO runtime parser；字段缺失、unknown 或 error 使对应数据集失败，不回退旧 Offer/wallet/task 类型。
2. 提供 positive、zero、insufficient、unknown、paid-but-ungranted、stale、private hidden、permission denied、409 的 E1 component fixture，并明确标注非生产证据。
3. E1 覆盖错误保真、恢复动作、权限不发请求、深链、缓存隔离、轮询终止、键盘与焦点。
4. E2 连接真 PostgreSQL/API 验证 RLS 错误、支付/grant/revision 状态和并发刷新，不使用硬编码商业值。
5. E3 使用正式安装 ChatGPT 插件和 1440×900 真实桌面浏览器验证阻断 → 充值 → 到账 → 新 revision → 恢复，以及目录/private SKU/费率/账本/服务的 RBAC 路径。
6. fixture 截图、storybook/component test 或静态 UI 存在不算功能完成。

## 依赖、风险与完成定义

- 依赖工作包 01 的共享 DTO/账本、工作包 02 的 Bridge/错误/门禁和工作包 03 的服务事件；工作包 05 提供 E3/E4 环境与证据门禁。
- 风险集中在旧 Finance 类型污染、粗粒度权限、Bridge 错误裁剪、unknown 被当 0、workspace 缓存串租户和 paid 被误报 recovered。
- 完成条件：所有页面和插件组件只消费服务端事实，E1/E2/E3 通过，1440px 桌面与正式 ChatGPT 证据可复核。

## 不包含

后端账本/迁移、真实供应商接入、全站重设计、营销页面、ERP/PIM、商业政策重新决策，以及手机或平板适配。
