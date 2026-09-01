# 商家营销内容助手生产运维 Runbook

版本：v1.0（与部署配置和发布版本一起变更）

> 当前迁移链以 `release-metadata.json` 声明的 106 为准；本文较早的迁移说明仅作历史背景，生产 preflight 必须使用 `EXPECTED_MIGRATION_VERSION=106`，不得使用旧值。

本 Runbook 是生产操作清单，不替代云厂商、平台开放文档或安全审批。每次操作必须记录 `release_id`、操作者、`request_id/trace_id`（如有）、开始/结束时间和结论。任何平台写操作、凭证轮换和数据库恢复都需要双人复核。

## 0. 产品范围与当前证据边界

- 当前产品范围仅包括桌面 ChatGPT 商家插件和桌面运营后台。Merchant Studio 仅供开发调试；手机和平板不属于需求、生产验收或上线阻断项。
- 当前可执行 release 基线为 Repository `0.1.1`、plugin `0.1.0+codex.20260831125200`、247 个 MCP 方法、148 个商家工具、13 个 Ops 一级域和 PostgreSQL 迁移 106。发布 manifest、镜像和数据库必须与该基线一致；105 增加 durable authorization grants，106 收紧 canonical/legacy 品牌完整性。
- 2026-08-29 桌面 ChatGPT 真实宿主对 `merchant.start`、`workspace.health`、`catalog.search`、`billing.status` 四项只读入口验收为 4/4 通过；数据来自本地 `ws_demo`/fixture。该证据只能证明桌面宿主链路，不证明真实平台 OAuth、真实支付、生产身份、云容量或生产数据可用，当前生产结论仍为 `NO-GO`。

## 1. 发布前 Go/No-Go

只有以下证据全部存在才允许放量：

1. `npm run check`、`npm run build`、`npm run infra:validate` 通过。
2. `tests/compose-resource-gate.ts` 通过，且目标环境的资源规格、镜像 digest、连接池和副本数已记录。
3. 预生产 HTTP 容量门禁通过：`CAPACITY_GATE_MODE=real_cloud`、目标为 HTTPS、环境为 `preproduction`，并保存原始输出和云监控报告。`local_fake`/Compose 结果不能替代云门禁。
4. 运营后台的“生产证据 readiness”必须显示六平台 capability 与容量报告均为 `ready`，并可看到脱敏的 release、环境、profile/schema、核验人和核验时间。`example`、`fixture`、`test_e2e`、本地容量报告不会被计为生产通过；小红书/抖音在自身 capability 未就绪前必须保持只读或 fixture/API。
5. 生产订阅下单、升级补差价和支付回调要求 `PAYMENT_MODE=provider`、HTTPS `PAYMENT_CALLBACK_BASE_URL` 与 `PAYMENT_CALLBACK_SECRET`；支付回调必须通过 HMAC 验签和订单金额快照校验。
6. 数据库备份成功，备份校验和可验证；迁移已在预生产执行并记录版本。
7. API、Worker、PostgreSQL、Redis 的健康检查为 healthy；队列老任务年龄和 Outbox backlog 在预算内。
8. `platform-capability-evidence.json` 通过 `npm run evidence:validate`；正式 preflight 还必须让六个平台九项能力（含媒体上传）全部达到 `production_canary`，否则保持 read/write feature flag 关闭。
9. `model-relay-release-1.json` 必须由五类真实中转探测生成，且 `environment=production`、`simulated=false`；每类都要有 provider request ID、usage 和 cost 证据，不能用 fixture 或“已配置”替代真实成功。正式 preflight 会以 `--require-production` 强制该边界。
10. 告警接收人、升级电话、回滚版本和 kill switch 已确认，且至少有一名当班工程师在线。
11. `DATABASE_URL` 与 `OPS_DATABASE_URL` 使用不同的非 owner、非 superuser、非 `BYPASSRLS` 凭据；两者都必须使用 `postgres://`/`postgresql://` 并且恰好包含一个 `sslmode=require`、`verify-ca` 或 `verify-full`。Preflight 会在 URL 规范化后拒绝 `localhost`、IPv4/IPv6 loopback 和未指定本机地址。运行探针必须证明 tenant role 无 feature flag 表权限、Ops role 仅有 feature flag 控制面权限且无 tenant table 权限。`infra/scripts/deploy-preflight.sh` 会强制调用 `verify-runtime-db-role.sh`；URL 门禁、真实 PostgreSQL 连接或任一隔离断言失败时直接拒绝发布。
12. `codex-app-host-evidence.json` 必须使用 schema v2，并通过 `npx tsx tests/codex-app-host-evidence-gate.ts --file <report> --release-id "$RELEASE_ID" --expected-mcp-base-url <root-origin> --expected-bridge-sha256 <sha256>`；证据必须来自真实桌面 ChatGPT 宿主，精确绑定本次发布的公开 MCP 根 origin 与 bridge 摘要，覆盖插件发现、`merchant.start`、充值入口、平台授权入口、附件入口、错误恢复和图片选择旅程，且所有场景为 passed、console/network errors 为 0，并绑定不可变 production artifact。该证据还必须由固定 production evidence trust anchor 签名，release manifest gate 会验证其精确字节、key id、有效期和 Ed25519 签名。stdio、普通 Chromium、localhost 或其他环境的真实证据均不得替代本次发布宿主证据。
13. `RELEASE_MANIFEST_PATH` 必须通过 `npx tsx tests/release-manifest-gate.ts --file <manifest> --release-id "$RELEASE_ID"`；manifest 必须绑定当前 API OpenAPI、MCP contract、插件 bridge/Skill/manifest 摘要，以及 capability、capacity、relay、payment、restore、object storage 和桌面 ChatGPT host 的同一 release 生产证据引用。缺少新 API/MCP 摘要或任一引用为 `not-provided` 时直接拒绝。
14. `OBJECT_STORAGE_EVIDENCE_PATH` 必须证明 quarantine/clean/metadata、版本恢复、完整性抽样、删除保护、orphan recovery 和 `generated_video_archive`；只有 provider job、外部 URL 或 PostgreSQL 元数据不算视频归档证据。

