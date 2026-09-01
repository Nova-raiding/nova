# PRD FR-06～FR-10 需求追踪与实现审计

审计范围：`doc/PRD-merchant-marketing-codex-final.md` 中 FR-06～FR-10。

审计时间：2026-08-24

> 2026-08-25 增量复核：本文下方“遗漏”保留 2026-08-24 的历史判断；以下项目已经补齐，冲突时以本增量复核为准：

> 2026-08-31 FR-09 增量复核：生成器不再把所有冻结商品来源复制到空来源模块；模块来源必须由模型逐项提供，缺失时 fail-closed。无数据模块统一采用 `pending + pendingReason`，模型省略模块时由应用补齐明确待确认模块，不生成空泛正文；该策略满足“省略或标记待补”的 PRD 口径。AI/应用回归通过，真实模型质量与 relay 证据仍未完成。

> 2026-08-31 FR-08 增量复核：方向重生成/修改卖点时已重新绑定当前商品事实来源；无法匹配的卖点保持 `pending`，不会继承旧方向证据。定向服务回归通过；真实模型方向质量评测与 Host 交互证据仍未完成。

> 2026-08-31 增量复核：FR-06 多候选商品问题新增稳定 `candidates` ID 列表；FR-07 `TaskQuestion.evidenceKind` 新增商家请求、商品事实、平台授权、平台规则和系统默认来源分类，并由 Merchant Studio 展示来源标签。定向应用/UI 回归通过；复杂实体解析、真实授权续期和真实 Codex Host 仍未完成。
>
> - FR-06 新增版位、目标、受众、场景、卖点、价格策略、活动有效期、输出数量和限制的自然语言提取，并写入制作方案。
> - FR-06 多平台理解新增结构化 `executionPlan`：明确 `split_by_platform`，逐平台返回唯一/缺失/歧义商品绑定；任一平台未唯一绑定时阻断创建，不再把单个平台商品 ID 写成全局 `product_id`。Merchant Studio 展示独立子任务计划与候选稳定 ID。
> - FR-06 多平台创建闭环新增每平台唯一选择、商家确认清单和服务端整组预校验；平台重复、商品/平台/店铺不匹配时整组失败且不产生孤儿子任务。
> - FR-06 重复提交闭环新增可恢复幂等：同键同意图在条目顺序变化或 API 重启后仍返回原任务组，不重复创建子任务或事件；同键换意图失败关闭。
> - FR-07 新增动态问题重算、blocking/recommended/optional 排序、每轮最多 4 问、非阻断“稍后补充”、促销有效期阻断和紧急任务减少非阻断问题；阻断状态不能选择方向。
> - FR-10 `content.review` 现在固定返回六类审核结果；Finding 已具备 P0/P1/P2、证据、修复建议和状态。品牌证据不足显示 `not_evaluated`，平台外部校验显示 `external_pending`，不伪报通过。
> - FR-10 处理闭环已补齐：P1/P2 支持“已知悉/带理由接受”，处理人、原因、时间写入内容版本并增加 revision；P0 在 REST 与 MCP 均拒绝绕过。Merchant Studio 提供对应操作并显示审计记录。
> - FR-10 品牌确定性审核已补齐可本地闭环部分：任务自动绑定工作区品牌档案，内容版本冻结完整品牌 revision 并可跨进程重启恢复；品牌禁用词产生带版本证据的 P0，重叠规则去重后只保留一条商家处理项。Logo/颜色/字体/语气等需要稳定结构化证据的检查仍不伪报通过。
> - FR-10 平台驳回修正闭环已补齐：四平台适配器、Worker、API 和 `publish.get` 保留安全的原始拒绝码、可读原因和字段错误；Merchant Studio 可定位原任务并创建 `review_required` 子版本。旧版本和驳回回执不可变，修正版必须重新审核、批准、预览和确认，禁止自动重发。
> - FR-10 六类审核基础 finding 已补齐：商品事实、品牌、文案/价格/合规、视觉 Brief、技术规格和平台预检均有统一 code/严重度/来源/修复建议；真实平台预检仍保持 `external_pending`，不把本地映射当作平台通过。
> - FR-09 默认与历史内容版本均补齐完整详情模块；缺资料明确标记待确认；模型结构错误最多自动修复 2 次。Merchant Studio 直接展示完整模块，不向商家暴露内部来源字段。
> - 最新回归：77 个测试文件、496 项测试、TypeScript 和 production build 全部通过；新增生产模式钱包回归覆盖零余额拒绝、充值回调解锁和幂等扣款。真实平台、真实模型和云环境仍不在本地完成口径内。

