# 160709 版插件下一轮逐项验收矩阵（只读审计）

核对对象：本地已安装 `0.1.0+codex.20260929160709`，商家工作区 `ws_57fd2361ed5b44c7891f3d37`。此文是执行计划及证据分级，**没有发起生产写入**。参数来自[116 项原始清单](../../2026-09-29-chatgpt-app-116-tool-checklist.md)；`<...>` 必须替换为**本工作区真实读回值**，不能作为测试参数直接发送。方法分类与运行门禁按 `apps/plugin/mcp/bridge.mjs` 当前源码及 CodeGraph `READ_ONLY_METHODS`、`recoveryOnlyResult`、`handle` 影响链复核。CodeGraph 索引为 2356 文件、33871 节点、132829 边，另有 1 新增/3 修改未同步，因此仍以磁盘源码和原始运行记录为准。

## 严格证据分层

| 层级 | 当前证据 | 计数含义 |
| --- | --- | --- |
| 当前真实 ChatGPT App，160709 版 | [16:40:46 桌面会话](164046-desktop-onboarding-call.md) 已调用 `onboarding.status` 一次，保留同 `call_id` 的中文正文；该脚本未输出结构化工作区 | **1/116 实际调用，0 项正向业务闭环**。需继续补身份和结构化结果。 |
| 当前安装 stdio，160709 版 | 独立 bridge 仅执行 `tools/list`，116 名一致，46 项标只读；未发送 `tools/call` | **116/116 被发现，0/116 被执行**。不能当作 App 或 API 验收。 |
| 历史真实 App，153500 版 | [原始调用审计](153500-app-call-audit.md)：8 个不同方法、9 次调用；两份 XLSX 的 `asset.upload` 均因 `CREATIVE_POINTS_UNAVAILABLE` 被拒 | **8/116 历史版入口覆盖，0 项上传闭环**；不可继承到 160709。 |
| 历史真实 App，143500 版 | [正向矩阵](positive-business-coverage-matrix.md)：116/116 实际调用，22 项非错误、94 项错误或门禁 | 仅说明旧版调用覆盖；**不是 116 项业务通过**。 |
| API/隔离测试 | 各域已有定向证据；部分缺真实订单、点数、店铺、商品与任务，生产 schema 254 对候选 255 有发布门禁 | 逐项只算该层证据，不与 App 累加成“通过”。 |

## 最小安全执行顺序

1. **App 身份三项**：从 160709 版新会话真实调用 `commercial.access.get({})`、`subscription.get({})`、`canonical.product.consistency({})`，核对三个结构化结果的工作区均为 `ws_57fd2361ed5b44c7891f3d37`，账号是 `demo@sn.com` 的 QA 作用域。若工作区不同，停止。
2. **剩余无必填参数只读项**：清单中此类共 31 项，扣除上面 3 项后有 **28 项**。逐项保存调用、同 `call_id` 输出、`isError`、错误码、结构化工作区和中文用户可见答复。`brand.extract({})` 仅可算候选/空态；`billing.export({})` 仅可能返回后台入口；`campaign.batch.list({})` 在当前空 QA 工作区可查询，但有真实批次时先核对进度副作用。
3. **15 项带对象/查询参数的只读项**：先由本工作区列表、订单、任务等读回真实 ID；无对象则记“前置数据缺失”，不传伪造 ID 刷覆盖。`campaign.batch.get` 可刷新持久进度，`catalog.image.get` 可写归档/票据，这两项有对象时还要副作用对账。
4. **70 项非只读**：当前 QA 工作区商业权益/点数未知。未取得正式权益和专用对象前，仅做已安装 stdio/隔离测试的契约与拒绝验证；不以生产 `write=false` 当作全局只读开关。`merchant.first_value({"example":"true"})` 是已审计的静态示例分支，但商业恢复缓存仍可能先拒绝；即使返回也只算示例展示。`asset.upload`、模型生成、订单、停用、删除、发布等要等真实授权、回退和账务审计后逐项正向验收。

