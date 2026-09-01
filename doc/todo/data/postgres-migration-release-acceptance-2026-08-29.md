# PostgreSQL migration and storage release acceptance

审计日期：2026-08-29

## 2026-08-31 canonical backfill run control increment

Migration 101 adds `canonical_backfill_runs`: a workspace-scoped durable state projection for bounded canonical backfill batches. It records planned/running/paused/completed/failed status, dry-run mode, stable product cursor, last result snapshot, actor/reason and an optimistic revision. The table is FORCE RLS and denies public access; action history remains in the append-only `workspace_operation_audit` ledger. Memory/PostgreSQL repositories, API/MCP lifecycle controls and stale-revision tests are implemented. Production execution and release evidence remain incomplete, so this increment does not move the canonical feature to done or change the production NO-GO conclusion.

Migration 102 adds `canonical_backfill_conflicts`: an idempotent workspace-scoped human-review queue. A backfill run enqueues each `(run, legacy product, conflict code)` once; operators can list, claim, resolve or dismiss items with revision CAS and a required resolution note. FORCE RLS and role grants are applied. This still does not prove production execution, conflict resolution completeness, or canonical cutover readiness.

本轮真实本地证据：在 Compose PostgreSQL 的随机临时数据库执行 `apps/api/src/migrate.ts`，输出 `applied=102`，查询 `schema_migrations` 得到 `max_version=102、migration_count=102`；临时数据库已自动清理，现有业务库未修改。

## 结论

- 当前可执行迁移链是 `001` 到 `100`。`070` 创建商品—素材关系，`071` 做运行时完整性，`072` 修复 source 投影同步和素材引用校验，`073`–`081` 依次补齐运营数据、模型 usage/context、canonical 回填索引、任务发布 scope、素材绑定、知识快照、存储配额和 reconciliation status；`082` 修复 hydration revision，`083` 补账务 actor 归属，`084`–`087` 补素材扫描凭证、尝试记录、可信 clean 回填和清理任务，`088`–`089` 补图片续跑租约与商家意图快照，`090`–`091` 隔离运营控制面并绑定 platform scope，`092`–`095` 补图片执行租约、对账游标和 append-only 权限，`096`–`097` 补 Provider 对账证据及未知错误约束，`098` 补 unified link audit，`099` 补 canonical→legacy 品牌完整性，`100` 补告警通知投递账本。
- 应用迁移入口是 `MigrationRunner`；本地 Compose 的 migrate 容器使用 `infra/scripts/apply-migrations.sh`。两者都按版本升序、使用 advisory lock、写入 `schema_migrations`，已应用版本会跳过。
- 数据库回滚不是 schema downgrade。`infra/scripts/rollback.sh` 明确只恢复此前已验证的运行镜像，并重新执行 release/canary 验证；迁移为 forward-only。
- Postgres 保存素材元数据快照和 `storage_key`，二进制位于 `ObjectStoragePort` 后面的本地目录或 S3-compatible 对象存储。070/072 能证明关系指向同工作区的 asset snapshot，但不能单独证明对象存储中的对象仍存在、未被篡改或可恢复。
- 真实 PostgreSQL release 测试默认 fail-closed：只有显式提供 `PERSISTENCE_RELEASE_DATABASE_URL` 才创建临时数据库；不会读取、猜测或复用未知凭据。

## 当前运行路径

### 应用迁移

`packages/persistence/src/migration.ts` 的 `loadMigrations()` 显式加载并返回 001—100。`MigrationRunner`：

1. 获取 session advisory lock `731942851`。
2. 创建 `schema_migrations`，读取已应用版本；完整发布链会拒绝未知版本和非连续历史，过滤片段仅用于隔离升级测试/受控修复。
3. 对未应用迁移按版本升序执行，并在成功后登记版本和名称。
4. 对普通迁移使用事务；60、62 这类 `transactional: false` 迁移按顶层 SQL 语句执行，再单独登记版本。已登记版本会校验 name 与 SHA-256 checksum，旧库缺失 checksum 时只做一次兼容回填。
5. 出错时回滚当前事务并释放 advisory lock。

