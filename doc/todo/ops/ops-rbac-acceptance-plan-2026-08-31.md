# 运营后台 RBAC 与 Ant Design 重构验收计划

日期：2026-08-31  
状态：本地实现与定向验收已执行；生产发布仍为 **NO-GO**  
Owner：QA / 发布门禁  
范围：ChatGPT 插件入口 → `MCP_METHODS` 全量方法（当前动态 247/247）→ API/授权引擎 → 13 个 Ops 域 → PostgreSQL/RLS → Worker → 审计；桌面运营后台 Ant Design 重构  
明确不在范围：手机、平板、触控布局；它们不是需求、验收项或上线阻断项

## 0.0 当前代码对账（owner 复核，2026-08-31）

以下结论以当前工作树代码、定向测试和本地运行结果为准；文档后续章节中的“当前发现”保留为历史审查快照，不得覆盖本节。

| 能力 | 当前落地证据 | 当前判定 |
| --- | --- | --- |
| 双工作台 | `OpsConsoleController` + `opsWorkbenchLocation`；切换会持久化上下文、更新 URL、abort 旧请求并 remount runtime；`OpsConsoleController.workbench.test.ts`、`opsClient.test.ts` | 本地已落地；真实 OIDC/多租户浏览器证据待补 |
| 身份/范围上下文 | `RoleScopeBar` 展示 canonical role、actor、workbench、scope、policy version、有效临时授权；`OpsHeader` 已接入 | 本地已落地；真实 grant 生命周期待补 |
| 连接诊断 | `OpsHeader` 将 API/工作区/凭据收进可展开诊断区，缺失配置和读取状态显式呈现 | 本地已落地；生产配置策略待验证 |
| 能力驱动导航 | `createAuthorizationProjection` 只消费服务端 capabilities/effective permissions；托管会话无投影时 deny-all，不从 raw role 扩权 | 本地已落地；全量 HTTP/worker parity 待补 |
| 403 可解释性 | `AccessDeniedResult` 展示缺失 capability、当前 scope、request ID，并提供返回/刷新权限；API 错误元数据由 `opsClient` 保留 | 本地已落地；真实 API 403 与对象不泄露矩阵待补 |
| AntD 主题与错误反馈 | `main.tsx` 根级 `ConfigProvider`；`OpsAntAppBoundary` 包住 `useOpsConsoleModel`；错误状态使用 alert/live-region 规范 | 本地已落地；全域视觉快照待补 |

本节的“已落地”仅表示当前代码已具备并通过本地验证，不代表生产上线完成。仍保留为阻断项：真实 OIDC 与受控主体、精确资源 scope/obligation、持久可撤销 JIT、全 critical worker authorization snapshot、统一 decision audit、双角色 allow/deny 与 IDOR 运行矩阵、真实模型中转 usage/cost/error、全容器签名/ClamAV 健康和 canary。

## 0. 验收结论规则

当前状态判定为 **LOCAL VERIFIED WITH BLOCKERS / PRODUCTION NO-GO**。本地代码、PostgreSQL、API、publish worker 与桌面浏览器已有运行证据，但不能替代真实生产 OIDC、模型中转、全 critical worker 和发布迁移门禁。

### 0.1 本轮 owner 验收快照

- 契约：247/247 MCP 方法均有显式 policy；除角色查询/分配/撤销与 JIT 查询/签发/撤销六个管理方法外，新增只读 `ops.authorization.matrix.get`，其响应直接由同一 policy registry 生成。
- 权限：`ops.session.v2`、permission atoms、exact scope、显式 deny、持久 assignment/grant/revision、JIT 原子消费和失效已接入 API；`platform_owner` 不在日常管理入口开放。
- Worker：`publish.execute` 已使用 enqueue 快照，并在释放凭据前向 API 做权威 revision/member/grant fresh check；其他 critical operation 尚未接入并 fail-closed。
- UI：Ant Design 双工作台、RoleScopeBar、capability gate、授权治理中心及带必填原因的撤销 Modal 已落地；JIT 签发表单具备提交中锁定、失败诊断和输入保留；切换会 abort/remount，并保留最后一次服务端投影的可用工作台以避免失败态锁死。
- 自动化：后端/契约/持久化/worker 12 个文件 215 项通过；运营后台 69 个文件 326 项通过；JIT/错误诊断定向 12 项通过；全量 typecheck、ops-console production build、相关 diff check 通过。
- 浏览器：1440×900 实际验证平台控制台、授权中心、缺 workspace 状态、`ws_demo` 工作区和返回平台；平台告警聚合的运行时 `Date`/string 500 已修复，重建后 API 无新增 unhandled 500。
- 容器：当前只读复核显示 `api`、`api-replica`、`ops-ui`、`ui`、六类 worker、PostgreSQL、Redis 与 ClamAV 均 healthy；`schema_migrations=106/106`，migration 106 完整性查询返回 0 个无效映射。此前阻断记录 `ws_demo / canonical_product_0ffeaf289d0f444bbf98ac41 / prod_taobao_484008b7e055_TB-FIXTURE-2001` 现已变为 legacy/canonical brand 均为 `brand_release_qa`，legacy 行 `updated_at=2026-08-31T04:50:54.677658Z`，migration 106 于 `04:51:08.736239Z` 应用。该修复发生在本轮 owner 工作之外，本轮只读确认、未删除或修改业务数据；在缺少修复审批/审计和预生产演练前，不能把容器健康当作生产发布成功。
- 截图：`dogfood/ops-console-current/rbac-platform-postfix-1440.png`、`rbac-authorization-center-1440.png`、`rbac-workspace-required-1440.png`、`rbac-workspace-ws-demo-settled-1440.png`、`rbac-switch-back-platform-1440.png`。

仍缺：1280/1920 角色矩阵浏览器证据、真实生产 OIDC、真实模型五模态中转鉴权/用量/成本/错误、HTTP policy registry 全量 parity、生产多副本与 canary，以及 migration 106 修复的审批/审计和预生产完整门禁。因此不满足最终 PASS 条件。

最终只有同时满足以下条件才能 PASS：

1. 动态 N/N MCP 方法、全部受保护 HTTP route 和全部 Worker 高风险动作均登记唯一权限策略，注册表、handler 与契约三集合相等，无 wildcard fallback。
2. 每个角色模板在其 scope 内至少有一条 allow 和一条 deny 运行证据；客户数据方法另有跨 workspace/brand/store 的 IDOR 负向证据。
3. `ops.session.v2` 的 effective capability、页面可见/只读/操作状态、MCP/HTTP 实际响应、RLS 结果和审计记录一致。
4. 平台角色无有效 JIT grant 时读取客户正文稳定返回 403；聚合响应不含客户正文、prompt、客户对象 ID、下载 URL 或凭据。
5. OIDC、workspace membership、RLS、Worker 授权快照、审计、模型中转和容器门禁均以真实运行证据验证；配置缺失显示明确阻断且 fail-closed。
6. 桌面浏览器在 1280×800、1440×900、1920×1080 至少完成核心角色矩阵、工作台/工作区切换、深链、只读、高风险和 JIT 流程，并保留截图；交互流程需要实际点击后的结果证据。

任何一项缺失都不是“部分通过”。本地环境无法验证生产依赖时，结论写 `BLOCKED`，不可写 PASS。

## 1. 验收依据与证据分级

### 1.1 规范依据

- 产品真源：`doc/todo/ops/ops-rbac-product-plan-2026-08-31.md`
- 架构真源：`doc/todo/ops/ops-rbac-architecture-2026-08-31.md`
- UI 真源：`doc/todo/ops/ops-rbac-ui-design-2026-08-31.md`
- 项目宪法：真实 ChatGPT 插件链路、真实中转证据、真实 RLS/Worker/发布门禁；不以静态代码代替完成。

若三份文档与实现冲突，先记录差异，不由 QA 静默选择更宽权限。涉及角色词典、capability 命名、JIT 审批或数据范围的冲突必须由产品/架构 owner 定夺。

### 1.2 三类证据必须分栏记录

| 证据类型 | 可以证明 | 不能证明 | 最低产物 |
| --- | --- | --- | --- |
| 代码/静态证据 | 注册表覆盖、类型契约、无散落角色判断、迁移和测试存在 | 用户实际可用、真实 OIDC/RLS/Worker 生效、生产已上线 | diff、集合清点输出、定向测试/build 日志 |
| 本地运行证据 | 本地 MCP/API、Postgres、Worker、浏览器真实行为 | 生产 OIDC/provider/多副本/密钥和数据面成立 | 原始请求/响应、DB probe、worker/审计记录、桌面截图/视频 |
| 生产外部证据 | 真实 OIDC、双 DB role、模型中转、真实 connector、canary、审计 sink | 无法用 fixture 或本地 token 替代 | 时间戳、环境、trace/request/decision/audit ID、脱敏响应、发布门禁结果 |

禁止把三类证据合并成一句“已验证”。最终报告每条要求都要注明证据层级。

## 2. 测试数据与身份夹具

执行前建立专用、可回收但不删除业务数据的测试主体。不得复用生产客户正文做截图。

### 2.1 资源拓扑

```text
platform
├── ws_alpha
│   ├── brand_alpha_1 → store_alpha_taobao / store_alpha_jd
│   └── brand_alpha_2 → store_alpha_douyin
└── ws_beta
    └── brand_beta_1 → store_beta_tmall
```

- 两个 workspace 都必须有 active owner；另准备 inactive/suspended member。
- 每个 workspace 至少一个重名商品/任务，验证响应不能因业务 ID 猜测跨租户。
- 准备 customer metadata、customer content、finance、secret metadata 四类数据。
- 准备一条有效 JIT、一条过期 JIT、一条撤销 JIT、一条 scope mismatch JIT；grant 绑定 actor、workspace、capability、resource、TTL、ticket/reason。
- 准备 enqueue 后撤权的 Worker job、高风险执行前 grant 被撤销的 job、篡改 snapshot 的 job。

### 2.2 角色主体

平台角色全部单独建主体：`platform_owner`、`platform_admin`、`platform_ops`、`platform_support`、`platform_finance`、`platform_commercial_admin`、`platform_rules_admin`、`platform_model_admin`、`platform_security_auditor`、`platform_release_admin`。

商家角色全部单独建主体：`workspace_owner`、`merchant_admin`、`merchant_operator`、`content_editor`、`content_reviewer`、`publisher`、`merchant_rules_admin`、`merchant_finance`、`workspace_auditor`。

另建组合角色、显式 deny、过期 assignment、gateway/member mismatch 和 platform + workspace 双身份主体。双身份必须通过工作台切换，不得在同一页面隐式合并平台与客户数据权限。

## 3. 全量 MCP 方法与 HTTP 契约门禁

产品方案第 8 节的 51 个能力族覆盖 `MCP_METHODS` 全量方法。验收不能只抽样能力族；必须从实现中的 method policy registry 自动生成逐方法矩阵。

### 3.1 每个方法必须具有的字段

| 字段 | 断言 |
| --- | --- |
| `method` | 与 `packages/contracts/src/mcp.ts` 精确一致，恰好一条主策略 |
| `capability` | 使用 canonical permission/capability ID，不使用临时角色字符串 |
| `plane/dataClass` | 明确 control/tenant/customer data 及数据分类，未知分类拒绝 |
| `effect` | read/write/critical 明确，不靠“未列入 read 即 write”的推断 |
| `scopeResolver` | self/workspace/brand/store/platform 中至少一个，解析失败 deny |
| `obligations` | reason/revision/idempotency/confirmation/MFA/two-person/JIT 按风险声明 |
| `audit` | allow/deny/mutation 记录规则及稳定 event type |
| `HTTP parity` | 同一业务动作经 MCP 与 HTTP 得到相同 decision/error code |
| `workerMode` | 无异步动作、enqueue snapshot 或执行前 fresh check 三选一 |

### 3.2 自动化集合断言

- `declared MCP methods = registered method policies = implemented MCP cases = plugin exposed methods`，预期动态 N/N；重复也失败。
- 所有受保护 HTTP routes 均有 route ID 和 policy；同一 service 不得从 header/前端 claim 二次扩大 scope。
- 未登记 method/route：构建或启动失败；运行时兜底必须 deny，不能按前缀猜权限。
- 新增 method 若未补 capability、scope、data class、obligation、audit 和测试，CI 失败。
- 静态检查禁止在页面、hook、service 新增 `roles.includes(...)`、域内角色翻译或 wildcard allow；兼容 alias 只能存在于 principal resolver 入口。

### 3.3 逐方法表驱动用例

每个方法至少生成：

1. canonical role + 正确 scope 的 allow；
2. 身份有效但缺 capability 的 deny；
3. scope 不匹配的 deny；
4. mutation 缺 reason/revision/idempotency/confirmation 的对应 deny；
5. critical 缺 MFA/审批或授权已撤销的 deny；
6. MCP/HTTP parity；
7. decision audit 与 mutation audit 可关联。

客户数据方法增加 platform role 无 JIT、JIT actor/workspace/capability/resource/TTL/nonce 不匹配、read grant 执行 write、grant 超次等负测。平台聚合方法增加字段白名单和敏感内容扫描。

## 4. 13 个 Ops 域验收矩阵

域级 `V/R/W/A/J/N` 必须与产品方案第 7 节角色矩阵逐格对照；本表定义每个域的实际测试面。`V` 为可进入，`R` 为只读，`W` 为日常写，`A` 为高风险义务，`J` 为临时授权，`N` 为不可见/深链拒绝。

