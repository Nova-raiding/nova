# 持久权限仓储与迁移证据（2026-08-31）

## 结论

本切片最初完成 persistence 层；随后 owner 已把它接入 API/MCP、运营后台和六类 critical worker 的统一执行前复核。真实生产环境、service principal 和外部证据尚未完成，因此整体上线状态仍是 **NO-GO**。

## 后续集成状态（owner 复核）

- API 每次严格认证请求读取主体 `authorization_revision`；平台工作台读取 active role assignment，工作区读取 active exact-workspace grant，并在使用时原子消费 max-use。
- `ops.session.v2` 返回 authorization revision、effective permission atoms、temporary grants、workbench/context；managed session 缺少投影时前端 deny-all。
- MCP 已提供 `ops.authorization.roles.list/role.assign/role.revoke/grants.list/grant.issue/grant.revoke`，全部具有显式 capability、平台 scope、审计和 revision 并发控制。
- 六类 critical operation 共用快照和 execution-check；grant 来源为 `grant:<grant>:<grant-revision>:<identity>:<authorization-revision>`，worker 在副作用/凭据释放前通过 API 重读权威 grant 行，检查 workspace/capability/scope hash/revision/revocation/TTL，并记录 `authorization_recheck`。
- Ant Design 授权中心可按持久身份管理平台角色和 exact-workspace JIT；撤销必须填写原因，不用固定文案冒充操作者判断。
- 本地迁移 105 的 RLS/ACL probe 已确认 `merchant_app` 被控制面表拒绝、`merchant_ops` 有界访问；启动脚本中兼容授权重新开放这些表的问题已通过显式 REVOKE 修复。

已实现：

- migration 105 新增 `platform_role_assignments`、`ops_access_grants`、两类 append-only 事件表和主体级 `authorization_revisions`。
- 平台角色、grant 签发、grant 使用、角色/grant 撤销均在同一数据库事务内递增主体 revision；调用方可用 revision 使旧 session 和旧 worker 授权快照失效。
- JIT grant 绑定 identity、exact workspace、capability 集合、canonical scope hash、工单、审批人、TTL、最大使用次数和 revision。
- read grant 数据库上限 15 分钟；write grant 上限 5 分钟且签发人与审批人必须分离。
- 五张控制面表全部 `ENABLE/FORCE RLS`；policy 同时要求数据库用户为 `merchant_ops` 且事务级 `app.platform_scope=platform_ops`。
- `merchant_app` 对五张表无权限；`merchant_ops` 无 DELETE/TRUNCATE，事件表无 UPDATE；仓储每次访问自行开启短事务并设置平台 scope，失败回滚。

## 数据流与撤权语义

```text
API 解析可信 identity
  -> 读取 authorization_revision + active platform roles/grants
  -> 形成 session/decision 快照
  -> JIT 使用时校验 grant id + identity + workspace + capability
                     + scope_hash + grant revision + TTL + use budget
  -> 原子 use_count/revision++ + authorization_revision++ + used event

撤权：
  role/grant SELECT ... FOR UPDATE
  -> 校验对象 revision + 主体 authorization_revision
  -> revoked_* + object revision++
  -> authorization_revision++
  -> append-only revoked event
  -> COMMIT（任一步失败则全部 ROLLBACK）
```

## API/MCP 接入契约（已按此接入）

API owner 通过 `PostgresAuthorizationRepository(OPS_DATABASE_URL pool)` 接入；生产不允许用 `DATABASE_URL`、header role 或内存 fallback 代替：

1. session 投影：先调用 `getAuthorizationRevision(identityId)`，再按选中工作台调用 `listActivePlatformRoles()` / `listActiveGrants()`；返回 `authorization_revision`、assignment/grant ids 和对象 revision。
2. 角色授予/撤销与 grant 签发/撤销：请求必须带调用方观察到的 `expectedAuthorizationRevision`；对象撤销还必须带 `expectedRevision`。`AUTHORIZATION_REVISION_CONFLICT` 与对象 revision conflict 映射 409。
3. JIT ticket：签名内容至少绑定 `grant_id`、`grant_revision`、`identity_id`、`workspace_id`、`capability`、`scope_hash`；调用 `consumeGrant()` 返回 `undefined` 时统一映射 403，不区分资源不存在、过期、撤销、超次或 scope mismatch。
4. 仓储/数据库不可用时 fail closed，读写动作返回 503；不得回退 gateway role、旧 HMAC 票据或缓存 allow。
5. worker critical 动作接入前必须同时核对持久 grant 状态与 `authorization_revision`；本切片未修改 worker。
6. `platform_owner` 已在数据库 allowlist 预留，但当前 contracts 尚未提供该 canonical role；API 在 contracts 更新前必须拒绝创建该角色，不能自行字符串放行。

## 验证证据

### 单元、迁移完整性与 package build

```text
npm exec vitest -- run --no-file-parallelism packages/persistence/src/*.test.ts
Test Files 96 passed | 16 skipped (112)
Tests      339 passed | 30 skipped (369)

npm run build --workspace @merchant-marketing/persistence
PASS (tsc + migration asset copy)
```

30 个 skipped 用例是未提供 release PostgreSQL URL 时既有的环境门控测试，不能当通过证据。

### 本地隔离 PostgreSQL release 验收

```text
PERSISTENCE_RELEASE_DATABASE_URL=<local-admin-url> npm exec vitest -- run --no-file-parallelism \
  packages/persistence/src/migration-105-release.postgres.test.ts
Test Files 1 passed (1)
Tests      1 passed (1)
```

该测试在当前健康的本地 PostgreSQL 容器中新建随机命名临时数据库，执行完整 1–105 迁移和重复运行，然后验证：

