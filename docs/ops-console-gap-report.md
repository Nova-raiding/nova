# 运营后台能力缺口报表（第一版）

日期：2026-09-05  
范围：`apps/ops-console`、`apps/api`、`packages/contracts`、真实 ECS 运行环境。

## 当前有效结论（以最新取证为准）

### 2026-09-05 15:32 门禁复核更正

此前“530 项通过、只剩宿主验收”的结论过度。`quality-entrypoints.test.ts` 曾允许通用迁移测试替代最新迁移专项，实际 `test:release-gates` 未包含 migration 162。本轮恢复了 release 命令与 CI 的严格最新迁移断言，复现 1 项失败；随后将 `migration-162.test.ts` 实际加入 package.json 发布命令，专项 2 文件、7 测试通过。该专项仍只是 SQL 文本/注册测试，不是 PostgreSQL 实际执行验收。

`mcp-surface-contract.test.ts` 的 138/140 差异已定位并修复：测试误把 `catalog.image.generate`、`multimodal.image.edit` 列为 disabled，但 bridge 设计为让它们可见、由 API 执行商业准入；现已恢复精确 140 断言。MCP surface 与插件 manifest 专项 18 项通过。真实桌面业务验收、上线配置和同一部署版本的证据仍须逐项复核，不应将全部剩余工作归结为 Computer Use 故障。

本报告包含排障过程中的历史快照；历史快照不能覆盖下面的最新状态。当前 pilot 的有效证据是：公网 `/api/healthz=200`、`/api/readyz=200`、`/api/releasez=200` 且 `ready=true`；ECS 14 个容器 healthy；workspace MCP 的 `tools/list` 与只读 `merchant.first_value` 已成功；platform token 在 workspace workbench 下被 `AUTHZ_WORKBENCH_FORBIDDEN` 拒绝。扫描素材 `asset_368a5c9a-8135-400e-be5e-972322d8c0e2` 已取得 API 接受的签名回执，heartbeat `ready=true`、`callback.capable=true`、backlog=0。

这些证据只证明 pilot 和指定测试租户的运行闭环，不证明正式生产发布，也不证明真实 ChatGPT.app 已完成插件安装、对话调用和图片选择旅程。真实宿主证据仍是上线阻断项。

## 结论摘要

> 2026-09-05 验收口径更正：下文“已闭环”“最小操作闭环”仅有代码接入或测试依据，不能视作真实桌面、权限或业务验收通过。正式发布仍未完成。最新根项目全量测试退出码为 1，报告 24 个失败测试，涉及本地容器、插件镜像与发布元数据、权限、迁移版本、模型用量等；不能用局部绿色结果替代全量发布门禁。

### 扫描服务专项排障（2026-09-05）