### 本地/容器迁移

`infra/scripts/apply-migrations.sh` 从 `/migrations/[0-9][0-9][0-9]_*.sql` 读取物理文件，按文件名版本执行；执行前拒绝未知版本和历史缺口。普通迁移包在 `BEGIN`/`COMMIT` 中，并使用 `pg_advisory_xact_lock(731942851)`；标记为 `-- migrate:no-transaction` 的迁移使用 session lock。Compose 的 `migrate` 服务在 API/worker 之前运行，并挂载 `packages/persistence/src/migrations` 为只读目录。

发布验收必须同时确认这两个入口使用的文件集合一致；应用 runner 和容器脚本的链尾当前均为 100。

## 真实 release verifier

已有以下可执行 verifier：

- `packages/persistence/src/migration-069-release.postgres.test.ts`：fresh、068→069、幂等、RLS/ACL、`pg_dump`/`pg_restore` schema 恢复、CAS 并发。
- `packages/persistence/src/migration-070-072-release.postgres.test.ts`：fresh、069→072、幂等、坏 `sourceAssetIds`、disabled/curated role 保留、非法素材引用拒绝和强制 RLS。
- `packages/persistence/src/migration-073-release.postgres.test.ts`：fresh、072→073、幂等、空状态、平台读取、租户写入、ACL。
- `packages/persistence/src/migration-074-release.postgres.test.ts`：fresh、073→074、`schema_migrations` 统计、历史 metadata 回填、context/action 外键拒绝、RLS/forced RLS 和幂等。
- `packages/persistence/src/migration-077-release.postgres.test.ts`：固定执行到 077，验证 canonical/listing/platform/account scope 触发器。
- `packages/persistence/src/migration-078-release.postgres.test.ts`：fresh 001→078、077→078、幂等、历史回填、后到达素材触发器和跨工作区隔离。
- `packages/persistence/src/migration-079-release.postgres.test.ts`：固定截断到 079，验证知识 hydration 快照的 fresh、幂等、非超级用户 RLS 和 CAS。
- `packages/persistence/src/migration-080.test.ts`：只做 080 SQL 静态结构、约束和 RLS 声明检查，不是实际 PostgreSQL 执行证据。
- `packages/persistence/src/storage-quota-repository.postgres.test.ts`：可在 `STORAGE_QUOTA_DATABASE_URL` 下执行到链尾并验证并发预留与 settle 幂等；当前 CI 已提供该环境变量并显式运行该文件，但本轮没有 CI run artifact，因此不能把它登记为本轮或生产 verifier 已通过。
- `packages/persistence/src/migration-081-release.postgres.test.ts`：CI 已显式运行 081 的非超级用户、RLS、幂等验收；同样必须以具体 CI run artifact 作为正式证据。
- `packages/persistence/src/migration-100.test.ts`：静态检查 082–100 的迁移登记、关键 SQL、权限/约束和链尾契约；不替代真实 PostgreSQL release verifier。

只在明确授权的临时或验收 PostgreSQL 上运行：

```bash
PERSISTENCE_RELEASE_DATABASE_URL='postgres://USER:PASSWORD@HOST:PORT/DB' \
  npx vitest run --root . \
  packages/persistence/src/migration-069-release.postgres.test.ts \
  packages/persistence/src/migration-070-072-release.postgres.test.ts \
  packages/persistence/src/migration-073-release.postgres.test.ts \
  packages/persistence/src/migration-074-release.postgres.test.ts \
  packages/persistence/src/migration-077-release.postgres.test.ts \
  packages/persistence/src/migration-078-release.postgres.test.ts \
  packages/persistence/src/migration-079-release.postgres.test.ts
```

测试会创建随机命名的临时数据库和必要的临时角色，并在 `finally` 中终止连接、删除临时数据库和角色。没有 `PERSISTENCE_RELEASE_DATABASE_URL` 时测试跳过，不会改动本地或生产数据库。

静态/无数据库回归可安全执行：

```bash
npx vitest run --root . packages/persistence/src/*migration*.test.ts
npx vitest run --root . packages/storage/src/object-storage.test.ts --no-file-parallelism
```

