# 剩余 14 项只读工具：已安装 stdio 桥接器边界核验

时间：2026-09-29 13:07–13:09 CST。版本：本机已安装 `merchant-marketing@merchant-local 0.1.0+codex.20260929125100`，`tools/list` 为 116 项。使用 `demo@sn.com` 的短期 QA 工作区令牌，通过已安装的 `mcp/bridge.mjs` 发送标准 MCP `tools/call`，目标为生产 demo `https://yxsona.com/mcp`。令牌仅保存在进程内存，不写入本文。桥接器环境固定工作区 `ws_57fd2361ed5b44c7891f3d37`、严格鉴权、禁用 fixture 回退和交互写入。

**证据层级：这是已安装 stdio 插件到生产 API 的核验，不是 ChatGPT App 宿主会话证据。** 不能据此把 14 项记为 App 已调用或正向通过。每项独立启动桥接进程，避免商业恢复状态在同一进程中缓存并提前拦截后续请求。各项参数通过已安装工具 schema；按桥接器 `handle → callRemote` 路径，且没有命中本地商业缓存或本地参数错误，判定已尝试转发。只有 3 项在返回中带服务端请求 ID；其他项仍需服务端日志交叉核对，不能以本文单独证明数据库读取成功。

先调用 `canonical.product.consistency({})`：`isError=false`，结构化 `workspaceId=ws_57fd2361ed5b44c7891f3d37`、`status=clean`、`source=postgres`、`readMode=live`、四类计数均为 0。工作区不符即停止的前置门禁已满足。

| 方法 | 本轮最小安全参数 | stdio 实际结果 | 转发与验收判断 |
| --- | --- | --- | --- |
| `campaign.batch.get` | `{"campaign_id":"qa_nonexistent_campaign_20260929"}` | `isError=true`，`STORE_ONBOARDING_REQUIRED` | 已尝试转发；工作区未绑定正式任务店铺，产品门禁，非批次详情通过。 |
| `commercial.order.payment.get` | `{"order_id":"qa_nonexistent_order_20260929"}` | `isError=true`，`COMMERCIAL_ORDER_NOT_FOUND` | 已尝试转发；缺本租户真实订单，非支付查询成功。 |
| `support.customer.replies.list` | `{"related_order_id":"qa_nonexistent_order_20260929","limit":"10"}` | `isError=false`，`tickets=[]`、`next_cursor=null` | 已尝试转发；仅证明空态返回，不证明真实工单回复可读。 |
| `workspace.data.export.get` | `{"request_id":"qa_nonexistent_export_20260929"}` | `isError=true`，`INTERNAL_ERROR` | 已尝试转发；**缺陷**：非 UUID 输入返回内部错误。随后用随机合法 UUID 复核，返回 `WORKSPACE_DATA_EXPORT_NOT_FOUND`，为正确的不存在边界；仍无真实导出请求正向结果。 |
| `billing.recharge.get` | `{"order_id":"qa_nonexistent_order_20260929"}` | `isError=true`，`BILLING_ORDER_NOT_FOUND` | 已尝试转发；缺真实充值单。 |
| `catalog.image.get` | `{"job_id":"qa_nonexistent_image_20260929"}` | `isError=true`，`CREATIVE_POINTS_UNAVAILABLE`，请求 ID `req_f608486e-cabf-4b4a-aafc-45102a1b53db` | 已转发并获服务端请求 ID；余额未知而安全阻断，未查询到真实图片作业。 |
| `rule.history` | `{"pack_id":"qa_nonexistent_pack_20260929"}` | `isError=true`，`CREATIVE_POINTS_UNAVAILABLE`，请求 ID `req_ffde5f23-fdb2-4a2f-b749-d3f0c879cc89` | 已转发并获服务端请求 ID；余额门禁，非规则历史通过。 |
| `brand.get` | `{"brand_unit_id":"qa_nonexistent_brand_20260929"}` | `isError=false`，结构化结果为 `null`，中文提示当前范围未找到品牌档案 | 已尝试转发；仅证明空态，非品牌档案正向通过。 |
| `task.resume` | `{"task_id":"qa_nonexistent_task_20260929"}` | `isError=true`，`FORBIDDEN` | 已尝试转发；缺本租户真实任务，非任务恢复通过。 |
| `task.timeline` | `{"task_id":"qa_nonexistent_task_20260929"}` | `isError=true`，`FORBIDDEN` | 已尝试转发；缺真实任务时间线。 |
| `feedback.list` | `{"task_id":"qa_nonexistent_task_20260929"}` | `isError=true`，`CREATIVE_POINTS_UNAVAILABLE`，请求 ID `req_d86a5827-9412-43d5-b7f6-718bb6ff2c0b` | 已转发并获服务端请求 ID；余额门禁，非真实反馈列表通过。 |
| `generation.get` | `{"job_id":"qa_nonexistent_generation_20260929"}` | `isError=true`，`FORBIDDEN` | 已尝试转发；缺真实生成作业。 |
| `content.versions` | `{"task_id":"qa_nonexistent_task_20260929"}` | `isError=true`，`FORBIDDEN` | 已尝试转发；缺真实正式任务与版本。 |
| `content.diff` | `{"content_version_id":"qa_nonexistent_version_20260929"}` | `isError=true`，`FORBIDDEN` | 已尝试转发；缺真实正式版本，非差异结果通过。 |

本轮 14 项中，2 项非错误空态、12 项明确错误或门禁；**0 项具备真实业务对象的正向完成证据**。所有商家可见文本均为中文。`workspace.data.export.get` 对非 UUID 的生产错误需修复，不能把 500 当预期阻断。当前本地候选 `apps/api/src/mcp-workspace-lifecycle-handlers.ts` 已有 UUID 格式校验，`apps/api/src/mcp-completion-ops.e2e.test.ts` 也断言此输入应返回 400/`INVALID_REQUEST`；生产 demo 尚未呈现该行为，仍需通过发布门禁核对部署版本。该工作区无测试店铺、任务、版本、图片作业、真实订单和有效商业权益，需待专用资源提供后重跑正向路径；本轮没有生产写入。
