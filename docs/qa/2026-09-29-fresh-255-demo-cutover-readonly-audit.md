# 独立 255 演示库与切流可行性：只读审计

审计日期：2026-09-29。当前源码 `main` 的 `release-metadata.json` 要求迁移尾号 255。本审计只阅读仓库并运行 `npm run deploy:101:status`；没有创建数据库、容器、候选、账号或路由，没有部署或迁移。公网状态采样时间是 `2026-09-29T10:07:53.996Z`，再次执行前必须重新观察。

## 结论与“不迁移”的边界

1. **不修改现有公网 PG16/254 数据库**：可以在 101 上另建全新 PG17/255 的隔离候选作预生产验证。现成的 `infra/scripts/render-ecs-demo-candidate.mjs` 提供独立 Compose 项目、网络、卷、Redis、数据库角色和一次性 1–255 迁移任务；`docs/runbooks/ecs-merchant-browser-isolated-candidate.md` 给出从冻结镜像到浏览器验证的流程。旧数据库、现有账号与业务数据不会自动进入新库。
2. **任何数据库都不得执行 schema 初始化或迁移**：上述方案也不符合此解释。全新空库必须执行 1–255 的建表/迁移，才能运行当前候选。即使从旧库备份恢复到副本，再只在副本执行 255，也属于对副本迁移；`docs/runbooks/ecs-bridge-255-isolated-preview.md` 已证明这种预演的结果明确为 `production_deploy_authorized=false`。
3. **完整 255 功能对公网用户可用并全部测试通过**：现成隔离候选不能直接完成。它关闭插件写入、没有 worker、运营界面、支付或完整网关，不承载生产流量；独立库又没有旧商家账号、工作区、订单、权益、创意点、素材和任务。当前没有可复用的、经审查的“全新 255 库替换公网 254 库并保持业务连续性”执行器和恢复胶囊。不能把隔离候选通过改写成上线成功。

## 当前真实状态与已有候选能力

只读 `deploy:101:status` 本次返回公网 `merchant-demo-85575f9c` 的 `/releasez`、API `/readyz`、运营 `/healthz` 均 HTTP 200，13 个被列出的容器运行且健康，但源码版本混杂，`release_approved=false`。API 两副本是 `fd1ad6a7…`，商家 UI 是 `f48c8454…`，五个 worker 是 `ffcda399…`。状态命令未重新查询数据库迁移历史；此前独立只读 SQL 记录公网库为连续 `254|254`，见 `docs/qa/evidence/2026-09-29-chatgpt-app/20260929-no-migration-release-audit.md`。执行时仍须复核数据库身份、版本、名称和 SQL 校验和。

现成候选渲染器的强制边界：

| 能力 | 实际约束 |
| --- | --- |
| 隔离持久化 | 只接受新 project 的 PostgreSQL、Redis 卷和私有网络；运行角色 URL 必须指向候选 `postgres`，无宿主端口；使用固定摘要的 PG17/Redis 镜像。 |
| 源码与镜像身份 | 需要干净、冻结的 Git 归档、候选身份、不可变镜像引用、受保护 root-only 环境；迁移文件逐一与归档字节相等。 |
| 数据库准备 | 一次性 `migrate` 服务执行候选完整迁移链，当前目标 255；这仅发生在新候选库。 |
| 应用服务 | 仅 `api`，可选 `ui`；没有 worker、Ops UI、支付、正式入口网关。 |
| 写入和外部访问 | `PLUGIN_WRITE_ENABLED=false`；素材前缀按候选 release 隔离；没有公网端口，商家浏览器通过绑定准确容器 ID 的桌面 SSH 隧道访问。 |
| 证明范围 | `attest-ecs-demo-isolated-runtime.mjs` 标为 review-only；API 活性、独立 255 迁移和浏览器用户管理只证明隔离候选，不构成生产切流批准。 |

