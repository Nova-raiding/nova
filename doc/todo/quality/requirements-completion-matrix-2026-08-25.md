# 商家营销 Codex 插件需求完成矩阵

更新时间：2026-08-29（源码/契约对账；生产结论仍为 NO-GO）

> 说明：下列早期测试数与 CodeGraph 数均为历史快照；当前 release 只采用 `doc/release-checklist-0.1.1.md` 在冻结提交上的实测结果。
> 迁移口径：当前 runner、metadata 和 CI 链尾为 081；下方仍出现的 080 描述属于历史段落，不能作为当前发布门禁或 `EXPECTED_MIGRATION_VERSION` 依据。
> MCP 口径：当前 metadata/注册表为 218 个方法；下方出现的 217/217 仅保留为历史快照，不能作为当前 release 数字。

历史快照（不代表当前 release）：CodeGraph 657 files / 9,644 nodes / 40,490 edges；全量回归 263 个测试文件通过、9 个跳过，1,746 项通过、17 个跳过。

历史快照（不代表当前 release）：CodeGraph 657 files / 9,648 nodes / 40,520 edges；全量回归 263 个测试文件通过、9 个跳过，1,747 项通过、17 个跳过；类型检查与构建曾通过。生产仍为 NO-GO，真实 PostgreSQL、平台、支付、云存储/PITR、模型中转和 Codex App 宿主证据尚未提供。

最新图谱同步：657 files / 9,648 nodes / 40,521 edges，索引无 pending changes；Campaign legacy 输入和 generate fallback 已纳入 canonical resolver，生产环境缺 listing 时 fail-closed。

历史 CodeGraph 快照：658 files / 9,649 nodes / 40,524 edges；新增发布模拟配置文件已纳入图谱，未改变生产 NO-GO 判断。

本轮补充：repair 请求的输出上限降至不超过 800 tokens（首次请求仍遵循配置上限），降低结构修复异常路径的成本与延迟；Worker 启动配置已对生产 publish/reconcile 缺少 API、token 或签名密钥 fail-closed。

历史 CodeGraph 快照：658 files / 9,650 nodes / 40,529 edges；Worker 运行时也对 production 配置增加执行前门禁。

历史 CodeGraph 快照（2026-08-29）：658 files / 9,658 nodes / 40,548 edges；对象存储 evidence gate 的实体 artifact 校验和商家端环境状态条已纳入图谱。

最新图谱同步（2026-08-29）：658 files / 9,701 nodes / 40,703 edges，索引无 pending changes；MemoryBrandUnitRepository 已接入 task/publish 只读一致性投影，Worker readiness 查询类型门禁同步修复。

最终本轮图谱同步：658 files / 9,702 nodes / 40,709 edges，索引无 pending changes；全仓 `npm run build` 通过。

任务克隆链路复核：同商品/同平台/同店铺克隆继承 canonical/listing，跨平台或跨店铺不继承；任务创建与执行 binding 统一按 canonical/listing、campaign/campaignItem 成对校验。TypeScript、商家端构建通过；最新图谱为 658 files / 9,702 nodes / 40,716 edges。

最终回归证据：全量测试 263 个文件通过、9 个跳过，1,757 项通过、17 个跳过；全仓 `npm run build` 通过；CodeGraph 659 files / 9,713 nodes / 40,733 edges，索引无 pending changes。

对象晋级一致性复核：已有 clean 对象与 quarantine 源的 SHA、大小或 MIME 不一致时拒绝晋级并保留源对象；对象存储模块测试 20/20、TypeScript 检查通过。最新 CodeGraph 为 659 files / 9,713 nodes / 40,746 edges。

最终全量回归（对象晋级与 canonical clone 改动后）：264 个测试文件通过、9 个跳过；1,774 项通过、17 个跳过；退出码 0。预期的容器 manifest 负向场景 stderr 不计为失败。

当前 release 对账：MCP 方法/契约 218/218，商家 bridge 工具 147，迁移链到 081；精确回归和 CodeGraph 结果以 [`release-checklist-0.1.1.md`](../release/release-checklist-0.1.1.md) 在冻结提交上的最新命令输出为准。下方旧数字保留为历史快照，不能用于当前 release 判定。当前仍为生产 **NO-GO**：真实平台、支付、云资源/PITR、生产模型、容量、对象存储/视频归档、API/MCP release artifact 和 Codex App 宿主证据缺失。

