# 大麦多品多店批量运营架构

状态：REVIEWED — 架构评审通过，可进入实施；生产上线仍受 P0/P1 与真实 canary 门禁  
日期：2026-08-27  
范围：登录与租户、多“品”管理、多平台多店铺、批量商品详情页生产与发布、平台规则、模型中转、上下文与 Token 优化、存储边界。

## 1. 结论先行

1. 当前系统已经有多平台、多店铺、最多 50 项批量商品导入、任务组和批量发布基础，但没有真正的多“品”领域层，也没有从批量选品到批量生成、审核、发布的一体化活动编排。因此“批量商品”只能判定为基础能力已存在，完整产品能力未完成。
2. “品”应定义为工作区内的品牌/业务单元 `BrandUnit`，不是项目、文件夹或店铺。一个用户可加入多个工作区；一个工作区有多个品；品与店铺是多对多关系：一个店铺可以经营多个品，一个品也可以覆盖多个平台、多个店铺。
3. 品名称、定位、规则、结构化商品数据必须以云端 PostgreSQL 为生产事实源；图片、视频、品牌手册等二进制进入私有 S3-compatible 对象存储。Codex App 本地只保留短期缓存，不是权威数据源。
4. Codex/ChatGPT 宿主只负责会话入口和 MCP 编排。所有正式文案、图片、视频、OCR 与审核模型请求必须由服务端经自有中转站发出并计量；插件无法接管 Codex/ChatGPT 自己的宿主模型 Token。
5. 不应让模型读取完整聊天历史。服务端按 `workspace_id + brand_id + product_id + listing_id + task_id` 组装有版本号和预算上限的 Context Envelope，只检索当前任务需要的事实、规则和偏好。

## 2. 当前能力与缺口

### 已有基础

- `platform_accounts` 已按工作区支持多个平台账号/店铺，数据库有强制 RLS。
- 商品已绑定 `platform + platform_account_id`，同一远端商品可按店铺隔离。
- `catalog.import.batch`、`task.group.create`、`publish.batch.*` 已支持最多 50 项及逐项状态、暂停、恢复、失败重试和人工确认。
- 任务和内容版本已经冻结事实版本、规则版本和知识版本，发布有 confirmation hash、幂等键和远端快照。
- 生产对象存储已有隔离区、扫描晋级、SHA-256、KMS、工作区前缀和 fail-closed 约束。
- `model_usage_ledger` 已可按工作区记录 provider request、输入/输出 Token 与成本。

### 关键缺口

- `BrandProfile` 使用固定 ID `brand_${workspaceId}`，实际是一工作区一品牌；产品、素材、任务、平台账号没有稳定 `brand_id` 外键。
- 当前 Product 同时承担“标准商品事实”和“某平台某店铺 listing”两种职责，难以让一个商品复用到多店铺并保持平台字段独立。
- 批量能力是三个分散入口，不存在统一 `BatchContentCampaign`，无法一次查看多个品、多个商品、多个店铺的生成和发布进度。
- 生产知识库仍缺持久化仓储与跨进程恢复证据；平台规则同步、真实 OAuth、支付、云容量、真实模型和真实发布回执仍属于外部门禁。
- Codex bridge 当前进程级绑定一个 workspace，尚未形成面向商家的登录、工作区切换和品切换产品流。
- ChatGPT/Codex 插件不能任意向宿主左侧原生导航插入自定义树；应在插件卡片或独立商家工作台提供品/店铺导航。

## 3. 产品与租户模型

```text
UserIdentity
  └─ WorkspaceMembership ──> Workspace（商户组织/账务与权限边界）
                              ├─ BrandUnit（品）* N
                              │   ├─ BrandProfileRevision
                              │   ├─ BrandAssetBinding
                              │   ├─ BrandStoreBinding ──> PlatformAccount（店铺）
                              │   └─ CanonicalProduct * N
                              │       └─ ProductListing * N ──> PlatformAccount
                              └─ BatchContentCampaign * N
                                  └─ CampaignItem * N
                                      ├─ ContentTask / ContentVersion
                                      ├─ ComplianceReview
                                      └─ PublishJob
```

### 边界定义

- `Workspace`：商户组织、成员权限、钱包、套餐、配额、审计和数据隔离边界。
- `BrandUnit`（品）：用户经营视角的品牌/业务单元，拥有独立品牌资料、知识、素材、规则偏好和店铺绑定。
- `PlatformAccount`（店铺）：某平台的授权账号，凭据仍保存在 Vault/KMS 引用中，不存明文 Token。
- `CanonicalProduct`：平台无关的标准商品事实，例如材质、规格、卖点和品牌归属。
- `ProductListing`：标准商品在某平台某店铺的售卖映射，保存平台类目、标题、远端商品 ID、上下架状态和平台特有字段。
- `BatchContentCampaign`：一次批量运营活动，负责选择范围、冻结上下文、生成、审核和发布编排。

