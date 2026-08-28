# Release handoff — 0.1.0 engineering RC

日期：2026-08-27

## 本地交付状态

- 96 个测试文件、639 个测试全部通过。
- TypeScript、MCP bridge、批量商品垂直链路和基础设施校验通过。
- 已覆盖多品、多平台、多店铺、canonical product/listing、批量任务、幂等重试和冲突门禁。
- Compose API、PostgreSQL、Redis、Sync/Generation/Publish/Reconcile Worker 健康。
- 备份恢复、Redis 重启后的 Outbox replay、50 工作区 HTTP smoke 通过。
- MCP 已提供 `catalog.sync.start` / `catalog.sync.get`，同步由 Outbox + 独立 Sync Worker 执行，分页游标可恢复。
- PostgreSQL migration 已扩展至 039；039 纳入品、店铺绑定、canonical product、listing、批量计划和上下文快照约束。
- `npm audit --omit=dev`：0 vulnerabilities。

## 发布前必须由外部环境完成

1. 六平台真实 OAuth、scope、测试店铺、商品读取/创建/更新/状态回读和撤销 canary（京东、淘宝、天猫、拼多多、小红书、抖音分别签署）。
2. 真实云 50/100/250/500 波次、6 小时稳定性、滚动重启、噪声租户公平性和连接池预算证据。
3. 托管 PostgreSQL/Redis、Secret Manager/Vault、KMS、对象存储、WAF、DNS、TLS、OTel 和值班告警实操。
4. 使用最终镜像 digest 渲染 Kubernetes 清单，并通过 `infra/scripts/deploy-preflight.sh`。
5. 使用真实 Git 仓库执行 review、commit、CI 和发布；当前工作目录没有 `.git`，本次未初始化、未 reset、未覆盖其他人的测试修改。

当前 CodeGraph 索引已刷新：253 个文件、4,049 个节点、17,699 条边。

## 建议发布顺序

```text
外部 Day 0 平台/云门禁
  -> 预发布渲染与 deploy-preflight
  -> 六平台独立 canary
  -> pilot_50 容量与稳定性
  -> 6–9 家商家试点
  -> wave_100 / wave_250 / target_500
```

本文件是交付审计和接管清单，不把本地 fake/Compose 结果标记为真实云或真实平台通过。
