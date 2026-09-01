<!-- AUTOPLAN_RESTORE: /Users/lixiaomei/.gstack/projects/codexSkills/autoplan-restore/20260827-architecture-data-continuity-plan.md | sha256 187410af2ea2f9b08e633baaf4a68854ff8bf6bd98be82c1f9c0271521f11695 -->

# 大麦统一架构、上下文成本与数据连续性计划

状态：路线 B 已于 2026-08-28 批准；设计、工程与开发体验评审完成，进入分阶段实施  
日期：2026-08-27（2026-08-28 更新）  
范围：Codex/ChatGPT 插件、API、运营后台、数据库、对象存储、模型中转、平台连接器、批量运营和上线验收。

## 1. 用户结果

电商卖家不需要理解模型、提示词或平台接口。登录后选择“工作区 → 品 → 平台 → 店铺 → 商品”，即可批量完成商品事实同步、标题/详情/主副图/视频生成、平台规则检查、审核和发布；每一步有费用、状态、证据和失败恢复，并能跨设备、跨成员、跨进程继续。

这不是“做更多生成工具”。核心产品是一个可信的多品多店运营控制面：同一份商品事实被多个店铺 Listing 安全复用，平台差异独立保存，模型只读取当前任务所需上下文，所有正式数据有唯一云端事实源。

## 2. 当前事实审计

### 已有且应复用

- `039_multi_brand_batch.sql` 已建立 `brands`、品店绑定、品权限、标准商品、Listing、批次、批次项和上下文快照表，并强制 workspace RLS。
- `PostgresBrandUnitRepository` 已覆盖品、绑定、标准商品、Listing 和批次基础读写；生产无 `DATABASE_URL` 时 API 拒绝启动。
- `ObjectStoragePort` 已区分 quarantine/clean，生产 S3-compatible 配置缺失时 fail-closed。
- 模型请求已有中转站门禁、五模态路由和 `model_usage_ledger`，倍率由运营后台控制。
- 运营台已完成多页面组件化；插件已有品、Listing、批次 MCP 入口和上下文卡片资源。
- 现有任务、内容版本、审核、发布任务、确认哈希和 outbox 可继续作为生成与发布执行层。

### 已证实的数据断链

| 断链 | 当前证据 | 用户影响 |
|---|---|---|
| 品权限未执行 | 已有 `brand_access_grants` 仓储查询、MCP/HTTP 品级访问门禁和 workspace-scoped brand navigation | 仍需真实 PostgreSQL/RLS 与多角色运行证据 |
| 成员校验默认放行 | `enforceActiveWorkspaceMember` 已对严格认证主体强制 active membership；品牌资料 HTTP 也复用该门禁 | 仍需正式 OIDC 身份网关证据 |
| 上下文快照未落地 | `ContextSnapshotRepository`、`context_blobs/context_snapshot_links`、`contextSnapshotSink` 已接入生成准备链 | 仍需真实重启恢复和跨副本运行证据 |
| 上下文无预算与检索 | `prepareGenerationContext` 已执行硬预算；知识上下文通过 `buildBoundedKnowledgeGenerationContext` 限制硬规则、软规则和学习建议 | 仍需真实大数据量压测和模型窗口证据 |
| 批次项未持久化 | `PostgresBrandUnitRepository.createCampaign/updateCampaignTasks/updateCampaignProgress` 已逐项写入 `batch_campaign_items`，批次生成按持久化 item 恢复 | 仍需真实多副本并发和故障恢复证据 |
| manifest hash 无效 | 创建批次固定写入 `"0".repeat(64)` | 幂等不能证明同一意图，确认快照不可信 |
| 批次生成残留本地状态 | 当前批次生成使用持久化 campaign item 与确定性 task ID；未发现 `campaignGeneratedTasks` 进程 Map | 仍需跨实例演练确认 |
| 新旧商品模型并行 | 旧 `Product` 与 `CanonicalProduct/ProductListing` 尚未完成双写、回填和切读 | 商品事实、Listing 与任务可能出现孤儿或错配 |
| 品没有贯穿任务资产 | 任务只在 answers 中可选带 `brand_id`；资产、规则查询多以 workspace 为边界 | 一工作区多品时知识、素材和规则可能串品 |
| 知识库仍是进程模块 | `KnowledgeModule` 的生产持久化与恢复仍被文档列为未完成 | 规则和学习建议跨进程不连续 |
| 实际模型费用未结算到钱包 | `debitPluginWallet` 未传金额时固定预扣 1 分；中转回执的 `cost × multiplier` 只写 `model_usage_ledger`，未发现按回执补扣/退差额并关联 `action_ledger` 的结算闭环 | 用户钱包余额、运营收入和中转站真实成本可能长期不一致 |
| 对象写入缺少失败补偿 | 素材先 `putQuarantine`，之后才写业务快照；快照或事件写入失败时 catch 只删除进程内资产，没有删除已上传对象 | 数据库失败会遗留无业务引用的隔离区对象并持续占用云存储 |
| 审计文档不新鲜 | 多份“最终审计”记录互相矛盾的测试数和完成结论 | 团队无法据文档判断真实上线状态 |

