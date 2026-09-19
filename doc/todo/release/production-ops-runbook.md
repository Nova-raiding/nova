# 商家营销内容助手生产运维 Runbook

版本：v1.0（与部署配置和发布版本一起变更）

> 当前迁移链以 `release-metadata.json` 声明的 `expectedMigrationVersion` 为准；本文**不写死**迁移号（写死会在每次新增迁移后过期，并让 preflight 以「链尾不匹配」失败）。生产 preflight 必须读取该值填入 `EXPECTED_MIGRATION_VERSION`：`EXPECTED_MIGRATION_VERSION=$(node -p "require('./release-metadata.json').expectedMigrationVersion")`。本文较早的迁移说明仅作历史背景。

本 Runbook 是生产操作清单，不替代云厂商、平台开放文档或安全审批。每次操作必须记录 `release_id`、操作者、`request_id/trace_id`（如有）、开始/结束时间和结论。任何平台写操作、凭证轮换和数据库恢复都需要双人复核。

## 0. 产品范围与当前证据边界

- 当前产品范围仅包括桌面 ChatGPT 商家插件和桌面运营后台。Merchant Studio 仅供开发调试；手机和平板不属于需求、生产验收或上线阻断项。
- 当前可执行 release 基线以 `release-metadata.json` 为唯一机器可校验来源；本次文档同步时为 Repository `0.2.1`、plugin `0.1.0+codex.20260917171000`、327 个 MCP 方法、131 个商家工具、11 个 Ops 一级域；PostgreSQL 迁移链尾以 `release-metadata.json` 为准（本文不写死）。商家工具数由 151 收敛到 131 是插件范围收窄（资料整理/内容候选/审核/导出）而非功能回退，运营侧能力仍在桌面运营后台完整保留。发布 manifest、镜像和数据库必须与同一次构建读取到的元数据一致，不能只依赖本文快照。
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
8. `platform-capability-evidence.json` 通过 `npm run evidence:validate -- --file <证据文档>`（`--file` 为必需参数，省略时门禁以退出码 2 失败关闭）；正式 preflight 还必须让六个平台十项能力（`authorize`、`refresh`、`read`、`full_sync`、`incremental_sync`、`create`、`update`、`query_status`、`revoke`、`media_upload`）全部达到 `production_canary`，否则保持 read/write feature flag 关闭。
9. `model-relay-release-1.json` 必须由五类真实中转探测生成，且 `environment=production`、`simulated=false`；每类都要有 provider request ID、usage 和 cost 证据，不能用 fixture 或“已配置”替代真实成功。正式 preflight 会以 `--require-production` 强制该边界。
10. **告警通道（这一项当前不成立，是明确的 NO-GO 前置条件）**：告警接收人、升级电话、回滚版本和 kill switch 已确认，且至少有一名当班工程师在线。当前交付中，仓库没有部署 Prometheus/Alertmanager（对 `apps/`、`packages/`、`scripts/`、`infra/`、`tests/` 的代码与部署清单 grep `alertmanager|grafana|vmagent|loki` 为 0 命中，这两个词只作为「未部署」的说明文字出现在 `infra/observability/` 的两个模板里），没有真实 paging 通道，没有值班表，也没有告警演练记录；`infra/observability/prometheus-alerts.example.yaml` 只是**未部署的规则模板**，一条都不在生效。在补齐「3.4 告警通道现状」列出的六项之前，不得把「已配置告警」「有人值守」写成发布证据。
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
EXPECTED_MIGRATION_VERSION="$(node -p "require('./release-metadata.json').expectedMigrationVersion")" \
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

