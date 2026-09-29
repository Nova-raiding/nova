# 2026-09-29 演示环境直接更新与验收

本记录只描述本机 `merchant-demo` 演示 Compose，不代表生产发布，也不代表 ChatGPT App 工具矩阵通过。

## 更新结果

- 按 owner 的 demo 直接覆盖要求，从当前工作树重新构建并启动 `merchant-demo` Compose。
- 更新前对 demo PostgreSQL 做了逻辑备份，位于 `/tmp/codex-demo-db-backups-20260929/merchant-demo-before-latest-reset.dump`；SHA-256 `55580c82ad9417b04e40f30d8a3b314f448331cf004f5d8d36c64940b1513a5d`。仅重置 `merchant-demo_merchant-postgres`，其他 demo 卷及 `local` 项目未删除。
- 全新 demo schema 迁移连续 1–255，共 255 条，当前版本 `scoped_brand_settings`，checksum `3ca08679671e6d427308f19594a987d157efa33639d461cd84339d703ab0c279`。这属于从空库创建当前 schema，不是对旧生产库执行兼容升级。
- API `/healthz`、`/readyz`，商家 UI `/readyz`，运营台 `/healthz` 均 HTTP 200；Compose 中 API/UI/Ops/Postgres/Redis/ClamAV/worker 健康检查均通过。
- `npm run typecheck` 通过；本轮定向回归 5 个文件、37/37 通过；运营台只读浏览器矩阵 1/1 通过；商家隔离桌面矩阵 1/1 通过，10 个路由无 page error 或失败 API 请求。

此前浏览器矩阵均为隔离夹具启动的候选代码验收，不代表运行中的 demo UI 实测。当前 Compose 在线入口另见下方只读浏览器验收；隔离矩阵报告中的 `productionBrowser=false`。

## 当前 merchant-demo 在线桌面浏览器验收（只读）

- 验收目标经 Compose 核实为 `merchant-demo` 项目的 `ui` (`127.0.0.1:28081`) 与 `ops-ui` (`127.0.0.1:28082`)；视口 1440×1000。两个页面都实际加载，截图和结构化结果分别保存在 `artifacts/demo-deploy/2026-09-29/live-browser-merchant/` 与 `live-browser-ops/`。
- 商家端显示登录页“欢迎使用 Store Nova”；未登录导致唯一 API 响应为 `GET /api/v1/auth/session` 401。代码将无有效会话映射为 401；这是匿名登录入口的预期鉴权探测，但 Chromium 同时记录了资源 401 console error。无 page error、无其他失败请求。未输入账号、提交表单或执行写操作。
- 运营台重定向到 `/ops/overview` 并显示平台运营账号登录页；未输入账号、提交表单或触发 API 请求。无 console error 或失败请求。
- 随后以全新匿名 Chromium context 直达 14 条受保护路由：商家端概览、商品、素材、财务、成员、任务 6 条；Ops 概览、用户、店铺、规则、模型、存储、财务、审计 8 条。全部 document 导航 HTTP 200、只观测到 GET、无 requestfailed/page exception；所有路由均保留请求 URL 并显示登录入口。商家 6 条均有 `GET /api/v1/auth/session` 401，并伴随对应 Chromium resource-error console 记录；Ops 8 条没有 API 请求或 console error。该矩阵验证匿名路由保护和 SPA 回退，不代表登录后内容已渲染。
- 此在线实测仅覆盖两个未登录入口的桌面渲染与匿名态鉴权行为。由于没有经授权的现成登录会话，本轮没有进入登录后路由，也不据此宣称商家/运营工作流验收完成。运行镜像身份仍未绑定：merchant UI image `sha256:b781111e947d4321406db3d1fe49ced7271e50b586a3c48b180aefbe52cfa446`、Ops UI image `sha256:ecb7a9c58b8d63ac823ec219a8f595b9e060af21509ae25374af8b072509d948`；两个前端 `build-meta.json` 都是 `unbound`，API `/releasez` 的 release ID/SHA 为 null。镜像 digest 可识别构建产物，但不能把 dirty 工作树 HEAD 当作镜像源码 SHA；本记录只代表本机 demo 实例观察，不是可追溯源码 SHA 的候选发布验收。

## 未通过项与原因

扫描业务 canary 未执行，理由是当前 demo candidate 不满足安全门禁，而非容器未启动：

1. `http://127.0.0.1:8787/releasez` 返回 `release_id=null`、`release_git_sha=null`、`ready=false`，不能把未绑定构建伪装成已识别候选。
2. scanner heartbeat 虽 `recoveryCapable=true`，但 `callback.capable=false`，理由包含 `scanner_callback_not_capable` 与 `scanner_callback_stale`。健康检查不能替代真实签名回执。
3. demo worker 配置范围含 `ws_demo` 等 ID，但当前重置后只具备演示种子数据，尚无独立证据证明其中任一是预先存在的专用 QA workspace 且具备真实 `asset.upload` 权益。runbook 禁止在商家业务工作区试传。

因此没有发起上传，没有伪造 release ID、workspace 专用性或签名回执。要完成扫描验收，需先提供绑定完整 Git SHA 的 candidate 身份、受保护运行态下具备 callback 能力的 worker，以及独立证明过的专用 QA workspace/上传权益，然后依照 `docs/runbooks/scanner-callback-canary.md` 执行唯一一次 canary 与只读 DB 证据采集。

## 证据

- 容器、HTTP、迁移、类型检查与定向测试：`artifacts/demo-deploy/2026-09-29/`
- 桌面浏览器隔离候选矩阵（非 merchant-demo live browser）：运营台 [Playwright 报告](../../../../artifacts/ops-jit-isolation/2026-09-29T04-13-30.696Z-a0bd6863-1db1-49a3-a78b-14b7c6dc74a0/playwright.json)、[矩阵摘要](../../../../artifacts/ops-jit-isolation/2026-09-29T04-13-30.696Z-a0bd6863-1db1-49a3-a78b-14b7c6dc74a0/desktop-readonly-matrix/matrix.json)；商家工作台 [Playwright 报告](../../../../artifacts/ops-jit-isolation/2026-09-29T04-14-01.755Z-27cac83c-004c-4fed-89fe-ec4f9d26637a/playwright.json)、[矩阵摘要](../../../../artifacts/ops-jit-isolation/2026-09-29T04-14-01.755Z-27cac83c-004c-4fed-89fe-ec4f9d26637a/merchant-desktop-matrix/matrix.json)。
- merchant-demo 在线入口截图和结构化记录：`artifacts/demo-deploy/2026-09-29/live-browser-merchant/`、`live-browser-ops/`。
- 在线验收证据 SHA-256：merchant `home.png` `94b2a5d5afe8c5eb5dd0843416a500c74a45272420e04cfc11dc3d1b1427faeb`，`browser-evidence.json` `bb1e1cf94a34c62dfe9a40c4854e93067daa20b6f09ca4a8a98bf8733d34391d`；Ops `ops-home.png` `d1fa6c2139a880025c7fa00accdbecce9006d2bf868bf6d5ae5e5be845e93a30`，`browser-result.json` `4e67003bccc630f088167af9c40f0ea7ed38fd8c12bf48ba9e246062ad347017`。
- 14 路由匿名态检查摘要：`artifacts/demo-deploy/2026-09-29/live-browser-protected-routes/route-matrix.json`。
