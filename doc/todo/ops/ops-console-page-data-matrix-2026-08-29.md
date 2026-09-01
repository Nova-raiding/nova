# 运营后台页面数据验收矩阵（2026-08-29）

本矩阵记录运营后台每个页面的真实数据来源、空数据语义和可恢复路径。页面不使用业务 mock；未配置 API、工作区或持久化仓储时必须显示“未取得/配置阻断”，不能伪装成零金额或真实空列表。

> 最新复测修订（2026-08-29）：Local Compose 已提供独立 `ops-ui`（`18082`）并使用显式 `local` 构建模式；`ws_demo` fixture 已覆盖工作区、成员、商业配置、订阅、六平台设置、商品、任务、规则、告警、审计、客服、事故、账务和模型用量等运营页数据。下文较早的静态审计段落保留为历史记录，不能覆盖本段及最终运行态 QA 结论。

| 页面 | 真实数据链 | 空数据/未配置语义 | 主要验证 |
| --- | --- | --- | --- |
| 总览 | `workspaces`、`ops_workspace_summaries`、usage ledger、告警、readiness | 空工作区可为空；未授权显示配置阻断 | 桌面/375px、无 console error |
| 用户与租户 | identity、auth session、member persistence | 无治理对象显示真实空态 | 页面导航与筛选 |
| 成员与权限 | `workspace_members`、operation audit | 未取得工作区不显示“没有成员” | RBAC、邀请/停用门禁 |
| 客服与 CRM | support tickets/events | 缺工作区或加载失败显示未取得并禁用创建 | 空态、错误、重试、404 |
| 事故中心 | incidents/timeline/idempotency | 无事故与加载失败分开 | 列表、详情、时间线 |
| 任务与内容 | products、tasks、content、generation/publish、campaign | 队列为空与 API 失败分开 | 过滤、治理、重试 |
| 租户与店铺 | platform accounts、brands、bindings、sync、automation | 无店铺是可解释空态；写操作受授权门禁 | 店铺范围切换 |
| 平台规则 | rule packs、audit、media specs | 未加载不显示“已同步” | 同步状态与详情 |
| 模型服务 | model usage/budget/markup/action ledger | provider 配置不等于 ready；失败不显示加载中 | readiness 阻断 |
| 功能开关 | flags、targets、events | 空列表与未取得分开；未授权禁用创建 | 全局 flag 权限 |
| 账务与退款 | billing orders/transactions、subscriptions、offers、usage | finance repository 未配置返回可诊断错误，不伪造 ¥0 | 搜索、导出、退款门禁 |
| 审计中心 | operation/rule/incident/support audit 聚合 | 无记录与加载失败分开 | 脱敏、筛选、详情 |

## 状态契约

- `loading`：展示加载反馈，并通过 `role=status`/`aria-live` 告知辅助技术。
- `ready`：展示 API 返回的真实记录，即使记录数组为空也不能补造业务数据。
- `empty`：说明“当前没有记录”并给出下一步；不等同于 API/权限错误。
- `error`：显示 request/trace 诊断、下一步和具名重试；表单写操作在配置失败时禁用。

## 最终运行链与 CodeGraph 审计（2026-08-29）

### 结论

**生产环境仍为 NO-GO，本地运营后台已达到可用。** Local Compose 已补齐独立 `ops-ui`、宿主端口 `18082`、同源 `/api` Nginx proxy，并由显式 `VITE_OPS_AUTH_MODE=local` 让 production bundle 使用本地 Bearer pilot token；生产 bundle 仍强制 OIDC。当前 `18082 → /api → API` 认证和数据链路已闭环。

### `18082 → /api → API → repository → seed` 调用图

```text
browser http://127.0.0.1:18082
  -> Compose ops-ui, host 18082 -> container nginx 8080
  -> static bundle VITE_API_BASE=/api
  -> opsClient.rpc(method)
  -> POST /api/mcp + x-workspace-id
  -> Ops nginx location /api/, strip prefix through trailing-slash proxy_pass
  -> OPS_API_UPSTREAM=http://api:8787
  -> API POST /mcp
  -> authenticate(req)
       local Compose API expects Authorization: Bearer pilot-local-token
       local Compose bundle uses local Bearer token; production bundle uses OIDC
       => local chain continues with authenticated MCP request
  -> [only after authentication] MCP method switch
  -> persistence adapter / PostgreSQL repository
  -> PostgreSQL rows initialized by migrations + Local Compose seed
```

CodeGraph 找到 `opsClient.rpc` 的 22 个真实调用方，来自 `useOpsConsoleModel`、`opsDomainClients`、Marketing Queue 和 Campaign Lifecycle 等路径；`useOpsConsoleModel` 由 `OpsConsoleController` 调用。代表性后端链如下：

