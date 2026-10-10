# UI 页面覆盖清单（2026-10-10）

本清单用于按真实路由追踪桌面端页面、关键交互和浏览器证据。它不是“项目已完成”声明：组件单测或 source assertion 不等于页面旅程通过；任何本地 fixture 结果也不等于唯一 Demo 的真实租户验收。

## Merchant Studio

页面由 `demo/merchant-studio/src/navigation.ts` 的 `merchantPages` 路由清单定义，商品页内部还有产品、品牌资产、素材库、回收站子入口。

| 页面/子入口 | 当前可定位的浏览器证据 | 当前状态/下一步 |
|---|---|---|
| 运营概览 `/merchant/overview` | `overview-finance.browser.spec.js`、商家风险跳转、总览专项 | 有本地 journey；仍需检查全部概览卡片和失败恢复 |
| 商品与店铺 `/merchant/products?section=products` | catalog search/filter、深链、导入、手动登记、日期范围 | 有多条本地 journey；本轮继续扩充未覆盖交互 |
| 品牌资产 `/merchant/products?section=assets` | 品牌 scope 上传/竞态、上传重试 fixture | 有专项 journey；需核对保存后回读与全部表单错误态 |
| 素材库 `/merchant/products?section=knowledge` | 素材搜索/预览/导入、素材权益控件（本轮浏览器验证） | 受限 scope 无法升级商用；approved restricted 仍可调整。服务拒绝与保存后 GET 回读已覆盖；老 AssetLibrary 无路由 caller |
| 回收站 `/merchant/products?section=trash` | `material-recycle-bin.browser.spec.js` | 有本地 journey；真实租户隔离未验证 |
| 财务 `/merchant/finance` | `overview-finance.browser.spec.js`、购买中心浏览器测试 | 有局部 journey；页面组合筛选/错误恢复仍需覆盖 |
| 成员 `/merchant/members` | 隔离 workspace/member 浏览器 runner | 有认证/成员专项；真实账号权限未验收 |
| 任务 `/merchant/tasks` | task queue、image-generation、delivery-readiness 路径 | 成功选择候选后锁定旧选择表单的 Chromium 回归 1/1；交付错误恢复 1/1、7 tests；完整页面组合仍需覆盖 |
| 发布历史/发布详情（任务子流程） | `publish-history.browser.spec.js` | 有列表、深链和恢复 journey；tab ARIA 与键盘交互已补并有专项回归 |
| 规则 `/merchant/rules` | `rules-page-interactions.browser.spec.js` | 有浏览器专项；需按真实规则状态继续覆盖 |

## Ops Console

实际 Ops domain 清单以 `opsDomains` 和 `opsPageRegistry` 为准，共 13 个：Overview、Users、Customer Delivery、Members、Tasks、Knowledge、Stores、Rules、Models、Storage、Finance、Support、Audit。`IncidentsPage` 有独立组件与浏览器 fixture，但 `incidents` 不在 `opsDomains`、路由识别、页面 registry 或 sidebar 中，`IncidentsRoute.tsx` 也没有生产调用方；不能把它记为可访问的 Ops 页面或路由旅程。Ops Console 明确只激活 platform workbench；Members、Tasks、Knowledge 所需的 workspace workbench 在 `canActivateOpsWorkbench()` 中被拒绝，直达这些 workspace 路由会进入阻断恢复页，不应记作已验收页面。

分类约定：**已完成（定向）** = 本地浏览器旅程有明确通过收据，只表示该旅程；**有测试未完成/未执行** = 存在相关测试或断言，但当前没有完整、可归属的通过收据；**无页面覆盖** = 没有对应可访问页面的浏览器旅程。任何一类均不代表唯一 Demo 实机验收。

