# 101 demo 项目迁移 254 兼容桥安装设计（只读，NO-GO）

本文件记录 2026-09-28 对 101 的只读拓扑观察及独立受保护安装器所需的合同。它不是上线授权或执行步骤。当前没有经过验证的 demo 项目 254 桥接安装器、签名恢复 capsule 或故障演练；不得用现有 Bridge B 的 242 常数替换成 254，也不得直接运行普通发布器完成 254→255。

## 真实边界

- 公网 `yxsona.com` 的 80/443 由 Compose project `merchant-demo-85575f9c` 中的 `pilot-gateway` 持有。Nginx 使用 Docker DNS `127.0.0.11`，API upstream 是同项目的 `api-replica:8787`，商家 UI、运营 UI 和支付 upstream 分别是 `ui:8080`、`ops-ui:8080`、`payment-gateway:8790`。容器地址会变，验证应依据服务名和公网响应，不能固定旧 IP。
- 2026-09-28T12:44:48Z 的最新只读逐容器采样显示公网 API 与 API replica 已为 `release-bb417660-demo-api` / `bb417660402c341df1b0d1debd5778f8b963c568`，两者镜像均为 `storenova/merchant-api@sha256:ab65ea9dd3a97fbeba011eb2f2edae7d65b9aea5bb53efd634aeb3c7efdf9151`；公网 `/api/releasez` 同时返回 release ID `release-demo-manual-import-20260928`、同一 Git SHA、manifest `f28180720e4f3b4c4d7698987b487b61aa76c7808ba1c6092b81ae3dc9cf7043`、image-set `sha256:9512e0b347f1a558cc7bba5ecbf7d20676f3276397b669b36a5b457fc1e490a3`。
- 同次采样仍显示服务版本混杂：商家 UI 为 `release-f48c8454-dual-e2e` / `f48c84544c519642de7c92615351007c9ac70a99`；Ops UI 为 `release-fccee758-demo-ops` / `fccee75805ce2d5ed066f4c18475e6467dfe9e5f`；五个 demo worker 均为 `release-ffcda399` / `ffcda3996bcf1821fd2ab619c31a840dd5ee6eff`；支付网关为 `release-0fa18b78-review` / `0fa18b78a65de8c5b07f09488f416a6ed08bfe08`；pilot gateway 为 `release-3567df1e2894-image` / `3567df1e2894aaf45974464f2ecad50b187971ab`。所有 11 个服务当时均为 running，但 running/health 不能证明跨服务发布一致性。
- API 的 `bb417660` 更新只包含手工店铺导入的运维角色 ACL 改动；相同一行补丁已在 `main` 的 `72754581` 中，无需从 `bb417660` 倒灌。此前历史快照中的 `f48c8454` API、`a00cf9a5` Ops UI 身份已过时。PostgreSQL 16.15 / 迁移尾 254 与数据卷信息来自先前只读快照，未在上述 12:44 采样中重新查询；正式动作前仍须实时复核数据库、端口、网络、卷和完整容器 ID。
- demo project 当前运行 `worker-sync`、`worker-generation`、`worker-publish`、`worker-reconcile`、`worker-automation`，没有 demo `worker-scan`。主机上另有 `merchant-production-worker-scan-1`；在证明其数据库、队列、网络和任务归属之前，不能把它当成 demo worker，也不能假定没有并发扫描消费者。
- `merchant-production` 是另一个历史项目，其无标签/不健康旧容器不代表当前公网 demo 工作负载。安装器必须以实时公网 release identity、网关端口拥有者、Compose 标签和网关 upstream 一起判定目标项目。

## 安装前冻结的输入与证据