审计方式：逐条阅读 PRD、插件 Skill、应用服务、API/MCP 路由、AI 生成器、审核模块和定向测试；本轮同步修正了规则检查时间字段及本报告中已过时的完成描述。

## 总结结论

| 功能 | 状态 | 结论 |
|---|---|---|
| FR-06 自然语言任务与上下文解析 | 本地大部分完成 | 有自然语言入口、候选识别、结构化字段抽取、阻断问题、任务快照、任务组和唯一绑定后的自动创建；品牌实体、复杂优惠、黄金评测集、跨会话生产恢复与真实宿主交互证据仍需补齐。 |
| FR-07 智能追问 | 部分完成 | 已实现阻断/推荐/可选分类、按影响排序、每轮数量限制、原因/跳过后果、暂缓与重算；跨会话暂缓恢复、证明来源级分类和真实授权续期回归仍需补齐。 |
| FR-08 创意方向与制作方案 | 部分完成 | 固定三方向、选择/合并/修改/重新生成、方案确认、活动有效期/促销快照和规则检查时间已实现；事实型卖点证据绑定、差异化质量评估和正式入口门禁矩阵仍需补齐。 |
| FR-09 内容生成 | 本地大部分完成 | 平台托管模型详情内容、模块、静态 Brief、局部修改和字段锁定已实现；Codex-native prepare/commit 仅用于本地开发/测试，生产环境拒绝宿主模型路径；任务方案确认时的商品/SKU/价格/库存/素材/规则快照现在随任务 payload 持久化并可重启恢复，图片候选冻结 `skuIds` 并在选图/发布前校验范围，`task.sku.split` 可将未锁定的多 SKU 任务原子拆成逐 SKU 独立交付包，JSON Schema 校验和最多两次自动修复已实现；真实模型质量仍需补齐。 |
| FR-10 自动检查与人工确认 | 本地确定性基础闭环完成，外部证据待补 | 六类 finding、P0/P1/P2、处理审计、品牌版本冻结及平台驳回字段修正已完成；真实视觉/品牌深度校验、真实平台预检与模型辅助审核仍不能在 fixture 中宣称通过。 |

因此，当前不能对外宣称“FR-06～FR-10 已全部完成”。最主要的发布阻断项是 FR-10 六类审核，以及 FR-09 的快照冻结和结构化输出校验。

## 证据索引

| 证据 | 位置 |
|---|---|
| PRD 原文 | `doc/PRD-merchant-marketing-codex-final.md:690-794` |
| 插件工作流约束 | `apps/plugin/skills/merchant-marketing/SKILL.md:14-43` |
| 任务理解与追问 | `packages/application/src/service.ts:1187-1219` |
| 三方向与制作方案 | `packages/application/src/service.ts:533-590`、`1222-1265` |
| 详情内容与 Brief | `packages/application/src/service.ts:1268-1359`、`1535-1635` |
| 内容审核入口 | `packages/application/src/service.ts:990-1000` |
| 确定性审核实现 | `packages/review/src/review.ts:1-79` |
| 任务理解/快照测试 | `packages/application/src/version-vector.test.ts:43-86` |
| 任务答案 API 测试 | `apps/api/src/task-answers.e2e.test.ts:16-31` |
| 方向/内容/审核测试 | `packages/application/src/service.test.ts:312-386` |
| AI 结构化输出测试 | `packages/ai/src/generator.test.ts:4-40` |
| 资产解析测试 | `apps/api/src/asset-parse.e2e.test.ts:16-32` |
| 任务全链路 API 测试 | `apps/api/src/server.e2e.test.ts:40-220`、`340-390` |

## FR-06 自然语言任务与上下文解析

### PRD 要求

