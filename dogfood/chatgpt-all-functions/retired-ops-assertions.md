# 运营台 dogfood 断言退役记录

- 建立日期：2026-09-20（Asia/Shanghai）
- 适用范围：`dogfood/chatgpt-all-functions/ops-all.spec.js`、`dogfood/chatgpt-all-functions/ops-users.spec.js`。
- **2026-09-20 更新：本记录的决策前提已被 owner 部分推翻。** 见下一节。
- **2026-09-21 更正：本记录此前有四处出处写错**（`PlanBillingSection` 的 import 史与提交数、「唯一仍未挂载的根」、`ModelMarkupPanel` 的孤立、`models` 的撤出提交）。错句已就地标注，逐条复核见「更正」一节。
- **2026-09-21 第二次更新：`ops-mcp-request-matrix.spec.js` 的登记豁免已退役。** 该 spec 已按当前路由集对账，不再与产品事实矛盾，所以它此前「未处理，仅登记」从而被排除在反向门禁外的理由不再成立——继续留着就是「豁免活得比理由久」。详见对应小节；缺口 #5 相应更新。

## 更新：`finance` 一半已恢复（2026-09-20）

本文件原先的决策依据是「以 `365c5d84` 定义的运营台界面为权威」。这个前提**只在 `models` 上继续成立**；`finance` 上已被 owner 推翻，故该条不再作为依据。

- **裁定**：owner 在 `docs/qa/four-product-decisions-2026-09-20.md` 的四项决定中选 A —— **恢复 finance 导航域**。`models` 保持退役。
- **执行**：按 `365c5d84` 的逆向逐处回填，不是 `git revert`（该提交把这次删除与无关的分页/交付改动混在一起）。改动落在 `opsDomains`、`domainReadCapabilities`、`OpsSidebar.mainItems` + `navigationGroups`、`opsPageRegistry`、`OpsConsoleController.canAutoLoadModelMarkup`，并从 `365c5d84^` 取回 `FinancePage.tsx`（blob `b38d6290`，逐字节一致）。`release-metadata.json` 的 `opsDomainCount` 随之 11 → 12。
- **第 4 条那条唯一真实丢失的运营保证已经找回**：`pages/FinancePage.tsx:217-221` 重新挂载 `商业化生产门禁` Card（内嵌 `CommercialReadinessPanel`），`ops-all.spec.js` 现在直接断言该文案可见，而不只是断言走查回到 `账务与退款`。
- **第 1、2 条的 `finance` 部分不再是退役**：`platformSections` 重新包含 `账务与退款`，反向门禁改为「只断言 `模型服务` / `存储与对账` / `审计中心` 不可达 + 断言 `账务与退款` 可达」。
- **连带损伤一并修复**：`7152c9bd` 2026-09-20 把 `commercialBenefitDescriptions` 作为「四个死导出」之一删除，当时的核查「无引用」是**真的**——它之所以没有引用，正是因为 `FinancePage` 四天前刚被删。这是删除留下的二阶连带损伤，本文件旧版的「6 处配置」清单没有覆盖到它（`FinancePage.tsx:142` 依赖它，逐字恢复无法编译）。已在 `components/commercial/benefitLabels.ts` 按 `7152c9bd^` 原样补回，并在该处注释里写明「下次别再以『无人 import』为由删它」。
- **两条当时未被注意到的证据，说明这次移除更像漂移而非有意的产品决定**：`docs/product-usage-guide.md:331` 直到今天仍把「账务与退款」列为平台控制台页面，用途与产出都写着（文档从未随 `365c5d84` 更新）；以及上面那条二阶连带损伤。两者都不改变裁定，但都说明把它当作「有意的产品收敛」会掩盖一组连带损伤。

### 仍然没有恢复、且本次**没有**解决的两处

`导出商业配置`（第 3 条）**仍然没有挂载点**。恢复的 `FinancePage` 不 import `PlanBillingSection`，所以 `components/finance/PlanBillingSection.tsx`（连同 `AddonTable` / `CouponTable` / `OfferTable` / `RolloutTable`）在 finance 恢复后**依然是孤立的**。`ops-all.spec.js` 的反向门禁继续断言该按钮 `toHaveCount(0)`，注释里写明了这是「恢复 finance 也没有解决」的缺口，而不是「已随 finance 一起修好」。

**同批未解决的还有 `ConfigurationCenterSection`。** 这一段早先写的是「一处」（并在此后的小节里写成「唯一仍未挂载的根是 `PlanBillingSection`」），复核后发现 `components/finance/ConfigurationCenterSection.tsx` 同样没有挂载点：它的全部引用只有自身与 `ConfigurationCenterSection.test.tsx`——后者 `readFileSync` 自己的 `.tsx` 做源码断言，所以这个测试**不会**因为它没被挂载而变红。它没有任何 spec 断言覆盖，因此既不在 `ops-all.spec.js` 的反向门禁里，也不在本文件的「被禁用的断言写法」清单里；它现在只在这里被登记。见文首「更正」第 2 条。

