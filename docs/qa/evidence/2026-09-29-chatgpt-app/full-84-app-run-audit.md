# ChatGPT App 剩余 84 项原始调用审计

审计时间：2026-09-29 13:25（中国标准时间）。本文件只记录 ChatGPT App 会话原始 `custom_tool_call` 和对应输出，不把安装、工具发现、直接 MCP/API 测试或模型最终答复算作 App 工具验收。

## 基线核对

116 项来自 [逐项清单](../../2026-09-29-chatgpt-app-116-tool-checklist.md)：只读 46、可逆写入 3、受限写入 60、预期阻断 7。读取以下原始会话，按精确方法名跨版本去重：

| 本地插件版 | 原始会话开始时间 | 不同方法数 | 与此前版本新增的不同方法 |
| --- | --- | ---: | ---: |
| 114000 | 11:43:27、12:28:53 | 22 | 22 |
| 123300 | 12:40:07 | 13 | 10 |
| 124800 | 12:48:23 | 6 | 0 |
| 125100 | 12:52:12 | 2 | 0 |

114000 与 123300 重叠 `onboarding.status`、`brand-unit.list`、`knowledge.rule.list` 三项；后两版的初始调用均落在已有方法集合中。因此 **13:08 前跨版本曾在 App 调用 32/116，完全没有 App 调用 84/116**。这只是调用覆盖；不能把 32 项写成业务通过。原始文件为 `~/.codex/sessions/2026/09/29/rollout-2026-09-29T{11-43-27,12-28-53,12-40-07,12-48-23,12-52-12}-*.jsonl`。12:52:12 的旧会话在 13:09–13:13 又追加事件，不能按文件创建时间漏算，更新数见下节。

## 从未在上述 App 会话调用的 84 项

**只读 14 项**：`campaign.batch.get`、`commercial.order.payment.get`、`support.customer.replies.list`、`workspace.data.export.get`、`billing.recharge.get`、`catalog.image.get`、`rule.history`、`brand.get`、`task.resume`、`task.timeline`、`feedback.list`、`generation.get`、`content.versions`、`content.diff`。大多要求本 QA 工作区真实对象 ID；无对象时应记“前置数据缺失”，不可用其他租户 ID 或虚构成功。

**可逆写入 3 项**：`platform.store.alias.set`、`catalog.product.disable`、`catalog.product.enable`。

**受限写入 60 项**：`merchant.start`、`merchant.first_value`、`brand-unit.create`、`brand-unit.bind-store`、`brand-unit.product.create`、`brand-unit.listing.create`、`brand-unit.access.grant`、`campaign.batch.create`、`campaign.batch.pause`、`campaign.batch.resume`、`workspace.interactive.confirm`、`workspace.data.export.request`、`platform.mapping.preflight`、`catalog.title.optimize`、`catalog.title.accept`、`catalog.import`、`catalog.import.batch`、`catalog.sku.update`、`catalog.product.update`、`catalog.facts.confirm`、`catalog.image.generate`、`catalog.image.select`、`catalog.image.review`、`asset.parse`、`asset.facts.confirm`、`asset.preference.update`、`brand.upsert`、`asset.upload`、`asset.upload.batch`、`asset.generation.confirm`、`asset.rights.update`、`task.clone`、`feedback.submit`、`task.create`、`task.create.draft`、`task.answer`、`task.request.create`、`task.sku.split`、`task.group.create`、`creative.brief`、`creative.preview`、`creative.directions.update`、`task.select_direction`、`task.plan.confirm`、`content.generate`、`content.draft.generate`、`content.review.decide`、`content.visual.select`、`content.export`、`content.approve`、`content.restore`、`knowledge.rule.create`、`knowledge.asset.create`、`knowledge.asset.update`、`knowledge.brand.preference.update`、`knowledge.feedback.record`、`knowledge.learning.confirm`、`knowledge.learning.dismiss`、`knowledge.competitor.create`、`knowledge.competitor.reference`。

**预期阻断 7 项**：`commercial.service-boundary.accept`、`workspace.invitation.accept`、`commercial.order.create`、`workspace.deactivate`、`workspace.activate`、`workspace.data.delete.request`、`multimodal.image.edit`。这些是安全拒绝验收，不应为了增加调用数而在生产发起实际购买、停用或删除。

## 后续增量记录

每批以新会话原始工具事件为准，记录方法、输入类别、`isError`、结构化输出摘要、请求 ID 和工作区身份；逐项区分“调用通达”“预期阻断”“前置数据缺失”“正向业务通过”。跨版本覆盖只作历史累计；当前安装版覆盖单独计数。待 owner 发起新 App 轮次后在此节追加。

### 13:09–13:13，同一 125100 App 会话追加调用