这份矩阵按“当前代码已经能证明什么”填写。`已完成`代表有代码路径和测试/构建证据；`部分完成`代表入口或数据模型已有，但生产连接、自动化或运营闭环仍需补齐。

当前权威规模（以 2026-08-29 最新实现状态为准）：218 个唯一 MCP 方法/契约、商家 bridge 147 个工具、12 个 Ops 一级域、81 个 PostgreSQL 迁移。070–081 已注册，迁移链尾为 081；测试与 CodeGraph 必须引用发布 checklist 在冻结提交上的本轮运行结果。浏览器矩阵仍须诚实表述为“全量运行 91/92，修复后的缺失场景聚焦复验 1/1”，不能写成修复后单命令 92/92。

2026-08-29 PRD/requirements 增量对账确认以下能力已进入真实 application/multimodal 调用链并有定向测试：FR-03 复用已确认品牌 audience 且允许显式商品/活动受众覆盖；FR-08 三个创意方向的近重复/同义改写 fail-closed；FR-11 `VERSION_CONFLICT` 返回 current/expected、字段差异和可合并/冲突字段且保持 workspace 隔离；自然语言满减、满件折、预售、会员价等意图只自动应用无歧义字段；竞品参考执行来源、授权、跨租户、事实迁移、资产挪用和近似复制双门禁；campaign pause/resume/retry、可验证 delivery bundle、视觉真实性、平台媒体规格变体规划和资产派生预览均已接入真实服务调用链。上述均属于代码/本地测试完成，不替代平台、模型、对象存储或生产执行证据。

同日发布门禁实测：release bundle、production evidence、backup attestation 与 trust/replay 的代码级定向测试 16/16 通过；本地 fault acceptance 通过。正式 trust anchor 因 `/run/release-security/evidence-trust` 未配置而 fail-closed；`doc/todo/infra/capacity-evidence.example.json` 被真实云容量门禁拒绝，原因包括 `cloud_gate=false`、非 preproduction/production、非 HTTPS 和 mock ratio 非零。总体发布结论保持 **NO-GO**。

外部 Skills 对照与采用边界见 [`doc/github-skills-audit-2026-08-26.md`](../process/github-skills-audit-2026-08-26.md)；本轮综合 PM / gstack / CodeGraph 审理见 [`doc/pm-comprehensive-review-2026-08-26.md`](./pm-comprehensive-review-2026-08-26.md)。

