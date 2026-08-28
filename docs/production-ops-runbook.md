# 商家营销内容助手生产运维 Runbook

版本：v1.0（与部署配置和发布版本一起变更）

本 Runbook 是生产操作清单，不替代云厂商、平台开放文档或安全审批。每次操作必须记录 `release_id`、操作者、`request_id/trace_id`（如有）、开始/结束时间和结论。任何平台写操作、凭证轮换和数据库恢复都需要双人复核。

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
9. `model-relay-release-1.json` 必须由五类真实中转探测生成；每类都要有 provider request ID、usage 和 cost 证据，不能用 fixture 或“已配置”替代真实成功。
10. 告警接收人、升级电话、回滚版本和 kill switch 已确认，且至少有一名当班工程师在线。

部署前先执行只读 preflight，必须使用已渲染的生产配置、六个平台能力证据 JSON、真实云容量报告和不可变镜像摘要：

```sh
PRODUCTION_CONFIG_PATH="$RENDERED_PRODUCTION_CONFIG" \
RELEASE_ID="$RELEASE_ID" \
IMAGE_DIGEST="$IMAGE_DIGEST" \
RENDERED_MANIFEST_PATH=/secure/release/rendered.yaml \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
REDIS_URL="$PRODUCTION_REDIS_URL" \
SECRET_PROVIDER="managed-secret-store" \
CAPACITY_PROFILE="pilot_50" \
CAPABILITY_EVIDENCE_PATH=/secure/evidence/platform-capability-evidence.json \
CAPACITY_REPORT_PATH=/secure/evidence/pilot-50-capacity-report.json \
MODEL_RELAY_EVIDENCE_PATH=/secure/evidence/model-relay-release-1.json sh infra/scripts/deploy-preflight.sh
```

其中 `RENDERED_MANIFEST_PATH` 必须是实际将要执行 `kubectl apply` 的渲染结果（例如 `kubectl kustomize infra/kubernetes/overlays/pilot-50 > /secure/release/rendered.yaml`）。门禁会逐个检查容器镜像：不得含 `REPLACE_ME`、`latest` 或 tag-only 引用，必须带 64 位 `@sha256:` digest，且必须与 `IMAGE_DIGEST` 完全一致。该命令只检查配置、渲染清单和元数据，不执行迁移、扩容、发布或回滚；失败时不得继续部署。

## 2. 标准部署顺序

1. 锁定 `release_id`、配置版本、镜像 digest 和迁移版本。
2. 执行数据库备份：

   ```sh
   DATABASE_URL="$PRODUCTION_DATABASE_URL" BACKUP_DIR="$BACKUP_DIR" \
     sh infra/scripts/backup-postgres.sh
   ```

3. 先执行向后兼容的迁移；迁移失败立即停止放量，不执行自动反向迁移。
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

   ```sh
   DATABASE_URL="$RECOVERY_DATABASE_URL" BACKUP_FILE="$BACKUP_FILE" \
   NODE_ENV=production CONFIRM_RESTORE=YES RESTORE_TARGET_ISOLATED=YES sh infra/scripts/restore-postgres.sh
   ```

3. 执行迁移、健康检查、跨工作区隔离、Outbox/任务恢复和只读 smoke；确认后再开启 Worker 和流量。
4. 记录实际 RPO/RTO；恢复过程禁止把旧 Redis 数据当作事实来源。

### 回滚

仅回滚兼容应用版本，不自动执行破坏性 schema 反向迁移：

```sh
RELEASE_ID="$KNOWN_GOOD_RELEASE" \
ROLLBACK_COMMAND="$ROLLBACK_COMMAND" \
CONFIRM_ROLLBACK=YES sh infra/scripts/rollback.sh
```

回滚后必须重新检查 `/healthz`、迁移版本、队列收敛、`publish_unknown`、重复发布和跨工作区访问；任一项失败时保持写 kill switch 关闭。

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
