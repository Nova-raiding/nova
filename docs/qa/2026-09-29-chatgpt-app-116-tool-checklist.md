# Store Nova 114000 版 ChatGPT App 逐项验收清单（116 项）

**114000 版 App 结果：1 项真实调用、业务状态未核实；其余 115 项未在此版 App 正向完成。** 本表是逐项执行清单，不能把调用通达或安装成功写成业务通过。当前核对版本为 `merchant-marketing@merchant-local 0.1.0+codex.20260929114000`；[本地中文插件复测](evidence/2026-09-29-chatgpt-app/114000-chinese-plugin-round.md)记录安装器成功、116 项工具和定向测试。下面的精确方法及最小参数最初取自 **102500 版**安装缓存的 stdio `tools/list`：116 项，响应 SHA-256 `125a4692a94f80036ae00a00e33f783ae8c2ac65da5c3f30691d99b950e6dec6`；对照 `packages/contracts/src/mcp.ts` 的 `MCP_METHOD_SCHEMAS` 必填字段，115 项一致。这个哈希是旧版取样证据，不是 114000 App 调用证据。`asset.upload` 由桥接器接收本机 `file_path` 或 `content_base64` 再转为 API 请求，故其已安装工具 schema 与 API 源合同有意不同。

取样方式：以仅用于发现工具的本地测试环境启动**安装缓存内的 bridge 进程**，向标准输入发送 `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`；地址为 `https://merchant.example.com`，未设置真实令牌，也未发送 `tools/call`。按已安装 `inputSchema.required` 生成表内参数，再与源码 `MCP_METHOD_SCHEMAS` 核对。此取样不会访问生产 API。

[旧 131 项结果矩阵](2026-09-29-plugin-all-tools-matrix.md)及[111500 版证据清单](evidence/2026-09-29-chatgpt-app/111500-app-tool-evidence-audit.md)记录历史版本；其 App 截图、本地或生产 MCP 成功、隔离 E2E、工具发现，均不折算为 114000 版 App 通过。每次验收须保留新会话截图/工具名、输入、结构化输出、服务端请求 ID、同租户读回与审计；有模型调用时还要核对中转鉴权、用量、成本与创意点。

本版唯一实证：11:43:45，ChatGPT 桌面会话调用 `mcp__merchant_marketing__onboarding_status({})`，11:43:45.734 收到中文通用入门说明。该结果没有具体工作区状态、商家身份或结构化业务字段，所以表内记为“App 调用已证实；业务未核实”，**不计业务通过**。依据：[桌面运行日志与会话核对](evidence/2026-09-29-chatgpt-app/114000-runtime-log-audit.md)、[中文回复截图](evidence/2026-09-29-chatgpt-app/40-114000-chinese-reply-unverified-tool.png)。另 115 项仅有其他版本或层级证据，本版一律记“App 未正向完成”。

表中尖括号是占位符，必须用明确标记的 QA 对象与实际读回版本替换；不准把占位符直接提交。`{}` 表示没有 schema 必填参数，不意味着无需前置资源。只读组可在生产 demo 执行；可逆写入只在确认真实对象与回退路径后执行；受限写入需要专用 QA 对象、前置确认和审计；预期阻断组只做安全拒绝验证，成功路径放在隔离环境。任何 404、空结果或门禁都按真实状态记录，不能记为正向业务通过。

## 只读（46 项）