PRD 要求自然语言输入、示例、识别品牌/店铺/商品/SKU/平台/位置/内容类型/场景/目标/卖点/受众/价格/优惠/有效期/数量/限制；多平台需要创建独立子任务；要展示“系统理解”并允许修正；要建立快照并记录规则检查时间、预计时间、成本；任务可恢复。验收还要求多候选不自动绑定、修正后只使用新 ID、重复提交不重复交付、子任务相互隔离。

### 已实现证据

- API/MCP 暴露 `task.understand`，服务方法 `understandTaskRequest` 接收自然语言并返回 `platformCandidates`、`productCandidates`、`extracted`、`questions`。
- 当前实际解析了平台、通过商品标题或远端 ID匹配商品、以及“目标/目的/主推/重点”后的目标文本：`service.ts:1187-1196`。
- 多候选商品会生成阻断问题，不会自动写入 `product_id`：`service.ts:1197-1201`。
- `task.answer` 会保存答案、递增任务版本并生成 `inputSnapshotId`：`service.ts:1204-1218`。
- `createTaskGroup` 能创建多个独立任务，并保留独立平台/商品任务对象：`service.ts:1174-1184`；测试覆盖在 `version-vector.test.ts:53-63`。
- Skill 已规定自然语言入口、候选不唯一时让用户选择、任务历史恢复和不重复创建：`SKILL.md:14`、`37`、`43`。

### 测试证据

- `version-vector.test.ts` 验证自然语言识别淘宝和商品、缺少平台/商品时返回阻断问题：`76-86`。
- `version-vector.test.ts` 验证答案快照和明确事实确认后才进入 `ready_for_direction`：`43-51`。
- 同文件验证多平台任务组有不同任务 ID 和平台：`53-63`。
- `server.e2e.test.ts` 验证平台托管生成任务流程、版本和发布前状态；生产 Codex-native 路径的拒绝由 application service 回归覆盖；本次定向运行通过。

### 遗漏与判定

1. **解析字段仍非完整语义解析。** `understandTaskRequest` 已覆盖平台、商品候选、目标、受众、场景、卖点、活动有效期、输出数量、限制、位置和价格策略，并在唯一商品上下文中解析店铺/SKU；品牌实体、跨平台分别绑定和复杂优惠结构仍需结构化确认，不能把正则抽取当作完整实体解析。
2. **自然语言示例已补齐。** Skill 现在提供简短/标准/完整三档示例，并明确缺字段时的追问和多平台拆分要求；仍需在真实宿主会话中做交互验收。
3. **多平台自动拆分已串入解析闭环。** 新增 `task.request.create` / `POST /v1/task-requests`：自然语言请求在每个平台均有唯一商品绑定时，服务端复用完整任务组原子校验并创建独立子任务，支持幂等重放；平台或商品候选不唯一时仍返回澄清错误，不会猜测绑定。各子任务后续继续独立保存字段映射、规则、版本、确认和发布回执；真实平台回执仍受生产 canary 门禁。
4. **“系统理解”和快速修正已补齐商品实体替换。** `task.answer` 收到新的 `product_id` 时会校验工作区/平台，替换任务商品和店铺绑定，并清空旧方向、方案和候选引用；品牌、复杂优惠和自然语言多实体修正仍需结构化接口。
5. **任务快照已完成持久化修复，但仍需生产恢复证据。** 方案确认时完整快照写入任务 payload，API 重启 hydrate 会恢复 `taskInputSnapshots`，生成路径优先读取冻结快照；新增重启回归覆盖商品标题、价格和库存不随当前商品变化。生产数据库恢复演练仍需补充独立证据。
6. **规则最后检查时间已补齐任务方案证据。** 确认方案时将冻结快照的 `rulesCheckedAt` 写入 `productionPlan`，内容版本仍引用同一规则版本集合；外部规则源的实时刷新证据仍属于平台连接验收。
7. **幂等和恢复验收仍有边界。** 生成任务和图片任务有幂等设计，任务组对同一意图有重放保护；服务层已覆盖关闭会话后恢复暂缓问题/答案，真实宿主端到端重复提交与生产数据库恢复演练仍需补齐。

