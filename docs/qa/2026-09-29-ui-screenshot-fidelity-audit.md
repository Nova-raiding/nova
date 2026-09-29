# 双后台截图逐页对照（2026-09-29）

参考清单：Desktop 与微信附件中的 `outputs/ui-images-2026-09-28/截图清单.md`（23 个 URL、SHA256 相同）。Desktop `outputs` 当前含 12 张 Ops 图；11 张 Merchant 图在微信附件目录。两边的 12 张 Ops 图片逐张字节相同。按 SHA256 去重后，Ops 只有 9 张不同图，Merchant 有 8 张不同图；重复图和路由 alias 按清单最终地址解释，不能把 23 个 URL 表述为 23 个独立视觉页面。

## 对照结果

| 后台 / 截图 | 结果 | 差异及处理 |
|---|---|---|
| 运营 00 登录 | 布局匹配 | 原图和隔离实截图都是空凭据登录表单，无会话告警；卡片大小、字段位置、按钮和品牌标识位置一致。 |
| 运营 01 总览 | 几何匹配，数据格式有小差异 | 参考图本身显示各项为 0。权限确认后的最新矩阵显示客户数 1、接入收入 0 元、已验证平台模型成本 0.00 元，财务月度字段为后端真实 0。参考图金额采用整元 `0`；已修复整元货币显示，保留有分金额两位小数。赠送客户及创意点无后端数据源，仍显示“—”。 |
| 运营 02 用户中心 | 控件与表格几何匹配，数据不同 | 参考图当前页可见 10 行并有第 2 页；隔离矩阵返回 3 条已授权 API 记录。真实浏览器 DOM 复核搜索框外壳宽 200px、x≈291，与参考图吻合；先前缩略图观感像输入框缺失，裁切原图后确认它存在。账号“属性”字段语义也与旧截图不同，不能将旧演示分类映射为当前账号类型。 |
| 运营 03 客户交付 | 主体几何匹配，范围控件有差异 | 参考图有 1 条交付记录，当前隔离目标工作区无记录；当前标题行额外显示工作区选择器。接口必须有明确 `target_workspace_id`，目前不存在可恢复此目标的已选全局工作区上下文，因此保留显式选择。独立刷新按钮已移除。 |
| 运营 04 成员管理 | 无有效参考 | 与 05/06/08 截图 SHA256 相同，内容实际为登录失效警告；工作区页面在 platform 会话下受权限保护，矩阵未能查看主体。 |
| 运营 05 任务中心 | 无有效参考 | 同 04；不得把登录错误图当作任务页目标。 |
| 运营 06 知识治理 | 无有效参考 | 同 04；不得把登录错误图当作知识页目标。 |
| 运营 07 店铺治理 | 稳定态与参考图 loading 状态不同 | 参考图是在连接刷新中截取；最新矩阵显示接口完成后的空状态。Canonical 冲突队列需要显式工作区范围，保留选择控件。 |
| 运营 08 规则中心 | 无有效参考 | 与 04/05/06 同一登录失效图片；清单声明的 workspace URL 与实际图不符。当前可访问的 platform 规则页已在真实隔离会话中验证。 |
| 运营 09 模型服务 | 主体匹配 | 卡片、提示、禁用控件、焦点框与参考一致；右上用户标识随真实隔离账号变化，不固定成截图账号。 |
| 运营 10 存储治理 | 布局匹配，状态不同 | 参考图停留在 loading；当前接口已返回真实 settled 的“状态不可验证/暂无可验证对象清单”。不伪造 loading。空列表下多余 workspace 数量控件已去掉。 |
| 运营 11 审计中心 | 接近匹配 | 侧栏和表格主结构已对齐；截图多余的“原因”平台列移除，授权详情保留原因。数据行依真实审计数据变化。 |
| 商家 00 登录 | 布局匹配 | 1440×1050 参考与最新实截表单几何一致。服务端为 18081。 |
| 商家 01 运营概览 | 结构匹配，状态/数据不同 | 参考上下两条红色提示及 18 任务、326 消耗、10 店铺等属于另一状态。当前隔离租户无对应错误/业务记录，不合成提示和数字。 |
| 商家 02 平台、店铺、商品 | 文案与主体匹配 | 去掉侧栏“成员与权限”，空态文案对齐参考；隔离矩阵店铺记录与截图数量不同。 |
| 商家 03 知识资料 | 布局匹配，资产数据不同 | 该入口最终显示素材库。筛选、选择/下载控件存在；隔离工作区真实资产数为 0，截图有 8 张。 |
| 商家 04 图片素材 | 布局匹配，资产数据不同 | 与 03 共用真实素材库；存储配额/使用量由后端返回，不能补成参考的 31.5/50 GB。 |
| 商家 05 品牌资产 | 配置状态不同 | 参考图显示全局、店铺、系列配置；隔离环境没有可读店铺/配置，页面展示明确空态。参考图与最新实截侧栏均为 224px，品牌页的页面边界不需单独缩放。 |
| 商家 06 回收站 | 空状态准确，记录不同 | 隔离工作区没有回收记录；本项目当前没有服务端素材删除、回收列表或恢复 API。文案明确现有隐藏/清除只影响本地状态，未伪造截图旧素材。 |
| 商家 07 财务概况 | 摘要结构修正，账本不同 | “截止今日总消耗”现按完整 settled 点数账本计算；截断/不可读时显示未读取。隔离数据没有参考图中的余额、已确认套餐或存储额度，趋势不画假线。 |
| 商家 08 任务入口 | 路由匹配 | 按清单最终地址跳转 `/merchant/products`；它与知识入口一样显示素材库。 |
| 商家 09 发布入口 | 路由匹配 | 同 08。 |
| 商家 10 规则入口 | 路由匹配 | 同 08。 |

