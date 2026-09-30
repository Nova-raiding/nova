# 双后台截图逐页对照（2026-09-29）

> 状态更新（当前复核，2026-09-29 晚）：以下历史矩阵不代表当前工作树或最终发布候选。最近复核时 `main` HEAD 为 `541451e45632f6786022277876847c84312d30fc`；共享工作区仍持续出现并行未提交改动，尚未冻结。截图候选 SHA 仍为 `e60f2485…`，与当前 HEAD 不符。截图基准仍为 `/Users/lixiaomei/Desktop/outputs/ui-images-2026-09-28`。

本轮复核结果：

- 续跑核验（2026-09-29 12:35–12:43 UTC）：在当前共享工作树 `main` HEAD `541451e45632f6786022277876847c84312d30fc` 上，截图对应定向测试 5 文件/32 项通过；Merchant 与 Ops 前端生产构建、发布 metadata 校验、`git diff --check` 均通过。全量安全测试 8 个分片中 5 个通过、3 个失败，尚不能声称完整测试通过。失败项复核后，插件 runtime 镜像差异已消除，源适配器单测通过；安装契约的旧单参数断言已更新并通过。包含生产本地会话用例的 API E2E 文件隔离重跑 81 项全通过，先前 401 未复现。全仓 typecheck 启动后未取得可靠退出状态，仍待重跑。
- 最新只读 `npm run deploy:101:status`（12:35:27 UTC）：各探针 HTTP 200 且容器 healthy，但 `release_approved=false`；API/商家 UI/Ops UI/Worker 分属不同 SHA，生产 PostgreSQL 为 16。健康探针不构成候选发布审批或当前源码验收；没有部署、迁移或写入线上业务数据。
- 截图复看纠正了 Merchant 04 侧栏判断：原图 03 高亮“素材库”子项，04 只高亮“知识库”父项。共享代码曾错误地让 `section=images` 一并高亮子项；现已恢复独立选中状态并更新导航回归断言。该断言在当前全量测试第 2 分片报告通过，但分片之后因 300 秒安全超时结束；仍需完整重跑确认。

- 已确认本地临时 HTTPS 代理先前造成 MCP token 的 Origin 403：浏览器 Origin 带 `:5175`，而生产 API 校验规范 Origin `https://yxsona.com`。只在 `/tmp` QA 配置修正了代理 Origin；没有修改服务端 CSRF 检查。
- 本地商家台的 Vite 构建还必须显式注入 `VITE_API_BASE_URL=/api`。补齐后，生产 API 对商家账号的 session 与 login 请求分别返回 401；运营账号 `hyp@sn.com`、`devide@sn.com` 的登录也返回 401。为避免账号锁定或反复认证，本轮停止登录重试。因此没有取得可用于当前代码页面对照的已登录财务、品牌或用户中心截图；此前占位页截图不作为验收证据。临时 Vite 服务已停止。
- 现有隔离候选虽然容器健康，但其 release SHA 与当前工作树不匹配，数据库为迁移 254，API 使用 fixture 且 `writesEnabled=false`；不能充当真实数据验收环境。
- 101 生产库迁移版本只读观测为 254，当前 `release-metadata.json` 目标是 255。现有逐页修复不能直接切入该混合版本生产环境。
- 本轮运营用户目录定向测试 3 个文件/26 项、最新两笔提交定向测试 3 个文件/67 项、Keychain broker 定向测试 1 个文件/3 项通过；Merchant、Ops production build、全仓 typecheck 和 release metadata gate 均在 HEAD `541451e4` 上通过。Merchant build 的生产拷贝检查也通过。`npm run test:release-gates` 退出 0：主 Vitest 177 个文件/1404 项通过、7 个受保护文件/16 项跳过，Node 后续门禁 152 项通过。release gate 启动前后共享工作区有提交活动，且仍有持续变化的共享未提交路径；因此它不是干净冻结源归档在候选环境上的完整验收。`git diff --check` 通过。
- 最新 `npm run deploy:101:status` 仍显示 `release_approved=false`，公网 API `fd1ad6a7…`、商家 UI `f48c8454…`、运营 UI `fccee758…`、workers `ffcda399…` 等源码版本混用；生产库迁移历史为 254，而候选目标为 255。101 只读 inventory 还报告未分类外部消费者。没有运行迁移或部署，也没有改线上业务数据。
- 最近一次真实商家/运营登录探测仍分别返回 401，无法在登录态对当前源码重拍财务、品牌或用户目录；临时 Vite 代理服务已停止。没有将登录页/占位页计为这些页面的视觉通过证据。

后续必须在同一冻结提交上构建 API 与两个 UI 的身份绑定候选，使用真实后端数据/有效测试账号重新截取并对照所有有效目标页，补齐缺失服务端能力和测试，再通过 101 隔离、恢复与生产发布门禁。不得沿用下述历史截图或测试摘要冒充本轮证据。

> 时点说明：下文“当前源码”“当前 HEAD”和发布测试结果均指 18:00–18:40 的历史候选，不能外推到随后变更的 `185400` 插件及共享工作树。最终候选须冻结提交后重跑发布门禁，并在同版本 API、商家台、运营台与真实 ChatGPT 宿主重新验收。截至本次复核，`185400` 在真实宿主的 116 个工具调用均因 `MCP_CREDENTIAL_SOURCE_INVALID` 停在凭据门禁，业务正向结果为 0；生产仍未部署该候选。

## 当前源码候选与线上对照复核（18:00–18:40）

本节是对本报告早先状态的更新：本轮开始时目录有并行的未提交 UI 审计文档、插件截图证据、发布脚本及点数结算改动；没有将这些共享工作树文件归入本 UI 任务。开始时 HEAD 为 `86be1faf99309b97ee567530153c83dd93167c0f`，过程中共享主目录正常提交插件/Keychain 工作、结算安全与 QA 记录；当前 HEAD 已到 `284396b76cabfbcde048a62e71c6a154ab932980`，仍有 15 项其他未提交文件。候选截图构建源标记为先前工作树 `e60f248528cef78c1b5551f828602bb712654321`；截图期间 Merchant/Ops 源文件与这些 HEAD 均一致（提交只改插件、点数结算、Compose 渲染和审计文件），但截图结果 SHA 仍不等于当前 HEAD，不能冒充当前 SHA 构建。当前源码 Merchant/Ops 构建、类型检查、完整 `npm run test:release-gates` 以及 Ops 浏览器测试已复跑通过；完整 release gates 主测试 177 文件/1404 项通过、7 文件/16 项受保护凭据测试跳过，后续脚本退出 0。之后新增的 Keychain bounded-prompt 测试不属于上述 release gates，源码 UI 未受影响。metadata 暂时不一致后，插件包与四份 manifest/`release-metadata.json` 已并行一起更新至 `183900`；最新 `npm run release:metadata:validate` 通过。页面图与逐页文本/网络记录见 `artifacts/ui-comparison/2026-09-29/{candidate-merchant,candidate-ops}/`。

| 后台 | 逐页候选结果 | 与截图差异的分类 |
|---|---|---|
| Merchant 登录/概览 | 页面加载、无浏览器错误；概览内容已完整渲染 | 登录焦点与真实 KPI/待办数随当前商家数据库变化；概览高度 1077px，目标 1247px，差别主要为目标数据和状态块。 |
| 平台/店铺/商品 | 结构正常，API 返回真实 1 家登记店、0 家连接店 | 目标为 8/3；不能用目标截图数字填充。 |
| 知识、图片、任务、发布、规则 | Merchant 03 与任务/发布/规则目标图为同一张素材库快照；04 是独立截图：仅 Topbar 标题显示“知识库”，左侧“素材库”子项不高亮，其余素材库骨架相同。当前候选 PNG `knowledge.png`、`images.png` 都保留了这两种 Topbar/侧栏状态；所有列表继续读取同一 `/v1/assets` 服务端数据，真实返回 12 条 | 03/08/09/10 目标图重复，04 目标为 8 条素材。12 与 8 的差异来自当前商家后端记录，不是 UI 常量。若“知识资料”另指已解析/审核/索引文档，需明确产品定义及对应服务端读 API；当前截图的 03 目标实际是素材库。 |
| 品牌资产 | 当前候选布局省去旧线上 UI 的独立上传行，截图几何更接近目标；请求 `/v1/brand-scopes` 在旧生产 API 返回 404 | 当前源码有该 API；必须把匹配版本 API 与 UI 在隔离候选环境合验。线上旧 API 造成的数据请求失败不是通过截图验收的证据。 |
| 回收站 | 页面有显示；工作区当前无服务端回收记录 | 服务端缺回收站列表/恢复契约，无法凭空展示目标的一条记录；浏览器本地隐藏数据不作为服务端数据。 |
| 财务 | 版面与目标卡片结构匹配，完整页约 1115px；展示真实钱包余额 12,589 点与真实账本记录 | 目标余额/消耗趋势属于另一时间点数据。线上候选页面旧额外充值/账户/手动发布面板已从当前源码布局移除。 |
| Ops 总览 | 几何与目标一致，真实平台数据呈现，无浏览器错误 | KPI/订阅数随真实数据库变化。 |
| 用户中心 | 候选界面调用当前源码新增的 `account_type` 筛选，旧生产 `/api/mcp` 返回 400 | API 版本不匹配；待同版本隔离环境验证，不能静态前端连旧 API 后判 UI 已验收。 |
| 客户交付 | 页面正常显示客户工作区显式选择器及未选 workspace 提示 | 保持租户边界。目标截图里的一条档案不可跨租户读取或伪造。 |
| 成员/任务/知识/规则 | 页面遵守当前角色与工作区权限；参考图是重复失效会话画面 | 这些截图不能作为正确页面设计基准；平台账号无被选工作区成员权限。 |
| 店铺/模型/存储/审计 | 页面可加载；数据为空、不可验证态及审计记录数依据线上真实响应 | 与截图中的旧快照或 loading 时刻状态不同；不预填。 |