部署前先执行只读 preflight，必须使用已渲染的生产配置、六个平台能力证据 JSON、真实云容量报告和不可变镜像摘要：

```sh
PRODUCTION_CONFIG_PATH="$RENDERED_PRODUCTION_CONFIG" \
RELEASE_ID="$RELEASE_ID" \
IMAGE_DIGESTS_JSON="$IMAGE_DIGESTS_JSON" \
API_IMAGE_REF="$API_IMAGE_REF" \
WORKER_IMAGE_REF="$WORKER_IMAGE_REF" \
RENDERED_MANIFEST_PATH=/secure/release/rendered.yaml \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
OPS_DATABASE_URL="$PRODUCTION_OPS_DATABASE_URL" \
REDIS_URL="$PRODUCTION_REDIS_URL" \
SECRET_PROVIDER="managed-secret-store" \
CAPACITY_PROFILE="pilot_50" \
CAPABILITY_EVIDENCE_PATH=/secure/evidence/platform-capability-evidence.json \
CAPACITY_REPORT_PATH=/secure/evidence/pilot-50-capacity-report.json \
MODEL_RELAY_EVIDENCE_PATH=/secure/evidence/model-relay-release-1.json \
CODEX_APP_HOST_EVIDENCE_PATH=/secure/evidence/codex-app-host-release-1.json \
OBJECT_STORAGE_EVIDENCE_PATH=/secure/evidence/object-storage-release-1.json \
CANONICAL_CUTOVER_EVIDENCE_PATH=/secure/evidence/canonical-cutover-release-1.json \
EXPECTED_MIGRATION_VERSION=106 \
RELEASE_MANIFEST_PATH=/secure/evidence/release-manifest-release-1.json \
PAYMENT_EVIDENCE_PATH=/secure/evidence/payment-release-1.json \
RESTORE_EVIDENCE_PATH=/secure/evidence/restore-release-1.json \
PRODUCTION_EVIDENCE_ARTIFACT_ROOT=/secure/evidence/artifacts \
DEPLOYMENT_NONCE="$DEPLOYMENT_NONCE" \
sh infra/scripts/deploy-preflight.sh
```

