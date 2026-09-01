# 商品数据链与需求矩阵架构审计

审计日期：2026-08-29  
范围：需求矩阵、`Product`、`CanonicalProduct`、`ProductListing`、平台账号/店铺绑定、Task、CampaignItem、内容、发布和计费关联。  
变更边界：本轮只新增架构审计文档，未修改业务代码、migration 或数据库。

## 结论

当前系统已经具备两条并行商品链：

```text
旧兼容链：workspace → platform_account → products → tasks → content_versions → publish_jobs
标准链：  workspace → brand → canonical_products → product_listings
                                      → campaign_items → tasks → context_snapshots
                                      → content_versions → publish_jobs → receipts/usage
```

标准链的数据库复合外键和 workspace RLS 基本形成了安全骨架，但旧 `products` 仍承载真实商品事实，`CanonicalProduct` 目前主要是品牌/标准商品映射，`ProductListing` 才承载平台+店铺维度。需求矩阵中的“统一商品链已完成”应继续标为“本地代码闭环、迁移切读未完成”，不能把两套模型都当成独立可写真相源。

最高优先级问题：

| 优先级 | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| P1 | canonical product 到 legacy product 的品牌关系不是数据库级约束 | `packages/persistence/src/migrations/039_multi_brand_batch.sql:61-69` 的 `canonical_products_legacy_product_fk` 仅引用 `(workspace_id,id)`；`063_product_listing_brand_canonical_integrity.sql` 只修复 listing→canonical 的品牌组合 | 同一 workspace 内，canonical product 的 `brand_id` 可能与 `legacy_product_id` 所属商品品牌不一致；直写或回填时可造成跨品事实、素材、任务误归属 | 下一次 migration 为 `products` 建 `(workspace_id,id,brand_id)` 可引用键，并给 canonical→legacy 增加组合 FK；先做冲突报告，再 `NOT VALID`、回填/人工处理、VALIDATE。不得静默改写冲突 |
| P1 | 旧 Product 与 canonical/listing 双写/切读尚未闭环 | `doc/architecture-data-continuity-plan-2026-08-27.md:37,86,95`；`packages/application/src/service.ts:70-106,3246-3274`；API 仍直接创建/读取 `service.products` | 商品标题、事实、SKU、图片和确认状态可能只存在旧投影；标准链的 `canonical_products.facts`/`product_listings.fields` 不一定有同一版本，导致任务和发布读取不同来源 | 按 `expand → backfill → shadow read → consistency check → cutover → retire legacy` 完成；切读前增加按 workspace/brand/product/listing/version 的差异指标和阻断门禁 |
| P1 | 任务和批量子项仍同时保存 legacy `productId` 与 canonical/listing ID | `packages/persistence/src/brand-unit-repository.ts:17-20,196-206`；`apps/api/src/server.ts:291,526-528,3549-3564` | 一个子项可出现 `productId` 与 canonical/listing 语义不一致；当前约束主要保证 canonical/listing 自洽，未证明 legacy product 与 listing 指向同一商品 | CampaignItem/Task 切读后将 `listing_id` 作为平台目标主键，legacy product 仅做迁移兼容；过渡期必须有组合一致性检查，不一致直接阻断发布 |
| P2 | 需求矩阵与架构契约对“完成”口径不完全一致 | `doc/requirements-completion-matrix-2026-08-25.md` 将 canonical/listing、多店铺列为代码完成/部分完成；`doc/architecture-runtime-contract-2026-08-29.md:14-20` 又规定旧模型只能兼容投影 | 运营和交付可能误把 fixture/内存路径或兼容投影当成生产事实源 | 矩阵统一拆成“模型存在、应用链路、PostgreSQL 约束、生产证据、切读状态”五列；保持当前 NO-GO 口径 |
| P2 | 计费链路以 action/model usage 为主，商品目标关联依赖调用方携带 | `apps/api/src/server.ts:291,5610-5650`；`doc/architecture-runtime-contract-2026-08-29.md:28-41` | 同一商品可被多个任务/批次调用，若缺少 listing/campaign item/context hash，成本只能回溯到 action，难以按店铺商品核算 | 将 `task_id/campaign_item_id/listing_id` 作为 usage 维度的必备关联或不可变 metadata；在 legacy 兼容期间缺失则标记 `unattributed`，不能猜测归属 |

## 需求矩阵到数据对象的对账

