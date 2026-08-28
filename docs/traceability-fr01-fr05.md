# FR-01～FR-05 需求追踪与实现审计

审计日期：2026-08-24  
审计范围：`docs/PRD-merchant-marketing-codex-final.md` 的 FR-01～FR-05  版本基线：PRD v1.4 Final  结果性质：代码与测试追踪，不是生产上线批准

## 1. 审计口径

本次只审计现有代码、MCP 工具、HTTP API、Merchant Studio UI 和仓库测试。判断分为：

- **已完成**：需求主路径已实现，且有对应代码与测试证据；不代表真实平台生产验收已经完成。
- **部分完成**：已有可运行主路径，但仍缺少 PRD 明确的字段、状态、交互、持久化或验收条件。
- **未完成**：当前没有可证明的实现路径。
- **外部依赖**：代码已有接口或 fail-closed 门禁，但真实能力必须由平台、云资源、扫描器或人工证据完成。

特别说明：`fixture`、fake connector、内存仓储、local object storage、演示 UI 和本地 E2E 只能证明软件链路，不等于真实京东/淘宝/天猫/拼多多授权、真实商品同步、真实平台规则或生产写入通过。

> 2026-08-25 增量复核：FR-03 已新增只读 `brand.extract`/品牌提取 REST API，将已读取素材转换为带来源、置信度、冲突候选和强制确认标记的品牌字段。Merchant Studio 已支持逐字段复选、冲突值单选及只保存明确确认字段；未确认字段不写入，跨工作区素材拒绝。真实工作区 UI 和已安装 Codex bridge 均已验证。下方旧审计结论与本增量冲突时，以本段为准。最新回归为 66 个测试文件、355 项测试。

本次验证命令：

```text
npm run typecheck       # 通过
npm test                # 59 test files passed, 285 tests passed
```

## 2. 总体结论

| 需求 | 总体状态 | 客观结论 |
|---|---|---|
| FR-01 插件安装、工作区与健康检查 | 部分完成 | 可安装包、MCP bridge、工作区健康/停用和错误边界已有；真实 Codex marketplace/生产身份绑定及四平台真实 OAuth 仍未完成验收。 |
| FR-02 规则中心 | 部分完成（代码/本地验收） | 规则版本、来源、状态、审计、管理员权限、四个平台独立 platform seed 和商家只读入口已有；完整官方规则来源、店铺/活动规则治理、有效期生产证据仍需外部验收。 |
| FR-03 品牌资产建档 | 本地大部分完成 | 品牌核心档案、候选提取/逐字段确认、Logo/品牌色/字体强类型规则、素材与字体授权阻断、历史素材优秀/不喜欢评价及原因已有；图片/扫描件识别仍不足。 |
| FR-04 店铺、商品与 SKU 建档 | 部分完成 | 统一商品/SKU 模型、导入、同步 Job、分页恢复、事实确认、平台账号绑定和任务前阻断已有；官方平台真实读取/增量同步、字段映射和真实店铺身份仍是外部依赖。 |
| FR-05 文件上传、解析与资产安全 | 部分完成 | 格式/大小/签名/可执行文件拒绝、隔离区、扫描晋级、权益和部分文档解析已有；图片 OCR、扫描 PDF、AI/EPS 解析、真实云对象存储/扫描服务和重复文件引用去重尚未完整验收。 |

## 3. FR-01 插件安装、工作区与健康检查

### 需求与证据

