# Demo 发布状态账本（2026-10-10）

## 判定

**NO-GO，不得部署。** 本账本整理本地证据、agent 复核和 2026-10-10 04:02 UTC 的只读主机观察。主机观察有摘要，但未找到原始命令输出归档；它可用于定位当前阻断，不能替代 owner 签字 inventory、候选来源证明或业务验收。任何本地 fixture 通过都不作为 Demo 验收。

## 主机、候选和审批证据

| 证据来源 | 观察时间 | 状态 | 范围与限制 |
| --- | --- | --- | --- |
| [host-inventory.json](evidence/2026-10-04-ecs-release-round5/host-inventory.json) | 2026-10-04 22:33:25Z | 唯一项目 `merchant-demo-85575f9c`；`release_approved=false`；63 个 blockers，58 个未分类容器。 | 最新找到的独立 inventory 文件；不代表 10 月 10 日 04:02 主机观察中的库存审批状态。 |
| 本轮 parent/owner 消息（无配套归档文件） | 本轮消息；未提供采集时间 | 报告 inventory 命令 exit 2、`release_approved=false`，仍有 unclassified consumers。 | 仅记录 owner 报告；没有原始输出/时间戳附件，不能当作可复核的新 host artifact。 |
| [candidate-provenance-preflight.json](evidence/2026-10-04-ecs-release-round5/candidate-provenance-preflight.json) | 2026-10-04 22:33:39Z | 旧候选 SHA `59eb1e8…`；`deployable=false`、`review_only`；完整候选 image-set 和受保护 service preflight 缺失；public SHA 与该候选不一致。 | 绑定旧候选，不代表当前 HEAD 或当前部署候选。该文件内 production 专属授权字段/门禁不用于代替本 Demo 的门禁。 |
| [semantic owner decision](ecs-candidate-semantic-owner-decision-round6-2026-10-05.json) | 2026-10-05 | 旧候选 `59eb1e8…`；`approved=false`，0 项 owner approval。 | 不代表当前工作树的逐项语义批准。 |
| [round 10 captured-at](evidence/2026-10-05-release-round10/captured-at.txt) 与其 release / host projection 文件 | 2026-10-04 23:40:15Z | 旧 public release `ecs-3dc76c93b536` 当时 `ready=true`，但 host 运行镜像与候选集不完全匹配。 | 健康/release 探针是当时的只读观察；不是当前候选部署或业务验收。 |
| [Demo deployment report](2026-10-05-demo-deployment.md) 与 [owner current-state correction](2026-10-05-demo-owner-current-state.md) | 2026-10-05（各自归档时间） | 两份报告对在线迁移状态存在实质冲突：前者报告 257→258 部署；后者说明当时 live 历史仍为 1–257、258 仅在隔离恢复库验证，并明确纠正早先结论。 | 更正报告 supersedes 较早结论；二者均不能确认 10 月 10 日状态。需要当前 host/DB owner 提供逐行链证据。 |

## 当前本地候选与迁移门禁

- 历史只读快照：HEAD `f1f2d1c88a1279bf6dd1f088f05e6469faf8b590`；当时统计为 **171 dirty paths**（含本账本文件）。工作树随后持续变化；当前仍有大量未提交改动，不是 clean/frozen candidate。不要把历史计数当作当前状态。
- 本段早期历史阶段的 metadata 目标迁移版本曾为 272、273，随后为 274；这些数值均已被 2026-10-10 09:09 UTC 增量 supersede。当前 `release-metadata.json` 为 `sourceMigrationVersion=270`、`expectedMigrationVersion=275`，源码链包含新增迁移 271–275。migration 273 的隔离 PostgreSQL 回归有历史通过收据；迁移 274/275 均无本轮通过收据。主机观察没有读取 DB migration chain；既有 runbook/摘要提到的 270 不能当成本轮核实的 live baseline。无迁移快速更新必须先由 DB owner 提供 live 完整 `{version,name,checksum}` 链，并与目标链逐行比对；在确认前不批准无迁移路径，任何需要应用 271–275 的候选都须停止，等待另行批准的 migration window。
- 隔离 PostgreSQL 3/3 通过仅覆盖测试内构造的数据。它尚未覆盖几类历史组合：终态 NULL-scope return 对应已匹配 tenant balance；非空 return workspace 与 balance 不一致；tenant balance 缺少/错配 append-only match fact；source receipt 已有 tenant scope 但 balance 仍为 NULL。DBA 必须先在真实 Demo 只读计数并确认这些状态的合同，必要时补隔离迁移夹具；不能从 3/3 通过推断这些历史行不存在。
- 当前 runbook 要求对唯一 Demo 的新鲜 inventory 逐项分类所有运行容器，并在绑定候选完整 SHA 的受保护任务单/审查记录中由 owner 明确记录 `GO`、批准人、UTC 时间和证据；status 脚本固定 `release_approved=false`，退出 0 仅表示只读 inventory 命令成功，不是批准。还缺既有共享锁来源/权限/唯一 mutator 证明，并要求 API `setup.mode=demo`。健康与 `/releasez` 探针是必要检查，不能代替真实桌面权限、业务读回和插件/模型账单验收。
- 旧 owner-current-state 报告的 257/258、既有归档提到的 270 与当前源码候选链尾 275 之间仍缺可审计的 live migration history 衔接。不得从 metadata 或旧 runbook 数字推断线上已执行迁移。

## 插件与本地测试证据边界

| 证据 | 时间 | 状态 | 不证明什么 |
| --- | --- | --- | --- |
| [plugin-final-personal-install.json](package-implementation-2026-10-05/plugin-final-personal-install.json) | 2026-10-05 | 安装命令 `ok=true`，但要求 restart/login；记录 `host_restarted=false`、`host_loaded_new_snapshot_verified=false`；bundle 为 dirty source candidate。 | 不证明当前版本被 ChatGPT 宿主加载或工具清单刷新。 |
| [plugin-final-personal-stdio.json](package-implementation-2026-10-05/plugin-final-personal-stdio.json) | 2026-10-05 | 本地 stdio 包版本/文件清单检查；provenance 标记 source dirty、authenticity 未验证。 | 不证明 canonical Demo API、模型中转、真实费用/结算或商品生成闭环。 |
| [local plugin onboarding response](evidence/2026-10-05-local-plugin-binding/stdio-onboarding.json) | 2026-10-05 | 本地 stdio 返回 onboarding 文案。 | 不证明新 ChatGPT 会话已加载当前包，也不证明真实商家业务操作。 |
| 本轮 agent 汇报的本地用例 | 本轮；没有统一归档运行日志 | Merchant enhanced route matrix 1/1、素材库搜索spec 1/1、顶栏全局搜索spec 1/1；Ops role revision 与 fail-recovery 各 1/1，Overview page spec 2/2；API direct handler 11/11；既有 `npm run typecheck` exit 0。插件 smoke source 29/29、marketplace 28/28。 | 这些均为本地 fixture/合同或构建证据；不解除真实 Demo 门禁。 |
| 本轮库存安全整数补丁 | 2026-10-10 本轮本地运行 | `service.test.ts` 184/184 passed（覆盖本轮早先的 import/update safe-integer 检查）；最终新增 `product-stock-safe-integer.test.ts` 3/3 passed（覆盖同步批次预检、超限 SKU 和合计、import/update 合计溢出且无写入）；application workspace build exit 0。某次按 `-t` 选择两个新用例时，断言通过但安全 runner因同文件182项被跳过触发 pending-assertion gate而返回失败，随后完整文件通过。 | 均为本地 domain 层测试与构建，不证明 API/平台同步的真实 Demo 工作流。过滤器失败是 runner gate 证据，不应记为用例失败。 |
| 本轮插件 skill 路由文案 | 本轮本地运行 | `apps/plugin/visual-workflow-install-contract.test.ts` 1/1 passed；storyboard、merchant-marketing、ecommerce-video-marketing source 与 marketplace mirror `cmp` 一致。 | 不证明包已打包/安装或 ChatGPT 宿主加载；插件 source inputs 仍 dirty。 |
| 本轮最小回归新增收据 | 2026-10-10 本轮；定向运行 | `apps/api/src/mcp-customer-delivery-handlers.test.ts` 13/13、`apps/plugin/mcp/bridge-error-contract.test.ts` 14/14、`demo/merchant-studio/merchant-session-retry.browser.spec.js` 1/1、`apps/ops-console/src/components/support/SupportQueueSection.row-interaction.browser.test.tsx` 1/1、`visual-workflow-install-contract` 1/1；`tests/browser-gate-entrypoints.test.ts` **63/63**；新增 `SupportQueueSection.whitespace-validation.browser.test.tsx` **1/1**；完整 `npm run typecheck` **exit 0**。新增 Merchant session retry 与 Ops whitespace regression 均已有专用 script 并纳入 `test:browser:all`。 | 均为本地合同/fixture和类型检查；不证明真实 Demo 身份、租户业务、模型费用或插件宿主加载。Support 用例首次重测只确认模块响应 200 但 React mount 超时；补充 entry-executed/网络诊断后最终运行通过。 |
| 本轮继续：Merchant workspace A→B→A | 2026-10-10 06:07 UTC；artifact `artifacts/ops-jit-isolation/2026-10-10T06-07-06.082Z-147071c8-4b06-4187-be53-588d2fe68583/` | 第 19 次尝试通过（此前 18 次失败/超时）。浏览器结果验证 A→B→A、A/B 专属成员隔离、session/member 请求携带对应 workspaceId、切换后旧搜索/对话框清除，`pageErrors=[]`；Playwright 1/1、0 retry。fixture disposal 停止两个 run-owned 容器，`leftRunning=[]`、`externalContainersTouched=false`。 | 本机隔离 PostgreSQL/API/浏览器 fixture；不代表唯一 ECS Demo 的真实身份、RLS、业务数据或部署验收。 |
| 本轮继续：插件 bridge 窄回归与安全 runner | 2026-10-10 本轮；`tests/default-suite-pending.test.ts` 19/19；bridge 两条原失败用例分别 1/1 通过 | bridge 全文件先前收据为 160 项、158 passed、2 failed；根因为测试请求使用小数 JSON-RPC IDs，而 bridge 接受字符串或安全整数。修正三个 test IDs 后，仅重跑原失败的 `exposes standard discovery and forwards the scoped API envelope` 与 `binds the minimal image chooser to every archived clean catalog candidate result`，均通过。pending gate 支持 `-t`/`--testNamePattern`，按包含 suite ancestor 的名称过滤叶节点；选中的 skip/todo 仍失败；未匹配文件/叶不计入 filtered report。 | 未重跑完整 160 项 bridge suite，故不声称全套当前通过。报告仅覆盖两条失败用例和 gate 回归；本地 stdio fixture，不证明 ChatGPT 宿主加载、真实 API/relay 或生成计费。 |
| 本轮继续：worker 发布媒体生命周期回执 | 2026-10-10 本轮 | 首次全仓 `npm run typecheck` 报 `apps/worker/src/main.ts` 对未知回执字段访问错误；补充 persisted record 全租户/job/event/idempotency/platform/account/visual/role/hash 校验，以及非空 mediaId/URL 校验。新增 `apps/worker/src/worker.test.ts` 定向回归 1/1 通过；`npx tsc -p apps/worker/tsconfig.build.json --pretty false --noEmit` 通过。 | 修复后全仓 `npm run typecheck` 重跑被中断（exit 143），未取得全仓通过收据；其余已通过项目不重跑。真实平台上传/回执仍未在 Demo 验收。 |
| 271 PostgreSQL isolated run `artifacts/isolated-postgres/run-fQU7XZ/` | 较早尝试；Vitest 报告 184.77 秒 | 目标文件 `commercial-receipt-repository.postgres.test.ts` 的 3/3 项均在 60 秒超时；新增 preflight 用例未到达断言。runner 报告 `ISOLATED_POSTGRES_DISPOSAL_INCOMPLETE`。 | 这是失败的历史尝试；不要把它当作迁移通过证据。 |
| 271 PostgreSQL isolated run `artifacts/isolated-postgres/run-UOg9we/` | 2026-10-10 04:03 UTC | 独立 fixture 报告目标文件 3/3 passed、0 failed、0 pending；disposal 报告准确停止其两个 launcher-owned 容器，`leftRunning=[]`。 | 覆盖当前收款退回与租户隔离场景，不证明唯一 Demo 的 live migration chain，也不解除 demo 配置/审批门禁。 |
| 271 PostgreSQL isolated rerun `artifacts/isolated-postgres/run-UOg9we/` | 本轮；2026-10-10 03:59:54Z–04:03:11Z | 同一目标文件 3/3 passed（主现金退件旅程、NULL scope未决退件拒绝、缺余额拒绝及修复后同库重试）；manifest 标记 `fixtureOnly=true`、`sharedContainersTouched=false`、自身两容器已按 ID 停止。对首轮遗留的两个 ID 做只读 `docker ps -a --filter id=…` 查询无输出。该次命令发起者在当前协作记录中无法确认。 | 这是隔离 PostgreSQL migration 271 证据，不是 Demo live migration/数据验收。未对首轮遗留容器执行停止或删除。 |