### 关系约束

- 用户与工作区是多对多；角色留在 membership。
- 工作区与品是一对多；所有品级资源同时携带 `workspace_id + brand_id`。
- 品与店铺采用显式多对多绑定表。一个店铺可绑定多个品，一个品可绑定多个平台的多个店铺；每个 listing、任务和发布项都必须显式选择品，禁止只按店铺反推出品。
- 标准商品只属于一个品；同一标准商品可有多个 listing，分别绑定不同平台和店铺。
- 批量活动可跨多个品，但每个 CampaignItem 必须冻结唯一 `brand_id + canonical_product_id + listing_id + platform_account_id`。

### 标准商品与店铺 Listing 字段归属

| 标准商品共享字段 | Listing 独立字段 |
|---|---|
| 品归属、GTIN/货号、基础名称、材质、规格定义、品牌事实、通用卖点证据、通用素材引用 | 平台、店铺账号、远端商品/SKU ID、平台类目、店铺标题、价格、库存、上下架状态、平台属性、店铺差异化、远端 revision |

Listing 可以引用标准商品字段，但不能反向覆盖标准事实。价格、库存、活动和平台标题始终属于 Listing；跨店铺生成必须各自冻结 Listing revision。

## 4. 登录、会话与权限

```text
商家浏览器 / Codex App
  -> OIDC 登录（短信/微信/企业身份可由 IdP 承担）
  -> 平台签发短期会话或 access token
  -> MCP Backend-for-Frontend 进行 token exchange
  -> API 验证 subject、workspace membership、role、active brand
  -> PostgreSQL SET LOCAL app.workspace_id + 强制 RLS
```

- 插件不收集密码，不把长期 access token、平台店铺凭据或模型 Key 放入聊天上下文。
- 登录后返回用户可访问的工作区列表；`active_workspace_id` 与 `active_brand_id` 必须显式可见和可切换。
- 每次工具调用都由服务端从已验证会话解析 workspace，不能信任模型自由填写的 workspace ID。
- 写操作除 RBAC 外再校验 brand/store 绑定；发布操作保留逐项人工确认和 confirmation hash。
- 管理员、运营、审核、财务、平台运维角色沿用现有 workspace role；P0 同时落地 `brand_access_grants`，没有品授权的成员即使能访问工作区也不能读取该品的商品、素材、规则和任务。

## 5. 批量商品详情页与发布

### 用户流程

1. 选择一个或多个品。
2. 从已绑定店铺同步商品，或用 CSV/接口批量导入标准商品。
3. 选择目标 listing；若目标店铺尚无 listing，先创建草稿映射。
4. 创建批量活动并设置目标：详情页、标题、主图、副图、视频、活动文案等。
5. 系统对全部项目做预检：事实完整性、品/店绑定、平台授权、规则新鲜度、素材权益、钱包/额度和预计成本。
6. 按项目异步生成；用户在批次卡片查看成功、待补充、违规、失败和预计费用。
7. 批量审核可选择“仅通过项”，但发布仍逐项保存确认快照；任何商品/规则/远端状态变化都会使旧确认失效。
8. 发布后逐项展示平台回执；未知状态进入对账，不伪装成功。

### 状态机

```text
draft -> preflighting -> ready
      -> blocked
ready -> generating -> review_required -> approved -> publish_prepared
                   \-> partial_failed        \-> changes_requested
publish_prepared -> publishing -> completed
                              \-> partial
                              \-> failed / unknown / manual_attention
任意可恢复状态 <-> paused
```

- 父批次只聚合，不覆盖子项真实状态。
- 单项幂等键建议为 `campaign_id:item_id:operation:input_snapshot_hash`。
- 父批次创建也必须接收幂等键，唯一约束为 `(workspace_id, idempotency_key)`；相同键但 manifest hash 不同返回 `IDEMPOTENCY_KEY_REUSED`。
- V1 沿用 50 项上限；并发由平台、店铺、模型、RPM/TPM 和每日成本上限共同决定，不等于一次并发 50。
- 批量活动冻结 manifest；追加商品产生新 revision，不能静默改变已审核项目。
- `prepare` 必须在同一数据库事务中写入 manifest、父批次、所有子项、任务引用和 outbox；任何一步失败都不得留下“有子任务但无父批次”的半成品。
- 现有“同平台同店铺只能选择一个商品”的重复判定必须移除。重复键改为 `brand_id + listing_id + sku_id + output_kind`；同一店铺多个品、多个商品属于合法批量目标。
- `submitted` 仅表示平台已接收，不能计为 `completed`；只有平台回执 `published` 才计为完成，`unknown` 必须进入对账或人工处理，禁止自动重发。

