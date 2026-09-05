# 项目全流程扫描报表

扫描日期：2026-09-02  
扫描范围：ChatGPT 插件入口、MCP/API、模型中转、商家工作流、运营后台、持久化、worker、基础设施和发布门禁。

## 结论

当前不能判定为可上线。核心业务代码已有较完整的 fail-closed 和本地 fixture 验证，但真实生产依赖和全量行为回归仍未闭环。`TODO` 文件数量不能直接代表未完成任务：其中一部分是已实现后的历史验收记录，另一部分是必须在真实环境执行的上线证据要求。

## 量化盘点

| 项目 | 当前结果 | 判定 |
|---|---:|---|
| `doc/todo` 文件 | 94 | 含本报表；原有盘点范围为 93 |
| `doc/todo` Markdown 文件 | 77 | 需要逐项归档或保留阻断说明 |
| 含 `TODO/NO-GO/未完成/待实现/阻断` 的 `doc/todo` 文件 | 75 | 不能等同于 75 个代码缺陷 |
| CodeGraph 文件节点 | 1,107 | 已同步 |
| CodeGraph 节点/边 | 15,785 / 59,541 | 可用于影响面追踪 |
| CodeGraph 待同步变更 | 0（本次同步后） | 当前索引已更新 |

## P0：上线阻断项

这些项目必须有真实环境证据，不能用静态实现或 fixture 代替。

| 阻断项 | 证据/影响 | 完成条件 |
|---|---|---|
| 生产配置未渲染 | `npm run infra:production-gate` 失败：缺少 `PRODUCTION_CONFIG_PATH` 或参数 | 提供受控的生产配置，完成配置门禁并保留脱敏证据 |
| 模型中转未配置 | `npm run codex:relay:validate` 失败：缺少 `model_provider`、`base_url`、`wire_api=responses`、`env_key` | 配置真实 relay，完成鉴权、Responses 请求、用量、成本和错误回执验证 |
| 真实平台授权链路未验收 | 六平台 OAuth/回调/刷新/重新授权仍缺真实 canary 证据 | 每个平台完成授权、回调、失效、重授权和租户隔离验收 |
| 真实 ChatGPT 宿主链路未验收 | 插件入口到 MCP/API 的真实宿主/OIDC 证据不足 | 在真实 ChatGPT 工作流中验证 manifest、鉴权、MCP 契约和错误呈现 |
| 生产数据库/RLS/容量未闭环 | 目前主要是本地或测试数据库证据 | 使用生产级 Postgres 验证迁移、RLS、并发、连接池、备份恢复和回滚 |
| 对象存储与密钥托管未闭环 | S3 兼容存储接口存在，但真实 KMS、生命周期、隔离和恢复证据不足 | 完成 quarantine/clean、扫描证据、KMS、生命周期和恢复验收 |
| 支付、退款、对账未闭环 | 本地商业 fixture 不能证明支付供应商回调和资金一致性 | 以沙箱/生产等价环境验证充值、扣费、退款、幂等、对账和异常补偿 |
| 发布门禁/制品信任未闭环 | 缺真实签名制品、部署、canary、回滚证据 | 完成签名、来源清单、部署、canary、告警和可恢复回滚 |

## P1：实现或行为回归缺口

| 区域 | 当前问题 | 风险 |
|---|---|---|
| 商业化 charged 方法 | 正常测试环境仍按生产策略拒绝部分模型/图像/视频/内容生成方法；多个旧 e2e 仍期待成功 | 测试语义与生产策略不一致，容易掩盖真实不可用或错误放行 |
| 账务与模型结算 | 已补充部分 AOF/旧 RMB provider 结算、退款和预算释放逻辑，但 provider 失败、重复回执和真实成本证据仍需端到端验证 | 超扣、漏扣、预算锁死或成本不可审计 |
| 规则生成链路 | 本地规则成功路径与 charged 模型禁用路径混在同一批测试中 | 无法清晰区分产品阻断和测试 fixture 问题 |
| 商家首价值路径 | 明确产品选择后仍可能先收到平台账户重新授权错误，而非统一 onboarding 引导 | 首次用户无法得到稳定、可操作的下一步 |
| 工作区引导接口 | CodeGraph 显示 `WorkspaceBootstrapInput` 在关键实现处缺覆盖测试 | 租户初始化、重试和并发下可能出现状态不一致 |
| MCP 契约 | `McpMethodContract` 等关键类型的直接覆盖不足，虽有基础 `mcp.test.ts` | 宿主请求形状变化时可能出现静默兼容问题 |

## P1：测试与证据缺口

CodeGraph 对以下关键接口标记为无覆盖或覆盖不足：

- `packages/ai/src/provider-usage-log.ts` 的 provider 用量分页、解析和 statement。
- `RelayUsageContext` 及其在图像、视频、事实提取链路中的调用。
- `PlatformAuthorizationAudit` 输入、结果和持久化边界。
- `S3CompatibleObjectStorageConfig`、`ObjectMetadata` 和对象分区安全边界。

已知最近一次全量 `npm test` 仍有约 83 个失败，主要集中在支付/充值/订阅/退款、charged 内容和多模态生成、Codex commit、规则生成及若干状态顺序断言。不能用单独通过的 release-gates、typecheck 或 50 工作区 fixture smoke 替代全量通过。

## 已有正向证据

- `npm run typecheck` 最近一次通过。
- `npm run test:release-gates` 最近一次通过：112 个文件通过、3 个跳过；521 个测试通过、9 个跳过。
- 品牌提取、MCP/HTTP parity、模型预算、四平台授权相关的定向测试已通过。
- 明确启用 `CONNECTOR_FIXTURE_MODE=true` 和 `MERCHANT_TEST_APPROVED_RATES=true` 的 50 工作区 HTTP smoke 通过：400 请求、100 个重复发布请求、50 个唯一发布任务、0 错误。
- 当前 Docker 必需服务健康，worker-generation 最近检查记录为成功；本地 Docker 合约测试曾单独通过。

## 处理优先级

1. 先补齐生产配置和 relay 配置，执行真实 relay canary，形成可审计证据。
2. 将 charged 能力测试拆成“生产拒绝契约”和“显式批准费率 fixture/真实 provider 成功路径”，清理全量回归失败。
3. 补齐工作区引导、MCP 契约、用量日志、relay usage、授权审计、对象存储的直接测试。
4. 在真实 Postgres/RLS、对象存储/KMS、支付沙箱、平台 OAuth 和 ChatGPT 宿主环境执行全流程验收。
5. 只有 `npm test`、前端运营后台浏览器验收、worker/容器健康、备份恢复、容量、canary、发布和回滚证据全部通过后，才可把对应 TODO 归档为完成。

## 当前上线判定

**NO-GO。** 代码质量门禁已有通过项，但生产配置、模型 relay、真实外部链路和全量测试仍是硬阻断；不应把 fixture smoke 或静态 TODO 清理当作上线证据。

## 本轮追加回归证据

- CodeGraph 同步后：1,107 文件、15,785 节点、59,541 条边。
- 最近一次全量 `npm test`：`19 failed / 592 passed / 42 skipped` 文件，`19 failed` 测试项；错误注入日志不计为产品通过证据。
- 随后定向修复后的 `server.e2e`：`15 failed / 45 passed`，说明失败面已收敛但尚未清零。
- 最近一次 `npm run typecheck`：通过。
- 当前不能调用“全功能测试通过”或“可上线”；仍需继续修复并重新执行全量测试、运营后台桌面浏览器验收和真实依赖门禁。
- 追加定向回归：`server.e2e` 当前 `7 failed / 53 passed`；较上一轮 `15 failed / 45 passed` 已进一步收敛。
- 追加类型检查：`npm run typecheck` 通过。

## 2026-09-02 22:40 增量回归

### 本轮已完成

- `apps/api/src/server.e2e.test.ts`: `60/60` 通过。
- `npm run typecheck`: 通过。
- `packages/application/src/commercial-side-effect-matrix.test.ts`: 通过。
- `apps/api/src/platform-governance-integration.e2e.test.ts`: 通过。
- 商业测试夹具保持生产注册表 fail-closed；仅显式测试请求使用 fixture registry。
- `billing.status` 恢复旧客户端兼容字段 `model_access`、`action_entitlement`、`capability_entitlements`、`plugin_access.unlocks`、`action_cards`。
- `delivery.bundle.verify` 先执行租户边界检查，再解析 manifest/files。
- CodeGraph 增量同步：`28 changed files`, `637 nodes`。

### 当前未通过

- `apps/api/src/review-decisions.e2e.test.ts`: REST review 响应仍未返回 `DUPLICATE_IMAGE`，P2 waiver 流程无法继续；需继续追查请求前商品/快照图片引用的 hydration 覆盖。
- 全量测试最后一次：`3971 passed / 3 failed / 42 skipped`，上述 review failure 仍在；另有 `1 unhandled error`，Postgres 测试连接收到管理员终止 `57P01`，不能视为代码通过。
- 上述结果不是上线通过证据。

### 上线阻断（外部运行环境）

- `npm run infra:production-gate`: 缺失 `PRODUCTION_CONFIG_PATH`。
- `npm run codex:relay:validate`: 缺失真实 `model_provider`、relay base URL、`wire_api=responses`、`env_key`。
- 尚无真实平台 OAuth/canary、支付 provider callback/refund/reconciliation、云对象存储/KMS/PITR、生产 Postgres/RLS/capacity、ChatGPT host/OIDC、签名 artifact/trust/rollback 证据。

## 2026-09-02 23:05 最终回归记录