**判定：本地代码闭环完成，生产验收未完成。** 自然语言理解、唯一绑定自动拆分、幂等和澄清阻断已有应用/API/插件合同测试；真实宿主交互、复杂多实体语义解析和生产平台回执仍需单独验收。

## FR-07 智能追问

### PRD 要求

追问必须区分阻断型、推荐型、可选型；每轮最多 3～4 问，按正确性影响排序；每个问题说明原因和跳过后果；已确认不重复询问；支持“稍后补充”；紧急任务可以减少非阻断问题，但不能跳过事实和授权。

### 已实现证据

- `TaskQuestion` 具有 `id`、`kind`、`prompt`、`why`、`ifSkipped` 等字段，阻断问题包含原因和后果：`service.ts:1197-1201`。
- 初始任务在商品事实未确认时会生成 `confirm_facts` 阻断问题：`service.ts:1160-1168` 附近的 `createTask` 实现。
- `task.answer` 限制可写字段，并在 `confirm_facts=true` 后删除事实确认问题、进入 `ready_for_direction`：`service.ts:1204-1219`。
- 追问现在按置信度评分构建问题池：先输出阻断问题，再按影响排序输出推荐/可选问题；支持紧急任务 `max_questions=3`，普通场景 `max_questions=4`：`service.ts:786-851`。
- 加入授权问题与 SKU 问题，且“稍后补充”的问题可恢复：`service.ts:796-851`、`service.ts:2099-2165`。
- 暂缓问题在后续提交中会被清除并触发重算：`service.ts:2159-2163`。
- Skill 要求在缺关键事实时只追问阻断项，并要求内容生成前先检查素材库：`SKILL.md:8`、`22`、`37`。

### 测试证据

- `version-vector.test.ts:43-51` 验证回答问题、保存输入快照、事实确认后解锁。
- `version-vector.test.ts:43-55` 验证回答问题、保存输入快照、事实确认后解锁。
- `version-vector.test.ts:58-80` 验证已回答后问题重算、阻断不能暂缓、活动有效期阻断。
- `version-vector.test.ts:82-117` 验证暂缓问题可在后续直接回答并从 `deferredQuestionIds` 移除。
- `task-answers.e2e.test.ts:16-31` 验证 API 创建任务时保存答案并进入 `ready_for_direction`。
- 全部上述定向测试通过。

### 遗漏与判定

1. **问题分类与动态评分仍在增强。** 已覆盖阻断、推荐、可选的动态排序闭环，新增了 SKU、授权与活动时效问题；尚待补齐规则冲突与证明来源级分类。
3. **每轮 3～4 问约束已生效。** 当前实现按分数截断，但仍需持续观测真实会话下的排序可解释性与跳过后果提示。
4. **“稍后补充”语义与持续性路径已补齐本地闭环。** `deferredQuestionIds` 随任务快照持久化，服务重启 hydrate 后仍可恢复并继续回答；真实宿主会话恢复仍需验收。
5. **授权门禁已纳入追问输出。** 授权续期/重绑后的真实回调与云端会话恢复仍需外部回归。
6. **素材前置门禁已下沉到应用层。** `captureTaskInputSnapshot` 统一校验素材工作区、扫描、权益、解析事实、平台/区域/用途和有效期；文档类素材还必须解析成功并完成商家事实确认。`generateDraft`、`prepareCodexDraft` 和 `commitCodexDraft` 复用该冻结快照，生产 PostgreSQL 重启/恢复演练仍需证明线上持久化链路。

**判定：部分完成。** 已覆盖“事实确认阻断”的最小闭环，但还不是 PRD 的智能追问系统。

## FR-08 创意方向与制作方案

### PRD 要求

必须恰好 3 个差异清楚的方向；每个方向包含名称、核心思想、结构/构图、配色、文案方向、卖点、适合原因和风险；支持选择、合并、修改、重新生成；方案需包含完整任务上下文、平台/位置、商品/SKU、目标、卖点、价格/时效、方向、数量、资产、禁改项、格式、预计轮次、时间和成本；必须明确确认后才能正式生成。

### 已实现证据

