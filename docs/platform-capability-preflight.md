# 六平台连接器 Capability Preflight

## 目的

`packages/connectors/src/platform-preflight.ts` 提供一个不需要真实平台凭证的上线前检查器。它把六个平台的统一连接器 contract、能力证据矩阵和 HTTP readiness 分开报告，避免把 fixture 通过误判为真实平台已上线。

覆盖平台：京东（`jd`）、淘宝（`taobao`）、天猫（`tmall`）、拼多多（`pinduoduo`）、小红书（`xiaohongshu`）、抖音（`douyin`）。小红书和抖音当前只证明统一 profile/fixture/API 边界；在官方应用、签名器、字段映射和真实 canary 完成前，生产写入保持关闭。

每个平台的 fixture contract 会验证：

- 授权、撤销授权
- 商品读取、全量同步、增量同步
- 创建、更新、写入状态查询
- fixture 商品到 canonical 商品的映射和写入幂等回执

这些检查只证明适配器的端口和字段 contract 可用，不证明官方应用权限、签名、回调、配额或真实 API 行为。

## 运行

定向单元/contract test：

```sh
npm exec vitest run packages/connectors/src/platform-preflight.test.ts --no-file-parallelism
```

原有证据文件 gate 现在复用同一个 package verifier：

```sh
npm run evidence:validate -- --file docs/platform-capability-evidence.example.json
npm run evidence:validate -- --file /secure/evidence/platform-capability-evidence.json --require-canary --release-id "$RELEASE_ID"
```

真实平台 canary 使用统一 runner，凭证仍只从 Vault/外部 Secret Provider 解析，不写入证据文件：

```sh
PLATFORM_CANARY_MODE=real \
PLATFORM_CANARY_CONFIRM=true \
PLATFORM_CANARY_PLATFORM=taobao \
PLATFORM_CANARY_WORKSPACE_ID=ws_canary \
PLATFORM_CANARY_ACCOUNT_ID=store_canary \
PLATFORM_CANARY_APPLICATION_ID=approved-taobao-app \
PLATFORM_CANARY_EVIDENCE_REF=artifact://canary/taobao/$RELEASE_ID \
PLATFORM_CANARY_VERIFIED_BY=release-owner \
PLATFORM_CANARY_API_VERSION=v1 \
PLATFORM_CANARY_SCOPE='item.read,item.write' \
PLATFORM_CANARY_BASE_EVIDENCE=/secure/evidence/platform-capability-evidence.base.json \
PLATFORM_CANARY_OUTPUT=/secure/evidence/taobao-canary.json \
npm run test:platform-canary
```

六个平台可以使用统一门禁。它会逐个平台运行真实 canary、合并 evidence、执行 `--require-canary` 验证，并可在最后执行真实 PostgreSQL Worker 重启验收；社交平台只有在补齐各自官方适配器证据后才能通过该门禁：

```sh
RELEASE_ID="$RELEASE_ID" \
PAYMENT_MODE=provider \
PAYMENT_CALLBACK_BASE_URL="$PAYMENT_CALLBACK_BASE_URL" \
PAYMENT_CALLBACK_SECRET_REF="$PAYMENT_CALLBACK_SECRET_REF" \
PLATFORM_CANARY_MODE=real \
PLATFORM_CANARY_CONFIRM=true \
PLATFORM_CANARY_BASE_EVIDENCE=/secure/evidence/platform-capability-evidence.base.json \
PLATFORM_CANARY_OUTPUT=/secure/evidence/platform-capability-evidence.json \
PLATFORM_CANARY_JD_APPLICATION_ID="$JD_APPLICATION_ID" \
PLATFORM_CANARY_JD_TEST_STORE_ID="$JD_TEST_STORE_ID" \
PLATFORM_CANARY_JD_WORKSPACE_ID="$JD_CANARY_WORKSPACE_ID" \
PLATFORM_CANARY_JD_ACCOUNT_ID="$JD_CANARY_ACCOUNT_ID" \
PLATFORM_CANARY_JD_SCOPE="$JD_CANARY_SCOPE" \
PLATFORM_CANARY_JD_API_VERSION="$JD_API_VERSION" \
PLATFORM_CANARY_JD_VERIFIED_BY="$RELEASE_OWNER" \
RUN_WORKER_ACCEPTANCE=true \
DATABASE_URL="$PRODUCTION_DATABASE_URL" \
WORKER_WORKSPACES="$CANARY_WORKSPACE_ID" \
npm run test:production-canary
```

