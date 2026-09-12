# Release checklist — 0.1.2

日期：2026-09-13

这是当前候选版本的发布记录。它区分“代码/运行态已验证”和“仍需外部真实证据”，不把本地 fixture 或负向测试当作生产成功。

## 权威元数据

| 项目 | 当前值 |
|---|---|
| Repository version | `0.1.2` |
| Plugin build | `0.1.0+codex.20260912184110` |
| PostgreSQL migration tail | `192` |
| MCP methods | `303`（以共享注册表和运行态校验为准） |
| Merchant bridge tools | `146`（运行态契约为准） |
| Ops 一级域 | `11` |

## 已验证

- 类型检查、API/MCP/支付安全回归、release gates 和插件镜像校验通过；版本升级后的全量 Vitest 为 `645 passed / 45 skipped`、`4788 passed / 70 skipped`，release gate 为 `127 passed / 7 skipped` 与 `566 passed / 14 skipped`。
- 桌面 Merchant/Ops Playwright 验收分别为 `22/22`、`10/10`；本地 fixture 证据只用于功能回归。
- 远端 API、UI、Ops UI、五类业务 Worker、PostgreSQL、Redis、ClamAV 和支付网关均 healthy；数据库迁移尾为 192。
- HTTPS 候选已切换到 `sha256:6c21ebcf751dfa6f046cabd5c3bd0f6acad61e7abbb83cddc588546f1e49bdc0`，镜像内 nginx 模板与源码 SHA 一致，`nginx -t` 通过，80/443 公网探针稳定，旧网关镜像保留为 rollback。
- 公网 `/healthz`、`/v1/healthz`、支付网关健康端点和法律页通过；未授权 `/mcp` 返回 401；OAuth discovery 可达。
- 支付 checkout 仅做了本地签名结构探针，未发起支付宝下单、未扣款；随机不存在订单的只读 query 已通过真实 OpenAPI 请求/响应验签并返回 `pending`。异步回调仍需支付宝控制台配置网关后由真实平台回调验证。

## 当前阻断（NO-GO）

- 远端仍是 `NODE_ENV=development`、`DEPLOYMENT_PROFILE=local_acceptance`、`CONNECTOR_FIXTURE_MODE=true`，六个平台均为 `fixture_ready`，`productionGate=false`，插件写入关闭。
- `worker-scan` 仍是旧镜像的 Created 容器，没有新的真实 scanner callback/heartbeat；不得启动或伪造回执。
- `/.well-known/openai-apps-challenge` 返回 `503 OPENAI_APPS_CHALLENGE_NOT_CONFIGURED`；生产 OAuth authorize/token 也返回明确 503。需要发布门户发放的 challenge token、真实 OAuth 授权服务器和 reviewer credentials。
- 支付宝应用网关尚未配置。必须由账户所有者在支付宝控制台完成安全验证并填写 `https://yxsona.com/payment-gateway/v1/notify/alipay`，再等待真实平台回调；支付密码、短信验证码和私钥不得交给模型。
- 尚无同一 release 的生产 capability/capacity、托管存储/KMS/PITR、真实平台 canary、备份恢复、告警值守和发布安全控制面签署证据。

## 上线前必须完成

1. 在密钥管理器注入真实平台 OAuth、Vault、scanner、对象存储、OAuth server 和 OpenAI challenge 配置，并将生产环境切换为 `CONNECTOR_FIXTURE_MODE=false`。
2. 由账号所有者完成支付宝应用网关配置，并以真实平台回调验签探针及一笔经批准的 sandbox/测试订单完成对账证据。
3. 生成并签署绑定 `release_id`、Git SHA、manifest SHA、image set digest 的 production bundle，注入 `/releasez`，再运行真实平台/支付/扫描/回滚 canary。
4. 在可见浏览器中完成 OpenAI 发布门户的人机验证；门户审核通过后再点击 Publish。提交或审核通过不等于已经公开发布。

当前结论：代码与 pilot 运行态可继续验收，生产和 ChatGPT 公共市场发布仍为 **NO-GO**。