## 解锁所需的最小新证据

1. Host/release owner 对唯一 `101 / merchant-demo-85575f9c` 提供新鲜只读 inventory 原始结果及 SHA-256，并对全部运行容器（含 Compose 项目外容器）逐项确认分类；owner 在绑定候选完整 SHA 的受保护任务单/审查记录中明确写明 `GO`、批准人和 UTC 时间。status 命令的 `release_approved=false` 是固定兼容标记，命令退出 0 不产生批准。
2. Host owner 提供无 secret 的受保护 Compose/env 来源标识与摘要，以及既有共享锁的 canonical path、owner/mode、逐级目录权限和所有 Demo Compose mutator 共用该锁的证据。
3. DB owner 提供 live migration 完整 `{version,name,checksum}` 链及当前实际基线，解释 257/258、既有归档 270 与当前源码 275 的差异。只有目标链与核实后的 live 链逐行一致，才可评估无 DDL 的组件候选；若需应用 271–275，必须另行批准迁移窗口，并提供受保护执行器、备份/隔离恢复、前向迁移及旧版兼容/恢复证据。migration 273 的隔离 PostgreSQL 通过不代表 Demo live chain 已到 273，更不证明新 migration 274/275 可安全应用。
4. 本地整合者在 `main` 形成 clean commit，从精确 SHA 构建，并绑定 archive/source、每个目标镜像 digest、Compose/env 摘要和回滚材料；逐项 semantic owner approval 绑定该 SHA。
5. 获准部署后，owner 记录当前候选的 `setup.mode=demo`、实际桌面登录/角色/租户与受影响业务读回；当前本地 stdio 插件完成宿主 reload/tool discovery，并对实际 MCP/模型请求核对 provider receipt、usage/cost 和账务结算。

本账本中的本地校验不能代替上述 host owner 证据；在这些门槛解除前，Demo 发布状态保持 **NO-GO**。

## 2026-10-10 追加的只读实机观察

本轮于 **2026-10-10 04:02 UTC** 通过 SSH alias `101` 读取 canonical host，并先确认 `yxsona.com`、`ops.yxsona.com` 的 A 记录与 `ssh -G 101` 的目标地址一致。没有部署、重启、写库或调用业务接口。

| 检查 | 当前观察 | 判定 |
| --- | --- | --- |
| `docker ps --filter name=merchant-demo-85575f9c` | 15 个匹配容器均为 `Up` 且标记 `healthy`；包括 api、api-replica、ops-ui、ui、workers、PostgreSQL、Redis、ClamAV 和 gateways。 | 仅证明容器健康，不证明候选 SHA、配置摘要、迁移链、租户权限或业务流程通过。 |
| `GET https://yxsona.com/api/healthz` | HTTP 200；`setup.mode=production`、`setup.productionControls.required=true`、`setup.productionGate=true`；模型中转配置 ready，embedding 因索引禁用和缺模型标记为 not ready。 | 与唯一 Demo runbook 要求的 `setup.mode=demo` 不一致，发布保持 NO-GO。健康 200 不解除此阻断。 |
| `GET https://ops.yxsona.com/healthz` | HTTP 200；返回与 API 相同的 setup/readiness 投影。 | 仍需真实 Ops 登录、角色/租户访问及业务读回；本检查没有登录或写业务数据。 |
| API 容器 `DEMO_RUNTIME_MODE` 环境项 | api 与 api-replica 的 Docker inspect 环境投影中均未设置该项。 | 与健康响应的 `production` 模式相符；需由发布 owner 按单 Demo runbook 修复受保护 Compose 候选并重新验证。当前工作树改动未部署。 |

以上是 2026-10-10 04:02 UTC 的历史 host 只读观察摘要，修正当时“缺少 10 月 10 日 host 实读”的旧状态描述；它不是当前 host 状态。独立原始 SSH/HTTP 命令输出、脱敏 inspect 投影及其 hash 未归档，因此不能独立复核摘要，也不能替代 owner 批准或签名 inventory。该观察没有核验 `release_approved`、全量容器 owner 分类、共享锁、配置归属或 DB 迁移链。健康端点当时显示 `setup.mode=production`；09:09 UTC 可复核健康响应见下文归档。上述观察不改变迁移历史、候选来源、逐项 owner 批准和业务验收仍缺失的结论。

## 2026-10-10 第二轮体验审查与回归

使用 PM dogfood、gstack review/design-review 清单和 CodeGraph 调用链审查了 Merchant Studio 商品导入/素材绑定/权益状态/登录恢复/工作区切换、插件本地登录、Ops 导航/用户风险操作/删除申请状态，以及任务队列交互。此次只使用本地 fixture；未访问真实商家数据、运营账号、模型中转或业务写接口。

本轮确定性修复：

- 商品批量导入后只对事实确认失败的商品提供重试，不重复导入；产品素材关联继续操作现在要求全部绑定素材存在、扫描通过且权益已批准，并显示阻断原因。
- 素材权益被拒绝或范围为 `unusable` 时，主操作指向重新确认权益；权益表单默认落在真实可选的修复值。
- 商品详情模块筛选加入 Tab roving focus、左右方向键和 Home/End 导航。
- Ops 浏览器 Back/前进后焦点回到主内容区；用户风险弹窗提供中文字段名和风险级别；删除申请列表区分未读取、无权限、错误与已读取空列表。
- 本地插件登录帮助支持包装器预先注入参数，安全错误会给出中文恢复建议；Merchant 登录页明确受控注册、会话过期和找运营处理的路径。
- OpenAPI 参数约束、Merchant 同源 cookie/workspace 测试合同已修正并与当前实现对齐。

验证记录：`npm run typecheck` exit 0；CodeGraph 同步完成，索引 2,939 个文件、39,965 nodes、158,804 edges，状态 up-to-date；`git diff --check HEAD` 通过。定向浏览器回归：Ops 导航 1/1、Ops 支持队列行交互 1/1、Merchant 素材入口正式脚本 6/6、任务队列 6/6、登录会话重试 1/1、人工店铺登记 1/1。商品/素材、OpenAPI 与 Merchant API 相关定向单测 39/39；用户风险、删除申请、素材状态、导入 helper 等另有定向回归通过。

Merchant workspace A→B→A 曾在早期尝试失败；最新第 19 次本地隔离 fixture 运行已通过，见上方收据。早期失败 artifact 保留作历史诊断，不能覆盖最新结果；最新结果也不代表唯一 ECS Demo 验收。