| 页面/路由 | 分类 | 可核对证据与缺口 |
|---|---|---|
| Overview `/ops/overview` | 有测试未完成/未执行 | `OverviewPage.browser.test.tsx` 存在；本状态账本没有可归属的最新完整执行收据。 |
| Users `/ops/users` | 有测试未完成/未执行 | `OpsConsoleController.identity-route.browser.test.tsx` 存在；邀请恢复仅有 fixture/专项，完整用户中心页面旅程收据缺失。 |
| Customer Delivery `/ops/customer-delivery` | 有测试未完成/未执行 | 存在授权、创建、session-loss、归档等隔离 journey；不能合并为整页验收，当前账本没有这轮完整页面旅程收据。 |
| Members `/ops/members` | 有测试未完成/未执行 | 新增的 route browser 场景检查平台账号明确阻断、sidebar 不显示 workspace 页，以及“返回总览”；首次运行 **2 tests failed**，因测试 fixture 在 Node 回调中读取 `window`，已移除该错误并改为匹配实际 `role=status`，修订尚未复跑。成员邀请/角色/状态/分页/恢复 journey 无覆盖；该页面按现有工作台边界在 Ops 中不可达。 |
| Tasks `/ops/tasks` | 有测试未完成/未执行 | `BrandStoreTasksDeepLink.browser.test.tsx` 只覆盖任务深链；完整页面列表、筛选、输入、空/错恢复没有页面旅程收据。 |
| Knowledge `/ops/knowledge` | 无页面覆盖 | 组件/读状态单测存在；`workbench=workspace` 由平台控制台 fail closed，审批路径不属于可访问的 Ops 页面。 |
| Stores `/ops/stores` | 有测试未完成/未执行 | 店铺绑定/目录/注册/撤权等独立浏览器用例存在；完整 route page 组合及当前修改后顺序运行无通过收据。 |
| Rules `/ops/rules` | 有测试未完成/未执行 | 页面单测与 sync retry browser fixture 存在；当前状态账本没有完整 route journey 的归属收据。 |
| Models `/ops/models` | 已完成（定向） | `ModelsPage.overview-navigation.browser.test.tsx` + `StoragePage.error.browser.test.tsx` 合计 **4/4**；覆盖总览跳转、倍率读重试/审计保存、relay fail-closed、存储错误重试。完整模型成本/真实 relay 仍未验收。 |
| Storage `/ops/storage` | 已完成（定向） | 与 Models 同一浏览器批次 **4/4**；仅本地 fixture 的错误恢复和对账重载，不是 Demo 存储一致性证据。 |
| Finance `/ops/finance` | 有测试未完成/未执行 | 高级筛选浏览器专项 **2/2**，API/Hook/组件 **26/26**；仍没有全页查询、组合筛选、错误恢复与真实账务旅程的完整 route 收据。 |
| Support `/ops/support` | 有测试未完成/未执行 | 详情错误、队列/分页/回复等多项浏览器测试存在；最近可归属的完整串行批次曾有失败，修订后没有完整全套通过收据。 |
| Audit `/ops/audit` | 已完成（定向） | 完整 route journey **5/5**；覆盖范围筛选、脱敏详情、导出失败重试/CSV、聚合只读、空目录和目录错误恢复，均为本地 RPC fixture。 |
| Incidents `/ops/incidents` | 无页面覆盖（路由不存在） | 独立 `IncidentsPage.error.browser.test.tsx` 覆盖组件状态，不证明生产路由存在；`/ops/incidents` 会作为未知 Ops path 退回 Overview。已有组件旅程不可计入 Ops 页面覆盖。 |

## 验收边界

- “有 browser test”只表示代码仓库存在相应 fixture；执行结果和覆盖断言须按对应 QA 轮次记录。
- 每一页面旅程还需覆盖可见按钮、键盘焦点、筛选/输入、确认/取消、错误与重试、路由和 workspace 切换中适用的项目。
- 页面/组件测试不能替代 API、权限、租户隔离、模型 relay、worker、数据库 RLS 与唯一 demo 的真实运行环境验收。
- 下轮复核应优先补齐 Models、Audit、Knowledge、Members、Stores、Finance、Tasks 的路由级桌面 journey，再逐模块检查操作控件和空/加载/错误状态。
- 目前 Merchant/ Ops 之外的 API、MCP、worker、persistence、migration 和 release tooling 仍需单独按 CodeGraph 调用链与对应运行证据审查；此 UI 清单不覆盖这些代码。
