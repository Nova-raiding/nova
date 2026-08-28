# 商家营销内容助手云资源与服务器配置

版本：v1.4  
对应产品文档：[PRD-merchant-marketing-codex-final.md](./PRD-merchant-marketing-codex-final.md)  
适用范围：先按 50 个商家工作区同时在线采购和部署，架构预留扩展到 500 个工作区；京东/淘宝/天猫/拼多多四个 schema profile、单区域生产部署

## 1. 结论

建议采用“托管云服务 + 无状态容器 + 托管数据库/队列/对象存储”的单区域高可用架构，不需要自建 GPU、微服务集群、Kafka 或多地域双活。

50 家并发的生产起步资源约为：

- 应用与 Worker：约 12 vCPU、24 GB 内存。
- API：2 个无状态副本，2 vCPU / 4 GB。
- Worker：4 类、每类 1 个副本；发布和对账建议各保留 2 个副本。
- 数据库：HA PostgreSQL，4 vCPU、16 GB 内存起步，预留升配到 8 vCPU / 32 GB。
- Redis/队列：HA，4 GB 内存。
- 对象存储：1 TB 逻辑容量配额起步，扩展到 5 TB。
- 外部入口：托管 DNS、TLS、WAF、L7 负载均衡，至少 750 条并发连接能力。

500 家并发仍是产品容量目标，不代表首期一次性购买 500 家满配资源。最终规格必须以同版本软件、同区域、同配置和同平台/模型配额完成预发布压测后的结果为准。

## 2. 逻辑部署拓扑

```text
Codex App / Plugin
        │ HTTPS
        ▼
DNS → TLS → WAF → L7 Load Balancer
                         │
              ┌──────────┴──────────┐
              │  Stateless MCP/API  │  2 → 12 replicas
              └──────────┬──────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   PostgreSQL         Redis/Queue      Object Storage
   HA + Pooler        HA + Outbox      KMS + Lifecycle
        │                │                │
        └──────────────┬─┴────────────────┘
                       │
       ┌───────────────┼────────────────┐
       │               │                │
  Sync Workers   Generation Workers  Publish Workers
       │                                │
       └───────────────┬────────────────┘
                       │
                Reconcile Workers
                       │
       JD / Taobao / Tmall / Pinduoduo APIs
```

## 3. 生产起步资源规格

### 3.1 网络与入口

| 资源 | 起步配置 | 必须满足 |
|---|---:|---|
| DNS | 1 个生产域名 | 支持健康检查和故障切换配置 |
| TLS | 托管证书 | HTTPS 全站启用，OAuth 回调必须使用 HTTPS |
| WAF | 托管 WAF | 防常见 Web 攻击、IP/身份限流、请求体大小限制 |
| L7 LB | 1 个托管负载均衡 | 首期支持 150 条并发连接，并可扩到 750 条；支持健康摘除和滚动发布 |
| 公网出口 | 固定出口或 NAT 网关 | 便于平台 API 白名单、审计和故障排查 |
| 私有网络 | VPC/VNet + 私有子网 | API、Worker、数据库和 Redis 不直接暴露公网 |
| 安全组 | 最小权限规则 | 仅 LB → API、API/Worker → 数据层、Worker → 官方平台 API |

推荐域名：

```text
merchant.example.com                  # 产品/回调入口
mcp.merchant.example.com              # MCP 服务入口，可与产品域名合并
```

必须配置的回调地址：

```text
https://merchant.example.com/v1/oauth/callback/jd
https://merchant.example.com/v1/oauth/callback/taobao
https://merchant.example.com/v1/oauth/callback/tmall
https://merchant.example.com/v1/oauth/callback/pinduoduo
https://merchant.example.com/v1/webhooks/platform/jd
https://merchant.example.com/v1/webhooks/platform/taobao
https://merchant.example.com/v1/webhooks/platform/tmall
https://merchant.example.com/v1/webhooks/platform/pinduoduo
```

