# 运营后台统一权限架构 v1

日期：2026-08-31  
状态：可执行方案，尚未实施  
范围：ChatGPT 插件入口 → MCP/API → 运营后台 → PostgreSQL/RLS → Worker → 审计。运营后台仅按桌面工作台验收。

## 结论

当前系统已经有 OIDC 请求证明、活跃成员校验、租户 RLS、独立 `merchant_ops` 数据库凭据、客户数据 15 分钟临时票据、不可变审计和多处服务级权限检查。这些基础应保留。

当前不能继续在页面、hook、API switch 和各 service 中分别追加角色数组。v1 必须建立一个版本化的权限注册表作为唯一真源（SSOT），把“角色”只当作 capability 的授予模板。服务端根据平台身份、工作区成员关系、临时授权和资源范围计算最终 capability；MCP 与 HTTP 在进入业务 handler 前统一执行授权；前端只消费服务端返回的 capability 投影，不自行推导权限。

```text
OIDC/API token
    │  身份、会话、网关声明
    ▼
Principal Resolver ──► Identity/session fail-closed
    │
    ├── platform role assignments
    ├── active workspace membership
    ├── brand/resource grants
    └── temporary customer-data grant
    ▼
Authorization Engine (policy version + exact method/resource)
    ├── DENY ──► 403 + decision reason + audit
    └── ALLOW ─► tenant/control-plane repository
                    ├── merchant_app + app.workspace_id RLS
                    └── merchant_ops + bounded platform projection
    ▼
Audit decision + enqueue immutable authorization snapshot
    ▼
Worker validates workspace/resource/snapshot, then executes as system actor
```

## CodeGraph 与源码证据

CodeGraph 已同步当前工作树，索引为 783 个文件、10,934 个节点、40,772 条边。`opsNavigation.ts` 被 8 个文件使用，`useOpsConsoleModel.ts` 被 51 个文件使用，`repository.ts` 被 117 个文件使用；权限改动的真实爆炸半径覆盖 API、Ops UI、MCP 契约、迁移、Worker 和大量安全测试。`apps/api/src/server.ts` 因单文件体积未被 CodeGraph 文件读取命令索引，相关结论使用带行号源码复核；运行成功仍必须以真实 OIDC、PostgreSQL、浏览器和容器证据证明。

已核对的关键事实：

- `apps/api/src/server.ts:3931-3936` 的 `authorizedRoles()` 会根据 `memberRole` 重新过滤网关角色；只有成员角色为 `workspace_owner`、`merchant_admin` 或 `platform_ops` 时才保留非工作区 capability role。
- `apps/api/src/server.ts:4274-4286` 从数据库加载工作区成员并拒绝非 active、角色不匹配和身份绑定冲突，这是正确的 fail-closed 基础。
- `apps/api/src/server.ts:8493-8496` 的 `ops.session` 却返回原始 `principal.roles`，不是 `authorizedRoles(principal)`，也没有 permissions/scopes/policy version。
- `apps/ops-console/src/navigation/opsNavigation.ts:23-51`、`useOpsConsoleModel.ts:739-791`、`financePermissions.ts:11-21` 分别维护页面、动作和财务角色集合。
- `apps/api/src/ops/feature-flags-service.ts:11-27` 使用 `platform_admin / ops_admin / support / reviewer`；`server.ts:7429-7432` 又把 `platform_ops` 映射为 `platform_admin`，其余多数角色映射为 `member`。
- `apps/api/src/server.ts:4147-4182` 用方法前缀和一个不完整的 read 集合判定客户数据与读写；未列入 read 集合的新读方法会被误判为 write，未列入前缀/集合的新客户数据方法则可能绕过临时授权。
- `apps/api/src/server.ts:4215-4248` 的票据已绑定 actor、workspace、scope、有效期和 HMAC，最长 15 分钟并记录访问审计，但没有持久 grant 状态、撤销、审批人、工单原因、使用次数或防重放记录。
- `apps/api/src/server.ts:7560-7564` 对普通 MCP 方法先强制 active workspace member，再校验平台临时票据。纯平台客服即使有票据仍必须先成为目标租户成员，临时授权模型因此没有形成独立闭环。
- `packages/persistence/src/repository.ts:539-562` 在短事务内设置 `app.workspace_id`，能避免连接池 scope 泄漏；`server.ts:2230-2280` 在生产强制独立 `OPS_DATABASE_URL`，并把 identity、feature flags、finance search、workspace directory 与 media specs 放入 ops pool。
- `migrations/091_bind_platform_scope_to_ops_role.sql:5-54` 把平台范围同时绑定 `current_user='merchant_ops'` 和 `app.platform_scope='platform_ops'`，方向正确；但历史 migration 仍存在只检查 `app.platform_scope` 的 policy，生产必须以最终 policy probe 为准。
- MCP 契约在方案起草时声明 231 个方法；本轮并行实现后已动态增长到 240。数量相等不证明每个方法有同一授权语义，门禁必须读取实时集合。
- Worker durable envelope 以 workspace 和 event 为主，未形成统一的 `requested_by / authorization_decision_id / capability / policy_version` 授权快照。异步副作用的发起人证据依赖各 payload 自行携带，容易漂移。

