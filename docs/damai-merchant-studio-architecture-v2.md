# 大麦商家工作台 v2 架构设计

**版本**：v2.0  
**日期**：2026-09-11  
**对应需求**：[damai-merchant-studio-prd-v2.md](damai-merchant-studio-prd-v2.md)

## 1. 架构目标

本架构把商家工作台收敛为一条可验证链路：

```text
ChatGPT App / Desktop Browser
        │
        ▼
Merchant UI (session/context gate)
        │ HTTPS, HttpOnly cookie, trace
        ▼
API + MCP Gateway
        ├─ identity/session authentication
        ├─ workspace/account scope resolution
        ├─ capability authorization
        ├─ idempotency + rate limit
        └─ request/trace/audit evidence
        │
        ├───────────────┬────────────────┐
        ▼               ▼                ▼
Catalog/Knowledge   Rules/Checks     Commercial Access
        │               │                │
        └───────┬───────┴────────┬───────┘
                ▼                ▼
         Postgres + RLS      Redis queues
                │                │
                ▼                ▼
          Read projections   Workers
                │                ├─ sync/import
                │                ├─ scan/rights
                │                ├─ model relay
                │                └─ publish/reconcile
                ▼
             Merchant UI
```

## 2. 关键设计决策

### 2.1 会话先于业务数据

UI 启动只运行 `auth/session` 和必要的健康检查。只有 session 返回 `active merchant + workspaceIds.length > 0` 后，才挂载 Overview、Products、Rules 和其他业务查询。请求层按服务端 `error.code` 区分 `AUTH_*`（清会话）、`WORKSPACE_SCOPE_MISMATCH`/`AUTHZ_CAPABILITY_MISSING`（权限阻断）和 `ACCOUNT_INACTIVE`（账号阻断）；每个 bootstrap 批次只触发一次状态转换，同批次后续受保护请求在浏览器内短路。

### 2.2 workspace 由服务端权威解析

同源商家请求不发送本地默认 `x-workspace-id`；服务端从 HttpOnly session principal 解析 workspace。非同源的受控 API 请求可以携带 workspace，但必须与 principal 的允许范围交集校验，客户端不能扩大范围。

### 2.3 认证、授权和业务准入分层

```text
Authentication: session/token 是否有效
Authorization: actor 是否拥有 capability 和 resource scope
Commercial access: entitlement、点数、模型/平台配置是否可执行
Business state: 商品、规则、任务、发布状态机是否允许当前动作
```

每一层返回不同错误码和恢复动作，禁止把所有失败压扁成“请求失败”。

## 3. 请求状态机

```text
BOOT
  ├─ no api / offline → limited demo state
  └─ api configured → SESSION_LOADING
SESSION_LOADING
  ├─ 401/invalid → SIGNED_OUT
  ├─ wrong type/no workspace → AUTHZ_BLOCKED + bind-workspace action
  └─ active merchant → AUTHENTICATED
AUTHENTICATED
  ├─ hydrate health/context
  └─ mount business routes
BUSINESS_REQUEST
  ├─ 401 AUTH_SESSION_INVALID → SIGNED_OUT + clear request queue
  ├─ 403 WORKSPACE_SCOPE_MISMATCH/AUTHZ_CAPABILITY_MISSING → AUTHZ_BLOCKED
  ├─ 409/428/503 → BUSINESS_BLOCKED with next action
  └─ 200 → update read model
```

`inline-error` 只用于字段级、局部且可就地修正的错误。认证失效、权限拒绝、模型/支付/发布门禁使用全局弹框或阻断页；网络瞬态失败使用带重试的 Toast/状态卡。

## 4. 领域边界

| 域 | 责任 | 不负责 |
|---|---|---|
| Identity | 账号、密码会话、账号状态、workspace membership | 商品和规则事实 |
| Catalog | 平台店铺、商品、SKU、图片和素材权益 | 品牌长期规则 |
| Knowledge | 品牌资料、偏好、来源和学习确认 | 某个商品当前库存 |
| Rules | 平台、品类、广告发布规则及版本 | 账号授权 |
| Marketing | 任务、内容版本、审核和批量流程 | 支付确认 |
| Commercial | SKU、订单、entitlement、点数、用量和成本 | 前端展示布局 |
| Delivery | 发布预检、确认、平台回执和重试 | 修改历史商品事实 |
| Support/Ops | 平台治理、工单、审计、恢复操作 | 绕过商家权限 |

## 5. 规则库数据模型

