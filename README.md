# 商家营销内容助手（桌面 ChatGPT 插件）

发布元数据同步基线（2026-09-19）：MCP 契约和商家插件工具面以共享注册表与运行态校验为准，不在文档中固化易过期的工具数量；PostgreSQL 迁移链尾以 `release-metadata.json` 为准，不在文档中写死迁移号。

当前仓库包含一个可运行的工程 RC：桌面 ChatGPT 本地 stdio 插件 manifest/入口 Skill、MCP/API、统一契约、任务/内容/发布领域状态机、人工平台资料导入、生成/发布/对账 Worker、租户隔离 Outbox、OAuth state 安全组件，以及面向付费商家的 Merchant Studio Web 界面（构建产物为 `merchant-ui`）。当前上线档为 `PLATFORM_OPERATIONS_MODE=manual`：六个平台不接 OAuth 自动同步，平台运营人工导入商品与规则资料，商家只消费已分配的数据；官方平台 API 属于未来可选档位，不作为当前上线前置条件。

当前发布验收基线以 `release-metadata.json` 和运行时门禁为唯一权威：Repository、plugin、商家 Bridge 工具面、Ops 域和迁移版本均由机器校验。正式发布仍须由 metadata、真实宿主证据和生产发布门禁共同通过。

桌面 ChatGPT 宿主的本地 stdio 链路已覆盖 `merchant.start`、`workspace.health`、`catalog.search`、`billing.status` 等只读入口；本地 fixture 结果只能证明契约链路，不能替代生产商家、账务或发布证据。生产商家必须由平台运营建立人工店铺记录、导入资料并分配到 workspace 后才可继续。

**发布结论仍为 NO-GO。** 当前阻断不是六平台 OAuth：人工运营档已明确关闭自动授权和平台写入。仍需在同一候选 release 上补齐并验证 capability/capacity 外部证据、模型中转五模态真实用量与成本证据、支付回执、对象存储/KMS/PITR、扫描器、告警值守、`/releasez` 与认证业务路径 canary、签名 rollback bundle、备份 attestation，以及部署后真实桌面运营台验收。

2026-08-29 发布审计复核：仓库版本、插件镜像、MCP 注册表和迁移链已有 fail-closed metadata gate，release manifest 同时绑定 `VERSION`、`CHANGELOG`、metadata、Git SHA、插件、OpenAPI 与 MCP 源码。正式 trust anchor 检查因 `/run/release-security/evidence-trust` 未配置而拒绝，容量示例也因 `cloud_gate=false`、非生产环境、非 HTTPS 且包含 mock 流量而被真实云门禁拒绝。因此仓库门禁可验收，但生产发布继续 **NO-GO**。当前检查项和外部缺口见 [Store Nova 发布解阻清单](docs/runbooks/release-unblock-checklist.md)。

## 本地一键启动

首次使用先安装依赖并检查本机环境：

```bash
npm ci
npm run dev:doctor
```

检查通过后，一条命令启动本地 Compose 服务和桌面 Ops Console：

```bash
npm run dev:stack
```

项目要求 Node 22+、npm，以及已启动的 Docker Desktop（含 Compose v2）；Docker daemon 未启动时 `dev:doctor` 会返回非零状态，这是预期行为，启动 Docker Desktop 后重试即可。`dev:doctor` 会统一检查 Node、npm、Git/worktree、Docker/Compose/buildx、浏览器验收工具、Ops API 地址、模型中转配置、生产配置和本地运行端点，且不会输出密钥。`dev:stack` 会初始化本地扫描器密钥、启动 Compose 栈，并在前台启动 Ops Console；仅启动 API 时可使用 `npm run dev:api`，仅启动运营台可使用 `npm run dev:ops-console`。

这条命令只部署本地服务，不会安装或更新 ChatGPT 插件，也不会注入商家凭据。插件包须由管理员交付到桌面宿主，商家工作区也必须由平台管理员预先分配；当前生产绑定路径按[安装与配置手册](docs/store-nova-chatgpt-plugin-install-manual.md)使用本地登录 CLI，并明确传入管理员分配的 `ws_...` ID。没有工作区绑定时应停止并联系管理员分配/核对，不自动创建工作区，不使用 `workspace.bootstrap` 或演示租户补位。生产一键 Helper 默认关闭，独立商家自助后台尚未交付，不能把后台连接按钮当作现行步骤。CLI 绑定成功后完全重启 ChatGPT、开启新会话，再调用只读 `onboarding.status` 验证。

完整仓库验收不是首次启动步骤。准备候选发布时再运行：

```bash
npm run check
npm run release:metadata:validate
npm run test:release-gates
```

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

`.env` 被 `.gitignore` 忽略，干净 clone 中并不存在。使用 `npm run dev:stack` 时脚本会按需创建权限为 `0600` 的 `.env` 并写入本地扫描器密钥；如需覆盖默认配置，再从模板创建并编辑：

```bash
cp .env.example .env
docker compose --env-file .env -f infra/local/docker-compose.yml up -d
```

