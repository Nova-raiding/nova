# 101 单一常驻环境退役手册

## 目标与边界

当前只有一个常驻应用环境的需求：保留 `merchant-demo-85575f9c` 作为 prelaunch 环境，退役 `101` 上其余长期运行或残留的应用/数据库环境。`merchant-demo-85575f9c` 当前持有 `yxsona.com` 的 80/443；清理不得停止或重建其 gateway、API、UI、worker、Postgres、Redis、素材卷或 payment gateway。

本手册只供本次按清单分批执行。它不是自动清理器，也不授权推断式删除。日常开发使用开发机；迁移恢复、review sidecar 和候选验收只在隔离 runner 短期运行，完成后回收。Docker Registry `storenova-registry` 是共享构建基础设施，不是应用环境，保留。

禁止：`docker compose down -v`、`docker system prune`、按名前缀批量删除、手工改写 `schema_migrations`、跳过队列核验、在同一次清理中执行数据库迁移，以及删除任何未经核验的卷或备份。

## 当前已知目标与现场基线

2026-09-29 只读核验发现：

| 对象 | 连接/数据边界 | 已观测迁移版本 | 处理方向 |
| --- | --- | ---: | --- |
| `merchant-demo-85575f9c` | 公网 80/443；自己的 Postgres、Redis、素材卷和 5 个 worker | 254/254 | 保留 |
| `merchant-production` | 独立网络、Postgres/Redis；6 个旧 worker 无 Compose project 标签 | 242/242 | 依赖和队列核验、备份后退役 |
| `local` | loopback API/DB/Redis；独立素材卷；6 个无标签 worker | 233/233 | 依赖和队列核验、备份后退役 |
| `merchant-demo-cd7ops` | 独立 Postgres/Redis 和 API | 255/255 | 备份后退役 |
| `merchant-ops-review-cd7` | review UI/gateway；gateway 绑定 loopback 18445；与 cd7ops 共用 network | 不适用 | 证据归档后退役 |
| `merchant_restore_acceptance_pg_bee3` | 独立恢复验收 Postgres volume；本次默认角色查询失败 | 未确认 | 先识别验收用途并做物理归档/恢复核验，再退役 |
| 停止状态的历史 projects | 多个旧 Postgres/Redis volumes，部分归属不明 | 未确认 | 逐卷映射、归档和恢复核验后再清理 |

同一 Postgres image ID 被多个项目复用不代表共享数据库；应按容器挂载的 volume 和网络身份区分。部分旧服务没有 Compose 标签。`node infra/scripts/ecs-demo-254-host-inventory.mjs` 是只读库存工具。schema v2 仅在容器 ID/名称、精确 image ID、运行状态、完整 bridge 网络投影、loopback 5000 端口、专属 registry volume、无 Compose 标签以及 Env/Config/HostConfig/Mounts 摘要全部吻合时，将 `storenova-registry` 分类为 `shared_build_infrastructure`；它仍会出现在清单中，并带有 registry 客户端策略待审核警告。任何不匹配的 demo 外容器仍列为 `unclassified_external_consumer` 并阻断库存审查。该分类只说明已知基础设施归属，不授权删除或批准发布；其余外部容器须在现场逐项处置。

另有两个现场交叉 attachment：`local-clamav-1` 同时在 `local_default` 和 `merchant-production_default`，`local-ops-ui-1` 同时在 `local_default` 和 `storenova-demo-e0`；`merchant-ops-review-cd7` 的两个容器在 `merchant-demo-cd7ops_private`。必须先停掉依赖端，再移除交叉容器/network，不能按 project 一次性拆网。

## 强制门禁

每个待退役批次都必须单独记录操作者、时间、完整 container ID、image ID、project/service 标签、network ID、挂载卷、数据库身份/版本、队列状态及归档校验和。执行前取得现有 ECS deploy/rollback 使用的同一把宿主发布锁；锁路径从受保护配置读取，不在仓库或日志中记录凭据。

以下任一条件不满足，停止该批，不影响已确认保留的 demo：

1. 容器、卷、网络、域名监听关系无法准确归属，尤其无 Compose 标签的 worker。
2. 尚未暂停该环境的任务入口和 producer；或未记录 Redis ready/processing/delayed 计数、Postgres outbox lease/unknown 与 durable job 状态。
3. 数据库 dump、素材归档或 Redis/队列归档不完整；摘要校验失败。
4. 数据库备份不能在隔离实例恢复并通过 schema/关键表核验。
5. 临时恢复实例与公网/保留网络存在连通，或恢复验收用途/证据归属不清楚。
6. 归档目标不在受保护目录、剩余磁盘空间不足，或归档仅存在于将被删除的数据卷内。
7. 公网 `/releasez`、API `/healthz`/`/readyz`、Ops `/healthz` 或保留项目身份在本批执行前后发生意外变化。