| PRD 要求 | 代码/API/MCP/UI 证据 | 状态 | 缺口与建议 |
|---|---|---|---|
| 提供可安装 Codex Plugin 包和版本说明 | `apps/plugin/.codex-plugin/plugin.json:1-33` 提供 `id`、`version=0.1.0`、Skill、MCP server 和界面元数据；`apps/plugin/README.md:3-23` 提供安装说明；`apps/plugin/install-smoke.test.ts:8-25` 验证 manifest、Skill、MCP companion 和版本一致性。 | 已完成（本地包） | 仍需在团队/商家目标 Codex marketplace 做正式分发、兼容版本和升级回滚验收。 |
| 首次运行创建/绑定商家工作区 | MCP `workspace.bootstrap` 支持无 workspace header 创建工作区并返回 `ws_<24 hex>` 绑定值；`apps/api/src/server.e2e.test.ts` 覆盖 bootstrap 后 health；健康检查仍以 workspace header/插件环境变量作为租户边界。 | 部分完成 | 本地 API/MCP 首次绑定已覆盖；真实 Codex App 的身份选择、宿主环境变量写入和商家注册流程仍需验收。 |
| 显示插件版本、MCP、存储、四平台连接状态和规则版本 | `workspace.health` 返回 plugin、mcp、persistence、rules、connector readiness、platforms（`apps/api/src/server.ts:1333-1342`）；插件 Skill 要求每次会话先调用 health（`apps/plugin/skills/merchant-marketing/SKILL.md:14`）。 | 已完成（API/MCP） | 目标 Codex App 的结构化显示由宿主决定；Merchant Studio 的运行态页面主要展示平台账号、能力证据和同步状态（`demo/merchant-studio/src/App.tsx:146-259`），不是 FR-01 的独立商家 onboarding 页面。 |
| MCP 不可用时给出可操作原因，不创建半成品任务 | bridge 有本地 API readiness 重试测试（`apps/plugin/mcp/bridge.test.ts:168-196`）；API 未配置时返回 `NOT_CONFIGURED`/健康诊断，插件 Skill 要求先 health。 | 部分完成 | 有 bridge/API 级证据，但缺少 Codex App 中“重试、诊断、重新配置”的真实交互验收；应补一个宿主级失败截图/E2E 和半成品任务不产生断言。 |
| 支持停用插件且不删除商家数据 | `workspace.deactivate/activate` 在 `apps/api/src/server.ts:1419-1434`；测试 `apps/api/src/server.e2e.test.ts:329` 附近验证停用/恢复。 | 已完成（本地/持久化路径） | 仍需真实安装缓存升级/停用动作的 Codex marketplace 行为验收；“插件停用”与“工作区停用”在产品 UI 中需明确区分。 |
| 新用户安装后 60 秒创建工作区并通过健康检查 | `workspace.bootstrap` + `workspace.health` 已有本地 E2E，插件安装 smoke 验证包完整。 | 部分完成 | 没有真实 Codex App 端到端计时、宿主绑定写入和生产身份注册证据。 |
| 任一首发平台完成官方 OAuth，显示店铺身份和读写权限，不保存密码 | `platform.connect` schema/说明在 `apps/plugin/mcp/bridge.mjs:50-52`；OAuth state/PKCE/callback 代码在 `apps/api/src/server.ts:2439-2512`；安全测试覆盖 state、PKCE、回调和账号绑定（`apps/api/src/security.e2e.test.ts:25-137`）。 | 部分 / 外部依赖 | 本地 fixture 可模拟账号；真实平台 OAuth app、scope、回调、店铺身份回读、凭证 Vault 和权限证据未完成。生产配置当前明确 `auth_enabled/read_enabled/write_enabled: false`（`docs/production-config.example.yaml:87-155`）。 |

### FR-01 结论

插件包和健康检查的软件边界可以进入开发/试点联调；不能据此宣称“商家安装即完成真实店铺连接”。上线前阻断项是：Codex marketplace 目标版本、生产身份网关、Vault、四平台 OAuth 和至少每个平台一组真实测试店铺证据。

## 4. FR-02 规则中心

### 需求与证据

