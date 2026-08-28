# Connector HTTP 适配器配置

本项目的 connector 现在同时支持两种模式：

- `FakePlatformConnector`：本地开发、fixture 和 contract test 使用；不会访问平台网络。
- `HttpPlatformConnector`：通过运行时注入平台配置、凭证 Provider、可选签名器和 `fetch` 实现，负责调用平台官方接口。

通用适配器只实现 HTTP 边界和通用错误处理，不声称实现六个平台的官方签名细节。各平台的签名算法、参数排序、版本字段和 payload 映射必须由平台适配模块通过 `RequestSigner`、`mapProducts`、`mapWriteReceipt` 和 `mapWriteStatus` 注入，并以官方文档/沙箱证据为准。

## 最小配置

`HttpConnectorConfig` 必须包含以下真实适配边界；仅有端点和 client id 不会被视为可用：

- `clientId`
- `oauth.authorizeUrl`、`oauth.tokenUrl`
- `api.baseUrl`、`syncPath`、`createPath`、`updatePath`、`queryPath`
- `CredentialProvider`
- 平台真实 `RequestSigner`（`kind: 'platform'`）
- `mapProducts`、`mapWriteReceipt`、`mapWriteStatus`
- 与当前平台匹配、至少达到 `test_e2e` 且可追溯的 `capabilityEvidence`
- `mappingEvidence`（版本、证据引用、验证人、验证时间）

应用启动时可调用 `buildHttpConnectorConfigs(process.env)` 自动装配六个独立配置：

- `jd` 使用 `JD_*`
- `taobao` 使用 `TAOBAO_*`
- `tmall` 使用 `TMALL_*`（不会复用或覆盖淘宝配置）
- `pinduoduo` 使用 `PDD_*`
- `xiaohongshu` 使用 `XHS_*`
- `douyin` 使用 `DOUYIN_*`

每个平台只有在端点完整且通过 `validateConnectorReadiness` 后才会进入 `configs`；缺少签名器、字段映射、映射证据或能力证据的平台会被留在 `readiness/missing`，不会被宿主识别为已配置。同步、创建、更新、查询路径可用对应的 `*_SYNC_PATH`、`*_CREATE_PATH`、`*_UPDATE_PATH`、`*_QUERY_PATH` 覆盖，scope 使用逗号分隔的 `*_OAUTH_SCOPES`。

六个 API 路径必须是以 `/` 开头的相对路径；绝对 URL、协议相对 URL 和空路径会被 readiness 拒绝，防止配置把请求跳转到未审计的主机。readiness 通过只表示配置边界完整，仍不等于真实平台 canary 通过。

如果配置来自配置中心，可使用 `buildHttpConnectorConfigsFromStructured({ jd, taobao, tmall, pinduoduo, xiaohongshu, douyin })` 或把同样的 `structuredConfig` 传给 `ConnectorRuntime`。结构化配置只包含 client id、端点、路径和映射/签名配置；client secret 和 access/refresh token 仍应通过 secret 注入与 `VaultCredentialProvider` 管理，不放入普通配置对象。小红书和抖音没有仓库内置官方 signer/mapper，但提供了需显式配置 response mapping 的 bearer/generic transport；媒体上传还需 `mediaUploadPath`、媒体回执 mapping 和 `mediaUploadEvidence`，缺少平台官方映射或证据时仍保持 `NOT_CONFIGURED`。

缺少配置、凭证或凭证存储时，connector 返回 `NOT_CONFIGURED` 或 `UNAUTHORIZED`，不会退回 fake 写入，也不会把 token 放入 receipt、错误详情或日志。