## 分批执行顺序

### 0. 捕获库存与守护保留项目

1. 读取 `docker ps -a`、完整 `docker inspect` 投影、`docker volume ls/inspect`、`docker network ls/inspect` 和端口监听；敏感环境值只计算摘要，不打印。
2. 运行只读库存脚本并保存原始 JSON 到受保护审计目录；记录公网 `/releasez` 和三个健康探针。
3. 断言保留项目所有 13 个预期服务各恰好一个、均运行，且 `pilot-gateway` 仍占用 80/443；登记保留项目卷与 Registry 卷，建立显式 deny-list。
4. 枚举**所有**连到待退役 network、共享 Redis/DB endpoint、持有宿主端口或挂载候选数据卷的容器，包括停止容器和无标签容器；任一未知依赖即停止。

### 1. 按环境制作可恢复归档

对每个有数据库的环境分别执行，不跨库合并：

1. 暂停该环境所有写入口、调度器和 job producer；在变更记录中确认其业务 owner/QA 测试已停止。
2. 按实际 `POSTGRES_USER`/`POSTGRES_DB` 从容器内运行 custom-format `pg_dump`，不读取或输出密码；校验文件非空、SHA-256，并运行 `pg_restore --list`。
3. 在隔离、无公网端口、与保留项目网络不相连的同主版本 PostgreSQL 中实际恢复。校验迁移历史连续性、schema 版本、核心表数量/参照关系及应用只读连接；保存恢复日志和摘要。
4. 对已确认需要保留的素材卷做一致性归档并校验文件数/总字节/摘要。若数据库引用对象存储而非该卷，按其真实存储位置另行归档。数据库与素材归档需记录为同一批次。
5. Redis 队列必须先排空并通过应用可读的队列状态确认；不能证明队列为空时，不以 Redis 快照代替排空。之后记录 Redis 数据用途，按归档计划保存需要的数据。
6. 归档写入受保护且独立于被退役卷的目标，权限最小化。保留恢复证据、操作者、时间和校验和；禁止把数据库 dump、素材、env 或密钥提交 Git。

现场只读队列快照显示：`merchant-production` 有 64 条未发布 outbox 和 1 条 unknown，`local` 有 63 条未发布 outbox 和 1 条 unknown；两者当时均无有效数据库 lease，Redis RDB 分别为 783/797 字节。`merchant-demo-cd7ops` 这几项均为 0。未发布/unknown 任务不得重放、清空或宣称完成；它们必须随经过恢复验证的数据库/Redis 归档保留，并在审计记录中标为冻结的 prelaunch 数据。停止 workers 前须先停 producer；之后再次读取 lease 与 Redis ready/processing/delayed 状态。只要仍有 active lease、Redis 队列项或未知消费者，就停止该批。

优先批次：`merchant-demo-cd7ops` 和 `merchant-ops-review-cd7`（先确认无 review 会话）；随后 `local`；再处理无标签的 `merchant-production` 旧 worker、应用与数据库；最后处理恢复验收容器和停止状态历史 volumes。恢复验收环境必须保留其恢复证据后才可退役。

### 2. 安全停止并移除已归档环境

每个批次重新核对实时 ID 与库存快照：

1. 阻止新增任务，确认队列达到批准的空闲条件。
2. 对该批**精确列出的 worker 完整 ID**发送正常停止信号，等待退出；不得按 `worker-*` 名称或 image ID 批量操作。
3. 停止该环境的 API/UI/gateway/producer，再停止 Redis 和 Postgres。确认容器停止后才解除其网络 attachment。
4. 复查 demo `/releasez`、健康探针、保留项目容器 ID/image ID/volume ID 未变化。
5. 首轮仅移除经审核的已停止容器和已确认无依赖的环境专属 network；不带 `-v`。把 data volume 留在原处，直至该批的恢复核验签字完成。
6. 对签字确认的待删除数据卷，按完整 volume ID/名称逐个核对 deny-list、备份摘要和恢复证据，再单独删除；任何不匹配即停止。保留卷不能与活跃 demo/Registry/受保护证据卷混淆。

容器停止后意外重启、发现队列积压、数据库 dump/恢复错误或公网健康变化时：停止后续步骤，保留容器/卷/网络和日志；按该批恢复记录重新启动原容器，不执行自动 `down`/`prune`。

## 完成验收

清理全部目标后，重新获取现场库存并要求：

