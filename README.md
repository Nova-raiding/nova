# 商家营销内容助手（Codex Plugin）

当前仓库包含一个可运行的工程 RC：Codex Plugin manifest/入口 Skill、MCP/API、统一契约、任务/内容/发布领域状态机、六平台 fake profile 与可配置 HTTP connector、同步/生成/发布/对账 Worker、租户隔离 Outbox、OAuth state 安全组件，以及可调用 API 的 Merchant Studio。小红书和抖音在官方 OAuth/API、字段映射与 canary 未完成前保持 fixture/API 或只读，不宣称生产可写。

## 快速开始

```bash
npm install
npm run dev:doctor
npm run check
npm run dev:stack
```

项目要求 Node 22+ 和 npm；`dev:doctor` 会统一检查 Node、npm、Git/worktree、Docker/Compose/buildx、浏览器验收工具、Ops API 地址、模型中转配置、生产配置和本地运行端点，且不会输出密钥。`dev:stack` 启动本地 Compose 栈并在前台启动 Ops Console；仅启动 API 时可使用 `npm run dev:api`，仅启动运营台可使用 `npm run dev:ops-console`。

生产部署前使用 `npm run dev:doctor:production`。Git、buildx、持久 Secret 或显式生产配置缺失时会返回非零状态。

API 默认地址：`http://127.0.0.1:8787`

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

开启本地 fake connector 只用于开发/测试：

```bash
CONNECTOR_FIXTURE_MODE=true PLUGIN_WRITE_ENABLED=true npm run dev:api
```

这两个开关不会接通真实京东、淘宝/天猫或拼多多 API。生产环境必须通过官方应用审批、Secret Store 和 feature flag 单独配置。

本地 PostgreSQL/Redis：

```bash
docker compose -f infra/local/docker-compose.yml up -d
```

Compose 会先执行版本化迁移，再启动 API 和 UI；UI 地址为 `http://127.0.0.1:18081`，API 地址为 `http://127.0.0.1:8787`。UI 的 `/api/*` 请求由 Nginx 同源代理到 API。

UI Demo：见 [demo/merchant-studio/README.md](demo/merchant-studio/README.md)。

## 代码入口

- Plugin manifest：[apps/plugin/.codex-plugin/plugin.json](apps/plugin/.codex-plugin/plugin.json)
- MCP/API：[apps/api/src/server.ts](apps/api/src/server.ts)
- 公共契约：[packages/contracts/src/domain.ts](packages/contracts/src/domain.ts)
- 领域状态机：[packages/domain/src/publish.ts](packages/domain/src/publish.ts)
- 连接器：[packages/connectors/src/index.ts](packages/connectors/src/index.ts)
- Worker：[packages/workers/src/runner.ts](packages/workers/src/runner.ts)
- 持久化与 RLS：[packages/persistence/src/schema.sql](packages/persistence/src/schema.sql)
- 技术方案：[docs/technical-solution-design.md](docs/technical-solution-design.md)
- 云资源与部署：[docs/cloud-resources-and-deployment.md](docs/cloud-resources-and-deployment.md)
- Kubernetes 部署基线：[infra/kubernetes/README.md](infra/kubernetes/README.md)
- 能力/容量证据校验：`npm run evidence:validate`、`npm run capacity:evidence:validate`

## 当前明确边界

- 真实平台 OAuth、商品读取和写入尚未因代码自动获得权限；未配置时 API 返回 `NOT_CONFIGURED` 并 fail closed。
- fake connector 的数据和写入只用于契约测试和本地演示，不能作为平台上线证据。
- 未设置 `DATABASE_URL` 时应用默认使用内存 service，便于本地单测；设置 `DATABASE_URL` 后启动迁移并使用 PostgreSQL Outbox。生产必须保留 RLS、Outbox 和幂等约束。
