# 上线交付输入清单

本文把 `infra/config/production.blocked.example.yaml` 里的 **96 项生产必填配置**整理成可执行的交付清单。

**这份清单不是代码缺陷列表。** 代码侧的门禁（`npm run check`）已全绿；本文列的是**只有生产侧能提供**的值。每一行都写明了：谁提供、填在哪、**不填会怎样**、以及如何验证。

排序不是按字母，而是按「**离一个付费客户能完成一件有价值的事有多远**」——前三组不补齐，客户与运营会同时推不动；后面几组不补齐，则会在具体环节上失败。

> 判定依据一律来自代码，标注了文件与符号名。若某一行与你掌握的情况不符，**以代码为准并回来修正本文**——本文与配置模板必须一起改，否则又会变成新的失真。

---

## A. 支付链路（13 + 1 项）— 不补齐则客户与运营双向死锁

| 配置项 | 谁提供 | 不填会怎样 |
|---|---|---|
| `commercial_payment_provider` | 平台运营 | `commercial.order.create` 直接 503 且**订单不落库**；运营的 `ops.commercial.order.payment.verify` 因查不到订单返回 404 |
| `payment_mode` | 平台运营 | 生产门禁强制 `provider` |
| `payment_provider_adapters` | 平台运营 | 目前只实现了 `alipay`；`wechat` 返回 `provider_adapter_not_implemented` |
| `payment_provider_api_key_ref` | 支付服务商 → 密钥系统 | 网关就绪判定失败，在线支付不可用 |
| `payment_provider_merchant_id` | 支付服务商 | 同上 |
| `payment_callback_secret_ref` | 平台运营（与网关同源） | 回调验签无人可验，到账无法确认 |
| `payment_checkout_base_url` | 支付服务商 | 结账地址缺失 |
| `payment_provider_checkout_api_url` | 支付服务商 | 无法创建支付单 |
| `payment_provider_query_api_url` | 支付服务商 | 无法主动查单（对账依赖它） |
| `payment_provider_refund_api_url` | 支付服务商 | 退款不可用 |
| `payment_provider_refund_query_api_url` | 支付服务商 | 退款状态无法确认（unknown 状态会累积） |
| `payment_callback_base_url` | 平台运营 | 必须等于 `https://<merchant_bearer_hostname>/v1` |
| `payment_reconciliation_enabled` | 平台运营 | 生产必须为 `true` |
| `payment_refund_enabled` | 平台运营 | 生产必须为 `true` |

**判定代码**：`apps/api/src/server.ts` 的 `paymentProviderReadiness()`（13 项就绪判据）、`commercialPaymentProvider()`、`packages/application/src/commercial-payment-service.ts` 的 `createCheckout()`。

**替代路径**：若首发不带在线网关，把 `commercial_payment_provider` 设为 `manual_transfer`——订单会落库，走「客户线下转账 → 运营核验后发放」的人工路径。**此时不要设成 `alipay`**，否则客户看到的是「下单成功但付款失败」。

**验证**：下单后查 `commercial_orders_v2` 是否有行；`GET /v1/commercial/orders/<id>/payment` 返回状态。

---

## B. 素材扫描器（14 项）— 不补齐则素材永远停在隔离区

| 配置项 | 谁提供 | 不填会怎样 |
|---|---|---|
| `asset_scanner_mode` | 平台运营 | 生产必须是 `clamav_worker` |
| `asset_scanner_api_token_ref` / `asset_scanner_workspace_signing_secret_ref` | 平台运营 | 扫描回调无凭据 |
| `asset_scan_receipt_key_id` / `asset_scan_receipt_private_key_ref` | 平台运营 | 无法签发扫描回执 |
| `asset_scan_trusted_public_keys_ref` | 平台运营 | API 无法验签 |
| `asset_scan_policy_version` | 安全/合规 | 扫描策略版本缺失 |
| `clamav_image_digest` | 平台运营 | ClamAV 镜像必须是不可变 digest |
| `clamav_signature_max_age_minutes` | 安全 | 病毒库新鲜度上限 |
| `clamav_max_file_bytes` | 平台运营 | 单文件上限 |
| `allow_local_asset_scan_fixture` | 平台运营 | 生产必须 `false` |
| `asset_quarantine_retention_days` / `asset_clean_retention_days` | 平台运营（法务/合规确认） | 数据保留策略 |
| `asset_display_base_url` / `asset_display_url_signing_secret_ref` | 平台运营 | 素材展示签名 URL 不可用 |

**判定代码**：`apps/api/src/server.ts` 的 `requireApprovedAssetForImageGeneration()`；未通过扫描返回 `IMAGE_SOURCE_ASSET_INVALID`(409)，生成结果在隔离区返回 `GENERATED_IMAGE_SCAN_REQUIRED`(409)。

**验证**：上传一份隔离素材 → 扫描 → `asset.parse` 成功；扫描回执可验签。