### 2026-08-31 当前复核结果

本次使用 CodeGraph 对上述断链重新反查。品牌权限、成员门禁、上下文快照、上下文预算、批次明细持久化和批次生成恢复均已找到真实 application/API/persistence 调用链，不能再按“没有代码”描述；对应代码仍需按发布门禁补齐真实 PostgreSQL/RLS、多副本、重启恢复和大数据量压测证据。图片回调补偿与品牌资料 HTTP 权限的最新实现记录分别见：

- [`image-generation-api-callback-lease-review-2026-08-31.md`](../architecture/image-generation-api-callback-lease-review-2026-08-31.md)
- [`brand-management-prd.md`](../brand/brand-management-prd.md)

本轮定向验证：上下文/品牌单元/应用服务测试 125 项通过、1 项跳过；设置 `PERSISTENCE_RELEASE_DATABASE_URL` 后，知识 hydration 079 release 和设置 `PLATFORM_MEDIA_SPEC_DATABASE_URL` 后，批次生命周期跨 repository 实例测试均通过。CodeGraph 当前为 773 files / 10,771 nodes / 40,227 edges。

本文件继续保留在 `doc/todo/data`，因为它还包含 canonical 双模型切读、真实模型成本、对象存储联合恢复和外部平台等未闭合项；不能因部分断链已落地而整体迁移。

## 3. 目标领域模型

```text
UserIdentity
  └─ WorkspaceMembership(role)
      └─ Workspace  ← 权限、钱包、套餐、审计、RLS 边界
          ├─ BrandUnit（品）
          │   ├─ BrandAccessGrant
          │   ├─ BrandProfileRevision
          │   ├─ BrandAssetBinding ──> AssetRevision ──> ObjectStorage
          │   ├─ BrandRuleBinding ──> RuleVersion
          │   ├─ BrandStoreBinding ──> PlatformAccount（店铺）
          │   └─ CanonicalProduct（标准事实）
          │       └─ ProductListing（平台+店铺差异）
          └─ BatchCampaign
              └─ CampaignItem
                  ├─ ContextSnapshot
                  ├─ ContentTask / ContentVersion
                  ├─ VisualJob / VideoJob
                  ├─ ComplianceReview
                  ├─ UsageLedger
                  └─ PublishJob / PlatformReceipt
```

### 不变量

1. 所有品级资源必须同时携带 `workspace_id + brand_id`；只传 workspace 不足以读取品数据。
2. 所有店铺操作必须携带稳定 `platform + platform_account_id`；店名和别名只用于展示。
3. 一个标准商品属于一个品；一个标准商品可映射多个 Listing；价格、库存、平台标题只属于 Listing。
4. 每个 CampaignItem 冻结唯一的品、标准商品、Listing、店铺、规则、素材和事实版本。
5. 生产结构化事实只在 PostgreSQL；二进制只在私有对象存储；浏览器、本地文件和进程 Map 只能作为缓存或测试替身。
6. 所有正式模型调用只由服务端经自有中转站发出；Codex/ChatGPT 宿主自身 Token 无法由插件接管，必须与业务模型费用分开说明。
7. 生产成员授权默认拒绝：认证主体必须存在 active membership，且成员角色不得超出身份网关 grant。
8. 每次模型调用必须以同一 `action_id` 串起预授权、模型用量、最终结算和退款；缺成本回执时不得把正式结果标记为已结算。
9. 对象存储与资产快照必须采用可恢复工作流：数据库失败立即补偿删除，补偿失败进入 orphan queue 并由定时扫描清理。

