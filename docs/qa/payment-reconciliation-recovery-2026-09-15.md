# 支付对账恢复与资金安全验收 · 2026-09-15

状态：支付恢复、整合回归及真实数据库锁超时恢复验证已完成。全量交付仍被分工外的权限契约冲突阻断；不是生产支付放行声明。

## 范围与根因

本轮只恢复既有支付／退款对账链路，不新增商业订单、开通权限、合同外链下载、OCR 或 StoryForge 功能。业务实现限于 `apps/api/src/server.ts` 与 `packages/persistence/src/billing-repository.ts`；保留工作区原有未提交修改，不提交、不推送、不部署。

worker 仍定时调用 `/v1/internal/billing/reconciliation`，但 `3c9a7f6` 删除了 API 路由、worker 路由角色映射和共用对账函数。原安全用例修复前实际得到 `FORBIDDEN`，而不是请求进入对账处理后应返回的 `TENANT_SCOPE_DENIED`。新增边界与退款测试先复现路由缺失、未知退款误释放预留的问题，再修改实现。

## 已修复

- 恢复只允许 `reconcile` 角色的签名 HTTP 入口，绑定 worker、方法、请求目标、正文和工作区，拒绝重放。正文 `limit` 仅接受 1–20 的数字整数，省略默认 10；关闭开关或生产查单能力缺失时阻断。
- MCP 与 worker 共用批次实现。保留桌面既有字符串 `limit: "50"` 调用兼容，实际每批最多 20 次；付款与退款共用预算，交错处理，两类不会因付款总在前面而饿死退款。三分钟后不再发起新的查询，未执行项明确记录为 deferred。
- 退款发起与查单使用同一个持久化 `reservation.id`。超时、处理中、未知或凭据不足时保留预留；只有明确拒绝／失败才回补，确认成功才完成。重复查单／退款不重复记账。
- Redis 工作区互斥，查询前后续租；本地内存模式也互斥。失去租约则停止后续查询与记账，旧令牌不能删除新持有者的租约。
- 四个仓储变更入口增加可选的内部租约检查：付款完成、付款终态、退款完成、退款回补。仅对账事务设置 lock_timeout 5 秒、statement_timeout 15 秒、idle_in_transaction_session_timeout 15 秒；取得行锁后写入前、写入及 outbox 后提交前复核。异常回滚。非对账调用不新增超时设置。
- 保存成功／失败的 worker 汇总审计；退款未知／拒绝也留审计。修复内存对象原地更新污染 `before.state` 的问题。

这里的并发保证是限时数据库事务与租约复核，不宣称 Redis 与 PostgreSQL 具有跨系统原子 fencing。

## 独立审查与回归

owner 负责根因、API 恢复、交错调度、整合和最终运行；独立 agent 分别负责 HTTP 回归、worker／持久化契约复核、隔离运行脚本、资金安全审查、原需求与契约只读核对。独立审查发现的数据库等锁失租和慢付款挤占退款两个问题均纳入本轮修复，没有将其留作“已知但通过”。

已经观测到的阶段证据：

| 验证 | 结果 |
| --- | --- |
| 原安全用例修复前 | 1 failed / 67 skipped；不改原断言 |
| 新增 HTTP 边界首跑 | 25 failed / 6 passed |
| 未知退款业务首跑 | 9 failed / 32 skipped |
| 饥饿／审计快照新回归修复前 | 2 failed / 43 skipped |
| 独立 agent 最终 API 三文件 | 181/181 通过（45 + 68 + 68） |
| 仓储单元测试 | 62/62 通过，含 16 个写前／提交前／回滚／非对账兼容检查 |

owner 最终整合：12 个文件、451 项，**450 passed / 1 failed / 0 skipped**，61.15 秒。失败仅为下文说明的余额权限契约冲突；没有跳过、改断言或移除该测试。报告：`artifacts/payment-reconciliation/run-DXaOt3/owner-final-vitest.json`。

其中 API 三文件 181、worker 90、支付 provider 19、账务仓储 62、worker 签名 5 均通过；OIDC 26、OAuth 5、native MCP 13、MCP 契约 17 通过；authz 32 通过、1 失败。上述数量为同一次运行的唯一用例，不累计重复执行次数。最终 `npm run typecheck`（根项目、ops-console、merchant-studio）退出码 0，`git diff --check` 通过。未更改 UI，因此不重复声称本轮做了桌面视觉验收。

最终被测生产源码：server `23de9071eb8027c73c431dae3df6a5dd6647c7db162911b4c7ee85d600289719`；billing repository `bd2ac8ad10eba42067600f021573fdad59a98688c7082b17ac91aa04735b4629`。上述单元和内存 HTTP 测试不替代真实 PG/Redis 验收。

