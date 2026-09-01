# Canonical Product / Listing / Campaign Item 统一切读设计

日期：2026-08-29  
目标：在不删除旧表、旧字段、旧快照和旧发布记录的前提下，把标准商品链逐 workspace 切换为读取主源。  
本文件是设计，不代表已经执行切读；当前生产口径仍为 NO-GO。

## 2026-08-31 控制面交互增量

- Ops Console 功能开关编辑器已对 `canonical.product.read_mode` 的 `canonical_read` 值显示专用风险提示：非生产环境提示先核对 workspace 一致性报告并保留回滚审计；生产环境明确提示必须具备正式 `canonical-cutover-evidence`，且服务端仍是最终 fail-closed 门禁。
- 该提示只改善运营决策和恢复路径，不替代一致性检查、连续 shadow、回滚演练或生产证据；因此本设计继续保留在 `doc/todo/data`，不迁移到 `doc/done`。

## 1. 目标链与主源

```text
workspace
  └─ brand
      └─ canonical_product        ← 标准商品事实主源
          └─ listing               ← 平台 + 店铺商品主源
              └─ campaign_item     ← 批量执行目标主源
                  └─ task
                      └─ context_snapshot → content_version → publish_job → receipt
```

| 概念 | 切读后的唯一主源 | 旧字段处理 |
|---|---|---|
| 商品通用事实、品牌归属、事实版本 | `canonical_products.facts/facts_revision` | `products` 只保留兼容投影和迁移来源，不再作为标准链的事实写入入口 |
| 平台商品标题、类目、平台字段、远端商品 ID | `product_listings` | `products.remote_product_id/rawPlatformFields/title` 只用于 legacy 回读/对账 |
| 平台和店铺身份 | `platform_accounts` + `product_listings.platform_account_id` | `products.store_name` 只展示，不定义店铺身份 |
| 批量目标和顺序 | `batch_campaign_items` 的 `listing_id`、`canonical_product_id`、platform/account scope | `legacy_product_id` 保留用于追溯，不作为发布目标主键 |
| 单次任务范围 | `tasks` 的 `brand_id/canonical_product_id/listing_id/campaign_item_id` | `tasks.product_id` 继续保留，直到所有旧任务完成迁移和归档 |
| 内容/发布历史 | 已冻结的 `context_snapshots/content_versions/publish_jobs` | 历史记录不可重写，不因切读重新生成或重新绑定 |

主源规则只适用于切读之后新建或重新确认的对象。历史 content/publish 记录继续以其保存的快照和版本 ID 为准，不能用当前 canonical/listing 覆盖历史事实。

## 2. 现有代码证据与约束

1. `039_multi_brand_batch.sql:53-103` 已有 `canonical_products` 和 `product_listings`；listing 通过 workspace、品牌店铺绑定、平台账号和 canonical product 约束。
2. `043_route_b_expand.sql:1-6` 明确是 additive Route B，保留旧列，不在 expand 阶段强制非空。
3. `047_route_b_task_projection.sql:1-10` 从兼容快照补齐 Task 的 brand/canonical/listing/campaign scope，但无效后代关系会被保留在 `data` 中，不能把 NULL 当作已验证关系。
4. `049_legacy_snapshot_backfill.sql:88-156` 按 brand → canonical → listing → campaign item 单调投影，危险后代不会反向污染安全祖先，且 `ON CONFLICT DO NOTHING` 不覆盖现有标准行。
5. `063_product_listing_brand_canonical_integrity.sql:1-30` 已阻断 listing 将品牌与另一品牌的 canonical product 组合。
6. `069_platform_account_scope_integrity.sql:1-47` 已阻断旧 products/tasks/publish_jobs 的平台与账号错配。
7. `apps/api/src/server.ts:5539-5585` 的 API 已按 workspace/brand/store/account 校验 canonical 与 listing，但 application `Product` 仍在 `packages/application/src/service.ts:70-106,1497-1515` 保存完整旧商品事实。

## 3. 分阶段方案

### Phase A：Expand（只加，不删）

