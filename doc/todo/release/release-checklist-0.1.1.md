# Release checklist — 0.1.1

日期：2026-08-29

> 2026-08-31 Worker 证据增量：worker HMAC 成功校验现在写入统一结构化请求终态日志，记录角色、current/rotation 槽位、工作区/路由、proof 时间、body/nonce 摘要和校验时间，不记录任何凭证、签名、原始 nonce 或正文。真实 Compose 仅滚动双 API、保留五类 worker 原进程后，automation worker 对新 API 请求返回 200 并产生无敏感值证据；定向回归 73/73、release gates 355 passed / 7 skipped。ClamAV/scan worker 既有 unhealthy 及正式日志留存/告警、托管 Secret 轮换、production canary 仍是 NO-GO 阻断。

> 2026-08-31 本轮发布门禁复核：根全量回归 381 个文件通过、17 个跳过，2484 项通过、31 个跳过；release-gates 68 个文件（67 通过、1 跳过），360 项通过、7 个跳过；TypeScript、插件镜像一致性、MCP/OpenAPI、迁移与配置门禁通过。跳过项和真实 OIDC、生产 RLS、Provider/账务、对象存储恢复、正式 ChatGPT Host、跨副本故障注入及 canary 证据仍不能被视为生产通过，当前发布结论保持 NO-GO。

> 2026-08-31 Worker 凭证增量：生产 API 改为 `WORKER_API_CREDENTIALS` 角色映射，五类 worker 分别引用独立 Secret key；请求证明覆盖角色、method、target、workspace、body digest、timestamp 与 nonce。release-sim/生产配置/Kubernetes validator 会拒绝共享 key、缺少任一角色或超过两套轮换凭证。完整 release gates 66 个文件通过、1 个跳过（355 项通过、7 项跳过），infra validation、TypeScript、本地双 API 与五类 worker 健康检查通过。该结果不替代真实 Secret Manager 轮换、正式集群和 production canary，生产仍为 NO-GO。

> 2026-08-31 UI 控制面增量：Ops Console 功能开关编辑器已对 canonical 商品链切读值显示前置条件和恢复提示；生产服务端仍强制要求正式 `canonical-cutover-evidence`。Ops Console 61 个测试文件、277 项通过，release gates 57 个文件通过、1 个跳过（324 项通过、6 项跳过）；该增量不解除真实 workspace shadow、回滚、宿主和生产资源证据门禁。

> 2026-08-31 增量：MCP 当前权威基线已更新为 247；OpenAPI `McpRequest.method` 枚举已同步图片审计、计费审计和 durable authorization 方法。历史测试数字仅代表当时工作树，当前结果必须以 Repository `0.1.1`、plugin `0.1.0+codex.20260831125200` 和同一冻结提交重新执行；仓库代码级 gate 通过也不解除真实生产资源、Provider、平台、支付、OIDC 和正式 ChatGPT 宿主证据门禁。

> 2026-08-31 增量：OpenAPI `x-method-schema-refs` 已为上述 3 个图片审计方法补齐 fail-closed 参数 schema，并加入 OpenAPI 契约测试；定向契约回归 17/17、完整 release gate 55/55 文件通过（1 个跳过）。

> 2026-08-31 增量：核心 `ops.marketing.image.reconcile` 也已补齐 OpenAPI 参数 schema 与 schema 引用，包含完成/失败、证据引用、理由、幂等键和 revision 约束；定向契约回归 17/17、完整 release gate 55 个测试文件通过、1 个跳过。

> 2026-08-31 增量：图片任务 `GET /v1/image-generation-jobs` 与 `GET /v1/image-generation-jobs/{jobId}` 已补入 OpenAPI 路由文档，包含 workspace scope、分页/状态过滤、门禁和 fail-closed 响应说明；OpenAPI/API surface/server E2E 定向回归 57/57，完整 release gate 55 个测试文件通过、1 个跳过。
结论：**生产 NO-GO。当前可执行基线为 Repository `0.1.1`、plugin `0.1.0+codex.20260831125200`、247 个 MCP 方法、148 个桌面 ChatGPT 商家工具、13 个 Ops 一级域和迁移 001–106。真实 PostgreSQL fresh/upgrade/RLS、平台、支付、模型中转、云资源和正式桌面宿主证据仍未闭环。**

范围：商家端仅为桌面 ChatGPT 插件，运营端仅为桌面后台。手机和平板不在需求、验收和上线阻断范围；Merchant Studio 仅用于开发调试。