3. 先执行向后兼容的迁移；迁移失败立即停止放量，不执行自动反向迁移。当前 release 迁移链尾以 `release-metadata.json` 的 `expectedMigrationVersion` 为准（本文不写死该数字，写死会在每次新增迁移后过期）。060–106 的历史变更包括并发索引、商品/素材完整性、工作区配额、运行时 ACL、canonical 回填和一次性交互确认；107 之后继续加入企业租户、商业目录、客户交付证据、告警回执隔离、MCP OAuth 身份绑定、客户交付账号绑定、公共平台规则，以及退款累计上界（220 `commercial_refund_cumulative_bound`、221 `commercial_refund_amount_bound`）。生产操作必须逐项审阅 `packages/persistence/src/migrations/` 中相应版本的真实 SQL，不能用这段摘要替代迁移评审。生产 preflight 必须以 `EXPECTED_MIGRATION_VERSION="$(node -p "require('./release-metadata.json').expectedMigrationVersion")"` 绑定工作树和镜像链尾；执行时必须监控锁等待、触发器耗时、WAL/副本延迟和失败恢复，不得把本地静态测试当作生产迁移证明。
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

**上表是目标面板，不是当前可得的数据。** 按 `infra/observability/prometheus-alerts.example.yaml` 头部的「指标可用性矩阵」逐条核对，代码里已经存在、接上采集后即可落地的序列是：API 请求量与 4xx/5xx（`merchant_http_requests_total`，**没有 route 标签**）、队列队龄与各队列 job 计数（`merchant_queue_oldest_job_age_seconds`、`merchant_job_state_count`，按工作区从数据库聚合，覆盖 sync/publish/generation，reconcile 复用 publish；scan 由 Worker 侧 `merchant_queue_depth{queue="scan"}` 提供）、outbox pending（**SQL 把 dead-letter 也算作 pending**）、`publish_unknown`、两个 connector 错误码（`RATE_LIMITED`/`TIMEOUT`，且该序列是 `sum(attempts)` 而非单调 counter）、Worker 的进程启动时间/uptime/心跳/轮询结果（Worker `/metrics`，默认 `127.0.0.1:9102`，需 `WORKER_METRICS_HOST` 与采集放行）、scan 队列深度与 dead-letter，以及告警扫描/投递遥测（`merchant_alert_sweep_*`、`merchant_alert_delivery_*`）。

**当前仍然没有指标、因此面板必然为空的是**：P95/P99（`/metrics` 只有 duration 的 sum/count，没有 histogram bucket，算不出分位数）、PostgreSQL 连接/锁等待/慢查询/副本延迟、Redis 内存与故障转移、按 Pod 的重启次数与精确 HPA 下限（需要 kube-state-metrics）、connector 的 401/403/5xx、非 scan 队列的 dead-letter、磁盘水位、证书过期、支付回调验签失败、对账 `attention_required`。这些缺口对应的规则已在规则文件中逐条标注 `dependency_status: missing`（加载后会永远为假，**不构成保护**）。

日志必须以结构化字段关联 `trace_id`、`request_id`、`workspace_id`、`task_id`、`job_id`、`platform`、`account_id`；禁止输出 access token、refresh token、app secret、授权码和原始敏感正文。OTEL 管道使用 `infra/observability/otel-collector.example.yaml` 的脱敏处理器，接入托管后必须用一条带敏感 header 的测试 trace 验证不会落盘或外发。

### 3.3 采集、遥测与告警通道现状

上面 3.2 列的是**目标面板**。以仓库当前状态直接部署，这些面板全部是空的——本节记录截至 2026-09-19 的核实结论，避免把「文档里写了」当成「已经在跑」。

**当前实际状态：仓库内不存在任何采集与告警组件。**

- 没有 Prometheus / Alertmanager / Grafana / 各类 exporter，没有 OTEL collector。`infra/observability/` 下的三个 `.example.yaml`（采集任务、告警规则、OTEL 管道）都是契约模板，不被任何 Kustomization 或 Compose 引用，也没有任何镜像 digest 绑定。文件头部已标注「未部署」，不得当作已生效的保护。
- `infra/kubernetes/base/api.yaml` 的 Service 上确实写了 `prometheus.io/scrape|path|port` 注解，但**没有任何进程会读这些注解**；注解本身不会产生采集。
- 代码里存在的指标端点只有两个：API 的 `GET /metrics`，以及 Worker 的 `GET /metrics`（`apps/worker/src/worker-metrics.ts`，默认 `127.0.0.1:9102`，`WORKER_METRICS_HOST`/`WORKER_METRICS_PORT` 可覆盖，生产同样要求 `METRICS_AUTH_TOKEN`）。Worker 默认只绑回环，**必须显式放开 host 并放行采集命名空间**，否则它对集群不可见。alert-receiver 只应答 `/healthz`、`/readyz` 和 `/internal/v1/alerts`，没有 `/metrics`；给它加 `prometheus.io/scrape` 注解只会指向不存在的端点。
- `/metrics` 不在任何 Ingress path 中，只能在集群内（或经 NetworkPolicy 放行的命名空间）采集。