> **已知部署阻塞**：scan pod 设了 pod 级 `runAsNonRoot: true`，而固定的 ClamAV 镜像以 root 运行，**kubelet 会拒绝该容器**。此项在代码/清单侧尚未解决，上集群前需先决策。

---

## C. 对象存储（6 项）

| 配置项 | 谁提供 |
|---|---|
| `object_storage_bucket` | 云厂商 / 平台运营 |
| `object_storage_region` | 云厂商 |
| `object_storage_endpoint` | 云厂商 |
| `object_storage_sse_mode` | 安全/合规（`AES256` 或 `aws:kms`）|
| `object_storage_versioning` | 平台运营（生产必须 `true`）|
| `lifecycle_policy_ref` | 平台运营（密钥系统中的生命周期策略引用）|

**不填会怎样**：素材隔离区写入失败（`putQuarantineObject`），上传链路整体不可用。生产要求 `OBJECT_STORAGE_VERSIONING=true`。

**验证**：上传 → 对象出现在 bucket 且带版本。

---

## D. 模型中转与额度（14 项）— 不补齐则无法生成任何内容

| 配置项 | 说明 |
|---|---|
| `model_relay_base_url` | 中转地址；主机名必须与 `MODEL_RELAY_ALLOWED_HOSTS` 完全一致 |
| `model_relay_api_key_ref` | 密钥系统引用 |
| `text_model` | 文案模型 |
| `image_model` | 图片生成模型 |
| `image_edit_model` | 图片编辑模型 |
| `ocr_model` | OCR 模型 |
| `video_model` | 视频模型 |
| `embedding_model` | 向量模型 |
| `embedding_dimensions` | 向量维度（必须与模型一致）|
| `embedding_max_request_cny` | 单次 embedding 请求成本上限 |
| `knowledge_vector_index_enabled` | 向量索引开关 |
| `approved_requests_per_minute` | 已批准的中转 RPM 上限 |
| `approved_tokens_per_minute` | 已批准的 TPM 上限 |
| `maximum_task_cost_cny` | 单任务成本上限 |

**不填会怎样**：图片/文案生成立即 `MODEL_RELAY_NOT_CONFIGURED`(503)。

**注意**：`model_relay_base_url` 的主机名必须与 `MODEL_RELAY_ALLOWED_HOSTS` **完全一致**（绑定门禁强制）。占位域名会被配置门禁直接拒绝。

**验证**：跑一次真实生成，确认 `model_usage_ledger` 有 provider request ID 与成本。

---

## E. 图片/视频 artifact 白名单（2 项）— 本轮新增的必填项

`image_artifact_allowed_hosts`、`video_artifact_allowed_hosts`。

**不填 / 填占位值会怎样**（这是两种不同的失败）：
- **空值** → 生产启动即 503 `IMAGE_ARTIFACT_ALLOWLIST_MISSING` / `VIDEO_ARTIFACT_ALLOWLIST_MISSING`（fail-closed，**这是好事**）
- **占位值**（如 `image-cdn.example.com`）→ **启动正常**，但白名单指向保留域名，运行时**每一个真实 artifact 主机都被拒绝**，而且没有任何提示

**验证**：填真实 CDN 主机后跑一次图片生成 → artifact 可拉取。配置门禁会拒绝 `example.*` / `invalid` / `localhost` / `127.0.0.1`。

---

## E2. 素材权益门禁（1 项）— 本轮新增的必填项

`require_approved_asset_for_generation`（生产必须为 `true`）。

**不填会怎样**：API 用 `!== 'true'` 读取该开关（**fail-open**），未配置即等于关闭——正式商品主图生成不再要求素材已通过安全扫描、已确认商用权益、允许 AI 修改且适用于目标平台，**且没有任何提示或 503**。这与 `image_artifact_allowed_hosts` 的「空值会 fail-closed」不同：这一项空值不报错，只是静默不设防。

**验证**：`require_approved_asset_for_generation: false` 或缺键的渲染配置会被 `validate-production-config.sh` 直接拒绝；生产的渲染 ConfigMap 必须带 `REQUIRE_APPROVED_ASSET_FOR_GENERATION: "true"`（`validate-rendered-production-config.rb` 绑定门禁强制逐字一致）。

---

## F. 身份、会话与 MCP 边界（9 项）

`merchant_bearer_hostname`、`app_base_url`、`ops_base_url`、`mcp_base_url`、`mcp_authorization_mode`、`OPS_AUTH_MODE`、`auth_enforcement`、`session_id_hash_secret_ref`、`durable_platform_assignments_required`。

**约束（绑定门禁强制）**：
- `mcp_base_url` 必须**逐字等于** `app_base_url`（插件会自行追加 `/mcp`）
- `app_base_url` 的主机必须等于 `merchant_bearer_hostname`
- `ops_base_url` 的主机**必须与商家主机不同**（运营台走独立的 OIDC 边界）
- 生产要求 `mcp_authorization_mode=enforce`、`durable_platform_assignments_required=true`

**验证**：`GET /releasez` 返回 `ready=true`；商家与运营两个 origin 分别可达。

---

## G. 密钥与数据库（5 项）