线上复核：API 与 Ops `/readyz` 均为 HTTP 200；两站 `/releasez` 报 `release-demo-product-code-20260929`、Git SHA `fd1ad6a7bd122a391350c185798ac07e92795f8c`、`ready=true`，与上述本地候选源码/API 不是同一 release。18:33 与 18:40 两次 `npm run deploy:101:status` 只读服务清单一致，`release_approved=false`：API 是 `fd1ad6a7…`、商家 UI `f48c8454…`、Ops UI `fccee758…`、workers `ffcda399…`，另有支付和 gateway 等来源。宿主只读清单 `node infra/scripts/ecs-demo-254-host-inventory.mjs` 以 exit 2 返回 `release_approved=false`，列出 44 个 `unclassified_external_consumer`，因为分类器只将 `merchant-demo-85575f9c` 的预期 demo 角色识别为已分类，其余真实容器归属均需人工审查；这些不是可以直接删除的容器。demo 库迁移为 PG16/254，而当前 release metadata 目标是 255；现存隔离 255 浏览器候选只有 PG17 + API + 可选 Merchant UI，无 Ops、workers、支付、完整数据迁移和生产切流。依照 [ECS 候选包安全同步手册](../runbooks/ecs-candidate-safe-sync.md) 和 [101 隔离商家浏览器候选手册](../runbooks/ecs-merchant-browser-isolated-candidate.md)，目前缺少同时保留真实数据并完成 254→255 兼容、全组件验收、完整回滚/切流的已实现路径。当前工作树仍有其它并行未提交文件，候选打包脚本会拒绝脏工作树，因此本轮没有部署，也没有伪造截图数据或改写线上业务数据。

验证更新：`npm run typecheck`、`npm run build:merchant-studio`、`npm run build:ops-console`、`npm run test:release-gates` 通过；release-gates 主 Vitest 部分为 177 文件/1403 项通过、7 文件/16 项受保护凭据测试跳过，门禁之后脚本均退出 0。Ops 浏览器测试隔离重跑为 131 文件/1020 项通过。当前页面截图候选测试不代表匹配版本 API 的隔离运行时，也未替代发布门禁。

## 结论

对照了 09-28 截图清单列出的 23 个后台入口，并用本地 qa-clean 实际前端/API 截图复核。已确认品牌页旧矩阵里的 50px 高度差并完成修复，Merchant 未挂载的发布历史 UI 死码已清理。最终只读交叉检查发现页面矩阵和品牌页实截图早于当前共享源码的最后修改，因此这些截图只证明截图时的构建，不能作为当前源码全页 1:1 的最终证据。不同测试租户的真实店铺、素材、账本、用户和审计数据仍与目标图不同，未写入截图常量或恢复其他租户数据。

目前不能宣称所有页面逐像素 1:1：运营 04/05/06/08 四张参考图都是相同的失效会话图；服务端回收站 API 缺失；这些项目需要有效授权/业务数据或后端能力后才能完成对应状态验收。

## 参考截图与覆盖范围

- Desktop 输出目录 `/Users/lixiaomei/Desktop/outputs/ui-images-2026-09-28` 含 12 张运营后台截图与清单。Merchant 11 张截图在同日期的 WeChat 附件目录 `.../outputs/ui-images-2026-09-28/商家后台/`。
- 清单有 23 个 URL，但不是 23 个独立画面。Merchant 的知识、任务、发布、规则目标图相同，且任务/发布/规则最终重定向到 `/merchant/products`；运营成员、任务、知识、规则四张目标图 SHA256 相同，内容是 `ops.session` 失效告警。
- qa-clean 浏览器矩阵曾覆盖 Merchant 10 个最终路由、Ops 12 个 pathname；截图与 JSON 在 `artifacts/ui-live-restored/2026-09-29/local-container-matrix/{merchant,ops}/`。品牌页单独实测图在 `artifacts/ui-live-restored/2026-09-29/merchant-brands-after-fix.png`。最终复核发现这批图早于共享源码当前最后修改，需在最新构建上重新截取，才能验收当前视觉。

## Merchant 页面

| 目标 | 对照结果 |
|---|---|
| 00 登录 | 主体几何匹配；蓝色焦点框是截图焦点状态差异。 |
| 01 运营概览 | 布局匹配；目标的任务、店铺、素材、告警和 KPI 属于另一工作区快照，当前按 API 返回值展示。目标全页 1247px，当前约 1077px，差异来自目标额外状态提示和数据块。 |
| 02 平台/店铺/商品 | 布局与空商品区匹配；目标为 8 店/3 已连接，当前真实工作区为 1 个 Fixture 店/0 已连接。 |
| 03 知识资料 | 与任务/发布/规则入口目标图重复；目标素材库布局、标题及“素材库”子项高亮匹配。目标 8 项；线上候选真实 API 返回 12 项。 |
| 04 图片素材 | 单独目标图的 Topbar 为“知识库”，侧栏知识库父项高亮而“素材库”子项不高亮；线上候选截图保留此导航状态并共用真实素材列表。目标 8 项及 31.5/50GB，当前 API 返回 12 项及 0.0/50GB；只是列表共用，不是截图重复。 |
| 05 品牌资产 | 修复截图显示原 50px 高度差已消除，修复后图与目标均为 1440×2259；03→04 间距为 14px。但当前共享源码最后修改晚于该截图，须重新构建复测。全局/店铺/系列值仍以 brand-scopes API 为准：当前为空，仅有一个淘宝 Fixture 店和“未分类”系列。保存按钮只在用户修改后出现，保存调用真实 PUT，旧构建上的 reload 读回测试通过。详细记录见 [品牌页几何审计](2026-09-29-merchant-brand-page-geometry-audit.md)。 |
| 06 回收站 | 当前工作区没有服务端删除记录，目标的 1 条素材不能重建。当前页面有浏览器本地隐藏/恢复状态；API 尚无租户隔离的软删除列表、恢复及清理路由，故不能算服务端回收站已完成。 |
| 07 财务概况 | 几何匹配，额外“最近已入账充值”行已移除。余额、套餐、存储和趋势按当前钱包账本/权益/配额返回；当前账本无可绘制消耗曲线，不能补画目标历史曲线。 |
| 08 任务入口 | 清单最终跳转 `/merchant/products`，按默认知识资料入口显示；与目标知识页相同，不是独立任务中心页面。 |
| 09 发布入口 | 同 08。移除了 App 内无挂载点的 `PublishCenter`、专属本地状态恢复、样式和 helper；保留活动发布预览、确认、回执校验、后端发布/人工回填 API 与契约。当前 Merchant 没有可见的发布历史/驳回修正页面；目标图也不是该页面。 |
| 10 规则入口 | 同 08。 |

品牌页最终实测：Playwright 在 1440×1050 视口登录 qa-clean 后读取真实 API，全页 `2259px`、保存按钮初始隐藏、独立操作行数量 `0`、03→04 间距 `14px`。修改全局画像后按钮出现；真实 PUT 返回 200；reload 后读回修改值；测试结束再恢复原画像并验证。测试通过：`dogfood/chatgpt-all-functions/merchant-brand-scopes.spec.js`。

## Ops 页面

| 目标 | 对照结果 |
|---|---|
| 00 登录 | 几何匹配；卡片、字段、按钮、标识位置一致。 |
| 01 总览 | 页面结构匹配；指标按已授权后端数据展示，截图数值与当前工作区快照不同。 |
| 02 用户中心 | 表格与筛选几何匹配；目标 9 条，当前矩阵读取 10 条，账号属性与分页随真实数据变化。 |
| 03 客户交付 | 目标显示 1 条测试公司档案；当前默认未选择客户工作区时显示范围提示和空表，明确选择后读取该租户档案。保留显式 `target_workspace_id` 选择器以满足租户隔离，不能推导或默认越权读取。 |
| 04 成员管理 | 目标图实际为失效会话告警，不能作为成员页面基准；当前平台身份没有 workspace 成员权限，无法验收主体。 |
| 05 任务中心 | 同 04；当前会话没有对应 workspace 页面授权。 |
| 06 知识治理 | 同 04；当前会话没有对应 workspace 页面授权。 |
| 07 店铺治理 | 主体结构匹配；目标停留在刷新/加载态，当前显示 API settle 后状态；Canonical 冲突操作保留显式 workspace 选择。 |
| 08 规则中心 | 同 04；清单指向 workspace 规则，但参考图是失效会话图，当前账号只可验收 platform 规则，不能替代 workspace 画面。 |
| 09 模型服务 | 几何匹配，账号身份按真实登录账号显示。 |
| 10 存储治理 | 目标停留在 loading，当前显示服务端已 settle 的状态不可验证/暂无清单。 |
| 11 审计中心 | 表格骨架匹配；记录数按真实授权审计数据变化。 |