原始文件仍为 `rollout-2026-09-29T12-52-12-01a0eb81-9269-7f60-a1b8-34524cdb72a8.jsonl`。第 62/65 行 `canonical.product.consistency` 返回 `isError=false`，结构化 `workspaceId=ws_57fd2361ed5b44c7891f3d37`；第 87/90 行 `commercial.access.get` 返回 `isError=false`。这两项已在历史 32 项内，用于本会话身份交叉核对，不增加跨版去重数。

| 之前未调用的 14 项 | 原始行号 | 实际结果 | 判定 |
| --- | --- | --- | --- |
| `campaign.batch.get` | 104/107 | `isError=true`；缺 `campaign_id`，插件参数拒绝。 | 调用到达，未测业务读取 |
| `commercial.order.payment.get` | 111/114 | `isError=true`；`COMMERCIAL_ORDER_NOT_FOUND`。 | QA 订单缺失 |
| `support.customer.replies.list` | 116/119、123/126、130/133 | 前两次因不支持 `task_id`、`order_id` 被参数拒绝；仅 `ticket_id` 的第三次为 `INTERNAL_ERROR`。 | **缺陷候选**，未取得列表；需查服务端请求链 |
| `billing.recharge.get` | 137/140 | `isError=true`；`BILLING_ORDER_NOT_FOUND`。 | QA 充值单缺失 |
| `catalog.image.get` | 142/145 | `isError=true`；要求 `job_id` 与 `visual_ref` 恰好提供一个。 | 参数拒绝，未测业务读取 |
| `rule.history` | 147/150 | `isError=true`；`CREATIVE_POINTS_UNAVAILABLE`，余额 `unknown`。 | 商业门禁 |
| `brand.get` | 154/157 | `isError=false`；中文说明当前范围未找到品牌档案，未返回品牌对象。 | 空态读取 |
| `workspace.data.export.get` | 177/186 | `isError=true`；`WORKSPACE_DATA_EXPORT_NOT_FOUND`。 | QA 导出单缺失 |
| `task.resume`、`task.timeline`、`feedback.list`、`generation.get`、`content.versions`、`content.diff` | 177/186 | 六项各 `isError=true`；均为 `CREATIVE_POINTS_UNAVAILABLE`，余额 `unknown`。 | 商业门禁 |

第二批 7 项在一个 `functions.exec` 调用内逐项产生原始 MCP 返回；第 186 行按标签提取七个 `isError` 和 `structuredContent.code`，没有采用最终自然语言答复。**至 13:13，原先 84 项中的 14 项已在当前版 App 调用，跨版本历史累计调用覆盖为 46/116，仍有 70 项从未在 App 调用。125100 版本身累计 18/116；上述 14 项没有一个有真实对象的正向业务通过。**剩余 70=可逆写入 3+受限写入 60+预期阻断 7；上节“84 项”仍为执行前基线，不能作当前未调用数量。

### 13:14，可逆写入和预期阻断 10 项

同一原始会话第 208–272 行依次调用下表 10 项，逐项有独立 `custom_tool_call_output`。输入均为拒绝路径参数；没有以这些返回证明业务写入或审计/账本无变化。

| 方法 | 原始调用/输出行 | `structuredContent.code` | 结论 |
| --- | --- | --- | --- |
| `platform.store.alias.set` | 208/211 | `CREATIVE_POINTS_UNAVAILABLE` | 余额 unknown，安全停止 |
| `catalog.product.disable` | 215/218 | `CREATIVE_POINTS_UNAVAILABLE` | 同上 |
| `catalog.product.enable` | 222/225 | `CREATIVE_POINTS_UNAVAILABLE` | 同上 |
| `commercial.service-boundary.accept` | 229/232 | `CREATIVE_POINTS_UNAVAILABLE` | 同上 |
| `workspace.invitation.accept` | 236/239 | `CREATIVE_POINTS_UNAVAILABLE` | 同上 |
| `commercial.order.create` | 243/246 | `INTERACTIVE_WRITE_DISABLED` | 本地交互写门禁拒绝 |
| `workspace.deactivate` | 250/253 | `CREATIVE_POINTS_UNAVAILABLE` | 余额 unknown，安全停止 |
| `workspace.activate` | 257/260 | `CREATIVE_POINTS_UNAVAILABLE` | 同上 |
| `workspace.data.delete.request` | 262/265 | `INTERACTIVE_WRITE_DISABLED` | 本地交互写门禁拒绝 |
| `multimodal.image.edit` | 269/272 | `CREATIVE_POINTS_UNAVAILABLE` | 余额 unknown，安全停止 |

