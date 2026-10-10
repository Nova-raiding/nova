# UI 页面覆盖清单（2026-10-10）

本清单用于按真实路由追踪桌面端页面、关键交互和浏览器证据。它不是“项目已完成”声明：组件单测或 source assertion 不等于页面旅程通过；任何本地 fixture 结果也不等于唯一 Demo 的真实租户验收。

## Merchant Studio

页面由 `demo/merchant-studio/src/navigation.ts` 的 `merchantPages` 路由清单定义，商品页内部还有产品、品牌资产、素材库、回收站子入口。

| 页面/子入口 | 当前可定位的浏览器证据 | 当前状态/下一步 |
|---|---|---|
| 运营概览 `/merchant/overview` | `overview-finance.browser.spec.js` **5/5**，含概览连接跳转与指标失败恢复 | 本轮本地 fixture 浏览器通过；全卡片和唯一 Demo 数据仍未验收 |
| 商品与店铺 `/merchant/products?section=products` | `material-product-import.browser.spec.js` **2/2**，含导入后事实确认失败的重试；`catalog-search-filters.browser.spec.js` **1/1**；`catalog-import-search-readback.browser.spec.js` **1/1**，覆盖搜索、CSV 导入、事实确认及刷新后同店铺回读；`catalog-read-retry.browser.spec.js` **1/1**，覆盖目录读取 503、显式重试与服务端商品回读；`manual-store-registration.browser.spec.js` **1/1** | 本地 mock 桌面旅程通过；完整商品/店铺旅程和真实租户仍需验收 |
| 品牌资产 `/merchant/products?section=assets` | `brand-scope-save-readback.browser.spec.js` **1/1**，覆盖编辑、单次 PUT、刷新后 GET 回读；另有 scope 页面、上传/竞态与上传重试 fixture | 保存回读的定向旅程通过；其他字段错误态及真实租户仍需覆盖 |
| 素材库 `/merchant/products?section=knowledge` | 素材搜索/预览/导入、素材权益控件（本轮浏览器验证） | 受限 scope 无法升级商用；approved restricted 仍可调整。服务拒绝与保存后 GET 回读已覆盖；老 AssetLibrary 无路由 caller |
| 回收站 `/merchant/products?section=trash` | `material-recycle-bin.browser.spec.js` **1/1** | 本轮桌面浏览器通过读失败恢复和工作区内素材恢复；真实租户隔离未验证 |
| 财务 `/merchant/finance` | `overview-finance.browser.spec.js` **2/2**（当前版本/有效期和 legacy 事实 fail-closed）、购买中心浏览器测试；`finance-combined-range.browser.spec.js` **1/1**（组合月区间、提交前结果保持、账本不因筛选重读）；`commercial-subscription-read-retry.browser.spec.js` **1/1**（套餐读取错误可见、刷新后恢复且不创建订单） | 本地 mock 读取恢复通过；页面其他错误路径及真实账务仍需覆盖 |
| 成员 `/merchant/members` | `MerchantMembersPage.test.ts` **10/10**；`MerchantMembersPage.mount.test.ts` **1/1**，覆盖初次加载及工作区切换后的 session/list 顺序和邀请草稿清除 | 本轮修复重置与加载 effect 的竞态并通过本地挂载回归；真实账号权限未验收 |
| 任务 `/merchant/tasks` | task queue、image-generation、delivery-readiness 路径 | image-generation desktop **12/12**（含三个桌面视口）、素材卡片键盘/详情交互 **1/1**；安全重试失败与 provider outcome unknown 已覆盖；`delivery-readiness-recovery.browser.spec.js` **1/1**，覆盖证据重试保留深链并恢复键盘焦点；完整页面组合仍需覆盖。商品详情的图片用途/尺寸/校验与生成 payload **1/1**、取消确认且不创建任务 **1/1** |
| 发布历史/发布详情（任务子流程） | `publish-history.browser.spec.js` | 有列表、深链和恢复 journey；tab ARIA 与键盘交互已补并有专项回归 |
| 规则 `/merchant/rules` | `rules-page-interactions.browser.spec.js` | 有浏览器专项；需按真实规则状态继续覆盖 |