| 域 | 域读取/导航 | 代表写动作 | 高风险/JIT | 必测边界 |
| --- | --- | --- | --- | --- |
| 总览 `overview` | 平台聚合或当前 workspace 摘要 | ack/刷新（若有能力） | 上线阻断不可被无权限用户消失 | 卡片不能泄露无权域数量；partial/503 不得伪装 ready |
| 用户 `users` | 平台身份/租户目录 | suspend、risk、session revoke | 自停用拒绝、MFA/reason/revision | workspace 角色 N；深链 403；不暴露其他租户正文 |
| 成员 `members` | 当前 workspace 成员 | invite、role update、deactivate | 最后 owner、owner/platform role 授予 | MA 不得授 owner；跨 workspace IDOR；stale revision 409 |
| 客服 `support` | 工单/最小化 CRM | assign/comment/export | 客户正文 JIT、导出限量 | 无 grant 只见脱敏壳；到期/退出立即清缓存 |
| 事故 `incidents` | 平台或 workspace 事故 | transition/comment/commander | SEV、关闭/升级、reason | support 只读/受限写与 platform ops 指挥权限分离 |
| 任务 `tasks` | 平台聚合或 workspace 内容 | queue/creative/content/review | 客户正文 JIT、审批人与创建者分离 | 平台聚合无 prompt/对象 ID；publisher 不得编辑冻结内容 |
| 店铺 `stores` | connection/brand/store health | connect/revoke/sync/alias | OAuth、撤销确认、精确 store scope | brand/store 越权；平台角色只能聚合或 JIT |
| 规则 `rules` | 生效规则/媒体规格 | draft/update | approve/publish、双人/来源 evidence | platform 与 workspace 规则隔离；作者不能自批高风险版本 |
| 模型 `models` | readiness/usage/cost metadata | policy/budget/markup（按角色） | 配置缺失 fail-closed | model admin 不读 prompt/output；真实中转错误/用量/成本可见 |
| 功能开关 `flags` | 环境 scope 的 flag | normal update | emergency set + MFA/reason | platform release 与 read-only 角色分离；revision/idempotency |
| 存储 `storage` | 脱敏容量/对账 | 受限 reconcile（若定义） | 导出/定位 workspace | 无 object bytes/key/download URL/credential；tenant/ops DB 边界 |
| 财务 `finance` | self/workspace/platform finance | refund/reconcile/catalog update | 高额退款/加价双人审批 | 内容角色 N；原单、金额、幂等、provider evidence；个人/工作区分离 |
| 审计 `audit` | 与当前 scope 对应的只读审计 | export 为独立能力 | 平台导出受限 | append-only；无 wildcard cursor；敏感 payload 脱敏 |

### 4.1 每个域的六项角色断言

对产品矩阵中每个角色 × 域格执行或生成以下断言，不允许只看快照：

1. 导航：`N` 不渲染；`R/W/A/J` 按工作台显示。
2. 深链：`N` 返回统一 403 且不发业务数据请求；不得以空页代替。
3. 数据：`R/W/A` 只返回当前 scope；`J` 未授权只返回脱敏壳。
4. 动作：`R` 不渲染写表单；`W` 能完成动作；`A` 缺义务时被服务端拒绝；`J` 仅在有效 grant 内出现。
5. 解释：只读/拒绝展示人类可读原因、缺失 capability、当前 scope、request ID，但不泄漏对象是否存在。
6. 审计：允许和拒绝均可关联 actor、decision ID、policy version、scope、matched assignment/grant、obligations、request/trace ID。

## 5. OIDC、Session 与权限传播

| 场景 | 预期 |
| --- | --- |
| OIDC 签名、issuer、audience、nonce 任一错误 | 401/403；不创建匿名或本地 fallback |
| identity suspended / session revoked / step-up required | session 与业务请求 fail-closed，稳定 error code |
| gateway role 与 active membership 不一致 | effective role 以权威 resolver 结果收窄；`ops.session.v2` 与 API 一致 |
| workspace membership inactive/expired | 当前 workspace capability 清空；页面不闪现敏感内容 |
| policy catalog 缺失/版本不支持 | 503 配置阻断；全部写入锁定，不返回空数组 |
| assignment/deny/grant 变更 | session snapshot revision 变化；旧请求取消；critical 动作重新查权威状态 |
| 同时有平台和 workspace 角色 | 必须显式切换 workbench；两套 capability 不在同页自动并集 |
| 切换 workspace/workbench | abort in-flight、清 query cache/选中项/Drawer/正文，再取新 capability |

权限传播测试至少包含两个并发浏览器会话：A 中撤权，B 的下一次读取/写入分别验证刷新与服务端即时拒绝；禁止循环重试 403。

## 6. JIT 客户数据访问

### 6.1 正向链路

`平台客服/运营 → 脱敏概要 → 选择工单/事故、workspace、capability、resource scope、时长 → 审批 → 签发 grant → 新会话/能力投影 → 每次请求校验并审计 → 主动退出或到期清空`。

### 6.2 必须失败的探针

- 无 grant、伪造签名、错误 actor、错误 workspace、错误 capability、错误 resource、过期、撤销、revision 旧、重复 nonce、超过 max uses。
- read grant 请求 write；workspace 级 grant 请求另一个 brand/store；5/15 分钟上限被客户端篡改。
- grant 仓储不可用时不得使用缓存 allow 执行写；返回可解释 503/403。
- 到期或撤销后页面正文、浏览器缓存、query cache、详情 Drawer、导出链接全部清除。
- 平台 admin/owner 也不能绕过 JIT；break-glass 必须是独立、可审计、非常规流程。

并发 max-use 和撤销竞态必须使用真实 PostgreSQL 验证，不能只测内存 mock。

## 7. PostgreSQL / RLS 验收

使用临时测试数据库或明确的测试 schema，不清空现有业务/容器数据。

| DB 身份/上下文 | 正向 | 负向 |
| --- | --- | --- |
| `merchant_app` + `app.workspace_id=ws_alpha` | 仅 ws_alpha 租户表数据 | ws_beta 为 0 行/拒绝；不能设置 platform scope 越权 |
| `merchant_ops` + 有界 platform scope | security-barrier 聚合/控制面 view | 客户正文底表、对象存储 key、秘密表拒绝 |
| 连接池复用 | 每事务正确设置/清除 workspace GUC | 前一请求 scope 不得泄漏到下一请求 |
| JIT 访问 | 仍以 `merchant_app` + exact workspace RLS | HTTP header capability 不得写入 DB GUC 形成 wildcard |
| audit/grant events | INSERT 与授权查询 | UPDATE/DELETE/TRUNCATE 均拒绝 |

迁移门禁：前后 assignment 数量、owner 不变量、canonical/legacy 映射、显式 deny、审计链完整；回滚脚本只验证可执行性，不以删除数据“恢复”。历史只检查 `app.platform_scope` 的 policy 必须由最终 policy probe 证明已收敛。

## 8. Worker 与异步授权验收

所有外部发布、退款、删除、模型成本和状态变更事件必须携带并持久化：`decision_id`、`requested_by`、`capability`、`scope_hash`、`policy_version`、`grant_ids`、`decided_at`。

| 场景 | 预期 |
| --- | --- |
| 普通异步动作、合法 enqueue snapshot | workspace/resource/scope hash 相同才执行 |
| critical 动作在执行前撤销 grant/approval | fresh check 拒绝，不调用 provider |
| snapshot 缺失/篡改/版本未知 | dead-letter/manual attention；不降级执行 |
| event workspace 与 snapshot 不同 | 拒绝并记录安全事件 |
| resource revision 已变化 | 拒绝或回到明确重审状态，不能发布旧版本 |
| lease 丢失、重放、重复交付 | 幂等；一次外部副作用；结果关联原 decision |
| provider unknown/timeout | 保留 unknown，不冒充成功；重试和审计可追踪 |

Worker 运行证据需同时看到 action ledger/outbox、worker 日志和最终审计关联；仅构造 payload 调内部函数不算运行验证。

## 9. 审计与可观测性

- 每次决策至少记录：actor/identity、method/route、capability、effect/reason、scope、policy version、matched assignments/grants、obligations、decision/request/trace ID、时间。
- mutation 记录 before/after revision 或不可变 result evidence；敏感字段、token、JIT 票据正文、客户正文不得进入日志。
- deny reason 稳定且可聚合：unauthenticated、inactive、capability missing、scope mismatch、grant required/expired/revoked、obligation missing、policy unavailable、RLS denied。
- 审计查询本身受 scope 和 export capability 限制；平台 security auditor 只看脱敏 evidence。
- 指标必须能观测 shadow mismatch、grant issue/use/revoke、deny latency、policy version、Worker dead-letter；发布前 shadow mismatch 为 0 或每一项有批准的、不会扩大权限的解释。

## 10. Ant Design 桌面浏览器验收

### 10.1 视口与证据

- 固定测试 1280×800、1440×900、1920×1080；不执行或报告移动端适配。
- 每个核心状态保留 PNG；点击、工作台切换、JIT、Drawer/Modal、运行中撤权等交互用视频或逐步前后截图。
- UI PASS 必须基于真实组件和真实运行页面。build、DOM 快照或历史截图只能作为补充。
- 每次交互后检查浏览器 console；截图必须能定位角色、范围、域、状态且不包含真实凭据。

### 10.2 Shell 与工作台

- `OpsAppShell` 使用 AntD `Layout/Sider`，桌面侧栏 224px，可折叠 64px；无可见域的导航组整体隐藏。
- 平台控制台与商家工作区明确分开；顶部持续显示身份、角色来源、数据范围、workspace/brand/store、会话/JIT 剩余时长、连接健康。
- 不再对 workspace 用户显示“平台级/全平台”；生产 Header 不常驻 Token/API 配置。
- capability 未加载时先显示验证 Skeleton，不能闪出全量导航或敏感页面。

### 10.3 权限状态

| 状态 | 浏览器断言 |
| --- | --- |
| Hidden | 菜单和动作不出现；直达 URL 显示 403；Network 不发业务数据请求 |
| Read-only | 数据可读；写表单不渲染；说明“为何只读”；不使用整页 disabled inputs |
| Disabled | 用户有动作能力但前置条件缺失；控件可聚焦并解释原因 |
| Forbidden | 页面/区块 Result 含当前身份、scope、缺失 capability、request ID 与返回路径；不泄露资源存在性 |
| JIT locked | 只见脱敏壳、真实申请入口；无后端申请流时不显示假按钮 |
| JIT active | 全局警示、工单/原因/批准人/倒计时；退出/过期立即回锁定态 |
| Loading/empty/error/partial/stale | 五者视觉和语义均不同；403/503 不可转为空态；partial 明示已加载比例/失败分片 |

### 10.4 页面组件与交互

- `OpsPageHeader` 只有一个主动作；`FilterBar` 与 `OpsDataTable` 不做 Card 套 Table 套 Card。
- Table sticky header、服务端分页/筛选/排序、首列/操作列固定、金额数字右对齐；无权行不可批量选择且能解释原因。
- 详情/轻编辑使用 560/720 Drawer；危险或跨范围动作使用 Modal，展示对象、范围、影响、reason、revision 和二次确认。
- 只读字段使用 `Descriptions/ReadOnlyField`；成功反馈包含对象、状态、revision/audit ID；失败保留输入和恢复动作。
- 主题来自根 `ConfigProvider` token；业务组件不散落新颜色/圆角/阴影。对现有样式的清理以 diff 检查和视觉证据共同判定。

### 10.5 键盘与无障碍

- 仅键盘完成导航、筛选、打开/关闭 Drawer、确认/取消 Modal；关闭后焦点回触发控件。
- 路由后焦点进入 H1；当前导航 `aria-current=page`；图标按钮有名称；排序列有 `aria-sort`。
- 只读/禁用原因可由键盘获得；状态不只靠红/绿；正文 4.5:1、边界/焦点 3:1。
- Toast 不抢焦点；成功 polite live region，阻断错误 alert；表单多错误聚焦摘要并保留输入。
- `prefers-reduced-motion` 下取消非必要动效；业务成功不得依赖动画结束。

## 11. 攻击性与并发测试

- IDOR：合法 token + ws_alpha session 请求 ws_beta/brand_beta/store_beta/object ID；响应不得透露存在性差异。
- 参数混淆：header workspace 与 body/path/query workspace 不一致；以权威 resource resolver 拒绝。
- 多角色：allow + explicit deny；deny 优先。多个 assignment 仅合并各自 scope，不生成超集。
- TOCTOU：打开 Modal 后撤权/改 revision，再提交；服务端拒绝并保留用户输入。
- 缓存：工作台/工作区切换、退出 JIT、session 过期、浏览器 back/forward 后不得闪现旧数据。
- 并发：同一 grant max-use、同一 refund/publish idempotency key、并发成员角色更新、最后 owner 竞态。
- 失败注入：policy/grant repository、OIDC、Postgres、Redis、audit sink、provider 任一不可用，验证明确阻断且不放宽权限。

## 12. 实施完成后的执行顺序

### Phase A：先确认 diff 与覆盖面

1. 记录 base、commit 数和 `git diff --stat`；区分用户原有改动与本次 RBAC 改动。
2. 生成 MCP/HTTP/Worker/页面动作 inventory，并与 registry 做集合差异。
3. 搜索新散落的角色判断、隐式别名、catch-all 空数组和 wildcard scope。
4. 对照产品第 7/8 节逐项标记：证明、矛盾、缺失或证据太弱。

### Phase B：静态与定向自动化

在实现落地后按实际文件选择定向测试，最低命令集：

```bash
npm run typecheck
npm run test:ops-console
npm run build:ops-console
npm run test:release-gates
```

另运行新增的 authz registry、session、API/MCP parity、JIT/PostgreSQL、RLS、Worker 和审计定向测试。全量 `npm test` 作为回归补充，不替代运行验证。红测先按变更文件、环境变量、macOS `/var/folders` 与 Linux `/tmp` 差异分类，禁止修改无关业务代码掩盖环境问题。

### Phase C：本地真实表面

1. 使用仓库提供的本地 compose/启动入口启动 API、ops-ui、Postgres、Redis、Worker；不删除 volume。
2. 以真实 HTTP/MCP 请求执行 allow/deny/scope/JIT/审计链；保存脱敏响应。
3. 以真实 DB role 执行 RLS probes；以真实 worker 消费测试 outbox。
4. 使用桌面浏览器完成第 4、5、6、10 节的代表性流程与负向探针，保留截图/交互证据。
5. 执行容器 health/readiness；健康只证明进程可用，不自动证明权限通过。

### Phase D：生产发布门禁

在真实环境执行：OIDC 登录/session v2、插件 → MCP → API、双 DB role/RLS、JIT issue/use/revoke、Worker critical action、模型中转鉴权/请求/usage/cost/error、审计落库、容器/多副本、canary。

