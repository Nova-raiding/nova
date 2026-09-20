# 运营台 dogfood 断言退役记录

- 建立日期：2026-09-20（Asia/Shanghai）
- 决策依据：以 `365c5d84`「fix ops pagination and customer delivery workflow」定义的当前权威运营台界面为准（该提交删除 `FinancePage`、移除 `finance` 域、把平台侧栏收敛为单一导航组），不修改界面，退役不再有承载面的断言。
- 适用范围：`dogfood/chatgpt-all-functions/ops-all.spec.js`、`dogfood/chatgpt-all-functions/ops-users.spec.js`。

## 为什么会有这份记录

平台运营台的 dogfood 套件在 2026-09-16 的导航收敛之前编写，断言挂在当时存在的界面上。之后的提交把平台侧栏收敛为 `总览 / 用户中心 / 客户交付` 三项目标，`账务与退款` 与 `模型服务` 两个可点入口消失；用户中心在 2026-09-14 的四个界面提交里也换掉了一批控件。

如果直接删掉这些断言，覆盖度的下降会变成无声的：下一个人看到绿灯，无法知道少了什么。因此每一条退役都登记在此，写清楚断了哪个面、哪个提交断的、当前还有什么在覆盖、以及要恢复应该改哪里。

**这不是「测试没通过所以放宽」，而是「被测界面已由产品决定移除」。** 判定基于源码 import 图 + 提交历史 + 2026-09-20 在隔离栈（`OPS_OIDC_BASE_URL`，PG17/Redis 全隔离）上真实浏览器测量到的可达性，不是推断。

## 与 `retired-merchant-assertions.md` 的一处差异（已知缺口）

商家记录由 `tests/merchant-dogfood-retirements.test.ts` 强制：它双向钉住「退役的写法不得回到 spec」和「每条退役必须在记录里被点名」。**运营台目前没有对应的门禁测试**，所以本文件第 1–9 条只有文字约束，没有机器约束（第 1、5 条的两个界面缺席由 `ops-all.spec.js` 的反向门禁与 `OpsSidebar.test.tsx` 直接断言，但「写法不得回到 spec」这一半仍无人守）。补齐方式见文末「仍然存在的缺口」。

## 退役清单

