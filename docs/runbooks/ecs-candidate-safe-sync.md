# ECS 候选包安全同步

此流程用于比较本地 OSS、授权和发布证据实现与 ECS 上的版本，生成供人工审查的候选包。它不负责部署，也不应直接覆盖现网目录。当前候选明确关闭告警，并排除 Kubernetes/ACK 配置。

## 生成候选包

发布不依赖 GitHub CLI、PR 或 GitHub 登录。候选包由本地 owner 生成后，通过 SSH/受控文件同步送到 `101`，再由 ECS 主机上的发布执行器完成 staging、preflight 和切换。

```sh
sh infra/scripts/prepare-ecs-candidate-bundle.sh
```

脚本只接受干净且已提交的工作树。产物包含远端比较文件清单、逐文件本地/远端 SHA-256、完整提交源码归档 `candidate-source.tar`、归档摘要及 `candidate-identity.txt`。身份文件绑定完整 Git SHA、源码归档 SHA-256、比较清单 SHA-256 和同步计划 SHA-256；其中源码摘要必须与候选门禁镜像的 `com.storenova.candidate.source_sha256` OCI 标签一致。脚本对 SSH 目标仅执行 `cd`、文件存在性判断和 `sha256sum`。

审核完成后，不得把归档覆盖解压到现有 checkout。先在 ECS 主机预创建仓库外、仅发布操作者可写的 releases 根目录，然后执行：

```sh
ECS_CANDIDATE_BUNDLE_DIR=/srv/release-candidates/<candidate> \
ECS_RELEASES_ROOT=/srv/merchant-releases \
RELEASE_ID=<release-id> \
sh infra/scripts/stage-verified-ecs-release.sh
```

staging 执行器会重新校验身份文件中源码归档、比较清单和同步计划的 SHA-256，并核对 Git archive 内嵌提交 SHA；含路径穿越、链接或特殊文件的归档会被拒绝。它只在 releases 根目录内创建随机临时目录，以 `npm ci --ignore-scripts` 从锁文件安装，保留只读的 `.candidate-source.tar` 和 `.candidate-identity` 供部署器重新核验，最后原子改名为全新的 release 目录。目标已存在时拒绝覆盖。生产 `.env`、密钥和运行时凭据不得进入候选包或 release checkout，仍由受保护的主机路径在渲染和部署阶段注入。

## 一键部署与磁盘上限

生产镜像、rendered Compose、回滚 capsule 和真实证据准备完毕后，在 ECS 宿主执行一条命令完成安全 staging、受验证切换、健康验收和成功后的空间回收：

```sh
ECS_CANDIDATE_BUNDLE_DIR=/srv/release-candidates/<candidate> \
ECS_RELEASES_ROOT=/srv/merchant-releases \
RELEASE_ID=<release-id> \
RENDERED_COMPOSE_PATH=/受保护路径/rendered-compose.json \
PRODUCTION_CONFIG_PATH=/etc/merchant/production.yml \
PRODUCTION_API_BASE_URL=https://yxsona.com/api \
sh infra/scripts/ecs-one-click-deploy.sh deploy
```

其余鉴权、数据库、证据、镜像摘要和回滚变量沿用 `deploy-verified-ecs-compose.sh` 的受保护宿主配置。自动化不降低任何发布门禁：只有部署器完整成功后才执行回收；失败候选保留用于诊断。默认保留最近 2 个完整 release 和最近 2 个经身份文件验证的 `/srv/release-candidates` 候选包，并自动保护线上 `/releasez` 返回的当前版本、回滚计划的目标版本、当前候选、含 `.keep` 标记的目录以及 `ECS_PROTECTED_RELEASE_IDS` 指定的版本。候选包用 `candidate-identity.txt` 的完整 Git SHA 与受保护 release/容器关联；未知目录保持不动。release 清理只接受 `.candidate-identity` 与目录名一致的目录。两类清理都拒绝符号链接，不触碰 Docker volume、数据库、对象存储和运行容器引用的镜像。

