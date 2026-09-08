# 前后端能力与产品闭环审计（2026-09-05）

## 审计范围与证据

本报告基于当前工作区、真实运行验收和 CodeGraph 索引生成。CodeGraph 数据库 `.codegraph/codegraph.db` 当前为完整状态：

- 1,136 个文件
- 15,906 个节点
- 60,408 条边
- 87,330 个未解析引用（主要来自动态/跨包引用，不能直接当作缺陷）
- 索引状态 `complete`

此前的正则扫描结果不能作为能力缺口结论：它漏掉了泛型 RPC、`rpcForWorkspace` 和域客户端封装，并把测试探针及非方法的 `case` 分支混入统计。所谓“后端存在、前端没有直接调用”的 52 项只是待复核候选集，不是 52 个缺失入口；本校正版先撤回其 P0/P1 缺口判断，改以逐项调用链证据为准。已核实 `ops.audit.detail`、`ops.authorization.matrix.get`、`ops.storage.reconciliation.list` 均已有前端代码引用。

真实桌面 OIDC 验收证据：

- 页面漫游、模型状态 fail-closed、inventory、无凭证门禁、401 重新认证、品牌树导航均已通过；
- 用户目录曾出现完整套件冷启动超时，追踪确认是 `ops.users.list` 被可选聚合请求竞争资源；已增加专用 30 秒超时和启动追踪；
- 生产发布仍被外部配置/支付、OAuth、对象存储/KMS、扫描器等真实证据缺失阻断，不能用本地 fixture 代替。

## 已确认的前端有、后端没有

没有发现生产前端调用缺少后端实现的能力。扫描出的 3 个值为测试探针：

| 调用值 | 判断 | 处理 |
|---|---|---|
| `ops.bad` | 负向测试方法 | 保留，用于验证 404/fail-closed |
| `ops.empty` | 空响应测试方法 | 保留，用于契约测试 |
| `ws-authorized` | 授权测试标识 | 保留，不是 API 能力 |

## 后端有、前端没有直接入口

以下能力仍需逐项确认页面闭环；下表是审计候选，不代表当前没有入口或必须开发。

### 待复核：不能由静态候选集直接判定缺口

| 能力 | 后端方法 | 当前风险 | 建议闭环 |
|---|---|---|---|
| 平台告警读取/确认 | `ops.alerts.list`, `ops.alert.ack` | 只在 overview/hydration 中出现，缺少专门告警工作台、筛选、确认结果反馈 | 建立“告警中心”：列表、详情、ack 审计、失败重试 |
| 数据删除治理 | `ops.data.delete.list/cancel/approve` | 已发现 hydration 与通用 decision helper；需运行验证状态、原因、审计和幂等反馈 | 以浏览器证据确认是否需要补强 |
| 平台授权矩阵 | `ops.authorization.matrix.get` | 已发现 `PermissionMatrixSection` 调用；仍需浏览器验证展示、错误和权限边界 | 核验现有页面闭环后再决定是否补强 |
| 授权角色/Grant 管理 | `ops.authorization.roles.list`, `ops.authorization.grants.list/issue/revoke` | 写入闭环容易成为信息孤岛 | 角色/临时授权页，显示有效期、用途、最大使用次数、撤销证据 |
| 审计详情 | `ops.audit.detail`, `ops.audit.export` | 已发现域客户端和 `AuditPage` 链路；导出可用性与平台/workspace scope仍需运行验证 | 以浏览器证据确认是否存在真实缺口 |
| Canonical backfill | `ops.canonical.backfill.*` | 批次/冲突/claim/resolve 是高风险运维能力，当前没有明显页面闭环 | “数据修复”页：dry-run、批次状态、冲突队列、claim/resolve、回滚证据 |
| 存储对账 | `ops.storage.reconciliation.list` | 已有 `StoragePage` 和 hydration；需验证差异详情及失败态是否足够 | 以运行证据决定是否补充详情或 redrive |

### 待核实：已具备后端域，前端覆盖程度未完成运行验收