## 权威 release metadata

| 项目 | 当前值 | 仓库证据 |
|---|---:|---|
| Repository version | `0.1.1` | `VERSION`、根 `package.json`、`package-lock.json`、`CHANGELOG.md` |
| Plugin build | `0.1.0+codex.20260831125200` | source 与 marketplace 的 package/manifest |
| Git revision | 生成 release manifest 时读取完整 `HEAD` | `components.releaseGitSha`，gate 拒绝与当前 `HEAD` 不一致 |
| MCP methods | 247 | `packages/contracts/src/mcp.ts`，由 metadata/manifest gate 动态读取 |
| Merchant bridge tools | 148 | source/marketplace bridge 运行态 `tools/list` 测试 |
| Ops 一级域 | 13 | Ops 导航/契约测试 |
| PostgreSQL migrations | 001–106，连续 106 个；079 为知识快照，080 为 workspace 存储配额，081 为 reconciliation status，091 为平台作用域与 `merchant_ops` 角色绑定，092–097 为图片执行租约、对账证据与运行时权限收敛，098 为 canonical unified link audit，099 为 canonical→legacy 品牌复合完整性约束，100 为告警通知投递账本，101 为 canonical backfill 批次状态，102 为 canonical backfill 人工冲突队列，103 为告警通知账本的应用角色 ACL，104 为一次性交互确认票据及最小权限消费约束，105 为 durable authorization grants（持久化授权授予/撤销、JIT 时效与次数预算及双人写审批约束），106 为 NULL 品牌映射 fail-closed 完整性守卫 | metadata/runner gate 必须在 release 冻结后检查物理文件、注册顺序与链尾 |

`release-metadata.json` 是机器可读的规模声明；`npm run release:metadata:validate` 将它与源码、版本、CHANGELOG、插件镜像和迁移文件逐项对账。release manifest 还将 `VERSION`、`CHANGELOG.md`、`release-metadata.json`、Git SHA、插件、OpenAPI 和 MCP 注册表纳入哈希绑定。

## 仓库内发布门禁

| 门禁 | 命令 | 本轮证据 |
|---|---|---|
| Metadata 一致性 | `npm run release:metadata:validate` | 权威值应为 Repository `0.1.1`、plugin `0.1.0+codex.20260831125200`、MCP 247、商家工具 148、Ops 一级域 13、迁移链尾 106；仍必须在干净 release commit 上重跑 |
| Metadata/manifest | `npm run release:metadata:validate` | 通过；版本、CHANGELOG 入口、plugin mirror、MCP 注册表和迁移链对齐，退出码 0 |
| TypeScript | `npm run typecheck` | 本机本轮通过，退出码 0；仍需在冻结 release commit 的 CI artifact 中复核 |
| Release/backup/fault gates | `npm run test:release-gates` | 当前 release suite 必须显式包含 migration 078–106、migration integrity、bridge/marketplace、Ops、source artifact、供应链和 fault acceptance；执行结果以同一冻结提交的 CI artifact 为准。该结果不是生产证据，真实 PostgreSQL verifier 即使在本机 Compose 通过，也不等同生产证据 |
| Ops Console workspace tests | `npm run test:ops-console` | 本轮未重新执行；历史结果不绑定当前冻结提交，需在干净 CI checkout 重跑 |
| Package build | `npm run build --workspace @merchant-marketing/persistence` | 迁移 106 发布基线须在冻结提交上重新构建并核对 `dist/migrations` |
| UI production build | `npm run build:ops-console`、`npm run build:merchant-studio` | 本轮未重新执行；需在干净 CI checkout 重跑并绑定构建 artifact digest |
| Migration runner/chain 定向测试 | metadata gate + migration 079–106 + migration integrity + operations scripts | 2026-08-31 相关套件 11 个文件通过，33 项通过、3 项跳过；当前 runner 链尾为 106，103 ACL、104 交互确认票据、105 durable authorization grants、106 品牌完整性 fail-closed guard 的静态契约均通过。真实 PostgreSQL RLS、历史脏数据治理、durable grant 撤销/预算/审批必须在授权 CI 数据库中补跑，本机结果不能算生产证据 |
| Infra static validation | `npm run infra:validate` | 2026-08-31 本轮通过，退出码 0；capability/capacity 示例仅为 fixture schema，不是生产证据，仍需在冻结提交上重跑 |
| CodeGraph | `codegraph sync .`、`codegraph status .` | 本次观察到约 697 files、10,176 nodes、42,302 edges；共享工作树在检查期间持续变化，CodeGraph 数字仅为命令执行时快照，必须在冻结 release commit 上重新同步并绑定 affected tests |
| 集成冲突 | `git ls-files -u` + 当前文本文件冲突标记扫描 | unmerged index 0、冲突标记文件 0 |
| 工作树可发布性 | `git status --short` | 共享工作树存在大量未提交状态（本次检查超过 1,100 条）；HEAD `7b2c0addec3f87a104e8378b1fc6cd13cca99f5d`，不满足干净、可复现、可签署 release 条件 |
| Release notes 覆盖 | `CHANGELOG.md` 0.1.1 与当前工作树对照 | 版本号与迁移 079–106 摘要已同步；冻结 release 前仍须与最终 application/UI/infra diff 逐项对账，未冻结工作树不得视为完整 release notes |
| Diff hygiene | `git diff --check` | 通过；退出码 0 |
| Fresh/upgrade PostgreSQL | CI 的 PostgreSQL service + 显式数据库测试 | 当前 release 必须验证 001→105 fresh、现网前序链尾→105 upgrade、幂等、并发配额、reconciliation 幂等、104 全局 nonce 唯一性/一次性消费、105 durable grant 撤销/预算/审批约束和跨工作区 RLS；本机 Compose PostgreSQL 结果只能作为本地验收，仍需同一正式 CI artifact 证据 |