## 更正：本记录此前写错的出处（2026-09-21 复核）

对抗性评审指出本记录有凭据不实的句子。逐条用 git 复核后更正如下。结论凡仍成立的都保留，并写明原来错在哪一半。复核的提交集是 HEAD，`git rev-list --count HEAD` = 1652（`--all` = 1857）；下面的 `git log -S` 与 `git show` 都在这个集合上跑。

**1. 第 3 条「`PlanBillingSection` 自 `2440b44b` 起从未被任何文件 import」——错。**

`git show 2440b44b:apps/ops-console/src/pages/FinancePage.tsx | grep -n PlanBillingSection` 显示该页当时既 import 又挂载它（`import { PlanBillingSection } from "../components/finance/PlanBillingSection"`、`<PlanBillingSection model={model} />`）。它是在 `c13cc673`（2026-09-01，「feat(commercial): add package entitlements and runtime gates」）把 `FinancePage` 正文换成 `CommercialOperationsWorkspace` 时才失去挂载点。全历史命中该 import 的只有两个提交：`2440b44b`（加）与 `c13cc673`（删）。

「对 600 个提交做过全量 `git grep`」也错：真实提交数是 1652（HEAD）／1857（`--all`），600 这个数没有任何来源。

**结论仍成立，理由要换**：这条 spec 分支被删时（`b3983595`，2026-09-20），`导出商业配置` 已自 `c13cc673`（2026-09-01）起 19 天没有挂载点，所以删掉下载分支没有损失当时的真实覆盖。但不能说它「生来就是死代码」——`e5facd77`（2026-09-01 08:08）加入该断言时 `FinancePage` 还挂着 `PlanBillingSection`，断言是活的；同日 22:24 的 `c13cc673` 才把它变成死代码（`747d1a07` 四天后给它加 `count() === 0` 守卫，正是因为按钮已经不在了）。

**2. 「唯一仍未挂载的根是 `PlanBillingSection`」——漏了一个。**

同一节下面还断言过「唯一」，真实清单是**两个**：`PlanBillingSection` 与 `ConfigurationCenterSection`。`ConfigurationCenterSection.tsx` 在全仓除自身与其源码扫描测试 `ConfigurationCenterSection.test.tsx`（它 `readFileSync` 自己的 `.tsx` 做断言）外零引用；`PlanBillingSection` 是 `AddonTable` / `CouponTable` / `OfferTable` / `RolloutTable` 的唯一 importer。其余 finance/commercial 组件都有非测试 importer：`grep -rn "components/finance/\|components/commercial/" apps/ops-console/src`（排除 `.test.`）只有 7 个文件 17 行，逐条可查。

**3. 「`ModelMarkupPanel` 整树孤立」——错。**

`apps/ops-console/src/pages/ModelsPage.tsx:2` import、`:17` 渲染它；`opsPageRegistry` 仍把 `models` 域映射到该页。准确的说法是：**它被挂载，但宿主页的 `models` 域本身不在 `navigationGroups`**，所以没有侧栏入口走得到它——与 `模型服务` 是同一处退役，不是「整树孤立」。后文 2026-09-20 的「核查方法更正」已经说过这一点，但「整树孤立」这个说法留在了标题里，构成同一文件内自相矛盾。

**4. `models` 撤出 `navigationGroups` 不是 `365c5d84` 干的。**

`git show 365c5d84^:apps/ops-console/src/components/OpsSidebar.tsx` 显示 model-billing 组当时已经写作 `items: ["finance"]`，`models` 早已不在其中。真正删除它的是 `5859f9b0`（2026-09-13，「chore: consolidate current code changes」），其 diff 是 `-{ key: "model-billing", ..., items: ["models", "finance"] }` → `+{ ... items: ["finance"] }`。`365c5d84`（2026-09-16）删的只有 `finance`（`mainItems` 的条目、整个 model-billing 组、`opsDomains` / `domainReadCapabilities` / `opsPageRegistry` 里的 `finance`、`FinancePage.tsx` 232 行），并且**保留并改写**了 `models` 在 `mainItems` 的条目（`description` 由「模型状态已并入账务中心」改成「查看模型状态与计费设置」）。

