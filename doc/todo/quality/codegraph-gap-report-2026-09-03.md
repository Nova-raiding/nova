# CodeGraph 部署与生产 Gap 报表

日期：2026-09-03

## 图谱基线

- CodeGraph 已同步：`1,133 files / 15,884 nodes / 60,328 edges`。
- OIDC 主链路：本地 `local-oidc-gateway` 生成签名身份断言，API 在 `server.ts` 校验 issuer、subject、session、workspace、workbench、roles、amr、timestamp、nonce、body digest 和 signature。
- 运营前端链路：`OpsHeader`/`opsClient` 在 managed session 下使用 cookie，不把 token 注入前端；本地 bearer 仅用于开发模式。
- 实际运行面：Docker Compose 中 API、Ops UI、Postgres、Redis、六类 Worker 和 ClamAV 均 healthy。
- Kubernetes 结论：本机无 `kubectl`、无可用 cluster context；`infra/kubernetes` 是发布模板、Secret contract 和 release gate，不是当前运行时依赖。不得删除这些文件，除非另行决定取消 Kubernetes 发布目标。

## 已完成并有证据

- OIDC gateway 本地登录、CSRF、短期 session、签名代理和 workbench 隔离：`72/72` 测试通过。
- 全量 Vitest：`597 passed / 42 skipped` 文件，`4053 passed / 64 skipped` 测试。
- 桌面浏览器验收：`29 passed / 1 skipped`。
- 发布门禁：`112 passed / 3 skipped` 文件，`527 passed / 9 skipped` 测试。
- 真实 ClamAV worker 回调：`5/5` 通过；本地 Compose 公钥已能被 API 正确解析。
- DB/RLS 本地检查、迁移尾、容器健康和 API/Ops UI health/ready 检查通过。

## 当前 Gap 分类

### A. 代码链路

CodeGraph 未发现 OIDC 主链路缺失的代码断点。当前不应为 OIDC 继续新增业务登录代码；新增 provider SDK 或前端 token 逻辑会偏离现有安全边界。

### B. 当前部署配置缺口

| Gap | 现状 | 所需动作 |
|---|---|---|
| 生产 rendered config | 当前 shell 没有 `PRODUCTION_CONFIG_PATH`，仓库只有示例和校验器 | 在实际服务器生成受控生产配置并导出路径 |
| 插件 Bridge | `MERCHANT_MCP_BASE_URL` 和生产 `MERCHANT_MCP_TOKEN` 未进入当前部署进程 | 在 Secret Manager/部署服务注入，不写入插件或镜像 |
| OIDC provider | 当前只有 loopback 本地 IdP fixture | 接入真实 IdP 的 issuer、client ID、client secret、回调和角色映射 |
| OIDC signing secret | 本地已配置；生产 Secret 未证明注入 | gateway/API 使用同一生产 secret，独立于 session hash secret |
| 生产运行面 | 当前是 local Compose，`mode=fixture`、writes disabled | 用实际服务器的 Compose + reverse proxy + OIDC gateway 配置生产 profile |

### C. 外部真实证据阻断

以下由 production doctor 报告为失败，不能通过本地测试或文档勾选替代：

- 支付 provider、HTTPS endpoint、验签、防重、退款和对账。
- 六个平台官方 OAuth、回调、credential provider、read/write canary。
- 五模态 relay 的真实鉴权、provider request ID、usage、cost、503/recovery evidence。
- 云对象存储、KMS、版本/保留和扫描证据。
- 生产告警 webhook/secret 和真实投递。
- 可执行 catalog、财务批准费率。
- 生产 release metadata、镜像 digest、迁移版本、capacity/canary。
- ChatGPT/Codex App host 的真实 503 error recovery evidence。
- 生产 Postgres 双角色/RLS、JIT 撤销竞态、不可变 audit sink 和 OIDC 多角色浏览器矩阵。

## TODO 对账

