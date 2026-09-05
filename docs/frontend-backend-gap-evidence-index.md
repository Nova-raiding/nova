# 前后端差距审计证据索引

| 结论 | 主要证据 | 验证方式 |
|---|---|---|
| 前端 Ops 页面集合 | `apps/ops-console/src/navigation/opsNavigation.ts` | 页面路由、工作台约束、capability 过滤 |
| 前端 RPC 调用集合 | `apps/ops-console/src/**/*.ts*` | `rpc`/`rpcForWorkspace` 静态扫描 |
| 后端 MCP/运营分支 | `apps/api/src/server.ts` | `routeMcp` 的 `case` 分支扫描 |
| 能力与角色 | `packages/contracts/src/authz.ts` | `ROLE_CAPABILITIES`、MCP policy、scope 对照 |
| API/MCP 契约 | `packages/contracts/src/mcp.ts`, `http-authz.ts` | 契约单测与 parity 测试 |
| 数据隔离与持久化 | `packages/persistence/src/*-repository.ts` | workspace scope、RLS/tenant query、listMany 对照 |
| worker 闭环 | `apps/worker/src`, `packages/workers/src` | durable outbox、execution authorization、callback 状态 |
| 插件入口 | `apps/plugin/mcp/bridge.mjs`, `apps/plugin/skills/merchant-marketing/SKILL.md` | tools/list、write confirmation、发布状态门禁 |
| 生产发布门禁 | `infra/kubernetes`, `infra/scripts`, `docs/production-readiness-evidence-design.md` | rendered manifest、scanner、secret/config evidence |
| CodeGraph 关系 | `.codegraph/codegraph.db` | nodes/edges/files/project_metadata/unresolved_refs |
| 真实桌面验收 | `npm run test:browser:ops` | OIDC gateway、真实 API/Postgres/Redis、Playwright |

## 证据强度

1. CodeGraph 只证明代码关系和引用候选，不证明运行时行为。
2. 静态契约扫描只证明调用集合的覆盖关系，不证明参数、权限和租户数据正确。
3. 单元/API 测试证明局部契约。
4. 真实桌面浏览器测试证明入口、API/MCP、认证、数据库、Redis 和页面状态的组合行为。
5. 生产证据还必须包含真实渲染配置、外部 OAuth/支付/对象存储/KMS/扫描器、用量成本和发布门禁证据。

## 当前不能宣称的事项

- 不能把 CodeGraph 的 `index_state=complete` 写成“所有代码已经逐行人工读完”。
- 不能把本地 OIDC/Postgres/Redis 验收写成生产发布通过。
- 不能把后端存在的 case 分支写成前端已有完整闭环。
- 不能把空列表、fixture 或 API 成功 envelope 写成真实商家数据可用。