本机 Registry 必须单独治理。当前自动清理不会运行 `docker image prune`，也不会调用 Registry garbage collection，因为只按磁盘年龄删除 blob 会破坏摘要固定的线上或回滚镜像。先从现网容器、回滚计划与保留 release 的镜像清单生成受保护 digest 集，再通过启用 delete 的 Registry API 删除未保护 manifest，最后在停止写入的维护窗口运行 Registry GC；缺少完整 digest 集时只报告占用，不删除。

部署前可只读查看回收计划：

```sh
PRODUCTION_API_BASE_URL=https://yxsona.com/api \
ECS_RELEASES_ROOT=/srv/merchant-releases \
sh infra/scripts/ecs-one-click-deploy.sh report
```

单独执行清理时必须显式确认；脚本同时把 BuildKit 缓存限制为默认 2GB，但不自动删除任何镜像，避免误删离线回滚仍需的不可变镜像：

```sh
CONFIRM_ECS_STORAGE_CLEANUP=YES \
PRODUCTION_API_BASE_URL=https://yxsona.com/api \
ECS_RELEASES_ROOT=/srv/merchant-releases \
sh infra/scripts/ecs-one-click-deploy.sh cleanup
```

可用 `ECS_RELEASE_KEEP_COUNT`、`ECS_BUILD_CACHE_KEEP_STORAGE` 和 `ECS_BUILD_CACHE_UNTIL` 调整保留策略。生产推荐保持 `2`、`2GB`、`24h`，磁盘稳定占用约为两个完整 checkout（当前与回滚）加 2GB 构建缓存，不再随部署次数线性增长。

## 合并原则

- `review_required`：必须基于服务器文件进行三方合并，禁止整文件覆盖。
- `missing_remote`：确认是当前候选版本的新增文件后，才可放入隔离发布目录。
- `.env`、密钥、OAuth/支付凭据、告警 Webhook 密钥及签名私钥不得进入候选包。
- `docker-compose.ecs-pilot.yml` 在服务器上可能保留六平台连接器、Vault 和生产安全配置；本地版本不能直接替换它。
- 最终层顺序只由 `infra/local/ecs-production-compose.layers` 定义：基础 Compose → ECS pilot → OSS cutover → 生产迁移 → release identity。禁止加入开发用途的 `deploy/runtime/auth-hardening.yml`；最终渲染必须通过 `validate-ecs-production-compose.mjs` 的服务器生产安全校验。OSS overlay 仅包含 `api`、`api-replica` 的存储、生命周期和配额字段，不修改六平台、Vault、支付、证据或告警配置；当前候选不启用 `--profile alerts`。
- 生产证据不得从开发机复制充数，必须绑定最终 release ID、Git SHA、镜像摘要、配置摘要和 deployment nonce，并由服务器信任边界签名。

## 切换前门禁

ECS preflight 会以只读查询分别使用目标 `DATABASE_URL` 和 `OPS_DATABASE_URL` 核对 `schema_migrations`。迁移前允许数据库处于当前候选迁移链的任一不可变前缀：已应用版本必须从 1 连续、名称和 SQL SHA-256 与候选源码一致、不得出现候选之外的超前版本，且两个运行角色必须看到逐行完全相同的历史。随后才执行租户、Ops 的非 superuser／非 BYPASSRLS、表所有权、ACL 和动态 RLS 边界探针。任一凭据连接失败、历史缺口、角色视图差异、未知或超前版本、名称或 checksum 漂移都会阻断发布；不得通过修改生产迁移记录绕过门禁。

部署执行器消费 nonce 后使用固定摘要的 PostgreSQL 17 迁移镜像执行前向迁移；迁移命令成功并不足以切流。执行器必须再次通过 `DATABASE_URL` 和 `OPS_DATABASE_URL` 运行完整链校验，确认两个运行角色都精确包含 1 到 `EXPECTED_MIGRATION_VERSION` 的候选链，才允许重建 API、Worker、UI 或网关容器。完整链校验失败会在业务容器切换前中止并进入受保护回退流程；数据库仍遵循 forward-only 策略，不执行 schema downgrade。