本轮继续处理插件 bridge 全文件历史 160 项中 2 个失败：修正非法小数测试 ID 后，仅重跑两个失败用例，均 1/1 通过。为使 targeted run 不被其余未匹配测试的 skip 误报，pending gate 改为按完整测试名筛选，且对匹配到的 skip/todo 继续 fail closed；`tests/default-suite-pending.test.ts` 19/19 通过。完整 bridge suite 未重跑，当前全文件通过状态仍未取得。

全仓 `npm test` 分片 runner 的诊断超时为 300 秒；前 3 个分片均在超时后退出，故 owner 停止了剩余分片。root run 中的失败不是全绿证据：OpenAPI 两处文档字段和 Merchant 测试切片合同已修正，定向用例通过；安全 E2E 仍有内存测试 fixture 未登记 workspace，以及 production memory adapter 缺少 `persistTaskGroup` 导致预期 `TASK_GROUP_PERSISTENCE_UNAVAILABLE` 的场景。不得放宽 fail-closed 生产门禁。该全仓结果不影响本账本的 Demo **NO-GO** 判定，也不证明所有 2,939 个文件逐一审阅完成。

## 2026-10-10 第三轮全栈交互与调用链复核

按用户要求启动 10 个并行角色，覆盖财务/商业、审计/事故/知识/规则、存储/客户交付、Merchant 发布/商品目录/知识、Ops 店铺自动同步/API、插件 MCP、模型计量。审查使用 PM dogfood、gstack review/design-review 检查维度和 CodeGraph 调用关系；测试串行执行以避免浏览器和 Vitest 资源互扰。CodeGraph 最终同步了 39 个变更文件，索引为 2,943 files、39,994 nodes、158,940 edges，状态 up-to-date。

本轮确定性修复：

- Ops 店铺页原先未挂载自动同步与店铺作用域选择面板；现在接入两者，策略保存携带单店范围与 `sync_enabled`，不可读/已撤销店铺不可选，未指定/未知范围 fail closed，并用 API 测试验证审计写入。
- 客户交付归档记录新增受授权的 `archived_only` 查询及页面归档列表/恢复入口；恢复要求更新权限并携带最新 revision，revision 冲突不自动覆盖。参数同步到 MCP schema 与 OpenAPI。
- Merchant 品牌偏好读取失败时不再把默认 JSON 当作可编辑草稿；显示失败/重试，读取未确定时禁用保存。
- Merchant 图片生成深链切换现在按 workspaceId + jobId 隔离任务状态、候选选择和异步响应，避免旧任务迟到响应串入新任务。
- Merchant 商品目录搜索和清空筛选会同步 URL `q`；刷新/分享后能还原筛选。
- 规则激活表单先校验可解析的审批时间；relay usage 解析跨已识别 envelope 校验 token、图片计数、成本与视频时长一致性，矛盾计量证据不进入 settlement sink。

本轮 owner 串行验证：`npm run typecheck` exit 0；相关 13 个 API/Ops 测试文件 223/223 通过；Merchant 导航与图片生成 job route state 21/21 通过；图片生成桌面浏览器套件 15/15 通过（含 A→B 迟到响应回归）；CodeGraph 状态 up-to-date；`git diff --check HEAD` 通过。角色级另有：审计/事故/知识/规则 53 项、Brand Preference/知识 62 项、Customer Delivery 与 MCP/OpenAPI 324 项、模型计量 132 项、插件 stdio/API 17 项、自动同步 Ops 47 项及 MCP handler 2 项通过。

范围和阻断：`npm run test:ops-console` 整体 Vitest 超过 4 分钟没有输出、主进程 CPU 为 0，owner 以 exit 130 中止；因此不报告 Ops Console 全套测试通过。此前 `npm test` 全仓分片也超出 300 秒超时；全仓类型检查这轮通过。Ops 真实账务、权限账号、跨租户业务读写、真实模型和唯一 Demo 的健康/部署仍未验证；没有访问生产或部署。工作树存在大量既有 dirty paths，本轮未提交。**本轮是大范围并行定向审查和修复，不表示每个页面、组件或全部代码文件均已逐项人工评审；Demo 仍为 NO-GO。**

## 2026-10-10 第四轮 API、成员治理、工作任务与发布路径复核

延续 10 角色并行覆盖，并复核共享 dirty diff。新增 CodeGraph 同步及 owner 的全仓 `npm run typecheck` exit 0；本轮同步前索引为 2,943 files、39,994 nodes、158,940 edges。最终 `git diff --check HEAD` 通过。

本轮修复：

- Ops Members revision 检查和重复邀请防护会遍历所有 offset 页；后续页读取失败、成员数变化、分页循环/异常时 fail closed。第 101 位成员和失败后不写入测试通过。
- Merchant 产品/SKU 更新的 `expected_version` 必须是非负安全整数，超范围不再被 JS 舍入后误报 409。
- Merchant 内容存在错误级审核项时提前禁用批准按钮，显示修复/复审指引；事件处理器也做阻断校验。
- Merchant 品牌范围数据读取期间禁用字段/启停/系列控件并显示等待状态；商品事实缺少来源或证明时禁用确认，服务端阻断会显示定向恢复及商品目录定位入口。
- API task mutation 对格式错误 `expected_version` 不再静默当作省略，错误返回 400；MCP task timeline limit 收紧到 1–200，同步 OpenAPI；补齐已有 HTTP answers 与 plan-confirm route 的文档契约。
- Sync progress 入口在终态/重复页快速返回前校验 items 结构；worker durable 恢复先检查整批 workspace 归属，避免跨租户批次部分入队。
- Batch import 幂等哈希的 key 排序改为 locale-independent code-point 顺序；插件 HTTP/OpenAPI parity 测试现在能解析 inline 和 block enum，并用真实破坏构造负例。

定向证据：成员 6 tests、商品/SKU MCP 7 tests、Merchant content approval 2 tests、Merchant brand/fact 与相关组件 38 tests、API task/contracts/OpenAPI 83 tests、worker/sync 62 tests、persistence 35 tests、Ops overview/tasks/incidents 54 tests、MCP HTTP parity 5 tests、MCP param parity 14 tests、stdio discovery 1 test 均通过。另以 `VITE_API_BASE_URL=/api` 的本地 Merchant Studio 页面、API 拦截 fixture 串行运行规则页桌面浏览器测试 1/1 通过（直接运行脚本而未启动 Vite 时因 `apiBaseUrl` 缺失失败，补齐本地配置后通过）。插件完整 `bridge.test.ts` 两次在无摘要状态分别等待约 4 分钟和 1 分钟后停止；不报告为通过。generation/sync e2e setup 卡住，sync e2e 7 项 skip，不报告通过。发布执行在媒体上传后取消/校验拒绝仍可能产生 orphan media；生产 connector 未注入删除适配器或持久 orphan sink，本轮只记录缺口，没有制造无耐久证据的表面清理。

覆盖仍未穷尽：CodeGraph 当前识别约 2,943 个全仓文件，Ops 与 Merchant 前端 TS/JS 清单共 606 个；本轮为关键链路的并行审查和定向修复，不能声称每页、每组件及每个代码文件均已逐项人工评审。Ops 真实角色/租户访问、账务、真实模型、ChatGPT 宿主链路和唯一 Demo 运行态仍未验证；未部署。Demo **NO-GO** 判定不变。

## 2026-10-10 第五轮 Ops 导航与发布媒体恢复复核

依照用户要求启动 10 个并行角色，分工覆盖 Ops 访问与表单导航、发布媒体生命周期、API/OpenAPI、商品目录、Merchant 交付面板、插件本地安装、持久层/RLS 与 worker 扫描。使用 PM dogfood/gstack 检查维度与 CodeGraph 追踪关键调用链；CodeGraph 同步了 30 个变更文件，索引报告为 2,957 个文件、40,138 个节点、159,420 条边。新增测试文件可在索引中查询；索引仍显示 1 个待纳入文件，未将其标记为完全 up-to-date。

本轮修复：

- Ops 表单注册改用每个表单独立 ID 并在卸载时清理，避免同名表单互相覆盖或卸载后留下过期脏状态。
- Ops 侧栏、查询深链和浏览器 Back/Forward 经过统一的未保存内容确认；取消保留原路由和草稿，确认展示受影响表单标签并继续导航。工作台历史 entry 保留索引，支持取消历史导航后回到原 entry。
- AccessDenied 权限说明区分“服务端明确返回空能力集”与“能力投影未知”，避免把未知误报为当前用户未获任何权限。
- Merchant 交付准备页的刷新操作复用错误重试的焦点恢复流程。
- 发布媒体上传现有 workspace scoped 的生命周期记录：上传前写 intent、得到 receipt 后立刻记录；平台写入开始后只标记 retained/unknown；写入前失败只有 connector 明确确认删除才记录 deleted，否则保留待人工恢复状态。worker 复用现有签名方式读取/回传回执；intent/unknown 重试 fail closed。源码 migration 272 使用强制 RLS、任务与 job/event 复合外键、幂等唯一键和 append-only 事件表，并限制 merchant_app ACL；这是候选源码/隔离 fixture 证据，不证明唯一 Demo live DB 已运行到 272。
- OpenAPI 补齐 9 个 identity HTTP 操作的输入、响应和认证契约；本地插件 source 与 mirror 的登录脚本差异已同步。

Owner 验证：`npm run typecheck` exit 0；`git diff --check HEAD` 通过。定向 Vitest：媒体 API route/runtime/repository 3 文件 21/21；迁移与 repository 2 文件 19/19；Ops 表单上下文和 Controller 2 文件 18/18。Ops Chromium 浏览器回归 2/2，覆盖侧栏/query 的取消与确认以及 Back/Forward 取消恢复。隔离 PostgreSQL 单文件 1/1 通过，使用仓库隔离 runner 实际运行 migration 1–272，并验证 workspace RLS、receipt 幂等和 unknown 状态禁止删除；原始报告为 `artifacts/isolated-postgres/run-XOMe86/vitest.json`。API/OpenAPI 另有 27 项通过；商品目录 30 项、worker scan 168 项、插件本地安装/profile 27 项、交付焦点恢复 3 项由相应角色执行。worker readiness test 中期待旧 migration 271 的两条断言已更新为当前完整链 272，随后 `apps/worker/src/worker.test.ts` 124/124 通过。所有浏览器临时 fixture 已清理。

