# 254→255 前向迁移与恢复审查（当前 NO-GO）

## 已核对的边界

现网数据库停在迁移 254。提交 `2c366e0a220ae4cae6adc4c07573ef31864e0c0e` 与其后代 `cab31fd883054103bcac37b50e1cee1aaa9009d9` 都声明 `expectedMigrationVersion=255`，且迁移清单与 `migration.ts` 的字节在两提交之间相同。它们因此是 **255 迁移链源码候选**，不是已经验证的生产恢复镜像。恢复身份必须使用各自实际构建并推送的固定摘要镜像、完整八镜像集、渲染 Compose、受保护环境和真实运行时证据；两提交的制品及证据不可混用。

`deploy-verified-ecs-compose.sh` 的普通发布在 nonce 消费和迁移前要求 `rollbackTail === candidateTail` 且 `liveVersion === candidateTail`。因此，现有发布器对 255 候选要求数据库已经是 255；不能从 254 直接进入这条路径。将 capsule 的 `live_migration_version` 填成 255 而数据库仍是 254，会被受保护的实时观测拒绝。移除该检查也不安全：脚本先迁移共享数据库，再重建 API/worker，旧 254 运行时会在两者之间继续承载流量。

现有 `ECS_BRIDGE_CODE_ONLY` 特例只允许 242 数据库和 244 候选，且入口要求使用独立签名的 Bridge B 执行器。`verifyBridgeMigrationPrefix` 只接受 242/244 或 242/254，后者要求候选迁移清单恰好到 254。255 提交不能借用任一模式。受保护的预身份恢复控制对 Bridge B 也绑定旧 242 前缀。不要把 254→255 写成新的允许数值而沿用旧签名状态机。

### 101 真实拓扑快照（2026-09-28，只读）

`docker ps --format` 与 Docker Compose project/service 标签观察到：`merchant-production-api-replica-1` 和六个 `merchant-production-worker-{sync,generation,publish,reconcile,automation,scan}-1` 均没有 `com.docker.compose.project` 或 `com.docker.compose.service` 标签；API replica 显示 `unhealthy`。`merchant-production-postgres-1`、`merchant-production-redis-1` 有 `merchant-production` 标签。公网 `https://yxsona.com/api/releasez` 当时仍报告 `release-f48c8454-dual-e2e` / `f48c84544c519642de7c92615351007c9ac70a99`；公网 `/api/readyz` 返回 200 不能证明上述无标签 replica 已健康，也不能证明 255 候选已启动。执行前必须重查容器 ID、镜像 ID、标签、网络、挂载、网关 upstream 和数据库版本，不得沿用这份快照当执行输入。

这意味着先要完成独立的 **legacy→Compose 接管**：冻结每个旧无标签容器、共享数据库/Redis、外部 80/443 网关的实际身份与配置，核对旧镜像可恢复归档及服务 map；以受保护签名 journal 在独立 Compose project 中演练代码切换和失败恢复，再验证公网网关确实指向已接管的桥接 API、API 副本和 worker。`docker compose up` 不会把无标签容器原位收编。不能因容器名称类似服务名而认定属同一 Compose project，也不能让旧 worker 与桥接 worker 并行执行任务。旧 API replica 的 `unhealthy` 状态需先诊断并确定可恢复目标；若旧运行时本来不健康，回到旧监听不是成功回退。

## 最小可审过渡

首选单独发布 **254/255 双前缀兼容桥**：桥接 API、API 副本和所有六类 worker 必须在完整且校验过的 254 与 255 数据库前缀上均健康，并且在 254 时不得读写迁移 255 新表。桥接版本必须先以 254 数据库完成隔离部署、真实业务及本地 stdio ChatGPT 宿主验收，再成为公网当前身份。迁移期间只有这套经审核的桥接运行时处理流量；旧 254 镜像退出服务路径。桥接的 255 恢复镜像须在迁移前完成构建、固定摘要、隔离 255 数据库演练和恢复验收。

受保护部署/恢复控制随后需要一个 **独立的 254→255 转移模式**，在生产锁内绑定：当前桥接公网四字段身份、完整服务清单与容器 ID、255 候选身份、255 恢复目标身份、受保护 Compose/env/八镜像摘要、实际 254 历史前缀 SHA-256、预期 255 前缀 SHA-256、nonce 和一次性签名 journal。迁移前核对上述输入及恢复镜像在本机可用；迁移后先核对数据库从 1 到 255 的名称和校验和，再切流。任一失败按已冻结的 **255 兼容恢复目标**恢复业务；数据库和卷均不倒退。整个过程中绝不能重新启动不识别 255 的旧 API/worker。

受保护状态机至少区分以下可重放、签名绑定的阶段，且每次变更前后重新观察容器和数据库，不允许仅依赖调用方写入的阶段名：