- 根因：扫描任务领取依赖 `callback.capable`，而首次有效回调又依赖任务先被领取，形成冷启动死锁。修复仅开放满足依赖、病毒库、EICAR 和签名配置条件的任务执行；健康标记仍要求真实回调被 API 接受，素材放行仍要求验签与事件/对象绑定。
- 回归：先复现首次领取断言失败，再修复；专项 109 项通过，Worker 范围 263 项通过、1 项跳过，根项目构建退出码 0。新增生命周期测试使用模拟回调状态，不是线上回调证据。
- 部署：通过本地 SSH 构建扫描镜像，只更新 `worker-scan`。随后发现 Compose 未指定根目录 `.env`，导致扫描私钥缺失；显式 `--env-file .env` 后恢复启动。任务开始领取后暴露 API 可信公钥未加载，已用同样参数仅更新 `api` 配置。未删除业务数据，未手动完成任务，未绕过签名。
- 固定验证目标：素材 `asset_368a5c9a-8135-400e-be5e-972322d8c0e2`，事件 `evt_95ae47d7-4c79-4c82-bdbd-15cdb4c81773`，租户 `ws_demo`。网关将测试身份映射至该租户，本次不构成多租户隔离证据。
- 线上复验通过（13:39 北京时间）：该事件 `published_at=2026-09-05T05:38:36.081Z`；公开 `/api/mcp` 的 `asset.list` 返回该素材 `scanStatus=clean`；扫描 heartbeat `ready=true`、`callback.capable=true`、`lastAcceptedAt=2026-09-05T05:38:36.079Z`、backlog=0、deadLetter=0，容器 healthy。素材解析和权益仍 pending，不算素材全流程完成。事件保留之前重试的 `last_error`，不能仅据这一历史字段判断当前失败。
- 运维约束：从项目根运行 `docker compose --env-file .env -f infra/local/docker-compose.yml -f infra/local/docker-compose.ecs-pilot.yml ...`；服务定向更新使用 `up -d --no-deps <service>`，避免不必要的依赖重建。此为 ECS 测试配置，不是生产配置。
- 发布探针复核：`/healthz`、`/api/healthz`、`/api/readyz` 返回 200，但 `/api/releasez` 返回 `ready=false`，且 `release_id`、`release_git_sha`、`manifest_sha256`、`image_set_digest` 均为空。故“服务健康”不等于“允许发布”，当前线上仍未通过发布门禁。
- 质量门禁修复：仓库当前迁移链已到 162、桥接工具实际为 140；同步 `release-metadata.json` 和迁移基线测试后，发布元数据/操作脚本/迁移专项 47 项全部通过。该修复只校准真实仓库基线，不代表 ECS 已注入正式发布元数据。
- 本机发布诊断（`npx tsx scripts/dev-doctor.ts --json`，2026-09-05）：22 pass、20 warn、11 fail。失败项包括本机 API/API replica、Redis、UI、Ops UI 和多个 worker 健康状态；同时缺少宿主 ChatGPT/插件 endpoint 合同、模型中转用量成本证据和 Codex App 503 恢复证据。该诊断运行在本机 Compose，不替代远程 ECS 证据，但明确说明本地验收环境也未达到发布门禁。
- ECS pilot 发布身份已补齐并经公网网关复核：`/api/releasez` 返回 `ready=true`，`release_id=pilot-20260905`，release SHA、Compose manifest 摘要和实际镜像集合摘要均非空；`/api/healthz`、`/api/readyz` 返回 200。该文件 `infra/local/docker-compose.ecs-pilot-release.yml` 只用于 pilot，且 API 与 replica 都注入，避免网关切到 replica 后元数据丢失；仍不等价于生产 Kubernetes 发布。
- 公网 MCP 鉴权修复并复验：此前 `/api/mcp` 经 UI 代理会把 platform token 降级成 `workspace_admin_demo`；新增 pilot gateway `/api/` 直连 API 并透传 Authorization、workspace、workbench 头后，`pilot-local-token` 实际返回 `actor_demo`、`workbench=platform`，`ops.commercial.access.summary` 成功；`workspace-local-token` 在 platform workbench 下被拒绝。新增网关回归测试 34 项通过。
- 后续回归分类：远程 ECS 当前所有容器均 healthy；本机 Docker 测试失败主要来自本机 Redis/API/Worker 状态，不可替代远程证据。插件桥接测试已按当前“候选需人工审核、返回 download_urls”契约修正，85 项通过。仍有 API 安全测试对 `COMMERCIAL_OPERATION_DISABLED` 与旧 `FORBIDDEN/AUTHZ_SCOPE_MISMATCH` 断言不一致，需先决定并统一商业能力门禁与授权检查顺序，不能简单删断言。
- 安全契约推进：商品主图生成现在要求品牌 `editor` 权限；已识别但角色不足的商品返回 `FORBIDDEN/AUTHZ_SCOPE_MISMATCH` 并附 `required_role`，不可见商品继续用 `PRODUCT_NOT_FOUND` 反枚举。安全测试仍有后续场景在商业门禁与隐藏对象错误契约之间不一致，尚未宣称通过。
- 安全回归已收敛：新增任务-商品、任务-内容版本组合范围校验，分别返回 `TASK_PRODUCT_SCOPE_MISMATCH` / `TASK_CONTENT_SCOPE_MISMATCH`，在商业门禁前拒绝跨资源组合；API security e2e 当前 67/67 通过。测试日志仍有一个预期的内存告警仓储噪声 `OPERATIONAL_ALERT_NOT_FOUND`，不影响断言通过，需后续单独治理日志质量。
- 发布前联合回归：运营后台、API 安全、Bridge、操作脚本、迁移和 release metadata 共 92 个测试文件、688 个测试全部通过。公网 ECS 复核仍为 `/api/healthz=200`、`/api/readyz=200`、`/api/releasez=200 ready=true`，且 14 个容器 healthy；这证明 pilot 当前稳定，不替代正式生产证据。
- 公网 ChatGPT/MCP 协议验收：workspace token 的 `tools/list` 返回工具清单，`tools/call merchant.first_value`（示例只读场景）返回结构化内容且无错误；platform token 在 workspace workbench 请求下被 `AUTHZ_WORKBENCH_FORBIDDEN` 拒绝。插件入口、MCP 契约和权限边界已形成可观测证据，但真实 ChatGPT 宿主安装/调用和生产身份提供方仍未验收。
- 规则审计入口已补齐：`RulesPage` 接入 `WorkspaceRuleAuditPanel`，调用 `ops.rules.workspace.audit`，明确只读、输入 `pack_id`、显示成功/失败状态；运营后台全量前端测试 87 个文件、488 项通过。该结果证明组件和契约接线，不替代 ECS 登录后的真实规则包验收。
- SSH 复核发现一个发布运维陷阱：直接使用三份 Compose 文件而未在 shell 注入 `PILOT_RELEASE_GIT_SHA`、`PILOT_RELEASE_MANIFEST_SHA256`、`PILOT_RELEASE_IMAGE_SET_DIGEST` 会被 Compose 的 required-variable 校验拒绝；按发布身份注入后远程 `ps` 显示 14 个容器 healthy，`/api/releasez` 返回 `ready=true`。这不是业务故障，但部署脚本/运行手册必须把发布身份注入作为必需步骤，避免“线上已运行但无法复现 compose 查询/更新”的误操作。
- 已新增 `infra/scripts/pilot-compose-preflight.sh`：在任何 pilot Compose 操作前强制检查三个 release identity 变量，并执行三份 Compose 文件的 `config --quiet` 解析；脚本语法检查和 `git diff --check` 已通过。
- 远程复验：脚本已同步至 `/opt/merchant-deploy/infra/scripts/pilot-compose-preflight.sh`，使用当前 pilot release identity 在 ECS SSH 执行成功，输出 `pilot compose preflight passed: release identity and compose configuration are valid`；未重建或停止业务容器。
- 本机 release gate 的 503 根因已定位并修复：`local-redis-1` 的 `appendonly.aof.85.incr.aof` 存在损坏尾部，Redis 因此循环重启，API 返回 `REDIS_UNAVAILABLE`；同时 API 日志记录过 PostgreSQL `No space left on device`。已先在 Redis 数据卷内创建 `redis-aof-pre-repair-20260905.tar.gz` 备份，再用 `redis-check-aof --fix` 截断到最后有效记录，未删除业务数据库或 Docker 卷。Redis 恢复 healthy，`/healthz=200`，`tests/local-docker-release-gate.test.ts` 2/2 通过；本机仍是 fixture 模式，不构成生产证据。
- 完整 `npm run test:release-gates` 已复验通过：112 个测试文件、530 项通过、9 项按设计跳过；这只证明仓库发布门禁，不替代真实生产平台/支付/宿主 canary。
- 在本机门禁通过后再次远程复核 ECS pilot：`/api/healthz=200`、`/api/readyz=200`、`/api/releasez=200` 且 release `ready=true`；本地与远程状态均稳定。
- 真实 ChatGPT.app 宿主复核尝试：Computer Use 原生管道启动失败（`Sky Computer Use native pipe startup failed`），因此本轮没有产生宿主 UI 的插件安装、工具发现或对话调用证据；不能把公网 MCP 协议验收替代为 ChatGPT.app 验收，仍保持该上线阻断项。