- 核心定向回归：`179/179` 通过。
- API/security/server 关键回归：`133/133` 通过。
- Docker runtime contract 串行复验：`5/5` 通过；`local-worker-generation-1` 当前 healthy，最近 5 次 health check 均 `exit=0`。
- 最近一次全量并行回归：`3974 passed / 1 failed / 42 skipped`；唯一失败是 worker-generation 在并行运行期间的瞬时 health-log 非零退出，随后独立串行复验通过，故全量并行结果仍不能标记为无条件全绿。
- CodeGraph 最后同步：`5 changed files`, `337 nodes`。
- 生产门禁仍未通过：`infra:production-gate` 缺 `PRODUCTION_CONFIG_PATH`；`codex:relay:validate` 缺 `model_provider`、relay `base_url`、`wire_api=responses`、环境变量名形式的 `env_key`。

## 最终扫描基线

- `doc/todo` 当前包含 marker 的 Markdown 文件：`72` 个。
- 当前 marker 总数：`940` 个；这些包含历史说明、NO-GO 证据和待外部配置项，不能简单按数量等同于未开发功能。
- CodeGraph 当前索引：`1,131 files / 15,806 nodes / 59,577 edges`。
- 代码与测试没有伪造生产配置；生产门禁在真实配置缺失时保持 fail-closed。

## 最终全量回归（23:13）

- 全量 `npm test`：`596 test files passed / 42 skipped`。
- 全量测试：`3975 passed / 64 skipped`，无失败、无 unhandled error。
- `npm run typecheck`：通过。
- Docker runtime contract：`5/5` 通过；稳定健康等待逻辑保留真实 Docker health evidence，持续故障仍会失败。
- CodeGraph 已在最终源码变更后重新同步。

### 结论

代码与本地/容器测试达到当前仓库验收标准；生产上线门禁仍未通过，原因是缺少真实部署环境输入，不得以 fixture 或示例配置替代：`PRODUCTION_CONFIG_PATH`、生产 Postgres/RLS、真实五模态 relay 鉴权与 usage/cost、平台 OAuth/canary、支付 provider、云对象存储/KMS/PITR、ChatGPT host/OIDC、签名 artifact/trust/rollback 证据。

## 2026-09-02 增量基础设施验收

- `sh infra/scripts/validate-config.sh`: 通过。
- 已验证 YAML、Docker Compose 配置、全部 shell 语法、Kubernetes base/pilot manifests、能力证据 schema、容量证据 schema。
- 能力与容量证据文件的输出明确为 `fixture/non-production validation only`，未被错误当作生产证据。
- 已确认 `doc/todo/infra/production-config.example.yaml` 存在且仅为示例；没有将占位值伪装成 rendered production config。

## 桌面端全流程验收

- `npm run test:ops-console`: `87 files / 475 tests` 通过。
- `npm run build:ops-console`: 生产构建通过。
- `npm run build:merchant-studio`: 生产构建通过。
- `SMOKE_MODE=production SMOKE_API_TOKEN=workspace-local-token npm run test:merchant-studio-smoke`: `PASS`，UI、API health、六平台账户隔离、未配置/需重授权分类和只读同步均已验证。
- `npm run test:browser:all`: `29 passed / 1 skipped`，真实桌面浏览器覆盖商家与运营后台全流程、数据安全、发布幂等/超时恢复、权限和用户治理。
- `npm run infra:validate`: 通过。
- 生产 gate 仍需真实 rendered config、relay、OAuth、支付、云基础设施和 ChatGPT host 证据；不得以本地 fixture 代替。

## 2026-09-02 运行态收口复核

### 新增发现与处理

- `dogfood/chatgpt-all-functions/ops-users.spec.js` 的 workspace 成员治理场景原先被环境变量跳过；显式使用本地 Compose 已提供的 `workspace-local-token` 与 `workspace_admin_demo` 后，发现验收 fixture 使用了已废弃的分散 localStorage 键，且 `page.addInitScript` 错误捕获测试作用域变量，导致配置注入中断并触发 deny-all。已改为清理旧键、写入 `ops_connection_config_v1` 并显式传参。
- 复测命令：`OPS_BASE_URL=http://127.0.0.1:18082/ OPS_WORKSPACE_TOKEN=workspace-local-token OPS_WORKSPACE_ACTOR_ID=workspace_admin_demo npm exec -- playwright test dogfood/chatgpt-all-functions/ops-users.spec.js --workers=1 --grep 'workspace workbench'`。
- 复测结果：`1 passed`，成员页、邀请表单、键盘焦点和 workspace 路由均通过。
- 重建 Ops Console 镜像时发现 API readiness 失败；根因是默认 Compose 调用没有显式加载根目录 `.env`，导致本地 scanner 公钥未注入。使用项目现有 `scripts/ensure-local-scanner-key.sh` 并以 `docker compose --env-file .env` 启动后，API、Ops UI、PostgreSQL、Redis、ClamAV 和 6 个 worker 均 healthy。未删除或清理业务数据。
- Compose 配置已确认通过变量读取 `ASSET_SCAN_TRUSTED_PUBLIC_KEYS`；生产配置仍必须由 secret provider 注入，不能依赖本地 key 脚本。
- `codegraph sync .`：PASS，`2 changed files`，`10 nodes`。

### 当前验证汇总

- 根全量测试：`596 test files passed | 42 skipped`，`3975 passed | 64 skipped`。
- 类型检查：`npm run typecheck` PASS。
- 配置/发布静态门禁：`sh infra/scripts/validate-config.sh` PASS。
- Ops Console 单测：`87 files / 475 tests` PASS。
- Ops Console 与 Merchant Studio 构建均 PASS。
- Merchant Studio production smoke（workspace token）：PASS，6 平台账户隔离、只读生产策略、API/UI health 通过。
- 桌面 Playwright 全套上次结果：`29 passed / 1 skipped`；被环境变量跳过的 workspace 成员治理场景已单独补测并 `1 passed`。
- Docker runtime contract：`5/5` PASS；本轮重启后的本地运行态所有服务 healthy。

### 仍未完成且不可由本地 fixture 代替的上线阻断

- `npm run infra:production-gate`：仍阻断，缺少显式真实 `PRODUCTION_CONFIG_PATH` 或命令行配置路径。
- `npm run codex:relay:validate`：仍阻断，缺少真实模型中转 `model_provider`、host relay `base_url`、`wire_api=responses`、环境变量 key 及业务模型凭据。
- 生产真实 OAuth/API、Vault/外部凭据服务、OIDC/SSO、DNS/TLS/WAF、对象存储、支付回调/对账、通知/OTel、容量报告、备份恢复和六平台 canary 尚未提供可验证证据。
- 因上述外部输入缺失，项目当前本地功能与回归测试通过，但整体上线结论仍为 `NO-GO`；不能把 fixture readiness、示例配置或本地 smoke 记为生产完成。

## 2026-09-02 Worker reconciliation 增量

### 新发现与修复

- CodeGraph 影响分析确认 `apps/worker/src/main.ts` 的 reconciliation 解析器是图片执行恢复链的关键入口。
- API 已返回 `provider_reserved` 与 `provider_dispatching`，但 Worker 原先只接受 `provider_started` 与 `outcome_unknown`，造成预外呼 fence 在 Worker 侧被静默丢弃；同时带有 request ID 的预外呼状态可能被误计入 Provider 查询数量。
- 已将四种状态纳入候选投影；预外呼状态保持可见但禁止 Provider 查询，只有 `provider_started/outcome_unknown` 且存在 request ID 时才查询；`queried` 统计改为实际查询集合。
- 新增回归测试覆盖预外呼状态可见、无 Provider 查询和统计准确性。

### 增量证据

- `npx vitest run apps/worker/src/worker.test.ts --no-file-parallelism`：`1 file / 82 tests passed`。
- `npm run typecheck`：PASS。
- `codegraph affected`：识别 64 个受影响测试文件；本轮执行了直接相关 Worker 全量定向测试，未把未执行集合冒充已验证。
- `codegraph sync .`：PASS，`3 changed files`，`137 nodes`。

### 待办状态调整

该项从“Worker 预外呼状态在 reconciliation 侧可能丢失”调整为“代码级修复完成、真实 Provider query/replay、双副本故障恢复和生产证据仍未完成”。整体生产结论不变，继续 `NO-GO`。

## 2026-09-02 发布门禁与 CodeGraph 增量复核

- `npm run test:release-gates`：`112 test files passed / 3 skipped`，`521 passed / 9 skipped`。
- CodeGraph 影响分析针对 Worker reconciliation 标记 64 个受影响测试文件；直接相关 `apps/worker/src/worker.test.ts` 已 `82/82` 通过。
- 最新 `npm run typecheck`：PASS。
- 本地 Compose 重启后的 API、Ops UI、PostgreSQL、Redis、ClamAV、6 个 Worker 均 healthy。
- 最新 CodeGraph 状态：`1,131 files / 15,807 nodes / 59,582 edges`；同步完成，索引无待处理源码变更。
- 当前新增代码级修复不改变外部上线结论：真实 Provider query/replay、真实 OIDC/ChatGPT Host、生产 PostgreSQL/RLS、平台 canary、容量/故障/恢复和模型中转凭据仍是 `NO-GO` 阻断。

## 2026-09-02 全量回归与 CodeGraph 多方向审计收口

### 最新可复现计数

- `doc/todo` 中含未勾选条目的文件：`8` 个。
- 未勾选条目：`59` 个。
- 含 `NO-GO`/阻断标记的文档：`67` 个；该数字包含历史审计、生产门禁和外部依赖文档，不能等同于 67 个代码缺陷。
- CodeGraph 索引：`1,131 files / 15,807 nodes / 59,582 edges`。
- `codegraph sync .`：通过；本轮新增文件解析为 `0 nodes`，仍不代表生产证据已具备。

