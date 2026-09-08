# 桌面 JIT 签发与测试入口隔离

日期：2026-09-07（CST）。本轮承接用户“继续”对桌面签发表单和测试入口隔离的确认。结论：签发表单已修复且真实入库；隔离入口已落地；JIT 完整生命周期仍被撤销策略/接口不一致阻断，生产仍 **NO-GO**。

后续更新：用户已确认撤销免二次审批，策略缺陷已修复；真实 PG 撤销成功，但桌面刷新后回执丢失。见[撤销策略续轮报告](jit-revoke-policy-verification-2026-09-07.md)。以下保留本轮原始失败快照，不覆盖历史证据。

## 本轮范围与方法

使用 gstack investigate 的根因、红测、最小修改、复验流程；pm-skills verify-feature 要求实际桌面交互和运行证据；ui-ux-pro-max 仅用于表单绑定、错误恢复和 pending 反馈，不做重新设计或移动适配。CodeGraph 与源码入口交叉核对，图缺失不作为免测依据。当前图最后更新于 17:59 CST，仍有 15 新增/40 修改未索引；safe launcher 未入图、server.ts 超过 1 MiB 索引上限。原始查询与实际引用补边见 [CodeGraph 复核](../../../artifacts/audit-2026-09-07/jit-isolation/codegraph-review.md)。

本轮只认领表单两处修复、测试隔离/报告/CI 接线，以及 API 新增可选绑定地址供隔离启动器使用。`server.ts` 的本轮修改仅为 `server.listen(port, process.env.API_BIND_HOST, ...)` 和真实监听地址日志；未改变默认部署绑定行为、鉴权策略、模型、商业能力、迁移或业务数据。大量已有工作区改动保留，不能把整个 git diff 归因于本轮。

## 已修复

1. 真实 JIT 表单提交的 `resource_scope_json` 从旧 `type/ids` 改为唯一单工作区 `workspace_ids`。
2. Ant Design 到期时间 Form.Item 原来有 Input 和辅助 span 两个子节点，字段没有正确绑定；将说明移出 Form.Item，保留可访问关联。最初红测先暴露绑定失败，单独修好绑定后继续稳定复现旧 scope 失败。
3. 新组件回归在 Chromium 中挂载真实 React/AntD 组件与 opsClient，仅模拟 RPC 边界，覆盖实际提交、版本号、错误输入保留、重试和 pending 去重。这是 E1，不冒充真实鉴权/数据库。
4. 桌面启动器不再读取现有业务容器环境：自建 PG17/Redis、随机密码/工作区/身份、完整 1–163 迁移、持久角色、签名本地 OIDC、真实 API 和生产构建 UI。API/UI/gateway 真正绑定回环地址；启动缺少 session hash secret 的失败被保留并修正。中断清理等待未完成的夹具创建，只按已核验完整 ID 停止自己的容器。
5. 普通测试、watch、summary 改用安全环境白名单，剥离 DB/Redis/模型/云/Kube/EXECUTE 配置。临时素材目录由本次创建并清理，原始报告保留。
6. 隔离环境不再隐含继承 fixture 配置：summary 仅对受控内存 HTTP smoke 显式设置合成费率，普通 Vitest 不携带该设置；容量报告单测显式提供测试版本，不再依赖 npm 注入的版本号。没有修改商业费率或容量门禁的生产语义。

## 测试入口与真实边界

| 入口 | 行为与分母 | 不能据此宣称 |
| --- | --- | --- |
| `npm test` / `npm run check` | 安全 launcher；显式排除 13 个非隔离文件；选择被排除文件或覆盖 config 时拒绝，空选集失败 | 全部数据库、运行栈和宿主能力已通过 |
| `npm run test:postgres:isolated` | 自建 PG17；固定 8 个曾有本地回退的 PG 文件；校验精确文件集、非空断言和零 skip；结束清理 exact IDs | 其余所有 PG、真实生产迁移或商业流程已通过 |
| `npm run test:runtime:isolated` | 保留 4 文件/9 场景；配置缺失在 Docker/HTTP 前失败；不是 skip | 当前已完成 13 服务故障演练 |
| `npm run test:local-release-gate` | 转入独立 runtime config，同样强制隔离核验 | 共享 local 栈可作为故障注入目标 |
| `npm run test:browser:ops:jit` | 自建持久 PG/Redis、签名 OIDC、桌面实际签发/刷新/撤销；失败仍返回非零 | 正式 IdP、真实 ChatGPT 宿主或完整生命周期已通过 |
| `npm run test:summary` / `test:watch` | 使用同一安全环境；summary 保留实际失败、未执行及原始报告 | summary 的成功计数可以覆盖被隔离/未执行的场景 |

13 个排除文件中：4 个 runtime、8 个 PG，以及 1 个旧 canonical-backfill API 合同（6 场景）。后者仍嵌入本地 merchant bearer 和固定 DB/API 回退，现已从默认入口隔离，**尚未迁移为签名且全隔离的专用验收**；明确保留为缺口，不删除用例、不称通过。