### 3.2 API/MCP 运行时

| 项目 | 起步 | 上限/策略 |
|---|---:|---:|
| 副本数 | 2 | 12 |
| 单副本规格 | 2 vCPU / 4 GB | 保持无状态，按副本横向扩容；扩到 250/500 时升为 4 vCPU / 8 GB |
| 会话 | 不使用内存会话 | 禁止粘性会话，状态写入 PostgreSQL/Redis |
| 扩容信号 | CPU 60%、P95、并发连接 | 超阈值 120 秒内开始扩容 |
| 单副本连接目标 | 约 100 条 | 50 家起步预留 150 条；扩到 500 家时扩为 750 条 |
| 请求体限制 | 50 MB | 上传大文件走对象存储分块，不经过长连接 API |
| 健康检查 | `/healthz` | 区分存活、就绪和依赖健康 |
| 发布方式 | 滚动发布/蓝绿任选 | 不终止已接收 Job；失败自动停止放量 |

API 只负责鉴权、校验、快照、保存、Job 接收和状态查询。同步、生成、发布、对账不得长时间占用 API 请求。

### 3.3 Worker 资源

| Worker 池 | 50 家起步副本 × 单副本规格 | 最大副本 | 扩容信号 |
|---|---:|---:|---|
| 商品同步 | 1 × 2 vCPU / 4 GB | 12 | 最老任务年龄、队列深度、平台配额 |
| 内容生成 | 1 × 2 vCPU / 4 GB | 16 | 最老任务年龄、模型 RPM/TPM、并发额度 |
| 商品发布 | 2 × 1 vCPU / 2 GB | 8 | 最老任务年龄、平台配额、发布优先级 |
| 状态对账 | 2 × 1 vCPU / 2 GB | 4 | unknown 任务年龄、队列深度 |

Worker 要求：

- 四类队列和 Worker 独立部署、独立并发预算。
- 按 `workspace_id + platform + account_id` 公平调度。
- 单工作区默认不超过可用 Worker 并发的 10%。
- 同一店铺/同一商品写操作串行。
- 平台 429、5xx、timeout 进入退避、熔断或对账，不无限重试。

50 家起步应用资源合计约 12 vCPU / 24 GB；全部扩容上限约 184 vCPU / 368 GB。上限是容量规划值，不应在上线时一次性购买。

### 3.4 数据库

| 资源 | 配置 |
|---|---|
| 类型 | 托管 HA PostgreSQL |
| 起步规格 | 4 vCPU / 16 GB |
| 高可用 | 主备或云厂商 HA，自动故障转移 |
| 连接池 | 托管 Pooler/Proxy |
| 客户端池 | 50 家 Compose/试点 profile：API 20、Worker 5；目标 500 profile：API 12、Worker 3；均经 pooler 汇聚 |
| 后端连接预算 | 50 家起步不超过 120；目标 500 profile 的最大客户端池按 12×12 + 40×3 = 264 预留，后端总预算不超过 300 |
| 告警 | 连接使用率 80%、锁等待、慢查询、IOPS、事务时长 |
| 备份 | 自动备份 + 30 天保留；必须完成恢复演练 |
| 数据保留 | 试点默认 90 天；删除任务按 PRD 生命周期执行 |

数据库设计约束：

- 所有业务表、缓存读写和查询必须带 `workspace_id`。
- 高频列表使用分页和复合索引。
- 同步使用批量 upsert，禁止逐 SKU N+1。
- Transactional Outbox 保证已接收 Job 可重建到队列。
- 历史任务使用不可变快照，不能被当前商品资料静默改写。

### 3.5 Redis、队列和 Outbox