| PRD 要求 | 代码/API/MCP/UI 证据 | 状态 | 缺口与建议 |
|---|---|---|---|
| 支持法律/安全、平台、品类、品牌、店铺、活动规则 | `RulePackScope` 定义了 `global/platform/category/brand/store/campaign`（`packages/review/src/rule-center.ts:3-5`）；MCP `rule.list/history/audit/publish/status` 在 `apps/plugin/mcp/bridge.mjs:94-112`；规则/品类只读页面在 `demo/merchant-studio/src/App.tsx:551`。默认 seeds 已覆盖 global、category、京东、淘宝、天猫、拼多多 platform pack。 | 部分完成 | scope 枚举和平台 seeds 已有代码/本地命中证据；店铺/活动实际规则样例、官方来源核验、生产治理和生效证据仍需补齐。 |
| 六平台分别维护独立规则集、版位规格、类目约束 | `catalog.categories` 返回平台范围/必填字段；`defaultRuleCenterSeeds` 已包含京东、淘宝、天猫、拼多多、小红书、抖音独立 platform pack；小红书/抖音 seed 明确标记 `source.kind=internal`，不冒充官方来源。 | 部分 / 外部依赖 | 本地可审计 rule pack、字段映射和规则命中已有；六个平台真实规则来源、版本、版位规格和官方核验尚未提供，仍需每个平台独立 canary/黄金任务。 |
| 固定优先级：法律 > 平台 > 品类 > 品牌/店铺 > 活动 > 偏好；用户不能覆盖硬规则 | `RuleCenter.evaluate()` 按 global→platform→category→brand→store→campaign 排序，并对高优先级 block 与低优先级 allow 产生 `RULE_PRIORITY_CONFLICT` P0 finding；审核在 `packages/application/src/service.ts` 消费规则 finding。 | 部分完成 | 本地冲突裁决和黄金测试已完成；真实四平台规则源、规则命中回读和运营发布证据仍未完成。 |
| 规则字段含 ID、来源、版本、范围、生效/失效日期、核验时间、严重度、动作 | `RulePackVersion`、PostgreSQL migration 029、MCP/REST/OpenAPI 均包含 effectivity、severity、action、target/scope 字段；来源仍保留 checkedAt。 | 已完成（代码/本地测试） | 真实规则源和运营发布证据仍属于外部上线门禁。 |
| 规则状态为 draft/published/expired/disabled，只有 published 进入快照 | 内部状态仍为 `draft/active/inactive/expired`，任务快照只冻结 context-aware evaluator 返回的有效规则；REST/MCP 对外增加 `lifecycleStatus` 映射为 `published/disabled`；Ant Design 运营台规则中心已展示生命周期、来源和版本，并支持创建草稿、停用和过期操作。 | 部分完成（代码/本地验收） | 真实规则源、规则管理员审批、规则治理值班和生产发布证据仍未完成。 |
| 规则过期按配置阻断或警告，不静默继续 | `RuleCenter.evaluate()` 检查 effectiveFrom/effectiveTo、expired 状态并返回阻断 finding；任务快照记录 `rulesCheckedAt`。 | 已完成（代码/本地测试） | 真实规则源、告警和值班演练仍未完成。 |
| 冲突有唯一可解释结果、命中到规则 ID/版本 | `content.review` 返回 `rule_hits`，包含规则 ID、版本、scope、action、severity 和命中的检查类别；优先级冲突为 P0。 | 已完成（代码/本地测试） | 真实平台规则命中回读仍未完成。 |
| 复制内容到另一平台重新加载规则和快照 | `task.clone` 支持显式 `target_product_id + target_platform + target_account_id`；目标商品必须属于目标平台，创建的是新任务，不复制旧内容/促销；跨平台事件记录 `rule_reload_required=true`；`packages/application/src/service.test.ts` 覆盖跨平台复制。 | 已完成（代码/本地测试） | 真实目标店铺商品回读和平台规则来源仍需外部 canary；目标平台生成前仍必须重新执行规则/事实确认流程。 |

### FR-02 结论

规则“存储、版本、管理员审计、只读查询”的骨架已完成；规则“执行语义”尚未达到 PRD 定稿要求。尤其不能把当前 UI 的“已生效”或本地检查通过解释成四平台官方规则审核通过。

## 5. FR-03 品牌资产建档

### 需求与证据

