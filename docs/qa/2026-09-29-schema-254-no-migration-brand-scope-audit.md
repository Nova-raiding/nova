# 数据库 254 无迁移承载品牌层级配置的只读审计

审计日期：2026-09-29。范围：当前 `main` 的迁移、仓库、API 组合与已有测试。使用 `codegraph status .` 和 `codegraph explore scoped-brand-settings-repository` 辅助追踪调用关系；未修改业务代码、数据库、发布元数据或门禁，也未把静态审计当作生产验收。

## 结论

在保留当前实现与“数据库不迁移”的约束下，**254 只能保持品牌层级配置关闭，不能发布该功能为已通过**。`release-metadata.json:5` 声明候选目标为 255；普通运行时在数据库低于候选迁移版本时健康检查失败（`apps/api/src/server.ts:3110-3117,3338-3346`）。专用 254→255 桥接模式允许完整且校验通过的 254 前缀启动，但刻意不注入品牌层级仓库（`apps/api/src/server.ts:3165`），四个品牌层级 HTTP 操作返回 `BRAND_SCOPES_NOT_CONFIGURED`/503（`apps/api/src/http-scoped-brand-routes.ts:27-31`），任务确认也跳过层级配置冻结（`apps/api/src/server.ts:13172,13281`）。`apps/api/src/scoped-brand-routes.contract.test.ts:13-46` 把上述 254 行为固定为契约。

这不影响旧的 `brand.get`/`brand.upsert` 品牌档案路径是否可用；它不能证明新“全局→店铺→系列→图片”覆盖链可用。若发布范围明确不包含新链，可独立评估 254 桥接候选，但这不满足“全部品牌配置功能上线”。

## 255 的三张表及不能省略的语义

| 表 | 已实现职责与数据库约束 | 代码使用 |
| --- | --- | --- |
| `merchant_brand_series` | 服务端稳定系列 ID；同工作区同店铺名称不区分大小写唯一；复合店铺外键；系列行修订号。见 `packages/persistence/src/migrations/255_scoped_brand_settings.sql:1-18`。 | `packages/persistence/src/scoped-brand-settings-repository.ts:64-83,198-199`。 |
| `merchant_brand_asset_assignments` | 每个工作区素材只有一条店铺/系列归属；素材快照、店铺和同店铺系列的复合外键及 `ON DELETE RESTRICT`；独立修订号。见迁移 `:20-37`。 | 仓库 `:86-122,141-149,203` 进行 CAS 更新和任务生成时的店铺核对。 |
| `merchant_brand_scoped_settings` | 工作区唯一配置 JSONB、版本校验、操作者、整棵层级的 CAS 修订号。见迁移 `:39-49`。 | 仓库 `:56-60,126-179` 在同一工作区事务内读、校验、保存；`apps/api/src/scoped-brand-task-hydration.ts:6-40` 在任务确认前冻结。 |

三张表均开启并强制工作区 RLS，并限制 `merchant_app`/`merchant_ops` 权限（迁移 `:51-81`）。仓库保存时还会锁定店铺、系列、素材快照，检查扫描/授权/事实确认，再写配置；生成前重新核对（仓库 `:183-220`）。因此只把 JSON 塞入旧字段，无法自动继承这些约束。

## 254 可用载体与缺失的不变量

| 254 载体 | 现有能力 | 缺口 |
| --- | --- | --- |
| `business_entity_snapshots` 的 `brand_profile` 行 | JSONB、工作区复合主键、实体版本、强制 RLS（`packages/persistence/src/migrations/004_business_entities.sql:187-208`；`006_brand_assets.sql:1-8`）。 | 它是旧品牌档案恢复投影；`packages/application/src/service.ts:2487-2565` 管理旧档案和冲突。额外层级 JSON 没有独立系列/素材身份、复合 FK、同店系列名称唯一索引、资产归属单行 CAS；现有 `PostgresBusinessRepository.saveInTransaction` 只按 `entity_version` 单调覆盖快照（`packages/persistence/src/business-repository.ts:112-148`），不是新接口的 `expectedRevision` 等值 CAS。直接复用会改变旧档案契约和重启恢复语义。 |
| `brands.data` 与 `brand_store_bindings` | 既有品牌行含 `data` JSONB、工作区键和品牌↔店铺复合外键（`packages/persistence/src/migrations/039_multi_brand_batch.sql:11-38`）。 | 品牌单位/店铺绑定不是“某店系列”实体；无每个素材只归一个店铺/系列的复合外键、行修订号和原有新接口的工作区整棵配置 CAS。若借用 `data`，需重新定义多个品牌行与唯一工作区配置之间的冲突/继承规则。 |
| `product_asset_bindings` | 商品→素材关系、工作区 RLS（`packages/persistence/src/migrations/070_product_asset_bindings.sql:1-31`）。 | 主键含商品和素材，资产可属于多个商品；不表达素材→唯一店铺/系列归属。素材存在性靠触发器筛选，不提供新表的素材/店铺/系列三重外键（同文件 `:32-77`）。 |

**可行性界线：** 254 的 RLS 与 JSONB 容量足以实现“工作区隔离的某些配置存取”；但在不加表/约束/索引/触发器的前提下，不能从数据库层继承 255 已有的稳定身份、名称唯一性、引用完整性和删除限制。理论上可以另写应用层事务锁、校验与 CAS，尽量取得类似 API 可见行为，但须处理跨请求竞争、相关实体删除、恢复投影和所有绕开该 API 的写入路径；目前没有这套实现或相应生产证据。把 `expectedMigrationVersion` 改成 254、改健康门禁或启用现有仓库查询，只会把缺表错误/不完整语义暴露给用户，不是无迁移方案。

