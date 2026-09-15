# ECS 候选包安全同步

此流程用于比较本地 OSS、授权和发布证据实现与 ECS 上的版本，生成供人工审查的候选包。它不负责部署，也不应直接覆盖现网目录。当前候选明确关闭告警，并排除 Kubernetes/ACK 配置。

## 生成候选包

```sh
sh infra/scripts/prepare-ecs-candidate-bundle.sh
```

产物包含文件清单、工作区状态、逐文件本地/远端 SHA-256、候选归档及归档摘要。脚本对 SSH 目标仅执行 `cd`、文件存在性判断和 `sha256sum`。

## 合并原则

- `review_required`：必须基于服务器文件进行三方合并，禁止整文件覆盖。
- `missing_remote`：确认是当前候选版本的新增文件后，才可放入隔离发布目录。
- `.env`、密钥、OAuth/支付凭据、告警 Webhook 密钥及签名私钥不得进入候选包。
- `docker-compose.ecs-pilot.yml` 在服务器上可能保留六平台连接器、Vault 和生产安全配置；本地版本不能直接替换它。
- OSS 切换使用第三层 `infra/local/docker-compose.ecs-oss-cutover.yml`，并按“基础 Compose → 服务器 ECS pilot overlay → OSS cutover overlay”的顺序渲染。该文件仅允许包含 `api`、`api-replica` 的存储、生命周期和配额字段，不修改服务器持有的六平台、Vault、支付和证据挂载。当前候选把 `ALERT_CHANNEL_SECRET_REF` 和 Webhook 配置锁为空值，不得使用 `--profile alerts`。
- 生产证据不得从开发机复制充数，必须绑定最终 release ID、Git SHA、镜像摘要、配置摘要和 deployment nonce，并由服务器信任边界签名。

## 切换前门禁

1. 在独立目录解包并完成三方合并。
2. 对合并结果运行类型检查、OSS/证据/生产配置测试及 `pilot-compose-preflight.sh`。
   合并后的 Compose 渲染命令必须显式把 OSS overlay 放在最后：

   ```sh
   docker compose --env-file .env \
     -f infra/local/docker-compose.yml \
     -f infra/local/docker-compose.ecs-pilot.yml \
     -f infra/local/docker-compose.ecs-oss-cutover.yml \
     config
   ```
3. 以旁路容器验证 `/healthz`、`/readyz`、RAM Role 临时凭证、OSS 写读删和持久管理员授权；当前候选不启动或验收告警投递。
4. 保存现网 Compose、镜像摘要和配置摘要作为回滚点。
5. 只有上述证据全部属于同一候选版本时，才能安排切换。
