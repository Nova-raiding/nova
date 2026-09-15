# 当前账号展示复核 · 2026-09-15

## 本轮修复范围

页头、账号弹层及“成员与权限”的当前账号统一读取服务端 `ops.session.account_login`。缺失、null、空白时显示“账号名称未提供”；无会话显示“未登录”。不回退显示 UUID/OIDC sub，也不使用未验证的登录框输入。`actor_id` 仍参与身份、权限、自操作保护和审计，未改安全语义。

独立 agent 已只读复核：展示函数无缓存，登录／退出清除旧 session，权限投影仍取原 session，未发现本轮引入的授权问题。CodeGraph 用于定位受影响测试，新增文件另行直接核对。UI/UX 技能仅用于统一账号标识和缺失状态；未重设计桌面布局或引入移动端验收。

## 运行证据

- 定向前端：3 文件、19 项通过，覆盖登录名优先、UUID 不展示、缺失／空白、Unicode、两个页面共用展示逻辑。
- 密码登录 HTTP：`server.e2e.test.ts` 的 `hydrates durable authorization context for password-authenticated merchant sessions` 通过；新增断言 `actor_id=identityId` 与 `account_login=login` 同时成立。仅运行此项，其余 67 项是命令筛选未执行，不算全 API 验收。
- 全项目 `npm run typecheck` 退出 0。
- 真实浏览器：签名 OIDC → API/MCP enforce → 隔离 PG17/Redis → 生产构建桌面 Chrome，3 项通过（20.8 秒），无重试。覆盖两个工作台当前账号缺失的真实响应、弹层打开、刷新不回退内部 ID；商家工作台仍被客户交付平台权限边界以 403 拒绝。
- 最新目录：`artifacts/ops-jit-isolation/2026-09-15T01-10-46.311Z-26c2e197-14c3-4550-a24b-a2d929e6329c/`，fixture run ID `3f8b7745-1113-471f-88e6-e6f509aa147d`。
- owner 已查看两个 `account-label-{platform,workspace}/account-panel-shot-scraper.png`；稳定画面可见“已登录”和正确占位，“成员与权限”页面也已加载。对应 `account-panel.webm` 实际点击账号按钮并展示弹层。浏览器 cookies 通过 stdin 传入截图进程，没有保存凭据。
- 首轮 `2026-09-15T01-08-47.743Z-ca3572d4-9299-407f-94be-57f1d51d4706` 的断言虽通过，但截图停在加载／动画中间帧；保留原记录，补等待真实已登录和页面内容后重跑，不使用首轮截图宣称视觉完成。
- 本轮两个隔离 PG/Redis 容器已按完整 ID 清理，`leftRunning=[]`；owner 精确 inspect 复查均不存在。未进行业务数据修改、模型调用、支付、扫描或开通。

## 尚未完成的边界

1. 正式 OIDC 协议仍没有受签名保护的登录名传递，`account_login` 为 null；本轮只修复“不显示内部 ID”，不声称 OIDC 已能显示输入账号。后续须完整设计、验证签名字段，且显示名不可进入成员匹配或权限提升路径。
2. 18082 只读检查仍返回旧 `index-CQFNxopu.js`，可见 `account_login ?? actor_id`。本轮浏览器验收针对新构建的隔离服务，尚未更新共享运行页面。
3. 交付档案已显式绑定目标工作区，但同工作区可有多份档案，不能唯一确定客户账号。`createdByActorId` 是运营操作者，不能作为被开通账号。“所有内容完成后用户生效”的正式业务范围已再次询问用户，尚未得到选择；不得自动恢复管理员停用，接入／上传／验收也不能被正式业务门禁反向阻断。
4. 已通过的七附件、18 项清单、培训／视频／撤销工作流见 `customer-delivery-acceptance-2026-09-14.md`，不等于账号自动开通、OCR 或全插件上线通过。

StoryForge 的 11 个容器按用户要求保持停止，不自动恢复；共享本项目 13 个运行服务最近只读健康检查均 healthy。owner 未执行提交、推送或共享容器部署。工作期间外部流程产生了 3 个提交，HEAD 从 `dc72e177` 变为 `ad2c2d3b`，包含本轮显示修改；未撤销外部提交，也不将其归为 owner 的推送成果。
