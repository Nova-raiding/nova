# Ops Console 本地演示数据

`infra/local/seed-demo.sql` 只由 Local Compose migration 容器执行，不属于生产部署清单。数据固定在 `ws_demo`，用于验证运营后台连接真实 PostgreSQL 后的只读页面状态。

演示事实覆盖工作区套餐与试用订阅、六平台显示设置、两个 Fixture 店铺账号、一个 Fixture 商品、待审核与可恢复失败任务、未激活内部演示规则、开放告警、操作审计、支持工单、演练事故、未支付 Fixture 账单、待成本确认的 Fixture 模型用量，以及保持禁用的本地 feature flag。

所有数据使用固定 ID 和固定时间，重复运行不会增加记录；append-only 历史使用 `ON CONFLICT DO NOTHING`。租户表在事务内设置 `app.workspace_id=ws_demo`，不修改 RLS policy、角色或授权。

## 证据边界

- 平台凭据引用只使用 `fixture://local-demo/...`，不保存 access token、refresh token 或生产凭据。
- 商品来源为 `fixture`，快照和告警证据带 `local_compose_seed` 与 `productionEvidence=false`。
- 演示规则保持 `draft`，feature flag 同时 `enabled=false`、`emergency_disabled=true`。
- 订阅为零金额 `trialing`；唯一账单保持 `pending + fixture`，模型用量保持 `pending_cost`。不创建到账、退款、发布成功、模型成功或 production canary 记录。
- 小红书演示账号保持 `refresh_required`，不能据此宣称平台已就绪。

本地检查：

```bash
docker exec -i local-postgres-1 psql -U merchant -d merchant -v ON_ERROR_STOP=1 < infra/local/seed-demo.sql
docker exec -i local-postgres-1 psql -U merchant -d merchant -v ON_ERROR_STOP=1 < infra/local/seed-demo.sql
npx vitest run packages/persistence/src/seed-demo.test.ts
```
