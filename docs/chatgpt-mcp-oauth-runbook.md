# ChatGPT 插件接入与验收手册

本手册用于技术人员把 Store Nova MCP 接入 ChatGPT。用户不需要提供店铺密码；授权发生在平台 OAuth 页面，店铺账号与工作区身份由服务端绑定。

## 1. 上线前准备

确认以下地址已使用 HTTPS：

- MCP 资源：`https://yxsona.com/mcp`
- 授权端点：`https://yxsona.com/oauth/authorize`
- Token 端点：`https://yxsona.com/oauth/token`

在 ChatGPT 插件管理页创建/查看 MCP 客户端，复制页面显示的真实 `client_id` 和完整 `redirect_uri`。不要手写或猜测回调地址；回调必须逐字匹配。

## 2. 写入部署 Secret

将真实值写入部署平台的 Secret，不要提交到 Git：

```json
{"<真实client_id>":["<ChatGPT管理页显示的HTTPS回调地址>"]}
```

Kubernetes：更新 `merchant-runtime-secrets` 的 `MCP_OAUTH_CLIENTS`；ECS：更新任务定义的同名 Secret 环境变量。保持：

```text
MCP_OAUTH_REQUIRED=true
MCP_OAUTH_ISSUER=https://yxsona.com
MCP_OAUTH_AUTHORIZATION_ENDPOINT=https://yxsona.com/oauth/authorize
MCP_OAUTH_TOKEN_ENDPOINT=https://yxsona.com/oauth/token
```

## 3. 发布前检查

```bash
curl -fsS https://yxsona.com/.well-known/oauth-protected-resource
curl -fsS https://yxsona.com/.well-known/oauth-authorization-server
```

响应中的 `resource` 必须是 `https://yxsona.com/mcp`，端点必须与上面一致。未配置真实客户端时，生产 readiness 必须失败，不能用测试 client 绕过。

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