同一条更正也适用于第 5、6 条：`模型服务` 的 `continue` 豁免是 `fde0c4ba`（2026-09-14，`5859f9b0` 的次日）为了「按钮已经不在了」而加的——出生时就是死代码——删于 `b3983595`；第 6 条 `状态不可用` 的消失是 `5859f9b0`（models 页的 `ModelStatusSection`）与 `8d0b4ff2`（2026-09-15，「ui: refine operations console overview and users」，总览页的 `ModelServiceSummary`）两处，`365c5d84` 对 `ModelsPage.tsx` 的改动只是去掉「打开账务中心」按钮与改写 Alert 文案。

退役清单第 3 条其余引用复核后成立，未改：`apps/api/src/server.ts:16241` 是 `ops.commercial.export` 的 case，`:16253,16263` 是 json/csv 两个 `ops-commercial-` 文件名，`mcp-completion-content.e2e.test.ts:247` 是唯一调用它并断言 `503 COMMERCIAL_OPERATION_DISABLED` 的 e2e。（客户端调用点另有一处 `hooks/useOpsConsoleModel.ts` 里的 `rpc("ops.commercial.export", …)`，与「成功路径零覆盖」不矛盾。）

## 为什么会有这份记录

平台运营台的 dogfood 套件在 2026-09-16 的导航收敛之前编写，断言挂在当时存在的界面上。之后的提交把平台侧栏收敛为 `总览 / 用户中心 / 客户交付` 三项目标，`账务与退款` 与 `模型服务` 两个可点入口消失（两个入口不是同一次提交撤的：`模型服务` 由 `5859f9b0` 于 2026-09-13 撤出，`账务与退款` 由 `365c5d84` 于 2026-09-16 撤出，见文首「更正」第 4 条）；用户中心在 2026-09-14 的四个界面提交里也换掉了一批控件。

如果直接删掉这些断言，覆盖度的下降会变成无声的：下一个人看到绿灯，无法知道少了什么。因此每一条退役都登记在此，写清楚断了哪个面、哪个提交断的、当前还有什么在覆盖、以及要恢复应该改哪里。

**这不是「测试没通过所以放宽」，而是「被测界面已由产品决定移除」。** 判定基于源码 import 图 + 提交历史 + 2026-09-20 在隔离栈（`OPS_OIDC_BASE_URL`，PG17/Redis 全隔离）上真实浏览器测量到的可达性，不是推断。

## 与 `retired-merchant-assertions.md` 的一处差异（已知缺口）

商家记录由 `tests/merchant-dogfood-retirements.test.ts` 强制：它双向钉住「退役的写法不得回到 spec」和「每条退役必须在记录里被点名」。

**这一段描述的是补齐前的状态（2026-09-20 已补齐，保留以记录当时的缺口）。** 当时运营台没有对应门禁，第 1–9 条只有文字约束；补齐后由 `tests/ops-dogfood-retirements.test.ts` 强制。它没有照抄商家版本，原因见「被禁用的断言写法」一节：ops 的反向门禁必须在 spec 里写出它断言缺席的字符串，裸词禁令会把「解释退役」本身也禁掉，所以改成扫「断言面」。方向 (b)「每条退役被点名」这一半的覆盖面以该文件里的 `RETIRED_SURFACES` 清单为准，而不是本表全部 9 条——第 2、4、6、8 条属于**重锚**或已恢复，不是禁用写法。

## 退役清单

