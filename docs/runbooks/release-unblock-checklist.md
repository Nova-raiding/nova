# Store Nova 发布解阻清单

本文是人工发布准备清单，不替代 `deploy-verified-ecs-compose.sh` 的发布门禁。每次执行前必须重新冻结候选身份；下方历史状态只用于说明差距，不是可复用的发布输入。

## 1. 固定候选身份

历史快照（2026-09-19）：当时的候选为 `main` / `3e3522ab024102d0b451785928bd71fa89051a87`，101 上候选容器为更旧的 `53721389bf6d3399b264642bc0c5969302ad39e8`。这些 SHA、差异文件数和缺失文件数不代表当前状态，不能直接用于后续 staging 或发布。

当前插件包候选在 `codex/windows-plugin-bundle` 分支；正式发布前从最终审核提交读取完整 Git SHA、`release-metadata.json`、包及镜像摘要，并与目标主机 `/releasez` 身份逐项核对。生产 `/releasez` 若属于旧提交，即使返回 ready，也不能证明当前候选已上线。

发布前必须把以下字段绑定到同一 `RELEASE_ID`，不得现场修改或复用旧证据：Git SHA、源码归档摘要、镜像摘要、渲染 Compose 摘要、deployment nonce、capability/capacity evidence。

## 2. 数据库迁移

1. 保存当前数据库和 Compose 回滚状态。
2. 通过候选 release 的迁移入口执行前向迁移；不得直接修改 `schema_migrations`。
3. 迁移前后分别以 `merchant_app` 和 `merchant_ops` 非 superuser、非 `BYPASSRLS` 角色做只读检查。
4. 目标版本必须等于 `release-metadata.json` 的 `expectedMigrationVersion`（本文不写死该数字，以免新增迁移后过期），并且 1 至该版本连续、名称和 SQL checksum 与候选源码一致。
5. 验证 `public_platform_rule_versions` 与 `public_platform_rule_audits` 已创建；商家角色只能读公共规则，运营角色才能写生命周期，审计表 UPDATE/DELETE 必须被拒绝。

## 3. Scanner callback

1. 不手工写 Redis、数据库或 heartbeat 文件。
2. 先确认 scanner 的 API endpoint、签名私钥、公钥指纹、workspace 绑定和 ClamAV 配置来自受保护的运行时 secret。
3. 通过真实隔离素材产生一次扫描任务，使 API 接受签名 callback。
4. 必须同时观察到：`callback_accepted_at`、heartbeat `callback.capable=true`、heartbeat 未过期、`ready=true`、backlog/dead-letter 为零。
5. 先以当前 release 的 Compose 项目和镜像身份确认目标容器；2026-09-23 的 101 正式扫描容器是 `merchant-production-worker-scan-1`，不能把同机旧 `local-worker-scan-1` 的日志或健康状态当作生产证据。正式扫描实例只有在上述证据齐全后才能进入 ready；没有 callback 证据时保持发布阻断。

## 4. 发布证据

以下证据必须由生产环境生成并签名，禁止使用 fixture/example/test_e2e 文件替代：

- 平台 capability canary（当前六平台按人工运营模式记录；不虚构 OAuth/API 成功）；
- capacity report，或显式 `CAPACITY_PROFILE=no_load` 对应的未执行声明（`status=not_performed`、`cloud_gate=false`、`capacity_commitment=none`），仍须绑定当前 release 并纳入签名 evidence bundle；
- model relay、Codex app host、object storage、payment、restore evidence；
- release manifest 和 evidence bundle，全部绑定同一 release identity。

模型中转 evidence 除五模态成功请求外，还必须包含同一 release 的真实 503→恢复
轨迹：失败与恢复请求 ID 必须不同、时间有序，并引用受保护 evidence root 下带
SHA-256 的不可变原始 artifact。配置存在、鉴权 key 已注入或一次直连成功均不等价
于 request/usage/cost/error 闭环；不得人为让生产 relay 故障来补证据。

低成本执行顺序固定为：先 `--modalities=text,ocr`；确认真实 request ID、token
usage 和成本后，再由人工显式设置 `MODEL_RELAY_CANARY_CONFIRM=true` 执行 image、
image_edit，最后执行最短 3 秒 video。媒体探针不得自动重跑；异步 video 优先使用
`MODEL_RELAY_CANARY_VIDEO_TASK_ID` 轮询既有任务。503 恢复只能从自然发生或批准演练
留下的两个真实 capture 归档：

每次 `--probe` 均须显式设置 `MODEL_RELAY_CANARY_MAX_TOTAL_CNY`，它是该次进程的
人民币预算。canary 会先从已鉴权 relay 获取价格快照，按最多三次 429 尝试预留
预算；未知或零价格、预算不足时不会发送生成请求。视频新任务还须显式设置
`VIDEO_DURATION_SECONDS=3` 与 relay 定价支持的 `VIDEO_RESOLUTION=720P`（或
`1080P`），不能仅凭应用运行时的 `MODEL_*_MAX_REQUEST_CNY` 额度放行。
该请求前预算不是 relay 账户的服务端硬额度；执行前仍应核对账户级限额及
实际定价，生成后以 provider usage/cost 收据结算，不把预估写成实付。
生产探针现在还会以相同的模型/视频 Bearer token 只读查询
`GET /api/usage/token/`，要求两者 `unlimited_quota=false`、有限正剩余额度和
未过期状态；查询结果进入带 SHA-256 的不可变 artifact，并由发布证据门禁复核。
101 当前模型和视频 token 均返回 `unlimited_quota=true`，因此在中转后台为生产
token 配置有限的服务端额度、再重新采集证据前，五模态门禁保持 NO-GO。此步骤
不能由本地 `MODEL_RELAY_CANARY_MAX_TOTAL_CNY` 替代，也不能靠伪造快照通过。