| PRD 要求 | 代码/API/MCP/UI 证据 | 状态 | 缺口与建议 |
|---|---|---|---|
| 品牌名、定位、人群、品牌卖点 | `BrandProfile` 有 name/positioning/audience/details（`packages/application/src/service.ts:62-75`）；`brand.upsert/get` 在 `apps/plugin/mcp/bridge.mjs:122-128`；MCP E2E `apps/api/src/product-image-review.e2e.test.ts:78-93`。 | 部分完成 | 字段可存，但品牌卖点、定位与商品卖点的来源/事实结构不够细；没有完整 Codex/Studio 表单验收。 |
| 性格、语气、Logo 版本和使用限制 | `BrandProfile.visualRules.logo` 关联工作区图片素材，改色/变形/重绘默认 `false`；生成前检查扫描、权益、平台范围、有效期及 AI 修改许可。Merchant Studio 提供显式配置入口。 | 本地已完成 | 仍未做成片像素级 Logo 识别；真实扫描、权益和渲染模型属于外部验收。 |
| 主色/辅助色/禁用色、字体及商用授权、视觉风格 | `BrandProfile.visualRules` 强校验 `#RRGGBB`、颜色冲突、字体 `approved/restricted/unknown`、素材引用和风格词；内容、主图、Brief、预览及批准复查均消费规则。 | 本地已完成 | 实际成片是否精确使用品牌色/字体仍需图片分析、OCR 和生产渲染证据。 |
| 禁用内容、人物/IP、历史优秀/不喜欢素材及原因 | `restrictedSubjects` 分别保存禁用内容、人物、代言人和 IP，并进入模型/Codex 提示及确定性文案审核；`asset.preference.update` 和素材库编辑器要求商家显式填写优秀/不喜欢及原因。优秀素材在扫描、权益、有效期和平台条件满足时进入任务冻结快照，仅影响风格；不喜欢素材自动排除，显式选择时阻断。 | 本地大部分完成 | 图片像素中的人物/IP 仍没有外部视觉识别证据，必须人工复核。 |
| 素材权利状态、平台/地区/时间/用途、AI 是否允许修改 | `AssetMetadata` 独立保存 rightsStatus、rightsScope、applicablePlatforms、applicableRegions、usageScopes、validFrom/To、aiModificationAllowed、scanStatus；任务支持显式 `region`，快照对显式选择和优秀素材统一执行地区、扫描、权益、平台、用途、有效期门禁。 | 部分完成（代码/本地测试） | 真实扫描、权益凭证及生产组合 canary 仍需完成。 |
| 资产确认、冲突、缺失、草稿保存 | 品牌冲突结构和 resolution 在 `packages/application/src/service.ts:738-774`；`asset.list` 显式返回素材 `draft/ready/blocked` readiness、聚合统计、逐素材阻断原因和下一步 action cards；素材权益有 pending/approved/rejected。 | 部分完成（本地链路） | 素材生命周期状态已独立投影，仍需真实扫描/OCR/权益凭证和完整 onboarding 缺口列表验收。 |
| 上传品牌手册、Logo、字体说明、介绍、历史素材 | `asset.upload`/`asset.upload.batch`、文件格式集合、素材库 UI `demo/merchant-studio/src/App.tsx:268-287`。 | 部分完成 | 上传入口和列表存在；Codex 内可调用 MCP，但“上传后自动抽取并写入品牌档案”的闭环未证明，图片/扫描文档也不能解析。 |
| AI 提取结果展示来源/置信度并由用户确认 | `brand.extract` 与品牌提取 REST API 从 `extractedFacts` 生成字段候选，携带素材/字段来源、置信度、冲突 alternatives 和 `confirmationRequired`；Merchant Studio 逐字段复选及冲突单选后才调用保存。 | 已完成（本地链路） | PDF 页码/坐标级引用、图片 OCR 和扫描件识别仍需外部解析能力；置信度是解析启发式，不代表事实正确。 |
| 未确定调性提供三段试写 | `brand.tone.preview` 返回 tone_a/b/c（`packages/application/src/service.ts:725-736`），MCP schema 在 `apps/plugin/mcp/bridge.mjs:130-132`。 | 已完成（本地链路） | 需要补真实 Codex App 可见性和选择后保存为品牌规则的验收；当前 preview 本身不改变全局品牌档案。 |
| Logo 默认禁止改色/变形/重绘；字体授权不明标 restricted | 强类型规则默认三项禁止；字体支持 `restricted/unknown` 并在全部真实生成入口返回 `BRAND_VISUAL_RULES_BLOCKED`；已安装 bridge 保留字段级阻断详情。 | 本地已完成 | 这里只证明规则与门禁生效，不等于外部模型生成成片已通过像素级品牌审核。 |