仓库存在 09-07 的 Ops 成员/任务/知识历史实截图，可供旧版结构参考，不能当作 09-28 基准。未签发临时身份、扩展平台权限或伪造 workspace 记录。

## 数据与未完成项

- 知识/图片页面目前读取 Merchant `/v1/assets` 物理素材列表；知识索引文档列表是另一数据面，目前 UI 没有 Merchant 文档查询接口。需要产品明确“知识资料”指上传素材还是已解析/审核/索引的知识文档，再接入相应服务端 API。
- 品牌范围 GET/PUT、系列创建和素材关联 API/迁移已存在。当前 brand-scopes 返回空设置是未配置状态，不是已配置空品牌；未把目标截图的 Logo、品牌色、文案、PDF、店铺、系列写入本地测试数据。
- 回收站缺服务端删除/恢复契约；当前浏览器 localStorage 状态不能代表后端回收记录。需要实现租户隔离软删除、分页列表、恢复及保留/清理策略后才能按真实数据验收。
- 全部 QA 使用本地 `qa-clean` demo/test 工作区；不等同生产租户，也没有部署到公网。

## 验证与运行环境

- 当前重跑 `npm run typecheck`、`npm run build:merchant-studio`、`npm run build:ops-console` 均通过；`npm run release:metadata:validate` 当前对齐 `0.1.0+codex.20260929183900` 并通过。UI/API 聚焦测试 6 文件/70 项通过，Ops 浏览器测试 131 文件/1020 项通过。更新后的完整 `npm run test:release-gates` 主 Vitest 为 177 文件/1404 项通过、7 文件/16 项受保护凭据测试跳过，后续脚本全部运行至结束；当前 Git 最新 SHA `284396b76cabfbcde048a62e71c6a154ab932980` 中另有插件 Keychain bounded-prompt 测试改动，发布门禁没有单独覆盖该新增用例。
- 本轮 `git diff --check` 与 metadata gate 通过。其他共享 UI/插件/发布证据仍有未提交变更；全仓 `run-safe-tests-sharded` 正在持有 `.safe-tests.lock`，故一条重复 UI/API 聚焦测试在等待近 5 分钟后被 owner 停止（没有启动重复测试，也未影响持锁的全仓测试）。
- QA 期间 Docker 数据盘写满，Postgres 日志报 `No space left on device`。先盘点后只回收 4.057GB 不活跃、可重建的 Docker 构建缓存，未删除镜像、容器卷或业务数据；Postgres 自动恢复并完成 WAL recovery。随后本地 API、Postgres、Merchant/Ops UI 健康检查恢复为 healthy，重建 qa-clean Merchant UI 并完成品牌页实测。数据库此前逻辑备份位于 `/tmp/qa-clean-pre-ui-migrations-2026-09-29.dump`。
- CodeGraph 查询用于路由/组件影响面定位；最终交叉检查时索引为 2,356 files / 33,871 nodes / 132,829 edges，另有 6 个工作树变化尚未索引。gstack Browse 既有登录实截图证明浏览器可用，但不替代最新源码页面矩阵或逐图比较；修复后品牌尺寸来自实际 Chromium 截图与 DOM 测量，但早于当前源码最后修改。
- 未部署生产。当前 101 混合组件版本，`release_approved=false`；公网 PG16/254 与本地目标迁移 255 不兼容普通切流，且品牌页/运营用户页候选请求在旧线上 API 分别收到 404/400。本次不将候选前端连接旧 API 的失败态宣称为通过，也未更改线上数据。

## 2026-09-29 最新复核

- Screenshot fidelity 修复复测：Merchant 文案/导航/财务 26 项，Ops MembersSection 5 项、插件安装契约与源码镜像 6 项通过；加 API E2E 后合计 112 项通过。Merchant 与 Ops 独立生产构建均通过，`npm run typecheck` 退出码 0，`npm run release:metadata:validate` 通过，`git diff --check` 通过。
- 发布门禁运行中观察到主 Vitest 组 177 文件、1,406 项通过、16 项跳过；后续受保护发布辅助脚本输出通过记录，但本次没有获得 `npm run test:release-gates` 的最终汇总退出结果，故不记作完整门禁验收通过。
- 当前 `main` HEAD 为 `541451e45632f6786022277876847c84312d30fc`，工作树有大量并行未提交变更。正式候选打包器执行后以状态码 2 拒绝：`candidate bundle requires a clean committed source tree`。没有 stash、强制打包或部署。
- 101 只读探测于 2026-09-29 13:27 UTC 返回 `/releasez`、API readiness、Ops health 均 200，但 `release_approved=false`，服务 Git SHA 混合（API `fd1ad6a…`、Merchant UI `f48c845…`、Ops UI `fccee75…`）。固定主机清单将大量容器标记为未分类外部消费者并拒绝批准。UI 修复尚未进入线上同 SHA 候选运行时，没有生产截图验收或切流证据。

## 2026-09-29 页面文案回归复核

- 新一轮截图/source 对照发现旧报告中的部分文案修改已回退。已恢复 Merchant 概览三处 kicker（`DAILY BRIEFING`、`ACCOUNT OVERVIEW`、`ACTION CENTER`）、目录 `PLATFORM & STORE`、财务三个 kicker（`ACCOUNT & BILLING`、`CREATIVE POINTS`、`ACCOUNT PLAN`）、品牌 `BRAND ASSETS`/`BRAND SETTINGS`、素材 `MATERIAL LIBRARY`，并将回收站 kicker 对齐为 `RECYCLE BIN`。素材页继续显示真实后端列表与配额；没有恢复截图种子数据，也没有将上传控件改称“上传并分析”，因为当前流程不保证自动分析。
- Ops 03 客户资料列将“已完成/未完成”改为语义准确的“已填写/未填写”；交付检查项仍显示“已完成/未完成”。工作区选择器和可写权限下“编辑档案”操作保留，因为它们受租户 scope/权限控制，截图不足以证明可移除。
- 复测结果：相关 5 个测试文件、56 项通过；随后 `npm run typecheck` 退出码 0、Merchant/Ops 生产构建通过、metadata gate 与 `git diff --check` 通过。本条仅证明当前本地工作树；需在清洁、提交后的同 SHA 候选中重跑并获取运行时截图。

## 2026-09-29 当前 owner 复核：素材回收生命周期

- 本轮在 `main` 当前共享工作树实现服务端素材回收生命周期：migration 256、租户隔离/不可变审计、删除与恢复 API、服务端列表、7 天到期租约清理、worker 定时调用，以及 Merchant 回收站改读服务器记录。素材列表、商品/品牌绑定、解析确认和生成源素材读取均按 lifecycle 状态过滤或拒绝；旧浏览器本地回收记录保留为兼容函数但不再作为 UI 真值。
- 隔离 PostgreSQL 验收：`npm run test:postgres:isolated -- packages/persistence/src/asset-lifecycle-release.postgres.test.ts` 通过 1/1，覆盖 256 全迁移、相同 asset ID 的跨租户隔离、拒绝跨租户写、7 天到期、revision CAS、恢复、清理 lease、purge 后保持不可用、禁止再次回收及追加式审计事件。
- 本轮通过项：`npm run typecheck`；Merchant Studio 和 Ops Console 生产构建；worker 与 Merchant 回收 UI 定向测试 131/131；API server e2e、security、HTTP authz、OpenAPI 和 quality-entrypoints 修正后的定向覆盖已分别通过（最终组合复测见会话记录）；`git diff --check`。完整 `npm run test:release-gates` 主 Vitest 曾报告 176 文件/1406 项通过、16 项因受保护凭据跳过，并因并行测试已启动后才修正的清单计数断言失败；该断言独立复跑 16/16 通过。后续 release scripts 被当前共享源目录缺少 `services/payment-gateway`、`package-lock.json` 等生产输入阻断，不记录为完整 release gates 成功。
- 当前源码的新 UI 通过 Vite 18883 打开后，提供的商家账号可到达本地登录请求，但本地 API 因缺少 `VITE_API_TOKEN` 明确阻止鉴权。既有 18881/18882 tunnel 仍服务旧候选；未用旧截图冒充新源码截图，未向现网 API 塞假数据，也未重复尝试登录。故 Merchant 与 Ops 23 张参考图尚未在同一当前源码、真实鉴权、真实数据库的运行候选中重新逐页截图比对。
- 外部截图清单有 23 个页面条目，像素哈希去重仅 17 张；运营成员/任务/知识/规则四图是登录错误，商家知识/任务/发布/规则四图是重复素材库快照。数值型差异按真实数据库值理解；无效重复图不能证明各自独立页面一致。
- 工作树仍有约 204 个共享未提交/新增/删除路径，候选归档要求 clean committed source。101 状态之前已确认 `release_approved=false`，公网迁移仍为 254，与 migration 256 不匹配；没有部署、线上迁移或线上业务写入。本轮完成了可验证代码和隔离数据库验收，但不能宣称所有页面逐图验收、完整发布门禁或生产上线完成。

## 2026-09-30 owner runtime follow-up