- 当前 `doc/todo` 未勾选清单：`61` 项，分布在 `9` 个文件。
- 其中技术方案文档的两项是应用权限审批证据和六平台 OAuth 正常/拒绝/过期/撤权证据。
- 其余未勾选项主要是生产环境、审计、容量、发布和 provider 证据；未发现可以仅凭当前本地测试安全关闭的生产门禁。

## 部署决策

当前推荐部署拓扑：

```text
ops.yxsona.com
  -> Nginx/Caddy
  -> OIDC gateway
  -> Docker Compose ops-ui/API
  -> Postgres/Redis/Workers
```

Kubernetes 不是当前服务器的活动部署目标，但现有 Kubernetes manifests 仍被 release gate 校验，应保留为备用/发布契约，或在明确取消该目标后单独清理。

## 当前结论

本地代码和 Compose 运行链路已通过；生产上线仍为 `NO-GO`。下一步不是继续修改 OIDC 业务代码，而是在实际服务器上绑定真实 IdP、Secret Manager、reverse proxy 和 rendered production config，然后运行：

```bash
PRODUCTION_CONFIG_PATH=/secure/rendered-production.yaml \
npm run infra:launch-preflight
```


## 2026-09-03 latest verification

- CodeGraph was re-synced after local configuration changes. No pending source dependency change remains relevant to the OIDC path; the remaining pending index entry is a non-code environment artifact.
- Canonical production merchant origin is already present in checked-in release templates as `https://yxsona.com`; Ops origin is `https://ops.yxsona.com`. The current local shell does not contain `MERCHANT_MCP_BASE_URL` or `MERCHANT_MCP_TOKEN`, so plugin bridge readiness correctly remains blocked.
- Kubernetes is not active on this host: `kubectl` is unavailable and all live services are Docker Compose containers. Kubernetes manifests remain release-contract inputs only.
- Latest production doctor remains `38 pass / 1 warn / 14 fail`; local Compose services are healthy, but production configuration/evidence gates remain fail-closed.

## Merge status

- The current worktree contains the implemented code/config/report updates and all verification evidence above.
- A commit/merge has not been claimed as complete without a repository integration operation and review of the other worktrees. The requested merge deliverable therefore remains open; no other worktree changes were overwritten.

## CodeGraph 影响面补充

本轮对 API、运营后台、worker、插件桥接入口执行 `codegraph affected`，返回 89 个受影响测试文件。影响面覆盖：

- 插件/MCP 桥接与真实中转链路
- API 鉴权、租户隔离、RLS、账务和模型调用
- 运营后台登录、RBAC、用户、商品、订单、财务和审计
- worker、资产扫描、Redis、数据库迁移和发布门禁
- 桌面浏览器验收与生产配置契约

这证明代码依赖图已经连接到测试面，但不等同于 89 个测试都代表生产环境已验收。生产门禁仍以真实 OIDC、MCP、支付、平台 OAuth、对象存储、模型用量成本、告警和发布证据为准。

## Owner 交付结论

- 代码层：当前未发现可由静态 CodeGraph 单独证明的 OIDC 主链路断点；本地 OIDC/API 安全契约已通过 72/72。
- 本地运行层：Docker Compose 服务健康，前后端、worker、Postgres、Redis、ClamAV 已有运行证据。
- 生产层：仍为 `NO-GO`，因为生产配置、真实外部凭据和线上运行证据尚未注入或尚未采集。
- TODO 层：`doc/todo` 当前仍有 61 个未勾选条目，分布于 9 个文件；外部证据型条目不能由本地测试替代。
- 仓库集成层：当前工作区的修改和报表已落地，但本轮不宣称已完成提交或合并；合并前仍需由仓库 owner 审核其他工作区变更并执行集成操作。

## 最终本地门诊核对（2026-09-03）

`node --import tsx scripts/dev-doctor.ts`：`38 pass / 15 warn / 0 fail`。