## 6. 平台规则与违规检查

每个 CampaignItem 的规则选择由服务端确定：

```text
platform + category + brand_id + listing_id + platform_account_id + placement + region + effective_at
  -> deterministic filter
  -> conflict resolver（更具体作用域优先，但下级 allow 不得覆盖上级 block）
  -> immutable RuleSnapshot
  -> generation constraints + post-generation compliance review
```

- 生成前：规则过期、同步失败、严重规则冲突或平台身份不确定时 fail-closed。
- 生成中：只传命中的规则摘要和不可违反条款，不传整个平台规则库。
- 生成后：确定性校验（禁词、长度、必填字段、价格声明）优先；模型审核只处理语义型风险。
- 发布前：重新检查规则版本与远端 listing 快照；版本变化则要求重新审核。
- 定时更新：增量同步、版本化、来源签名/抓取证据、有效期、失败告警、人工发布。任何自动抓取规则未经审核不直接成为生产 blocking 规则。
- 店铺规则以稳定 `platform_account_id` 匹配，`storeName/storeAlias` 只用于展示，绝不能作为权限键或规则主键。
- 冲突裁决固定为：全局/平台 blocking 规则不可被下级 allow 覆盖；同优先级冲突则阻断并交由 `compliance_admin` 发布新规则版本，模型不自行裁决。

## 7. 上下文与 Token 优化

### 核心原则

- 不读取完整 Codex 历史记录作为业务事实源。
- 对话只传资源 ID 和当前意图；服务端组装 `ContextEnvelope`。
- 事实、规则、品资料都按版本冻结；相同输入复用缓存，不重复总结。
- 将编排、检索、确定性校验与高成本生成拆开，能不用大模型的步骤不用。

### Context Envelope

```json
{
  "scope": {"workspace_id":"...","brand_id":"...","product_id":"...","listing_id":"...","task_id":"..."},
  "versions": {"brand":3,"facts":8,"rules":["..."],"preferences":4,"prompt":"v12"},
  "facts": {},
  "brand_compact": {},
  "applicable_rules": [],
  "approved_preferences": [],
  "request_delta": {},
  "budget": {"max_input_tokens":12000,"max_output_tokens":2500},
  "provenance": []
}
```

### 建议输入预算

| 内容 | 比例 | 处理方式 |
|---|---:|---|
| 系统/输出契约 | 10% | 固定模板，版本化 |
| 商品与 SKU 事实 | 22% | 只取所选商品/sku |
| 命中平台规则 | 20% | 确定性筛选后 top-k，不传全库 |
| 品牌摘要 | 12% | 结构化 compact profile |
| 素材解析摘要 | 14% | OCR/文档先解析一次，引用 asset revision |
| 已确认偏好 | 8% | 只取相关且已确认的少量偏好 |
| 当前用户请求 | 4% | 当前 delta，不附完整历史 |
| 安全余量 | 10% | 防止 provider tokenizer 差异 |

超过预算时的裁剪顺序：历史偏好 → 非必要素材摘要 → 低严重度规则说明；商品硬事实、blocking 规则和输出契约绝不裁剪。仍超限则拆分 SKU/页面模块，不做无提示截断。

### 缓存与性能

- 缓存键：`sha256(workspace + brand revision + fact snapshot + listing revision + rule versions + asset revisions + prompt version + output contract)`。
- 缓存只保存脱敏后的上下文片段和生成结果引用，按工作区/品校验权限；敏感凭据永不进入缓存。
- 批量任务先共享品摘要、规则索引和素材解析结果，再对每项 fan-out；避免每个商品重复 OCR 和规则检索。
- 小模型/规则引擎负责意图路由、字段映射、摘要和初筛；文案、视觉、视频按质量要求路由模型。所有模型仍走同一中转站。
- Generation Worker 使用队列、租约、心跳、退避和每平台/每模型限流；前端轮询或订阅状态，不让 Codex 会话长时间阻塞。
- `model_usage_ledger` 增加 `campaign_id/item_id/context_hash/cache_hit/latency_ms`，形成每品、每店、每能力的 Token 和人民币成本报表。
- Context Envelope 不直接内嵌图片、视频或完整 PDF，只包含经过扫描和权益校验的 asset revision、解析摘要和短期读取引用；模型 Key、店铺 Token 永不进入 Envelope。