| # | 用例位置 | 原断言的安全面 | 移除提交 | 当前覆盖情况 |
|---|---|---|---|---|
| 1 | `ops-all.spec.js` `platformSections` | 平台侧栏 `模型服务`、`账务与退款` 两个**可点按钮**必须存在，点开后分别落在 `模型服务` / `平台财务中心` 标题上 | `5859f9b0`（撤 `模型服务`）／`365c5d84`（撤 `账务与退款`） | **一半已恢复（2026-09-20）**：`账务与退款` 重新进入 `platformSections`，走查再次点开它并断言 `平台财务中心` 标题可见。**`模型服务` 仍是退役**：`models` 仍不在 `OpsSidebar.navigationGroups`，反向门禁（现名 `keeps the withdrawn model services surface unreachable and the restored finance surface reachable`）继续断言它不可达，`OpsSidebar.test.tsx` 的 `keeps the model services entry out of the rendered platform navigation` 同侧钉住。`tests/ops-navigation.test.ts` 断言 `/ops/finance` 解析为 `finance`（原为归一化到 `overview`，已随恢复反转） |
| 2 | `ops-all.spec.js` 原 `if (section === '账务与退款')` 段 | 平台财务中心里 `当前租户成员` 计数为 0、`成员角色调整` 计数为 0（即：平台财务面不得泄漏租户成员治理控件） | `365c5d84` | **已恢复（2026-09-20）**：`FinancePage.tsx` 从 `365c5d84^` 取回全文，`账务与退款` 重新可走查，`if (section === '账务与退款')` 分支与两条 `toHaveCount(0)` 一并回填。恢复走查入口而不回填分支体会让覆盖「看起来完整、实际缺席」，所以两者同批做；分支处的注释写明了这两条为什么仍然成立（`当前租户成员` 只由 `components/finance/MembersSection.tsx` 渲染，而 `MembersPage` 挂它、恢复的 `FinancePage` 不挂；`成员角色调整` 只是发往 `ops.member.upsert` 的变更原因，从不是渲染标签）。**注意：本次未执行 `npm run test:browser:ops`**（需要隔离 OIDC 栈），这两条是按源码可达性判定的，尚未经过真实浏览器验证 |
| 3 | `ops-all.spec.js` 原 `导出商业配置` 下载分支 | 点击 `导出商业配置` 后下载文件名为 `ops-commercial-<YYYY-MM-DD>.csv`、内容含表头 `kind,id,code` | `c13cc673`（按钮失去挂载点）／`365c5d84`（`FinancePage` 删除） | **仍是退役 —— finance 恢复没有解决这一条。** 见文首「仍然没有恢复、且本次没有解决的两处」。**这条断言在被删之前就已经是死代码**：它的进入条件是 `exportButton.count() !== 0`，而 `导出商业配置` 只存在于 `apps/ops-console/src/components/finance/PlanBillingSection.tsx:16`；`PlanBillingSection` 自 `c13cc673`（2026-09-01）起就没有挂载点（此前由 `FinancePage` 挂载，见文首「更正」第 1 条——本行早先写作「自 `2440b44b` 起从未被任何文件 import」，那是错的，且当时给出的 600 个提交也不对）。所以删除它**没有损失任何真实覆盖**。服务端 `ops.commercial.export` 仍在（`apps/api/src/server.ts:16241`，`platform_ops` 门禁，csv/json 双格式），但成功路径**零覆盖**：`apps/api/src/mcp-completion-content.e2e.test.ts:247` 唯一一次命中它，断言的是 `503 COMMERCIAL_OPERATION_DISABLED`；`ops-commercial-` 这个字面量全仓只出现在 `apps/api/src/server.ts:16253,16263` |
| 4 | `ops-all.spec.js` 原财务段的 `else` 兜底断言 | `账务与退款` 页必须呈现 `商业配置` / `商业访问` / `上线门禁` / `商业化生产门禁` 之一（商业上线证据对运营可见） | `365c5d84` | **这是本批退役里唯一一条真实丢失的运营可见保证，现已找回（2026-09-20）。** 载体是 `FinancePage.tsx:217-221` 那张 `商业化生产门禁` Card（内嵌 `CommercialReadinessPanel`），随页面删除而失去挂载点；页面恢复后它重新挂载。替代覆盖比原来的 `else` 兜底**更强**：原断言只要求四个文案之一出现，`ops-all.spec.js` 现在直接断言 `商业化生产门禁` 这一条文案在浏览器里可见 |
| 5 | `ops-all.spec.js` 的 `模型服务` `continue` 豁免 | （豁免本身）`模型服务` 按钮缺失时跳过而不报错 | `5859f9b0`（入口撤出）／`b3983595`（豁免删除） | 豁免随入口消失而成为死代码，已删除。`模型服务` 在平台侧栏不可达这一事实改由第 1 条的反向门禁断言。更正（2026-09-21）：豁免由 `fde0c4ba`（2026-09-14）加入，而入口在前一天就已被撤，所以它出生时就是死代码；早先写的 `365c5d84` 是错的（见文首「更正」第 4 条） |
| 6 | `ops-all.spec.js` 第二个用例 `does not report model configuration success when model status fails` | `平台.model.status` 读取失败后，`状态不可用` 徽标必须在模型面可见 | `5859f9b0`（models 页的 `ModelStatusSection`）／`8d0b4ff2`（总览页的 `ModelServiceSummary`） | 已**重锚**而非消失：改为断言产品真正的 fail-closed 信号 —— 全局加载警告 `.ops-global-load-warning` 必须可见、必须写明「部分运营数据未刷新 / 个数据集刷新失败」、展开后必须点名 `platform.model.status`；`状态不可用` 与 `平台模型配置完整` 均断言 `toHaveCount(0)`。可用性上比原断言更强（原断言只要求徽标出现，不要求点名失败数据集） |
| 7 | `ops-users.spec.js` `导出当前筛选` 下载断言 | 点击 `导出当前筛选` 下载 `ops-users-<YYYY-MM-DD>.csv`、表头含 `external_subject,display_name,workspace_id` | `cc2f01cb` `ui: simplify user status filter` | 控件已从用户目录面板移除，浏览器里没有可点的导出。服务端 `ops.users.export` 的 csv 形态仍有真实覆盖：`apps/api/src/ops-users-directory.e2e.test.ts:176` 断言 `format: 'csv'` 的 `count` 与内容包含目标 subject；`mcp-completion-content.e2e.test.ts:238,347` 覆盖 json 形态与未授权拒绝。**但 `ops-users-<date>.csv` 这个文件名、以及 `external_subject,display_name,workspace_id` 这个表头首段，已无任何替代面**（`apps/api/src/server.ts:15730,15733` 仍生成它们，只是没有断言） |
| 8 | `ops-users.spec.js` `清空` 按钮 | 点 `清空` 复位筛选，断言「筛选空态可逆」 | `cc2f01cb` | 控件已移除。已**重锚**：改为清空关键词输入框后重新点 `查询`，仍然断言筛选空态可以回到非空（`toHaveCount(1)` 反向断言 + 表格行数恢复）。保证本身没有丢 |
| 9 | `ops-users.spec.js` 用户详情抽屉的四段断言 | `认证会话（已脱敏）`、`平台身份生命周期`、`所属租户与角色`、`成员操作历史` 四段必须在抽屉里可见 | `f84b9561` `ui: remove sessions and simplify store details`、`1b7d8799` `ui: simplify user detail drawer` | 抽屉已改为按企业主体聚合的商业视图。已**重锚**到当前真实结构：`店铺详情` / `月费详情` / `钱包` / `当月消耗表` / `用户总消耗金额`（`apps/ops-console/src/components/users/UserDirectorySection.tsx:338,344,350,357,364`）。**被脱敏会话列表、身份生命周期、租户角色摘要、成员操作历史这四类信息在用户中心已无任何承载面**——这是真实丢失，不是改名 |