### 全量测试证据

- `npm test -- --no-file-parallelism`：`596 test files passed | 42 skipped`，`3976 passed | 64 skipped`。
- 最新直接相关 Worker 回归：`82/82` 通过。
- 最新发布门禁：`112 test files passed | 3 skipped`，`521 passed | 9 skipped`。
- 类型检查、Ops Console 测试/构建、Merchant Studio 构建、生产模式只读 smoke、桌面 Playwright 和本地 Docker runtime contract 均有前序通过证据；跳过项均因真实外部凭据或生产环境未提供，不能计为完成。

### CodeGraph/多方向审计发现

1. **P1，营销活动 manifest 的任务作用域需要显式复核**：`apps/api/src/server.ts` 活动 manifest 投影读取 task 后，当前审计未看到与 campaign workspace 的显式一致性断言。建议在写入 manifest 前校验 `task.workspaceId === campaign.workspaceId`，并增加跨 workspace 负向测试；禁止跨租户元数据投影。
2. **P1，恢复脚本的隔离目标保护不足**：`infra/scripts/restore-postgres.sh` 依赖 `RESTORE_TARGET_ISOLATED=YES` 环境声明，仍需增加源/目标身份实际比对，并增加 source=target 必须拒绝的自动化测试。未完成前不能作为生产恢复安全证据。
3. **P1，Kubernetes base 镜像标签可变**：`infra/kubernetes/base/*.yaml` 使用可变版本标签；生产部署应强制 digest 或不可变 release artifact，并由发布门禁验证渲染结果与签名/回滚证据一致。
4. **P1，OpenAPI bootstrap 契约存在待核对项**：`apps/api/openapi.yaml` 的 `WorkspaceId` 必填定义与 `apps/api/src/server.ts` 的 bootstrap 路径无 workspace id 场景可能不一致。需要统一契约并补 OpenAPI/运行时兼容测试，避免 ChatGPT 插件首次连接失败。
5. **P1，授权快照 grant 集合比较存在顺序敏感风险**：`packages/workers/src/execution-authorization.ts` 直接比较 `grantIds.join(',')`；同一 grant 集合不同排序会被误判为变化。应在比较前规范化排序，并补顺序变化回归测试。
6. **P2，canonical campaign item 投影缺少 campaignId 维度**：`packages/application/src/canonical-product-consistency.ts` 当前投影难以检测 item 与 task 的 campaign 归属不一致，应补字段和一致性断言。
7. **P2，canonical product 列表唯一性依赖调用方 platform/account 参数**：`apps/api/src/server.ts` 相关列表路径需要继续核对服务端租户、平台和账号组合约束，避免多店铺同平台查询歧义。
8. **P2，运营后台桌面范围内仍有可访问性细节**：`UserDirectorySection.tsx` 的操作按钮和筛选控件需要唯一 accessible name/显式 aria-label。移动端 focus trap 不属于本项目上线阻断范围，但可作为后续质量项。

### 已确认不是缺陷的项

- Finance 在缺少 `commercial.access.read` 时返回 403 属于 fail-closed 授权结果；当前前端通过 capability 和 access decision 门控商业请求，不能为消除日志噪声而放宽权限。
- Worker reconciliation 的 `provider_reserved/provider_dispatching` 预外呼 fence 已修复为可见但不查询 Provider；真实 Provider replay、双副本故障恢复仍未验证。
- 插件源 manifest 与 marketplace mirror 已同步增加 `MERCHANT_STRICT_AUTH`；插件 manifest/MCP bridge 定向测试为 `88/88` 通过。

### 当前上线结论

本地代码、单元/API/契约测试及桌面 UI 回归没有新增失败；但项目整体仍为 **`NO-GO`**。阻断项是缺少真实 rendered production config、Codex relay 鉴权与 usage/cost 证据、生产 Postgres/RLS、OIDC/ChatGPT Host、平台 OAuth/canary、支付回调/对账、对象存储/KMS/PITR、容量/故障恢复和签名发布 artifact。以上 8 个未完成文档中的条目，在获得对应真实环境证据或完成上述 P1 修复前不得勾选。

## 2026-09-03 增量修复与最终本地回归

### 本轮修复

- `packages/workers/src/execution-authorization.ts`：授权 `grantIds` 按集合规范化排序后比较，避免同一授权集合因返回顺序不同被错误拒绝。
- `packages/workers/src/execution-authorization.test.ts`：新增 grant 集合顺序变化回归测试。
- `apps/api/src/server.ts`：campaign delivery manifest 读取任务时增加 workspace、campaign、campaign item、商品、平台、账号及已提供 canonical/listing 绑定校验；不一致返回 `CAMPAIGN_TASK_SCOPE_MISMATCH` 并 fail-closed。
- `packages/application/src/campaign-delivery-manifest.ts`：登记新的稳定错误码。
- 插件源包和 marketplace mirror 同步 `MERCHANT_STRICT_AUTH` 及安装 smoke 测试契约。

### 当前验证证据

- Worker 授权定向测试：`12/12` 通过。
- API E2E：`60/60` 通过。
- 插件 manifest/安装 smoke：`19/19` 通过。
- Docker runtime contract：`5/5` 通过。
- rules E2E：`11/11` 通过。
- 根全量回归 `npm test -- --no-file-parallelism`：`596 test files passed | 42 skipped`，`3977 passed | 64 skipped`。
- `npm run typecheck`：通过。
- `codegraph sync .`：通过，`6 changed files`，`111 nodes`。

### 仍需处理

- 恢复脚本真实 source/target identity、签名 target attestation、维护锁和恢复后迁移/smoke 状态机仍未实现或无法由本地 fixture 证明。
- Kubernetes base manifest 的不可变 digest、migration shell runner 的真实执行矩阵仍需补齐。
- OpenAPI 的条件 workspace 语义需要契约化并补生产/本地/OIDC bootstrap 矩阵。
- 真实 relay、OIDC/ChatGPT Host、生产 Postgres/RLS、平台 OAuth/canary、支付、对象存储/KMS/PITR、容量和回滚证据仍缺失。
- 当前 `doc/todo` 仍有 `8` 个含未勾选项的文件、`59` 个未勾选条目；不得因本地全量测试通过而清零。

### 上线判断

本地代码与回归测试达到当前仓库门槛；整体生产上线仍为 **`NO-GO`**，原因是上述真实环境和高破坏性恢复安全证据缺失。`gstack` CLI/浏览器 agent 在当前环境不可用，已使用可用的 UI/PM 审计、桌面 Playwright、Docker runtime 和 CodeGraph 证据替代，未虚构 gstack 运行结果。

## 2026-09-03 高风险门禁修复与最终回归

### 已完成的代码级修复

- `infra/scripts/restore-postgres.sh`：拒绝符号链接备份；生产恢复前读取目标 PostgreSQL system identifier，并在与源库 identity 相同时 fail-closed。
- `tests/operations-scripts.test.ts`：新增符号链接和 source/target identity 相同的负向测试。
- Kubernetes base API、migration、workers、UI、Ops UI manifests：基础工作负载镜像改为 immutable digest。
- `tests/kubernetes-release-gate.test.ts`：增加 base manifest digest 与 kustomize 渲染门禁。
- `apps/api/openapi.yaml`：明确生产 workspace 必填、本地 fallback 和 OIDC bootstrap 条件语义；未放宽 server 运行时授权。
- `tests/openapi-contract.test.ts`：补充 workspace 条件契约矩阵。
- `tests/local-docker-runtime-contract.test.ts`：health log 等待窗口改为 15 秒，仍要求 healthy 且连续三次成功。

### 本轮验证

- 恢复脚本：`31/31` 通过，`sh -n` 通过。
- Kubernetes/OpenAPI/恢复定向测试：`59/59` 通过。
- 发布门禁：`112` 文件通过，`525` 测试通过，`3` 文件跳过，`9` 测试跳过。
- Docker runtime：`5/5` 通过。
- 根全量回归：`596 test files passed | 42 skipped`，`3981 passed | 64 skipped`。
- CodeGraph：同步通过，`2 changed files`，`20 nodes`。

### 仍未达到生产上线条件

- 真实 target attestation、恢复维护锁、迁移/完整性/smoke 状态机仍需生产基础设施接入；当前脚本已增加 identity 级 fail-closed，但不能替代真实恢复演练。
- 真实 rendered production config、Codex relay 鉴权与 usage/cost、OIDC/ChatGPT Host、生产 Postgres/RLS、平台 OAuth/canary、支付、对象存储/KMS/PITR、容量和回滚证据仍缺失。
- `doc/todo` 仍有 `8` 个含未勾选项的文件、`59` 个未勾选条目；外部证据未到位前不得清零。

当前结论：**本地全流程测试通过；生产整体仍为 `NO-GO`，不是代码测试失败，而是真实生产依赖和上线证据缺失。**
### 2026-09-03 本地 backfill 重试安全闭环

- CodeGraph 追踪 `canonicalBackfillRunCanRetry` 仅由 `apps/api/src/server.ts` 的 backfill retry 路径调用，并定位到 `packages/application/src/canonical-backfill-queue.ts`。
- 修复：结果含 `conflicts` 字段但不是数组时 fail-closed，不再把 malformed 结果当作纯执行器错误自动重试。
- 测试：`npx vitest run packages/application/src/canonical-backfill-queue.test.ts --no-file-parallelism`，`1` 文件、`6` 测试通过。
- CodeGraph：同步完成；该模块下游影响为 `packages/application/src/canonical-backfill-queue.test.ts`。
- 本地 TODO 数仍为 `59`；真实 backfill 全量、生产数据和运行证据仍不可由本地测试替代。