`API_IMAGE_REF` 与 `WORKER_IMAGE_REF` 必须是已拉取到发布 runner 的完整
`repository@sha256:...` 引用，且摘要分别匹配 `IMAGE_DIGESTS_JSON` 中的
`merchant-api` 与 `merchant-worker`。preflight 会以 Docker 解析出的不可变 image ID
创建但不启动临时容器，复制镜像内迁移目录和构建时生成的源码清单。门禁要求
API/Worker 的最高迁移文件名及文件 SHA-256 与当前工作树一致，并用构建阶段与宿主
共用的固定算法逐字节比对源码清单及其总 SHA-256。API profile 固定覆盖 `apps/api`、
`apps/plugin`、`packages` 和根目录 `package*.json`/`tsconfig*.json`；Worker profile 固定
覆盖 `apps/worker`、`packages` 和相同根构建元数据。`dist`、source map、测试产物、
secret 与 `.env` 文件不进入清单。profile 和镜像内路径不能由 label、build-arg 或发布
环境变量改写；缺 Docker/Node、可变 tag、缺清单、额外或缺失路径、异常路径、重复
迁移版本、内容或总摘要不一致，以及门禁运行期间工作树变化，都会 fail closed。

字节级 source freshness 门禁当前只覆盖 API 与 Worker。UI/Ops UI 的 immutable digest 绑定与基础镜像固定测试不等价于 source freshness：`validate-kubernetes-release.sh` 会要求 `merchant-ui`、`merchant-ops-ui` 使用 release 绑定的 `repository@sha256`，`tests/supply-chain-reproducibility.test.ts` 会固定两类 UI Dockerfile 的基础镜像 digest，UI contract/运维测试会检查构建和 Nginx 安全契约；但当前 UI 镜像内没有可与工作树逐字节比较的固定源码清单。发布审批必须把 UI/Ops UI 的可信构建 provenance/attestation 作为外部 NO-GO 门禁，直到两类镜像获得与 API/Worker 等价的 source manifest 校验；不得把 digest 固定或单元测试写成源码 freshness 已通过。

本机 `tests/production-ops-gate.ts` 的 `status=pass` 只代表仓库内运维契约检查；当输出 `cloudGate=false` 时不构成生产容量、桌面 ChatGPT 宿主或权限隔离证据，不能解除本 Runbook 的 NO-GO。

其中 `RENDERED_MANIFEST_PATH` 必须是实际部署的渲染结果（例如 `kubectl kustomize infra/kubernetes/overlays/pilot-50 > /secure/release/rendered.yaml`）。最终发布必须调用 `infra/scripts/deploy-verified-manifest.sh`，它会在门禁前后校验清单 SHA-256，并只执行 `kubectl apply -f "$RENDERED_MANIFEST_PATH"`；不得在门禁后重新 `apply -k`。

生产证据额外遵循以下 fail-closed 契约：