相关代码：`infra/scripts/render-ecs-demo-candidate.mjs` 的 `validateDemoCompose`、`render`；`infra/scripts/attest-ecs-demo-isolated-runtime.mjs`；`docs/runbooks/ecs-merchant-browser-isolated-candidate.md`。此候选要求从受保护环境提供 `MODEL_RELAY_API_KEY`，渲染器会拒绝占位格式；密钥是否真的可鉴权仍需运行时回执证明。密钥不可写入仓库、聊天或日志。

## 全新库生产切流尚缺的具体闭环

最短可执行的**预生产**路径是：冻结干净提交与镜像摘要 → 按现成渲染器建立独立 255 候选 → 运行真实迁移及隔离 attester → 用新建的候选测试账号和工作区，经私有隧道验商家页面/租户/RLS/API。全过程保留公网 254 原状；绝不将候选 URL 冒充公网生产 URL。执行前检查 101 磁盘、Docker 镜像、受保护目录和中转凭据。失败时只停止准确候选容器，保留卷与证据供调查，不清理公网卷。

要把这条路径扩展为**完整生产部署**，至少还需冻结并验证以下状态，不能只改 DNS 或替换 gateway upstream：

1. **完整服务拓扑与凭据**：同一不可变 release 的 API 双副本、五类 worker、商家与运营 UI、支付、HTTPS gateway，以及各自受保护环境；模型中转真实鉴权、回执、用量和成本；对象存储及扫描、支付、平台回调地址。候选目前无 worker，无法证明队列领取、任务结算与发布工作流。
2. **账号与数据去向**：决定旧 PG16/254 的用户、工作区、店铺、商品、订单、已付权益/创意点账本、素材引用、对象字节、任务、审计和邀请如何进入 255 新库。空库测试账号不能替代 `demo@sn.com` 或现有业务工作区；旧库备份恢复并升级副本虽然保留旧库原样，仍须验证备份新鲜度、完整性、序列/RLS/外键及迁移后所有旧数据。旧库从复制点以后继续写入时，需要经审核的增量同步或短暂停写、排空与最终差异核对方案。
3. **流量和消费者切换**：旧、新 worker 与队列/外部消费者不能并发重复消费；新 gateway 路由、登录会话、MCP token、回调和对象存储前缀应绑定同一数据代次。公网 80/443 的接管、健康及真实 ChatGPT 桌面宿主验证需在精确容器身份和受保护发布锁下执行。
4. **失败恢复**：切流前保留旧库、旧卷、旧镜像、旧 Compose/env、网关配置、受保护签名身份和独立恢复胶囊，并在等价拓扑演练切流前/后失败。如果新库接受业务写入，直接路由回旧库会丢掉新写入；需明确写入冻结、双写/重放或人工对账及可接受的恢复点。不可通过删除新库、降级 schema 或复用旧密码来制造回滚通过。
5. **发布门禁与权限**：生产发布还需要当前 release 的签名证据、一次性 nonce、恢复证明、模型/支付/对象存储/ChatGPT host canary、租户/RLS、容器 digest 与公网 `/releasez` 四字段一致性。受保护 root-only 资料和授权操作者必须实际可用；隔离 attester 的 `review-only` 结果不能升级为签名的生产批准。

现行 `deploy-verified-ecs-compose.sh` 要求普通发布的 `liveVersion === rollbackTail === candidateTail`。公网 254 对当前 255 候选不满足该前提；详见 `docs/runbooks/ecs-254-255-forward-recovery.md` 和 `docs/runbooks/ecs-candidate-safe-sync.md`。新库方案会绕开“同库 254→255”的技术阻断，但引入**跨库业务连续性和恢复**问题；仓库现有隔离候选脚本故意不提供公网切流。若用户坚持完整 255 上线，同时坚持绝不修改旧库，必须先完成新库生产拓扑、数据/账号迁移策略、签名切流和故障恢复实测；现在的判断仍是 **NO-GO**。