## 4. 三种实施路线

### 路线 A：补洞式最小改动

- 直接为现有仓储补 `batch_campaign_items` 和 `context_snapshots` 写入。
- 删除批次本地 Map fallback；生成前校验品权限。
- 保留旧 Product 为主要任务事实源，CanonicalProduct 只做映射。
- 人类投入：约 4–7 天；Codex：约 1 天。
- 优点：改动小，能最快消除最危险的数据丢失。
- 缺点：新旧商品双模型长期并存，后续每个能力都要同时理解两套语义。
- 完整度：6/10。

### 路线 B：渐进式统一切换（推荐）

- 建立统一 repository/application service，所有品、Listing、批次、上下文和权限经过同一事务边界。
- 用迁移 043+（本文最初编写时为 042；当前迁移基线为 081）完成默认品回填、旧 Product→CanonicalProduct/Listing 映射、品级资产/规则绑定和 model usage 关联。恢复、升级或发布验收必须以 `packages/persistence/src/migrations` 的实际 checksum 清单为准，并执行 migration integrity release test。
- 双写并做一致性校验，随后按工作区 feature flag 切读；稳定后移除旧路径。
- ContextEnvelope 先服务批次，再接单商品生成；二进制永不进模型上下文。
- 人类投入：约 2–4 周；Codex：约 3–5 天。
- 优点：保留现有可用能力，同时获得明确迁移和回滚路径；最终只有一个事实模型。
- 缺点：双写期需要严密的一致性监控和回滚工具。
- 完整度：9/10。

### 路线 C：一次性重写运营核心

- 新建独立 Brand/Catalog/Campaign/Context 服务，插件和运营台全部切新 API。
- 旧 MerchantService 仅作为兼容层，短期内整体迁移。
- 人类投入：约 6–10 周；Codex：约 2–3 周。
- 优点：边界最干净，长期架构最直接。
- 缺点：迁移爆炸半径大；现有支付、审核、发布、连接器和测试资产大量重接，无法证明一次切换更安全。
- 完整度：10/10，但交付风险最高。

## 5. 推荐原则

推荐路线 B。路线 A 只能把数据丢失变成技术债；路线 C 会把已经可复用的审核、计费和发布能力一起重写。路线 B 允许先把事实源、权限、批次事务和上下文成本收敛，再逐工作区切换，不需要伪造生产完成。

用户已于 2026-08-28 明确选择路线 B。实施以“先建安全边界和统一事实层，再双写、校验、切读”为顺序；不做一次性重写。

## 6. ContextEnvelope 与 Token 预算

```text
会话请求（只含 active IDs + 当前意图）
  -> ScopeAuthorizer(workspace, brand, store, product, listing)
  -> ContextAssembler
       ├─ ProductFactSnapshot
       ├─ ListingSnapshot
       ├─ BrandCompactProfile
       ├─ ApplicableRuleSnapshot
       ├─ ApprovedAssetSummaries
       └─ ConfirmedPreferenceDelta
  -> TokenBudgeter（硬事实和 blocking 规则不可裁剪）
  -> ContextBlob(hash + envelope + token estimate)
  -> ContextSnapshotLink(item/task + versions + hash)
  -> Relay Model
  -> UsageLedger(context_hash + cache_hit + cost)
```

### 成本控制

- 不读取完整聊天历史；新会话只恢复 active scope、最近未完成批次和资源 ID。
- MCP 默认返回摘要、计数、状态和资源句柄；明细使用分页工具或 `resources/read` 按需读取。
- 同一 `context_hash` 复用品摘要、规则筛选和素材 OCR；批次中同品、同规则版本只计算一次。
- 内容去重与业务审计分表：`context_blobs` 按 hash 去重，`context_snapshot_links` 为每个批次项/任务保留独立引用与版本证据。
- 输入预算默认 12k、输出预算默认 2.5k；超限按“低相关偏好→非必要素材摘要→低严重规则说明”裁剪，硬事实和 blocking 规则不裁剪。
- 模型调用异步化；Codex 会话只轮询批次摘要，避免长连接和重复上下文。
- 用量账本记录 `brand_id/campaign_id/item_id/context_hash/cache_hit/latency_ms`，运营后台只展示用户应付和消耗，不展示内部倍率。
- 结构化输出修复不再把上一份完整响应无限叠加；仅发送校验错误、受限长度的问题字段和固定 schema，设置单请求累计 Token 上限。
- 钱包采用“最大费用预授权 → 中转回执实际费用 × 后台倍率结算 → 释放差额”；没有 `provider_request_id + action_id + cost` 的调用进入待对账，不得静默按 1 分结算。