- 双并发消费 `max_uses=1` grant 只有一次成功；
- grant 与平台角色撤销后 active 查询为空，主体 revision 精确到 5；
- `merchant_app` SELECT 被 ACL 拒绝；
- `merchant_ops` 缺少事务级 platform scope 时 RLS 返回 0 行；
- runtime 角色不能 UPDATE 事件或 DELETE grant。

测试结束只删除自己创建的随机临时数据库，未修改或清理现有业务/容器数据。该结果是本地 release-simulation 证据，不是生产证据。

## 未完成与上线阻断（当前）

- 当前 worker registry 定义的六类 critical operation 已完成统一快照/执行前复核；OAuth callback 和定时同步仍缺独立 service principal，故严格环境 fail-closed。退款、删除等未进入该 worker registry 的外部副作用仍需后续 inventory 与契约化。
- HTTP route 的契约级全量 inventory/parity 门禁已形成：`HTTP_OPERATION_POLICIES` 覆盖 OpenAPI 文档操作，并由 `http-authz.test.ts` 校验 identity policy 引用已注册 MCP policy、模板精确匹配和文档操作一一覆盖；但所有真实生产 HTTP 路由的 allow/deny/JIT/审计运行证据仍未完成。
- 尚无 production `DATABASE_URL` / `OPS_DATABASE_URL` 双角色正负向 probe、真实 OIDC 主体或生产审计关联证据。
- 当前完整 compose 迁移被 migration 106 检出的 1 条无效 canonical legacy brand mapping 阻断；必须通过受审计的数据修复流程解决，不能清数据绕过。
- 尚无真实模型五模态中转的鉴权、请求、用量、成本、错误证据和生产 canary。

因此本文件只证明 persistence 数据模型、仓储契约和本地 PostgreSQL 行为，不改变项目生产 **NO-GO** 判断。

### 2026-08-31 当前复验补充

使用 Compose PostgreSQL 管理连接 `postgres://merchant@127.0.0.1:54329/merchant` 重新运行 `migration-105-release.postgres.test.ts`、`migration-109-release.postgres.test.ts` 和 `migration-integrity-release.postgres.test.ts`，结果为 3 个文件、3 个测试全部通过。证据覆盖完整迁移链、RLS/ACL、并发 JIT max-use、角色/grant 撤销、revision 冲突、扫描恢复表和迁移 checksum；测试只创建并清理随机临时数据库。该补充仍属于本地 release-simulation，不替代生产 OIDC、双数据库角色、正式审计和多副本演练。

### 2026-09-01 Postgres authorization reservation 一致性审计（CodeGraph/文档 owner）

本次审计严格限定为 authorization execution reservation，未把图片 Provider 的 operation reservation 当作授权 reservation：

| 层级 | 当前事实 | 判定 |
| --- | --- | --- |
| 授权仓储契约 | `AuthorizationRepository.reserveExecution()` 已定义；Memory 实现校验主体 revision、grant revision、workspace、capability、resource、scope hash、TTL、撤销和 max-use，并对相同 reservation 做幂等返回 | 本地契约存在 |
| Postgres 仓储 | `PostgresAuthorizationRepository.reserveExecution()` 仍抛出 `AUTHORIZATION_EXECUTION_RESERVATION_UNAVAILABLE` | **未实现，fail-closed** |
| 授权迁移 | migration 105 仅建立 `authorization_revisions`、角色、grant 和 append-only 事件表；未建立 execution reservation 表、唯一 event key、fence 状态或对应 RLS/ACL | **缺失** |
| Worker 接入 | `apps/worker/src/handler.ts` 仍调用 `executionAuthorization.assertAuthorized()`，授权复核成功后直接进入 handler；未取得持久 reservation/fence | **未接入** |
| 图片迁移 117/119 | 仅针对 `image_generation_executions.provider_operation_key` 与图片 dispatch 状态，和授权 reservation 无关 | 不可替代授权证据 |

CodeGraph 同步后的当前索引为 **863 files / 12,213 nodes / 45,730 edges**，状态为 `Index is up to date`。静态图确认 `reserveExecution` 的生产调用者仍不存在；动态的 Worker `execution-check` 协议也不能被 CodeGraph 的直接调用边完整证明。

本轮定向回归实际结果：

```text
npx vitest run --no-file-parallelism \
  packages/persistence/src/authorization-repository.test.ts \
  packages/workers/src/execution-authorization.test.ts \
  apps/worker/src/authorization-recheck.test.ts \
  apps/api/src/worker-authorization-recheck.test.ts \
  apps/api/src/security.e2e.test.ts \
  packages/persistence/src/migration.test.ts \
  packages/persistence/src/migration-105.test.ts \
  packages/persistence/src/migration-119.test.ts

Test Files  7 passed | 1 failed
Tests       92 passed | 1 failed
```

唯一失败是 `apps/api/src/security.e2e.test.ts` 的“exact consumed grant row”场景：测试仍期待已消费至 `useCount === maxUses` 的旧快照复核成功，而当前 fail-closed 语义返回 `AUTHZ_EXECUTION_REVOKED`。本轮未修改测试或源码；该失败说明授权消费语义尚未完成契约对齐，不能作为 reservation 或并发线性化的通过证据。

因此当前结论保持：

```text
Memory authorization reservation：LOCAL PARTIAL
Postgres authorization reservation：NOT IMPLEMENTED / FAIL-CLOSED
Worker atomic reservation fence：NOT CONNECTED
跨进程 revoke/reserve、RLS、崩溃恢复：NOT VERIFIED
Production：NO-GO
```

本轮只更新本事实记录，未修改其他开发者的未提交文件，未迁移任何文档到 `doc/done`。后续实现必须由 owner 同步新增授权 reservation migration、Postgres 事务/CAS、Worker fence 接入及真实 PostgreSQL 双进程测试后，重新审计。