1. `artifact://production/<relative-path>#<sha256>` 映射到 `PRODUCTION_EVIDENCE_ARTIFACT_ROOT/<relative-path>`。门禁要求目标是根目录内存在的普通非符号链接文件，并重新计算 SHA-256；只有字符串格式正确不能通过。
2. trust path 固定为 `/run/release-security/evidence-trust`，禁止通过 `PRODUCTION_EVIDENCE_TRUST_DIR` 改写。该目录必须由发布安全控制面以 root 管理、工作树外只读方式提供，并包含五个普通非符号链接文件：`production-evidence-public.pem`、`production-evidence-key-id`、`production-evidence-public-key-sha256`、`production-evidence-nonce-consumer-sha256`、`production-capability-attester-sha256`。校验会检查规范路径、owner、mode、父目录、公钥指纹、consumer 摘要和 attester 摘要；部署 runner 不得持有私钥。
3. 部署编排器必须生成至少 128 bit 熵、22-128 位 URL-safe 的 `DEPLOYMENT_NONCE`。capability、payment 与 restore evidence 都必须签入同一个 nonce；preflight 校验三类签名及 release/image-set/manifest/Git/nonce 绑定。`deploy-verified-manifest.sh` 在 `kubectl apply` 前消费 nonce，消费后失败不得复用，必须重新签发证据和 nonce。
4. nonce consumer 固定为 `/usr/local/libexec/merchant/consume-production-evidence-nonce`，禁止通过 `PRODUCTION_EVIDENCE_NONCE_CONSUMER` 改写。它必须是 root 管理、工作树外、摘要与 trust 目录记录一致的普通可执行文件，并对命名空间和 nonce 做跨 runner、持久化、原子 put-if-absent；返回码 `0` 仅表示首次成功消费，任何非零值都拒绝部署。
5. capability attester 固定为 `/usr/local/libexec/merchant/attest-capability-evidence`。它及 `/usr/local/libexec`、`/usr/local/libexec/merchant` 必须由 root 持有、不是符号链接且不可被 group/other 写入，执行文件摘要必须匹配 trust bundle 中的 `production-capability-attester-sha256`。六平台 runner 只生成候选矩阵，attester 必须在受保护控制面添加 release/image-set/manifest/Git/nonce、固定 key ID 与 Ed25519 签名；应用容器和仓库脚本不得接触私钥。
6. `deploy-verified-manifest.sh` rollout 后必须通过 `/livez`、`/readyz`，并由 `/releasez` 核对 release ID、Git SHA、manifest SHA-256 和 image-set digest 四项绑定；随后调用携带 Bearer token 与 workspace header 的 `/v1/products?limit=1&offset=0` 数据库业务路径，再运行并复验签名六平台 canary。Ingress 健康或 runner 本地 connector 成功不能替代该路径。

上述发布、回滚和恢复代码门禁已经实现并 fail closed；当前 NO-GO 不再是 capability 签名、固定路径或 signed rollback 缺少代码，而是生产环境尚未实际配置受保护 trust/consumer/attester、真实签名 artifacts，并完成同一 release 的部署、回滚和恢复演练。

## 2. 标准部署顺序

1. 锁定 `release_id`、配置版本、镜像 digest 和迁移版本。
2. 执行数据库备份：

   ```sh
   DATABASE_URL="$PRODUCTION_DATABASE_URL" BACKUP_DIR="$BACKUP_DIR" \
     sh infra/scripts/backup-postgres.sh
   ```

   `backup-postgres.sh` 会生成 custom-format dump 和本地 checksum sidecar。生产备份还必须由仓库外受保护签名服务生成 `postgres_backup` attestation，至少包含 `schema_version=1`、`kind=postgres_backup`、`environment=production`、固定 `key_id`、准确 `backup_file_name`、备份字节 `backup_sha256`、隐私安全的 `source_database_id_sha256`、`created_at`、`expires_at`、`simulated=false` 和 Ed25519 `signature_base64`。私钥不得进入备份脚本或运行容器。