## 验证证据

- 商家后台 10 路由最新隔离矩阵：`artifacts/ops-jit-isolation/2026-09-29T05-21-17.855Z-a7af1f57-f01f-48cf-957d-3ceb50fb592a/merchant-desktop-matrix/`，passed、`pageErrors=[]`、`failedApi=[]`。
- 运营平台 12 路由/标签矩阵：`artifacts/ops-jit-isolation/2026-09-29T05-14-16.713Z-3f17640e-a84f-4f0d-84d5-7f4d6c49ddfe/desktop-readonly-matrix/`，1/1 通过、`pageErrors=[]`、`failedApi=[]`；总览实截 `overview.png`。
- 当前复跑 `npm run test:release-gates` 已以退出码 0 完成：177 个测试文件通过、7 个依赖生产凭据的测试文件跳过，pending assertion gate 记录 16 项预声明断言。`npm run typecheck`、Ops build、总览测试和 Ops 浏览器矩阵均在本轮通过。
- 本轮 owner 加 9 个协作 agent 共 10 个并行核对；CodeGraph 索引 2,347 files / 33,796 nodes，执行了 Ops 路由与客户交付数据探索。CodeGraph 对动态 JSX/路由引用不完整，故用 registry、全仓搜索、截图清单和 git 历史复核交叉验证；gstack Browse 检查可执行。23 个清单 URL 已按请求/最终地址关系覆盖；实际路由与实截图数量以各自 matrix.json 为准，不等同于 23 个独立页面。
- 旧 `AssetLibrary` 确认无调用者且没有路由挂载；本轮保留为未挂载历史实现，因为它仍是不可信文档边界、素材事实/权益确认和品牌视觉强规则的唯一实现。删除它会移除尚未迁移的安全能力，不能当成无风险重复代码清理。对应约束见 `demo/merchant-studio/src/reviewed-surface-data.test.ts`。

## 剩余数据条件

本地持久化工作区目前只有 2 个平台账号、2 个商品、0 个知识素材、2 个任务、2 条点数账本事件、0 个已确认订阅权益；这不包含参考截图中的完整租户数据。使用配置的本地 MCP token 对只读 `workspace.metrics` 查询得到 403 `FORBIDDEN`，没有尝试绕过授权。扫描桌面和微信附件中的同名截图，没有找到另外有效的成员/任务/知识/规则页面；微信内两份截图压缩包也只有同一套 23 项清单与图片。逐页结构已尽量恢复，但“所有有数据页面像素级 1:1”仍需要与参考截图同一授权范围、同一后端记录和有效的运营工作区截图。不能通过前端常量或权限绕过来制造相同画面。