本地通过项包括 Docker Compose、API `/healthz` 与 `/readyz`、商家 UI、运营 UI、Postgres、Redis、全部 worker、ClamAV、数据库迁移尾和 FORCE RLS。15 个 warning 均为生产就绪条件，不应被本地健康状态覆盖：插件 bridge、生产配置、支付、六平台 OAuth、五模态 relay 成本证据、对象存储、scanner、alerts、production gate、可执行目录、批准费率、releasez、relay evidence、Codex App error-recovery evidence。

CodeGraph 已再次同步，当前索引为 `1,133 files / 15,884 nodes / 60,329 edges`。本报告中的结论保持：本地链路可运行，生产链路证据不足，发布状态仍为 `NO-GO`。

## TODO 文件级清单（自动统计）

| 文件 | 未完成项 |
|---|---:|
| `doc/todo/ops/ops-rbac-ui-design-2026-08-31.md` | 5 |
| `doc/todo/architecture/architecture-and-delivery-plan-9-fte.md` | 3 |
| `doc/todo/ops/ops-rbac-acceptance-plan-2026-08-31.md` | 33 |
| `doc/todo/ops/image-generation-desktop-ui-ux-audit-2026-08-31.md` | 1 |
| `doc/todo/ops/ops-rbac-architecture-2026-08-31.md` | 5 |
| `doc/todo/ops/canonical-product-desktop-ui-ux-audit-2026-08-31.md` | 1 |
| `doc/todo/data/canonical-product-prioritization-review-2026-08-31.md` | 10 |
| `doc/todo/architecture/technical-solution-design.md` | 2 |
| `doc/todo/product/PRD-engineering-review-v1.3.md` | 1 |

合计：61


## 61 条 TODO 的 owner 分层

### 可由代码与自动化验收关闭的剩余项

- canonical scope、outbox/retry/reconciliation、backfill 全量报告和 shadow replay。
- HTTP/MCP/Worker 逐方法 parity、资源 ID scope、explicit deny、obligation、双工作台切换、JIT 生命周期和审计可重建性。
- Ops 桌面工作台的三类会话截图、403/503 错误契约、JIT 到期/撤销、AntD token 和连接诊断 Drawer。
- 真实 Postgres-like 双 role/RLS probe、worker 执行前复核、容器重建和动态发布门禁报告。

### 必须由外部环境或人工提供的上线证据

- 生产 OIDC issuer/audience/nonce、受控主体、gateway/membership 一致性和应用权限审批截图/编号。
- 真实支付 provider、六平台 OAuth、对象存储/KMS、模型 relay usage/cost/error、不可变审计 sink、告警 webhook。
- 生产-like PostgreSQL role/RLS、JIT signer/revocation、跨副本一致性、canary、容量/故障/6 小时稳定性和真实 ChatGPT/Codex App error recovery。
- release ID、commit/image digest、操作者、workspace、时间、回滚和备份恢复证据。

### 不能直接勾选的条目

任何仅有本地 fixture、契约测试、容器存活或静态代码证明的生产型 TODO，继续保持未勾选；必须补齐对应真实运行证据后再关闭。

## 多 agent owner 汇总（2026-09-03）

当前 agent 配额为 6 个，已全部完成只读/定向审计；尝试再启动 6 个时返回 `agent thread limit reached`，因此未虚构 10 个 agent。owner 已核对其结果并整合代码变更。

已整合的代码修复：

- Worker 执行复核严格拒绝非字符串或空 `grant_ids`，保持 fail-closed；新增 malformed evidence 测试。
- Commercial operation registry 纳入 7 个 Worker action，并增加 runtime manifest totality 回归测试。
- Ops Sidebar 的当前操作范围补充 `role=region` 和标题关联。
- Canonical consistency UI 支持 `backfilled` 状态，显示为“已回填待核验”，不会误报为 verified。
- Canonical 冲突认领/处理增加 operation-level in-flight guard，并在请求期间禁用操作按钮。