### FR-03 结论

当前可称为“品牌档案 + 素材权益 + 候选提取/逐字段确认 + 视觉强规则生成门禁 + 历史素材评价/引用/排除”的本地闭环，但仍不能称为完整生产品牌资产建档。剩余主要缺口是像素级人物/IP 与成片品牌一致性，以及图片 OCR、扫描件和页码/坐标级来源证据。

## 6. FR-04 店铺、商品与 SKU 建档

### 需求与证据

| PRD 要求 | 代码/API/MCP/UI 证据 | 状态 | 缺口与建议 |
|---|---|---|---|
| 店铺名称、平台、品类、相对品牌差异 | `Product` 有 platform/storeName/category/storeDifferentiation；`catalog.import` 的 MCP/REST 均支持 `store_differentiation`，生成内容的品牌模块消费该字段。 | 部分完成 | 字段和快照链路已完成；Merchant Studio 仍需将其纳入正式表单，真实店铺资料同步和商家确认仍属外部/交互验收。 |
| API 同步和资料上传；商品名、货号、平台商品 ID、类目、店铺、上下架状态 | `catalog.import`、`catalog.sync/start/get`（`apps/plugin/mcp/bridge.mjs:62-64,150-170`）；REST sync/callback 代码 `apps/api/src/server.ts:2459-2602`；Product 有 remoteId/listingStatus/source。 | 部分 / 外部依赖 | 本地 fixture 和 API 适配层可运行；真实官方 API、字段映射、增量 cursor、上下架回读尚未通过平台 canary。CSV/本地导入不等于 API 同步。 |
| 真实商品图、参数、SKU/规格及 SKU 图片映射 | `ProductSku`、Product images/attributes；服务层同步保留逐 SKU 数据；显式 `sku.images` 会进入确定性逐 SKU 映射门禁，缺图返回 `SKU_IMAGE_MAPPING_INVALID`；主图检查 API 和 E2E 已覆盖。 | 部分完成 | 真实平台 SKU 图片映射、主体一致性、图与 SKU 的人工确认 UI 未完成；主图审核明确把清晰度/OCR/平台最终审核列为外部未验证。 |
| 最多 3 个核心卖点、适用人群/场景、证明状态 | `Product.sellingPoints`、商品事实确认、方向选择和 content review；MCP/REST/OpenAPI 均支持卖点证明状态。 | 部分完成 | 核心卖点已限制最多 3 条，并要求来源 ID 与 `confirmed` 状态；真实平台证明、OCR、线上渲染和 SKU 图片授权组合仍需外部 canary。 |
| 长期价/日常价；活动价只在任务，有范围和有效期 | Product 有 price；Task 有 `promotion_json`，确认方案生成 `PromotionSnapshot`，限定平台/店铺/商品/SKU/起止时间并随任务快照冻结；方案返回 `promotionPriceDiff` 逐 SKU 展示基准价、展示价、券后价和差额。 | 部分完成 | 多件多折、平台补贴和真实平台价格回读仍未完成；已有金额两位小数、过期和 SKU 歧义测试。 |
| 库存、平台更新时间、SKU 绑定；映射失败保留 payload 摘要并进入待处理队列 | `Product` 有 stock/platformUpdatedAt/rawPlatformFields/mappingWarnings；SyncJob 有 failedItems/cursor/retry（`packages/application/src/service.ts:267-291,673-692`）；`apps/api/src/sync-job.e2e.test.ts:16-31`。 | 已完成（代码/本地测试） | 仍需真实长分页、Worker 重启、平台字段异常和云环境验收；当前测试是 API/本地持久化边界。 |
| 风险、禁用项、证明材料、素材授权、最终确认 | `factsConfirmed`、`Product.sellingPoints`、asset rights、content review、`catalog.facts.confirm`。 | 部分完成 | 商品卖点证明和确认门禁已完成；真实平台证明、OCR、线上渲染和 SKU 图片授权组合仍需外部 canary。 |
| AI 只能从资料提取参数，不自行补全事实 | 任务创建对未确认 facts 阻断（`packages/application/src/service.ts:1167-1174`）；生成器使用商品快照；审核阻断缺失来源。 | 已完成（边界） | 需用真实模型和提示注入/资料冲突黄金集继续验证；fixture 生成结果不能证明模型不会幻觉。 |
| 同名商品让用户选择稳定 ID | `catalog.search` 支持 remote_product_id/account_id，商品 ID 作为任务绑定；结果额外返回逐商品 `product_actions`，未确认商品直接引导 `catalog.facts.confirm`；多账号 migration/测试存在。 | 部分完成（本地链路） | 搜索参数、稳定 ID 和事实确认动作已存在，但缺少 Codex App 同名候选选择交互的实测证据。 |
| 三个平台同款关系不得仅凭名称自动合并 | 任务组创建独立子任务，平台/账号隔离；实现状态文档记录过相关测试。 | 已完成（代码边界） | 仍需把该行为纳入正式 FR-04 追踪测试，且真实平台远端身份证据尚未完成。 |