| 能力族 | 后端方法示例 | 缺口 |
|---|---|---|
| 客服支持 | `ops.support.tickets.list/get/create/assign/transition/comment`, `ops.support.sla.*` | 页面覆盖工单、SLA 修正和评论审计；任务/订单关联已接入，仍需真实工作区数据验收 |
| 事故中心 | `ops.incidents.*` | 页面存在基础事故域，需核对 commander、scope update 与时间线是否全部可操作 |
| 商业运营 | `ops.commercial.timeline.list`, access-blocks, entitlements, points-ledger, orders, rate-cards, fulfillment | 商业工作台存在，但方法族多于页面显式入口，容易只显示摘要不显示证据 |
| 功能开关 | `ops.feature-flags.*` | 页面有入口，但 evaluate/events/emergency 需验证是否可回溯 |
| 营销队列 | `ops.marketing.queue.*`, image audit/reconcile | 有任务/内容域，图像归档、计费审计、重试和发布确认需独立状态闭环 |
| 用户治理 | `ops.user.detail/suspend/activate/risk.transition/session.revoke` | 已接入；需保证冷启动和并发加载稳定，当前已发现并修复加载超时问题 |

### 待核实：可能是后台聚合或迁移遗留

`ops.brand-units.summary`、`ops.stores.list`、`ops.tasks.summary`、`ops.growth.funnel`、`ops.model-usage.summary`、`ops.members.list` 等主要被 overview/hydration 使用。它们不一定需要独立页面，但必须满足：

1. 页面显示数据来源、时间和失败状态；
2. 能从摘要钻取到原始记录；
3. API 失败时不得把空列表显示成“没有数据”；
4. 每个写入动作都有 request/trace/audit 证据。

## 页面与组件缺口

### 1. “导航可见”不等于“能力可用”

导航由 capability projection 控制，但部分页面同时依赖本地 workbench、workspace storage 和托管 OIDC 状态。已发现的典型风险：

- 托管 OIDC 会话曾被旧的本地 workbench 配置判为未连接，导致 `loadUsers` 直接跳过；
- 商业摘要曾从错误的 storage 读取空 workspace；
- 平台会话的 workspace scope 曾只依赖 header/参数，没有回退到签名 principal。

这些问题已修复，但说明页面初始化需要统一的 managed-session context provider，避免每个 hook 自己拼接上下文。

### 2. 缺少统一“请求状态组件”

当前各页面分别处理 loading/error/empty/retry。建议抽出统一组件，至少包含：

- loading 与首屏 skeleton；
- stale-data 标识；
- request/trace ID；
- retry/backoff；
- 权限拒绝与配置阻断的明确区分；
- empty 是真实空数据还是查询失败。

### 3. 高风险写入缺少统一确认/审计体验

成员停用、权限 grant、数据删除、商业积分、功能开关、发布确认等页面应共用：

- 原因字段；
- 幂等键；
- 当前 revision；
- 影响范围；
- 二次确认；
- 执行结果逐条展示；
- 审计链接。

目前各域已有不同程度实现，尚未形成一致组件和交互契约。

## 信息孤岛与闭环缺口

1. **模型/中转证据**：模型状态页面能表达 runtime readiness 与 release evidence 的差别，但成本、provider request ID、五模态证据到运营动作的链路仍应在同一详情页可追溯。
2. **生产 readiness**：配置阻断证据已有文档，但运营页面、发布门禁和 canary 结果没有统一入口；容易出现“页面看起来可用，发布实际上不可用”。
3. **商业账务**：access summary、entitlement、points ledger、orders、rate cards、fulfillment 分散在方法族，缺少以 workspace/customer 为主线的时间线。
4. **审计与错误**：API 返回 request_id/trace_id，但页面只在部分错误中展示；需要全域可点击关联。
5. **数据修复**：canonical backfill 的运行、冲突、修复结果和回滚未形成运营闭环。
6. **真实外部连接**：平台 OAuth、对象存储/KMS、扫描器、支付回调等有后端配置/门禁，但前端缺少“阻断原因 → 配置入口 → 重新验证 → 证据”闭环。
7. **用户治理**：用户目录已能读真实成员，但完整套件冷启动时曾因并发聚合请求超时；已提高关键请求超时并加追踪，仍应把 overview hydration 与 route-critical 查询隔离。