- 修正 API 迁移桥隔离测试：不再以 `NODE_ENV=test` 启动 API，而是在一次性 PostgreSQL fixture 中预置符合业务结构的素材快照，并通过正常 API 进程验证 trash、active-list exclusion 和 restore。
- `npm run test:release-gates:runtime` 通过：3 个文件 / 22 项（API 254→255→256 桥及素材生命周期，worker 兼容桥，模型用量结算）。`npm run typecheck` 退出码 0；`git diff --check` 通过。
- 本次最终检查仍见主工作树约 205 个改动路径、分支 `main`，不是可冻结发布候选；没有运行部署或写入线上数据库。逐图桌面浏览器验收仍未完成：候选截图 SHA 不匹配当前源码、商家鉴权缺少本地 `VITE_API_TOKEN`，且多张参考图是失效登录页或重复页面。

## 2026-09-30 当前工作树桌面截图矩阵复核

本节记录本轮通过隔离 PostgreSQL/Redis 和真实 API 路径运行的当前共享工作树矩阵。矩阵不是发布候选证据，也没有写入生产数据。

- Ops 矩阵 `artifacts/ops-jit-isolation/2026-09-29T16-06-24.947Z-31a22efc-42fe-4c3e-a3d0-994731522bb8/desktop-readonly-matrix/matrix.json`：17 个页面状态、0 个页面错误、0 个失败 API。覆盖登录、概览、用户、客户交付、店铺、模型、存储、审计、权限治理目的地及 workspace/store 选择状态。用户搜索框宽度 200px，表格右边缘为 `[287,692,905,1035,1212,1391]`，与参考图几何一致。
- Merchant 矩阵 `artifacts/ops-jit-isolation/2026-09-29T16-07-15.460Z-208dc0a4-6725-4686-988b-cc3bebf3cc8a/merchant-desktop-matrix/matrix.json`：10 条路由、0 个页面错误、0 个失败 API。覆盖登录、概览、目录、知识/素材、图片、品牌、回收站、财务及任务/发布/规则入口；后三者实际重定向产品素材工作区。
- 两矩阵均使用临时隔离数据库账号及当前工作树代码（`productionBrowser=false`），截图中的记录和金额只代表隔离 fixture 的实际 API 返回，不代表截图目标数据或商家线上记录。

| 页面 | 当前源码与有效目标图对照 | 差异结论 |
|---|---|---|
| Merchant 登录 | 卡片、字段与按钮布局匹配；截图焦点状态可能不同。 | 几何通过。 |
| Merchant 概览 | 结构匹配，显示隔离数据库实际响应。 | 指标/待办数是数据差异。 |
| Merchant 目录 | 表格/空商品区域几何匹配。 | 目标 8 店/3 已连接，隔离库 0 店；数据差异。 |
| Merchant 知识、图片 | 标题/框架匹配；知识目标单独选中子项，图片目标只选中父项。 | 目标含 8 项、31.5GB/50GB；隔离库为空，容量按后端响应显示。 |
| Merchant 品牌 | 表单区域可比，但目标含 Store Nova 品牌、Logo、店铺和系列资产，隔离库未配置品牌/店铺系列。 | 后端业务数据缺口；不可用 UI 假值补齐。 |
| Merchant 回收站 | 当前页从服务端加载、支持恢复，隔离库无删除记录。 | 目标有一条记录；目标还出现“彻底删除”，当前遵循 7 天后 worker 清理策略，没有手工永久删除按钮。此处为真实控制差异，需先定义保留策略/权限与审计契约再决定产品控制。 |
| Merchant 财务 | 卡片和图表区域几何匹配。 | 目标 PRO/2480 点/31.5GB 及趋势在隔离库不存在；数据差异。 |
| Merchant 任务/发布/规则 | 路由实际落到 `/merchant/products`，矩阵记录最终路径。 | 参考图为知识素材页重复图；当前也没有独立页面，不能将重复图当独立视图通过。 |
| Ops 登录、总览 | 页面骨架与几何匹配。 | 总览 KPI 按隔离数据库值变化。 |
| Ops 用户 | 搜索宽度与列边界匹配，表格结构一致。 | 目标 9 行/2 页，隔离库 3 行/1 页；数据差异。 |
| Ops 客户交付 | 必须明确选 workspace 后呈现租户数据。 | 目标公司档案不存在于该隔离 workspace；保留 scope 选择以满足租户隔离。 |
| Ops 店铺/模型/存储/审计 | 主体布局匹配；店铺/存储参考截图处于 loading 状态，当前矩阵等待 API settle；模型文案结构匹配。 | 店铺、存储、审计内容按实际 API/授权返回，目标数值不是 UI 常量。 |
| Ops 成员/任务/知识/规则 | 09-28 对应参考图是同一失效会话告警，不是目标业务页面。 | 无效基准，不能据此验收实际 workspace 页面；平台身份也不应被提升权限来制造可比数据。 |

Ops 登录页本轮截图为 `artifacts/ops-jit-isolation/2026-09-29T16-07-15.460Z-208dc0a4-6725-4686-988b-cc3bebf3cc8a/desktop-readonly-matrix/00-login.png`，与目标 `运营后台/00-登录页.png` 肉眼复核：卡片尺寸/位置、标题与说明、字段、按钮和底部 Logo 均匹配。此前矩阵清单提及登录覆盖，但没有指出该图实际位于同批 Ops matrix 目录；此处补上可核对路径。

- 矩阵之前核对 `/Users/lixiaomei/Desktop/outputs/ui-images-2026-09-28` 共 23 个 URL 项、17 个唯一图像哈希：16 张有效页面基准，另有 Ops 失效会话图；四张 Ops 图重复该错误，Merchant 知识/任务/发布/规则四项互相重复素材页快照。
- 修正 API migration bridge 在 schema 256 下的回滚只读过滤：255/256 bridge 允许 active 素材读取时仍隐藏 trashed ID，并对 trashed asset 下载返回 410；trash/list/restore 写接口保持不可用。runtime release gate 3 文件/22 项通过；Merchant recycle/nav/API 定向测试 4 文件/26 项通过。`git diff --check` 通过。
- 全仓 typecheck 本轮未取得有效退出码：共享工作区同时出现多个 `npm run typecheck`，owner 停止自己重复启动的实例；另有共享进程仍在运行。不能记录为本轮通过。
- 代码仍处于未冻结共享工作树，HEAD `fec82c0a7d18fd0d675ca36d450ff430f61843b5` 与旧候选截图 SHA 不同。隔离矩阵只能佐证当前开发树功能；不能替代冻结提交构建、真实商家与运营权限账号、当前 production schema 兼容验证及容器健康检查。
- 后续单实例复核纠正：`npm run typecheck` 退出码 0；`npm run test:release-gates:runtime` 为 3 文件/22 项通过；隔离 PostgreSQL migration 256 生命周期测试 1/1 通过；`git diff --check` 通过。一次本轮 `npm run deploy:101:status` 返回所有 13 个容器 healthy，公网 `/releasez`、API `/readyz`、Ops `/healthz` 为 200，但 `release_approved=false`、应用组件 Git SHA 混合。随后执行固定白名单只读 `node infra/scripts/ecs-demo-254-host-inventory.mjs`：13/13 预期角色各一个、无未分类消费者，另识别一项共享 registry 警告，inventory 明确 `inventory_only=true` / `release_approved=false`。两个远端输出时间为 2026-09-29T16:23:46Z 与 16:25:19Z（远端时钟）；该状态命令和清单均不读取 DB schema，当前生产迁移尾号仍未获得新的受保护只读证明。

## 2026-09-30 owner 修复回收站提前彻底删除对照差异

- 参考图在已删除素材页工具栏提供“彻底删除”按钮。现已补上带确认词和原因的服务端流程：请求携带当前生命周期 revision 与准确素材名；API 仍要求工作区编辑权限，记录 actor/reason 的 append-only `early_purge_requested` 事件，将工作交给现有 worker lease；worker 必须检查业务引用、对象存储删除/缺失证明，再释放配额并写入 `purged`。引用仍存在或对象删除未验证时，生命周期行留在服务端列表并显示失败码；worker 取得 lease 前可通过 revision CAS 撤销请求，且可以恢复素材。没有在 HTTP 请求里直接删对象，也没有绕过租户 RLS、审计或 worker。
- migration 256 增加请求者/原因状态列及事件类型；OpenAPI、API 路由和 Merchant SDK/回收站确认弹窗同步。项目当前 migration 256 仍只存在于未冻结 WIP，未部署线上。
- 复测：`npm run typecheck` 通过；Merchant/Ops 生产构建通过；metadata gate 通过；针对 Persistence/API/Merchant/授权路由的 7 文件/142 项通过；Migration 256 隔离 PostgreSQL 生命周期验收 1/1 通过，覆盖早删请求、worker 领取、引用阻断后可见、可撤销恢复及成功 purge 的事件顺序。生产 UI 合约与 metadata 测试另 2 文件/51 项通过。
- 新 Merchant 隔离浏览器矩阵通过 10 路由、页面错误 0、失败 API 0，证据在 `artifacts/ops-jit-isolation/2026-09-29T16-33-48.178Z-b8a6807f-ce2e-4777-bf16-ecf7f3586ae4/merchant-desktop-matrix/matrix.json`。新拍 `trash.png` 的工具栏包含目标图对应的“全选/恢复所选素材/彻底删除”控件；空回收站而目标显示 1 条记录是隔离库与目标数据差异。确认弹窗路径由 API/E2E 和代码测试覆盖，矩阵本身未生成有素材行的弹窗截图。
- `git diff --check` 通过。随后完整重跑 `npm run test:release-gates` 退出码 0：预发布 runtime 3 文件/22 项通过，主 Vitest 177 文件/1407 项通过、7 文件/16 项因受保护凭据跳过，Node 后续门禁 152 项通过；production config 等脚本均运行至结束。`npm run typecheck`、`npm run release:metadata:validate`、Merchant/Ops production build 和上述定向测试也在本轮通过。
- 工作树仍有 209 条状态记录，混有未审插件凭证、中转、业务点数、迁移、证据和 QA 改动。release-gates 自身的源清单检查也指出当前候选来源缺 `services/payment-gateway`、`package-lock.json`，并发现 `apps/api/src/package-link.json` 为符号链接；不能把整份共享工作树打包成候选或从 HEAD 假称包含当前 UI 补丁。截图仍只证明隔离数据库下页面结构和请求；缺真实商家/运营账号的同版本页面验收。101 仍 `release_approved=false`、应用组件 SHA 混合；当前 schema 尾号没有受保护只读证明，且受保护 254 前向兼容转移/恢复状态机未形成可运行候选。没有在 101 创建迁移、候选部署或容器/数据库写入。

