# Merchant Marketing 183900 正向验收执行矩阵

状态：**计划，未执行**。依据本机已安装 `0.1.0+codex.20260929183900/mcp/bridge.mjs` 的工具定义及可见性门禁复核。此前 143500 版的 116/116 调用仅证明入口覆盖；此表不继承业务通过结论。当前 183900 版握手仍待修复和重新验证，因此先不对任何一行标记成功。

验收身份固定为 `demo@sn.com` 的专用 QA 工作区 `ws_57fd2361ed5b44c7891f3d37`。每项保存 App 调用/返回、请求 ID、同租户对象读回、审计及账本差异；模型项还需中转鉴权、用量、成本与错误证据。余额 `unknown`、工作区不符或真实中转不可用时，保持阻断。

| 顺序 | 最小流程和当前工具契约 | 当前缺项或门禁 | 正向通过证据 |
| --- | --- | --- | --- |
| 0 宿主与只读基线 | 重启 ChatGPT App 后确认 `initialize`、`tools/list`，再调用 `onboarding.status`、`workspace.health`、`canonical.product.consistency`、`commercial.access.get`、`subscription.get`、`creative-points.balance.get`、`creative-points.statement.list`。 | 183900 握手待修；QA 创意点余额此前为 `unknown`。 | 当前安装版同一会话工具输出有正确工作区 ID；权益、余额和成本准入真实可核。 |
| 1 无新素材只读 | `commercial.catalog.get`、`subscription.orders.list`、`billing.recharge.list`、`rule.list`、`rule.sync.status`、`knowledge.rule.list`、`knowledge.asset.list`、`knowledge.brand.preference.get`、`knowledge.learning.list`、`knowledge.competitor.list`、`brand.get`、`asset.list`、`deliverable.list`。 | 可立即安全尝试；空列表、后台入口或门禁只记实际状态。对象型 `*.get` 须先有本租户真实 ID。 | 结构化数据、租户 ID 与服务端读回一致，读前后无意外写入。 |
| 2 商品资料 | `catalog.import` 传 `platform`、`title`、`draft_only=true` 建一条未绑定 QA 草稿；`catalog.search` 读回；商家核实事实后 `catalog.facts.confirm`；需店铺绑定的路径再补专用可选店铺。批量表格走 `asset.upload`→`asset.parse`→人工事实确认→`catalog.import.batch(source_asset_id)`。 | QA 工作区此前无商品/可选店铺；缺已确认商品事实。`catalog.import.batch` 也可用 `products_json`，不能把未解析表格直接当作已确认商品。 | 商品、SKU、来源、版本和事实状态在同一租户读回；无同步或发布。 |
| 3 图片 | 已确认商品用 `catalog.image.generate(product_id,count=1)`；未绑定上传图可用 `title + asset_ids_json`，但须先有工作区素材 ID。长图用 `size=1024x4096` 或 `1024x3072`。生成后 `catalog.image.get(job_id)` 查询真实 `images`/附件；`catalog.image.review` 会写审查快照；`catalog.image.select` 需候选票据、revision、幂等键和明确确认。 | 缺可用创意点、测试素材或已确认商品、中转图片模型和真实成本证据。不要把文字方案或原图视为生成结果。 | App 可见真实候选图；provider 作业、对象存储、用量成本、点数和审计对得上；未批准、未发布。 |
| 4 文档解析和品牌 | 用用户明确提供的小型 QA 文本/JSON/表格附件调用 `asset.upload(name,mime_type,file_path)`，再 `asset.list` 和 `asset.parse(asset_id)`；OCR 不可用时 `asset.facts.confirm` 需人工确认事实与理由。`brand.extract` 只产候选，`brand.upsert` 才保存版本。 | 当前无本会话明确授权的新 QA 附件；文件上传需服务端创意点准入。`asset.parse` 契约是文本或 JSON 素材，不推断任意 PDF/图片 OCR 已可用。 | 扫描、权益、解析来源与版本读回；事实只在人工确认后入库。 |
| 5 文案与任务 | 先 `task.create.draft` 或 `task.create` 建本租户 QA 任务，再 `creative.brief/preview`、`content.draft.generate` 或 `content.generate(task_id)`；随后 `generation.get`、`content.versions`、`content.diff` 读回。 | 缺真实 QA 商品/任务、可用点数和文本模型中转证据；`content.generate` 需真实 `task_id`。 | 待审核候选、版本、模型用量/成本及点数结算一致，不编造商品事实。 |
| 6 审核与导出 | 人工审阅后按实际 finding 调 `content.review.decide`，用 `content.visual.select` 绑定已检查图片；`content.approve(task_id,content_version_id)` 批准；`content.export(content_version_id,format)` 导出 `manifest/json/markdown/bundle`，`deliverable.list` 读回。 | 缺正式内容版本、审核人和图片归档；`content.export` 是生成交付物，仍需验文件真实性与引用。 | 审核决定、不可变版本、交付文件 MIME/大小/哈希和审计相符；不把导出当发布。 |
| 7 视频 | 当前生产商家工具面默认隐藏 `multimodal.video.request` 和 `multimodal.video.get`；`multimodal.generate` 也隐藏。仅本地 loopback 且显式 `MERCHANT_ENABLE_LOCAL_VIDEO_CANDIDATES=true` 才暴露视频请求/查询。 | 183900 默认 116 项不含成片工具；无视频正向业务验收入口。不要用脚本/分镜文字冒充视频文件。 | 若后续正式开放，须独立验证 `request(output=rendering)`→`get(provider_job_id)`、真实视频文件、provider/成本/点数证据和审核门禁。 |

高风险的支付、删除、工作区停用及外部发布不在此最小正向流程内；分别用隔离对象和正式门禁验收。整个矩阵的结果目前均为**未执行**。