3. 先执行向后兼容的迁移；迁移失败立即停止放量，不执行自动反向迁移。当前 release 迁移链到 106：060 的分页索引以 `CREATE INDEX CONCURRENTLY` 创建，062 以 `DROP INDEX CONCURRENTLY` 删除重复索引，均带 `migrate:no-transaction`；063 在添加并验证 listing workspace/brand/canonical 组合外键前会拒绝既有跨品牌脏数据；069 增加 legacy 商品、任务和发布记录的平台/店铺账号作用域触发器；070/071/072 补齐商品—素材关系及完整性校验；073 增加平台运营读取所需的受控工作区商业摘要视图；074 将模型 usage 的 context link/hash 提升为独立列并加一致性约束；075 增加按工作区/动作的模型 usage 查询索引；076 增加 workspace-scoped canonical backfill lookup index；077 增加任务与发布任务的 canonical/platform/store scope 触发器；078/079 增加素材快照绑定回填和知识水合快照；080 增加 workspace 存储配额与幂等预留账本；081 增加 reconciliation status，082 修复知识水合 revision，083–089 收紧数据生命周期、模型/素材证据与运行时权限，090–091 收紧平台运营作用域与角色绑定，092–097 补齐图片执行租约、对账证据和运行时权限，098 增加 canonical unified link audit，099 增加品牌复合完整性约束，100 增加告警通知投递账本，101/102 增加 canonical backfill 批次状态与人工冲突队列，103 收紧告警通知账本应用角色 ACL，104 增加一次性交互确认票据及最小权限消费约束，105 增加 durable authorization grants，持久化授权授予/撤销、JIT 时效与次数预算及双人写审批约束，106 增加 NULL 品牌映射的 fail-closed 完整性守卫。生产 preflight 必须以 `EXPECTED_MIGRATION_VERSION=106` 绑定工作树和镜像链尾；执行时必须监控锁等待、触发器耗时、WAL/副本延迟和失败恢复，不得把本地静态测试当作生产迁移证明。
4. 部署 API 和 Worker，等待容器健康检查通过；API 使用 `/healthz`，Worker 使用进程健康检查和队列消费指标共同判断。
5. 放入小流量 canary，观察至少 30 分钟：API 5xx/P95、数据库连接、Redis 内存、Outbox backlog、队列队龄、Worker 重启次数、connector 错误和 `publish_unknown`。
6. canary 无回归后逐步放量；所有平台写权限按平台、按工作区、按功能 flag 独立开启。
7. 发布结束记录 dashboard 截图/链接、门禁原始输出、迁移结果和最终副本数。

## 3. 健康检查与观测

### 3.1 健康判定

- `/healthz` 是 API 的存活/就绪综合检查；HTTP 200 且 `data.persistence.ready=true` 才允许入口流量进入。数据库不可用时应为 HTTP 503。
- Compose 中 API/UI/Worker/PostgreSQL/Redis 都有容器健康检查；Worker 的进程健康只能证明进程存活，不能单独证明队列正在收敛，必须同时看 oldest-job age、消费速率和 error rate。
- API/Worker 使用 `stop_grace_period` 给正在处理的任务留出退出时间；重启后必须检查 Outbox lease 是否恢复、是否出现 unknown 或重复执行。

### 3.2 必看指标和告警

发布和事故期间至少打开以下面板：

- API 请求量、P95/P99、4xx/5xx、连接数和限流数；
- PostgreSQL 连接使用率、锁等待、慢查询、事务时长；
- Redis 内存、持久化状态、连接数和故障转移状态；
- 每个队列的深度、最老任务年龄、成功/失败/unknown、Worker 重启；
- connector 的 401/403/429/5xx/timeout，平台和工作区维度的公平性；
- Outbox pending、lease 超时和 dead-letter 数量。

日志必须以结构化字段关联 `trace_id`、`request_id`、`workspace_id`、`task_id`、`job_id`、`platform`、`account_id`；禁止输出 access token、refresh token、app secret、授权码和原始敏感正文。OTEL 管道使用 `infra/observability/otel-collector.example.yaml` 的脱敏处理器，接入托管后必须用一条带敏感 header 的测试 trace 验证不会落盘或外发。

## 4. 常见故障处置

### API 不健康或 5xx 升高

1. 记录 `/healthz` 响应、容器日志、最近发布版本和依赖状态。
2. 若数据库/Redis 不健康，先暂停放量和写 feature flag；不要反复重启掩盖依赖故障。
3. 若仅单副本异常，摘除异常副本并保留日志；若所有副本异常，执行回滚评估。
4. 恢复后验证健康、API 容量门禁抽样和 Outbox backlog，再恢复流量。

### Worker 重启、队列积压或 Outbox 不收敛

