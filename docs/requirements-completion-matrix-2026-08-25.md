# 商家营销 Codex 插件需求完成矩阵

更新时间：2026-08-26（最终部署 preflight 已强制六平台 auth/read/write 开关与 production canary 证据一致）

这份矩阵按“当前代码已经能证明什么”填写。`已完成`代表有代码路径和测试/构建证据；`部分完成`代表入口或数据模型已有，但生产连接、自动化或运营闭环仍需补齐。

外部 Skills 对照与采用边界见 [`docs/github-skills-audit-2026-08-26.md`](./github-skills-audit-2026-08-26.md)；本轮综合 PM / gstack / CodeGraph 审理见 [`docs/pm-comprehensive-review-2026-08-26.md`](./pm-comprehensive-review-2026-08-26.md)。

| 用户说法 | 当前状态 | 代码/文档证据 | 对外口径 |
|---|---|---|---|
| Codex App 插件，不要求用户充值 Codex | 代码完成，待中转运行时验收 | `apps/plugin/`、插件 bridge、`docs/codex-app-relay-setup.md`、`MODEL_RELAY_BASE_URL` 生产门禁、`codex:relay:validate` 双链路配置门禁；生产 Skill 禁止宿主 `image_gen` 旁路，业务生成请求走服务端 relay；`platform.model.status` 在 bridge 中保持只读可用 | 用户不需要配置业务模型 Key；Codex App 自身仍必须在用户级配置中切换到大麦 Responses provider，真实 Responses 兼容性、供应商额度/账单和断链 fail-closed 仍需部署验收 |
| 用户自己充值，充值后开放全部能力 | 部分完成 | `billing.status`、`billing.recharge.create`、`billing.recharge.get` provider 查单与 paid 入账、`billing.reconciliation.run` 角色保护的待支付订单查单入账；provider `closed/failed` 查单结果会转为订单终态并进入异常列表，不会重复查单；服务端 payment provider checkout/refund/query adapter、HTTPS 支付链接、回调验签/幂等入账、金额/渠道/交易号重放校验、钱包账本、bridge 零余额放行授权/充值订单/只读同步；平台授权和商品只读同步不再被钱包或平台/同步加购强制阻断；钱包余额是生成、图片、视频、OCR、SEO-GEO、REST/MCP 单项发布和批量发布的统一门禁，内容生成不再被过期订阅二次拦截；模型、图片、图片编辑、单项/批量发布失败会按原扣款幂等键写入钱包退款流水；REST、MCP、批量确认/重试均先恢复持久化幂等任务再扣款；多模态和视频 rendering 先预扣再调用 provider，失败按同一扣款键退款；图片生成和视频请求重复重试不重复扣费；插件首次进入固定展示余额/充值入口/解锁状态，明确操作时由 `workspace.interactive.confirm` 开启 15 分钟交互写会话，不要求用户手工配置环境变量；Merchant Studio 提供运营账务入口；bridge/API 回归覆盖充值、零余额同步、交互写入与只读 Automation 边界 | 钱包余额可解锁受控能力；支付宝/微信真实商户 provider、查单/对账、退款接口凭证和生产回调仍需配置与验收 |
| 知识库：平台固定/品类/大促规则 | 已完成 | `packages/knowledge`、`knowledge.rule.*`、规则版本/审计 | 规则可追溯，发布前检查；不承诺平台规则永不变化 |
| 知识库：品牌资产/客户资产 | 已完成 | `knowledge.asset.*`、品牌资产 API、资产权限检查 | 生成前读取已确认的品牌与客户资产 |
| 自动录入店铺 | 部分完成 | `platform.connect`、OAuth/PKCE/state、平台账户列表；插件 manifest/README/Skill 首个默认入口与 Skill 首次交互均先绑定六平台店铺；生产 MCP 与 REST 对无已绑定店铺的商品、素材、同步、任务、生成和发布调用返回 `STORE_ONBOARDING_REQUIRED`，仅放行健康、授权、钱包和运营入口；OAuth 回调同时保留 JSON 契约，并在浏览器 `Accept: text/html` 下返回带 CSP、无缓存且不泄露凭据的成功/失败继续页；安全 E2E 覆盖首步门禁和回调页面 | 安装后的产品引导第一步进入六平台授权选择；本地代码已强制生产首步店铺绑定，各平台正式 OAuth/callback、商家身份注册、真实回调和宿主回跳体验仍需分别验收 |
| 自动录入商品 | 部分完成 | `catalog.import`、`catalog.import.batch`、`/v1/products/import` 与 `/v1/products/import/batch`、`catalog.sync`、平台 connector profile、SKU 事实快照；MCP/REST 批量入口均最多 50 项，逐项绑定 `platform + account_id`，支持商品级 `sourceAssetIds/asset_ids` 绑定已上传素材，图片优化默认复用绑定素材；全量预校验后以单次快照事件写入并在失败时恢复导入前商品快照 | 已支持单项/批量导入、同步、店铺绑定、商品素材绑定与事实确认；生产读取取决于平台连接器证据 |
| 一句话生文/生图/生视频 | 已完成（受钱包/审核/中转 provider 约束） | `content.generate`、`catalog.image.generate`、`multimodal.*`、`packages/ai/src/video-generator.ts`；视频 rendering 只接受平台中转站返回的 HTTPS 成片地址或 provider job id，并可用 `multimodal.video.get` 查询异步状态 | 一句话可生成文案、图片候选、视频脚本/分镜，配置视频 provider 后可渲染成片；未配置、失败或仅排队时不得称为已完成 |
| 自动读取品牌 | 已完成 | brand profile/extract、任务上下文与内容生成链路 | 使用已确认品牌档案，冲突时要求确认 |
| 直接在图上注释修改 | 已完成（请求模型） | `multimodal.image.edit`、图片编辑候选与权限检查 | 支持自然语言修改请求；具体图形编辑服务需接入生产 provider |
| 内容交付自动审核 | 已完成 | review/report、事实/规则/图片检查、发布前阻断 | 系统自动标出风险，最终发布仍由人确认 |
| 驳回后持续学习规范 | 已完成 | `knowledge.feedback.record`、`knowledge.learning.*` | 驳回沉淀为待确认学习建议，不自动把单次驳回变成全局规则 |
| 记忆营销动作 | 已完成（只读自动化有边界） | task/content/publish/audit 时间线与快照；`automation.policy.*`、原生 Automation 六平台巡检模板、稳定 risk key、低库存识别、按店铺隔离的经营快照和结构化优化建议 | 可追溯已执行动作；无人值守只读巡检不自动同步、生成、批准、充值或发布，建议包含官方方法入口但修复动作仍需新的交互会话确认 |
| 竞品录入后模仿 | 已完成（差异化参考闭环） | `knowledge.competitor.*`、`competitor_reference_json`、任务输入快照、内容生成知识上下文 | 经运营审核的结构/表达观察可注入生成快照；仅允许差异化参考，禁止复制竞品原文、品牌或未经确认卖点 |
| 运营后台 | 部分完成 | `apps/ops-console`、独立 `merchant-ops-ui` Docker/Kubernetes Deployment、`ops.merchant.example.com` 路由、运营角色、`ops.session` 身份/角色投影、审计、账单、平台能力证据、营销队列及负责人分配；视觉候选脱敏投影与 `ops.marketing.visual.review` 已加入；实际上传素材的扫描/解析/权益/事实 readiness 以 `uploadedAssetRisks` 脱敏投影进入同一队列并带商家下一步；`ops.marketing.queue` 支持平台、店铺、商品、任务和状态筛选，`ops.alerts.list` 支持平台、店铺、告警编码和对象筛选，运营台提供队列与告警筛选控件；侧栏提供商业平台、任务用量、用户店铺、账务退款四个 `/ops/{domain}` 可恢复 URL 入口，并兼容旧 hash；自动化扫描/作用域、退款、成员管理、商业/平台/规则编辑控件均按角色进入 UI 禁用，并由服务端再次校验；生产 OIDC 模式已具备短时 HMAC 网关身份断言边界；成员暂停状态已接入生产 MCP principal 校验，下一请求返回 `MEMBER_SUSPENDED`；已登记成员的数据库角色成为生产权限上限，邀请状态返回 `MEMBER_NOT_ACTIVE` | 支持队列安全重试、异常确认、创建待审核修正版、视觉候选审查、负责人分配、上传素材风险定位、队列与告警筛选、告警定位和服务端角色门禁；真实 IdP/SSO 网关、DNS/TLS、镜像发布和真实图片 provider/宿主视觉回归仍需完成 |
| 六个平台 | 部分完成 | 六平台 capability preflight、证据样例、配置模板、独立 fixture profile、平台类型、API/MCP/店铺入口和运营配置；全量 fixture 回归已覆盖六平台“授权→同步→事实确认→主图→任务→生成→审核→批准→模拟发布回执”；小红书/抖音具备 bearer HTTP transport、通用商品/SKU/写入回执映射，并新增可配置媒体上传路径、媒体 ID/URL 映射和媒体证据；仍要求官方字段映射与 capability evidence；安装 manifest 与 Automation 入口已同步六平台 | 六个平台均可进入授权/商品/任务选择；小红书/抖音具备可配置 OAuth/API/媒体传输骨架，正式官方 scope、字段映射、生产写入和 canary 仍未完成 |
| 一个平台注册多个店铺 | 部分完成 | 账户主键使用 workspace + platform + accountId；`platform.connect` 的真实环境使用 OAuth 回调远端账号，fixture 演练支持 `store_key` 创建同平台双店铺；运营台展示店铺目录，商品快照、`workspace.metrics` 和同步按账号隔离；任务组允许同平台不同 `account_id` 生成独立子任务，发布确认拒绝把已绑定任务改投同平台另一店铺（MCP/REST/批量共用校验） | 多店铺任务/批量范围隔离已验证；正式 OAuth 与店铺选择页需按平台验收 |
| 不同商品/SKU 分开生成 | 已完成（本地代码闭环，生产映射受平台门禁） | Product/SKU、`catalog.sku.update`、task/product 绑定、内容版本和事实快照 | 已支持按商品任务生成、逐 SKU 修改名称/价格/库存/图片/规格并触发事实重新确认；真实平台字段映射仍以 canary 回执为准 |
| 主图/副图设计、素材优化 | 部分完成 | 图片生成、图片审核、素材资产与偏好；商品导入可持久化绑定 `sourceAssetIds`，优化模式无显式素材时默认使用商品绑定素材；配置 `MODEL_RELAY_BASE_URL` + `OCR_MODEL` 后图片素材可通过平台视觉模型提取 OCR 候选；图片候选冻结任务/内容版本/商品/店铺/平台及 `skuIds` 作用域；多 SKU 未锁定任务可通过 `task.sku.split` 形成逐 SKU 独立交付包；连接器支持带映射证据的 `mediaUploadPath`，Worker 按冻结的 `main`/`secondary` 顺序上传 | 已有平台中转 OCR 候选、SKU 强绑定和媒体上传代码路径；未配置时要求人工确认/发布阻断，真实图片 provider、版权证明和六平台媒体 canary 仍需生产验收 |
| 详情规则/规格/价格 | 已完成（本地代码闭环，生产映射受平台门禁） | `catalog.product.update`、`catalog.sku.update`、类目字段、平台 profile validateWrite、发布预检 | 支持商品级详情、标题、类目、图片、属性、卖点与逐 SKU 规格/价格/库存编辑；实际平台写入要以生产 canary 证据为准 |
| 标题 SEO/GEO | 已完成（本地建议模型） | `packages/seo`、`catalog.title.optimize`、`catalog.title.accept`、平台长度限制、关键词/事实证据、SEO/GEO 分数和风险字段；接受后重新进入事实确认 | 输出可解释优化建议与分数；不承诺平台排名、收录或转化 |
| 批量发布 | 已完成（代码闭环，生产平台仍受 canary 门禁） | `publish.batch.prepare/confirm/get/pause/resume/retry_failed`，批次快照逐项保存 `contentVersionId`、`confirmationHash`、`remoteSnapshotHash`、店铺和失败信息；批量确认的父批次、任务和子 `publish_job` 现在在同一 workspace snapshot/outbox 事务内提交，并在子任务上保存 `batchId`，重启可从父批次恢复；批量准备采用全组预检，失败不会留下已准备的前置任务；回归覆盖部分成功、暂停/恢复、失败项新确认重试、状态查询和跨入口幂等扣款 | 支持最多 50 项的可恢复批次；平台已排队项目不会被伪装成已取消，失败重试仍要求新的逐项确认；真实平台执行、跨进程故障注入和生产 canary 仍需外部验收 |
| 上传后自动化运营 | 已完成（到期扫描 + 同步/发布完成即时扫描 + 店铺同步 + 独立 Worker 调度 + 执行窗口 + workspace 租约 + 授权/规则冲突自动暂停 + 人工确认模式） | `automation.policy.*`、`automation.policy.list`、`automation.tick`、`POST /v1/internal/automation/tick`、`worker-automation`、`sync_enabled`、同步完成和发布成功回执后的 MCP/REST/Worker `automation.post_sync_scan` 作用域钩子、按 platform/account 校验的持久化策略快照、`lastRunAt/nextRunAt`、`claimedAt/lastSyncJobId` 认领恢复（重启按店铺和时间窗口核对同步任务，缺失时立即重排）、Redis `SET NX PX` workspace 租约/续期/安全释放、执行窗口 `windowStart/windowEnd` 与窗口外延迟审计、`retryLimit` 对 `sync.retry_failed` 的持久化 `retryCount` 上限、扫描风险写入 `ops.alerts.*`；撤权/需续期风险或适用规则过期、未生效、优先级冲突会自动关闭对应策略、跳过同步并写入 `automation.policy.auto_paused` 审计；同步任务在权益/持久化/provider 失败时补偿为 `failed` 并退还已消费权益；运营台店铺作用域选择器、暂停权限与审计、运营台控制与营销队列 | 独立 Worker 按工作区周期触发到期扫描并可创建 `catalog.sync.start` 任务；同步最终成功或 partial、或发布收到可验证 published 回执后，只对精确店铺执行即时风险扫描，不自动发布或重试；并发 tick 只允许一个执行；授权或规则冲突会 fail-safe 暂停；运营台可一次查看所有已配置店铺策略及暂停原因；真实官方连接器与云端 Worker 生产 canary、跨进程故障注入仍待外部环境；明确禁止无人值守自动重发 |

