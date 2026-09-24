# ChatGPT 远程 MCP OAuth 运行手册（已退役）

本项目只支持本地直装 stdio 插件链路。ChatGPT 远程 MCP OAuth 的授权、token、revoke 和 discovery API 已从服务端移除；不得按历史步骤设置 ChatGPT client、回调 URI、`MCP_OAUTH_*` 或 OpenAI Apps challenge 配置。

新安装和账号绑定请使用[本地插件安装与配置手册](store-nova-chatgpt-plugin-install-manual.md)。Ops Console 使用 Store Nova 平台账号密码登录，不使用 OIDC/SSO。

历史 runbook 与历史 QA 记录保留作审计证据，不能作为当前可用配置、发布门禁或上线成功证明。
