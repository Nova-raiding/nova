# 当前账号展示复核 · 2026-09-15

## 本轮修复范围

页头、账号弹层及“成员与权限”的当前账号统一读取服务端 `ops.session.account_login`。缺失、null、空白时显示“账号名称未提供”；无会话显示“未登录”。不回退显示 UUID/OIDC sub，也不使用未验证的登录框输入。`actor_id` 仍参与身份、权限、自操作保护和审计，未改安全语义。

独立 agent 已只读复核：展示函数无缓存，登录／退出清除旧 session，权限投影仍取原 session，未发现本轮引入的授权问题。CodeGraph 用于定位受影响测试，新增文件另行直接核对。UI/UX 技能仅用于统一账号标识和缺失状态；未重设计桌面布局或引入移动端验收。

## 运行证据

- 定向前端：3 文件、19 项通过，覆盖登录名优先、UUID 不展示、缺失／空白、Unicode、两个页面共用展示逻辑。
- 全量运营前端：97 文件、612 项通过（42.98 秒）。
- 密码登录 HTTP：`server.e2e.test.ts` 的 `hydrates durable authorization context for password-authenticated merchant sessions` 通过；新增断言 `actor_id=identityId` 与 `account_login=login` 同时成立。仅运行此项，其余 67 项是命令筛选未执行，不算全 API 验收。
- 全项目 `npm run typecheck` 退出 0。
- 真实浏览器：签名 OIDC → API/MCP enforce → 隔离 PG17/Redis → 生产构建桌面 Chrome，3 项通过（20.8 秒），无重试。覆盖两个工作台当前账号缺失的真实响应、弹层打开、刷新不回退内部 ID；商家工作台仍被客户交付平台权限边界以 403 拒绝。
- 最新目录：`artifacts/ops-jit-isolation/2026-09-15T01-10-46.311Z-26c2e197-14c3-4550-a24b-a2d929e6329c/`，fixture run ID `3f8b7745-1113-471f-88e6-e6f509aa147d`。
- owner 已查看两个 `account-label-{platform,workspace}/account-panel-shot-scraper.png`；稳定画面可见“已登录”和正确占位，“成员与权限”页面也已加载。对应 `account-panel.webm` 实际点击账号按钮并展示弹层。浏览器 cookies 通过 stdin 传入截图进程，没有保存凭据。
- 首轮 `2026-09-15T01-08-47.743Z-ca3572d4-9299-407f-94be-57f1d51d4706` 的断言虽通过，但截图停在加载／动画中间帧；保留原记录，补等待真实已登录和页面内容后重跑，不使用首轮截图宣称视觉完成。
- 本轮两个隔离 PG/Redis 容器已按完整 ID 清理，`leftRunning=[]`；owner 精确 inspect 复查均不存在。未进行业务数据修改、模型调用、支付、扫描或开通。

## 尚未完成的边界

1. 正式 OIDC 协议仍没有受签名保护的登录名传递，`account_login` 为 null；本轮只修复“不显示内部 ID”，不声称 OIDC 已能显示输入账号。后续须完整设计、验证签名字段，且显示名不可进入成员匹配或权限提升路径。
2. 18082 初检返回旧 `index-CQFNxopu.js`，可见 `account_login ?? actor_id`；本轮已单独更新该前端，详见下节。共享真实业务账号的登录后展示没有使用凭据再次验证；已登录界面验证来自隔离 OIDC、密码 HTTP 回归与前端测试，不把未登录截图当成真实账号登录成功。
3. 交付档案已显式绑定目标工作区，但同工作区可有多份档案，不能唯一确定客户账号。`createdByActorId` 是运营操作者，不能作为被开通账号。“所有内容完成后用户生效”的正式业务范围已再次询问用户，尚未得到选择；不得自动恢复管理员停用，接入／上传／验收也不能被正式业务门禁反向阻断。
4. 已通过的七附件、18 项清单、培训／视频／撤销工作流见 `customer-delivery-acceptance-2026-09-14.md`，不等于账号自动开通、OCR 或全插件上线通过。

## 本地 18082 更新与回退

- 固定源码：`ad2c2d3bc3935583964824cb8e90c25fbe97d059`，构建所需文件与通过测试的当前工作区无 diff。`git archive` 仅导出 Dockerfile COPY 的白名单文件到 `/tmp/ops-ui-ad2c2d3b-OrciLA`；构建上下文 2.37 MB，没有发送 `.env`、业务文件或整个动态工作区。
- 按原 Compose 参数构建：local auth、`/api`、base `/`、`VITE_OPS_LOCAL_SESSION=false`。镜像内 `tsc` 与 Vite 生产构建成功。
- 保留真实原镜像 `sha256:1af6a29cc2e3f047350659555b5d55a9454c5d95f4d6a1d55e537316e6ead670`，回退标签 `local-ops-ui:rollback-20260915-0115`。没有清理或覆盖原镜像内容。
- 新镜像 `sha256:42d6105f7c531da32fc00940a25e97552fae51bf97d54f39b86d005685a0e770`，新容器 `4ed5e62df7228e8a5042b4d2c3a422d27e4ca1444ca804b5fabf001fe73c3cad`。仅执行 Compose `up --no-deps --no-build --pull never --force-recreate --wait ... ops-ui`，未部署 API、迁移或 worker。
- 18082 实际返回 `index-CdXKMk3V.js`，新 helper 仅读 `account_login`、缺失用“账号名称未提供”，不含原来的账号名回退表达式。`/api/readyz` 返回 200，无凭据的 `ops.session` 返回 401 / `UNAUTHENTICATED`。
- 独立 agent 再次直接读取 18082 的实际 JS：`MembersPage-Cd_keOXB.js` 导入并调用 index 中同一 helper，资源、HTTP 门禁、准确容器／镜像／回退标签均匹配。该复核没有登录或写入业务。
- owner 查看真实 `artifacts/ops-account-display/2026-09-15-local/login-gate.png`，确认未登录时呈现平台账号登录门禁；未用前端假会话跳过登录。
- ops-ui 为 healthy；替换前后的其他 12 个运行容器完整 ID 均未变化。旧 ops-ui 是无数据卷的静态前端容器，已被替换；其镜像保留，可回退，没有删除业务数据。
- 如需回退：先将上述 rollback 标签重新标记为 `local-ops-ui:latest`，再用原 `.env`、`infra/local/docker-compose.yml`、`-p local` 及上述单服务参数仅更新 `ops-ui`，不得执行 `down` 或全服务重建。

StoryForge 的 11 个原容器完整 ID 再次复查均 exited，按用户要求保持停止，不自动恢复；本项目 13 个运行服务均 healthy。owner 未执行提交或推送，仅更新了上述本地前端。工作期间外部流程产生了 4 个提交，HEAD 从 `dc72e177` 经 `ad2c2d3b` 变为 `b9696324`，包含本轮显示修改；后者与固定构建版本的全部 COPY 文件再次 diff 无变化。未撤销外部提交，也不将其归为 owner 的推送成果。
