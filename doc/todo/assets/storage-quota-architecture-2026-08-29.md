# Workspace 对象存储配额架构

状态：migration 080、内存/仓储代码与静态契约已实现；真实 PostgreSQL、对象存储和生产入口验收待完成

## 事实源边界

- 商品、SKU、任务、规则和账务事实进入 PostgreSQL。
- 原图、生成图、视频、PDF 和交付包进入私有对象存储。
- Redis 只保存短期租约、队列和缓存，不保存容量事实。
- 模型钱包/Token 账本只记录模型消耗，不承载文件容量。
- 本地 volume 仅用于开发、fixture、临时上传和预览缓存。

## 配额数据模型

每个 workspace 一个 `workspace_storage_quotas`，记录 `limit_bytes`、`reserved_bytes`、`used_bytes` 和 revision；每次文件写入在 `storage_quota_reservations` 建立唯一 reservation，当前持久化字段包括 workspace、reservation key、asset ID、预留字节、`actual_bytes` 和状态。对象 key、资源类型等上层关联信息不属于 080 表字段，必须由调用方在同一业务流程中绑定。

```text
reserved → settled
        ↘ released
```

支持的资源类型：`asset`、`image`、`video`、`deliverable`。历史对象不在迁移时盲目估算，必须通过独立 reconciliation 生成可审计的初始 used_bytes。

## 原子操作契约

### reserve

在 workspace 事务中锁定配额账户和 `(workspace_id, reservation_key)`：

1. 已有相同参数的 reservation 直接幂等返回。
2. 已有不同参数的 reservation 返回 `STORAGE_QUOTA_RESERVATION_CONFLICT`。
3. 检查 `used_bytes + reserved_bytes + requested_bytes <= limit_bytes`。
4. 插入 `reserved` 记录并增加 `reserved_bytes`。

超额返回 `STORAGE_QUOTA_EXCEEDED`，不得调用对象存储或模型 provider。

### settle

对象写入成功并通过 HEAD/hash/size 校验后，在同一 workspace 事务中：

```text
reserved_bytes -= reserved_bytes
used_bytes += actual_bytes
reservation = settled
reservation.actual_bytes = actual_bytes
```

`actual_bytes > reserved_bytes` 返回 `STORAGE_QUOTA_SETTLE_EXCEEDS_RESERVATION`，不自动突破上限。重复 settle 必须幂等，不能重复增加 used_bytes。

### release

只允许 `reserved → released`，并扣减 `reserved_bytes`。重复 release 幂等；`settled` 不允许被 release。对象写入失败、业务元数据失败或人工取消都必须释放 reservation。

## 对象写入时序

```text
reserve
  → put quarantine/temporary object
  → HEAD + SHA-256 + MIME + size 校验
  → 保存 Asset/Job 元数据
  → settle
```

跨系统无法做到真正两阶段提交，因此必须保留以下补偿路径：

- put 失败：release。
- 元数据保存失败：删除对象；删除失败登记 object orphan；reservation 保持可重试或人工处理。
- settle 失败：不伪造成功；保留 reservation 并进入可重试队列。
- orphan cleaner 成功删除对象后：幂等 release 或修正 reservation。
- 周期 reconciliation：按对象元数据与业务引用重新计算 used/reserved 差异，差异进入人工处理，不静默覆盖账本。

## 租户与权限

- 所有 quota 查询和变更必须通过 workspace-scoped transaction 和 RLS。
- 配额错误只返回 workspace 的已用量、上限、预留量和下一步，不暴露 bucket、endpoint、KMS 或对象 key 的敏感细节。
- platform_ops 只看脱敏汇总和告警；客户对象明细需受控支持授权。
- 对象 key 必须包含 workspace scope；跨 workspace 的 key、reservation 或 asset 直接拒绝。

## UI 状态

插件卡片显示：`已用 / 上限`、`预留中`、资源类型和下一步：

- 正常：允许上传/生成。
- 接近上限：显示容量告警，但不阻断已预留任务。
- 超额：显示“存储空间不足”，提供清理历史版本或联系管理员入口。
- 对账异常：显示“容量正在核对”，禁止新增对象写入，保留已有数据访问。

运营后台只显示按 workspace 的脱敏容量汇总、异常 reservation 数量和 reconciliation 状态，不提供客户对象下载或 bucket 管理。

## 迁移与上线

```text
expand 表、索引、RLS
→ 创建默认配额（不修改历史 used）
→ shadow 计量写入/删除
→ reconciliation 生成初始账本
→ feature flag 开启 reserve
→ 观察 orphan、settle 失败、并发和费用
→ cutover 后所有对象入口强制 quota
```

上传、图片生成、视频归档和交付包导出必须共享同一 quota repository，禁止各入口维护独立计数器。

## 验收清单

- 并发 reserve 不突破 workspace 配额。
- 相同 reservation key 幂等，不同参数冲突。
- release/settle 重试不会产生负数或重复计量。
- 对象写入成功但业务持久化失败时，orphan 与 reservation 可恢复。
- 删除、版本归档、clean/quarantine 晋级和恢复会正确结算。
- workspace A 无法读取或消耗 workspace B 配额。
- Local、Compose、CI PostgreSQL、真实 PostgreSQL 和真实对象存储证据分开记录。
- 配额异常不会改变模型 token 账本或钱包扣款结果。

当前实现状态：migration 080、`StorageQuotaRepository` 的 workspace reserve/settle/release、幂等和并发配额逻辑，以及静态/内存/CI PostgreSQL 测试入口已落地；对象写入全链路接入、真实 PostgreSQL 无 skipped 验收、真实对象存储对账和生产容量证据仍未完成，不能宣称云存储成本已在生产环境系统性控制。

## 2026-08-31 商家配额可见性增量

`asset.list` 现在在存在配额仓储时返回脱敏的 `storage_quota`：已用、预留、上限、可用空间和 `available/near_limit/over_limit` 状态；bridge 只映射这些商家可理解的字段，不暴露 bucket、endpoint、KMS、对象 key 或 workspace 内部标识。上传/生成归档仍由同一 quota repository 强制 reserve/settle，配额状态投影不改变账本。

该增量已完成代码和 bridge 契约验证。2026-08-31 使用 Compose PostgreSQL（admin `merchant` + RLS 应用角色 `merchant_app`）完成真实数据库并发 reserve、超额阻断、settle 幂等、物理删除后 release 和跨事务恢复测试，结果 1/1 passed、无 skipped；真实云对象存储、对账异常、多副本 PostgreSQL、PITR 和生产容量证据仍是外部门禁，本文件继续保留在 `doc/todo/assets`。
