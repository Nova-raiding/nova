# ChatGPT 插件接入与验收手册

本手册用于技术人员把 Store Nova MCP 接入 ChatGPT。用户不需要提供店铺密码；授权发生在平台 OAuth 页面，店铺账号与工作区身份由服务端绑定。

## 1. 上线前准备

确认以下地址已使用 HTTPS：

- MCP 资源：`https://yxsona.com/mcp`
- 授权端点：`https://yxsona.com/oauth/authorize`
- Token 端点：`https://yxsona.com/oauth/token`

当前 Store Nova 授权服务器只支持预定义 OAuth 客户端，不发布 CIMD 或动态注册端点。在 ChatGPT 插件管理页选择预定义客户端模式，复制页面显示的真实 `client_id` 和完整 `redirect_uri`。当前服务器未声明 OAuth 响应中的 issuer identification，ChatGPT 新连接通常使用含 callback ID 的回调；管理页显示的值才是准确信息，不要手写或猜测。

回调模式和 OAuth metadata 要求以 [OpenAI 插件认证文档](https://developers.openai.com/plugins/build/auth) 为准。

## 2. 写入部署 Secret

将真实值写入部署平台的 Secret，不要提交到 Git：

```json
{"<真实client_id>":["<ChatGPT管理页显示的HTTPS回调地址>"]}
```

ECS：把该 JSON 写入服务器持有的 `MCP_OAUTH_CLIENTS` Secret 环境变量，不提交到 Git。保持：

```text
MCP_OAUTH_REQUIRED=true
MCP_OAUTH_ISSUER=https://yxsona.com
MCP_OAUTH_AUTHORIZATION_ENDPOINT=https://yxsona.com/oauth/authorize
MCP_OAUTH_TOKEN_ENDPOINT=https://yxsona.com/oauth/token
```

## 3. 发布前检查

```bash
node infra/scripts/check-mcp-oauth-production.mjs --config
node infra/scripts/check-mcp-oauth-production.mjs --smoke
node infra/scripts/probe-chatgpt-oauth-boundary.mjs
curl -fsS https://yxsona.com/.well-known/oauth-protected-resource
curl -fsS https://yxsona.com/.well-known/oauth-authorization-server
```

响应中的 `resource` 必须是 `https://yxsona.com/mcp`，端点必须与上面一致；授权服务器 metadata 必须发布 `token_endpoint_auth_methods_supported: ["none"]` 和 `code_challenge_methods_supported: ["S256"]`。未配置真实客户端时，生产 readiness 必须失败，不能用测试 client 绕过。

`--config` 只读取当前环境变量并输出错误代码，不回显客户端 ID 或回调地址；`--smoke` 只读取公网 discovery，检查当前线上配置。两项通过仅说明配置形状与公开 metadata 正确，不证明 ChatGPT 管理页的真实客户端、回调和商家授权码闭环。真实值须从 ChatGPT 管理页取得，不能通过脚本生成。

`probe-chatgpt-oauth-boundary.mjs` 对未注册客户端、无效 token grant 和未授权 MCP 工具列表发起无凭据的负向请求；期望前两项返回 `400 invalid_request`，MCP 返回 401。它不提交商家密码、不跟随回调，也不打印响应正文。若生产返回 503，先在 ECS 宿主执行 `sh -s < infra/scripts/diagnose-ecs-mcp-oauth.sh`（通过 SSH 时用 `ssh 101 'sh -s' < infra/scripts/diagnose-ecs-mcp-oauth.sh`）。该只读脚本仅报告 API 容器是否启用生产模式、强制 OAuth 和客户端注册表是否存在，不输出注册表或 Secret 内容；存在不代表客户端配置有效，仍需执行配置检查和真实 ChatGPT 授权验收。

## 4. ChatGPT 侧验收

1. 在 ChatGPT 添加 MCP 连接，使用管理页的真实回调完成 OAuth。
2. 授权页只输入平台商家账号，不向技术人员或插件提供店铺密码。
3. 完成授权后调用一个只读商家工具，确认返回的工作区是授权账号对应工作区。
4. 创建 `points_500` 测试订单，完成一笔小额支付后确认创意点到账。
5. 重放同一支付回调，余额、流水和到账记录不得增加。
6. 使用另一成员读取该订单，必须返回 `COMMERCIAL_ORDER_NOT_FOUND`。

## 5. 故障处理与回滚

- OAuth discovery 503：检查 Secret 是否挂载、JSON 是否有效、回调是否为 HTTPS。
- `redirect_uri_mismatch`：从 ChatGPT 管理页重新复制完整回调，禁止自行改写。
- 授权后工作区错误：撤销该授权并检查账号的唯一工作区成员关系，不要通过请求头切换工作区。
- 支付成功但未到账：保留订单号、支付宝交易号和回调时间，检查签名/幂等证据；不要重复扣款。

回滚只回滚应用版本，不删除 OAuth 表、支付订单或流水。若必须暂停接入，将 `MCP_OAUTH_REQUIRED` 保持为 `true` 并移除客户端 Secret，使请求安全失败。