增加以下控制面结构，不能改写旧业务数据：

- 每个 workspace 的 `canonical_read_mode`：`legacy_shadow | dual_verify | canonical_read`。
- `unified_link_audit`：记录 `workspace_id`、legacy product、canonical product、listing、campaign item、检查版本、checksum、状态、发现时间和最后错误。
- 运行指标：`legacy_only`、`backfilled`、`verified`、`conflict`、`blocked` 的数量和比例。

旧列、旧表、`business_entity_snapshots`、历史任务和发布记录均保留。任何控制面写失败都不能改变业务写入结果；切读开关默认 `legacy_shadow`。

### Phase B：Backfill（只填可证明关系）

按以下顺序执行，每个 workspace 可暂停、重跑、幂等：

1. **Legacy Product → CanonicalProduct**
   - 候选键优先使用明确的 `canonical_product_id`/持久化映射；无映射时使用同 workspace、同品牌、明确人工或导入批次关联。
   - 不用标题、店铺名、图片 hash 单独猜测 canonical identity。
   - `products` 无 brand 归属时只登记 `legacy_only`，不得自动归到第一个品。
2. **CanonicalProduct → Listing**
   - 候选必须同时满足 `workspace_id + brand_id + canonical_product_id + platform + platform_account_id`。
   - `remote_product_id` 非空时还要满足 `(workspace_id, platform, platform_account_id, remote_product_id)` 唯一身份。
   - 缺少平台账号、品牌店铺绑定、远端身份或存在多个候选时登记 `conflict`。
3. **Listing → CampaignItem**
   - 只将 `legacy_product_id/productId` 与 listing 的 canonical、brand、platform、account 全部一致的子项标为 `verified`。
   - 只匹配到 canonical、但没有 listing 的子项标为 `legacy_only` 或 `blocked`，不能合成 `planned-listing:*` 作为生产身份。
4. **CampaignItem → Task**
   - Task 只有在 campaign item 的组合 scope 完整且一致时才补齐 `listing_id/canonical_product_id/brand_id`。
   - 任何一项不一致都保留原 `data` 和旧 `product_id`，状态为 `conflict`，发布前阻断。

回填只使用 `INSERT ... ON CONFLICT DO NOTHING` 或带 expected revision 的幂等更新；不删除、不覆盖人工维护的 canonical/listing 字段，不将 unresolved ID 伪造为标准关系。

### Phase C：Shadow Read + 双向校验

在 `legacy_shadow` 下仍返回旧链结果，同时后台读取标准链并生成差异：

- 商品事实：canonical facts 与 legacy `Product` 的规范化 hash。
- 平台字段：listing fields/title/remote ID 与旧 Product 平台字段 hash。
- 目标范围：campaign item/task 的 brand、canonical、listing、platform、account 五元组。
- 版本：facts revision、listing revision、task version、content context hash。

差异分为：

| 状态 | 含义 | 是否允许切读 |
|---|---|---|
| `backfilled` | 关系已创建，但尚未完成字段核对 | 否 |
| `verified` | 关系、scope、字段 hash 和版本均一致 | 是 |
| `legacy_only` | 只有旧链，无法证明标准关系 | 否 |
| `conflict` | 品牌、商品、平台、店铺、远端 ID 或版本冲突 | 否 |
| `blocked` | 规则/权限/缺失账号/迁移错误导致不能读取 | 否 |
| `rolled_back` | 曾切读但已恢复旧模式 | 否，需重新 shadow verify |

冲突必须可见、可检索、可人工处理；不得通过重新命名商品、取第一条候选或覆盖旧快照消除差异。

### Phase D：Workspace 级 Cutover

只允许按 workspace 切换，不做全局开关。满足以下门禁后，`canonical_read` 才能打开：

- 所有活跃可发布 listing 的关系状态为 `verified`；
- 活跃 campaign item、待生成 task、待发布 publish job 无 `conflict/legacy_only/blocked`；
- 平台账号与品牌店铺绑定均存在，且 platform/account 组合一致；
- 最近两个 shadow 检查周期无新增差异；
- 旧链仍可回读，且有带版本/时间的备份和恢复演练记录；
- 计费、context snapshot、发布审计均能通过 listing/campaign item 回溯。