### 性能目标

- 上下文组装 P95 < 500 ms（不含首次 OCR/外部规则同步）。
- 相同输入二次生成前的上下文重复 Token 降低 ≥ 70%。
- 50 项批次创建与预检 P95 < 3 s，异步返回，不等待模型完成。
- 每个批次可看到预计 Token/费用、实际 Token/费用、缓存命中率和失败退款。

## 8. 存储边界与成本

| 数据 | 生产事实源 | 本地用途 | 备注 |
|---|---|---|---|
| 用户、工作区、品、店铺绑定 | PostgreSQL 云数据库 | 短期只读缓存 | 结构化数据很小，必须跨设备和多人共享 |
| 标准商品、listing、任务、版本、审核、发布状态 | PostgreSQL | 开发 fixture | 必须事务、审计、RLS 和恢复 |
| 品牌简介、语气、禁词、规则摘要 | PostgreSQL | 可缓存 | 版本化、可搜索；长文原件另存对象存储 |
| 图片、视频、PDF、品牌手册、生成成片 | 私有 S3/OSS/COS/MinIO | Codex 临时预览缓存 | 二进制不放数据库，必须扫描、KMS、生命周期 |
| 原始平台/模型凭据 | Vault/KMS/工作负载身份 | 禁止 | 数据库只存 `credential_ref` |
| Context Envelope/摘要缓存 | Redis 或对象/数据库缓存层 | 可选进程缓存 | 有 TTL、版本键和租户校验 |
| 对话历史 | Codex/ChatGPT 宿主 | 宿主管理 | 不是本平台业务事实源，不应全量复制 |

直接回答：新建一个“品”的名称、设置和结构化档案会消耗少量云数据库空间，通常是 KB 级；上传 Logo、图片、视频、手册才消耗明显的云对象存储。生产环境不能只存在用户电脑本地，否则换设备、多人协作、异步任务、定时规则更新和自动发布都会失效。可给套餐设置存储额度、媒体转码额度、保留期和超额加购。

建议按 `workspace/brand/asset` 逻辑隔离；物理对象可用 SHA-256 做去重，但跨工作区去重必须避免通过哈希或计费侧信道泄露他人是否拥有同一文件。下载只发短时 signed URL，原 bucket 永不公开。

## 9. 数据库演进

新增核心表：

- `user_identities(id, issuer, external_subject, ...)`
- `brands(id, workspace_id, name, status, revision, ...)`
- `brand_store_bindings(workspace_id, brand_id, platform_account_id, status, revision, ...)`，唯一键为 `(workspace_id, brand_id, platform_account_id)`
- `brand_access_grants(workspace_id, brand_id, member_id, role, ...)`
- `canonical_products(id, workspace_id, brand_id, facts_version, ...)`
- `product_listings(id, workspace_id, brand_id, canonical_product_id, platform_account_id, platform, remote_product_id, revision, ...)`
- `batch_campaigns(id, workspace_id, revision, state, manifest_hash, ...)`
- `batch_campaign_items(id, workspace_id, campaign_id, brand_id, canonical_product_id, listing_id, task_id, state, input_snapshot_hash, ...)`
- `context_snapshots(id, workspace_id, brand_id, task_id, context_hash, versions, token_estimate, payload_ref, ...)`

所有表强制 RLS；品级表额外校验 `brand_access_grants`。跨表引用使用复合外键。为彻底保证平台与店铺一致，`platform_accounts` 增加唯一键 `(workspace_id, id, platform)`，`product_listings/tasks/publish_jobs/campaign_items` 使用 `(workspace_id, platform_account_id, platform)` 引用它，而不是仅依赖应用层判断。任务、内容版本、发布任务继续保存现有不可变快照，不把历史记录原地覆盖。

### 兼容迁移

1. 为每个现有 workspace 创建一个默认品，迁移现有 `BrandProfile` 为该品的首个 revision。
2. 给现有商品、素材、任务回填默认 `brand_id`；原 Product 暂时作为 listing 兼容视图。
3. 从现有 Product 提取 canonical facts，并按 `platform_account_id + remote_product_id` 创建 listing。
4. 现有店铺与默认品建立首条绑定；如果数据检测到多个品牌名称，则创建待确认的候选品和候选绑定并标记 `needs_brand_review`，未经确认不生成或发布。
5. 双写一段发布周期，核对行数、哈希、孤儿记录和跨品访问拒绝后切读；保留可回滚兼容视图。

## 10. 界面与宿主限制

Codex/ChatGPT 左侧原生导航由宿主控制，插件不能承诺任意插入“品”树。产品应提供两层界面：