下面“App”列除 `onboarding.status` 外，当前 160709 版均**未调用**；它不覆盖上表的历史证据。“可执行条件”是下一次正向测试所需资源，而不是目前已满足的事实。

## 46 项只读

| 序号 | 工具 | 最小参数 | 可执行条件与验收边界 | 160709 App |
| ---: | --- | --- | --- | --- |
| 1 | `onboarding.status` | `{}` | 已有桌面调用和中文正文；待补结构化工作区、错误位及权益空态 | 已调用；非闭环 |
| 2 | `brand-unit.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 3 | `brand-unit.listing.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 4 | `canonical.product.consistency` | `{}` | 第一批身份核验；结构化租户一致 | 未调用 |
| 5 | `campaign.batch.list` | `{}` | 第二批；若出现批次，核对进度无副作用 | 未调用 |
| 6 | `campaign.batch.get` | `{"campaign_id":"<已有 QA campaign_id>"}` | 第三批；真实批次 ID，前后核对进度写入 | 未调用 |
| 7 | `workspace.health` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 8 | `workspace.invitations.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 9 | `workspace.metrics` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 10 | `commercial.access.get` | `{}` | 第一批身份核验；结构化租户一致 | 未调用 |
| 11 | `commercial.catalog.get` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 12 | `commercial.order.payment.get` | `{"order_id":"<已有 QA order_id>"}` | 第三批；需本租户现存对象/订单/任务 ID；缺失则待资源 | 未调用 |
| 13 | `creative-points.balance.get` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 14 | `creative-points.statement.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 15 | `support.customer.replies.list` | `{"related_order_id":"<本工作区已有 QA 订单 ID>","limit":"10"}` | 第三批；需本租户现存对象/订单/任务 ID；缺失则待资源 | 未调用 |
| 16 | `subscription.get` | `{}` | 第一批身份核验；结构化租户一致 | 未调用 |
| 17 | `subscription.orders.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 18 | `billing.export` | `{}` | 第二批；后台入口不算 App 内导出 | 未调用 |
| 19 | `workspace.data.export.get` | `{"request_id":"<已有 QA request_id>"}` | 第三批；需本租户现存对象/订单/任务 ID；缺失则待资源 | 未调用 |
| 20 | `billing.status` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 21 | `billing.model-usage.statement` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 22 | `billing.recharge.get` | `{"order_id":"<已有 QA order_id>"}` | 第三批；需本租户现存对象/订单/任务 ID；缺失则待资源 | 未调用 |
| 23 | `billing.recharge.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 24 | `billing.transactions` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 25 | `catalog.search` | `{"scope":"workspace","query":"<本 QA 工作区实际商品货号>"}` | 第三批；需本租户实际商品货号；无结果不算商品流程成功 | 未调用 |
| 26 | `catalog.categories` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 27 | `catalog.image.get` | `{"job_id":"<已生成 QA 图片作业 ID>"}` | 第三批；真实作业 ID，前后核对归档与选择票据 | 未调用 |
| 28 | `rule.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 29 | `rule.sync.status` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 30 | `rule.history` | `{"pack_id":"<已有 QA pack_id>"}` | 第三批；需本租户现存对象/订单/任务 ID；缺失则待资源 | 未调用 |
| 31 | `asset.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 32 | `brand.get` | `{"brand_unit_id":"<本 QA 工作区 brand-unit.list 返回的 ID>"}` | 第三批；需本租户现存对象/订单/任务 ID；缺失则待资源 | 未调用 |
| 33 | `brand.extract` | `{}` | 第二批；只记提取候选/空态，核对未持久化 | 未调用 |
| 34 | `deliverable.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 35 | `task.history` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 36 | `task.resume` | `{"task_id":"<已有 QA task_id>"}` | 第三批；需本租户现存对象/订单/任务 ID；缺失则待资源 | 未调用 |
| 37 | `task.timeline` | `{"task_id":"<已有 QA task_id>"}` | 第三批；需本租户现存对象/订单/任务 ID；缺失则待资源 | 未调用 |
| 38 | `feedback.list` | `{"task_id":"<已有 QA task_id>"}` | 第三批；需本租户现存对象/订单/任务 ID；缺失则待资源 | 未调用 |
| 39 | `generation.get` | `{"job_id":"<已有 QA job_id>"}` | 第三批；需本租户现存对象/订单/任务 ID；缺失则待资源 | 未调用 |
| 40 | `content.versions` | `{"task_id":"<已有 QA task_id>"}` | 第三批；需本租户现存对象/订单/任务 ID；缺失则待资源 | 未调用 |
| 41 | `content.diff` | `{"content_version_id":"<已有 QA content_version_id>"}` | 第三批；需本租户现存对象/订单/任务 ID；缺失则待资源 | 未调用 |
| 42 | `knowledge.rule.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 43 | `knowledge.asset.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 44 | `knowledge.brand.preference.get` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 45 | `knowledge.learning.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |
| 46 | `knowledge.competitor.list` | `{}` | 第二批无参读取；记录真实空态/权限/额度门禁 | 未调用 |