十项均 `isError=true`，无正向业务通过。**至 13:14，历史 App 调用覆盖 56/116，当前 125100 版 28/116；尚无 App 调用的 60 项均为受限写入。**生产侧的副作用不由 `isError` 单独证明，应结合服务端读回与审计核对。

### 13:15，首批受限写入 13 项

同一会话第 294–381 行逐项调用：`merchant.start`、`merchant.first_value`、`brand-unit.create`、`brand-unit.bind-store`、`brand-unit.product.create`、`brand-unit.listing.create`、`brand-unit.access.grant`、`campaign.batch.create`、`campaign.batch.pause`、`campaign.batch.resume` 均 `isError=true`、`CREATIVE_POINTS_UNAVAILABLE`。`workspace.data.export.request` 第 364/367 行被本地 schema 拒绝，缺少 `reason`；`platform.mapping.preflight` 第 371/374 行为 `INTERACTIVE_WRITE_DISABLED`；`workspace.interactive.confirm` 第 378/381 行为 `INTERACTIVE_CONFIRMATION_REQUIRED`。均没有正向写入通过证据。**此刻历史 App 调用覆盖 69/116，当前版 41/116，仍有 47 项未调用。**

### 13:16–13:17，商品与品牌 11 项

同一会话第 403–464 行分别调用 `catalog.title.optimize`、`catalog.title.accept`、`catalog.import`、`catalog.import.batch`、`catalog.sku.update`、`catalog.product.update`、`catalog.facts.confirm`、`brand.upsert`、`catalog.image.select`、`catalog.image.review`、`catalog.image.generate`，每项均有独立原始输出，均 `isError=true`、`CREATIVE_POINTS_UNAVAILABLE`。这是余额 `unknown` 时的安全门禁，不证明商品导入、更新、标题优化或图片生成已完成。**至 13:17，历史 App 调用覆盖 80/116，当前版 52/116，仍有 36 项未调用。**

### 13:17，资产与创意 10 项

同一会话第 484–538 行调用 `asset.parse`、`asset.facts.confirm`、`asset.preference.update`、`asset.upload.batch`、`asset.generation.confirm`、`asset.rights.update`、`creative.brief`、`creative.preview`、`creative.directions.update`、`asset.upload`。十项各有原始 MCP 输出，均 `isError=true`、`CREATIVE_POINTS_UNAVAILABLE`；没有证明上传、解析、生成或偏好修改成功。**至 13:17:43，历史 App 调用覆盖 90/116，当前版 62/116，仍有 26 项未调用。**

### 13:19，任务 10 项

同一会话第 560–626 行调用 `task.clone`、`feedback.submit`、`task.create`、`task.create.draft`、`task.answer`、`task.request.create`、`task.sku.split`、`task.group.create`、`task.select_direction`、`task.plan.confirm`。十项各有独立原始输出，均 `isError=true`、`CREATIVE_POINTS_UNAVAILABLE`；未创建任务、正式草稿或反馈的正向证据。**至 13:19:25，历史 App 调用覆盖 100/116，当前版 72/116，仍有内容 7 项、知识 9 项未调用。**

### 13:19–13:20，内容 7 项

同一会话第 650–695 行调用 `content.generate`、`content.draft.generate`、`content.review.decide`、`content.visual.select`、`content.approve`、`content.restore`、`content.export`。七项各有独立原始输出，均 `isError=true`、`CREATIVE_POINTS_UNAVAILABLE`；没有生成、审核、导出成功证据。**至 13:20:04，历史 App 调用覆盖 107/116，当前版 79/116，仍有知识写入 9 项未调用。**

### 13:20–13:21，知识写入 9 项

同一会话第 717–776 行调用 `knowledge.rule.create`、`knowledge.asset.create`、`knowledge.asset.update`、`knowledge.brand.preference.update`、`knowledge.feedback.record`、`knowledge.learning.confirm`、`knowledge.learning.dismiss`、`knowledge.competitor.create`、`knowledge.competitor.reference`。九项各有独立原始输出，均 `isError=true`、`CREATIVE_POINTS_UNAVAILABLE`。第 779 行的用户可见 ChatGPT App 答复用中文说明九项已调用、被余额门禁停止、没有业务成功；其中“未转发业务请求”是模型答复文字，本审计未用它替代服务端日志/副作用读回。

## 13:21 中间态：首轮剩余 84 项完成

精确方法名与 116 项清单逐项交叉核对：此时**跨版本不同方法真实 App 调用覆盖 116/116**；其中旧四轮基线 32 项，本轮把剩余 84 项全部调用一遍。13:21 这一时间点，当前 `0.1.0+codex.20260929125100` 版同一会话覆盖 **88/116**：原有四项加本轮 84 项；**5 项 `isError=false`，83 项 `isError=true`**。当时尚有 28 项只在早期版本调用，已于 13:22–13:24 在当前版补跑；最终状态见下节。

