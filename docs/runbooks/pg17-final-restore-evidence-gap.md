# PG17 隔离恢复到最终签名证据：当前缺口

状态：**NO-GO**。`restore-pg17-isolated.mjs` 的成功 JSON 是原始恢复记录，不是 `kind=restore` 的最终生产证据。它证明签名的 242 备份在新建 PG17 内部网络和卷中恢复，并执行候选 243/244 迁移；它没有执行或见证下列数据与应用验收。不得把这份 JSON 复制成其他检查的附件，也不得把本地 fixture、静态 `status=pass` 或容器健康状态签成生产恢复成功。

## 最小真实验收合同

最终签名器必须由独立于可变发布目录的受保护控制执行，先复核原始 capture 文件所有权、SHA、已安装 runner 摘要以及 Docker 实际 `container_id`、`network_id`、`volume_name`、镜像 ID 和 `internal=true`/无端口映射。所有验收只访问该 capture 指定的隔离容器；不能使用线上数据库 URL 或生产卷。每个原始结果以新的不可变文件保存，记录 release ID、Git SHA、八镜像集合摘要、manifest 摘要、部署 nonce 摘要、capture SHA、观察时间、命令/镜像摘要、退出状态及脱敏的 request/trace ID；失败结果保留，不能覆盖后改成通过。

1. **数据完整性**：在隔离数据库上用只读连接核对 `pg_control_system().system_identifier` 与 capture 的目标哈希；核对 `schema_migrations` 是 1–244 完整前缀、243/244 校验和等于候选归档；对备份前预先冻结的业务表清单执行每表行数与规范化校验和比对，并抽样验证商家/工作区外键、RLS 策略和权限。只有迁移行数不能证明业务数据未丢失。生产备份没有预冻结基线时，此项不能事后凭恢复库单方生成“前后相等”结论。
2. **API**：候选 `merchant-api` 的确切不可变镜像加入同一内部网络，使用仅面向恢复库的短期只读凭据与隔离 Redis；验证 `/healthz`、`/readyz`、带真实身份及工作区的只读 `/mcp` 请求，记录响应码、request ID 与审计关联。若 API 启动需要支付、OSS、模型或扫描器生产副作用，先提供被代码验证为只读且不出网的恢复模式；不能把线上凭据或线上 Redis 注入隔离容器。
3. **Worker**：候选 `merchant-worker` 镜像在同一隔离网络与独立 Redis 中启动，记录健康与至少一个可审计的只读/幂等恢复任务；必须证明任务读取的是 capture 目标数据库。若 worker 启动即消费真实外部队列或写第三方，必须先有受审查的隔离队列和恢复模式，不能以“容器 running”代替业务任务。
4. **ChatGPT 本地 stdio 插件**：用与候选 release 精确匹配的本地安装包，在真实桌面 ChatGPT 宿主中新会话执行 `initialize → tools/list → onboarding.status` 以及一个授权只读商家查询；请求须经候选 API/MCP 且绑定同一恢复目标和已授权的验收工作区，捕获脱敏 request/trace ID、工作区和服务器审计事件。服务器上的 Node 直跑 bridge 只能证明传输合同，不能冒充真实 ChatGPT 宿主验收。隔离网络不允许桌面直接连入时，必须设计可审计、仅指向恢复目标、短期有效的受控测试入口；不能把生产入口重定向至恢复库。
5. **独立签发**：签名器逐项重新读取上述不可变原始记录和实际容器状态；验证所有 release/镜像/manifest/nonce/capture/数据库身份一致、时间顺序成立且无 `simulated`、fixture 或失败步骤，再生成五个不同 artifact 引用与 Ed25519 签名文档。`tests/production-evidence-gate.ts` 当前只深度解析 `isolated_restore` 附件，其余恢复附件仅验 SHA 和签名文档字段；在签名器补齐独立复核之前，门禁的形式通过不等于真实恢复验收。

## 不能安全自动化的前提

- 缺少备份前冻结、签名的业务数据完整性基线；事后比较无法证明丢失或错租户。
- 缺少专供恢复目标的 API/worker 只读运行配置、隔离 Redis/队列和副作用阻断证明；直接复用生产环境变量会触及线上系统。
- 缺少真实桌面 ChatGPT 宿主可达、只指向该隔离候选且具备真实授权工作区的短期入口；服务器内模拟 MCP 不能满足插件端到端要求。
- 缺少固定安装、root 拥有、独立于发布目录的最终恢复签名器及其受保护密钥/摘要；在仓库里加一个可传任意 JSON 的签名脚本会降低而非提高可信度。

上述四项没有实际配置并在 101 上复核之前，owner 只能保留原始 PG17 capture，不能签发最终 `restore` 证据或继续生产迁移/切流。本文件是执行边界，不是成功证明。

`infra/protected/compare-pg17-data-integrity.mjs` 可以比较两份独立取得的 `pg17-rowset-inventory/1` JSON：一份 `kind=live-backup-baseline`，一份 `kind=isolated-restore-observation`。每份必须绑定相同发布与备份摘要、各自数据库身份、UTC 观察时间，并为每张表提供 `name`、`row_count`、`canonical_rows_sha256`、`rls_policy_sha256`。调用者以 `--baseline`、`--restored`、`--capture`、`--output` 给出四个互异的绝对或相对路径；输出用 `O_EXCL` 创建的 0600 原始比较 JSON，失败仍留档。比较器只对已经取得的行摘要做确定性核对，**不负责从数据库采样、验证采样者身份或签发最终证据**。缺少受保护的备份前采样器与冻结基线时，不能用恢复后的数据反推一份 baseline。隔离 API/worker 的只读凭据、独立 Redis/队列、副作用阻断与真实桌面宿主入口也尚未配置，故目前没有安全的自动应用冒烟 runner。

`infra/protected/preflight-pg17-application-smoke.mjs` 是只读拓扑预检，不启动 API/worker。它要求 root-owned/0600 的 capture、候选环境、镜像库存与角色观察文件；只对 capture 指向的 Docker 内部 bridge 网络及 Postgres 容器做 inspect，Redis 必须是同网无挂载/无端口的独立容器。API/worker 的 DB 与 Redis URL 只能指向这些容器，环境变量采用严格白名单，镜像必须是不可变 digest；角色观察必须显示独立只读、无超级用户/绕过 RLS/写权限。**角色观察文件仍须由独立受保护的数据库查询采集，预检本身不能证明其真实性。**当前 worker 没有无派发的恢复冒烟模式，因此预检即使其余拓扑条件满足也固定 NO-GO、退出非零，绝不生成应用 `pass` 或最终证据。它不能用生产 Compose/env 直接启动业务容器。