当前源码有纯只读的 `infra/protected/demo-254-old-runtime-capsule.mjs` 组合旧运行时合同（schema v2），覆盖公网 demo 项目的 API、副本、五个 worker、网关、两套 UI、支付、Postgres、Redis，以及项目外共享消费者。它逐项约束不可变镜像引用、真实容器 ID、Compose/env 摘要、254 备份 capture 摘要、最多 24 小时有效期、保卷前向恢复，并要求 runtime archive SHA/字节数绑定旧 API、worker、pilot gateway 三个实际 image ID。此字段只是签名 capsule 的必要输入合同，尚没有独立主机采集器证明 archive 字节；**形状审查即使通过也始终返回 `deployable=false`**。截至 2026-09-28，尚无从 101 独立采集全部受保护文件、签名该组合 capsule、恢复七服务并完成故障演练的固定摘要宿主控制；不能把现有签名数据库备份当作运行时恢复 capsule。

101 当次只读重算也发现原件与现行容器标签的 Compose 服务配置 SHA 不一致：`pilot-gateway` 标签为 `ba7db8168f2bb8495a348038f41678ed8c3d8295af6f853193c86489be0467ea`，以其受保护 Compose 和 `candidate.local-stdio.env` 重算为 `6813fbb851b021b30f44e2b912ea9675ba84c025958bbf8477bb0ce5ece909d4`；`api` 标签为 `d2c08c7b91852f939142a4b3a46993d7bec06ce0e94b4fb21b8c637198fda16a`，重算为 `d506f0fd2cc8f85400377404cf238accae1efbe9cc1db53a9236e762fda0c6bc`；`worker-sync` 标签为 `d8af08cd2350b5a9dc19917f1fca91ac2125d2c78d48219dc4dceb97b286131d`，重算为 `ee8d236e468d5d79ea6ad48220cdecf68fe0b9500566108b179762b695619360`。在查清历史 Docker Compose 版本、环境插值及受保护原件是否变化并完成实际恢复演练之前，这些原件不能被签为可恢复的旧组合。

1. 从同一干净候选提交冻结 release ID、Git SHA、源码归档 SHA、manifest SHA、完整八镜像集摘要及各服务不可变镜像引用；候选 API/replica 与五 worker 必须已在独立 PG16 迁移 254 和 255 的恢复库上通过真实健康、MCP、租户/RLS、任务及收费路径，且 254 时不得访问迁移 255 新表。`RUN_MIGRATIONS_ON_STARTUP=false`，桥安装过程不得选择 `migrate` 服务。
2. 在持有同一生产部署锁时，重新读取公网 `/releasez` 四字段、`/livez`、`/readyz`；数据库 `merchant_app`、`merchant_ops` 角色各自读取完整 1–254 版本/名称/SQL SHA 链、无效索引和角色/RLS 状态，两个历史摘要须相同。记录 PG16 server version、数据库身份与卷 ID。不得依靠单个 `max(version)`。
3. 冻结七个被替换的服务（API、replica、五 worker）各自容器 ID、image ID、仓库 digest、Compose project/service/config hash、网络别名、挂载及健康状态；并冻结未替换的网关、两个 UI、支付、PG、Redis 和主机上可能访问同一 DB/队列的 worker 的完整 inventory。若服务增加、失联或身份漂移，捕获失败。
4. 审核并冻结候选 Compose/env/镜像摘要和一份**组合旧运行时恢复 capsule**。后者必须由 API 的 `f48c8454` 与 worker 的 `ffcda399` 受保护原件、实时 Docker inspect、以及网关/UI/支付/数据服务的现状逐项比对生成，保留不同服务的真实旧镜像和配置。单独拿任何一个历史 Compose 文件、容器名或可变 tag 都不足以恢复。所有输入 root 持有、私有权限、不可为符号链接；env 仅保存 SHA 和受保护路径，不进入日志、仓库或签名正文。
5. 恢复 capsule 绑定旧公网四字段身份、七服务与未管理服务 inventory、旧镜像 ID/仓库 digest、Compose/env SHA、固定 project/network/volume、数据库精确 254 历史摘要、`forward_only`、`schema_downgrade=false`、`volumes.preserve=true` 和短期有效期。旧 API/worker 必须在真实 254 数据库上验证可恢复，恢复后公网业务也必须正常。

## 独立受保护状态机