## 产品面证据（2026-09-20 核查）：`components/finance` 与 `components/commercial` 当时几乎没有挂载点

> **2026-09-21 更正：这个标题原写作「整树孤立」，不成立** —— `ModelMarkupPanel` 当时就被 `pages/ModelsPage.tsx` import 并渲染（本节第一点自己就把 `pages/ModelsPage.tsx:2` 列为它的 importer），下方的「核查方法更正」也复述过，但标题没有跟上，构成同文件内自相矛盾。准确说法是「**运营可达**的页面级挂载点全无，只剩纯逻辑函数与一个不可达的 `models` 页」，而不是「整树孤立」。本节其余事实经复核成立，未改。

这一节是**当时**支持恢复裁定的证据，保留原文事实以便复核；恢复后的状态见其后的小节。

第 3、4 条不只是「测试没地方挂」。2026-09-20 在 `010cab8d` + 当时工作树上做了一次 import 图核查，结论是**整个财务/商业前端面都没有挂载点**，而不是只有 `PlanBillingSection` 一个组件：

- `apps/ops-console/src` 里对 `components/finance/**` 与 `components/commercial/**` 的**非测试 import 只有 4 条**：`hooks/useOpsConsoleModel.ts:62`（`financePermissions`）、`:64`（`rechargeOrders` 纯函数）、`pages/MembersPage.tsx:2`（`MembersSection`）、`pages/ModelsPage.tsx:2`（`ModelMarkupPanel`）。前两条是纯逻辑，后两条的宿主页面自身也不在平台侧栏（`members` 不在 `mainItems`，`models` 在 `mainItems` 但被 `navigationGroups` 排除）。
- `FinanceSearchSection`、`ReconciliationSection`（finance 版）、`RechargeOrdersSection`、`RefundSection`、`CommercialOperationsWorkspace`、`CommercialReadinessPanel`、`PlanBillingSection`、`OfferTable`、`AddonTable`、`CouponTable`、`RolloutTable` —— 除各自的 `.test.*` 外**零 importer**。
- `pages/MembersPage.tsx` 里的 `billing: "账务与退款"` 只是权限矩阵的**能力分组标签**（`capabilityGroupLabels`），不是财务页面入口。

所以 `365c5d84` 删掉的不只是一条导航项：它删掉了**唯一**挂载财务/商业这一整片页面的页面（`ModelsPage` 除外——它挂 `ModelMarkupPanel`，但 `models` 域自 `5859f9b0` 起已不在侧栏），且没有替代承载面。更正（2026-09-21）：原文写的是「唯一挂载这整棵子树」，与本节第一点（它自己就把 `pages/ModelsPage.tsx:2` 列为 `ModelMarkupPanel` 的 importer）自相矛盾。