1. 在独立目录解包并完成三方合并。
2. 对合并结果运行类型检查、OSS/证据/生产配置测试及 `pilot-compose-preflight.sh`。
   合并后的 Compose 必须通过清单驱动的唯一渲染入口生成；不得手写或重排 `-f` 参数：

   ```sh
   sh infra/scripts/render-ecs-production-compose.sh > /tmp/merchant-ecs-production-compose.json
   node infra/scripts/validate-ecs-production-compose.mjs /tmp/merchant-ecs-production-compose.json
   ```

   渲染前必须先备齐 release 层的八个固定镜像引用。`infra/local/docker-compose.ecs-pilot-release.yml` 以 `${VAR:?}` 强校验 `MIGRATION_IMAGE_REF`、`API_IMAGE_REF`、`WORKER_IMAGE_REF`、`UI_IMAGE_REF`、`OPS_UI_IMAGE_REF`、`PAYMENT_GATEWAY_IMAGE_REF`、`PILOT_GATEWAY_IMAGE_REF`、`CLAMAV_IMAGE_REF`；渲染器用 `--env-file .env` 读取，缺任一项都会非零退出，而 Compose 最多报告 91 条插值错误，base 层的错误会掩盖 release 层自己的那条。这八个变量的生产者是 `infra/scripts/deploy-preflight-ecs.sh` 的必需清单与 `.env.example` 模板，两者缺一不可。同一条规则覆盖全部五个层（`infra/local/ecs-production-compose.layers`）：任一层里被 `${VAR:?}` 强校验的变量都必须同时出现在这两处，否则 `render-ecs-production-compose.sh` 会在 base 层就非零退出。闭环由 `tests/ecs-compose-release-gate.test.ts` 静态保证（digest 清单要求的每个服务都必须被固定，全部五个层的每个 `${VAR:?}` 变量都必须有这两处生产者），并由 `tests/release-env-closure.invariant.test.ts` 用真实 `docker compose config` 渲染整条链来验证。

   其中六个仓库自产镜像由 `infra/scripts/build-ecs-release-images.sh` 从同一受保护候选源码构建并输出固定摘要；`MIGRATION_IMAGE_REF` 与 `CLAMAV_IMAGE_REF` 仍必须由发布配置提供经过审核的上游固定摘要。运维需要把八个 `repository@sha256:<digest>` 合并进 `IMAGE_DIGESTS_JSON`（`validate-ecs-compose-release.rb` 会要求它们与 release 层引用逐字节一致）。缺任何一项时发布链在渲染阶段中止，没有“先用宿主手工构建的镜像顶一下”的降级路径；部署与回滚都使用 `up -d --no-build`。
3. 以旁路容器验证 `/healthz`、`/readyz`、RAM Role 临时凭证、OSS 写读删和持久管理员授权。先在候选 API 容器的同一环境内执行 `node infra/scripts/verify-oss-access.mjs`，只读取 `merchant-assets` 前缀中的至多一个对象；ECS 模式只接受 `ASSET_STORAGE_CREDENTIAL_PROVIDER=aliyun_ecs_ram_role` 和实例角色，拒绝静态 AccessKey。不要打印容器环境或凭据。然后按 `OBJECT_STORAGE_CANARY_CONFIRM=true` 的正式对象存储 canary 流程写入随机探针、核对精确 VersionId、读取 SHA-256 与加密状态、按该 VersionId 删除；权限缺失或清理失败均阻断切换。对旁路 API 的 `/healthz` 运行 `curl -fsS "$CANDIDATE_API_BASE_URL/healthz" | node infra/scripts/verify-ecs-oss-runtime.mjs`；即使容器健康，fixture、本地存储或禁写状态也必须拒绝切换。当前候选不启动或验收告警投递。
4. 保存现网 Compose、镜像摘要、配置摘要、对象存储模式和本地卷挂载作为回滚点。回滚只恢复原 Compose 与镜像并验证 API 健康；本地对象卷和 OSS 版本都保留，不做删除或清空。切换后的新对象写入必须记录并在回滚前核对，不能假定回滚到本地模式会自动显示这些对象。
5. 只有上述证据全部属于同一候选版本时，才能安排切换。