## 2026-09-30 继续 owner 审计与桥接验证

- 重新检查主线：`main` 比 `origin/main` 多 5 个提交。截图 copy/geometry 和 Merchant quota UI 修复已分别提交在 `9d5a8284`、`d4088229`；Ops account filter、build typecheck 和 release source-review 支持也已提交。回收站彻底删除依赖的 UI/API/OpenAPI/authz/persistence/worker/migration 256 仍是共享 WIP，无法从脏工作树直接打候选。
- 历史浏览器截图矩阵未绑定当前 source SHA：历史对比 JSON 指向 `e60f2485…`，新隔离矩阵未记录 commit/build identity，不能作为当前提交的逐页截图验收。矩阵 fixture 使用隔离数据库和生成凭据；Ops 的 `hyp@sn.com` 仅在隔离库重建，不是使用真实运营账号。参考目录中重复截图和失效会话页仍按无效基准处理。
- 补足本地迁移验收：`packages/persistence/src/asset-lifecycle-release.postgres.test.ts` 现在先完整应用 1–255 前缀，再只应用 migration 256；隔离 PostgreSQL 验收通过 1/1。修正 Worker 255 bridge 行为：启动于已验证 255 前缀时不调用 migration-256 lifecycle purge endpoint；完整运行或 256 bridge 仍调用。Worker 定向 2 文件/117 项、全仓 `npm run typecheck` 通过。本轮改动后完整 `npm run test:release-gates` 再次退出 0：runtime 3 文件/22 项、主 Vitest 177 文件/1407 项通过（16 项受保护凭据跳过）、后续 Node 门禁 152 项通过；metadata gate 和 `git diff --check` 通过。
- 101 再次只读状态：13 个业务容器 healthy，公网 `/releasez`、`/api/readyz`、Ops `/healthz` 为 200；API/merchant UI/Ops UI/workers 源 SHA 混杂，`release_approved=false`。库存输出仍是 `inventory_only=true`，有共享 registry 策略警告。主机未安装 `/usr/local/libexec/merchant/ecs-bridge-255-transition`；状态/库存命令均不读取数据库迁移尾，当前生产尾号仍为 UNKNOWN。
- 代码虽增加 Worker 255/256 schema prefix 支持，但部署 preflight 不支持正式 254→256 rollout。现有受保护 255 CLI 只有 plan/journal status/review，没有宿主流量 fence、nonce-backed forward migration/恢复编排和完整故障演练；历史隔离 254→255 预演也不代表生产授权。尚无可支持的生产 schema read-only attestation 命令或真实账号同版本验收。
- 所以当前 UI/API/PG 本地功能证据不等于完整候选：仍需把共享 WIP 逐块隔离成有审查的提交、绑定当前 SHA 重拍 Merchant/Ops 全矩阵并对有效参考图逐页复核、完成 254→256 受保护桥/回滚证明和完整发布证据，再由候选 gate 批准。没有在 101 写入或部署。

## 2026-09-30 真实生产双后台逐页复核与证据绑定

- 使用已授权的商家账号 `demo@ys.com` 与运营账号 `hyp@sn.com`，对线上 https://yxsona.com 与 https://ops.yxsona.com 完成登录后只读页面导航；每个登录会话 1 次认证，随后只访问页面，不点击写入动作。真实生产截图保存在私有目录 `/tmp/store-nova-prod-ui-qa-20260930/`（目录权限 0700，摘要权限 0600），未加入仓库。Merchant 10 个入口、Ops 11 个页面均无登录重定向、浏览器页面错误 0、失败 API 0；任务/发布/规则入口最终落到 `/merchant/products`。登录请求生成认证审计事件属于服务端预期行为，本次未执行业务写入。
- 逐页肉眼核对有效目标截图：Merchant 登录卡片与字段几何匹配；目录/素材网格、素材标题和工具条骨架匹配，数量和真实文件名来自贵人鸟当前后端记录；概览、财务的 KPI/余额/趋势/店铺与目标快照不同，属于租户和时间数据差异，不得填入截图数值。品牌资产线上页存在独立“上传品牌资料”横幅，参考目标没有该横幅，导致下面配置表单整体下移；这是已确认的可见布局差异。线上真实品牌配置与目标 Store Nova 演示数据也不同，不能伪造回填。回收站结构、7 天保留与提前彻底删除控件匹配，但线上该账户当前为空，目标的 1 条记录只可在隔离服务端生命周期测试证明，不是线上现存记录。
- Ops 登录参考图为登录表单，但实际授权登录后已进入总览；当前线上 admin@d… 登录页无法由已登录用户会话复现，故不声称登录页几何对比通过。总览、用户中心、客户交付、店铺、模型、存储、审计均实际打开。用户中心参考为旧版单页筛选/表格，当前为分区用户治理导航和新的表格操作，是清晰可见的页面结构差异；需产品/代码目标基线确认后再改，不能将业务数据差异当作理由。客户交付参考有显式客户工作区选择器，当前真实截图呈现平台连接汇总及其他区块，没有客户选择器，存在真实 UI 功能结构差异；新候选已具显式 scope 选择器，见隔离测试。店铺页参考显示授权健康表格/人工登记入口，生产截图内容因当前服务端数据/加载时序显示刷新状态，未观察到完整 settle。模型服务字段、审计筛选表结构与参考相近。存储页在截图时显示加载状态，和目标截图一致但不是已加载最终态；Ops `hyp@sn.com` 当前菜单无模型、存储、审计入口，仅通过直达 URL 可读取，不能把直达可见性作为导航授权正确的证明。参考中的 Ops 成员、任务、知识、规则四张图相同且为过期 session 错误页，无法用来判定这些业务页视觉是否应匹配。
- 当前开发树隔离矩阵证据分别为 Merchant `artifacts/ops-jit-isolation/2026-09-29T17-03-52.805Z-fe08cb6b-9542-4d18-9d48-9b62b53b2da2/merchant-desktop-matrix/`（10 路由）和 Ops `artifacts/ops-jit-isolation/2026-09-29T17-04-31.116Z-064d1961-e795-41c9-8c66-23d13dc0f9c8/desktop-readonly-matrix/`（17 个状态）。两者使用 disposable PostgreSQL/Redis fixture；矩阵状态通过且没有页面/接口错误。源码指纹前后相同，但浏览器矩阵 JSON 未自带当前 SHA，且当前 `main` 此后有提交活动；这些隔离矩阵不能升级为源 SHA 绑定候选验收。
- 线上健康证据见本审计前文 `npm run deploy:101:status`，健康探针 HTTP 200 且容器 healthy；生产 `release_approved=false`，DB migration 254，而候选有 migration 256，缺正式 bridge/controller 和全服务发布授权。本次没有迁移、部署、线上数据更改。
- 本轮完成 10 个 scoped agent（owner + 9）只读审查。已复核并移除空的临时 worktree `/tmp/store-nova-ui-fec82`。完整源码范围仍有未提交 WIP，UI/生命周期补丁和插件/模型/财务等改动混杂；不可将共享工作区直接作为发布候选。需要继续按截图验证记录拆出最小 UI 补丁，基于冻结/审核的提交重拍并绑定 Source SHA，再在当前源码的 API/UI 同版本隔离环境验收。
- 本轮代码验证（本地时区 2026-09-30）：`npm run typecheck` 退出 0；`npm run build:merchant-studio` 与 `npm run build:ops-console` 退出 0；`npm run release:metadata:validate` 与 `git diff --check` 通过。Merchant Vite 提示单个 bundle 超过 500 kB，构建仍成功且 production-copy guard 通过。
- 本轮首次 `npm run test:release-gates` 在 runner 默认 300 秒总上限处终止，退出 143，不能算完整通过；终止前报告两项 `container-source-freshness`、三项 `production-config-gate` 失败。随后这两份测试定向重跑共 54/54 通过，提示为并发/资源争用期间的暂时失败，尚未找到单测根因。将 SAFE_TEST_TIMEOUT_MS 扩至 900000 再跑完整门禁时，发现上一次 npm 链进程仍在运行导致资源争用，已停止本轮重叠重跑，未声称 release-gates 通过。本轮其余已完成组：release runtime 22/22、host inventory 9/9、source-freshness/prod-config 定向 54/54。前文 2026-09-29 的完整 release gate 退出 0 是先前验证记录，不能替代本轮当前提交上的完整运行。