生产 canary 至少包含四条：

1. platform role 无 JIT 读取客户正文 → 403；
2. ws_alpha 主体读取 ws_beta → 403/不泄露存在性；
3. 合法 scoped 操作 → 2xx + mutation + audit；
4. grant 撤销后下一次读取和 critical worker 执行 → 拒绝。

## 13. 发布门禁与缺陷分级

### P0，任何一项即 NO-GO

- 未达到动态 N/N policy coverage；未知 method/route 不是 fail-closed。
- UI、MCP/HTTP、RLS 或 Worker 任一层可以扩大服务端有效权限。
- 跨 workspace/brand/store 可读取或修改；平台角色无 JIT 可读客户正文。
- OIDC/membership/grant/catalog/audit 配置缺失时降级为 allow、memory 或假空数据。
- critical 动作缺 MFA/审批/reason/revision/idempotency，或 Worker 无授权快照仍执行。
- 审计可修改/删除、敏感 token/正文进入日志，或授权决策无法追溯。

### P1，上线前必须清零

- 页面导航、深链、只读/写动作与 API 权限不一致。
- 切换 workspace/workbench/JIT 后旧数据残留；403/503/empty 混淆。
- 高风险操作影响范围不清、并发冲突未提示、失败丢输入。
- 核心桌面流程不可键盘完成或无可见焦点。

### P2，可在不扩大权限且 owner 批准时延期

- 不影响理解与安全的局部视觉间距、文案或低频性能问题。
- 延期必须有 issue、owner、期限；不能用 P2 标签掩盖权限解释或数据残留问题。

## 14. 最终验收报告模板

```text
VERDICT: PASS | FAIL | BLOCKED
BASE / COMMITS / DIFF:
ENVIRONMENT:

CODE EVIDENCE
- method policy: x/N（N 从构建产物读取）
- protected HTTP routes: x/x
- worker protected actions: x/x
- tests/build: command + result

LOCAL RUNTIME EVIDENCE
- OIDC/session:
- MCP/HTTP allow-deny parity:
- PostgreSQL/RLS:
- Worker/audit:
- desktop browser routes/roles/viewports:
- screenshots/videos:
- adversarial probe:

PRODUCTION EXTERNAL EVIDENCE
- OIDC:
- plugin → MCP → API:
- DB roles/RLS:
- JIT revoke/concurrency:
- worker/provider/model relay:
- canary/audit/container:

BLOCKERS / FINDINGS
- severity, exact reproduction, raw evidence, impacted requirement

DATA SAFETY
- no business/container data deleted
- credentials and customer content redacted
```

## 15. 当前待办与阻断

- [ ] 等待前后端、数据库、Worker 和权限注册表实现完成后复核实际 diff。
- [ ] 由 owner 冻结 canonical role/capability 词典及产品矩阵争议项。
- [ ] 新增逐方法 registry completeness、MCP/HTTP parity、角色/范围/JIT/RLS/Worker 测试。
- [ ] 执行定向测试、typecheck、ops build、release gates。
- [ ] 安全启动本地服务后执行桌面浏览器 smoke/角色矩阵并保存运行证据。
- [ ] 真实 OIDC、生产 DB role、provider/model relay、审计 sink、canary 证据未提供前保持生产 NO-GO。

本计划本身只属于**代码/文档证据**，不构成功能完成或上线证据。

## 16. 前端 P0 首轮复核记录（2026-08-31）

本节记录前端 owner 宣布 P0 完成后的首轮独立复核。后端仍在实现，因此结论仅覆盖当前 `apps/ops-console` 工作树，不代表 RBAC 全链路通过。

### 16.1 已取得证据

| 层级 | 证据 | 结果 |
| --- | --- | --- |
| 代码 | `AuthorizationProvider`、`createAuthorizationProjection`、13 域 capability 驱动导航、显式 deny、managed session 未加载 fail-closed | 部分符合 |
| 自动化 | `npm run test:ops-console` | PASS：62 个文件、284 个测试 |
| 构建 | `npm run build:ops-console` | PASS：TypeScript + Vite production build |
| 本地浏览器 | 当前源码 Vite local 模式，1440×900，总览首屏 | 页面可渲染，console 无错误；local wildcard 仅是开发行为，不是权限证据 |
| 本地浏览器 | 当前源码 Vite OIDC 模式，1440×900，无 workspace/session | 导航 fail-closed 并显示验证 Skeleton；console 无错误 |
| 截图 | `.gstack/qa-reports/screenshots/ops-rbac-frontend-p0-current-1440-2026-08-31.png` | local 开发态 |
| 截图 | `.gstack/qa-reports/screenshots/ops-rbac-frontend-p0-oidc-1440-2026-08-31.png` | OIDC 未建立 session 的 fail-closed 初始态 |

### 16.2 当前发现

1. **P1：受管会话仍存在角色模板回退。** 当 `effective_permissions` 与 `capabilities` 均未返回时，`createAuthorizationProjection()` 会从 `session.roles` 展开 `roleCapabilities`。已知当前 `ops.session` 可能返回原始 gateway role，这会让 UI 显示服务端实际不允许的域/动作。迁移期可以作为明确标记的兼容层，但不能作为最终 P0 完成态；后端 session v2 enforce 后应删除或仅在显式 shadow flag 下启用。
2. **P1：页面/Hook 仍直接推导角色。** `TasksPage`、`ModelsPage`、`StoresPage`、`AuditPage`、`IncidentsPage`、`useMembers`、`useOpsConsoleModel`、`modelMarkupVisibility` 等仍读取 `platform_ops`/其他角色。测试绿色未覆盖“所有业务动作只消费 capability”的完成定义。
3. **P1：生产 OIDC Header 仍默认展开连接表单。** OIDC 浏览器证据显示 API 地址和工作区 ID 常驻首屏；虽已隐藏 actor/token，但与 UI 规范“生产只在连接诊断 Drawer 展示连接配置”不一致，且抢占主任务空间。
4. **P1：全局角色/范围/JIT 上下文未完成。** 当前 Sidebar 能区分 platform/workspace/brand/store/controlled support 文案，但未见完整 `RoleScopeBar`、真实 workbench/workspace selector、grant 倒计时/退出、切换后取消请求和清缓存的浏览器证据。
5. **P1：403 信息不足。** Controller 的域级 Result 仍是通用“当前会话角色没有该页面权限”，未显示缺失 capability、当前 scope、request ID、刷新权限或“查看我的权限”；不满足可解释拒绝规范。
6. **证据限制：local 模式是 wildcard allow。** 当前 local 首屏展示 13 个域属于 `can() => true` 的开发适配器结果，不能用于证明任何角色矩阵。生产证据必须使用 OIDC session v2 或真实受控测试主体。
7. **范围尚未落地：AntD 主题/组件化重构不完整。** 当前源码未见根 `ConfigProvider` token、`RoleScopeBar`、`WorkspaceScopeSelector`、`AccessDeniedResult` 等设计规范组件；因此“UI 全面重构”仍未完成，不能因现有页面已使用 AntD 或 build 通过而结案。
8. **P1 / 运行失败：AntD message 上下文位置错误。** 当前源码 local Vite smoke 在模型计费加载失败时产生未处理异常：`TypeError: message.error is not a function`，位置 `useOpsConsoleModel.ts:1827`。`useOpsConsoleModel()` 在 `OpsConsoleController` 内先执行，`<AntApp>` 由该组件之后才返回，因此 hook 不在 App provider 之下。该问题会把本应可解释的 API/权限失败升级为前端未处理异常；284 个绿色测试未覆盖这个真实错误路径。修复后必须用运行页面触发一次失败响应并确认 Alert/message 正常且无 unhandled rejection。

### 16.3 阶段判定

**DONE_WITH_CONCERNS（仅前端 P0 基础设施） / 整体 NO-GO。** capability 投影和域级 fail-closed 已形成基础，测试与 build 通过；但角色回退、散落角色判断、可解释权限状态、双工作台/JIT 上下文和 AntD 设计系统仍需完成。待后端 session v2/method policy 合入后重新验证 UI 与 API 决策一致性。

## 17. 后端 P0 与前后端联合复核记录（2026-08-31）

### 17.1 已取得证据

| 层级 | 命令/检查 | 结果 |
| --- | --- | --- |
| 代码 | `npx tsx -e` 读取 `MCP_METHODS` 与 `assertMcpMethodPolicyCoverage()` | 240 declared / 240 registered，policy `2026-08-31.v1` |
| 自动化 | `npx vitest run --no-file-parallelism packages/contracts/src/authz.test.ts apps/api/src/security.e2e.test.ts apps/api/src/ops-integration.test.ts` | PASS：3 个文件、58 个测试 |
| 代码 | `highRiskCapabilityEnforcedMethods` 清点 | 仅 15 个方法进入 capability enforcement |
| 代码 | `enforceRegisteredMcpCapability()` | 全方法检查 registry 存在；严格环境仅 15 个方法检查 capability；未消费 scope/obligation |
| 代码 | `ops.session` | 返回 canonical roles、capabilities、scopes、policy version；仍把平台与 workspace 能力合并为一个集合 |

当前方法基线由方案阶段的 231 增至 240，包括新增 canonical backfill 与 conflict review 方法。后续所有文档和发布门禁应使用构建时自动读取的 `MCP_METHODS.length`，不要继续硬编码数量；231 仅是方案起草时的历史基线。

### 17.2 P0 未迁移边界

1. **246/246 是登记覆盖，不是执行覆盖。** 只有 15 个高风险方法执行 capability check；其余 231 个方法仍由旧 `requireOperationsRole`、领域 service、JIT、RLS 等路径决定。注册表绿色不能证明 240 个方法都已迁移，也不能证明 MCP/HTTP parity。
2. **统一授权器尚未实现 scope/obligation。** `enforceRegisteredMcpCapability()` 只检查 capability 是否存在，不比较 policy scope 与资源 scope，也没有 reason/revision/idempotency/MFA/two-person/JIT、deny precedence 或 authorization decision audit。高风险方法的这些约束仍依赖旧 handler/service；不能称为统一 PDP/PEP。
3. **平台/workspace 工作台仍隐式并集。** `effectiveAuthorizationProjection()` 同时展开 gateway platform role 和 member role，并返回 platform + workspace scopes；没有 workbench 参数或按工作台裁剪。与“双工作台不得同页自动合并”契约不符。
4. **持久 JIT、撤销、审批与使用次数未落地。** 现有 HMAC/TTL/JIT 与旧 customer-data 边界继续提供保护，但目标数据模型、即时撤销、审批人、工单、nonce/max-use 持久并发验证仍缺失。
5. **Worker 授权快照未落地。** 当前 P0 没有证明全部高风险 outbox 携带 `decision_id/requested_by/capability/scope_hash/policy_version/grant_ids`，也没有执行前撤销/资源 revision 检查。
6. **RLS 与审计未由新 decision 贯通。** 现有 RLS、双 pool 和领域审计仍是安全基础；尚无统一 decision ID、matched assignment/grant、policy version、obligation evidence 的不可变关联。

### 17.3 前后端 P0 阻断

后端 session 使用 contracts capability ID，例如 `platform.summary.read`、`workspace.directory.read`、`identity.read`、`customer.content.read`、`feature_flag.read`；首轮前端域表则使用另一套 ID，例如 `ops.overview.read`、`ops.users.read`、`platform.identity.read`、`ops.tasks.read/workspace.content.read`、`ops.feature_flags.read`。

这不是命名美观问题。session 一旦返回 `capabilities`，前端就停止 role adapter 回退，导致合法生产 OIDC 用户的总览、用户、任务等域被错误隐藏或深链 403。修复门禁：前端直接复用 contracts `CapabilityId` 或由同一真源生成映射，并用真实 `ops.session` payload 对 13 域做契约测试。

### 17.4 阶段判定

**P0 DONE_WITH_CONCERNS / 整体 NO-GO。** 已完成 246/246 显式 policy inventory、canonical role/capability 投影和 15 个高风险方法的额外 capability 收窄；原有 role/service/JIT/RLS 继续生效，未观察到代码主动删除旧安全边界。但统一 scope/obligation/decision audit、其余 231 个方法 enforcement、持久 JIT、Worker snapshot、双工作台仍未完成。

## 18. 最终联合复核更新（2026-08-31）

第 16、17 节保留了发现问题时的原始证据。随后 owner 已修复前端 capability 命名、managed raw-role 回退和 AntD provider 层级；最终复核又捕获 MCP inventory 并发新增导致的 registry 漂移，修复后重新验证如下。

### 18.1 最终命令与结果

| 检查 | 精确命令 | 最终结果 |
| --- | --- | --- |
| Ops UI tests | `npm run test:ops-console` | PASS：63 files / 287 tests |
| Ops UI production build | `npm run build:ops-console` | PASS：TypeScript + Vite，3189 modules transformed |
| Authz/API targeted | `npx vitest run --no-file-parallelism packages/contracts/src/authz.test.ts apps/api/src/security.e2e.test.ts apps/api/src/ops-integration.test.ts` | PASS：3 files / 58 tests |
| Policy inventory | `npx tsx -e` 读取 `MCP_METHODS` 和 `assertMcpMethodPolicyCoverage()` | PASS：240 declared / 240 registered，policy `2026-08-31.v1` |
| Diff whitespace | `git diff --check -- apps/ops-console packages/contracts/src/authz.ts apps/api/src/server.ts doc/todo/ops/ops-rbac-acceptance-plan-2026-08-31.md` | PASS |
| Local containers | 重建 `api`、`ops-ui` 与六类 worker 后执行 `docker compose -f infra/local/docker-compose.yml ps` | PARTIAL：API 双副本、ops-ui、merchant-ui、Postgres、Redis 及五类 worker healthy；scan worker 因缺 `ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM` fail-closed/restarting，ClamAV health unhealthy |

方法数最终从方案阶段的 231 增长到 240：canonical backfill 先新增 6 个方法，最终又新增 3 个 conflict review 方法。最终 QA 首次重跑真实捕获 `240 declared / 237 registered` 并使 3 个 suite 在 import 阶段 fail-closed；补齐 `conflicts.list` 的 read policy 和 `conflict.claim/resolve` 的 audited write policy 后恢复 246/246。该事件证明发布门禁必须动态比较集合，文档不能硬编码旧数字。