## Ops Console

实际 Ops domain 清单以 `opsDomains` 和 `opsPageRegistry` 为准，共 13 个：Overview、Users、Customer Delivery、Members、Tasks、Knowledge、Stores、Rules、Models、Storage、Finance、Support、Audit。`IncidentsPage` 有独立组件与浏览器 fixture，但 `incidents` 不在 `opsDomains`、路由识别、页面 registry 或 sidebar 中，`IncidentsRoute.tsx` 也没有生产调用方；不能把它记为可访问的 Ops 页面或路由旅程。Ops Console 明确只激活 platform workbench；Members、Tasks、Knowledge 所需的 workspace workbench 在 `canActivateOpsWorkbench()` 中被拒绝，直达这些 workspace 路由会进入阻断恢复页，不应记作已验收页面。

分类约定：**已完成（定向）** = 本地浏览器旅程有明确通过收据，只表示该旅程；**有测试未完成/未执行** = 存在相关测试或断言，但当前没有完整、可归属的通过收据；**无页面覆盖** = 没有对应可访问页面的浏览器旅程。任何一类均不代表唯一 Demo 实机验收。

| 页面/路由 | 分类 | 可核对证据与缺口 |
|---|---|---|
| Overview `/ops/overview` | 有测试未完成/未执行 | `OverviewPage.browser.test.tsx` 本轮 **2/2**：无模型读取权限时区分未知成本、模型状态读取 fail-closed 并重试；完整 controller route 与真实运行数据仍无收据。 |
| Users `/ops/users` | 有测试未完成/未执行 | `OpsConsoleController.identity-route.browser.test.tsx` 本轮 **4/4**：无 identity.read 时深链保持阻断，授权刷新后读取用户目录，并阻断平台工作台不可用路径；完整用户中心管理旅程仍缺。 |
| Customer Delivery `/ops/customer-delivery` | 有测试未完成/未执行 | 授权、创建、session-loss、归档等隔离 journey 存在；脏建档离开/取消与丢弃场景本轮修复后各 **1/1**，完整 route journey 仍缺。 |
| Members `/ops/members` | 有测试未完成/未执行 | 新增的 route browser 场景检查平台账号明确阻断、sidebar 不显示 workspace 页，以及“返回总览”；首次运行 **2 tests failed**，因测试 fixture 在 Node 回调中读取 `window`，已移除该错误并改为匹配实际 `role=status`，修订尚未复跑。成员邀请/角色/状态/分页/恢复 journey 无覆盖；该页面按现有工作台边界在 Ops 中不可达。 |
| Tasks `/ops/tasks` | 有测试未完成/未执行 | `BrandStoreTasksDeepLink.browser.test.tsx` 只覆盖任务深链；完整页面列表、筛选、输入、空/错恢复没有页面旅程收据。 |
| Knowledge `/ops/knowledge` | 无页面覆盖 | 组件/读状态单测存在；`workbench=workspace` 由平台控制台 fail closed，审批路径不属于可访问的 Ops 页面。 |
| Stores `/ops/stores` | 有测试未完成/未执行 | `StoresPage.route.browser.test.tsx` **1/1**：目录筛选/空结果、平台工作台显式目标工作区、登记失败保留输入和安全重试、成功后刷新未授权记录；其余组件测试照常保留。更广 route/权限组合仍缺。 |
| Rules `/ops/rules` | 有测试未完成/未执行 | `PublicRuleDraftReviewPanel.detail-boundary.regression.test.tsx` **4/4**；`RuleCenterSection.activation-validation.browser.test.tsx` **3/3**；Markdown 导入失败使用 `role=alert`、成功使用 `role=status` 的回归 **4/4**。完整 controller route journey 仍缺。 |
| Models `/ops/models` | 已完成（定向） | `ModelsPage.overview-navigation.browser.test.tsx` + `StoragePage.error.browser.test.tsx` 合计 **4/4**；覆盖总览跳转、倍率读重试/审计保存、relay fail-closed、存储错误重试。完整模型成本/真实 relay 仍未验收。 |
| Storage `/ops/storage` | 已完成（定向） | 与 Models 同一浏览器批次 **4/4**；仅本地 fixture 的错误恢复和对账重载，不是 Demo 存储一致性证据。 |
| Finance `/ops/finance` | 已完成（定向）；仍有覆盖缺口 | 高级筛选浏览器专项 **2/2**，API/Hook/组件 **26/26**；FinancePage 级失败恢复与筛选快照导出 **1/1**，hook stale/export truncation **3/3**，FinanceSearchSection **14/14**。完整 controller route 和真实账务旅程仍未验收。 |
| Support `/ops/support` | 有测试未完成/未执行 | create failure retry、whitespace validation、assignment action feedback 组件 journey **3/3**；生产 `OpsConsoleController → registry → SupportRoute` 本轮 **1/1**，覆盖授权企业选择、队列失败后重试、键盘打开详情。完整回复/变更 route suite 与真实租户仍未验收。 |
| Audit `/ops/audit` | 已完成（定向） | 完整 route journey **5/5**；覆盖范围筛选、脱敏详情、导出失败重试/CSV、聚合只读、空目录和目录错误恢复，均为本地 RPC fixture。 |
| Incidents `/ops/incidents` | 无页面覆盖（路由不存在） | 独立 `IncidentsPage.error.browser.test.tsx` 覆盖组件状态，不证明生产路由存在；`/ops/incidents` 会作为未知 Ops path 退回 Overview。已有组件旅程不可计入 Ops 页面覆盖。 |