Agent 发现且仍保持未关闭的关键 gap：

- 所有 critical Worker 的完整 enqueue → revoke → execute 持久 envelope 证据仍不足。
- production-like `merchant_app`/`merchant_ops` 双 role RLS 矩阵尚未完整闭环。
- canonical 真实 workspace 仍有 `legacy_only/conflict/blocked` 数据与 cutover/rollback 证据缺口。
- 容量基线、故障恢复、备份恢复、canary、发布 digest 和 RPO/RTO 仍缺真实环境证据。

## 桌面真实浏览器验收

全量命令 `npm run test:browser:all` 首次终态：`28 passed / 1 failed / 1 skipped`。唯一失败是运营后台品牌树场景等待 `Release QA Brand` 超时；随后用同一服务和同一测试条件单独重跑该用例，结果 `1 passed`（8.0s）。API 直接复核也返回 `Release QA Brand`、`brand_release_qa` 和目标淘宝店铺。

结论：品牌树主链路当前可用，但首次全量出现一次加载竞态，不能把全量结果记为无风险；应在后续 CI 中保留该场景并观察复现率。当前无证据证明 ChatGPT 官方生产宿主已打开或已通过，因为本环境没有交互式 ChatGPT 控制器，也没有生产插件凭据。

## 本轮最终验收记录

- `npm run typecheck`：通过。
- 定向回归：4 个文件、120 个测试通过。
- `npx playwright test dogfood/chatgpt-all-functions/ops.spec.js --workers=1`：4 个测试通过。
- `npm run test:browser:all`：29 个测试通过、1 个跳过，退出码 0。
- CodeGraph 最终同步：`1,133 files / 15,885 nodes / 60,326 edges`；本轮同步 `6 changed files`，无待处理代码变更声称。

此次浏览器验收覆盖本地桌面工作台和插件模拟入口，不覆盖 ChatGPT 官方生产宿主。由于 gstack 可执行文件和交互式 ChatGPT 浏览器控制器在当前环境不可用，不能声称完成官方宿主验收；该项继续作为外部环境 gap。

## 当前发布判定

代码级回归和本地桌面链路通过；生产发布仍为 `NO-GO`。未完成项集中在真实生产 OIDC/MCP、支付、六平台 OAuth、五模态 relay usage/cost/error、对象存储/KMS、不可变审计、容量/故障/备份恢复、canary、rollback 和 release metadata。没有生产凭据或真实运行证据时，所有相关 TODO 保持未勾选。

## 宿主打开记录（2026-09-03）

- `open -a 'Google Chrome' 'https://chatgpt.com'`：退出码 0，已请求打开 ChatGPT 官方页面。
- 本地商家端 `http://127.0.0.1:18081/` 与运营后台 `http://127.0.0.1:18082/ops/stores?workbench=workspace`：退出码 0，已请求打开。
- 当前环境没有浏览器交互控制器，无法读取 ChatGPT 页面登录态、选择插件、发送消息并逐项操作；上述记录只证明宿主打开请求成功，不证明官方 ChatGPT 插件验收完成。

## ChatGPT 宿主控制器复核（2026-09-03）

再次检查当前工具面：未暴露 in-app browser、Chromium 控制器或 ChatGPT 页面交互工具，仅有插件权限管理和网络查询接口。因此无法由本 agent 执行官方 ChatGPT 登录态读取、插件选择、消息发送、MCP 回包观察和全功能回归；不能以 `open` 命令退出码替代这些证据。该项继续作为环境阻断。

## 增量 CodeGraph 影响分析（当前 owner 工作区）

针对本轮修复的 API/Worker/Ops/registry 文件，`codegraph affected` 返回 80 个受影响测试文件，覆盖插件 bridge、Ops Console、桌面 dogfood、Worker、commercial registry、canonical backfill、Postgres RLS/授权、迁移和发布门禁。该结果已用于确定定向测试范围；80 个文件的影响关系不替代真实生产环境验收。