### FR-04 结论

统一商品/SKU/账号/同步任务的工程骨架较完整，且本地测试覆盖较好；但 FR-04 的核心业务承诺是“官方授权后的真实四平台同步”，这一点目前仍是外部依赖，不能以 fixture 同步成功替代。

## 7. FR-05 文件上传、解析与资产安全

### 需求与证据

| PRD 要求 | 代码/API/MCP/UI 证据 | 状态 | 缺口与建议 |
|---|---|---|---|
| 支持 PDF/DOCX/XLSX/CSV/TXT/PNG/JPG/JPEG/WEBP/SVG；AI/EPS 仅存储并提示不可完整解析 | 扩展名白名单在 `apps/api/src/server.ts:652`；签名/MIME 校验在 `apps/api/src/server.ts:664-686`；parser 支持 JSON/text/CSV/MD/XLSX/DOCX/PDF，图片 OCR/AI/EPS 明确失败（`packages/application/src/document-parser.ts:48-71`）。 | 部分完成 | 上传格式范围基本齐全，但 PRD 没有把 JSON/MD列为 P0 必须格式，代码额外支持；PNG/JPG/WEBP/SVG 只上传不解析，扫描 PDF/OCR 需要外部解析器。 |
| 单文件 ≤50MB、单批≤20个、总计≤250MB | `MCP_BODY_LIMIT=70MB`、单文件 50MB、批量 20/250MB 在 `apps/api/src/server.ts:646-649,1240-1254,1706-1716`；storage 默认 50MiB 在 `packages/storage/src/object-storage.ts:127-130`。 | 已完成（限制） | 需补 REST 批量上传是否与 MCP 完全一致的测试；Codex base64 包体的实际边界还应做大文件验收。 |
| 校验扩展名、MIME、内容签名；拒绝可执行、加密压缩、路径穿越 | 扩展名、MIME、PNG/JPEG/WEBP/SVG/PDF/Office 签名和 PE/ELF/Mach-O/shebang 拒绝在 `apps/api/src/server.ts:652-686`；storage 路径规范化/隔离在 `packages/storage/src/object-storage.ts:151-189`；E2E `apps/api/src/product-image-review.e2e.test.ts` 覆盖可执行、签名不匹配和 ZIP/加密压缩扩展名拒绝。 | 部分完成（代码/本地测试） | 白名单会在隔离区前拒绝 ZIP/加密压缩包；真实云扫描服务和复杂容器格式仍需外部安全验收。 |
| 原始只读保存，派生预览另存，不覆盖原文件 | quarantine→clean promotion、完整性校验在 `packages/storage/src/object-storage.ts:204-272,396-477`；storage tests `packages/storage/src/object-storage.test.ts:10-82`。 | 已完成（本地 storage 契约） | 生产 S3/KMS、病毒扫描回调和跨服务只读权限仍为外部依赖；“派生预览”对象生产链路未见专门实现。 |
| 上传指令是不可信数据，不改变系统规则/调用工具 | 所有新旧素材统一返回 `contentTrust={classification:untrusted,mode:data_only,canOverrideInstructions:false,canTriggerTools:false,requiresMerchantConfirmation:true}`；Codex 草稿规则与 Skill 均明确禁止服从素材指令。HTTP E2E 上传含 `publish.confirm` 的恶意 TXT，确认其只进入 extractedFacts 且发布任务仍为 0；Merchant Studio 显示可见信任边界。 | 已完成（TXT 本地闭环） | DOCX/PDF 使用同一资产信任边界；生产仍应以供应商模型做跨格式 prompt-injection 红队验收。 |
| 解析失败保留原文件、说明位置、允许手工填写 | API parse failed 保留 asset，并返回结构化 `parseErrorContext`（错误类别、可选位置、`asset.facts.confirm` 动作）；JSON 语法错误记录字符列，不支持格式记录人工补录动作；`apps/api/src/asset-parse.e2e.test.ts` 覆盖失败后补录。 | 部分完成 | 文档解析器仍不能为图片 OCR/扫描 PDF 提供真实页级定位；Merchant Studio 的专用补录表单仍需交互验收，Codex 插件已提供人工补录路径。 |
| 同一文件重复上传可去重但保留引用关系 | `MerchantService.registerAsset` 按 workspace+SHA-256 复用对象，`references` 持久化不同文件名/MIME 的上传引用；MCP/HTTP 重复上传跳过对象写入，原扫描/权益状态不变；同一引用重试不增加 revision。service、HTTP E2E 和 Merchant Studio UI 契约均覆盖。 | 已完成（本地闭环） | 生产对象存储仍需以真实 S3/云扫描环境复验，但不再缺少领域引用关系。 |

