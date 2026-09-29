# Store Nova 116 项工具：真实 ChatGPT App 验收缺口

审计时间：2026-09-29 11:29 CST。本轮仅核对清单、既有证据、代码调用图和测试报告；未操作 ChatGPT、未调用生产写接口。按 gstack QA 的证据层级区分**工具发现、工具实际调用、业务结果、服务端读回**。完整逐方法参数见[116 项执行清单](../../2026-09-29-chatgpt-app-116-tool-checklist.md)，111500 版状态见[111500 版证据清单](111500-app-tool-evidence-audit.md)，后续 114000 版调用见[114000 版运行日志核对](114000-runtime-log-audit.md)。

## 结论与证据等级

- 清单精确计数为 **116 = 46 只读 + 3 可逆写入 + 60 受限写入 + 7 预期阻断**。本机安装缓存的 `tools/list`、契约对照和 53 个运行文件验真仅证明安装与发现，不能计入 ChatGPT App 通过。
- 截至本审计可读取的证据，**111500 版没有逐方法 App 调用截图或工具事件，116 项均待该版本真实 App 验收**。102500 版的 `onboarding.status`、`brand.get` 以及 `brand-unit.listing.list`、`campaign.batch.list`、`task.history`、`subscription.orders.list`、`brand.extract` 七项画面是历史证据，不向新版继承。后五项截图主要是宿主的调用摘要，尚须展开工具事件。更早版本的 CSV 导入、商品查询和一次文案候选生成也不能折算成新版 116 项全过。
- 11:34 的截图 [39](39-111500-onboarding-status-work.png)只证明 **111500** 版 `onboarding.status({})`。其后 114000 版的同方法调用由运行日志与截图 [40](40-114000-chinese-reply-unverified-tool.png)单独证明，因此 **114000 版仍有 115/116 项待测**；两个版本的证据不合并计数。
- 旧 131 项矩阵中剩余 57 项有 53 项隔离成功路径，3 项 `upload.session.*` 仍不可用且已从当前插件隐藏；这批隔离 HTTP/MCP 结果不证明真实 App、生产权限或模型中转。`merchant.start` 连隔离正向调用仍缺。
- CodeGraph 只读检查：索引 2,343 文件、33,756 节点、132,010 边，当前有 1 个新增和 12 个修改文件未同步。`merchantConversationProjection` 的调用关系连到 `merchantUiMetadata`、`merchantStartContext` 与商家文案净化函数；图证明桥接位置，不证明宿主显示效果。审计以安装版工具清单和现有截图为准，未用未同步索引推断新改动已生效。

## 按功能域的具体缺口

表中“需数据/权限”用于**正向业务闭环**；空列表或预期拒绝只能记为对应只读/负向边界，不算正向完成。所有写入对象应属于独立 QA 商家工作区，且有唯一“QA 请勿发布”标记；现有贵人鸟共享 demo 不应用于全量有状态测试。