## 7. 存储边界

| 数据 | 生产事实源 | 本地允许用途 |
|---|---|---|
| 用户、工作区、品、店铺绑定、标准商品、Listing | PostgreSQL | fixture、短期缓存 |
| 任务、内容版本、规则快照、审核、批次、发布回执、账本 | PostgreSQL | 测试替身 |
| Logo、图片、视频、PDF、品牌手册、生成成片 | 私有 S3/OSS/COS/MinIO | 上传临时文件、预览缓存 |
| OCR、文档解析、品 compact profile、ContextEnvelope | PostgreSQL/Redis/对象存储引用 | 有 TTL 的进程缓存 |
| 店铺凭据、模型 Key、支付密钥 | Vault/KMS/工作负载身份 | 禁止落本地或聊天 |
| 对话历史 | Codex/ChatGPT 宿主 | 不是业务事实源，不全量复制 |

录入一个“品”的名称、定位和结构化资料只消耗少量云数据库空间，通常为 KB 级。真正占用云存储的是图片、视频和文档；生产不能只存在用户电脑本地，否则跨设备、多人协作、异步任务和定时运营都会失效。

## 8. 数据连续性验收

### 必须通过的主流程

```text
登录 -> 选择工作区 -> 创建品 -> 绑定两平台四店
 -> 导入/同步标准商品 -> 创建多 Listing
 -> 上传素材并扫描/确认权益
 -> 创建 50 项批次 -> 冻结上下文与预计费用
 -> 生成文案/主副图/视频 -> 平台规则审核
 -> 人工确认 -> 分店发布 -> 回执/对账/失败重试
 -> 运营台查看成本、状态、证据与审计
```

### 反向与故障验收

- 跨 workspace、跨品、未绑定店铺、错 Listing 全部拒绝。
- API/Worker 重启后品、批次项、上下文、费用和任务关系不丢失。
- 同幂等键同 manifest 返回原批次；同键不同 manifest 返回明确冲突。
- 50 项中注入模型超时、平台 429、拒绝、unknown、Worker 重启：成功项不重复，失败项可单独重试，unknown 不自动重发。
- 对象仍在 quarantine、权益未知或规则过期时生成/发布 fail-closed。
- 中转站不可用、成本回执缺失或钱包不足时不产生未计费正式结果。
- 认证主体无 active membership、跨品 grant 缺失或身份网关角色与成员角色冲突时均返回 403。
- 注入对象写入成功、数据库快照失败：对象必须被同步补偿删除；再注入删除失败时必须进入 orphan queue 并由扫描任务清理。
- 模型回执 0.013 元、倍率 2.5 时，最终用户费用、钱包流水、action ledger 和 model usage ledger 必须一致（按统一分币/微元舍入策略）；重复回执不得重复扣款。
- 文档中的测试数由机器生成的单一 evidence manifest 更新，禁止手写多个“最终数字”。

## 9. 上线门禁

本地代码完成不等于生产完成。真实 relay、六平台 OAuth/API/媒体回执、支付 provider、云数据库/Redis/对象存储、OIDC、OTel/告警、容量和恢复演练必须分别提供带 release ID、环境、时间和核验人的证据。

## 10. 已确认决策

1. 采用路线 B“渐进式统一切换”作为实施基线。
2. 父批次允许跨多个品，但每个 CampaignItem 必须独立冻结品、商品、Listing、店铺、规则、计费和审计范围。
3. 品级权限首版即强制；没有有效 grant 时默认拒绝，workspace owner 可通过明确策略获得全品访问，而不是隐式放行。
4. 生产结构化数据统一存 PostgreSQL，图片/视频/文档存私有对象存储；本地只作临时缓存和 fixture。
5. 用户端只显示应付金额、额度和账单，不展示中转成本、内部倍率或渠道密钥；倍率只在运营后台按权限配置。

## 11. 设计评审

### 信息架构

主导航采用“双层结构”，避免把领域入口和商家范围混在同一棵树中：

