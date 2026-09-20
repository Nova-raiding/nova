# 商家工作台 dogfood 断言退役记录

- 建立日期：2026-09-20（Asia/Shanghai）
- 决策依据：以评审版 UI 为准（`2e055921` / `fdd6deac` / `02b4843a` 三个界面提交定义了当前权威界面），不修改 UI，退役不再有承载界面的断言。
- 适用范围：仅 `dogfood/chatgpt-all-functions/merchant-*.spec.js` 的桌面浏览器用例。

## 为什么会有这份记录

商家工作台的 dogfood 套件在 2026-09-19 的界面精修之前编写，断言挂在当时存在的界面上。之后的三个提交把界面收敛为评审版，其中一部分被断言的安全面**在商家工作台里已完全不存在**，不是选择器改名。

如果直接删掉这些断言，覆盖度的下降会变成无声的：下一个人看到绿灯，无法知道少了什么。因此每一条退役都登记在此，写清楚断了哪个面、哪个提交断的、当前还有什么在覆盖、以及要恢复应该改哪里。

**这不是「测试没通过所以放宽」，而是「被测界面已由评审决定移除」。** 判定全部基于 2026-09-20 在 `eca3a4ca` 上构建的 candidate 栈的真实浏览器测量，不是源码推断。

## 退役清单

| # | 用例位置 | 原断言的安全面 | 移除提交 | 当前覆盖情况 |
|---|---|---|---|---|
| 1 | `merchant-data-safety.spec.js:71` `model relay readiness is visible before a merchant starts a task` | `.environment-banner` 显示「模型中转未就绪」+ `查看系统健康` 对话框 | `2e055921` | 服务端契约由 `apps/api/src/server.e2e.test.ts` 覆盖；**商家界面无任何替代面** |
| 2 | `merchant-data-safety.spec.js:112` `fixture health never presents the merchant workspace as production ready` | 同上，`data-environment-state="demo"` / `演示环境 · 不可上线` | `2e055921` | 同上 |
| 3 | `merchant-data-safety.spec.js:161` `closed writes keep a production-mode workspace visibly blocked` | 同上，`data-environment-state="blocked"` / `当前环境不可上线` | `2e055921` | 同上 |
| 4 | `merchant-interactions.spec.js:17`（`exercise Merchant Studio safe interactions…` 的系统健康段落） | `系统健康` 按钮 → `系统健康与上线状态` 对话框、`重新检查模型中转` 重试路径 | `2e055921` | 同上 |
| 5 | `merchant-workspace-roles.spec.js` 的 `.environment-banner` 断言 | `.environment-banner` 可见 | `2e055921` | 该文件未装载进 `test:browser:merchant`；断言已改为「该角色能看到评审版外壳」（`运营概览` 入口可见），角色→鉴权头的断言保留 |
| 6 | `merchant-data-safety.spec.js:410` `rule and category API failures never reveal demos and independent retries recover real data` | `知识库 > 规则库` 入口、规则/品类 API 失败与重试的界面状态 | `fdd6deac` | 规则读写的服务端契约由规则相关 API 测试覆盖；**商家界面无规则库入口** |
| 7 | `merchant-data-safety.spec.js:453` `successful empty rule and category APIs show true empty states without demos` | 同上，`rules-api-empty` / `categories-api-empty` 空态 | `fdd6deac` | 同上 |
| 8 | `merchant-data-safety.spec.js:576` `task list shows loading, then a true empty state only after a successful response` | `知识库 > 营销任务` 任务队列的加载/空态区分 | `fdd6deac` | 任务列表服务端契约由任务 API 测试覆盖；**商家侧任务队列已无一等入口** |
| 9 | `merchant-data-safety.spec.js:595` `task list keeps error distinct from empty and retry can recover to data` | 同上，错误态与空态区分 | `fdd6deac` | 同上 |
| 10 | `merchant-data-safety.spec.js:617` `task list remains visible when auxiliary product identity fails and retry recovers` | 同上，附属商品身份失败时的列表恢复 | `fdd6deac` | 同上 |
| 11 | `merchant-data-safety.spec.js:671` `knowledge navigation keeps publishing inside the marketing task workflow` | `知识库 > 营销任务` 一级入口存在，且发布不脱离营销任务流 | `fdd6deac` | 「发布中心不存在」这半条仍成立，已并入 `:656` 的替代用例 |
| 12 | `merchant-data-safety.spec.js:681` `both sync-all entry points target every readable store including same-platform stores` | 概览 `同步全部店铺` 按钮逐店同步 | `c2eafb72`（CSS 注释：`Overview simplification requested during visual review.`） | 店铺同步的服务端契约由平台账号/同步 API 测试覆盖；**商家工作台已无同步入口** |
| 13 | `merchant-data-safety.spec.js:715` `store discovery failure disables sync and sends no sync request` | 店铺发现失败时同步按钮禁用且不发请求 | `c2eafb72` | 同上 |
| 14 | `merchant-all.spec.js` 的概览版式断言（`.platformShare ≥ 0.98`、`visibleDashboardChildren === 1`、`scrollHeight ≤ viewportHeight`） | 概览 `article.platform-panel` 铺满 `dashboard-grid` 且整页不滚动 | `c2eafb72` | 被测量的 `article.platform-panel` 父级就是被 CSS 隐藏的 `.dashboard-grid`，量到的一律是 0；已改为断言可见的概览地标（`今日看板`/`账号看板`/`事务看板`）与「被视觉评审隐藏的三个面保持隐藏」 |
| 15 | `merchant-all.spec.js` 的 `utilitySections = ['查看系统健康与上线状态']` 遍历 | 逐个打开工具面板 | `2e055921` | 与 1–4 同因；该面板已无法从商家界面打开 |
| 16 | `merchant-all.spec.js` 在**概览页**做的全局搜索 | 概览存在 `搜索商品` 输入并可按关键词过滤 | `c2eafb72` | 概览已无搜索框；搜索框现在只在商品目录页（`merchant/tasks/new`）。原代码用 `if (await search.count())` 包着，界面改掉后是**静默跳过**、仍然绿灯——已改为在商品目录页执行并硬断言 `toHaveCount(1)`，不再允许静默流失 |