## 2026-09-03 migration、恢复与 backfill 增量

### 本轮新增完成

- `infra/scripts/restore-postgres.sh`：强制 `RESTORE_TARGET_ENVIRONMENT`；未签名恢复仅允许 local，签名恢复仅允许 production；生产 URL 复用数据库 URL 校验；保留 source/target identity、备份哈希和 trust anchor 的 fail-closed 保护。
- `tests/operations-scripts.test.ts`：恢复安全测试达到 `32/32`，覆盖 identity、符号链接、环境和 URL 边界。
- `tests/apply-migrations-runner.test.ts`：新增 migration runner 的非连续版本、未知版本、checksum 漂移、锁释放和并发测试 `5/5`。
- `packages/application/src/canonical-backfill-queue.ts`：conflicts 结构异常时 fail-closed，禁止把未知数据当作可重试冲突。
- `packages/application/src/canonical-backfill-queue.test.ts`：新增异常结构回归，`6/6` 通过。

### owner 复验

- 新增定向测试：`43/43` 通过。
- 发布门禁：`112` 文件通过、`526` 测试通过、`3` 文件跳过、`9` 测试跳过。
- 根全量回归：`597 test files passed | 42 skipped`，`3988 passed | 64 skipped`。
- `npm run typecheck`：通过。
- `codegraph sync .`：通过，新增 `2` 文件、`19` nodes。

### 当前上线结论

本地代码和全项目测试继续保持通过，但生产仍为 `NO-GO`。剩余阻断包括真实 rendered production config、Codex relay 凭据和 usage/cost、OIDC/ChatGPT Host、生产 Postgres/RLS、OAuth/canary、支付、云备份/KMS/PITR、容量和回滚证据；`doc/todo` 仍有 `8` 个文件、`59` 个未勾选条目。不得用本地 fixture 或测试绿灯替代这些真实证据。

## 2026-09-03 canonical、Ops UI 与插件入口增量

### 本轮完成

- `brand-unit.listing.create` 增加 canonical product 的 workspace + brand 归属校验，阻断同 workspace 跨品牌商品绑定。
- Ops 商业/Finance 工作区按授权前置门控请求；无权限、403、503 和 stale data 显示明确状态，不伪造 `¥0` 或旧数据成功态。
- 插件严格鉴权开启时，loopback endpoint 不再绕过 token 校验；源包与 marketplace mirror 已同步。

### 本轮验证

- API、插件定向回归：`152/152` 通过。
- Ops 商业/Finance 定向回归：`16/16` 通过。
- 根全量回归：`597 test files passed | 42 skipped`，`3993 passed | 64 skipped`。
- 桌面浏览器全流程：`29 passed / 1 skipped`；跳过项为未提供 workspace 真实凭据的场景。
- `npm run typecheck`：通过。
- `codegraph sync .`：通过；本轮新增 fixture/报告类文件解析为 `0 nodes`。

### 剩余状态

- `doc/todo` 仍有 `8` 个文件、`59` 个未勾选条目。
- 真实生产 rendered config、relay、OIDC/ChatGPT Host、Postgres/RLS、OAuth/canary、支付、云备份/KMS/PITR、容量和回滚证据仍缺失。
- 本地单元/API/桌面浏览器测试已通过，但上述外部证据未具备前，整体上线结论仍为 `NO-GO`。

## 2026-09-03 canonical、运营后台与 relay 深度增量

### 本轮新增修复

- `packages/application/src/canonical-product-consistency.ts`：关系投影增加 campaignId 证据；task/item 缺失或不一致时标记 `CAMPAIGN_ID_SCOPE_MISMATCH` 并 fail-closed。
- `apps/ops-console/src/components/users/UserDirectorySection.tsx`：桌面用户目录操作按钮增加行级 accessible name，筛选控件增加 aria-label，错误状态增加稳定描述关联。
- `packages/ai/src/relay-usage.ts`：解析嵌套 relay 响应中的 `data.result.cost_cny/costCny`，避免已有成本证据被误判缺失。
- `apps/api/src/server.ts`：canonical listing 创建增加 workspace + brand 归属校验。
- `apps/ops-console` 商业工作区：无权限请求前置阻断，403/503 和 stale data 明确呈现。
- `apps/plugin/mcp/bridge.mjs` 及 marketplace mirror：严格鉴权模式下 loopback 不再绕过 token。

### 复验结果

- canonical/users/relay 定向测试：`51/51` 通过。
- 五模态相关回归：`57/57` 通过。
- API/plugin 定向回归：`152/152` 通过。
- 根全量回归：`597 test files passed | 42 skipped`，`3996 passed | 64 skipped`。
- 桌面浏览器全流程：`29 passed / 1 skipped`。
- `npm run typecheck`：通过。
- `codegraph sync .`：通过；本轮报告/fixture 类新增文件解析为 `0 nodes`。

### 剩余上线阻断

- 未勾选 TODO 仍为 `8` 个文档、`59` 个条目。
- 真实生产 rendered config、relay 鉴权及 usage/cost、OIDC/ChatGPT Host、Postgres/RLS、OAuth/canary、支付、云备份/KMS/PITR、容量和回滚证据仍未提供。
- 本地全流程已通过，但生产整体继续判定为 `NO-GO`；不得以 fixture、跳过的 workspace 凭据场景或本地测试替代真实上线证据。

## 2026-09-03 Feature Flags 与多店铺隔离增量

### 本轮新增修复

- `apps/ops-console/src/hooks/useFeatureFlags.ts`、`FeatureFlagsPage.tsx`：修复并发保存/紧急操作计数竞态，加载期间禁用刷新、分页和新建入口。
- `packages/persistence/src/feature-flags-repository.ts`：cursor 绑定 environment/query，百分比 targeting 规范化并拒绝等价重复值，workspace target 保持租户隔离。
- `apps/api/src/server.ts`：listing 按 account 查询时强制同时提供 platform，拒绝跨平台账号歧义。

### 本轮复验

- Feature Flags 定向测试：`14/14` 通过。
- API E2E：`60/60` 通过。
- 根全量回归：`597 test files passed | 42 skipped`，`3999 passed | 64 skipped`。
- 桌面浏览器全流程：`29 passed / 1 skipped`。
- `npm run typecheck`：通过。
- `codegraph sync .`：通过。

### 当前剩余

`doc/todo` 仍有 `8` 个文件、`59` 个未勾选条目。剩余项集中于真实生产 relay/OIDC/ChatGPT Host/Postgres-RLS/OAuth/支付/云备份/容量/canary/回滚证据。当前本地全流程测试通过，但生产仍为 `NO-GO`，不得用 fixture 或跳过项清零。

## 2026-09-03 RBAC、MCP parity 与授权防护增量

### 本轮新增修复

- `ops.session`：拒绝 platform session 中 workspace header/body/target 冲突，修复 `platform_ops` workbench 误判并保持 capability/scope 隔离。
- HTTP `GET /v1/commercial/access` 与 MCP `commercial.access.get`：统一使用正确 operation，修复 parity 错误。
- `consumeGrant`、`reserveExecution`：非法时间戳统一 fail-closed，禁止绕过过期校验、SQL、用量或审计写入。

### 本轮复验

- API/persistence 定向回归：`154/154` 通过。
- MCP/AuthZ/OpenAPI/workbench 定向回归：`35/35` 通过。
- 根全量回归：`597 test files passed | 42 skipped`，`4001 passed | 64 skipped`。
- 桌面浏览器全流程：`29 passed / 1 skipped`。
- `npm run typecheck`：通过。
- `codegraph sync .`：通过。

### 当前状态

本地前后端、运营后台、插件入口、API/MCP、Worker、持久化和桌面浏览器测试均通过。仍有 `8` 个 TODO 文档、`59` 个未勾选条目；真实生产 rendered config、relay、OIDC/ChatGPT Host、Postgres/RLS、OAuth/canary、支付、云备份、容量和回滚证据缺失，整体上线结论仍为 `NO-GO`。

## 2026-09-03 workbench、parity 与 JIT 审计增量

### 本轮新增修复

- `ops.session`：强化 platform/workspace workbench 的 header、body、target workspace 冲突拒绝及 capability/scope 隔离。
- HTTP `GET /v1/commercial/access` 与 MCP `commercial.access.get`：统一 operation 映射，修复 parity 错误。
- `consumeGrant`、`reserveExecution`：非法时间戳 fail-closed，禁止绕过授权过期检查。
- HTTP `GET /v1/products/{productId}/image-review`：修正 operation registry 映射为 `catalog.image.review`。
- platform authorization audit：同一 decisionId 携带不同审计事实时返回冲突，不再静默接受。
- Ops workbench：规则、充值订单、模型倍率旧请求在 scope 切换后不能回填旧数据。

### 本轮 owner 验证

- API/persistence 定向：`154/154` 通过。
- MCP/AuthZ/OpenAPI/workbench 定向：`35/35` 通过。
- 根全量首次出现一次 PostgreSQL `57P01` 清理时序错误；单独复现通过，重跑全量：`597 test files passed | 42 skipped`，`4002 passed | 64 skipped`。
- 桌面浏览器全流程：`29 passed / 1 skipped`。
- 类型检查通过。
- CodeGraph 最终同步通过：`2 changed files`，`5 nodes`。

### 当前上线结论

本地 API/MCP、Worker、数据库适配、插件和 Ops 桌面全流程通过。仍有 `8` 个 TODO 文档、`59` 个条目，且真实生产 rendered config、relay、OIDC/ChatGPT Host、Postgres/RLS、OAuth/canary、支付、云备份、容量和回滚证据未提供，整体生产上线继续为 `NO-GO`。Postgres release 测试的 `PERSISTENCE_RELEASE_DATABASE_URL` 生产-like 外部配置仍需提供，不能用本地默认库替代。