根 `npm run check` 现包含 TypeScript、根测试、Ops Console workspace 测试、metadata gate 和两套 UI build。历史回归数字不绑定当前未冻结工作树，不能作为当前发布证据；迁移 104/105 的真实 PostgreSQL 用例必须在带 `PERSISTENCE_RELEASE_DATABASE_URL` 的 CI 中补跑。跳过项、fixture、mock、示例 evidence 或负向拒绝都不得登记为外部生产成功；仍须在干净 release commit 上由完整 CI 覆盖。

### 2026-08-31 当前增量：图片安全重试后的发布元数据同步

- 新增 `catalog.image.retry` 后，已同步 release metadata 的 MCP 与商家 bridge 计数，并将迁移链尾对齐到当前 109；`npm run release:metadata:validate` 通过。
- `tests/operations-scripts.test.ts` 26/26 通过，证明 manifest 构建不会接受过期的方法数或迁移链尾。
- 该项只关闭本地发布元数据一致性缺口；工作树仍未冻结，真实 PostgreSQL/RLS、生产签名 artifact、Provider/平台/支付和正式宿主证据仍缺，生产结论继续 `NO-GO`。

## 仍需同一正式 release 的外部证据

### Codex App 对话体验门禁（当前 NO-GO）

以下证据必须绑定同一冻结 release、真实桌面 ChatGPT 宿主和真实身份；本地 Merchant Studio、mock MCP、fixture 数据或静态字符串测试不能替代：

| 门禁 | 必须观察到的证据 |
|---|---|
| 首次进入与单步导航 | 首轮欢迎、当前状态和唯一下一步清晰；商家不需要工具名、ID、JSON；每轮只有一个主产物卡和一个 CTA |
| 真实任务创建失败 | 注入/观察 500、超时和断连时不保留幽灵成功、不重复扣费/建任务，并明确“是否落库未知”及恢复入口 |
| 商品与店铺范围 | 首页、商品页和任务页的真实店铺口径一致；仅展示可操作商品，平台和店铺范围不可静默漂移 |
| 阻断与恢复 | 余额、权限、素材、规则、模型中转缺失均 fail-closed；任务可恢复且不重复生成/发布 |
| 交付与发布 | 生成结果可审阅、批准和发布确认分离；发布状态可回读，未知状态不得声称成功 |
| 附件与 Automations | 图片/文档错误有可恢复卡；原生 Automations 仅按只读协议运行，宿主缺失时不自建替代调度器 |
| 宿主质量 | OAuth、真实 MCP tools/list、真实 relay 鉴权/用量/成本证据、零 console/network errors，且有截图、请求 ID、时间和 release SHA |

任一项缺证据即维持 NO-GO；当前上述真实宿主证据尚未闭环。

