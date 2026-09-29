# Store Nova 111500 版 ChatGPT App 工具证据清单

日期：2026-09-29。只读复核；未调用生产写接口。验收口径遵循 gstack QA 的入口、实际调用、返回值和证据分级；CodeGraph 仅辅助定位调用链。

## 版本与证据边界

- `codex plugin list --json` 显示 `merchant-marketing@merchant-local` 为 `0.1.0+codex.20260929111500`、已安装且启用。`verify-installed-bridge` 返回 `ok=true`：源码与安装镜像均为 **116 工具、53 运行文件**，没有清单漂移；无配置的 `workspace.health` 被 `MCP_CONFIGURATION_REQUIRED` 拒绝。这些是本地安装和契约证据，不是 ChatGPT App 成功。
- CodeGraph 1.5.0 索引状态 `complete`，2343 文件、33756 节点、132010 边、`pendingRefs=0`；有 1 个新增和 1 个修改文件尚未入图。`impact merchantConversationProjection` 指向插件桥接器投影、UI 元数据和 `handle`，证明调用链位置，不证明运行成功。
- 截图 [36](36-102500-onboarding-status-work.png)、[37](37-102500-brand-get-null-work.png)、[38](38-102500-five-readonly-work.png)均标为 **102500** 版，不能继承到 111500。36 显示 `onboarding.status` 的 JSON 业务状态；37 显示 `brand.get` 的无档案文本且无结构化结果；38 的 App 回复报告五项调用及返回：`brand-unit.listing.list` 空、`campaign.batch.list` 空、`task.history` 空、`subscription.orders.list` 空、`brand.extract` 检查 11 件素材但提取字段为空。截图 38 是宿主回复中的调用摘要；若要严格核对工具事件，仍需展开该会话的工具调用记录。
- 新增截图 [39](39-111500-onboarding-status-work.png)（11:34）显示 111500 Work 会话中的原始调用记录：`mcp__merchant_marketing__onboarding__status`，参数 `{}`，结果 `isError=false`。回复报告 `in_progress`、1 家人工运营店铺、1 个商品、11 件素材但无可用素材，生成/审核/发布均阻断；旧版店铺接入状态仅作兼容信息。当前仅该方法有新版 App 级调用证据，截图未展示完整 JSON 结果。
- 因此下表 **115/116 项仍待该版本 App 验收**。此前 App、生产 stdio→API 或隔离 HTTP/MCP 结果按各自版本和层级保留，不折算为 111500 App 通过。

## 当前 116 项逐方法 App 状态

