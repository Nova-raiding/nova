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

路由页面清单按 `apps/ops-console/src/navigation` 当前 registry：Overview、Users、Customer Delivery、Members、Tasks、Knowledge、Stores、Rules、Models、Storage、Finance、Support、Audit、Incidents。

| 页面 | 页面级/浏览器证据 | 当前状态/下一步 |
|---|---|---|
| Overview | `OverviewPage.browser.test.tsx` | 有本地页面旅程 |
| Users | `OpsConsoleController.identity-route.browser.test.tsx` 与邀请恢复 fixture | 本轮新增/扩展路由级恢复验证 |
| Customer Delivery | authorization/create/session loss/browser suites | 多条隔离旅程；真实业务数据未测 |
| Members | 当前有页面/组件与权限单测 | 路由组合 browser journey 待补 |
| Tasks | `BrandStoreTasksDeepLink.browser.test.tsx` 与任务组件 fixture | 仅深链/组件专项；完整页面组合待补 |
| Knowledge | `LearningSuggestionsPanel`/读状态/辅助 single-flight 单测共 11 项通过 | `/ops/knowledge?workbench=workspace` 被现有工作台权限策略拦截，审批路由旅程无法在此控制台验收；归属需产品决策 |
| Stores | 撤权失败提示/目标保留的浏览器断言可通过 | 单项回归通过；完整文件顺序运行不稳定，失败等待重试按钮可见；仍需修复/复核 |
| Rules | `RulesPage` 单测和 sync retry browser fixture | 新增失败后页面内恢复验证；单测和 browser 通过 |
| Models | `ModelsPage.overview-navigation.browser.test.tsx` | 模型计费页新增直达总览按钮；单测 4/4、浏览器 1/1 |
| Storage | `StoragePage.error.browser.test.tsx` | 错误单一呈现与重试已在本地 Chromium 验证 |
| Finance | 页面单测、费用/收据专项用例 | 全页面筛选与错误恢复旅程仍缺 |
| Support | `SupportPage.error.browser.test.tsx`、队列/详情/分页/回复专项 | Support error 1/1，单测 2/2；9-file 串行批次 8/11。whitespace fixture 未 mount；Audit truncation 标题 timeout；另有 locator timeout 已单项修复通过 |
| Audit | 页面/中心/筛选单测及导出 Chromium | AuditPage 4/4、AuditCenter 10/10、filters 2/2；导出单项 2/2。完整路由级筛选到导出旅程仍缺 |
| Incidents | `IncidentsPage.error.browser.test.tsx` | 本轮新增初次失败、重试、状态筛选与清除筛选旅程 |

## 验收边界

- “有 browser test”只表示代码仓库存在相应 fixture；执行结果和覆盖断言须按对应 QA 轮次记录。
- 每一页面旅程还需覆盖可见按钮、键盘焦点、筛选/输入、确认/取消、错误与重试、路由和 workspace 切换中适用的项目。
- 页面/组件测试不能替代 API、权限、租户隔离、模型 relay、worker、数据库 RLS 与唯一 demo 的真实运行环境验收。
- 下轮复核应优先补齐 Models、Audit、Knowledge、Members、Stores、Finance、Tasks 的路由级桌面 journey，再逐模块检查操作控件和空/加载/错误状态。
- 目前 Merchant/ Ops 之外的 API、MCP、worker、persistence、migration 和 release tooling 仍需单独按 CodeGraph 调用链与对应运行证据审查；此 UI 清单不覆盖这些代码。