```sh
export RELEASE_ID='release-<当前冻结的候选标识>'
npx tsx scripts/model-relay-recovery-evidence.ts \
  --failure /受保护路径/relay-503.json \
  --recovery /受保护路径/relay-recovered.json \
  --artifact-root /受保护证据根目录 \
  --release-id "$RELEASE_ID" \
  --output "/受保护路径/${RELEASE_ID}-relay-recovery.json"
```

该命令不发网络请求，只验证并封存已有响应；随后将输出路径作为
`MODEL_RELAY_ERROR_RECOVERY_PATH` 交给五模态 canary。

### 4.1 容量采集入口（默认不联网）

本次发布按用户要求不执行压测，不创建 50 个工作区或测试账号。使用正式 `no_load` 声明明确记录没有容量验证、没有容量承诺；不能把它标记为 `pass` 或 `cloud_gate=true`。该范围不豁免真实登录、租户权限、业务 E2E、模型调用、支付、对象存储、备份恢复和发布身份验证。下面的容量采集流程仅供未来另行批准的负载验证使用，不属于本次部署步骤。

容量采集只允许针对隔离预发环境。默认 `plan` 仅输出不可执行计划，不发送请求；
`yxsona.com` 与 `ops.yxsona.com` 生产域名会被脚本直接拒绝。当前候选可先执行：

```sh
RELEASE_ID='release-<当前冻结的候选标识>' \
CAPACITY_PROFILE=pilot_50 \
CAPACITY_CAPTURE_TARGET_URL='https://<isolated-preproduction-host>' \
CAPACITY_CAPTURE_OUTPUT='/受保护证据目录/<当前冻结的候选release-id>-capacity-raw.json' \
sh infra/scripts/capture-ecs-capacity-evidence.sh plan
```

经容量窗口、隔离预发资源和影响范围人工批准后，才可额外设置
`CAPACITY_CAPTURE_TARGET_KIND=isolated_preproduction`、
`CAPACITY_CAPTURE_CONFIRM=<当前冻结的候选release-id>`、`CAPACITY_CAPTURE_EXPECTED_GIT_SHA=<完整40位提交>`
与受保护 token，并把动作改为 `capture`。采集器会先请求 `/releasez`，且仅在
release ID、Git SHA 和 ready 身份均与候选一致时才发送负载；身份请求与容量请求均不跟随重定向。
隔离环境必须预先创建该 profile 所需的 `ws_capacity_0..N` 工作区，并为每个工作区绑定淘宝测试账号；采集会真实执行任务创建与 job admission，缺少账号时必须失败，不能把零任务报告当作覆盖证据。
该入口只采集 API HTTP 与 job admission 原始观测，强制保留 `cloud_gate=false`，
不能替代平台真实流量、故障注入、租户噪声隔离、六小时稳态和人工签署；最终
capacity evidence 仍必须独立生成并通过 `deploy-preflight-ecs.sh` 的 cloud gate。

## 4.2 告警通道（当前未成立，NO-GO 前置条件）

发布前 Go/No-Go 清单里的「告警接收人、升级电话、值班工程师」这一项**当前不成立**，必须按未满足处理，不得勾选：

- 仓库没有部署 Prometheus / Alertmanager / Grafana，`infra/observability/prometheus-alerts.example.yaml` 是**未部署的规则模板**，一条规则都不在生效。
- 没有真实 paging 通道：全仓没有任何邮件/短信/IM/on-call 适配器；API 的 `notifyOperationalAlert` 只把 HMAC 告警报文投给 `apps/alert-receiver`，而 receiver 的终点是 `alert_webhook_receipts` 表。receiver 的 README 自己声明它不是 pager、不是升级策略、也不是「有人确认」的证据。
- 没有值班表和演练记录。ECS pilot 环境默认 `OPS_ALERT_NOTIFICATIONS_ENABLED: "false"`、`OPS_ALERT_WEBHOOK_URL: ""`，连落库这一段都是关闭的。
- 规则与指标的逐条对照（哪些依赖当前不存在、哪些即使加载也永远为假）见规则文件头部的「指标可用性矩阵」；缺口清单、要补齐的六项以及最小可行方案的代价，见 [`doc/todo/release/production-ops-runbook.md`](../../doc/todo/release/production-ops-runbook.md) 的「3.4 告警通道现状」。

判定：**在部署监控栈 + 接入真实 paging 通道 + 值班表 + 至少一次触发/送达/人工确认演练记录齐备之前，这一项保持 NO-GO**；不得用「已配置 webhook」或「规则文件已提交」替代。

## 5. 最终门禁

```sh
npm run typecheck
npm run test:release-gates
sh infra/scripts/deploy-preflight-ecs.sh
sh infra/scripts/deploy-verified-ecs-compose.sh
```

若任何 preflight 失败，保留现场并修复对应证据；不要删除容器、数据库卷或重写迁移历史来清除失败状态。

## 6. 验收标准

```sh
curl -fsS https://yxsona.com/api/healthz
curl -fsS https://ops.yxsona.com/healthz
curl -fsS https://yxsona.com/api/releasez
ssh 101 'docker ps --format "table {{.Names}}\\t{{.Status}}"'
```

只有 `/api/releasez` 返回 `ready=true`、数据库目标迁移等于 `release-metadata.json` 的 `expectedMigrationVersion`、scanner healthy 且候选 release 身份一致，才可以向商家开放真实使用。
