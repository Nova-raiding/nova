# Merchant Ops Console 运营后台架构文档

版本：v1.0  
日期：2026-08-25  
适用范围：`apps/ops-console`、`apps/api`、MCP 契约、持久化与运营文档

## 1. 结论

当前项目已经有运营后台，不是从零开始：`apps/ops-console` 是独立的 React + Ant Design 管理端，通过 `/mcp` 调用 API。后台覆盖商业化和平台控制面，并已接入知识规则、资产权益、学习建议和竞品参考的安全投影；多模态候选和平台驳回修正版仍需独立运营队列与生产证据。

本轮新增的商业边界是：Codex App 内插件不要求用户提供模型 API Key；模型请求统一经过产品自有中转服务，用户通过工作区钱包充值后解锁生成、图片、视频和发布确认能力。充值订单、余额、能力解锁、成本和异常必须成为运营后台的一级控制面。

目标架构是“独立运营前端 + 统一 MCP/API 控制面 + 角色/工作区门禁 + 业务服务 + 持久化快照与 outbox 审计”：运营后台负责看状态、做审核、处理队列和发起受控命令；不直接连数据库、不持有平台凭证、不替商家确认最终内容或发布。

## 2. 当前实现审计

### 2.1 已存在的后台

| 层 | 当前实现 | 证据 |
|---|---|---|
| 前端 | 独立 Ant Design 控制台，支持构建和静态部署 | `apps/ops-console/src/App.tsx`、`package.json` |
| 访问 | 本地演示使用 Bearer；生产使用 OIDC httpOnly 会话 + 网关 HMAC principal，并携带 `x-workspace-id` | `apps/ops-console/src/App.tsx`、`apps/api/src/server.ts`、`docs/ops-console-runbook.md` |
| 商业化 | 套餐、订阅、加购、优惠券、灰度、用量、退款、对账 | `apps/api/src/server.ts` 的 `workspace.commercial.*`、`ops.commercial.*`、`billing.*` |
| 平台运营 | 平台开关、店铺别名、连接器 readiness、生产证据 | `platform.settings.*`、`workspace.health` |
| 运营治理 | 成员、审计、告警、数据删除双人审批、增长漏斗 | `ops.members.*`、`ops.audit.*`、`ops.alerts.*`、`ops.data.delete.*` |
| 规则 | 传统规则草稿、发布、状态、审计 | `rule.list`、`rule.publish`、`rule.status` |

### 2.2 现有后台的缺口

当前 `App.tsx` 的运营页面已展示以下新能力的安全投影：

- `knowledge.rule.*` 的新知识规则来源、版本、作用域和状态；
- 品牌资产/客户资产的审核状态、权益状态和来源；
- `knowledge.learning.*` 的证据、作用域、影响范围和确认队列；
- 竞品公开信息的来源、卖点观察和差异化参考边界；
- `multimodal.generate`、`multimodal.image.edit`、`multimodal.video.request` 的任务状态、候选审核和风险结果；
- 平台驳回到内容版本/修正版的关联信息展示；现已提供独立的安全重试、异常确认和创建修正版命令，并保留原始回执与审计。

本轮审核还确认：前端加载请求已改为逐域容错，低权限角色缺少某个运营接口时，其余可授权域仍可展示；商业、平台和规则编辑控件会按 `ops.session` 进入只读禁用态；队列安全重试、异常确认、创建修正版、负责人分配和视觉候选审查均已有端到端契约/浏览器证据。负责人字段随 generation/publish job snapshot 持久化，并由 revision 做并发保护；真实生产适配器、权限配置和宿主应用回归仍需外部证据。

因此，对外准确表述应该是：**已有商业与平台运营后台，并已接入营销能力治理投影；真实平台写入、多模态生产候选和驳回修正版队列仍按生产门禁独立放行。**

### 2.3 gstack/红队审计发现的上线前问题

以下问题不是文案问题，而是正式运营后台上线前的工程门禁：

1. 知识库治理接口本轮已补齐运营角色门禁和操作审计；多模态接口是商家侧共享执行入口，运营后台的队列投影、候选审核和三项处置命令必须继续与商家执行权限分离，不能混为一谈。
2. 新规则模型需要明确 `shared/global` 与 workspace 私有规则的边界，避免全局规则和客户规则混用。
3. 前端已改为按运营域逐项容错加载；低权限角色访问不到某个接口时，其余可授权域仍可展示。后续应继续按导航域和权限拆分路由，避免单页静态导航持续膨胀。
4. 当前演示后台手工输入并在 `localStorage` 保存 Bearer token；该模式只允许本地/演示环境。生产必须由 SSO/OIDC 网关提供短时 access token、httpOnly secure session、退出和撤销流程，前端不得接收或保存长期 Bearer token。
5. 当前能构建或打开页面不代表生产就绪；`workspace.health` 的 memory、CONFIG_MISSING、模型缺失、writes disabled、capability/capacity evidence blocked 等状态必须在后台明确展示。