| 阶段 | 进入前必须核验 | 失败时允许的恢复 |
| --- | --- | --- |
| `captured_254` | 公网桥接身份、完整 254 历史摘要、服务和网关实际拓扑、254 与 255 两份恢复目标均已审核 | 不变更服务或数据库 |
| `fenced_254` | 公网入口进入受保护维护/隔离路由；旧 API、API 副本和六 worker 已停止或无请求/任务入口；精确容器 ID 再核对 | 仅在数据库仍为 254 时恢复已验证的 254 运行时与路由 |
| `migrating_255` | 持有生产锁、一次性 nonce 已消费、旧 254 工作负载持续处于 fence 状态 | 禁止旧 254 镜像重启；保持 fence 并转向 255 恢复路径 |
| `verified_255` | DB 两个运行角色读取完整 1–255 链及前缀摘要；255 恢复镜像和 Compose/env/八镜像摘要仍一致 | 仅启动已审 255 恢复目标，数据库与卷保持前向 |
| `candidate_cutover` | 候选 API/worker/gateway 精确镜像与 Compose 归属、健康、发布四字段身份均正确；旧容器仍隔离 | 以签名 journal 恢复已审 255 目标，核对公网身份与业务 |
| `accepted_255` | 公网 `/readyz`、真实业务、账务/模型中转与本地 stdio ChatGPT 宿主证据均属于 255 候选 | 完成验收；后续故障走新的冻结恢复计划 |

现有 `ecs-preidentity-recovery.mjs` 的桥接 `bridge-begin` 明确要求数据库 242，`deploy-ecs-bridge-unlabeled.sh` 明确要求候选尾部 244；两者均没有上表 254→255 的签名状态或旧服务 fence 证明。受保护 helper 的安装摘要、私钥/公钥绑定和 nonce ledger 也必须随新状态机同步审核。只更改 `deploy-preflight-ecs.sh`、Compose 模式或 `deploy-verified-ecs-compose.sh` 的版本号无法建立上述保证。

若选择停机过渡而非双前缀桥，也必须有独立受保护的维护模式：先隔离公网写流量、停止并核验全部旧 API/worker、保存可恢复的入口/容器拓扑，再迁移并仅启动已验证的 255 恢复镜像；失败时保持流量隔离，直到 255 恢复目标真实健康。当前发布器、签名状态机和入口网关尚无经验证的该模式，不能用手工停止容器替代。

## 恢复目标与 capsule 必备验收

1. 从选定的**同一干净提交**完整构建六镜像，取得不可变 registry digest；加上经审核的 PostgreSQL 17 alpine 与 ClamAV digest 形成八镜像集。API 和 worker 镜像都需在容器内核对 1–255 SQL 清单及源码/发布标签。当前 cab 的本机 API 镜像不等于六镜像生产清单；`2c366e0a` 也没有因 Git 提交存在而自动具备镜像。
2. 在独立数据库分别重放生产 1–254 历史、迁移 255、按 merchant_app 与 merchant_ops 角色只读核对完整链与权限；对迁移 255 的新表执行租户隔离和写入用例。证明旧 254 镜像在 255 上失败关闭且无公网流量，证明桥接镜像在两前缀上通过真实 API/MCP、worker 及业务 canary。
3. 冻结最长 24 小时的 `ecs-compose-rollback-capsule`：`current` 为最终候选四字段身份，`target` 为已运行/可恢复的 255 桥接版本四字段身份及 Compose/env/八镜像摘要；`database` 为 `forward_only`、`schema_downgrade=false`、实时 `live_migration_version`、`target_migration_tail=255`，并绑定覆盖实际允许阶段的 254、255 前缀摘要；`volumes.preserve=true`。签名 journal 及受保护执行器必须重新读取该 capsule、数据库历史、容器和公网身份，不能只接受手填 JSON。
4. 在与 101 拓扑等价的隔离环境故障注入：迁移前、迁移写入后且切流前、部分服务切流后、网关切换后、后置 ChatGPT 宿主验收失败。每一阶段验证 255 恢复目标的完整 API/worker/网关身份、`/readyz`、商家与运营真实业务、数据库仍为 255、对象和卷保留、nonce 不复用，以及签名 journal 的终态。不能把旧 254 服务恢复监听视作成功回退。
5. 101 正式前再核对公网旧版本身份、Compose 归属、外部网关拓扑、受保护凭据和完整发布证据；正式切流后重新采集公网 `/releasez`、`/readyz`、业务及 ChatGPT 宿主场景。缺任一证据保持 NO-GO。

目前缺少双前缀桥接运行时、对应受保护 254→255 状态机和真实恢复演练。`cab31fd8` 或 `2c366e0a` 可作为进一步构建与审查 255 恢复制品的源码起点，均不能直接作为现网 254 普通发布的已批准恢复目标。