## 2026-09-29 二次复核

- 本轮启动 10 个 agent（owner + 9 个只读分工），分别核对 Ops/Merchant 路由、截图清单、视觉差异、后端数据范围和未挂载代码；没有发现可安全直接删除的已授权业务页面。Merchant `AssetLibrary` 虽未挂载，但现有安全契约明确要求保留；Ops `IncidentsPage` / `IncidentsRoute` 是潜在旧页面候选，尚无退役决定，因此没有删文件或相关 API。
- Customer Delivery 与 Canonical 冲突队列都必须指定租户：`ops.customer-delivery.*` 缺少 `target_workspace_id` 会被 API 拒绝；Canonical 冲突处理按 `workspace_id` 执行。截图中缺少控件不构成跨租户读取或默认选目录第一项的授权。当前 UI 保留显式选择，接受与旧图的这项差异。
- CodeGraph 本轮探索了 Customer Delivery 与 Canonical 工作区调用链并同步索引。CodeGraph 解析对动态 JSX/路由绑定有限，路由注册和全仓引用另用源代码搜索及 manifest 复核。Agent 共识：四张 Ops workspace 截图实际是同一张会话失效图；Merchant 任务/发布/规则图是清单记录的 products 重定向结果。
- 复跑 `npm run typecheck` 通过；`npx vitest run apps/ops-console/src/pages/CustomerDeliveryPage.test.tsx apps/ops-console/src/components/stores/CanonicalBackfillConflictSection.test.tsx apps/ops-console/src/pages/StoresPage.test.tsx apps/ops-console/src/api/customerDeliveryClient.test.ts` 通过，4 files / 117 tests。Customer Delivery 测试输出了 antd `useForm` 未连接警告（出现在测试挂载非创建表单页时），未导致测试失败。
- 首次范围复核没有改动租户数据。随后对 Customer Delivery 做了页面级对齐：移除卡片头部独立“刷新交付档案”按钮，保留显式租户选择器和错误态重试。全页 CustomerDeliveryPage 测试 35/35 通过，`npm run build:ops-console` 通过，更新后的 Ops 矩阵 1/1 通过、failed API 为空；最新实截为 `artifacts/ops-jit-isolation/2026-09-29T05-02-45.289Z-4df49f31-796c-47f0-9924-ac43f21be762/desktop-readonly-matrix/customer-delivery-selected-workspace.png`。与参考相比剩余差异是目标工作区选择器与目标截图演示行；两者需要明确的目标租户及其真实记录才能继续消除，不能回退到未指定租户的页面请求。随后只重建 `qa-clean-ops-ui-1` 本地 Ops 静态容器（healthy，`/api/readyz` 返回 ok），未改 API/数据库/商家 UI 容器。`git diff --check` 通过。尚未重跑 release gates；上一次运行记录为版本元数据 mismatch 失败，需先修复 release metadata 并重新执行才能作为上线门禁。
- 又重跑双后台矩阵：Ops 真实隔离 Postgres/Redis + 平台账号密码浏览器矩阵 1/1 通过（`artifacts/ops-jit-isolation/2026-09-29T05-02-45.289Z-4df49f31-796c-47f0-9924-ac43f21be762`，遍历总览、用户、店铺、规则、财务、客户交付、存储、审计、模型，failed API 为空）；Merchant 10 路由截图矩阵 passed、`pageErrors=[]`、`failedApi=[]`（`artifacts/ops-jit-isolation/2026-09-29T05-06-36.422Z-b00cc211-35f7-43f6-9224-629b1c5d4b44/merchant-desktop-matrix`）。
- 05:14 UTC 重跑 Ops 矩阵时增加了总览数据水合断言，矩阵 1/1 通过，`pageErrors=[]`、`failedApi=[]`。最终实截 `artifacts/ops-jit-isolation/2026-09-29T05-14-16.713Z-3f17640e-a84f-4f0d-84d5-7f4d6c49ddfe/desktop-readonly-matrix/overview.png` 显示客户总数/有效客户 1，接入费及可验证平台成本为 0；这确认了先前短横线是截图时序问题，业务组件无需增加占位默认值。
- 05:21 UTC Merchant 矩阵最新覆盖登录、概览、商品、素材、品牌、回收站、财务及 3 个 alias，`pageErrors=[]`、`failedApi=[]`。截图证据在 `artifacts/ops-jit-isolation/2026-09-29T05-21-17.855Z-a7af1f57-f01f-48cf-957d-3ceb50fb592a/merchant-desktop-matrix/`。
- 本轮根据参考图修复 Ops 总览两项差异：整元平台成本格式（`0.00` → `0`；小数保留两位），以及套餐销量读取错误汇总的问题。套餐销量现在使用财务 API 的 `commercialOrderBySku`，按真实商品目录的 `type=monthly` 筛选，并将目录中确实存在但当前月没有订单的 2000/5000 SKU 显示为 `0`；没有目录证据时仍显示 `—`。相关单测 20/20、Ops build、Ops 桌面路由矩阵 1/1 通过；最新矩阵 `artifacts/ops-jit-isolation/2026-09-29T05-35-22.507Z-6de49bb5-d1c8-42cb-a26d-5ca38be0f282/desktop-readonly-matrix/` 遍历所有主页面、失败 API 请求为空。本地 `qa-clean-ops-ui-1` 已替换为 `qa-clean-ops-ui-restored` 镜像，容器随后健康且 `/api/readyz` 返回 200；未触碰 API/DB/商家 UI 或生产服务。`npm run build:ops-console` 通过；两次全仓 `npm run typecheck` 在包构建后停于 `tsc -b`（进程零 CPU、无输出），因此本轮不记为通过。此前验证成本格式时的全仓 typecheck 通过属于前一次代码状态，不覆盖本次新增套餐映射改动。
- 05:42–05:45 UTC 重跑 Ops 桌面矩阵以核验用户页搜索框；DOM 显示输入框外壳 `x=291.02,width=200`，裁切后的参考与实截均有同样 200px 控件，因此未发现 UI 缺陷。矩阵保留此运行时尺寸断言。最终矩阵 `artifacts/ops-jit-isolation/2026-09-29T05-45-26.268Z-1131277c-0050-4b9a-b14a-043bb0f09031/desktop-readonly-matrix/` 通过（1/1），失败 API 为空。