| 用户说法 | 当前状态 | 代码/文档证据 | 对外口径 |
|---|---|---|---|
| Codex App 插件，不要求用户充值 Codex | 代码完成，待中转运行时验收 | `apps/plugin/`、插件 bridge、`doc/codex-app-relay-setup.md`、`MODEL_RELAY_BASE_URL` 生产门禁、`codex:relay:validate` 双链路配置门禁；生产 Skill 禁止宿主 `image_gen` 旁路，业务生成请求走服务端 relay；`platform.model.status` 在 bridge 中保持只读可用 | 用户不需要配置业务模型 Key；Codex App 自身仍必须在用户级配置中切换到大麦 Responses provider，真实 Responses 兼容性、供应商额度/账单和断链 fail-closed 仍需部署验收 |
| 用户自己充值，充值后开放全部能力 | 部分完成 | `billing.status`、`billing.recharge.create`、`billing.recharge.get` provider 查单与 paid 入账、`billing.reconciliation.run` 角色保护的待支付订单查单入账；provider `closed/failed` 查单结果会转为订单终态并进入异常列表，不会重复查单；服务端 payment provider checkout/refund/query adapter、HTTPS 支付链接、回调验签/幂等入账、金额/渠道/交易号重放校验、钱包账本、bridge 零余额放行授权/充值订单/只读同步；平台授权和商品只读同步不再被钱包或平台/同步加购强制阻断；钱包余额是生成、图片、视频、OCR、SEO-GEO、REST/MCP 单项发布和批量发布的统一门禁，内容生成不再被过期订阅二次拦截；模型、图片、图片编辑、单项/批量发布失败会按原扣款幂等键写入钱包退款流水；REST、MCP、批量确认/重试均先恢复持久化幂等任务再扣款；多模态和视频 rendering 先预扣再调用 provider，失败按同一扣款键退款；图片生成和视频请求重复重试不重复扣费；插件首次进入固定展示余额/充值入口/解锁状态，明确操作时由 `workspace.interactive.confirm` 开启 15 分钟交互写会话，不要求用户手工配置环境变量；Merchant Studio 提供运营账务入口；bridge/API 回归覆盖充值、零余额同步、交互写入与只读 Automation 边界 | 钱包余额可解锁受控能力；支付宝/微信真实商户 provider、查单/对账、退款接口凭证和生产回调仍需配置与验收 |
| 知识库：平台固定/品类/大促规则 | 已完成 | `packages/knowledge`、`knowledge.rule.*`、规则版本/审计 | 规则可追溯，发布前检查；不承诺平台规则永不变化 |
| 知识库：品牌资产/客户资产 | 已完成 | `knowledge.asset.*`、品牌资产 API、资产权限检查 | 生成前读取已确认的品牌与客户资产 |
| 自动录入店铺 | 部分完成 | `platform.connect`、OAuth/PKCE/state、平台账户列表；插件 manifest/README/Skill 首个默认入口与 Skill 首次交互均先绑定六平台店铺；生产 MCP 与 REST 对无已绑定店铺的商品、素材、同步、任务、生成和发布调用返回 `STORE_ONBOARDING_REQUIRED`，仅放行健康、授权、钱包和运营入口；OAuth 回调同时保留 JSON 契约，并在浏览器 `Accept: text/html` 下返回带 CSP、无缓存且不泄露凭据的成功/失败继续页；安全 E2E 覆盖首步门禁和回调页面 | 安装后的产品引导第一步进入六平台授权选择；本地代码已强制生产首步店铺绑定，各平台正式 OAuth/callback、商家身份注册、真实回调和宿主回跳体验仍需分别验收 |
| 自动录入商品 | 部分完成 | `catalog.import`、`catalog.import.batch`、`/v1/products/import` 与 `/v1/products/import/batch`、`catalog.sync`、平台 connector profile、SKU 事实快照；MCP/REST 批量入口均最多 50 项，逐项绑定 `platform + account_id`，支持商品级 `sourceAssetIds/asset_ids` 绑定已上传素材，图片优化默认复用绑定素材；全量预校验后以单次快照事件写入并在失败时恢复导入前商品快照 | 已支持单项/批量导入、同步、店铺绑定、商品素材绑定与事实确认；生产读取取决于平台连接器证据 |
| 一句话生文/生图/生视频 | 文案/图片本地闭环；视频渲染已验证但商业禁用 | `content.generate`、`catalog.image.generate`、`multimodal.*`、`packages/ai/src/video-generator.ts`；视频 rendering 只接受平台中转站返回的 HTTPS 成片地址或 provider job id，并可用 `multimodal.video.get` 查询异步状态。真实 5 秒 canary 成本为 ¥544.265625，超过当前单请求/日成本上限时服务端 fail-closed，且不得扣钱包或调用 provider | 一句话可生成文案、图片候选、视频脚本/分镜；视频适配器与 provider 已验证，但在模型价格、套餐和累计预算门禁通过前不向商户开放渲染，不能把技术 canary 称为商业可用 |
| 自动读取品牌 | 已完成 | brand profile/extract、任务上下文与内容生成链路 | 使用已确认品牌档案，冲突时要求确认 |
| 直接在图上注释修改 | 本地交互闭环；生产 provider 待验收 | `multimodal.image.edit`、`apps/plugin/ui/image-local-edit.html`、bridge/multimodal 契约；支持拖拽创建/移动归一化区域、方向键及组合键微调、可编辑/不可修改/冲突提示、原图保留和候选输出，宿主不可用时保留请求 JSON | 可在插件交互资源中圈选并请求局部编辑；真实图像质量、计费和 Codex App 宿主仍需生产 provider/宿主验收 |
| 内容交付自动审核 | 已完成 | review/report、事实/规则/图片检查、发布前阻断 | 系统自动标出风险，最终发布仍由人确认 |
| 驳回后持续学习规范 | 已完成 | `knowledge.feedback.record`、`knowledge.learning.*` | 驳回沉淀为待确认学习建议，不自动把单次驳回变成全局规则 |
| 记忆营销动作 | 已完成（只读自动化有边界） | task/content/publish/audit 时间线与快照；`automation.policy.*`、原生 Automation 六平台巡检模板、稳定 risk key、低库存识别、按店铺隔离的经营快照和结构化优化建议 | 可追溯已执行动作；无人值守只读巡检不自动同步、生成、批准、充值或发布，建议包含官方方法入口但修复动作仍需新的交互会话确认 |
| 竞品录入后模仿 | 已完成（差异化参考闭环） | `knowledge.competitor.*`、`competitor_reference_json`、任务输入快照、内容生成知识上下文 | 经运营审核的结构/表达观察可注入生成快照；仅允许差异化参考，禁止复制竞品原文、品牌或未经确认卖点 |
| 运营后台 | 部分完成 | `apps/ops-console` 已注册 12 个独立一级域：overview、users、members、support、incidents、tasks、stores、rules、models、feature-flags、finance、audit；成员管理有独立 `/ops/members`；路由、角色可见性、组件契约、成员生命周期和规则独立审批已覆盖。feature flag API 使用独立 `OPS_DATABASE_URL`/`merchant_ops` 控制面角色，租户角色无控制面 ACL | 12 域本地浏览器深链及写操作已验证；真实 IdP/SSO、生产规模数据、DNS/TLS、镜像发布和云数据库角色探针仍需完成。上线 CRM 限定为支持工单所需客户投影；跨租户 CDP/360° CRM 另立 PRD |
| 六个平台 | 部分完成 | 六平台 capability preflight、证据样例、配置模板、独立 fixture profile、平台类型、API/MCP/店铺入口和运营配置；全量 fixture 回归已覆盖六平台“授权→同步→事实确认→主图→任务→生成→审核→批准→模拟发布回执”；小红书/抖音具备 bearer HTTP transport、通用商品/SKU/写入回执映射，并新增可配置媒体上传路径、媒体 ID/URL 映射和媒体证据；仍要求官方字段映射与 capability evidence；安装 manifest 与 Automation 入口已同步六平台 | 六个平台均可进入授权/商品/任务选择；小红书/抖音具备可配置 OAuth/API/媒体传输骨架，正式官方 scope、字段映射、生产写入和 canary 仍未完成 |
| 一个平台注册多个店铺 | 部分完成 | 账户主键使用 workspace + platform + accountId；`platform.connect` 的真实环境使用 OAuth 回调远端账号，fixture 演练支持 `store_key` 创建同平台双店铺；运营台展示店铺目录，商品快照、`workspace.metrics` 和同步按账号隔离；任务组允许同平台不同 `account_id` 生成独立子任务，发布确认拒绝把已绑定任务改投同平台另一店铺（MCP/REST/批量共用校验） | 多店铺任务/批量范围隔离已验证；正式 OAuth 与店铺选择页需按平台验收 |
| 品牌隔离 | 本地 API/仓储闭环；生产探针待验收 | 商品/任务分页、商品详情、图片审核、任务创建及 MCP 商品/任务入口按成员 `brand_access_grants` 过滤；canonical product 映射用于商品可见性，受限任务不得使用空品牌绕过 | 应用层品牌越权被拒绝；数据库 RLS 当前是 workspace 级而非品牌级，生产必须保留 API 越权与直连角色 ACL 探针 |
| 不同商品/SKU 分开生成 | 已完成（本地代码闭环，生产映射受平台门禁） | Product/SKU、`catalog.sku.update`、task/product 绑定、内容版本和事实快照 | 已支持按商品任务生成、逐 SKU 修改名称/价格/库存/图片/规格并触发事实重新确认；真实平台字段映射仍以 canary 回执为准 |
| 主图/副图设计、素材优化 | 部分完成 | 图片生成、图片审核、素材资产与偏好；商品导入可持久化绑定 `sourceAssetIds`，优化模式无显式素材时默认使用商品绑定素材；配置 `MODEL_RELAY_BASE_URL` + `OCR_MODEL` 后图片素材可通过平台视觉模型提取 OCR 候选；图片候选冻结任务/内容版本/商品/店铺/平台及 `skuIds` 作用域；多 SKU 未锁定任务可通过 `task.sku.split` 形成逐 SKU 独立交付包；连接器支持带映射证据的 `mediaUploadPath`，Worker 按冻结的 `main`/`secondary` 顺序上传 | 已有平台中转 OCR 候选、SKU 强绑定和媒体上传代码路径；未配置时要求人工确认/发布阻断，真实图片 provider、版权证明和六平台媒体 canary 仍需生产验收 |
| 详情规则/规格/价格 | 已完成（本地代码闭环，生产映射受平台门禁） | `catalog.product.update`、`catalog.sku.update`、类目字段、平台 profile validateWrite、发布预检 | 支持商品级详情、标题、类目、图片、属性、卖点与逐 SKU 规格/价格/库存编辑；实际平台写入要以生产 canary 证据为准 |
| 标题 SEO/GEO | 已完成（本地建议模型） | `packages/seo`、`catalog.title.optimize`、`catalog.title.accept`、平台长度限制、关键词/事实证据、SEO/GEO 分数和风险字段；接受后重新进入事实确认 | 输出可解释优化建议与分数；不承诺平台排名、收录或转化 |
| 批量发布 | 已完成（代码闭环，生产平台仍受 canary 门禁） | `publish.batch.prepare/confirm/get/pause/resume/retry_failed`，批次快照逐项保存 `contentVersionId`、`confirmationHash`、`remoteSnapshotHash`、店铺和失败信息；批量确认的父批次、任务和子 `publish_job` 现在在同一 workspace snapshot/outbox 事务内提交，并在子任务上保存 `batchId`，重启可从父批次恢复；批量准备采用全组预检，失败不会留下已准备的前置任务；回归覆盖部分成功、暂停/恢复、失败项新确认重试、状态查询和跨入口幂等扣款 | 支持最多 50 项的可恢复批次；平台已排队项目不会被伪装成已取消，失败重试仍要求新的逐项确认；真实平台执行、跨进程故障注入和生产 canary 仍需外部验收 |
| 上传后自动化运营 | 已完成（到期扫描 + 同步/发布完成即时扫描 + 店铺同步 + 独立 Worker 调度 + 执行窗口 + workspace 租约 + 授权/规则冲突自动暂停 + 人工确认模式） | `automation.policy.*`、`automation.policy.list`、`automation.tick`、`POST /v1/internal/automation/tick`、`worker-automation`、`sync_enabled`、同步完成和发布成功回执后的 MCP/REST/Worker `automation.post_sync_scan` 作用域钩子、按 platform/account 校验的持久化策略快照、`lastRunAt/nextRunAt`、`claimedAt/lastSyncJobId` 认领恢复（重启按店铺和时间窗口核对同步任务，缺失时立即重排）、Redis `SET NX PX` workspace 租约/续期/安全释放、执行窗口 `windowStart/windowEnd` 与窗口外延迟审计、`retryLimit` 对 `sync.retry_failed` 的持久化 `retryCount` 上限、扫描风险写入 `ops.alerts.*`；撤权/需续期风险或适用规则过期、未生效、优先级冲突会自动关闭对应策略、跳过同步并写入 `automation.policy.auto_paused` 审计；同步任务在权益/持久化/provider 失败时补偿为 `failed` 并退还已消费权益；运营台店铺作用域选择器、暂停权限与审计、运营台控制与营销队列 | 独立 Worker 按工作区周期触发到期扫描并可创建 `catalog.sync.start` 任务；同步最终成功或 partial、或发布收到可验证 published 回执后，只对精确店铺执行即时风险扫描，不自动发布或重试；并发 tick 只允许一个执行；授权或规则冲突会 fail-safe 暂停；运营台可一次查看所有已配置店铺策略及暂停原因；真实官方连接器与云端 Worker 生产 canary、跨进程故障注入仍待外部环境；明确禁止无人值守自动重发 |