### 18.2 最终 OIDC 前端 smoke

测试表面：当前稳定源码，Vite `VITE_OPS_AUTH_MODE=oidc`，只读本地 fixture API；视口 1440×900。fixture 仅驱动服务端 session projection/错误响应，不写数据库，也不构成真实 OIDC 签名或生产 API 证据。

| 场景 | 观察 | 证据 |
| --- | --- | --- |
| canonical server capability fixture | `ops.session` 返回 contracts ID 后 13 个域全部出现；scope 显示 platform；域请求失败显示明确 partial/error 而非空态 | `.gstack/qa-reports/screenshots/ops-rbac-final-oidc-capabilities-1440-2026-08-31.png` |
| managed session 只有 raw `roles`、无 permissions/capabilities | 0 个域导航；overview 深链显示 403；raw `platform_ops` 未恢复 legacy allow | `.gstack/qa-reports/screenshots/ops-rbac-final-oidc-deny-all-1440-2026-08-31.png` |
| model markup 与其他域返回显式 503 | 页面展示“部分运营数据未刷新/无法加载运营数据”和重试；当前 Vite 进程无 `message.error is not a function` 或 unhandled rejection | `.gstack/qa-reports/screenshots/ops-rbac-final-oidc-error-path-1440-2026-08-31.png` |

浏览器 network console 中存在 fixture 有意返回的 503 resource errors，这是错误路径输入，不是前端未处理异常。之前共享工作树并发 delete/add 文件造成的 Vite HMR 404 已在文件恢复后通过全新页面加载、最终 tests/build 重新验证，不作为稳定源码缺陷。

### 18.3 已关闭的 P0 前端发现

- 前后端 capability 已统一使用 contracts `CapabilityId`；13 域真实 session shape 有契约测试和浏览器证据。
- managed session 无服务端投影时使用 `source: deny-all`，不再从 raw gateway role 扩权。
- `OpsAntAppBoundary` 已位于调用 `useOpsConsoleModel()` 的 runtime 外层；真实 503 smoke 未再产生 message API 异常。
- `ops.session` 加载失败有阻断态；未验证权限时不加载深链页面与动作。

### 18.4 最终判定

**P0 DONE_WITH_CONCERNS；整体目标仍为 NO-GO。**

P0 已交付并验证的边界：246/246 method policy inventory、canonical role/capability session projection、前端 managed fail-closed、13 域 canonical capability 导航、15 个高风险方法的额外 capability 收窄，以及现有 role/service/JIT/RLS 安全边界继续保留。

仍阻断整体完成和生产发布：

1. 其余 225 个 MCP 方法尚未迁移统一 capability enforcement；HTTP parity、逐方法 allow/deny/scope/obligation 也未完成。
2. 当前 enforcement 不消费统一 scope、explicit deny、MFA/two-person/JIT/reason/revision/idempotency 或 decision audit；这些仍依赖分散旧门禁。
3. 持久可撤销 JIT grant、平台角色 assignment、双工作台裁剪、Worker authorization snapshot、统一 decision audit 和最终 RLS probe 未落地。
4. Ant Design 全面模块化/主题与权限 UX 尚未完成：根 token、完整 RoleScopeBar/workbench selector/JIT 倒计时与退出、可解释 403、剩余散落 role 判断仍是 P1/P2 实施项。
5. 本轮没有真实生产 OIDC、双 Postgres role/RLS、模型中转鉴权/usage/cost/error、审计 sink 和 production canary 证据；本地容器也未全绿：scan worker 明确因缺签名私钥 fail-closed，ClamAV health 仍 unhealthy。不得注入虚构密钥绕过该门禁。

因此可以合并“RBAC P0 基础设施”继续迭代，但不能宣称插件全功能权限、运营后台重构或生产上线目标已经完成。

## 19. P1 独立审查基线与机器化完成清单（2026-08-31）

本节是 P1 实施过程中的只读审查快照，不覆盖第 18 节已经取得的 P0 证据。审查使用当前工作树的 CodeGraph 本地索引与 `rg` 交叉验证；CodeGraph 同步后为 800 files / 11,189 nodes / 41,647 edges。由于共享工作树仍在并行变更，下面的数量只描述本次快照，所有发布门禁必须在最终提交上重新运行，不能把文档中的 240、15 或任何历史数字当常量。

### 19.1 当前代码基线

| 检查面 | 当前代码证据 | P1 判定 |
| --- | --- | --- |
| MCP inventory | `MCP_METHODS.length = 240`，`MCP_METHOD_POLICIES = 240`，`assertMcpMethodPolicyCoverage()` 返回 246/246 | 登记覆盖保持通过；必须持续动态监测漂移 |
| policy 分类 | scope 分布：workspace 179 / platform 55 / self 6；brand/account 为 0。audit 分布：mutation 124 / deny_only 94 / allow_and_deny 22 | 只有 scope 类型元数据；尚未证明资源 ID 精确匹配 |
| runtime decision | contracts 已有 `AuthorizationDecision`、explicit-deny precedence、scope/obligation reason；API 已调用 `evaluateAuthorizationDecision()` | 有统一 decision 雏形，但尚未形成全链路可信输入和全量强制 |
| rollout | `MCP_AUTHZ_MODE=shadow|staged|enforce`；`enforce` 覆盖全部 246 个登记方法，`staged` 仍按域推进，15 个高风险方法始终 enforce | 已具备显式最终强制态；生产仍需在真实 OIDC、RLS、Worker、审计 sink 和 canary 上验证，不能把本地全量枚举当成生产证据 |
| scope | `evaluateAuthorizationDecision()` 当前仅判断同类型 scope 存在且 ids 非空；没有将请求资源 ID 与 grant ID 做集合匹配 | cross-workspace/brand/account 精确范围仍是阻断 |
| explicit deny | `RequestPrincipal` 有可选 `explicitDeniedCapabilities`，但当前源码没有赋值点 | evaluator 单测通过不等于运行时 deny 已接通 |
| obligations | API 按方法名手写 reason/idempotency/confirmation/MFA 子集；没有统一 revision、approval/two-person/JIT grant 解析 | policy registry 与 obligation resolver 仍可能漂移 |
| decision audit | enforced deny 与 `allow_and_deny` allow 可写 `authz.decision`；请求 observation 带 decision/policy/mode/result/reason/capability | shadow 与普通 mutation 的不可变 decision 关联、matched grant/scope evidence 尚不完整 |
| 前端角色判断 | 当前窄正则剩 4 行/3 个文件：finance response schema 角色枚举，以及成员目标角色保护/选项过滤 | 页面域和主要动作已明显收敛；成员治理仍需服务端可分配角色/目标约束契约，不能由字符串决定权限 |
| 双工作台 | `RoleScopeBar` 仅依据最终 scope 显示“平台控制台/商家工作区”；未见主动 workbench selector、URL scope 切换协议或独立 capability snapshot | 未完成“不自动合并两套权限” |
| JIT | 前端只读取 `temporary_grants` 显示到期时间；API/session/persistence 未检出对应统一 grant 投影、申请/审批/撤销模型 | 未完成；当前标签不是 JIT 工作流证据 |
| 403 | `AccessDeniedResult` 可显示 capability/scope/request ID，但 controller 的客户端深链拒绝没有 request ID；API 403 的 request/trace 已由 `OpsPageError` 支持 | 组件存在，需验证服务端 403 保留输入、停止 loading、不重试、不泄露对象存在性 |
| AntD 根主题 | CodeGraph 与 `rg` 均未发现 `ConfigProvider` | 设计系统 token 尚未落地；UI 方案把它列为 T6/P2，但“全面 AntD 重构”完成前仍需验收 |
| Worker | Worker 会在部分 connector 写前调用 API execution-check，但未见统一 `decision_id/requested_by/capability/scope_hash/policy_version/grant_ids` envelope | 异步授权快照和撤销后执行阻断未完成 |

### 19.2 每次提交必跑的动态 inventory 门禁

- [x] **P1-GATE-001：MCP 集合精确相等（本地契约已验证）。** `6ab248a` 的 `authz.test.ts` 补齐精确 policy coverage；对应测试验证实时方法集合与 policy 注册表一致，并拒绝未知方法。仍需在最终发布提交上动态重跑，不能将本地结果当作生产证据。

```bash
npx tsx -e "import { MCP_METHODS } from './packages/contracts/src/mcp.ts'; import { MCP_METHOD_POLICIES, assertMcpMethodPolicyCoverage } from './packages/contracts/src/authz.ts'; const coverage=assertMcpMethodPolicyCoverage(); if (MCP_METHODS.length !== Object.keys(MCP_METHOD_POLICIES).length) process.exit(1); console.log(JSON.stringify({methods:MCP_METHODS.length,policies:Object.keys(MCP_METHOD_POLICIES).length,...coverage}))"
```

- [x] **P1-GATE-002：集合内容相等而非只比数量（本地契约已验证）。** `6ab248a` 的 `authz.test.ts` 已验证 method key 集合与 `MCP_METHODS` 精确相等，并对未知方法 fail-closed；新增、删除或重命名方法仍必须在最终提交重新执行该门禁。
- [x] **P1-GATE-003：handler/contract/policy 三集合相等。** `tests/ops-api-surface.test.ts` 直接从 API `case` dispatch 提取完整 handler 集合，不再先按声明集合过滤；动态断言 `declared = registered policy = implemented handler`，任一缺失或额外 handler 都会失败。
- [ ] **P1-GATE-004：HTTP parity（生产运行证据仍未完成）。** 契约层已由 `HTTP_OPERATION_POLICIES`、OpenAPI 一一覆盖测试及服务端 `enforceRegisteredHttpCapability()` 接入同一 MCP policy；剩余验收是逐路由真实 allow/deny、scope、obligation、JIT、decision audit 和生产 OIDC/RLS 证据，不能仅凭契约测试勾选完成。

### 19.3 前端 P1 completion checklist

- [x] **P1-FE-001：权限判断只消费统一 projection（本地源码审计完成）。** 页面、hook、action handler 不读取 session/raw role 决定可见、只读或可操作；当前唯一命中为财务结果的服务端返回 `scope.role` schema 校验，属于允许的返回契约校验，不用于授权决策。运行时生产身份与 RLS 仍需外部验收。

```bash
rg -n --glob '!**/*.test.*' "(sessionRoles|opsSession\\?\\.roles|model\\.sessionRoles|\\brole)\\.(includes|some)|\\brole\\s*(===|!==)|\\[.*\\]\\.includes\\((role|String\\(scope\\.role\\))" apps/ops-console/src
```

- [x] **P1-FE-002：成员治理目标约束服务端化（本地切片完成）。** session 返回 `assignable_roles`，成员列表返回 `governance` 目标约束；前端不根据 `platform_ops/workspace_owner` 字符串推导谁可授予、降级、停用。单元/API 测试覆盖最后 owner、自身停用、平台角色授予与并发 revision；真实 OIDC/RLS/生产矩阵仍是上线门禁。
- [x] **P1-FE-003：13 域矩阵由 contracts 生成（本地切片完成）。** 前端域读取映射测试改为遍历实时 `domainReadCapabilities`，canonical role 测试遍历 contracts 的 `CANONICAL_ROLES`；managed session 无服务端 projection 对所有角色 deny-all。显式 deny 已有回归，生产矩阵与真实 OIDC 仍是上线门禁。
- [ ] **P1-FE-004：双工作台显式切换。** 同时持有 platform 与 workspace assignment 的主体必须主动选择 workbench；服务端分别返回裁剪后的 capability/scope，UI 不做并集。浏览器测试验证：切换前确认未保存内容、abort 旧请求、清空旧数据/筛选/选中 Drawer、更新 URL、拉取新 session snapshot，旧响应迟到不得回填。
- [x] **P1-FE-004：双工作台显式切换（本地代码切片完成）。** 服务端 `ops.session` 按 workbench 裁剪；UI 只使用服务端 `available_workbenches`，切换前显式清理授权数据/session，随后 abort 旧请求、持久化 workbench、更新 URL，并通过 keyed runtime 重新拉取 session。未保存表单确认与真实浏览器多角色证据仍为上线门禁。
- [ ] **P1-FE-005：JIT 完整体验。** 支持申请、审批状态、精确 workspace/brand/store 与 read/write scope、倒计时、主动退出/撤销、过期自动清除数据；使用 fake timer 与浏览器测试证明到期瞬间导航/数据/动作同时收口，而不只是显示格式化到期时间。
- [ ] **P1-FE-006：统一 403。** 深链拒绝显示缺失 capability、当前 scope、策略/decision reason、request ID（有服务端请求时）和刷新权限；action 403 保留用户输入、结束 loading、不自动重试。跨租户对象的 403/404 投影不得泄露对象是否存在。
- [x] **P1-FE-007：403 相关信息可传播。** `OpsRequestError.requestId/traceId/details.decision_id/reason_code/obligations_missing` 已映射到统一错误呈现并由 `opsClient.test.ts`、`OpsPageError.test.tsx`、`permissionUx.test.tsx` 覆盖；客户端预判不生成 request/trace ID，明确区分尚未发请求与服务端拒绝。
- [ ] **P1-FE-008：根 AntD 设计系统。** 根 `ConfigProvider` 提供批准的 token/component token；`AntApp` 保持位于所有 `useApp()` consumer 外层。1440×900 与 1920×1080 桌面截图、键盘路径、对比度、reduced-motion 通过；移动/平板不作为本项目门禁。
- [ ] **P1-FE-009：连接诊断不占主工作区。** OIDC 生产态不常驻 API/token 表单；连接信息进入诊断 Drawer，token 永不回显。local development adapter 必须有醒目标记且不能进入 production build/runtime 配置。
- [x] **P1-FE-009：连接诊断与生产认证边界（本地切片完成）。** 连接配置仅在诊断 Drawer 展示；已保存 Bearer token 不进入表单草稿或 DOM，空 token 保存保持既有凭据。production bundle 无条件启用 OIDC，`VITE_OPS_AUTH_MODE=local` 不能降级；启动时同时清除 localStorage/sessionStorage 的 local adapter 配置、endpoint、actor、token、workspace/workbench 覆盖。`OpsHeader.test.tsx`、`opsClient.test.ts`、production build 及 1440×900 production preview 验证预置 secret 不在 DOM、无 actor/token 字段、无本地 `8787` 请求、console 无错误且显示 SSO 托管会话；真实 OIDC gateway 登录与部署证据仍为上线门禁。