当前后台已经具备 13 个导航域：概览、用户、成员、支持、事件、任务、店铺、规则、模型、Feature Flags、存储、财务、审计。后端契约登记了 107 个 `ops.*` MCP 方法。静态交叉检查发现 18 个方法没有被运营前端以字面量直接引用；这不是“18 个功能都缺失”，因为动态 dispatch、客户端常量和间接 hook 会被静态扫描漏掉，清单必须结合真实调用和页面验收复核。

最新静态扫描（`npm run audit:ops-surface`）为 107 个契约方法、105 个前端字面量引用、2 个未直接引用方法：`ops.data.delete.approve`、`ops.data.delete.cancel`；但进一步核对发现删除审批通过 `useOpsConsoleModel` 的动态 dispatch，且前端决策测试与 API/MCP 双租户 e2e 均通过（2 个文件、6 项）。因此这两项不再列为“未对接”，而列为“动态接线、待 ECS 真实页面验收”；静态结果只用于盘点，不作为功能完成证据。

线上证据：ECS API、UI、运营 UI、Postgres、Redis、ClamAV、网关和大部分 Worker 已运行；扫描 Worker 依赖测试环境回执密钥，配置缺失时会 fail-closed。当前发布仍需完成 Worker 稳定性、后台真实登录/权限、每个域的 API 成功态和写操作验收。