| 资源 | 起步配置 | 用途 |
|---|---|---|
| Redis | 托管 HA，4 GB 起步，可扩到 8 GB | 缓存、限流、短状态、分布式锁的辅助能力 |
| 同步队列 | 独立队列 | 商品全量/增量同步 |
| 生成队列 | 独立队列 | 内容生成和模型调用 |
| 发布队列 | 独立队列 | 确认后的平台创建/更新 |
| 对账队列 | 独立队列 | unknown、超时、回调和远端状态收敛 |
| Outbox | PostgreSQL 持久化 | 队列不可用时可重建，避免已接收 Job 丢失 |

Redis 不是唯一事实来源。不能只把发布 Job 放在 Redis 后返回成功；返回 Job ID 前必须完成数据库快照和 Outbox 持久化。

### 3.6 对象存储

| 项目 | 配置 |
|---|---|
| 类型 | 托管对象存储 |
| 逻辑配额 | 1 TB 起步，扩容到至少 5 TB |
| 工作区隔离 | `workspace_id/brand_id/product_id/task_id/version_id/` 前缀 |
| 加密 | KMS/托管密钥 |
| 下载 | 短时签名 URL，默认 10 分钟 |
| 上传 | 单文件 50 MB、单批 20 个、单批 250 MB；大文件分块 |
| 生命周期 | 临时预览、失败中间产物和历史资产分层清理；已交付包不得默认删除 |
| 版本 | 原始文件只读，派生预览另存，不覆盖原始文件 |

### 3.7 密钥与安全资源

必须使用云厂商托管 Secret Manager/KMS，不得把真实密钥写入代码、Plugin、Skill、配置仓库、数据库明文或日志。

| 密钥/配置 | 保存位置 | 用途 |
|---|---|---|
| JD AppKey/AppSecret | Secret Manager | 京东 OAuth/API |
| Taobao AppKey/AppSecret | Secret Manager | 淘宝/天猫 OAuth/API |
| PDD Client ID/Secret | Secret Manager | 拼多多 OAuth/API |
| Token 加密密钥 | KMS | 商家平台凭证信封加密 |
| Webhook signing secret | Secret Manager | 回调验签 |
| Database/Redis URL | Secret Manager | 数据层连接 |
| Object Storage KMS key | KMS | 文件加密 |
| OTEL/Error DSN | Secret Manager | 观测上报 |

安全必配：OAuth `state` TTL 600 秒、回调域名白名单、官方 API 出站域名白名单、Token 脱敏、短签下载、密钥轮换、撤权后立即停止同步/发布。

### 3.8 模型服务

P0 不自建 GPU，使用经批准的模型 API 或企业模型服务。

必须提前取得：

- 提取、生成、审核模型的固定 Model ID。
- RPM、TPM、最大并发和上下文限制。
- 数据地域、留存、训练使用和企业隐私条款。
- 单任务最大成本和每日工作区成本预算。
- JSON Schema 输出、最多 2 次格式修复、90 秒超时。

模型配额不足时只能排队、限流或返回预计等待，不得通过无限重试制造雪崩。

### 3.9 可观测与运维

| 资源 | 必备内容 |
|---|---|
| Metrics | API P95/P99、Job 接收、5xx、队列深度/队龄、Worker 饱和、DB 连接、Redis 内存、平台/模型 429、成本 |
| Logs | 结构化日志，包含 trace/workspace/task/job/platform/account；禁止 Token 和敏感正文 |
| Tracing | OTEL，100% 请求有 trace ID |
| Error reporting | API、Worker、Connector 异常聚合和版本关联 |
| Dashboards | 系统总览、平台连接器、发布状态、容量、租户公平、成本 |
| Alerts | P0 事实漏检、跨工作区访问、publish_unknown、OAuth 失败、规则过期、队列积压、DB 连接池、平台错误 |
| Runbook | 平台撤权、429、超时 unknown、重复发布、队列重建、数据库恢复、写 kill switch |

## 4. 环境配置

至少建立三套完全隔离环境：

| 环境 | 用途 | 平台凭证 | 数据 |
|---|---|---|---|
| Development | 本地/日常开发 | Sandbox/Mock | 脱敏样例 |
| Pre-production | 联调、压测、故障演练 | 独立测试应用/店铺 | 合成数据 + 脱敏 fixture |
| Production | canary 和正式试点 | 正式应用/店铺 | 真实商家数据 |