### 254 JSON 聚合不能等价承载 255 约束的反证

254 的 `business_entity_snapshots` 并非可自由扩展实体类型的键值表：迁移 `218_manual_publish_evidence.sql:4-8` 重建的 `business_entity_snapshots_entity_type_supported_check` 仅允许固定的 `brand_profile`、`asset` 等类型，不允许新建 `brand_series` 或 `scoped_settings` 类型。若复用保留的 `brand_profile` ID 存一行 JSON 聚合，`packages/application/src/service.ts:2474` 会把它当旧品牌档案加载，必须改读模型才能避免伪档案混入。该表的 `entity_version` 是 `integer`（`004_business_entities.sql:189-197`），255 新配置和系列的修订号是 `BIGINT`。

一个 254 适配器可以用 `SELECT id FROM workspaces WHERE id=$1 FOR UPDATE` 串行化自己的一切创建、改名、绑定及保存操作；在事务中核对同店 `lower(name)`、素材与店铺存在性，使用 `UPDATE business_entity_snapshots SET entity_version=entity_version+1,payload=$new::jsonb WHERE workspace_id=$1 AND entity_type='brand_profile' AND entity_id=$reserved AND entity_version=$expected RETURNING ...` 实现等值 CAS。这只能约束**经过适配器**的写入。`infra/local/ensure-app-role.sql:55-59` 给 `merchant_app` 现有表的 `SELECT, INSERT, UPDATE, DELETE`，工作区 RLS 只检查 `workspace_id`（`004_business_entities.sql:203-208`），不检查聚合 JSON 内的资产、店铺和系列引用。即使适配器在事务中用 `FOR SHARE` 锁定一个可用资产，事务提交后，另一合法同租户事务仍可删除一个未被其他外键引用的 `asset` 快照；聚合继续引用已不存在的素材。删除被引用的店铺也会造成悬空。适配器锁住 `workspaces` 行并不能强制其他写入路径遵守该锁协议。资产状态后来变为不可用时，254 与 255 都还需要在任务冻结阶段重新校验使用资格。

255 的 `merchant_brand_asset_assignments` 则以 `(workspace_id,asset_id)` 为主键，并对素材快照、店铺和同店系列设置复合外键 `ON DELETE RESTRICT`（`255_scoped_brand_settings.sql:20-35`）；系列还受同店 `lower(name)` 唯一索引保护（`:17-18`）。上述删除在 255 上由数据库拒绝，不依赖 API 是否参与。要在 254 上达到同等级保证，必须新增/改变数据库外键、约束、触发器或角色权限；即使不增加版本号，这也是实质数据库迁移，与用户的“不迁移数据库”限制冲突。因此不能把 JSON 聚合适配器称为完整、等价、可上线的 254 方案。

并发任务冻结还有单独注意点：当前 255 仓库的 `resolveForTask` 用 `FOR KEY SHARE` 读取资产归属（`scoped-brand-settings-repository.ts:142`），而 `assignAsset` 更新的店铺/系列归属不属于归属表主键（`:90-99`）；该锁模式不能阻止普通非主键字段更新。无论选择哪种数据库方案，都应把任务冻结和重归属之间的锁与提交边界纳入真实 PostgreSQL 并发验收，不能用仅有的顺序测试推断无竞争。

## 如果坚持 254 完整功能，实际工程范围

这会是新的持久化实现，而非一个发布配置切换。至少需要：

1. 选定 254 存储布局并定义稳定系列 ID、全局/店铺/系列/图片唯一工作区配置、资产唯一归属和与旧档案的并存/恢复契约。
2. 重写 `PostgresScopedBrandSettingsRepository` 的读、建系列、资产绑定、配置保存及任务解析：对工作区聚合与相关店铺/素材行加锁，在同一事务内完成所有引用校验和等值 CAS，并处理并发创建、改名、删除/解绑和重试。
3. 调整 API 254 桥接组合、任务确认与重启后的恢复路径；显式保持 RLS、权限、审计和错误码，不放宽现有门禁。
4. 新增真实 PostgreSQL 254 隔离测试：双租户读写、同时创建同名系列、同时绑定一张素材、同时改配置、删除/禁用引用对象、扫描/使用权状态变化、进程重启及任务快照冻结。重跑 API/MCP、桌面商家界面、worker 和生产候选健康检查。
5. 重新评审发布元数据与 254 完整链的签名归档/回滚计划；这应是单独的 254 兼容发行，不得修改现有 255 门禁以制造绿灯。

这属于**多文件、多天级**实现和隔离环境验证，实际工期取决于上述并发与恢复路径的测试结果；不能当作当前候选的快速安全部署。现有 255 PostgreSQL 发布测试在 `packages/persistence/src/scoped-brand-settings.release.postgres.test.ts:19-42,75-115` 从 254 升到 255 后才验证四层持久化、CAS、跨租户拒绝与 RLS；它没有证明 254 的替代实现。

## 当前发布判断

- **无迁移 + 当前 255 候选 + 全部品牌层级功能：NO-GO。** 254 桥接运行时有意 fail-closed，普通运行时因迁移落后失去健康状态。
- 保持 254 时可继续验证/修复不依赖 255 的旧功能，但不得把新品牌层级功能、两份 Excel 上传或全部插件工具宣称通过。
- 本审计是源代码/测试的只读推导；生产数据库版本、运行容器、ChatGPT App 实际调用与发布签名必须由 owner 在发布时再次实测。用户要求不迁移数据库，因此本审计不建议擅自执行 255。