| # | 用例位置 | 原断言的安全面 | 移除提交 | 当前覆盖情况 |
|---|---|---|---|---|
| 1 | `ops-all.spec.js` `platformSections` | 平台侧栏 `模型服务`、`账务与退款` 两个**可点按钮**必须存在，点开后分别落在 `模型服务` / `平台财务中心` 标题上 | `365c5d84` | `365c5d84` 把 `models` 从 `OpsSidebar.navigationGroups` 摘除、把 `finance` 从 `opsDomains` + `navigationGroups` + `domainReadCapabilities` 一并删除，两个按钮在平台界面**已无任何承载面**。取而代之的是 `ops-all.spec.js` 新增的反向门禁 `keeps the withdrawn finance and model navigation surfaces unreachable`（断言它们确实不可达），以及 `OpsSidebar.test.tsx` 的 `keeps the withdrawn finance destination out of the platform navigation`。`opsNavigation.test.ts` / `tests/ops-navigation.test.ts` 断言 `/ops/finance` 归一化为 `overview` |
| 2 | `ops-all.spec.js` 原 `if (section === '账务与退款')` 段 | 平台财务中心里 `当前租户成员` 计数为 0、`成员角色调整` 计数为 0（即：平台财务面不得泄漏租户成员治理控件） | `365c5d84` | 载体 `FinancePage.tsx` 已删除（-232 行）。`当前租户成员` 那半条仍由用户中心段落覆盖（`ops-all.spec.js` 用户中心分支保留 `toHaveCount(0)`）；**`成员角色调整` 在平台界面已无任何替代面** |
| 3 | `ops-all.spec.js` 原 `导出商业配置` 下载分支 | 点击 `导出商业配置` 后下载文件名为 `ops-commercial-<YYYY-MM-DD>.csv`、内容含表头 `kind,id,code` | `365c5d84` | **这条断言在被删之前就已经是死代码**：它的进入条件是 `exportButton.count() !== 0`，而 `导出商业配置` 只存在于 `apps/ops-console/src/components/finance/PlanBillingSection.tsx:16`，该组件自 `2440b44b`（初始导入）起在 `apps/ops-console/src` 全历史中**从未被任何文件 import**（对 600 个提交做过全量 `git grep`）。所以删除它**没有损失任何真实覆盖**。服务端 `ops.commercial.export` 仍在（`apps/api/src/server.ts:16241`，`platform_ops` 门禁，csv/json 双格式），但成功路径**零覆盖**：`apps/api/src/mcp-completion-content.e2e.test.ts:247` 唯一一次命中它，断言的是 `503 COMMERCIAL_OPERATION_DISABLED`；`ops-commercial-` 这个字面量全仓只出现在 `apps/api/src/server.ts:16253,16263` |
| 4 | `ops-all.spec.js` 原财务段的 `else` 兜底断言 | `账务与退款` 页必须呈现 `商业配置` / `商业访问` / `上线门禁` / `商业化生产门禁` 之一（商业上线证据对运营可见） | `365c5d84` | **这是本批退役里唯一一条真实丢失的运营可见保证。** 它的载体是 `FinancePage.tsx` 里那张 `商业化生产门禁` Card（内嵌 `CommercialReadinessPanel`），随页面一起删除。`CommercialReadinessPanel` 组件本体仍在，但**已无任何挂载点**；平台上再没有一处向运营呈现「商业化能否上线」的浏览器证据 |
| 5 | `ops-all.spec.js` 的 `模型服务` `continue` 豁免 | （豁免本身）`模型服务` 按钮缺失时跳过而不报错 | `365c5d84` | 豁免随入口消失而成为死代码，已删除。`模型服务` 在平台侧栏不可达这一事实改由第 1 条的反向门禁断言 |
| 6 | `ops-all.spec.js` 第二个用例 `does not report model configuration success when model status fails` | `平台.model.status` 读取失败后，`状态不可用` 徽标必须在模型面可见 | `365c5d84`（模型面收敛） | 已**重锚**而非消失：改为断言产品真正的 fail-closed 信号 —— 全局加载警告 `.ops-global-load-warning` 必须可见、必须写明「部分运营数据未刷新 / 个数据集刷新失败」、展开后必须点名 `platform.model.status`；`状态不可用` 与 `平台模型配置完整` 均断言 `toHaveCount(0)`。可用性上比原断言更强（原断言只要求徽标出现，不要求点名失败数据集） |
| 7 | `ops-users.spec.js` `导出当前筛选` 下载断言 | 点击 `导出当前筛选` 下载 `ops-users-<YYYY-MM-DD>.csv`、表头含 `external_subject,display_name,workspace_id` | `cc2f01cb` `ui: simplify user status filter` | 控件已从用户目录面板移除，浏览器里没有可点的导出。服务端 `ops.users.export` 的 csv 形态仍有真实覆盖：`apps/api/src/ops-users-directory.e2e.test.ts:176` 断言 `format: 'csv'` 的 `count` 与内容包含目标 subject；`mcp-completion-content.e2e.test.ts:238,347` 覆盖 json 形态与未授权拒绝。**但 `ops-users-<date>.csv` 这个文件名、以及 `external_subject,display_name,workspace_id` 这个表头首段，已无任何替代面**（`apps/api/src/server.ts:15730,15733` 仍生成它们，只是没有断言） |
| 8 | `ops-users.spec.js` `清空` 按钮 | 点 `清空` 复位筛选，断言「筛选空态可逆」 | `cc2f01cb` | 控件已移除。已**重锚**：改为清空关键词输入框后重新点 `查询`，仍然断言筛选空态可以回到非空（`toHaveCount(1)` 反向断言 + 表格行数恢复）。保证本身没有丢 |
| 9 | `ops-users.spec.js` 用户详情抽屉的四段断言 | `认证会话（已脱敏）`、`平台身份生命周期`、`所属租户与角色`、`成员操作历史` 四段必须在抽屉里可见 | `f84b9561` `ui: remove sessions and simplify store details`、`1b7d8799` `ui: simplify user detail drawer` | 抽屉已改为按企业主体聚合的商业视图。已**重锚**到当前真实结构：`店铺详情` / `月费详情` / `钱包` / `当月消耗表` / `用户总消耗金额`（`apps/ops-console/src/components/users/UserDirectorySection.tsx:338,344,350,357,364`）。**被脱敏会话列表、身份生命周期、租户角色摘要、成员操作历史这四类信息在用户中心已无任何承载面**——这是真实丢失，不是改名 |