## 2026-09-03 relay、审计连接与插件超时增量

### 本轮新增修复

- `packages/ai/src/video-generator.ts`：规范化 durationSeconds 到 `3–15` 秒，截断小数，非法值回退安全默认值，保持 relay 请求与成本证据一致。
- `PostgresPlatformAuthorizationAuditRepository`：事务启动时 probe `current_user` 与 `app.platform_scope`，不匹配则回滚并禁止审计 SQL。
- `apps/plugin/mcp/bridge.mjs`：幂等写请求超时不再自动重试，保留 `operation_status=unknown`、`retryable=false` 和 timeout evidence；源包与 marketplace mirror 已同步。

### 本轮 owner 验证

- 关键定向测试：`117/117` 通过，另 1 个真实 Postgres 集成测试因缺少 `PERSISTENCE_RELEASE_DATABASE_URL` 跳过。
- 五模态/relay/plugin：`69/69` 通过。
- 根全量回归：`597 test files passed | 42 skipped`，`4012 passed | 64 skipped`。
- `npm run typecheck`：通过。
- CodeGraph：同步通过。

### 当前上线结论

本地 API/MCP、Worker、AI relay 解析、插件桥接、数据库适配和 Ops 桌面流程已通过回归。仍有 `8` 个 TODO 文档、`59` 个条目；真实生产 relay、OIDC/ChatGPT Host、Postgres/RLS、OAuth/canary、支付、云备份、容量和回滚证据缺失，整体生产上线继续为 `NO-GO`。本地默认数据库不能替代 production-like RLS 与真实凭据证据。

## 2026-09-03 复核结果

### 本轮修复后的验证

- CodeGraph：`codegraph sync .` 成功，更新 2 个变更文件，解析新增/修改节点 3 个。
- 全量自动化测试：`597` 个测试文件通过，`42` 个跳过；`4015` 个测试通过，`64` 个跳过。
- 对象孤儿回收定向测试：`6/6` 通过。
- Docker 运行时契约定向测试：`5/5` 通过。
- 本轮修复涉及的 API、权限、持久化回滚、MCP bridge 和插件安装契约定向测试此前均已通过。

### 当前未完成项与上线阻断

- `doc/todo` 仍有 `8` 个文件包含未勾选事项，共 `59` 个未完成 TODO；这些不能因自动化测试通过而标记完成。
- 真实生产/预生产中转模型链路的鉴权、请求、用量、成本和错误证据仍需环境凭证取证；缺失配置必须保持 fail-closed。
- 真实 Postgres/RLS、多租户并发、worker、MCP/ChatGPT 插件端到端链路及发布门禁仍需在对应真实环境验收；自动化跳过项不计入通过。
- 桌面运营后台浏览器验收此前为 `29 passed / 1 skipped`；真实 workspace 凭证缺失的治理场景仍是环境阻断，不是功能通过。

### 结论

当前仓库自动化测试全绿，但项目尚未达到“所有 TODO 为 0”或“所有真实环境上线门禁通过”。剩余工作应优先处理上述 `59` 个 TODO，并补齐真实凭证、数据库/RLS、worker、插件链路和发布环境证据。

## 2026-09-03 继续推进与最终复核

### 本轮实际修复

- canonical consistency：dangling legacy product finding 保留关联 ID，冲突重检覆盖 orphan finding，并返回稳定阻断码。
- canonical backfill：允许明确 `conflicts: []` 的失败重试，同时继续阻断非空或非法冲突数据。
- authorization：补充 `platform.revoke` HTTP/MCP 跨工作区 scope mismatch 负向 parity 覆盖，不进入撤销处理且不泄露 foreign ID。
- Worker：关键副作用进入执行前授权/商业准入门禁；修复 redrive scan 重复授权复核，保持单次 live authorization 和授权错误优先级。
- Ops Console：连接诊断展示最近失败原因并支持重新验证；工作台切换明确来源、目标和会清除的未保存内容。

### Owner 复核证据

- Agent 变更整合定向回归：`8` 个文件，`154/154` 通过。
- Worker 修复后定向回归：`2` 个文件，`94/94` 通过。
- TypeScript：`npm run typecheck` 通过。
- 仓库全量测试：`597` 个测试文件通过、`42` 个跳过；`4022` 个测试通过、`64` 个跳过。
- Release gates：`112` 个文件通过；`526` 个测试通过；`9` 个跳过。
- 桌面浏览器全流程：`29` 个通过、`1` 个跳过。Ops 全流程此前出现一次并发超时，单独重放和最终全量重跑均通过。
- CodeGraph：同步成功，索引当前约 `1,132` 个文件、`15,849` 个节点、`60,181` 条边。

### 仍未完成且不能伪造完成的门禁

- `doc/todo` 仍为 `8` 个文件、`59` 个未勾选事项；其中包含真实环境验收，不应仅凭本地测试勾选。
- `infra:launch-preflight` 当前明确失败：未提供 `PRODUCTION_CONFIG_PATH` 或 rendered production config。
- 真实 OIDC issuer/audience/nonce、受控主体、gateway/membership 一致性证据缺失。
- production-like PostgreSQL 双 role/RLS 攻击矩阵、连接池隔离、真实数据门禁证据缺失。
- 持久 JIT 的真实审批/撤销竞态、跨副本 nonce/max-use、一致性和不可变 audit sink 证据缺失。
- 六平台真实 OAuth/读写/媒体、真实支付、托管对象存储/KMS/PITR、模型中转 usage/cost、容量与长稳、告警值守和生产 canary 证据缺失。
- 浏览器唯一跳过项为真实 workspace 凭证缺失的成员治理场景；该项不计为通过。

### 当前结论

本地代码、API/MCP 契约、Worker、Ops 桌面 UI、容器契约和自动化测试均已通过当前可执行范围；项目整体仍为 **PRODUCTION NO-GO**，原因是上述真实凭证、生产类基础设施和外部系统证据尚未提供。不得将剩余 `59` 项迁移到 `doc/done`，也不得注入 mock 凭证替代真实验收。

## 2026-09-03 真实运行门禁复核

- `npm run infra:validate`：通过；仅验证 YAML/schema 和示例证据，不代表生产配置。
- `npm run evidence:validate`：通过；当前文件为 fixture/non-production validation。
- `npm run capacity:evidence:validate`：通过；当前文件为 fixture/non-production validation。
- `npm run dev:doctor`：`37 pass / 16 warn / 0 fail`；本地容器和 API/UI 健康，但 production gate=false。
- `npm run test:load`：通过 `pilot_50_fake_in_memory`，`50` workspace、`50` publish job、无重复写；明确不是云端容量证据。
- `npm run test:capacity-workload`：被 `CAPACITY_WORKLOAD_URL` 缺失阻断。
- `npm run test:redis-loss-recovery`：被 `REDIS_RECOVERY_ACCOUNT_ID` 缺失阻断，未执行破坏性恢复操作。
- `npm run test:replica-consistency`：当前身份对 `store.connection.read` 返回 `403`，未形成真实复制证据。
- `npm run test:distributed-rate-limit`：当前身份收到 `403,403,403`，未形成限流证据。
- `npm run test:fault-acceptance`：Pinduoduo connector `NOT_CONFIGURED`，按 fail-closed 停止。
- `npm run codex:relay:validate`：宿主 Codex `model_provider/base_url/wire_api/env_key` 未配置，无法证明宿主 relay。
- `npm run infra:launch-preflight`：未提供 `PRODUCTION_CONFIG_PATH` 或 rendered production config，发布门禁阻断。

这些失败均属于真实凭证/目标环境前置缺失，不通过修改断言、fixture 或跳过逻辑处理。

## 2026-09-03 继续验证补充

- `npm run test:backup-restore`：通过；本地恢复迁移版本 `1..160` 完整，业务表恢复检查通过，`cloudGate=false`。
- `npm run test:normalized-projection`：通过；版本投影从 `1` 到 `2` 正常重放。
- 当前真实运行前置仍未满足：无非示例 rendered production config，宿主 Codex relay 字段缺失，真实 workspace/store 权限身份未提供。
- 所有外部依赖缺失均维持 fail-closed，未改写 smoke 预期、未注入虚假凭证、未删除数据库或容器数据。

## 2026-09-03 继续轮次：workspace 与恢复链路

- CodeGraph + pm-dogfood/pm-verify-feature 复核：唯一浏览器跳过项明确依赖 workspace-only `merchant_admin/owner` 的 `OPS_WORKSPACE_TOKEN`，不能用 platform token 冒充。
- `npm run test:backup-restore`：通过，本地 Postgres 迁移 `1..160` 与业务表恢复检查通过；仍为 `cloudGate=false`。
- `npm run test:normalized-projection`：通过，投影版本 `1 -> 2` 正常重放。
- `npm run test:load`：通过 `pilot_50_fake_in_memory`，但不是云端容量证据。
- `npm run test:capacity-workload`：因 `CAPACITY_WORKLOAD_URL` 缺失阻断。
- `npm run test:redis-loss-recovery`：因 `REDIS_RECOVERY_ACCOUNT_ID` 缺失阻断，未执行破坏性操作。
- `npm run test:replica-consistency` 与 `npm run test:distributed-rate-limit`：当前身份被服务端授权拒绝，不能伪造成功。

当前 `doc/todo` 计数仍为 `8` 个文件、`59` 个未勾选项。所有未完成项均保留原始门禁语义，等待真实 workspace token、生产配置和外部系统证据。

## 2026-09-03 生产模式 doctor 与安全复核