| 客户端方法 | API handler | 持久化 caller | Seed 后结果 |
| --- | --- | --- | --- |
| `ops.workspaces.list` | `server.ts` method switch | `persistence.listWorkspaceSummaries()`；当前实现是在 API persistence adapter 中执行 workspace/commercial/subscription/member 聚合 SQL | `ws_demo` 可返回一行，商业字段使用查询中的安全默认值，成员数为 2 |
| `ops.members.list` | `server.ts` method switch | `PostgresMembersRepository.list(workspaceId)` | 返回 `actor_demo`、`support_demo` 两条成员记录 |
| `ops.support.tickets.list` | support handler | `PostgresSupportRepository.list(...)` | Local seed 有 1 条 fixture 工单；生产需真实客服数据 |
| `ops.incidents.list` | incidents handler | `PostgresIncidentRepository` | Local seed 有 1 条 fixture 事故；生产需真实事故数据 |
| `ops.finance.search` | finance handler | `PostgresFinanceSearchRepository` | Local seed 有充值/模型用量 fixture；支付与结算仍需生产 provider evidence |
| `ops.audit.list` | audit handler | `PostgresAuditCenterRepository` | Local seed 有运营审计 fixture；生产需真实审计采集 |
| `workspace.health` | workspace health handler | 多个 persistence repository 与 runtime readiness 聚合 | 可证明本地 Postgres/API 配置状态，不能证明平台、模型、支付等生产依赖 ready |

`PostgresOpsDataRepository` 及 `ops_workspace_summaries` view 有独立实现和测试；当前 `ops.workspaces.list` 已通过 API persistence 的 `opsData` caller 进入该共享类，避免重复 inline 聚合 SQL。

### 本地 fixture 与生产 evidence 边界

- `infra/local/seed-demo.sql` 是 Local Compose 专用 fixture。它写入持久化 PostgreSQL，因此数据是“真实数据库行”，但 provenance 仍是 fixture，绝不是生产 evidence。
- Local seed 包含 `ws_demo`、`actor_demo`（`platform_ops`）、`support_demo`（`support`）及各运营页面的最小 fixture 集；这些行用于本地联调和空/错/重试路径验证，绝不构成生产 evidence。
- `ops.workspaces.list` 与 `ops.members.list` 的非空结果属于 seed 覆盖；其他页面的空结果只证明空库语义。它们不能证明生产数据同步、权限目录、财务结算、事故响应或审计采集可用。
- 生产部署清单不加载 `seed-demo.sql`。生产 evidence 必须来自真实环境、真实身份会话和真实持久化记录，并绑定 request/trace、环境、时间与发布版本。
- 本次已启动 Compose，并通过 gstack browse 和直接 MCP 请求完成本地运行态复核；生产结论仍不能由本地 fixture 替代。

### API base、Nginx、CORS 与认证

- Compose 将 `OPS_CONSOLE_BUILD_MODE=local`、`VITE_API_BASE=/api`、`VITE_OPS_AUTH_MODE=local` 传给镜像，并发布 `18082:8080`。Ops Nginx 将 `/api/` 代理到 `http://api:8787/`，所以网络和默认 API base 配置已闭环。
- 镜像执行普通 `vite build` 时 `import.meta.env.PROD=true`，但 `resolveManagedOpsSession()` 优先读取显式 `VITE_OPS_AUTH_MODE`；Local Compose 因此使用 local Bearer 配置，生产构建使用 managed OIDC session。
- Local Compose API 通过 `API_AUTH_TOKENS` 接受本地 pilot token；Nginx 只透传浏览器 Authorization，不注入 token。Ops 镜像已显式使用 `VITE_OPS_AUTH_MODE=local`，最终运行态 `/api/mcp` 返回 200。生产镜像仍强制 OIDC，不得复用本地 token。
- 同源 `/api` 正常路径不依赖浏览器 CORS；Compose 同时配置 loopback `ALLOWED_ORIGINS`，便于直接 API 联调，但页面验收使用同源代理。
- 生产 Kubernetes 目标链使用 OIDC。API 要求网关注入带请求体摘要、时间窗和一次性 nonce 的签名 `x-oidc-*` 断言；基础 Ingress/Deployment 清单仍不足以证明真实 SSO gateway、cookie 和签名 trust 已闭环。

### 当前剩余 NO-GO（生产环境）