## 70 项非只读

| 序号 | 类别 | 工具 | 最小参数 | 当前前置与安全边界 | 160709 App |
| ---: | --- | --- | --- | --- | --- |
| 1 | 可逆写入 | `platform.store.alias.set` | `{"platform":"<本工作区真实店铺平台>","account_id":"<本工作区真实授权店铺账号>","alias":"<经确认的 alias>","expected_revision":"<刚读回的版本>"}` | 需 QA 实物、前后版本、回退和审计；当前不要为计数写生产 | 未调用 |
| 2 | 可逆写入 | `catalog.product.disable` | `{"product_id":"<已有 QA product_id>","reason":"QA 验收，勿发布"}` | 需 QA 实物、前后版本、回退和审计；当前不要为计数写生产 | 未调用 |
| 3 | 可逆写入 | `catalog.product.enable` | `{"product_id":"<已有 QA product_id>"}` | 需 QA 实物、前后版本、回退和审计；当前不要为计数写生产 | 未调用 |
| 4 | 受限写入 | `merchant.start` | `{}` | 仅空参数可读引导状态；带目标会持久化意图 | 未调用 |
| 5 | 受限写入 | `merchant.first_value` | `{"example":"true"}` | `example=true` 为静态示例，但商业恢复缓存可能先阻断；正向流程需权益与真实资料 | 未调用 |
| 6 | 受限写入 | `brand-unit.create` | `{"name":"<明确标记 QA 的名称>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 7 | 受限写入 | `brand-unit.bind-store` | `{"brand_id":"<已有 QA brand_id>","platform":"<本工作区真实店铺平台>","account_id":"<本工作区真实授权店铺账号>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 8 | 受限写入 | `brand-unit.product.create` | `{"brand_id":"<已有 QA brand_id>","title":"<明确标记 QA 的名称>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 9 | 受限写入 | `brand-unit.listing.create` | `{"brand_id":"<已有 QA brand_id>","canonical_product_id":"<已有 QA canonical_product_id>","platform":"<本工作区真实店铺平台>","account_id":"<本工作区真实授权店铺账号>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 10 | 受限写入 | `brand-unit.access.grant` | `{"brand_id":"<已有 QA brand_id>","external_subject":"<经确认的 external_subject>","role":"viewer"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 11 | 受限写入 | `campaign.batch.create` | `{"brand_id":"<已有 QA brand_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 12 | 受限写入 | `campaign.batch.pause` | `{"campaign_id":"<已有 QA campaign_id>","expected_revision":"<刚读回的版本>","idempotency_key":"<本次唯一 QA 键>","reason":"QA 验收，勿发布"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 13 | 受限写入 | `campaign.batch.resume` | `{"campaign_id":"<已有 QA campaign_id>","expected_revision":"<刚读回的版本>","idempotency_key":"<本次唯一 QA 键>","reason":"QA 验收，勿发布"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 14 | 受限写入 | `workspace.interactive.confirm` | `{"confirmation":"I_CONFIRM_INTERACTIVE_WRITES"}` | 正确确认值会开启写会话；不得纳入只读批次 | 未调用 |
| 15 | 受限写入 | `workspace.data.export.request` | `{"reason":"QA 验收，勿发布","idempotency_key":"<本次唯一 QA 键>"}` | 会持久化导出申请和审计；需单独授权与回读 | 未调用 |
| 16 | 受限写入 | `platform.mapping.preflight` | `{"input_json":"<只含 QA 商品的映射 JSON>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 17 | 受限写入 | `catalog.title.optimize` | `{"product_id":"<已确认 QA 商品 ID>","keyword":"通勤"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 18 | 受限写入 | `catalog.title.accept` | `{"product_id":"<已有 QA product_id>","platform":"jd","suggestion_id":"<已有 QA suggestion_id>","title":"<明确标记 QA 的名称>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 19 | 受限写入 | `catalog.import` | `{"platform":"jd","title":"<明确标记 QA 的名称>","draft_only":"true","local_product_key":"QA-DO-NOT-PUBLISH-<唯一串>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 20 | 受限写入 | `catalog.import.batch` | `{"products_json":"<单条 QA 商品 JSON 数组>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 21 | 受限写入 | `catalog.sku.update` | `{"product_id":"<已有 QA product_id>","sku_id":"<已有 QA sku_id>","stock":"<已核对的 QA 库存>","expected_version":"<刚读回的版本>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 22 | 受限写入 | `catalog.product.update` | `{"product_id":"<已有 QA product_id>","title":"QA 商品标题请勿发布","expected_version":"<刚读回的版本>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 23 | 受限写入 | `catalog.facts.confirm` | `{"product_id":"<已有 QA product_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 24 | 受限写入 | `catalog.image.generate` | `{"product_id":"<已确认 QA 商品 ID>","count":"1"}` | 写入豁免；合法参数可能转发生产 API，需真实授权、资源及副作用对账 | 未调用 |
| 25 | 受限写入 | `catalog.image.select` | `{"job_id":"<已有 QA job_id>","visual_ref":"<经确认的 visual_ref>","expected_revision":"<刚读回的版本>","idempotency_key":"<本次唯一 QA 键>","reason":"QA 验收，勿发布","confirmation_ticket_nonce_hash":"<经确认的 confirmation_ticket_nonce_hash>","confirmation_ticket_intent_hash":"<经确认的 confirmation_ticket_intent_hash>"}` | 写入豁免；合法参数可能转发生产 API，需真实授权、资源及副作用对账 | 未调用 |
| 26 | 受限写入 | `catalog.image.review` | `{"product_id":"<已有 QA product_id>"}` | 写入豁免；合法参数可能转发生产 API，需真实授权、资源及副作用对账 | 未调用 |
| 27 | 受限写入 | `asset.parse` | `{"asset_id":"<已有 QA asset_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 28 | 受限写入 | `asset.facts.confirm` | `{"asset_id":"<已有 QA asset_id>","facts_json":"<经核对的合法 JSON>","reason":"QA 验收，勿发布"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 29 | 受限写入 | `asset.preference.update` | `{"asset_id":"<已有 QA asset_id>","verdict":"unrated"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 30 | 受限写入 | `brand.upsert` | `{"name":"<明确标记 QA 的名称>","brand_unit_id":"<本工作区现有品牌单元 ID>","source":"qa://merchant-confirmed"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 31 | 受限写入 | `asset.upload` | `{"name":"<明确标记 QA 的名称>","mime_type":"<经确认的 mime_type>","file_path":"<本机小型 QA 文本或图片路径>"}` | Excel 原件已尝试两次且因额度未知被拒；需真实权益后回读资产 ID/SHA | 未调用 |
| 32 | 受限写入 | `asset.upload.batch` | `{"assets_json":"<经核对的合法 JSON>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 33 | 受限写入 | `asset.generation.confirm` | `{"job_id":"<已有 QA job_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 34 | 受限写入 | `asset.rights.update` | `{"asset_id":"<已有 QA asset_id>","rights_status":"pending"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 35 | 受限写入 | `task.clone` | `{"task_id":"<已有 QA task_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 36 | 受限写入 | `feedback.submit` | `{"task_id":"<已有 QA task_id>","rating":"liked"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 37 | 受限写入 | `task.create` | `{"product_id":"<已有 QA product_id>","platform":"jd"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 38 | 受限写入 | `task.create.draft` | `{"product_id":"<已有 QA product_id>","platform":"jd"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 39 | 受限写入 | `task.answer` | `{"task_id":"<已有 QA task_id>","answers_json":"<经核对的合法 JSON>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 40 | 受限写入 | `task.request.create` | `{"request_text":"为 QA 商品制作待审核候选，勿发布"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 41 | 受限写入 | `task.sku.split` | `{"task_id":"<已有 QA task_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 42 | 受限写入 | `task.group.create` | `{"entries_json":"<经核对的合法 JSON>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 43 | 受限写入 | `creative.brief` | `{"product_id":"<已有 QA product_id>","asset_type":"banner"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 44 | 受限写入 | `creative.preview` | `{"product_id":"<已有 QA product_id>","asset_type":"banner"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 45 | 受限写入 | `creative.directions.update` | `{"task_id":"<已有 QA task_id>","action":"regenerate"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 46 | 受限写入 | `task.select_direction` | `{"task_id":"<已有 QA task_id>","direction_id":"<已有 QA direction_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 47 | 受限写入 | `task.plan.confirm` | `{"task_id":"<已有 QA task_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 48 | 受限写入 | `content.generate` | `{"task_id":"<已有 QA task_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 49 | 受限写入 | `content.draft.generate` | `{"draft":"true","draft_title":"QA 候选请勿发布","idempotency_key":"<本次唯一 QA 键>","draft_prompt":"仅制作待审核候选，不发布"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 50 | 受限写入 | `content.review.decide` | `{"content_version_id":"<已有 QA content_version_id>","code":"<审核项代码>","field":"<经确认的 field>","status":"acknowledged"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 51 | 受限写入 | `content.visual.select` | `{"content_version_id":"<已有 QA content_version_id>","visual_refs_json":"<经核对的合法 JSON>","expected_revision":"<刚读回的版本>","reason":"QA 验收，勿发布"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 52 | 受限写入 | `content.export` | `{"content_version_id":"<已审核 QA 版本 ID>","format":"manifest"}` | 写入豁免；合法参数可能转发生产 API，需真实授权、资源及副作用对账 | 未调用 |
| 53 | 受限写入 | `content.approve` | `{"task_id":"<已有 QA task_id>","content_version_id":"<已有 QA content_version_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 54 | 受限写入 | `content.restore` | `{"content_version_id":"<已有 QA content_version_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 55 | 受限写入 | `knowledge.rule.create` | `{"name":"<明确标记 QA 的名称>","content":"<经确认的 content>","scope":"global","source_kind":"internal","source_reference":"qa://internal-rule","source_checked_at":"<当前 ISO 时间>","version":"<实际版本>","status":"draft"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 56 | 受限写入 | `knowledge.asset.create` | `{"kind":"brand","name":"<明确标记 QA 的名称>","content_json":"<经核对的合法 JSON>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 57 | 受限写入 | `knowledge.asset.update` | `{"asset_id":"<已有 QA asset_id>","content_json":"<经核对的 QA 内容 JSON>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 58 | 受限写入 | `knowledge.brand.preference.update` | `{"preferences_json":"<经核对的合法 JSON>","version":"<实际版本>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 59 | 受限写入 | `knowledge.feedback.record` | `{"kind":"feedback","reason":"QA 验收，勿发布"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 60 | 受限写入 | `knowledge.learning.confirm` | `{"suggestion_id":"<已有 QA suggestion_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 61 | 受限写入 | `knowledge.learning.dismiss` | `{"suggestion_id":"<已有 QA suggestion_id>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 62 | 受限写入 | `knowledge.competitor.create` | `{"competitor_name":"<明确标记 QA 的名称>","source_json":"<经核对的合法 JSON>","summary":"<经确认的 summary>","structure_json":"<经核对的合法 JSON>","selling_points_json":"<经核对的合法 JSON>","expression_json":"<经核对的合法 JSON>"}` | 需商家确认写会话、可用权益、真实 QA 对象与审计读回 | 未调用 |
| 63 | 受限写入 | `knowledge.competitor.reference` | `{"competitor_id":"<已有 QA competitor_id>","own_brand_name":"<经确认的 own_brand_name>","own_selling_points_json":"<经核对的合法 JSON>"}` | 写入豁免；合法参数可能转发生产 API，需真实授权、资源及副作用对账 | 未调用 |
| 64 | 预期阻断 | `commercial.service-boundary.accept` | `{"policy_version":"<实际版本>","policy_checksum":"<实际校验值>","acceptance_ref":"<真实条款引用>","accepted_at":"<当前 ISO 时间>","idempotency_key":"<本次唯一 QA 键>"}` | 仅隔离环境做拒绝及正向场景；生产 demo 不发送合法写参数 | 未调用 |
| 65 | 预期阻断 | `workspace.invitation.accept` | `{"expected_revision":"<刚读回的版本>"}` | 仅隔离环境做拒绝及正向场景；生产 demo 不发送合法写参数 | 未调用 |
| 66 | 预期阻断 | `commercial.order.create` | `{"purchase_kind":"purchase","sku_code":"<已批准 QA 套餐 SKU>","idempotency_key":"<本次唯一 QA 键>","reason":"QA 验收，勿发布"}` | 仅隔离环境做拒绝及正向场景；生产 demo 不发送合法写参数 | 未调用 |
| 67 | 预期阻断 | `workspace.deactivate` | `{"reason":"QA 验收，勿发布"}` | 仅隔离环境做拒绝及正向场景；生产 demo 不发送合法写参数 | 未调用 |
| 68 | 预期阻断 | `workspace.activate` | `{"reason":"QA 验收，勿发布"}` | 仅隔离环境做拒绝及正向场景；生产 demo 不发送合法写参数 | 未调用 |
| 69 | 预期阻断 | `workspace.data.delete.request` | `{"scope":"<隔离租户范围>","reason":"隔离环境双人审批演练","idempotency_key":"<隔离唯一键>"}` | 仅隔离环境做拒绝及正向场景；生产 demo 不发送合法写参数 | 未调用 |
| 70 | 预期阻断 | `multimodal.image.edit` | `{"request_json":"<经核对的合法 JSON>"}` | 仅隔离环境做拒绝及正向场景；生产 demo 不发送合法写参数 | 未调用 |

## 完成判定

逐项“通过”须同时有：当前版本真实 App 的调用与同 `call_id` 输出、用户可见中文结果、同租户真实业务对象/空态解释；写入还须有服务端请求 ID、审计、前后读回及可回退记录；模型/计费操作再核对中转鉴权、用量、成本和创意点结算。参数错误、403、余额门禁、静态示例、空列表、工具目录发现均按各自层级记录，不计正向业务闭环。