| 方法 | 最小安全参数 | App 预期结果 | 副作用核对 | 114000 App 实际状态 |
| --- | --- | --- | --- | --- |
| `onboarding.status` | `{}` | 返回结构化状态、来源和时间；unknown 不写成成功 | 核对工作区相关快照与操作审计前后差异；读前后应无变化 | 调用已证实；业务未核实 |
| `brand-unit.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | 未在此版 App 正向完成 |
| `brand-unit.listing.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | 未在此版 App 正向完成 |
| `canonical.product.consistency` | `{}` | 返回结构化状态、来源和时间；unknown 不写成成功 | 核对工作区相关快照与操作审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `campaign.batch.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 |
| `campaign.batch.get` | `{"campaign_id":"<已有 QA campaign_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 |
| `workspace.health` | `{}` | 返回结构化状态、来源和时间；unknown 不写成成功 | 核对工作区状态、授权/导出/删除队列与审计；读前后应无变化 | 未在此版 App 正向完成 |
| `workspace.invitations.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对工作区状态、授权/导出/删除队列与审计；读前后应无变化 | 未在此版 App 正向完成 |
| `workspace.metrics` | `{}` | 返回结构化状态、来源和时间；unknown 不写成成功 | 核对工作区状态、授权/导出/删除队列与审计；读前后应无变化 | 未在此版 App 正向完成 |
| `commercial.access.get` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `commercial.catalog.get` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `commercial.order.payment.get` | `{"order_id":"<已有 QA order_id>"}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `creative-points.balance.get` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `creative-points.statement.list` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `support.customer.replies.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对工作区相关快照与操作审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `subscription.get` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `subscription.orders.list` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `billing.export` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `workspace.data.export.get` | `{"request_id":"<已有 QA request_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对工作区状态、授权/导出/删除队列与审计；读前后应无变化 | 未在此版 App 正向完成 |
| `billing.status` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `billing.model-usage.statement` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `billing.recharge.get` | `{"order_id":"<已有 QA order_id>"}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `billing.recharge.list` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `billing.transactions` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `catalog.search` | `{"scope":"workspace","query":"QA-DO-NOT-PUBLISH-20260929"}` | 返回 QA 货号、店铺、库存、事实状态一致的商品 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | 未在此版 App 正向完成 |
| `catalog.categories` | `{}` | 返回结构化只读结果；逐字段核对租户、版本和来源 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | 未在此版 App 正向完成 |
| `catalog.image.get` | `{"job_id":"<已生成 QA 图片作业 ID>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | 未在此版 App 正向完成 |
| `rule.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对工作区相关快照与操作审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `rule.sync.status` | `{}` | 返回结构化状态、来源和时间；unknown 不写成成功 | 核对工作区相关快照与操作审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `rule.history` | `{"pack_id":"<已有 QA pack_id>"}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对工作区相关快照与操作审计前后差异；读前后应无变化 | 未在此版 App 正向完成 |
| `asset.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变；读前后应无变化 | 未在此版 App 正向完成 |
| `brand.get` | `{"brand_unit_id":"<brand-unit.list 返回的贵人鸟 ID>"}` | 返回所选品牌档案或明确 null；null 是未配置，不能算档案成功 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | 未在此版 App 正向完成 |
| `brand.extract` | `{}` | 只返回来源、置信度和待确认候选；不自动建档 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | 未在此版 App 正向完成 |
| `deliverable.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 |
| `task.history` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 |
| `task.resume` | `{"task_id":"<已有 QA task_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 |
| `task.timeline` | `{"task_id":"<已有 QA task_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 |
| `feedback.list` | `{"task_id":"<已有 QA task_id>"}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 |
| `generation.get` | `{"job_id":"<已有 QA job_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 |
| `content.versions` | `{"task_id":"<已有 QA task_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 |
| `content.diff` | `{"content_version_id":"<已有 QA content_version_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 |
| `knowledge.rule.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对知识记录/版本/来源、审计与租户隔离；读前后应无变化 | 未在此版 App 正向完成 |
| `knowledge.asset.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对知识记录/版本/来源、审计与租户隔离；读前后应无变化 | 未在此版 App 正向完成 |
| `knowledge.brand.preference.get` | `{}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对知识记录/版本/来源、审计与租户隔离；读前后应无变化 | 未在此版 App 正向完成 |
| `knowledge.learning.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对知识记录/版本/来源、审计与租户隔离；读前后应无变化 | 未在此版 App 正向完成 |
| `knowledge.competitor.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对知识记录/版本/来源、审计与租户隔离；读前后应无变化 | 未在此版 App 正向完成 |

## 可逆写入（3 项）

| 方法 | 最小安全参数 | App 预期结果 | 副作用核对 | 114000 App 实际状态 |
| --- | --- | --- | --- | --- |
| `platform.store.alias.set` | `{"platform":"jd","account_id":"<QA 店铺账号 42169>","alias":"<经确认的 alias>","expected_revision":"<刚读回的版本>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `catalog.product.disable` | `{"product_id":"<已有 QA product_id>","reason":"QA 验收，勿发布"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `catalog.product.enable` | `{"product_id":"<已有 QA product_id>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |

## 受限写入（60 项）

| 方法 | 最小安全参数 | App 预期结果 | 副作用核对 | 114000 App 实际状态 |
| --- | --- | --- | --- | --- |
| `merchant.start` | `{}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对工作区相关快照与操作审计前后差异 | 未在此版 App 正向完成 |
| `merchant.first_value` | `{"example":"true"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对工作区相关快照与操作审计前后差异 | 未在此版 App 正向完成 |
| `brand-unit.create` | `{"name":"<明确标记 QA 的名称>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `brand-unit.bind-store` | `{"brand_id":"<已有 QA brand_id>","platform":"jd","account_id":"<QA 店铺账号 42169>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `brand-unit.product.create` | `{"brand_id":"<已有 QA brand_id>","title":"<明确标记 QA 的名称>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `brand-unit.listing.create` | `{"brand_id":"<已有 QA brand_id>","canonical_product_id":"<已有 QA canonical_product_id>","platform":"jd","account_id":"<QA 店铺账号 42169>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `brand-unit.access.grant` | `{"brand_id":"<已有 QA brand_id>","external_subject":"<经确认的 external_subject>","role":"viewer"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `campaign.batch.create` | `{"brand_id":"<已有 QA brand_id>"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `campaign.batch.pause` | `{"campaign_id":"<已有 QA campaign_id>","expected_revision":"<刚读回的版本>","idempotency_key":"<本次唯一 QA 键>","reason":"QA 验收，勿发布"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `campaign.batch.resume` | `{"campaign_id":"<已有 QA campaign_id>","expected_revision":"<刚读回的版本>","idempotency_key":"<本次唯一 QA 键>","reason":"QA 验收，勿发布"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `workspace.interactive.confirm` | `{"confirmation":"I_CONFIRM_INTERACTIVE_WRITES"}` | 在用户明确交互后返回短期写入票据和范围；无业务对象自动修改 | 核对工作区状态、授权/导出/删除队列与审计 | 未在此版 App 正向完成 |
| `workspace.data.export.request` | `{"reason":"QA 验收，勿发布","idempotency_key":"<本次唯一 QA 键>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对工作区状态、授权/导出/删除队列与审计 | 未在此版 App 正向完成 |
| `platform.mapping.preflight` | `{"input_json":"<只含 QA 商品的映射 JSON>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `catalog.title.optimize` | `{"product_id":"<已确认 QA 商品 ID>","keyword":"通勤"}` | 返回候选/作业和真实模型状态；核对用量成本、点数与未发布 | 核对订单/账本、model_usage、创意点及审计前后差异 | 未在此版 App 正向完成 |
| `catalog.title.accept` | `{"product_id":"<已有 QA product_id>","platform":"jd","suggestion_id":"<已有 QA suggestion_id>","title":"<明确标记 QA 的名称>"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `catalog.import` | `{"platform":"jd","title":"<明确标记 QA 的名称>","draft_only":"true","local_product_key":"QA-DO-NOT-PUBLISH-<唯一串>"}` | 仅导入 QA 草稿，不绑定店铺或发布；读回货号和待确认事实 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `catalog.import.batch` | `{"products_json":"<单条 QA 商品 JSON 数组>"}` | QA 商品批量入待确认目录，核对原子性、店铺/货号/SKU，无发布 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `catalog.sku.update` | `{"product_id":"<已有 QA product_id>","sku_id":"<已有 QA sku_id>","stock":"<已核对的 QA 库存>","expected_version":"<刚读回的版本>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `catalog.product.update` | `{"product_id":"<已有 QA product_id>","title":"QA 商品标题请勿发布","expected_version":"<刚读回的版本>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `catalog.facts.confirm` | `{"product_id":"<已有 QA product_id>"}` | QA 商品事实变为已确认，版本递增，审计可见 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `catalog.image.generate` | `{"product_id":"<已确认 QA 商品 ID>","count":"1"}` | 返回候选/作业和真实模型状态；核对用量成本、点数与未发布 | 核对订单/账本、model_usage、创意点及审计前后差异 | 未在此版 App 正向完成 |
| `catalog.image.select` | `{"job_id":"<已有 QA job_id>","visual_ref":"<经确认的 visual_ref>","expected_revision":"<刚读回的版本>","idempotency_key":"<本次唯一 QA 键>","reason":"QA 验收，勿发布","confirmation_ticket_nonce_hash":"<经确认的 confirmation_ticket_nonce_hash>","confirmation_ticket_intent_hash":"<经确认的 confirmation_ticket_intent_hash>"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `catalog.image.review` | `{"product_id":"<已有 QA product_id>"}` | 返回归档候选检查结果；核对是否仅检查、未修改商品 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `asset.parse` | `{"asset_id":"<已有 QA asset_id>"}` | 返回候选/作业和真实模型状态；核对用量成本、点数与未发布 | 核对订单/账本、model_usage、创意点及审计前后差异 | 未在此版 App 正向完成 |
| `asset.facts.confirm` | `{"asset_id":"<已有 QA asset_id>","facts_json":"<经核对的合法 JSON>","reason":"QA 验收，勿发布"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变 | 未在此版 App 正向完成 |
| `asset.preference.update` | `{"asset_id":"<已有 QA asset_id>","verdict":"unrated"}` | 返回 QA 素材状态/版本；扫描与权益门禁仍有效 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变 | 未在此版 App 正向完成 |
| `brand.upsert` | `{"name":"<明确标记 QA 的名称>","brand_unit_id":"<现有贵人鸟品牌单元 ID>","source":"qa://merchant-confirmed"}` | 明确关联既有品牌单元，新版本读回；不从名称猜资料 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 |
| `asset.upload` | `{"name":"<明确标记 QA 的名称>","mime_type":"<经确认的 mime_type>","file_path":"<本机小型 QA 文本或图片路径>"}` | 返回隔离素材 ID、扫描状态与权益状态；不得直接可用/发布 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变 | 未在此版 App 正向完成 |
| `asset.upload.batch` | `{"assets_json":"<经核对的合法 JSON>"}` | 返回隔离素材 ID、扫描状态与权益状态；不得直接可用/发布 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变 | 未在此版 App 正向完成 |
| `asset.generation.confirm` | `{"job_id":"<已有 QA job_id>"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变 | 未在此版 App 正向完成 |
| `asset.rights.update` | `{"asset_id":"<已有 QA asset_id>","rights_status":"pending"}` | 保持 pending 并读回；仅真实权益证据经人工确认后才可批准 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变 | 未在此版 App 正向完成 |
| `task.clone` | `{"task_id":"<已有 QA task_id>"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `feedback.submit` | `{"task_id":"<已有 QA task_id>","rating":"liked"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `task.create` | `{"product_id":"<已有 QA product_id>","platform":"jd"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `task.create.draft` | `{"product_id":"<已有 QA product_id>","platform":"jd"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `task.answer` | `{"task_id":"<已有 QA task_id>","answers_json":"<经核对的合法 JSON>"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `task.request.create` | `{"request_text":"为 QA 商品制作待审核候选，勿发布"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `task.sku.split` | `{"task_id":"<已有 QA task_id>"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `task.group.create` | `{"entries_json":"<经核对的合法 JSON>"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `creative.brief` | `{"product_id":"<已有 QA product_id>","asset_type":"banner"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `creative.preview` | `{"product_id":"<已有 QA product_id>","asset_type":"banner"}` | 返回候选/作业和真实模型状态；核对用量成本、点数与未发布 | 核对订单/账本、model_usage、创意点及审计前后差异 | 未在此版 App 正向完成 |
| `creative.directions.update` | `{"task_id":"<已有 QA task_id>","action":"regenerate"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `task.select_direction` | `{"task_id":"<已有 QA task_id>","direction_id":"<已有 QA direction_id>"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `task.plan.confirm` | `{"task_id":"<已有 QA task_id>"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `content.generate` | `{"task_id":"<已有 QA task_id>"}` | 返回候选/作业和真实模型状态；核对用量成本、点数与未发布 | 核对订单/账本、model_usage、创意点及审计前后差异 | 未在此版 App 正向完成 |
| `content.draft.generate` | `{"draft":"true","draft_title":"QA 候选请勿发布","idempotency_key":"<本次唯一 QA 键>","draft_prompt":"仅制作待审核候选，不发布"}` | 返回候选/作业和真实模型状态；核对用量成本、点数与未发布 | 核对订单/账本、model_usage、创意点及审计前后差异 | 未在此版 App 正向完成 |
| `content.review.decide` | `{"content_version_id":"<已有 QA content_version_id>","code":"<审核项代码>","field":"<经确认的 field>","status":"acknowledged"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `content.visual.select` | `{"content_version_id":"<已有 QA content_version_id>","visual_refs_json":"<经核对的合法 JSON>","expected_revision":"<刚读回的版本>","reason":"QA 验收，勿发布"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `content.export` | `{"content_version_id":"<已审核 QA 版本 ID>","format":"manifest"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `content.approve` | `{"task_id":"<已有 QA task_id>","content_version_id":"<已有 QA content_version_id>"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `content.restore` | `{"content_version_id":"<已有 QA content_version_id>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 |
| `knowledge.rule.create` | `{"name":"<明确标记 QA 的名称>","content":"<经确认的 content>","scope":"global","source_kind":"internal","source_reference":"qa://internal-rule","source_checked_at":"<当前 ISO 时间>","version":"<实际版本>","status":"draft"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 |
| `knowledge.asset.create` | `{"kind":"brand","name":"<明确标记 QA 的名称>","content_json":"<经核对的合法 JSON>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 |
| `knowledge.asset.update` | `{"asset_id":"<已有 QA asset_id>","content_json":"<经核对的 QA 内容 JSON>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 |
| `knowledge.brand.preference.update` | `{"preferences_json":"<经核对的合法 JSON>","version":"<实际版本>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 |
| `knowledge.feedback.record` | `{"kind":"feedback","reason":"QA 验收，勿发布"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 |
| `knowledge.learning.confirm` | `{"suggestion_id":"<已有 QA suggestion_id>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 |
| `knowledge.learning.dismiss` | `{"suggestion_id":"<已有 QA suggestion_id>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 |
| `knowledge.competitor.create` | `{"competitor_name":"<明确标记 QA 的名称>","source_json":"<经核对的合法 JSON>","summary":"<经确认的 summary>","structure_json":"<经核对的合法 JSON>","selling_points_json":"<经核对的合法 JSON>","expression_json":"<经核对的合法 JSON>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 |
| `knowledge.competitor.reference` | `{"competitor_id":"<已有 QA competitor_id>","own_brand_name":"<经确认的 own_brand_name>","own_selling_points_json":"<经核对的合法 JSON>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 |

## 预期阻断（7 项）

| 方法 | 最小安全参数 | App 预期结果 | 副作用核对 | 114000 App 实际状态 |
| --- | --- | --- | --- | --- |
| `commercial.service-boundary.accept` | `{"policy_version":"<实际版本>","policy_checksum":"<实际校验值>","acceptance_ref":"<真实条款引用>","accepted_at":"<当前 ISO 时间>","idempotency_key":"<本次唯一 QA 键>"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对订单/账本、model_usage、创意点及审计前后差异；请求前后必须无变化 | 未在此版 App 正向完成 |
| `workspace.invitation.accept` | `{"expected_revision":"<刚读回的版本>"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对工作区状态、授权/导出/删除队列与审计；请求前后必须无变化 | 未在此版 App 正向完成 |
| `commercial.order.create` | `{"purchase_kind":"purchase","sku_code":"<已批准 QA 套餐 SKU>","idempotency_key":"<本次唯一 QA 键>","reason":"QA 验收，勿发布"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对订单/账本、model_usage、创意点及审计前后差异；请求前后必须无变化 | 未在此版 App 正向完成 |
| `workspace.deactivate` | `{"reason":"QA 验收，勿发布"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对工作区状态、授权/导出/删除队列与审计；请求前后必须无变化 | 未在此版 App 正向完成 |
| `workspace.activate` | `{"reason":"QA 验收，勿发布"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对工作区状态、授权/导出/删除队列与审计；请求前后必须无变化 | 未在此版 App 正向完成 |
| `workspace.data.delete.request` | `{"scope":"<隔离租户范围>","reason":"隔离环境双人审批演练","idempotency_key":"<隔离唯一键>"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对工作区状态、授权/导出/删除队列与审计；请求前后必须无变化 | 未在此版 App 正向完成 |
| `multimodal.image.edit` | `{"request_json":"<经核对的合法 JSON>"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对工作区相关快照与操作审计前后差异；请求前后必须无变化 | 未在此版 App 正向完成 |

## 执行记录模板

每项记录：安装版本与新会话、工具名、QA 对象与工作区、App 画面、请求 ID、结构化结果、服务端读回、审计/账本差异、结论（正向通过 / 预期阻断 / 产品门禁 / 缺陷 / 未执行）。清单生成时未发起任何 `tools/call` 或生产写入。