## 验收边界

- “有 browser test”只表示代码仓库存在相应 fixture；执行结果和覆盖断言须按对应 QA 轮次记录。
- 每一页面旅程还需覆盖可见按钮、键盘焦点、筛选/输入、确认/取消、错误与重试、路由和 workspace 切换中适用的项目。
- 页面/组件测试不能替代 API、权限、租户隔离、模型 relay、worker、数据库 RLS 与唯一 demo 的真实运行环境验收。
- 下轮复核应优先补齐 Models、Audit、Knowledge、Members、Stores、Finance、Tasks 的路由级桌面 journey，再逐模块检查操作控件和空/加载/错误状态。
- 目前 Merchant/ Ops 之外的 API、MCP、worker、persistence、migration 和 release tooling 仍需单独按 CodeGraph 调用链与对应运行证据审查；此 UI 清单不覆盖这些代码。

## 本轮 API/MCP 与插件专项收据

- API：`asset-scan-worker.e2e.test.ts` 与 `video-status-settlement.test.ts` **26/26**；`server.e2e.test.ts` 中 task creation/publish-confirmation HTTP 旅程 **1/1**，含 `?limit=` 与 `?limit=0` 的边界断言。
- MCP 插件：`bridge.test.ts` **165/165**、`relay-evidence.test.ts` **23/23**、`packages/persistence/src/postgres-repository.test.ts` **15/15**、`tests/browser-gate-entrypoints.test.ts` **71/71**，合计 **278/278**。插件与 Marketplace 的 image-local-edit 恢复测试各 **2/2**。
- CodeGraph 已同步至当前工作树；`git diff --check HEAD` 通过。首轮全仓 `npm run typecheck` 被 SIGTERM 中断；其后检测到另一个全仓类型检查进程仍在执行，未收到可核验的最终退出结果，因此类型检查当前标记为未确认。
- 本轮只使用本地浏览器 fixture 和测试数据；没有访问唯一 Demo、生产或部署服务。真实 tenant/RLS/权限/账务/中转模型、worker 和数据库行锁争用仍未获得 Demo 实机证据；`PERSISTENCE_RELEASE_DATABASE_URL` 未配置。

## 第二轮代码图谱审查与 10 月 10 日验证更新

下列改动来自页面所有者对 CodeGraph 调用链、当前实现和相邻测试的复核。共享 typecheck PID `39148` 是早期检查记录，已由本轮新的全仓 `npm run typecheck` 取代；当前运行结果见下方本轮收据。只把有日志或测试运行结果支持的项目标记为通过；仍未执行的浏览器场景保持待验。