- 运行的应用服务只有 `merchant-demo-85575f9c` 的预期 13 个服务；`storenova-registry` 作为共享基础设施保留。
- 80/443 仍只由保留 demo gateway 持有；公网 `/releasez` 身份正确，API 与 Ops 健康探针正常。
- 没有其他项目的活动 worker/API、遗留 sidecar、未知网络 attachment 或候选/恢复容器。
- 保留 demo 的 Postgres/Redis/素材卷 ID 与清理前相同；迁移版本保持原状，本次退役未迁移数据库。
- 所有退役数据都有经过恢复验证的归档和摘要；卷的删除逐项有审计记录。
- 清理前后 inventories、备份/恢复记录、探针结果和逐项执行结果归档到受保护证据根。

## 本次执行记录（2026-09-29）

- 按上述边界保留 `merchant-demo-85575f9c` 和共享 `storenova-registry`；所有其他已盘点的应用/恢复容器、零 attachment 网络及非保留数据卷均已停止并移除。未使用 `down -v`、全局 prune 或迁移数据库。
- 受保护归档位于 `101:/var/lib/merchant-release-security/retired-environments/20260929T1434Z`，权限为 `0700`；dump、Redis 快照及卷包权限为 `0600`。归档位于同一台主机，不是异地灾备。
- `merchant-production`、`local`、`merchant-demo-cd7ops` 的最终数据库 dump 已用对应 PostgreSQL 主版本在隔离实例中恢复验证，schema 版本分别为 242、233、255；workspace 数分别为 3、2、0。恢复验收数据卷按原 PG17 主版本从归档恢复并确认 PostgreSQL 启动、SQL 可读（`server_version_num=170011`）。临时恢复容器和卷已删除。
- 39 个数据卷 tar 包及 3 个最终 Redis RDB 快照的 SHA-256 校验通过。卷包中额外包含了部分保留 demo 卷副本；原 demo 卷未删除或重建。
- 停止入口后仍有 frozen prelaunch 记录：production 64 条未发布 outbox + 1 条 unknown；local 63 条未发布 outbox + 1 条 unknown。它们随数据库 dump 保存，未清空、重放或标记完成。
- 清理后 101 上仅保留 demo 的 13 个运行容器和 `storenova-registry`；Docker 卷仅剩 demo 的 PostgreSQL、Redis、素材卷与 registry 数据卷。未挂载的旧 ClamAV 卷已先校验归档再删除。`https://yxsona.com/releasez`、`https://yxsona.com/api/healthz`、`https://ops.yxsona.com/healthz` 清理前后均返回 ready/ok，release ID 为 `release-demo-product-code-20260929`。
- 最终证据清单、卷摘要、Redis 摘要、清理后脱敏健康探针（`post-cleanup-health.json`）和逐项容器/网络计划保存在上述受保护归档目录。后续如需灾难恢复，应先将归档复制到独立存储并验证，再按原 PostgreSQL 主版本恢复。
- 同日磁盘收尾在发布、demo compose 和构建锁均成功非阻塞获取后，先清理超过 24 小时的可回收 BuildKit 缓存（报告释放 828.4 MB），再按当前 `/releasez` 对应的完整六组件 manifest 精确保留应用镜像，并保留 PostgreSQL 16、Redis 7 和 Registry 基础镜像；本地镜像由 143 个 ID 减到 9 个。之后按精确 digest 清理 Registry 的 496 个旧 manifest revision，保留当前完整六组件发布 `release-demo-product-code-20260929`（`image_set_digest=sha256:019981e3c4932d1b619021c3912d569c86bd42d870446e1fc0e054bccc50f6f6`）。Registry 仍有 17 个 catalog 名称，但仅 6 个仓库有 tag、共 6 个受保护发布 tag；旧 manifest 候选均返回 404，六个保留 manifest 均返回 200。Registry 停止维护期间执行 GC，预演确认 2,718 个无引用 blob 可回收，registry 数据卷从约 8.6 GB 降至 378 MB，根盘由 45 GB 已用/50 GB 可用（48%）降至 37 GB 已用/58 GB 可用（39%）。本地镜像和 Registry 计划、删除日志、GC 预演及执行日志均保存在上述受保护归档目录。原 `storenova-registry` 配置已恢复（删除功能仍关闭），13 个 demo 容器、Registry、releasez 和三项线上健康探针正常。

## 明确不在本次范围

- 将 demo 数据库从 254 迁移到候选 255，或升级 PostgreSQL 主版本。
- 将 demo 当成已通过正式发布门禁的 production。
- 删除保留项目、Registry、生产密钥、发布信任根、部署证据、备份或所有 Docker 镜像。
- 删除仓库中的 Compose 文件/测试夹具；文件模板不是 `101` 上的常驻运行环境。
- 编写通用清理器、定时任务或新增长期 staging 环境。