**指标链路要打通，必须依次完成以下四项，缺一项结果都是空序列：**

1. **令牌**：`METRICS_AUTH_TOKEN` 作为 `merchant-runtime-secrets` 的 key 由托管密钥系统下发，并通过 `secretKeyRef` 注入 API。缺失时生产环境的 `GET /metrics` 固定返回 `503 METRICS_AUTH_NOT_CONFIGURED`；值不匹配返回 401。契约见 `infra/kubernetes/secret-contract.example.yaml`，注入见 `infra/kubernetes/base/api.yaml`。Worker 的 `/metrics` 同样比对同一个变量，但该 key **目前只对 API Deployment 放行**：把 Worker 指标端口接入清单时，必须同时为 Worker 增加 `secretKeyRef`，并把该 key 加入 `infra/scripts/validate-kubernetes-release.rb` 的 `WORKLOAD_SECRET_KEYS` 白名单，否则发布门禁会以「Secret key reference is not allowed」失败关闭（这是预期的最小权限行为，不是需要绕过的障碍）。
2. **采集任务**：采集方必须带 `Authorization: Bearer <token>`。`prometheus.io/*` 注解不带任何凭据，照抄注解得到的是 401/503。可用的采集契约见 `infra/observability/prometheus-scrape.example.yaml`。
3. **网络**：`NetworkPolicy/merchant-api-ingress-boundary` 默认只放行 ingress-nginx 与本命名空间内的 UI/Worker。采集方若在其他命名空间，必须显式放行，否则请求在到达容器前就被丢弃（表现为采集超时而非 401）。
4. **告警通道**：规则模板 `infra/observability/prometheus-alerts.example.yaml` 即使被加载，也需要 Alertmanager 与真实的 paging 通道（电话/短信/聊天工具 + 值班表）才能「有人知道」。**告警通道现状**：本仓库没有任何投递通道，也没有值班表。告警扫描与投递链路自身已有指标（`merchant_alert_sweep_*`、`merchant_alert_delivery_*`），所以「扫描静默失败」可被规则捕获；但指标只证明「信号走到了 alert-receiver 并落库」，不证明有人看见——链路的终点仍是 `alert_webhook_receipts` 与 `workspace_operation_alert_notifications` 两张表。接入托管 paging 时，本条必须由**仓库外**的接收方确认（独立通道或人工每日确认），否则「没有告警」与「告警链路已死」在本仓库内无法区分；具体的通道、值班人和 dead-man's switch 接收方不属于代码仓库的字段契约，需在运维系统侧登记后再回填本节。完整缺口见「3.4 告警通道现状」。

**发布评审口径**：在上述四项完成并有真实触发/送达/升级记录之前，`infra/observability/` 下的任何文件都不能作为「已有可观测性保护」的证据；`traceability-fr11-fr15.md` 对 FR-15 标注的「部分完成」保持成立。

### 3.4 告警通道现状：当前未成立的交付前置条件（NO-GO）

**结论：凌晨 2 点卡住的发布，当前没有任何机制把信号推给人。** 本节的每一项都是「尚未成立」的陈述，不是操作指南。

**链路实际形状**（代码已核实）：

```text
API sweepOperationalAlerts()              apps/api/src/server.ts（按时间窗轮转租户，默认每 60s 一批 8 个租户）
  → notifyOperationalAlert()             apps/api/src/alert-notifier.ts（HMAC 签名 POST OPS_ALERT_WEBHOOK_URL，最多重试 3 次）
  → POST /internal/v1/alerts             apps/alert-receiver/src/server.ts（验签、防重放，成功 202 / 重复 409）
  → public.alert_webhook_receipts        持久回执（精确信封 + SHA-256）
  + workspace_operation_alert_notifications（delivery / attempts / reason）
```