- `npm run dev:doctor:production`：`37 pass / 1 warn / 15 fail`。
- 通过项包含 Docker/Compose/buildx、API/UI/Worker/Postgres/Redis/ClamAV 健康、迁移尾 `160`、数据库 FORCE RLS `9/9`、业务持久化和模型 relay contract。
- 失败项明确为宿主 Codex relay、MCP bridge、真实 production config、支付、六平台 OAuth、真实模型 relay、对象存储/KMS、scanner、告警、production gate、approved catalog/rate、release evidence 和 Codex App error recovery 未配置或未提供证据。
- `npm audit --omit=dev --audit-level=high`：`0 vulnerabilities`。
- CodeGraph impact：`createOutboxHandler` 影响 `73` 个测试文件，包含 Worker 主循环、授权复核、商业零副作用和浏览器链路；未发现无覆盖的关键调用方。
- 运行时代码 TODO 扫描仅命中占位值拒绝规则，不存在可安全视为“未实现”的裸 TODO/NotImplemented。

本轮没有修改安全门禁或注入凭证；生产失败保持 fail-closed。整体仍为 **PRODUCTION NO-GO**，直到外部真实配置和证据由授权环境提供。

## 2026-09-03 P0 与测试汇总复核

- `npm run test:p0-golden`：`1` 个文件、`10/10` 通过。
- `npm run test:summary`：测试文件 `639/639`、测试 `4022/4022` 无失败；HTTP fake load 因商业上线门禁关闭，`create_draft` 全部返回 `503 COMMERCIAL_OPERATION_DISABLED`，汇总以非零退出。这是预期的 fail-closed 结果，不将被改写为 smoke 成功。
- `npm run test:merchant-studio-smoke`：当前身份缺少 `store.connection.read`，服务端拒绝，未绕过授权。
- `npm run test:platform-canary`：未设置 `PLATFORM_CANARY_MODE=real`，真实平台 canary 未执行。

本轮没有修改测试门禁以消除真实阻断；生产写入、平台 canary 和 workspace 权限仍需授权环境。

## 2026-09-03 构建与发布产物复核

- `npm run build`：通过；全部 packages 与根 TypeScript production build 完成。
- `npm exec tsx -- scripts/release-manifest.ts --release-id local-verification-2026-09-03 --output /tmp/codex-release-manifest.json`：通过，生成临时本地 manifest；未冒充生产 release。
- `npm run release:metadata:validate`：通过；VERSION、package metadata、CHANGELOG、插件 mirrors、MCP registry 和 migrations 一致。
- CodeGraph：同步成功。

当前自动化/构建证据已闭环；生产模式 `15` 个 fail 和 `59` 个 TODO 仍由真实外部配置、凭证、授权身份及云环境验收决定，不通过修改门禁消除。

## 2026-09-03 生产配置与 relay canary 复核

- `npm run infra:production-gate`：阻断，未提供 `PRODUCTION_CONFIG_PATH` 或参数形式的 rendered production config。
- `npm run test:model-relay-canary`：返回 `state=blocked`，原因 `MODEL_RELAY_BASE_URL missing`；未伪造模型请求或成本证据。
- `npm run test:local-release-gate`：`1` 个文件、`2/2` 通过。

本轮未修改代码或门禁断言；当前生产阻断完全由真实环境输入缺失造成。

## 2026-09-03 复核增量：MCP 工具面与发布门禁

- 发现并修复商家 bridge 与共享 `COMMERCIAL_OPERATION_REGISTRY` 不一致：`workspace.health`、`canonical.product.consistency`、`platform.mapping.preflight` 恢复入口已纳入 recovery surface；`merchant.first_value`、`brand.extract`、`creative.brief`、`creative.preview`、`automation.scan`、`automation.tick` 不再被错误标记为 disabled。
- 源插件 bridge 与 `.codex-marketplace` mirror 已逐字节一致；运行态 `tools/list` 为 `138` 个商家 MCP 工具。
- 同步 `release-metadata.json`、根 README、插件 README、实现状态和 MCP surface allowlist，发布元数据校验通过。
- 定向发布/插件/部署契约：`6` 个测试文件，`60/60` 通过。
- 全量 Vitest：`597` 个测试文件通过，`4022` 个测试通过；`42` 个文件、`64` 个测试因真实外部环境门禁跳过。
- 类型检查通过；CodeGraph 已同步本次 `3` 个变更文件。
- 本地仓库仍不是生产 GO：真实模型中转、生产配置/签名证据、真实平台 OAuth/canary、支付、云对象存储、容量长稳、Redis 恢复账号和 workspace token 等外部门禁仍缺失；相关脚本保持 fail-closed，不能以本地测试替代。

## 2026-09-03 多 agent 深度审查与修复

### 代码级高风险问题已修复

- 创意点结算：交付结算现在必须绑定当前 operation/provider 的持久化成功 receipt，并校验 usage、cost、verifiedAt；provider request ID 跨 operation 冲突 fail-closed。
- Worker 死信：不再把 `published_at` 写成死信成功标志，改为 terminal error 证据并兼容历史扫描。
- Worker `--once`：poll/依赖失败现在以非零失败返回，不再被 Cron/Job runner 误判成功。
- Worker lease：lease 校验后使用数据库权威 payload，避免相同 id/token 下执行被替换消息内容。
- 原生 MCP：业务错误码、details、request_id、trace_id 以及商业 access evidence 统一进入 JSON-RPC `error.data`。
- Provider 503：保留有界错误摘要；未明确证明 provider 未执行时转为 `MODEL_PROVIDER_OUTCOME_UNKNOWN`，写操作不自动重试。
- `merchant.start`：`attachment_count` 与共享 contract 统一为字符串 `0..20`，源插件和 marketplace mirror parity 已覆盖。
- PostgreSQL restore：恢复后自动执行迁移一致性、运行时 DB role/RLS/ACL、API/worker/plugin smoke；hook 缺失或失败均非零退出。

### 复核证据

- 受影响定向测试：`14` 个文件、`371/371` 通过；MCP/native/bridge 后续定向集合 `9` 个文件、`287/287` 通过。
- 全量 Vitest：`597` 个文件通过、`4033` 个测试通过；`42` 个文件、`64` 个测试按真实环境门禁跳过。
- 类型检查：通过。
- 构建：通过。
- 发布元数据校验：通过。
- CodeGraph：已同步本轮变更。
- 桌面浏览器全流程：`29 passed / 1 skipped`；覆盖商家工作流、数据安全、发布幂等/超时恢复、Ops 工作台和用户治理。
- UI/UX Pro Max：完成桌面 Ops 可访问性/错误焦点/键盘交互检索；现有 Ops 实现审查未发现独立 P1/P2 UI 缺陷。

### 仍然不可宣称上线

- 生产 doctor：`37 pass / 1 warn / 15 fail`。
- 生产配置、宿主 Codex relay、插件 origin/token、真实支付、六平台 OAuth、五模态真实 relay evidence、云对象存储/KMS、scanner、告警、可执行目录/费率、release evidence、真实 workspace 权限仍缺失。
- 生产 Postgres/RLS 非超级用户攻击矩阵、PITR/WAL 演练、真实双 role、审计 sink、容量/故障/Redis 恢复和 ChatGPT 宿主错误恢复证据仍缺失。
- `doc/todo` 当前仍为 `8` 个含未勾选项文件、`59` 个未勾选条目；其中多数是必须由授权生产环境提供的真实证据，不能通过改勾选或 fixture 清零。

当前结论：**本地代码、API/MCP、Worker、数据库契约、插件和 Ops 桌面回归达到当前可执行门槛；整体生产状态仍为 `NO-GO`，直到真实外部配置与不可变证据完成。**

## 2026-09-03 最终本地回归

- 多 agent 深度审查后新增修复：结算入口与 persistence 层拒绝负数、NaN、Infinity、非法 usage/cost、非法 modality/model、非法时间和不完整 provider receipt。
- 全量 Vitest 最终结果：`597` 个测试文件通过、`4042` 个测试通过；`42` 个文件、`64` 个测试按真实环境门禁跳过。
- `npm run build`：通过。
- `npm run typecheck`：通过。
- `npm run release:metadata:validate`：通过。
- `npm run test:browser:all`：`29 passed / 1 skipped`；唯一跳过为真实 workspace 凭证缺失的成员治理场景。
- CodeGraph 已完成最终同步。

最终判断：仓库内可执行代码、前后端、Worker、插件、数据库契约、Ops 桌面 UI 和自动化回归均通过当前可用验证；但真实生产配置和外部 evidence 仍缺失，生产 doctor 仍为 `37 pass / 1 warn / 15 fail`，`doc/todo` 仍有 `8` 个文件、`59` 个未勾选项。因此整体上线结论仍为 **PRODUCTION NO-GO**，不能以本地绿灯替代真实 relay、OAuth、支付、对象存储、PITR、RLS 攻击矩阵、容量、告警、ChatGPT 宿主和发布签名证据。

## 2026-09-03 深度审查补充结论

- CodeGraph 复核了插件/API、Ops、PostgreSQL/RLS、Worker/队列、模型/账务和发布基础设施六个方向。
- Worker 代码级高风险项已闭合：死信不再伪装成功、`--once` 失败退出、lease 后使用权威 payload。
- 结算代码级高风险项已闭合：receipt 与 operation/provider 绑定、跨 operation request ID 冲突拒绝、usage/cost 数值边界拒绝。
- 原生 MCP 代码级高风险项已闭合：业务错误 data 完整保留、Provider 裸 503 有界摘要和未知结果 fail-closed、写操作不自动重试。
- 剩余数据库风险不是当前已确认的 HTTP 越权：RLS workspace GUC 尚未与数据库身份/membership 绑定，生产-like 双 role 攻击矩阵、PITR/WAL 演练和恢复后全链路 smoke 仍缺证据。
- Ops UI/RBAC 桌面审查未发现独立 P1/P2 代码缺陷；现有 403、焦点、ARIA、工作台切换和 stale response 保护有测试覆盖。
- 不能通过修改测试断言、勾选 TODO、注入 fixture 或清理容器数据来消除上述外部阻断。