## 2026-09-30 当前 owner 最终复跑

- 修正 Ops「客户交付」页：目标企业选择器与“刷新交付档案”移至页面顶栏，位于未选择 scope 的警告上方；未选择授权工作区时刷新禁用，不发客户档案请求。选择工作区后刷新请求显式携带其 `target_workspace_id`。复跑 `npm run test:browser:ops:matrix` 通过（1/1 场景、11 个路由、失败 API 0）；当前工作树产物 `artifacts/ops-jit-isolation/2026-09-29T17-45-04.441Z-afa8ce47-8fc7-4e3f-af6d-b86d63fb645c/desktop-readonly-matrix/` 的未选/已选截图已肉眼核验。`CustomerDeliveryPage.test.tsx` 40/40、`npm run typecheck`、Ops 与 Merchant 构建、`npm run release:metadata:validate`、`git diff --check` 通过。
- 当前重跑 `npm run test:release-gates` 的隔离 runtime（22/22）、host inventory（9/9）、主 Vitest（177 文件通过、1408 项通过，7 个受保护文件的 16 项跳过）、后续脚本链及最终 Node 组（152/152）均有通过输出；runner 进程在 shell 会话返回前结束且最终状态回收失败，**不能声明该命令完整退出码为 0**。门禁期间 freshness/production-config 测试将“required input missing”等多行写到标准错误，这是其负例夹具预期输出，不是当前仓库缺文件；已现场确认 `services/payment-gateway`、`apps/worker`、`package-lock.json` 存在，`git ls-files` 已跟踪关键文件。
- Ops 浏览器矩阵是隔离 PostgreSQL fixture，成功只证明当前工作树该矩阵，不代表真实生产数据或发布候选。真实生产上一轮仍可只读健康探针，但应用 SHA 混合、`release_approved=false` 且候选迁移 256 与生产 254 不匹配；没有进行部署、迁移或生产写入。
- 源码绑定 sidecar 尚待随最终文档状态刷新。当前主工作树保留 136 条共享状态记录，staged 内容同时含 API、Merchant lifecycle、Ops UI 与解析器等多项改动，不是清洁可归档候选；没有提交或声称该组 WIP 已集成。

## 2026-09-30 10-agent owner 整合与候选包复核

- 本轮按用户要求共启用 10 个并行角色（owner + 9 个边界清晰的只读审查 agent），覆盖商家/运营截图差异、发布候选输入、迁移转移、资产生命周期、源码绑定、用户中心和 worktree 安全。所有结论由 owner 复核整合；agent 未写生产数据。
- `main` 当前 HEAD 为 `27aa1d3e1fd9b03827de50fbdb2bcbe3ae3c8d89`。其中 `24fa2e4c` 修复资产 purge lease 持锁时通过同一事务 client 写入完成/失败状态的死锁问题；`27aa1d3e` 将运营用户目录搜索框宽度调为 200px，以匹配桌面参考图表格几何。之前的客户交付 scope 选择器及显式 `target_workspace_id` 刷新请求已在 `24fa2e4c`。
- Ops 浏览器只读矩阵复跑 17 个页面/状态，页面错误 0、失败 API 0；用户中心搜索控件父级宽度 200px，表格边界与 1440px 参考图对齐。另从 clean detached worktree `27aa1d3e` 重拍 Merchant 10 路由，页面错误 0、失败 API 0，结果 `artifacts/ops-jit-isolation/2026-09-29T18-26-21.256Z-ef4ebfe1-6c2d-4334-b5bd-2a46508b154b/merchant-desktop-matrix/`，workspace 为 disposable PostgreSQL/Redis fixture。商家页面矩阵通过不代表截图数值相同：品牌/财务/配额/素材总量按各自后端记录呈现，不回填目标图数字。另一个 Merchant 交互 dogfood 18 项中 17 项通过，1 项断言已退役的“人工发布状态”财务区块；目标参考图与当前 UI 都没有该区块，因此这是过时自动化断言，不是本轮 UI 回归，测试断言尚未更新。
- 验证：`npm run typecheck` 退出 0；`npm run test:postgres:isolated -- packages/persistence/src/asset-lifecycle-release.postgres.test.ts` 1/1 通过；资产 lifecycle/API 定向测试 2 文件/94 项通过；`npm run test:browser:ops:matrix` 通过；`SAFE_TEST_TIMEOUT_MS=900000 npm run test:release-gates` 本轮完整退出 0（runtime 3 文件/22 项、主 Vitest 177 文件/1408 项通过，受保护测试 16 项跳过，后续 Node 门禁 152 项通过）。
- 从 clean detached worktree `27aa1d3e` 只读生成候选包，绑定源码 SHA256 `43be34f7864d2649f5b3a3090658ce69208a11f3c8adbe51aab16f0d4bf234a5`、比较清单 SHA256 `189dbaf42757c9100bf2304f13af6027406952debf993c52af2701e2d8b1d759`、同步计划 SHA256 `394566db2242b003b07058f973b65bf625cc9406808e3c37672de3b536ba9811`。计划共 1008 项：383 same、236 `review_required`、389 `missing_remote`。结构审查 43 项中 6 项匹配、37 项不匹配，另有 23 个受保护路径要求主机侧复核；不能把候选直接同步至 `/opt/merchant-deploy`。隔离候选 6/6 结构测试通过；远端 allowlist 仅读抓取 170 个源码文件，拒绝 66 个非源码/配置路径，没有持久化原始远端字节，也没有修改主机。
- 本轮新 `npm run deploy:101:status` 仍为 `release_approved=false`：13/13 容器健康，公开健康探针为 200，但 API/UI/worker 等源码 SHA 混用，schema 254 与候选 migration 256 不匹配，且 254→256 受保护 bridge、恢复状态机及隔离候选证据未就绪。没有部署、迁移、staging 或线上业务写入。
- 当前工作树保留用户/并行任务中的约 121 条未提交状态记录，主要在插件凭证与 QA 证据；未清理或覆盖。clean-source detached worktree 的候选浏览器环境已停机且没有容器遗留，Matrix 结果已归档到当前工作区；其两个由测试脚本明确保留的隔离 fixture volumes 仍保留。候选远端源码快照含 private allowlist 文件，限制在 `/tmp` 权限目录，不作为仓库产物。

## 2026-09-30 继续修复 Merchant 浏览器断言并重跑发布门禁

- 修正 `dogfood/chatgpt-all-functions/merchant-interactions.spec.js` 中已退役的财务“人工发布状态”区块断言：现在验证财务概况和充值入口存在，发布任务动作不出现在财务页。主工作目录已有共享未提交变更，浏览器候选 runner 按契约拒绝 dirty tree；修正后的单项 Playwright 用例以 `npm exec -- playwright test dogfood/chatgpt-all-functions/merchant-interactions.spec.js --workers=1` 直接在本地隔离候选运行，1/1 通过。`run-safe-tests` 不包含 `.spec.js`，按该入口运行会报告 No test files；不是测试失败。
- 当前源码对应的 Merchant 全页只读矩阵已经从 clean HEAD worktree 跑完 10/10 路由、页面错误 0、失败 API 0，并归档在 `artifacts/ops-jit-isolation/2026-09-29T18-26-21.256Z-ef4ebfe1-6c2d-4334-b5bd-2a46508b154b/merchant-desktop-matrix/`。独立互动 Playwright 修正通过。重跑 `SAFE_TEST_TIMEOUT_MS=900000 npm run test:release-gates` 完整退出 0：runtime 22/22、主 Vitest 177 文件/1408 项通过、16 个受保护测试跳过、Node 门禁 152/152 通过。
- `npm run release:metadata:validate` 与 `git diff --check` 通过。最新 `npm run deploy:101:status` 仍为 `release_approved=false`，13 个容器健康且公网 health/readiness HTTP 200；API/商家 UI/Ops UI/worker SHA 混杂、PG16 schema 254 与目标迁移 256 不匹配，不能将健康误作审批。未做部署、迁移或线上业务写入。
- 刷新 Merchant 来源绑定 sidecar 后，根目录审计文档继续更新；应在提交或停止修改前再次刷新 sidecar。共享工作树其他 WIP 保持原样。

## 2026-09-30 提交测试修正并验证新 SHA 浏览器候选