| 区域 | 已发现并修复/正在修复的问题 | 尚待验证 |
|---|---|---|
| Ops Tasks | 队列筛选器按对应读取权限显示；队列徽标与实际展示的 provider/execution 行一致。 | 页面过滤、徽标计数及权限拒绝测试。 |
| Ops Stores | 账号 ID 含冒号时绑定保留完整 ID；无活动工作区时禁用无效登记入口；目录筛选/空结果/分页重置及别名重试反馈。 | Stores 页面浏览器与组件测试。 |
| Ops Rules | 批量审核仅允许当前合格草稿；详情有关闭入口；切换草稿/筛选或取消批量确认时清除旧凭证和理由。 | 合格性、详情恢复与确认范围浏览器测试。 |
| Ops Support | 未知写入恢复期间锁定企业选择；创建请求重试沿用同一 payload 的 key，编辑 payload 后换新 key。 | 重试恢复页面浏览器测试。 |
| Merchant 商品导入 | 批量导入使用幂等键，避免提交已落库但响应丢失后的重复创建。 | 模拟已提交/响应丢失/安全重放的页面旅程。 |
| Merchant 素材库 | 初次素材列表失败增加就地重试。 | 加载失败及恢复的挂载/浏览器回归。 |
| Merchant Finance | 账务状态、权益与存储读取失败增加独立状态及重试；避免把错误伪装成空结果。 | Finance 页面错误恢复回归。 |
| MCP/模型中转 | video provider 终态错误明确提示只读重试同一 `provider_job_id`，避免重复提交；缺少 token 时的认证提示区分尚未登录与凭据失效。 | 本轮缺 token 与 HTTP 401 文案聚焦测试 **2/2**；源 bridge 与 Marketplace 镜像逐字节一致，`node --check` 通过。没有调用唯一 Demo 的真实模型中转。 |
| Persistence | outbox 的 lease 状态更新先锁定物化行再校验/更新，防止与活动 claim 竞争。 | 单测与可选 release DB 并发测试；当前未配置 release DB URL。 |

Ops shell/registry 审查未发现确定缺陷：13 个路由有注册，sidebar 按 capability 与平台 workbench 边界过滤。缺少逐一经真实 controller 挂载全部 13 个页面的测试。唯一 demo、真实租户权限和生产模型证据不在本地 fixture 的验收能力内。

本轮新增验证收据：MCP `asset.preference.update` 无效 revision 回归 **2/2**；MCP 缺 token/401 提示回归 **2/2**；Ops authorization 与 navigation **95/95**；发布确认 Escape 取消浏览器场景 **1/1**；全仓 `npm run typecheck` **通过**。另修复 Merchant catalog filter 的方向键/Home/End/Enter 与 Escape 焦点返回，并新增 Customer Delivery controller 到页面的路由场景；两项浏览器测试尚未运行。Overview 错误恢复浏览器测试也待运行。所有证据均为本地测试，不是 ECS Demo 实机验收。

## 10 月 11 日继续审查

- Merchant Studio：商品导入回读、品牌 scope 保存回读、财务组合月份筛选，以及商品详情图片生成/取消确认等本地浏览器旅程均取得各 **1/1** 收据。筛选提交不触发账本重读；取消确认不创建图片任务。
- Ops Console：Stores controller 路由旅程 **1/1**；平台工作台请求显式携带目标 `workspace_id`，但不伪装成商家工作台请求。规则 Markdown 导入错误播报回归 **4/4**，失败用 `alert`、成功用 `status`。
- API：`commercial.service-boundary.accept` 曾在并发重放时可能双写审计。当前实现通过 PostgreSQL 事务 advisory lock 序列化同一 acceptance key，并用唯一 JSON tuple 生成无 NUL 锁键；定向测试 **27/27**。全仓类型检查仍在执行；未运行 PostgreSQL 测试或连接数据库。
- 插件：电商图片工作流契约测试 **3/3**；本地插件安装器重复参数防覆盖测试 **1/1**。本机仍同时启用 `merchant-local` 与 `personal` 两个 provider，缓存版本不同；没有写入本机配置或安装插件。
- 仍未完成的页面旅程包括 Ops Tasks 的筛选按钮、Rules 的完整 controller 路由，以及各真实租户/账务/服务环境验收。视频成片能力的 MCP 门禁已有测试，但 Merchant Studio 尚无视频创建入口；本地视频 skill cache 与源码版本也有差异。