`TAOBAO`、`TMALL`、`PDD`、`XHS`、`DOUYIN` 使用同样的前缀字段；正式运行时各组字段都必须填写真实值，不能使用 `SET_*` 占位符。当前生产 native connector gate 对六个平台统一执行 evidence/readiness 检查；小红书和抖音未提供真实 production evidence 时默认会阻断写入，不会被旧四平台基线绕过。

runner 默认要求 `jd,taobao,tmall,pinduoduo,xiaohongshu,douyin` 六个平台全部通过；任何一个平台、支付配置、证据或 Worker 验收失败，都不会写出 production-ready 证据。写入/撤销 canary 仍需额外设置原有的双重确认变量。

`PLATFORM_CANARY_BASE_EVIDENCE` 必须是同一 release 的六平台证据矩阵；runner 只更新当前平台，随后仍需执行 `npm run evidence:validate -- --file /secure/evidence/taobao-canary.json --require-canary --release-id "$RELEASE_ID"`。

创建/更新会改变测试店铺，必须额外设置 `PLATFORM_CANARY_ALLOW_WRITE=true PLATFORM_CANARY_CONFIRM_WRITES=true`；撤销授权会使测试账号失效，只有一次性 disposable 账号才允许设置 `PLATFORM_CANARY_ALLOW_REVOKE=true PLATFORM_CANARY_CONFIRM_REVOKE=true`。未显式开启时 runner 会把写入/撤销标记为未验证，不会伪造 `production_canary`。

媒体能力同样必须使用受控测试素材：设置 `PLATFORM_CANARY_MEDIA_FILE=/secure/canary/main.png`（可按平台使用 `PLATFORM_CANARY_XHS_MEDIA_FILE` 等前缀覆盖），文件大小不得超过 5 MiB；runner 会计算 SHA-256、上传主图并要求非模拟媒体 ID 回执，缺少素材或回执时不会生成 production-ready 证据。

代码集成方式：

```ts
import { runPlatformPreflight } from '@merchant-marketing/connectors'

const result = await runPlatformPreflight({
  evidence: parsedEvidenceJson,
  configs: renderedConnectorConfigs,
  requireProductionCanary: true,
})

if (!result.passed) {
  console.error(result.gaps)
  process.exitCode = 1
}
```

`configs` 是可选的。未传入时，结果会明确报告每个平台的 `HTTP connector config not supplied` 缺口；即使 evidence 矩阵全部为 `production_canary`，也不会因为 fixture contract 通过而隐藏该缺口。

## 证据状态与上线判断

证据状态只能按以下顺序理解：

`unverified → documented → fixture_verified → test_e2e → production_canary`

生产 gate 还要求：

- 六个平台各有九项能力，额外要求主图/副图媒体上传回执；
- 每项非 `unverified` 证据都有 `evidence_ref`、`verified_by`、合法 ISO 时间；
- `production_canary` 证据包含 `api_version` 和 `scope`；
- 六个平台的 application/test store 标识不是 `SET_*`、`REPLACE_ME` 等占位符；
- 证据 JSON 不包含 secret、token、password、private key 等字段；
- 生产/预生产 canary 证据必须使用带时区的 ISO instant；能力验证时间不能晚于证据文档生成时间；
- canary 记录中的 application/store、scope、API 版本和证据引用不能是 `SET_*`、`TODO` 等占位符；
- `validateConnectorReadiness` 对每个平台配置通过，包含真实 signer、字段映射、映射证据、HTTPS 和 host allowlist 检查。

`production_canary` 仍是外部验收证据，不可由 fixture test 自动生成。真实平台缺口通常包括官方应用审批、OAuth 回调、scope、测试店铺、签名算法、商品字段映射、写入回读、限流/超时行为及平台侧撤销授权。
