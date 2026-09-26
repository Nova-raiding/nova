# Release checklist — 0.1.2

日期：2026-09-13

> **历史记录，已被后续发布基线取代。** 本文描述的是 2026-09-13 的 0.1.2 快照，不是当前候选、当前状态或上线门禁；不得据此配置生产环境或判定发布。当前流程以 [ECS 候选包安全同步 runbook](../../../docs/runbooks/ecs-candidate-safe-sync.md) 和 [桌面本地安装迁移 runbook](../../../docs/runbooks/desktop-only-migration.md) 为准。
>
> 当前 ChatGPT 插件仅要求本地直装的 `local_stdio` bridge → HTTPS `/mcp` 链路；ChatGPT 云端 OAuth、OpenAI Apps challenge 和 OpenAI 发布门户审核/Publish 均不是本项目要求或上线门禁。商家平台自身的授权与生产 canary 仍按当前候选的 capability 证据要求验收，不能与 ChatGPT OAuth 混为一项。

## 历史快照元数据（仅代表 2026-09-13）

| 项目 | 当时记录值 |
|---|---|
| Repository version | `0.1.2` |
| Plugin build | `0.1.0+codex.20260912184110` |
| PostgreSQL migration tail | `192` |
| MCP methods | `303`（以共享注册表和运行态校验为准） |
| Merchant bridge tools | `146`（运行态契约为准） |
| Ops 一级域 | `11` |

## 当时验证记录（不可作为当前验收证据）

- 类型检查、API/MCP/支付安全回归、release gates 和插件镜像校验通过；版本升级后的全量 Vitest 为 `645 passed / 45 skipped`、`4788 passed / 70 skipped`，release gate 为 `127 passed / 7 skipped` 与 `566 passed / 14 skipped`。
- 桌面 Merchant/Ops Playwright 验收分别为 `22/22`、`10/10`；本地 fixture 证据只用于功能回归。
- 远端 API、UI、Ops UI、五类业务 Worker、PostgreSQL、Redis、ClamAV 和支付网关均 healthy；数据库迁移尾为 192。
- HTTPS 候选已切换到 `sha256:6c21ebcf751dfa6f046cabd5c3bd0f6acad61e7abbb83cddc588546f1e49bdc0`，镜像内 nginx 模板与源码 SHA 一致，`nginx -t` 通过，80/443 公网探针稳定，旧网关镜像保留为 rollback。
- 公网 `/healthz`、`/v1/healthz`、支付网关健康端点和法律页通过；未授权 `/mcp` 返回 401；OAuth discovery 可达。
- 支付 checkout 仅做了本地签名结构探针，未发起支付宝下单、未扣款；随机不存在订单的只读 query 已通过真实 OpenAPI 请求/响应验签并返回 `pending`。异步回调仍需支付宝控制台配置网关后由真实平台回调验证。

## 当时观察到的状态（仅供历史参考）

- 远端仍是 `NODE_ENV=development`、`DEPLOYMENT_PROFILE=local_acceptance`、`CONNECTOR_FIXTURE_MODE=true`，六个平台均为 `fixture_ready`，`productionGate=false`，插件写入关闭。
- `worker-scan` 仍是旧镜像的 Created 容器，没有新的真实 scanner callback/heartbeat；不得启动或伪造回执。
- 当时 `/.well-known/openai-apps-challenge` 与 OAuth authorize/token 返回 503；这些是旧版公共宿主/远程 OAuth 路径的历史观察，不构成当前项目的配置要求或上线阻断。
- 支付宝应用网关尚未配置。必须由账户所有者在支付宝控制台完成安全验证并填写 `https://yxsona.com/payment-gateway/v1/notify/alipay`，再等待真实平台回调；支付密码、短信验证码和私钥不得交给模型。
- 尚无同一 release 的生产 capability/capacity、托管存储/KMS/PITR、真实平台 canary、备份恢复、告警值守和发布安全控制面签署证据。

## 当时的后续事项（不是当前上线清单）

1. 当时记录了真实商家平台授权、Vault、scanner 和对象存储等生产配置事项；这些事项是否仍适用，必须按当前候选门禁和证据重新核实。ChatGPT OAuth server 与 OpenAI challenge 不属于当前要求。
2. 由账号所有者完成支付宝应用网关配置，并以真实平台回调验签探针及一笔经批准的 sandbox/测试订单完成对账证据。
3. 生成并签署绑定 `release_id`、Git SHA、manifest SHA、image set digest 的 production bundle，注入 `/releasez`，再运行真实平台/支付/扫描/回滚 canary。
4. 旧版公共插件市场的门户审核/Publish 计划已废弃，不属于当前项目交付范围或上线门禁。

本文中的历史 NO-GO 结论不代表当前发布结论；当前候选必须依照上方链接的 runbook 重新评审并采集对应证据。
