# 172900 版插件：15 项带参数只读工具前置数据核查

核查时间：2026-09-29。目标账号 `demo@sn.com`，唯一 QA 工作区 `ws_57fd2361ed5b44c7891f3d37`。本轮以当前 `apps/plugin/mcp/bridge.mjs` 的 `READ_ONLY_METHODS` 与工具 `inputSchema`、[31 项生产 API 读取](production-api-31-readonly-20260929.md)、[此前 14 项 stdio 边界核验](remaining-reads-agent.md)、[QA 工作区权益和订单只读核查](qa-creative-points-entitlement-readonly-audit.md)为证据。运行 `codegraph status .`：2357 文件、33878 节点、132857 边，2 个文件待同步；运行 `codegraph explore campaign.batch.get brand.get catalog.search --max-files 4` 辅助定位调用链，最终按磁盘源码核对。本轮**没有新增生产调用**，因此没有新的请求 ID，也不增加真实 ChatGPT App 覆盖项。

| 工具 | 合同最小对象/查询 | 当前 QA 工作区真实前置 | 本轮判断 |
| --- | --- | --- | --- |
| `campaign.batch.get` | `campaign_id` | `campaign.batch.list({})` 已返回 `STORE_ONBOARDING_REQUIRED`，没有本租户可读的计划 ID | 缺批次；且刷新进度可能持久化，需前后对账 |
| `commercial.order.payment.get` | `order_id` | V2 订单 0 条 | 缺订单 |
| `support.customer.replies.list` | `ticket_id`、`related_task_id` 或 `related_order_id` | 未有本租户真实工单、任务或订单 ID | 缺关联对象 |
| `workspace.data.export.get` | `request_id` | 未有本租户正式导出申请 ID | 缺申请；旧版用非 UUID 假 ID 曾返回 `INTERNAL_ERROR`，现有本地候选有格式校验，待部署后复核 |
| `billing.recharge.get` | `order_id` | 充值单列表 API 已读，但 31 项证据未保存列表正文或订单 ID；此前无真实充值单正向证据 | 缺经读回确认的充值单 ID |
| `catalog.search` | 可用 `scope=workspace` 与商家真实商品级查询词；`sku_id` 仅用系统读回值 | 两份 Excel 原件上传被创意点门禁阻断，QA 工作区未有已确认商品货号；无结果不能转作 SKU ID | 可做空态/门禁查询，暂不算商品对象正向验收 |
| `catalog.image.get` | `job_id` 或 `visual_ref`，只能二选一 | 无本租户图片作业；当前余额 `unknown` | 缺作业；查询可能触发归档/选择票据，需副作用对账 |
| `rule.history` | `pack_id` | `rule.list({})` API 已调用，但 31 项证据未保存规则包 ID；此前假 ID 查询受创意点门禁阻断 | 缺经读回确认的包 ID |
| `brand.get` | `brand_unit_id` 可选 | `brand-unit.list({})` 受 `STORE_ONBOARDING_REQUIRED` 阻断；此前假 ID 返回 `null` | 可省略 ID 测空态，缺真实品牌单元对象 |
| `task.resume` | `task_id` | `task.history({})` 受 `CREATIVE_POINTS_UNAVAILABLE` 阻断 | 缺任务 |
| `task.timeline` | `task_id` | 同上 | 缺任务 |
| `feedback.list` | `task_id` | 同上；此前假 ID 受点数门禁阻断 | 缺任务 |
| `generation.get` | `job_id` | 没有本租户已生成任务 ID | 缺生成作业 |
| `content.versions` | `task_id` | 没有本租户任务 ID | 缺任务 |
| `content.diff` | `content_version_id`，`against_version_id` 可选 | 没有本租户内容版本 ID | 缺内容版本 |

计数：**13 项必须取得真实对象/商品前置才能做正向验收，2 项 (`catalog.search`、`brand.get`) 可不传对象 ID 做空态或门禁读取**。此前 `remaining-reads-agent.md` 对其中 14 项用明确不存在的 ID 调过旧版 stdio，覆盖的是拒绝或空态边界，**0 项为真实业务对象正向完成**；本轮没有复用假 ID。`catalog.search` 在该旧版 14 项里未调用。当前 172900 版仍须从重启后的真实 ChatGPT App 新对话重新计数，旧版 stdio 和 API 请求不能移植为 App 通过。

下一轮按同一工作区只读列表取回并保存原始响应中的真实 ID、服务端请求 ID 与时间，再逐项调用；先核对 `commercial.access.get`、`subscription.get`、`canonical.product.consistency` 结构化工作区均一致。若生产业务门禁继续返回权益未知或店铺未登记，记录阻断码，不生成测试对象、不借用贵人鸟 ID，也不把错误返回计为正向通过。