```ts
const runtime = new ConnectorRuntime({
  connectorConfigs: {
    jd: {
      clientId: process.env.JD_APP_KEY!,
      clientSecret: process.env.JD_APP_SECRET,
      oauth: {
        authorizeUrl: process.env.JD_OAUTH_AUTHORIZE_URL!,
        tokenUrl: process.env.JD_OAUTH_TOKEN_URL!,
      },
      api: {
        baseUrl: process.env.JD_API_BASE_URL!,
        syncPath: '/documented/products',
        createPath: '/documented/products/create',
        updatePath: '/documented/products/update',
        queryPath: '/documented/publish/status',
      },
      signer: jdSigner,
      mapProducts: mapJdProducts,
    },
  },
  credentialProvider: vaultCredentialProvider,
})
```

`CredentialProvider` 是宿主应用注入的 Vault/KMS port；生产实现应声明 `kind: 'vault'` 或 `kind: 'external'`，从 Vault/KMS 读取短期访问凭证，`store` 和 `revoke` 负责保存/吊销引用。connector 不缓存 token，也不在 receipt、错误详情或日志中返回 token。`exchangeCode`、refresh 和 revoke 在没有 provider、provider 缺失 `store`、或 Vault 调用失败时统一 fail closed。仓库不提供任何生产内存 token store；测试 provider 只能放在测试代码中。

仓库现在提供 `VaultKvCredentialProvider`，用于 HashiCorp Vault KV v2。通过 `VAULT_ADDR`、`VAULT_TOKEN`、可选的 `VAULT_KV_MOUNT`、`VAULT_NAMESPACE` 和 `VAULT_CREDENTIAL_PATH_PREFIX` 装配；API 启动时会自动注入它。生产环境中的 `VAULT_TOKEN` 仍应由云 Secret Manager/Workload Identity 注入，不能提交到 `.env`、镜像或日志。未同时提供地址和 token 时，provider 不会创建，平台操作继续 fail closed。

授权 URL 构造也必须先通过 readiness；没有真实签名、映射和可追溯能力证据时返回 `NOT_CONFIGURED`。真实 OAuth code exchange 必须经过真实 provider；仓库不会实现或伪造任何平台签名算法。

## 错误与重试

HTTP 401/403、404、409、429 分别归一化为 `UNAUTHORIZED`、`NOT_FOUND`、`CONFLICT`、`RATE_LIMITED`；超时归一化为 `TIMEOUT + unknown + retryable`。未知 HTTP/网络失败归一化为 `REMOTE_ERROR`。发布 Worker 仍须遵守 unknown 状态的远端不存在证明和安全重试证明，connector 不自行重试写请求。

## 环境变量模板

下面变量只描述配置边界，真实值放入 Secret/KMS，不提交仓库：

