# PRD 追踪核对：FR-11～FR-15、版本、发布、运营、容量、安全与验收

核对日期：2026-08-24  
核对范围：`docs/PRD-merchant-marketing-codex-final.md` v1.4 Final、仓库源码、测试、部署模板和现有交付文档  
核对原则：代码/自动化测试证明“实现或本地行为”；真实平台、真实云和生产运维必须有对应的外部原始证据才能标记完成。

> 范围校正（2026-08-26）：FR-15 当前按六个平台审理：京东、淘宝、天猫、拼多多、小红书、抖音。下文“四 profile/四平台”是旧版 PRD 与历史证据口径；当前生产写入门禁与 canary runner 以六个平台为准。

## 1. 总结结论

当前不能签署“PRD 全部完成”或“可生产上线”。FR-11～FR-14 的核心业务能力大多已有代码和自动化测试，FR-15 的六平台连接器契约、fixture 和生产门禁代码已具备，但六个平台的真实 platform canary 尚无可核验的非占位证据。50 家首发和 500 家目标容量也只有本地/Compose/loopback 证据，尚无 `cloud_gate=true` 的真实云报告。

| 范围 | 当前结论 | 主要原因 |
|---|---|---|
| FR-11 修改与版本 | 部分完成 | 修改、diff、恢复、乐观锁和版本向量已有测试；生产级跨服务持久化/并发运行证据和完整向量随发布物、平台回执的实证仍缺 |
| FR-12 输出与交付 | 部分完成 | Markdown/JSON/ZIP、manifest、source map、检查结果和“无回执不伪造”已实现；真实平台成功回执包、过期价格和失败重试的完整外部验收未完成 |
| FR-13 历史、搜索、反馈 | 已完成（代码/本地验收） | 检索、时间线、反馈、克隆/恢复、停用后审计等已有实现和测试；真实试点验收仍属于总体验收未完成项 |
| FR-14 运营与可观测性 | 本地大部分完成 | trace/envelope、结构化事件、统一 HTTPS/HMAC 告警 Webhook、Runbook/部署模板已具备；托管 OTel、Dashboard、真实通知到达和值班演练没有生产证据 |
| FR-15 平台授权、同步、发布 | 部分完成，生产写入未完成 | 六平台 adapter/contract/preflight/fixture 已有；京东、淘宝、天猫、拼多多、小红书、抖音真实 OAuth、读写、状态回读、撤销 canary 未证实 |
| 50 家首发容量 | 未完成 | 当前证据明确是 `cloudGate=false`，且平台/模型为 mock 或未实际压测 |
| 500 家目标容量 | 未完成 | 只有容量合同、脚本和本地/Compose结果，没有目标配置下真实云 150/300 RPS、500 作业突发及 6 小时报告 |
| 安全生产验收 | 部分完成 | OAuth/IDOR/上传/脱敏/RLS 等代码测试通过；真实 Secret Store、KMS、WAF、TLS、日志落盘扫描、密钥轮换和恢复演练未证实 |

## 2. FR-11 修改与版本管理

PRD 原文位置：`docs/PRD-merchant-marketing-codex-final.md:796-814`。

| PRD 要求 | 状态 | 已核对证据 | 缺口/外部依赖 |
|---|---|---|---|
| 识别修改对象、位置、禁改项和影响范围 | 已完成 | `packages/application/src/service.ts` 的局部修改接口；`packages/application/src/version-vector.test.ts` 覆盖锁定字段和局部修改 | 需补充真实 Codex App 多轮修改的可见验收记录 |
| 区分只改内容、升级商品资产、升级品牌/店铺规则并二次确认 | 部分完成 | Skill 明确要求区分；资产/规则有独立 MCP/API 边界 | 需用真实用户交互证明“以后默认”等作用域确认未被绕过 |
| 每次修改创建新版本并记录原因、输入、模型、规则快照、差异 | 已完成（代码/测试） | `content_versions`、父子版本、`reason`、`versionVector`；版本向量测试验证 manifest 导出 | 生产数据库迁移后的端到端恢复和跨副本一致性仍需环境证据 |
| 查看、字段/段落 diff、候选版本、设为当前、恢复旧版本 | 已完成（代码/本地验收） | 版本 HTTP 验收、`content.diff`、恢复创建新版本；`docs/implementation-status.md:31-33,148` | 无任意分支合并 UI 属于 PRD 明确非 P0，不是缺口 |
| approved/delivered 只读；恢复不覆盖历史 | 已完成（代码/测试） | 领域状态机、恢复创建子版本；`packages/application/src/version-vector.test.ts` | 需纳入正式发布流水线回归 |
| 并发保存返回冲突/差异而不是覆盖 | 已完成（代码/测试） | `VERSION_CONFLICT`、`expected_version`，版本向量测试 | 尚缺真实多客户端/多 API 副本压力下的原始报告 |
| 远端变化使 confirmation token 失效 | 已完成（代码/测试） | 发布准备/确认校验远端 snapshot hash；`apps/api/src/server.ts` 发布门禁 | 尚缺真实平台远端修改后回读 canary |
| 完整版本向量覆盖事实、任务、规则、映射、软件、模型、内容和平台远端版本 | 部分完成 | 应用层向量含 asset/task/rule/mapping/plugin/skill/mcp/connector/model/prompt/creator/time/reason；manifest 导出已带向量 | 需确认生产值不是 fixture/default（如 `local`、`deterministic-fixture`），并将真实 connector build、平台远端 snapshot、发布 receipt 绑定到同一 release |

