# 标准商品链一致性报告（第一阶段）

本轮没有切换读取主源，也没有写入或修改真实数据库。新增的纯函数报告只沿用已有的显式关系：

```text
products.id
  → canonical_products.legacy_product_id
  → product_listings.canonical_product_id
  → batch_campaign_items.listing_id / canonical_product_id
  → tasks.product_id + canonical_product_id + listing_id + campaign_item_id
```

实现：[packages/application/src/canonical-product-consistency.ts](../../../packages/application/src/canonical-product-consistency.ts)。它不根据标题、图片、店铺名称、平台名称或数组顺序猜测身份，也不覆盖任何输入对象。

真实 PostgreSQL 查询位于 `PostgresBrandUnitRepository.listCanonicalChainConsistencyRows({ workspaceId })`，在一个 workspace-scoped、只读事务中读取 `products`、`canonical_products`、`product_listings`、`batch_campaign_items` 和 `tasks`。MCP 方法 `canonical.product.consistency` 通过 `POST /mcp` 暴露该 dry-run；请求的 `X-Workspace-Id` 与可选 `params.workspace_id` 必须指向同一 workspace。

返回会标明 `source: postgres|memory` 与 `durable: true|false`。生产请求必须看到 `source: postgres`；memory 结果只用于本地启动/测试状态说明，不伪装成持久化结果。

## 当前架构结论

- `canonical_products` 已以 `(workspace_id, brand_id)` 约束品牌范围，并保留 `legacy_product_id` 追溯旧商品。
- `product_listings` 已通过 canonical、品牌店铺绑定、平台账号三组外键组合约束平台/店铺范围。
- `batch_campaign_items` 已保存 canonical/listing/task 关系；`047_route_b_task_projection.sql` 对任务补齐了组合 scope 外键。
- `products` 和 `tasks` 仍是应用层主要读取面，特别是 `packages/application/src/service.ts` 和 `apps/api/src/server.ts`，因此当前不能宣称已完成统一切读。
- 标准链缺少正式的差异报告入口；本轮先补纯函数和测试，后续可由 persistence repository 将数据库行转换为该输入，不需要另造业务表。

## 状态含义

| 状态 | 含义 | 是否可切读 |
|---|---|---|
| `verified` | 显式 canonical/listing/campaign/task 关系和 scope 一致 | 可作为候选，仍需 workspace 门禁 |
| `legacy_only` | legacy product 没有唯一 canonical 映射 | 不可 |
| `blocked` | canonical 存在，但已有平台/店铺上下文缺少 listing 或必要关系 | 不可 |
| `conflict` | 多 canonical、品牌、平台、账号、listing 或 task scope 不一致 | 不可 |

报告输出按状态优先级和 ID 稳定排序，并给出 `counts`、关系 ID 和稳定错误码，适合 dry-run、审计导出和后续 CI 门禁。另有 `orphanFindings` 专门报告 listing、campaign item、task 指向不存在上游关系的孤儿记录，避免从 legacy product 入口无法覆盖标准链孤岛。

## 现阶段最小切读建议

1. persistence 层按 workspace 查询四类标准行和 legacy rows，调用该纯函数生成报告；默认只读、幂等，不新增迁移。
2. 只有报告中不存在 `legacy_only/conflict/blocked` 的 workspace，才允许未来进入 `dual_verify`；不要用标题或 remote ID 单独回填。
3. 新统一读取接口应返回 canonical product + 可选 listings + campaign items，并保留 `legacyProductId` 作为追溯字段；历史 task/content/publish snapshot 继续按原 ID 读取。
4. 若后续实现 workspace 级开关，默认 `legacy_shadow`，失败回滚只切回读取模式，不删除或覆盖标准链。

## MCP / OpenAPI 契约

- MCP allowlist 和参数契约：`packages/contracts/src/mcp.ts` 的 `canonical.product.consistency`。
- OpenAPI：`apps/api/openapi.yaml` 的 `/mcp` allowlist、`McpRequest` enum、`McpCanonicalProductConsistencyParams` 和 method schema ref。
- 该方法只读，不触发 backfill、不改变 `canonical_read_mode`、不更新任务、不删除或覆盖 legacy 数据。