```text
范围选择器：工作区
  └─ 品
      └─ 平台
          └─ 店铺

领域导航：概览 / 商品与素材 / 批量任务 / 发布 / 规则 / 账务
```

- 左侧范围树是所有页面的统一过滤上下文；切换品、平台或店铺必须清空不兼容的商品/Listing 选择。
- 店铺不直接挂在工作区下，必须通过 BrandStoreBinding 显示其所属品；同一店铺可绑定多个品时按品分别出现。
- 商家端与运营后台共用范围语义和状态词，但保持独立页面与权限，不把运营后台嵌成一个超长页面。
- Merchant Studio 当前 `App.tsx` 约千行且只有页面级状态切换，应拆为路由、页面、领域 hooks、范围上下文和通用状态组件。

### 七维评分与改进目标

| 维度 | 当前 | 路线 B 目标 | 关键动作 |
|---|---:|---:|---|
| 信息架构 | 5/10 | 9/10 | 增加工作区→品→平台→店铺范围树，领域页面改真实路由 |
| 视觉层级 | 6/10 | 8/10 | 统一 Merchant Studio 设计令牌，减少首页卡片堆叠，强化主任务与阻断状态 |
| 交互与反馈 | 6/10 | 9/10 | 所有异步操作提供受理、进行中、部分成功、失败重试和最终回执 |
| 状态完整性 | 5/10 | 9/10 | 对范围树、绑定、同步、生成、审核、发布、支付补齐五态 |
| 响应式 | 6/10 | 8/10 | 桌面常驻树；窄屏抽屉；批次表转摘要列表，保留 44px 触控目标 |
| 可访问性 | 6/10 | 9/10 | 树形键盘导航、焦点恢复、aria-live、对比度和 reduced-motion |
| 一致性 | 5/10 | 9/10 | 商家端和运营台共享 token、术语、状态机和组件契约 |

### 必须覆盖的界面状态

| 能力 | 加载 | 空态 | 错误 | 成功 | 部分成功/恢复 |
|---|---|---|---|---|---|
| 品/店范围树 | 骨架树 | 引导创建品 | 重试并保留旧范围 | 显示计数与连接状态 | 某平台不可用时只禁用对应分支 |
| 店铺绑定 | 授权跳转中 | 选择平台 | OAuth 失败及错误码 | 已绑定并显示账号 | token 过期可重新授权 |
| 商品/Listing | 同步进度 | 导入商品 | 字段映射错误 | 事实与 Listing 分层展示 | 失败商品单独重试 |
| 批量生成 | 预估费用 | 选择商品 | 钱包/模型/规则阻断 | 批次完成 | 成功项不重跑，失败项可筛选重试 |
| 图片/视频 | 排队/生成 | 上传参考素材 | 权益/安全/模型失败 | 版本可审核 | 单素材失败不拖垮整批 |
| 发布 | 平台受理中 | 无已批准版本 | 429/拒绝/unknown | 平台最终回执 | unknown 先对账，不自动重发 |
| 充值 | 创建订单 | 无账单 | 支付取消/失败 | 到账且流水可追溯 | 回调延迟显示“确认中” |

### 核心旅程

```text
选择品与店铺
  → 同步/创建标准商品
  → 为不同店铺建立 Listing
  → 选择批量能力和平台规则
  → 冻结上下文、规则版本与预估费用
  → 生成并逐项审核
  → 人工确认发布
  → 查看平台回执、成本与失败恢复
```

设计评审没有发现需要推翻路线 B 的 User Challenge；真正需要挑战的是“先做更多页面就等于功能可用”的假设，界面必须由统一数据链和状态机驱动。

## 12. 工程评审

### 执行架构

```text
Codex Plugin / Merchant Studio / Ops Console
                    │
             Scope Application API
                    │
  ┌─────────────────┼──────────────────┐
  │                 │                  │
Authorization   Catalog/Campaign   Billing/Context
  │                 │                  │
PostgreSQL      PostgreSQL+Outbox   Relay+Usage Ledger
  │                 │                  │
  └────── Object Storage ── Workers ───┘
                         │
                Platform Connectors
```

### 置信度排序的问题