## ECS Compose 回滚

现网只有 ECS/Docker Compose 环境时使用 `infra/scripts/rollback-ecs-compose.sh`，不要使用 Kubernetes `rollback.sh`。回滚输入必须是发布前保存并审核的单一渲染 Compose、其完整镜像摘要 JSON 和回滚计划。计划格式如下；四个身份字段必须来自切换前 `/releasez` 和目标发布的 ECS release gate，不能现场猜测或改写：

```json
{
  "schema_version": "1",
  "kind": "ecs-compose-rollback-capsule",
  "created_at": "2026-09-16T04:00:00.000Z",
  "expires_at": "2026-09-17T04:00:00.000Z",
  "compose_project": "merchant-production",
  "current": { "release_id": "current", "git_sha": "40位SHA", "manifest_sha256": "64位SHA", "image_set_digest": "sha256:64位SHA" },
  "target": { "release_id": "previous", "git_sha": "40位SHA", "manifest_sha256": "64位SHA", "image_set_digest": "sha256:64位SHA", "compose_sha256": "64位SHA", "env_sha256": "64位SHA", "image_digests_sha256": "64位SHA" },
  "database": { "strategy": "forward_only", "live_migration_version": 214, "target_migration_tail": 214, "schema_downgrade": false },
  "volumes": { "preserve": true }
}
```

先设置 `ECS_ROLLBACK_PLAN_PATH`、`ECS_ROLLBACK_COMPOSE_PATH`、`ECS_ROLLBACK_ENV_FILE`、`ECS_ROLLBACK_IMAGE_DIGESTS_JSON`、`ECS_ROLLBACK_STATE_PATH`、`ECS_DEPLOY_LOCK_PATH`、`PRODUCTION_API_BASE_URL` 和只读检查所用的 `DATABASE_URL`，最后显式设置 `CONFIRM_ECS_ROLLBACK=YES` 执行。rollback capsule 最长有效 24 小时，并同时绑定旧 release、Compose、环境文件、镜像摘要 JSON、固定 Compose project 和执行前/目标 release 身份。部署执行器自动回退时必须保存并传递这些冻结输入，不能从当前可变工作目录重新生成。部署与回滚共同使用 repo 外 canonical `ECS_DEPLOY_LOCK_PATH` 和 `ECS_COMPOSE_PROJECT`（默认 `merchant-production`），避免两个进程同时修改唯一生产环境。脚本在启动目标服务前完成以下核对：目标 Compose SHA-256、目标镜像和发布身份、当前线上身份没有发生并发变化、实时数据库版本仍等于审核计划、目标镜像包含实时数据库的完整迁移链。数据库只允许前向兼容，不执行 schema downgrade；回滚的 `compose up` 不重新运行 migrate。

脚本不会执行 `docker compose down/rm`、`--volumes` 或删除数据库数据。`ECS_ROLLBACK_HEALTH_TIMEOUT_SECONDS` 只接受 30 到 900 秒的整数。健康检查超时会在 `ECS_ROLLBACK_STATE_PATH` 原子写入 `health_failed` 和 `requires_manual_recovery: true`；此时保留容器、卷和数据库现场，按状态文件及 Docker 日志人工恢复，不得通过清空卷重试。状态路径必须位于 repo 外、由执行用户拥有且组/其他用户不可写的 canonical 目录中，并使用新的安全 `.json` 文件名。