**链路的终点是两张数据库表。** alert-receiver 自己的 README 也这么写：「This receiver proves authenticated delivery and durable receipt only. It is not an on-call provider, pager, escalation policy, or evidence that a human acknowledged an alert.」这两张表是**可查询**的，但「可查询」等于「有人主动去查」——这正是本节的缺口。

**已核实的空实现（全仓 grep）**：

- 对 `apps/`、`packages/`、`scripts/`、`infra/`、`tests/` 的代码与部署清单 grep `nodemailer|sendgrid|smtp|twilio|pagerduty|opsgenie|dingtalk|feishu|wecom|telegram|mailgun` = **0 命中**（唯一的字面命中是本清单这一行自己的说明文字）：没有任何邮件/短信/IM/on-call 适配器。
- 同一范围 grep `alertmanager|grafana|vmagent|loki` = **0 命中**：没有告警路由，也没有给人看的看板。这两个词只作为「未部署」的说明出现在 `infra/observability/prometheus-alerts.example.yaml` 与 `infra/observability/prometheus-scrape.example.yaml` 的注释里，不代表任何已生效的组件。
- 连「落库」这一段在生产默认也是关的：alert-receiver 在 Compose 里是 `profiles: ["alerts"]` 的可选服务，ECS pilot 环境里两个 API 容器都是 `OPS_ALERT_NOTIFICATIONS_ENABLED: "false"`、`OPS_ALERT_WEBHOOK_URL: ""`（`tests/alert-receiver-deployment-contract.test.ts` 固定了这个默认值）。
- `doc/todo/infra/production-config.example.yaml` 的 `observability.alertmanager_url`、`dashboard_url`、`alert_thresholds.*` **没有任何代码或脚本读取**（全仓 grep 0 命中）；其中 `api_query_p95_ms` 用现有指标根本算不出来（只有 duration 的 sum/count，没有 histogram bucket）。
- 告警链路自身现在**有指标**（代码已实现，仍需采集）：`merchant_alert_sweep_*`（扫描成功时间戳、连续失败、覆盖滞后、runs/tenant_syncs 计数）与 `merchant_alert_delivery_*`（投递尝试、按结果分类的投递数、连续失败、投递证据写入失败）。但「有指标」不等于「有人知道」：这些序列同样要先进 Prometheus、再由 Alertmanager 路由到一条真实通道；在此之前它们和上面所有指标一样，只是没人看的数字。

**要真正做到「有人知道」，还缺以下六项（全部是仓库外/部署项，本仓库无法自证）**：

1. **部署 Prometheus（或托管等价物）**：加载规则文件与采集任务（采集链路的前置条件见「3.3 采集、遥测与告警通道现状」）。
2. **部署 Alertmanager（或等价通知路由）**：规则命中后目前没有任何路由目标。
3. **一条真实 paging 通道**：电话/短信/IM webhook + 升级策略；并明确 **alert-receiver 不是 pager**，把「信号推给人」放在它之外。
4. **值班表**：主/备接收人、升级路径与时限、值班电话，并写入发布记录。
5. **演练记录**：至少一次真实的「触发 → 投递 → 人工确认 → 升级」闭环，记录时间戳、确认人和耗时；没有演练记录的告警通道不算成立。
6. **dead-man's switch 接收方**：`MerchantAlertPipelineWatchdog` 需要 `alertmanager_notifications_total`（随 Alertmanager 部署才有），并且必须由**仓库外**的接收方确认，否则「没有告警」与「告警链路已死」在本仓库内无法区分。告警链路自身的两个自监控规则（`MerchantAlertChannelNoSuccessfulDelivery`、`MerchantAlertSweepNotSucceeding`）已有对应指标与规则，但它们同样要经过上面第 1–3 项才能变成「有人知道」。