### FR-11 结论

业务版本模型可以进入 RC，但不能称为生产验收完成。上线前必须提供：同一 release 的真实配置版本向量、跨副本并发冲突原始报告、真实平台远端变更导致旧确认失效的证据，以及一份可从交付包还原的完整 provenance 审计样本。

## 3. FR-12 输出与交付包

PRD 原文位置：`docs/PRD-merchant-marketing-codex-final.md:816-844`。

| PRD 要求 | 状态 | 已核对证据 | 缺口/外部依赖 |
|---|---|---|---|
| Markdown、JSON、ZIP 导出 | 已完成（代码/测试） | `packages/application/src/service.ts` 导出路径；应用测试覆盖 manifest/ZIP | 需在最终构建产物中固定版本和 checksum |
| README、content、manifest、review-findings、source-map | 已完成 | `docs/implementation-status.md:32,216`；导出实现已包含这些文件 | 需检查生产对象存储下载链路和权限 |
| 未发布时省略 `publish-receipt.json`，不得伪造已发布 | 已完成（代码/测试） | `packages/application/src/service.test.ts`；实现只在真实可验证状态生成回执 | 需要真实平台成功回读样本验证回执字段完整性 |
| 已发布包记录平台账号、商品/SKU ID、幂等键、请求时间、request ID、状态且不含 token | 部分完成 | 发布 Job/Observation 数据模型和脱敏边界已实现；Worker 强制 queryWrite | 没有真实 published 回执，无法核验平台字段、状态审核和最终生效链路 |
| 文件名安全归一化且默认不覆盖旧包 | 已完成（代码/测试） | 导出逻辑和对象存储版本策略 | 需补充对象存储真实版本化/保留策略证据 |
| ZIP 解压后文件存在且 checksum 一致 | 已完成（本地测试） | ZIP 生成和导出测试 | 需在生产对象存储上传、下载、重试链路复验 |
| 过期价格再次阻断；旧包标记 expired | 部分完成 | `ContentVersion.deliveryStatus`、`markExpiredDeliveryIfNeeded` 和 `content.delivery_expired` 事件会在过期时保留原版本/审核证据并标记 `expired`；manifest/content 带出状态；服务层回归覆盖 `CONTENT_EXPORT_BLOCKED` 与状态变更 | 对象存储中的历史文件标记、下载重试和生产故障注入仍需验收 |
| 下载失败可重试，幂等重试不创建新版本 | 部分完成 | API 对素材/生成图片对象读取统一使用最多 3 次、仅针对 429/5xx/网络瞬态错误的退避重试；导出仍按内容版本 ID 生成，不创建新版本 | 需要真实对象存储故障注入和下载链路原始运行证据 |

### FR-12 结论

交付包生成能力基本具备，但“真实平台成功回执包”仍是外部依赖；当前本地 fixture 发布只能得到 `submitted`/`simulated`，不能满足 PRD 的最终 published 验收。

## 4. FR-13 历史、搜索与反馈

PRD 原文位置：`docs/PRD-merchant-marketing-codex-final.md:846-860`。

