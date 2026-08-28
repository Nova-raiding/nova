# 六平台授权接入手册

兼容文件名：`four-platform-authorization-runbook.md`（历史路径）。

适用范围：京东、淘宝、天猫、拼多多、小红书、抖音的店铺授权、商品同步和撤权。

## 当前状态

本地 `CONNECTOR_FIXTURE_MODE=true` 时使用演示账号，不访问平台网络；Codex App 中必须标注“演示连接”。真实授权需要平台开发者应用、测试店铺、OAuth 凭证、HTTPS 回调和平台字段/签名适配，不能用 fixture 结果替代。

## 商家在 Codex App 中的操作

商家输入“配置店铺”或“连接平台”后，插件按平台显示六个入口：

- 连接京东
- 连接淘宝
- 连接天猫
- 连接拼多多
- 连接小红书
- 连接抖音

商家点击某个平台后，插件调用 `platform.connect`，把服务端生成的官方 OAuth URL 展示为授权按钮。商家在平台官方页面登录并授权，不能在 Codex 对话中输入平台密码或 Token。

授权回调成功后，插件重新读取 `workspace.health`，展示店铺、授权状态和读写能力，再调用 `catalog.sync.start` 同步商品。撤权后必须显示“需要重新授权”，并阻断同步和发布。

## 服务端回调

六个平台使用独立回调路径：

```text
https://<API_DOMAIN>/v1/oauth/callback/jd
https://<API_DOMAIN>/v1/oauth/callback/taobao
https://<API_DOMAIN>/v1/oauth/callback/tmall
https://<API_DOMAIN>/v1/oauth/callback/pinduoduo
https://<API_DOMAIN>/v1/oauth/callback/xiaohongshu
https://<API_DOMAIN>/v1/oauth/callback/douyin
```

生产环境必须使用 HTTPS、Redis OAuth state store 和服务端固定的 `PUBLIC_OAUTH_REDIRECT_URI`；state 必须一次性、同平台、同工作区消费。Token 只能保存在 Vault/KMS，不能返回给 Codex、写入日志或提交到仓库。

## 六个平台配置边界

| 平台 | 应用配置 | 主要能力证据 |
|---|---|---|
| 京东 | `JD_*` | OAuth、商品读取、SKU/库存/价格读取、创建/更新、状态查询、撤权 |
| 淘宝 | `TAOBAO_*` | OAuth、商品读取、SKU/库存/价格读取、创建/更新、状态查询、撤权 |
| 天猫 | `TMALL_*` | 独立 OAuth、天猫商品 schema/资质、读取、创建/更新、状态查询、撤权 |
| 拼多多 | `PDD_*` | OAuth、商品读取、SKU/库存/价格读取、创建/更新、状态查询、撤权 |
| 小红书 | `XHS_*` | OAuth、商品读取、SKU/库存/价格读取、创建/更新、状态查询、撤权；正式运行前必须有官方字段映射证据 |
| 抖音 | `DOUYIN_*` | OAuth、商品读取、SKU/库存/价格读取、创建/更新、状态查询、撤权；正式运行前必须有官方字段映射证据 |

每个平台都必须独立完成配置，不得把淘宝配置复用为天猫配置，也不得把一个平台的授权结果当成其他平台已授权。

最小环境变量只描述配置位置，真实值必须由 Secret Manager/Vault 注入：

```dotenv
CONNECTOR_FIXTURE_MODE=false
PLUGIN_WRITE_ENABLED=false
PUBLIC_OAUTH_REDIRECT_URI=https://<API_DOMAIN>/v1/oauth/callback/{platform}

JD_APP_KEY=
JD_APP_SECRET=
JD_OAUTH_AUTHORIZE_URL=
JD_OAUTH_TOKEN_URL=
JD_OAUTH_REDIRECT_URI=https://<API_DOMAIN>/v1/oauth/callback/jd
JD_API_BASE_URL=

TAOBAO_APP_KEY=
TAOBAO_APP_SECRET=
TAOBAO_OAUTH_AUTHORIZE_URL=
TAOBAO_OAUTH_TOKEN_URL=
TAOBAO_OAUTH_REDIRECT_URI=https://<API_DOMAIN>/v1/oauth/callback/taobao
TAOBAO_API_BASE_URL=

TMALL_CLIENT_ID=
TMALL_CLIENT_SECRET=
TMALL_OAUTH_AUTHORIZE_URL=
TMALL_OAUTH_TOKEN_URL=
TMALL_OAUTH_REDIRECT_URI=https://<API_DOMAIN>/v1/oauth/callback/tmall
TMALL_OAUTH_REFRESH_URL=
TMALL_OAUTH_REVOKE_URL=
TMALL_API_BASE_URL=

PDD_APP_KEY=
PDD_APP_SECRET=
PDD_OAUTH_AUTHORIZE_URL=
PDD_OAUTH_TOKEN_URL=
PDD_OAUTH_REDIRECT_URI=https://<API_DOMAIN>/v1/oauth/callback/pinduoduo
PDD_API_BASE_URL=

XHS_CLIENT_ID=
XHS_CLIENT_SECRET=
XHS_OAUTH_AUTHORIZE_URL=
XHS_OAUTH_TOKEN_URL=
XHS_OAUTH_REDIRECT_URI=https://<API_DOMAIN>/v1/oauth/callback/xiaohongshu
XHS_API_BASE_URL=

DOUYIN_CLIENT_ID=
DOUYIN_CLIENT_SECRET=
DOUYIN_OAUTH_AUTHORIZE_URL=
DOUYIN_OAUTH_TOKEN_URL=
DOUYIN_OAUTH_REDIRECT_URI=https://<API_DOMAIN>/v1/oauth/callback/douyin
DOUYIN_API_BASE_URL=
```

## 接入和验收顺序

1. 在平台开发者后台创建应用，登记 HTTPS 回调地址。
2. 申请最小商品读取权限；写权限先保持关闭。
3. 配置真实 signer、商品字段映射和 `test_e2e` 能力证据。
4. 用一次性测试店铺完成 OAuth、换 Token、刷新 Token 和撤权。
5. 同步一条真实测试商品，核对商品、SKU、价格、库存和图片。
6. 执行撤权，确认同步和发布均被阻断。
7. 重新授权后再次同步，确认状态恢复。
8. 每个平台必须独立完成真实 canary 和回执对账后，才可按平台开启写入；不能用其他平台的证据替代。六个平台全部达到门禁后，才可将全局 `PLUGIN_WRITE_ENABLED=true`。

真实验收命令由 `docs/platform-capability-preflight.md` 约束；未配置真实账号时只能通过 fixture contract，状态保持 `fixture_verified`，不得标记为 `production_canary`。

## 当前阻塞项

- 六个平台真实应用 ID 和 Secret 尚未提供；
- 没有真实测试店铺或官方沙箱凭证；
- 尚未配置正式 HTTPS 域名和生产 Redis/Vault；
- 平台真实签名、类目 schema、商品写入回执尚未完成 canary；小红书/抖音还缺官方字段映射和 scope 证据。

因此当前 Codex App 可以演示六平台入口和 Mock 生命周期，但不能宣称已经完成真实商家授权。