- 对话内卡片：当前工作区/品/平台/店铺选择器、功能清单、批次进度、补资料、审核、充值和失败恢复。
- 独立商家工作台：真实左侧导航 `品 → 平台 → 店铺`，主区展示商品、素材、知识、内容、批次和账单。Codex 卡片可深链到对应页面。

新会话不“阅读所有历史记录”，而是调用 `merchant.start` 返回当前范围、最近未完成批次、知识/商品/图片/素材四个入口和安全的下一步建议。

### 不可误选的交互规则

- 所有生成、审核、同步和发布界面顶部固定显示上下文锁定条：`工作区｜品｜平台｜店铺｜已选商品数`。
- 切换品会清空平台、店铺、商品与旧确认；切换平台会清空店铺和商品；切换店铺会清空商品和旧确认。
- 一店多品时先选择品，再展示该店铺属于该品的 Listing；禁止使用“最近一次品”静默推断。
- 批量确认卡展示品数、平台数、店铺数、商品数、规则版本、预计费用和逐项阻断；键盘与屏幕阅读器能读出完整范围。
- 375px 宽度采用按店铺折叠的项目卡，不使用必须横向滚动的宽表；状态同时使用图标、文字和颜色。
- 状态语义统一：绿=完成/可执行，黄=待确认/即将过期，红=阻断/失败，灰=演示/未知，蓝=处理中/外部等待。

## 11. 分阶段交付

### P0：数据隔离与真登录

- 多品表、多对多绑定表、品级授权、平台复合外键、迁移、RLS、服务端会话解析、工作区/品切换。
- 验收：两个用户、两个 workspace、两个品交叉访问全部拒绝；Token/凭据不出现在 MCP 输出与日志。

### P1：标准商品与批量活动

- CanonicalProduct/Listing 拆分、批量活动、预检、异步生成、批次卡片。
- 验收：50 项跨品跨平台活动可创建；单项失败不污染其他项；重试不重复计费或重复任务。
- 验收补充：批次 prepare 中途数据库失败后父子项均不存在；同店多品多商品合法；重复 manifest 返回同一批次，不同 manifest 复用幂等键被拒绝。

### P2：规则与内容闭环

- 按 listing 规则快照、生成前后审核、规则更新告警、逐项批准和批量发布对账。
- 验收：切换店铺会命中不同规则；规则变化使旧确认失效；真实平台 canary 有 published/rejected/unknown 三类证据。

### P3：上下文、成本和体验优化

- Context Envelope、摘要/解析缓存、模型路由、成本预测、存储计量、独立商家工作台。
- 验收：达到第 7 节性能指标；账单可下钻到批次/项目/模型；额度不足在生成前显示充值弹框且支付验签后才入账。

## 12. 非目标与不得误报

- 不承诺修改 ChatGPT/Codex 原生左侧导航。
- 不把本地 fixture、memory storage、模拟支付、模拟平台回执或浏览器替身称为生产完成。
- 不允许用户在插件中填写模型 Key，也不允许正式生成走 Codex 宿主模型绕过平台计量。
- 不在没有平台 OAuth、真实模型、支付验签、云存储 canary 和真实发布回执时宣称已经上线。

## 13. 验收测试矩阵

| 维度 | 必测场景 |
|---|---|
| 租户 | 跨 workspace、跨品、无品授权、停用成员、切换会话 |
| 批量 | 1/50/51 项、重复项、部分事实缺失、暂停恢复、Worker 崩溃、幂等重试 |
| 批次事务 | manifest/父批次/子项/outbox 任一步失败全回滚；submitted、published、unknown 聚合不混淆 |
| 店铺 | 同平台多店、同商品多店、授权过期、店铺改绑、远端状态变化 |
| 规则 | 过期、冲突、同步失败、平台/类目/店铺不同、生成后规则变化 |
| 模型 | 中转未配置、RPM/TPM、成本上限、provider 超时、usage 缺失、缓存命中 |
| 存储 | 隔离区、扫描失败、跨租户 key、signed URL 过期、生命周期、恢复演练 |
| 发布 | 逐项确认、确认哈希失效、部分成功、unknown 对账、重复回调 |
| 体验 | 首次登录、空状态、品/店切换、额度不足充值、批次失败恢复 |
| 可访问性 | 375px、键盘全流程、焦点恢复、屏幕阅读器读出完整品/平台/店铺/商品范围 |

## 14. 证据索引