## 被禁用的断言写法

以下代码写法不得再出现在 `dogfood/chatgpt-all-functions/merchant*.spec.js` 里，由 `tests/merchant-dogfood-retirements.test.ts` 强制。要重新启用其中任何一条，必须先在评审里决定恢复对应界面，再同步更新本文件与那条门禁——不允许静默加回。

```
locator('.environment-banner')
name: /系统健康/
name: '查看系统健康'
getByRole('button', { name: '知识库', exact: true })
name: /商品目录/
name: '同步全部店铺'
'暂无营销任务'
rules-api-empty
categories-api-empty
utilitySections
openKnowledgeEntry
```

## 测量证据（2026-09-20，`eca3a4ca` candidate 栈）

`/merchant/overview` 用真实浏览器测得的商家可见界面：

```
.environment-banner               0 个元素
[class*=health]                   0 个元素
系统健康 / 查看系统健康 按钮        0 个
规则库 / 品类库 文本               全站 0 处（?section=rules 被归一化为 ?section=knowledge）
任务队列 / 暂无营销任务            全站 0 处
.overview-sync-actions            1 个元素，computed display:none
.data-integrity-panel             1 个元素，computed display:none
账户菜单 / 待处理问题面板          无任何环境或上线状态文案
```

`.overview-sync-actions` 与 `.data-integrity-panel` 是被 CSS 显式隐藏的，源码里写明是视觉评审的要求，属于评审决定；`.environment-banner`、`系统健康`、`规则库`、`任务队列` 是组件被卸载后遗留的死代码（`EnvironmentStatusBanner` 定义于 `App.tsx:1129`、`AssetLibrary` 定义于 `App.tsx:3075`，均无任何挂载点）。

## 仍然成立的替代覆盖（重锚，不是退役）

以下用例的界面还在，只是位置或名字变了，已改为断言评审版界面：

- 商品目录表（`商品目录` + `创建任务` + `搜索商品或平台` + 待确认筛选）现由 `merchant/tasks/new` 归一化后的产品工作流承载；原 `知识库 > 商品目录` 两步点击改为直接走该路由。
- `merchant/rules` / `merchant/publish` 归一化后落在知识工作区，落地标题由 `知识库` 改为 `素材库`（`merchant/products?section=knowledge`）。
- `merchant-all.spec.js` 的遍历章节由 `['运营概览','知识库']` 改为评审版侧栏的六项（`运营概览` / `平台&店铺&商品` / `品牌资产` / `素材库` / `回收站` / `财务概况`）。
- 概览 `同步全部店铺` 与 `.data-integrity-panel` 断言改为断言「按视觉评审要求隐藏」，而不是断言可见。

验证：2026-09-20 在 `eca3a4ca` 构建的 candidate 栈上，`merchant-all` / `merchant-interactions` / `merchant` / `merchant-data-safety` 四个文件 **13 passed / 0 failed**（改动前为 3 passed / 21 failed）。

## 要恢复这些覆盖，应该改哪里

1. 组件本体都还在（`EnvironmentStatusBanner`、`AssetLibrary`、`UtilityPanel` 的 health 分支），恢复＝把挂载点加回去，不需要重写逻辑。
2. `resolveMerchantEnvironmentStatus` 仍在被 `UtilityPanel` 调用（`App.tsx:1382`），服务端状态映射逻辑完整。
3. 恢复属于**界面变更**，需要客户重新评审，因此本记录不自行恢复，只登记。
