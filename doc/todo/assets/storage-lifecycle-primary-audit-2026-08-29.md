# 商品、素材与生成视频存储生命周期主审

审计日期：2026-08-29

## 真实边界

### PostgreSQL

- 商品、任务、内容版本、发布任务、素材和生成任务的事实恢复入口是 `business_entity_snapshots` 及对应的规范化投影。
- 素材二进制不写入 PostgreSQL；asset snapshot 保存 `storageKey`、SHA-256、大小、MIME、扫描状态、revision、权益和解析事实。
- `product_asset_bindings`（070/072）只保存商品与素材的同工作区关系。072 通过 `business_entity_snapshots(entity_type='asset')` 校验引用存在和租户范围，不能证明对象存储本体存在。
- 生成图片候选归档到对象存储，并在 `image_generation_jobs.outputs` 保存对象 key、摘要、大小、MIME 和 archive state。
- 视频 rendering 当前以生成事件/供应商结果持久化；代码没有把供应商视频自动归档为 clean asset。`provider_job_id` 或供应商返回的结果不能当作本地/云对象备份。

### 对象存储

- 上传路径：`quarantine/<workspace>/<asset>/<file>`。
- 只有带外部 `scanEvidenceRef` 的 promote 才能生成 `clean/<workspace>/<asset>/<file>`；默认不允许读取 quarantine。
- LocalObjectStorage 只用于开发、CI 和明确的 `local_acceptance` 专用持久卷；生产默认要求 HTTPS S3-compatible endpoint、bucket、region、KMS、版本化、公有访问关闭和扫描证据。
- 每个对象旁边保存受保护的 metadata，读取时重新校验大小和 SHA-256。对象 key 必须包含工作区，禁止路径穿越和符号链接。
- 上传/归档在元数据或业务快照写入失败时执行补偿删除；补偿失败登记 `object_storage_orphans`，由清理 worker 重试，达到上限转 `manual_attention`。

## 已补的确定性漏洞

云对象删除此前把 body 或 metadata 已被删除的 404 当作失败，导致“删除已完成但仍不断重试”的孤儿不收敛。现在 `S3CompatibleObjectStorage.delete()` 对 body、metadata 分别执行删除：任一对象已不存在视为幂等成功，但另一份仍继续清理；真实 provider outage 仍返回失败并保留重试语义。

回归测试在 `packages/storage/src/object-storage.test.ts`，使用完全内存 mock transport，不使用云凭据。

新增 `packages/storage/src/archive-lifecycle-contract.ts` 作为恢复声明契约：asset、generated image、generated video 都必须同时提供 workspace-scoped `clean/quarantine` object key、SHA-256、大小和正数 revision；只有 provider job、URL 或 `fixture://` 不能被声明为可恢复。该契约目前作为 release/恢复验收门禁，视频仍需真正归档到对象存储后才能通过。

2026-08-31 增量：API `archiveCompletedVideo` 已将该契约接入视频 provider 完成后的隔离对象写入路径；若对象 key、摘要、大小或 revision 不满足合同，则不持久化 `asset.video_quarantined`，结果保持失败并进入补偿清理。该代码路径已由视频 MCP HTTP 回归覆盖；这只证明本地归档边界，不替代真实云对象版本恢复、扫描晋级或生产 provider 证据。

## 删除与引用生命周期

- 商品素材解除绑定只影响 `product_asset_bindings`/兼容投影，不应立即删除共享 asset object；删除前必须检查反向引用、版本和交付包。
- asset snapshot 的删除/停用与对象删除不是同一事务。对象删除失败必须保留可审计的 orphan 记录，不能先伪造“已清理”状态。
- 当前对象适配层能够补偿上传和生成图片归档失败，但没有把“数据库 data-deletion 完成”自动等价为“所有对象版本已删除”。正式删除流程必须逐对象确认 clean/quarantine key、metadata key、版本/删除标记和引用数。
- 生成视频没有统一的对象归档、asset revision 和反向引用模型；如果产品要求重启后可下载、跨区域恢复或按素材删除，视频必须先归档为带 revision/hash 的 asset，再由交付包引用该 asset，而不是只保存供应商状态。

## 备份与恢复

Postgres schema/data dump 可以恢复商品、素材元数据、关系、生成任务和对象 key，但不能恢复二进制对象。对象存储需要独立验证：

1. versioning/delete protection 和生命周期策略存在；
2. quarantine、clean、metadata 三类对象均在备份范围；
3. 恢复顺序为对象清单/版本恢复，再使 asset snapshot 对外可读；
4. 使用 workspace、asset revision、SHA-256、大小和 MIME 做恢复抽样校验；
5. 恢复后对产品反向引用、候选图和视频交付包做可读性检查；
6. 失败对象进入 orphan/manual-attention 队列并产生告警。

`pg_dump/pg_restore` 只能作为数据库连续性证据，不能被称为完整素材恢复证据。当前真实云 bucket、KMS、生命周期、版本恢复和视频归档仍需部署环境提供外部证据；本地 fixture 不替代该证据。

## 可执行验证

```bash
npx vitest run --root . packages/storage/src/object-storage.test.ts --no-file-parallelism
npx vitest run --root . packages/workers/src/object-orphan-cleaner.test.ts
npx vitest run --root . packages/persistence/src/migration-070-072-release.postgres.test.ts packages/persistence/src/migration-073-release.postgres.test.ts
```

Postgres release test 只有在显式设置 `PERSISTENCE_RELEASE_DATABASE_URL` 时运行；缺少该变量会跳过，不会猜测或读取未知数据库凭据。云对象存储只允许通过无凭据的 transport contract/mock 测试，真实云 canary 需由部署方单独授权。

## 上线验收条件

- Postgres fresh、069/072/073 upgrade、幂等、RLS 和 `merchant_ops` 隔离 release verifier 全部通过且无 skipped。
- asset 的 quarantine→clean、SHA/大小校验、版本/删除保护、共享引用和 orphan 补偿均有证据。
- 生成视频若承诺可恢复/可下载，必须存在对象归档和 asset revision；仅有 provider job/status 不达标。
- 完成一次 Postgres + 对象存储联合恢复演练，并验证商品→素材→候选/视频→交付包反向引用。
- 生产禁止使用默认本地目录、模拟 provider、fixture 对象或未知凭据作为完成证明。