## 产品面证据：`components/finance` 与 `components/commercial` 已整树孤立

第 3、4 条不只是「测试没地方挂」。2026-09-20 在 `010cab8d` + 当前工作树上做了一次 import 图核查，结论是**整个财务/商业前端面都没有挂载点**，而不是只有 `PlanBillingSection` 一个组件：

- `apps/ops-console/src` 里对 `components/finance/**` 与 `components/commercial/**` 的**非测试 import 只有 4 条**：`hooks/useOpsConsoleModel.ts:62`（`financePermissions`）、`:64`（`rechargeOrders` 纯函数）、`pages/MembersPage.tsx:2`（`MembersSection`）、`pages/ModelsPage.tsx:2`（`ModelMarkupPanel`）。前两条是纯逻辑，后两条的宿主页面自身也不在平台侧栏（`members` 不在 `mainItems`，`models` 在 `mainItems` 但被 `navigationGroups` 排除）。
- `FinanceSearchSection`、`ReconciliationSection`（finance 版）、`RechargeOrdersSection`、`RefundSection`、`CommercialOperationsWorkspace`、`CommercialReadinessPanel`、`PlanBillingSection`、`OfferTable`、`AddonTable`、`CouponTable`、`RolloutTable` —— 除各自的 `.test.*` 外**零 importer**。
- `pages/MembersPage.tsx` 里的 `billing: "账务与退款"` 只是权限矩阵的**能力分组标签**（`capabilityGroupLabels`），不是财务页面入口。

所以 `365c5d84` 删掉的不只是一条导航项：它删掉了**唯一**挂载这整棵子树的页面，且没有替代承载面。

**判定要回答的问题**（本文件只登记，不自行恢复 —— 恢复界面属于产品决定）：
1. 平台财务检索（`billing.platform.read` → `ops.finance.search`）是否还需要运营人员**在浏览器里**做？若是，`FinancePage` 需要重建。
2. 「商业化生产门禁」证据（`CommercialReadinessPanel`）是否需要一个运营可达的挂载点？这是第 4 条丢失的保证。
3. 企业主体侧的 `账务与商业配置`（`ReconciliationSection` / `RechargeOrdersSection` / `RefundSection` / `CommercialOperationsWorkspace`）随 `finance` 域一起从运营台消失，是否是有意为之？如果不是，`/ops/finance?workbench=workspace` 的深链接现在会被归一化到 `overview`，用户**看不到任何提示**就落到总览。

## 被禁用的断言写法

以下写法不得再出现在 `dogfood/chatgpt-all-functions/ops-all.spec.js` 与 `ops-users.spec.js` 里。**目前没有门禁测试强制这一节**（见文末缺口），所以它现在只是评审约束。

```
导出商业配置
ops-commercial-
平台财务中心
导出当前筛选
认证会话（已脱敏）
平台身份生命周期
所属租户与角色
成员操作历史
platformSections = ['总览', '用户中心', '模型服务', '账务与退款']
```

例外：`ops-all.spec.js` 的**反向门禁**用例可以、也应该出现 `账务与退款` / `模型服务` / `导出商业配置` / `平台财务中心` 这些字符串——它断言的正是它们的**缺席**。这与商家记录「只匹配代码形式、绝不匹配裸词」的取舍相冲突，是运营台记录暂时没有门禁测试的原因之一，补齐时需要按调用点形状而非裸词来匹配。

## 仍然成立的替代覆盖（重锚，不是退役）