## 当前未开发或未验证清单

本轮补齐上传素材风险项的运营动作入口：运营台可在角色允许时提交 `asset.scan`、`asset.rights.update` 或 `asset.facts.confirm`，并要求扫描证据、权益范围或人工确认原因；真实扫描服务和生产对象存储仍按下列外部门禁执行。

- 运营台细粒度授权体验：已具备单页内四个域入口、`ops.session` 角色投影、高风险命令后端门禁，以及商业/平台/规则编辑控件的前端只读禁用态；API 已提供显式 `OPS_AUTH_MODE=oidc` 的签名网关断言合同，真实 URL 路由、IdP/SSO 网关接入仍需外部部署完成。
- 小红书/抖音正式 OAuth、字段映射、生产读写和 canary：当前已有 fixture 授权→同步→撤权→重授权回归及 API/运营配置证据；canary runner 已支持显式加入这两个平台，但不会降低 scope、映射或真实非模拟回执门禁。
- 真实模型、图片/视频 provider、对象存储和支付服务商生产证据：本地 fixture/请求模型不等价于生产质量或到账证据。
- 订阅支付闭环补充：`subscription.order.create` 与升级补差价现在必须声明支付宝/微信渠道，服务端生成并持久化 provider/fixture 收银台 URL，支付回调按订单渠道和金额快照校验后才激活订阅；真实 provider、签名和生产回调仍需外部验收。
- Codex App 宿主内新增运营台按钮的可视化回归：本轮已完成 gstack Chromium 页面回归和 bridge 运行时回归，但当前会话没有可调用的 Codex App 宿主浏览器连接，因此仍标记为未验证。
- PostgreSQL 迁移闭环：此前发现后续商业/运营表错误使用 UUID workspace 外键；源码已统一为 text 并加入 033 兼容迁移。真实本机 PostgreSQL 临时库已执行 001→038 全量迁移，验证 `schema_migrations=1:38:38` 及核心表存在；033 同时修复了先删 RLS policy 再转换列类型的顺序问题。独立 API 已在 PostgreSQL 模式下完成启动→工作区 bootstrap→进程重启→同工作区健康恢复 smoke；Worker 使用 `WORKER_WORKSPACES=auto` 连续两次启动并完成 poll smoke；临时非 owner 角色只能看到绑定的 `ws_rls_a` 且无 scope 写入被 RLS 拒绝。仍需真实部署环境复核角色、连接池和迁移权限配置。

## 当前必须保留的边界

1. 六个平台的生产能力合同统一执行；小红书/抖音只有在官方 OAuth、读写、状态查询、限流和拒绝码证据齐全后，才能升级为生产能力。
2. 钱包充值在本地/测试环境可生成 fixture 订单；生产环境必须配置支付服务商回调和签名校验，`pending` 不能当作到账。
3. 批量发布必须逐商品保留审计、幂等键和回执；“批量准备”不等于“自动发布成功”。