## 2026-09-03 继续推进复核

- 以 CodeGraph 重新追踪剩余 TODO 后，补充 `parseWorkerAuthorizationSnapshot` 直接安全边界矩阵：schema、scope hash、resource/workspace/context、capability、authorized、timestamp、grantIds 均 fail-closed。
- parser 定向测试：`21/21` 通过。
- 全量回归首次受到 `worker-generation` Docker health log 瞬时失败影响；检查 live container 后确认当前 `healthy`、最近 health checks 全部 `ExitCode=0`，针对性 live Docker contract `5/5` 通过。
- 全量回归重跑：`597` 个文件通过、`4051` 个测试通过；`42` 个文件、`64` 个测试按环境跳过。
- 剩余生产阻断未变化：生产配置、宿主 relay、真实 OAuth/支付/对象存储/PITR/RLS/容量/告警/ChatGPT 宿主和签名 evidence 仍需授权外部环境。

## 2026-09-03 resumed verification: image task classification and desktop acceptance

- Root cause: `isImageGenerationConfigurationError` and `describeApiError` used broad model/image prefixes, so `IMAGE_GENERATION_READ_UNAVAILABLE` was misclassified as a model configuration blocker. This hid the recoverable read-error surface and replaced the server message.
- Root cause: the image job status chip prioritized `outcome_unknown` over the more specific `archive_state=partial`, hiding the required `部分归档，等待补偿` state.
- Fixes: narrowed configuration classification to explicit configuration codes; preserved `IMAGE_GENERATION_READ_UNAVAILABLE` server messages; prioritized partial/external/pending archive states in the display label; added regression assertions.
- Targeted unit tests: `2 files / 7 tests passed`.
- Merchant Studio build: passed.
- Image-generation desktop acceptance: `12 passed / 0 failed` across 1280, 1440, and 1920 desktop viewports.
- Full typecheck: passed.
- Full Vitest: `597 files passed / 42 skipped`; `4051 tests passed / 64 skipped`; exit code `0`.
- Full browser suite on isolated local preview: `26 passed / 1 skipped / 3 failed`. The three failures were Merchant Studio inventory/walk/interaction checks receiving real `401 UNAUTHENTICATED` responses because the isolated preview intentionally had no API proxy/token. Ops Console and merchant data-safety flows passed. This is environment evidence, not a claim of production readiness.
- Production status remains `NO-GO`: the production doctor still reports missing host relay contract, plugin bridge token/endpoint, production config, payment provider fixture, six platform OAuth credentials, five modality relay evidence sets, object storage, scanner, alerts, executable catalog, approved rate, and release readiness. These require real deployment configuration and canary evidence; they must not be replaced by local fixtures.

## 2026-09-03 continued: relay activation and registry/UI audit

- Host Codex configuration was present but inactive because the top-level `model_provider` selector was missing. Added `model_provider = "damai_relay"` to `~/.codex/config.toml`.
- The configured host model `gpt-5.6-luna` was not advertised by the real relay catalog. Switched the host model to `glm-5.2`, which the authenticated relay advertises with `openai-response` support.
- Current authenticated relay probe: HTTP 200; catalog exposes OpenAI `data[]`, including `glm-5.2` and `openai-response`; it does not expose the required top-level Codex `models[]` catalog. `npm run codex:relay:validate` therefore remains blocked on the provider directory contract, not on a missing local URL/key.
- Agent owner review found and accepted two local fixes:
  - `packages/contracts/src/commercial-operation-registry.ts`: added 7 Worker runtime operations to the commercial runtime manifest and registry totality gate.
  - `apps/ops-console/src/components/OpsSidebar.tsx`: added an explicit `region` landmark and labelled scope panel.
- Targeted verification for these fixes: `2 files / 22 tests passed`; full typecheck passed; Ops Console production build passed.
- Remaining TODO count: `8 files / 59 unchecked items`. The remaining items are predominantly real OIDC, production PostgreSQL/RLS, JIT/audit sink, capacity/fault/restore, provider/OAuth/storage/scanner/alert and canary evidence gates.

## 2026-09-03 continued: activate host relay and remove false catalog blocker

- Root cause: `~/.codex/config.toml` had a valid `[model_providers.damai_relay]` section but no top-level `model_provider` selector; the configured model was also absent from the real relay catalog.
- Configuration activation: added `model_provider = "damai_relay"` and selected `glm-5.2`, which the authenticated relay advertises with `openai-response` support.
- Root cause in release validation: `scripts/validate-codex-relay.ts` required a non-standard top-level `models[]` mirror even when a standard OpenAI `data[]` catalog declared the selected model and `openai-response`. The probe now requires `data[]`, selected model declaration, and Responses capability; optional `models[]` is validated when present.
- Relay validation: `npm run codex:relay:validate` now passes: `host_provider=damai_relay`, `host_endpoint=ai.wormholexyz.xyz`, `business_relay=ai.wormholexyz.xyz`.
- Authenticated real canary with project `.env`: text and OCR both returned HTTP 200 with provider request IDs, usage and pricing cost evidence; both were `ready`. Image, image-edit and video probes were intentionally `not_run_cost_guard`; they require explicit `MODEL_RELAY_CANARY_CONFIRM=true` because they may incur provider charges.
- Regression verification: `tests/configure-codex-relay.test.ts`, registry, Ops Sidebar and image error suites: `5 files / 40 tests passed`; typecheck passed.
- Production remains `NO-GO` until billable media canaries are explicitly authorized and completed with provider usage/cost/error evidence, and real production OAuth, payment, object storage, scanner, alerts, capacity, restore and release metadata are supplied.

## 2026-09-03 continued: release gate and CodeGraph verification

- Production doctor after relay activation: `38 pass / 1 warn / 14 fail`; `host_model_relay` is now passing.
- Release metadata gate: passed; VERSION, package metadata, CHANGELOG, plugin mirrors, MCP registry and migrations aligned.
- Release-gates regression: `112 files / 527 tests passed / 3 skipped files / 9 skipped tests`.
- CodeGraph sync: passed; `15 changed files`, `2 added`, `13 modified`, `528 nodes` synchronized.
- TODO count remains `8 files / 59 unchecked items`; remaining items require real external production configuration/evidence and are not safely closable from this workspace.

## 2026-09-03 continued: Redis AOF runtime verification

- Initial host check on `127.0.0.1:6379` showed `aof_enabled=0`, but that port is not the project Redis instance.
- Project container `local-redis-1` is published on `127.0.0.1:63799` and runs `redis-server --appendonly yes`.
- Container evidence: `aof_enabled=1`, `aof_rewrite_in_progress=0`, `aof_rewrite_scheduled=0`, `aof_last_rewrite_time_sec=0`, `aof_last_bgrewrite_status=ok`, `aof_last_write_status=ok`, `loading=0`, `rdb_last_bgsave_status=ok`.
- No destructive AOF repair/rewrite was executed because the application Redis instance is healthy; the host `6379` mismatch is an environment-observation issue, not an application AOF failure.

## 2026-09-03 continued: Redis connection-path verification

- Compose configuration confirms API and every Worker use `REDIS_URL=redis://redis:6379` over the compose network.
- The project Redis service is `local-redis-1`, published only as host port `63799->6379`; its AOF runtime state is healthy (`aof_enabled=1`, rewrite/write/RDB statuses `ok`).
- Host port `6379` belongs to a separate Redis instance and is not used by the application. Redis AOF is therefore not an application release blocker.

## 2026-09-03 continued: release manifest invocation and validation

- Generated a real local release manifest with release ID `local-20260903-relay`; command completed successfully.
- Release manifest, manifest gate and bundle gate: `3 files / 10 tests passed`.
- The prior manifest failure was only missing required CLI arguments, not a release implementation defect.
- Production runtime readiness remains independent and blocked by missing external credentials/evidence.

## 2026-09-03 continued: local plugin-to-MCP chain smoke

- Executed the installed plugin bridge through `apps/plugin/mcp/bridge.sh` with the local compose API endpoint and local workspace token; no writes enabled.
- MCP `initialize`: successful.
- MCP `tools/list`: successful, `138` tools returned.
- MCP `tools/call workspace.health`: successful, `isError=false`, structured result returned.
- This closes the local `stdio -> bridge -> HTTP /mcp -> API -> workspace auth` path. Production plugin endpoint/token remains a separate external release gate and is still missing.

## 2026-09-03 continued: Merchant Studio smoke credential alignment

- Root cause: `tests/merchant-studio-smoke.ts` defaulted to `pilot-local-token`, while `infra/local/docker-compose.yml` defaults the API credential to `workspace-local-token`; local smoke therefore failed authorization on `store.connection.read`.
- Fix: aligned the smoke default with compose and retained explicit `SMOKE_API_TOKEN` override for staging/production.
- Merchant Studio production read-only smoke: passed; UI returned HTTP 200, API persistence ready, all six platform account rows readable, 20 products returned, no writes executed.
- Full typecheck: passed.
- No standalone `tests/merchant-studio-smoke.test.ts` exists; no test count was attributed to that nonexistent path.

## 2026-09-03 continued: real desktop browser regression