这些问题已同步到主 PRD FR-17.12、运行手册发布门禁和 PM 审计记录，不应被销售文档表述为“已完成的生产能力”。

## 3. 目标架构

```text
运营人员浏览器
    │ HTTPS + Bearer token + workspace grant
    ▼
apps/ops-console（运营控制台）
    │ MCP JSON-RPC / 安全投影 / 命令契约
    ▼
apps/api（统一控制面）
    ├─ 认证、工作区、角色和订阅门禁
    ├─ 运营命令路由与参数校验
    ├─ Knowledge / Review / Merchant / Connector 服务
    ├─ 多模态任务与候选审核编排
    └─ 审计、告警、幂等、限流和状态对账
    │
    ├──────────────┬────────────────┬─────────────────┐
    ▼              ▼                ▼                 ▼
PostgreSQL     Outbox/Event      Object Storage     Redis/Queue
业务快照/审计    事件与恢复         素材/候选/导出       限流/任务 admission
    │              │                │                 │
    └──────────────┴────────────────┴─────────────────┘
                         │
                         ▼
             平台连接器 / 模型供应商 / Worker
```

### 3.1 前端模块

将现有单页控制台按运营任务拆成以下导航域，第一阶段可以继续共用 React 页面和 API client：

1. **总览**：工作区、套餐、用量、告警、模型和平台 readiness。
2. **商户与工作区**：工作区状态、成员、角色、订阅和风险标记。
3. **知识治理**：规则、品牌资产、客户资产、来源、版本、确认和权益状态。
4. **学习建议**：平台驳回、用户反馈、重复修改、建议作用域和确认/驳回。
5. **竞品参考**：公开来源、获取时间、权利状态、拆解报告、差异化参考。
6. **内容与生成队列**：文本、图片、局部编辑、视频脚本/分镜候选及审核状态。
7. **平台与连接器**：授权、同步、失败重试、平台驳回和回执。
8. **财务与运营治理**：账务、退款、套餐、灰度、审计、删除和告警。

前端只调用 MCP 方法，不直接拼接 SQL、不读数据库、不保存模型或平台 Secret。列表必须支持 workspace、platform、brand、store、product、task、status、time range 等服务端筛选，避免把全量跨租户数据下载到浏览器。

### 3.2 API 控制面

每个运营请求遵循以下顺序：

1. 解析 Bearer token、工作区 grant 和 actor；
2. 校验 MCP 方法及参数 schema；
3. 校验工作区状态、角色、订阅/能力门禁和资源归属；
4. 读取安全投影或执行受控命令；
5. 对写操作保存业务快照、revision、outbox 事件和 operation audit；
6. 返回脱敏结果、诊断 ID、下一步动作和阻断原因。

运营后台不得调用面向商家的确认/发布快捷路径来绕过确认层。内容、图片和视频都必须保持 `candidate → review_required → approved/blocked` 的状态边界。

### 3.3 数据与事件

#### 业务实体

- `workspace`、`workspace_member`、`subscription`、`usage_ledger`；
- `platform_account`、`sync_job`、`product`、`task`、`content_version`、`publish_job`；
- `knowledge_rule`、`knowledge_asset`、`learning_suggestion`、`competitor_analysis`；
- `generation_job`、`image_candidate`、`video_script_or_storyboard`、`operational_alert`。

#### 运营写入原则

| 写入类型 | 业务结果 | 必须记录 |
|---|---|---|
| 规则/资产治理 | 新 revision 或状态变化 | actor、workspace、来源、原因、前后状态 |
| 学习建议 | confirmed/dismissed，不自动激活规则 | 反馈证据、作用域、影响范围、确认人 |
| 竞品治理 | source/rights 状态变化 | URL、获取时间、权利状态、使用范围 |
| 候选审核 | approved/blocked/needs_revision | 来源版本、区域/素材、检查结果、审核人 |
| 告警处理 | acknowledged/escalated | 原始平台回执、下一步、确认原因 |

所有跨进程恢复所需的知识对象必须有快照或 append-only 事件；API 重启后不能依赖前端缓存或单进程 Map 恢复运营状态。

## 4. 权限矩阵

| 能力 | workspace_owner | merchant_admin | operator | support | finance | platform_ops |
|---|---:|---:|---:|---:|---:|---:|
| 查看本工作区知识/任务 | ✓ | ✓ | ✓ | 按授权 | - | 按授权 |
| 审核品牌/客户资产 | ✓ | ✓ | ✓ | - | - | - |
| 确认/驳回学习建议 | ✓ | ✓ | 按授权 | - | - | - |
| 发布平台规则 | - | - | - | - | - | ✓/规则管理员 |
| 修改套餐/平台配置 | ✓ | ✓ | - | - | - | ✓ |
| 退款/账务写操作 | ✓ | ✓ | - | - | ✓ | - |
| 成员角色调整 | ✓ | ✓ | - | - | - | ✓ |
| 删除申请二次审批 | ✓ | ✓ | - | - | - | ✓ |
| 最终内容/发布确认 | 商家侧确认 | 商家侧确认 | 不可替代 | 不可替代 | 不可替代 | 不可替代 |