### FR-05 结论

文件安全的本地隔离、签名校验、扫描晋级以及重复文件引用去重已形成可测试闭环；解析能力仍是“结构化文本和 Office/PDF 文本层 MVP”，不是完整素材智能阅读能力。图片 OCR、扫描 PDF、真实扫描服务和云对象存储仍不能标记为完成。

## 8. 建议补齐顺序

1. **先补 FR-02 规则执行语义**：统一状态名，补 effective/expiry、severity/action、优先级冲突 evaluator、rule hit 追踪和四平台规则包；这是所有正式生成/确认的上游门禁。
2. **再补 FR-04 真实平台证据**：完成京东、淘宝/天猫、拼多多的 OAuth、测试店铺、全量/增量读取、SKU/字段映射、状态回读和错误/限流证据；fixture 只能保留为本地测试。
3. **继续补 FR-03 外部识别与评价**：品牌候选、逐字段确认及 Logo/字体/颜色强约束已完成；下一步是页码/坐标级来源、历史素材评价、图片 OCR/扫描件和像素级成片品牌一致性。
4. **补 FR-05 安全与解析闭环**：病毒/加密压缩扫描、OCR/扫描 PDF、图片元数据、重复文件引用、手工修正 UI，以及 S3/KMS/扫描回调 canary。
5. **最后补 FR-01 宿主体验验收**：真实 Codex App 安装、首次工作区 onboarding、MCP 失败诊断、权限显示和停用/升级/回滚；形成可复现的 60 秒安装健康检查报告。

## 9. 不应写入“已完成”的结论

- 本地 `fixture_ready` 不等于平台已授权。
- fake connector 的同步成功不等于京东、淘宝/天猫或拼多多真实同步成功。
- `npm test` 全绿不等于真实 OAuth、真实规则、真实 OCR、真实对象存储或真实云容量通过。
- Merchant Studio 的演示数据和 UI 可见不等于 Codex App 商家端全部交互完成。
- 本地图片 fixture 或本地模型回退不等于生产 AI 文案/图片服务已经配置。
