# 2026-09-29 本地桌面浏览器隔离验收补充

本记录是本地候选代码的浏览器证据，不代表生产部署或 ChatGPT App 工具验收。

本轮所称“隔离矩阵”使用一次性 Postgres/Redis 夹具及隔离候选服务，`productionBrowser=false`。它不验证当前运行中的 `merchant-demo` Compose 服务/UI 端口；merchant-demo live browser acceptance 另见下文，覆盖未登录入口与受保护路由的匿名态，不含登录后流程。

## 结果

- `npm run test:browser:ops:matrix`：通过，`ops-desktop-readonly-matrix.spec.js` 1/1。隔离 Postgres 夹具、单工作线程；验证 overview、users、stores、rules、finance、customer-delivery、storage、audit、models 等页面及授权工作区选择。浏览器运行记录显示 API 失败请求 `[]`。
- `node --import tsx scripts/merchant-isolated-screenshot-matrix.ts`：通过，`ops-merchant-matrix-bootstrap.spec.js` 1/1。使用一次性 Postgres/Redis 夹具完成商家登录并访问 10 个工作台路由；浏览器 page errors 和 failed API 均为 `[]`。任务、发布、规则路由按当前导航规则回到商品/素材页。
- `npm run typecheck`：本轮收尾后通过。
- 本轮定向回归：5 个测试文件，37/37 通过，覆盖 canonical 扫描权限、创意点区间窗口、空状态、回收站文案和结算实际消耗解析。
- 更早的 MCP/API/运营台/商家工作台测试记录为 205 通过、1 项 Postgres 测试因隔离数据库条件跳过；独立 bridge 与 MCP 契约回归为 261 项通过。这两组历史汇总没有单独保存机器输出日志，不作为本轮收尾的验证依据。

## 证据位置

- 运营台矩阵：`artifacts/ops-jit-isolation/2026-09-29T03-40-26.528Z-18d27a9d-01de-40f1-ba00-e1b2ac64d39f/`
- 商家工作台矩阵及截图：`artifacts/ops-jit-isolation/2026-09-29T03-41-33.023Z-60b815b9-26fe-4581-bf47-5b0c6d864623/merchant-desktop-matrix/`，摘要文件为 `matrix.json`。
- 本轮重建后的运营台隔离候选矩阵：[Playwright 报告](../../../../artifacts/ops-jit-isolation/2026-09-29T04-13-30.696Z-a0bd6863-1db1-49a3-a78b-14b7c6dc74a0/playwright.json)、[矩阵摘要](../../../../artifacts/ops-jit-isolation/2026-09-29T04-13-30.696Z-a0bd6863-1db1-49a3-a78b-14b7c6dc74a0/desktop-readonly-matrix/matrix.json)。
- 本轮重建后的商家隔离候选矩阵：[Playwright 报告](../../../../artifacts/ops-jit-isolation/2026-09-29T04-14-01.755Z-27cac83c-004c-4fed-89fe-ec4f9d26637a/playwright.json)、[矩阵摘要](../../../../artifacts/ops-jit-isolation/2026-09-29T04-14-01.755Z-27cac83c-004c-4fed-89fe-ec4f9d26637a/merchant-desktop-matrix/matrix.json)。
- 本轮 typecheck 原始输出：`artifacts/demo-deploy/2026-09-29/typecheck.log`；定向 37/37 回归原始输出：`artifacts/demo-deploy/2026-09-29/targeted-tests.log`。
- 演示容器、迁移状态和 HTTP 探针摘要：`artifacts/demo-deploy/2026-09-29/container-health.txt`、`migration-state.txt`、`http-health.txt`。
- 浏览器候选脚本 `npm run test:browser:merchant` 因其安全门禁要求干净、已冻结提交的工作区而未运行；没有绕过门禁。

## 2026-09-29 演示栈直接更新