新安装器须有独立名称、固定已审核程序 SHA、受保护密钥与 journal 命名空间；它可以复用 Bridge B 的受保护路径验证、固定进程/FD 9 锁、Ed25519 签名及原子 journal、一次性 nonce owner 绑定、Compose/image digest 校验和数据库双角色观测原语，但不能重用 Bridge B 只接受 242 的状态及其旧 `merchant-production` 假设。每一步先重新观察实时容器、数据库和公网四字段，并将观察摘要与操作结果写入签名 journal。独立 `bridge-demo-254` nonce owner 需要受审消费者和持久账本合同；不得借用 `bridge-b` 或普通 deploy 的已消费 nonce。

| 阶段 | 准入证据 | 允许的动作及失败恢复 |
| --- | --- | --- |
| `captured_254` | 旧公网身份、完整 254 历史、所有服务/端口/网络/卷、候选及旧组合 capsule 签名一致 | 只读；失败保持现网。 |
| `nonce_consumed_254` | 同一 attempt 的 nonce 在持久账本中有精确 operation/身份 owner，锁仍持有，基线未漂移 | 尚未改运行时；崩溃只能由同 attempt 重放，不能换 nonce。 |
| `runtime_mutation_started` | 新旧镜像本机可用；gateway 仍将 API 指向本 project 的 `api-replica`；DB 仍 254 | 仅对冻结的七服务执行无构建、无拉取、无依赖、无迁移的 Compose 替换。worker 应有经验证的暂停/排空和防并发计划，先核对其他扫描消费者；不能让旧、新同角色同时处理队列。任何中途失败仅用旧组合 capsule 在 254 数据库恢复七服务，保留网关、数据和卷。 |
| `bridge_runtime_verified_254` | 七服务全为桥镜像/目标 release 标签且健康；网关 upstream 实际命中桥 replica；公网 `/releasez` 四字段为桥身份；DB 双角色链仍精确 254；业务/MCP/worker canary 通过 | 验收失败进入签名恢复阶段；不得声称 UI 或网关容器本身已换版。 |
| `recovery_started_254` | 当前候选或部分替换容器均能由签名 journal 解释，旧组合 capsule 未变，DB 仍精确 254 | 仅恢复冻结的旧七服务，不能迁移或回退数据库；遇到未知容器/漂移停下人工处置。 |
| `recovery_verified_254` | 旧七服务镜像/配置/健康、网关路由、公网旧四字段、254 历史和业务 canary 均与捕获目标一致 | 保留 journal、日志、卷和凭据，记录失败结论。 |

桥安装后进入迁移 255 应使用另一套独立的受保护 254→255 状态机：先证明桥 API/全部 worker 在 254/255 双前缀兼容，再冻结 255 可恢复镜像、fence 旧工作负载、执行前向迁移并验收。现有普通发布器要求 live/rollback/candidate 尾号已相等；当前 live 254 无法直接发布 255。PG17 是发布用一次性迁移客户端及隔离恢复目标，现网 PostgreSQL 服务仍为 PG16；本桥安装不升级数据库主版本。

## 隔离演练与故障注入门槛

在与 101 等价的独立 Compose project、PG16 254 恢复快照和相同网关 DNS/证书路由上，先演练完整正常安装与旧组合 capsule 恢复。至少注入：捕获后容器/Compose/env/镜像漂移；nonce 已消费但 journal 尚未推进；首个 worker 替换后失败；API 已换而 replica 未换；replica 已换而 Nginx DNS/公网仍命中旧实例；worker 排空超时或发现另一消费者；公网身份/业务 canary 失败；恢复过程中旧镜像不可用或数据库历史已变。每次都要证明锁、签名 journal、nonce、防重复任务、旧版 254 恢复以及公网业务真实结果。数据库一旦到 255，禁止走本 254 恢复路径。

完成隔离演练后仍须重新生成并审核 101 当次实时身份、签名发布证据、备份与恢复证据、部署锁/密钥/nonce 安装状态和批准的维护窗口。任何缺项均保持 **NO-GO**。
