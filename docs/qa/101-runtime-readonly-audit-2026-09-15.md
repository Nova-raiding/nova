# 101 运行态只读核验

核验时间：2026-09-15 12:30:11–12:32:07 +08。来源为本轮 agent 的 SSH 工具回执；本轮未生成独立原始证据文件，本文是 owner 整理的摘要，不是部署成功凭证。

## 已确认

- SSH `101` 可连接；14 个目标容器处于 running/healthy，但 API、worker、桌面 UI 和 gateway 并非同一最新候选版本。
- PostgreSQL 为 16.15；`schema_migrations` 连续到 209，无版本缺口。当前候选为 211，不能直接把 PG17 镜像挂载到 PG16 的原数据卷。
- API 和 replica 的 readiness 返回 200，但处于 fixture、写入关闭及生产门禁关闭状态；release identity 未就绪。healthy 不代表生产可用。
- 支付 runtime 的 provider configured=false，阻断原因是 `provider_refund_query_api_must_use_https`。本轮没有读出或输出实际 URL、密钥，没有发起真实支付、模型调用或退款。
- localhost 的常用开发端口有 SSH 隧道。候选桌面测试必须使用拥有唯一 project、镜像、随机端口和精确 SHA 的隔离运行器，不能把这些共享端口当作新代码验收目标。

## 核验到的配置位置

- `/opt/merchant-deploy/.env` 为既有 ECS 配置来源；文件存在不代表各字段正确或已通过生产门禁。不得复制到仓库、日志或聊天。
- `/opt/merchant-deploy/infra/local/docker-compose.yml`
- `/opt/merchant-deploy/infra/local/docker-compose.ecs-pilot.yml`
- `/opt/merchant-deploy/deploy/runtime/auth-hardening.yml`
- `/opt/merchant-validation/20260915T0820Z-worker209-rollout/worker-candidate.override.yml`
- Ops UI 和 payment gateway 使用 `/opt/merchant-releases/9506d7bf/` 下的配置。

上述 12:30 核验时的生产配置 locator 缺失不等于支付密钥丢失，不能据此声称昨日的配置已被删除。该 locator 状态随后已变化，见下节；旧窗口的版本/支付观察不是后续部署验收。

## 13:49–13:50 只读增量核验

owner 在合并其他并行工作的配置准备提交后，再次通过 SSH `101` 只读核验，两个命令均退出 0。本次只输出布尔、权限和状态，不读取/输出原始 dotenv、YAML、URL 或秘密。

- `/opt/merchant-deploy/.env.production-config-path` 当前已存在，是受控 symlink，不是 lstat 意义的普通文件；其 canonical target 位于 `/opt/merchant-deploy` 内，目标为普通文件、mode 600。symlink 的 lstat mode 777 不等于目标文件可被任意写入。
- locator 解出的 YAML 路径与预期部署 root 内目标一致，YAML 为普通文件、mode 600，配置目录为 mode 700。
- `configuration_status=BLOCKED_UNTIL_REQUIRED_PRODUCTION_INPUTS`。已有持久化路径/draft 不代表真实秘密引用、生产配置、支付或发布门禁通过。
- 本增量未重新核验 API/数据库版本，不以 locator 检查替代 PG17/211 升级证据。未执行 installer、renderer、preflight、备份、迁移、重启、支付或模型调用。

## 发布前置条件

先保存 PG16 备份，在独立 PG17 目标中恢复并演练 209→211，再部署同源不可变镜像并核验权限、迁移和 release identity。原业务卷与回滚数据保留。之后完成真实 ChatGPT 插件、支付宝支付/回调/查单/退款/对账、知识库和模型中转 canary，以及目标环境发布门禁。

本轮没有更改 101 配置、重启容器、执行迁移或删除业务/容器数据。判定仍为 NO-GO。