规则包在现有 `RulePack` 基础上增加服务端提供且数据库约束的明确分类；前端不得根据名称猜测分类：

```ts
type RuleCategory = 'platform' | 'category' | 'advertising_publish'
type RulePack = {
  id: string
  category: RuleCategory
  name: string
  version: string
  scope: string
  status: 'draft' | 'active' | 'expired' | 'blocked'
  source: { reference: string; checkedAt: string }
  revision: number
}
```

规则检查输入必须包含 `workspace_id`、`product_id?`、`platform?`、`category?` 和规则 revision。输出包含 finding、severity、rule id/version、evidence ref、next action；存在 unresolved blocker 时，商业执行和发布均拒绝。

## 6. 数据一致性与审计

跨域操作统一携带：`workspace_id`、`actor_id`、`operation_id`、`request_id`、`trace_id`、`idempotency_key`、`authorization_revision` 和 `evidence_refs`。

Postgres 事务内写入主记录、outbox 和 audit；worker 使用租约、指数退避、最大重试和死信。Redis 只承担队列/锁/速率状态，不作为业务事实来源。读模型必须标记 `freshness` 和 `source`，读取失败不得降级成空数据。

## 7. 关键安全门禁

- 生产 API 必须有效 Bearer 或 HttpOnly password session。
- RLS 以 workspace/member scope 为最终隔离边界。
- 平台 token 只存 credential reference，不进入浏览器或 ChatGPT 参数。
- 模型调用必须经过 relay，保留 provider request、usage、cost 和 outcome evidence。
- 生成前 reserve，成功且证据完整才 settle；失败 release；未知结果进入 reconcile。
- 发布必须通过规则、素材权益、店铺授权、商业准入和二次确认。
- 任一 OAuth、模型 relay、对象存储/KMS、扫描器、支付回调或发布回执缺失，生产能力 fail-closed。

## 8. 前端组件契约

统一 `RequestState` 组件接收：`loading | ready | empty | stale | error | forbidden | blocked`，以及 `requestId`、`traceId`、`source`、`onRetry`、`nextActions`。

统一 `AuthContext` 提供：`status`、`account`、`workspaceId`、`capabilities`、`reauthenticate`。页面不得自行读取 localStorage 推断登录成功，也不得在 `status !== authenticated` 时加载业务 hook。

## 9. 代码映射与实施顺序

1. `demo/merchant-studio/src/App.tsx`：AuthContext、请求状态、导航和首页信息架构。
2. `demo/merchant-studio/src/api.ts`：session、workspace scope、401/403 circuit breaker、错误契约。
3. `demo/merchant-studio/src/MerchantLoginPage.tsx`：登录反馈和授权阻断。
4. `apps/api/src/server.ts`：session principal、workspace resolution、HTTP/MCP capability parity。
5. `packages/persistence`：账号 workspace、规则分类、audit/outbox/RLS。
6. `workers`：同步、扫描、模型、发布、对账的状态和重试。
7. `apps/ops-console`：商家账号开通、workspace 绑定、权限矩阵和审计证据。

实施顺序：P0 会话和权限链路 → P1 信息架构与统一错误 → P1 规则三分类 → P1 真实浏览器/API/MCP 验收 → P2 引导页和体验优化 → 生产配置与 canary 门禁。

## 10. 测试策略

- 单元：规则分类、错误映射、状态机、scope 解析、幂等键。
- API 契约：登录、session、workspace、platform accounts、sync jobs、MCP 和 403 reason code。
- 集成：Postgres/RLS、outbox、worker lease、point reserve/settle/release。
- 浏览器：空登录、错误账号、无 workspace、有效商家账号、会话过期、规则筛选、商品到任务、退出登录。
- 容器：API/UI/worker/Redis/Postgres health 和迁移完整性。

## 11. 发布门禁

只有以下证据全部存在才允许生产发布：

1. 登录页空载无业务请求，授权失败无请求级联。
2. 至少一个真实商家 workspace 完成登录、商品读取、规则读取和任务创建验收。
3. API/MCP/数据库/RLS/worker 链路有 request、trace、audit 和状态证据。
4. 五模态模型 relay、真实成本用量、平台 OAuth、对象存储/KMS、扫描器、支付和发布回执均通过配置检查与 canary。
5. 桌面运营后台可完成账号审核、workspace 绑定、权限查看和恢复操作。

任何缺口都必须显示具体 blocker 和 owner，不得以 fixture 成功替代生产证据。
