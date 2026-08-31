# 商家营销内容助手（桌面 ChatGPT 插件）

当前仓库包含一个可运行的工程 RC：桌面 ChatGPT 插件 manifest/入口 Skill、MCP/API、统一契约、任务/内容/发布领域状态机、六平台 fixture profile 与可配置 HTTP connector、同步/生成/发布/对账 Worker、租户隔离 Outbox、OAuth state 安全组件，以及仅供开发调试的 Merchant Studio。小红书和抖音在官方 OAuth/API、字段映射与 canary 未完成前保持 fixture/API 或只读，不宣称生产可写。

当前发布验收基线（2026-08-31）：Repository 为 0.1.1，plugin 为 0.1.0+codex.20260831142726，MCP 契约注册表为 249 个唯一方法，商家插件运行态为 149 个 MCP 工具，Ops Console 为 13 个独立一级域，PostgreSQL 迁移链已进入 108。060/062 采用非事务并发索引迁移；063–079 补齐 listing/canonical 品牌组合、身份 bootstrap、素材解析租约、媒体规格、字段映射审批、campaign ACL、legacy 平台/店铺作用域、商品素材完整性、Ops 数据契约、模型用量上下文、canonical 发布作用域和 workspace 知识快照游标；080 增加 workspace 存储配额与预留账本；098 增加 canonical 统一链审计，099 增加 canonical→legacy 品牌复合完整性约束，100 增加告警通知投递账本，101/102 增加 canonical backfill 批次控制与人工冲突队列，103 收紧告警通知账本的应用角色 ACL，104 增加一次性交互确认票据及最小权限消费约束，105 增加 durable authorization grants（持久化授权授予、撤销、JIT 时效/次数预算及双人审批约束），106 增加 NULL 品牌映射的 fail-closed 完整性守卫，107 增加 canonical backfill 冲突验证证据，108 强制已结算模型用量必须存在真实成本。正式发布仍须由 metadata 和发布门禁重新对账。

2026-08-29 桌面 ChatGPT 真实宿主只读验收中，`merchant.start`、`workspace.health`、`catalog.search`、`billing.status` 四项均通过。该结果证明桌面宿主 → 插件 → MCP → 本地 API 的四个核心只读入口可工作；本次店铺、商品和余额来自本地 `ws_demo`/fixture，不能替代真实六平台 OAuth、真实商户余额或生产 release 证据。

**发布结论仍为 NO-GO。** capability 正式签名 preflight、固定 trust/nonce 路径、部署后 `/releasez` 与认证业务路径 canary、签名 known-good rollback bundle、回滚资源 kind 限制和生产备份签名 attestation 均已进入 fail-closed 代码路径。尚缺的是同一正式 release 的外部真实证明：六平台真实 OAuth/读写/媒体 canary、真实支付、托管对象存储/KMS/PITR、容量与长稳、告警值守，以及由发布安全控制面实际配置并演练过的信任锚、原子 nonce consumer、capability attester 和签名 artifacts。

2026-08-29 发布审计复核：仓库版本、插件镜像、MCP 注册表和迁移链已有 fail-closed metadata gate，release manifest 同时绑定 `VERSION`、`CHANGELOG`、metadata、Git SHA、插件、OpenAPI 与 MCP 源码。正式 trust anchor 检查因 `/run/release-security/evidence-trust` 未配置而拒绝，容量示例也因 `cloud_gate=false`、非生产环境、非 HTTPS 且包含 mock 流量而被真实云门禁拒绝。因此仓库门禁可验收，但生产发布继续 **NO-GO**。当前检查项和外部缺口见 [0.1.1 发布 checklist](doc/todo/release/release-checklist-0.1.1.md)。

## 快速开始

```bash
npm install
npm run dev:doctor
npm run check
npm run release:metadata:validate
npm run test:release-gates
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
docker compose --env-file .env -f infra/local/docker-compose.yml up -d
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
- 技术方案：[doc/todo/architecture/technical-solution-design.md](doc/todo/architecture/technical-solution-design.md)
- 发布检查清单：[doc/todo/release/release-checklist-0.1.1.md](doc/todo/release/release-checklist-0.1.1.md)
- 云资源与部署：[doc/todo/infra/cloud-resources-and-deployment.md](doc/todo/infra/cloud-resources-and-deployment.md)
- Kubernetes 部署基线：[infra/kubernetes/README.md](infra/kubernetes/README.md)
- 能力/容量证据校验：`npm run evidence:validate`、`npm run capacity:evidence:validate`

## 当前明确边界

- 本项目唯一商家产品界面是安装在桌面 ChatGPT 中的插件；Merchant Studio 仅用于开发调试。平台运营后台是桌面工作台。
- 手机和平板不在产品范围、验收范围或上线门禁范围内；不得因移动端适配、移动视口或响应式表现阻断上线，也不得据此扩展需求。
- 真实平台 OAuth、商品读取和写入尚未因代码自动获得权限；未配置时 API 返回 `NOT_CONFIGURED` 并 fail closed。
- fixture connector 的数据和写入只用于契约测试和本地演示，不能作为平台上线证据。
- 未设置 `DATABASE_URL` 时应用默认使用内存 service，便于本地单测；设置 `DATABASE_URL` 后启动迁移并使用 PostgreSQL Outbox。生产必须保留 RLS、Outbox 和幂等约束。
- 生产 API 必须同时提供不同凭据的 `DATABASE_URL` 与 `OPS_DATABASE_URL`；前者是强制 workspace RLS 的租户运行角色，后者只能访问平台 feature flag 控制面，不能访问租户业务表。
发布元数据同步基线（2026-09-01）：MCP 契约注册表为 254 个唯一方法，商家插件运行态为 150 个 MCP 工具，PostgreSQL 迁移链已进入 119。