- Ran the full desktop browser suite against the default `18081/18082` runtime.
- Result: `27 passed / 1 skipped / 2 failed`.
- Merchant Studio entry, interaction, inventory and all merchant data-safety scenarios passed.
- Two Ops scenarios failed because the current `ws_demo` runtime data does not contain the acceptance records `Release QA Brand` / `brand_release_qa` and `support_demo`; page load and authorization succeeded, but the expected rows were absent.
- Direct unauthenticated MCP probes for `ops.users.list` and `ops.workspaces.list` returned `403`, while `ops.session` without the full workbench session context returned `400`; this confirms fail-closed session projection rather than a query data leak.
- No fixture rows were inserted and no authorization was weakened. The remaining browser failures require a controlled, documented acceptance dataset/bootstrap in the target environment.

## 2026-09-03 官方本地验收 seed 与并发回归

- `infra/local/seed-demo.sql` 已确认是项目官方、幂等、本地专用 seed；Compose `migrate` 执行成功，迁移 001-160 均已存在，运行时数据库角色校验通过，seed `support_demo` 与 `brand_release_qa` 均写入 `ws_demo`。
- 只读 SQL 证据确认：`workspace_members(ws_demo, support_demo)=1`、`brands(ws_demo, brand_release_qa)=1`；直接 MCP `ops.users.list(query=support_demo)` 返回该成员；隔离浏览器重跑 `ops.spec.js:99` 通过，`ops-users.spec.js:33` 亦通过。
- 完整桌面浏览器回归第二轮：`25 passed / 1 skipped / 4 failed`。失败包含 API `merchant_app` 连接池超时引起的用户目录/品牌树空状态，以及两个受控注入/Mock 场景未进入预期状态；API 日志明确出现 `timeout exceeded when trying to connect`，涉及 `support/sla-scan`、`ops.audit.platform.list`、`automation/tick` 与对象清理后台任务。
- 结论：功能数据与核心 MCP 读取链路可用，但当前本地全链路并发稳定性仍为 P1，不满足上线门禁；不能以重复执行浏览器套件替代连接池/后台任务隔离修复。

## 2026-09-03 API 重启后定向回归

- API 容器重启后保持 `running`，未清理 Postgres/Redis 数据卷。
- 定向浏览器回归：同步全部店铺、模型故障状态、品牌树均通过；用户目录首屏/详情首轮曾隔离通过，但在四用例串行回归中第二次“不存在用户”筛选出现空状态更新超时，快照显示旧的 161 条结果仍在页面。
- 该现象与 API 日志中的连接池争用一致，属于运营后台查询状态与后台任务并发下的稳定性问题；当前不应宣称全流程验收通过。

## 2026-09-03 连接池扩大实验与完整回归

- 使用 `DB_POOL_MAX=40` 仅重建本地 API 容器进行实验，API 保持健康；未修改生产配置、源码或持久化数据。
- 定向回归中同步全部店铺、模型故障状态、品牌树、用户目录曾通过，但完整套件仍出现不稳定。
- 完整桌面回归结果：`26 passed / 1 skipped / 3 failed`；商家交互用例 120 秒超时，用户目录与品牌树再次因后台并发下的查询状态/超时未呈现验收数据。
- 结论：简单扩大连接池不足以满足上线标准，仍需正式实现后台任务与交互请求的资源隔离、并发上限和超时可观测性，再进行全流程验收。

## 2026-09-03 隔离复现结论

- `merchant-interactions.spec.js:16` 在 API `DB_POOL_MAX=40` 实验环境中隔离通过，耗时 13.7 秒；此前完整套件中的 120 秒超时不是该功能的稳定必现失败。
- 但完整套件仍会在串行累积后台任务/审计请求后出现用户目录、品牌树或商家交互异常，说明验收环境与 API 后台任务缺少可靠的资源隔离和状态清理边界。
- 不能用隔离通过覆盖完整链路不稳定；上线门禁继续保持 NO-GO，正式修复应包含 API 前台请求与后台任务的连接池/并发预算、任务调度互斥或独立池，以及可观测的池等待/超时指标。

## 2026-09-03 用户目录并发与无障碍契约修复

- `packages/persistence/src/members-repository.ts`：`PostgresMembersRepository.listMany` 从逐工作区串行读取改为最多 8 路有界并发；每个工作区仍通过 `withWorkspaceTransaction` 设置独立 RLS scope，无跨租户查询或权限放宽。
- `apps/ops-console/src/components/users/UserDirectorySection.tsx`：行内治理按钮 accessible name 改为精确 `停用`/`恢复`，用户身份继续由表格行和详情按钮上下文提供，修复验收定位契约不一致。
- 验证：`npm run typecheck` 通过；`members-repository.test.ts` 为 `7/7` 通过；API/Ops UI 镜像构建成功；`infra:validate` 通过；API 与 Ops UI healthy；用户目录真实浏览器用例通过（约 23.8s）。
- 结论：用户目录批量读取性能与 UI 动作可定位性已改善；完整 30 用例套件仍需在干净、受控的运行时资源预算下重新验收，不能用单用例通过替代全链路稳定性证据。

## 2026-09-03 Ops 平台账务调用边界修复

- `apps/ops-console/src/pages/OpsConsoleController.tsx`：移除平台工作台初始化/刷新时对 workspace-scoped `billing.recharge.list` 的自动调用；平台账务页面应使用 `ops.finance.*` 聚合，商家充值列表不再产生必然 403。
- 验证：类型检查、Ops UI 构建、镜像重建成功；`ops-all.spec.js:23` 真实浏览器通过（`1/1`），此前 `billing.self.read` 403 消失。
- 同轮 `PostgresMembersRepository.listMany` 有界并发修复仍有效，用户目录真实用例通过。

## 2026-09-03 最终桌面回归记录

- 修复后完整桌面套件：`27 passed / 1 skipped / 2 failed`；失败为串行套件下发布错误焦点和品牌树数据呈现的偶发状态干扰。
- 两个失败用例隔离重跑全部通过：发布 500 可恢复确认 `1/1`，品牌树真实数据导航 `1/1`，总耗时 `13.9s`。
- 当前稳定通过项覆盖 Merchant Studio 全流程、商家数据安全、全店铺同步、Ops 总览、模型失败闭环、用户目录、品牌树和权限失败闭环。
- 仍不能宣称全套件稳定绿：需要独立测试数据/资源预算与跨用例状态隔离，生产上线还受真实 OIDC、六平台 OAuth、支付、五模态成本证据、对象存储、扫描告警、容量报告和 release metadata 阻断。

## 2026-09-03 Release gates 全量通过

- 修复 marketplace 镜像漂移：`apps/plugin/skills/merchant-marketing/SKILL.md` 已与 `.codex-marketplace` 镜像同步；插件 manifest 门禁 `8/8` 通过。
- 将 checked-in Kubernetes 域名断言同步到项目 canonical `yxsona.com` / `ops.yxsona.com`，并保留通用 example manifest 测试；生产渲染绑定与运维脚本门禁通过。
- 修复平台工作台自动请求 workspace-scoped `billing.recharge.list` 的权限边界；Ops 总览真实浏览器通过。
- 完整 release gates：`112 files / 527 tests passed / 9 skipped`，退出码 0。
- 当前剩余阻断仍为真实生产证据：OIDC/六平台 OAuth、支付 provider、五模态 cost evidence、生产对象存储/扫描告警、容量报告、生产 release metadata、真实 Postgres/RLS/canary 等；因此不能将 TODO 伪清零或宣称可上线。

## 2026-09-03 continuation evidence

- Fixed local Compose parsing of `ASSET_SCAN_TRUSTED_PUBLIC_KEYS`: the JSON public-key map in `.env` is now quoted so Compose injects it into API and worker containers instead of silently resolving to an empty value.
- Recreated local API and `worker-scan` without removing volumes or business data. Real scanner callback contract now passes `5/5`; the previously pending attempts were accepted after the trust root was injected. ClamAV remained real (`clamav_worker`), not a fixture.
- Restored row-specific accessible labels for Ops user governance actions and made the browser locator match the accessible name. User directory component tests pass `7/7`.
- Updated Ops source-contract assertions to cover the intentional delayed background hydration path (`deferredOptional`) rather than requiring an outdated eager call string. Ops contract tests pass `8/8`.
- Full Vitest: `597 passed / 42 skipped` files; `4053 passed / 64 skipped` tests; exit 0.
- Full desktop browser acceptance: `29 passed / 1 skipped` of 30 tests; includes Merchant Studio, Ops Console, model failure isolation, 401 re-authentication, brand tree/store navigation, publish confirmation/idempotency, data safety, and platform user governance.
- Release gates: `112 passed / 3 skipped` files; `527 passed / 9 skipped` tests; exit 0.

### Remaining launch blockers

- The documentation backlog remains `59` unchecked TODO/NO-GO items across `8` files. These are predominantly requirements for real production evidence, not code comments that can be safely checked off: OIDC, six-platform OAuth, payment provider, five-modality relay usage/cost evidence, object storage/KMS, scanner approvals/definitions, alerts, capacity/canary, RLS/rollback/JIT/audit evidence, and production release runtime.
- Local runtime is healthy and the real scanner callback is proven, but production readiness is still NO-GO until the external evidence paths are supplied and the production doctor reports all required gates ready.

## 2026-09-03 backlog reconciliation

- Recounted all unchecked Markdown checklist items with `rg`: `61` unchecked items across `9` files. The previously reported `59/8` count missed `doc/todo/architecture/technical-solution-design.md`.
- The missed document contains two genuine external-evidence items: application permission approval evidence and six-platform OAuth normal/rejected/expired/revoked acceptance evidence. They remain unchecked intentionally.
- Production doctor after the local scanner fix: `38 pass / 1 warn / 14 fail`. Local runtime and real scanner callback are healthy; production remains NO-GO for missing external configuration/evidence.
