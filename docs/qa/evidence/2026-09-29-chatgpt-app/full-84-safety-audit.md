# 剩余工具真实 App 调用前的副作用审计（2026-09-29）

范围：本地商家 bridge `apps/plugin/mcp/bridge.mjs` 所列 116 个方法、[116 项清单](../../2026-09-29-chatgpt-app-116-tool-checklist.md)及生产 API 当前源码。此文是**静态只读审计**，没有调用 ChatGPT App 或生产 API，也不把“调用被拒绝”写成业务通过。不同安装版本的 32 项历史调用不能自动折算为当前版本已通过；owner 必须以当前安装版原始 `custom_tool_call` 与结构化返回逐项核对。

## 关键门禁顺序

`tools/call` 先查方法是否隐藏/禁用，接着应用商业恢复缓存，然后处理 `workspace.interactive.confirm`，再检查 `SAFE_WITHOUT_INTERACTIVE_WRITE` 与 `MERCHANT_MCP_WRITE_ENABLED`，**最后**执行本地 schema 校验并转发 API。`write=false` 只使不在安全豁免集里的写方法返回 `INTERACTIVE_WRITE_DISABLED`；它**不等于只读模式**。对不在豁免集的写方法传 `{}` 会在本地被写门禁拒绝，通常不转发；对豁免集则可能先因 schema 拒绝，也可能带合法参数真实转发。商业恢复缓存还会更早地返回 `CREATIVE_POINTS_UNAVAILABLE` 一类拒绝；因此拒绝结果必须记录命中的具体门禁，不能声称执行了 API 业务前置校验。

本地无效参数 `{"__qa_unknown_field":true}` 只有在当前安装版 schema 的 `additionalProperties:false` 且工具仍受本地校验时才会被拦截；它证明的是**插件边界校验**，不证明生产 API 功能。每次先核对当前 `tools/list` 中该方法的 schema。严禁用一个模型生成的批量提示代替逐项原始工具事件。

## 禁止作为“无副作用读”直接调用的方法

以下是 116 项清单中 70 个非只读方法的精确集合。除下方明示的纯示例/空参数分支外，在 QA 工作区、权益、对象及回退证据未齐备时，不给模型提供合法业务参数，也不打开 `workspace.interactive.confirm`：