## 当前矛盾与缺口

### P0

1. **会话角色投影与服务端有效角色不同**（置信度 10/10）。`ops.session` 返回原始网关角色，而 API 多数门禁使用 `authorizedRoles()`。用户可能看到可操作 UI 后持续 403；更危险的是后续代码若信任 session role，会产生权限提升。
2. **没有方法级授权 SSOT**（置信度 10/10）。全量 MCP case、HTTP 映射、导航、hook 和独立 service 各自维护 allowlist。新增功能没有强制注册策略的编译/启动门禁。
3. **平台临时客户数据访问的两道门互相冲突**（置信度 9/10）。票据授权不能替代 active membership，平台客服必须被写入租户成员表；同时 `support` 成员又可不经临时票据进入多项客户数据能力。平台职责与租户职责被混成一个 `MemberRole`。
4. **客户数据分类默认不安全**（置信度 9/10）。前缀/例外集合不是闭合清单。安全分类必须随每个 method policy 显式声明，未知 method 启动失败或请求拒绝。

### P1

5. **角色词汇分裂**（置信度 10/10）：`platform_ops`、`platform_admin`、`ops_admin`、`reviewer`、`competitor_reviewer`、`rules_admin`、`knowledge_editor` 同时存在，部分只在某一层出现。
6. **前端只有 roles，没有 capability、scope 和 denial reason**（置信度 10/10）。组件只能重复硬编码角色，无法表达“可看汇总、不可看明细”“可读、不可导出”“当前 workspace 可写、其他 workspace 不可见”。
7. **临时 grant 不能撤销和追溯审批**（置信度 9/10）。只验证签名和过期时间，无法在 15 分钟内即时撤销，也无法证明谁批准、因何工单、已使用多少次。
8. **Worker 授权证据不统一**（置信度 8/10）。异步执行按 workspace 隔离和 lease 工作，但没有统一的人类授权决策快照，无法稳定回答“谁以什么权限触发了这次外部写入”。

### P2

9. **权限变更后的缓存/长会话语义不明确**（置信度 8/10）。成员停用有请求级复核，但前端 capability 刷新、策略版本变更和已排队任务的处理规则未形成契约。
10. **跨工作区平台查询成本会随租户数增长**（置信度 8/10）。财务检索已限制 1000 workspace、并发 8，但未来权限过滤若逐 workspace/逐资源查库会出现 N+1。

## 统一权限模型

### 1. 分离四类概念

| 概念 | 例子 | 存储位置 | 规则 |
| --- | --- | --- | --- |
| 平台角色 | `platform_admin`、`ops_admin`、`support_agent`、`finance_ops`、`security_admin`、`auditor` | `platform_role_assignments` | 不写入 `workspace_members`；只能授予平台 capability 模板 |
| 工作区角色 | `workspace_owner`、`workspace_admin`、`operator`、`reviewer`、`finance`、`viewer` | `workspace_members` | 必须 active 且绑定当前 identity；只在指定 workspace 生效 |
| Capability | `workspace.member.manage`、`billing.refund.execute`、`customer.content.read` | 代码注册表 | API 判断的唯一权限单位；角色只展开成 capability |
| Grant/scope | workspace、brand、account、resource、platform aggregate、临时客户数据 | 持久 grant + 请求上下文 | capability 必须和 scope 同时匹配；默认拒绝 |

