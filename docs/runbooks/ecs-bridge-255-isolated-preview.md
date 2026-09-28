# 254→255 隔离 PG17 预演（不授权生产发布）

此流程使用当前公网 demo PG16/254 的**签名备份四件套**，在 101 本机新建内部 Docker 网络、独立卷和 PG17 容器，恢复 254 后只在该隔离库执行迁移 255。预演计划明确写入 `purpose=isolated_preview` 和 `production_deploy_authorized=false`；当前公网版本不会因此被标成已上线的 254/255 桥。

## 前置证据

- 已固定安装并核验 `attest-demo-254-frozen-plan`、`attest-demo-254-backup`、`ecs-bridge-255-isolated-runner` 的受保护摘要；签名 trust anchor、私钥和安装目录均由 root 持有。
- 已生成 `/run/release-security/evidence-trust/production-demo-254-backup-source-plan.json` 和同一 attempt 的 `before-upgrade-254.dump`、`.attestation.json`、`.capture.json`；dump 来自当前公网 demo 源，而非旧 `merchant-production` 的 242 源。
- 将经审查的 `255_scoped_brand_settings.sql` 放在 `/var/lib/merchant-release-security/bridge-255/<attempt-id>/`，目录和文件均为 root 所有且不可被其他用户写入；在本机固定并核对 PG17 镜像 ID `sha256:...`。
- 下面命令只供审查，**尚未在 101 执行**。`<...>` 应替换为同一个已冻结 attempt 的实际值。`--created-at` 在 `inspect` 和 `sign` 中使用相同的 UTC 值，必须仍在一小时内。

## 只读检查与签名

`inspect` 只读取受保护文件并执行 `docker image inspect`。它会打印预演计划摘要，不创建容器或写数据库。

```sh
sudo /usr/local/libexec/merchant/ecs-bridge-255-isolated-runner inspect \
  --attempt-id '<attempt-id>' --pg17-image-id 'sha256:<pg17-image-id>' \
  --created-at '<YYYY-MM-DDTHH:MM:SS.mmmZ>' \
  --backup '/var/lib/merchant-release-security/backups/<source-release-id>-demo254-<attempt-id>/before-upgrade-254.dump' \
  --attestation '/var/lib/merchant-release-security/backups/<source-release-id>-demo254-<attempt-id>/before-upgrade-254.dump.attestation.json' \
  --capture '/var/lib/merchant-release-security/backups/<source-release-id>-demo254-<attempt-id>/before-upgrade-254.dump.capture.json' \
  --migration-255 '/var/lib/merchant-release-security/bridge-255/<attempt-id>/255_scoped_brand_settings.sql' \
  --output '/var/lib/merchant-release-security/preview-restores/<attempt-id>-isolated-255.json'
```

独立复核 `plan_sha256`、公网 254 源和 255 SQL 字节后，`sign` 使用完全相同的参数，并追加 `--approved-plan-sha256 '<inspect-result>'`。它只以独占方式写入 root 保护的 `/run/release-security/evidence-trust/production-bridge-255-isolated-preview-plan.json`；任何内容漂移会使摘要或签名检查失败。

```sh
sudo /usr/local/libexec/merchant/ecs-bridge-255-isolated-runner sign \
  --attempt-id '<attempt-id>' --pg17-image-id 'sha256:<pg17-image-id>' \
  --created-at '<与 inspect 相同的 UTC 值>' \
  --backup '/var/lib/merchant-release-security/backups/<source-release-id>-demo254-<attempt-id>/before-upgrade-254.dump' \
  --attestation '/var/lib/merchant-release-security/backups/<source-release-id>-demo254-<attempt-id>/before-upgrade-254.dump.attestation.json' \
  --capture '/var/lib/merchant-release-security/backups/<source-release-id>-demo254-<attempt-id>/before-upgrade-254.dump.capture.json' \
  --migration-255 '/var/lib/merchant-release-security/bridge-255/<attempt-id>/255_scoped_brand_settings.sql' \
  --output '/var/lib/merchant-release-security/preview-restores/<attempt-id>-isolated-255.json' \
  --approved-plan-sha256 '<inspect 返回的 plan_sha256>'
```

## 隔离运行与副作用

在同一受保护输入仍有效时，运行命令只接受以下五组路径参数：

```sh
sudo /usr/local/libexec/merchant/ecs-bridge-255-isolated-runner \
  --backup '/var/lib/merchant-release-security/backups/<source-release-id>-demo254-<attempt-id>/before-upgrade-254.dump' \
  --attestation '/var/lib/merchant-release-security/backups/<source-release-id>-demo254-<attempt-id>/before-upgrade-254.dump.attestation.json' \
  --capture '/var/lib/merchant-release-security/backups/<source-release-id>-demo254-<attempt-id>/before-upgrade-254.dump.capture.json' \
  --migration-255 '/var/lib/merchant-release-security/bridge-255/<attempt-id>/255_scoped_brand_settings.sql' \
  --output '/var/lib/merchant-release-security/preview-restores/<attempt-id>-isolated-255.json'
```

运行会：

1. 验证签名计划、254 备份 attestation/capture、实际 dump SHA、255 SQL SHA 与本机 PG17 镜像 ID。
2. 新建 `merchant_restore_net_<随机值>` **内部网络**、`merchant_restore_data_<随机值>` **独立卷**、`merchant_restore_pg_<随机值>` PG17 容器；不发布宿主端口、不挂载公网 PG16 卷。
3. 在隔离 PG17 中恢复 dump，校验完整 1–254 历史，事务内仅执行冻结的 255 SQL，再校验完整 1–255 历史。
4. 以 root 0600 独占写入 `/var/lib/merchant-release-security/preview-restores/<attempt-id>-isolated-255.json`。失败时停止隔离容器，保留内部网络和独立卷供调查。

此入口没有生产锁、nonce 消费、签名切换 journal、网关 fence 或切流操作；预演签名结果不能替代生产转移状态机和真实双前缀 API/worker/ChatGPT 验收。生产发布继续 **NO-GO**。
