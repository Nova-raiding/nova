# 运营后台闭环架构设计

## 分层

```text
ChatGPT 插件 / 运营桌面后台
          │
          ▼
Ops UI API clients ── capability projection / scope context
          │
          ▼
MCP + /v1 ops gateway ── authz / idempotency / audit / trace
          │
    ┌─────┴─────────┐
    ▼               ▼
Domain services   Operation ledger
    │               │
    ├─ commercial   ├─ operation_id/trace_id
    ├─ marketing    ├─ state transitions
    ├─ governance   ├─ evidence refs
    └─ support      └─ cost/usage records
    │
    ▼
Postgres + RLS / Redis queues / Workers / local model relay
```

## 核心数据关联

所有跨域工作项必须携带：`workspace_id`、`actor_id`、`operation_id`、`trace_id`、`idempotency_key`、`authorization_revision`、`status`、`last_error`、`evidence_refs`。商业账务与营销执行不得只靠时间戳或业务名称关联。

## 写入门禁

1. gateway 校验身份、scope、capability 和 authorization revision；
2. domain service 校验状态机、幂等键和业务前置条件；
3. persistence 在事务中写主记录、outbox 和 audit；
4. worker 使用租约/重试/死信；
5. read model 将状态、成本、错误和证据投影给 Ops UI；
6. 缺失密钥、模型中转或外部平台配置时返回明确 blocked 状态。

## 实施顺序

P0：统一 operation ledger、数据删除闭环、商业点数双审、Worker 配置/健康门禁。  
P1：canonical backfill、规则审计、履约状态机、资产计费对账。  
P2：商业导出、授权矩阵增强、用户风险与会话治理、体验优化。

