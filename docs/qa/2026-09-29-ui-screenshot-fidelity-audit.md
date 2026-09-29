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