## 建议执行顺序

1. 固化 managed OIDC context provider，删除页面对 local/session storage 的直接依赖。
2. 为 `ops.users.list`、`ops.session`、`ops.workspaces.list` 建立 route-critical 请求优先级和单独连接池预算。
3. 建立统一 Ops request state/error/audit 组件。
4. 对候选能力补充真实桌面浏览器、权限拒绝和审计证据后，再决定是否需要开发。
5. 商业工作台补齐 workspace/customer 时间线，把 access、entitlement、ledger、order、fulfillment 串为一条链。
6. 建立自动契约审计：前端 RPC → contracts → API route → persistence → audit → UI evidence。
7. 把生产 readiness、模型 relay evidence、外部连接和发布门禁接到同一运营证据视图。
8. 真实桌面浏览器验收要求完整 Ops 套件全绿；当前历史最佳为 6/8，用户目录正在继续稳定性修复。

## 当前结论

没有证据表明存在“前端调用了不存在的生产 API”。主要问题是反向覆盖不足：后端已经暴露大量运营/治理能力，而前端缺少可见入口、详情证据或完整写入闭环。最大产品风险不是单个缺失按钮，而是信息跨域分散、失败状态不统一、生产证据不能从一个运营工作流闭环回溯。

## 代码覆盖边界与后续审计方式

本轮是基于 CodeGraph、契约静态扫描、关键源文件阅读和真实桌面验收的负责人审计，不把“文件被索引”冒充成“每一行都完成了人工语义审阅”。当前工作区按目录统计约有：

- `apps/` 1,088 个文件（其中 379 个 TypeScript、144 个 TSX）；
- `packages/` 5,415 个文件（包含生成的 JS/map 文件，不能全部按独立业务源文件计算）；
- `tests/` 576 个文件；
- `scripts/` 68 个文件；
- CodeGraph unresolved references 87,330 条。

因此下一轮应按业务边界而不是文件名逐步审阅：插件入口/MCP 契约、Ops Console 页面与 hooks、API routeMcp、contracts/authz、persistence repositories、worker、发布门禁。每个边界都要补一张“入口 → 鉴权 → 参数契约 → 持久化 → 审计 → UI 状态 → 浏览器证据”链路表，并把 unresolved reference 分成生成代码、动态导入、测试探针和真实缺口四类。

本报告的结论等级分为：CodeGraph 静态证据、源代码交叉证据、单元/API 证据、真实桌面运行证据、生产外部证据。只有最后两级才能支持上线判断；静态扫描和单测只能支持“存在/覆盖关系”，不能证明真实租户、权限、账务或外部连接已经可用。

## 插件、MCP、worker 与发布门禁补充发现

- 插件 skill 明确要求通过 `mcp/bridge.mjs`、宿主 Bearer 身份和 `X-Workspace-Id` 进入 API；缺少 MCP 地址、工作区或真实工具清单必须失败关闭。
- `tools/list` 是插件运行态唯一权威；插件侧必须只看到商家工具，不能混入 `ops.*`。这与 Ops Console 的平台能力隔离是两条不同权限面，不能用前端隐藏代替服务端边界。
- 生成、编辑、批准、发布有独立交互确认、事实确认、审查、批准、预览 hash、幂等键和最终查询闭环。任何前端页面只显示“已提交”而不回查 `publish.get` 都是逻辑闭环缺口。
- worker 具备独立的数据库、Redis、签名 token、扫描器和模型中转凭据；发布/扫描/重试结果必须回到任务状态、审计和商家可读结果。worker 只在后台有实现而没有对应 UI/插件状态投影时，属于信息孤岛。
- Kubernetes 文档要求使用同一份签名渲染清单、scanner contract、Secret/ConfigMap 校验和发布门禁；当前本地报告不能证明生产渲染清单、支付、OAuth、对象存储/KMS 或扫描器证据已齐备。

插件专项代码阅读又发现两个可验证的组件接线缺口：

