# Pre-Mortem：发布功能对账（2026-08-29）

## 范围与假设

假设项目在 14 天内尝试生产发布，并在发布后因证据不足、权限穿透或运维不可恢复而失败。本审计只依据当前源码、契约、迁移与文档；本地测试、fixture、示例 evidence 和历史浏览器结果不替代同一正式 release 的生产证明。

当前事实基线为 217 个唯一 MCP 方法/契约、商家 bridge 147 个工具、12 个 Ops 一级域和 78 个 PostgreSQL 迁移。图片局部编辑、品牌授权过滤、独立 Ops DB role、并发索引迁移、canonical/listing 完整性、发布作用域及后到达素材绑定触发器已在本地实现；总体发布结论仍为 **NO-GO**。权威计数见仓库根目录 `release-metadata.json`。

## Tigers（真实风险）

| 风险 | 紧急度 | 证据 | 缓解措施 |
|---|---|---|---|
| 六平台、支付、云存储/KMS/PITR、容量/长稳和告警值守没有正式 release 外部证据 | Launch-blocking | 本地 fixture、合同与 canary runner 存在，但真实凭据/控制面回执缺失 | 由平台、财务、SRE、安全分别提供签名 artifact，统一绑定正式 release 后再开写流量 |
| 新增 12 域 Ops 与图片局部编辑沿用旧浏览器数字会形成假绿 | Launch-blocking | 当前 92 场景已完成单命令回归并全部通过，但真实 OIDC/宿主与生产证据仍缺 | 保留当前 92 场景证据，并补真实 OIDC、生产规模、局部编辑宿主矩阵，生成新 release evidence |
| 品牌隔离被误写成数据库品牌 RLS | Launch-blocking | 当前数据库 RLS 是 workspace 级；品牌授权由 API/仓储执行 | 保留 API 越权探针、仓储过滤测试和直连角色 ACL 验证；安全评审决定是否需要 actor-aware DB policy |
| 在线索引迁移被误认为零影响 | Fast-follow（放量前必须观测） | 060/062 使用 CONCURRENTLY，但仍可能产生锁等待、WAL 与副本延迟 | 在生产规模预生产库演练，记录时长、锁、无效索引恢复与副本延迟阈值 |

## Paper Tigers（表面担忧）

- “MCP 工具多于 200 就不能发布”：工具数量本身不是 blocker；真正风险是发现性、角色暴露、契约一致性与关键路径验收。217/217 唯一契约已消除纯数量漂移，但不替代生产行为证明。
- “CONCURRENTLY 完全不能用于版本化迁移”：可以使用，当前 runner 已支持非事务迁移和 session advisory lock；需要的是大表演练与失败恢复，而不是退回阻塞式建索引。
- “独立 Ops DB role 必须使用独立数据库实例”：当前需求是凭据和 ACL 隔离，不必为了名义隔离立即拆物理实例；是否拆实例应由威胁模型、审计与连接预算决定。

## Elephants（未充分讨论）

- 品牌权限依赖 API/仓储，而 Worker、导出、未来新路由可能绕过统一 helper；需要持续的入口清单和 deny-by-default 契约。
- 部署脚本已用 `/releasez` 和认证数据库业务路径证明请求穿过已部署 API，并在 rollout 后执行六平台签名 canary；但在真实集群、身份、网络策略和 Worker 上完成一次正式 release 演练前，仍不能把代码合同当作生产证明。
- 文档存在大量按日期追加的旧“当前”数字；若没有单一权威状态页，发布评审容易引用历史快照。
- 外部签署人、证据保留期、撤销/轮换流程和事故时谁有权关闭写 feature flag 尚需组织确认。

## Launch-blocking 行动计划

| 风险 | Owner | 完成日期 | 完成定义 |
|---|---|---|---|
| 六平台/支付/云/容量正式证据 | Platform、Finance、SRE | 发布日前 | 全部 artifact 绑定同一 release、Git、manifest 和 image-set，并由组织签署 |
| 新增 UI/角色矩阵 | QA + Design + Ops | 2026-09-01 | 12 域、图片局部编辑、真实 OIDC、移动端和失败恢复形成新浏览器证据 |
| 品牌隔离安全验收 | Security + Backend | 2026-08-31 | MCP/REST/导出/Worker 越权矩阵通过，并记录是否升级 DB policy 的决定 |

在所有 Launch-blocking Tiger 关闭前，发布结论保持 **NO-GO**。

## 已由代码关闭、待生产演练的原风险

| 原风险 | 当前代码状态 | 仍需外部完成 |
|---|---|---|
| capability 正式签名 preflight | `deploy-preflight.sh` 已强制 `--require-signed-production`，绑定 release/image-set/manifest/Git/nonce；部署后再次验证签名 canary | 在正式 release 上由受保护 attester 生成真实签名 evidence，并保留正反门禁记录 |
| 固定 trust/nonce 控制面 | trust 固定为 `/run/release-security/evidence-trust`，nonce consumer 固定为 `/usr/local/libexec/merchant/consume-production-evidence-nonce`；校验 owner、mode、父链、指纹、摘要和非符号链接 | 配置 root 管理的只读 mount 与跨 runner 原子 nonce store，完成消费失败/重放审计演练 |
| 签名 known-good rollback 与 kind 限制 | rollback 强制 Ed25519 known-good bundle、不可变 manifest/capability 引用、镜像摘要和签名 capability，并拒绝不允许的 Kubernetes kind；回滚后执行 canary | 由发布安全控制面签署已知良好 bundle，并在真实集群完成回滚、队列收敛和业务 canary 演练 |
| 生产签名 backup attestation | `NODE_ENV=production` 的恢复强制签名 `postgres_backup` attestation，绑定备份文件名、字节 SHA-256、来源库隐私摘要、时间窗和固定 key ID | 对真实备份生成外部签名 attestation，在隔离恢复目标完成 PITR/RPO/RTO 演练 |