runtime guard 要求专用 Compose 项目、run/workspace label、独立配置文件、同机 Unix Docker daemon、内部 PG/Redis/worker 依赖、非生产与单工作区 token。每次潜在写入/停启之前复核；所有 published 端口仅回环，禁止所有 host bind（包括只读源码、配置、secret、socket 和设备）、privileged 和原生 device；只接受已验证归属的本地 volume 或 tmpfs。专用镜像须 build/copy 配置，不能复用原 local Compose 挂载。

CI 为组件回归安装桌面 Chrome；新增自建容器 8 文件 PG 入口。已有 CI PostgreSQL 迁移步骤改为直接运行明确指定的 Vitest 文件，使用 CI 服务凭据；否则安全默认入口剥离环境后会导致原 PG 用例跳过。此前授权专项的五文件/零跳过门禁保留。CI 配置已本地校验，但本轮没有推送或执行远程 CI。

## 新发现：撤销义务与公开接口冲突（P1，未修改策略）

真实签名登录及 grant issue/list 均 200；撤销请求到达 API 后返回 403。服务端审计为 `AUTHZ_OBLIGATION_REQUIRED`，不是持久层错误，也不是仅缺 `target_workspace_id`。

- `packages/contracts/src/authz.ts` 将 issue/revoke 合并为同一条政策，二者均要求 reason、revision、approval。
- `packages/contracts/src/mcp.ts` 的 revoke schema 只接受 grant、subject、版本号和原因，不接受审批字段。
- `server.ts` 在路由前提取义务并拒绝请求，revoke handler 未执行。前端临时补审批字段也会违反严格 schema。

最小候选修复为拆开政策：签发继续要求审批；撤销保持平台权限、原因、版本与审计，但不要求接口无法提供的审批。该变更涉及安全政策，本轮没有擅自实施。应由安全/产品 owner 确认撤销是否需要二次审批，再补政策/schema一致性、签名 HTTP 成功/拒绝、真实桌面与 PG 审计回归。不能用预期 403 替换成功断言来让原生命周期 suite 变绿。

此前 `ops-session-grant-contract.test.ts` 没有显式启用 MCP_AUTHZ_MODE=enforce，默认 shadow 的成功不能证明此策略可用。后续回归须固定 enforce 和真实持久能力，不能依赖外部环境碰巧启用。依据 gstack investigate 的范围与安全歧义约束，本轮停止在该政策变更之前，等待确认。

## 验证记录

证据目录：`artifacts/audit-2026-09-07/jit-isolation/`。原始红测、启动失败、失败截图与后续通过分别保存。

| Owner 检查 | 结果 | 证据 |
| --- | --- | --- |
| 真实组件提交回归 | 1 文件 / 9 passed / 0 skipped | `../qa/jit-component-owner-green.json` |
| 入口/夹具/CI 接线 | 5 文件 / 77 passed / 0 skipped | `owner-integrated-entrypoints-green.json` |
| runtime guard + PG launcher | 2 文件 / 92 passed / 0 skipped | `owner-guards-postgres-entry.json` |
| 自建 PG17.11 的 8 文件 | 8 passed / 0 failed / 0 skipped | `artifacts/isolated-postgres/run-c59WPX/vitest.json` 与 `run-result.json` |
| 缺配置 runtime 入口负例 | exit 1，4 文件 / 9 failed / 0 skipped，配置先行拒绝 | `owner-runtime-failclosed.log` |
| 默认入口选择故障测试负例 | exit 1，启动 Vitest/容器前拒绝 | `owner-safe-selection-refused.log` |
| summary 最终回归 | 1 文件 / 23 passed / 0 skipped | `owner-summary-final.json` |
| 环境隔离与报告元数据回归 | 3 文件 / 69 passed / 0 skipped | `owner-environment-regressions.json` |
| Owner 真实 HTTP smoke | 50 workspace / 400 请求 / 0 错误；100 次重复发布请求对应 50 个唯一任务 | `owner-http-smoke-ERxkC0/run-result.json`；E1，受控内存、fake connector、cloudGate=false |
| 首次安全完整 check | exit 1；595 文件通过 / 1 失败 / 44 跳过；4,445 passed / 1 failed / 70 skipped | `owner-full-check.log`；失败是 npm 版本号隐含依赖，其后链式步骤未执行 |
| 静态/受控 release-gates | exit 0；113 文件通过 / 6 跳过；538 passed / 13 skipped | `owner-release-gates.log`；跳过的 PG 不构成动态放行，CI 另有显式 PG 步骤 |
| 最终安全 check | exit 0；根套件 597 文件通过 / 44 跳过，4,449 passed / 0 failed / 70 skipped；Ops 88 文件 / 500 passed / 0 skipped | `owner-full-check-final.log`；两次计数不相加，根套件包含重叠组件覆盖 |
| 类型、元数据与构建 | 根/API/两 UI 类型通过；metadata、Ops build、Studio build 通过；新增入口另做严格 TS 检查通过 | 同一最终 check 日志、`owner-new-entrypoints-typecheck.log`；Studio 保留 >500 kB chunk 警告，不是正式商家入口 |
| 真实桌面生命周期 | exit 1；1440×900 撤销 403 失败，1280×800 因 serial 前置失败未运行 | 不能写成“两尺寸通过” |
| 桌面视频与只读 PG 审计 | 1440×900，shot-scraper exit 0；TTL 负例拦截、issue/list 200、revoke 403 | 取证成功不等于生命周期成功，见下述证据 |