| 优先级 | 未闭环项 | 关闭所需证据 |
| --- | --- | --- |
| P0 | Local Compose 认证链 | 已关闭：local bundle + Bearer API + 浏览器 `/api/mcp` 200；生产仍需真实 OIDC evidence |
| P0 | 生产 OIDC gateway 注入和 trust 无真实证据 | 真实登录、签名断言、nonce 重放拒绝及 `/mcp` 2xx/401/403 evidence |
| P0 | 生产外部依赖未验证 | 真实 workspace/token、平台 OAuth、支付、对象存储/KMS、PITR、容量、故障和 on-call evidence |
| P1 | 生产真实数据逐页验收 | 使用真实身份、真实 workspace 和真实数据完成 12 页面验收；本地 fixture 仅证明联调链路 |
| P1 | Local seed 与生产数据边界 | 已关闭本地联调覆盖；生产仍需受控真实数据逐页验收，生产禁止 seed |
| P1 | 未连接状态仍需浏览器矩阵确认 | 对无 workspace、401、403、仓储不可用和空库执行 12 页面浏览器验证，避免把未取得呈现为真实空数据 |

### CodeGraph 命令证据

本次执行 CodeGraph 只读分析，并对业务实现、测试与文档完成闭环验证。

- `codegraph sync .`：退出码 `0`，索引为最新。
- `codegraph status .`：退出码 `0`；`652 files`、`9,608 nodes`、`40,325 edges`，索引为最新。
- `codegraph affected infra/local/seed-demo.sql infra/local/docker-compose.yml infra/nginx/ops-console.conf infra/docker/ops-console.Dockerfile apps/ops-console/src/api/opsClient.ts apps/ops-console/src/hooks/useOpsConsoleModel.ts apps/api/src/server.ts packages/persistence/src/repository.ts packages/persistence/src/members-repository.ts packages/persistence/src/support-repository.ts packages/persistence/src/incidents-repository.ts packages/persistence/src/finance-search-repository.ts packages/persistence/src/audit-center-repository.ts`：退出码 `0`，识别 `291` 个受影响测试文件。该数字是应回归影响面，不是通过数。
- 三次 `codegraph explore` 均退出码 `0`，分别审计 Ops 网络/RPC/PostgreSQL、workspace/seed、support/incidents/finance/audit repository 路径。
- 代表性受影响测试包括 `tests/local-compose-ops-ui.test.ts`、`opsClient.test.ts`、`opsDomainClients.test.ts`、`ops-integration.test.ts`、各 Ops repository test、migration release PostgreSQL tests 和 Ops browser dogfood specs。

最终本地运行态已证明认证后的 `/mcp` 可返回 200 并可渲染各页面；静态 Nginx healthcheck、配置测试或本地 fixture 仍不能证明生产 `/mcp`、真实数据和外部依赖可用。在取得上述 P0 evidence 前，生产发布结论保持 **NO-GO**。

### 2026-08-31 无凭据桌面运行态复核

Compose Chrome 1280px 无本地凭据验收已补齐：`ops.spec.js` 无凭据用例 1/1 通过。真实界面显示“权限未验证”和总览 403 阻断，不渲染业务数据、不发起 `/api/mcp` 请求；连接诊断默认折叠，点击后可显式打开配置表单。该证据闭合 local no-credentials 的桌面 fail-closed 语义；401、仓储不可用、生产真实身份和 12 页面逐页真实数据验收仍未闭合，因此 P1 项不迁移到 `doc/done`。

### 2026-08-31 401 会话门禁复核

Ops Console 1280px Chrome 路由级 401 验收 1/1 通过：`ops.session` 仅请求一次，页面显示“无法验证运营权限”和可执行的“重试权限验证”，认证错误不再重复显示为全局数据刷新告警；业务页面与动作保持拒绝。无凭据与 401 两种本地 fail-closed 证据均已补齐，但仓储不可用、生产 OIDC/真实身份和 12 页面真实数据验收仍未完成，整体 P1/生产门禁不迁移。

### 最终运行态复核

- 12 个页面均有对应 API handler/repository 链路，Local Compose 通过同源 `/api` 代理访问 API。
- 1440px 与 375px 两种视口下 12/12 路由均通过，`document.scrollWidth` 等于视口宽度；Finance 宽表仅在局部容器内滚动。
- CodeGraph 最终状态：`635 files / 9,401 nodes / 39,555 edges`，索引为最新。
- 全量质量门禁：`254 passed, 7 skipped` test files；`1,689 passed, 15 skipped` tests；类型检查、Ops build、Docker build 均通过。

## 权威后续复核（2026-08-29）

旧数字为历史快照；当前批次最终证据：API/Ops UI Docker 构建成功，CodeGraph `652 files / 9,608 nodes / 40,325 edges` 且索引最新；全量测试 `261 passed, 8 skipped` test files、`1,736 passed, 16 skipped` tests，类型检查通过；门店、规则、Feature Flags、交付证据及本地运营队列完成 API/UI 回归。生产外部 evidence 仍需真实环境补齐。