Compose 会先执行版本化迁移，再启动 API 和 UI；UI 地址为 `http://127.0.0.1:18081`，API 地址为 `http://127.0.0.1:8787`。UI 的 `/api/*` 请求由 Nginx 同源代理到 API。

UI Demo：见 [demo/merchant-studio/README.md](demo/merchant-studio/README.md)。

## 代码入口

- 产品总文档（主链路、账号密码、知识库、账务与上线门禁）：[docs/store-nova-product-master-document.md](docs/store-nova-product-master-document.md)
- 安装与交付手册（技术安装人员、管理员和商家）：[docs/store-nova-chatgpt-plugin-install-manual.md](docs/store-nova-chatgpt-plugin-install-manual.md)
- 产品使用介绍：[docs/product-usage-guide.md](docs/product-usage-guide.md)
- 测试架构与上线验收：[docs/test-architecture-and-release-readiness-2026-09-08.md](docs/test-architecture-and-release-readiness-2026-09-08.md)

- Plugin manifest：[apps/plugin/.codex-plugin/plugin.json](apps/plugin/.codex-plugin/plugin.json)
- MCP/API：[apps/api/src/server.ts](apps/api/src/server.ts)
- 公共契约：[packages/contracts/src/domain.ts](packages/contracts/src/domain.ts)
- 领域状态机：[packages/domain/src/publish.ts](packages/domain/src/publish.ts)
- 连接器：[packages/connectors/src/index.ts](packages/connectors/src/index.ts)
- Worker：[packages/workers/src/runner.ts](packages/workers/src/runner.ts)
- 持久化与 RLS：[packages/persistence/src/schema.sql](packages/persistence/src/schema.sql)
- 技术方案：[doc/todo/architecture/technical-solution-design.md](doc/todo/architecture/technical-solution-design.md)
- 发布检查清单：[docs/runbooks/release-unblock-checklist.md](docs/runbooks/release-unblock-checklist.md)
- 云资源与部署：[doc/todo/infra/cloud-resources-and-deployment.md](doc/todo/infra/cloud-resources-and-deployment.md)
- Kubernetes 部署基线：[infra/kubernetes/README.md](infra/kubernetes/README.md)
- 能力/容量证据校验（`--file` 为必需参数，指向待校验证据文档）：`npm run evidence:validate -- --file doc/todo/platform/platform-capability-evidence.example.json`、`npm run capacity:evidence:validate -- --file doc/todo/infra/capacity-evidence.example.json`

## 当前明确边界

- 商家产品界面有两个，二者共享同一套 MCP/API 契约：安装在桌面 ChatGPT 中的插件，以及浏览器中的 Merchant Studio（`demo/merchant-studio`）。Merchant Studio 由 `infra/docker/ui.Dockerfile` 构建为 `merchant-ui` 镜像，在 `infra/kubernetes/base/ingress.yaml` 中绑定 `host: yxsona.com` 的 `path: /`，ECS/Compose 路径同样由 `infra/nginx/pilot-gateway-https.conf` 的 `location /` 代理到 `pilot_ui`；`infra/scripts/validate-rendered-production-config.rb` 会在该绑定缺失时拒绝生产部署。因此商家访问 `https://yxsona.com/` 落地页即为 Merchant Studio 的运营概览，其展示内容对客户可见，必须来自真实 API 数据，不得使用演示数值。平台运营后台是桌面工作台。
- 手机和平板不在产品范围、验收范围或上线门禁范围内；不得因移动端适配、移动视口或响应式表现阻断上线，也不得据此扩展需求。
- 真实平台 OAuth、商品读取和写入尚未因代码自动获得权限；未配置时 API 返回 `NOT_CONFIGURED` 并 fail closed。当前上线 profile 为 `manual`：六平台不接 OAuth，商品资料由运营人工上传，发布由运营在官方商家后台人工完成并回填。
- 商业准入是硬门禁，不是提示：零创意点余额会锁死除恢复类方法外的全部业务方法（包括插件入口 `merchant.start`），且只有月付套餐（`basic` / `growth`）会产生权益快照，**点数包不产生权益**。因此上线前必须配置 `COMMERCIAL_PAYMENT_PROVIDER` 并上架可售月付套餐——未配置时下单返回 503 且订单不落库，运营的人工核验又需要一条已存在的订单，客户与运营都无法推进。未绑店铺时商品同步、正式任务与发布返回 428 `STORE_ONBOARDING_REQUIRED`。详见 [产品使用介绍](docs/product-usage-guide.md)。
- fixture connector 的数据和写入只用于契约测试和本地演示，不能作为平台上线证据。
- 未设置 `DATABASE_URL` 时应用默认使用内存 service，便于本地单测；设置 `DATABASE_URL` 后启动迁移并使用 PostgreSQL Outbox。生产必须保留 RLS、Outbox 和幂等约束。
- 生产 API 必须同时提供不同凭据的 `DATABASE_URL` 与 `OPS_DATABASE_URL`；前者是强制 workspace RLS 的租户运行角色，后者只能访问平台 feature flag 控制面，不能访问租户业务表。
