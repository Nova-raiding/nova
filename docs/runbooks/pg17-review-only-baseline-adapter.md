# PG17 同快照行集基线：受保护适配设计

状态：**review-only，NO-GO**。`infra/protected/review-only-pg17-snapshot-baseline.mjs` 目前只是可注入数据库连接的采样原型，没有生产 CLI、文件落盘、控制安装或签名能力。不得将其返回值改写成 `pg17-rowset-inventory/1` 或最终 `kind=restore` 证据。

## 已有接口与快照时序

备份 runner `produceBackup()` 持有 `pg_export_snapshot()` 的导出事务，先让 `pg_dump --snapshot=<id>` 完成，再在事务释放前调用 `reviewOnlyObserveSnapshot(snapshot, identity)`。原型的第一条数据库命令为 `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`，第二条为 `SET TRANSACTION SNAPSHOT '<id>'`；之后关闭 RLS 行过滤并重新读取系统标识、数据库 OID/名称、迁移版本。它在同一事务中核对全部用户持久关系的目录、冻结的列顺序/类型、RLS 策略，并读取行的数据库 JSON 字节。任何错误回滚并关闭连接；runner 回调失败则拒绝备份。生产 CLI 当前未传入这些回调，**不会自动生成基线**。

`bindReviewOnlyBaseline()` 只比较观察记录和备份文档内的快照 ID、来源数据库身份、迁移版本与备份摘要。它不验证文档 Ed25519 签名、私钥控制、安装字节或文件来源，输出始终包含 `final_production_evidence=false`、`source_provenance_verified=false`、`backup_document_signature_verified=false`。

## 生产适配必须先补齐

1. 由独立受保护的签发者冻结完整表计划：版本、release/Git SHA、生产数据库身份哈希、预期迁移前缀、全量用户关系清单、每表完整物理列顺序/类型/非空标记、规范编码版本、签发时间和签名。固定公钥、计划摘要及采集器摘要应由发布目录之外的 root-owned 控制提供。不能让候选 checkout 或请求参数自行声明“完整”。
2. 独立只读采样身份需具备所有业务关系的 `SELECT`、读取 `pg_control_system()`/系统目录的必要权限，并以 `row_security=off` 使被 RLS 隐藏的行导致拒绝而非悄然少采。必须实测身份、授权和每个关系的可见性；不能使用线上 API/worker 身份来代替。
3. 固定安装的适配器只从受保护路径读取并验证签名计划及来源 policy，以保护的数据库连接工厂提供采样连接。它必须把观察值和备份签名文档各自写入不可覆盖的 root-owned 0600 文件，在落盘前复核同一快照和来源身份。独立复核器还需验证备份 Ed25519 签名、dump SHA、安装字节、容器/网络及采样角色来源。
4. 当前原型按表一次性读取，默认每表最多 10,000 行；超出即拒绝，不能只采前 10,000 行后声称完整。生产大表需要经审查的游标/外部排序或分块算法、固定内存与时间上限，并使 PG16 与 PG17 的列 JSON 编码一致；任何差异保守失败。现有摘要算法会排序并保留重复行。
5. 关系目录检查覆盖非系统 schema 的普通表、分区表、物化视图和外部表；后两种当前拒绝，直到单独定义恢复合同。序列值、大对象、外部存储与扩展状态不在行集摘要内，须另行验收。RLS 摘要只是策略结构，不证明租户查询实际隔离；应用级 RLS 验收仍独立执行。

完成以上项目后，仍需在新签名 242 生产备份的**同一导出快照**中实际运行采样，随后在 PG17 隔离恢复目标独立采样并比较。旧备份没有同期基线，不能事后补造。只有受保护的最终恢复签发器复核全部原始记录、API/worker/真实 ChatGPT 宿主验收和运行容器身份，才可能签发 `kind=restore`。