本轮再次尝试启动 6 个新 agent，因现有 agent thread limit 仍满而拒绝；已有 6 个 agent 结果已由 owner 核对，不重复创建线程。

## 真实本地 workspace canonical 证据（2026-09-03）

调用本地真实 API `canonical.product.consistency`（workspace=`ws_demo`、workbench=`workspace`）得到：

- `status=attention_required`
- `verified=0`
- `legacy_only=39`
- `conflict=9`
- `blocked=1`
- `findings=40`，`orphanFindings=9`
- `freshness=fresh`，但 `contractStatus=attention_required`
- `read_control.mode=legacy_shadow`，`source=default`

因此当前工作区没有任何可证明的 verified canonical 链路，不能开启 `canonical_read`，不能关闭相关 TODO，也不能进入生产发布。此前文档中的较小数量只是旧快照；本次 API 返回是当前权威状态。

## 本地 runtime backfill 修复证据（2026-09-03）

CodeGraph/日志定位到 `PostgresCanonicalBackfillConflictRepository.enqueue()` 漏写 `canonical_backfill_conflicts.status`，导致发现冲突时触发 NOT NULL 500。owner 已修复 INSERT，显式写入初始状态 `open`。

验证：

- API 镜像重建完成，容器状态 `running healthy`。
- 本地真实 `ops.canonical.backfill.create` 使用 `dry_run="true"`、`batch_limit="50"` 创建批次成功。
- 本地真实 `ops.canonical.backfill.run` 执行成功返回结构化结果，不再 `INTERNAL_ERROR`：`dryRun=true`、`creates=0`、`unchanged=1`、`conflicts=39`、`insertedIds=0`。
- 因存在 39 个 `MISSING_BRAND` 冲突，批次状态为 `failed`，这是预期的 fail-closed 结果；没有写入 canonical 商品。
- 回归测试：backfill API/冲突仓储 `13/13` 通过。

## Resumed owner audit: 2026-09-03

- CodeGraph re-check: index available with 1,133 files and 15,885 nodes.
- The canonical backfill conflict repository and its API/repository tests affect 73 test files according to CodeGraph. This confirms the SQL fix is on a high-impact persistence path, not an isolated UI change.
- `gstack` executable probe: unavailable in the current workspace/runtime. No claim of gstack browser validation is made.
- Agent execution: the six existing delegated agents have completed; further agent creation remains blocked by the session agent-thread limit. Owner review and integration remain required.
- Local runtime recheck: all 13 Docker services report `running healthy`.
- API runtime probes: `/healthz`, `/readyz`, and `/metrics` returned HTTP 200 with request/trace evidence. `/health` and `/ready` returned HTTP 401, so only the authenticated/contracted healthz endpoints are treated as valid health checks.
- Release-gate rerun: `112 passed / 3 skipped` files, `528 passed / 9 skipped` tests, exit 0 in 94.28s. The printed container-manifest failures are negative fixture assertions within passing tests, not test-run failures.
- Interpretation of relay configuration: local configuration is present and local contract tests pass; production readiness still requires runtime production evidence for real authentication, request/usage/cost/error records, redaction, timeout/retry, and fail-closed behavior.
- Latest full-suite runtime blocker: PostgreSQL WAL recovery panics with `No space left on device`; Docker marks API, Postgres, UI, and workers unhealthy. Host filesystem still has 103GiB free, while Docker reports 5.737GB reclaimable build cache and 21.86MB inactive containers. No volumes, containers, or business data were deleted.
- Local recovery and full-suite rerun: PostgreSQL was restarted without deleting volumes or data; all 13 services returned healthy. Canonical backfill API contract passed `6/6`. Full `npm test` passed `597` files, skipped `42`; `4,055` tests passed, skipped `64`, exit 0, duration 476.15s.