- `packages/persistence/src/migrations/001_initial.sql`
- `packages/persistence/src/migrations/004_business_entities.sql`
- `packages/persistence/src/migrations/007_multi_account_products.sql`
- `packages/persistence/src/migrations/022_workspace_members.sql`
- `packages/application/src/service.ts`
- `packages/storage/src/object-storage.ts`
- `apps/api/src/server.ts`
- `apps/plugin/mcp/bridge.mjs`
- `docs/object-storage-adapter.md`
- `docs/platform-model-billing-policy.md`
- `docs/fr16-knowledge-context-evidence.md`
- `docs/final-requirement-evidence-audit-2026-08-27.md`

## 15. 决策记录

| 决策 | 当前建议 | 状态 |
|---|---|---|
| “品”的含义 | workspace 内品牌/业务单元 | 已确认 |
| 店铺与品关系 | 多对多：一店多品、一品多平台多店 | 已确认 |
| 批量活动是否允许跨品 | 允许，但每项独立冻结范围与确认 | 已确认 |
| 生产事实源 | PostgreSQL + 私有对象存储，本地仅缓存 | 建议锁定 |
| 正式模型出口 | 平台服务端统一自有中转站 | 已由用户要求锁定 |
| 宿主历史 | 不全量读取，只按 ID 取服务端上下文 | 建议锁定 |

## 16. PM 四视角评审综合

问题分类：Architecture。参与视角：用户代表、系统架构师、怀疑者、务实交付者。

### 共识

1. 当前多平台、多店铺、任务组和批量发布底座应增量复用，不应推倒重写。
2. `BrandProfile` 的工作区单例不能承担多品隔离；“品”必须成为具有 `workspace_id + brand_id` 强约束的一级实体。
3. 批量操作必须在内部拆成逐品、逐平台、逐店铺、逐商品/SKU 子项；父批次只聚合，不能掩盖部分失败和未知状态。
4. 正式业务生成统一走服务端 Relay；PostgreSQL 存结构化事实与审计，对象存储存二进制，本地只用于临时缓存和开发 fixture。
5. Context Manifest/Envelope 必须不可变、可哈希、可缓存、可计量，并有统一 Token 上限和超限拆分策略。

### 关键反对意见及处理

- **不能声称“所有 Codex Token 都由插件中转”。** 插件可以保证文案、图片、OCR、视频、审核等业务调用全部走自有 Relay；Codex/ChatGPT 宿主代理自身的模型调用只能由宿主支持的模型提供商/Responses Relay 配置决定。若商业要求连宿主 Token 也必须纳入自有计费，则应把“宿主 Relay 可验证”设为部署门禁；无法配置的宿主版本不能作为该商业模式的正式入口。
- **品与店铺多对多会增加误选风险。** 不通过限制关系规避，而是要求每个 listing、CampaignItem、规则快照和发布确认都显式携带 `brand_id + platform_account_id`；卡片同时展示品名和店铺名，缺任一范围即阻断。
- **50 项不是并发数。** V1 保留现有限额作为单批 manifest 上限，Worker 依据模型 TPM/RPM、平台限流和成本预算分片执行；后续通过压测提高上限，而不是直接放大。
- **真实外部能力不能由本地测试替代。** OAuth、支付验签、云对象存储、规则来源、Responses Relay、真实模型和真实平台发布都需要各自 canary 证据。

### 综合推荐

采用本文的 BrandUnit + CanonicalProduct + ProductListing + BatchContentCampaign 架构；先完成数据隔离和登录，再交付批量活动，随后锁定规则/发布闭环，最后优化上下文、缓存和成本。迁移采用默认品回填与双写核对，避免一次性重写现有链路。

## 17. gstack 工程评审

初评：CONDITIONAL CLEAR。现有代码可复用，但直接实施原草案会在数据一致性和批次恢复上留下 P0 风险。本文已吸收以下修订，修订后结论为 **PLAN CLEAR FOR IMPLEMENTATION**；这不代表代码已经实现。

### P0 修订

1. 品从工作区级品牌单例升级为领域实体，所有下游资源强制带 `workspace_id + brand_id`。
2. 平台账号、Listing、任务、发布项通过 `(workspace_id, platform_account_id, platform)` 复合外键保证平台一致，不能只靠应用层校验。
3. 批量 `prepare` 使用单事务写入 manifest、父批次、子项、任务引用和 outbox，并给父批次增加幂等键。
4. 删除旧的“同平台同店只能有一个商品”约束，支持同店多品多商品；精确重复由 listing/SKU/output kind 判断。
5. 品级授权、规则快照和素材绑定纳入 P0，防止同 workspace 内串品。

### P1/P2 修订