### 19.4 后端授权、scope、审计 P1 completion checklist

- [x] **P1-BE-001：每个方法都生成 decision。** strict auth 下遍历实时 `MCP_METHODS`，逐方法断言调用统一 evaluator 并产生唯一 `decision_id/policy_version/mode/result/reason_code`；绕过仅允许有明确契约和测试的 bootstrap，不能在 handler 内另读 header 扩权。
- [x] **P1-BE-002：shadow 不冒充完成。** shadow 只用于差异观测；发布配置必须显式列出 enforce 域并有覆盖率报表。最终全量强制时，动态计算 capability domain 集合并断言全部进入 enforce，不能以当前 15 个高风险方法或手写历史总数替代。
- [ ] **P1-BE-003：资源 ID 精确 scope。** evaluator 输入必须来自逐方法 scope resolver，比较请求/加载后资源的 workspace、brand、account、self ID 与 grant IDs；测试至少覆盖同类型但不同 ID 的 cross-workspace、cross-brand、cross-account 拒绝，以及 platform aggregate 不读取 customer detail。
- [ ] **P1-BE-004：显式 deny 有真实来源。** principal 的 deny 来自持久 assignment/deny 数据或可信 session projection，并在 capability allow、角色并集、JIT grant 之前生效。运行测试必须证明源码存在赋值路径以及 allow + deny 同时出现时 deny。
- [ ] **P1-BE-005：obligation 与 policy 同真源。** reason、revision、idempotency、confirmation、MFA、approval/two-person、JIT grant 由 policy/obligation registry 声明并由通用 resolver 校验；CI 检查所有 write/allow_and_deny 方法的 obligation 分类，不允许 API 中另维护容易漂移的方法名数组。
- [ ] **P1-BE-006：双工作台服务端裁剪。** `ops.session` 接收/绑定明确 workbench，平台 assignment 与 workspace membership 不自动合并；workbench、scope 与 capability snapshot 共同签名/绑定 session。切换必须重新取 snapshot，旧 snapshot 不能跨 workbench 使用。
- [ ] **P1-BE-007：JIT 持久且可撤销。** grant 绑定 actor、workspace、exact scopes、read/write、工单/事故、审批人、issued/expires/revoked、nonce/max-use；并发测试覆盖过期、撤销、重放、scope mismatch 和使用次数竞争。原有 `OPS_CUSTOMER_ACCESS_*` fail-closed 票据在迁移完成前不得移除。
- [ ] **P1-BE-008：decision audit 可重建。** enforced deny、敏感 allow、权限变更、JIT 使用均持久记录 decision ID、policy/catalog version、actor、workbench、resource scope、matched assignments/grants、explicit deny、obligation evidence、request/trace ID；审计写失败对高风险写 fail-closed。测试读取审计仓储验证内容，而非只断言日志函数被调用。
- [ ] **P1-BE-009：旧门禁差异归零后再删除。** shadow 报表对比新 decision 与旧 role/service/JIT/RLS 结果；按 method/workspace 统计 allow/deny 差异，差异未归零不得移除旧门禁。删除时必须有负向回归证明安全强度未下降。
- [ ] **P1-BE-010：RLS 最终防线。** 使用真实 production-like app/ops DB roles 执行正负 SQL probe；应用 allow + RLS scope mismatch 仍拒绝，`merchant_ops + platform_scope` 只能读批准的聚合/脱敏视图，不能读取客户正文表。
- [ ] **P1-BE-011：Worker 快照与执行时复核。** 所有外部副作用 envelope 持久包含 `requested_by/authorization_decision_id/capability/scope_hash/policy_version/grant_ids/resource_revision`；Worker 在 connector 写前复核撤销、TTL、scope 和 revision。测试覆盖“排队后撤销再执行”必须拒绝且不调用 provider。
- [ ] **P1-BE-012：错误契约稳定。** capability/scope/explicit deny/obligation/catalog/JIT 拒绝分别返回稳定 code、decision/request ID 和最小化 details；403、503、真实 empty 三者不可互换，错误体不得暴露目标对象内容或存在性。
- [x] **P1-BE-012：统一 evaluator 拒绝详情（本地切片完成）。** capability、scope、workbench、explicit deny、obligation 五类拒绝统一由 `authorizationDenialDetails()` 生成稳定的 decision/capability/reason/required scope/workbench/explicit-deny/obligation/policy 字段；request/trace ID 继续由 API envelope 提供。定向测试遍历五类 reason，并证明 details 不含 resource ID、解析 scope IDs 或目标对象内容。catalog/JIT 专用错误、503/empty 与真实 OIDC 运行矩阵仍为主项门禁。
- [x] **P1-BE-012：JIT 执行前复核错误关联（本地切片完成）。** evaluator allow 后的临时授权复核保持 `AUTHORIZATION_GRANT_RECHECK_UNAVAILABLE` 为 503、撤销/过期/耗尽/版本变化保持 `AUTHORIZATION_GRANT_REVOKED` 为 403，并统一携带 decision/capability/required scope/workbench/policy/grant ID；details 不含 grant scope、resource ID 或解析 scope IDs。catalog 专用错误、完整 503/empty 与真实 OIDC 运行矩阵仍为主项门禁。
- [x] **P1-BE-012：policy catalog 与 403/503/empty 三态（本地切片完成）。** MCP/HTTP policy 缺失统一返回 `AUTHZ_POLICY_UNAVAILABLE` 503，并携带 policy version、transport、method/operation，不包含请求参数或目标对象。真实 HTTP 测试证明 403、503 均为 `data:null + error` 且保留 request/trace ID；新工作区商品分页空态为 200、`error:null`、`items:[]/total:0`。真实 OIDC 运行矩阵仍为主项门禁。

### 19.5 最终回归与发布判定

- [ ] `npm run test:ops-console`、`npm run build:ops-console`、contracts authz、security E2E、ops integration、request observability、Worker targeted tests 全绿；记录精确 files/tests 数，不复用第 18 节旧数字。
- [ ] 1440×900 OIDC 桌面浏览器覆盖 platform/workspace/controlled-support、显式 deny、scope mismatch、JIT 到期/撤销、action 403、session 503；每个场景保存截图、console/network 摘要，fixture 与真实 OIDC 证据分栏。
- [ ] 本地容器必须重新构建 API、ops-ui 与相关 Worker；健康检查、迁移、真实 Postgres role/RLS probe 全绿。缺 signer/key/provider/relay 配置继续显示外部阻断，不注入虚构凭据。
- [ ] 生产门禁动态报告：当前 MCP 总数、policy 总数、shadow/enforce 总数与比例、HTTP policy 覆盖、scope resolver 覆盖、obligation 覆盖、decision audit 写入、Worker snapshot 覆盖。任一分母来自实时 registry/route/envelope 集合。
- [ ] 在真实 OIDC、生产 DB role/RLS、JIT signer/revocation、audit sink、Worker execution-check、模型中转鉴权/usage/cost/error 与 canary 证据齐备前，整体结论保持 **NO-GO**。

### 19.6 全量 MCP capability enforcement 增量（2026-08-31）

`apps/api/src/server.ts` 现已让全部已登记 MCP 方法进入 policy registry，并支持按 `MCP_AUTHZ_ENFORCE_DOMAINS` 分阶段执行 canonical capability 校验；这不是“240 个方法已在生产全量 enforcement”。当前默认 always-enforced 仍为原先 15 个高风险方法，其他方法在显式开启的 capability domain 中执行；为保持既有最小权限行为，补齐了平台运营自动化读取/店铺连接更新/商业配置、商家管理员工作区删除与商业 rollout、运营/客服个人账务导出、规则管理员用户目录导出、finance 商业目录读取、平台客服 feature flag 读取，以及首次 OIDC bootstrap 的无成员例外。

证据：安全、API、Ops 集成和 MCP completion 相关套件、TypeScript、release gates 均通过；CodeGraph 需以本轮同步结果为准。运行时现在支持显式 `shadow/staged/enforce`，其中 `enforce` 才是全量执行态；`246/246` 仅代表声明方法与 policy registry 的登记覆盖，不能代表生产已经启用全量执行。统一 scope/obligation/decision audit、持久 JIT、Worker snapshot、HTTP parity 和真实生产链路证据仍是未完成项。

这项增量仍不等于整体 RBAC 完成：剩余方法的 staged enforcement、统一 scope/obligation/decision audit、持久可撤销 JIT、平台角色 assignment、双工作台裁剪、Worker authorization snapshot、全量 HTTP parity、真实 OIDC/PostgreSQL 双角色/Worker/审计 sink/模型中转和生产 canary 证据仍缺失。因此本文件继续保持 `TODO / NO-GO`，不得迁移到 `doc/done`。

### 2026-08-31 契约/策略/路由动态清单增量

`tests/ops-api-surface.test.ts` 新增动态 inventory 断言：当前 MCP 契约、`MCP_METHOD_POLICIES` 和 API dispatch 的完整 method key 集合必须相等，并由 `assertMcpMethodPolicyCoverage()` 验证策略注册完整。该测试 4/4 通过，不绑定历史方法数量；HTTP parity、生产 enforcement 和真实 OIDC/RLS 仍未完成。

另新增 HTTP/MCP 引用清单测试：所有 identity HTTP policy 的 `mcpMethod` 必须同时存在于实时 MCP 方法集合和授权策略注册表，identity 数量由 registry 动态计算；`HTTP_OPERATION_POLICIES` 还与 OpenAPI operation 做一一覆盖校验，服务端在认证后执行同一注册 policy。契约/Authz 定向回归与本轮 release gates 通过。该项完成契约层 parity；运行时逐路由 allow/deny/JIT/审计和生产证据仍未完成。

### 2026-08-31 403 诊断证据传播增量

模型层现在保留实际 `ops.session` 错误的 request/trace ID、错误码和安全 details，统一拒绝页消费并展示这些服务端证据；无真实错误时不伪造 ID。权限 UX/model helper 回归 18/18、类型检查、Ops 构建和 diff check 通过。真实 OIDC 网关注入、decision audit、RLS 与生产角色矩阵仍未完成。

### 2026-08-31 成员治理目标约束投影增量

`ops.members.list` 现在返回服务端计算的 `governance` 目标约束；前端不再根据目标成员原始 role 推断保护状态，缺少投影时 fail-closed。成员 API 与前端治理回归 6/6 通过，服务端原有 owner/platform/self/CAS 门禁未移除。可分配角色清单、JIT、真实 OIDC/RLS、decision audit 和生产矩阵仍未完成。

## 20. P1 最终独立复验（2026-08-31）

本节追加于当前稳定工作树，不改写第 18、19 节的历史快照。验收遵循 `verify-feature` 与 gstack `qa-only`：只读检查业务实现，运行真实构建、测试和 1440×900 桌面浏览器；本节唯一写入是本验收文档。浏览器使用本地 Vite OIDC 模式和只读 session fixture，不写数据库，也不冒充真实 OIDC、生产 API 或生产审计证据。

### 20.1 最终命令与结果

| 检查 | 精确命令 | 当前稳定源码结果 |
| --- | --- | --- |
| Ops UI tests | `npm run test:ops-console` | PASS：63 files / 290 tests |
| Ops UI production build | `npm run build:ops-console` | PASS：TypeScript + Vite 8.2.2，3192 modules transformed |
| Authz/API/observability | `npx vitest run --no-file-parallelism packages/contracts/src/authz.test.ts apps/api/src/security.e2e.test.ts apps/api/src/ops-integration.test.ts apps/api/src/request-observability.test.ts` | PASS：4 files / 77 tests |
| 关键负向用例 | `npx vitest run --no-file-parallelism --reporter=verbose packages/contracts/src/authz.test.ts apps/api/src/security.e2e.test.ts apps/api/src/request-observability.test.ts packages/persistence/src/members-repository.test.ts -t 'fails closed on missing or unknown production authorization modes\|projects server-computed capabilities\|evaluates complete allow, deny and scope semantics\|reports a shadow denial\|enforces an explicit principal deny even while the capability domain is in shadow mode\|records bounded authorization decision evidence\|fails closed when an enforced authorization decision cannot be persisted to the audit sink\|rolls back the member update when the audit insert fails'` | PASS：14 selected / 62 skipped；覆盖 staged 配置、session projection、exact scope、explicit deny、shadow、审计最小化和两类 audit fail-closed |
| 动态 policy inventory | `npx tsx -e` 直接读取 `MCP_METHODS`、`MCP_METHOD_POLICIES`、`AUTHZ_POLICY_VERSION` | PASS：methods/policies/declared/registered 均为 240，18 个 capability 顶级域，policy `2026-08-31.v1` |

240 是本次实时输出，不是验收脚本常量。发布门禁仍须动态比较集合；后续 MCP 方法漂移必须让 coverage 测试立即失败，不能把本文数字复制进断言。

### 20.2 1440px 桌面浏览器复验

本地表面：`VITE_OPS_AUTH_MODE=oidc` 的 Vite 控制台，经同源只读 fixture 提供 `ops.session`；独立 shot-scraper 与全新 Playwright context 均使用 1440×900。fixture 在 capability 场景对业务数据方法故意返回 503，以验证错误态；这不等于真实 API 成功证据。

