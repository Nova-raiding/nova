# JIT 撤销策略修复与真实复验

日期：2026-09-07（CST）；状态：**DONE_WITH_CONCERNS**。用户“继续”已确认签发仍需审批、撤销免二次审批。本轮策略缺陷修复完成，真实 PG 中撤销成功；前端回执/导航生命周期已修复并通过隔离桌面复验，生产仍保持 **NO-GO**，因为 ChatGPT 宿主、中转五模态、正式部署容量/恢复等 E3/E4 证据未齐。

## 结果与根因

此前撤销请求返回 403 `AUTHZ_OBLIGATION_REQUIRED`，缺失 approval。根因是 `authz.ts` 将 issue/revoke 合并为同一条需要审批的策略，而严格 MCP revoke schema 本来不接收审批字段。给前端补 approved_by/approved_at 会违反 schema，不能解决问题。

本轮生产代码只改 [authz.ts](../../../packages/contracts/src/authz.ts:417)：签发仍要求 reason/revision/approval，撤销要求 reason/revision；两者继续要求 authorization.grant.manage、platform 工作台与范围，保留 secret_metadata、write 和 allow_and_deny 审计。策略版本递增为 `2026-09-07.v1`，不回写旧审计、grant、scope/hash、审批或历史事件，也不批量递增 subject revision。

联动三份当前版本测试改用 `AUTHZ_POLICY_VERSION`，新增 [强制授权签名 HTTP 回归](../../../apps/api/src/ops-jit-revoke-enforce.test.ts)。合计 5 个代码/测试文件；MCP schema、API handler、repository、数据库迁移、前端和原桌面 spec 均未修改。已有脏工作区修改不归入本轮，历史 bridge/persistence 的旧版本透传 fixtures 保留。

方法：gstack investigate 的根因→红测→最小修复→全量复验；pm-skills verify-feature 的真实界面/进程/数据取证；CodeGraph 的只读 impact/query 与当前源码引用交叉核对。索引不完整，不用图中缺失代替影响分析。详见 [CodeGraph/安全复核](../../../artifacts/audit-2026-09-07/jit-revoke/security-persistence-review.md)。

## 实际运行分母

本轮证据目录为 `artifacts/audit-2026-09-07/jit-revoke/`。下面各次运行存在覆盖重叠，不相加为独立测试数量。

| 检查 | 实际结果 | 原始证据 |
| --- | --- | --- |
| Owner 旧策略原子红测 | exit 1；合法撤销仍因缺 approval 被拒绝 | `owner-policy-red.json` |
| 新文件旧策略红测 | 33 项：12 failed、21 passed、0 skipped；两管理员均在真实签名 HTTP 撤销被拒绝 | `agent-http-policy-red.json` |
| Owner 最终定向复验 | 7 文件 / 296 passed / 0 failed / 0 skipped | `owner-focused-final.json` |
| 新回归明细 | 39 passed：19 项真实签名 HTTP + 20 项策略单元；后补 6 项边界不宣称已做旧策略红测 | 同上及 `agent-http-policy-final-green.json` |
| 独立授权 PG17.11 | 固定 6 文件 / 8 passed / 0 failed / 0 skipped；非空断言和精确文件集合校验 | `postgres-run-87qlt8/vitest.json`、`run-result.json` |
| 安全全量 check | exit 0；根套件 598 文件通过 / 44 跳过；4,494 passed / 70 skipped；Ops 88 文件 / 501 passed / 0 skipped | 本续轮完整 `npm run check` 日志 |
| 类型、元数据、构建 | 根/API/两 UI 类型通过；release metadata、Ops build、Studio build 通过；Studio >500 kB 警告保留 | 同一完整 check 日志 |
| Owner 原始桌面 suite | exit 1；1440×900 回执缺失；1280×800 因 serial 前置失败未运行 | `owner-desktop-lifecycle.log` |
| 独立桌面录屏复验 | exit 1，仍 FAIL；实际签发/撤销均 200，回执等待失败；TTL 与空撤销原因负例生效 | 下节视频、RPC 与只读 PG 诊断 |

最终 check 摘要：

```text
Test Files  598 passed | 44 skipped (642)
Tests       4494 passed | 70 skipped (4564)
Ops Files   88 passed (88)
Ops Tests   501 passed (501)
check exit  0
```

E1 HTTP 使用本地回环、真实 OIDC 签名验证、enforce + durable required、独立 Memory 身份/角色/授权/审计仓储，不冒充 PG 事务或正式 IdP。覆盖两类 canonical 管理员、旧授权失效、允许/拒绝审计、缺权限/签名错误/错误工作台、缺字段/非法格式、双版本冲突、错误 subject 和使用新签名 nonce 的重复撤销。原签发审批要求保留。

PG 六文件覆盖授权执行预留、撤销与历史幂等重放、RLS/ACL、伪造 subject/workspace 事件、workspace_ids 写入边界及存量迁移、原子预算与追加式事件、迁移 109 的隔离重驱。它们在新 PG17 的私有集群中新建自己的 UUID 数据库；没有使用共享业务 DB。首次启动前环境检查因 macOS 注入系统编码键而 fail-closed，未启动 Docker/SQL；修正 artifact-only 系统键识别后才进行该次成功运行，记录保留在 `postgres-runner-preflight.md`。

## 桌面、持久数据与新的阻断