**核查方法上的两处更正（2026-09-20 恢复时复核发现）**：上面「零 importer」的结论按**子串 grep** 得出，有两类假命中，不能直接当 import 图用。其一，`ReconciliationSection` / `RefundSection` 的命中来自 `StorageReconciliationSection`、`destructiveConfirm*.test.ts` 等**不同对象**，不是这两个组件的 importer。其二，`ModelMarkupPanel` **不是**孤立的——`pages/ModelsPage.tsx` 真的在用它。真正的孤立根是 `PlanBillingSection`（它是 `AddonTable` / `CouponTable` / `OfferTable` / `RolloutTable` 的唯一 importer）与 `FinanceSearchSection`、`RechargeOrdersSection`、`CommercialOperationsWorkspace`、`CommercialReadinessPanel`。结论方向不变，但「哪些组件孤立」应以 import 语句为准，不要用子串 grep。（2026-09-21 补：这段当时还漏了 `ConfigurationCenterSection`，它也是零 importer，见文首「更正」第 2 条。）

**当时判定要回答的三个问题，owner 已裁定（选项 A：恢复 finance 导航域）**：
1. 平台财务检索（`billing.platform.read` → `ops.finance.search`）是否还需要运营人员**在浏览器里**做？—— **是**，`FinancePage` 已重建。
2. 「商业化生产门禁」证据（`CommercialReadinessPanel`）是否需要一个运营可达的挂载点？—— **是**，已随 `FinancePage` 重新挂载。
3. 企业主体侧的 `账务与商业配置` 随 `finance` 域消失是否有意为之？—— **不是**，`finance` 恢复为**双范围**（`requiredWorkbenchForDomain` 返回 `undefined`，故意不指派 workbench），`/ops/finance?workbench=workspace` 重新落在「账务与商业配置」，而不再被静默归一化到 `overview`。

### 恢复后的孤立状态

`FinancePage` 重新挂载了 `CommercialOperationsWorkspace`、`CommercialReadinessPanel`、`FinanceSearchSection`、`ReconciliationSection`、`RechargeOrdersSection`、`RefundSection`。**仍未挂载的根有两个：`PlanBillingSection`（及其 4 个子表）与 `ConfigurationCenterSection`**，因此第 3 条仍是未解决缺口——finance 恢复没有连带修好它，这一点在反向门禁里继续以 `导出商业配置` 的 `toHaveCount(0)` 形式断言。更正（2026-09-21）：本行原写「唯一」。`ConfigurationCenterSection` 没有 spec 覆盖，所以它连反向门禁都没有，只在本文登记。

## 被禁用的断言写法

以下写法不得再出现在 `dogfood/chatgpt-all-functions/ops-all.spec.js` 与 `ops-users.spec.js` 里。**这一节现在由 `tests/ops-dogfood-retirements.test.ts` 强制**（双向：写法不得回流 spec，且本节每一条都必须被该测试点名）——文末缺口 #1 已补齐。

```
模型服务
platformSections = ['总览', '用户中心', '模型服务', '账务与退款']
导出商业配置
ops-commercial-
导出当前筛选
认证会话（已脱敏）
平台身份生命周期
所属租户与角色
成员操作历史
```

**`平台财务中心` 已从本清单移除**：owner 于 2026-09-20 恢复了 finance 域，它重新是走查的**真实期望标题**（`headings` 映射与 `platformSections` 都要用它），不再是被禁用的写法。同理 `账务与退款` 从来不该被禁——它现在是合法的走查入口。

关于「裸词 vs 代码形式」的取舍（这也是本文件长期没有门禁测试的原因）：反向门禁必须写出 `模型服务` 这些字符串来断言它们**缺席**，注释也必须点名每条退役。所以门禁**不按裸词扫全文**，而是扫「断言面」——剥掉注释与反向门禁用例之后的剩余部分，也就是走查真正断言的东西。这个剥离的两个方向（缺席断言会被剥掉、正向断言不会被剥掉）都由该测试自证，避免剥离器过度匹配让门禁空转变绿。

## 仍然成立的替代覆盖（重锚，不是退役）

- `ops-users.spec.js` 的用户目录表定位：`成员状态` → `激活状态` 列头。这是**重锚到真实信号**，不是放宽——`7f6cf3f4` `ui: streamline user center filters and columns` 确实把该列由 `成员状态` 改名为 `激活状态`（`UserDirectorySection.tsx:233`）。
- `ops-users.spec.js` 停用对话框：新增「只填操作原因不足以启用确认按钮」+ 选择审批人后才启用。这是**新增覆盖**，不是退役。
- `ops-all.spec.js` 的 `状态不可用` 断言：见退役清单第 6 条，已重锚到全局加载警告。

## `ops-mcp-request-matrix.spec.js` 已对账，登记豁免随之退役（2026-09-21）

**这条 spec 不再与产品事实矛盾，所以本记录不再要求把它排除在反向门禁之外。** 这一段此前的标题是「另一条与当前产品事实矛盾的 spec（未处理，仅登记）」；`tests/ops-dogfood-retirements.test.ts` 的 `registeredSpecs()` 按**标题含「未处理」**定位该段，再把段内出现的 spec 名从 `guardedSpecs()` 里减掉。留着一个不再需要的登记，正是这份记录本身要防的形状——豁免活得比理由久。标题已去掉「未处理」，该 spec 因此**回到禁令的适用范围**：它的断言面自此受 `RETIRED_SURFACES` 全部 9 条约束。