- 父批次只聚合；`submitted`、`published`、`unknown/manual_attention` 严格区分。
- 规则快照按品、Listing、店铺账号、平台、类目和生效时间冻结，店铺名称不参与权限和主键判断。
- Context Envelope 增加 hash、预算、版本、来源和缓存字段；Relay 用量增加品/Listing/批次/项目归属。
- 对象存储现有隔离、扫描、KMS 和租户前缀继续复用，仅新增品级 asset binding，不再发明第二套文件存储。

### 测试架构

```text
                    真实 canary（少量）
      OAuth / Relay / S3 / 规则源 / 平台 published|rejected|unknown
                              ▲
                    端到端场景测试
       登录→选品→选店→批量预检→生成→审核→发布→对账
                              ▲
                   API / Worker 集成测试
       RLS、事务回滚、outbox、租约、幂等、崩溃恢复、限流
                              ▲
                   领域与契约单元测试
       复合范围、状态机、规则冲突、预算裁剪、缓存键、错误码
```

每个生产声明至少需要一条真实 canary；fixture 只能证明本地协议，不证明外部能力。

## 18. gstack 设计评审

| Pass | 初评 | 目标 | 已写入方案的修订 |
|---|---:|---:|---|
| 信息架构 | 4/10 | 9/10 | 固定 `工作区→品→平台→店铺→商品/批次`，品为一级上下文 |
| 交互状态 | 5/10 | 9/10 | 上下文锁定条、切换清空下游选择、逐项阻断和预计费用 |
| 用户旅程 | 4/10 | 9/10 | 首次四步：建品→绑店→导入商品→批量生成/发布 |
| AI slop | 6/10 | 9/10 | 展示来源/时间/规则版本/真实或预览，禁止无证据的“已发布” |
| 设计系统 | 7/10 | 9/10 | 统一五类状态语义和对话卡/Studio 字段顺序 |
| 响应式/可访问性 | 6/10 | 9/10 | 375px 折叠卡、键盘、焦点返回、文字+图标+颜色 |
| 决策完整度 | 3/10 | 9/10 | 锁定多对多、字段归属、跨品批次、单项重试、入口和规则裁决 |

### 已锁定的设计决策

- 产品名称仍显示“品”，内部模型使用 `BrandUnit` 并预留 `kind=brand|product_line`，无需把用户暴露给技术术语。
- 跨品批次允许混合平台和店铺，但确认页必须按品→平台→店铺分组；失败项允许单独重试。
- 独立商家工作台是管理控制面；Codex/ChatGPT 对话卡片是快捷入口和操作面，两者使用相同资源 ID 深链。
- 品级权限首期落地；规则冲突由确定性引擎阻断，再由合规管理员发布新版本解决。

## 19. gstack DX 评审

当前代码 DX：5.8/10；目标架构落实后的交付门槛：8.5/10 以上。

### Persona

- 插件开发者：需要 5 分钟内在本地完成一次只读健康检查和一次不发布的内容预览。
- 平台运营：不接触内部 ID，也能完成建品、绑定店铺、查看规则/费用和恢复失败批次。
- 集成工程师：使用类型化契约、稳定错误和环境 preflight 接入 Relay、OAuth、对象存储及平台连接器。

### 黄金路径与工具收敛

现有约 158 个 MCP 工具不适合作为用户第一层菜单。首层只暴露 5 条黄金路径，其余按卡片下一步渐进展示：

1. `merchant.start`：身份、当前工作区/品、未完成批次与四个内容入口。
2. `workspace.health`：数据库、对象存储、Relay、规则、OAuth、支付和平台 readiness。
3. `catalog.search`：在已锁定品/平台/店铺范围内选商品。
4. `task.request.create`：创建单项或批量活动，返回预检而非立即发布。
5. `publish.batch.prepare`：展示不可变 manifest 和逐项确认信息。

所有错误统一返回：`code、http_status、message、retryable、next_action、doc_url、scope`。内部堆栈、凭据和模型 Key 不返回。

### TTHW 与测量

| Persona | 当前估计 | 目标 |
|---|---:|---:|
| 插件开发者本地 hello world | 10–20 分钟 | ≤5 分钟 |
| 平台运营首次商品预览 | 20–30 分钟且流程不完整 | ≤10 分钟 |
| 集成工程师首个生产 preflight | 1–2 小时 | ≤30 分钟 |

埋点覆盖安装、登录、建品、绑店、导入、首个预览、首个批次、首个发布和恢复；按 persona 统计 TTHW、错误一次修复率、文档跳转率和放弃点。README 按三类 persona 提供可复制流程，迁移文档包含回填、双写、核对和回滚命令。

## 20. 实施任务