边界：平台 connector 仍没有可用的生产媒体删除适配器，待人工恢复不等于自动清理；本轮没有真实平台发布、真实 Ops 账号验证或 demo 环境验收。全局全仓测试未运行，先前卡住的套件不计通过。工作树保留大量并行 dirty paths，未重置、清理或提交。唯一 Demo 的发布仍为 **NO-GO**；本轮工作也不代表所有页面、组件或全仓代码文件已经逐项完成人工评审。

## 2026-10-10 第六轮待验证缺口处理

10 个并行只读角色完成 API/租户、Ops、Merchant、插件、worker 媒体、迁移链和 Demo 发布门禁复核。Owner 修正了发布媒体生命周期中的一条错误归类：仅在持久化 `intent` 成功且即将调用平台上传后，才将该媒体列入“上传结果可能未知”；读取既有 receipt、写 intent 失败或尚未轮到的媒体不再被错误写成 `unknown`。新增对应回归用例。

本轮当前验证结果：包含迁移 272 期望、Demo 候选链拒绝、pending gate 和客户交付拒绝写副作用的定向测试 7 文件 88/88 通过；`packages/application/src/connector-runtime.test.ts` 18/18 通过；`packages/application` TypeScript 项目检查 exit 0。另只运行 API 回执 URL 新增回归：1/1 通过、同文件其余 2 项按 `-t` 过滤跳过；确认空白 URL 返回 400 且不持久化。最终 `git diff --check HEAD` 通过。其他排队测试由此前启动的测试任务持锁执行，本轮没有移除或覆盖锁。

迁移源码终点为 272；10 月 10 日 host 摘要没有核验真实数据库迁移链，故 Demo live baseline 仍为未知。未完成唯一 Demo 的批准 inventory、全容器 owner 分类、共享锁、候选 SHA 冻结、ChatGPT host reload、真实模型用量/成本及归档证据；仍禁止部署，Demo **NO-GO**。

## 2026-10-10 第七轮页面域体验与交互复核

按用户要求组织 10 个并行角色（owner + 9 个页面域角色），使用 PM dogfood/gstack 的表单、筛选、空态、错误恢复、键盘操作和权限检查维度，并通过 CodeGraph 追踪调用链。角色覆盖 Ops 财务/存储、用户/成员/授权、任务/知识/规则、支持/事故/审计，以及 Merchant 商品目录/导入、素材权益、购买/工作区、任务/发布和 API/MCP 插件契约。

本轮确定性修改：

- Ops 存储对账错误页移除重复的错误与重试区域；筛选平台变化会清除不兼容店铺并收窄店铺选项。
- Ops JIT 授权列表刷新时清空旧 revision；签发/撤销再次核验当前权限、目标和 revision，避免旧快照操作。
- Merchant 购买恢复状态按活动工作区隔离，迟到响应不能覆盖新工作区；单工作区旧记录可迁移，多工作区旧记录归属不明时阻止新购/升级/付款并提示核验。
- 素材权益 UI 根据受限 scope 生成 usage scope，避免把 internal-only/limited-use 误表示为通用商用/AI 权益；应用服务拒绝 internal-only 任务素材并拒绝冲突权益写入。
- 任务队列平台/店铺筛选联动修复；Campaign 超时后同一操作重试复用幂等键；工单重试复用相同意图键；公共规则增加可聚焦的详情操作。
- 财务页将当前 workspace 传入商业中心并按账号/工作区重建状态。

角色级回归：Ops Finance/Storage 9 文件 52 tests、Storage Chromium 1/1；Ops 授权 8 文件 67 tests（含隔离 Chromium）；Ops Tasks/Knowledge/Rules 目标文件 61 tests、局部 fixture 8/8 和筛选 helper 5/5；Merchant 购买隔离 4 文件 36 tests；Merchant 素材权益 helper 8/8；Merchant 商品目录/深链/导入浏览器 fixture 6 项通过，相关单测 47 项通过；Campaign/规则/队列相关单测 42 项通过，Campaign Chromium 重试 1/1；API/MCP bridge/parity 23 项及 first-use stdio→API fixture 3 项通过；应用服务素材权益用例所属 `service.test.ts` 185/185 通过。Support 两个浏览器 fixture 等待列表行/页面加载超时，所在定向测试批次其余 10 文件 44 tests 通过；Finance 搜索已有 Chromium 用例也因 10 秒内没有出现筛选按钮失败，均不能计作浏览器通过。插件 `install-smoke.test.ts` 超过 safe runner 300 秒上限；部分输出报告 29 项中的 4 项失败，但无完整摘要，原因待单独复跑。没有真实租户、平台账号、购买或业务数据写入。

Owner `git diff --check HEAD` 通过；首次全局 `npm run typecheck` 暴露筛选测试 fixture 泛型收窄问题，修正后重新运行全局检查 exit 0（packages 构建、project references、Ops Console、Merchant Studio 均通过）。`filterClear.test.ts` 修正后 5/5 通过。共享工作树仍保留大量既有 dirty paths，本轮没有清理、提交或部署。Support/Finance 超时、install-smoke 未决、旧 AssetLibrary 权益弹窗当前无可达调用者、真实 API/RLS/模型和 Demo 运行态都仍是缺口。一次页面域并行复核不等于全项目每个页面、组件、按钮或每个代码文件都已逐项审完；唯一 Demo 仍为 **NO-GO**。

## 2026-10-10 第八轮插件打包与未决授权回归

按用户要求并行协作 10 个角色（owner + 9 个只读 agent），复核 Demo 发布门禁、插件宿主、媒体恢复、API/租户、Merchant 与 Ops 未覆盖流程、测试队列及媒体技能。复核没有发现可解除 Demo NO-GO 的新运行证据；迁移 live baseline 仍未知，ChatGPT 当前宿主也没有绑定到本地候选版本。

本轮修复与结果：

- 新增插件内 `ecommerce-image-workflow` 入口，明确规划与生成分流、商品身份锁定和按需查询 MCP 工具；实际媒体仍只能走 Store Nova MCP、relay、权限/成本/扫描/归档门禁。浏览了 Amazon product photography、open-design ecommerce-image-workflow 与 Riffkit 的公开技能：前者包含强制 Nexscope 导流，open-design 要求直接生成本地图片/manifest/gallery，Riffkit 要求第三方 CLI/API 与服务积分，因此没有原样安装或接入这些外部 provider。只采纳通用策划思路并改写为 Store Nova 工作流。
- 本地包脚本使用显式技能文件 allowlist，遗漏了新增图片入口。修复 `package-local-plugin.mjs` 后，macOS bundle/package 目标回归 1/1 通过，tar 清单确实包含新技能。
- 随后对本地 marketplace source mirror 做验收时，发现 mirror 的 `package-local-plugin.mjs` 仍是旧字节，安装器按同版本内容不可变规则正确拒绝安装。已同步 allowlist、登记 `pluginSkillMirrors` 并更新受控本地镜像。release-manifest mirror 约束 1/1 通过；镜像安装测试从 30 秒 harness timeout 调整到 180 秒（安装器内部 helper 上限 120 秒），随后精确目标 1/1 通过。
- install-smoke 最近一次全文件运行报告 27/29 通过：图片技能打包遗漏和隔离 QA 安装子进程超时是两个失败。修复打包清单后，仅重跑上述两个失败项，各 1/1 通过；合并逐项收据为 29 个场景均已通过，但没有再次运行一次完整文件套件。安装子进程 outer timeout 调整到大于 helper 120 秒内部预算。
- 媒体清理适配器调用前先持久化 `orphaned`，避免已删除但第二次状态写入失败后仍留下可复用 `uploaded` 回执；删除适配器抛错会写入固定原因码，不泄漏错误原文且保留原始发布拒绝。新增独立回归与已有预写失败回归定向运行 2/2；`packages/application` TypeScript 检查 exit 0。
- 客户交付授权拒绝测试现在以商家令牌所属工作区为目标，证明拒绝来自 platform-only 方法权限而非跨租户 mismatch；仅运行新增覆盖的用例，1/1 通过、同文件其余 9 项按名称过滤跳过。
- `git diff --check HEAD` 再次通过。源码及本地 source mirror 中新增图片入口已打包验证，但由于当前候选仍是共享 dirty worktree，没有更新个人 ChatGPT 插件缓存或启动新宿主会话；不能报告宿主已加载新版本。
- 两个 Support 目标 fixture 在当前组件改动后定向复验 2/2；`git diff --check HEAD` 最新检查通过。它们仍是本地 Chromium fixture，不构成真实 Ops 授权或 Demo 验收。
- Finance stale-snapshot 浏览器回归 1/1 通过；它覆盖失败后旧快照标识与禁止导出，不覆盖先前“高级筛选按钮未出现”的手动交互失败，后者仍需准确复现。Support 页面交互和错误态的两个最可能对应 fixture（队列行复制/打开、页面单一错误及刷新入口）当前源码定向复验 2/2；历史摘要没有保留失败文件名，因此无法证明它们与历史超时一一相同，但当前对应交互没有复现超时。

2026-10-10 新鲜只读 healthz 结果归档于 [`artifacts/demo-health-readonly/20261010T065232Z`](../../artifacts/demo-health-readonly/20261010T065232Z)：两个域名均 HTTP 200，API/Redis/Postgres readiness 显示 ready，`writesEnabled=false`，但 `setup.mode=production`。JSON 原文及 SHA-256 在该目录，故仍不满足唯一 Demo 的 demo 模式要求。该探针不读取审批 inventory、容器 owner 分类、共享锁或 DB migration chain，亦不证明 UI/租户/模型业务通过。

