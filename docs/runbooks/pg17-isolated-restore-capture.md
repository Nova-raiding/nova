# PG17 隔离恢复原始记录（不等于上线 restore evidence）

`infra/protected/restore-pg17-isolated.mjs` 只负责把一份已签名的生产 242 备份恢复到新的 PG17 内部 Docker 网络和独立卷，运行候选归档中固定的迁移脚本至 244，并留下机器可复核的 JSON 原始记录。它不会连接或修改生产数据库，不会签发 `tests/production-evidence-gate.ts` 所需的最终 restore evidence，也不替代数据完整性或 API/worker/ChatGPT 插件烟测。

安装前必须独立评审源文件与 SHA，使用 `install-ecs-release-controls.mjs --control restore` 安装至固定 root-only 路径。执行时提供如下全部参数，不能通过环境变量或可替换 hook 指向迁移、验签或 Docker 脚本：

```text
/usr/local/libexec/merchant/restore-pg17-isolated \
  --backup /var/lib/merchant-release-security/backups/<release>-attempt-<id>/before-upgrade-242.dump \
  --attestation /var/lib/merchant-release-security/backups/<release>-attempt-<id>/before-upgrade-242.dump.attestation.json \
  --candidate-root <已验证且 root 持有的独立候选目录> \
  --eight-image-set <受保护的 eight-image-set.json> \
  --image-digests <受保护的 image-digests.json> \
  --rendered-compose <受保护的冻结 Compose YAML> \
  --release-id <release> --git-sha <40 位 SHA> \
  --image-set-digest sha256:<64 位 SHA> --manifest-sha256 <64 位 SHA> \
  --deployment-nonce <已冻结发布 nonce>
```

所有输入路径必须是无符号链接、root 持有且不可被组/其他用户写入。执行器仅接受签名的 v2 备份，核对导出快照哈希与备份开始、快照观察、dump 完成的时间链；同时复核候选归档 SHA 和内嵌 Git commit、242 版本、八镜像集合、Compose 规范化哈希。它只从已验证候选归档提取 `/migrations`、`apply-migrations.sh` 与 Compose 校验器；不接收任意脚本或 `/bin/true` hook。Postgres 容器无端口映射，网络 `internal=true`，仅挂一个新建 Docker 卷。成功 JSON 包含容器、网络、镜像、卷、数据库身份哈希、迁移前后前缀及 244 行链的哈希；发布 nonce 仅记录 SHA-256，不保留原文。失败 JSON 的 `status=fail` 永远不能用于上线。

每次尝试生成随机数据库密码。Docker 命令行只传环境变量名，明文仅在 root 执行器及其短暂 Docker 子进程环境中；不写入 JSON 记录或日志。Docker 管理权限等同于主机高权限，具备该权限者仍可检查运行容器环境。运行成功后隔离容器和卷保留，供独立验收；失败后仅移除该次隔离容器和网络，卷保留以便排查。后续清理必须先确认 JSON 中的 ID 与 Docker 实际身份，不能使用广域 `docker system prune` 或删除生产卷。最终生产 restore evidence 仍须独立验证数据完整性和真实 API/worker/插件工作流后，由另一个受保护签名器出具。本脚本的本地单元测试不是生产恢复证据；在 101 上首次运行前还需受控实机演练和执行者审查。
