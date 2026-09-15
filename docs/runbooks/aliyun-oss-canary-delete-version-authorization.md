# OSS canary 历史版本清理授权

## 目的

Store Nova 的对象存储 canary 会在版本控制已启用的 Bucket 中写入随机探针，并使用 `PutObject` 返回的精确 `VersionId` 清理该版本。现有 `StoreNovaOssBucketAccess` 已覆盖业务对象读写和普通删除，但精确版本清理还需要 `oss:DeleteObjectVersion`。

此授权只允许删除以下隔离前缀内的对象版本：

```text
oss://codex-image-20260914/merchant-assets/canary/*
```

它不允许删除 `merchant-assets/` 下的普通业务对象版本，也不增加 Bucket 管理、策略管理或跨 Bucket 权限。

## 最小变更

将 [StoreNovaOssBucketAccess.delete-version.patch.json](../../../infra/aliyun/ram/StoreNovaOssBucketAccess.delete-version.patch.json) 中唯一的 Statement 合并到现有自定义策略 `StoreNovaOssBucketAccess` 的 `Statement` 数组。

不要直接使用该文件替换整个云端策略：仓库没有保存当前云端策略全文，整份覆盖可能误删原有 List、Get、Put、普通 Delete 和分片上传权限。

合并后的新增 Statement 必须保持为：

```json
{
  "Effect": "Allow",
  "Action": ["oss:DeleteObjectVersion"],
  "Resource": [
    "acs:oss:*:1600188311395090:codex-image-20260914/merchant-assets/canary/*"
  ]
}
```

## 控制台操作

1. 登录阿里云 RAM 控制台，进入“权限管理 → 权限策略”。
2. 打开自定义策略 `StoreNovaOssBucketAccess`，先复制并保存当前策略正文作为可回滚版本。
3. 编辑策略，在现有 `Statement` 数组末尾添加上述 Statement；不要修改其他 Statement。
4. 保存后确认角色 `StoreNovaEcsOssRole` 仍只绑定预期策略。
5. 在 ECS 上运行对象存储 canary。成功证据必须同时包含 `put`、`head`、`get_hash`、`encryption`、`delete` 五项 `passed`。

## 验收与回滚

- 正向：canary 对 `merchant-assets/canary/<release>/<uuid>/probe.bin` 的精确版本删除成功。
- 负向：不得把资源扩大成 `merchant-assets/*`、Bucket 全路径或 `*`。
- 负向：不得新增 `oss:*`、`oss:DeleteObject` 或策略管理权限来代替这一权限。
- 回滚：恢复第 2 步保存的原策略正文；随后停止 canary，避免继续产生无法清理的探针版本。

代码中的 canary 在缺少 `VersionId` 时会 fail-closed，不会执行无版本号删除并制造 Delete Marker。