- 六个平台真实 OAuth、scope、读写、媒体上传、状态回读、撤销与限流 canary。
- 真实支付充值/回调/对账/退款闭环，以及生产模型中转的账单与回执。
- 托管 PostgreSQL/Redis、对象存储、KMS、PITR、真实备份恢复和 RPO/RTO 证据。
- 不可变 API/Worker/UI/Ops UI 镜像 digest、供应链 provenance，以及最终部署 manifest。
- 生产 trust anchor、原子 nonce consumer、capability attester、签名 production evidence、known-good rollback bundle 和 backup attestation 的真实控制面配置及演练记录。
- 正式环境 `/releasez`、认证业务路径、跨租户探针、容量波次、长稳、故障注入、告警和值守签署。
- 桌面 ChatGPT 真实宿主已完成本地 fixture 四项只读验收：`merchant.start`、`workspace.health`、`catalog.search`、`billing.status` 均通过；仍缺绑定同一正式 release、真实身份、真实平台/支付数据且 console/network errors 为 0 的生产宿主证据。手机和平板不在范围。

## 2026-08-31 当前复核增量

- 发布执行门禁新增 action-time canonical scope recheck：`execution-check` 和媒体读取在返回凭证/媒体前重新验证当前 canonical 商品、facts、唯一 listing 及读取模式，worker 非 2xx 时不会调用 connector；API E2E 53/53、application 109/109、typecheck 通过。真实平台、生产 RLS、正式 ChatGPT 宿主和 canary 证据仍缺失，生产继续 NO-GO。
- 任务派生门禁新增 action-time canonical scope recheck：`task.sku.split` 与同商品/平台/店铺 `task.clone` 在落库前重新校验当前标准链，避免旧任务 scope 复制到新任务；API 相关回归 74/74、typecheck 通过。该证据仍不替代真实 workspace、生产 RLS 和 canary。
- 图片归档一致性门禁新增 receipt digest 内容重算，合法 64 位 digest 但与当前 asset/job/object metadata 不一致时返回 `ARCHIVE_RECEIPT_DIGEST_MISMATCH`；feature-gap 回归 22/22、typecheck 通过。真实对象存储和归档恢复证据仍缺失，生产继续 NO-GO。
- 图片账务审计新增逐 usage cost/customer charge 与 Provider request ID 一致性门禁，并校验 action ledger request ID；API/模型结算相关回归 88/88、typecheck 通过。真实 relay usage/cost、钱包和供应商账单对账仍缺失，生产继续 NO-GO。

- Canonical read 已接入 `publish.prepare` 与 `publish.batch.prepare` 的动作前 scope 复核，历史任务不能绕过当前 canonical product/facts/listing 校验进入发布预览；API 定向回归 57/57、TypeScript、差异检查和 CodeGraph 通过。真实平台写入/回读与生产 canary 仍缺失。

- Canonical read 已覆盖 `task.create`：唯一 canonical product、facts 和 listing 成为任务 scope 前置条件，缺失时 409 fail-closed；API/application 定向回归 57/57、TypeScript、差异检查和 CodeGraph 通过。批量任务/发布准备及真实生产切读证据仍缺失。

- 图片 reconciliation 已补齐 durable `next_attempt_at`：最新 evidence 决定冷却窗口，API 不会在窗口内重复下发 Provider 查询，Worker 对 processing/unknown 发送有界指数退避。API/Worker/Persistence 定向测试 75/75、TypeScript、差异检查和 CodeGraph 通过；真实 Provider、对象存储/计费和多副本并发证据仍是 NO-GO 门禁。
- 双 API 副本真实 Compose smoke 已复验通过：`local-api:8787` 写入隔离商品和任务，`api-replica:8788` 通过共享 PostgreSQL/Redis 读取同一 workspace/product/task；同时修正验收脚本以解析持久化模式分页商品响应。该证据只覆盖跨实例持久化读取，不替代 API 重启后的图片回调、Provider、RLS 故障注入或生产 canary，发布仍为 NO-GO。

- 图片 reconciliation Worker 已修复 evidence 请求缺少 `idempotency_key` 的协议断裂：幂等键绑定 `job_id + execution_attempt + query_attempt + provider_request_id`，并将真实 query attempt 透传到 API；Worker 43/43 定向测试、TypeScript、差异检查通过。该项不替代真实 Provider、durable backoff、对象存储/计费和生产并发证据。

- Canonical facts 增量已通过定向回归：`canonical_products.facts` 已接入 canonical product 的 Memory/Postgres 读写和 `catalog.title.optimize` 生成上下文；`canonical_read` 下缺失 facts fail-closed，返回 `CANONICAL_PRODUCT_FACTS_REQUIRED`。API/application/persistence/server 定向测试 71 项通过，`npm run typecheck`、`git diff --check` 通过；本地 Compose 全部服务 healthy。该结果不解除真实生产 RLS、历史数据切换、relay/provider 和正式 ChatGPT 宿主门禁。
- CodeGraph 状态快照为 779 files / 10,882 nodes / 40,524 edges；共享工作树仍有 pending changes，因此不宣称满足干净 release 条件。