本轮工作树维持大量共享 dirty paths，未提交、未直装到 ChatGPT 宿主、未部署。orphan 运维列表/恢复界面、真实 ChatGPT host reload 与 provider 用量/成本/归档闭环、Finance 高级筛选在真实页面上的浏览器复现、唯一 Demo 的 owner 和 DB 证据仍未完成。Demo **NO-GO**。

## 2026-10-10 第九轮页面交互与恢复路径复核

按用户要求继续用 10 个角色（owner + 9 个页面域角色）检查 Merchant 与 Ops 桌面页面。使用 PM dogfood/gstack 维度复核表单、权限、下一步入口、错误提示、重试、焦点、深链和工作区边界；使用 CodeGraph 追踪素材权益、图片候选、Support/Audit/Incidents、Models、Knowledge、Stores 与规则同步调用链。工作树沿用既有 `main` checkout 和大量 dirty paths，没有重置、清理、提交或部署。

本轮修复：

- Merchant 图片候选成功提交后，旧任务页仍允许改选和再次提交。成功态现锁定候选 checkbox、原因输入和再次提交，并在 handler 增加早退保护；进入新版本审核入口仍保留。缺陷先由专属 Chromium 用例复现，修复后单项 1/1 通过。完整图片生成浏览器套件在修复前 15/15；修复后只重跑了该单项。
- Merchant 素材权益入口现覆盖真实可见的 MaterialLibraryWorkspace。服务端拒绝在 `internal_only`/`limited_use` scope 下写入通用商用或 AI 生成范围；受限选择器限制为保留/收窄；修正已批准的 restricted scope 投影被事实确认动作遮挡的问题。相关投影和权益用例 10/10，单 Chromium 保存拒绝/重试/GET 回读 1/1，Merchant Studio TS 检查通过。
- Merchant 登录与首次 workspace bootstrap 增加提交期间禁用、workspace 名称自动聚焦；浏览器覆盖登录失败与恢复、bootstrap 503 与重试，1/1；相关 Vitest 6/6。
- Merchant 交付准备错误文案与错误恢复修正，Chromium 1/1、相关单测 7/7。
- Ops Models 页新增“查看平台总览”可点击入口，模型单测 4/4，Chromium 1/1。Knowledge 学习建议确认增加 single-flight，组件及页面测试 11/11；但当前 Ops 路由权限策略明确阻止 `/ops/knowledge?workbench=workspace`，审批页面旅程在本控制台无法验收，页面归属仍需产品判断。
- Ops Support 删除页面/队列重复错误块，并统一错误重试说明。页面浏览器回归 1/1，页面单测 2/2。Incidents/Audit/Support 定向浏览器矩阵 9 文件 11 tests 中 8 通过、3 失败：Support whitespace fixture 在 mount 前未建立 root；Audit 导出截断等待标题超时；另一个 Support locator 的超时已调整并单项通过。Audit 相关单测通过（Page 4、Center 10、Filters 2），导出专项单项重跑 2/2。
- Ops Stores 撤权失败会在确认框展示错误并保留目标。浏览器断言已证明错误提示和目标保留；隔离 BrowserContext 后整文件出现两次 2/2、一次重试按钮可见性超时，失败时诊断看到按钮可见且未禁用，尚无法将不稳定归因于产品缺陷或稳定排除 harness 问题。
- Finance 套餐事实读取 503 后提供刷新恢复；隔离浏览器 1/1，验证 workspace header、成功恢复、不创建订单或付款。
- Rules sync 错误可留在页面并重试；本轮单测 fixture 增补 promise 透传断言。

Owner 运行 `packages/application/src/service.test.ts` 186/186 通过，`git diff --check HEAD` 通过。API `product-image-review.e2e.test.ts` 两次运行均卡在 `beforeAll` 动态导入服务：分别 30 秒和 60 秒超时，11 个断言全部 skip；不能计作 API 回归通过。新增投影测试 fixture 的必需字段和类型已修复，随后全局 `npm run typecheck` 被重复启动造成执行结果未能由工具完整回传，故不声称全局 typecheck 通过；需用单一进程重跑并拿到 exit code。CodeGraph 当前同步后为 2,975 files、40,281 nodes、159,809 edges，仍有 1 个新增文件 pending，需再同步一次。

UI 页面清单已更新在 [`ui-page-coverage-inventory-2026-10-10.md`](ui-page-coverage-inventory-2026-10-10.md)。本轮仍是本地隔离 fixture，不是真实租户/生产模型/唯一 Demo 运行验收；未进行容器健康检查或部署。页面矩阵仍有明确失败、缺少路由级旅程与 API 初始化超时；不代表全项目每页、每组件、每个按钮或所有代码文件已逐项完成审查。唯一 Demo **NO-GO**。

## 2026-10-10 第九轮提交后回归与 Demo 门禁复核

用户要求先提交，再继续修复、验证和部署。本轮在 `main` 连续形成三个窄提交：`99715416` 新增 Store Nova 安全路由的商品图片技能并纳入源/marketplace 镜像与本地打包清单；`151072d1` 增加 Finance 高级筛选显示与展开的 Chromium 覆盖；`0bb86b02` 增加 Merchant 商品目录翻页后组合搜索/日期筛选的回归场景。

本轮新验证收据：

- `tests/release-manifest-gate.test.ts` 15/15 通过，覆盖插件源/marketplace 内容镜像和候选 artifact 绑定。
- `apps/plugin/install-smoke.test.ts` 29/29 通过，实际打包和本地安装 smoke 通过。此结果来自当前共享工作树，当前 ChatGPT 宿主尚未刷新，因此不代表宿主已加载该版本。
- `FinanceSearchSection.advanced-filter.browser.test.tsx` 1/1 通过：权限已提供的组件 harness 能找到“高级筛选”、展开后可见两个筛选控件。历史超时记录没有保留原 spec、locator 或截图；当前用例不覆盖完整 Ops Finance 页面权限投影，也不证明高级筛选参数成功提交。早期针对该新 fixture 的多次失败均是控件选择器/表单夹具问题，最终收据仅覆盖按钮显示和展开。
- `catalog-search-filters.browser.spec.js` 1/1 通过：从第 2 页切换为商品搜索并加近 7 天筛选后，结果正确交集显示且页码回到第 1 页。
- 发布媒体回执 API 与内存仓储定向回归合计 7/7；修正后的 API route 用例 4/4。隔离 PostgreSQL 的 migration 272 / RLS 用例 1/1，覆盖 `deleted` 必须基于既有上传回执、回执必须匹配、且原因为 `discard_adapter_confirmed_delete`。该签名 worker reason 是内部 worker 的受限声明，不是第三方平台独立删除凭证；平台删除查询证据与 Ops orphan 恢复/认领入口仍缺。
- `git diff --check HEAD` 通过。一个全局 `npm run typecheck` 进程由先前工作发起，观察到它运行中但未取得最终退出码，故本轮不记全局类型检查通过。

2026-10-10 07:28 UTC 曾通过固定 101 只读 inventory 脚本采样：摘要记录覆盖 94 个容器，79 个仍被分类为未分类外部 consumer，并出现预期服务重复、非运行或不健康项。该脚本明确是 inventory-only、`release_approved=false`，不构成部署批准；本次未归档原始 inventory。随后 healthz 的 HTTP 200/production 摘要也没有 07:28 原始响应归档；它已由下文 09:09 UTC 可复核的 healthz artifact 更新。09:09 响应仍显示 `setup.mode=production`、`writesEnabled=false`，与唯一 Demo runbook 所需 `demo` 模式不符。

Demo 仍为 **NO-GO，未进行同步、构建、重启、迁移或部署**。此外，数据库 owner 尚未提供 live `{version,name,checksum}` 迁移全链，host owner 尚未提供容器归属与共享锁证据；当前工作树仍有大量未提交改动，不能构建候选。缺少对应 host/DB owner 证据时，不能用本地隔离 PG、HTTP 200 或静态代码替代 Demo 运行态验收。真实 ChatGPT host reload、真实 API/RLS 租户读写、provider 请求回执/usage/cost/结算/归档及媒体人工恢复流程也未验收。

## 2026-10-10 第十轮未决回归与插件版本核对

本轮以 10 个并行角色（owner + 9 个角色）复核尚未通过或没有明确收据的路径；没有重跑账本中已通过的 catalog 组合筛选、Finance 控件显隐、manifest gate 或 install-smoke，除非当前候选版本变更会使原收据失效。