- 单独提交已修正的互动测试为 `52d79f52e63e4e8b21f8aaeaeb37a4cf3391ae24`，没有把其他共享 WIP 放入提交。原 `27aa1d3e` 的全量商家矩阵结论仍仅用于 parent SHA。
- 从该提交 clean worktree 重拍 Merchant 10 路由矩阵，10/10 路由通过、页面错误 0、失败 API 0，归档目录为 `artifacts/ops-jit-isolation/2026-09-30T52d79f52-merchant-desktop-matrix/`。同一 SHA 的 `npm run test:browser:merchant` 第二次启动后完整通过 18/18 场景；第一次重试前的失败在迁移容器遇到 PG startup `connection refused`，隔离容器已停止，第二次完整运行正常。该脚本保留了两轮隔离 fixture volumes，没有残留运行容器。
- 为提交 `52d79f52` 重新生成只读候选包：candidate source SHA256 为 `051b08213adbae3831f7dbb5fed79b25413e0c5df2d8adeeea369292217aa8c9`。对 101 的只读计划仍为 1008 项（383 same、236 review_required、389 missing_remote）；43 个可结构审查文件中 6 个匹配、37 个不匹配，另有 23 个保护路径须 onsite 复核。170 个 allowlisted 源文件被提取用于受限对比，未写回服务器。完整三方合并、缺失文件逐项分类、受保护主机核验尚未完成，不得上传或同步。
- 完整 `npm run test:release-gates` 在提交前以同一测试文件字节完整退出 0（主 177 文件/1408 项、受保护 16 项跳过、Node 152/152）；Merchant browser 18/18 和逐页矩阵均在提交后的 clean SHA worktree 上验证。101 最新只读状态仍 `release_approved=false`，应用 SHA 混用，PG16/schema 254 与候选迁移 256 不兼容证据未闭合；未部署或执行迁移。
- 当前 clean SHA worktree 的 Merchant 矩阵 sidecar 待本节审计定稿后刷新；主工作区其他约 129 条共享状态记录保留原样。

## 2026-09-30 线上 schema 只读复核及并行差异审查

- 通过 101 上 API 容器内已配置的 `OPS_DATABASE_URL`，使用 `merchant_ops` 角色执行 `BEGIN READ ONLY` 查询；事务确认 `transaction_read_only=on`，读取数据库 `merchant` 的迁移记录后 `ROLLBACK`。UTC 2026-09-29 18:50Z 观测到 254 条记录，尾号 254；最近三条迁移为 252 `charged_text_dispatch_attempts`、253 `charged_text_no_delivery_resolution`、254 `merchant_entitlement_snapshot_cursor`，对应 checksum 已记录在受限只读证据 `artifacts/demo-deploy/2026-09-29/live-schema-readonly-20260929T1850Z.json`（权限 0600）。没有修改数据库或业务数据。此前引用的尾号 255 快照与本次生产角色查询不一致，应视为过期/不同观测，不能作为当前证明；本次查询也尚未验证 1–254 的完整 SQL/checksum 链或 `merchant_app` 角色视图。
- 候选 SHA `52d79f52` 的发布差异由 9 个并行只读审查角色分域检查，owner 汇总复核；没有 agent 修改代码或生产环境。Merchant 远端审查报告 28 项 review、70 项 missing；Ops 195 项中 136 review、59 missing，远端取回源码有 4 项不可用。API 定向 18 项中 4 review、14 missing；插件/MCP 定向 41 项中 40 missing、1 项需审查。多个大幅服务端、登录授权、租户交付和插件协议改动需要整合审查，不能作为可直接恢复的截图版 UI 文件。
- 部署/迁移/授权/模型计费并行审查共同确认：候选元数据迁移目标 256，而 `ecs-candidate-safe-sync.md` 当前隔离 API/worker 合同只覆盖 254→255，demo 254 桥接安装手册明确 NO-GO；候选 255/256 及 PG16 兼容、完整迁移 checksum 链、回滚 capsule、真实服务混合版本仍未闭合。新增模型/支付账务配置需生产受保护证据，不能运行可能产生费用的 canary 来替代审批。`release_approved=false` 不变；本轮没有 staging、部署、迁移或支付/模型调用。
- 将发布 runbook 旧的“当前 242→255”段落更新为当前 254→255→256 两阶段阻断条件，并明确 automation worker 的跨阶段测试和插件第二阶段接口仍待验证；隔离 Merchant 流程目标绑定候选 release metadata 256。其后修正 Ops review sidecar：迁移尾从隔离候选 manifest 读取并强制匹配 PG17 attestation；定向测试覆盖 255、256 与不匹配拒绝，共 11/11 通过。sidecar 尚不独立读取源码归档的 release metadata，因此必须由候选 renderer/归档身份链证明 manifest 尾号确实来自同一冻结候选；这项证据未完成。没有将旧阶段签名演练伪装成 256 证据。`release:metadata:validate` 与 `git diff --check` 通过；只读重采 101 于 2026-09-29T18:53:18Z，13/13 容器健康，公网 release/readiness/Ops health 为 200，但服务 SHA 仍混杂、PG/Redis 仍为带标签的既有运行镜像，`release_approved=false`。
- 刷新 Merchant 矩阵 source-binding sidecar，现绑定 HEAD `52d79f52`、6275 个源文件、23 张参考图及 23 个生产截图摘要。当前树摘要以 sidecar 实际内容为准；该 sidecar 只证明截图/源码绑定关系，不代表截图逐像素全部通过或线上发布批准。


## 2026-09-30 exact SHA 113ad72 desktop screenshot comparison

- Candidate source is exact committed SHA `113ad72cd194e79c89fa44c16c9a574a7e4208aa`, tested from a clean detached worktree with disposable PostgreSQL and Redis. Merchant screenshot matrix: 10 routes, 1440px viewport, sidebar/main-shell offset 224px, zero page errors and failed API requests. Ops read-only matrix: 17 page and authorization states, zero page errors and failed API requests. Browser flows for Merchant passed 18/18; Ops desktop matrix passed 1/1 test covering its page/state assertions. PNG and JSON evidence are preserved at `artifacts/ui-comparison/2026-09-30/sha-113ad72/{merchant-desktop-matrix,ops-desktop-readonly-matrix}/` with private directory/file permissions.
- Rechecking the original images at native pixel coordinates confirms both original Merchant brand screenshot and candidate start the main content at x=224. A prior estimate based on scaled previews (194 vs. 224) was incorrect; no sidebar CSS change is warranted.
- The candidate and reference align in shared shell, page panel arrangement, headings, search/table geometry, and primary controls on the pages that have valid references. Remaining visible differences are predominantly live-data/configuration state: the historical Merchant baseline contains seeded-looking brand fields, PRO/credit/storage/trend values and asset rows, while the candidate fixture reports unconfigured brand, unread balances, and empty lists. No screenshot values were hardcoded and no merchant data was inserted to imitate the reference. Ops selected-workspace pages additionally show the explicit scope selector/empty authorized fixture state required by the current authorization flow.
- Four Ops reference images (members/tasks/knowledge/rules) are the same login-error screenshot and cannot establish those pages' appearance; candidate matrix still exercised platform-scope-denied states for members/tasks/knowledge and the rules page. Merchant task/publish/rules references repeat the same Materials Library screenshot; candidate routes correctly resolve those legacy paths to the current canonical products route.
- Full release gates and typecheck passed for this code/test change set before its isolated browser verification: runtime 22/22, core Vitest 177 files with 1410 passed and 16 protected cases skipped, Node gates 152/152; exact sidecar tests 11/11. The first Ops browser-matrix attempt failed at environment startup because the fresh worktree lacked workspace package build outputs; after `npm run build:packages`, the exact same SHA matrix passed. This is recorded as an environment setup correction, not a product defect.
- Production remains outside this visual acceptance: latest read-only host status has 13/13 containers healthy and public health endpoints 200, but `release_approved=false` due mixed service SHAs and schema 254 vs candidate 256 plus incomplete bridge/recovery evidence. No deployment or production write occurred. Visual/build verification in the isolated fixture does not satisfy the production release gate.


## 2026-09-30 owner 复核发布差异与 automation bridge

- 从干净提交 `113ad72cd194e79c89fa44c16c9a574a7e4208aa` 生成本地候选 identity，归档 SHA-256 为 `578196fe834a5e8b08509417524a88beef13ae3d8f83fd2627cbeda576e3467b`，comparison manifest SHA-256 为 `189dbaf42757c9100bf2304f13af6027406952debf993c52af2701e2d8b1d759`，sync plan SHA-256 为 `394566db2242b003b07058f973b65bf625cc9406808e3c37672de3b536ba9811`。101 只读 plan 1008 项：383 same、236 review_required、389 missing_remote；170 个 allowlisted source 文件只读获取，66 个 source/config 路径拒绝获取；43 个结构条目中 6 match/37 mismatch，23 个受保护路径需要 onsite review。此为审查材料，不是上传或 staging。候选保存在 `/tmp/ecs-candidate-113ad72/candidate`，权限受限；未写服务器。
- 只读主机 inventory 观察到 13 个预期运行服务，无 unclassified external consumers；共享 `/storenova-registry` 仍触发 consumer policy warning。容器健康和 `/releasez`、API readiness、Ops health 均正常，但多个服务 SHA 混用，且尚缺生产兼容迁移与受保护恢复/切流证据。inventory/status 的 `release_approved=false` 是设计上的只读未批准值，不能当作具体 gate 原因或可通过绕改 status 解决。
- owner 复核隔离 worker 测试后发现真实 automation 进程缺口，并将其补入 `tests/ecs-254-255-worker-bridge-isolated.postgres.test.ts`：255 时 automation worker 只调用例行 tick/orphan cleanup、不发 256 purge；256 迁移后重启真实 automation 进程，验证唯一 purge 的 workspace、请求体、token、automation role 和 HMAC proof。`npm run test:release-gates:runtime` 在该改动后由实现 agent 实跑通过（3 files / 22 tests）；owner 仍需独立复跑和 typecheck。此测试不代表生产 PG16 恢复、所有 worker role、队列业务 canary 或宿主切流已完成。
- 运营用户中心线上实图仍和历史参考存在筛选/属性列与多标签治理工作区的结构差异。候选在隔离 fixture 的 17 state 矩阵通过，不是线上真实运营账号下的逐图视觉批准。Merchant overview 的卡片壳体和 224px 主内容起点一致；banner 与真实店铺状态不同会改变纵向位置和后端数值。不能写入参考图数字来消除数据差异。