- `bridge.mjs` 已定义 `RECHARGE_UI_URI`、`IMAGE_EDIT_UI_URI` 和候选图 UI URI，但 `RECHARGE_UI_METHODS`、`IMAGE_EDIT_UI_METHODS` 当前为空；对应能力只能走原生对话或普通结果，定义的组件不会被路由。这是“组件存在但没有入口接线”的信息孤岛候选。
- `assertRelayEvidence` 对生产/staging/preview 的文本、图片、图片编辑、OCR/视频类 relay 结果强制要求 provider execution、provider request ID、usage 和 cost；这是正确的 fail-closed 门禁，但运营后台必须能按 provider request ID 追溯这些证据，否则模型页面和发布页面之间仍是断链。

## 2026-09-06 复核证据补充

本次抽查已确认以下能力不是“后端有、前端无”：

- 审计中心通过 `AuditPage` → `useAuditCenter` → `auditCenterClient` 调用列表、详情和导出；组件提供加载更多、错误重试、脱敏详情抽屉、导出错误反馈和焦点回收。
- `PermissionMatrixSection` 直接调用 `ops.authorization.matrix.get`，并由 `AuthorizationGovernanceSection` 挂载到成员与权限工作区。
- `StoragePage` 读取 `ops.storage.reconciliation.list` 的错误状态，并把摘要与 workspace summaries 传给 `StorageReconciliationSection`。
- `AuthorizationGovernanceSection` 已调用角色、grant 查询及 revoke/assign/issue 写操作。

因此旧表中的这些条目只能保留为“运行态闭环待验收”，不能标为缺失入口或 P0 开发项。后续判断需要补充浏览器截图、真实权限拒绝、请求/审计证据，而不是再次依赖方法名集合差集。

### 路由复核：审计导出与工作区切换

`requiredWorkbenchForDomain("audit")` 固定返回 `platform`。`AuditPage` 在平台 scope 下使用 `listPlatform`，并禁用详情与导出；组件提示用户切换到具体工作区。`OpsConsoleController` 的导航逻辑支持先切换 workbench 再提交目标路由，因此这目前是有意的两步流程候选，不应直接判为缺陷。仍需真实桌面验收确认：平台会话确实能看到可用 workspace 切换器，切换后审计页重新加载 workspace 列表，并且 `audit.export` 权限拒绝有可见反馈。

## 2026-09-06 运营表面审计脚本结果

运行 `npm run audit:ops-surface` 得到：契约方法 108 个，前端引用 106 个，脚本标出的 `ops.data.delete.approve`、`ops.data.delete.cancel` 实际通过 `useOpsConsoleModel.ts` 的通用 decision helper 动态拼接方法名调用；`ops.data.delete.list` 也有 hydration 调用。因此这三项均不是缺失前端入口。该结果仍是静态引用证据，下一步需沿数据删除治理页面、鉴权和服务端状态机做人工链路及浏览器验证。此前 52 项差集不再作为覆盖率依据。

## 2026-09-06 ChatGPT 插件与桌面验收结果

商家插件相关的真实浏览器场景共 25 项，通过 25 项，覆盖 Merchant Studio 漫游、交互校验、发布确认与重试、模型中转可见性、真实数据失败关闭、任务与同步流程。

Ops 专用 runner 最终结果为 7 通过、1 跳过；覆盖全平台页面巡检、模型状态失败关闭、无凭据连接诊断、401 重新认证、平台导航和用户目录治理。跳过项是需要独立 workspace token fixture 的工作区成员治理。全量聚合命令仍可能在没有 OIDC runner 环境变量时出现前置失败，因此验收结果以专用 runner 的真实桌面会话为准，不能把环境前置失败当成插件功能缺陷。

## CodeGraph 新鲜度门禁

CodeGraph 元数据显示索引状态为 `complete`、文件数 1136；按数据库 content hash 与当前工作区比对，发现 70 个文件已变化，涉及知识库组件、Ops 路由、MCP/API 和模型代码。生产级验收前必须重新索引并记录索引时间、工作区提交和变更文件数；在此之前 CodeGraph 只能作为关系线索。