| PRD 要求 | 状态 | 已核对证据 | 缺口/外部依赖 |
|---|---|---|---|
| 按品牌、店铺、商品、SKU、平台、状态、日期搜索 | 已完成（代码/测试） | `docs/implementation-status.md:64` 列出历史检索覆盖；API/Repository 有筛选索引 | 需用真实大数据量工作区验证查询延迟 |
| 按账号、同步状态、远端商品 ID、发布状态搜索 | 已完成（代码/测试） | 同上；平台账号和远端 ID 已纳入查询 | 真实多店铺数据隔离仍需云环境验收 |
| 时间线展示版本、确认、失败和交付事件 | 已完成（代码/本地验收） | 任务 timeline、事件 envelope、Outbox/快照 | 需验证异常跨重启、跨 Worker 后时间线完整性 |
| 交付后反馈，且反馈只作用于当前任务 | 已完成（代码/测试） | migration `009_feedback`、Feedback API、实现状态文档 | 真实商家反馈闭环和数据留存策略未签署 |
| 从历史恢复上下文并创建副本 | 已完成（本地验收） | 历史任务克隆/版本恢复验收记录 | 需纳入正式 E2E 日常流水线 |
| 过期任务不默认带入旧活动价 | 部分完成 | `ProductionPlan.activityValidUntil`、逐 SKU `promotionPriceDiff`、`PROMOTION_EXPIRED` 预检和 `service.test.ts` 有效期测试已存在 | 仍需补充跨任务/历史恢复的独立验收样本，证明新任务不会静默复用过期活动价 |
| 商品停用后保留历史但阻断新任务 | 已完成（代码/测试） | `workspace/product deactivate/restore` 相关 API/MCP 和状态门禁 | 真实商家数据删除/停用合规流程仍需运营确认 |

### FR-13 结论

FR-13 是当前五项中完成度最高的业务模块，代码和本地验收可视为完成；若按 PRD 总体 DoD，还需将其放入真实试点和生产观测闭环。

## 5. FR-14 运营与可观测性

PRD 原文位置：`docs/PRD-merchant-marketing-codex-final.md:862-876`。

| PRD 要求 | 状态 | 已核对证据 | 缺口/外部依赖 |
|---|---|---|---|
| 每请求携带 trace/workspace/task/attempt/platform/account | 部分完成 | API envelope 和 `trace_id/workspace_id` 已实现；发布/Job 结构含 job/attempt 相关字段 | 需确认所有生成、同步、导出、解析、回调路径均不丢字段，并提供完整链路样本 |
| 结构化记录安装、授权、同步、确认、生成、审核、发布、回执、导出和失败 | 已完成（代码/本地测试） | 业务事件、Outbox、任务时间线和审计表 | 需外部日志管道验证完整性、顺序、留存和脱敏 |
| 按平台的授权、刷新、同步、发布和任务漏斗 Dashboard | 部分完成 | `workspace.metrics`、Merchant Studio 指标和 Prometheus/OTel 模板 | 未发现已连接托管 Dashboard 的截图、查询链接或指标数据；当前不能证明运营可用 |
| MCP/API、平台错误、Token 刷新失败、游标停滞、unknown、存储失败、规则过期、IDOR、P0 漏检告警 | 部分完成 | `infra/observability/prometheus-alerts.example.yaml`、health/错误码、Runbook | 示例配置不是已启用告警；缺少真实触发、通知到达、升级和值班记录 |
| 试点排障 Runbook 和导出工具 | 部分完成 | `docs/production-ops-runbook.md`、导出 API | 未完成真实值班演练、回滚演练和权限验证 |
| 仅凭 task ID 重建时间线 | 已完成（本地验收） | timeline、事件和 task history API | 需在生产日志/队列/数据库跨系统关联一次 |
| 单个 adapter 可 Feature Flag 关闭且不影响查看/导出 | 已完成（代码/测试） | platform readiness/Feature Flag/读写分离门禁 | 需真实部署切换并确认流量、告警和 UI 状态 |

### FR-14 结论

运营“代码资产”已有，运营“可值班系统”未完成。不能把示例 OTel/Prometheus YAML、health API 或本地日志当作生产 Dashboard/告警验收。

## 6. FR-15 平台授权、同步与确认后发布

PRD 原文位置：`docs/PRD-merchant-marketing-codex-final.md:878-929`。

### 6.1 能力矩阵逐 profile 结论