Owner 原 suite：[原始报告](../../../artifacts/ops-jit-isolation/2026-09-07T12-33-38.950Z-e23223f1-350d-4012-8a99-ccb651a3c872/playwright.json)。真实流程已推进至撤销 200、有效列表移除；第 270 行严格等待“最近一次 JIT 已撤销”失败。没有将 403 或回执缺失改成预期成功，也没有删掉第二尺寸。

独立 fresh fixture 再次复现：[72.68 秒实际交互视频](../../../artifacts/ops-jit-isolation/2026-09-07T12-37-48.612Z-1b265e61-3f40-4518-afd2-e6f8544fd344/live-desktop-revoke-capture/jit-signed-login-issue-revoke.mp4)、[空撤销原因禁用](../../../artifacts/ops-jit-isolation/2026-09-07T12-37-48.612Z-1b265e61-3f40-4518-afd2-e6f8544fd344/live-desktop-revoke-capture/03-revoke-empty-reason-disabled.png)、[失败末帧](../../../artifacts/ops-jit-isolation/2026-09-07T12-37-48.612Z-1b265e61-3f40-4518-afd2-e6f8544fd344/live-desktop-revoke-capture/failure-final-frame.png)。Owner 已打开关键截图复核；视频来自实际登录和表单点击，不是直 POST 或 mock，密码始终遮罩。视频转换成功不代表功能成功；最终 UI 仍为 FAIL，其他运营数据错误横幅未隐藏。

[只读 PG 诊断](../../../artifacts/ops-jit-isolation/2026-09-07T12-37-48.612Z-1b265e61-3f40-4518-afd2-e6f8544fd344/live-desktop-revoke-capture/postgres-readonly-diagnostic.redacted.json)限定 own fixture、目标 subject/workspace、actor/ticket，以 merchant_ops、同连接 REPEATABLE READ READ ONLY 读取。Owner 独立交叉断言确认：

- 录屏目标仅 1 个 grant；issued/revoked event 各 1 条，grant revision 1→2；本次录屏的 subject revision 2→3→4（前置失败 suite 已完成一次真实签发/撤销）。
- revoke actor 为实际登录身份，原因存在，use_count=0，scope 精确为该 workspace_ids；撤销后的有效列表不再包含目标 grant。
- 签发/撤销浏览器 request_id 与 PG allow 审计精确吻合；签发义务仍含 approval，撤销仅 reason/revision，两者 missing=[]。
- 非法 TTL 与空撤销原因均在请求发起之前被界面阻止；每个合法 mutation 只发起一次。

该诊断保留 `diagnosticOnly=true`；[Owner 证据交叉核验](../../../artifacts/audit-2026-09-07/jit-revoke/owner-live-evidence-crosscheck.json)只确认后端事实，不将失败桌面捕获提升为 PASS。

已修复的前端 P1：回执、外层用户治理区和内层授权页签现在由 `useOpsConsoleModel` 持有；撤销仍先清理 session 与所有授权范围数据，再重新加载服务端 session，只有 actor/workbench（及存在时的会话工作区）一致才保留 UI 回执。平台工作台没有 `session.workspace_id` 时不会丢弃以真实 actor 绑定的目标 grant 回执。隔离桌面验收新证据：`artifacts/ops-jit-isolation/2026-09-07T13-01-53.847Z-0acc1a79-22ff-48cb-b971-83bc11ec8d16/`，1440×900 与 1280×800 均通过（2/2）；此前失败目录保留用于红测对照。

另一个既有 P1 已修复：`AuthorizationRepositoryError` 现在在 API 边界按语义映射为不存在 404、revision/并发冲突 409、非法参数 400，未知系统错误仍为 500。真实撤销 HTTP 回归已更新为精确断言，39/39 通过；grant、subject revision 与成功 mutation 在拒绝场景保持不变。

## 来源、清理与交接

完整 check 前后均采集 1,432 个源码/配置文件摘要。本轮五个代码/测试文件及桌面 spec/启动器/fixture 均未变；其他并行写入改动了 TasksPage.tsx 和两个 inventory JSON，因此这次全量运行不构成整个发布来源冻结证明。详情见 `source-fullcheck-before.json` / `source-fullcheck-after.json`。

[Owner 清理核验](../../../artifacts/audit-2026-09-07/jit-revoke/owner-postgres-cleanup-verified.json)校验了 PG 报告、六文件源码 hash 和三次运行的 6 个容器完整 ID；这些 ID 均已从本机 Docker 容器集合消失，leftRunning=[]。只移除了本次 tmpfs 合成夹具，可重新运行生成；报告、视频、截图保留。未删除业务数据、持久卷，未停启共享服务。

本轮未调用付费中转模型、未改商业门禁、未迁移共享库、未提交或部署。默认 suite 的 70 个跳过、隔离排除的 13 个文件、桌面第二尺寸未执行均保留分母；专项通过不能抵消它们。ChatGPT 宿主、正式 IdP、中转五模态、真实目标部署、容量/恢复与 E3/E4 发布证据仍按[测试方案](test-strategy-2026-09-07.md)逐项验收。

依据 gstack investigate 的根因→最小修复→验证流程，本续轮仅改动前端状态生命周期与回归断言，未扩大授权策略、MCP schema、repository 或迁移范围。必须保持失效权限与客户数据清理，不能为了留住回执而保留旧 capability；当前 27 项相关单测、类型检查和真实隔离桌面 2/2 均通过。