- Merchant 全局商品搜索新增 `q` 深链直达并刷新恢复 fixture，定向 Chromium 测试 **1/1 通过**。该测试依赖尚未提交的 `App.tsx` 与 `navigation.ts` 商品详情深链行为，不能作为 test-only 提交；此前文件内其他深链及跨店场景没有重跑。
- Ops `StoresPage` 品牌绑定新增隔离浏览器用例。成功路径首轮 **1/1 通过**，覆盖 workspace header、品牌 revision、RPC 参数及成功刷新。409 场景首轮只因读取 Ant Design 隐藏 input 的断言失败，已改为检查可见选择器文本；修正后的共享 Vitest 执行缺少可归因的输出，当前不记通过。该新测试未修改产品代码。
- Customer Delivery PostgreSQL RLS 新增测试的隔离运行未到达断言：`artifacts/isolated-postgres/run-3JKfvH/run-result.json` 记录唯一断言 skipped、0 passed，runner 因跳过断言拒绝该次运行。执行报告没有收集到完整 hook 错误；运行 agent 观察到 `beforeAll` 在创建临时数据库时连接断开。隔离容器 disposal 产物只记录通用身份核验/精确停止失败，不能确认具体环节；随后 Colima socket 启动返回 `context canceled`。未手动清理容器。此项不是 RLS 通过，也不能把 API 授权用例当作数据库 RLS 证据。
- 本轮另一组 publish-media PostgreSQL 测试在容器启动阶段超时，见 `artifacts/isolated-postgres/run-tB2Ua1/run-result.json`；其结果不代表 SQL 断言失败。之前 migration 272 隔离测试曾有 1/1 通过收据，但本次 fixture 故障没有新收据。
- 插件元数据发现版本 `0.1.0+codex.20261010030424` 已被禁用的 merchant-local cache 使用，而该 cache 不含新增图片技能。此前候选 `0.1.0+codex.20261010154450` 的 bridge 字节在版本标记后继续变化，可能触发不可变版本内容碰撞；本轮已将 source、marketplace 两端及 release metadata 统一升级到新候选版本 `0.1.0+codex.20261010170000`。该候选仍是 dirty source，尚未构建或安装；当前启用的 personal cache 仍是旧版本，ChatGPT 宿主未安装/加载候选技能。
- worker 的正常清理逻辑仅在 adapter 返回 `deleted: true` 时记录删除；失败维持 orphan。但签名 worker 可以直接提交相同上传回执和固定 reason，仓储/API 仍无法证明平台确实删除。固定 reason 是 worker 声明，不能当作独立 provider 删除证据；生产环境也没有已证实的媒体删除适配器注入。
- 视频请求、relay、异步 usage/cost 结算、隔离归档与扫描有 mock/fixture 合同覆盖；当前没有唯一 Demo 的真实 provider 请求、结算、clean scan、归档与下载证据。Merchant Studio 缺少视频播放/抽帧的成片验收表面，因此不能声称视频内容、时长或商品保真已通过。

以上段落是当时的历史快照，不代表当前执行状态。快照记录全局 `npm run typecheck` 正在执行、没有 exit code，以及当时约 284 条 dirty/untracked 路径；后续工作树和进程均有变化。Merchant 深链测试依赖当时混合在 `App.tsx` 的未提交改动；该快照没有创建可部署候选或进行提交/部署。

Demo 继续 **NO-GO**：没有新鲜、原始的全容器 owner 分类与 host/release 批准，没有共享锁证明，没有两 API 副本 `setup.mode=demo` 证据，也没有 Demo live 全迁移链。任何这些门禁都不能由本地 fixture、类型检查或插件打包测试替代。

## Follow-up regression batch (2026-10-10, after `0b542a13`)

- Global `npm run typecheck` completed with exit code 0 before the final browser-fixture-only assertion adjustments. `git diff --check` is clean.
- Focused API, application, persistence, worker, plugin contract, migration metadata, candidate-gate and browser-entrypoint suite passed: 10 files / 185 tests. This includes 136 API customer-delivery validation cases, 54 demo candidate gate cases, connector receipt validation, and in-memory lifecycle concurrency.
- Customer Delivery restore browser regression passed 1/1. Merchant product asset rights tests passed 11/11. Plugin source/marketplace smoke and release profile contract passed in an earlier focused run (63 tests total).
- A broader Ops browser/component batch passed 4 files / 143 tests and failed 3 browser assertions: Finance advanced-filter submission did not observe the expected call, Support error dismissal was blocked by a visible modal overlay, and assisted-purchase modal was not found by its accessible-name selector. Fixture assertions were adjusted afterward, but reruns ended with exit code 130 before results; these three scenarios remain unverified. Do not count the assertion adjustments as passing coverage.
- Isolated PostgreSQL fixture startup timed out before migration 273 SQL execution. The new forward migration has source-level/migration metadata coverage only; its database execution remains unverified.
- Current source migration head is 273. Live Demo migration chain, owner inventory/classification, shared-lock ownership, and required `setup.mode=demo` remain unverified or blocked by previously recorded host evidence. No deployment or container mutation was performed; unique Demo remains **NO-GO**.
- Browser coverage remains selective and does not establish that every route, component, or code file passed. The three failed/unverified Ops browser journeys and PostgreSQL startup limitation must be resolved before claiming full acceptance.

## 2026-10-10 第九轮页面交互复核（进行中）

按用户要求以 10 个角色（owner + 9 个页面域）并行复核，并使用 PM dogfood/gstack 维度和 CodeGraph 调用关系定位影响面。CodeGraph 在本轮增量同步后报告 2,980 files、40,758 nodes、160,274 edges，`pendingChanges=0`、`worktreeMismatch=null`。索引只证明结构关系，不能替代运行验收或逐行人工审阅。

当前确认的改进：

- API/MCP 本地素材上传拒绝 0 字节文件，避免无效 API 请求，并给出输入错误提示。
- 商品人工导入明确素材来源/代上传原因；列表刷新后禁用不适用的提交，提交期间禁用刷新；模板错误显示在页面。
- 商家登录状态探测期间增加可访问的等待提示，说明账号输入暂不可用。
- Ops Models 只读用户不能填写商业配置变更理由。
- Support 工单错误提示可真正关闭；重开操作或错误变化后再展示新提示。
- Finance 高级筛选补充 workspace、类型、状态、关键词同时提交的浏览器旅程。
- Merchant TaskWorkspace 列表读取失败时保留最后成功数据并提示当前快照可能过期；PublishHistory 同样保留列表与聚焦详情并提供重试。
- 补充待付款代购创建旅程，断言不会触发支付；此测试尚未通过定位器复核。

验证收据及限制：插件 MCP 0 字节上传 1/1、商品导入单测 1/1、Models 4/4、Support 详情 6/6、TaskWorkspace 搜索 3/3、登录/工作区定向单测 18/18（新增登录状态文本 5/5）已由角色报告通过。Finance 高级筛选提交浏览器场景没有可归因的新通过收据；上一次可归因运行在提交动作断言失败，后续修正的 root run 被取消，不能记为 2/2 通过。Support status-controls 在测试初始挂载期间找不到按钮，代购旅程找不到确认弹窗，随后分别增加诊断/等待和精确标题定位，但最新修订仍未获成功浏览器收据。一次 PublishHistory 浏览器尝试遭遇并发过载并失败，不能作为产品结论；登录与任务队列浏览器的新断言亦尚未取得完整收据。Merchant Studio scoped TypeScript 检查先发现 `App.tsx` 条件 JSX 缺少 `{`，owner 已修正；随后又发现 PublishHistory 快照判空类型错误并修正。修正后的 `npx tsc -p demo/merchant-studio/tsconfig.json --pretty false --noEmit` exit 0。`git diff --check HEAD` 已通过；本轮 CodeGraph 已同步（pending changes 0，unresolved refs 6,685）。

工作树仍包含并行修改与未提交文件；旧 safe-runner stdout 无法恢复，不能为其没有 owner session 收据的 suite 记为通过。真实 Demo、真实商家权限与租户、真实平台写入、模型用量/成本、插件宿主加载均未在本轮验收；没有部署。各域页面和全仓代码文件仍未逐个完成审阅，Demo 保持 **NO-GO**。

## 2026-10-10 当时的回归收据与 Demo 门禁状态（历史快照；已由 09:09 UTC 增量更新）

以下记录补充并 supersede 本文较早的“插件安装/manifest 尚待测试”“migration 273 SQL 未验证”与 Finance 高级筛选“2/2 通过”状态。当前目录在 **2026-10-10 16:46 CST** 核对时处于 `main`，HEAD 为 `fe30eb504d267f2e1b7e74d1d6214f6cca00773a`，`git status --short` 显示 **35 条**未提交/未跟踪路径（含本 QA 报告与并行修改）；此工作树不是 clean/frozen deployment candidate。路径计数是该次观察的快照，不代表之后的实时计数。

本轮可归因的本地回归：

- Owner 汇报的串行 safe-runner 批次为 **13 files / 192 tests passed**；该批包括 `tests/release-manifest-gate.test.ts`、`apps/plugin/install-smoke.test.ts`、marketplace `install-smoke.test.ts`、`apps/plugin/scripts/package-release-profile-contract.test.ts`，以及 API、application、persistence、worker、Merchant 和 Ops 定向用例。此收据更新了本节前“release-manifest/install-smoke 待执行”的状态；它是共享 dirty worktree 的本地测试，不代表新 ChatGPT 会话已加载插件，也没有绑定一个已冻结的部署 SHA。
- `npm run test:postgres:isolated packages/persistence/src/publish-media-orphan-repository.postgres.test.ts` 的 run `f27a423d-830e-47df-b9f8-9b83e6d2a368` 于 2026-10-10 08:28:16–08:29:17 UTC 执行，退出码 0；Vitest **1/1 passed**，测试确认 migration head 为 273，并覆盖 publish-media workspace/job/event、回执与生命周期约束。结果和容器自动处置收据见 [`run-result.json`](../../artifacts/isolated-postgres/run-6jDVs3/run-result.json)、[`vitest.json`](../../artifacts/isolated-postgres/run-6jDVs3/vitest.json) 与 [`fixture-disposal`](../../artifacts/isolated-postgres/run-6jDVs3/fixture-disposal-f27a423d-830e-47df-b9f8-9b83e6d2a368.json)：两个本次 fixture 容器均停止，`leftRunning=[]`，未触碰外部容器。当前 `PERSISTENCE_RELEASE_DATABASE_URL` 未配置；此测试使用 runner 新建的隔离 fixture。它验证了本地 273 SQL 执行，不证明 Demo live migration chain。
- 最近一次全局 `npm run typecheck` 的可确认通过收据早于这些最终源/测试修改；本轮无新的全仓 typecheck exit code。上述 13 文件测试汇总也不替代类型检查收据。
- Finance 高级筛选提交、Support 状态/错误提示交互和 Assisted Purchase 待付款创建的浏览器场景仍为 **未验证**：已有可归因失败或没有修订后通过收据。Finance stale-snapshot 测试的通过结果覆盖另一条恢复路径，不代表高级筛选提交成功。不得把取消或无法归因的 runner 输出记为通过。
- 此前 13 files / 192 tests 批次包含 install-smoke 与 release manifest 合同测试；本轮版本号已统一为 `0.1.0+codex.20261010170000`，并新增版本一致性断言，但该版本变更和断言尚未重跑测试。尚无该版本的 package archive、bundle digest/provenance 或安装收据。没有本地 ChatGPT 宿主 reload/tool discovery 证据。真实 provider 请求、usage/cost/结算及视频成片播放/内容验收也未在本轮完成。