| 功能域 | 当前版待测方法 | 需数据、权限及实际验收点 |
| --- | --- | --- |
| 首次使用与工作区 | `onboarding.status`, `merchant.start`, `merchant.first_value`, `workspace.health`, `workspace.metrics`, `workspace.invitations.list`, `workspace.invitation.accept`, `workspace.interactive.confirm`, `workspace.data.export.request`, `workspace.data.export.get`, `workspace.deactivate`, `workspace.activate`, `workspace.data.delete.request` | 新版 App 先独立验证工具确实被调用、工作区 ID 和中文可见结果。正向引导需 QA 商家身份；邀请需真实指定受邀人，导出需请求 ID/worker 完成证据。当前生产 `workspace.invitations.list` 曾见 403，非法导出 ID 曾见 500；应按真实问题复测。停用/恢复仅限 QA 工作区；删除申请及邀请接受以隔离正向或生产授权拒绝为边界，不触碰共享 demo。`merchant.first_value(example=true)` 是示例，不能算真实中转生成。 |
| 品牌、店铺、平台映射 | `brand-unit.list`, `brand-unit.create`, `brand-unit.bind-store`, `brand-unit.product.create`, `brand-unit.listing.create`, `brand-unit.listing.list`, `brand-unit.access.grant`, `brand.get`, `brand.extract`, `brand.upsert`, `canonical.product.consistency`, `platform.store.alias.set`, `platform.mapping.preflight` | 需 QA 品牌单元、已授权归属的测试店铺账号、品牌档案、商品与平台映射，以及品牌 owner/授权角色。现有 `jd:42169` 是贵人鸟共享店铺，不可拿来执行绑定、别名和写入。`brand.get` 返回 null 应显示“未建档”；`brand.extract` 空字段仅证明读取候选。需读回品牌/店铺归属和审计，核对跨租户拒绝。 |
| 商业权益与账务 | `commercial.service-boundary.accept`, `commercial.access.get`, `commercial.catalog.get`, `commercial.order.create`, `commercial.order.payment.get`, `creative-points.balance.get`, `creative-points.statement.list`, `subscription.get`, `subscription.orders.list`, `billing.export`, `billing.status`, `billing.model-usage.statement`, `billing.recharge.get`, `billing.recharge.list`, `billing.transactions`, `support.customer.replies.list` | 需 QA 商家的有效权益、真实 QA 订单/账本/价格与回复记录，财务查看权限；空订单/空回复只验通路。付款订单和服务条款接受不得在共享 demo 造真实商业承诺；订单正向仅隔离环境，生产 App 验证明确授权拒绝。生成前后核对 provider 请求、token 用量、成本、创意点预留/结算，不把 `pending` 当已支付。 |
| 商品目录、图片、规则 | `catalog.search`, `catalog.categories`, `catalog.title.optimize`, `catalog.title.accept`, `catalog.import`, `catalog.import.batch`, `catalog.sku.update`, `catalog.product.update`, `catalog.facts.confirm`, `catalog.product.disable`, `catalog.product.enable`, `catalog.image.generate`, `catalog.image.get`, `catalog.image.select`, `catalog.image.review`, `rule.list`, `rule.sync.status`, `rule.history` | 需 QA 商品货号、至少 2 个真实 SKU、事实来源、版本、规则包及图片作业 ID；标题与图片生成需要有效中转模型、价格/额度。`catalog.import.batch(draft_only)` 仍会持久化，不能在共享工作区试。停用/启用即使可逆也会改状态。规则空列表不能证明规则同步或历史可用；选择图片须真实候选、确认票据、版本及审计。旧运营后台 CSV 成功、XLSX 仅预览，均不代替插件导入与 Excel 提交验收。 |
| 素材、扫描与权益 | `asset.list`, `asset.upload`, `asset.upload.batch`, `asset.parse`, `asset.facts.confirm`, `asset.preference.update`, `asset.generation.confirm`, `asset.rights.update` | 需自有测试图片/文本、本机实际文件路径或小型 base64、MIME/SHA、QA 资产 ID、扫描和版权/授权证据。上传后读回对象存储、扫描、rights 状态；解析需真实模型请求/成本，隔离模拟 provider 不算生产成功。偏好更新需合法 `reasons_json` 和版本；生成确认需先有作业且核对不重复入队。 |
| 任务、活动、反馈 | `campaign.batch.create`, `campaign.batch.list`, `campaign.batch.get`, `campaign.batch.pause`, `campaign.batch.resume`, `deliverable.list`, `task.history`, `task.resume`, `task.clone`, `task.timeline`, `feedback.list`, `feedback.submit`, `task.create`, `task.create.draft`, `task.answer`, `task.request.create`, `task.sku.split`, `task.group.create`, `creative.brief`, `creative.preview`, `creative.directions.update`, `task.select_direction`, `task.plan.confirm` | 需 QA 品牌、商品、活动、任务、方向、交付物及其 ID/修订号。先创建待审核任务，再读回、暂停恢复和反馈；空列表不是闭环。预览可能扣点或触发模型，应核对用量和成本；所有计划保持未发布。 |
| 内容生成、审核、导出 | `content.generate`, `content.draft.generate`, `generation.get`, `content.review.decide`, `content.visual.select`, `content.versions`, `content.diff`, `content.export`, `content.approve`, `content.restore` | 需已确认 QA 商品、扫描/权益通过的素材、任务、审核项、内容版本、视觉候选及人工确认票据。实际 App 应显示候选、待审核状态和导出物，后台读回版本/审计；正式生成需真实中转鉴权、用量、成本和点数结算。历史一次 `content.draft.generate` 成功仅证明当时版本的一次候选，不证明正式审核、批准或当前版。 |
| 知识库与学习 | `knowledge.rule.create`, `knowledge.rule.list`, `knowledge.asset.create`, `knowledge.asset.update`, `knowledge.asset.list`, `knowledge.brand.preference.get`, `knowledge.brand.preference.update`, `knowledge.feedback.record`, `knowledge.learning.list`, `knowledge.learning.confirm`, `knowledge.learning.dismiss`, `knowledge.competitor.create`, `knowledge.competitor.list`, `knowledge.competitor.reference` | 需 QA 品牌资料、内部规则版本与来源、测试竞品样本、学习建议 ID、知识资产版本及有权确认的商家身份。先创建再读回，核对来源、租户隔离、审计和版本；只读空态不能算创建、确认、索引或引用完成。 |
| 多模态图片编辑 | `multimodal.image.edit` | 仅隔离环境正向，或生产 App 受控拒绝；需已扫描且授权的 QA 图片、可计费真实图片中转、候选归档及成本证据。当前模拟 provider 结果不能算真实五模态中转。 |

## 执行前置与记录口径

1. 新版 ChatGPT Work 会话中的 `onboarding.status` 已有工具事件；按只读批次继续记录每项的调用卡、原始结构化结果、可见中文回答、插件版本及时间。工具未暴露时停止整批，不用模型口述补证。
2. 先批量执行 46 个只读项。对象型读取必须有本租户真实 ID；不存在时记录“前置数据缺失”，不能把 404 写成通过。每一项核对服务端读回及必要的无副作用证据。
3. 独立 QA 身份/工作区当前尚未创建；生产只读核查显示仅 1 个工作区，公开注册关闭。开通需平台管理员身份，首次工作区绑定需该 QA 商家会话，本地 stdio 插件令牌必须指向 QA 工作区；细节见[独立工作区计划](independent-qa-workspace-readonly-plan.md)。新身份初始 `vip_access=pending_billing_verification`，不能由开通成功推断写入/模型权益已具备。
4. 写入、审核、生成逐项记录工具名与入参、请求 ID、QA 对象 ID、API/数据库读回、审计、账本前后值和 App 可见中文结果。真实支付、外部发布、删除及共享 demo 数据变更不在此轮正向生产测试中；这些项需明确标为隔离正向、生产预期阻断或仍未验收。

**本文件是缺口审计，不是 116 项测试通过报告。**