## PM/NN/g UX 摘要

本轮重点用户是商家运营人员和平台运营人员：前者需要登记/核对店铺与维护商品，后者需要审核规则、管理店铺及确认跨商家影响。任务常从商品目录、失败提示、规则队列或带查询参数的详情深链进入。用户关心写入是否真的完成、权限是否足够、操作影响范围以及失败后如何安全恢复。

1. **目标：** 把日常商品运营和平台治理变成可理解、可恢复、权限边界清楚的桌面流程。
2. **用户：** 商家店铺运营和平台运营管理员；需要区分两者的权限与数据范围。
3. **触发：** 登记/查找店铺、处理商品任务、审核规则或从通知深链进入任务。
4. **到达时的关注：** 当前读取是否成功、写入是否落地、错误能否恢复、会影响哪个工作区或全部商家。
5. **上一步：** 商品目录或工作台导航、规则审核队列、任务通知/URL 深链、API 写入后的回读。
6. **期望感受：** 知道当前状态、掌握下一步，并且不会因不确定响应重复执行写入。
7. **替代方式：** 手工记账/重复提交、离开工作台找人核对、使用 URL 参数猜测筛选状态。
8. **下一步：** 用只读核对确认店铺登记；重试失败读取；确认规则变更范围；回到有效任务视图。
9. **相对改进：** 失败不再伪装成空列表；不确定的登记结果不再诱导第二次 POST；跨商家规则状态变更前明确名称、版本和范围。
10. **可删减项：** 隐藏账号 ID 不用于搜索时不应显示；失败状态应隐藏误导性的“空队列”提示；重复提交入口应在结果未核实时禁用。
11. **解除约束后的设计：** 各业务页仍应统一提供工作区上下文、状态回读和可恢复的下一步，并由完整 controller route 旅程验证。
12. **价值可见性：** 本轮补上的说明直接写明“仅登记”“未授权”“列表尚未核实”“所有商家/当前工作区”等影响。
13. **主要指标：** 降低误操作和重复操作，提升商家任务完成率及运营处理效率；本轮没有行为数据来量化影响。

| NN/g 启发式 | 本轮证据与判断 |
|---|---|
| 系统状态可见 | **通过（定向）**：读取失败和“写入已成功但列表未核实”有独立状态与恢复操作。 |
| 匹配真实语言 | **通过（定向）**：文案区分登记、授权、读取、审核和范围。 |
| 用户控制与自由 | **通过（定向）**：规则确认可取消；筛选可清除；Escape 返回菜单触发器。 |
| 一致性与标准 | **部分验证**：沿用 Ant Design 确认、表单、警告与键盘模式；未逐页视觉审核。 |
| 错误预防 | **通过（定向）**：无变化别名禁用保存；未核实的登记禁止重复提交；无效/过时深链筛选清理。 |
| 识别而非记忆 | **部分验证**：筛选器、空状态和影响范围可见；其他页面选择器未逐项覆盖。 |
| 灵活高效 | **部分验证**：本地目录筛选、清除和分页重置；全站快捷路径未逐页审查。 |
| 简洁美观 | **未完整验证**：本轮处理了状态层级和冗余提示，未完成全站像素/视觉审计。 |
| 识别、诊断和恢复错误 | **通过（定向）**：队列刷新、登记只读核对、别名重试和 API 状态重查有明确路径。 |
| 帮助与文档 | **部分验证**：关键权限/未授权状态有就地说明；全站帮助覆盖仍缺。 |

最高影响的三类问题都已有本地回归：不确定的写入结果可只读核对；失败读取不再显示成成功的空结果；高影响规则变更需看清范围并确认。三者只说明相关旅程改善，不代表全项目或唯一 Demo 验收。