| 精确方法 | 111500 App | 102500 截图 36–38 历史证据 |
| --- | --- | --- |
| `onboarding.status` | 39：调用事件可见，空参数，`isError=false`；摘要显示 `in_progress` 和阻断步骤；完整 JSON 未展示 | 36：JSON 业务状态；截图未展开工具事件 |
| `commercial.service-boundary.accept` | 待测 | — |
| `merchant.start` | 待测 | — |
| `merchant.first_value` | 待测 | — |
| `brand-unit.list` | 待测 | — |
| `brand-unit.create` | 待测 | — |
| `brand-unit.bind-store` | 待测 | — |
| `brand-unit.product.create` | 待测 | — |
| `brand-unit.listing.create` | 待测 | — |
| `brand-unit.listing.list` | 待测 | 38：宿主报告调用，items=[]、count=0 |
| `brand-unit.access.grant` | 待测 | — |
| `canonical.product.consistency` | 待测 | — |
| `campaign.batch.create` | 待测 | — |
| `campaign.batch.list` | 待测 | 38：宿主报告调用，items=[]、count=0 |
| `campaign.batch.get` | 待测 | — |
| `campaign.batch.pause` | 待测 | — |
| `campaign.batch.resume` | 待测 | — |
| `workspace.health` | 待测 | — |
| `workspace.invitations.list` | 待测 | — |
| `workspace.invitation.accept` | 待测 | — |
| `workspace.interactive.confirm` | 待测 | — |
| `workspace.metrics` | 待测 | — |
| `commercial.access.get` | 待测 | — |
| `commercial.catalog.get` | 待测 | — |
| `commercial.order.create` | 待测 | — |
| `commercial.order.payment.get` | 待测 | — |
| `creative-points.balance.get` | 待测 | — |
| `creative-points.statement.list` | 待测 | — |
| `support.customer.replies.list` | 待测 | — |
| `subscription.get` | 待测 | — |
| `subscription.orders.list` | 待测 | 38：宿主报告调用，空数组 |
| `billing.export` | 待测 | — |
| `workspace.data.export.request` | 待测 | — |
| `workspace.data.export.get` | 待测 | — |
| `platform.mapping.preflight` | 待测 | — |
| `billing.status` | 待测 | — |
| `billing.model-usage.statement` | 待测 | — |
| `billing.recharge.get` | 待测 | — |
| `billing.recharge.list` | 待测 | — |
| `billing.transactions` | 待测 | — |
| `workspace.deactivate` | 待测 | — |
| `workspace.activate` | 待测 | — |
| `workspace.data.delete.request` | 待测 | — |
| `platform.store.alias.set` | 待测 | — |
| `catalog.search` | 待测 | — |
| `catalog.categories` | 待测 | — |
| `catalog.title.optimize` | 待测 | — |
| `catalog.title.accept` | 待测 | — |
| `catalog.import` | 待测 | — |
| `catalog.import.batch` | 待测 | — |
| `catalog.sku.update` | 待测 | — |
| `catalog.product.update` | 待测 | — |
| `catalog.facts.confirm` | 待测 | — |
| `catalog.product.disable` | 待测 | — |
| `catalog.product.enable` | 待测 | — |
| `catalog.image.generate` | 待测 | — |
| `catalog.image.get` | 待测 | — |
| `catalog.image.select` | 待测 | — |
| `catalog.image.review` | 待测 | — |
| `rule.list` | 待测 | — |
| `rule.sync.status` | 待测 | — |
| `rule.history` | 待测 | — |
| `asset.list` | 待测 | — |
| `asset.parse` | 待测 | — |
| `asset.facts.confirm` | 待测 | — |
| `asset.preference.update` | 待测 | — |
| `brand.get` | 待测 | 37：无档案文本，isError=false，无结构化结果 |
| `brand.extract` | 待测 | 38：宿主报告调用，11 件素材、fields={}、4 件未读/确认被忽略 |
| `brand.upsert` | 待测 | — |
| `asset.upload` | 待测 | — |
| `asset.upload.batch` | 待测 | — |
| `asset.generation.confirm` | 待测 | — |
| `asset.rights.update` | 待测 | — |
| `deliverable.list` | 待测 | — |
| `task.history` | 待测 | 38：宿主报告调用，items=[]、total=0 |
| `task.resume` | 待测 | — |
| `task.clone` | 待测 | — |
| `task.timeline` | 待测 | — |
| `feedback.list` | 待测 | — |
| `feedback.submit` | 待测 | — |
| `task.create` | 待测 | — |
| `task.create.draft` | 待测 | — |
| `task.answer` | 待测 | — |
| `task.request.create` | 待测 | — |
| `task.sku.split` | 待测 | — |
| `task.group.create` | 待测 | — |
| `creative.brief` | 待测 | — |
| `creative.preview` | 待测 | — |
| `creative.directions.update` | 待测 | — |
| `task.select_direction` | 待测 | — |
| `task.plan.confirm` | 待测 | — |
| `content.generate` | 待测 | — |
| `content.draft.generate` | 待测 | — |
| `generation.get` | 待测 | — |
| `content.review.decide` | 待测 | — |
| `content.visual.select` | 待测 | — |
| `content.versions` | 待测 | — |
| `content.diff` | 待测 | — |
| `content.export` | 待测 | — |
| `content.approve` | 待测 | — |
| `content.restore` | 待测 | — |
| `knowledge.rule.create` | 待测 | — |
| `knowledge.rule.list` | 待测 | — |
| `knowledge.asset.create` | 待测 | — |
| `knowledge.asset.update` | 待测 | — |
| `knowledge.asset.list` | 待测 | — |
| `knowledge.brand.preference.get` | 待测 | — |
| `knowledge.brand.preference.update` | 待测 | — |
| `knowledge.feedback.record` | 待测 | — |
| `knowledge.learning.list` | 待测 | — |
| `knowledge.learning.confirm` | 待测 | — |
| `knowledge.learning.dismiss` | 待测 | — |
| `knowledge.competitor.create` | 待测 | — |
| `knowledge.competitor.list` | 待测 | — |
| `knowledge.competitor.reference` | 待测 | — |
| `multimodal.image.edit` | 待测 | — |

## 建议的只读批次

下一步在 **111500 Work 会话**按只读批次继续，逐项保留工具调用卡、原始结构化结果、可见中文回答、时间和插件版本。`onboarding.status` 已有截图 39 的调用事件；其余方法仍待测。若宿主未暴露 Store Nova 工具，记录阻断并停止该版 App 批测。工具发现、安装状态和模型口述不能替代真实工具事件。

| 批次 | 精确调用与输入 | 可接受的 App 证据 |
| --- | --- | --- |
| 1：工作区与品牌归属 | `workspace.health({})`、`workspace.metrics({})`、`brand-unit.list({})`、`brand-unit.listing.list({})`、`brand.get({})` | 每项有独立调用记录；工作区/店铺数与品牌单元作用域一致。`brand.get` 若为空，必须明确“未建档”，不能说已取得档案。 |
| 2：商业状态 | `commercial.access.get({})`、`commercial.catalog.get({})`、`creative-points.statement.list({limit:"10"})`、`subscription.get({})`、`subscription.orders.list({})` | 显示服务端 decision、目录状态、账本分页、订阅状态与自有订单；`unknown`、`trialing`、`pending` 原样保留，不称已付款或余额确定。 |
| 3：现有素材、规则与任务 | `asset.list({})`、`brand.extract({})`、`rule.list({})`、`campaign.batch.list({})`、`task.history({})` | 显示素材扫描/权益、候选字段和 warnings；空规则、计划和任务只算安全读取，不算业务对象或规则生效。 |
| 4：知识库查询 | `knowledge.rule.list({})`、`knowledge.asset.list({})`、`knowledge.brand.preference.get({})`、`knowledge.learning.list({})`、`knowledge.competitor.list({})` | 每项返回当前工作区范围内的实际记录或明确空态；不得把列表读取算作创建、确认或向量索引成功。 |

以上是批次安排，不是通过记录。每次保留 ChatGPT 中的精确工具名、输入、工具结果、可见回答、时间和插件版本。`merchant.start` 会记录意图，不属于纯只读批次；`workspace.invitations.list` 生产仍有 403，`workspace.data.export.get` 的非法 ID 在线上仍有 500，暂不混入成功批测。