**「最小可行有人知道」的判定：NO-GO。** 在不引入外部依赖的前提下，本仓库不存在任何能主动把信号推给人的组件：Worker 是轮询循环、UI 是浏览器（只有人打开才看到）、alert-receiver 只写库、API 没有任何出向通知通道（`notifyOperationalAlert` 的唯一目标就是一个 webhook URL，而它指向的正是这个只写库的 receiver）。代价最小的替代方案是：在 alert-receiver 之后接一条托管告警通道或 IM 群机器人 webhook，并配值班表与演练记录——但那仍然是外部依赖，不是仓库内可完成的修复。

**评审口径**：在上述六项完成前，第 1 节第 10 项不成立；任何「告警已配置」「有人值守」「告警已覆盖 XX」的表述都不得进入发布证据或对外交付说明。

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

### 告警发出但没有人知道（告警通道故障）

适用场景：已经发生事故，但没有人被叫醒；或怀疑「一直没有告警」其实是通道死了。当前状态下**没有自动化信号能区分这两者**（见 3.4），因此只能人工核查：

1. 先确认事故是否被检测到：查询 `workspace_operation_alerts` 是否有对应行。没有行说明是**检测缺口**（扫描器没跑或没水合到该租户）；有行但没人知道，说明是**投递缺口**。
2. 检查投递结果：`workspace_operation_alert_notifications` 的 `delivery` / `attempts` / `reason`。`blocked` 表示 `OPS_ALERT_WEBHOOK_URL` / `_ALLOWED_HOSTS` / `_SECRET_FILE` 未配置或地址被安全策略拒绝；`failed` 表示 receiver 不可达或返回非 2xx。
3. 检查 receiver 是否收到：`alert_webhook_receipts` 是否有对应 `alert_id`；`received_at` 与 `sent_at` 的时间差是否超出 5 分钟有效窗口（超窗会被拒为 `ALERT_TIMESTAMP_STALE`）。
4. 检查 API 日志中的 `operational_alert_sweep_failed`、`operational_alert_sync_failed` 与 `alert_receiver.rejected`，确认扫描与验签各自的失败分支。
5. 无论结论如何，**先按「无人知道」处理**：电话通知当班人，并按 3.4 的六项缺口记录本次暴露出的具体缺口，作为复盘输入。
6. 复盘必须回答：为什么这次事故没有把信号推给人（哪个组件缺失）、下次靠什么在 N 分钟内知道、以及需要补的指标名。不得用「已配置告警 webhook」作为结论。

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
   RESTORE_TARGET_ENVIRONMENT=production \
   RESTORE_TARGET_ISOLATED=YES \
   ALERT_RECEIVER_DATABASE_URL="$RECOVERY_ALERT_RECEIVER_DATABASE_URL" \
   EXPECTED_SOURCE_DATABASE_ID_SHA256="$EXPECTED_SOURCE_DATABASE_ID_SHA256" \
   RESTORE_API_SMOKE_SCRIPT="$RESTORE_API_SMOKE_SCRIPT" \
   RESTORE_WORKER_SMOKE_SCRIPT="$RESTORE_WORKER_SMOKE_SCRIPT" \
   RESTORE_PLUGIN_SMOKE_SCRIPT="$RESTORE_PLUGIN_SMOKE_SCRIPT" \
   sh infra/scripts/restore-postgres.sh
   ```

   上面这段命令之外，`restore-postgres.sh` 自身强制的入参如下（缺任何一项都会在接触数据库之前直接退出）：

   - `RESTORE_TARGET_ENVIRONMENT`：**必填**（`restore-postgres.sh` 第 6 行），生产签名路径只接受 `production`；漏填会在第 6 行以 `Set RESTORE_TARGET_ENVIRONMENT=local or production` 退出。
   - `RESTORE_TARGET_ISOLATED=YES`：签名路径要求独立目标库（第 28 行）。
   - `ALERT_RECEIVER_DATABASE_URL` 或 `ALERT_RECEIVER_DATABASE_URL_FILE` 二者**恰好一个**（第 29–30 行）；恢复会同时校验该连接串（第 35 行），因为 alert-receiver 运行角色不在业务 dump 的恢复范围内。
   - `EXPECTED_SOURCE_DATABASE_ID_SHA256`：**必填**（第 32 行），用于拒绝「恢复到与批准源同库」的目标（第 40 行）。
   - `RESTORE_API_SMOKE_SCRIPT`、`RESTORE_WORKER_SMOKE_SCRIPT`、`RESTORE_PLUGIN_SMOKE_SCRIPT`：三个都必须是已存在的可执行文件（第 78–80 行的 `require_executable_hook`），缺失会在 `pg_restore` 之前退出；`RESTORE_DB_PROBE_SCRIPT` 有默认值 `infra/scripts/verify-runtime-db-role.sh`，`RESTORE_MIGRATION_SCRIPT` 缺省时回落到 `apps/api/src/migrate.ts`（需要 `npx`）。

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
PRODUCTION_CANARY_WORKSPACE_ID="$PRODUCTION_CANARY_WORKSPACE_ID" \
PRODUCTION_CANARY_BEARER_TOKEN="$PRODUCTION_CANARY_BEARER_TOKEN" \
CONFIRM_ROLLBACK=YES sh infra/scripts/rollback.sh
```