兼容期只在服务端 resolver 入口映射旧名称：`platform_ops → ops_admin`、`merchant_admin → workspace_admin`。不得在页面、service 或数据库中继续创建新的别名判断。`platform_ops` 从 `MemberRole` 中移除前，数据库迁移先把现有记录转成平台角色 assignment 或明确的 workspace `support/reviewer` 成员关系，不能静默扩大权限。

### 2. Capability 命名和风险元数据

格式：`<domain>.<resource>.<action>`。action 固定为 `read | create | update | execute | approve | export | delete | administer`。每个 capability 带以下元数据：

```ts
type CapabilityDefinition = {
  id: CapabilityId
  plane: 'tenant' | 'control'
  dataClass: 'platform_summary' | 'customer_metadata' | 'customer_content' | 'finance' | 'secret_metadata'
  risk: 'low' | 'medium' | 'high' | 'critical'
  allowedScopes: readonly ('self' | 'workspace' | 'brand' | 'account' | 'platform')[]
  requiresMfa?: boolean
  requiresReason?: boolean
  requiresApproval?: 'single' | 'dual'
  enqueueMode?: 'none' | 'authorization_snapshot' | 'fresh_at_execution'
}
```

关键 capability 基线：

| 域 | 只读 | 操作 | 高风险/审批 |
| --- | --- | --- | --- |
| 用户/租户 | `identity.read`、`workspace.directory.read` | `identity.session.revoke`、`workspace.status.update` | identity 停用/风险变更要求 MFA、reason、幂等与审计 |
| 成员 | `workspace.member.read` | `workspace.member.manage` | owner/platform role 授予为 critical，禁止停用自己/最后 owner |
| 店铺/平台 | `store.connection.read`、`platform.readiness.read` | `store.connect.execute`、`store.sync.execute` | revoke/publish 要确认、reason、资源 scope |
| 任务/内容/知识 | `customer.content.read` | `customer.content.update`、`customer.publish.execute` | 平台人员必须有持久临时 grant；普通租户按 workspace/brand ACL |
| 规则 | `rule.read` | `rule.update`、`rule.publish.approve` | publish 必须 approval evidence |
| 模型 | `model.status.read`、`model.cost.read` | `model.policy.update` | 全局 markup/budget 为 control-plane 高风险操作 |
| 功能开关 | `feature_flag.read` | `feature_flag.update` | emergency 为 critical，仅 platform_admin + MFA |
| 财务 | `billing.self.read`、`billing.workspace.read` | `billing.reconcile.execute`、`billing.refund.execute` | refund/settlement 要 reason、幂等、金额范围和审计 |
| 客服/事故 | `support.ticket.read`、`incident.read` | assign/comment/transition/commander | 客户明细需要 workspace membership 或临时 grant |
| 存储/审计 | `storage.reconciliation.read`、`audit.read` | `audit.export` | export 是独立 capability，必须有范围和条数上限 |

完整覆盖不靠手工文档维护：`MCP_METHODS` 的全量 method 和所有受保护 HTTP route 都必须在 registry 中精确映射到 capability、scope resolver、data class、read/write 和 audit requirement。CI 断言 `declared methods = registered policies = implemented handlers`，任一缺失直接失败；服务启动时再次校验并 fail-closed。

### 3. 推荐角色模板

| 角色 | 默认能力边界 |
| --- | --- |
| `platform_admin` | 平台角色/安全/紧急开关；不默认读取客户内容，不默认执行财务退款 |
| `ops_admin` | 平台汇总、配置、模型/规则/运营治理；客户明细仍需临时 grant |
| `support_agent` | 工单/事故与经授权的客户只读；写客户内容需单独 grant |
| `finance_ops` | 平台财务汇总、对账、经审批退款；无客户内容权限 |
| `security_admin` | 身份风险、会话撤销、审计；无营销内容与财务业务操作 |
| `auditor` | 脱敏审计和受限导出，只读 |
| `workspace_owner` | 当前 workspace 全部租户管理，不能授予平台角色 |
| `workspace_admin` | 当前 workspace 日常配置、成员（不含 owner）和商业配置 |
| `operator` | 店铺、商品、任务、内容、发布；无成员、退款、全局规则权限 |
| `reviewer` | 内容/视觉/规则审核，只读加审核决定；无发布与配置 |
| `finance` | 当前 workspace 账单/对账/退款，默认不读客户内容 |
| `viewer` | 当前 workspace 非敏感只读 |

