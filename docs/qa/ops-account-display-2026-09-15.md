# 当前账号展示复核 · 2026-09-15

## 最新：OIDC 登录名链路已实现并通过隔离运行验收

2026-09-15 09:32：网关证明 v2、API 展示字段与真实桌面登录链路通过；本节更新下方第一轮“OIDC 登录名尚未实现”的历史结论。尚未部署本轮 API 修改，也未宣称外部生产 SSO 已上线。

- 实现：新增 `packages/security/src/oidc-login-proof.ts`，通过 `X-OIDC-Proof-Version: 2` 与 `X-OIDC-Display-Login` 把登录名绑定到完整 HMAC 证明。旧证明只在两个新头都不存在时兼容；篡改、移除、空值、非法版本或非规范编码均拒绝，不降级尝试。
- 编码：原始 UTF-8 → 无 padding base64url，严格往返校验；上限 256 Unicode 码点／512 字节，拒绝控制、格式、换行、孤立代理项及前后空白；不强制 NFC，不改变身份提供方已验证的原文。
- 权限：新的 `displayAccountLogin` 只有三处使用——类型、验签成功的 OIDC principal、`ops.session.account_login` 投影。原 `accountLogin` 的密码账号成员别名匹配保持不变；OIDC 显示名不会参与主体、成员、角色、临时授权或租户查询。
- 多 agent：一个 agent 修改本地网关与独立签名断言；另一个 agent 新增真实 HTTP 反例并独立复核权限边界；owner 实现协议解析、API 接线、桌面验收与整合测试。CodeGraph 检查了主入口影响面，未以索引结果代替实际验证。
- owner 重跑：4 文件共 132 项通过（协议 46、网关 19、隔离 runner 41、HTTP 安全 26）；全项目类型检查通过。HTTP 反例覆盖同名管理员不提权、停用／非成员拒绝、改名不换身份、不同主体同名仍隔离、legacy 不残留前次显示名、签名／编码篡改及重放。
- 旧安全套件中按 OIDC 筛选的 4 项另行通过；其他 64 项为筛选未执行，不能据此覆盖下文支付失败。完整 owner 汇总和五文件 SHA256 见本轮证据目录的 `owner-account-verification.json`。
- 真实链路：Chrome 1440×900、Asia/Shanghai，认证表单 → 本地签名网关 → 真实 API/MCP enforce → 隔离 PostgreSQL 17／Redis → 生产前端构建。3 项通过（21.4 秒），无跳过／重试：平台 ASCII 账号与商家中文＋非 NFC 账号均与实际登录输入完全一致；刷新保持、账号弹层与成员页一致；浏览器伪造展示头被覆盖；工作区跨平台交付门禁仍严格 403。
- 证据目录：`artifacts/ops-jit-isolation/2026-09-15T01-30-13.358Z-76f84fae-63db-40b2-b4db-3ac3589b3f92/`，fixture run ID `eb71f0fd-7c0d-4c17-bba4-5a59b063c781`。owner 已查看两个 `account-label-{platform,workspace}/account-panel-shot-scraper.png`；对应 WebM 实际打开账号弹层，画面非加载／动画中间帧。
- 稳定与清理：API、协议 helper、网关、runner、桌面 spec 五文件 SHA256 前后完全一致；两个自有 PG/Redis 容器 disposal `leftRunning=[]`，owner 精确 inspect 再查均不存在。未启动扫描器、调用模型／支付或写共享业务数据；StoryForge 保持停止。
- 发布边界：生产 SSO 网关实现不在本仓库。本地验收网关已发 v2，外部网关需按运行手册升级；应先部署兼容 API，再升级网关，不能把 fixture 通过当作生产 SSO 上线。

### 本轮另发现的非 OIDC 回归：支付对账 worker 路由缺失

旧 `security.e2e.test.ts` 全量 68 项中 1 项失败；连同协议／网关／runner 的首批结果为 173 passed、1 failed，不是全绿。独立 agent 定向复验仍失败：支付对账 worker 用例期待 `TENANT_SCOPE_DENIED`，实际为 `FORBIDDEN`。

当前共享 `server.ts` 的其他并发修改已删除 `/v1/internal/billing/reconciliation` 的 worker 路由识别、角色映射、HTTP handler 与业务函数。请求因此落入普通 Bearer 授权，尚未解析 body 的租户范围就被拒绝；该用例未开启 OIDC，未经过本轮新增的验签解析。前三个 403 断言只是碰巧通过，不证明 worker 保护仍存在。

未改弱断言或替换错误码，也未擅自恢复其他流程删除的支付能力。该功能应保留还是明确下线需要与删除方确认；因此本轮不更新共享 API，只保留上一轮已部署的本地前端。交付自动生效的工作区／指定账号范围也仍未确认。

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