本轮新增 84 项按结果分类：

| 分类 | 数量 | 含义 |
| --- | ---: | --- |
| `CREATIVE_POINTS_UNAVAILABLE` | 72 | 点数余额 `unknown`，商业门禁安全停止；不代表功能正向通过 |
| 找不到本 QA 工作区订单或导出单 | 3 | `COMMERCIAL_ORDER_NOT_FOUND`、`BILLING_ORDER_NOT_FOUND`、`WORKSPACE_DATA_EXPORT_NOT_FOUND` |
| 插件参数拒绝 | 3 | `campaign.batch.get` 缺 ID、`catalog.image.get` 缺恰好一个引用、`workspace.data.export.request` 缺 reason；`support.customer.replies.list` 还出现两次额外参数拒绝重试 |
| 本地交互写入门禁拒绝 | 3 | `commercial.order.create`、`workspace.data.delete.request`、`platform.mapping.preflight` |
| 待人工确认 | 1 | `workspace.interactive.confirm` 返回 `INTERACTIVE_CONFIRMATION_REQUIRED` |
| 内部错误 | 1 | `support.customer.replies.list` 仅带 `ticket_id` 的重试返回 `INTERNAL_ERROR`，需定位真实根因 |
| 空态只读，非错误 | 1 | `brand.get` 明确无品牌档案，未返回业务对象 |
| **合计** | **84** | **新增 84 项均没有正向业务流程通过证据** |

原始会话路径：`~/.codex/sessions/2026/09/29/rollout-2026-09-29T12-52-12-01a0eb81-9269-7f60-a1b8-34524cdb72a8.jsonl`。计数依据是各 `custom_tool_call` 的精确 `mcp__merchant_marketing__*` 方法与相同 `call_id` 的 `custom_tool_call_output`；第 177/186 行的 7 项合并调用按各自标签逐一配对。第 779 行为知识写入批次用户可见的中文 App 答复。

## 13:24 最终状态：当前版 116/116 已调用

同一 125100 App 会话继续补跑早期版本已调用、但本版尚未调用的 28 项只读方法。原始第 798–890 行有 14 项：`workspace.health`、`brand-unit.list`、`brand-unit.listing.list`、`campaign.batch.list`、`workspace.invitations.list`、`workspace.metrics`、`commercial.catalog.get`、`creative-points.balance.get`、`creative-points.statement.list`、`subscription.get`、`subscription.orders.list`、`billing.export`、`billing.status`、`billing.model-usage.statement`；其中 9 项非错误，5 项余额或权益门禁。第 914–1008 行有另 14 项：`billing.recharge.list`、`billing.transactions`、`catalog.categories`、`rule.list`、`rule.sync.status`、`asset.list`、`brand.extract`、`deliverable.list`、`task.history`、`knowledge.rule.list`、`knowledge.asset.list`、`knowledge.brand.preference.get`、`knowledge.learning.list`、`catalog.search`；其中 8 项非错误，6 项余额门禁。`catalog.search` 只传入当前工作区范围和明确不存在的 QA 查询词，返回门禁，不能解释成“没有匹配商品”。第 1013 行用户可见的中文 App 答复逐项说明第二批的空态、后台入口和门禁，没有把门禁结果写成查询成功。

最终将当前版全部 `custom_tool_call` 与相同 `call_id` 输出逐项配对，并按精确方法去重：**116/116 个方法全部在真实 ChatGPT App 中调用，22 项 `isError=false`，94 项 `isError=true`；无遗漏或清单外方法。** 当前版 22 项非错误只说明入门、状态、空态或后台入口可读取；94 项中的多数是创意点余额 `unknown` 引发的安全门禁。**业务正向闭环尚未通过**，尤其商品导入、资产上传、创意生成、审核导出、商业订单及店铺绑定缺真实 QA 对象和权益；还需服务端读回、账本/审计、模型中转用量与成本证据。

创意点门禁的独立根因：`demo@sn.com` 是本轮新建商家账号，只绑定专用 QA 工作区 `ws_57fd2361ed5b44c7891f3d37`；独立余额 GET 为 `unknown`/`null`，该工作区创意点 grant 与 ledger 为 0。贵人鸟工作区**历史授予累计 12600 点，当前可用余额未在此核算**；该历史授予属于另一个工作区，不能跨租户转给 QA。[专用 QA 工作区只读核查](independent-qa-workspace-readonly-plan.md)确认商家身份无贵人鸟工作区成员或绑定，现有演示权益受数据库约束仅归贵人鸟工作区。不能用共享余额或其他租户数据把门禁伪装成通过。