| 场景 | 本地运行观察 | 证据 |
| --- | --- | --- |
| canonical capability session | RoleScopeBar 显示 canonical `平台运营`、身份、平台控制台、平台全局和 policy version；13 个桌面域导航可见；连接诊断默认折叠 | `.gstack/qa-reports/screenshots/ops-rbac-p1-capabilities-1440-2026-08-31.png`、`.gstack/qa-reports/screenshots/ops-rbac-p1-final-capabilities-shot-scraper-1440-2026-08-31.png` |
| 连接诊断展开 | 实际点击后 `aria-expanded=true`；只出现 API base/workspace，OIDC/SSO 提示存在，不出现 token 字段；点击前清空 console，交互后无前端异常 | `.gstack/qa-reports/screenshots/ops-rbac-p1-managed-diagnostics-open-1440-2026-08-31.png` |
| managed raw-role、无 capability projection | raw `platform_ops` 只作为身份文本显示；域导航为 0；`/ops/users` 呈现统一 AccessDeniedResult，明确 `identity.read` 和 platform scope；诊断 `aria-expanded=false`；没有“部分运营数据未刷新” | `.gstack/qa-reports/screenshots/ops-rbac-p1-final-deny-all-shot-scraper-1440-2026-08-31.png` |
| deny-all 请求收口 | 首轮独立 QA 抓到 13 个 `/api/mcp` POST 和误导性的 partial warning；修复 capability-aware hydration 后，最终 JSONL 共 52 条资源请求，其中 `/api/mcp` 精确 1 条、HTTP 200。全新 Playwright context 同时捕获 POST body 方法集合精确为 `["ops.session"]` | `.gstack/qa-reports/ops-rbac-p1-final-deny-shot-requests.json` |
| Ant Design 根主题 | 运行截图可见统一蓝色主操作、深色侧栏、Result/Alert/Card 样式；代码证据是根 `ConfigProvider theme={opsTheme}`，其 token 明确 primary/info/success/warning/error、背景、边框、圆角和控件高度；`OpsAntAppBoundary` 仍包裹所有 message consumer | `apps/ops-console/src/main.tsx`、`apps/ops-console/src/theme/opsTheme.ts` 与上述截图 |

最终 deny-all 独立请求日志核验命令为：

```bash
wc -l .gstack/qa-reports/ops-rbac-p1-final-deny-shot-requests.json
rg -c '"url": "http://127.0.0.1:4179/api/mcp"' .gstack/qa-reports/ops-rbac-p1-final-deny-shot-requests.json
```

结果分别为 `52` 和 `1`。该闭环证明只隐藏导航不够：无投影会话还必须禁止后台 hydration；以后浏览器门禁应同时断言 UI、POST method 集合和错误提示。

### 20.3 后端 P1 证据边界

| 能力 | 代码证据 | 自动化/本地运行证据 | 当前边界 |
| --- | --- | --- | --- |
| shadow / staged | 生产缺失或未知 mode/domain 503 fail-closed；默认 15 个高风险方法强制，其余由显式 capability 顶级域 staged 扩大 | security E2E 验证 `support,incident` staged 集合；contracts 验证 shadow denial 可观测但未迁移 handler 继续执行 | shadow 不是授权完成；其余方法仍依赖旧 role/service/JIT/RLS |
| exact scope | decision 比较请求 resource type/id 与 grant IDs，不再只判断同类型 scope 非空 | `member exact resource deny`：workspace `ws_1` grant 对 `ws_2` resource 返回 `AUTHZ_SCOPE_MISMATCH` | 尚无完整逐方法 workspace/brand/account resolver 覆盖率与真实 RLS probe |
| explicit deny | bearer `denied_capabilities` 进入 principal，未知 capability ID 503；`ops.session` 返回 deny 并从 effective capabilities 扣除 | `feature flag explicit deny` 与“shadow mode 仍优先 explicit deny”均通过；security E2E 覆盖 session 投影 | 持久 assignment/deny 管理面和全量方法 enforcement 尚未完成 |
| obligations | handler 使用 MethodPolicy SSOT 中的 obligations，无另一份手写 required-method 数组 | reason/confirmation 等 obligation 缺失的 deny 用例通过 | approval/two-person、持久 JIT、全部 write 方法 obligation 覆盖仍缺 |
| decision audit fail-closed | request observation 与 operation audit 都带 decision metadata；高风险 enforced decision 的持久化被 `await` | `fails closed when an enforced authorization decision cannot be persisted to the audit sink` 注入 `AUTHZ_AUDIT_SINK_UNAVAILABLE`，断言完整 deny evidence 已交给 sink、请求返回 HTTP 500/`INTERNAL_ERROR` 而不是继续返回普通 403，且 unhandled error 记录 sink 故障；成员更新审计失败事务回滚也通过 | 本地内存/故障注入不是生产不可变 audit sink、查询重建或保留策略证据 |

### 20.4 证据分层与最终判定

- **代码证据：** canonical-only 前端 authorization、capability-aware hydration、RoleScopeBar/AccessDeniedResult、根 ConfigProvider；后端 246/246 policy registry、shadow/staged、exact resource scope、explicit deny、MethodPolicy obligations 和 awaited decision audit。
- **自动化证据：** Ops 63 files / 290 tests、production build、后端 4 files / 77 tests，以及 14 个具名负向用例通过。
- **本地运行证据：** 1440×900 Vite + fixture 的 canonical/deny-all/诊断交互截图；deny-all 网络集合只有 `ops.session`。这些证明本地桌面交互与请求收口，不证明真实 OIDC 签名、生产数据库/RLS 或生产审计链路。
- **生产外部阻断：** 尚无真实生产 OIDC gateway、production-like 双 Postgres role/RLS、不可变 audit sink、模型中转鉴权/usage/cost/error、Worker 撤销后执行检查或 production canary 证据；现有 ops-ui container healthy 也不能替代这些证据。

**P1 当前切片 DONE_WITH_CONCERNS；整体仍为 NO-GO。** 本轮关闭了 capability 命名/managed fail-closed、原始 role 导航泄漏、统一 403、根 AntD theme、diagnostic 默认折叠、deny-all 后台 hydration、exact scope、explicit deny、MethodPolicy obligations 与高风险 decision-audit failure propagation。但以下四项仍是明确发布阻断：

1. **双工作台服务端裁剪：** platform 与 workspace capability/scope snapshot 仍未按显式 workbench 分离，旧响应隔离/切换协议未完成。
2. **持久化 JIT 与撤销：** grant 数据模型、审批、nonce/max-use、到期/主动撤销和并发执行检查未完成。
3. **Worker authorization snapshot：** 副作用 envelope 尚未统一携带 decision/capability/scope hash/policy/grants/resource revision，也未证明“排队后撤销再执行”拒绝 provider 调用。
4. **生产真实证据：** 真实 OIDC、PostgreSQL/RLS、audit sink、模型中转、Worker 和 canary 门禁未闭环。

因此本文件继续保持 `TODO / NO-GO`，不得迁移到 `doc/done`，也不得把 246/246 登记覆盖表述为生产全量 capability enforcement。

## 23. 成员可分配角色服务端投影增量（2026-08-31）

已关闭 P1-FE-002 中“邀请/角色调整仍由前端本地角色与能力推断”的本地子项：`ops.session` 返回 `assignable_roles`，按当前 workbench、`workspace.member.manage` 与 `workspace.status.update` 服务端裁剪；成员 UI 缺少投影时 fail-closed，空成员工作区不回退本地枚举。`ops.members.list` 原数组协议保持不变，成员目标约束继续由每行 `governance` 投影提供。

证据：API dual-workbench session 回归、Ops Console MembersSection/useMembers 与 member audit 共 9 tests passed；typecheck 与 diff check 通过；CodeGraph index complete / pendingRefs 0 / worktreeMismatch null。该切片仍不等于真实 OIDC、PostgreSQL/RLS、audit sink、worker、模型 relay 或生产 canary 证据，整体仍为 **NO-GO**。

## 24. JIT 实时到期体验增量（2026-08-31）

已完成 JIT UX 的本地切片：`RoleScopeBar` 对服务端 `temporary_grants` 实时显示剩余时间；倒计时到期后触发 `model.load()` 重新获取 session/授权投影，活动标签消失并由服务端重新决定数据访问。无有效 grant 时保持锁定态，不显示假授权或票据正文。

证据：权限 UX、Ops Header、workbench transition 共 15 tests passed；typecheck 与 diff check 通过。尚未证明真实浏览器读屏、生产 OIDC、撤销竞态期间的全量敏感数据清除、生产审计和 canary，因此 P1-FE-005 仍未整体完成，本文继续保持 **TODO / NO-GO**。

补充：到期处理现在先执行 `clearAuthorizationScopedData()`，使旧请求失效并清空已加载服务端数据、筛选、选择和 session，再重新取授权投影；Ops Console 全量回归 67 files / 314 tests、生产构建 3197 modules 均通过。真实浏览器 fake-timer/读屏、撤销竞态、生产 OIDC/RLS、审计 sink 与 canary 仍需外部证据。

撤销路径也已对齐：授权中心完成 `ops.authorization.grant.revoke` 后，刷新 grant 列表并清空当前 Ops 数据/session，再重新拉取授权投影；因此当前会话撤销不会仅从表格消失而继续显示旧数据。真实并发撤销竞态仍需浏览器与生产化验证。

另修复 `clear -> load` 的 React 闭包竞态：加载使用 session ref，清理同步置空 ref，避免状态提交前重新读取旧 JIT session。定向回归 10/10、typecheck、CodeGraph 均通过；生产并发撤销与浏览器证据仍待完成。

## 21. Worker 执行授权与 HTTP parity 增量（2026-08-31）

本轮将六类关键 worker operation 统一纳入持久事件快照与执行前复核：`publish.execute`、`publish.reconcile`、`generation.execute`、`image_generation.execute`、`catalog.sync.execute`、`asset.continuation.execute`。快照现在强制 SHA-256 `scope_hash`，membership 绑定 identity + subject authorization revision；JIT 还绑定 grant id + grant revision。执行时从权威仓储重读 grant，精确核对 identity、workspace、canonical capability、scope hash、revision、revoked/TTL，不再接受仅格式正确的伪造 grant id。

用户发起的 MCP 目录同步、失败重试、文本/图片生成和图片续跑确认已写入快照。`POST /v1/sync-jobs`、平台账号同步 HTTP route 与 `POST /v1/tasks/:id/content-jobs` 先调用同一 MCP capability evaluator，然后才产生快照或外部副作用。OAuth callback 只有 state + PKCE，不冒充商家授权；严格环境下自动首次同步返回 `service_principal_authorization_not_configured` 并 fail closed，由用户回到 ChatGPT 发起可审计同步。独立 machine/service principal 的签发、轮换和撤销模型仍是后续生产项，未用伪造用户快照填补。

最新验证：

- TypeScript project build：PASS。
- API/application/contracts/security/workers：90 files / 818 tests PASS。
- CodeGraph affected persistence/worker 补充集：13 passed + 5 environment-skipped files，50 passed + 16 skipped tests。
- Ops UI：68 files / 323 tests PASS；Vite production build PASS（3198 modules transformed）。JIT 状态条已展示服务端投影的读写模式、精确 scope 与使用预算，并以 `aria-live` 更新倒计时；申请/审批、撤销竞态、过期时全量数据清除和真实 OIDC 仍未完成。
- CodeGraph：815 files / 11,527 nodes / 42,899 edges；CLI 仍报告 1 个生成型 pending added artifact，不影响已索引源码的 affected-test 计算。

容器状态后来发生外部变化：当前 API/API replica/Ops UI/UI、六类 worker、PostgreSQL、Redis、ClamAV 均 healthy，数据库为 106/106 且无 invalid canonical/legacy brand mapping。旧阻断对象现已对齐 `brand_release_qa`；本轮 owner 未执行该数据变更，仅保存了只读时间戳与迁移结果。缺少修复审批/审计、预生产和生产证据，因此整体结论仍为 **NO-GO**。

连接诊断增量：Ops Header 仅保留连接状态与诊断入口，API/工作区/本地 Bearer 配置进入 Ant Design Drawer；刷新中状态在主界面保留并带 `aria-busy`，保存成功后关闭面板。Ops UI 68 个测试文件/324 个测试、生产构建和 TypeScript 通过。该实现不替代真实 OIDC 网关、生产配置和桌面多角色浏览器证据，P1-FE-009 整体仍需外部验收。

## 22. 全量插件功能权限矩阵增量（2026-08-31）

连接诊断增量：Ops Header 仅保留连接状态与诊断入口，API/工作区/Bearer 配置进入 Ant Design Drawer；刷新中状态保留在主界面并带 `aria-busy`，保存成功后关闭面板。Ops UI 定向回归与生产构建通过；真实 OIDC 网关、生产配置和桌面多角色浏览器证据仍缺，P1-FE-009 整体继续保持未完成。

补充 UI 错误证据增量：`OpsRequestError.details` 的 `decision_id`、`reason_code`、`obligations_missing` 已映射到 `OpsErrorPresentation`，并在 `OpsPageError` 的折叠诊断区展示；未发起请求时不生成 request/trace ID。定向权限错误回归 30/30、Ops Console 全量回归 68/68（324 tests）、生产构建和 TypeScript 均通过。该增量不替代真实 OIDC/403/审计联动验收，整体仍为 NO-GO。

JIT/角色表单提交增量（owner 复核）：`AuthorizationGovernanceSection` 的 `ops.authorization.grant.issue` 与 `ops.authorization.role.assign` 现在具备提交中锁定/`aria-busy`、统一错误诊断、失败时保留表单输入、成功后才 reset；JIT 能力字段也有规范化测试。运营台全量回归为 69 个文件 / 326 tests PASS；Ops production build、TypeScript、`git diff --check` 和 CodeGraph 同步通过。该增量仍不证明真实 OIDC、JIT 审批/撤销竞态、审计 sink 或生产发布门禁，P1-FE-005/P1-FE-009 继续保持未完成，文档不迁移到 `doc/done`。

JIT 到期可见性增量：`RoleScopeBar` 现在按渲染时钟立即隐藏已过期的服务端投影 grant，不等待 session reload 完成；原有到期回调继续清理授权范围数据并重新获取 session。新增过期边界测试，JIT/工作台相关回归 10/10、Ops production build、TypeScript 和 `git diff --check` 通过。该增量不替代 durable grant 的服务端撤销、真实 OIDC、浏览器 fake-timer/读屏和生产审计证据，P1-FE-005 仍未整体完成。