- `listCreativeDirections` 默认返回 A/B/C 三个方向，字段包含名称、核心思想、结构、视觉方向、卖点、适合原因、文案方向和风险：`service.ts:533-544`。
- 支持 `regenerate`、`merge`、`modify`，并把旧方向追加到 `directionHistory`，新方向带版本后缀：`service.ts:546-590`。
- 选择方向时创建 `productionPlan`，包含平台、商品、SKU、目标、卖点、价格策略、格式、数量、必需资产、禁改项、预计修改轮次、时间和成本：`service.ts:1222-1250`。
- `confirmProductionPlan` 要求 `direction_selected`，写入 `confirmedAt`、`confirmedBy` 和方案确认状态：`service.ts:1256-1265`。
- `generateDraft`、`prepareCodexDraft` 仅接受 `plan_confirmed`：`service.ts:1295-1300`、`1328-1333`。

### 测试证据

- `service.test.ts:312-324` 覆盖三个方向、合并/修改的版本行为。
- `server.e2e.test.ts:136-144` 验证返回 A/B/C、选择方向、方案确认、内容生成和审核。
- `server.e2e.test.ts:354-360` 验证 MCP 方向选择→方案确认→内容生成。
- 本次定向测试全部通过。

### 遗漏与判定

1. **方向事实证据绑定已补齐基础结构。** 方向与制作方案现在带 `sellingPointEvidence`，每个事实型卖点都有 `factSourceIds` 和 `proofStatus`；没有可验证来源时明确标记 `pending`。剩余缺口是把更多商品属性自动映射到细粒度事实字段，而不是只依赖卖点文本精确匹配。
2. **方向差异目前是固定模板差异。** 默认 A/B/C 由硬编码模板生成，重新生成主要给名称追加反馈文本；没有模型/评估证据证明不是同义词改写，也没有差异质量测试。
3. **制作方案活动有效期已补齐。** `activity_valid_until` 会进入 `ProductionPlan.activityValidUntil`，促销快照会计算逐 SKU 的 `promotionPriceDiff`；确认、内容生成和导出审核均复用该快照，并对过期活动价 fail-closed。剩余缺口是生产对象存储中已导出旧包的过期标记与下载重试验收。
4. **正式生成状态门禁矩阵已补齐本地证据。** 生产环境下异步文本、平台托管内容、Codex prepare/commit，以及绑定任务的图片生成均在未确认方案时拒绝；真实生产 API/Worker 仍需部署后验收。

**判定：部分完成。** 核心交互和版本骨架可用，但事实绑定和方案字段仍不足。

## FR-09 内容生成

### PRD 要求

详情页至少包括首屏、卖点、解决方案、细节/材质/工艺、使用场景、参数、尺码/使用指南、SKU、证据、包装、售后、品牌介绍和 CTA；每个模块需有目的、标题、正文、事实引用和真实图片类型建议。静态 Brief 需覆盖平台版位、尺寸、层级、真实图、Logo、标题、副标题、卖点、价格/优惠、CTA、密度、安全区和禁改区域。生成必须使用任务快照、通过 JSON Schema、格式错误最多修复 2 次、区分事实/创意/待确认，并支持字段锁定和局部重生成。

### 已实现证据

- `contentModules` 生成首屏、核心卖点、解决方案、细节/材质/工艺、使用场景、参数、尺码/使用指南、SKU、证据、包装、售后、品牌、CTA、真实图片建议和平台交付说明等模块；每个模块有目的、正文、事实来源和适用的图片建议：`service.ts:2962-2992`。
- `defaultStaticBrief` 包含平台/版位、尺寸说明、视觉层级、真实商品图、Logo 安全、标题、副标题、核心卖点、价格表达、CTA、文字密度、安全区和禁改区域：`service.ts:1548-1565`。
- `prepareCodexDraft` 返回结构化输出要求、模块 schema、Brief schema 和“只使用已确认事实”等规则：`service.ts:1328-1350`。
- `normalizeCodexBody` 会规范化模块和 Brief，缺失模块时生成默认模块；`modifyContentVersion` 支持按字段修改并检查锁定字段：`service.ts:1351-1360` 及其后续实现。
- 外部模型路径使用 OpenAI-compatible provider，并要求 JSON object；生成器对输出做结构化读取/校验：`packages/ai/src/generator.ts`。

