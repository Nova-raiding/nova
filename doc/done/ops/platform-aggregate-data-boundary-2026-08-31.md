# 平台聚合数据边界（已完成代码与本地验收）

日期：2026-08-31

## 已完成范围

平台运营的跨工作区只读聚合接口不再返回客户级明细：

- `ops.alerts.list(platform_scope=platform)`：按告警编码、级别、平台、状态和通知投递态聚合。
- `ops.stores.list(platform_scope=platform)`：按平台、授权状态、数据模式和读写能力聚合。
- `ops.brand-units.summary`：只返回平台级数量，不返回工作区明细。
- `ops.data.delete.list(platform_scope=platform)`：按删除范围和状态聚合。
- `ops.support.tickets.list(platform_scope=platform)`：按状态和优先级聚合。
- `ops.incidents.list(platform_scope=platform)`：按严重度和状态聚合。
- `automation.policy.list(platform_scope=platform)`：按平台、启停状态、模式、同步开关和调度参数聚合。

聚合响应不包含真实 workspace、account、客户、工单、事故或可操作资源 ID。桌面 Ops Console 对聚合行只读，客户级详情和变更必须切换到明确工作区授权上下文。

## 验收证据

- API 安全与运营集成回归：54/54 通过。
- 全量 Vitest：332 个测试文件通过、15 个跳过；2,182 项通过、28 项跳过。
- TypeScript 类型检查通过。
- Ops Console 与 Merchant Studio 生产构建通过。
- 发布门禁：321 项通过、6 项跳过。
- CodeGraph 已同步：781 文件、10,909 节点、40,634 边。
- `git diff --check` 通过。

## 边界说明

本文件只证明代码、契约和本地自动化验收完成，不证明生产 OIDC、真实多租户规模、值班演练、外部平台或正式发布证据。相关条件继续由 `doc/todo/quality` 和 `doc/todo/release` 文档管理，满足外部证据后再更新生产发布结论。