`secret_provider`（生产为 `vault`）、`database_pooler_enabled`、`database_max_backend_connections`、`database_connection_utilization_alert_percent`、`point_in_time_recovery_enabled`。

**约束**：`DATABASE_URL` 与 `OPS_DATABASE_URL` 必须使用**不同**的非 owner、非 superuser、非 `BYPASSRLS` 凭据，且都带 `sslmode=require|verify-ca|verify-full`；preflight 会拒绝 loopback 与未指定本机地址。

---

## H. Worker 凭据与 UI 凭据（13 项）

`worker_api_credentials_ref`，以及 5 个角色（sync / generation / publish / reconcile / automation）各自的 token 与签名密钥引用：

| 角色 | token | 签名密钥 |
|---|---|---|
| sync | `worker_sync_api_token_ref` | `worker_sync_api_signing_secret_ref` |
| generation | `worker_generation_api_token_ref` | `worker_generation_api_signing_secret_ref` |
| publish | `worker_publish_api_token_ref` | `worker_publish_api_signing_secret_ref` |
| reconcile | `worker_reconcile_api_token_ref` | `worker_reconcile_api_signing_secret_ref` |
| automation | `worker_automation_api_token_ref` | `worker_automation_api_signing_secret_ref` |

外加商家后台的两个凭据引用：`merchant_ui_api_token_ref`、`merchant_ui_workspace_id_ref`。

**约束**：各角色 token 与签名密钥**必须互不相同**（门禁断言唯一性）。若共用，一个角色被攻陷即可伪造任意角色的内部回调。

**注意**：scan 角色没有自己的 token 对——它复用 `ASSET_SCANNER_*` 系列（见 B 组）。

**说明**：`WORKER_API_CREDENTIALS` 是唯一同时含全部 6 个角色 token 的配置——它充当这些配置项的对照来源。

---

## I. 平台能力开关（10 项）

`platform_operations_mode`（**当前上线档必须为 `manual`**），以及三个平台的读/写/授权开关：

| 平台 | auth | read | write |
|---|---|---|---|
| 京东 | `jd_auth_enabled` | `jd_read_enabled` | `jd_write_enabled` |
| 淘宝/天猫 | `taobao_tmall_auth_enabled` | `taobao_tmall_read_enabled` | `taobao_tmall_write_enabled` |
| 拼多多 | `pinduoduo_auth_enabled` | `pinduoduo_read_enabled` | `pinduoduo_write_enabled` |

（小红书与抖音的开关不在必填集内，由 `render-production-config-from-env.mjs` 按平台分组条件性要求。）

**manual 档的强制约束**：`platform_rule_sync_manifest_url` 与 `platform_rule_sync_signing_secret_ref` **必须留空**、`platform_rule_sync_interval_hours` 必须为 `0`——配置门禁会拒绝 manual 档下启用远端规则同步。

**客户可达性**：本轮的「运营侧人工店铺记录」能力（`ops.platform.store.record.create`）就位后，运营为商家登记人工店铺范围，商家才能使用商品同步、任务与发布。

---

## J. 发布与可观测性（4 项）

`release_id`（必须绑定到同一次发布的所有证据）、`plugin_enabled`、`alert_notifications_enabled`、`backup_retention_days` / `deletion_request_grace_days` / `lifecycle_policy_ref`。

**告警通道（已判 NO-GO）**：仓库内**没有**部署 Prometheus / Alertmanager，**没有**真实 paging 通道、**没有**值班表与演练记录。`infra/observability/*.example.yaml` 是**未部署的模板**，一条规则都不在生效。补齐所需的六项见 `production-ops-runbook.md` 的「3.4 告警通道现状」。

**判定**：在监控栈 + paging 通道 + 值班表 + 至少一次触发/送达/人工确认演练记录齐备之前，这一项**保持 NO-GO**。

---

## 还需要（不在 96 项配置里，但发布门禁要求）

发布门禁要求以下证据由**生产环境**生成并签名，**禁止**用 fixture / example / test 文件替代：

- 平台 capability canary（六平台，按 manual 运营模式如实记录）
- capacity report
- model relay / Codex app host / object storage / payment / restore 证据
- release manifest 与 evidence bundle，全部绑定同一 `RELEASE_ID`，并由固定 trust anchor 以 Ed25519 签名

（见 `docs/runbooks/release-unblock-checklist.md` 与 `deploy-verified-ecs-compose.sh`）

---

## 最短路径建议

按依赖顺序，补齐以下四组即可让**第一个付费客户走通「导入商品 → 生成内容 → 人工交付」**：

1. **F 组**（身份/MCP 边界）——没有它，插件连不上
2. **D 组**（模型中转）——没有它，生成不可用
3. **A 组**（支付，或用 `manual_transfer` 走人工路径）
4. **B + C 组**（扫描器 + 对象存储）——素材链路的硬前置

发布（J 组告警通道 + 生产签名证据）可以在灰度期间并行推进，但**不能**在发布判定时以「已配置」替代。