### 测试证据

- `generator.test.ts:4-40` 验证 provider 调用、结构化输出和静态 Brief。
- `service.test.ts:326-364` 验证导出、静态 Brief、内容版本向量。
- `service.test.ts:366-386` 验证审核前置和未知 SKU 阻断。
- `server.e2e.test.ts:40-52`、`354-362` 验证平台生成、内容版本、审核链路；application service 测试验证生产 Codex-native 旁路被拒绝。
- 上述定向测试 65/65 通过。

### 遗漏与判定

1. **默认详情模块覆盖已补齐。** 默认内容现在覆盖 PRD 列出的主要模块，并对缺失资料统一生成 `pending` 与 `pendingReason`；仍需真实内容评测验证模块文案质量。
2. **无数据处理已统一为显式待确认。** 默认和省略后补齐的模块均使用 `contentKind=pending` 与非空 `pendingReason`，不输出空泛正文；`omitted` 不作为模型可写状态，避免客户端把“未返回”误解为已完成。仍需真实内容评测验证模型不会在非 pending 模块中产生无来源推断。
3. **任务快照与追问状态已覆盖本地跨会话恢复。** `confirmProductionPlan` 捕获完整快照并写入 `task.inputSnapshot`，`hydrateSnapshot` 恢复快照、答案、暂缓问题和版本；真实 PostgreSQL 重启/恢复演练仍需证明线上部署链路。
4. **结构化输出边界已实现，但仍需扩展契约覆盖。** 当前已对必填字段、模块、静态 Brief 执行结构校验，格式错误最多自动修复 2 次；仍需扩展更完整的 PRD 模块覆盖和 SKU 冲突拆分评测。
5. **事实/创意/待确认分层已补齐基础契约和预览交互。** `ContentModule.contentKind` 明确区分 `fact`、`creative`、`pending`，待确认模块必须保留 `pendingReason`；旧模型/fixture 输出缺少该字段时由应用层按正文安全归类。Merchant Studio 已提供按类别筛选、计数、类型徽标和待确认原因展示；确认动作仍回到 Codex 插件的正式工作流。
6. **模块级局部重生成已形成独立流程。** `content.modify`/REST 内容修改入口支持 `module_key`，应用层只替换指定默认模块，保留兄弟模块、事实/规则版本向量和父版本，并重新进入 `review_required`；MCP/REST 回归覆盖 CTA 模块和锁定模块阻断。真正调用外部模型进行模块重生成仍需生产模型 provider 支持。
7. **SKU 范围隔离与自动拆包已补齐。** 明确选择 SKU 后，制作方案、冻结快照和内容版本向量只保留该 SKU 的价格/库存/事实；模块仍可用 `referencedSkuIds` 做逐模块映射，审核会阻断未知或无图片映射的 SKU。自然语言明确要求“每个 SKU/逐个规格分别做”时，`task.request.create` 会在事实已确认后直接规划逐 SKU 任务组；`task.sku.split` 和 `POST /v1/tasks/:id/sku-split` 也会在任务尚未锁定时，按幂等键原子创建每个 SKU 的独立任务与交付包；真实平台逐 SKU 媒体/发布 canary 仍需外部验收。

**判定：部分完成。** 可生成可审阅详情/Brief，但距离 PRD 的可信内容生产标准还有明显差距。

### 2026-08-31 增量：模块分类成为模型输出硬门禁

模型输出校验现在要求每个 `modules[]` 项显式提供 `contentKind`，取值只能是 `fact`、`creative` 或 `pending`；`pending` 必须同时提供非空 `pendingReason`。此前应用层会为旧数据补默认分类，但模型信任边界不应接受缺失分类，因此缺失字段现在会进入最多两次结构修复，修复失败则拒绝交付。新增回归覆盖缺失 `contentKind` 的拒绝路径；AI/application/version-vector 定向测试 156/156 通过。

该增量只关闭结构化输出契约缺口，不证明模块文案质量、外部模型稳定性或真实平台审核已完成，因此 FR-09 仍保持“部分完成”，本文件继续留在 `doc/todo`。