1. 查看 oldest-job age、lease、attempt、error code 和 dead-letter；先确认 workspace scope。
2. 不直接删除队列或 Outbox。Redis 不是事实来源，必要时依据 PostgreSQL Outbox 重建。
3. 对 `publish.requested` 的 timeout/unknown 先对账远端状态；未确认前禁止盲目重试写操作。
4. 修复原因后只重放明确可重试的事件，记录重放范围和结果。

### 平台 429、401/403 或 OAuth 撤权

1. 立即关闭对应平台的 write flag；撤权时同时停止该账号同步和发布。
2. 429 按平台配额退避，不提升并发、不无限重试；401/403 进入重新授权流程。
3. 轮换/吊销 Secret Manager 中的凭证，检查审计事件和异常访问。
4. 重新授权并完成该平台 capability evidence、测试店铺探针和 canary 后，才恢复读/写。

### 数据库恢复

1. 进入变更窗口，停止写流量和 Worker，确认恢复目标、RPO/RTO 与备份时间点。
2. 使用独立目标库演练优先；正式恢复必须设置 `CONFIRM_RESTORE=YES` 和 `RESTORE_TARGET_ISOLATED=YES`，并由第二人复核备份校验和目标连接串。禁止直接对生产主库执行 `pg_restore --clean`：

   所需文件：canonical regular dump `BACKUP_FILE`、由受保护控制面签名且未过期的 `BACKUP_ATTESTATION_PATH`，以及固定 trust 目录中的四个文件。生产流程不读取 `$BACKUP_FILE.sha256` 作为信任依据。

   ```sh
   DATABASE_URL="$RECOVERY_DATABASE_URL" \
   BACKUP_FILE="$BACKUP_FILE" \
   BACKUP_ATTESTATION_PATH="$BACKUP_ATTESTATION_PATH" \
   NODE_ENV=production \
   CONFIRM_RESTORE=YES \
   RESTORE_TARGET_ISOLATED=YES \
   sh infra/scripts/restore-postgres.sh
   ```

   生产恢复不接受仅有 `.sha256` sidecar 的备份；脚本会用固定 trust anchor 验证 `BACKUP_ATTESTATION_PATH` 的 Ed25519 签名、key ID、有效期、文件名和实际备份字节 SHA-256。非生产恢复才使用 `$BACKUP_FILE.sha256`。

3. 执行迁移、健康检查、跨工作区隔离、Outbox/任务恢复和只读 smoke；确认后再开启 Worker 和流量。
4. 记录实际 RPO/RTO；恢复过程禁止把旧 Redis 数据当作事实来源。

### 回滚

仅回滚兼容应用版本，不自动执行破坏性 schema 反向迁移：

所需文件：签名 `known_good_release` bundle、bundle 通过不可变引用绑定的已渲染 manifest、签名 capability evidence，以及固定 trust 目录中的四个文件。manifest 与 capability 文件必须位于 `PRODUCTION_EVIDENCE_ARTIFACT_ROOT` 内，文件字节 SHA-256 必须和 bundle 引用一致。

```sh
RELEASE_ID="$PREVIOUS_RELEASE_ID" \
ROLLBACK_RELEASE_BUNDLE_PATH="/secure/evidence/known-good/$PREVIOUS_RELEASE_ID.json" \
PRODUCTION_EVIDENCE_ARTIFACT_ROOT=/secure/evidence/artifacts \
DEPLOYMENT_NONCE="$ROLLBACK_DEPLOYMENT_NONCE" \
POST_ROLLBACK_CANARY_OUTPUT="/secure/evidence/canary/$PREVIOUS_RELEASE_ID-rollback.json" \
PRODUCTION_API_BASE_URL=https://api.example.com \
CONFIRM_ROLLBACK=YES sh infra/scripts/rollback.sh
```