新增只读平台方法 `ops.authorization.matrix.get`。返回值直接遍历 `MCP_METHOD_POLICIES`，对当前 247 个方法输出 capability、workbench、scope、data class、effect、audit、obligations，并用全部 19 个 canonical role 的能力模板计算 `hidden/read/operate/govern`。API 回归额外断言每一项的 `role_access` key 与 `CANONICAL_ROLES` 完全一致、值域封闭，避免新增方法或角色时静默缺列。

Ops Console 将矩阵作为授权中心的独立 Ant Design 模块，只向拥有 `authorization.role.read` 的会话展示。支持方法/能力搜索、工作台和读写筛选、多角色对比、固定方法/能力列、横向滚动及有界纵向表格。页面明确声明角色模板不是最终许可，最终执行仍须满足当前 workbench、exact resource scope、显式 deny、obligation、JIT 和执行时复核。

## 23. JIT 主动退出 UI 增量（2026-08-31）

`RoleScopeBar` 在存在服务端投影的有效 `temporary_grants` 时新增明确的“退出临时授权”按钮，并通过 `OpsHeader → OpsConsoleController` 复用既有 `clearAuthorizationScopedData()` 与 session 重取流程；退出后先清空授权范围内的数据，再等待新的服务端授权投影，避免旧数据在切换期间继续可见。按钮具有可访问名称，状态条继续使用 `aria-live` 展示读写模式、精确范围和倒计时。

验证：权限 UX 与 Ops Header 定向回归 17/17、TypeScript、Ops Console production build、CodeGraph 同步通过（索引 835 files / 11,918 nodes / 44,436 edges）。该增量是本地 UI 会话退出能力，不等价于服务端 durable grant revoke；撤销竞态、fake-timer 浏览器证据、真实 OIDC/RLS、持久审计和生产 canary 仍缺，因此 P1-FE-005 继续保持 TODO / NO-GO，不迁移到 `doc/done`。

## 24. 403 决策原因投影增量（2026-08-31）

入口拒绝页现在优先显示服务端错误详情中的 `details.reason_code`，仅在服务端未返回具体原因时回退到传输层 `code`；请求 ID、追踪 ID 和能力/范围证据保持原样，未由前端生成。这样 `SCOPE_MISMATCH`、`CAPABILITY_DENIED` 等决策原因不会被 `FORBIDDEN` 覆盖。

验证：Ops Console Controller、OpsPageError、权限 UX 定向回归 25/25，TypeScript、`git diff --check` 和 CodeGraph 同步通过。真实 OIDC/403、多角色 scope mismatch、审计决策链和生产 canary 仍未验证，P1-FE-006 继续保持 TODO / NO-GO。

## 25. 持久 JIT 服务端回归复核（2026-08-31）

本轮未重复修改已存在的服务端实现，而是复核真实代码调用面：`PostgresAuthorizationRepository` 与 `MemoryAuthorizationRepository` 均覆盖精确 `scope_hash`、TTL、read/write 模式、写操作双人审批、subject authorization revision、CAS grant revision、原子 `max_uses` 消费、撤销和不可变 grant event；API 的 session projection 与 worker 执行前复核消费同一 grant 状态。

验证：`packages/persistence/src/authorization-repository.test.ts` 与 `apps/api/src/security.e2e.test.ts` 共 69/69 通过。该结果证明本地 repository/API 逻辑，不证明生产 PostgreSQL/RLS 双角色、真实 OIDC 受控主体、外部审计 sink、跨副本并发撤销或浏览器撤销竞态；P1-BE-007/P1-FE-005/P1-GATE-004 继续按真实环境门禁保持 TODO / NO-GO。

## 26. 授权决策审计请求关联增量（2026-08-31）

授权决策写入 `workspace_operation_audit.after_json` 时现在同时保存当前请求的 `request_id` 与 `trace_id`，与已有 decision、policy、workbench、capability、scope、result、reason 和缺失义务形成可反查的最小审计快照；请求关联值来自服务端 `IncomingMessage`，未由前端伪造。未新增绕过 RLS 的表访问，也未把 token 或客户正文写入审计。

验证：`apps/api/src/security.e2e.test.ts` 与 `apps/api/src/request-observability.e2e.test.ts` 共 68/68 通过，TypeScript、`git diff --check`、CodeGraph 同步通过。当前仍缺生产审计 sink、真实 PostgreSQL 双角色/RLS、全量高风险 allow/deny 覆盖和 canary，因此 P1-BE-008 继续保持 TODO / NO-GO。

## 27. HTTP policy parity 本地复核（2026-08-31）

HTTP identity route 的实现已复核为先通过 `getHttpOperationPolicy` 找到对应 MCP method，再调用统一 `enforceRegisteredMcpCapability`；因此 HTTP 与 MCP 共用 capability、workbench、scope、obligation、JIT 消费和 decision audit 逻辑，不另建一套前端或 REST 权限判断。

验证：`packages/contracts/src/http-authz.test.ts` 与 `apps/api/src/server.test.ts` 共 38/38 通过，覆盖 identity route 引用完整性、MCP policy 存在性和代表性 HTTP→MCP 映射。逐路由真实生产 allow/deny、scope/JIT/审计和 OIDC/RLS 证据仍缺，P1-GATE-004 继续保持 TODO / NO-GO。

本地运行证据：隔离 memory API 使用 `MCP_AUTHZ_MODE=enforce`、平台 Bearer grant 与独立 session hash secret；Vite 桌面页面通过真实 `/api/mcp` 返回 247/247，四种状态均以文字呈现，搜索 `ops.authorization.matrix.get` 收敛为 1/247，复载后无 Ant Design 静态 message 上下文告警。截图保存在 `dogfood/ops-console-current/rbac-permission-matrix-1440.png` 与 `rbac-permission-matrix-search-1440.png`。TypeScript、Ops production build、API/application/contracts/security/workers 90 files / 820 tests、Ops 66 files / 302 tests、plugin/root contract/release 11 files / 158 tests 均 PASS；动态 inventory 为 247 methods / 247 policies / 247 declared / 247 registered / 19 roles。当前本地容器也已全 healthy、迁移 106 完整性查询为 0；但数据修复不是本轮 owner 执行且缺审批/审计，其他页面数据又因测试身份遵守最小权限出现 403，生产依赖仍未接入。这不影响矩阵局部链路 PASS，但整体仍为 **PRODUCTION NO-GO**。

2026-08-31 桌面运行态增量：连接诊断默认折叠，避免 Drawer 遮挡桌面导航；`OpsHeader` 定向回归 11/11。重新构建并重启 `ops-ui` 后，真实 Compose Chrome 桌面入口 `ops.spec.js` 为 1 passed，入口响应成功、HTTP 错误 0、请求失败 0、console/page 错误 0。跨到 workspace 后的 support/incidents 导航仍由服务端授权投影控制，未授权时隐藏属于 fail-closed 预期；全域深链仍需按角色拆分验收，不迁移为 done。
深链验收随后按真实权限语义完成拆分：`ops-deeplink.spec.js` 桌面 Chrome 全套 15/15 通过，覆盖 11 个可访问域的深链刷新、平台工作台导航历史/前进后退，以及 support/incidents 无权态刷新；未通过前端显示隐藏域规避服务端 RBAC。

## 28. 本地契约证据逐条核对（2026-09-01）

本节只登记已经提交、可由对应定向测试复核的本地代码/契约证据，不把局部实现升级为完整验收，也不替代真实运行环境证据。