切读行为：

- 新列表、任务范围、批量预检和发布准备从 canonical/listing/campaign item 读取。
- 旧 `product_id` 作为兼容输入时，先解析到唯一 verified listing；多候选或非 verified 直接返回可修复的冲突，不猜测。
- 新写入先写标准链，再异步更新旧投影；旧投影更新失败进入 outbox/retry，不回滚已经提交的标准事实。
- 已冻结的历史上下文、内容版本和发布回执只按原 ID 读取，不重新绑定当前 listing。

## 4. 回滚设计

回滚不是删除标准数据，而是将 workspace 的 `canonical_read_mode` 改为 `dual_verify` 或 `legacy_shadow`：

1. 停止新的标准链写入入口和发布确认，保留只读标准链。
2. 未冻结的新任务回到旧兼容读路径；已创建的 canonical/listing/campaign item 不删除、不降级覆盖。
3. 已冻结任务、content version、publish job 继续按其 snapshot/version/hash 执行，不把旧链结果混入已确认版本。
4. 记录 `rolled_back` 事件、原因、操作者、revision 和受影响 workspace。
5. 修复冲突后重新 shadow verify；不能仅重新打开开关。

如果标准写入成功、旧投影失败，恢复依赖 outbox 重试和 reconciliation；不能通过删除 canonical/listing 来“回滚”。如果标准写入事务失败，则保留完整未创建态，不能只留下半个 listing 或 campaign item。

## 5. 迁移后收敛门禁（未来，不在本轮执行）

只有所有 workspace 完成 cutover、历史发布任务达到终态、legacy-only/conflict 数为零并完成归档证明后，才可另立变更：

- 将旧字段改为只读兼容投影；
- 补齐 canonical→legacy 的品牌组合外键；
- 把旧 API 输入转为显式兼容适配器；
- 评估旧表/字段的保留期限和审计导出要求。

本设计明确禁止当前直接 `DROP TABLE`、`DROP COLUMN`、清空 `legacy_product_id`、重写历史 snapshot 或用当前 canonical/listing 覆盖历史发布事实。

## 6.1 2026-08-31 实现增量（仍不代表 cutover）

- `canonical.product.consistency` 继续保持 workspace-scoped、只读 dry-run，并新增 canonical-only 根节点缺失 legacy 映射的阻断发现，避免“无 legacy 行所以 clean”的漏报。
- 2026-08-31 增量：一致性报告同时阻断显式指向不存在 legacy product 的 canonical root（`CANONICAL_LEGACY_PRODUCT_ORPHAN`）；该规则已补充单测，避免 dangling mapping 被误判为 clean。
- `catalog.search` 返回 `canonical_scope.verification_status`、canonical/listing ID、listing 数量和下一动作；状态不为 `verified` 时引导重新执行一致性检查，不猜测商品关系。
- 新增工作区级 canonical 读取模式控制：复用 `platform_feature_flags` 的 `canonical.product.read_mode`，支持 `legacy_shadow | dual_verify | canonical_read` 的显式值、工作区覆盖、版本和紧急关闭；缺少 feature-flag 仓库、关闭、紧急关闭或非法值均 fail-closed 为 `legacy_shadow`。
- 新增 `unified_link_audit` 持久化投影（迁移 098）：一致性检查按 workspace + 实体稳定 key 幂等更新 legacy/canonical/listing/campaign/task/publish 关系、状态、错误码、检查 revision、checksum、首次/最近发现时间；PostgreSQL 启用 FORCE RLS，内存仓库与 PostgreSQL 仓库保持同一契约。
- `canonical.product.consistency` 返回 `read_control`，`catalog.search` 的 `canonical_scope` 返回 `read_mode`，因此桌面运营台和插件可以观测当前切读模式；本次未改变既有商品读取结果，也未默认打开 canonical 读取。
- 插件 Bridge 将 `canonical.product.consistency` 明确列为只读方法。
- 任务解析仍复用唯一 canonical/listing resolver；没有打开 workspace 级 `canonical_read`，没有迁移到 `doc/done`。