当前项目按六个平台 profile 审理：京东、淘宝、天猫、拼多多、小红书、抖音；每个 profile 都必须分别验证 `authorize/read/full_sync/incremental_sync/create/update/query_status/revoke/media_upload`。旧 PRD 四 profile 要求保留为历史口径。

| Profile | 代码/fixture contract | 真实 OAuth/read | 真实 full/incremental sync | 真实 create/update/status/media | 真实 revoke | 当前判定 |
|---|---|---|---|---|---|---|
| 京东 | 已完成：adapter、签名/映射、fixture contract、preflight | 未提供真实 evidence | 未提供真实 evidence | 未提供真实 evidence | 未提供真实 evidence | 部分完成，生产能力关闭 |
| 淘宝 | 已完成：TOP adapter、签名/映射、fixture contract、preflight | 未提供真实 evidence | 未提供真实 evidence | 未提供真实 evidence | 未提供真实 evidence | 部分完成，生产能力关闭 |
| 天猫 | 已完成：独立 schema profile，复用 TOP 边界但保留 profile | 未提供真实 evidence | 未提供真实 evidence | 未提供真实 evidence | 未提供真实 evidence | 部分完成，生产能力关闭 |
| 拼多多 | 已完成：Router adapter、签名/映射、fixture contract、preflight | 未提供真实 evidence | 未提供真实 evidence | 未提供真实 evidence | 未提供真实 evidence | 部分完成，生产能力关闭 |
| 小红书 | 已完成：generic HTTP、媒体路径/映射和 readiness contract | 未提供真实 evidence | 未提供真实 evidence | 未提供真实 evidence | 未提供真实 evidence | 部分完成，生产能力关闭 |
| 抖音 | 已完成：generic HTTP、媒体路径/映射和 readiness contract | 未提供真实 evidence | 未提供真实 evidence | 未提供真实 evidence | 未提供真实 evidence | 部分完成，生产能力关闭 |

依据：`docs/platform-capability-preflight.md:5-16` 明确 fixture 只证明 contract，不证明官方 API；`docs/platform-capability-preflight.md:74-91` 明确 `production_canary` 必须有 application/store、scope、API 版本、evidence ref、验证人和真实配置。

### 6.2 授权

| 要求 | 状态 | 证据/判断 |
|---|---|---|
| 官方 OAuth、state、PKCE、单次消费、工作区/平台绑定 | 已完成（代码/测试） | OAuth 安全测试和 API E2E 已覆盖 |
| 加密 credential ref、Token 生命周期、撤权后停止同步/发布 | 部分完成 | Vault provider、撤权状态机和 fail-closed 已实现；真实 Vault、真实平台撤权未验收 |
| 授权后首轮同步、分页游标、失败重试 | 部分完成 | Sync Worker、Outbox、游标和本地重启恢复已实现；真实六平台长分页/限流/失败恢复未验收 |

### 6.3 发布与发布回执

| 要求 | 状态 | 证据/判断 |
|---|---|---|
| 发布前展示平台、店铺、商品、SKU、字段 diff、规则检查和影响 | 已完成（代码/本地验收） | `publish.prepare`、confirmation hash、remote snapshot hash、字段白名单 |
| 用户二次确认、幂等、同店同商品锁 | 已完成（代码/测试） | `publish.confirm`、幂等键、Redis lease lock、相关测试 |
| 写入后必须 query status；submitted/unknown 不得显示 published | 已完成（代码/测试） | `packages/workers/src/publish-adapter.ts`、`publish-observation.ts`；明确把不可验证结果降级为 unknown |
| 保存真实平台 request ID、商品 ID、受理/审核/成功/驳回/unknown 回执 | 部分完成 | 数据模型和回执投影已实现；fixture 只有 `submitted`/`simulated=true` |
| 真实创建/更新最终 published 并可导出 receipt | 未完成 | 当前没有真实平台成功回读证据；PRD 要求的真实 canary 尚未提供 |
| 状态未知后对账、修正、重试不重复写入 | 部分完成 | Reconcile Worker、unknown 状态和 lease/幂等实现存在；真实平台 timeout/重复回调/对账报告未提供 |

### FR-15 结论

平台代码可以进入“待真实接入”的工程 RC，但不能称为六个平台生产能力已完成。生产写开关必须保持关闭，直到每个平台的九项能力（含媒体上传）都存在同一 release 的 `production_canary` 证据。