- [x] **策略集合精确覆盖。** `6ab248a`；`packages/contracts/src/authz.test.ts` 定向测试通过，覆盖 policy key 精确匹配与未知方法 fail-closed。对应完整验收项为 P1-GATE-001/P1-GATE-002；仍需最终提交动态重跑。
- [x] **撤销/过期授权拒绝。** `acab8ae`；Authz 定向测试 18/18 通过，覆盖 revoked、expired、非法时间、空/控制字符 scope 和 wildcard scope 拒绝。该证据仅关闭本地 grant 校验子项，不关闭 P1-BE-007 的持久 JIT、生产并发和真实 OIDC 要求。
- [x] **Ops session/grant 契约。** `3c80ff4`；API 定向测试 4/4 通过，覆盖 workbench/workspace 裁剪、grant issue/revoke、expiry projection 和 403 decision evidence。该证据不等于真实 OIDC 或跨副本生命周期验收。
- [x] **Grant lifecycle 本地 fail-closed 契约。** `acab8ae`、`3c80ff4`；Authz 定向测试 18/18、Ops session/grant 定向测试 4/4 通过，覆盖 revoked/expired grant 拒绝、非法 scope/时间拒绝、签发/撤销、到期投影清理和 decision evidence。该证据不等于真实 OIDC、持久化审批、跨副本撤销竞态或生产生命周期验收。
- [x] **用户治理 capability 投影。** `962cbbd`；Users 页面定向测试 10/10 通过，覆盖服务端 capability projection、无权限 fail-closed、只读说明和键盘可达恢复。该证据不关闭完整角色矩阵、生产 RLS 或全桌面浏览器验收。
- [x] **Ops RBAC API 接口契约。** `e5832d4`；API 定向测试 3/3 通过，覆盖 MCP 方法授权矩阵、平台权限边界、双工作台 session 裁剪和 403 decision/request evidence。该证据不等于逐路由生产 parity。
- [x] **MCP/HTTP parity 本地契约。** `be29b31`；`mcp-http-parity-contract.test.ts` 27/27 通过，验证 registry/contract/policy/OpenAPI 方法集合精确一致、每个 MCP 方法具备完整 contract/policy、HTTP identity 操作引用已注册 MCP policy。该证据不等于全量生产逐路由 allow/deny、OIDC、RLS、审计或真实运行矩阵。
- [x] **Worker execution-check 本地契约。** `59c0df1`；Worker 定向测试 13/13、workers build 通过，验证 queued 后 grant revoke、scope mismatch、revision mismatch 均拒绝执行且 provider 外呼为 0。该证据不等于全部 critical worker 的生产授权快照、跨副本竞态或完整运行矩阵。
- [x] **逐方法 authorization decision 契约。** `c1460f5`；生产执行路径与测试共用 `registeredMcpAuthorizationDecision()`，测试从实时 `MCP_METHODS` 遍历全部方法，逐项验证唯一 decision ID、当前 policy version、enforce mode、deny result 与稳定 reason code。`workspace.bootstrap` 也先经过同一 evaluator，首次成员例外仍只保留在授权函数内的显式契约层。API 定向测试 5/5、全项目 TypeScript 通过。
- [x] **动态 enforce 覆盖率报告。** `1c63946`；`mcpAuthorizationCoverageReport()` 从实时 `MCP_METHODS`、policy capability domain 和运行模式计算方法总数、enforce/shadow 数量、比例及 enforce/shadow 域。生产 readiness 直接携带该无密钥报告，并要求 `mode=enforce`、无 staged domain 覆盖；测试移除历史 `17` 方法断言，动态证明生产方法和 capability domain 均 100% enforce。非法配置在 readiness 中稳定报告 unavailable/not-ready，运行时仍 fail-closed 拒绝启动。定向测试 81/81、全项目 TypeScript 通过。
- [x] **精确 scope resolver 基础契约（本地切片）。** `c157184`；生产授权路径统一使用可测试的 `resolveAuthorizationResourceScope()`，对 workspace/self/brand/account ID 做非空 trim 规范化，缺失 ID 保持 unresolved 并由 evaluator fail-closed，platform 仅解析为显式 `*` aggregate。五类 resolver 定向回归与授权安全套件共 75/75、全项目 TypeScript 通过。实时 policy inventory 当前仍只有 workspace 184、platform 63、self 7，brand/account 为 0；具体方法迁移、加载后资源归属复核及 cross-brand/cross-account 运行证据未完成，因此 P1-BE-003 保持 TODO。
- [x] **店铺别名 exact account scope（本地切片）。** `8f83b9c`；`platform.store.alias.set` 从 workspace policy 迁移为 account policy，普通工作台 capability projection 的 account IDs 来自服务端当前工作区店铺目录。显式 enforce 运行测试证明 owner/admin 可修改本租户店铺，另一租户 account ID 在统一 evaluator 阶段以 `AUTHZ_SCOPE_MISMATCH` 拒绝，不进入 handler 暴露对象存在性；平台工作台仍以 workbench mismatch 拒绝。定向测试 101/101、全项目 TypeScript 通过。当前仅 1 个 account-scope 方法，其他店铺/品牌方法和加载后资源归属仍待迁移，P1-BE-003 保持 TODO。
- [x] **品牌店铺绑定 exact account scope（本地切片）。** `f27f6c3`；`brand-unit.bind-store` 迁移为 account policy。本租户 account 先通过统一 evaluator，再由既有品牌 editor 权限与服务端店铺归属校验；另一租户 account 在进入品牌 handler 前以 `AUTHZ_SCOPE_MISMATCH` 拒绝，避免对象存在性探测。定向测试 166/166、全项目 TypeScript 通过。brand scope 投影、listing 等资源加载后复核仍未完成，P1-BE-003 保持 TODO。
- [x] **Listing 创建 exact account scope（本地切片）。** `bdeed3f`；`brand-unit.listing.create` 迁移为 account policy，并保留品牌 editor、品牌—店铺绑定、canonical product 归属三层服务端校验。显式 enforce 测试证明本租户店铺可创建 listing，另一租户 account 在 handler 前以 `AUTHZ_SCOPE_MISMATCH` 拒绝。定向测试 142/142、全项目 TypeScript 通过。其他 account/brand 方法及加载后 task/product scope resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **持久品牌权限 exact atom（本地切片）。** `554fc67`；`brand-unit.product.create` 迁移为 brand policy。服务端只在主体原本拥有对应 workspace capability，且 workspace-wide owner/admin 或持久品牌仓储满足 write→editor/read→viewer 最低角色时，派生单一 brand ID 的 `resource_grant` atom；品牌 grant 不会反向新增 capability。显式 enforce 测试证明 viewer grant 的品牌写操作在 evaluator 阶段以最小化 `AUTHZ_SCOPE_MISMATCH` 拒绝，owner 正常创建。定向测试 166/166、全项目 TypeScript 通过。其他品牌方法及 task/product 加载后 resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **品牌权限授予 exact brand scope（本地切片）。** `7d6ab84`；`brand-unit.access.grant` 迁移为 brand policy。统一 evaluator 先要求服务端派生的 exact brand write atom，handler 再要求品牌 admin 并校验目标 active member；只有 viewer grant 的成员尝试自提权时在 handler 前以 `AUTHZ_SCOPE_MISMATCH` 拒绝。定向测试 142/142、全项目 TypeScript 通过。完整品牌方法与加载后资源 resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **Task 加载后 exact brand scope（本地切片）。** `5c0586a`；`task.timeline` 迁移为 brand read policy。授权前按 `task_id` 从服务端任务仓储加载，仅在任务 workspace 与当前路由一致时提取任务 brand ID；客户端无需也不能用独立 `brand_id` 改写该范围。显式 enforce 测试证明 viewer grant 可读取授权品牌任务，同 workspace 未授权品牌任务以 `AUTHZ_SCOPE_MISMATCH` 拒绝。定向测试 142/142、全项目 TypeScript 通过。其他 task/product 方法、account 加载解析和 platform aggregate/customer detail 边界仍待迁移，P1-BE-003 保持 TODO。
- [x] **Task 恢复加载后 exact brand scope（本地切片）。** `ce7fe68`；`task.resume` 迁移为 brand write policy并复用服务端 task resolver。viewer 即使可读该品牌也不能恢复任务，升级为持久 editor grant 后可恢复已授权品牌任务；未授权品牌保持 evaluator 阶段拒绝。定向测试 142/142、全项目 TypeScript 通过。其余 task/product 方法与 platform aggregate/customer detail 边界仍待迁移，P1-BE-003 保持 TODO。
- [x] **Task 回答加载后 exact brand scope（本地切片）。** `1cc4a0a`；`task.answer` 迁移为 brand write policy并复用服务端 task resolver。显式 enforce 测试证明 viewer 对可读品牌仍不能提交任务回答、未授权品牌同样拒绝，workspace owner 的全品牌权限可正常执行；拒绝均发生在 handler 解析 `answers_json` 前。定向测试 90/90、全项目 TypeScript 通过。其余 task/product 方法仍待迁移，P1-BE-003 保持 TODO。
- [x] **任务方向选择加载后 exact brand scope（本地切片）。** `8c84dfe`；`task.select_direction` 迁移为 brand write policy并复用服务端 task resolver。显式 enforce 测试证明 viewer 在方向 ID/任务状态校验前拒绝、未授权品牌同样拒绝，workspace owner 可对服务端解析品牌后的任务正常选择方向。定向测试 150/150、全项目 TypeScript 通过。方案确认、内容生成与 product resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **任务方案确认加载后 exact brand scope（本地切片）。** `2d7eebb`；`task.plan.confirm` 迁移为 brand write policy并复用服务端 task resolver。未授权主体在 canonical listing、计划状态、版本和价格影响确认之前以 `AUTHZ_SCOPE_MISMATCH` 拒绝，不能借后续业务错误探测任务内部状态。定向测试 150/150、全项目 TypeScript 通过。内容生成、内容版本与 product resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **内容生成加载后 exact brand scope（本地切片）。** `9823759`；`content.generate` 迁移为 brand write policy并复用服务端 task resolver。未授权品牌请求在 canonical scope、插件钱包、规则预检、成本预算、用量消费、模型中转和 Worker 入队之前以 `AUTHZ_SCOPE_MISMATCH` 拒绝；运行测试同时断言 generation job 数量不变。定向测试 147/147、全项目 TypeScript 通过。内容版本与 product resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **内容版本列表加载后 exact brand scope（本地切片）。** `4f2e388`；`content.versions` 迁移为 brand read policy并复用服务端 task resolver。授权品牌无版本时保留真实空列表语义；未授权品牌不以空态冒充成功，而在 evaluator 阶段以 `AUTHZ_SCOPE_MISMATCH` 拒绝，避免泄露版本数量和生产进度。定向测试 142/142、全项目 TypeScript 通过。content-version ID 与 product resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **Content version 加载后 exact brand scope（本地切片）。** `584ab03`；resolver 新增服务端 `content_version_id → content version → task → brand` 链路，`content.diff` 迁移为 brand read policy。授权品牌可读取差异，未授权品牌在比较 against version 或正文前以 `AUTHZ_SCOPE_MISMATCH` 拒绝；跨 workspace、不存在版本和无品牌任务保持 unresolved。定向测试 150/150、全项目 TypeScript 通过。其他 content-version 写方法与 product resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **内容审阅 exact brand editor scope（本地切片）。** `cc3ac0f`；`content.review` 迁移为 brand write policy并复用 content-version resolver。viewer 无法借规则审阅接口读取完整正文、事实证据或命中规则，未授权品牌同样在 canonical scope 与规则评估前以 `AUTHZ_SCOPE_MISMATCH` 拒绝。定向测试 142/142、全项目 TypeScript 通过。审阅决策、修改/恢复及 product resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **审阅决定 exact brand editor scope（本地切片）。** `d3b7a02`；`content.review.decide` 迁移为 brand write policy并复用 content-version resolver。viewer 与未授权品牌在 finding code、revision、reason 和 P0/P1/P2 规则判断前以 `AUTHZ_SCOPE_MISMATCH` 拒绝，不能探测 finding 是否存在或写入审阅决定。定向测试 142/142、全项目 TypeScript 通过。修改/恢复、视觉选择及 product resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **内容修改 exact brand editor scope（本地切片）。** `4137845`；`content.modify` 迁移为 brand write policy并复用 content-version resolver。测试故意提交非法 `changes_json`，证明 viewer 与未授权品牌先以 `AUTHZ_SCOPE_MISMATCH` 拒绝，不暴露 JSON/module/revision 校验差异；拒绝前后 content version 数量保持不变。定向测试 142/142、全项目 TypeScript 通过。恢复、视觉选择及 product resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **内容恢复 exact brand editor scope（本地切片）。** `649118d`；`content.restore` 迁移为 brand write policy并复用 content-version resolver。viewer 与未授权品牌在 source version、expected version、canonical scope 和任何持久写入前以 `AUTHZ_SCOPE_MISMATCH` 拒绝；拒绝前后 content version 数量保持不变。定向测试 142/142 通过；全项目 TypeScript 被并行工作区的 `demo/merchant-studio/src/App.tsx` 可空图片与 `tests/capacity-workload.ts` 缺失 `Timing` 类型阻断，均不在本提交文件范围。视觉选择及 product resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **视觉选择 exact brand editor scope（本地切片）。** `63269e0`；`content.visual.select` 迁移为 brand write policy并复用 content-version resolver。viewer 与未授权品牌在 visual refs、revision、真实性、幂等和版本创建前以 `AUTHZ_SCOPE_MISMATCH` 拒绝，拒绝前后 content version 数量保持不变。本轮品牌场景 1/1、contracts/server 78/78 通过；全 security 套件被并行提交 `484bc5d` 后三个 Worker snapshot 旧断言阻断，另有非本轮 `server.ts` HTTP parity 未提交修改，均未混入本提交。product resolver 仍待迁移，P1-BE-003 保持 TODO。
- [x] **Product 加载后 exact brand scope（本地切片）。** `bacc09e`；resolver 改为异步服务端链路并新增 `product_id → workspace product → canonical product source relation → unique brand` 解析；无 canonical 关系时仅回退服务端已记录 brand，多品牌歧义、跨 workspace 和不存在商品保持 unresolved。`creative.brief` 迁移为 brand read policy，未授权品牌在钱包、商品事实和创意生成前以 `AUTHZ_SCOPE_MISMATCH` 拒绝。本轮品牌场景 1/1、contracts/server 78/78 通过；并行 HTTP parity hunk 已通过分块暂存明确排除。其他 product 方法仍待迁移，P1-BE-003 保持 TODO。
- [x] **创意预览 exact product-brand scope（本地切片）。** `d27f91d`；`creative.preview` 迁移为 brand read policy并复用 product resolver。未授权品牌在钱包扣费、商品事实、视觉准备和预览生成前以 `AUTHZ_SCOPE_MISMATCH` 拒绝，不再返回可用于探测商品存在性的 `PRODUCT_NOT_FOUND`。本轮品牌场景 1/1、contracts/server 78/78 通过。商品图片与更新方法仍待迁移，P1-BE-003 保持 TODO。
- [x] **商品图片生成 exact product-brand editor scope（本地切片）。** `b2346a5`；`catalog.image.generate` 迁移为 brand write policy并复用 product resolver。viewer 对已授权品牌和未授权品牌均在商品读取、钱包扣费、模型中转和图片任务入队前以 `AUTHZ_SCOPE_MISMATCH` 拒绝；测试断言拒绝前后 image generation job 数量不变。本轮品牌场景 1/1、contracts/server 78/78 通过。其他商品更新与图片选择/审阅方法仍待迁移，P1-BE-003 保持 TODO。
- [x] **商品事实修改 exact product-brand editor scope（本地切片）。** `536310e`；`catalog.product.update` 迁移为 brand write policy并复用 product resolver，exact-scope grant 契约同步改为 brand 资源。viewer 对已授权品牌提交非法 JSON 时仍先由 evaluator 拒绝，未授权品牌同样拒绝，避免泄露字段解析、canonical 映射和商品存在状态；测试断言两个商品对象均未变化。本轮品牌场景 1/1、contracts/server 78/78 通过。其他商品事实写方法与图片选择/审阅仍待迁移，P1-BE-003 保持 TODO。
- [x] **商品图片选择 loaded-job exact brand editor scope（本地切片）。** `7520402`（并发 owner 提交中包含 resolver/policy/首个断言）+ `584050f`（独立隐藏品牌回归）；resolver 新增 `job_id → image generation job → product → canonical brand` 服务端链路，`catalog.image.select` 迁移为 brand write policy。viewer 对可见品牌缺少 editor 权限、以及完全不可见品牌时，均在 revision、视觉引用和确认票据校验前以 `AUTHZ_SCOPE_MISMATCH` 拒绝；两个 job 快照均保持不变。品牌场景 1/1、contracts/server 78/78 通过。并发暂存被其他 owner 的 `7520402` 一并提交，未改写共享历史；后续以独立测试提交锁定边界。图片审阅等方法仍待迁移，P1-BE-003 保持 TODO。
- [x] **商品图片审阅 exact product-brand editor scope（本地切片）。** `383def3`；`catalog.image.review` 迁移为 brand write policy并复用 product resolver。显式 enforce 下，viewer 对可见品牌缺少 editor 权限和隐藏品牌均在 visual refs 解析、canonical listing、真实性审阅及 job 持久化前以 `AUTHZ_SCOPE_MISMATCH` 拒绝；测试断言 image generation job 集合不变。品牌场景 1/1、contracts/server 78/78 通过；非 enforce 兼容测试仍保留 handler 层 `PRODUCT_NOT_FOUND` 隐匿语义。其他商品事实写方法仍待分类迁移，P1-BE-003 保持 TODO。
- [x] **商品图片安全重试 loaded-job exact brand editor scope（本地切片）。** `eaa6e79`；`catalog.image.retry` 从独立 workspace policy 迁移为 brand write policy，并复用 `job_id → image job → product → brand` resolver。可见品牌 viewer 与隐藏品牌请求均在任务状态、模型成本、钱包扣费、授权快照和重试入队前以 `AUTHZ_SCOPE_MISMATCH` 拒绝；测试断言完整 image generation job map 不变。品牌场景 1/1、contracts/server 78/78 通过。MCP schema 格式校验仍按协议先于 evaluator 执行。其他商品事实写方法仍待分类迁移，P1-BE-003 保持 TODO。
- [x] **商品图片读取 loaded-job exact brand viewer scope（本地切片）。** `ef3fde0`；`catalog.image.get` 迁移为 brand read policy，resolver 同时支持 `job_id` 和 workspace 内 `visual_ref` 查找，再解析 product 与 canonical brand。viewer 可读取获授权品牌 job，隐藏品牌在任务状态、候选图、归档内容、签名 URL 和选择票据返回前以 `AUTHZ_SCOPE_MISMATCH` 拒绝。品牌场景 1/1、contracts/server 78/78 通过。gstack `/review` 因当前分支即 base `main` 按门禁停止，owner 已复核 staged diff；`ui-ux-pro-max` 判定纯后端变更不应引入 UI 修改。其他商品事实写方法仍待分类迁移，P1-BE-003 保持 TODO。
- [x] **文本生成状态 loaded-job exact brand viewer scope（本地切片）。** `26da2b5`；resolver 新增 `generation.get job_id → generation job → task → brand` 服务端链路，`generation.get` 迁移为 brand read policy。viewer 可读取获授权品牌 job，隐藏品牌在队列元数据、失败原因、内容版本引用和 workflow 投影前以 `AUTHZ_SCOPE_MISMATCH` 拒绝。测试夹具在读取断言后将 job 转为终态，避免污染后续 workspace 活跃任务配额；品牌场景 1/1、contracts/server 78/78 通过。其他 job/publish 读取方法仍待迁移，P1-BE-003 保持 TODO。

以下项目有代码或本地测试片段，但当前没有足够证据勾选完整验收项：

- [ ] 真实 OIDC 签名、issuer/audience/nonce、受控主体和 gateway/membership 一致性。
- [ ] 生产-like PostgreSQL 双 role、RLS 攻击矩阵、连接池隔离和迁移后真实数据门禁。
- [ ] 持久 JIT 的真实审批、撤销竞态、nonce/max-use 并发及跨副本一致性；上述本地 grant lifecycle 契约不能替代该项。
- [ ] 不可变 audit sink 的真实写入、失败阻断、查询重建和保留策略。
- [ ] 全量 HTTP/MCP/Worker enforcement 与逐方法 allow/deny/scope/obligation parity。
- [ ] 1280/1440/1920 桌面角色矩阵、JIT 到期/撤销和跨租户 IDOR 的完整浏览器证据。

因此本地契约子项已按证据勾选，但本文件总体仍为 **TODO / LOCAL VERIFIED WITH BLOCKERS / PRODUCTION NO-GO**；不得据此迁移到 `doc/done`。