实际授权以服务端角色和 workspace grant 为准，表格不是前端自行放权依据。

## 5. 关键流程

### 5.1 驳回到修正版

```text
平台驳回
  → 保存原始错误码/字段路径/店铺/商品/内容版本/PublishJob
  → 运营队列展示并关联工作区
  → 记录反馈并生成待确认学习建议
  → 运营查看证据与影响范围
  → 商家或规则维护者确认建议/创建修正版
  → 新 content_version 重新检查
  → 商家确认后才允许发布
```

### 5.2 竞品参考

```text
录入合法公开来源
  → 权利状态和获取时间检查
  → 结构/卖点/表达拆解报告
  → 运营确认可作为创意参考
  → 绑定本方已确认商品事实和品牌规则
  → 输出差异化方案
  → 版权/品牌/平台检查
  → 进入候选审核，不自动发布
```

### 5.3 多模态运营队列

文本、图片、图片局部编辑和视频脚本/分镜共用任务追踪模型；每个候选至少关联：workspace、task、product、brand/rule snapshot、source asset、model version、review findings、actor 和 audit event。视频成片渲染在队列中显示为 planned/blocked，不得显示为已生成。

## 6. 非功能与安全门禁

- 租户隔离：API/RLS/业务服务三层校验；列表和导出默认当前 workspace。
- Secret 隔离：浏览器只保存短期 token；模型 Key、平台 token、支付密钥只在服务端 Secret Store。
- 可追溯：所有写操作有 request/trace/actor/audit 关联；历史版本只读。
- 幂等和并发：命令支持 idempotency key；配置和知识更新使用 revision。
- 故障安全：API/Worker 重启后可由数据库快照和 outbox 恢复；平台/模型/权限异常时 fail-closed。
- 性能：总览查询使用聚合投影，避免一次请求扫描原始事件；大导出异步化并限制大小。
- 可用性：只读运营查询和写命令分离，平台异常时仍可查看历史回执和审计。

## 7. 分期交付

### 7.0 本轮商业化与六平台增量

Codex App 中的商家插件不要求用户配置或充值 Codex 模型额度；插件请求统一进入平台自有中转服务。工作区钱包由 `billing.recharge.*`、账本和幂等扣款组成，余额为正才开放内容、图片、视频生成及发布确认，运营台负责订单、余额、扣款、退款、异常和权限审计。

平台注册表覆盖京东、淘宝、天猫、拼多多、小红书、抖音六个平台；每个平台都必须独立通过 OAuth、读写、状态查询、限流和拒绝码 canary 后才能打开生产写入。

批量发布通过 `publish.batch.prepare` 生成最多 50 个独立准备项，每项绑定商品、SKU、店铺、平台、confirmation hash 和失败原因；确认与外部写入按项幂等，运营台已提供队列投影、暂停、恢复、失败重试和回执聚合。

### P0：接入现有后台

- 增加统一导航、workspace/grant 展示、全局阻断原因和知识安全投影；
- 将现有规则、资产、告警、审计和平台 readiness 入口统一到运营任务视图；
- 运营台 build、HTTPS/CORS、Bearer 验证、workspace grant 和脱敏验收。

### P1：新能力运营闭环

- 知识规则/资产审核；
- 学习建议队列；
- 竞品来源和权利审核；
- 内容/图片/视频脚本候选队列；
- 驳回回执、修正版关联和运营指标。

### P2：规模化运营

- 跨工作区聚合报表和成本分析；
- 批量知识治理和规则影响分析；
- 复杂告警编排、视频成片运营和高级模型成本控制。

## 8. 代码与文档映射

| 文档/代码 | 作用 |
|---|---|
| `docs/PRD-merchant-marketing-codex-final.md` | FR-17 产品需求和验收基线 |
| `apps/ops-console/src/App.tsx` | 当前运营台 UI 和 MCP 调用 |
| `apps/api/src/server.ts` | API/MCP 路由、角色门禁、审计和运营命令 |
| `packages/contracts/src/mcp.ts` | MCP 方法与参数契约 |
| `packages/persistence/src/*` | 业务快照、outbox、审计、账务和成员持久化 |
| `docs/ops-console-runbook.md` | 部署、凭证和发布操作手册 |
| `docs/diagrams/ops-console-architecture.html` | 可离线打开的架构图 |