| 置信度 | 问题 | 处理 |
|---:|---|---|
| 99% | 无成员记录时生产成员校验继续放行 | fail-closed，并补 owner bootstrap/迁移路径 |
| 99% | 品权限表未进入运行时授权 | 增加 BrandScopeAuthorizer，所有品级 repository/API 强制调用 |
| 99% | 批次项、上下文快照未成为运行时事实 | repository 事务写入 Campaign + Items + ContextSnapshot |
| 99% | manifest 固定全零且生成残留进程 Map | canonical manifest hash；数据库状态替代 Map |
| 98% | 模型用量只记账、不按真实回执结算钱包 | 预授权、最终结算、差额释放、重复回执幂等 |
| 98% | 上下文全量读取并在修复重试中叠加完整输出 | ContextEnvelope、预算器、摘要缓存和受限修复协议 |
| 97% | 对象写成功后数据库失败会留下孤儿 | compensation delete + orphan queue + 定时清理 |
| 95% | 旧 Product 与 CanonicalProduct/Listing 双模型断链 | 默认品回填、映射、双写校验、feature flag 切读 |
| 92% | 新仓储测试多为 SQL mock，缺真实 PostgreSQL 主链验收 | Testcontainers/本地 PostgreSQL 集成与重启一致性测试 |

另外三项数据库级约束必须在首次切读前完成：Task 增加 `campaign_item_id/canonical_product_id/listing_id` 并用组合外键保证同一商品链；旧 Product→CanonicalProduct 映射改为唯一且可记录冲突；旧远端商品唯一键补上 `platform_account_id` 店铺维度。

### 渐进迁移顺序

1. 安全门禁：成员 fail-closed、品授权、统一 scope 校验和审计。
2. 一致性门禁：对象补偿、orphan queue、真实 manifest、CampaignItem 持久化，删除进程 Map 事实。
3. 计费闭环：action_id 贯穿预授权、relay usage、结算、退款和对账。
4. 上下文层：ContextAssembler、TokenBudgeter、ContextSnapshot 和 hash cache，先接批次生成。
5. 商品统一：为旧 Product 回填默认品与 CanonicalProduct/Listing，开启双写一致性报告。
6. 逐工作区切读：先内部 fixture，再测试租户，再灰度生产；异常时只切回读路径，保留新写入数据。
7. UI 与插件切新聚合 API，最后移除兼容 Map、旧读路径和手写演示数据。

### 回滚原则

- 每一步迁移均为 expand → backfill → dual-write → verify → switch-read → contract；数据库 contract 不与首次切读同版本发布。
- feature flag 以 workspace 为粒度；回滚只关闭新读路径，不删除新表或新账本。
- 计费回执和发布请求以稳定幂等键重放；任何 unknown 状态必须先查询外部结果。
- 对象删除失败只进入可审计 orphan queue，不用不可恢复的批量删除作为回滚手段。

### 测试覆盖图

```text
Scope/auth ─┬─ unit: role/grant matrix
            └─ integration: RLS + no-member + cross-brand
Catalog ────┬─ unit: mapping/manifest
            └─ integration: Product→Canonical→Listing dual-write
Campaign ───┬─ unit: state/idempotency
            └─ restart: 50 items + partial failure + resume
Context ────┬─ unit: budget/truncation/hash
            └─ integration: snapshot replay + cache hit + bounded retry
Billing ────┬─ unit: rounding/multiplier
            └─ integration: reserve→usage→settle/refund + duplicate receipt
Storage ────┬─ unit: object key/digest
            └─ fault: put success→DB fail→delete fail→orphan cleanup
Publish ────┬─ contract: six platform profiles
            └─ canary: accepted/rejected/429/unknown/reconcile
UI/Plugin ──┬─ component: five states + keyboard
            └─ browser: complete merchant journey and ops reconciliation
```

工程评审不构成对路线 B 的 User Challenge；但要求把“真实 PostgreSQL、对象存储故障注入和计费回执幂等”列为切读前硬门禁。

## 13. 开发体验评审

主要开发者画像是负责 API、连接器、计费和插件能力的全栈/平台工程师；次要画像是新增平台连接器或模型渠道的集成工程师。

独立评审当前综合成熟度为 5.3/10：错误契约和连接器边界较成熟，但首次成功时间、配置面、MCP 工具发现和巨型文件显著拖慢开发。当前约 169 个 MCP 工具不应同时作为商家默认入口；黄金路径应收敛到约 8 个高层入口，底层工具按角色、范围和能力动态暴露。