## FR-10 自动检查与人工确认

### PRD 要求

必须有六类检查：商品真实性、品牌一致性、文案/价格/合规、视觉 Brief 质量、技术规格、平台发布预检；支持 P0/P1/P2 严重度；P0 未解决不能批准；模型检查不能独自宣布合规；商家可见检查项、严重度、来源、建议和处理状态；平台驳回要保存原始错误码并提供字段修正入口。

### 已实现证据

- `reviewContent` 调用 `reviewDeterministic`，审核前检查事实来源、模块来源、规则版本、SKU 和禁用词：`service.ts:990-1000`。
- `reviewDeterministic` 还检查规则版本有效性、价格范围和 SKU 引用：`packages/review/src/review.ts:58-75`。
- `approveContent` 在 `isReviewBlocking(findings)` 为真时抛出 `REVIEW_BLOCKED`，否则才把版本置为 `approved`：`service.ts:1369-1380` 附近的审批实现。
- 主图有独立的格式、尺寸、重复、缺失等检查：`packages/review/src/review.ts:10-41`；API 的 `catalog.image.review` 返回外部验证边界。
- 发布准备/发布流程另有平台字段和远端快照检查，且 Skill 明确要求本地预检不等于平台受理：`SKILL.md:42`、`62-66`。

### 测试证据

- `packages/review/src/review.test.ts:8-17` 验证来源、规则、价格、SKU、禁用词阻断。
- 同文件 `52-72` 验证规则版本不可用时阻断，`62-66` 验证模块无事实来源时阻断。
- `service.test.ts:366-386` 验证内容审核和未知 SKU 阻断。
- `product-image-review.e2e.test.ts:16-56` 验证主图审核和外部验证边界。
- `server.e2e.test.ts:142-144`、`358-362` 验证内容审核链路。
- 本次运行结果：7 个测试文件通过，65 个测试通过。

### 遗漏与判定

1. **六类审核基础检查已实现，但深度证据仍缺失。** `ReviewFinding.code` 现在覆盖商品事实、品牌、文案/价格/合规、视觉 Brief、技术规格和平台预检；图片像素比对、真实平台字段回读、模型辅助审核仍未完成。
2. **商品真实性只检查 SKU/来源，不检查商品视觉事实。** 没有颜色、结构、材质、配件、Logo/印花、使用方式与真实商品图的比对。
3. **品牌一致性缺失。** 虽有品牌资料和禁用词能力，但 `content.review` 没有检查 Logo、颜色、字体、视觉方向、语气、品牌禁用项的完整结果。
4. **文案/价格/合规只覆盖子集。** 有来源、价格范围、禁用词和规则版本检查，但没有价格有效期、卖点证据、人物/IP 授权、平台/品类规则细项和绝对化表达的完整证据链。
5. **视觉 Brief 目前是结构化完整性检查。** 已检查版位、尺寸、层级、真实商品图指导、Logo 安全区、CTA 和保护区域；画面清晰度、构图、像素级商品保护仍需真实视觉供应商/人工验收。
6. **技术规格目前覆盖 schema 和 manifest 基础门禁。** 交付文件的尺寸/比例、格式、命名和完整清单仍需导出物料级检查。
7. **平台预检已纳入 finding 结果，但真实回读仍 pending。** `PLATFORM_PREFLIGHT_PENDING` 明确本地映射与平台最终校验边界；必填字段、类目属性、SKU/价格/库存、账号权限的真实平台回执仍需 canary。
8. **Finding 信息的本地处理闭环已补齐。** `ReviewFinding` 现在包含 `priority`、`evidence`、`repairSuggestion`、`status` 和处理决策的 actor/reason/time；P0/P1/P2 与 P0 禁止绕过、P1/P2 带理由处理均有服务层/API 测试。剩余缺口是模型辅助审核和真实平台/视觉证据，不是基础 Finding 数据结构。
9. **模型辅助审核未形成受控 finding 流程。** 当前模型主要用于内容生成；未见模型辅助审核输出只能产生 finding、且不能单独批准的专门接口和测试。
10. **平台驳回字段级修正（2026-08-25 已解决）。** 已有原始拒绝码、可读原因、字段错误、发布中心定位入口、不可变子版本修正和重新审核门禁；应用/API/四平台映射/UI contract 及真实运行界面均已验收。

