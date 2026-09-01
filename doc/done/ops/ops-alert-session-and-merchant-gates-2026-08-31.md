# 运营告警会话与商家安全门禁修复

## 本次落地

- 修复告警通知联表读取：`workspace_operation_alerts.id` 为 UUID，而迁移 100 的通知 `alert_id` 为 text；查询统一按 `a.id::text` 比较，避免 `text = uuid` 导致 `ops.alerts.list` 返回 500。
- 本地验收模式也读取 `ops.session`，以真实 API 会话确定工作区、角色和权限；成员、事故、用户目录不再因 UI 未拿到会话而显示“未选择工作区”或禁用表单。
- 素材事实弹窗的安全前置失败统一进入弹窗内 `role=alert` 错误区，避免错误只显示在页面外。

## 验证证据

- 直连 Postgres API：`ops.members.list` 返回 `actor_demo`、`support_demo`；`ops.alerts.list` 返回 200 且含通知状态。
- Compose API、Merchant UI、Ops UI 镜像均基于当前源码重建并启动。
- 定向浏览器回归：充值校验、素材事实/权益校验、商家安全交互、运营成员生命周期、事故域、规则域通过；本轮定向集最终相关用例通过。

## 上线边界

本地验收通过不等于生产通过。生产仍需真实 OIDC、Postgres/RLS、对象存储删除证明、模型中转成本证据、六平台 capability canary 和 ChatGPT 宿主链路证据。