显式 deny 优先于 allow。平台角色不自动继承 workspace 角色；多角色 capability 取并集，但 scope 取各 grant 的并集，critical 操作仍执行其额外条件。

## 服务端契约

### Policy Registry

建议新增 `packages/contracts/src/authz/`，包含 capability 类型、角色模板和 method policy；新增 `apps/api/src/authz/`，包含 principal resolver、authorization engine、scope resolvers 和审计适配器。业务 service 只接收不可伪造的 `AuthorizationDecision`，不再接收任意 `roles: string[]`。

```ts
type MethodPolicy = {
  method: McpMethod | HttpRouteId
  capability: CapabilityId
  scope: 'self' | 'workspace' | 'brand' | 'account' | 'platform'
  dataClass: DataClass
  effect: 'read' | 'write'
  audit: 'deny_only' | 'allow_and_deny' | 'mutation'
}

type AuthorizationDecision = {
  id: string
  allowed: true
  actorId: string
  identityId: string
  capability: CapabilityId
  scope: { type: string; ids: readonly string[] }
  policyVersion: string
  grantIds: readonly string[]
  decidedAt: string
  expiresAt?: string
}
```

MCP 与 HTTP 共用 `authorizeRequest()`：认证 → identity/session 状态 → workspace lifecycle → member/platform/grant 解析 → method policy → resource scope → 条件（MFA/reason/approval）→ 决策审计 → handler。handler 不允许再次从 header 读取角色，也不允许自行扩大 workspace。

### `ops.session.v2`

保留 `roles` 仅用于展示，增加服务端最终投影：

```json
{
  "actor_id": "...",
  "identity_id": "...",
  "policy_version": "2026-08-31.v1",
  "platform_roles": ["ops_admin"],
  "workspace": { "id": "ws_x", "roles": ["operator"], "status": "active" },
  "capabilities": ["workspace.summary.read", "customer.content.read"],
  "scopes": [{ "type": "workspace", "ids": ["ws_x"] }],
  "temporary_grants": [{ "id": "g_x", "expires_at": "...", "capabilities": ["customer.content.read"] }],
  "assurance": { "mfa_verified": true, "session_expires_at": "..." }
}
```

前端必须以 `can(capability, resource?)`、`scopeFor(capability)` 和服务端 action descriptor 渲染。导航只决定是否显示模块；按钮禁用/隐藏、只读态、导出和危险操作都使用同一 capability。API 仍是最终边界。

### 临时客户数据授权

新增 `ops_access_grants`：`id, subject_identity_id, workspace_id, capabilities, resource_scope, reason, ticket_ref, approved_by, approved_at, issued_at, expires_at, revoked_at, revoked_by, max_uses, use_count, revision`。另建 append-only `ops_access_grant_events`。

- 客户内容默认拒绝平台角色。
- read grant 最长 15 分钟，write/admin 最长 5 分钟并要求双人审批、MFA、reason 和精确 resource scope。
- 票据只作为携带 grant id/nonce 的签名证明；API 必须查询持久状态、核对 revision、未撤销、未过期、未超使用次数，并原子记录使用。
- workspace 用户路径使用 active membership；平台支持路径使用 active platform role + active temporary grant。二者是明确的 OR 分支，不再要求平台支持先成为租户成员。
- 列表/导出只能返回 grant scope 内数据；错误为稳定的 `AUTHZ_GRANT_REQUIRED/EXPIRED/REVOKED/SCOPE_MISMATCH`，不泄漏资源是否存在。

## PostgreSQL/RLS