在此历史快照时，Demo 发布门禁为 **NO-GO，不得部署**。当时记录的 07:28 inventory 摘要为 94 个容器中 79 个未分类、`release_approved=false`，但没有原始 inventory artifact；当时 healthz 摘要也没有对应原始响应。当前可复核的 healthz 与 inventory 状态见下文 09:09 UTC 增量。此历史快照时没有精确干净 SHA 的候选 archive、镜像 digest、Compose/env 摘要、owner approval 与回滚材料，也没有唯一 Demo 的桌面权限/租户业务读回与真实 MCP/模型账单验收；不得把隔离 PostgreSQL 与本地 UI/插件测试视为这些门禁证据。

## 2026-10-10 migration 274 增量与门禁复核（当时快照；目标链现为 275）

记录该段时的源码 metadata 为 `sourceMigrationVersion=270`、`expectedMigrationVersion=274`；此值已被下文 09:09 UTC 的候选增量 supersede。新增 `packages/persistence/src/migrations/274_unverified_publish_media_deletion.sql` 与 `packages/persistence/src/publish-media-lifecycle-migration.postgres.test.ts` 当时尚处于未提交工作树。migration 274 将既有 `deleted` 状态记录降为 `orphaned` 并追加恢复事件，同时禁止后续未经独立 provider 证据的 `deleted` 状态；SQL 包含 legacy receipt preflight 和 `row_security=off`，要求迁移执行器具备受保护的 BYPASSRLS/superuser 权限。该迁移会修改既有业务行，不能按无 DDL 快速更新处理。

Owner 当时报告 `publish-media-lifecycle-migration.postgres.test.ts` 与更新后的 `publish-media-orphan-repository.postgres.test.ts` 正在排队/执行；该时点尚无可归因的 run artifact、Vitest 汇总或 exit code，不记为通过。已通过的 migration 273 PostgreSQL run `f27a423d-830e-47df-b9f8-9b83e6d2a368` 只覆盖 273 链，不覆盖 274。09:09 UTC 更新确认 274/275 均无本轮通过收据；即便隔离 PostgreSQL 回归通过，也只证明隔离数据库执行，不能证明唯一 Demo live chain、历史 `deleted` 行预检结果或受保护迁移窗口。

本轮部署判定继续为 **NO-GO**：最近记录的 host inventory 仍是 inventory-only、`release_approved=false`，且 94 个运行容器中 79 个未分类；API/Ops 健康投影为 `setup.mode=production`、`writesEnabled=false`。缺少 owner 签字的全容器 inventory、共享锁所有权/权限/所有 mutator 共用证明、DB owner 提供的完整 live `{version,name,checksum}` 链，以及能执行 migration 274 的获批窗口、BYPASSRLS/superuser 受保护执行器、备份/隔离恢复和旧版兼容/回滚证据。当前没有 clean/frozen commit 或绑定精确 SHA 的候选 archive、镜像 digest、Compose/env 摘要与 owner approval；桌面登录/租户业务读回、插件 host reload、真实 provider usage/cost/结算仍未验收。新增迁移与测试不解除上述阻断。

## 第十轮页面交互与调用链复核（进行中）

本轮按 Merchant 素材、购买/结账、任务/发布、API/MCP、Support/Stores、Finance、Audit、Incidents/Models、migration/worker 分区复核。采用 PM dogfood 的可见交互与错误恢复观察，并用 CodeGraph 检查组件到 hook/client/API 的调用关系；API `server.ts` 不在 CodeGraph 索引中，相关门禁仍由直接源码核对。共享工作树继续沿用 `main`，未清理、提交或部署。

本轮可确认的本地修复与验证：

- Finance 高级筛选折叠时原先卸载目标节点，导致 `aria-controls` 失效。现保持目标挂载并控制显隐；诊断版 Chromium spec **2/2 通过，exit 0**，覆盖展开/折叠、ARIA 目标和 workspace/type/status/keyword 组合提交。Finance API client、搜索 Hook 与组件单测有 **26/26** 收据，组件单测复跑 **13/13**。
- TaskWorkspace 搜索/换页失败时明确标出屏幕保留的旧页码与最近成功查询，避免旧快照被误认作新条件结果；四文件定向单测仍在队列中，无退出码/计数收据。
- PublishHistory 的只读 503 此前复用通用“操作未确认”并引导检查模型中转/插件连接。现改为 API 读取恢复指引；对应组件单测 **6/6 通过，exit 0**，本地拦截 API 的 Playwright 全套 **10/10 通过，exit 0**（错误文案、旧快照说明、重试，以及分页、深链和键盘标签旅程）；JavaScript 语法检查通过。浏览器截图写入既有本地 QA evidence 目录，不代表真实 Demo/API 业务数据。
- 素材关联失败会保留已选素材供修正重试；继续生成前置条件现在检查服务端要求的 `aiModificationAllowed=true`。素材权益单测 **23/23**。素材浏览器的一次重复运行 exit 143，另一次 `.last-run` 状态缺少具体断言，因此都不记为浏览器通过。
- Support 状态变更失败 fixture 改用 `useRef`，避免确认交互重渲染时清掉模拟失败开关；回归仍在串行队列等待，无通过收据。
- Audit 平台范围增加企业主体选择入口，以满足页面原有“切换到具体企业导出”的指引。首次可见 Audit browser 收据为 **5 tests：2 passed、3 failed，exit 1**。随后综合 runner 的 Audit/Incidents/Storage 4 files / 25 tests 中 **19 passed、6 failed，exit 1**；Audit 有 2 个 locator/fixture 问题，Incidents 有 4 个状态/断言问题，详见 `/tmp/codex-ops-pages-round10.log`。Audit 中途完整复跑曾为 **4/5 passed、1 failed，exit 1**；两次目录恢复定向复跑也暴露隐藏 option/selection-label locator 不稳定，最终改为键盘 Enter/ArrowDown/Enter 选择，并核对 workspace-scoped `ops.audit.list` 请求及页面切换到企业范围说明。最终完整 Audit route journey **5/5 passed，exit 0**，日志 `/tmp/codex-audit-journey-final.log`；包含筛选、脱敏详情、焦点返回、导出失败重试/CSV 下载、聚合只读、空目录和错误恢复。Browser 使用本地 RPC fixtures，不是 Demo 或真实租户证据。Incidents round3 定向选取4条旅程为 **2 passed、2 failed**；round4 修正 Select 展开与页面级 create 锁恢复后，两条先前失败旅程 **2/2 passed**（其余6项跳过，round4没有可见 shell exit marker）。完整 Incidents spec 尚在排队，待取得完整收据。Owner 复核另发现目录加载/错误/空状态时不应隐藏企业入口，已补目录空/错误禁用、重试和 journey。
- API/MCP marketplace bridge 镜像已补空上传拒绝和本地文件参数错误提示；canonical 与镜像一致、两份 `node --check` 及 `git diff --check` 通过。新增 bridge error contract 精确测试 **18/18 passed**，覆盖 canonical/mirror、通知与取消、请求参数和 fail-closed。
- migration 274 测试元数据与发布媒体 API 生命周期拒绝条件已更新；API 生命周期用例 **17/17 passed**，worker production entry 回归 **129/129 passed**。迁移 SQL/仓储回归仍无本轮完整收据。`publish_media_orphan_tasks` 尚无商家或 Ops 恢复页面入口，现有存储统计/批次重试不提供人工认领恢复。
- 增量 6 文件回归记录 **184 passed、1 failed，exit 1**：repository、worker 129、Ops API client 7、素材关联权益 5、Customer Delivery authz 10 均通过；plugin install-smoke 中 macOS package/install 一条失败，报告 bundle provenance inventory 缺少 `docs/skill-source-provenance.md`。随后该 package/install 用例单独复跑 **1/1 passed**，完整 install-smoke suite **29/29 passed**（`/private/tmp/codex-plugin-install-smoke-owner.log`），未复现缺文件错误；最初失败与并行 runner 重叠，但具体竞争根因尚未证明。
- Image-generation/API 五文件回归初次为 **51 passed、2 failed**，失败在新 `image-budget-dispatch.test.ts` fixture 未提供运行时 `header` 函数，因此未进入预算断言。已补 fixture 并单文件复跑 **23/23 passed，exit 0**（`/private/tmp/codex-image-budget-dispatch-rerun.log`）；该批其余 repository、scanner、knowledge claim、failed-image reconciliation 用例分别通过，scanner 11、knowledge 2、failed-image reconciliation 11。该结果仍是本地 fixture/E2E 测试，不代表真实 Demo provider 请求或成本回执。

全工作树 `git diff --check HEAD` 最新通过。CodeGraph 最近索引为 2,982 files、40,359 nodes、160,112 edges，但工作树有并行新增/修改尚待 sync；待并行编辑稳定后再统一同步。Audit、Incidents、Support、TaskWorkspace、素材与购买旅程仍有排队、未归档或未执行项；局部修复不代表全页面验收。唯一 Demo 的真实租户、权限、模型 relay/成本、live migration chain 与发布门禁仍保持 **NO-GO**，本轮未访问或写入线上环境。

## 2026-10-10 09:09 UTC 候选与只读健康检查增量

