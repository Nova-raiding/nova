# 254→255 隔离 PG17 预演（不授权生产发布）

此流程使用当前公网 demo PG16/254 的**签名备份四件套**，在 101 本机新建内部 Docker 网络、独立卷和 PG17 容器，恢复 254 后只在该隔离库执行迁移 255。预演计划明确写入 `purpose=isolated_preview` 和 `production_deploy_authorized=false`；当前公网版本不会因此被标成已上线的 254/255 桥。

## 101 已完成的隔离预演（2026-09-28，只读复核结果）

- attempt `demo25410e85c90eb03673d85495fec` 的已签名计划于 `2026-09-28T05:38:20Z` 创建，绑定备份 SHA-256 `6c87e4c96591310c83a624714caedbcd373c5c95fc1ee4dcfc47ed063cb94510`、254 前缀 `26be57bbd61771707ace0eb6626d110094bedeef7eeb829b24e8d083ac0fb847`、255 前缀 `2239556dd8bb6064596a2c57808d086ba6f6a160c39d52aa33c227f24351500b`、迁移 SQL SHA-256 `3ca08679671e6d427308f19594a987d157efa33639d461cd84339d703ab0c279` 和本机 PG17 image ID `sha256:79bd7c99e923138f136f8009d6bffa66e21e9d4fda5c0c561b00fc9c90cfe537`。计划有效期至 `2026-09-29T05:35:42.526Z`。
- `/var/lib/merchant-release-security/preview-restores/demo25410e85c90eb03673d85495fec-isolated-255.json` 报告 `status=pass`、`simulated=false`，恢复与迁移前缀摘要均匹配计划；我用受保护的生产公钥重新验证了计划和结果两份 Ed25519 签名、key ID、attempt、备份/SQL/镜像及前后缀绑定。
- 只读 Docker inspect 确认 PG17 预演容器以 exit 0 结束，内部网络仍 `internal=true`，独立卷仍存在；未发布宿主端口，也未触碰公网 PG16 卷。容器/网络/卷身份记录在签名结果中。
- 此结果只证明这个**旧 `f48c8454` 源备份**可恢复并应用所绑定的 255 SQL。当前 API 已变为 `bb417660`，服务版本仍混杂；该预演不证明双前缀 API/worker、业务/MCP canary、生产 journal/fence/恢复状态机或切流可用，`production_deploy_authorized=false`，生产仍 **NO-GO**。

## 前置证据

- 已固定安装并核验 `attest-demo-254-frozen-plan`、`attest-demo-254-backup`、`ecs-bridge-255-isolated-runner` 的受保护摘要；签名 trust anchor、私钥和安装目录均由 root 持有。
- 已生成 `/run/release-security/evidence-trust/production-demo-254-backup-source-plan.json` 和同一 attempt 的 `before-upgrade-254.dump`、`.attestation.json`、`.capture.json`；dump 来自当前公网 demo 源，而非旧 `merchant-production` 的 242 源。
- 将经审查的 `255_scoped_brand_settings.sql` 放在 `/var/lib/merchant-release-security/bridge-255/<attempt-id>/`，目录和文件均为 root 所有且不可被其他用户写入；在本机固定并核对 PG17 镜像 ID `sha256:...`。
- 下列参数化命令是可复核的操作模板；上方记录的 attempt 已在 101 完成。不要用模板重新创建同 attempt 或覆盖现存计划/结果。若重做，必须使用新的 attempt 与全新输出路径；`--created-at` 在 `inspect` 和 `sign` 中使用相同 UTC 值，且仍在一小时内。

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