三套环境必须隔离数据库、对象存储桶、队列、密钥和平台应用；生产 Token 不得进入开发或预生产。

## 5. 上线前容量与资源验收

本地和云上门禁必须明确区分：

- `npm run test:load`：内存 fake，仅验证领域闭环。
- `CAPACITY_GATE_MODE=local_fake CAPACITY_GATE_PROFILE=pilot_50 npx tsx tests/http-capacity-gate.ts`：loopback HTTP fake，验证 50 workspace HTTP 并发和延迟预算。
- `sh tests/run-compose-acceptance.sh`：本地真实 Compose/PostgreSQL/Redis/Worker HTTP 验收，仍为 `cloudGate=false`。
- `CAPACITY_GATE_MODE=real_cloud CAPACITY_GATE_PROFILE=pilot_50 CAPACITY_GATE_URL=https://... CAPACITY_GATE_ENVIRONMENT=preproduction CAPACITY_GATE_CONFIRM_REAL_CLOUD=true npx tsx tests/http-capacity-gate.ts`：仅此模式可标记 `cloudGate=true`；必须绑定预发布/生产原始容量报告，不能用 fake 或 loopback 结果替代。
- `npm run test:capacity-workload`：按固定 profile 执行真实 HTTP 持续/突发流量、异步 Job 受理、幂等和噪声工作区统计；通过 `CAPACITY_WORKLOAD_MODE=real_cloud`、HTTPS、`CAPACITY_WORKLOAD_CONFIRM_REAL_CLOUD=true` 才允许连接真实云。脚本输出只覆盖 API/Job admission，`platform_traffic_exercised=false`、平台/模型 mock 比例为 1，必须与四平台 canary 和模型配额报告合并后才能形成正式容量证据。
- HTTP capacity gate 的覆盖范围固定为 `api_http_only`，并且 `platformTrafficExercised=false`；它不会、也不能声称完成京东/淘宝/天猫/拼多多 connector canary。可用 `CAPACITY_GATE_OUTPUT=/secure/evidence/http-capacity-summary.json` 以一次性创建方式保存摘要，避免覆盖既有证据。
- 运行结果必须整理为 `capacity-evidence.json`，并通过 `npm run capacity:evidence:validate -- --file <report>`；部署 preflight 对正式报告额外要求 HTTPS、`cloud_gate=true`、零平台/模型 mock、profile 阈值、0 错误/重复写入/丢 Job、公平性和 6 小时稳定性。

资源部署完成不等于支持 500 家商家。必须使用同版本配置完成：

1. 首期先验证 50 个不同工作区、建议 150 条客户端连接；扩容阶段再验证 500 个工作区、750 条客户端连接。
2. 首期 30 RPS 持续 30 分钟；扩到 500 家时验证 150 RPS。
3. 首期 60 RPS 突发 60 秒；扩到 500 家时验证 300 RPS。
4. 首期 50 个异步作业在 60 秒内提交；扩到 500 家时验证 500 个，全部返回唯一 Job ID。
5. 单租户 10 倍噪声流量，其余租户 P95 退化不超过 20%。
6. 6 小时稳定性运行，无内存持续增长、连接耗尽和队列不收敛。
7. 滚动重启 API/Worker、Redis 短故障、数据库连接池满、平台/模型 429 和 timeout。
8. 作业丢失、重复发布、跨工作区泄露均为 0。

容量报告必须绑定：代码版本、配置版本、环境规格、数据库参数、压测脚本、数据集、平台/模型 mock 与真实调用比例和原始指标。

## 6. 分阶段扩容计划

