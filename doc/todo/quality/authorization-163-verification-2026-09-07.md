# A-01 授权契约修复与验收

日期：2026-09-07。范围：用户确认的 15 个实现/测试/CI 文件，以及本地测试证据与报告。产品工作流与全量方案仍见 [项目评审](project-review-2026-09-07.md)、[测试方案](test-strategy-2026-09-07.md)。

## 当前结论

本报告保留 18:40 CST 后端验收快照。用户随后确认的桌面签发表单与测试隔离已继续实施，最新状态以[续轮报告](jit-desktop-test-isolation-2026-09-07.md)及本页“历史红测，已修复”段落为准；下述旧 runner 失败不再代表当前实现进度。

A-01 已确认的后端 15 文件补丁完成，前向迁移 163、隔离 PG17、签名 HTTP 与真实 OIDC 桌面专项均通过；桌面表单已同步提交单元素 `workspace_ids`，A-01 的实现与隔离验收项可关闭。**不是生产发布批准。** 共享业务库的存量授权审计/迁移仍需预发布 operator 执行；没有连接店铺、调用付费模型或修改商业能力/安装缓存。

采用 gstack investigate 的根因→红测→最小修复→重新验收流程；CodeGraph 架构复核独立核查唯一生产 reservation 调用的两个入口；owner 重新检查补丁并实际执行测试，不以 agent 报告替代结果。

## 根因与变更

| 根因 | 修复 | 不变的安全边界 |
| --- | --- | --- |
| API 签发 workspace_ids，旧 152 trigger 要求 type/ids | 前向迁移 163 对齐单工作区 scope，可带安全字符串 metadata | 152 checksum 不变；不翻译历史授权、不重算 scope hash、不改审计事件 |
| Worker 以真实任务 ID 预留，却拿它匹配工作区 ID | workspace scope 与 workspaceId 比较，reservation 保留真实 resourceId | generic task/brand/account 等内部精确资源匹配仍保留；真实事件归属由 Worker HTTP 入口检查 |
| pg 返回 BIGINT 字符串，与 TS number 契约不一致 | 授权 revision 在读取/比较出口统一安全解码 | 非整数、负数、溢出明确拒绝，不静默舍入 |
| 定向 PG 可能因缺环境而跳过，却被当成通过 | CI 增加五文件专项，核对实际文件集合与所有断言状态 | 文件漏跑、空断言、failed/skipped/todo/pending、缺原始报告均失败 |

163 在同一事务中先取得表锁，再进行 `row_security=off` 审计与 trigger 替换。所有未撤销且未过期的不兼容授权都会阻断，包括已耗尽和未来生效的授权。旧 writer 未提交时迁移必须等待；提交后重新读取并拒绝不兼容活动授权。RLS 过滤下的审计报错，不把看不见的数据当成不存在。

历史兼容授权保留原样；已失效/撤销的 canonical 旧授权可保留和更新撤权信息，但不能以旧格式新签发或修改 scope。生产发现活动旧授权时，需要有权限的 operator 显式撤销、重新签发并评估排队任务；本次没有执行该业务操作。

## 已执行验证

证据目录：`artifacts/audit-2026-09-07/auth163/`，所有失败原始报告均保留。

| 检查 | 实际结果 | 原始证据 |
| --- | --- | --- |
| 修复前 PG17 红测 | 2 文件 / 2 failed / 0 skipped，均 scope invalid | `postgres-1788776776612.json`、`postgres-before.log` |
| 迁移注册红测 | tail 未注册 163 时失败，旧 152 hash 断言通过 | `migration-registration-red.json` |
| owner 真实 PG17.11 集成 | 5 文件 / 6 passed / 0 failed / 0 skipped，文件集合精确匹配 | `postgres-1788777565347.json`、`owner-postgres.log` |
| owner 授权/迁移/HTTP 定向 | 8 文件 / 89 passed / 0 failed / 0 skipped | `owner-auth-focused.json`、`owner-auth-focused.log` |
| 类型检查 | `npm run typecheck` 通过 | `typecheck-preliminary.log` |
| CI 分母保护行为测试 | 直接执行 CI 内嵌校验代码，验证正常及缺文件/空断言/跳过/失败负例 | `ci-denominator.json`；最终专项中 migration-163 四项再次通过 |

PG 五文件包括 repository release、RLS boundary、event scope integrity、grant scope integrity、migration-105 release。覆盖 19 种非法新 scope 的 INSERT/UPDATE 拒绝、7 种独立活动旧授权升级阻断、历史证据保留、跨租户、append-only、用量、撤销、新执行与历史幂等、BIGINT 溢出、受限角色 42501、真实锁等待。

89 项中 Worker 文件 34 项（2 helper、32 个真实签名 loopback HTTP 用例），针对两个执行入口检查不存在事件、跨工作区、aggregate/operation/snapshot 篡改、发布任务/account binding、撤权、重复请求与真实 job ID。依赖受控内存服务，归为 **E1**；PG repository/迁移/RLS 为 **E2**。没有将两组局部证据拼接为真实端到端 E3。