### 桌面真实证据

[12.4 秒交互视频](../../../artifacts/ops-jit-isolation/2026-09-07T12-02-31.313Z-97066e92-893e-48e2-a755-f972387b7111/live-desktop-capture/jit-signed-login-issue-revoke-denied.mp4)、[非法 TTL](../../../artifacts/ops-jit-isolation/2026-09-07T12-02-31.313Z-97066e92-893e-48e2-a755-f972387b7111/live-desktop-capture/frame-03-invalid-ttl-submit.png)、[签发并刷新](../../../artifacts/ops-jit-isolation/2026-09-07T12-02-31.313Z-97066e92-893e-48e2-a755-f972387b7111/live-desktop-capture/02-issued-and-explicitly-refreshed.png)、[撤销拒绝保留原因](../../../artifacts/ops-jit-isolation/2026-09-07T12-02-31.313Z-97066e92-893e-48e2-a755-f972387b7111/live-desktop-capture/04-revoke-denied-input-retained.png)。Owner 已打开三张关键截图复核，不只查看文件存在。视频从实际登录、填写、点击录制，密码保持遮罩；没有用 API 直接 POST 替代 UI 点击。

[只读数据库证据](../../../artifacts/ops-jit-isolation/2026-09-07T12-02-31.313Z-97066e92-893e-48e2-a755-f972387b7111/live-desktop-capture/postgres-readonly.redacted.json)使用自建 PG 的 merchant_ops、同连接 REPEATABLE READ READ ONLY：capture ticket 对应唯一新 grant、workspace_ids 精确匹配、1 条 issued event、0 条 revoked event、revoked_at=null。浏览器与持久审计的 request/decision ID 一致，拒绝明确缺 approval。视频中其他全局运营数据错误横幅未隐藏，不以本次签发成功宣称整个后台可用。

## 安全与交接

本轮不迁移或清空共享业务库，不重启共享 Redis，不调用付费中转模型，不改变商业授权、不发布。自建容器采用随机运行标识、loopback 随机端口、tmpfs 和 AutoRemove；清理仅影响本轮可重建合成数据，证据保留。上一轮 scanner-callback 合成素材的影响记录保留，未清除数据来掩盖事故。

[最终运行清单](../../../artifacts/audit-2026-09-07/jit-isolation/run-manifest.json)包含原始报告/视频/截图 SHA256、夹具清理与源码快照。所有记录为 stopped 的自建容器 ID 已与 Docker 现存完整 ID 集合比对，均不存在；leftRunning=[]。只移除了本次合成夹具数据，可重新运行生成；未删除业务数据或持久卷。

共享 local 的 13 个服务在结束时只读观测为 healthy；这不是长稳证明。ClamAV 另观测到 RestartCount=10、12:03:27 UTC 重新启动、OOMKilled=false，本轮没有操作该容器，也没有足够证据归因其重启。Redis StartedAt 仍为上一轮已记录的 10:41:42 UTC。不能将时点健康夸大为无故障运行。

### 来源稳定性与剩余分母

第一次完整检查前快照为 1,427 个源码/配置文件，检查后为 1,429 个：其他并行工作新增 ProductSpreadsheetImport 两文件，并修改 StoresPage 与 spreadsheet-batch；本轮 summary 两文件也在补充独立回归后冻结。最终完整检查中途到结束，只有其他并行工作的 StoresPage、TasksPage hash 又发生变化。本轮目标表单、启动器、守卫和测试文件在该后半段未变；仍不签为整个发布来源冻结。最终源码摘要及逐文件差异见运行清单。

默认 suite 的 70 个跳过、release-gates 的 13 个跳过、排除清单的 13 个文件，以及 Playwright 的 1 个未运行均保留原始分母。专用 8 文件 PG 的通过不能抵消其他未执行 PG；桌面取证成功也不能抵消生命周期失败。安全入口防止已审计的环境误继承和共享目标误用，不是抵御恶意测试代码或手动绕过 launcher 的操作系统沙箱。

后续优先级：确认撤销审批语义并闭合 JIT 生命周期；为旧 canonical API 和完整 13 服务 runtime 建立可执行隔离夹具；固定发布来源后，按[测试方案](test-strategy-2026-09-07.md)完成真实 ChatGPT、五模态中转、租户/账务/worker、容量/恢复与发布门禁。局部 E1/E2 通过不替代 E3/E4。