运行前还必须注入 `run-production-canary.sh` 要求的真实 `PAYMENT_*`、六平台 `PLATFORM_CANARY_*` 和写入/撤销双确认变量；这些值不得写入 bundle。`ROLLBACK_RELEASE_BUNDLE_PATH` 必须是 Ed25519 签名的 `known_good_release` JSON，包含 release/Git/manifest SHA-256、四个镜像 digest、有效期、固定 key ID，以及带 SHA-256 fragment 的 `manifest_ref` 和 `capability_evidence_ref`。两个引用都必须解析到 `PRODUCTION_EVIDENCE_ARTIFACT_ROOT` 内的普通非符号链接文件；bundle 中的 capability evidence 还必须以本次 rollback nonce 对同一 release/image-set/manifest/Git 做正式签名。

回滚后必须重新检查 `/healthz`、迁移版本、队列收敛、`publish_unknown`、重复发布和跨工作区访问；任一项失败时保持写 kill switch 关闭。

rollback 已强制签名 known-good release bundle、不可变 artifact、镜像摘要和签名 capability evidence，并以 `--rollback` 模式拒绝 `Namespace`、`Secret`、`ServiceAccount`、`Role`、`RoleBinding`、`ClusterRole`、`ClusterRoleBinding`、`PersistentVolume`、`PersistentVolumeClaim`、`StorageClass`；其他资源仍受发布清单支持列表和 digest 校验约束。数据库迁移只前进，不执行 schema downgrade。当前剩余门禁是用真实受保护 bundle 和生产集群完成回滚、队列收敛及六平台业务 canary 演练。

## 5. 扩容与容量门禁

- 使用 `infra/scripts/scale-workloads.sh pilot_50|wave_100|wave_250|target_500` 先 dry-run，生产执行必须显式设置 `EXECUTE=true` 并注入受控 `SCALE_COMMAND`。
- 扩 API 前先确认数据库连接预算、Redis 内存、平台/模型配额和 Worker 队龄；不能只增加 API 副本。
- 每个容量档位保存代码/配置版本、实例规格、数据集、压测脚本、原始指标和云监控链接。
- 只有 real-cloud、HTTPS、预生产/生产环境且显式确认的结果可以将 `cloudGate` 记为 true。

## 6. 事故结束与复盘

恢复稳定后保留日志、trace、告警、队列/Outbox 快照和操作记录；确认无 unknown 未对账、无 dead-letter 遗漏、无跨租户数据访问。24 小时内完成时间线、影响工作区、根因、检测缺口、修复项、Owner 和截止时间；更新本 Runbook 与对应验收脚本。

## 7. 数据删除与生命周期

1. 商家请求删除或注销时，先确认工作区身份、请求人权限、范围（工作区/素材/业务快照）和是否存在待处理支付、发布或争议；`workspace.deactivate` 仅停用入口并保留数据，不能当作删除完成。
2. 记录删除请求、操作人、原因、`request_id`、创建时间和预计执行时间。生产默认保留 90 天，活动数据进入至少 7 天宽限期；宽限期内允许合规复核或取消，未经两名不同身份运营/安全人员审批不得执行不可逆删除，申请人不能审批自己的请求。
3. 第二名审批完成后状态为 `approved`，但 API 不直接执行删除；宽限期结束后先冻结新的同步、生成、发布和上传，再按 workspace scope 删除数据库业务快照、Outbox、任务/版本/审计中的正文引用和凭证引用；审计只保留去内容化 ID、hash、状态、时间和删除请求关联。
4. 按对象存储版本化策略删除 clean 与 quarantine 对象、旧版本、元数据和删除标记；扫描器、签名下载和访问审计系统必须返回删除成功或明确失败，不允许只删除数据库元数据。
5. 备份按 30 天轮转策略清除；保留删除请求、审批、对象列表摘要、数据库计数、备份批次和失败重试证据，不保留 Token、Secret、原始素材或已删除正文。
6. 任一数据库、对象存储、备份或外部扫描器步骤失败时，状态保持 `deletion_incomplete`，暂停重新启用工作区并创建高优先级告警；不得报告“已删除”。完成后执行跨工作区读取、签名下载、任务历史和平台凭证回查，形成独立删除证明。
