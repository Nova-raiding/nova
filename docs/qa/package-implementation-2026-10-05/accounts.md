# 安全邀请开户与首单前支持交接

Owner: application_backend；2026-10-05；主工作目录 main，无提交/分支。

## 账号邀请边界

运营用户管理已移除运营自填密码、固定开通金额和付款状态直授全量权限的表单。POST `/v1/ops/merchant-accounts` 由 root 接线到安全邀请处理器，运营真实权限验证后创建待激活账号及明确单一 Workspace 成员。客户通过一次交付的 fragment 激活链接自行设置密码并确认条款；激活仅开放登录，不建立商业订单、到账事实或权益。未配置实际邮件投递，因此明确返回 `delivery_status:not_sent`，不能声称邮件已发送。

邀请 token 仅存 SHA-256 hash，15 分钟有效，一次消费；重签同账号会作废旧链接。运营重试原幂等请求只能取得原账号及邀请状态，不再次回传 bearer token；不确定结果保留原请求，界面提供原结果查询和明确重签。激活 HTML 删除地址栏 fragment、禁缓存、禁 referrer、严格 nonce CSP，无外部资源；激活与普通密码重置互不串用。新普通旧 authorize 请求返回 410，只有精确旧审计幂等记录可只读重放，历史合法订单仍走原商业查询履约路径。

263 迁移使用 merchant_ops + platform scope、显式 Workspace scope 和不可修改邀请事实。真实 PostgreSQL 测试覆盖全部迁移后再次执行角色 bootstrap，禁止 merchant_app 读取邀请控制表。QA 真实角色验证发现创建 Workspace 早于设置 workspace scope，已修正为 INSERT/关联企业查询前设置唯一目标 scope；第三轮已走过该 RLS 边界，激活末尾审计同一参数同时用作 UUID/TEXT 推断冲突，已分别显式 cast 保持相同身份审计语义。等待 QA 第四轮完整复验，不能以静态代码替代真实通过证据。

验证：账号相关 4 文件 40 测试通过，无跳过；后续新增支持与账号回归合计 4 文件 25 测试通过，无跳过；Ops console 和 persistence `tsc --noEmit` 均 exit 0；owner scoped `git diff --check` 通过。真实 PG/完整类型检查及真实桌面验收由 root/qa_release 收敛，未在此宣称完成。

## 首单前人工支持

新增 `merchant-support-request.ts`，复用真实 SupportRepository 持久化工单。专属商家 POST `/v1/support/requests` 不要求订单、任务或旧工单；仅允许问题、原幂等标识及脱敏 request_id/trace_id/version/step，服务器绑定当前账号与 Workspace，普通优先级及固定 intake 标签。返回真实 ticket_id/ticket_number 和客户回复查询入口。GET 同路径加 ticket_id 必须当前企业且同 customerId，仅返回 customer visibility 回复，不泄露内部调查内容。request_id 仅排障信息，不能用来获取其他客户工单。请求中的身份、优先级、付费和授权字段拒绝，常见 password/API token/Bearer/query 凭证在持久化前脱敏。

HTTP exact registry 由 contracts_bridge 增加为免费恢复路径；会话和 active membership 由 root 接线验证后提供可信 context，不能从请求正文构造。handler 单元测试涵盖无业务标识真实回执、幂等重放及冲突、客服真实回复过滤、跨企业/跨账号拒绝、凭证脱敏及伪造字段拒绝。排障标识若脱敏函数检测到凭证，直接拒绝，阻止 Bearer 通过看似合法字母空格字段存入工单。响应使用共享 contracts receipt/view 类型防止漂移。root 负责 server 实际路由，merchant_frontend 已收到冻结 DTO 负责真实入口界面，后续真实运行证据须追加。

## gstack 代码复核

按已读取 review 技能及完整检查表复核：锁顺序统一 account 后 token，邀请账户/成员/审计在同一事务；权限不得来自 paid 状态/body；scope 必须早于 RLS 操作；一次 bearer 交付与 unknown-result 重放分离；原 idempotency 意图冲突拒绝；支持回执不能冒充已发送邮件或已获付款资格。已按证据修正生产 `/api` Nginx 激活路径、merchant_app 最终 bootstrap ACL 边界（root）、Workspace 创建 scope（本 owner）。剩余真实 PG/浏览器/部署验收不以此复核代替。

## 首单求助的真实平台客服回复路径

QA 真实桌面验证商家首次求助已返回201及真实回执，但平台工作台使用旧 Workspace support 方法被正确拒绝，聚合队列不能逐工单回复。新增独立 `mcp-platform-support-handler.ts` 的三个精确 platform methods：tickets.list / ticket.get / ticket.comment。请求必须 target_workspace_id；实际平台工作台及运营身份、中央独立 support.ticket.read 或 support.ticket.update 授权、目标企业存在和可信服务端 actor 四项验证后，复用原 SupportRepository/SupportService。不能修改工作区 header 假装 Workspace 会话；不向商家暴露 Ops 创建权限，也不因平台角色暗授客服能力。

平台可读取明确企业真实工单、内部事件，并以 customer/internal visibility 写入真实带 actor/idempotencyKey/revision 的回复事件。商家原专属查询只返回本人企业的 customer 可见回复。未知回复结果可 get 原事件核对原幂等标识、真实 actor、body 和 visibility，不自动重复回复。正文常见凭证再次脱敏。

2文件7测试通过、owner diffcheck0。覆盖无订单首次登记→平台列出/读取→真实幂等回复→客户可见查询，全程 platform header 保持原值；缺平台身份或独立客服授权时未读写仓储、显式目标和禁止身份伪造、跨企业工单读取/回复拒绝。root 负责三方法中央授权与 server 实际接线，DX 负责可选企业逐工单 UI，QA 必须重新跑真实桌面交接完整链路后才能宣布闭环完成。

本轮全局 `tsc -p tsconfig.json --noEmit --incremental false` 发现 server3443 SqlPool.query/3444-3445 row隐式any及 contracts platform-support-contract.test15 的 Record<string,string> 联合对象类型错误，已通知对应 root/contracts owner；本新增handler/tests无类型报错，但全局检查未通过，不记为完成。

## 同企业第二账号邀请的最小权限修复

QA 支持第四轮已通过真实商家提交、平台读取/回复、客户可见回复，但同企业第二用户 HTTP 邀请得到503/42501（req_1db32778-8488-4861-99d8-aa02183a4eeb）。现有企业邀请路径使用 SELECT workspaces FOR SHARE；263/最终角色 bootstrap 只授 merchant_ops SELECT/INSERT，行锁读取需要额外 UPDATE 权限，而原真实 PG 测试只覆盖新企业创建路径。已去掉现有企业只读验证的 FOR SHARE，不扩大任何表权限/RLS；仍在明确 app.workspace_id 范围查询 active 企业，只建立 pending 账号及 invited 会员。客户激活事务再次要求实际 Workspace active 并精确激活会员，企业已 disabled 会全部回滚，不能变成 active 登录。

新增严格模拟 SELECT/INSERT-only Ops 权限、FOR SHARE 即42501 的回归及 HTTP 邀请测试合计2文件10项通过，diffcheck0。真实 PG 已补同企业第二账号邀请/激活、确认无 workspaces UPDATE 权限、邀请后企业 disabled 拒激活并保留 pending 的断言，交 QA 下一串行环境复验。当前推断与最小补丁尚不能代替真实 HTTP/PG 复验通过证据，未另起PG、浏览器或全局检查。