| 需求能力 | 当前入口/对象 | 当前真相源 | 断链或孤岛 |
|---|---|---|---|
| 一个用户多个品 | workspace、brands/BrandUnit | PostgreSQL `brands`；内存 `BrandUnitService` 另有一套 Map | `packages/application/src/brand-units.ts:90-100` 的领域服务与 API 使用的 `BrandUnitRepository` 并非同一存储抽象，容易被误用为第二真相源 |
| 一个品多个平台/店铺 | `brand_store_bindings`、`product_listings` | listing 的 `(platform, platform_account_id)` | 绑定关系完整性有 FK，但旧 `products` 的 `store_name` 仍是展示/兼容字段，不应反向定义店铺身份 |
| 标准商品事实 | `canonical_products` | 设计上应为标准事实 | 当前表有 `title/facts/facts_revision`，而 application `Product` 仍保存 `title/category/images/attributes/skus/factsConfirmed`；尚未证明双写一致 |
| 平台店铺商品 | `product_listings` | listing + `platform_accounts` | `fields/title/remote_product_id` 与旧 `products.rawPlatformFields/remoteId` 重叠；发布前必须指定读取源 |
| 批量目标 | `batch_campaign_items` | 子项的 listing/canonical/platform/account | 子项还保留 `legacy_product_id`/应用 `productId`，形成兼容链旁路 |
| 内容与素材 | `context_snapshots`、content versions、product asset bindings | 冻结快照 + 对象存储元数据 | 未绑定的知识资产不默认进入任务是正确边界；商品图片/素材仍需保证 canonical/listing 维度的绑定可回溯 |
| 发布 | `publish_jobs`、平台回执 | 确认 hash + task/content/listing scope | 旧 publish job 仍以 task/product/platform/account 为主，listing 关联需在切读阶段强制存在 |
| 计费 | action ledger/model usage/wallet | action + usage receipt | 计费可追踪调用，但商品/店铺维度需要从不可变任务或 campaign item 继承，不能由当前商品标题反查 |

## 当前安全边界

已看到的有效保护：

- `products`、`tasks`、`platform_accounts` 具备 workspace 复合关系；`069_platform_account_scope_integrity.sql` 防止平台与账号错配。
- `product_listings` 同时受品牌、canonical product、品牌店铺绑定和平台账号约束；`063_product_listing_brand_canonical_integrity.sql` 已阻断 listing 跨品引用。
- API 创建 listing 前检查当前 workspace 的品牌店铺绑定和平台账号；创建 canonical product 的 `source_product_id` 有 workspace/品牌访问检查（`apps/api/src/server.ts:5539-5550`）。
- 任务/批次/上下文快照保留稳定 ID，名称只用于展示，符合 `doc/architecture-runtime-contract-2026-08-29.md:14-20` 的契约。

这些保护不能替代数据库级 canonical→legacy 品牌组合 FK，也不能证明旧 Product 与标准链已完成切读。

## 推荐修复顺序

1. **先做 P1 冲突盘点，不改数据**：统计 `canonical_products.legacy_product_id` 对应旧商品的 `workspace_id/brand_id` 不一致记录，以及 task/campaign item 的 `productId` 与 listing canonical/brand 不一致记录。
2. **补数据库组合约束**：为 `products` 暴露 `(workspace_id,id,brand_id)` 唯一键；canonical product 增加 `(workspace_id,brand_id,legacy_product_id)` 组合外键或等价约束。使用 `NOT VALID` 后先修冲突，再 `VALIDATE`。
3. **锁定读取源**：标准链切读前，商品事实从 canonical product，平台字段从 listing，店铺身份从 platform account；旧 Product 只保留兼容投影。
4. **建立一致性门禁**：按 workspace/brand/canonical/listing/task/campaign item 记录 hash、版本和 last checked；任何差异阻断发布和自动回填，进入人工处理队列。
5. **补矩阵证据列**：分别记录内存测试、PostgreSQL 约束、真实平台回读和生产部署证据，避免“接口存在”被写成“生产完成”。

## 本轮不直接修复的原因

发现的 P1 均涉及 migration、历史回填或双模型切读，不属于安全的文档/测试改动；在没有冲突清单和回滚方案时直接新增约束可能阻断现有数据迁移，直接切换读取源可能改变任务/发布语义。因此本轮没有修改代码，也没有把风险降级为已解决。

## 2026-08-29 跨层复核补充

本次使用 CodeGraph 对符号调用关系做了复核（索引状态：up to date；623 files、9,255 nodes、39,328 edges），并重新对读 docs、migration、API、persistence 和 worker。当前实际链路如下：

```text
catalog.import/sync
  → apps/api service.products (legacy Product: 商品事实 + platform/account/storeName)
      → task.create / task.group
          → task.inputSnapshot / contentVersion
              → publish_job + outbox event
                  → worker connector (platform + account_id + fields)

brand-unit.product.create
  → persistence.brandUnits.createCanonicalProduct
      → product_listings(canonical_product_id, platform_account_id)
          → batch_campaign_items(canonical/listing 可选 + legacy_product_id)
              → Task(canonical/listing 可选 + legacy product_id)
```

### 旁路与切读缺口证据