## 缺口矩阵

| 优先级 | 能力/接口 | 当前证据 | 判断 | 需要补齐 |
|---|---|---|---|---|
| P0 | `ops.canonical.backfill.get/pause/resume/run` | `StoresPage` 已接入冲突扫描；API 有完整 handler、平台权限和契约/RBAC 测试；运行批次控制仍未形成独立前端操作面 | API/冲突处理闭环已实现，批次控制 UI 部分缺失 | 增加批次列表/详情、暂停/恢复/执行按钮，并在 ECS 做一次真实 dry-run 与审计验收 |
| P0 | `ops.commercial.points.adjust.propose/decide` | API 有双阶段 handler、独立 capability 和 e2e/security 测试；运营前端未发现 proposal/decision 操作入口 | 后端闭环已实现，后台操作面缺失 | 增加待审批列表、提议/审批详情、双人身份校验、余额前后快照和证据展示 |
| P0 | `ops.data.delete.approve/cancel` | API 有独立 handler、双审批/权限/审计 e2e；静态扫描只能看到动态决策调用 | 后端与动态前端闭环已存在，仍需桌面真实验收 | ECS 验收审批后状态、冲突和证据导出 |
| P0 | `ops.marketing.image.archive.audit/billing.audit` | 营销治理区已接入归档审计和按 job 的计费审计；结果只读展示，不自动修复/扣费 | 最小审计闭环已实现，仍需 ECS 真实 job/workspace 验收 | 线上验证归档缺口、Provider/ledger/usage 账务缺口和审计事件 |
| P0 | `ops.rules.workspace.audit` | 契约存在，前端无直接引用 | 规则发布后无法从后台核验 | 规则版本、命中率、发布证据、回滚门禁 |
| P1 | `ops.commercial.service-allocation.create` | 财务页履约面板已接入快照 ID、服务类型、单位、数量、checksum 和审计原因；客户端固定 `expected_revision=0` 并附幂等/evidence | 最小操作闭环已实现，仍需 ECS 真实 workspace 验收 | 线上执行成功/拒绝/重复提交/审计证据验收 |
| P1 | `ops.commercial.service-fulfillment.schedule/start/complete/adjust` | 财务页已接入四个动作；表单要求 allocation、revision、reason，完成/调整要求数量，客户端统一附带幂等键/evidence | 最小操作闭环已实现，仍需 ECS 真实 workspace 验收 | 线上执行成功/拒绝/409/审计证据验收；禁止未提供证据的“完成” |
| P1 | `ops.commercial.access-blocks.list` | 商业运营 hook 已有引用 | 需验证真实 API 数据和空态 | 阻断原因、恢复动作、证据链 |
| P1 | `ops.incident.get` | API handler 和服务端测试存在，运营前端主要使用列表/时间线投影，未直接接详情 RPC | 后端已实现，详情深链入口缺失 | 接 incident_id 详情抽屉并核对列表/详情一致性 |
| P1 | `ops.feature-flag.evaluate` | API handler、授权边界和服务测试存在，前端未接评估入口 | 后端已实现，线上评估结果仍是信息孤岛 | 按 workspace/用户评估、命中解释和环境显示 |
| P1 | `ops.commercial.model-markup.get/update` | `ModelsPage`/`ModelMarkupPanel` 已接入读写，API 有 revision、权限和 e2e/security 测试 | 已闭环；仍缺真实 ECS 写入验收 | 线上以测试 workspace 做一次读/乐观锁拒绝/回滚证据验收 |
| P1 | `ops.marketing.image.reconcile` | 契约存在且可能在其他文件间接引用 | 需确认页面和队列闭环 | 对账运行、差异列表、重试 |
| P2 | `ops.marketing.* retry/acknowledge/assign` | 运营队列相关能力较多 | 需验证是否只读队列 | 任务动作、负责人、重试上限、死信 |
| P2 | `ops.commercial.export` | 契约存在 | 商业数据导出闭环未证实 | 异步导出、权限、脱敏、下载审计 |
| P2 | `ops.authorization.*` | 契约能力较完整 | 后台页面入口与实际角色矩阵需核对 | 授权矩阵、变更审批、回滚 |
| P2 | `ops.user.risk.transition/session.revoke` | 契约存在 | 用户风控动作是否可见待验收 | 风险状态、会话撤销、原因审计 |