| 阶段 | 目标并发工作区 | API | Worker | PostgreSQL | Redis | 对象存储 |
|---|---:|---|---|---|---|---|
| 首期采购 | 50 | 2 × 2C/4G | 6 个起步副本 | 4C/16G HA | 4G HA | 1 TB |
| 第一阶段 | 100 | 2–3 × 2C/4G | 按队龄扩容 | 4C/16G | 4G | 2 TB |
| 第二阶段 | 250 | 3–6 × 4C/8G | 四类池分别扩容 | 8C/32G | 8G | 3 TB |
| 目标阶段 | 500 | 3–12 × 4C/8G | 最大 40 个副本 | 8C/32G 起 | 8G | 5 TB |

每次扩容必须同时复核数据库连接、模型 RPM/TPM、平台配额、队列队龄、租户公平和成本；不能只增加 API 机器。

## 7. 云资源采购/配置清单

### 必买/必开

- 托管 DNS、TLS、WAF、L7 负载均衡。
- 托管容器运行时或应用托管平台。
- HA PostgreSQL + 连接池代理。
- HA Redis/托管队列。
- 对象存储 + KMS + 生命周期。
- Secret Manager/KMS。
- Metrics、Logs、Tracing、Error Reporting。
- 备份、恢复和告警能力。

### 需要外部审批，不是云资源

- 京东开放平台应用、权限、回调域名、测试店铺和配额。
- 淘宝/天猫开放平台应用、权限、安全等级、测试店铺和配额。
- 拼多多开放平台应用、权限、回调域名、测试店铺和配额。
- 模型供应商企业权限、配额、数据处理条款和成本预算。
- 商家授权、平台协议、隐私政策、数据地域和责任声明。

### P0 不需要

- 自建 GPU 集群。
- Kafka、Service Mesh、自研调度器。
- 多地域双活。
- 微服务拆分。
- 独立图片/视频渲染集群。

## 8. 与现有配置文件的关系

详细字段契约已在 [production-config.example.yaml](./production-config.example.yaml) 中定义。本文件用于采购、部署和验收说明；YAML 只允许填写环境配置，不得提交真实密钥。

上线前至少完成：

- 将 `SET_*` 字段替换为审批后的真实配置或 Secret 引用。
- 默认关闭四平台 auth/read/write Feature Flag，完成逐平台 canary 后再开启。
- 保持 `unattended_publish_enabled: false` 和 `visual_generation_enabled: false`。
- 填写容量报告、配额证据、Owner、runbook 和回滚信息。
- 通过 PRD 的 Day 0、Day 13、Day 15 Go/No-Go 门禁。

## 9. 可复制部署与恢复模板

仓库内模板的职责边界如下：

- `infra/config/staging.example.yaml`：预生产的独立资源、Secret 引用和默认关闭平台写权限配置。
- `docs/production-config.example.yaml`：生产字段契约；真实值只从托管 Secret Manager/KMS 注入。
- `infra/local/docker-compose.yml`：本地/联调依赖。`migrate` 服务只执行 `packages/persistence/src/migrations/*.sql`，并在 `schema_migrations` 中登记版本；不再挂载兼容指针 `schema.sql`。
- `infra/scripts/backup-postgres.sh`、`restore-postgres.sh`：数据库备份、校验和、显式确认恢复模板。
- `infra/scripts/scale-workloads.sh`：50/100/250/500 容量档位的 dry-run 扩容模板；生产执行时由平台注入 `SCALE_COMMAND`。
- `infra/scripts/rollback.sh`：显式确认的发布回滚模板；回滚后必须执行健康、迁移、队列收敛和 `publish_unknown` 检查。
- `infra/observability/`：Prometheus 告警和 OTEL 脱敏管道示例。
- `infra/backup/backup-policy.example.yaml`：数据库 PITR、对象存储版本化和恢复演练约束。

部署顺序固定为：备份/迁移 → 部署 API/Worker → 健康检查 → 小流量 canary → 观测窗口 → 放量。迁移失败不得放量；生产回滚不得自动反向执行破坏性 schema migration，只允许回滚兼容应用版本或按恢复演练 runbook 操作。