## 2026-09-30 当前提交逐图差异复核（a770e424）

- 当前 `main` 为 `a770e424fcdc8b5286d498992e8ffaf7ead2a2f1`。对 2026-09-28 基线目录 23 张 PNG 按 SHA-256 去重为 17 组：有效商家页面基线 8 张、有效运营页面基线 8 张；运营 04/05/06/08 是同一张会话错误截图，不能评成员/任务/知识/规则页面；商家 08/09/10 与 03 知识资料图完全相同，清单也记录三个入口最终重定向到 `/merchant/products`，所以按素材库落地态比较，不声称各有独立工作页。
- 当前提交相对已存浏览器矩阵 SHA `113ad72cd194e79c89fa44c16c9a574a7e4208aa` 的商家/运营 UI 源码差异仅在商家回收站说明文字；Ops UI、Merchant 布局/CSS没有变化。两处文案改为由服务端提供保留期限，并说明可恢复到原店铺或申请提前彻底删除，避免旧的固定“7 天”说法。`npm run check` 与 `SAFE_TEST_TIMEOUT_MS=900000 npm run test:release-gates` 均在该提交内容下退出 0；商家回收站源码/文案契约属于通过用例。该结论只约束源码差异范围，不把旧矩阵图片改称 a770e424 构建。
- 页面逐项结论：商家登录、商品、知识/素材、品牌、回收站和财务的主体结构与基线相近；概览少了基线里的连接/待办异常提示且待办卡为空。品牌线上页曾观察到额外“上传品牌资料”横幅并使表单下移。运营总览卡片/导航基本对齐；用户中心由旧单页筛选表变为分区治理结构，是可见结构差异；客户交付需要显式选工作区，未选时显示范围提示；店铺页有权限、策略和冲突队列状态提示；模型页结构接近；存储和审计显示真实的不可验证/已加载空态，而参考分别停在加载态。目标截图中的金额、商家数、素材行、品牌值和审计/客户行属于当时数据库快照，不得写成前端常量。
- 逐页 PNG `sha-113ad72` 明确使用 disposable PostgreSQL + Redis 与隔离身份（`productionBrowser=false`），只作版式/交互证据，不是 `demo@ys.com` 贵人鸟或真实运营账号的数据验收。矩阵 sidecar 绑定 113ad72，且当前回收站文字不同；因此不作为当前 SHA 全矩阵通过证明。该矩阵记录 Merchant 10 路由、Ops 17 个页面/权限状态均无页面错误和失败 API；可作为历史隔离测试证据。当前源码回收站改文案后没有重新截图；本轮没有伪造商家记录、引入截图数据，也没有对生产库写入。
- 共享工作目录仍有并行插件 Keychain/授权测试修改，候选浏览器 runner 的 clean-worktree 前置条件不满足；本轮没有挪动或覆盖这些文件。通过 CUA 浏览器检查时未发现可用 Chrome/IAB provider。重新绑定当前 SHA 的全页浏览器矩阵，以及以真实生产账号/同版本 UI+API 逐页截图，仍未完成。101 发布状态保持 NO-GO，详见 [ECS 候选包安全同步手册](../runbooks/ecs-candidate-safe-sync.md)；本次没有 staging、迁移或部署。
- 后续生产只读登录复核（2026-09-30，Asia/Shanghai）：Merchant `demo@ys.com` 与 Ops `hyp@sn.com` 各尝试一次，登录 API 均返回 HTTP 401；没有再试其他密码/账号，未建立业务会话，也没有拍摄登录后的页面。两张未登录页、匿名 releasez 响应及不含凭据的摘要保存在权限 0700/0600 目录 `/tmp/store-nova-prod-ui-qa-20260930-current/`；两站 `/api/releasez` 均为 `ready=false` 且 release id/SHA 未提供。登录页卡片/字段结构与参考大体一致，空表单按钮 disabled 样式颜色不同于参考截图（参考图看起来处于 enabled 状态）；这不能替代登录后页面验收。

## 2026-09-30 当前 d7a78ca6 逐页矩阵与旧图对照

- 当前 HEAD `d7a78ca65780551c980c9fc21a8b8d60d4dd21f6` 的浏览器证据已重拍并由截图门禁逐页绑定 SHA 与 dirty-path 清单。Merchant 证据在 `artifacts/ops-jit-isolation/2026-09-30T02-35-06.532Z-0e51d8bf-b764-4ec4-bc4e-209abadf9d57/merchant-desktop-matrix/`：10 个路由均通过，`pageErrors=[]`、`failedApi=[]`，裸任务/发布/规则入口都按规范重定向到 `/merchant/products`。Ops 证据在 `artifacts/ops-jit-isolation/2026-09-30T02-35-45.756Z-1f022783-bd85-4507-91ca-a6fb97f6a4ea/desktop-readonly-matrix/`：18 个路由/权限状态通过，`failedApi=[]`。两个 fixture 均使用隔离 PostgreSQL/Redis；它们证明当前 dirty source 的桌面 UI 与授权状态可运行，不代表生产商家数据。最初并行运行两个 fixture 时 Ops 有一个 Postgres 连接超时；清理确认两套容器均已停止，串行重拍通过，未触碰外部容器。
- 逐页结论（以 2026-09-28 原图去重组为基准）：Merchant 登录、总览、商品/店铺、知识/素材、品牌、回收站、财务都有独立截图；任务/发布/规则三图与知识页完全重复，且清单明确重定向到素材库。当前三个裸入口截图继续一致呈现素材页，属于目标定义中的复用状态。商品/素材数量、点数余额、钱包和趋势图来自各自数据库，不按截图写死。
- Merchant 品牌页当前代码保留全局、店铺、系列三组表单/预览区；有效基线预填 Store Nova logo、颜色、品牌文案和品牌手册。当前隔离候选的三组区域为空，并用“未单独配置/等待真实数据”显示空值。较早只读生产图 `/tmp/store-nova-prod-ui-qa-20260930/merchant-brands.png` 还显示一条“上传品牌资料”提示条，导致表单下移，且已授权商家没有可编辑的店铺/系列配置；此图来自混合 SHA 的旧线上 release，不能代表 d7a78ca6 候选。差异涉及真实配置及品牌资产写入/持久化能力，不能通过预填 demo 品牌值伪造一致。
- Merchant 财务基线的 PRO 套餐卡、2,480 点、31.5/50GB 与本地/线上候选的当前余额、钱包、容量、趋势不同；生产实图可见余额 12,582 点、容量 50GB，趋势为 2 个点并合计 98 点。这是截取时真实服务端账本的差异，不属于静态 UI 缺陷。运营概览/商品/素材的记录条数、计划和状态同理按服务端结果比较，不要求像素/数值复刻旧数据库。
- Ops 总览、店铺治理、模型、存储、审计拥有有效参考，截图反映旧版本导航/布局及当时的数据状态；当前 Ops 有身份/权限范围提示，并且存储/审计展示当前授权和空数据状态。Ops 用户中心从基线单表筛选变为“已接入用户、商家工作区、成员、入驻申请、权限与授权”分区；这是真实结构差异，不是数据差异。客户交付基线直接显示一条客户记录，而当前平台会话在未选客户工作区时明确拒绝范围外读取；选择工作区后矩阵可显示该隔离工作区数据。生产只读图也记录未选客户工作区提示与空表。必须保留租户范围校验，不能为了复刻基线去掉选择步骤或复制客户行。
- Ops 基线的成员、任务、知识、规则四图为同一登录错误 PNG，无法作为这些业务页基线。当前平台会话对成员/知识/任务等企业工作区能力按权限拒绝，矩阵记录 denial 状态；正确验收需要相应真实商家工作区会话。平台规则等页面当前可在授权范围验证。截图中的蓝框属于截图选区标记，非产品 UI。
- 2026-09-29 的真实生产只读截图 `capture-summary.json` 记录 10 个 Merchant 与 11 个 Ops 页面均无页面错误/失败 API，路由结果与规范入口一致，但没有同屏绑定当时完整 release Git SHA；另有 2026-09-30 当前生产认证各一次 401、`releasez.ready=false` 的记录。因此这些旧线上截图可佐证已部署版本与真实数据库的页面/数据状态，不能作为当前源码 d7a78ca6 的 release acceptance。最终全项目候选仍需干净、已冻结提交、完整同 SHA API/MCP/UI/worker 运行和真实数据库权限验收。
- 根因复核：隔离桥接测试曾因共享 WIP 同时宣称 migration 258 而失败（链尾实际 257）。迁移负责人确认 migration 256 已含生命周期保护、257 已加快照外键；重复 FK 的 migration 258 草案不存在必要性。owner 已将相关测试、worker 期望与 PG17 restore identity 校验对齐回实际 257 清单，没有改写 migration 256/257 SQL。修复后 runtime 3 文件/22 项、迁移/worker/restore 定向 4 文件/144 项、PG16 1–257 全链与 PG17 restore 合同均通过；完整 release gate 与当前候选干净树/生产发布仍待最终收口。