## 信息孤岛

1. 商业账务：订单、权益、点数账本、模型用量、服务履约分散在多个 MCP 方法，缺少统一的“workspace 商业时间线”。
2. 营销执行：队列、图片审核、扫描、生成、发布、计费对账之间缺少统一 operation_id/trace 视图。
3. 规则治理：规则、发布、命中、异常和回滚证据没有统一工作台入口。
4. 数据删除：删除申请列表与批准/取消动作未形成可验证的生命周期页面。
5. 交付门禁：`delivery-readiness` 是 REST 入口，但后台只读展示不能替代完整发布阻断证据。

## 上线阻断项

- 任何缺失真实配置的模型、扫描、支付或连接器能力必须在后台显示为阻断，不能显示“成功”。
- 每个写操作必须有 capability、幂等键、审计事件和失败证据。
- 线上必须验证 workspace/platform 两种 scope 的隔离，而不是只跑静态测试。
- Worker 全部 healthy 后，仍需用真实 ECS IP 验收页面、API、MCP 和关键写操作。

## 最新线上取证（ECS 47.114.34.122）

- API、运营 UI、UI、网关、Postgres、Redis、ClamAV 和 5 个业务 Worker 已健康。
- 扫描 Worker 的数据库/API/Redis/ClamAV/EICAR 检查均通过，但 heartbeat 的 `callback.capable=false`，容器保持 `unhealthy`。
- 测试私钥与 API 侧公钥指纹已核对一致；但尚未产生被 API 接受的真实扫描回执，heartbeat 的 `lastCallbackAcceptedAt` 为空，因此 `callback.capable=false`。该状态必须保持阻断，不能把扫描能力标记为 ready。