**登记时说的病灶（2026-09-20）**：该 spec 写死于收敛前的路由表。当时点名的是四条 finance 行（`['账务与退款', '/ops/finance?workbench=platform']`、它的 `?workbench=workspace` 版本、`'账务与退款': '平台财务中心'`、workspace 特判 `账务与商业配置`）：`365c5d84` 撤走 finance 后 `/ops/finance` 归一化到 `overview`，走查会等到一个永不渲染的标题，**跑起来就是红的**。真正的分歧面其实比这四条更大——同一份路由表里还留着代表已退役侧栏入口的 `模型服务` 标签，以及 `客服` / `事故中心` 两个任何走查都到不了的标题。恢复 finance 只把上面那四条变回正确（双范围恢复后 `?workbench=platform` → `平台财务中心`、`?workbench=workspace` → `账务与商业配置`），其余按旧路由表写的假设一直没核。

**现在是什么（对账）**：相对 `c7ccc9b7`（最后一个改动过该文件的提交），工作树上的 spec 有三处对账改动，每一处都是对着产品源码核的：

- `platformSections` / `workspaceSections` 现在镜像**路由集**，而不是侧栏 `navigationGroups`。平台侧 = `apps/ops-console/src/navigation/opsNavigation.ts` 里 `requiredWorkbenchForDomain` 返回 `platform` 的六个域（`users` / `customer-delivery` / `stores` / `models` / `storage` / `audit`）；工作区侧 = 返回 `workspace` 的四个域（`members` / `tasks` / `knowledge` / `rules`）；两边再加 `overview` / `finance` 这两个该函数故意返回 `undefined` 的双范围域。这份域集合与 `opsDomains` 以及 `apps/ops-console/src/navigation/opsPageRegistry.tsx` 的 `Record<OpsDomain, …>` 逐域页面一致。**顺带补上了漏掉的 `客户交付`（`customer-delivery`）一行** —— 此前这份走查没有覆盖它。
- `模型服务` 那一行改成路由自己的可达名 `模型计费设置`，与 `apps/ops-console/src/pages/ModelsPage.tsx:12` 的 `title` 一致。`OpsPage` 用 `aria-label = title`，所以这才是 `/ops/models` 真正渲染出来的可访问名；继续用已退役的侧栏标签，等于超时在一个该页从未渲染过的标题上。
- `headingByLabel` 删掉了 `客服` / `事故中心`（其路由模块无人 import、标签也不在 `opsDomains` 里，两条路径都落回 `overview`）。`账务与退款` 的两个标题与 `apps/ops-console/src/pages/FinancePage.tsx:211` 的三元一致，随 finance 恢复重新成立。

**退役豁免前已核实它能通过门禁**（否则这是把一条注定变红的 spec 塞进守卫）：门禁扫的是**剥掉注释之后**的断言面，不是裸词全文。核对结果——9 条禁用写法在它的断言面里一个都不出现；断言面 8036 字符 / 源码 10589 字符 ≈ 0.759，高于 `leaves a substantial assertion surface` 那条要求的 1/2；断言面含 `expect(`，所以也不会被「空断言面」保护拦下。

**一个仍然为真、防止把「被守卫」误读成「被运行」的事实**：该 spec **仍未接入任何浏览器入口** —— `npm run test:browser:ops` 只点名 4 个 spec，不含它；`tests/browser-gate-entrypoints.test.ts:124` 把它钉在 `CONFIG_ONLY_BROWSER_SPECS` 里，即只有那份无人加载的 `playwright.config.mjs` 的 `testMatch` 会匹配到它。本次只让它**回到禁令适用范围**，没有让它开始运行；要不要把它接进 `test:browser:ops`（或直接删除）仍是 owner 的裁定。

## 要恢复这些覆盖，应该改哪里