### Safe backfill 实现增量（2026-08-31）

- `runCanonicalProductBackfill` 现在支持 `dryRun`、稳定 `afterProductId` 游标和 1–5000 的有界 `limit`；未传 `limit` 时保留原有全量 apply 兼容行为。
 - `canonical_backfill_runs`（migration 101）及 `ops.canonical.backfill.create/get/pause/resume/run` 已提供持久化批次控制、revision CAS、单批执行和冲突失败快照；migration 102 进一步提供幂等人工冲突队列及认领/解决 CAS。
- dry-run 不执行 INSERT，按 workspace advisory lock 读取并只返回可证明 creates、unchanged、conflicts 和下一游标；apply 仍只使用 conflict-safe INSERT，不 UPDATE/DELETE legacy 或 canonical 既有关系。
- 真实本地 PostgreSQL `ws_demo` dry-run 分两页执行成功：第一页返回 0 creates / 2 conflicts，游标为 `prod_fixture_1`；第二页返回 0 creates / 2 conflicts，游标为 `prod_jd_local_1748a7ba4da4d550c698`。该运行未写入 canonical 行。
- 这只完成了回填执行器、批次审计、暂停/继续 API 和人工冲突队列基础，不等同于全量历史回填或生产 RLS/回滚演练；因此 canonical 文档继续留在 `doc/todo`。

## 6.3 2026-08-31 标题优化读取门禁增量

- `catalog.title.optimize` 现在读取 workspace 的 `canonical.product.read_mode`；只有显式 `canonical_read` 才启用标准链门禁，`legacy_shadow` 与 `dual_verify` 保持旧行为。
- `canonical_read` 下必须存在唯一 `sourceProductId` 映射和唯一目标平台/店铺 listing；缺少映射、映射冲突、listing 缺失或 listing 冲突均返回可修复的 `409`，不会继续用旧商品事实生成标题。
- 通过门禁后，标题生成使用已验证 canonical 商品标题，并在响应中返回 `canonical_scope`（canonical product、brand、listing）；其他商品属性仍沿用当前已确认的商品事实，未宣称完成全字段切读。
- 新增纯函数回归覆盖三种 rollout 语义及 mapping/listing fail-closed 分支；API/application 定向测试 36 项通过，类型检查和 `git diff --check` 通过。
- 该增量仍不打开真实 workspace 的 `canonical_read`；连续 shadow、真实双副本故障注入、生产回滚和正式宿主证据仍缺失，不能迁移到 `doc/done`。

## 6.2 2026-08-31 当前验证

- canonical consistency application、coverage、queue、API 和 Stores 页面定向测试共 72 项通过。
- 新增读取模式 fail-closed 单测及 API 控制面契约测试；canonical application/API 定向测试共 35 项通过，`npm run typecheck` 和 `git diff --check` 通过。
- 新增 API E2E：通过 `ops.feature-flag.upsert` 对 workspace 灰度开启 `canonical_read`，未建立标准商品链时标题优化返回 `CANONICAL_PRODUCT_MAPPING_REQUIRED`；补齐唯一 canonical 商品与 listing 后，标题建议使用标准商品标题并返回 canonical scope。该场景与既有功能缺口 E2E 共 21 项通过。
- `unified_link_audit` 仓库、迁移 098、API consistency 写入和历史迁移兼容回归共 64 项通过；本地 PostgreSQL migration integrity（含 098）通过，release metadata 已更新为迁移 098。
- `server.e2e.test.ts` 已验证 workspace-scoped dry-run；页面测试验证品牌树与一致性入口的桌面空态/阻断态。
- 当前仍不执行 workspace 级 `canonical_read` 切换：本地真实 workspace 仍存在 `legacy_only/conflict/blocked`，且未完成连续 shadow 周期、真实多副本并发、生产回滚和正式宿主验收。