- 按 owner 确认的演示环境重置，仅替换 `merchant-demo_merchant-postgres` 卷；镜像由 `docker compose -p merchant-demo -f infra/local/docker-compose.yml up -d --build` 从当前工作树构建，随后以仓库 `.env` 中受保护的运行配置及原演示端口重新启动。旧演示数据库恢复点保存在本机 `/tmp/codex-demo-db-backups-20260929/merchant-demo-before-latest-reset.dump`，SHA-256 为 `55580c82ad9417b04e40f30d8a3b314f448331cf004f5d8d36c64940b1513a5d`；未纳入仓库。
- `migrate` 容器退出码为 0；全新演示数据库 `schema_migrations` 为连续 1–255，共 255 条。API `/healthz` 和 `/readyz`、商家 UI `/readyz`、运营台 `/healthz` 均返回 HTTP 200。演示 Compose 中 API、UI、Ops UI、Postgres、Redis、ClamAV 和六个 worker 的容器健康检查均通过。
- 本轮运营台桌面矩阵 1/1 通过、API 失败请求为空；商家工作台矩阵 1/1 通过，10 个路由的 page errors 和 failed API 均为空。两项均使用隔离 Postgres/Redis 夹具，不是 ChatGPT App 或生产环境验收。
- scanner worker 的健康状态代表 recovery 能力；其 heartbeat 仍为 `ready=false`、`recoveryCapable=true`、`callback.capable=false`，因此不记扫描业务 ready。真实签名 callback canary 仍按 runbook 单独验收。
- 另一个 `local` Compose 项目未重置；其旧 v144 数据仍与此演示重建分开。本轮演示更新不把 `local-ops-ui-1` 的旧 502 记作演示栈失败，也不将两个项目的证据混用。

## 仍待处理

- ChatGPT App `0.1.0+codex.20260929114000` 的 116 工具矩阵目前只有 `onboarding.status` 一项具备该版本真实工具事件证据；其余 115 项仍待真实 App 会话验收。
- `npm run test:browser:merchant` 因安全门禁要求干净、已冻结提交的工作区而未运行；本轮没有提交或绕过该门禁。
- 本地共享 `local-ops-ui-1` 因同网络找不到 `api` 服务而在 `/api/readyz` 返回 502；后续只读诊断确认 API 未启动是迁移失败的下游结果。`merchant-demo-worker-scan-1` 的数据库、Redis、ClamAV、队列检查正常，但 scanner callback 不具备能力，heartbeat 已过期。诊断期间未重启或修改它们。
- 当前本地迁移器在版本 144 检出 approved checksum 与工作树迁移文件不一致并 fail-closed；共享数据库未检查/修改，也未删除卷或重跑迁移。

## 扫描 canary 门禁复核（2026-09-29）

演示栈已按 owner 确认从当前代码直接重建，但扫描业务 canary 暂不执行：`/releasez` 没有绑定 `release_id`/完整 Git SHA 且 `ready=false`；scanner heartbeat 的 `callback.capable=false`、`scanner_callback_stale`；演示种子工作区没有独立专用 QA workspace 与 `asset.upload` 权益证明。worker 的 `recoveryCapable=true` 和容器健康不能替代这些证据。没有向业务工作区上传素材。详细验收及下一步见 [demo-deploy-acceptance.md](demo-deploy-acceptance.md)；执行条件见 `docs/runbooks/scanner-callback-canary.md`。

## merchant-demo 在线浏览器结果（只读）

- `merchant-demo` merchant UI 的 `127.0.0.1:28081` 实际加载登录页；匿名 `GET /api/v1/auth/session` 返回预期 401，但浏览器将其记为一条 console resource error。没有页面异常或其他失败请求；未填写或提交表单。
- Ops UI 的 `127.0.0.1:28082` 实际加载 `/ops/overview` 的运营账号登录页，无 API 请求、console error 或失败请求；未填写或提交表单。
- 截图和结构化记录见 `artifacts/demo-deploy/2026-09-29/live-browser-merchant/`、`live-browser-ops/`。没有既有授权登录态，因此登录后页面和商家/运营业务流程尚未在线验收。运行镜像 release 身份未绑定，详情见 demo 验收记录。
- 受保护路由矩阵记录在 `artifacts/demo-deploy/2026-09-29/live-browser-protected-routes/route-matrix.json`：14 路由均仅发 GET、无页面异常或网络失败；商家 6 个路由出现预期 session 401 和对应 console resource error，Ops 8 个路由无 API 请求。SHA-256 `940ee926509c5bf8bc7f483ae48ed2693740c04ef55b0878d220762e9386f56c`。
