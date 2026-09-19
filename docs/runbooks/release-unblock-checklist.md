# Store Nova 发布解阻清单

本文只用于当前候选版本的人工发布准备，不替代 `deploy-verified-ecs-compose.sh` 的发布门禁。

## 1. 固定候选身份

候选分支：`main`

当前候选提交：`3e3522ab`（完整 SHA：`3e3522ab024102d0b451785928bd71fa89051a87`）

候选包已于 2026-09-19 生成。101 上现有候选容器仍绑定旧提交 `53721389bf6d3399b264642bc0c5969302ad39e8`，不得将其视为当前候选；必须先完成安全同步、人工合并 21 个差异文件，并补齐 45 个远端缺失文件后再 staging。

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
5. `local-worker-scan-1` 只有在上述证据齐全后才能进入 healthy；没有 callback 证据时保持发布阻断。

## 4. 发布证据

以下证据必须由生产环境生成并签名，禁止使用 fixture/example/test_e2e 文件替代：

- 平台 capability canary（当前六平台按人工运营模式记录；不虚构 OAuth/API 成功）；
- capacity report；
- model relay、Codex app host、object storage、payment、restore evidence；
- release manifest 和 evidence bundle，全部绑定同一 release identity。

## 4.1 告警通道（当前未成立，NO-GO 前置条件）

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
