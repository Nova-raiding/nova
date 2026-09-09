# 商家与平台后台用户系统落地说明

## 目标

商家运营后台、平台运营后台和 ChatGPT MCP 使用同一套服务端身份模型。浏览器只持有 HttpOnly 会话 Cookie，API/MCP 依据服务端投影的 identity、membership、workspace、role、capability 和 commercial entitlement 决策；前端不再把 Bearer token、workspace ID 或 actor ID 当作用户凭据。

商家账号采用邀请制。平台运营账号由平台预配并分配角色。当前阶段不开放未经审批的公共密码注册，避免创建没有工作区、没有账务归属和没有权限来源的孤立账号；“注册”入口统一表现为“登录 / 接受邀请”。

## 已有真实数据关系

| 用户看到的对象 | 服务端真实来源 | 归属边界 |
|---|---|---|
| 登录主体、会话、MFA、风险状态 | OIDC 网关、`platform_identities`、identity lifecycle | identity；停用会撤销活动会话 |
| 商家成员、角色、工作区 | `workspace_members`、workspace status、authorization projection | workspace；每次请求由 API/RLS 再校验 |
| 平台运营角色 | durable platform role assignments | platform scope；不等于商家成员 |
| 钱包余额、扣款、创意点 | billing/wallet ledger、verified payment、entitlement、access revision | workspace；余额未知或账本未对账时 fail-closed |
| 任务与模型用量 | task、execution、provider usage/cost evidence | workspace + task；无真实用量/成本证据不结算 |
| 订单、账单、支付回调 | commercial order、payment fact、grant、billing search | workspace；平台运营跨租户读取仍受 capability 和审计约束 |
| 店铺授权与商品 | platform account、catalog facts、store identity | workspace + platform account；相同名称不代表同一店铺 |
| 审计与客服关联 | operation audit、identity events、support ticket relation | actor + workspace + resource |

## 当前实现

- 平台后台“连接诊断 / 登录配置”中展示当前主体、工作台、授权范围、角色、会话有效期，并提供登录、切换账号和退出登录入口。
- 商家后台“工作区信息”中展示登录主体、工作区、会话有效期和认证方式；同时明确钱包、扣款、任务、账单、订单、店铺授权和审计均从当前工作区读取。
- 未登录的本地 OIDC `/auth/session` 返回结构化 `401 UNAUTHENTICATED`，账号面板不会把 HTML 登录页误认为用户信息。
- 既有 `ops.session` 返回服务端计算的 workspace、workbench、roles、capabilities、effective permissions、temporary grants、identity status、risk decision、MFA 和 session expiry；前端只展示投影，不根据角色名称自行授权。
- 既有权限与业务门禁继续生效：邀请未接受、成员停用、身份 suspended、余额不足、支付/权益未对账、模型中转未配置、真实渲染/OCR/人审/哈希证据缺失时，相关任务、扣款和发布不会显示为成功。

## 用户流程

1. 用户从 `ops` 或 `admin` 入口进入 OIDC 登录。
2. 服务端按 issuer + subject 建立或读取 identity，查找 membership 和平台角色。
3. 单一工作区直接进入；多个工作区进入服务端授权的工作区选择；没有有效成员关系则显示“等待邀请”。
4. 会话过期、身份停用、风险阻断或工作区停用时，页面只显示恢复动作：重新登录、接受邀请、联系管理员或等待对账。
5. 商家业务页把当前工作区作为钱包、扣款、任务、账单、店铺和审计的唯一数据范围。
6. ChatGPT 通过独立 MCP OAuth client 绑定同一 identity；不能从对话中提交他人的 workspace ID 或运营 token。

## 注册、邀请和权限规则

- 商家注册：平台管理员创建邀请，邀请包含目标 workspace、预期角色、过期时间和审计原因；用户登录后接受邀请，服务端才创建/激活 membership。
- 平台注册：不提供公共注册；由平台 owner/security admin 预配 identity 并授予 platform role。
- 邀请过期、撤销、身份 suspended、成员 suspended、workspace disabled 均 fail-closed。
- `workspace_owner`、`merchant_admin`、`operator`、`support`、`finance` 和 `platform_ops` 由服务端 capability projection 映射；前端隐藏入口不能代替 API/RLS 鉴权。
- 钱包充值不是开通权限的替代品；正式开通必须经过批准 SKU、verified payment、entitlement、grant、ledger 和 access revision 的事务闭环。

## 外部调研结论

采用 OIDC Authorization Code + PKCE、短时服务端会话和刷新能力。OAuth 安全最佳实践要求公共客户端使用 PKCE、使用 S256、绑定一次性交易，并禁止隐式授权；OIDC 的 `state`/`nonce` 用于绑定浏览器会话和防止重放。[RFC 9700](https://datatracker.ietf.org/doc/rfc9700/)、[OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html)

ChatGPT 自定义 MCP 应用是远程服务；配置 OAuth 时必须确认 provider 能签发 refresh token，并在 discovery metadata 中声明 `offline_access`，否则原始授权过期后可能失联。[OpenAI：Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)、[OpenAI：Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in)

因此本项目不在业务 API 内自建密码、短信或社交登录聚合器。外部 IdP 负责认证，项目负责身份映射、成员/工作区授权、账务准入、RLS 和审计。

## 上线门禁

当前本地 OIDC Gateway、Postgres 隔离测试和桌面浏览器链路已验证。正式上线前仍必须由部署环境提供并验收：

- 真实 HTTPS IdP、独立 `ops` / `admin` / `mcp` client 和精确 callback allowlist；
- discovery metadata、PKCE S256、`state`/`nonce`、`offline_access` 和 refresh token；
- Redis 等生产 OAuth state/nonce 存储，签名密钥轮换和会话撤销；
- `OPS_AUTH_MODE=oidc`、`OIDC_PROXY_SIGNING_SECRET`、`SESSION_ID_HASH_SECRET` 及数据库/RLS/worker 健康证据；
- ChatGPT 中实际创建 draft MCP app，完成 OAuth、工具扫描、只读调用和写操作确认；
- 真实支付回调、钱包/创意点账本、扣款成本证据、任务执行、客服关联和审计导出验收。

没有这些外部证据时，系统必须继续显示“未验证/待配置”，不能把本地 fixture 或脚本测试升级为生产登录、真实扣款或真实 ChatGPT 连接成功。