## 2026-09-29 后续复核与品牌素材补齐

- 本轮再次核对 CodeGraph（2,347 文件、33,797 节点）及 gstack Browse。截图清单仍是 23 个 URL，而非 23 张有效独立页面图；运营页去重 9 张、商家页去重 8 张。运营 04/05/06/08 是相同的失效会话画面；商家 03/08/09/10 是相同的素材库画面。
- 直接对照运营模型服务目标图与隔离矩阵实截，两者都是 1440×1050，页面标题、合并提示、Token 成本倍率卡和主体几何一致；之前提出的模型页语义漂移已撤回。
- 品牌资产 Logo/文档的选择原先只有本机预览，不能建立后端素材引用。本轮接通现有 `POST /v1/assets/upload`、工作区素材列表及 scoped brand 配置：可上传或从当前工作区选择真实素材；Logo 预览读取服务端资产或受当前会话保护的本地临时预览，临时 Object URL 在替换、工作区切换和卸载时清理。素材需通过服务端扫描、权益、解析、事实确认后才写入 scoped brand values；待检查素材保留本页草稿并显示状态，不阻止文本和颜色保存。未放宽 API 的素材就绪校验。
- 聚焦测试 `material-brand-assets.test.ts` 与 `material-brand-facts.test.ts` 通过（19/19）；`npm run build --prefix demo/merchant-studio` 通过，production copy guard 通过；最新 Merchant 隔离浏览器矩阵 `artifacts/ops-jit-isolation/2026-09-29T06-03-39.464Z-6928fe4b-2c9c-4370-881c-40ed6ccbf4af/merchant-desktop-matrix/` 覆盖 10 条路由，通过且 `pageErrors=[]`、`failedApi=[]`；`git diff --check` 通过。
- 本轮按页面边界启动 9 个子代理（含 owner 共 10 个 agent）。未发现可安全直接删除的重复 UI：Merchant 兼容 alias 有路由测试；未挂载的 AssetLibrary、Ops Support/Incidents 和 workspace 页面仍对应安全契约或真实 API。保留这些实现，避免以“未在当前侧栏显示”作为删除依据。
- Ops 的成员、任务、知识主体页和 workspace 规则仍未完成本次参考截图 1:1 验收：给定目录中的对应图片是会话失效截图，当前平台矩阵只证明 platform 会话按权限拒绝；仓库较早的 workspace 截图可作辅助旧版参考，但恢复可见性需要经过当前授权的 workspace 会话。不得把拒绝态或无效参考图写成页面视觉验收通过。
- 商家品牌页在隔离租户的真实店铺/系列配置缺失，因此留有“尚不可用”状态占位；不能补成截图中旧演示店铺、Logo、颜色或文档。页面几何受真实数据不同影响，尚不能声称品牌页达到非空数据状态的像素级一致。