## 真实运行面证据

入口：`node --import tsx scripts/verify-payment-reconciliation.ts`。脚本只创建属于自己 run ID 的 PostgreSQL 17 与 Redis 临时容器，验证容器 ID、标签、随机回环端口、角色与隔离数据存储后使用。API 使用应用数据库角色；不读取共享业务环境、支付密钥或模型配置。

付款／退款状态由新建 localhost 测试 provider 返回，不是真实支付商或真实交易。退款预留由隔离数据库构造，脚本明确标注 seeded refund holds；退款发起链路由独立 HTTP 用例覆盖。真实部分是签名 HTTP、数据库写入／RLS、锁等待、Redis 租约及持久化审计。

- 第一轮：`artifacts/payment-reconciliation/run-0UZPUw/run-result.json`，基础结算、幂等、租户隔离、并发 409、provider 返回后失锁 503 均通过。
- 第二轮：`artifacts/payment-reconciliation/run-DXaOt3/run-result.json`，另验证了真实 `pg_stat_activity` 与 `pg_locks` 显示 API 等锁后置换租约：付款订单、退款完成预留、退款回补预留三场景均 503 `PAYMENT_RECONCILIATION_LEASE_LOST`、全部账本不变、下一笔不查询、新租约保留、失败审计落库。对应源文件前后指纹一致；随后脚本类型与失败证据捕获改进，最终版本需重新运行。

最终复验通过：`artifacts/payment-reconciliation/run-nbnQyo/run-result.json`，run ID `6931b0ff-0d66-4ff7-90a8-61e91e9ffb3e`，2026-09-15 11:05:25–11:06:14（北京时间）。再次执行全部基础场景与三类数据库等锁失租场景，并新增真实五秒 lock_timeout：API 在 5,303 ms 返回 `attention_required / 55P03`，此时测试持锁事务仍存在，账本不变；只在释放该测试行锁后重新对账到账 800 分，再次执行不重复入账。

最终脚本指纹 `913528ed9133d17b1ccb41be5afb30df7173c585dca40e6a5a5b79fa09214ff5`。九个关联源文件前后指纹一致，owner 再读当前源码也完全匹配。该轮两个临时容器已由精确 ID 校验后停止，随后 owner 独立确认均不存在，无遗留；未删除业务数据或共享容器卷。完整收口记录：`artifacts/payment-reconciliation/run-nbnQyo/owner-final-verification.json`。

共享桌面 `/api/readyz` 返回 200，13 个既有项目服务健康；StoryForge 原 11 个完整容器 ID 均重新核对为 exited，没有自动恢复。此健康检查不表示新代码已经部署。

## 仍未解决、未冒充完成的事项

1. **共享目录权限语义冲突。** 前轮通过时 `authz.ts` 指纹为 `94e7a9ed…`；本轮未分配的后续修改将 `creative-points.balance.get` 从 `billing.self.read / self` 改为 `billing.workspace.read / workspace`，当前对应指纹 `b054d3fb…`。现有 `authz.test.ts:110` 仍要求原语义，owner 实际复现失败。该改变影响普通租户角色是否可看余额，不是修复 signed worker 所必需，不能通过改断言掩盖，也不能擅自回退他人权限变更。同一外部分工变更还涉及平台退款／对账策略，需要独立协调。
2. **合同外链尚未实现。** 原需求明确“文件／链接”，当前可信合同附件只接受已扫描的 asset_ref；MCP 层仍宣称接受 HTTPS，而 API 拒绝。未放宽安全门禁，也未将参考外链冒充已扫描合同。需要明确链接只供查看还是要下载并扫描后替代上传。
3. **交付完成后自动生效范围尚未确认。** 不擅自给整个企业或某个账号开通，不解除管理员停用、角色和付费限制。
4. 无真实支付商验收、真实模型调用或生产发布证据。本轮没有部署；StoryForge 按用户要求保持停止。

并行写入收尾记录：本会话未执行 `git commit`／push，但收尾时 HEAD 已从起始 `b6d23e78` 前进到 `468d7e82`（`fix: close release blockers from full QA`），上述支付源码和权限文件已被另一写入流程纳入提交。owner 随后复核支付 server、repository 和验证脚本指纹仍与最终验收一致；权限文件也仍为 `b054d3fb…`，因此那一项失败并未因提交而消失。保留此记录，不回退或改写其他会话提交，也不能依据提交标题把全量验收认定为通过。

技能影响：investigate 要求先证据定位再修复，识别到 SQL 等锁之后的第二个失租窗口；verify-feature 要求在真实 HTTP／数据库／Redis 运行面验证，避免把测试 seam 或类型通过当作真实支付证明。