1. 租户业务表继续使用 `merchant_app` 与事务级 `app.workspace_id`；所有 repository 必须经过 `withWorkspaceTransaction()`，禁止裸 pool query。
2. 平台汇总和控制面继续使用独立 `merchant_ops` pool。平台查询只读 security-barrier view 或专用 repository，不授予底层客户内容表的跨租户读取。
3. 最终 RLS policy 必须同时约束数据库角色和 scope GUC；对历史只检查 `app.platform_scope` 的 policy 做收敛迁移。
4. 临时客户数据访问仍通过 `merchant_app + exact workspace_id` 读取/写入，数据库不接受来自 HTTP header 的 capability GUC。应用层决策和 DB workspace RLS 形成两道边界。
5. append-only 的 audit、ledger、grant event 撤销 UPDATE/DELETE/TRUNCATE；关键变更使用同一事务写业务结果与审计/outbox。
6. 生产发布门禁必须使用 `DATABASE_URL` 与 `OPS_DATABASE_URL` 分别执行正向/负向 SQL probe：tenant 不能设 platform scope 越权，ops 不能读客户内容底表，错误 workspace 为 0 行，连接复用不泄漏 GUC。

## Worker 授权与审计

所有可能产生外部写入、退款、状态变更或模型成本的 outbox payload 增加：

```ts
authorization: {
  decision_id: string
  requested_by: string
  capability: string
  scope_hash: string
  policy_version: string
  grant_ids: string[]
  decided_at: string
}
```

Worker 使用独立 system identity，只接受服务端生成并在 action ledger/outbox 中持久化的授权快照；校验 event workspace、资源版本与 scope hash。普通异步动作使用 enqueue-time 决策；退款、删除、发布到外部平台等 critical 动作在执行前还要校验 approval/grant 未撤销。Worker 结果、重试、unknown/dead-letter 都关联 `decision_id`、原 actor、provider request id 和 trace id。

## 前端 capability 投影

- 新增 `AuthorizationProvider` 和纯函数 `can/canAny/scopeFor`；页面 registry 只声明 `requiredCapabilities`。
- 删除 `opsNavigation.ts`、`useOpsConsoleModel.ts`、`financePermissions.ts` 和各组件中的角色数组，迁移期由一个 adapter 把 session v2 capability 投影到旧 props。
- 页面状态固定为 `loading | ready | empty | denied | blocked | error`；403 显示所缺 capability 和申请路径，503 显示配置阻断，不能伪装空列表。
- “可见但只读”由 read capability 存在、write capability 缺失表达；危险按钮要求 capability + MFA/approval action descriptor。
- 服务端可以返回 resource action descriptor：`{ action, allowed, capability, reason_code, requires_confirmation }`。前端不可把 `allowed:false` 改成 true。

## 迁移顺序（Strangler，不做大爆炸）

| 阶段 | 交付 | 上线条件 |
| --- | --- | --- |
| M0 | 冻结角色词汇；生成动态 method inventory；加入 policy completeness CI | 当前行为基线和 deny 测试稳定 |
| M1 | capability registry、role templates、authz engine；对旧门禁做 shadow decision | shadow mismatch 有指标、无执行影响 |
| M2 | `ops.session.v2` 与前端 `AuthorizationProvider` | 原始 role 与 effective capability 差异可观测 |
| M3 | 先强制身份、成员、功能开关、退款、发布、客户数据等 critical/high risk 方法 | 负向 API/MCP/E2E 全绿，deny 有审计 |
| M4 | 迁移其余全量 MCP method 和受保护 HTTP route；启动时拒绝未注册 handler | registry/handler/contract 三集合完全一致 |
| M5 | 新增持久临时 grant、平台角色表；双写/回填，旧票据只读兼容 | 撤销、过期、重放、并发使用 PostgreSQL 测试通过 |
| M6 | 前端删除角色判断；旧 `platform_ops/merchant_admin` 别名只在 resolver 保留 | 桌面角色矩阵与深链 403/只读验收通过 |
| M7 | RLS/ACL 收敛、Worker authorization snapshot、删除旧路径 | 真实 OIDC、双 DB role、Worker、多副本、容器门禁通过 |

每阶段由 feature flag 控制 `shadow | enforce`，只允许向更严格方向灰度；策略加载失败、未知 capability、未知 method、scope resolver 失败一律 deny。

## 测试架构