1. **导航域（第 1、2 条）**：`apps/ops-console/src/navigation/opsNavigation.ts:3`（`opsDomains`）、`:21`（`requiredWorkbenchForDomain`）、`:66`（`urlForDomain` 路由正则）、`domainFromLocation` 里 `/ops/finance` 的两条归一化分支、`apps/ops-console/src/components/OpsSidebar.tsx:39,48`、`apps/ops-console/src/authz/authorization.ts:36`（`domainReadCapabilities`）、`apps/ops-console/src/navigation/opsPageRegistry.tsx`。注意 `opsPageRegistry` 是 `Record<OpsDomain, OpsDomainPage>`，加回 `finance` 必须同时提供一个页面组件。
2. **财务页面（第 2、4 条）**：`FinancePage.tsx` 已删除，`git show 365c5d84^:apps/ops-console/src/pages/FinancePage.tsx` 可以取回全文（232 行，含 `商业化生产门禁` Card 与 `PlatformCatalogManagementPanel`）。
3. **商业配置导出（第 3 条）**：`apps/ops-console/src/components/finance/PlanBillingSection.tsx` 组件本体在（52 行），`apps/ops-console/src/hooks/useOpsConsoleModel.ts:1616`（本次复核时工作树上是 `:1655`，行号随其它提交漂移）的 `exportCommercial` 也在，两者都只是没有挂载点。挂载即可用，不需要重写逻辑。服务端 `ops.commercial.export` 完整。**同批孤立的还有 `ConfigurationCenterSection.tsx`**（2026-09-21 复核补登，见文首「更正」第 2 条）。
4. **用户导出（第 7 条）**：`apps/ops-console/src/components/users/UserDirectorySection.tsx` 的用户目录面板需要重新渲染导出控件。
5. 恢复属于**界面变更**，需要产品重新评审，因此本记录不自行恢复，只登记。

### 2026-09-20 执行结果（对上述 1–5 的回应）

1–2 已执行（owner 选项 A）。执行时发现**清单漏了一处**：只按这份清单逐条回填会在编译期失败，因为 `FinancePage` 依赖 `commercialBenefitDescriptions`，而它已被 `7152c9bd` 当死导出删除——那个「死」正是这次删除造成的。补回后编译通过（`tsc -p apps/ops-console/tsconfig.json` exit 0）。**教训：恢复一处删除，要按依赖逆向验证，不要只按当时的清单逐条勾。**
3 仍未执行（`PlanBillingSection` 依然孤立）。4 未在本次范围内（不在四项决定里）。5 的前提已被 owner 推翻，但流程本身成立——恢复确实是先经由评审才发生的，反向门禁按设计把决定逼回了评审。

## 仍然存在的缺口（2026-09-20 更新）

1. ~~补一个运营台版的门禁测试~~ —— **已补齐**：`tests/ops-dogfood-retirements.test.ts` 双向钉住「被禁用的写法不得回到 ops spec」与「清单每条被点名」。其覆盖范围以该文件的 `RETIRED_SURFACES` 为准，**不是**本表全部 9 条：第 2、4、6、8 条属于重锚或已恢复，不是禁用写法。
2. ~~第 4 条是真实丢失的运营保证~~ —— **已解决**：随 `FinancePage` 恢复重新挂载，`ops-all.spec.js` 直接断言 `商业化生产门禁` 可见。
3. **仍未解决 —— 第 9 条的四类用户信息**（脱敏会话、身份生命周期、租户角色、成员操作历史）在用户中心仍无承载面。本次的四项决定未涉及。
4. **仍未解决（本次复核登记）—— 第 3 条**：`PlanBillingSection` 在 finance 恢复后**依然没有挂载点**，`导出商业配置` 与 `ops.commercial.export` 的成功路径仍是零覆盖。恢复 finance **没有**连带解决它。
5. ~~`ops-mcp-request-matrix.spec.js` 的旧路由表假设未核、且登记豁免没有理由~~ —— **已解决（2026-09-21）**：spec 已按路由集对账，登记段标题去掉「未处理」，豁免退役、该 spec 重新受反向门禁约束（见「已对账，登记豁免随之退役」一节）。**但它仍未接入任何浏览器入口**，所以「删除还是接进 `test:browser:ops`」这一半仍然待 owner 裁定——门禁守卫的是它不回流退役写法，不是它真的在跑。
6. **未执行验证的一处（诚实登记）**：第 2 条回填的两条断言（`当前租户成员` / `成员角色调整`）本次**没有**经过真实浏览器执行——`npm run test:browser:ops` 需要隔离 OIDC 栈，本次未跑。它们是按源码可达性判定的（见第 2 条说明），应由下一次浏览器门禁执行来确认。
7. **仍未解决（2026-09-21 复核登记）—— `ConfigurationCenterSection`**：与 `PlanBillingSection` 同批失去挂载点，但不在任何 spec 的断言面里，因此连反向门禁都没有。要么给它一个挂载点，要么按 owner 决定显式删除并在这里登记。
8. **仍未清理（2026-09-21 复核登记）—— spec 注释里还留着同一句错话**：`ops-all.spec.js:196-199` 的反向门禁注释仍写着 `PlanBillingSection`「has never been imported by any file since `2440b44b`」。本次只改了本记录，没有改 spec（该文件不在本次可改范围），所以那句错话还在源码里；它与本文第 3 条现在互相矛盾，应由改 spec 的那一次一并订正。