## RLS 和连续性边界

- `business_entity_snapshots` 与 `product_asset_bindings` 均启用并强制 RLS；关系表按 `app.workspace_id` 隔离。
- 072 的校验触发器要求 `(workspace_id, entity_type='asset', entity_id=asset_id)` 的快照存在，并以 `23503` 拒绝不存在或跨租户素材 ID。
- `sourceAssetIds` 是兼容投影，不是唯一事实源。072 将非法 JSON 视为空数组，只禁用缺失的 active source；人工维护的 `main/secondary/detail` 和 disabled 状态保留。
- 数据库 dump/restore 只能恢复 Postgres schema 和行数据，不能恢复本地对象目录或云 bucket 中的二进制对象。

## 对象存储引用边界

当前上传闭环是 `quarantine object → 外部扫描 → clean object → 注册 asset metadata/snapshot`。元数据中记录 `storage_key`、大小、SHA-256、MIME 和扫描证据引用；对象本体由本地 durable storage 或 S3-compatible storage 保存。

因此上线验收不能只检查 `product_asset_bindings`：还必须针对同一批 asset revision 验证 clean key 存在、workspace 前缀正确、SHA/大小匹配、删除/补偿记录可追踪，以及恢复时先恢复对象再恢复可读的 asset metadata。当前真实云 bucket 的版本化、生命周期、删除保护、扫描回调和恢复演练仍属于部署门禁，不能由 Postgres migration verifier 代替。

## 上线验收条件

1. 在授权临时 PostgreSQL 上全部 release verifier 通过，且没有 skipped 的 release test。
2. fresh install 的 `schema_migrations` 恰为 001—100；099→100 只应用 100；重复运行返回空数组。该项必须由真实 PostgreSQL verifier 证明，静态 SQL 测试不能替代。
3. 验证 RLS、forced RLS、跨工作区读取为空、跨工作区 asset binding 写入失败，并确认应用角色没有绕过 RLS 的权限。
4. 完成一次 schema-only dump/restore 指纹比对；另行完成对象存储对象清单、SHA、版本和恢复演练，不能把 schema restore 当作完整素材恢复。
5. rollback 只执行已签名运行包回滚，不执行迁移降级；回滚后重新通过 release、数据库健康和对象读取 canary。
6. 生产对象存储配置、生命周期、版本化、KMS、扫描器和告警均由受管配置提供；缺失配置必须 fail-closed。

## 2026-08-31 当前复核

- 迁移/回填定向回归：22 个测试文件、45 项通过、5 项跳过；类型检查与 `git diff --check` 通过。
- release gates：57 个测试文件通过、1 个跳过；323 项通过、6 项跳过。输出中的 container source manifest 失败行属于测试内置负向断言，不是测试失败。
- 当前 CodeGraph：781 files / 10,912 nodes / 40,650 edges；代码索引已同步，文档类变更可能仍显示为 pending。
- 本轮没有获得真实 `PERSISTENCE_RELEASE_DATABASE_URL`、非超级用户 PostgreSQL/RLS/CAS、PITR 或生产发布 artifact，因此本文件继续保持 `TODO / NO-GO`，不迁移到 `doc/done`。

## 2026-08-31 本地真实 PostgreSQL 迁移链补充证据

- 在本地 Compose PostgreSQL 上以随机临时数据库执行 `packages/persistence/src/migration-integrity-release.postgres.test.ts`，结果为 1 个文件、1 项通过；测试完成后已清理临时数据库，未触碰现有业务库。
- 通过真实应用入口 `apps/api/src/migrate.ts` 在同一 PostgreSQL 实例的另一随机临时数据库执行完整迁移链，输出 `applied=100`；随后查询 `schema_migrations` 得到 `max_version=100`、`migration_count=100`。
- 该证据确认当前本地应用迁移入口可从空库连续落到 100，但不替代生产大表迁移窗口、非超级用户 RLS/CAS、schema dump/restore、对象存储恢复、PITR、双副本和正式发布 artifact 验收；因此本文件仍为 `TODO / NO-GO`。