- `catalog.title.optimize` 的 canonical read scope 门禁定向测试 36 项通过；release gates `56` 个文件通过、`1` 个跳过，`320` 项通过、`6` 个跳过；metadata gate、typecheck、CodeGraph 和 `git diff --check` 通过。
- 使用项目既有 `scripts/ensure-local-scanner-key.sh` 与 `docker compose --env-file .env` 重建本地链路后，API/UI/Postgres/Redis/ClamAV 与 6 个 Worker 全部 healthy；扫描 heartbeat 报告 database/api/redis/clamav/callback 均 ready，EICAR 通过。
- 以上仅是本地 Compose 证据，不替代生产密钥、云平台、正式 ChatGPT 宿主和外部 canary；生产继续 NO-GO，未迁移到 `doc/done`。

## 发布判定

### 2026-08-31 当前工作树复核

- 根 `npm run check` 通过：332 个测试文件通过、15 个跳过，2187 项通过、28 项跳过；Ops Console 61 个测试文件、275 项通过；`release:metadata:validate` 通过；Ops Console 与 Merchant Studio 生产构建通过。
- 图片任务终态 busy 状态修复已包含在本轮 Merchant Studio 构建与定向测试中；本地 Compose 核心容器保持 healthy，未携带 Bearer 的图片任务 API 返回 401 `UNAUTHENTICATED`，符合生产鉴权 fail-closed。
- 该工作树仍存在大量用户未提交变更；上述结果是当前本地快照，不是干净 release commit、真实生产 PostgreSQL/RLS、真实 Provider/支付/对象存储或正式 ChatGPT 宿主证据。生产判定继续为 **NO-GO**。

仓库代码已具备对版本、迁移、release artifacts 和外部 evidence 结构的 fail-closed 校验；本轮修正了 metadata 与 runner 链尾 081 的漂移，CI 已接入 PostgreSQL service 与 079/080/081 验收路径，但本轮没有对应 CI artifact，且本机 Compose/fixture 结果均不代表生产。当前共享 `main` 工作树未冻结为可复现 release，云对象存储/KMS/PITR、模型 relay、平台写入、支付和 Codex App 宿主证据仍未绑定同一 release，因此不能批准生产写流量。桌面 ChatGPT 本地 fixture 四项全绿不能解除生产 NO-GO。最终 GO 必须在干净 release commit 上完整 CI 通过后，由 Release、Security、SRE、Platform、Finance 和 QA 对上述真实 artifacts 共同签署。
> 2026-08-31 Compose worker 镜像刷新：发现 worker 镜像仍携带 migration 108 运行时，数据库已进入 109 后 6 类 worker 全部因 schema mismatch unhealthy。重建 `infra/docker/worker.Dockerfile` 并重启六类 worker 后，automation/generation/publish/reconcile/sync 已恢复 healthy；scan worker 的 database/API/Redis/ClamAV/回调能力均通过，但因当前队列存在 1 条 dead-letter 按 fail-closed 策略仍保持未就绪。未删除或清理业务数据；需通过 migration-109 redrive/人工处置后再重新验证 scanner readiness。该证据仅为本地 Compose，不解除真实生产 NO-GO。
同步证据（2026-08-31）：API/replica 已刷新到当前源码，真实 MCP `ops.marketing.asset_scan.retry` 已成功完成 JIT 授权、隔离对象绑定、旧死信保留和 `asset.scan_redrive_requested` 入队（asset revision 2→3，仍为 quarantined）。随后发现本地 Compose API 缺少 `scan` worker credential，导致该历史恢复事件以 `worker internal authorization required` 拒绝；已补齐 `WORKER_API_CREDENTIALS.scan`。使用全新、非去重隔离素材重新验证后，真实 scan worker 日志显示 `restored=1, processed=1, succeeded=1, deadLetter=0`，数据库记录 `asset.scan_promoted`、扫描回执和 callback `accepted`，素材已进入 clean。扫描消费闭环本地证据已补齐；生产 Secret Manager、正式集群、canary 和外部平台证据仍使本发布项 NO-GO，不能迁移到 `doc/done`。