- `ops-users.spec.js` 的用户目录表定位：`成员状态` → `激活状态` 列头。这是**重锚到真实信号**，不是放宽——`7f6cf3f4` `ui: streamline user center filters and columns` 确实把该列由 `成员状态` 改名为 `激活状态`（`UserDirectorySection.tsx:233`）。
- `ops-users.spec.js` 停用对话框：新增「只填操作原因不足以启用确认按钮」+ 选择审批人后才启用。这是**新增覆盖**，不是退役。
- `ops-all.spec.js` 的 `状态不可用` 断言：见退役清单第 6 条，已重锚到全局加载警告。

## 另一条与当前产品事实矛盾的 spec（未处理，仅登记）

`dogfood/chatgpt-all-functions/ops-mcp-request-matrix.spec.js` 仍写死于收敛前的路由表：

- `:18` `['账务与退款', '/ops/finance?workbench=platform']`
- `:27` `['账务与退款', '/ops/finance?workbench=workspace']`
- `:62` `'账务与退款': '平台财务中心'`
- `:67` `if (label === '账务与退款' && workbench === 'workspace') return '账务与商业配置'`

`/ops/finance` 现在归一化到 `overview`，所以这两条 walk 会等到 `平台财务中心` 标题超时 —— **这个 spec 如果被运行就是红的**，不是「绿灯撒谎」。它未被任何脚本引用（`npm run test:browser:ops` 不含它，`tests/` 里也没有引用），因此当前不构成有效门禁。本次**未修改**该文件：它是一份围绕 `platformSections` 逐域走查的矩阵 spec，只手改两条 label 会留下其余按旧路由表写的假设，风险大于收益。建议由 owner 决定是删除整个 spec、还是把它重写成收敛后的域集合。

## 要恢复这些覆盖，应该改哪里

1. **导航域（第 1、2 条）**：`apps/ops-console/src/navigation/opsNavigation.ts:3`（`opsDomains`）、`:21`（`requiredWorkbenchForDomain`）、`:66`（`urlForDomain` 路由正则）、`domainFromLocation` 里 `/ops/finance` 的两条归一化分支、`apps/ops-console/src/components/OpsSidebar.tsx:39,48`、`apps/ops-console/src/authz/authorization.ts:36`（`domainReadCapabilities`）、`apps/ops-console/src/navigation/opsPageRegistry.tsx`。注意 `opsPageRegistry` 是 `Record<OpsDomain, OpsDomainPage>`，加回 `finance` 必须同时提供一个页面组件。
2. **财务页面（第 2、4 条）**：`FinancePage.tsx` 已删除，`git show 365c5d84^:apps/ops-console/src/pages/FinancePage.tsx` 可以取回全文（232 行，含 `商业化生产门禁` Card 与 `PlatformCatalogManagementPanel`）。
3. **商业配置导出（第 3 条）**：`apps/ops-console/src/components/finance/PlanBillingSection.tsx` 组件本体在（52 行），`apps/ops-console/src/hooks/useOpsConsoleModel.ts:1616` 的 `exportCommercial` 也在，两者都只是没有挂载点。挂载即可用，不需要重写逻辑。服务端 `ops.commercial.export` 完整。
4. **用户导出（第 7 条）**：`apps/ops-console/src/components/users/UserDirectorySection.tsx` 的用户目录面板需要重新渲染导出控件。
5. 恢复属于**界面变更**，需要产品重新评审，因此本记录不自行恢复，只登记。

## 仍然存在的缺口（交给 owner 的三件事）

1. **补一个运营台版的门禁测试**（对应 `tests/merchant-dogfood-retirements.test.ts`）：双向钉住「被禁用的写法不得回到 ops spec」与「每条退役在本文件里被点名」。这是本文件目前唯一的机器保障缺口。
2. **第 4 条是真实丢失的运营保证**：`商业化生产门禁` 证据面板在所有可达页面里都没有挂载点。这不是测试问题，是产品问题。
3. **第 9 条的四类用户信息**（脱敏会话、身份生命周期、租户角色、成员操作历史）在用户中心已无承载面。