## 7. 版本、发布回执和证据向量专项核对

### 7.1 当前已实现的版本向量

应用层已经能生成并导出以下字段：

`assetVersionIds`、`taskInputSnapshotId`、`ruleSnapshotId`、`mappingVersion`、`pluginVersion`、`skillBundleVersion`、`mcpVersion`、`connectorBuild`、`modelId`、`promptBundleVersion`、`createdBy`、`createdAt`、`reason`，并在版本恢复/修改时创建新向量。

证据：`packages/application/src/version-vector.test.ts:5-31`、`docs/implementation-status.md:31-34`。

### 7.2 仍未闭合的向量链

1. 已有 `scripts/release-manifest.ts` 可生成同一 release 的插件、Skill、MCP、bridge 文件摘要和版本向量；仍缺绑定最终部署镜像 digest、真实连接器/模型/prompt 版本以及真实 capability/capacity/payment evidence 的生产 manifest。
2. PRD 要求的平台远端快照和发布回执必须和内容版本绑定；当前代码有 hash/receipt 边界，但没有真实平台 published 样本。
3. 容量报告也必须绑定代码版本、配置版本、环境规格、脚本、数据集和 mock 比例；仓库现有容量样例明确是 `cloud_gate=false`，不能作为发布向量证据。

## 8. 50/500 容量核对

PRD 原文位置：`docs/PRD-merchant-marketing-codex-final.md:1030-1086、1200-1213、1363-1372、1472-1490`。

| 门槛 | PRD 目标 | 当前证据 | 判定 |
|---|---|---|---|
| Release 1 / 50 工作区 | 50 workspace、150 连接、30 RPS 持续、60 RPS 突发、50 作业突发、6h 稳定 | loopback/Compose HTTP smoke；实现状态文档明确 `cloudGate=false` | 未完成真实云验收 |
| 500 目标 | 500 workspace、750 连接、150 RPS 持续、300 RPS 突发、500 作业突发 | 容量脚本、合同测试、本地/Compose 结果；未见真实云原始报告 | 未完成 |
| 公平性 | 10 倍噪声租户，其余租户 P95 退化 ≤20% | Worker round-robin 和配额代码/单测 | 部分完成，缺真实负载证据 |
| 稳定性 | 6h，无内存增长、连接耗尽、队列不收敛 | 脚本和本地 runbook | 未完成真实云验收 |
| 故障恢复 | 滚动重启、Redis 短故障、连接池满、429、timeout | 本地故障/Redis/备份恢复测试 | 部分完成，缺同版本预发布原始报告 |
| 正确性 | 丢 Job、重复发布、跨 workspace 泄露为 0 | 单元/E2E/本地 smoke | 部分完成，真实平台和真实云未证实 |

直接证据：`docs/cloud-resources-and-deployment.md:224-245` 明确真实云模式、`cloudGate=true`、零 mock 和全阈值要求；`docs/capacity-evidence.example.json` 是示例，且 `cloud_gate=false`、`platform_mock_ratio=1`、`model_mock_ratio=1`。

## 9. 安全与生产验收核对

| 要求 | 状态 | 已核对证据 | 未完成项 |
|---|---|---|---|
| OAuth state/PKCE/replay/过期/绑定与生产首步店铺门禁 | 部分完成（代码/本地测试） | `apps/api/src/security.e2e.test.ts`、`packages/security/src/oauth.test.ts`、`apps/api/src/server.ts:requireStoreOnboarding`；无有效店铺时仅放行健康、授权、钱包和运营入口，业务 MCP 返回 `STORE_ONBOARDING_REQUIRED` | 真实平台 callback/verifier exchange、商家身份注册、宿主授权页和生产 canary 仍需外部验收 |
| 工作区隔离、RLS、IDOR | 已完成（代码/本地测试） | PostgreSQL RLS、quality/security E2E、workspace 条件 | 需真实云多租户压测和审计告警 |
| 恶意文件、路径穿越、大小/MIME/SHA 校验 | 已完成（代码/测试） | asset parse/security tests、对象存储 quarantine | 云扫描回调、真实 bucket 和下载权限未验收 |
| Secret 不出现在日志/响应 | 部分完成 | redaction helper、安全测试、OTel 示例处理器 | 需生产日志管道敏感 header 扫描 |
| Secret Store/Vault、KMS、轮换和应急撤销 | 部分完成 | Vault provider、生产配置 fail-closed | 真实 Secret Manager/Vault/KMS 配置和轮换演练缺失 |
| WAF、TLS、DNS、OAuth callback、出站 host allowlist | 部分完成 | Kubernetes/Ingress/配置模板和 readiness 检查 | 未提供生产域名/TLS/WAF 实际验证 |
| 备份、PITR、恢复 | 部分完成 | 本地 PostgreSQL backup/restore 通过且标记 `cloudGate=false` | 托管 PostgreSQL PITR/KMS 恢复演练缺失 |
| 数据地域、留存、模型供应商、商家协议 | 外部依赖/未完成 | PRD 将其列为 Day 0/上线门禁 | 法务、安全和供应商书面批准未见证据 |