| 类别 | 方法 | `write=false` 的真实含义 / 安全替代 |
| --- | --- | --- |
| 可逆但会改业务状态（3） | `platform.store.alias.set`, `catalog.product.disable`, `catalog.product.enable` | 本地拒绝；用 `platform.store.list`（当前商家插件隐藏，不能从 App 调）、`catalog.search` 或同租户后台只读核对。不能为凑工具数在生产禁用再启用。 |
| 身份、空间、商户、订单、数据生命周期（12） | `merchant.start`, `merchant.first_value`, `brand-unit.create`, `brand-unit.bind-store`, `brand-unit.product.create`, `brand-unit.listing.create`, `brand-unit.access.grant`, `workspace.interactive.confirm`, `workspace.data.export.request`, `platform.mapping.preflight`, `commercial.service-boundary.accept`, `commercial.order.create` | `merchant.start` 有明确目标时持久化 intent；`merchant.first_value` 只有 `{"example":"true"}` 为静态示例。`workspace.data.export.request` 在 `write=false` 下仍可转发并创建持久导出申请及审计；订单创建也属恢复豁免但不在安全写豁免集，`write=false` 会本地拒绝。读替代：`onboarding.status`, `workspace.health`, `commercial.access.get`, `commercial.catalog.get`, `subscription.orders.list`, `workspace.data.export.get`（需真实本租户申请 ID）。 |
| 批量计划和商品事实（14） | `campaign.batch.create`, `campaign.batch.pause`, `campaign.batch.resume`, `catalog.title.optimize`, `catalog.title.accept`, `catalog.import`, `catalog.import.batch`, `catalog.sku.update`, `catalog.product.update`, `catalog.facts.confirm`, `catalog.image.generate`, `catalog.image.select`, `catalog.image.review`, `brand.upsert` | 图片生成在 `write=false` 下**可转发**，会调用中转、建立作业、结算；图片选择会写偏好；图片审阅带 `visual_refs_json` 会持久化审阅结果。读替代：`canonical.product.consistency`, `catalog.search`, `brand.get`, `catalog.image.get`（仅在无候选或已知安全状态，见下节）。 |
| 素材和任务（19） | `asset.parse`, `asset.facts.confirm`, `asset.preference.update`, `asset.upload`, `asset.upload.batch`, `asset.generation.confirm`, `asset.rights.update`, `task.clone`, `feedback.submit`, `task.create`, `task.create.draft`, `task.answer`, `task.request.create`, `task.sku.split`, `task.group.create`, `creative.brief`, `creative.preview`, `creative.directions.update`, `task.select_direction` | `asset.upload` 在 `write=false` 下**可转发**，会上传本地文件/字节、建素材、扫描；其余按对应真实对象写状态、任务或调用模型。读替代：`asset.list`, `task.history`, `task.timeline`, `feedback.list`, `deliverable.list`。 |
| 方案、内容、知识库（22） | `task.plan.confirm`, `content.generate`, `content.draft.generate`, `content.review.decide`, `content.visual.select`, `content.export`, `content.approve`, `content.restore`, `knowledge.rule.create`, `knowledge.asset.create`, `knowledge.asset.update`, `knowledge.brand.preference.update`, `knowledge.feedback.record`, `knowledge.learning.confirm`, `knowledge.learning.dismiss`, `knowledge.competitor.create`, `knowledge.competitor.reference`, `workspace.invitation.accept`, `workspace.deactivate`, `workspace.activate`, `workspace.data.delete.request`, `multimodal.image.edit` | `content.export` 在 `write=false` 下可转发且会在过期时持久化交付状态，也可能生成本机产物；`knowledge.competitor.reference` 会写操作审计。`workspace.deactivate` 与删除申请风险最高，必须留在隔离演练。读替代：`content.versions`, `content.diff`, `knowledge.*.list`。 |

上表按业务解释，**计数以清单原始 3+60+7=70 个不重复方法为准**。任何 `INTERACTIVE_WRITE_DISABLED`、schema 错误、余额拒绝或 403 只能记录“门禁验证”，不能算完整功能通过。

## `write=false` 仍可能转发的精确豁免方法

`SAFE_WITHOUT_INTERACTIVE_WRITE` 中在商家 116 工具面且不属于 `READ_ONLY_METHODS` 的方法是：`merchant.start`, `merchant.first_value`, `content.export`, `catalog.image.review`, `catalog.image.select`, `knowledge.competitor.reference`, `asset.upload`, `catalog.image.generate`, `workspace.data.export.request`, `workspace.interactive.confirm`。后两项尤其不能以“无模型、无商品写入”理解为安全：导出申请会写记录和审计；确认工具若传正确常量会打开交互写窗口且 API 可能写确认票据。`platform.connect`, `catalog.sync`, `catalog.sync.start` 也在豁免集中，但**当前商家插件隐藏**，不得算进 116 项 App 测试。

可以在真实 App 安全执行的唯一特定分支：`merchant.first_value({"example":"true"})`，API 明确返回静态示例、`modelCalled:false`，不属于真实商家资料或生成闭环。`merchant.start({})` 不记 intent，但仍需服务端身份与商业判定；如需调用只记录读到的入门状态，不给目标、平台或附件数。`catalog.image.review` 带真实候选引用会持久化审阅状态；`catalog.image.select` 即使 `write=false` 也可凭确认票据写偏好；禁止在只读批次传合法候选与票据。`knowledge.competitor.reference` 即使只是生成参考也明确调用 `recordOperationAudit`。`asset.upload`、`catalog.image.generate` 禁止作为无写批次验证。

## 标注只读但可能持久化的精确方法

