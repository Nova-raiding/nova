# JIT 撤销免二次审批：只读边界复核

复核者：security_persistence；日期：2026-09-07。仅查询现有 CodeGraph、rg 和源代码；没有修改业务源码，没有运行 HTTP、SQL 或 Docker。原始证据见同目录 `security-persistence-readonly-evidence.json`、`codegraph-policy-impact.raw.txt`。CodeGraph 索引未更新，覆盖不完整，当前源代码为准。

## 结论与最小范围

根因是 `packages/contracts/src/authz.ts:417` 把签发与撤销合并到同一条包含 approval 的策略。`mcp.ts:672` 的撤销契约本来仅要求 grant_id、subject_identity_id、expected_revision、expected_authorization_revision、reason，且参数模型 `additionalProperties: false`（491–501）。因此不能通过额外塞入 approved_by/approved_at 来补足错误的 policy；那会违反 MCP 契约。

正确的最小实现是在 authz.ts 拆开这两个方法：签发继续 reason/revision/approval；撤销仅 reason/revision。两者的 authorization.grant.manage、platform workbench/scope、secret_metadata、write、allow_and_deny 都保持不变。API 的通用义务提取（server.ts:5142–5150）和 revoke handler（11426–11429）本来就能执行此契约，不需要改 schema、handler、repository 或迁移。

应递增 AUTHZ_POLICY_VERSION，建议 `2026-09-07.v1`。同一 payload 从缺审批拒绝变为允许，是可审计的策略语义变化；继续沿用 v2 会混淆新旧决策。版本会进入决策、拒绝详情、审计、ops.session 的 policy_version/context_version，以及 worker recheck。UI 和 worker 类型接受字符串，没有要求存量记录统一改成最新版本。不得回写历史 policy_version、scope/hash、签发审批或事件，不需批量提升 subject authorization revision。

实际必要代码范围可压在 5 个文件：authz.ts、authz.test.ts、server.test.ts、authz-decision-audit.test.ts、security.e2e.test.ts。后三份现有测试含当前 AuthorizationDecision 的字面量类型或真实当前响应版本断言，版本递增后需要改为常量。桥接层和 persistence 的旧 v2 模拟数据是历史透传证据，可保留，不能机械替换。若同时修改桌面 JIT spec 来验收真实 UI，则为第 6 个真实验收文件，应明确计入联动范围；没有必须新增数据库迁移的理由。

## 持久性与失效链

- `PostgresAuthorizationRepository.revokeGrant`（authorization-repository.ts:350）在事务中按 grant id + subject + 未撤销锁行，检查 grant revision，随后按 subject revision CAS 递增；更新 revoked_at/by/reason、grant revision、authorization revision，并追加 revoked 事件。CAS 失败或事件写失败会整体回滚。scope/hash 和原签发 approved_by/approved_at 不被改写。
- `MemoryAuthorizationRepository.revokeGrant`（275–281）也检查 subject 与两种版本，但不能用其替代真实 PG 事务或 RLS 证据。
- migration 105:124–152 约束 merchant_ops + transaction-local platform_ops；merchant_app 无授权表权限，ops 只能更新撤销/计数/版本字段，事件不能 UPDATE/DELETE。migration 135:29–54 绑定事件与真实 grant 的 subject/workspace；migration 125 保持历史不可变。
- 该方法是平台管理能力，允许受权管理员处理所选目标工作区的 grant。不能误把“目标 workspace 与操作界面当前 workspace 不同”当成必然违规；真正需要锁定的是管理能力、平台 scope 和 grant/subject 精确绑定。
- 撤销提升目标 subject authorization revision。后续读取不再列出 revoked grant；consume 的 revoked_at 条件拒绝旧授权；worker recheck（server.ts:4292–4333）先比较当前 subject revision，再检查 grant revision/subject/workspace/capability/hash/revokedAt/有效期，旧快照不能创建新的执行预留。
- 已提交的 reservation 是历史决策结果，repository 的精确幂等重放被保留；这不等于撤销后可重新通过 worker 的完整 recheck。也不能声称能回滚已经开始的外部副作用。

## 最小回归矩阵

| 层 | 必须证明 |
|---|---|
| 策略单测 | revoke 带 reason/revision 无 approval 允许；issue 同样输入仍缺 approval 拒绝；缺管理能力、显式 deny、错误 workbench/scope、缺 reason/revision 仍拒绝；audit 级别不变 |
| MCP 契约/API | 撤销只发送 schema 已有字段成功；缺任一 required 字段/错误版本格式/额外 approval 字段仍按契约拒绝；签发仍要求审批字段 |
| API 管理权限 | 真实签名 OIDC 或受控 HTTP 身份有 grant.manage 才能撤销；无权限不能借 grantId 或 subjectId 越权；失败零变更 |
| 真实 PG 成功与回滚 | grant revision 和目标 subject revision 各 +1，只有一条 revoked 事件；scope/hash/原审批保留；错误 subject、旧 grant revision、旧 subject revision 均不产生部分更新；重复撤销不重复追加事件 |
| RLS/审计 | app role 拒绝；ops 错误/缺失 platform scope 不可读写；拒绝与允许决策携带新 policy_version；撤销事件 subject/workspace 与 grant 精确一致、历史不可变 |
| 旧授权失效 | revoke 后 active list 为空、旧 consume 拒绝；两个真实 worker HTTP 入口均拒绝旧快照，零新增 reservation/零 provider 调用；不改写既存幂等历史 |
| 桌面验收 | 新签发仍输入审批；撤销仅原因与版本，不再出现审批缺失；完成后状态/版本/审计刷新；失败可解释且不出现假成功 |

本次只读未重新运行上述测试。既有 repository、RLS、worker HTTP 回归可复用，但 owner 需对策略补丁及新版本做定向重验，不能把静态存在当作本轮动态通过。
