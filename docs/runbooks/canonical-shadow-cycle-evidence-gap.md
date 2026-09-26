# Canonical shadow cycle 证据缺口

`tests/canonical-product-cutover-evidence-gate.ts` 现要求逐周期来源引用，但始终拒绝将自填 JSON、`shadow_check_cycles: 2` 或两个 SHA-256 文件直接认作生产证据。门禁保持关闭，直到以下来源链实际落地并经独立验证。

## 仓库现状

- `packages/persistence/src/unified-link-audit-repository.ts` 以 `ON CONFLICT ... DO UPDATE` 更新 `unified_link_audit`；迁移 098 和 226 都将其定义为投影。它没有保留两个周期的原始结果，不能从当前行数倒推历史周期。
- `infra/protected/payment-refund-ledger-snapshot.mjs` 已示范只读、可重复读事务，检查 RLS 角色以及在受保护目录用 `O_EXCL` 写入新文件。这些文件安全约束可复用，账务表及角色不能直接用于 canonical 来源。
- `infra/protected/produce-protected-live-backup.mjs` 从 `pg_control_system()` 取得 PostgreSQL system identifier 和数据库 OID。canonical 专用只读角色尚不存在，也没有经审核的该角色查询 live system identifier 的权限/函数。
- 现有 canonical consistency API 在线计算报告；未发现保存每个工作区、每轮开始/结束时间及完整结果的不可变采集记录。

## 受保护采集器的必要契约

1. 固定本次 release ID、deployment nonce、目标数据库身份和工作区集合，均来自已签署的发布身份及受保护清单，不接受采集脚本自行生成的 release 绑定。
2. 使用独立的 canonical evidence 只读角色。拒绝 superuser、`BYPASSRLS`、表写权限、可继承高权角色和未强制的 RLS。每工作区在 `REPEATABLE READ READ ONLY` 事务中设置 `app.workspace_id`；记录真实事务快照、数据库身份、采集时间、工作区集合摘要和检查版本。
3. 对每个工作区运行与线上 canonical consistency API 同一版本的检查逻辑，持久化完整原始结果或可复算的行级摘要。仅查询可变 `unified_link_audit` 投影不符合此要求。采集器需要验证覆盖所有冻结工作区，并且不能因单一工作区错误而将结果截断为成功。
4. 每轮使用独立不可复用 attempt ID，将原始记录以私有目录、`O_EXCL`、`fsync` 方式写出并计算 SHA-256。第二轮必须在第一轮完成之后由新的只读事务独立采集；不能复制或重新封装第一轮文件。
5. 独立于采集进程的核验器应从固定信任根核对数据库身份、发布身份、采集器版本、两个 attempt ID、全量工作区集合和原始记录哈希，然后才可生成最终证据及签名。只有这条验证路径接入门禁后，才能移除当前 fail-closed 错误。

当前尚未定义和部署上述角色、live database identity 授权方式、完整在线检查的只读复算接口及独立核验器。仓库无法据此生成真实的两个生产周期；构造两份 `source_ref` 文件只会提供完整性，不提供来源真实性。
