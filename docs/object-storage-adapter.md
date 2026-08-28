# 素材对象存储最小闭环

## 当前状态

`packages/storage` 提供了独立的 `ObjectStoragePort`、`LocalObjectStorage` 和 transport 注入式 `S3CompatibleObjectStorage`。后者不绑定云厂商 SDK，部署时可接入 S3/OSS/COS/MinIO 的签名 transport；它本身不代表云 bucket、KMS、扫描器或生产 canary 已配置。

当前闭环为：

1. 应用以 `workspaceId + assetId + fileName` 上传二进制。
2. 适配层计算并校验 SHA-256、大小和 MIME 类型，将对象写入 `quarantine/<workspace>/<asset>/<file>`。
3. 隔离区默认不能读取；只有外部扫描器提供非空 `scanEvidenceRef`，才能转入 `clean/<workspace>/<asset>/<file>`。
4. clean 对象读取时再次校验文件大小和 SHA-256；删除、租户范围和路径均经过校验。

## 安全约束

- 本地 root 必须为绝对路径；对象 key 禁止绝对路径、反斜杠、`.`、`..`、跨 workspace 和符号链接路径组件。
- 默认单对象上限 50 MiB，与现有素材元数据校验一致。
- 临时文件使用同目录 `wx` 创建，写入并 `fsync` 后 rename；对象和元数据文件权限为 `0600`，目录为 `0700`。
- `.meta.json` 只保存对象校验和、MIME、租户、区域及扫描证据引用，不保存访问令牌或平台凭证。
- 适配层不执行病毒扫描，也不凭空把对象标记为 clean；`scanEvidenceRef` 只是外部扫描结果的审计引用。

## 与现有 API 的关系

API 已提供二进制上传、扫描晋级和 clean 下载路由；生产环境没有受管对象存储配置时 fail-closed。正确的接入顺序是：

```text
upload bytes -> ObjectStoragePort.putQuarantine
             -> malware/rights scanner
             -> ObjectStoragePort.promoteClean(scanEvidenceRef)
             -> register asset metadata with returned clean key
```

在接入 API/Worker 前，必须让服务端只接受该 port 返回的 key，并将对象元数据登记与业务快照放在同一业务流程中；不能允许客户端任意伪造 clean key。

## 云适配器门槛

生产 API 已通过 AWS SDK 的 S3-compatible transport 装配 `S3CompatibleObjectStorage`。需要注入 `ASSET_STORAGE_BUCKET`、`ASSET_STORAGE_REGION`、HTTPS `ASSET_STORAGE_ENDPOINT`、`ASSET_STORAGE_KMS_KEY_ID`（以及云 workload identity 或默认 credential chain）；缺少任一项时 fail-closed。生产渲染配置还必须声明对象版本化、生命周期策略引用、隔离区至少 7 天保留、clean 对象至少 30 天保留、删除请求 7-30 天宽限期和告警通道引用。仍需在真实云 bucket 上验证私有 bucket、短时 signed URL、workspace 前缀策略、生命周期/隔离区清理、版本化/删除保护、访问审计、病毒扫描回调和恢复演练，并完成真实云 canary。

## 验证

```bash
npx vitest run packages/storage/src/object-storage.test.ts --no-file-parallelism
npm run typecheck
```

测试覆盖上传、SHA/大小校验、隔离区读保护、扫描证据转正、跨租户拒绝、路径穿越、重复 key、对象篡改检测和临时目录清理。