```text
POLICY CONTRACT                                  REAL FLOW
[UNIT] role -> capability                         [E2E] OIDC login/session v2
[UNIT] method -> policy N/N（构建时读取）          [E2E] plugin -> MCP -> API -> RLS
[UNIT] scope/resource/condition                   [E2E] Ops UI role/page/action matrix
       │                                          [E2E] temp grant issue/use/revoke
       ▼                                                 │
[API] every method allow + deny                          ▼
[API] MCP = HTTP parity                          [POSTGRES] tenant/ops positive+negative
[API] role mismatch/session revoke               [WORKER] snapshot/revoke/replay/unknown
       └──────────────────── release gate ────────────────────┘
```

必须覆盖：

- 表驱动单测：每个角色模板、capability、scope、显式 deny、MFA/approval 条件。
- 契约测试：全量 MCP 方法及全部受保护 HTTP route 恰有一个 policy；不存在 wildcard fallback。
- API 负向测试：无角色、错误 workspace、suspended member、gateway/member mismatch、旧 session、跨品牌/店铺、平台角色无 grant、read grant 执行 write。
- Grant PostgreSQL 测试：过期、撤销、签名篡改、actor/workspace/scope mismatch、并发 max-use、重复 nonce、审批 revision 冲突。
- RLS 真实 PostgreSQL：`merchant_app`/`merchant_ops` 正负矩阵、连接池 GUC 泄漏、security-barrier view、append-only 权限。
- 前端桌面 E2E：每个角色逐域“不可见/只读/可操作”，深链不可绕过，403/503/empty 分离；不把手机和平板列为上线项。
- Worker：授权快照缺失/篡改/已撤销、workspace mismatch、资源版本变化、重放、lease 丢失、unknown/dead-letter 和审计关联。
- 真实链路门禁：OIDC 签名与 nonce、MCP、API、数据库、Worker、模型中转请求/用量/成本/错误、容器健康；fixture 不能替代生产证据。

## 性能与可观测性

- session v2 一次返回当前 workspace 的压缩 capability set；不要逐按钮请求权限。
- capability template 在进程内按 `policy_version` 缓存；身份/成员/grant 使用短 TTL，并由停用/撤销事件主动失效。critical 操作始终查询权威状态。
- 授权判断只做 O(1) set lookup；资源 ACL 批量读取，禁止列表逐行授权 N+1。
- 平台聚合继续使用 bounded view、分页和并发上限；导出使用独立限额和异步任务。
- 指标：`authz_decisions_total{method,capability,effect,reason}`、shadow mismatch、grant issued/revoked/used、policy version、denied latency；日志禁止记录票据正文、token、客户内容。

## 失败模式

| 失败 | fail-closed 行为 | 用户看到 | 测试 |
| --- | --- | --- | --- |
| OIDC/identity/session 不可验证 | 401/403，不创建匿名 fallback | 重新登录/联系管理员 | OIDC E2E |
| policy registry 缺 method | 服务启动失败；运行时未知 method deny | 配置阻断 | contract + startup |
| member/grant 仓储不可用 | 503，不使用缓存 allow 执行写操作 | 权限暂不可验证，可重试 | API fault |
| grant 过期/撤销/超次 | 403，记录 reason code | 重新申请授权 | PostgreSQL concurrency |
| RLS scope 缺失/错误 | 0 行或 DB 拒绝，不降级 memory | 无权访问 | real PostgreSQL |
| Worker snapshot 缺失或 scope mismatch | dead-letter/manual attention，不调用外部服务 | 任务需运营处理 | Worker integration |
| 前端 session 过期 | 清空 capability、取消请求、跳登录 | 不闪现敏感页面 | desktop E2E |
| policy 版本更新 | 旧 projection 失效并刷新；critical 动作重判 | 权限已更新 | version tests |

## 并行实施与依赖

| Lane | 模块 | 依赖 |
| --- | --- | --- |
| A | contracts/authz、API authz engine、session v2 | M0 inventory |
| B | platform role/grant schema、RLS/ACL、repository | capability/grant schema from A |
| C | Ops UI AuthorizationProvider、page/action migration | session v2 schema from A |
| D | Worker authorization snapshot、audit correlation | decision schema from A |
| E | contract/API/PostgreSQL/E2E/release gates | follows A-D incrementally |