## 10. 验收矩阵与阻断项

### 已具备的本地/代码级验收

- Plugin manifest、MCP bridge、schema 和安装 smoke。
- FR-11 的版本、diff、恢复、乐观锁、版本向量单测/HTTP 验收。
- FR-12 的 Markdown/JSON/ZIP、manifest、source map 和无虚假 receipt。
- FR-13 的历史、时间线、反馈、克隆、停用/恢复。
- FR-14 的 envelope、事件、health、指标、告警模板和 Runbook 资产。
- FR-15 的六平台 connector contract、fixture、签名/映射、OAuth 安全、同步/发布 Worker 和 fail-closed 门禁。
- 本地 PostgreSQL/Redis/Compose、备份恢复、Redis loss recovery、loopback/Compose 容量和安全测试。

### 当前必须关闭的阻断项

1. 六平台真实 capability evidence：每个平台的九项能力（含媒体上传）达到 `production_canary`，且 evidence 非占位、绑定 release、应用/店铺/scope/API 版本/验证人/时间齐全。
2. 真实平台发布回执：至少每个 profile 一次低风险商品创建或更新、状态查询最终收敛、request ID/remote ID/审计/导出包完整；撤销后同步和发布必须阻断。
3. 50 家真实预发布容量：同一 RC、配置、数据集和环境，`cloud_gate=true`，满足 30/60 RPS、50 作业突发、噪声租户、6 小时稳定性和 0 丢 Job/重复发布/跨租户泄露。
4. 500 家目标容量：进入 500 波次前重新执行 150/300 RPS、500 作业突发、750 连接和 6 小时稳定性；不能用 50 家报告替代。
5. 生产运维落地：托管 PostgreSQL/Redis、对象存储、Secret Store/KMS、WAF/TLS/DNS、OTel/告警、值班联系人、回滚和 kill switch 实演。
6. 生产版本向量：发布 manifest、镜像 digest、Plugin/Skill/MCP、connector build、规则/映射、模型/prompt、远端快照和 receipt 可相互关联。
7. 过期价格导出阻断、对象存储下载失败重试、真实平台 timeout/unknown/对账的原始验收证据。

## 11. 建议的下一步验收顺序

1. 先冻结 RC release ID、配置版本、镜像 digest、Skill/MCP/connector/model/prompt 版本。
2. 为六个平台准备真实应用、测试店铺、回调域名、scope、Vault 引用和一次性 disposable canary 账号。
3. 按 `docs/platform-capability-preflight.md` 逐 profile 跑 authorize/read/full_sync/incremental/create/update/query_status/revoke，并保存非敏感原始 evidence。
4. 在同一预发布 release 上跑 50 capacity gate；通过后才允许小范围真实商家试点。
5. 用同一套目标配置按 100→250→500 波次重复容量门禁，单独签署每一波。
6. 接通托管 OTel/告警和值班联系人后，执行一次撤权、429、unknown、Redis 故障、回滚和恢复演练。
7. 复核交付包：用真实 published 回执生成 `publish-receipt.json`，再从 ZIP 反向还原完整版本向量。

## 12. 证据边界

本报告没有修改业务代码，也没有把本地测试、fixture、loopback 或 Compose 结果升级为生产完成。现有交付文档本身也明确指出真实平台 canary、真实云容量、托管基础设施和运维实操仍需外部完成：`docs/release-handoff-0.1.0.md:15-34`、`docs/platform-capability-preflight.md:16,72,91`、`docs/cloud-resources-and-deployment.md:224-245`。