- [ ] **T1（P0）— 多品领域与迁移**：新增 BrandUnit、BrandStoreBinding、BrandAccessGrant、CanonicalProduct、ProductListing，默认品回填、双写、核对和回滚。
- [ ] **T2（P0）— 数据库强约束**：为平台账号建立 workspace/account/platform 复合唯一键，下游复合外键和 RLS 跨品拒绝。
- [ ] **T3（P0）— 登录和活动范围**：服务端会话解析 active workspace/brand，MCP 不信任模型提供的租户范围。
- [ ] **T4（P0）— 原子批次**：实现 manifest + campaign + items + task refs + outbox 单事务、父批次幂等和崩溃恢复。
- [ ] **T5（P0）— 一店多品交互**：上下文锁定条、逐级清空、按品/平台/店分组确认和可访问性测试。
- [ ] **T6（P1）— 规则快照**：稳定账号 ID 匹配、版本冲突、过期阻断、更新告警和发布前再校验。
- [ ] **T7（P1）— Context Envelope**：Token 预算、确定性裁剪、分片、内容寻址缓存和来源审计。
- [ ] **T8（P1）— Relay 成本归属**：五模态调用记录品、Listing、CampaignItem、context hash、缓存命中、延迟和费用。
- [ ] **T9（P1）— 黄金路径与错误契约**：收敛首层能力卡，统一 typed error/next action/doc link。
- [ ] **T10（P1）— 生产 canary**：分别验证 Responses Relay、业务 Relay、OAuth、规则源、S3、支付和真实平台回执。
- [ ] **T11（P2）— DX 教程和迁移工具**：三 persona README、可复制请求、环境 preflight、迁移检查器和回滚演练。
- [ ] **T12（P2）— SLO/容量与商业计量**：50 项批次 P95、Token 降幅、存储配额、生命周期、超额加购和失败退款报表。

## 21. 目标需求覆盖审计

| 明确需求 | 架构证据 | 结论 |
|---|---|---|
| 一用户多品 | WorkspaceMembership + BrandUnit + BrandAccessGrant | 已设计 |
| 一店多品、一品多平台多店 | BrandStoreBinding 多对多，Listing 显式 brand/account | 已按用户确认锁定 |
| 多个品/商品批量详情页并上传店铺 | BatchContentCampaign + Item 状态机 + 原子 manifest + 逐项发布 | 已设计；代码待实施 |
| 按当前平台/店铺规则检查违规并定时更新 | Listing/brand/account/category 规则快照、更新和发布前再校验 | 已设计；真实规则源待 canary |
| 正式模型走自有中转站 | 业务五模态服务端 Relay fail-closed；宿主 Responses Relay 单独门禁 | 边界已明确 |
| 上下文过长、Token 高、运行慢 | Context Envelope、预算、top-k、摘要缓存、fan-out、异步队列和指标 | 已设计并有量化目标 |
| 品录入存云端还是本地 | 结构化品数据进 PostgreSQL；媒体进私有对象存储；本地仅临时缓存/fixture | 已明确 |
| gstack/PM 多轮讨论 | 四视角 council + CEO + Eng + Design + DX 评审 | 已完成架构轮次 |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---:|---:|---|---|
| CEO Review | `/plan-ceo-review` | 范围与商业价值 | 1 | CLEAR | 核心关系已由用户确认：品与店铺多对多 |
| Codex Council | `/another-perspective` | 四视角压力测试 | 1 | CLEAR | 5 项共识、4 项反对意见已吸收 |
| Eng Review | `/plan-eng-review` | 架构与测试 | 1 | CLEAR (PLAN) | 3 个 P0 风险、6 项修订及测试金字塔已纳入 |
| Design Review | `/plan-design-review` | 信息架构与交互 | 1 | CLEAR (PLAN) | 7-pass 从 3–7/10 修订到目标 9/10 |
| DX Review | `/plan-devex-review` | 接入与可运营性 | 1 | CLEAR WITH DELIVERY GATES | 当前 5.8/10，已定义黄金路径、TTHW 和实施门槛 |

**CROSS-MODEL:** 多视角与三轮专业评审共同确认“多品一级隔离 + 品店多对多 + 子项级批处理 + 云端事实源 + 服务端业务 Relay”；平台复合外键、批次事务、不可误选 UI 和 DX 黄金路径已由反对意见转为实施门禁。

**VERDICT:** CEO + COUNCIL + ENG PLAN + DESIGN PLAN + DX PLAN CLEARED — 架构可进入实施；真实生产能力仍必须通过 P0/P1 与外部 canary，不能据此宣称代码已完成。

NO UNRESOLVED DECISIONS
