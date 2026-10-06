# 101 Demo Ops 桌面回归报告

- 日期：2026-10-06
- 入口：`https://ops.yxsona.com/ops/overview`
- 范围：队列状态映射、公共规则入口、审计入口、账务/租户/权限路由守卫、扫描失败状态
- 浏览器：gstack browse，1440×900
- 业务写入：未执行。当前没有可用的 Ops 平台账号会话；未猜测密码、未创建线上账号。

## 当前页面证据

当前 release 的以下路由均返回 HTTP 200 的桌面应用壳，并在未认证时显示同一登录页：

`overview`、`tasks`、`rules`、`audit`、`users`。

`billing`、`tenants`、`permissions`按当前未认证守卫回到 `/ops/overview`。未认证 API 请求返回 401，浏览器无页面级 JavaScript 错误。

截图位于：

- `screenshots/overview-login.png`
- `screenshots/tasks-unauth.png`
- `screenshots/rules-unauth.png`
- `screenshots/audit-unauth.png`
- `screenshots/billing-unauth.png`
- `screenshots/users-unauth.png`
- `screenshots/tenants-unauth.png`
- `screenshots/permissions-unauth.png`

## 已修复

### OPS-001：已结算/可交付状态显示为橙色

队列文字已经把 `settled`、`export_ready`、`platform_verified` 定义为成功或可交付状态，但颜色映射没有同步，导致桌面队列以橙色呈现，容易把成功状态误读为待处理。

修复：`apps/ops-console/src/components/tasks/knowledge/MarketingQueuePanel.tsx` 将三种状态纳入绿色成功样式，并导出映射函数供测试使用。

验证：`MarketingQueuePanel.test.ts` 20/20 通过，新增断言覆盖三种成功状态、`pending_receipt` 橙色和 `archive_failed` 红色。

## 发现但未在本轮改动

### OPS-002：101 Demo 的扫描 worker 当前不健康

真实容器状态：`merchant-demo-85575f9c-worker-scan-1` 为 `unhealthy`，连续健康检查失败。容器心跳明确报告：`scanner_callback_not_capable`、`scanner_callback_stale`；随后还出现 `definitions_stale`。ClamAV 可达，EICAR 检查通过，队列 backlog 为 0。

这属于 Demo 运行时扫描配置/回调能力问题，不是 `ops-console` 页面状态映射问题。本轮未重启、删除或修改容器数据，也未把它伪装成成功。证据：`../tmp/worker-scan-health.json` 与 `/tmp/worker-scan-logs.txt` 为本机临时采集；正式可复核摘要已记录在本报告。

## 未完成的真实页面范围

因缺少有效平台运营账号，无法在当前线上页面继续进入并点击真实的队列、规则审核、审计、账务和租户权限数据。此前 `demo@ys.com` 的线上登录已有 403 证据，不能把它当作 Ops 账号。需要提供或在受控环境启用一个有效的 Demo 平台运营账号，才能完成这些页面的正向桌面 E2E；本轮没有伪造完成证据。

## 结论

- 未认证桌面入口和路由守卫通过。
- 队列成功/失败颜色语义已修复并通过相关测试。
- Ops 正向页面 E2E、扫描 worker 恢复验证仍被有效 Ops 会话和扫描回调配置阻断。
