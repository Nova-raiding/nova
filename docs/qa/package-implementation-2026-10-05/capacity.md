# C4 绝对配额真实消费边界

2026-10-05，application_backend owner。

发现真实素材写入 `putQuarantineObject` 只读旧 workspace_storage_quotas.limit_bytes/ENV；商业 cloud_storage 目录注册未进入上传预留。升级额度变化还会被 StorageQuotaRepository 旧 LIMIT_CONFLICT 拒绝。已增加 server-only `reserve({commercialEntitlement:true})`：生产 PostgreSQL 同事务先取与交易/升级/退款一致的 Workspace 合同 advisory 锁，再通过受限 current-revision SQL projection 读取唯一 active 权益的 cloud_storage.normalizedValue（规范 byte），缺失、冻结、重复、checksum/可执行标识/阻断项无效都拒绝，额度不从客户端/ENV读取。

当前合同 limit 替换仅更新 limit_bytes，used_bytes/reserved_bytes 和既有 reservation 不清除。预留、结算、物理删除后释放仍沿原台账；额度降低不足不会通过删除已用事实“补平”。投影分页达到安全上限时拒绝，避免历史截断遗漏另一个 active 合同。锁在 storage 行锁之前，与交易锁顺序相同。Memory mode 需明确注入商业 limit authority，否则拒绝；旧独立存储 fixture mode 保留。

API capacity 读取 cloud_storage normalizedValue，生产缺商业仓储拒绝，不退回 legacy subscription。存储展示需 root 将有效合同 limit 与原台账 used/reserved 合并；真实上传准入仍必须调用 reserve 内部锁下投影，不能以展示前读替代。

验证：3 文件17测试通过、persistence `tsc --noEmit` exit0、owner diffcheck0。覆盖规范GB→byte、无/冻结/重复/不完整证据、升额度不清已用预留、降额度不足拒绝、生产无商业 authority 不触碰 legacy。真实 PG 升级/冻结上传组合证据已请 eng_review 在其真实商业交易 fixture 加入，不以单元测试宣称真实生产消费完成。

退款缺口反馈：commercial-transaction-repository source recovery 原只检查已用/承诺服务和点来源，未检查恢复 old source max_brands/max_stores/cloud_storage 时的 actual brands/connected stores/used+reserved storage 是否超限。已通知 root/eng_review 在 Workspace 合同锁下预检，超原额度转明确补偿政策，不能直接恢复原限额。该文件由 eng_review 独占，未越界修改。

## 防止绝对额度消费的 late commit

root 后续授权真实 brand/store 两个持久化消费者收敛。PostgresBrandUnitRepository 构造 `commercialEntitlement:true` 时，createBrand 和 bindStore 从首个额度读取到 INSERT/COMMIT 持有同合同锁；品牌全部行计数（含 disabled），店铺按非 revoked platform_accounts 与 active distinct(platform,platform_account_id) bindings 的较大值，加实际新增目标的增量，已存在目标不重复计费。当前 source hold 将 period blocked 后无法读 active quota，禁止冻结后新增。

PostgresBusinessRepository 使用服务端构造选项 `normalizedProjection:true,commercialEntitlement:true`，platform_account 非 revoked snapshot 写入前执行相同锁内准入，再随原事务提交 normalized platform_accounts 与 snapshot。防止只写 snapshot 而不更新实际计数的配置组合，commercial mode 强制要求 normalized projection。revoked 清理保持可用，不靠付费权益阻止恢复操作。旧明确测试 fixture 构造默认未启用此商业模式。

新增 CommercialAbsoluteCapacityError 提供稳定 code/status 和 quota/used/included；source 权益异常复用商业额度 stable402/409/503。root 负责生产构造选项和 HTTP 错误转换。交易、真实 PG 组合退款/上传/brand 反例由 eng_review 整合，其已收到表谓词、锁协议及构造签名。

此轮4文件53测试通过、persistence类型检查通过；覆盖锁先于权益及实际计数、双店铺事实计数、已有目标不重复计数、冻结时真实仓储方法不得 INSERT、连接超限不得先写 snapshot。实际并发真实 PG 验收仍需 eng_review/QA 证据。

## OAuth 内存状态与存储用量证据

registerPlatformAccount 在 SQL 提交前已写 service.platformAccounts，真实 map key 是 entity.id；hydrateSnapshot 使用同一 key。persistSnapshot 现在在确定本地商业准入异常后，读取 exact tenant/entity durable snapshot：存在则恢复 durable fact，只有 BusinessSnapshotNotFoundError 确认不存在才清除该次注册的 exact key；其他租户及更晚并发注册不覆盖。网络/提交结果未知不得当失败删除。确定拒绝但 durable 查询不可用或返回错企业时保留身份，将本次 transient tokenState 标为 refresh_required，阻断其作为已连接账号使用；原始持久化错误继续返回，不声称额度或外部 OAuth 已成功交付。

effectiveStorageQuotaSnapshot 原来 ledger 缺失时造 used/reserved=0，无法证明外部对象或历史业务无存储占用。生产缺台账现在返回 STORAGE_QUOTA_USAGE_UNAVAILABLE 503 和 storage_usage_known:false，已知台账只替换合同 limit，保留真实 used/reserved，包括已超限事实。新独立恢复/快照 helper 针对测试覆盖 exact key/tenant、durable 已撤销账号恢复、未知commit不读不删、更晚注册不覆盖、读不可用不删除并阻断connected、缺账拒绝虚构零；等待本轮测试/全局类型检查结束追加结果。

本轮6项测试通过，包括 durable read 期间同对象就地撤销必须保留更晚 revision；server 调用传冻结 entityVersion 防止对象引用相同但修订已变化时覆盖。owner diffcheck0。全局类型检查 session48287 终态 exit2，仅 commercial-runtime-policy.test.ts11/24 的 new_recovery_intent 不属于当前 CommercialRuntimeOperation 两条类型错，已将完整输出交 root 对应 C6 owner；本恢复/helper接线未报类型错，不重复启动全局检查，不把全局失败记为通过。