| 维度 | 当前问题 | 改进 |
|---|---|---|
| 首次成功时间 | README 快速开始能启动 API，但完整链路需手工理解多个环境变量和 fixture 开关 | 增加 `npm run dev:stack`、种子工作区和一条端到端 smoke，目标 10 分钟内看到首个批次 |
| 概念模型 | Product、CanonicalProduct、Listing、Task、Campaign 的关系分散 | 以本文件领域图为唯一术语源，README 只链接，不重复定义 |
| 配置 | relay、数据库、Redis、对象存储、OIDC、支付配置分散 | 提供分环境 schema 校验和 `.env.example`，启动时一次性报告缺项 |
| API 发现 | MCP 方法很多，用户和开发者都不知从何开始 | `merchant.start` 返回能力卡片、当前范围、阻断项和下一步；详细结果分页 |
| 错误处理 | 底层错误有代码但恢复动作不统一 | 统一 `{code,message,retryable,next_actions,trace_id}` 契约 |
| 测试 | 测试脚本丰富但没有一条统一证据清单 | `npm run verify:release` 生成 evidence manifest，记录跳过原因和环境 |
| 扩展连接器 | 平台规则、能力和认证分散 | ConnectorDefinition 同时声明认证、读写能力、规则源、字段映射和 canary |
| 调试与性能 | 长上下文和 server.ts 巨型路由让定位慢 | application service 分域、结构化 trace、context/token 指标和慢调用样本 |

当前 `.env.example` 约 171 项，必须由类型化配置 schema 生成并拆成 local-fixture、integration、production 三个 profile；启动时一次性列出全部缺失项。`server.ts`、MCP bridge 和运营台状态 Hook 是首批组件化对象，但仍保持当前单体部署，不提前拆微服务。

DX 评审自动决策：保持 npm workspace 与现有包边界，不在本轮迁移构建微服务；先把 `apps/api/src/server.ts` 的领域处理器拆到 application services，再依据运行指标决定服务拆分。

## 14. 分阶段交付与门禁

### Phase 0：基线与可观测性

- 生成当前 schema、API、测试和能力 evidence manifest。
- 为 scope、campaign、context、billing、storage 建立 trace_id/action_id。
- 门禁：现有单测、构建、商家端和运营台 smoke 全绿。

### Phase 1：安全与一致性

- 成员 fail-closed、品授权、CampaignItem、真实 manifest、对象补偿/orphan queue。
- 门禁：跨租户/跨品攻击矩阵、重启恢复、对象故障注入全部通过。

### Phase 2：计费与上下文

- 真实成本结算、Token 预算、ContextSnapshot、缓存和有界修复重试。
- 门禁：重复回执不重复扣费；同上下文 cache hit；超预算请求可解释裁剪或阻断。

### Phase 3：统一商品链与前端范围树

- 默认品回填、双写、切读开关、商家端组件化与工作区→品→平台→店铺导航。
- 门禁：多品多店 50 项批次端到端通过，旧路径与新路径一致性为 100%。

### Phase 4：生产验证

- 六平台真实能力按“只读/可写/未配置”分别展示；支付、模型渠道、规则定时更新和媒体生成提供环境证据。
- 门禁：发布 canary、对账、备份恢复、容量、告警和回滚演练都有 release manifest。

## 15. 非本轮范围

- 不承诺未获得官方权限的平台真实写入。
- 不接管 Codex/ChatGPT 宿主自身会员或 Token 费用；只结算插件发起的业务模型调用。
- 不在缺少生产凭据时伪造支付弹窗、OAuth 成功或平台回执。
- 不在路线 B 首阶段拆成多个独立微服务，也不一次性删除旧 Product 数据。

## GSTACK REVIEW REPORT

```text
Review mode: autoplan
Premise: PASS — 用户选择路线 B
Design: PASS WITH REQUIRED CHANGES — 范围树、五态、统一设计令牌、Merchant Studio 组件化
Engineering: PASS WITH HARD GATES — auth、campaign/context、billing、storage、real-DB tests
Developer experience: PASS WITH REQUIRED TOOLING — one-command stack、统一错误、evidence manifest
User Challenge: NONE
Implementation authorization: APPROVED FOR ROUTE B
```

NO UNRESOLVED DECISIONS
