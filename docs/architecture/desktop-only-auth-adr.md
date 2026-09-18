# ADR：桌面端本地插件身份架构

日期：2026-09-18  
状态：已采用  
范围：Store Nova 桌面 ChatGPT/Codex 插件

## 决策

当前产品只支持桌面端本地插件，不接入 ChatGPT 云端远程 MCP：桌面宿主通过本地 stdio bridge 启动插件；商家在 Store Nova 商家后台登录；服务端签发绑定工作区的短期 access/refresh 凭据；可信安装器将凭据写入系统凭据存储；bridge 通过 HTTPS 调用 `https://yxsona.com/mcp`。

商家密码、Cookie、支付密钥和平台授权 token 不进入插件参数、聊天或日志。

## 不属于当前上线门禁的能力

ChatGPT 远程 MCP OAuth、ChatGPT Business/Enterprise/Edu 工作区应用发布、OAuth client_id、ChatGPT callback 和 challenge token 均属于未来可选远程接入方案，不是桌面端上线条件。

相关代码可以保留用于未来能力和安全负面测试，但不得让 `MCP_OAUTH_CLIENTS`、`MCP_OAUTH_REQUIRED` 或 ChatGPT OAuth metadata 阻断 `local_stdio` 桌面发布。

## 必须保留的身份边界

取消 ChatGPT 远程 OAuth 不等于取消 Store Nova 鉴权。服务端仍必须验证 access token 的签名、过期和撤销状态、workspace 成员与角色、workspace/RLS 范围、refresh/revoke 轮换，以及操作审计和支付/模型用量归属。

## 发布门禁变化

桌面端 `local_stdio` 发布必须检查 `MCP_INTEGRATION_MODE=local_stdio`、`MCP_OAUTH_REQUIRED=false`、商家登录、短期凭据签发和 refresh/revoke，以及真实桌面商家会话验收。

远程 MCP OAuth 只在未来启用 `remote_mcp` 发布配置时检查；两种模式不能混用。