源码候选迁移链现为 `sourceMigrationVersion=270`、`expectedMigrationVersion=275`；`loadMigrations()` 已登记 275。迁移 274/275 的新隔离 PostgreSQL 回归均尚无本轮通过收据，migration 273 的旧收据不覆盖 274/275。迁移 274 会改写既有媒体生命周期行并要求受保护的 BYPASSRLS/superuser 执行器及旧 worker 兼容窗口；迁移 275 要求 `merchant_schema_owner` 为专用 NOLOGIN、非 superuser/非 BYPASSRLS 角色，且不得与 `merchant_app`/`merchant_ops` 互相继承。测试会在临时隔离数据库创建/配置该 owner；这不代表 Demo 已 provision 该角色。迁移前仍须 DB owner 提供完整 live `{version,name,checksum}` 链、预检/备份与恢复证据及单独批准窗口。

本轮只读采集的 API 与 Ops healthz 均为 HTTP 200，采集时间 2026-10-10 09:09 UTC；原始 JSON、响应头、状态码和 SHA-256 清单归档于 [`artifacts/demo-health-readonly/20261010T090947Z`](../../artifacts/demo-health-readonly/20261010T090947Z)。两份响应都显示 `setup.mode=production`、`writesEnabled=false`。这只证明端点当时可读，不证明 Demo 业务、权限、MCP、模型账务或部署验收通过。主机容器 inventory 本轮未取得可归档的新鲜输出；此前“94 个容器/79 个未分类”仅为 07:28 UTC 历史摘要，原始 inventory 未归档，不作为当前状态。

本轮在共享 `main` 工作树修正/补强了 reconcile worker 执行授权与原始发布快照绑定、媒体事件数据库写入边界及迁移 275 登记、素材 picker 的可信扫描凭据/MIME/授权范围门禁、插件版本传播到 lockfile、若干 Ops/Customer Delivery/merchant UI 错误恢复与分页回归。相应定向测试正在串行队列中；在取得退出码和测试摘要前不记为通过。当前候选仍为 dirty worktree，未构建/安装插件 bundle，未完成 stdio host reload/tool discovery、provider receipt/usage/cost/settlement 或媒体成片验收。

**发布判定继续为 NO-GO。** 不执行 SSH 写入、同步、迁移或部署；源码迁移头、HTTP 200、隔离回归及本地页面测试均不能替代唯一 Demo 的 owner 批准和真实运行环境门禁。

## Owner final review (2026-10-10, local candidate)

- Incidents uncertain-write recovery browser cases: **2/2 passed**, exact log `/private/tmp/codex-incidents-targeted-final-owner.log`. Full spec's other six cases were skipped by the name filter.
- Models billing retry browser case: **1/1 passed** with two unrelated cases skipped, exact log `/private/tmp/codex-models-billing-retry-final.log`. The isolated PostgreSQL event-by-id tenant-boundary case was added but has no fresh database execution receipt.
- Connector runtime: **22/22 passed** after updating the orphan transition assertion; worker suite **129/129**, relay usage **82/82**, Audit browser journey **5/5**, API worker-media lifecycle **17/17**, MCP bridge error contract **18/18**, shared Ops navigation/accessibility **151/151**, merchant product asset journey **1/1**, browser entrypoint gate **67/67**, revoke confirmation **3/3**, and Storage pagination **1/1**. These are local fixtures/browser journeys, not live Demo evidence.
- A combined incremental regression batch reported **184 passed / 1 failed** across 6 files. The failure was plugin install-smoke provenance inventory missing `docs/skill-source-provenance.md`; the packager and test now include that required provenance document. The complete install-smoke file then passed **29/29**, exact log `/private/tmp/codex-plugin-install-smoke-owner.log`.
- Global `npm run typecheck` returned exit 1 with five strict-null errors in the API lifecycle test's optional server cleanup reference. The test now uses the imported server reference with local narrowing; a fresh full typecheck is still required. CodeGraph sync completed: 35 changed files indexed. `git diff --check HEAD` passed before this follow-up.
- PostgreSQL/RLS and migrations 274–275 have no current successful database execution receipt. Ops route exposure requiring product clarification remains unchanged. No screenshot-level desktop GUI audit was available.

The candidate remains **NO-GO for Demo deployment**. No SSH action, sync, migration, container restart, or deployment was performed. Real API/RLS tenant verification, provider request and cost evidence, migration-chain owner evidence, and host/release approval remain outstanding.

## Final follow-up (2026-10-10)

- Support assignment dialog feedback recovery has **no verifiable result** for the latest Escape-dismissal run: the support agent confirmed the process ended, but no stdout, exit code, or new log was retained. Do not count it as passed; earlier failures involved mount timing and a locale-dependent Cancel label. The task split-flow `scope-changed 409` journey passed **1/1** (`/private/tmp/task-scope-409-single-20261010.log`). The video skill safety contract passed **2/2** after tightening evidence, image-access, and competitor-research boundaries. These are isolated local fixtures/contracts, not live authorization or media-generation evidence.
- Task-list read failures now use read-specific wording for generic HTTP 503 responses, so they no longer claim a write outcome is unknown. Investigation confirmed `CANONICAL_TASK_READ_UNAVAILABLE` is emitted by single-task detail projection, not the `/v1/tasks` list route; the list browser fixture now uses the generic sanitized `INTERNAL_ERROR` 503 response. API classification/search unit files passed **10/10** (owner tool output; no standalone log), and the corrected browser read-recovery journey passed **1/1** (`/private/tmp/task-read-generic-read-error-final.log`), covering search and next-page failure/retry.
- Ops bootstrap regression for candidate `8ad54634`: `opsLoadCoordinator.test.ts` passed **20/20** (`/private/tmp/ops-session-effect-unit.log`), and `OpsConsoleController.identity-route.browser.test.tsx` passed **2/2** using Node 22 (`/private/tmp/ops-session-effect-browser.log`). These cover same-key in-flight load deduplication and identity-gated page reads. The exact timing where nonempty roles arrive during a fast bootstrap fan-out still has no direct test.
- Production-profile local stdio package built from clean plugin inputs at commit `b2094bef2e0263f5def19c2a9099bd0c34266703`: `ready_to_install=true`, `source_dirty=false`, Node v22.16.0/macOS arm64. After extraction, provenance verification returned `ok=true`, checked 89 files, and matched the version and commit. SHA-256: `34f7b94739210310f878e460baa956b5623ebe635e84a5849785681e39afbbc5` (`/private/tmp/merchant-marketing-0.1.0+codex.20261010192747-production-darwin-arm64.tar.gz`). This is a package candidate; actual ChatGPT host install/reload and new-conversation tool discovery remain unverified.
- Additional local Merchant Studio receipts: spreadsheet scanner/import **1/1** (`/tmp/material-product-import-scanner-grep-120s.log`); task-list read recovery **1/1** (`/tmp/task-read-recovery-after-fix-20261010.log`); publish-history journeys **6/6** and asynchronous manual-publish handoff **1/1** (`/private/tmp/focused-regressions-20261010.log`). These are separate focused runs; the combined task split-flow run was interrupted and is not an all-green suite receipt.
- The exact isolated PostgreSQL candidate set did not reach Vitest: run `artifacts/isolated-postgres/run-2rOUa4/` failed during fixture startup with `ISOLATED_FIXTURE_REDIS_NOT_READY`; no database assertions ran. The archived disposal record shows the Redis fixture stopped and the PostgreSQL fixture left running because identity verification or exact-ID stop failed. A later exact-ID read-only inspect reported “no such object” in the owner session, but that observation has no retained artifact; a separate current audit timed out while checking exact IDs, so present container state is unverified. This is infrastructure-unverified, not a test pass or product assertion failure; the Colima daemon did not respond to a read-only image-list query, so fixture readiness remains unresolved. Do not retry until fixture ownership and disposition can be verified.
- Finance local browser journeys now have focused receipts for advanced-filter submission **2/2**, stale-snapshot/export and detail keyboard/error-retry/focus recovery **2/2**, and cursor pagination **1/1**. Exact logs: `/tmp/codex-finance-models-audit-journeys.log`, `/private/tmp/codex-finance-stale-results-title-locator-retry.log`, and `/private/tmp/codex-finance-pagination-row-state-final.log`. The pagination assertion now waits for the rendered result count and compares unique table row keys, so Ant Design's fixed-column clones do not count as extra business records. These browser runs use local fixtures; they do not establish live tenant authorization, ledger correctness, or end-to-end Demo billing acceptance.
- Models/Storage local browser regression: **4/4 passed** across `ModelsPage.overview-navigation.browser.test.tsx` and `StoragePage.error.browser.test.tsx`; log `/private/tmp/codex-models-storage-final.log`. Models covers Overview navigation, multiplier read retry and audited change, and fail-closed relay gating; Storage covers error recovery and reconciliation reload.
- The multiplier retry browser failure was a locator mismatch: Ant Design rendered the visible label as `重 试`, so the exact `重试` accessible-name query did not match. The test now scopes the button lookup to the billing error alert and accepts the inserted whitespace. The focused recovery case passed **1/1** (`/tmp/codex-models-billing-retry-final.log`); the full Models/Storage files then passed as above. No product behavior change was needed.
- `git diff --check HEAD` passed after the test adjustment. CodeGraph was synchronized and reported **2,990 files, 40,453 nodes, 160,606 edges**, up-to-date at that point; subsequent parallel persistence-test edits may require another sync.
- A fresh global `npm run typecheck` was still running at the last check (two overlapping runs; one `tsc -b` remained active for over seven minutes). No final exit status is recorded. Do not treat this as a typecheck pass.
- Targeted role regressions listed above do not constitute a line-by-line review or browser acceptance of every page/component/control. Merchant purchase and asset journeys, Support/TaskQueue full browser receipts, PostgreSQL migrations/RLS, real ChatGPT host discovery, provider usage/cost evidence, and live tenant authorization remain incomplete or unverified. The canonical Demo remains **NO-GO**; no SSH access, deployment, or live data change was performed.