`PRODUCTION_CANARY_WORKSPACE_ID` 与 `PRODUCTION_CANARY_BEARER_TOKEN` 是 `rollback.sh` 自身强制的入参（第 164 行与第 194 行）：前者用于在回滚后的 generation/scan Worker 上做迁移兼容与扫描器心跳验收，后者用于带 `x-workspace-id` 的鉴权读路径验收；漏填会在完成滚动更新之后才退出，等于把集群留在半验收状态。

运行前还必须注入 `run-production-canary.sh` 要求的真实 `PAYMENT_*`、六平台 `PLATFORM_CANARY_*` 和写入/撤销双确认变量；这些值不得写入 bundle。注意当前上线档 `PLATFORM_OPERATIONS_MODE=manual` 走的是 `run-manual-operations-canary.sh` 分支（第 202–203 行），它额外强制 `PRODUCTION_API_BASE_URL`、`PRODUCTION_CANARY_BEARER_TOKEN`、`PRODUCTION_CANARY_WORKSPACE_ID` 三项，而不会去读 `PAYMENT_*` / `PLATFORM_CANARY_*`。`ROLLBACK_RELEASE_BUNDLE_PATH` 必须是 Ed25519 签名的 `known_good_release` JSON，包含 release/Git/manifest SHA-256、四个镜像 digest、有效期、固定 key ID，以及带 SHA-256 fragment 的 `manifest_ref` 和 `capability_evidence_ref`。两个引用都必须解析到 `PRODUCTION_EVIDENCE_ARTIFACT_ROOT` 内的普通非符号链接文件；bundle 中的 capability evidence 还必须以本次 rollback nonce 对同一 release/image-set/manifest/Git 做正式签名。

回滚后必须重新检查 `/healthz`、迁移版本、队列收敛、`publish_unknown`、重复发布和跨工作区访问；任一项失败时保持写 kill switch 关闭。

rollback 已强制签名 known-good release bundle、不可变 artifact、镜像摘要和签名 capability evidence，并以 `--rollback` 模式拒绝 `Namespace`、`Secret`、`ServiceAccount`、`Role`、`RoleBinding`、`ClusterRole`、`ClusterRoleBinding`、`PersistentVolume`、`PersistentVolumeClaim`、`StorageClass`；其他资源仍受发布清单支持列表和 digest 校验约束。数据库迁移只前进，不执行 schema downgrade。当前剩余门禁是用真实受保护 bundle 和生产集群完成回滚、队列收敛及六平台业务 canary 演练。

## 5. 扩容与容量门禁

- 使用 `infra/scripts/scale-workloads.sh pilot_50|wave_100|wave_250|target_500` 先 dry-run（不带 `EXECUTE=true` 时只打印目标副本数）；生产执行必须显式设置 `EXECUTE=true`。脚本**没有**注入式 `SCALE_COMMAND` 这一层：它直接对调用方 kubeconfig 的 6 个 Deployment 执行 `kubectl scale`，只把命名空间参数化为 `SCALE_NAMESPACE`（默认 `merchant`）。所以放量前必须自行核对 kubeconfig/context 与命名空间，不要以为有命令白名单在兜底。
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