## 2026-08-31 真实 workspace 冲突处置

- `ws_demo` 的 PostgreSQL 只读核查发现：商品 `prod_taobao_484008b7e055_TB-FIXTURE-2001` 的当前平台账号为 `fixture_ws_demo_taobao`，但历史任务 `task_9319f497-283b-4a2e-b6ef-b9baf7448ec6`、`task_7acd0f14-b26f-4956-907a-948cee1cc07d` 仍引用 `fixture-store-ws_demo-taobao`；这是同平台账号漂移，属于 `TASK_ACCOUNT_MISMATCH`，不是 migration 069 可以覆盖的跨平台账号错误。
- 现有 `ops.canonical.backfill.conflict.resolve` 只对 `MISSING_BRAND` 提供带产品版本 CAS、事务复核和审计的 `set_legacy_brand` 修复；对任务账号漂移没有目标账号确认、任务版本 CAS、关联发布/内容快照影响评估的安全契约，因此不得将该 finding 直接标记 resolved，也不得裸 SQL 改历史任务。
- 正确处置为：平台运营先确认目标店铺和历史任务是否仍需执行；需要继续执行时创建新的、经过 canonical scope 解析的任务，原任务保留为历史阻断并记录审计；需要专门修复历史任务时，必须新增任务级 remediation（目标账号、expected task version、关联快照/发布状态检查、CAS、回滚证据）后再操作。
- 本次没有修改演示业务数据；该 finding 继续阻断 canonical cutover，文档保持 `TODO / NO-GO`。
- 已修复 `task.clone` 的承接路径：当历史任务仅发生账号漂移时，显式提供 `target_account_id` 会触发 fresh-task scope rebind，并重新加载目标商品/平台/店铺的 Canonical 约束；不会复制旧内容、促销快照或旧发布状态。应用与 API 回归 180/180、TypeScript 通过。该能力只提供安全承接，不会自动修改原历史任务，因此原 finding 仍需运营确认后逐条处置。

## 测试

`packages/application/src/canonical-product-consistency.test.ts` 覆盖：完整链路、legacy-only、重复 canonical 不猜测、scope 冲突、workspace 隔离、缺失 listing 阻断以及输入不可变。
`packages/persistence/src/brand-unit-repository.test.ts` 验证 PostgreSQL repository 在一个事务中执行五个 workspace-scoped SELECT，且没有 INSERT/UPDATE/DELETE。
`apps/api/src/server.e2e.test.ts` 验证 MCP dry-run 可达、返回只读/未切读标识，并明确 memory 模式不是 durable 结果。

## 2026-08-31 真实 workspace 冲突处置

- `ws_demo` 的 PostgreSQL 只读核查发现：商品 `prod_taobao_484008b7e055_TB-FIXTURE-2001` 的当前平台账号为 `fixture_ws_demo_taobao`，但历史任务 `task_9319f497-283b-4a2e-b6ef-b9baf7448ec6`、`task_7acd0f14-b26f-4956-907a-948cee1cc07d` 仍引用 `fixture-store-ws_demo-taobao`；这是同平台账号漂移，属于 `TASK_ACCOUNT_MISMATCH`，不是 migration 069 可以覆盖的跨平台账号错误。
- 现有 `ops.canonical.backfill.conflict.resolve` 只对 `MISSING_BRAND` 提供带产品版本 CAS、事务复核和审计的 `set_legacy_brand` 修复；对任务账号漂移没有目标账号确认、任务版本 CAS、关联发布/内容快照影响评估的安全契约，因此不得将该 finding 直接标记 resolved，也不得裸 SQL 改历史任务。
- 正确处置为：平台运营先确认目标店铺和历史任务是否仍需执行；需要继续执行时创建新的、经过 canonical scope 解析的任务，原任务保留为历史阻断并记录审计；需要专门修复历史任务时，必须新增任务级 remediation（目标账号、expected task version、关联快照/发布状态检查、CAS、回滚证据）后再操作。
- 本次没有修改演示业务数据；该 finding 继续阻断 canonical cutover，文档保持 `TODO / NO-GO`。