**判定：本地基础完成，生产未完成。** 当前实现是“六类确定性基础预检 + 人工批准门禁”；不能称为真实平台/视觉/模型审核已完成。

## 素材前置门禁专项核对

这是当前需求中最容易被 Skill 文本掩盖的部分，单独列出：

| 检查项 | 现状 | 证据 |
|---|---|---|
| 素材列表 | 已有 `asset.list`，返回工作区素材 | `apps/api/src/server.ts:1633`、`service.ts:784` |
| 素材安全扫描 | 上传后进入 quarantine，扫描 API 存在 | `apps/api/src/server.e2e.test.ts:66-78` |
| 素材解析 | clean 后可调用 `asset.parse`，解析失败会记录 failed | `apps/api/src/server.ts:1634-1650`、`asset-parse.e2e.test.ts:20-32` |
| 权益确认 | 未扫描不能把权益设为 approved | `service.ts:795-806` |
| Skill 前置流程 | 已写入“正式生成前先 asset.list/asset.parse” | `SKILL.md:22` |
| 业务服务强制门禁 | 已实现：`captureTaskInputSnapshot` 在生成前统一校验素材扫描、权益、解析事实、平台/区域/用途和有效期；`generateDraft`、`prepareCodexDraft`、`commitCodexDraft` 均使用冻结快照 | `service.ts:933-1003`、`1295-1359` |
| 素材与任务绑定 | 已实现：任务 `asset_ids` 会进入冻结快照；跨工作区、不 clean、权益未批准、文档未解析/未确认和范围过期均阻断 | `service.ts:941-974`、`service.test.ts:560-625`、`product-image-review.e2e.test.ts` |

结论：素材前置检查已经是服务端不可绕过的生成门禁；剩余是生产扫描器、真实对象存储和 Codex App 附件交互验收，不能把本地 clean/fixture 证据升级为云端安全完成。

## 本次验证命令与结果

执行：

```bash
npm test -- --run \
  packages/application/src/version-vector.test.ts \
  packages/application/src/service.test.ts \
  packages/ai/src/generator.test.ts \
  packages/review/src/review.test.ts \
  apps/api/src/task-answers.e2e.test.ts \
  apps/api/src/asset-parse.e2e.test.ts \
  apps/api/src/server.e2e.test.ts
```

结果：

```text
Test Files  7 passed (7)
Tests       65 passed (65)
```

测试通过表示现有已实现路径没有回归，不表示 PRD 中未覆盖的字段、检查类别和验收场景已经完成。

## 建议的补齐顺序

1. **P0：FR-10 真实审核证据。** 本地六类 checker、P0/P1/P2、证据来源、建议、处理状态和审批门禁已完成；下一步是接入受控模型辅助审核、真实视觉 provider 和平台预检回读，且模型只能产生 finding，不能单独批准。
2. **P0：FR-09 任务快照冻结代码已完成。** 在任务确认时持久化商品/SKU/价格/库存/素材/规则快照；生成只读快照，不读当前商品最新值。剩余为生产 PostgreSQL 重启/恢复证据。
3. **已完成：服务端素材门禁。** 生成前强制校验任务引用素材存在、扫描 clean、权益 approved、适用平台和有效期；剩余为生产扫描/对象存储验收。
4. **已完成：FR-07 动态追问引擎本地闭环。** 已覆盖事实、授权、SKU、价格有效期、素材、每轮最多 4 问和“稍后补充”；剩余为真实宿主交互和授权续期回调验收。
5. **P1：FR-06 解析覆盖与多平台拆分。** 扩展解析 schema，增加快速修正 API、重复任务幂等和跨会话恢复 E2E。
6. **P1：FR-08 方向证据绑定与方案时效字段。** 方向卖点返回事实引用/待确认标记，方案增加活动价和有效期，并补差异质量测试。
7. **P1：FR-09 详情模块与 JSON Schema。** 补齐详情页模块、正式 schema 版本、最多两次自动修复、SKU 冲突拆分和模块级重生成 E2E。
