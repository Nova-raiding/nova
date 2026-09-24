# ADR：桌面端本地插件身份架构

日期：2026-09-25

状态：已采用
范围：Store Nova 桌面 ChatGPT 插件与运营后台

## 决策

ChatGPT 侧只支持本地直装 stdio 插件。插件通过 Store Nova 本地登录流程使用商家账号密码登录、确认管理员分配的工作区，并取得短期本机插件凭据；bridge 通过 HTTPS 调用 `/mcp`。ChatGPT 云端远程 MCP OAuth、公开或团队插件市场不是本项目的登录或发布链路。

Ops Console 只支持 Store Nova 平台账号密码登录。API 生产 readiness、生产配置校验和发布脚本均拒绝 OIDC 网关登录模式及已退役的远程 ChatGPT OAuth 环境配置。

## 已移除的入口

- ChatGPT 远程授权、token、revoke 与 `.well-known` discovery HTTP 路由。
- Ops API 的 OIDC 身份断言登录分支及其签名 nonce 处理。
- `remote_oauth` 集成模式、OAuth client registry 和 OpenAI Apps challenge 上线配置。

本地插件的 Store Nova 授权码、PKCE、本地回调和短期 token 仍然保留。这里的授权码用于本地安装绑定，不是 ChatGPT 云端 OAuth 登录。

## 必须保留的身份边界

服务端验证本地插件凭据的客户端、工作区、有效期和撤销状态；商家会话与平台会话分离；插件不得切换工作区、进入平台工作台或调用 `ops.*` 方法。生产操作后台只接受通过账号密码登录得到的 HttpOnly Store Nova 会话。

## 发布门禁

桌面端生产配置必须使用 `MCP_INTEGRATION_MODE=local_stdio`。不得设置 `MCP_OAUTH_REQUIRED`、`MCP_OAUTH_CLIENTS`、`MCP_OAUTH_ISSUER`、`MCP_OAUTH_AUTHORIZATION_ENDPOINT`、`MCP_OAUTH_TOKEN_ENDPOINT`、`OPENAI_APPS_CHALLENGE_TOKEN` 或 `OIDC_PROXY_SIGNING_SECRET`。生产 API 仍需验证账号密码身份库、商家登录、短期凭据签发/刷新/撤销、workspace/RLS 范围和真实桌面会话证据。