18:47:54 CST 起在来源快照固定后再次运行上述两组 owner 专项：真实 PG 仍 **6 passed / 0 skipped**，授权/HTTP 仍 **89 passed / 0 skipped**。最终原始报告为 `postgres-1788778074082.json` 和 `frozen-owner-auth-focused.json`。18:46:31→18:49:48 CST 的 1,388 个来源 hash 无变化，15 文件亦与 agent 冻结 hash 一致；完整状态、报告 hash 与明确未验收项见 `run-manifest.json`。

## 全量运行与来源

`npm run check` 类型检查通过，随后 Vitest 已观察到两项迁移 tail 门禁失败：源码期待 163，共享库只读查询实际 `count=162,min=1,max=162`。没有降低断言或迁移共享库来使其通过。检查随后出于安全隔离原因主动中止，**exit 130，缺完整测试分母，不宣称全量通过**。部分日志中的 source-manifest 错误信息来自负例，不能仅按日志中的 error 单词统计失败。

独立补跑 `npm run test:ops-console`：87 文件、495 passed、0 skipped；`npm run build:ops-console` 和 `npm run release:metadata:validate` 通过。Ops 单元通过不覆盖实际签发表单契约。原始日志分别为 `ops-tests.log`、`ops-build.log`、`metadata.log`。

18:40:40→18:46:31 CST 源码清单 `source-before.json` 与 `source-after.json` 的 1,388 个源文件/配置/测试 hash 全部一致。该清单对应全量检查的前后窗口，不把它伪称为整仓 release 已通过；工作区仍包含此前大量未提交变更。

### 全量检查的共享环境影响与中止

owner 启动全量检查时未提前识别出既有 runner 混入共享环境写操作，这是本轮执行隔离上的遗漏。确认后立即 Ctrl-C 中止，未继续执行该套件或清理共享数据。

- `tests/local-docker-runtime-contract.test.ts:202` 直接 POST 本地 8787 的素材上传，固定 `ws_demo`。只读核查确认运行窗口新增 1 个合成素材（18:42:06 CST），当前扫描 clean；精确合成 ID/名称保存在 `shared-runtime-impact.json`，没有导出其他业务素材内容，也没有删除该素材、相关对象或事件。
- `tests/local-docker-fault-acceptance.test.ts:69` 含共享 Redis stop/start。运行窗口观察到 Redis `StartedAt=2026-09-07T10:41:42.108476599Z`；中断报告不足以单独宣称该故障用例通过，Docker 事件历史查询没有返回可进一步归因的记录。记录实际重启现象，不伪造故障验收成功证据。
- 18:46:08 CST 两个本地 API 的 livez/healthz/readyz 均 200，项目 13 个服务当前 healthy，共享 Redis 为 running/healthy。容器健康不证明迁移163或新桌面功能已部署。
- 没有业务 schema/授权数据迁移；没有删业务数据、持久卷或容器来掩盖上述影响。全量回归后续必须将这两个共享测试迁入显式隔离/opt-in 的运行入口，不能仅为变绿跳过后声称已覆盖。

### 桌面补丁范围确认点（历史红测，已修复）

历史红测观察到 `AuthorizationGovernanceSection` 提交旧的 `{type:'workspace',ids:[workspaceId]}`，API 因缺少单元素 `workspace_ids` 返回 `400 AUTHORIZATION_GRANT_INVALID`。该问题已修复；当前组件真实浏览器回归断言 `resource_scope_json === { workspace_ids: [workspaceId] }`，并由隔离 OIDC+PG 桌面 suite 进一步验证。

既有桌面 RBAC matrix 仍是独立的组件层测试；当前真实 OIDC runner 已补齐 API/UI/gateway/PG/Redis 的登录→签发→列表→撤销路径，不使用 `route.fulfill` 冒充后端。该历史阻断不再代表当前实现状态。

## 仍需目标环境验收

- 在授权的预发布环境重新审计活动授权，验证 162→163 和当前镜像来源；本轮未升级共享业务数据库。
- 真实桌面 Ops 登录、签发/消费/撤权与目标 API/PG/Worker 串联，必须绑定同一版本和测试租户。
- 真实 ChatGPT 宿主、已配置模型中转的鉴权/用量/成本/错误、商业准入及发布门禁，依原测试方案 E3/E4 验收；本轮只读 MCP 健康查询返回未连接店铺，不是业务完成证据。
- 现有桌面 OIDC runner 复用共享 API 容器配置及固定业务 DB/Redis 端口，未在本轮直接执行，防止越过“只允许隔离 DB”范围。

## 安全与恢复

隔离容器 `merchant-auth163-pg-20260907` 使用固定 PostgreSQL17 镜像 digest、随机 loopback 端口、专用 run/phase label 与 AutoRemove；没有挂载业务卷。harness 每次验证容器身份与 PG 主版本，不回退到任何共享数据库。该隔离保证不适用于上面已中止的既有全量 runner；二者必须分开记录。

18:49:48 CST 已校验精确容器 ID、两个 label 与 AutoRemove 后 stop；仅移除本轮临时容器和合成数据库，原始报告保留，测试数据可用 harness 在同样隔离环境重新生成。没有清理共享测试素材、业务容器或持久卷。未提交代码或执行生产部署。