## 当前未开发或未验证清单

本轮补齐上传素材风险项的运营动作入口：运营台可在角色允许时提交 `asset.scan`、`asset.rights.update` 或 `asset.facts.confirm`，并要求扫描证据、权益范围或人工确认原因；真实扫描服务和生产对象存储仍按下列外部门禁执行。

- 运营台细粒度授权体验：已具备 12 个独立域、`ops.session` 角色投影、高风险命令后端门禁，以及商业/平台/规则编辑控件的前端只读禁用态；API 已提供包含原始 query、请求体摘要和一次性 nonce 的 `OPS_AUTH_MODE=oidc` 签名网关断言合同，本地全域浏览器验收已完成，真实 IdP/SSO 网关接入仍需外部部署完成。
- 小红书/抖音正式 OAuth、字段映射、生产读写和 canary：当前已有 fixture 授权→同步→撤权→重授权回归及 API/运营配置证据；canary runner 已支持显式加入这两个平台，但不会降低 scope、映射或真实非模拟回执门禁。
- 真实模型、图片/视频 provider、对象存储和支付服务商生产证据：本地 fixture/请求模型不等价于生产质量或到账证据。
- 订阅支付闭环补充：`subscription.order.create` 与升级补差价现在必须声明支付宝/微信渠道，服务端生成并持久化 provider/fixture 收银台 URL，支付回调按订单渠道和金额快照校验后才激活订阅；真实 provider、签名和生产回调仍需外部验收。
- Codex App 宿主内新增运营台按钮的可视化回归：本轮已完成 gstack Chromium 页面回归和 bridge 运行时回归，但当前会话没有可调用的 Codex App 宿主浏览器连接，因此仍标记为未验证。
- PostgreSQL 迁移闭环：迁移链已到 080；060/062 以 `migrate:no-transaction` 执行 `CREATE/DROP INDEX CONCURRENTLY`，063-067 依次补齐 listing 组合完整性、身份 bootstrap、素材解析租约、平台媒体规格注册表和字段映射预检审批，068 为 campaign 生命周期表授予租户运行角色最小读写权限，069 为 legacy 商品/任务/发布记录增加平台与店铺账号作用域触发器，070/071/072 补齐商品—素材关系及完整性校验，073 增加平台运营读取所需的受控工作区商业摘要视图，074 增加模型 usage 的独立 context link/hash 一致性约束，075 增加按工作区/动作的模型 usage 查询索引，076 增加 workspace-scoped canonical backfill lookup index，077 增加任务与发布任务的 canonical/platform/store scope 触发器，078 在同工作区素材 snapshot 后到达时补齐可证明的商品素材绑定，079 增加 workspace-scoped knowledge hydration snapshot/cursor，080 增加 workspace storage quota/reservation ledger；两者均保留 workspace RLS。租户 `merchant_app` 与控制面 `merchant_ops` ACL 已拆分并有本地角色探针；生产 preflight 必须将 `EXPECTED_MIGRATION_VERSION=080` 与镜像/工作树链尾绑定。CI 已列入 080 的真实 PostgreSQL 测试入口，但本地未配置真实数据库，不能把 skipped 计为通过；真实部署仍需复核非超级用户 RLS/CAS、云角色、连接池、大表锁等待、触发器开销、WAL/副本延迟和 PITR。
- 发布证据链：payment/restore/capability 均已强制校验 release、image-set、manifest、Git、nonce 与 Ed25519 签名；trust 与 nonce consumer 使用固定受保护路径；部署验证 `/releasez`、认证数据库业务路径和签名六平台 canary；rollback 强制签名 known-good bundle、不可变 artifact 与资源 kind 限制；生产恢复强制签名 backup attestation；release manifest gate 绑定 API/OpenAPI、MCP、bridge 和 Skill 摘要；对象存储 gate 强制视频归档证据。代码门禁已闭环，但正式环境尚未提供真实受保护控制面、签名 artifacts、视频对象归档和部署/回滚/恢复演练证据，因此仍明确为 NO-GO。

## 当前必须保留的边界

1. 六个平台的生产能力合同统一执行；小红书/抖音只有在官方 OAuth、读写、状态查询、限流和拒绝码证据齐全后，才能升级为生产能力。
2. 钱包充值在本地/测试环境可生成 fixture 订单；生产环境必须配置支付服务商回调和签名校验，`pending` 不能当作到账。
3. 批量发布必须逐商品保留审计、幂等键和回执；“批量准备”不等于“自动发布成功”。
