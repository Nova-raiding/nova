# 133000 轮次无数据库迁移发布审计

采集：2026-09-29 14:25 左右（北京时间；以每项命令输出时间为准）。本审计只读取 `main`、公开健康接口和 ECS `101` 容器/迁移记录；未部署、未修改生产、未迁移数据库。CodeGraph 索引为 2,349 文件 / 33,821 节点，用于定位发布链路；gstack QA 的证据分级用于区分“当前旧版健康”“候选通过”“新版本生产验收”。

## 现场事实与目标范围

| 对象 | 现场事实 | 可推断的范围 |
| --- | --- | --- |
| 本地 `main` | HEAD `20161286b2629171d80568c978eac75b2b9dc7d9`；`release-metadata.json` 为插件 `0.1.0+codex.20260929133000`、`expectedMigrationVersion=255`；工作树约 112 个改动/新增路径 | 不是干净、冻结、可签名的候选；这些未提交 API 改动也不在任何 Git SHA 归档内 |
| 公网 demo | `https://yxsona.com/api/releasez` 返回旧 release `release-demo-product-code-20260929` / API Git `fd1ad6a7bd122a391350c185798ac07e92795f8c`，`ready=true` | 旧版在线；不能证明 133000 修复已上线 |
| demo 服务集合 | `ecs-fast-status` 所示 API/副本 `fd1ad6a7`、商家 UI `f48c8454`、Ops UI `fccee758`、worker `ffcda399`；`release_approved=false`，警告 `application_services_have_mixed_source_revisions` | 组件来源混用，正式同一候选发布未批准 |
| 公网 demo 数据库 | 只读 `select max(version), count(*) from public.schema_migrations`：`254|254`，容器 `merchant-demo-85575f9c-postgres-1` | demo 目标库已连续应用至 254；相对本地候选尾 255 少 1 |
| 另一套 production 数据库 | 同样只读查询：`242|242`，容器 `merchant-production-postgres-1` | 它是独立 `merchant-production` 项目，不能拿其 242 代替公网 demo 的 254；若目标改为该项目，差距更大 |
| 公网健康 | `/api/healthz`、`/api/readyz` 与 Ops `/healthz` 可响应；健康详细字段仍显示 `CAPABILITY_EVIDENCE_PATH cannot be read`、`CAPACITY_REPORT_PATH cannot be read` | 在线旧版可用不等于新候选发布证据齐全 |

## 本次 `main` 的发布门禁判定

**API、worker、商家 UI、Ops UI：NO-GO；本地 stdio 插件：可独立直装与真实 App 测试。**

1. `prepare-ecs-candidate-bundle.sh` 要求干净且已提交工作树。当前 `main` 约 112 个待处理路径，需 owner 整合并行改动、选择性提交并冻结 SHA，才有可信候选归档。
2. 正式 `deploy-preflight-ecs.sh` 第 55–57 行要求 `EXPECTED_MIGRATION_VERSION` 与 `release-metadata.json` 一致，即 255。第 278–286 行对普通 `DEPLOYMENT_SCOPE=full` 采用 `MIGRATION_CHAIN_MODE=complete`；`verify-database-migration-chain.sh` 要求在线库达到候选尾。公网 demo 现为 254。把环境变量填成 254 会在 metadata 检查先失败；填 255 会在完整链校验失败。
3. `deploy-verified-ecs-compose.sh` 对普通 C 发布明确要求 rollback capsule 的实时版本 **等于**候选尾；在线升级需要独立签名和核验过的兼容桥。`254→255` 的隔离 API/worker 测试只验证兼容片段，手册明确不等于受保护桥、回滚 capsule、生产切流授权。用户指定本轮**不迁移数据库**，故不能启动能隐式应用 255 的普通部署器，也不能手改 `schema_migrations`、把 255 伪装成 254 或忽略检查。
4. `ecs-candidate-safe-sync.md` 将隔离候选 `/releasez`、同候选 API/MCP、模型中转、ChatGPT 宿主、对象存储、恢复及签名证据列为切流前置。当前旧公网 `/releasez` 身份不等于候选；`ecs-fast-status` 返回 `release_approved=false`。即使排除迁移问题，尚不能称候选已通过上线门禁。

## 真正无需迁移、现在可执行的范围

- **插件本地发布**：将已审查并经过当前版本检查的 `merchant-marketing` stdio 包直装到 ChatGPT 本机缓存，重启 App，再用真实工具事件、结构化输出、中文 UI 和 `demo@sn.com` 的独立 QA 工作区核验。它只更新本机插件/桥接与提示，不会把本地 `apps/api`、商家 UI、Ops UI 或 worker 改动送到 ECS。
- **现网只读和安全门禁测试**：仅在当前旧 API 已支持的方法内测试；每项分别标识 App 可调用、业务空态、权限/余额拒绝、真实正向完成。避免把 116 工具发现、schema 拒绝或 `write=false` 拒绝折算成业务通过。测试前确认结构化工作区 ID 与 QA 租户一致；上传/生成/订单/删除等遵照独立安全审计。
- **云端修复准备**：owner 可把修复裁成真正运行于 254 的独立候选，但这不是仅调环境变量就能得到的部署：需要证明源码不依赖迁移 255、重新定义一致的候选 metadata/迁移尾、复核 API/worker 与 PG16 的真实兼容、构建同 SHA 镜像、生成完整受保护证据及恢复计划，并为该候选提供经审查的正式无迁移发布执行路径。当前 runbook 的普通 full 路径不支持把本地 255 候选直接切到 254；在这些工作完成前，云端发布仍为 NO-GO。

## 复核用只读命令与代码依据

- `git rev-parse HEAD`、`git status --porcelain=v1 | wc -l`、`cat release-metadata.json`。
- `node infra/scripts/ecs-fast-status.mjs`；`curl -fsS https://yxsona.com/api/releasez`；`curl -fsS https://yxsona.com/api/healthz`。
- ECS 只读 SQL：`docker exec merchant-demo-85575f9c-postgres-1 sh -c 'psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select max(version)::int, count(*) from public.schema_migrations"'`，结果 `254|254`；另套 `merchant-production-postgres-1` 结果 `242|242`。没有读取或输出数据库密码。
- [发布手册](../../../runbooks/ecs-candidate-safe-sync.md)、`infra/scripts/deploy-preflight-ecs.sh`、`infra/scripts/deploy-verified-ecs-compose.sh`、`infra/scripts/verify-database-migration-chain.sh`。CodeGraph `status .` 已定位代码图，脚本判断仍以当前磁盘源码为准。