```dotenv
CONNECTOR_FIXTURE_MODE=false
PLUGIN_WRITE_ENABLED=false
PUBLIC_OAUTH_REDIRECT_URI=https://merchant.example.com/v1/oauth/callback/{platform}
JD_APP_KEY=
JD_APP_SECRET=
JD_OAUTH_AUTHORIZE_URL=
JD_OAUTH_TOKEN_URL=
JD_OAUTH_REDIRECT_URI=https://merchant.example.com/v1/oauth/callback/jd
JD_API_BASE_URL=
TAOBAO_APP_KEY=
TAOBAO_APP_SECRET=
TAOBAO_OAUTH_AUTHORIZE_URL=
TAOBAO_OAUTH_TOKEN_URL=
TAOBAO_OAUTH_REDIRECT_URI=https://merchant.example.com/v1/oauth/callback/taobao
TAOBAO_API_BASE_URL=
PDD_APP_KEY=
PDD_APP_SECRET=
PDD_OAUTH_AUTHORIZE_URL=
PDD_OAUTH_TOKEN_URL=
PDD_OAUTH_REDIRECT_URI=https://merchant.example.com/v1/oauth/callback/pinduoduo
PDD_API_BASE_URL=
XHS_APP_KEY=
XHS_APP_SECRET=
XHS_OAUTH_AUTHORIZE_URL=
XHS_OAUTH_TOKEN_URL=
XHS_OAUTH_REDIRECT_URI=https://merchant.example.com/v1/oauth/callback/xiaohongshu
XHS_API_BASE_URL=
XHS_SYNC_PATH=/documented/products
XHS_CREATE_PATH=/documented/products/create
XHS_UPDATE_PATH=/documented/products/update
XHS_QUERY_PATH=/documented/publish/status
XHS_MEDIA_UPLOAD_PATH=/documented/media/upload
XHS_MEDIA_ID_PATH=data.media_id
XHS_MEDIA_URL_PATH=data.url
XHS_MAPPING_EVIDENCE_VERSION=
XHS_MAPPING_EVIDENCE_REF=
XHS_MAPPING_EVIDENCE_VERIFIED_BY=
XHS_MAPPING_EVIDENCE_VERIFIED_AT=
XHS_MEDIA_UPLOAD_EVIDENCE_VERSION=
XHS_MEDIA_UPLOAD_EVIDENCE_REF=
XHS_MEDIA_UPLOAD_EVIDENCE_VERIFIED_BY=
XHS_MEDIA_UPLOAD_EVIDENCE_VERIFIED_AT=
DOUYIN_APP_KEY=
DOUYIN_APP_SECRET=
DOUYIN_OAUTH_AUTHORIZE_URL=
DOUYIN_OAUTH_TOKEN_URL=
DOUYIN_OAUTH_REDIRECT_URI=https://merchant.example.com/v1/oauth/callback/douyin
DOUYIN_API_BASE_URL=
DOUYIN_SYNC_PATH=/documented/products
DOUYIN_CREATE_PATH=/documented/products/create
DOUYIN_UPDATE_PATH=/documented/products/update
DOUYIN_QUERY_PATH=/documented/publish/status
DOUYIN_MEDIA_UPLOAD_PATH=/documented/media/upload
DOUYIN_MEDIA_ID_PATH=data.media_id
DOUYIN_MEDIA_URL_PATH=data.url
DOUYIN_MAPPING_EVIDENCE_VERSION=
DOUYIN_MAPPING_EVIDENCE_REF=
DOUYIN_MAPPING_EVIDENCE_VERIFIED_BY=
DOUYIN_MAPPING_EVIDENCE_VERIFIED_AT=
DOUYIN_MEDIA_UPLOAD_EVIDENCE_VERSION=
DOUYIN_MEDIA_UPLOAD_EVIDENCE_REF=
DOUYIN_MEDIA_UPLOAD_EVIDENCE_VERIFIED_BY=
DOUYIN_MEDIA_UPLOAD_EVIDENCE_VERIFIED_AT=
TMALL_CLIENT_ID=
TMALL_CLIENT_SECRET=
TMALL_OAUTH_AUTHORIZE_URL=
TMALL_OAUTH_TOKEN_URL=
TMALL_OAUTH_REDIRECT_URI=https://merchant.example.com/v1/oauth/callback/tmall
TMALL_OAUTH_REFRESH_URL=
TMALL_OAUTH_REVOKE_URL=
TMALL_OAUTH_SCOPES=
TMALL_API_BASE_URL=

# HashiCorp Vault KV v2（生产由 Secret Manager/Workload Identity 注入）
VAULT_ADDR=
VAULT_TOKEN=
VAULT_KV_MOUNT=secret
VAULT_NAMESPACE=
VAULT_CREDENTIAL_PATH_PREFIX=merchant-marketing

# 可选：六个平台均支持 *_SYNC_PATH/*_CREATE_PATH/*_UPDATE_PATH/*_QUERY_PATH
# 以及 *_HTTP_TIMEOUT_MS；JD/TAOBAO/PDD 也可用 *_APP_KEY/_APP_SECRET。
```

在没有完成官方应用、scope、回调域名、测试店铺、签名器、真实 payload fixture 和读写探针前，平台 readiness 只能保持 `not_configured`/`fixture_verified`，不能标记为生产可用。
