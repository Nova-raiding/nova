# 本轮 CodeGraph 只读影响复核

日期：2026-09-07（Asia/Shanghai）。本次只运行图谱查询、源码读取与 `rg`，未运行测试、重建索引、修改配置或修改源码。此报告不构成任何套件通过/发布结论。

## 当前图状态

- CLI 1.5.0，当前索引 `.codegraph`；最后索引时间 `2026-09-07T09:59:33.116Z`（北京时间 17:59:33）。
- 1,157 个文件、16,164 个节点、61,117 条边；查询时仍有 15 个新增文件、40 个修改文件待索引。
- `state=complete` / `reindexRecommended=false` 表示既有索引的提取状态/提取版本，不表示本轮源码已同步。
- `server.ts` 当前为 1,585,986 字节，`node --file` 明确没有匹配。此前独立构建的 `../codegraph/clean-build.json` 已记录该文件超过 1,048,576 字节上限；本次没有重新构建或尝试放宽上限。

## 图结果与源码校正

| 目标 | 图中 affected tests / traversed | 当前实际入口与边界 |
| --- | --- | --- |
| `scripts/run-ops-oidc-e2e.ts` | 106 / 189 | 图仍展示旧 `sourceContainer`、`serviceEnv` 和固定端口；不能用其宽泛“used by”列表作为当前调用链。实际 `package.json:32,58` 调用 runner；`tests/ops-e2e-isolation.test.ts:3` 导入当前参数/环境函数；runner `:8,100,127,153` 接自建 fixture、真实 API 子进程与 Playwright。默认选 `ops-jit-isolated.spec.js`。 |
| `scripts/run-safe-tests.ts` | 0 / 0 | 新文件未索引，不代表无测试。`package.json:22,55,62` 的 test/watch/check 链调用它；`tests/safe-test-launcher.test.ts:2` 直接测试环境、参数和生命周期；`tests/test-summary.ts:6,124` 复用环境构造并运行该入口。`tests/quality-entrypoints.test.ts` 守卫 package/config 接线。 |
| `AuthorizationGovernanceSection.tsx` | 5 / 14 | 五个图中测试是组件、UsersGovernanceWorkspace、两个 OpsConsoleController、UsersPage 测试。源码 `UsersGovernanceWorkspace.tsx:5,65` 确認实际渲染入口；组件 `:110,140,251` 调用 grants.list、grant.revoke、grant.issue。新桌面 spec 的动态 UI→RPC 边不应依赖静态 imports 才算覆盖。 |
| `apps/api/src/server.ts` | 0 / 0 | 文件缺失，必须人工补边。`worker-authorization-recheck.test.ts:3,243-256` 有 helper 和真实签名 HTTP 两类路径；`server.ts:11407,11426` 是公开 grant issue/revoke，`:18263-18329` 是两个 execution-check 入口。隔离桌面 runner 直接运行本 API 源文件，spec 从 UI 点击捕获真实 `/api/mcp` 响应。 |

四文件合并图查询也是 106 个 affected tests / 189 条遍历依赖，并非四组相加；不能据此缩减 owner 的完整 check 或推断遗漏文件无需测试。

## 必须保持的证据分层

1. `AuthorizationGovernanceSection.test.tsx:166,194` 的浏览器场景使用 `page.route` 返回受控 MCP 响应，是组件提交与错误呈现验收，不是持久化 API/OIDC 验收。
2. `worker-authorization-recheck.test.ts:256` 明确是真实签名 HTTP + 受控 Memory repositories，不能充当 PostgreSQL/RLS 验收。
3. `ops-jit-isolated.spec.js:53,111,154,211,236,259` 声明了桌面登录→真实 RPC 签发→刷新→撤销的运行链；1440×900、1280×800 两个桌面尺寸。其是否执行成功应仅引用 owner 的对应 run/原始报告，不从本次静态查询推出。普通 `npm check` 的成功也不等同专用桌面/真实 PostgreSQL 入口成功。

## 原始证据与复现命令

- `codegraph-status.json`
- `codegraph-affected-all.json` 与四个 `codegraph-affected-{ops-runner,safe-launcher,authorization-ui,server}.json`
- 四个 `codegraph-node-{ops-runner,safe-launcher,authorization-ui,server}.txt`
- `codegraph-rg-test-edges.txt`：package/config、测试导入、UI/RPC、worker HTTP 与文件大小的原始引用。

实际执行的 CLI（四个 PATH 为上述四目标路径）：

```sh
/opt/homebrew/bin/codegraph --no-color status --json
/opt/homebrew/bin/codegraph --no-color affected scripts/run-ops-oidc-e2e.ts scripts/run-safe-tests.ts apps/ops-console/src/components/users/AuthorizationGovernanceSection.tsx apps/api/src/server.ts --json
/opt/homebrew/bin/codegraph --no-color affected PATH --json
/opt/homebrew/bin/codegraph --no-color node --file PATH --symbols-only
```

CLI `node` 本次使用文本输出；`affected` / `status` 使用原始 JSON。没有把零结果、旧符号关系或图谱完成标志解释为测试/功能完成。