## 2026-09-29 最新 UI 恢复复核

- 先前把近白背景阈值误当成视觉估算依据，曾错误地将侧栏改为 238px；实际参考图和当前目标布局边界为 224px，且 `c2eafb72` 当前精修覆盖中的 224px 是正确值。随后对比 Merchant 财务和概览全图确认 238px 会使侧栏及主内容整体错位 14px，现已恢复配对的 224px，并把隔离矩阵 DOM 断言更正为 224px。
- 之后以完整截图并排核验确认 Ops 用户表列边界真实偏移：参考图右边界为 `[287,692,905,1035,1212,1391]`，原实截为 `[287,689,899,1030,1210,1391]`。删除强制 fixed table layout，校准列宽为 `[405,213,130,177,179]`，已把目标坐标加入隔离浏览器矩阵断言。
- Ops 隔离矩阵在用户列表列宽调整后通过（9 个平台路由，failed API 为空），记录的表格列右边界与截图完全一致。真实数据行数仍由隔离后端提供，未将截图演示账号复制到前端。
- 更正后的 Merchant 矩阵再次通过，10/10 路由、`pageErrors=[]`、`failedApi=[]`；所有路由均实测 sidebar 宽与 main-shell 偏移为 224px。证据：`artifacts/ops-jit-isolation/2026-09-29T06-21-31.317Z-85ff8203-e9a6-4152-be2f-89cbcb3d9269/merchant-desktop-matrix/`。Ops 最新矩阵证据：`artifacts/ops-jit-isolation/2026-09-29T06-19-30.890Z-c1168145-23e8-4182-9cfd-ce665611949a/desktop-readonly-matrix/`，其用户列边界 DOM 断言与最新参考图采样一致。
- `npm run build:ops-console`、`npm run build:merchant-studio` 均通过；用户目录与品牌素材专项测试 34/34 通过；`git diff --check` 通过。构建仅有 Merchant 主 bundle 大于 500 kB 的既有警告。
- 最后移除了用户表上强制布局模式与裁切 overflow 的冗余 CSS，保留全局默认横向滚动与逐列目标宽度。删除后又重跑 Ops 桌面矩阵，通过且用户表边界仍符合截图；最终 Ops 证据目录为 `artifacts/ops-jit-isolation/2026-09-29T06-23-14.077Z-6e1ad6a9-719b-4600-b389-7dd99e5a36b6/desktop-readonly-matrix/`。在此之后 `npm run build:ops-console` 与 `git diff --check` 再次通过。

## 独立审查补充：验收边界与缺口

