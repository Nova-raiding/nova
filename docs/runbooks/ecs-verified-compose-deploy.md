# ECS Compose 受验证部署执行器

`infra/scripts/deploy-verified-ecs-compose.sh` 只在 ECS 宿主的已审查发布目录运行。它不建立 SSH 连接，也不会从开发机复制配置、密钥或生产证据。执行器依次绑定干净提交和 `candidate-identity.txt`、复制并校验 rendered Compose 与生产配置、运行完整 ECS preflight、保存现网容器状态、消费 deployment nonce、执行迁移、通过两个运行角色验证数据库已到候选完整迁移链、启动摘要固定的服务，最后核对 `/livez`、`/readyz`、`/releasez`、数据库支持的鉴权请求和生产 canary。

渲染器、部署器、回滚器、release control installer、受保护的 backup/bundle/preidentity 控制源码和 bundle verifier 必须同时出现在候选对比清单与 release manifest 的 SHA-256 artifacts 中。候选包里的完整 `candidate-source.tar` 以同一个 Git SHA 生成，因此也包含这些文件；任一文件缺失或字节变化都必须重新生成发布清单，不能沿用旧签名证据。

受保护控制只能从精确发布提交的已审查源码安装。安装时以 root 从空环境调用 `env -i /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node /srv/merchant-releases/RELEASE_ID/infra/scripts/install-ecs-release-controls.mjs`，并完整传入 `--control`、绝对 `--source`、`--source-sha256`、绝对 `--node` 和 `--node-sha256`；固定 runtime、安装顺序、backup source policy 和逐项命令见 evidence bundle attester runbook。仓库源码的 executable bit 不构成授权，安装器也不负责密钥、签名、部署或业务数据变更。

截至 2026-09-21，生产 backup 已完成独立验签，但独立 restore 验收尚未完成，因此不能据此宣称 restore gate 或整套 release gates 已通过。`tests/postgres-backup-attester-cli-e2e.sh` 是必须以 `bash` 显式执行的 shell runner，不加入 Vitest 列表。preidentity 使用 `tests/run-ecs-preidentity-isolated-cli.sh` 运行隔离 shell/FD9 演练，其中 Docker 与 `psql` 等依赖由 `tests/fixtures/ecs-preidentity-isolated/` 下的部分 stub 提供；它只证明受控 CLI 合同，明确不是 real recovery evidence，不能替代生产恢复或切流验收。

运行前必须由宿主发布控制面提供：

- 完整的 `deploy-preflight-ecs.sh` 环境变量和真实生产证据；
- `ECS_CANDIDATE_IDENTITY_PATH`，其 Git SHA 和源码归档摘要与当前干净提交一致；
- 绝对路径 `ECS_DEPLOY_STATE_DIR`，用于保留权限为 `0600` 的切换前状态；
- 由 root 预创建的绝对规范路径 `ECS_DEPLOY_LOCK_PATH`；部署和回退使用同一文件执行非阻塞 `flock`，Compose project 均使用 `ECS_COMPOSE_PROJECT`（默认 `merchant-production`）；
- 绝对路径 `ECS_ROLLBACK_ENTRYPOINT`。该程序必须由宿主独立配置，读取 `ECS_DEPLOY_STATE_PATH`，恢复状态文件记录的上一组不可变镜像和路由；
- `CONFIRM_ECS_DEPLOY=YES`、严格等于生产 API origin 的 `PRODUCTION_APPROVED_ORIGIN`，以及 canary 工作区和 bearer token。

示例只描述调用边界，路径和环境值必须来自 ECS 宿主的受保护配置：

```sh
CONFIRM_ECS_DEPLOY=YES \
ECS_CANDIDATE_IDENTITY_PATH=/opt/merchant-releases/candidate/candidate-identity.txt \
ECS_DEPLOY_STATE_DIR=/var/lib/merchant-release-security/deploy-state \
ECS_DEPLOY_LOCK_PATH=/var/lock/merchant/ecs-compose-mutation.lock \
ECS_ROLLBACK_ENTRYPOINT=/usr/local/libexec/merchant/rollback-ecs-compose \
RENDERED_COMPOSE_PATH=/opt/merchant-releases/candidate/rendered-compose.yml \
PRODUCTION_CONFIG_PATH=/etc/merchant/production.yml \
sh infra/scripts/deploy-verified-ecs-compose.sh
```

状态目录、锁文件、回退程序及其父目录必须由 root 管理，且不能被 group/other 写入。状态文件通过 `O_EXCL` 创建，已存在时拒绝覆盖。执行器在所有只读门禁通过后才消费 nonce，并在消费 nonce、迁移和 Compose 切换前重复校验冻结输入摘要。迁移或后续有界健康检查失败会释放部署锁，再自动调用使用同一把锁的回退入口，并把候选 release ID 和切换前状态文件路径传给它。回退程序失败时发布保持阻断，需要人工按状态文件恢复；禁止删除 nonce 账本后重试。

执行器不会运行 `docker compose down`、`down -v`、删除卷、清空数据库或删除对象存储数据。迁移必须保持向后兼容，因为应用回退不会逆向删除 schema。状态文件保留现网 Compose 容器和镜像信息，也是回退审计记录的一部分，不应在失败后清除。

发布成功的最低证据包括匹配候选的 `/releasez` 四元组、鉴权数据库请求和签名后的 production canary。仅有容器 `healthy` 不能判定上线完成。