- `campaign.batch.get` 调用 `refreshCampaignProgress`，当任务状态改变时 `updateCampaignProgress` 写持久批次状态。`campaign.batch.list` 当前没有调用刷新，但会读取和生成交付清单；空 QA 工作区列表可安全验证，已有批次的详情应暂缓。
- `catalog.image.get` 在遇到终止 worker 错误时写失败状态，在干净候选归档完成时写归档快照，还会 `issueImageSelectionTickets` 写一次性选择票据。因此已有生成作业的轮询不是严格只读；在空 QA 工作区无 job ID 时，只能进行本地 schema 验证，不要凭虚构 ID 声称验收。
- `content.export` 未标成只读，但被写豁免；处理时先 `persistExpiredDeliveryIfNeeded`，可持久化过期交付状态，且可能创建本机导出文件。需真实审核版本及单独副作用对账。
- `brand.extract` 调 `service.extractBrandProfile`，当前未看到持久化调用；无素材时只作候选提取/空态，不能称已完成品牌档案创建。
- `task.resume` 调 `service.resumeTask`，源码没有显式 `persistSnapshot`；需核对服务方法是否更新内存/懒加载状态及现有任务版本。当前 QA 无任务，勿虚构 ID。
- 任何远端只读 HTTP/MCP 请求仍可能形成接入日志、安全审计或访问统计，故“无业务写入”不等于系统完全无痕。

## 可以先用 `{}` 查询的只读方法

按现有 116 清单，31 项的最小参数是 `{}`：`onboarding.status`, `brand-unit.list`, `brand-unit.listing.list`, `canonical.product.consistency`, `campaign.batch.list`, `workspace.health`, `workspace.invitations.list`, `workspace.metrics`, `commercial.access.get`, `commercial.catalog.get`, `creative-points.balance.get`, `creative-points.statement.list`, `subscription.get`, `subscription.orders.list`, `billing.export`, `billing.status`, `billing.model-usage.statement`, `billing.recharge.list`, `billing.transactions`, `catalog.categories`, `rule.list`, `rule.sync.status`, `asset.list`, `brand.extract`, `deliverable.list`, `task.history`, `knowledge.rule.list`, `knowledge.asset.list`, `knowledge.brand.preference.get`, `knowledge.learning.list`, `knowledge.competitor.list`。其中 `brand.extract({})` 是对当前素材提取**候选**，可能返回空态；`billing.export({})` 可能只给后台入口；`campaign.batch.list({})` 仅按当前 handler 未触发进度写入。其他 15 项只读方法以清单中的本租户真实参数调用，不能凭占位 ID 或 404 算通过。

## 给 owner 的执行规则

1. 在**当前 App 会话**先以 `commercial.access.get({})`、`subscription.get({})`、`canonical.product.consistency({})` 的结构化工作区 ID 同时证明是 `demo@sn.com` 的独立 QA 租户；出现贵人鸟共享工作区结果时立即停止后续调用。
2. 无对象依赖的只读方法可以用 `{}` 逐项测，逐项记录 `isError`、错误码、结构化结果与租户 ID。对象读取必须填本租户真实 ID；不存在就标“前置数据缺失”，不要用假 ID 刷计数。
3. 对大多数写方法，`write=false` 下传 `{}` 可以验证本地 `INTERACTIVE_WRITE_DISABLED`；这只是安全门禁覆盖。对上节 10 个豁免方法，先核对 schema 再用明确无效字段做**本地**契约拒绝，不能误触合法写入。
4. 只在本租户专用商品、素材、权益和回退路径齐备后，分批开启交互写并做真实结果、审计、账本、模型用量成本和同租户读回。用户说专用资源稍后提供，当前不以共享贵人鸟数据替代。

代码依据：`apps/plugin/mcp/bridge.mjs` 的 `READ_ONLY_METHODS`、`SAFE_WITHOUT_INTERACTIVE_WRITE`、`recoveryOnlyResult` 和 `tools/call` 顺序；`apps/api/src/server.ts` 的商业分类与实际分发；`apps/api/src/mcp-workspace-lifecycle-handlers.ts`、`mcp-image-handlers.ts`、`mcp-knowledge-handlers.ts`、`mcp-content-version-handlers.ts`、`mcp-campaign-handlers.ts`、`campaign-runtime.ts` 的具体副作用。