- 当前截图清单中的有效页面已按参考图、实截图和路由结果人工逐项复核；现有矩阵只对部分尺寸/坐标做自动断言（Merchant 侧栏与内容偏移、Ops 用户表列边界等）。本审查没有产出全页面像素差异/SSIM 分数或叠图报告，因此矩阵通过不能解释为所有页面已达到像素级 1:1。
- 本轮 live Merchant 截图证据 `artifacts/demo-deploy/2026-09-29/live-browser-merchant-reference-pass/matrix.json` 状态为 `failed`：唯一失败记录是登录前预期的匿名 `GET /api/v1/auth/session` 返回 401。登录后页面无脚本错误；但这个 artifact 应按失败记录保留，不能改标通过。另有较新的隔离 Merchant 矩阵通过（见上文 06-21 目录），二者为不同运行。
- Merchant 目标图片位于微信附件路径，Desktop `outputs/ui-images-2026-09-28` 本身只有运营后台 PNG；其中 Merchant Overview 参考是 1440×1247，而 live Browser 概览截图为 1440×1077。两者纵向捕获范围不同，尚未生成统一捕获范围的逐像素差异图。商家 Tasks/Publish/Rules 的清单最终地址均为 `/merchant/products`，并非三张独立目标视图。
- Ops 04/05/06/08 是同一张 `ops.session` 过期/未登录错误截图。真实 Ops 登录验收矩阵显示 workspace 深链落到 57 字符的权限提示/空短页；它没有证明 Members、Tasks、Knowledge 页面主体可用。规则截图清单还把规则中心标成 workspace，和当前 platform 规则路由归属不一致。上述四页需有效的设计稿与获授权 workspace 会话才能验收，不应把当前拒绝态记作页面还原完成。
- CodeGraph 的本地索引早于最后几次 UI/测试修改，索引状态曾显示 3 个新增和 8 个已修改文件待更新；CodeGraph 用于关系定位，不是视觉验收证据。独立审查未找到本轮截图验收对应的 gstack Browse run 日志或 session ID；当前实际页面证据来自 Playwright 桌面矩阵。后续文档仅在保存真实运行记录后称为 gstack/Browse 验收。
- Ops `IncidentsRoute`、`SupportRoute` 未出现在当前注册表/生产路由调用图中，是待产品确认的旧页面清理候选；下游仍存在整块功能实现，当前没有足够证据可直接删除。Merchant 的旧 publish/rules 页面分支也存在兼容入口，不能仅因侧栏未显示就删除。
- 有效截图涉及的数据差异继续按后端事实处理。Merchant 商家工作区当前 API 快照与参考图套餐、店铺、素材和点数不同；不存在可证明与截图完全相同且可安全恢复的当前业务快照。Ops 用户参考 10 行而当前授权读取 3 条；Live Ops 浏览器后续验收账号返回 11 行，这是不同后端快照。未用前端常量、旧测试 fixture 或越权查询填平差异。
- 进一步同会话核验发现 Merchant Overview 有一处可确认的数据绑定缺陷：API health 返回 `setup.platformOperations.mode=fixture`，`GET /api/v1/platform-accounts` 返回 6 个 workspace 平台状态（其中淘宝状态为 connected，但数据模式是 fixture）；目录页能据此展示“1 家店铺 · 0 家已连接”和“演示连接”，Overview 却因只在 `official_api` 模式调用列表 API 而显示“店铺连接未读取”。现已让 Overview 在所有已配置 API 模式读取同一工作区只读状态接口；同步控件与同步任务仍只在显式 `official_api` 模式下开放。人工登记浏览器用例断言 Overview 显示 `0/1 已接入`、人工登记状态和 0 家真实可读取店铺。Merchant production build 通过，该浏览器用例通过；finance 与 legacy-entitlement 浏览器用例也一并通过。真实 API 检查是只读的，没有触发授权、同步或数据写入。
- 上述独立审查后实际运行了 gstack Browse：浏览器 daemon 健康，运营商家登录 URL 返回 200；在 1440×1050 下保存 [Merchant 登录实截图](../../artifacts/gstack-browse/2026-09-29/merchant-login.png)，与参考图肉眼对照，卡片、Logo、输入框、按钮和页脚位置一致。该图对应登录态，不代表它验证了本次 Overview 源码补丁的线上部署结果。CodeGraph `sync` 两轮共同步 28 个变更文件；最新状态索引 2,351 文件、33,840 节点、132,693 条边，`pendingChanges` 仍有 1 个新增文件，引用解析完整。索引可用于关系定位，不作为页面视觉验收证据。
- 用本地 Vite 浏览器对接 merchant-demo API 的一次补充运行中，登录接口返回成功，但 `/api/v1/auth/mcp-token` 被 API 以跨来源校验拒绝（本地开发源 4201 不属于商家工作台允许来源）；因此没有把它算作真实后端下的补丁后页面验收。修复行为由隔离浏览器测试的 workspace-scoped API fixture 覆盖，现有已部署页面仍需在其受信工作台来源上更新源码后复测。