- `codegraph callers createListing` 显示标准 listing 写入入口主要是 `apps/api/src/server.ts:5437` 的 `routeMcp`；`packages/application/src/service.ts:3246-3274` 的 `createTask` 仍要求 `productId`，canonical/listing 只是可选字段。标准链没有成为 application task 的必选入口。
- `apps/api/src/server.ts:1477-1505,3790-3805,5143-5214` 的规则预检、账号解析、映射预检和发布前检查仍从 `service.products.get(task.productId)` 读取。即使任务已有 listing，多个关键门禁仍绕过 canonical/listing。
- `apps/api/src/server.ts:5539-5585` 的 canonical/listing API 使用 `persistence.brandUnits`；它与 legacy `MerchantService.products` 不在同一个写事务中。先创建 canonical，再单独创建 listing、再单独创建 campaign/task，任一步失败都可能留下“标准链半成品 + 旧链未关联”。
- `packages/persistence/src/brand-unit-repository.ts:17-20,78-84,196-206` 的 `CampaignTargetRow/CampaignItemRow` 同时保留 `productId`（落库为 `legacy_product_id`）和可选 `canonicalProductId/listingId`。这符合迁移兼容，但不符合“listing 是批量目标唯一主键”的最终切读契约。
- `apps/api/src/server.ts:526-528` 接受 `product_id` 或 `canonical_product_id`，但保留的 `productId` 为空时会以空字符串进入兼容目标结构；调用方仍可只给旧 ID。必须在 cutover 适配器中解析为唯一 `verified listing`，不能按标题、店铺名或第一条候选猜测。
- `apps/api/src/server.ts:3549-3564` 对缺少 listing 的 campaign item 生成 `planned-listing:${item.id}` 作为预览投影。该值只能是非生产预览标识，不能成为标准 listing 身份；生产发布前必须阻断。
- `packages/workers/src/factories.ts:5-8` 的 `PublishPayload` 只有 `taskId/contentVersionId/platform/idempotencyKey/fields/remoteId`；`apps/worker/src/main.ts:431-490` 的 connector 执行也只使用 platform/account/fields。worker 本身不验证 canonical/listing/campaign scope，安全性依赖 API `execution-check` 重新读取冻结 publish job。该 gate 必须保持唯一授权入口，否则 worker 直连会成为切读旁路。
- `apps/worker/src/main.ts:507-512,424-428` 的 generation usage 只把 `taskId/campaignItemId/contextHash` 注入用量 metadata，没有 canonical/listing；商品/店铺级成本必须通过不可变 task/campaign item 反查，不能从当前 Product 标题反推。

### 数据孤岛分类

| 孤岛 | 当前存储 | 读写特征 | 切读要求 |
|---|---|---|---|
| 旧商品事实 | `MerchantService.products` / PostgreSQL `products` | API/application 的绝大多数任务、预检、视觉和映射仍读这里 | canonical facts 成为事实主源；旧 Product 仅投影 |
| 标准商品关系 | `canonical_products` + `product_listings` + `BrandUnitRepository` | 由 `brand-unit.*` API 单独操作，尚未成为 task/application 必选依赖 | 通过唯一 verified 映射进入任务，不允许隐式猜测 |
| 批量兼容关系 | `batch_campaign_items` | `legacy_product_id` 与 canonical/listing 并存，部分 listing 可为空 | campaign item 必须以 listing scope 为发布目标，legacy 只追溯 |
| worker 执行范围 | outbox payload + API execution gate | worker payload 不携带标准链 ID，依赖 API gate | 禁止绕过 gate；切读时 gate 必须验证 task→campaign item→listing 五元组 |
| 内存领域模型 | `packages/application/src/brand-units.ts` 的多组 Map | 与 persistence repository 是不同实现，适合测试但不是生产事实源 | 明确仅 fixture/unit test；不得被生产 route 当作第二真相源 |

### P0/P1 判断

- 未发现可在本轮安全修复的 P0。现有 workspace 复合约束、listing 品牌组合 FK、069 平台账号触发器和 API 权限检查构成了基础防线。
- P1 仍然成立：legacy `productId` 与标准 listing 并存、关键 API 门禁绕过 canonical、worker scope 依赖隐式 execution gate、canonical→legacy 品牌组合缺少数据库级约束，以及标准链多次调用不在同一事务中。它们都需要 migration/切读开关/历史冲突数据配合，不能通过改一处调用或删除旧字段安全解决。

本补充只更新审计证据，不代表已完成 cutover，也不代表 worker 已具备独立 canonical/listing 校验能力。

### 2026-08-31 增量：新增 canonical→legacy 品牌复合约束

- 新增 migration 099：`products.brand_id` 从既有 `data->>'brandId'` 生成并持久化，建立 `(workspace_id, id, brand_id)` 唯一键。
- `canonical_products` 新增 `canonical_products_brand_legacy_fk`，引用 `(workspace_id, brand_id, legacy_product_id)`；约束使用 `NOT VALID`，因此不会改写或删除历史冲突数据，也不会把未盘点的旧数据误判为已修复。
- 截至该审计快照，本地 Compose 已真实应用 migration 099：`schema_migrations.max(version)=99`，约束与索引均存在；迁移日志显示 `migrations complete`。该记录是历史证据；当前链尾已推进到 migration 100，新增告警通知投递账本，最新链尾以 `release-metadata.json` 和发布门禁为准。
- 当前本地数据库冲突探针返回 0 条 `canonical_products.brand_id` 与旧 `products.brand_id` 不一致记录；这只是该本地数据集的观察结果，不等于所有 workspace/生产数据已清理，因此约束仍保持 `NOT VALID`。
- 该增量只阻断新增跨品牌 canonical 映射；历史冲突清单、约束 VALIDATE、canonical 事实切读和真实平台/生产证据仍未完成，故本审计和相关 TODO 不迁移到 `doc/done`。