先合并 A 的类型和 shadow engine；B、C、D 可在独立工作树并行；E 随每个 lane 增量验证。A/C 都会触及 session 类型，A/D 都会触及 outbox contract，必须由 owner 先锁接口再并行，避免共享类型冲突。

## Implementation Tasks

- [ ] **T1 (P0，human: ~2d / CC: ~2h)** — Authz SSOT — 建立 capability/method policy registry，并让 CI/启动校验全量 MCP + HTTP handler 完整覆盖。
  - 来源：P0-2、P0-4
  - 验证：contract inventory、unknown method startup failure、allow/deny table tests
- [ ] **T2 (P0，human: ~2d / CC: ~2h)** — Session — 实现 principal resolver 与 `ops.session.v2`，返回 effective roles/capabilities/scopes/policy version。
  - 来源：P0-1
  - 验证：gateway/member mismatch、suspended identity、session expiry、scope tests
- [ ] **T3 (P0，human: ~3d / CC: ~3h)** — Enforcement — MCP/HTTP 统一 `authorizeRequest()`，先迁移 critical/high-risk 方法。
  - 来源：P0-2、P0-3
  - 验证：MCP/HTTP parity、customer data/finance/publish/identity negative E2E
- [ ] **T4 (P0，human: ~3d / CC: ~3h)** — Grants — 建立持久可撤销临时客户数据 grant 和 append-only events，拆开 platform 与 workspace 身份路径。
  - 来源：P0-3、P1-7
  - 验证：真实 PostgreSQL 过期/撤销/重放/并发/双审批测试
- [ ] **T5 (P1，human: ~3d / CC: ~3h)** — Ops UI — 建立 AuthorizationProvider，删除导航、hook、财务和组件角色数组。
  - 来源：P1-5、P1-6
  - 验证：桌面全角色页面/动作/深链矩阵
- [ ] **T6 (P1，human: ~3d / CC: ~3h)** — Database — 收敛最终 RLS/ACL，保持 tenant 与 ops pool 隔离并加入生产 SQL probes。
  - 来源：RLS 审计
  - 验证：merchant_app/merchant_ops 正负矩阵、GUC 泄漏、append-only
- [ ] **T7 (P1，human: ~2d / CC: ~2h)** — Worker/Audit — 为高风险 outbox 加授权快照和 decision correlation，执行前验证撤销与资源版本。
  - 来源：P1-8
  - 验证：snapshot 篡改、scope mismatch、replay、unknown/dead-letter
- [ ] **T8 (P1，human: ~2d / CC: ~2h)** — Migration — 双写/回填角色，移除 `platform_ops` workspace role 和分散别名，灰度 shadow → enforce。
  - 来源：P1-5
  - 验证：历史数据迁移、回滚、零权限扩大、shadow mismatch 归零

## What already exists

- 复用：OIDC HMAC/body digest/nonce、identity/session 生命周期、active member 校验、brand ACL、`withWorkspaceTransaction`、独立 ops pool、security-barrier workspace summary、操作审计、outbox/lease/idempotency。
- 改造：`authorizedRoles`、`ops.session`、客户数据 method 分类、临时 HMAC grant、各 domain service role context。
- 删除（迁移完成后）：前端所有角色数组、server switch 内散落 allowlist、`featureFlagActor` 特殊角色翻译、`platform_ops` 作为 workspace member 的双重语义。

## NOT in scope

- 不改变商家营销产品工作流、平台 connector 或五模态模型能力本身；只治理谁能看到和执行。
- 不做手机、平板适配或相应验收。
- 不把本地 fixture、静态代码、历史截图当作生产成功证据。
- 不在本阶段引入外部策略 SaaS；先用版本化 TypeScript registry + PostgreSQL 权威状态，保持技术简单可审计。
- 不删除现有业务/容器数据；角色回填必须可回滚并保留审计。

## 发布判定

在以下证据齐全前保持生产 NO-GO：真实 OIDC 登录与角色声明、动态 N/N policy coverage、桌面角色矩阵、MCP/HTTP 负向越权、生产 PostgreSQL 双角色/RLS probe、临时 grant 撤销与并发、Worker 授权快照、审计关联、容器健康，以及模型中转真实鉴权/请求/用量/成本/错误证据。任何配置缺失必须显示为阻断，不能降级为全权限、本地 memory 或伪造空数据。
