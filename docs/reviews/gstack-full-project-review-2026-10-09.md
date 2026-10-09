# Store Nova 项目全量评审

日期：2026-10-09 至 2026-10-10（增量复核）
范围：ChatGPT 本地 stdio 插件、MCP/API、商家工作台、桌面运营台、模型中转、租户权限、生产健康和可运行测试。按项目 `AGENTS.md` 未进行生产写操作、部署或真实付费模型调用。

本轮完成了大范围代码、隔离 API、MCP、本地浏览器 fixture 和 gstack dogfood/design 走查；本报告不声称每个生产页面和每条付费业务链路都已通过。production profile 已安装到本机 `merchant-marketing@personal`，并通过安装桥接验证器完成安装文件、stdio `initialize`/`tools/list` 和缺配置 fail-closed 验证；当前既有 ChatGPT 对话是否刷新未验证。生产运营身份及真实中转图片/视频输出仍未验证；不把公开市场、ChatGPT OAuth 或签名作为门槛。

## 修改

- 套餐权益与目录摘要改用统一中文单位格式，修复 `2business_hour`、`12500creative_points` 和重复拼接 `GB`。不改变服务端权益或账本数据。
- 概览低库存/缺主图待办在旧指标缺少 `entityType` 时仍可将商品标题作为搜索词跳转到商品目录；标题不作为商品 ID。
- 新增商品目录关键词、近 7 天添加筛选、无匹配反馈、重置与分页浏览器回归，并纳入 merchant candidate runner。修复同页 Ant Design `Space.direction` 弃用警告。
- 商品目录新增回归后修复两个边界：店铺入口按 `(platform, accountId)` 查找并同步所选平台，最近 N 天筛选排除未来日期。新隔离浏览器回归 `catalog-scope-future-date.browser.spec.js` 的同 ID 跨平台点击与未来日期过滤分别通过 1/1；首次浏览器尝试因本地 Vite 未设置 `VITE_API_BASE_URL` 未到达目录断言，改用 `/api` 配置后完成验证。没有重跑原目录筛选/分页绿测。API 读取错误仍没有目录内重试控件，记录为后续 UX 缺口。
- 修复 PostgreSQL RLS 攻击矩阵：事务固定在同一 `PoolClient`；预期拒绝的写入通过 savepoint 回滚。
- 修复浏览器入口：将商品风险跳转 Playwright spec 纳入 merchant 隔离 runner；移除错误传入 Playwright 的 Vitest 文件，改用真正的浏览器 spec。
- 新增隔离资产下载授权/对象读取 PostgreSQL 验收、运营公共规则 Markdown 上传浏览器验收，以及公共规则详情异常格式的 UI 边界回归测试。
- 修正默认测试 suite 的 PostgreSQL pending 白名单：移除会在无数据库时直接失败的资产下载用例；创意点并发撤销用例保留精确 pending，并加入隔离 PostgreSQL runner 与 CI 验收清单。
- 电商商品图参考增加商品身份锁定、买家决策顺序、渠道规则核对、真实性复核；视频策划增加跨镜头一致性、转场/动作衔接、声音方案合同。实际生成仍走 Store Nova MCP、中转鉴权、权限、成本/用量及扫描归档门禁；未引入第三方 provider/API/CLI 或本地生成脚本。插件内的本地商品图、视频策划、分镜和公开导入技能及参考文件存在于源包与 marketplace 镜像；商品图/视频增强是根据公开资料整理并适配本项目治理约束的流程指导，不是将外部仓库 Skill、CLI、provider 或 renderer 原样安装。逐文件 SHA-256 一致，打包清单包含这些本地资源。production profile `0.1.0+codex.20261010011930` 已安装并启用（本地 stdio 候选，不是 ECS release）；构建收据为 `ready_to_install=true`、`source_dirty=false`，commit `40f22acd`；verifier 报告 tar/source provenance `checked_files=85`，已安装 runtime inventory source/install `69/69`，stdio 工具 `134/134`，且无配置时 `workspace.health` fail-closed 为 `MCP_CONFIGURATION_REQUIRED`。`.agents/plugins/marketplace.json` 不在安装缓存中符合安装时排除 `.agents` 的规则。当前既有 ChatGPT 对话刷新和真实付费成片仍未验证。
- 外部技能检索参考了 [Ecommerce Image Workflow](https://github.com/nexu-io/open-design/blob/main/skills/ecommerce-image-workflow/SKILL.md)、[ecommerce-image-skills](https://github.com/xianyu110/ecommerce-image-skills) 和 [AI video storyboard skill](https://github.com/aicontentskills/ai-video-storyboard-skill)；本地参考文件也标注 [ec-visual-skill](https://github.com/oldred-byte/ec-visual-skill)。采纳参考图保真、镜头/图片规划和交付复核要点，写入本地插件技能；未原样安装依赖 OpenDesign `OD_BIN` CLI/媒体调度器及其已配置图像 provider 的工作流（以上为上游技能文档中的执行要求，未独立运行），也未接入带强制营销导流的外部手册；根据本项目治理约束，接入前须评估是否符合 MCP、中转权限和审核门禁。
- 商家财务趋势把日期和周期改为草稿；点“查询”才应用，重置恢复默认区间。此前日期变动即时过滤而查询按钮没有行为。
- 商家通知下拉和风险详情根据接入模式使用与概览一致的安全提示；手动接入时不再要求“重新发起官方授权”。规则与类目搜索统一去空格并忽略大小写。
- 修复回收站提前彻底删除失败后的丢失确认状态：仅全部受理才关闭；部分成功时从选择中移除受理项并保留失败项、原因和确认词。另为成功空回收站添加 `role=status` 状态通知。新增状态回归 3/3、回收站服务端状态 3/3，扩展后的真实浏览器交互回归 1/1 通过。
- Ops 新增权限过滤的“运营数据与审计”次级导航，接入财务、存储和审计；Models 仍按退役状态隐藏，工作区专属域仍按身份边界隔离。
- 运营客服工作区按 `support.ticket.update` 权限禁用新建、分配、状态变更和备注控件；无更新权限时默认 fail-closed。
- 修复未绑定图片候选缺少商家确认标题时被默认名称掩盖的问题，现应在素材访问、预算预留和持久化前返回 400。视频技能完成条件与服务端交付契约对齐：以完成状态、扫描/归档和工作区资产引用为准，不依赖 provider 原始 URL。
- MCP 新增商品知识读取/审批方法并补齐 OpenAPI、发布元数据及相关合同；测试目录存在独有和不同步文件，不视为镜像完全相同。审批使用 revision CAS、租户与角色校验、追加审计；回放只验证治理事件，不把商品事实错误投影到旧知识资产中。
- HTTP 商品搜索 `GET /v1/products` 的 `facts_confirmed` 现在严格只接收 `true|false`；非法值在工作区解析和数据库查询之前返回 `INVALID_REQUEST`，避免静默变成错误筛选。新增 API 回归 3/3 通过。
- 补上商品知识列表 handler 缺失的 `catch`，修复导致 19 个 API/MCP 测试套件无法加载的语法阻断；完整定点复验这些原失败套件。
- Ops 侧栏按当前工作台可达性过滤 workspace-only capability；已验收 `/ops/users` 403 恢复到可达总览的场景，其它 workspace/platform 路由契约仍需逐条确认。
- 商品搜索 SQL 路径补齐分类与图片文本，任务搜索补齐平台账号 ID，以匹配 service fallback；OpenAPI 为商品/任务列表补齐 401，MCP `task.history` 补上任务状态 enum。
- 视频结果在同步完成和异步查询路径统一规范化顶层 `asset_id`、`archive_state`、`scan_status` 与归档下载路径；未扫描结果明确标记为演示/待处理。展示门禁依赖 `scanStatus=clean` 元数据，真实下载端点仍执行授权/生命周期校验；历史扫描元数据不一致时可能出现 UI 可下载提示与端点拒绝，列为低风险语义依赖。
- 素材回收站预览支持 Escape 关闭并将焦点返回触发控件；隔离 Ops spec 的权限范围文案更新为当前页面文本。
- 默认 PostgreSQL 测试 pending 清单增加新合同租户 RLS 用例；CI 文件分母新增两个 RLS 回归文件。

## 页面与交互覆盖矩阵

矩阵记录的是本轮实际走查/自动化验证到的表面及其边界，不把源码存在、路由可配置或 mock 测试计作真实运行覆盖。按钮与表单项以所在页面的实际旅程列示；这不是“每个可见控件均已在生产逐一点击”的声明。

| 应用/页面 | 本轮核对的导航、控件和数据面 | 证据状态 | 未覆盖/已知缺口 |
|---|---|---|---|
| ChatGPT 本地插件入口 / MCP 工具 | stdio initialize、tools/list、调用桥接、身份绑定、权限拒绝；视觉生成和视频请求的拒绝路径 | 本地 production profile 已 personal 安装；安装桥接验证器 `ok=true`，核验 installed/source 文件 69/69、工具 134/134、缺配置 fail-closed | 当前既有 ChatGPT 会话是否刷新未验；缺少真实角色授权及付费 provider 成片证据 |
| 商家概览 | 待办指标、低库存/缺主图跳转、通知/风险提示、导航 | 浏览器风险目的地测试；生产只读检查概览 | 生产只读不能证明每种角色/待办组合；无逐项生产按钮写入验证 |
| 商家登录 / 首次工作区 | 登录错误/会话失效组件、首次建工作区合同、公开登录空提交 | 登录与建工作区的组件/API合同回归 | 多工作区选择仅显示 workspace ID；桌面切换、失败提示、会话重进和真实身份链路未验 |
| 插件连接 / 授权回跳 | pairing workspace 与 installation key 一致性、同源校验、session 网络错误重试 | 定向连接合同与错误恢复测试 | ChatGPT 宿主真实授权回跳、会话刷新和宿主中的 stdio 调用未验 |
| 商品目录 | 搜索框、关键词大小写/空格、添加日期筛选、无结果/空店、重置、排序、分页、店铺与商品深链、跨平台同账号切店 | fixture Playwright 搜索筛选 1/1；商品数据单测 21/21；新增同账号跨平台点击 1/1、未来日期过滤 1/1 | 商品详情所有编辑控件和生产搜索组合未逐项验证；目录 API 错误状态没有页内重试入口；完整商家浏览器矩阵仍有边界 |
| 商品详情 / 商品知识 | 商品与素材绑定、资料审核、revision CAS、租户/角色拒绝、审计、待索引状态 | 商品知识 e2e 1/1；模块单测 19/19；本地 MCP 工具合同 | 不能证明生产工作区实际数据或索引 worker 的端到端状态；高风险写操作未对生产执行 |
| 商家成员 | 页面路由、工作区成员读写、邀请、角色调整、停用、并发签发 MCP token | 隔离浏览器实际登录后完成邀请、角色调整、停用；4 个并发 MCP token 签发均为 200，browserErrors=[] | 不覆盖跨工作区越权和邀请邮件交付；A→B→A 浏览器验证被登录/AntD selector harness 阻断，未验证 |
| 商家任务 / 内容 | 任务列表、搜索、状态/平台筛选、任务详情和生成/审核路径 | `/v1/tasks` 非法筛选返回 400，OpenAPI 与定向 API 契约覆盖 | 商家 UI 每个状态的按钮、生成任务成功和付费模型链路未全部浏览器验收 |
| 商家内容编辑 / 审核 / 活动 | 草稿与内容版本合同、审核状态边界、campaign 发布清单 | 任务终态与恢复合同、内容编辑/审核组件合同 | 逐状态 UI 操作、真实生成与审核、campaign 后端发布闭环未验 |
| 商家发布 | 发布页导航、渠道/任务状态显示与发布流程入口 | 路由登记与发布 API/OpenAPI 合同核对 | 真实渠道授权、发布确认、回调/线上状态及每个按钮未在生产验证 |
| 商家发布历史 / 内容导出 | publish_job_id 深链与不可达提示、bundle/Markdown 导出桥接和内容卡片合同 | 隔离浏览器深链 2/2；导出/bridge 定向合同测试 | 真实租户授权下历史刷新、宿主附件下载和真实渠道发布回调未验 |
| 商家财务 / 用量趋势 | 日期草稿、查询应用、重置；套餐权益单位及数据格式 | 状态测试 3/3；财务/导航定向测试在验证清单中 | 生产存在“实际消耗”正数语义疑问；未核实账本权威口径，也未改生产账本 |
| 素材库 / 预览 / 回收站 | 预览打开与关闭、Escape 与焦点返回；下载授权；恢复/删除部分冲突、准确确认词、撤销清理和弹层焦点陷阱 | 扩展后的回收站 Playwright 1/1；预览 Escape/焦点专测 4/4；资产下载隔离 PostgreSQL 1/1；回收站状态单测各 3/3 | 浏览器中的 `/api/mcp` 轮询在隔离 fixture 返回 404；本测试没有验证插件在线。对象存储仍是 mock |
| 品牌资产 / 上传 | Logo 上传拒绝、错误状态、同一文件重选重试与成功引用状态 | 本地 mock 浏览器重试专测 1/1，已接入素材浏览器 runner | 未验证真实对象存储/扫描 worker；生产只读检查不能替代写路径验收 |
| 商家规则 / 类目 | 搜索规范化、平台类目过滤、结果数量、`/merchant/rules` 路由与字段模板标题 | 原规则搜索 3/3、category discovery 4/4；路由及 `product_id/platform/account_id` 上下文新合同测试 11/11 | `/merchant/rules` 在 `merchant-all.spec.js` 的 sidebar walk 中不直达；`merchant-isolated-screenshot-matrix.ts` 只截图该路由并检查标题/加载状态，不驱动规则搜索或编辑交互。新路由合同是单测，不是浏览器直达/刷新/后退验收。所有规则编辑/发布按钮未在真实商家租户逐项覆盖 |
| 商家全局搜索 | 从“全局搜索”旅程进入商品目录搜索框、填写关键词 | `merchant-all.spec.js` 检查搜索框存在并填入 `轻云`；独立商品目录浏览器回归另行验证目录搜索/筛选结果 | 该 `merchant-all.spec.js` “全局搜索”旅程仍未提交搜索或断言结果；独立 Chromium fixture 回归 `global-catalog-search.browser.spec.js` 已 1/1 验证目录匹配结果、空态及 `q` URL。它验证的是商品目录搜索，不替代旧 walk 的完整全局搜索旅程，也不证明生产 API 相关性 |
| 运营总览、用户、商家、规则 | 实际导航按钮、路由授权、拒绝恢复、用户目录账号归属筛选 | Ops 桌面只读矩阵 1/1；导航单测 13/13；拒绝恢复 3 文件 15 项；用户目录组件 20/20 | `test:browser:ops` 的 `ops-all.spec.js` 主 section walk 只经过总览、用户中心、客户交付 3 页；另有独立 Ops 桌面矩阵检查总览、用户、店铺、规则、财务、客户交付、存储、审计、Models 等指定目的地，二者都不是逐控件矩阵。用户目录默认仅商家账号；缺少 `identity.read` 时请求 guard 生效，搜索、状态/归属筛选、查询、刷新控件均禁用。隔离浏览器已验证查询后表格出现平台账号；无权限 UI 状态尚未浏览器覆盖 |
| 运营 Members / Tasks / Knowledge（workspace 域） | 页面与授权代码存在于 registry/domain，但当前 Ops Console 固定运行 platform workbench | 当前平台工作台无法进入这些 workspace 页面；页面/组件测试不构成用户可达证据。见后文“按用户当前可达页面”矩阵。 |
| 运营店铺 / 品牌树 / 店铺目录 | 源码核对品牌创建、品牌店铺绑定、店铺任务深链、别名编辑、撤销确认、人工登记、目录刷新/错误状态、聚合计数；确认撤销仅由单一确认弹窗触发一次回调（不重复审已修双确认） | 已有 StoreDirectory 组件测试、人工登记边界结果浏览器回归 1/1、撤销确认浏览器回归，以及店铺深链浏览器回归 3/3；本次只读补查 StoreDirectorySection、BrandTreeSection、StoresPage 和 MCP 绑定处理器，没有新增可确认缺陷 | 店铺目录无独立关键词/状态筛选控件；品牌树全量呈现且没有搜索/分页控件，目前未证实为数据丢失或错误筛选。尚无覆盖所有品牌创建/绑定失败态、刷新失败时保留目录数据、别名 revision 冲突及撤销真实后端审计的端到端浏览器矩阵；聚合平台列表与租户店铺明细是不同呈现，不应互相套用数量语义 |
| 运营财务、交付、存储、审计 | 次级导航权限过滤、路由页面数据展示和 Models 退役状态 | 独立 Ops 桌面只读矩阵检查指定路由；导航 13/13 | `ops-all.spec.js` 主 walk 不覆盖这些页面；单独的桌面矩阵只验证其列出的目的地、页面标题/加载状态和少数明确断言，不代表每张表格每行操作均完整遍历。生产授权用户页面不可用 |
| 运营客服工单 | 新建、分配、状态变更、添加备注写操作权限 | 权限定向组件测试 2 个文件 8/8 | 无独立浏览器/真实 API 角色矩阵；服务端仍是最终授权边界 |
| 商家客服支持 | 新建工单空白校验、详情返回队列路径 | 返回队列组件测试 6/6；状态表单目标/原因取消重开重置浏览器回归 1/1；跨工单切换清理弹窗/表单浏览器回归 1/1 | 新建表单 fixture 未挂载；真实角色授权、持久化、幂等和队列筛选恢复未验 |
| 运营模型矩阵 | 文本/图片/图片编辑等模型通道数据字段映射 | API 返回独立 `image_edit_model`；矩阵组件/契约测试已更新；Ops Console 全量 TypeScript 检查通过 | 真实中转鉴权、用量、成本和故障证据仍受生产证据阻断 |
| 运营公共规则详情 | 异常内容边界、快速切换详情时的请求竞态 | 异常内容边界与详情竞态浏览器用例通过；Ops Console 全量 TypeScript 检查通过 | 未覆盖真实运营用户、多租户生产数据下的规则批准/发布 |
| API / 搜索、任务筛选 | 商品搜索布尔参数、任务 `state`/`platform` 参数校验、OpenAPI 合同 | 更新后的商品/任务 HTTP 定向测试 12/12；repository 搜索测试 14/14；OpenAPI 合同 6/6；`/v1/products` 与 `/v1/tasks` 文档补充 401 | 其他 query 参数与所有 API 过滤组合未穷举；本矩阵不声称全 API 参数穷举 |
| API / 商品筛选 | `facts_confirmed` 和 `platform` 参数白名单及早期拒绝 | API agent 报告商品列表定向文件 10/10 | 搜索全组合及真实生产数据分布未穷举 |
| 图像/视频任务 | 商品图工作流参考、视频规划约束、stdio permission denial | 安装契约 1/1；新视觉权限拒绝 e2e 1/1（共享记录） | 权限拒绝测试证明 fixture 下 fail-closed，不证明授权成功生成；无 provider、扣费、任务轮询成功或归档证据 |

### 插件图像与视频技能调研结论

插件源中增加了 `references/product-image-workflow.md`，并列入本地打包工具的 required 拷贝清单；它是根据公开仓库 README 撰写的本地适配参考，不是复制或安装上游 Skill/执行器。内容将商品身份锁定、买家决策顺序、渠道规则来源/版本、真实性检查写成工作流指导。主技能补充跨镜头一致性、镜头衔接和声音方案约束。现有 `ecommerce-video-marketing` 技能继续承接脚本/分镜方法。production profile `0.1.0+codex.20261010011930` 已安装启用；基于 commit `40f22acd` 的 bridge verifier 对 tar/source provenance 为 `checked_files=85`，已安装 runtime source/install 为 `69/69`，工具为 `134/134`，缺配置调用 fail-closed 为 `MCP_CONFIGURATION_REQUIRED`。安装缓存排除 `.agents/plugins/marketplace.json` 是预期。当前 ChatGPT 会话刷新仍未验证。这里增强的是内容指导，不是增加图像/视频 renderer、模型或真实生成能力；provider 成功、用量/成本与成片归档仍未实测。

这属于提示/工作流能力增强，并未新增图像或视频模型本身。没有把第三方 CLI/provider/API、密钥或绕过业务中转的生成链路装进插件；真实生成仍必须走 Store Nova MCP、鉴权、角色权限、成本/用量、扫描和归档链路。权限拒绝 e2e 1/1 只证明拒绝时没有回退调用，不能当作生成成功证据。

## 发现

| 优先级 | 发现 | 证据与处理 |
|---|---|---|
| 高 | 商家生产商品区可见 Demo/QA 名称记录，另有零库存、零规格、零价格记录。 | 线上登录态只读检查观察到，属于生产数据隔离/导入治理问题。未删除或更改数据；需核查来源并通过受审计的数据流程处置。 |
| 高 | 不能证明真实 ChatGPT 宿主下的图片生成与视频成片链路。 | MCP fixture/合同测试通过，但真实 provider 成功、任务查询、用量/成本、扫描和归档证据缺失。健康状态不能替代成片验收。 |
| 高 | 生产 capability 与 capacity 证据为 blocked。 | `https://yxsona.com/api/healthz` 与运营健康端点返回 HTTP 200、服务状态 ok；健康数据报告 `CAPABILITY_EVIDENCE_PATH`、`CAPACITY_REPORT_PATH` 无法读取。保存于 2026-10-09 01:48Z 的只读健康收据记录线上 `release-b92b954d`；03:46Z 的只读门禁健康收据记录 `release-c337ae2e`、relay 与五模态 setup/cost gate configured/ready。阶段收据仍标记 `formal_go=false`，capability/capacity 证据文件仍 blocked/unreadable；credentialed workflow、规范 Keychain 读取、扫描 canary、同任务视频归档和正式容量证据尚待验收。该健康收据采集时工作区 HEAD 为 `891b55ac`，不等于当时线上 SHA `c337ae2e`；当前工作区 HEAD 为后续本地提交，未部署，因此这些改动均不属于该生产版本。健康与 setup 字段不能证明鉴权业务调用、实际用量/成本或成片。 |
| 中 | 财务“实际消耗”为正值，而点数变动可能被理解为增加。 | 线上只读观察到正值与负数预留并存。未核实账本权威符号/列定义，未改动符号。 |
| 高 | 支付 checkout URI 仍需渠道绑定的运行证据。 | Ops 与商家客户端已拒绝 HTTP/userinfo；服务端 provider 与商业合同持久化已使用共享校验器，按所选渠道绑定 HTTPS/微信/支付宝 URI，并要求微信 `pr`、支付宝 `appId` 非空。provider 与 billing/commercial repository 的目标断言通过；subscription repository 最初的测试数据错误已修正，失败目标断言复验通过。由于选择性 `-t` 运行导致 safe runner pending-assertion gate 非零退出，这些不是完整文件套件或 release-gates 通过证据。生产 provider 返回值及桌面 OS 深链行为未验证，未执行真实支付写入。 |
| 中 | 目录未知数值被误显示为 0。 | 本轮将商品摘要数值转换收紧为只接受 number/string，避免 null/空值/boolean 被 JavaScript 数字转换误判为有效 0；真实 0 仍保留。目录数据单测文件 21/21 通过。 |
| 中 | 任务列表筛选非法值会静默形成空结果。 | `/v1/tasks` 对 `state` 与 `platform` 采用白名单校验，并在 OpenAPI 描述 400；任务列表白名单定向测试 6/6、商品/任务联合定向测试 9/9、更新后的 OpenAPI 合同 6/6。 |
| 中 | 模型渠道 ready 状态可能被误读为真实推理成功。 | API ready 反映模型/中转配置与 relay token quota 门禁，不执行各模态生成 canary。两个 Ops 表格已将“运行态 ready/可用”改为“配置与额度门禁/门禁通过”，并明确显示“真实生成尚未验证”及“未执行真实生成 canary”；新增 `ModelReadinessSemantics.regression.test.tsx` 2/2 通过，确保两处 UI 不再暗示真实模态生成已经可用。该文案修正不构成 provider 调用证据。 |
| 中 | 模型矩阵把图片编辑通道展示成普通图片模型。 | API 增加独立 `image_edit_model` 映射，前端按专属字段展示；Ops Console TypeScript 检查通过，目标矩阵测试已有 agent 通过记录。 |
| 中 | Incident 变更范围按 workspace-only 授权矩阵执行。 | workspace-only 授权要求创建/更新的受影响范围限定于 actor 当前 workspace；服务端已恢复拒绝跨 workspace ID，并校验 actor workspace ID 和受影响 ID 均存在于权威目录。平台 aggregate read 与单 workspace mutation 分离。新增 service/UI 回归尚待运行；Incident 页面代码仍未挂当前路由清单。 |
| 中 | 全仓默认 `npm test` 尚无一次性通过证据。 | 8 分片全量调用中，分片 3/8、5/8 完整通过；1、2、4、7、8 触及每分片 300 秒上限；分片 6 被当时的 handler 语法错误和 stale OpenAPI/pending 清单阻断。修复后，18 个原加载失败文件 101/101 通过；仅重跑失败/超时分组的 16 分片中，7、8、12、16 完整通过，9/10/15 的确定性问题已修复并针对性复验，1/2/4 仍触及运行预算。多个 5 秒单测在资源竞争下超时，相关文件提高预算单独验证通过。 |
| 中 | 仍有 6 个配置型 Playwright spec 未在命名 runner 中运行。 | 当前 `tests/browser-gate-entrypoints.test.ts` 的 `CONFIG_ONLY_BROWSER_SPECS` 清单为 6 个；历史 13 项记录已由当前入口覆盖账本更新。它们仍未运行，配置匹配不计作功能覆盖。 |
| 中 | Ops 仍有路由闭环与测试身份契约缺口。 | 新增权限过滤的财务/存储/审计次级入口，OpsSidebar 13 项测试通过；Models 明确退役。Ops 现为 platform-only，members/tasks/knowledge workspace-only 页面仍留在注册表但不能由 OpsShell 激活；Incidents 页面代码未挂载且不属于当前 domain。未接 runner 的 MCP browser spec 引用 workspace 场景，与当前拒绝行为冲突。Stores 品牌店铺的“打开任务”回调只在非 platform 分支出现，目标 tasks 会被守卫拒绝，仍需正确 workspace 身份复现；客服详情的“回到任务队列”死链已改回可达 `/ops/support`，保留 URL 编码的 task_id，组件测试 6/6。 |
| 中 | Ops 403 恢复按钮可能把无用户权限的角色送回同一拒绝页。 | 支持角色没有 `users` 权限；从旧链接进入 `/ops/users` 后，原按钮固定返回用户中心，形成循环。已修复为按授权投影和当前工作台可达性选择恢复路由，无可达目标时隐藏按钮。3 个测试文件、15 项通过，包含实际点击从 `/ops/users` 回到总览。 |
| 低 | `KnowledgeGovernanceSection.readState` 在全套高负载运行中有一项超过 5 秒。 | 独立复验文件 7/7 通过，目标用例耗时 551ms；当前没有产品回归证据。 |
| 中 | 品牌 Logo/文档上传的延迟响应会覆盖上传期间编辑的用户画像或品牌卖点。 | `MaterialBrandFields.uploadBrandAsset` 曾在 `await uploadAsset` 后合并启动时捕获的 `value`；现改为合并最新 draft。延迟上传浏览器回归 1/1 通过：上传等待时编辑全局用户画像，响应后内容保留。待上传列表现以唯一 ID 管理，并在超限时拒绝整批新增、显示未加入数量；其目标测试 3/3 通过。 |

## 验证

- 全仓 `npm run typecheck` 没有整条成功收据，`test:release-gates` 也未完整运行。首轮 typecheck 暴露两处 API 类型错误，修复后有以下定向 no-emit 检查收据：`npx tsc --noEmit --pretty false -p tsconfig.json` 完成且无诊断；root `tsconfig.json` 排除 Ops Console 和 demo，所以此项只覆盖后端/packages/scripts/tests 类型检查；`npx tsc --noEmit --pretty false -p apps/ops-console/tsconfig.json` 曾先发现 pointer null 防护问题，修复后 exit 0；`npx tsc --noEmit --pretty false -p demo/merchant-studio/tsconfig.json` exit 0。以上不能外推为全仓脚本或 release gates 完整通过，单项回归也只覆盖对应测试范围。
- 本轮新增/受影响定向回归首次执行结果为 18 个 test files：284 项通过、4 项失败，另有 1 个 suite transform error。复核归类为新测试自身的断言/mock/语法问题；随后仅重跑失败文件/目标用例，没有重复通过的 284 项。5 文件失败项复验中，Finance、MCP expected-scopes、Incident detail、billing repository 等目标断言通过；subscription repository 最初的失败用例把符合合同的 HTTPS URL 当成无效值，改为带凭据 HTTPS 后，目标断言也通过（1 passed、8 skipped）。但 `-t` 选择性运行使 safe runner 的 pending-assertion gate 因 103 项被跳过而以 exit 1 结束；因此这是目标断言通过的证据，不是完整文件套件或 release-gates 通过证据。worker `task.sku_split` 两项目标断言也通过，但 runner 同样因选择性跳过 121 项而未通过 gate。
- `npm run build:ops-console`、`npm run build:merchant-studio` 通过；商家构建仍有已知的大 chunk 提示。
- `npm run audit:ops-surface` 通过：187 个 contract methods、179 个前端字面引用、0 个未引用方法。
- `npm run test:plugin-import-contract`、`npm run test:merchant-studio-smoke` 通过；smoke 明确跳过生产写流程。
- MCP/视觉路由合同测试 4 个文件、9 项通过；商品财务格式和导航测试 3 个文件、24 项通过；镜像打包针对性安装测试通过。
- 商家风险跳转浏览器验收 3/3 通过；规则详情 UI 边界浏览器验收 2/2 通过；隔离运营公共规则 Markdown 上传验收 1/1 通过。
- 商家隔离演示的商品关系、图片任务及响应式 Playwright 共 18 项覆盖：14 项通过；其余 4 项首轮因 Vite 缺少 `VITE_API_BASE_URL=/api` 而失败，补齐本地环境后只复跑这 4 项，全部通过。浏览器没有触发真实图片生成 API。
- 新增商品目录搜索/筛选 Playwright 1/1 通过；实际验证 8 条 fixture 商品的关键词过滤、近 7 天条件、无结果与空店铺区分、重置及分页。商品列表数据总数缩小时页码 clamp 回归 2/2 通过。新增 runner 合同验证 `tests/browser-gate-entrypoints.test.ts` 历史批次 15/15、17/17；当前含发布历史入口的最终回归 20/20 通过。该验收使用隔离 PostgreSQL/Redis，未写业务数据或保存凭据，并确认伪造登录身份被忽略、刷新状态保持。
- Ops 桌面全 mock Playwright 14 项通过：canonical 状态 8/8、权限矩阵 5/5、脏表单历史导航 1/1。为避免用旧访问令牌伪造登录，这些浏览器 fixture 增加当前 cookie/password-session 标记；过期与键盘退出断言已对应到当前受控会话控件。
- Ops 路由可达性更新：`OpsSidebar.test.tsx` 13/13；新次级组只显示授权路由，保留主侧栏和 Models 退役状态。浏览器矩阵已改为点击非 Models 的实际导航按钮；隔离 PostgreSQL 上的真实桌面浏览器矩阵 1/1 通过，覆盖总览、用户、商家、规则、财务、交付、存储和审计，并确认 Models 不可见且无失败 API 请求。
- 商家财务趋势草稿/应用/重置状态测试 3/3 通过；商家风险通知与详情安全文案测试 14/14 通过；规则/类目搜索大小写和空格规范化测试 3/3 通过。
- 商品知识治理 e2e 1/1、知识模块单测 19/19 通过。覆盖租户/角色拒绝、商品与资产绑定、revision CAS、仍待索引状态及唯一 before/after 审计。
- OpenAPI/MCP 方法清单、默认 PostgreSQL pending、隔离入口、CI PostgreSQL 分母和 OpsSidebar 共 6 个文件 64/64 通过；`container-source-freshness` 和 bridge B package 两个原超时文件在 30 秒单测预算下 24/24 通过。
- 插件镜像完整性：source/marketplace 的运行 `bridge.mjs`、技能及商品图参考已同步；测试资产有独有和不同步文件。`tests/plugin-manifest.test.ts` 7/7、`apps/plugin/install-smoke.test.ts` 29/29 通过；本轮 bridge 错误合同 10/10 通过，含 `task.history` 分页非法值拒绝。较早快照的完整 bridge 用例曾通过 159/159；当前快照完整 bridge suite 未重跑成功，不把旧结果当作当前完整通过证据。
- 插件本地内容链 e2e 新运行 2 项中 1 项通过、1 项最初失败：知识未审核时 API 正确拒绝且没有调用 provider/产出内容，但 bridge 把具体的 `KNOWLEDGE_REVIEW_REQUIRED` 商家恢复提示泛化了。修复可见文本和结构化消息映射后定向用例 2/2 通过，错误码及阻断行为保留。
- 插件视觉工作流安装契约 1/1：检查源技能文件、required 拷贝清单和本地 stdio `tools/list` 的工具暴露。之后 production profile 已本机打包并安装，安装桥接验证器通过；未验证当前既有 ChatGPT 对话刷新，也未调用生成工具/provider。
- 隔离 PostgreSQL 资产下载授权验收 1/1、RLS 攻击矩阵 1/1 通过。
- `tests/ops-e2e-isolation.test.ts`、`tests/browser-gate-entrypoints.test.ts`、`tests/quality-entrypoints.test.ts` 共 84 项通过；pending 白名单与入口合同针对性复验 41/41 通过。隔离 PostgreSQL 资产下载和点数并发撤销用例 2/2 通过。
- 运营台全套运行有 163 个文件、1094 项通过及一项 5 秒超时；该超时文件随后独立复验 7/7 通过。
- `tests/ecs-demo-component-update.test.ts` 单文件 39/39 通过；该文件不在当前并行 release-gates 测试命令里。
- 回收站失败保留确认状态逻辑及空态读屏状态：各 3/3 定向测试通过；HTTP 商品搜索无效 boolean 契约 3/3；账户标签 Playwright 1/1。入口合同测试历史批次分别通过 15/15、17/17；较早新增 merchant-members 入口后的批次 19/19 通过；之后修正调度归属的当前最终批次 20/20 通过（见上文）。
- 公网未登录运营与商家登录页可见，空提交显示必填错误，无浏览器控制台错误。商家生产登录态只读检查覆盖概览、商品搜索/详情、素材库、品牌资产、回收站及部分财务页；认证后的运营生产页面不在可用身份下验证。
- 本轮新增视觉权限拒绝本地 stdio e2e 1/1：图片生成与视频请求均保留 `PERMISSION_DENIED`，没有 fallback、重试、轮询或 provider 调用。此项是 fail-closed 证据，不是成功生成证据。视频 API 响应合同 9/9 通过，覆盖同步/异步字段一致性及 clean/unscanned 状态区分；插件 bridge 视频提示合同定向 1/1 通过，验证 clean 才能展示“通过安全检查”、unscanned 保持未确认提示；MCP `task.history` enum 合同包含在 contracts 48/48 中。
- 本轮新增商家目录未知数值回归：`catalog-data.test.ts` 全文件 21/21 通过；HTTP 商品/任务列表定向测试 12/12，覆盖主 repository 与 service fallback；repository 搜索测试 14/14；新增 `/v1/products` 和 `/v1/tasks` 的 401 文档后，OpenAPI 合同文件 6/6 通过。
- 运营客服只读权限修复的组件测试 8/8 通过；API agent 报告新增商品平台筛选校验后定向 API 文件 10/10 通过。
- 未绑定图片候选标题缺失的 400/不触发素材访问、预算或持久化回归，`image-budget-dispatch.test.ts` 全文件 23/23 通过。视频技能已同步源与 marketplace 镜像。
- 本轮运营账号归属浏览器 spec 连续修正其测试契约：前序失败涉及等待窗口/默认过滤断言、遗漏点击“查询”、按钮可访问名称中的空格和统计文案。最终隔离 PostgreSQL 浏览器复验 1/1 通过：默认商家列表排除运营账号；切换并查询后表格含运营账号，详情显示平台归属且不显示商家套餐；`unexpected=0`、`flaky=0`。证据：`artifacts/ops-jit-isolation/2026-10-09T08-48-52.919Z-6f770bf6-11eb-4fc0-8a8c-35fa5406ab29/playwright.json`。每次 runner 均确认自有临时容器已停止，`leftRunning=[]` 且未触碰外部容器。组件/model 已修复为商家账号默认，缺读取权限时请求层 fail-closed 且输入/筛选/查询/刷新控件禁用；组件测试 20/20 通过。无权限 UI 状态尚未浏览器覆盖。

## 未验证边界

- 验收范围采用本地 stdio 插件链路；不要求公开/团队插件市场、ChatGPT OAuth 或签名。当前本地安装包在 ChatGPT 中的实际 stdio 调用仍缺验收记录。
- 未发起真实付费中转图片/视频请求，没有声称生成成片、成本扣费或生产归档成功。
- 2026-10-09 03:46Z 公网健康收据显示 relay/setup 与成本门禁 ready，但阶段记录仍无 formal Go；工作区当前改动未发布到生产（生产 release SHA `c337ae2e` 与当前 HEAD `891b55ac` 不同）。
- 全仓默认 `npm test` 未在一次调用内完整验证。当前工作树没有完整 `test:release-gates` 通过收据；未纳入 browser runner 的其余配置型 Playwright spec 尚未逐项完整重跑/接入。需要独立角色账号或写入 fixture 的用例仍不能安全连生产。
- 较早的工作树快照有过 `SAFE_TEST_TIMEOUT_MS=900000 npm run test:release-gates` 通过收据（runtime 前置 23/23、PG16 migration 1/1、181 个测试文件通过、7 个声明跳过文件、1532 项断言通过、16 项登记 pending、Node gates 168/168）。它不覆盖本轮之后的改动，不能作为当前最终工作树的完整 release gate 证明。测试全绿也不等于可以部署：本地工作区尚未冻结候选身份/manifest；101 报告中的运行 SHA `c337ae2e` 与本地 HEAD 不同，`release_approved=false`、`formal_production_approved=false`。能力/容量证据路径不可读，embedding 未就绪，五模态真实 provider 用量/成本回执缺失；因此当前候选尚未发布，未执行生产部署。本轮插件 candidate tar 仍需在提交并冻结候选后重新生成。

登录页截图位于 [`artifacts/qa-evidence/gstack-full-review-2026-10-09/`](../../artifacts/qa-evidence/gstack-full-review-2026-10-09/)。隔离 PostgreSQL 与运营浏览器结果在 `artifacts/isolated-postgres/`、`artifacts/ops-jit-isolation/`。四个临时 worktree 已审计：资产下载、规则上传、规则详情 UI 补丁已整合；只更新迁移尾断言至 269 的 worker 补丁已过时，因为当前迁移链已更后。临时 worktree 已移除，主工作目录为唯一 worktree。

此前快照增量复验曾通过客服建单失败保留表单、Ops search/race/filter/rule、video settlement、MCP contracts、bridge 错误合同、定向商家 session/task/product/publish 和生产构建。它们不是当前 dirty candidate 的整体验收收据。视频响应现仅在 clean scan 返回 `download_path`。商家成员隔离 E2E 已通过邀请、角色调整、停用与并发 token 签发；结果见本轮增量记录。

### 本轮新增发现与修复

- 素材回收站浏览器旅程扩展到部分恢复冲突、彻底删除的原因/准确确认文本、部分清理冲突保留选择，以及撤销清理请求；Playwright 1/1 通过。隔离页面同时向缺失的本地 `/api/mcp` 轮询地址发出 404，因此该次测试不能记作零控制台错误或插件在线验收；两个 409 是明确模拟的服务端冲突。
- 发布历史在刷新后总数缩小时修正到有效页，独立本地浏览器回归 1/1 通过；已为其增加 `test:browser:merchant:publish-history` 并接入 `test:browser:all`，browser-entrypoint ledger 单测 20/20 通过。
- 插件回跳采用已验证 pairing workspace，并校验当前选择及 installation key 一致；session probe 遇网络错误时出现可重试错误状态。针对性测试：插件连接 11/11，登录/会话错误展示 6/6。
- Merchant Studio 商品店铺筛选改用 `platform + account_id` 复合值，避免不同平台同一远端账号 ID 串店；服务端和 SQL 搜索新增平台 slug 与中文平台名匹配。平台 slug/中文名搜索有独立 API/repository 定向回归；搜索专项测试明细见验证段，未在生产数据上穷举组合。
- 后续定点修复：商品目录与幂等键按 `platform + account_id` 隔离（3/3）；规则深链保留商品/平台/店铺 query 上下文，入口测试 11/11；未知扫描/远端发布状态 fail-closed（回归各 1/1，更新后的 asset status 文件 6/6）；财务新查询使旧结果过期且禁用旧导出（浏览器 1/1）；Ops 阻断路由恢复到可达域（2/2）；Merchant Studio fetch 与流式响应均校验 workspace revision（1/1）；OAuth popup 用户点击期间先同步打开并安全隔离窗口（1/1）。这些是定点证据，不代表整页/真实生产闭环验收。
- 商品目录详情媒体此前展示同一购物袋占位、伪造图片槽和无源视频播放按钮。已改为使用 API 图片或显示“暂无商品媒体”，移除伪视频播放入口；新回归 3/3。图片真实有效性、卡片列表图片展示以及本轮后续媒体安全修正仍须以最终定点测试结果为准，不能推导为生成能力已验收。
- Storage reconciliation 的 fail-closed 回归文件已单独复验 5/5 通过；它只证明所列组件边界，不替代运行环境或数据库验收。
- Ops JIT 目标清除浏览器用例未到达清除断言（两次旧组件旅程及新 model 旅程均停在 JIT 读取定位）；实现有变更，但浏览器目标清除与真实后端撤销目标快照仍未验证。客服 workspace response 测试仅覆盖 mock hook 行为，不能证明真实鉴权、持久化或服务端幂等。
- 发布历史的 `publish_job_id` 深链现在通过现有 workspace/brand 授权的 `GET /v1/publish-jobs/{id}` 按 ID 读取，不受最近 20 条列表分页限制；若目标不可达则明确提示目标任务读取失败，并提供返回普通历史列表的入口，不会静默显示首页。新增隔离浏览器深链回归 2/2 通过，分别验证远页目标加载和不可达目标提示；runner 显式注入本地 mock workspace。此证据不证明真实生产身份/租户可见性。
- Postgres 商品/任务的通用 query、storeName、brandName LIKE 搜索现在把 `%`、`_`、反斜杠和 `!` 当作字面字符；店铺/品牌过滤值先 trim，brandName 同时匹配商品属性与 workspace canonical brand profile，以对齐 service fallback。新增特殊字符组合 4 项、过滤语义 SQL 6/6、Service fallback 2/2 通过；通用 LIKE 与商品编码此前 9 项通过。query 纯空格输入的 durable/fallback 一致性目标测试 11/11 已通过（service + persistence 两文件）；repository SQL 使用 RecordingClient 验证，未在真实 PostgreSQL 执行。
- 品牌素材上传响应按最新草稿合并字段，延迟上传完成时不再覆盖同时编辑的用户画像。延迟浏览器回归 1/1 通过。
- Ops 规则审计包切换和 workspace A→B 时以请求序号隔离旧 RPC 响应；企业目录提交查询后重置分页、审计过滤立即取消旧列表/详情/导出请求并清空旧状态。延迟 RPC/浏览器回归 2 文件 4 项通过，覆盖旧 list 和 export 的迟到响应。
- Finance 搜索字段由误导的“企业名称或 Workspace”改为真实支持的 Workspace ID，并为分隔符解析增加测试。客服创建失败状态留在弹窗、保留输入，并在失败重试中复用同一幂等键；创建期间禁关闭，创建成功后的刷新失败不再误报为创建失败。修正隔离浏览器 harness 后目标回归 1/1 通过；仍是内存模型 fixture，不证明真实 API/权限/数据库幂等。规则激活校验 rejection 被安全处理、纯空白理由被拒绝；Rule browser 测试 2/2 通过。**此前**退款确认前 single-flight 保护的定向测试 2/2 通过；这不覆盖当前新增的平台退款入口权限/文案改动。SLA 刷新/失败会标明旧快照并禁用 correction；切换 workspace 时隐藏上一工作区报告指标、周期和 checksum，并提示旧快照已隐藏，跨工作区 correction 被阻断；组件/SSR与源契约定向测试 8/8。真实 workspace 并发请求仍未后端 E2E 验证。工单列表的 scanTruncated 提示透传和队列测试 4/4；真实 API 扫描上限与跨页完整性仍未端到端验证。
- Merchant Studio 任务详情状态守卫复用共享 `TASK_STATES`，并只在 UI 显示/处理层保留旧 `content_generated` 防御分支；DB CHECK、共享 canonical enum 与 MCP `task.history` enum 均不含该旧状态，未查询真实生产数据库，不能断言历史数据中绝无该值。阻塞状态显示事实确认进度，列表总数缩小时修正页码。当前 MCP/API 合同中未发现任务取消端点，因此不能执行或声称任务取消；`failed_terminal` 重试语义也未确认。插件 bridge `task.history` schema 已与 `TASK_STATES` 完全同步，source/mirror parity 以及 159 项 bridge 测试通过。应用 service 内仍保留较窄 TaskState 类型，暂未统一。
- 发布历史若 `state=reconciling` 但 `remoteState=published`，现同时展示“平台已发布”和“任务对账未结案”，阻止重复提交；组件测试 1/1。发布成功后跳回任务队列并携带 `publish_job_id`，该深链现按 ID 加载目标任务；不可达时显示明确错误并可清除深链回到历史列表。针对新增深链行为的隔离浏览器测试使用本地 mock，不是生产写入或真实 API 授权验收。
- 尚未修复/验收的确定/高可信缺口：Ops 页面注册与访问控制复核：`members/tasks/knowledge` 属于 workspace workbench，当前平台工作台明确拒绝进入；`models` 和 Incidents 在测试中明确标为隐藏/退役。它们不是当前控制台的失效按钮；是否重新开放需要产品定义工作台边界。Stores 品牌树的“查看店铺任务”只在 workspace scope 渲染，而当前 Stores 路由为 platform scope，因此它不是生产页面可见按钮。未发现这些路径上有已展示按钮点击无响应的证据。Merchant Studio 品牌/规则保存取消、店铺连接、素材上传目标切换等仍缺完整的多店浏览器旅程。文件待上传使用独立 ID、超限整批拒绝并显示未加入数量，3/3；上传期间禁止关闭弹窗；卸载时 abort 上传并阻断迟到响应污染，同时释放 preview URL，上传目标回归 7/7；预览生成失败不会把服务端已确认上传误报成失败。仍存在响应不确定性：超时/卸载后的 AbortError 不证明服务端未持久化；当前界面可能报失败并保留待传文件，重试依赖内容哈希去重，非可信素材可能重新扫描/修订。未验证“服务端提交后断开响应”，需通过资产列表/状态回查确认。实际上传路由/代理有效文件大小限制待核验，不在 UI 猜阈值；商品页码 clamp 2/2；退款 single-flight 2/2；合同外链打开前复用 HTTPS validator，违规 userinfo/hash/non-default-port 不会调用 window.open，定向测试 1/1；该外链 UI guard 比 MCP 下载入口多拒绝 `%5c` 与 Unicode Cf，服务端入口另有 DNS/IP/TLS 防护；两处语法 guard 不完全一致，未证明为绕过，安全边界以服务端校验为准。Ops 充值链接 HTTP/userinfo 验证修复已覆盖基础目标测试 20/20；入口合同的最新运行证据需继续核对。商家成员邀请/角色/停用隔离旅程现已通过，跨工作区 selector 浏览器旅程仍在补验。
- 评审覆盖盘点确认 `test:browser:all` 是明确命名的页面子集，不是逐个点击全项目每个按钮。当前 entrypoint 配置列出 6 个 config-only spec；它们未被 browser script 调度，本轮没有将它们记为已运行。coverage ledger 现会解析根目录 `test:browser*` 脚本中的直接 spec 路径，先前 3 个 Merchant Studio unscheduled 标记已清理；脚本登记不代表 spec 已运行。尚欠的高风险浏览器旅程包括任务创建到审核/发布、品牌/规则保存与取消、财务退款决策成功路径、真实角色下客服分配/关闭、退款双人审批结算/积分回滚成功路径、知识导入/审核成功、真实店铺授权 callback、租户 A→B→A、本地 ChatGPT stdio 宿主调用与真实模型用量/成本/扫描归档。
- 电商技能调研参考公开 README 中的做图/视频 workflow；方法按当前 Store Nova 工作流整理进插件指导，没有新增独立业务入口。早先 `0.1.0+codex.20261009140000` QA 包收据已被后续生产包替代，详见下方增量记录。没有把外部 provider 或脚本作为插件依赖，也未声称外部 Skill 已通过本项目实测。

### 增量评审与验证状态

以下记录了已审计候选相对基线的实现变化及逐项验证状态。只有明确写有通过收据的目标回归计为通过；未通过、未完成或无收据的项目仍标为未验收。增量工作避免重跑已有通过文件，不能将局部 fixture 收据外推为真实生产/全页面验收：

- 商品详情和卡片改为读取 API 图片、只接受无凭据 HTTPS URL、错误图片显示不可用状态；数据注释不再暗示远端图片已验证。新增媒体源码接线回归当前候选 3/3 通过，不代表实际渲染或远端图片可用性验收。
- Ops 退款入口文案现标注“仅限平台管理员、运营管理员、平台运营或财务运营角色”；Finance 页面仅在授权投影包含 `billing.refund.execute` 时渲染退款操作区，退款表单在平台身份无该 grant 时禁用。当前候选 `RefundSection` 组件测试 3/3 通过；页面 capability gate 测试和真实服务端角色矩阵仍待验收。此前 single-flight 测试 2/2 不覆盖这些权限用例。新增退款表单浏览器回归覆盖纯空白订单 ID 与退款原因在回调前被阻断，以及“ x ”经 trim 后“x”可通过前端必填校验，内存 callback 收到 trim 后的订单 ID/原因；最终新文件定向运行 3/3 通过，未调用真实财务写接口。首版自定义 validator 曾同时保留 required 规则，导致纯空白原因出现重复错误提示；已移除重复规则，并按服务端 `billing.refund` 的 `required()` 只校验 trim 后非空调整原因 validator，不再增加服务端没有的 min/max 长度门槛。服务端契约、真实 MCP 写路径和真实角色矩阵未因此获得新的运行环境验收证据。
- lean/manual_transfer 退款 UX 新增从既有公开 `/healthz` `data.payment.mode` 读取运行模式：manual_transfer 明确提示人工处理并禁用提交；fixture/unknown 也 fail-closed；provider 保持原确认/回调路径。新增浏览器回归最初因 manual 用例尝试填入禁用输入而 1/2 失败；按复核后修正为直接检查输入/按钮禁用和 callback 未调用，再定向运行一次通过 2/2（provider 可操作并触发内存 callback，manual_transfer 提示与禁用均成立）。测试未调用真实生产 `/healthz` 或账务写接口。
- 任务队列增加搜索/清除搜索；任务创建支持 `split_by_platform` 与 `split_by_sku`，向 `/v1/task-requests` 提交确认的 expected scopes（platform、product_id、sku_ids），服务端在写入前重新比较分析计划，范围变化时返回 409 且不创建任务；客户端再核对响应任务范围并标注不一致。上述 UI 搜索、平台/SKU 拆分、expected-scope API gate 与返回范围核对的定向测试通过；专用桌面 Playwright 5/5 通过，覆盖初始化输入锁定、两个拆分路径、真实任务 ID 搜索/分页清除及范围变更 409 阻断。浏览器入口契约测试 33/33 通过。此 fixture 不替代真实商家身份/数据库和付费模型链路验收。
- 新增复核发现 `/v1/task-requests` 创建多任务组时，原持久化路径可能在中途失败后留下不完整快照/outbox，且服务内存里残留任务及幂等记录。实现现已通过 `persistTaskGroup` 在同一 workspace transaction 写入任务快照与逐任务 `task.created` 事件，并覆盖 HTTP/MCP 写入；当前还按 split group 分配 source `task.sku_split` 序号、由 worker 对经过校验的 `task.sku_split` 审计投影安全 ack，避免重复副作用，并在回放遇到高版本 snapshot 时保留 durable 最新状态、修复缺失创建事件。持久化失败时新增 rollback 清除新建任务及对应幂等记录，replay 不回滚既有任务。故障注入回归 `task-group-persistence.test.ts` 2/2 通过；`task-group-persistence.regression.test.ts` 5/5、`task-request-expected-scopes.regression.test.ts` 目标断言通过；worker `task.sku_split` 目标断言 2/2 通过，但选择性 runner 因分别跳过 103/121 个断言触发 pending gate，不能记作完整 suite 通过。上述目标测试不能替代真实 PostgreSQL rollback/concurrency 故障注入。生产缺少事务能力仍 fail-closed。
- 单任务复核补齐：HTTP `POST /v1/tasks` 与 MCP `task.create`/`task.create.draft` 现统一使用 grouped persistence；HTTP 确定性幂等重放先重写快照并补 `task.created`，成功后才返回 200。事务写失败回滚新任务，replay 写失败保留旧任务。MerchantService 任务组逐项构造失败也会清理此前已建子任务，且失败前不绑定幂等键。新增单任务故障恢复与构造原子性目标测试合计 3/3 通过（`task-single-persistence.regression.test.ts` 2/2、`task-group-atomicity.test.ts` 1/1）；`git diff --check` 通过。测试对持久化 helper 做了事件失败注入，并以源码断言确认 HTTP replay/MCP create 入口调用 helper；没有直接驱动完整 MCP handler 的端到端故障注入。非生产、无事务 writer 的旧式 snapshot/event fallback 仍可能出现提交结果不确定；任一写入开始后保留内存任务以避免删除可能已落库的 snapshot。HTTP 同 key 重放可补事件；MCP `task.create`/`task.create.draft` 没有幂等键合同，非生产 fallback 的事件失败没有自动 replay 修复。生产保持事务 writer 缺失时 fail-closed；未运行完整 release gate 或真实 PostgreSQL 故障注入。
- Incident 的 `affectedWorkspaceIds` 是影响范围字段，但 mutation 的授权矩阵为 workspace-only；服务端现限定为 actor 当前 workspace，并验证 actor 与受影响 workspace ID 均存在于权威目录。平台 aggregate read 不授权跨 workspace mutation。目录不可用时 fail-closed。Ops UI 已拆分详情/时间线的 verified、错误与重试状态；详情未验证时阻断变更，时间线读取失败不再伪装成空记录。incident service、MCP incident handler、useIncidents 与 detail 目标回归已通过；详情文件在首次批次发现一条过期测试断言，修正后失败用例复验通过。只读角色评论为服务端支持的设计，不列为权限缺陷。
- Ops 用户目录“激活状态”的本地跨页排序已移除，避免把当前页排序伪装成全目录排序；当前 UI 不再提供该排序 affordance。组件文件本轮测试 21/21 通过，覆盖筛选、清空、翻页和选择状态；若产品需要排序，应由服务端分页查询支持后再恢复控件。
- Ops 客户交付档案“生效账号”搜索修复：关键词变化时立即清空旧查询的账号选项、所选账号、分页游标及查询错误，避免旧结果在新查询条件下仍可绑定。新增真实桌面浏览器回归 `CustomerDeliveryAccountBinding.search.browser.test.tsx` 1/1 通过，覆盖查询 alpha 并选中后改为 beta，旧选择、加载更多和确认关联入口均消失。没有重跑其它已通过交付页面测试；本回归使用浏览器 stub 列表 API，不代替真实运营身份/API权限或账号目录分页端到端验收。
- Ops 客户交付表格跨页序号原每页从 01 重启，与服务端分页展示的全局列表位置不符；现按 `(page - 1) * pageSize + 当前页行索引 + 1` 计算。新增独立桌面 Chromium 回归 `CustomerDeliverySection.pagination.browser.test.tsx` 1/1 通过：切至第 2 页后首行显示 21。只运行该新文件，没有重跑 Customer Delivery 旧绿套件；数据为浏览器 fixture，不代替真实 API 分页验收。
- Commercial timeline 定向修复：日期范围按浏览器本地日历日构造边界，修改日期时回到第一页；日期/关键词/状态过滤后空态可清除全部筛选。客户端原请求 `limit=200` 超出服务端上限（100）的问题已修正。MCP schema、API handler、Ops client/hook/UI 已串通 workspace 与 from/to/status 绑定的稳定 keyset cursor（同时间戳按 ID 排序），有 `next_cursor` 时可继续追加；服务端仍独立授权 workspace。新增 source 截断提示：合同源扫描最多 500 条；聚合中的 ledger、allocations、audits、service events 也有 500 条源上限，命中上限时显式标记 `source_truncated`。cursor 只能翻阅当前已收集集合，不能突破这些源上限；要看完整历史仍需后端各源提供可续读 cursor。定向回归仅运行本次新增/修改的 4 个文件：17/17 通过（API timeline、client pagination、timeline controls、contract cursor）；未重跑其它已绿套件，也未取得全量候选类型检查/release gate 或桌面真实 API 端到端收据。
- Ops Commercial 退款事件列表静默截断修复：退款仓储现在以 `(created_at,id)` 稳定倒序 keyset 分页，按目标 workspace 校验 opaque cursor，并返回 `total`、`next_cursor`、`truncated`；MCP schema/API handler 和 Ops client/hook/UI 已贯通 cursor 与“加载更多”，显示已加载/总事件数。新增仓储分页回归与 Ops client cursor 回归定向运行 9/9 通过。尚未对真实 PostgreSQL 退款事件数据、真实平台角色授权、桌面运营会话或生产数据做端到端验证；分页契约测试不能代替这些证据。
- Merchant Studio 创建任务后的 URL 与浏览器前进/后退同步旅程尚无浏览器收据。路由会保留未识别 query 参数，但未发现证据证明敏感一次性参数实际进入该路由；创建后短暂出现的 URL/query 状态也未被确认是否为产品预期或泄露。因此仅列为待验证的历史导航与临时状态确认项，不定性为漏洞或已确认 bug。
- Ops Stores 平台聚合 API 原只返回分组行数，导致页面把一组多家真实店铺按一行计入平台汇总与卡片总数。现由 `ops.stores.list` 每行显式传 `count`，平台统计按底层店铺数计算；Stores 卡片总数也累加代表店数，表格分页则明确标注“平台汇总组”数量，行标签继续展示实际代表店数。API 仍要求 `platform_scope=platform` 并调用 `requirePlatformReadRole`，返回的平台聚合只含平台、连接状态、数据模式、能力位和数量，不含 workspace/account 身份。新增 API 与 UI 两个独立回归，分别覆盖 N 店铺聚合 count、summary 按 N 统计以及响应/页面不泄露实际身份。新文件已通过 safe runner 启动且进程退出；当前 agent 未保留该嵌套执行会话的 stdout/exit code，故暂不将其计为通过，也未重跑。
- QA 插件 `merchant-marketing@merchant-local` 保持 disabled，身份仍为 `qa-broker` / `qa_only=true` / `release_eligible=false`。其后 production profile 升级为 `0.1.0+codex.20261010011930`；personal 插件路径 manifest 显示该版本且 CLI 显示启用。基于 commit `40f22acd` 的新版本 bridge verifier 通过，确认 provenance 85 项、source/install 69/69、tools/list 134 项及缺配置 fail-closed；当前既有 ChatGPT 会话刷新仍未验证，不声称宿主已加载新快照或新增 renderer。
- checkout provider 返回的 `payment_url` / `code_url` 已通过共享校验器验证 HTTPS authority、凭据、fragment、私有/本地地址及与所选渠道匹配的微信/支付宝 scheme、host、path；微信 `pr` 与支付宝 `appId` 必须非空。billing 与 commercial contract repository 的筛选定向回归通过；subscription repository 无效 URL 用例已改成带凭据 HTTPS，目标断言通过（1 passed、8 skipped）。选择性测试因 pending-assertion gate 非零退出，不算完整文件套件通过；生产支付写入未执行。
- Ops canonical 商品一致性详情和摘要都有 fail-closed 状态判断；本轮时间戳、revision、有效状态一致性检查对应组件测试分别 27/27 与 10/10 通过。真实 API 的完整性、权限和数据仍须运行环境验收。
- Storage 对账对未知或缺失 `runStatus` fail-closed，并明确标注 loading 时的旧快照；本轮对应组件回归 5/5 通过。
- Rules 类目选择与平台/查询/tab 过滤联动清理；商品/平台/店铺深链上下文最新定向测试通过，范围为已执行的组件/路由合同，不代表浏览器直达、刷新和后退全旅程验收。
- Merchant 商品目录 `q` 与 store（`platform/account_id`）筛选现在通过 URL replace 同步；三个“返回选择”按钮清除失效 scope。Rules 侧栏切换时清理旧 `target`。Canonical detail 与 summary 校验 report/evidence 时间戳、revision 和有效状态一致。Ops 用户目录补齐 `invited` 状态筛选，清筛/翻页时清除已选行。Storage loading 明确标注旧快照；Finance retry 复用最后提交的 query 并同步表单状态。上述项目中，Canonical detail/summary、Storage、用户目录和 Finance retry 的本轮定向目标用例已通过；商品目录/Rules 导航合同测试亦有定向通过收据。它们不等于完整页面浏览器旅程，未覆盖部分仍保留在页面矩阵中。
- Ops 品牌树进入任务队列的店铺筛选此前只在内存中设置；路由未包含范围，刷新后平台/店铺条件丢失。现在导航 URL 显式携带 `platform` 与 `accountId`；`TasksPage` 等待初始授权店铺目录加载后，只有当前 workspace session 与授权目录均匹配的店铺才恢复筛选。平台 scope、未知平台、缺任一参数或目录中不存在的账号不会成为店铺范围；不带新参数的旧 `/ops/tasks` 和 `task_id` 链接保留原行为。新增独立桌面 Chromium route regression `BrandStoreTasksDeepLink.browser.test.tsx` 单文件 3/3 通过：品牌树 helper 生成 URL、重新加载后恢复筛选，且 platform scope 和 workspace 目录外 account 均被拒绝。只运行新文件，没有重跑旧 OpsConsoleController suite；fixture 不替代真实 API/租户身份验收。
- 报告没有全项目所有可见按钮、链接和输入框逐项点击的统一真实浏览器矩阵。现有浏览器 runner 是按页面/旅程命名的覆盖子集；任务审核/发布、规则/品牌保存取消、财务退款成功、客服角色写路径、知识导入审核、真实授权 callback、租户切换及本地 ChatGPT 宿主调用仍需逐项补齐或记录为未覆盖，不以组件/source 合同测试替代。
- `deliverable.list` 品牌权限曾在 workspace 全量索引分页之后过滤，可能让授权品牌记录落到不可达页，且 `totalMatched` 暴露受限品牌命中数。现在 MCP handler 在查询前解析可访问品牌，service 在排序/游标分页及 totalMatched 前按品牌过滤；受限成员的游标校验范围包含授权品牌集合，权限集合变化时拒绝旧 cursor。新增只读 MCP handler 回归 `mcp-deliverable-brand-pagination.regression.test.ts` 1/1 通过：跨页可见记录无遗漏、totalMatched 仅计授权匹配、受限记录不返回、权限集合变化时旧 cursor 被拒绝。此测试使用内存 service fixture；未在真实 PostgreSQL 上验收。
- Ops 店铺撤销此前同时由 `StoreDirectorySection` 和 `useOpsConsoleModel.revokeStore` 弹确认，导致操作员必须确认两次。现保留组件唯一确认（危险操作焦点默认在取消），hook 仍执行 `store.connection.update` capability 检查并且只发一次 `platform.revoke` RPC；核查调用方后，只有 StoresPage 把该 hook 回调传给 StoreDirectorySection。独立浏览器回归 `StoreDirectorySection.revoke-confirmation.browser.test.tsx` 1/1 通过，实测一个确认对话框、确认点击次数 1、模拟 API revoke 请求次数 1；不代表真实服务端鉴权/审计链路已验收。
- 当前 worktree 还修改了 Ops finance、controller、support hook、MCP envelope/release manifest、browser/release entrypoint 和插件安装 smoke 等实现/测试。由于全量候选测试未完成，不把这些新改动写成已验收；只沿用明确标注为历史快照的旧收据。

### 本轮运行环境复核

- `https://yxsona.com/api/healthz` 与 `https://ops.yxsona.com/healthz` 本轮只读请求均返回 HTTP 200，API health 的 `status=ok`、`writesEnabled=false`、PostgreSQL/Redis ready；鉴权覆盖显示 387/387 方法受 enforce。text/image/image_edit/OCR/video 配置为 ready；embedding 未就绪（`knowledge_vector_indexing_disabled`、`model_missing`）。这些字段只证明健康与配置状态，不证明真实模型请求、用量/成本结算、视频成片或扫描归档工作流。本机 Docker daemon 可访问，但 `docker ps` 无运行容器，故未执行本地容器健康验收。
- 复核时 `.safe-tests.lock` 曾显示由 PID 39568 持有并实际运行 Vitest；该命令包含已有通过的 Storage、UserDirectory、incident-service/MCP-handler 测试文件，主 agent 已收到重复风险清单。期间无额外 safe test 由本审计 agent 启动。`git diff --check` 再次通过。
- 本轮本地 stdio → MCP/API 合同复核发现两项缺口：`initialize` 收到不支持的协议版本时错误地返回 `-32602`，已改为 MCP 版本协商规定的受支持版本 counter-offer；商家桥接的 `billing.recharge.list` 缺少服务端合同已有的 `cursor` 参数，无法分页，已补齐并同步 marketplace bridge。窄化的本地 stdio 回归覆盖初始化、工具发现和 source/marketplace 镜像一致性，1/1 通过，未触达 API 或业务写入。完整 `bridge.test.ts` 159 项中 157 项通过、2 项失败：失败分别是上述 `cursor` 缺失与 expected-scopes 修改后的 marketplace 镜像不一致，随后按修复直接覆盖的窄回归通过；没有重跑已通过的 157 项。真实 ChatGPT 宿主会话与生产 MCP/API 鉴权、五模态模型用量仍未由本机 fixture 证明。
- 图片编辑工具曾把模型中转原始图片直接回给 MCP 调用者，即使归档状态仍是 quarantine。现改为只在归档产物扫描 clean 后从工作区归档读回并返回；扫描未通过时 `images=[]`。新增门禁回归 2/2 通过，真实 scanner 与对象存储联调仍未验证；图像/视频真实生成和成本仍未触发。
- 视频渲染调用契约曾将 `idempotency_key` 描述为可选，但生产 API 要求传键；现更新 direct bridge 工具描述和商家技能，明确新渲染意图生成随机新键、同一请求重试复用原键、意图变更使用新键，并同步 marketplace 镜像。新增 `video-idempotency-contract.test.ts` 单文件 1/1 通过，检查 source/marketplace 描述与技能镜像及三项键语义。未将 schema 改为必填，因为 QA/test 环境允许省略；未调用真实视频 provider。
- Ops 客服详情“回到客服队列”链接原来附带客服页面不读取的 `task_id`；现改到 `/ops/support`。对应完整组件测试文件 6/6 通过。Incident 页面仍未注册到 OpsDomain/registry；当前 authorization contract 是 workspace scope，而 OpsShell 只启用 platform workbench，不能未经产品授权将其挂入该工作台。
- 平台客服聚合每个 workspace 原只读取首个有界页面并直接按状态/优先级汇总；当某 workspace 返回 `nextCursor`、但不属于 SLA 有界扫描时，先前没有设置 `scanTruncated`，会静默低报。现将任一 workspace 的 continuation cursor 纳入聚合 `scanTruncated`，既有队列告警将明确提示结果可能不完整、无法继续翻页时应缩小筛选；本修复没有声称精确总数，也没有将聚合分组伪装成可翻页工单。新增独立回归测试 1/1 通过，覆盖有后续页面时必须返回截断提示；真实 API/数据库跨页聚合仍未做端到端验证；此聚合能力属于 Ops UI/API：商家插件统一通过 `isMerchantTool` 拒绝 `ops.*` 工具，不能把 platform-only 工具加入商家插件面，也不能称插件 MCP 可请求。
- PlatformSupportWorkspace 平台工单翻页此前请求时清空当前列表/详情，失败后空白且没有返回按钮；状态列和详情状态显示英文原始 enum。现以成功页面缓存/cursor stack 保留页序，加载中继续展示当前页，失败显示错误并留在原页，支持上一页/下一页；列表及详情复用 `supportStatusLabels` 中文映射。独立 Chromium 回归覆盖第 1→2 页、失败时留在第 2 页、回退第 1 页并前进恢复第 2 页，以及列表/详情中文状态。第一次执行因 fixture 工单号与主题重复导致 locator strict-mode 失败；fixture 修正后一次执行因 10 秒导航等待预算未进入交互断言；将该 spec 导航超时调整为 60 秒后，仅重跑此新增文件一次，1/1 通过。未重跑已通过的 Support suites。该浏览器使用本地 stub API，不证明真实授权、API 或 PostgreSQL 行为。
- 交付档案账号搜索词变化时，旧账号选项、已选项与分页 cursor 在新查询期间仍可保留。实现已在 query 改变时清空旧结果和确认状态；真实桌面 Chromium 回归 1/1 通过，查询 alpha 并选中后改成 beta，旧选择、加载更多和确认关联入口均不可继续使用。浏览器 API 使用 stub，不替代真实运营身份/目录分页端到端验收。
- 页面覆盖复核确认没有统一逐控件浏览器矩阵：Merchant 顶层“规则与类目”未找到显式浏览器直达内容验收；`merchant-all.spec.js` 的全局搜索 walk 仍只填入/清空输入，不验证结果列表或空态。为补充该缺口，新增独立桌面浏览器回归 `demo/merchant-studio/global-catalog-search.browser.spec.js`，以 mock 登录、店铺与商品数据从店铺选择进入目录，验证匹配商品、无匹配空态和 `q` URL 状态；本地 Vite + Chromium 1/1 通过（命令：`MERCHANT_STUDIO_URL=http://127.0.0.1:18091 npm exec -- playwright test --config=demo/merchant-studio demo/merchant-studio/global-catalog-search.browser.spec.js --workers=1`）。该回归只覆盖目录搜索这条路径，不替代 `merchant-all.spec.js` 旧旅程，也不验证生产 API/商家身份。Ops `ops-all.spec.js` 主 walk 只覆盖总览、用户中心、客户交付 3 页；独立 Ops read-only matrix 点击 9 destinations，且不覆盖全部按钮/输入。`ops-mcp-request-matrix.spec.js` 的路由 scope/权限断言也不能替代页面控件验收。
- 插件本地 personal 更新现为 production profile `0.1.0+codex.20261010011930`；安装路径 manifest 与 CLI 均显示启用，QA `merchant-local` namespace 仍 disabled。基于 commit `40f22acd` 的新版本 bridge verifier 通过，tar/source provenance `checked_files=85`、已安装 runtime inventory source/install `69/69`、stdio `initialize`/`tools/list` `134/134`，缺配置 fail-closed 为 `MCP_CONFIGURATION_REQUIRED`；缓存不含 `.agents/plugins/marketplace.json` 是预期安装排除项。当前既有 ChatGPT 会话刷新尚未验证，不能声称宿主已加载新快照。
- 独立 bridge 审计发现 `asset.upload` 缺少 `file_path` 与 `content_base64` 时，边界 schema（`oneOf`）未在本地拒绝，随后 `prepareToolArguments` 异常被通用捕获为 `MCP_GATEWAY_ERROR`。现将缺失输入的判断放到参数边界，保留已有文件读取/互斥行为，并同步 marketplace mirror。新增窄回归对 source 与 marketplace bridge 各验证 `TOOL_ARGUMENTS_INVALID` 且 API 请求列表为空，2/2 通过；未重跑 bridge 旧套件，也未覆盖真实上传/扫描。
- 商品目录日期筛选原先在 MCP / HTTP、Postgres / 内存路径的校验和结果不一致：HTTP 未转发 date range，Postgres 会强转为 timestamptz，而 memory 使用字符串比较。现新增共享 RFC3339、必带时区、有效日历、毫秒精度及 from ≤ to 校验并统一转 UTC，HTTP 和 MCP 在查询前拒绝无效值并传给两种 repository；合同及两个 bridge schema 标 `date-time`。HTTP+MCP 两文件 35/35 通过，offset 边界新增用例 1/1 通过；不代表真实 Postgres 上的数据组合已穷举。
- 发现一次非计划 safe-runner 命令尝试重复运行 Storage/用户目录/Incident/支付/任务等已有绿文件。该进程由主 agent 中断，未采信其部分结果；后续只运行新改行为的定向用例。未取得完整 `test:release-gates` 收据。
- Ops 用户导出曾以 `rows.length === limit` 推断截断，会在匹配总数恰好等于上限时误报。现使用 `searchWindow.total` 的权威匹配总数；无 `searchWindow` 的兼容路径则从完整已筛选集合计数后再切片。新增窄回归 `mcp-ops-users-export-truncation.regression.test.ts` 2/2 通过，覆盖 CSV/JSON 恰好达到上限为 `truncated=false`，以及总数超过上限为 `true`；未重跑旧目录套件。`git diff --check` 通过。该合同不新增分页能力，也不代替生产 API 导出验收。
- Ops Stores 聚合计数回归的 fixture 类型化后，`apps/api/src/mcp-ops-stores-aggregate-count.regression.test.ts` 再次单文件运行 **1/1 通过**。此为针对该 fixture 的修正后收据，未扩大为 Stores 全页面或真实租户聚合数据验收。
- Support 新建工单表单曾让空格字符串通过必填校验，而 API 会先 `trim()` 再校验；现对主题、描述、客户 ID、客户名称在表单变更时先 trim，并对必填项启用空白拒绝，使主题的最小长度和服务端一致。新增独立 Playwright regression `SupportQueueSection.whitespace-validation.browser.test.tsx`，意图验证空白值不调用 create、带空格的合法输入以 trim 后值提交；当前未取得通过收据：首跑超过 Vitest 默认 5 秒，之后两次 fixture 未挂载 React root；按要求复制既有成功 harness 的浏览器错误/console/request/module-response 诊断后，最后一次在 `page.goto(... waitUntil: domcontentloaded)` 10 秒超时，未记录到组件模块响应、未进入表单断言。按 harness/导航阻断处理，不把测试计为通过，也不再重跑。既有 `SupportQueueSection` suite 未重跑。

### 页面与控件覆盖矩阵

下表按用户当前可达页面归纳真实桌面交互证据和主要未验收控件。现有 browser 命令运行的是命名旅程子集，没有全项目逐个按钮/输入框的统一矩阵；组件测试、源码合同和隔离 fixture 不记作真实业务服务验收。

| 页面/入口 | 已有交互证据 | 尚未充分验收的关键控件/路径 |
|---|---|---|
| Merchant Studio 总览 | 页面 walk 与桌面 route matrix；已隐藏的 overview 同步/完整性控件不再作为可操作功能宣称 | 总览刷新、同步与真实后台结果；隐藏控件不代表通过 |
| 商品目录 | 桌面 Chromium 新回归命中、空结果、`q` URL 状态 1/1；目录筛选/分页另有定向通过 | 多店切换后筛选/排序/分页；商品编辑到任务审核和发布闭环 |
| 品牌资产与规则 | `brand-scope-upload-race.browser.spec.js` 本轮新增两个桌面浏览器场景 2/2：延迟 Logo 跨店/切回不污染 scope 与草稿；切店后品牌读取挂起期间保存按钮禁用且不发 PUT；BrandTree 异步交错成功/失败/重试桌面浏览器回归既有 2/2 收据未重跑 | 多店取消后跨页保存、Logo/文档同一配置的完整生命周期、规则切换与保存完整浏览器旅程；真实 API/RLS/对象存储仍未在此 fixture 中验证 |
| 素材库与回收站 | 上传/回收站隔离旅程和迟到响应回归；扫描状态 fail-closed | 服务端已持久化但响应丢失的回查；真实对象存储、扫描归档和生成链路 |
| Merchant 财务 | 财务概况、退款输入校验等局部收据 | 退款决策/结算、积分回滚、真实账务接口与角色矩阵 |
| Ops 总览、用户与客户交付 | 主 walk 覆盖 3 页；桌面只读矩阵点击 9 个目的地；Customer Delivery 搜索 1/1（stub API） | 全部筛选/分页/导出按钮的逐项交互；真实客户目录授权/绑定/店铺授权 callback |
| Ops Stores、Rules、Storage、Audit | 平台连接摘要组件覆盖逐店汇总、聚合组计数、空/失败/保留旧可信快照；Overview 摘要组件覆盖累计/月度金额、真实零值与未读/失败未知态；别名校验 2/2；公共规则审核 mutation 期间平台筛选锁定及完成后按当前平台 reload 的浏览器回归 1/1（stub RPC） | 聚合组 `count` 新回归目前尚无可核验的 runner 退出收据；摘要组件测试不校验其与真实 API 数据/Stores 表格在同一身份、同一快照下的一致性。Stores 真实新增/修改；Rules 导入审核/取消真实 API；Storage 清理回收真实权限；Audit 搜索分页导出真实 API |
| Ops Finance 与 Commercial | 财务摘要/金额/未知与失败态由 Overview 和 FinanceSearchSection 组件测试覆盖；cursor “已展示/匹配总数/是否还有下一页”专测 2/2；退款表单新回归 3/3；timeline 与列表控制专项 | 当前证明为组件/fixture 数据渲染合同，未以真实桌面会话核对 summary 与跨页明细金额、记录数及筛选条件一致性；真实退款写入、双人审批/结算、跨源完整历史分页（各源仍有 500 条扫描边界） |
| Ops Support | 返回队列组件 6/6；聚合截断告警 1/1；空白必填修复已实现，但新浏览器 fixture 导航阻断、无通过收据 | 真实角色下分配/回复/关闭、跨 workspace 聚合分页及真实数据库全路径 |
| Ops Tasks、Knowledge、Members | 页面和授权能力存在于 workspace 域代码；当前 Ops Console 是 platform workbench，不能进入这些 workspace 页面 | 这些路径不属于当前平台工作台可操作页面；不能用静态组件测试声称用户可访问 |
| 本地插件/MCP | stdio 初始化/工具发现窄回归；asset.upload 缺参边界 2/2；bridge 历史快照 157/159，2 个已知失败已由新窄测覆盖 | 活动 personal 插件升级后，新 ChatGPT 会话的真实 stdio 工具调用、provider 成片/用量成本及扫描归档 |

Ops `models` 与 Incidents 当前在测试/路由中被隐藏或撤下；此处不把其旧页面代码计为坏按钮。`test:browser:ops` 明确调度的主 walk 只有总览、用户、客户交付三页；Ops read-only matrix 的 9 个目的地仅证明路由/只读到达，不等于每个表单控件都已操作。
- 内存密码认证适配器的注册审核现与 Postgres 对齐：批准前逐一解析选定 workspace 状态；缺少状态解析器、workspace 不存在或非 active 均返回 `AUTH_WORKSPACE_NOT_FOUND`，不会改变申请状态。新增独立 adapter regression `password-auth-memory-registration-workspace.regression.test.ts` 2/2 通过，覆盖未知、停用、有效 active workspace；未重跑旧 auth suites。
- User Directory 商户详情抽屉底部原来固定显示“停用”，并对第一条 membership 发起操作；当该关系已 suspended 或用户存在多个 workspace 时，按钮文案没有表达真实动作/目标。现按第一条实际目标关系动态生成“启用成员访问”或“停用成员访问”，并同时呈现成员名、企业名称、workspace ID 与当前成员状态，accessible name 也包含完整目标。新增独立回归 `UserDirectorySection.membership-action.regression.test.ts` 1/1 通过，验证首条关系 suspended 时为启用语义且目标精确命中 `workspace-1`；未重跑已通过的 `UserDirectorySection` 旧 suite。此收据验证目标上下文 helper，不代表真实后台写操作验收。
- Ops 开通账号的“绑定已存在的企业”选择器原只加载 `ops.workspaces.list` 首个 100 项并在浏览器本地过滤，无法选择后续工作区。该 API 已支持服务端 `query`、`offset`/`limit`，上限 100，并返回 `hasMore`（total 可缺省）；现弹窗要求先显式查询，查询成功后才显示结果，可继续翻页，按新查询隐藏旧选项，并展示查询错误/真实零结果，不推断总数。新增 `UserDirectorySection.provision-workspace-search.browser.test.tsx` mock 回归验证搜索 `第101家目标企业` 后服务端收到 `{status: active, merchantOnly: true, page: 1, pageSize: 100}`，可在 modal 中选中目标，且开户 payload 绑定 `workspace_ids: ["ws_workspace_101"]`、`create_workspace: false`。此前的导航超时和 AntD 隐藏 option/重复节点断言失败均由 harness/定位调整解决；后续单文件 safe-runner 收据为 **1/1 通过**（session 6534，33.23 秒），故以最终成功运行替代前序失败尝试，不重复运行。测试使用 mock API，不证明真实 Ops API 授权、目录搜索或开户写入；UserDirectory 旧 suite 未重跑。
- `ops.workspaces.list` 在 `listWorkspaceDirectory` adapter 不可用时走 summaries fallback；该分支原有搜索只匹配 workspace ID 与套餐名，漏掉已展示给用户的企业名称。现补上企业名称搜索，同时保留 ID/套餐匹配；新增独立 regression 2/2 通过，覆盖企业名称 query 命中与不命中。此修复及收据仅适用于无 `listWorkspaceDirectory` adapter 的 fallback，不替代目录 adapter 或完整 Workspace 页面验收。
- Merchant Studio 任务队列原先把 `canceled` 归为“可以继续”、把 `failed_terminal` 归为“需要我处理”并显示“恢复任务”。现从 `packages/domain/src/task.ts` 的 `taskTransitions` 推导 terminal states（包括 `delivered`、`failed_terminal`、`canceled`），队列标为“已结束”，操作文案改为“仅查看”；`failed_recoverable` 仍显示“恢复任务”。新增独立回归 `demo/merchant-studio/src/merchant-ia-task-terminal.regression.test.ts` 2/2 通过，覆盖取消/不可恢复失败不可继续、可恢复失败仍可恢复，以及终态与领域状态图对齐；没有重跑已通过的 `merchant-ia.test.ts`。
- 公共规则草稿审核/拒绝进行中曾允许切换平台筛选；mutation 完成后闭包 reload 可能按旧平台读回并覆盖当前过滤列表。现将平台 Select 在审核/拒绝及批量审批 mutation 期间禁用；新增独立桌面 Chromium 回归 `PublicRuleDraftReviewPanel.filter-mutation-race.regression.test.tsx` 1/1 通过（命令：`node --import tsx scripts/run-safe-tests.ts apps/ops-console/src/components/rules/PublicRuleDraftReviewPanel.filter-mutation-race.regression.test.tsx`），以延迟拒绝响应验证 mutation 未完成时筛选控件 disabled，结束后最后一次列表请求仍使用 `pinduoduo`。本轮只运行此新文件一次；没有重跑公共规则审核既有绿色套件。该测试使用 stub RPC，不替代真实运营 API/数据库验收。
- 插件 production profile 当前版本为 `0.1.0+codex.20261010011930`：personal 插件路径 manifest 与 `codex plugin list --json` 均显示已启用，QA namespace 仍 disabled。基于 commit `40f22acd` 的 bridge verifier 核验 tar/source provenance `checked_files=85`、已安装 runtime source/install `69/69`、stdio 工具 `134/134`、无重复或越权 `ops.*`，并确认缺配置状态 fail-closed 为 `MCP_CONFIGURATION_REQUIRED`；安装缓存排除 `.agents/plugins/marketplace.json` 符合规则。安装 smoke 29/29 收据属于此前的 `0.1.0+codex.20261009140000`，不外推为新版本 smoke。当前 ChatGPT 对话刷新仍未验证。生产配置/权限仅在本地 CLI registry 状态核对，没有打印配置值。中转真实鉴权请求、provider 实际用量/成本、图像/视频成片及扫描归档仍无真实调用收据；健康/setup 字段不补足这些证据。
- Ops Users 用户目录的详情抽屉曾仅按 `externalSubject` 保存焦点触发按钮；同一身份若有多个工作区成员关系，关闭抽屉可能把焦点送到另一行。现以表格同款 `accountType + workspaceId + externalSubject` row key 保存/查找触发按钮，并新增独立回归 `UserDirectorySection.focus-target.regression.test.ts` 验证同一主体跨 workspace 的 key 唯一。实现已落地；测试状态未确认、无通过收据，本轮不重跑。此项只修正键盘焦点返回目标，不改变成员授权或服务端写入。
- 2026-10-10 Ops User Directory 补审发现导出 UI/hook 曾用 `identity.update` 控制，而 MCP `ops.users.export` 契约使用 `billing.export`。现在 UI 与 hook RPC 前置检查复用 `canExportUserDirectory(authorization)`，只检查 `billing.export`；新增 `userDirectoryPermission.regression.test.ts`，identity.update-only 被拒、billing.export 被允许，1 test passed（直接 Vitest，未经过 `.safe-tests.lock`，未重跑）。批量停用现在从逐条 RPC 返回失败 target 列表，部分失败后只把仍可操作的失败 workspace+subject 还原为选中项；已刷新后变为 suspended 的失败目标也会移出选择。提示成功/未完成数量并明确成功项不会重试；新增 `UserDirectorySection.bulk-partial-failure.regression.test.ts` 验证相同 subject 跨 workspace 也只保留仍可操作的失败目标，safe runner 1 test passed。真实平台角色矩阵、生产数据库/RLS和真实批量写入仍未验收，不能据此宣称后端实权验证完成。
- Ops Finance 交易流水已有服务端 keyset cursor 和“加载更多”，但表格上方没有把当前累计展示数与筛选匹配总数并列，也没有明确说明是否还有未加载页，容易将当前页误读为完整流水。现增加覆盖说明：显示已展示数、匹配总数，以及由 `nextCursor` 决定的“还有未加载记录/已加载全部匹配记录”；未改分页、汇总、退款或商业退款行为。新增单文件 `FinanceSearchSection.coverage.regression.test.ts` 2/2 通过，覆盖有 cursor 与全部加载两个状态；未重跑 Finance 既有测试。该收据为组件渲染契约，不代替真实 API/数据库多页数据验收。

### Merchant Studio 视觉生成、历史与导出入口复核（只读）

- 可达路径分为两层：商家可从 ChatGPT 本地 `merchant-marketing` 技能按自然语言要求商品图/详情长图、视频脚本或成片；已安装插件通过 stdio bridge 的 MCP 工具调用服务端。桌面 Merchant Studio 可从任务工作区进入内容/详情页草稿预览、审核与“导出已审核交付包”，并从任务区进入 `PublishHistoryPanel`；页面上的详情预览与“详情页决策合同”是内容组织/审阅入口，不代表视觉已渲染。插件的历史交付物入口是 `deliverable.list`，导出入口是 `content.export`。不把历史发布面板等同于媒体素材库。
- 图片/详情图路径在技能中要求：明确确认视觉方案后调用 `catalog.image.generate`，并自动用 `catalog.image.get` 读取结果；未绑定候选必须有商家确认标题和 `asset.upload` 返回的真实素材引用。详情长图须指定 `1024x4096` 或 `1024x3072`，检查最终像素尺寸；卡片、文案、方案和原图均不能伪装成成图。现有浏览器 `image-generation-desktop`、响应式 spec 与独立商家隔离 image-generation spec 是已登记的可运行入口，之前已有图像呈现/任务工作流收据；但隔离旅程刻意禁止真实生成写入。因此该证据覆盖页面呈现/错误状态与调用门禁，不覆盖真实模型成功或输出图的像素/商品保真。
- 视频路径在技能中要求先检查素材扫描和权益、形成并确认 brief/分镜，只有 live `tools/list` 暴露渲染工具后才用 `output=rendering`；排队后轮询同一 job，服务端归档和扫描完成后才给资产引用和受鉴权下载路径。新意图使用新幂等键、同意图重试复用原键。已有视频返回字段合同、clean/unscanned 展示语义和幂等键合同定向测试为已完成证据；这些不证明用户界面渲染、播放、抽帧或商品保真复核完成。插件自身说明该播放/抽帧复核流程目前未实现或未验证。
- 历史和导出：技能规定 `deliverable.list` 默认只列已批准/已交付摘要；店铺筛选同时传平台与账号，不猜测版本/图像绑定；撤权历史须标注不可刷新/发布。`content.export` 只导出内容，不包括历史主图或输入素材；成功必须恰有一个 `resource_link`，宿主显示附件后才说“可点击下载”，不宣称已下载。MCP bridge 中已有导出 bundle/Markdown 临时文件与安全路径专项测试，conversation-flow 有可操作导出卡片合同；当前没有本轮新增测试需要重跑，也未发现以上技能流程与 bridge 输入面之间可证实的严重回归。
- 仍未闭环的是运行时证据：虽已将 production profile 插件安装到 `merchant-marketing@personal` 并通过安装桥接验证器的工具发现/配置缺失 fail-closed 检查，当前既有 ChatGPT 会话的刷新未验证；没有在真实授权商家身份下实际调用中转生成图片/视频，没有 provider request ID、用量/成本结算、视频轮询完成、扫描与对象归档下载/播放/抽帧证据。公网上的 health/setup `ready` 不能替代这些收据。需要在新 ChatGPT 会话和隔离的真实授权工作区按生产证据门禁执行一次受控业务验收后，才能称为真实图片/成片能力通过；本次只读审计不触发付费请求或写操作。
- 本轮为复核既有路径与回执，仅更新审查文档；未运行已通过的图像、视频、历史或导出测试，未修改应用或插件代码。

### Ops 导航、审计与导出路径复核（只读）

- 审计中心入口已纳入 `opsDomains`、`opsPageRegistry` 与侧栏次级“运营数据与审计”组；`visibleOpsDomains` 按服务端 capability 过滤。路由识别覆盖 `/ops/audit`、旧 hash、根路径 canonicalization 与 query/hash 保留。直接进入、授权失败返回、workbench/popstate 的通用逻辑有单测/e2e；Ops 隔离桌面矩阵实际到达审计页。现有证据没有覆盖审计页自身完整的 A→B→A 浏览器后退/前进与“授权刷新后回到原 audit URL”组合，因此该组合仍未完成桌面浏览器验收；只读审查未发现可证实的坏跳转。
- 审计查询代码按租户/平台范围分离：平台聚合不开放跨租户详情和导出；显式企业目标才允许单租户详情/导出。服务端仍对读取/导出分别校验权限与 workspace scope。已有 service、page scope、detail drawer、OpsSearchPagination 与浏览器矩阵覆盖权限、筛选竞态、失败重试、无结果/初载错误、详情焦点返回、游标加载和筛选期间导出禁用；此处依据已存在的测试源码和既有收据，没有重跑这些已通过用例。
- **已修复：审计 CSV 达到 5,000 行上限时 UI 原会静默下载截断文件。** 服务 `AuditCenterService.exportCsv` 返回 repository 的 `truncated` 与 `rowCount`，客户端 parser 保留两字段；`useAuditCenter.downloadCsv` 现在在成功下载时保存实际导出行数和截断标记，UI 以可访问状态提示完整行数，或说明“仅导出前 5,000 条、请缩小筛选条件”。新增独立浏览器回归 `AuditExportTruncation.browser.test.tsx` 2/2 通过，覆盖完整导出行数提示与截断限制提示/下载。没有重跑已有审计套件；生产上限之外的全量导出仍需缩小筛选范围。
- 列表截断与空/失败态已有明确标记：工作区游标结果提示已加载数/匹配总量并提供“加载更多”；平台聚合结果显示服务端限制并建议缩小范围；首载失败不会把空列表解释成无事件，刷新失败保留旧行但禁止导出。只读检查未发现这些列表提示之间的可证实矛盾；真实平台大租户数量与生产后端扫描完整性未由本次复核证明。

### Owner 复核的类型检查收据

- `npx tsc --noEmit --pretty false -p tsconfig.json` 检查的是 root `tsconfig.json` 收录的后端、packages、scripts 与 tests；该配置明确排除 `apps/ops-console` 和 `demo`，不能把 root 的 exit 0 描述成 Ops Console 或 Merchant Studio 已通过类型检查。
- Ops Console 使用独立配置 `apps/ops-console/tsconfig.json`。该配置曾发现三份规则浏览器测试对同一 `Window.__publicRuleRpcMock` 声明参数数目不同；统一为同一可选参数签名后，`npx tsc --noEmit -p apps/ops-console/tsconfig.json` exit 0。其后又加入 Support 详情状态迁移菜单/modal 对共享 transition 合同的使用；在该后续改动后再次执行同一 Ops Console no-emit 检查，exit 0。之后新增跨工单身份变更清理逻辑，并于 2026-10-10 再次运行 Ops Console no-emit 检查，exit 0；这些收据都只运行类型检查，没有重跑此前已通过的规则浏览器测试。
- Merchant Studio 另由 `npx tsc --noEmit --pretty false -p demo/merchant-studio/tsconfig.json` 独立检查，exit 0。三个配置范围分别记录，不将任一结果外推为全仓脚本或 release gates 完整通过。

### Ops Incidents 可达性与 Support 工单详情动作复核（只读）

- Incidents 有 `IncidentsRoute`、页面和抽屉实现，但没有 `opsDomains` 项，也没有 `opsPageRegistry` 注册项；因此 `/ops/incidents` 不能作为当前 Ops Console 路由到达，路由解析会回退 overview，侧栏也不会显示事故入口。现有 `opsNavigation.test.ts` 明确断言支持角色虽具有 `incident.read` 仍只显示 overview/support/audit，既有 review 记录将 Incidents 标记为当前 workbench 隐藏/撤下。这是可复现的入口限制，但符合已记录的当前平台工作台边界，不能按“坏按钮”计；若产品要恢复事故中心，应先同步域注册、路由、workbench/scope 与角色验收，不应只挂入页面组件。此前 Incident 页面与抽屉的定向组件/服务测试收据已在上文记录，本次未重跑。
- Support 详情的“关闭详情”只清除当前选中工单并恢复队列空详情提示；关联任务/订单 ID 是复制控件，“回到客服队列”指向可达的 `/ops/support`。旧 `/ops/tasks?...task_id=` 死链已由该 `/ops/support` 链接修复；对应 `SupportTicketDetailSection.test.tsx` 的“return to queue without unsupported filter”断言及 6/6 组件收据此前已有记录，本次未重跑。当前链接不保留队列筛选/页码，是状态恢复未覆盖项，不是跳错路径。
- 详情状态迁移菜单已改为使用共享 `supportTicketTransitions` 合同，服务端与 UI 共用合法迁移矩阵；早期浏览器尝试曾在 modal 清理步骤失败、另一次导航超时；后续单文件安全 runner 已通过 1/1，覆盖五种状态的合法目标、取消重开时目标重置、原因清空和确认禁用。跨工单切换时关闭旧弹窗并清空表单的扩展回归随后通过 1/1（详见下方收据）。
- 共享 transition 的 `as` 类型转换只在编译期约束 UI 类型，没有运行时验证含义；API `SupportService.transition` 仍保留状态白名单校验。类型检查不替代对全部迁移边界的运行时测试，而上面的详情浏览器 UI 回归已有定向通过收据；真实 API 迁移写入仍需运行时验收。
- 详情状态枚举英文展示问题已修复：队列、详情及平台工作台共用 `supportStatusLabels` 中文映射；PlatformSupportWorkspace 独立浏览器回归 1/1 通过，覆盖列表和详情状态。该 stub 浏览器收据不替代真实 API/授权验证。
- 权限只读态的三项按钮（分配负责人、变更状态、添加备注）在 `canMutate=false` 时均 disabled 并给出无权限标题；授权投影以 `support.ticket.update` 控制可变 UI，服务端将它扩展为 create/assign/transition/comment 子权限并再次校验。已有 `SupportTicketDetailSection.test.tsx` 只读控件合同及平台 Support 路由 capability 测试收据已记录，本次未重跑；真实不同角色/租户写入矩阵仍未验证。平台聚合工作台只开放双人确认后的备注流程，不提供分配或状态操作。
- 本次为源码/已有收据复核，没有运行已通过的 Support 或 Incident 测试，没有执行任何工单写入，也没有修改应用代码。

### Support 工单详情状态 UX 修复候选

- 状态迁移矩阵已提升为 `packages/contracts/src/ops/support.ts` 的 `supportTicketTransitions` 共享合同；API `SupportService.transition` 与详情弹窗的目标状态选项都读取同一矩阵。详情标题状态 Tag 改为使用既有 `supportStatusLabels` 中文映射。Incident 仍按上面的工作台边界隐藏，本次未改路由。
- 新增独立浏览器回归 `SupportTicketDetailSection.status-transitions.browser.test.tsx`。早期 harness 导航超时及 modal 清理失败属于历史尝试；后续安全 runner 首次通过 1/1，覆盖五种合法状态及取消后重开时目标/原因重置。随后发现详情组件跨工单切换时可能残留弹窗输入，现已按 workspace、ticket、revision、status 身份变化关闭弹窗并清空表单；扩展后的同一文件安全 runner 于 2026-10-10 01:24:00 通过 1/1（22.24s，runner 23.30s），覆盖旧原因不带入新工单及新工单默认合法目标状态。未执行客服写入；跨工单改动后的 Ops Console no-emit 检查 exit 0；真实后端迁移写入仍待验证。

### Merchant 登录、首次工作区与六平台公开导入复核（只读）

- 登录失败/会话失效提示已由 `merchant-login-error.test.ts` 覆盖；本地插件授权登录回跳的同源校验由 `plugin-authorization-return.test.ts` 覆盖，API 有本地插件登录浏览器 e2e 与多工作区授权码绑定 e2e。首次无工作区商家创建工作区的无租户头请求、重新读取 session 与页面退出恢复由 `merchant-workspace-bootstrap.test.ts` 覆盖。注册页没有自助注册入口，登录页明确引导联系平台运营创建账号和分配工作区；这是既定开户边界，不认定为失效跳转。此次只读核对未读取凭据或触发注册、登录、绑定等写操作，也未重跑上述既有通过用例。
- 多工作区登录后的选择页只将 `workspaceIds` 原样作为 option label（`demo/merchant-studio/src/App.tsx`）；用户无法在该选择页区分多个企业工作区。后续选择只接受当前 session 授权列表，并切换后清理旧租户导航与数据上下文；服务端另有多工作区 OAuth 授权码绑定测试。缺少该 Merchant Studio 登录后工作区选择页的真实桌面浏览器旅程，尤其尚无通过可读企业名称确认目标、切换失败提示及重进验证的浏览器证据。此处为只读发现，没有修改或运行测试。
- 六平台公开商品导入 skill 已明确要求先确认宿主网页读取能力、只读取无需登录的公开 HTTPS、不携带 Cookie/私有 token；读取失败须停下请求用户补充资料；`catalog.import` 必须显式 `draft_only=true`。插件侧已有解析器固定样例、价格异常值/零值测试，桌面导入权限、无障碍与批量导入 API/边界/幂等回归收据；这些分别覆盖本地合同，不证明六个平台真实页面可访问或抓取成功。
- 已修复上述确定性解析缺口：meta 标签属性现在先独立解析再读取 `name`/`property` 与 `content`，不再依赖属性顺序；新建 `extract-product-meta-order.test.mjs`，只验证 content-first 的 OpenGraph 标题与 description。该新用例单独运行一次并通过（`node apps/plugin/skills/six-platform-public-import/scripts/extract-product-meta-order.test.mjs`）。按避免重复测试的要求，没有重跑既有 parser/import 测试；六平台实时页面仍未访问或验收。
- 本次未读取任何账号/认证凭据、未向外部平台请求商品页、未调用 `catalog.import`，未重跑通过的 auth/import 测试。

### MCP 图片/视频/资产/导出合同复核（只读）

- `catalog.image.generate` 的授权链在入口由 MCP method capability、商品/品牌或素材 workspace scope、正式绑定时的 canonical task/listing scope、商品事实确认、素材扫描/权益、平台规则、commercial access、平台模型成本 gate、创意点预留及 durable worker authorization snapshot 组成。`catalog.image.get` 同样按 workspace 取 job；绑定候选额外检查 brand/canonical scope，未绑定候选仅按持久 canonical binding 豁免 brand grant。输出必须已归档且扫描可用才返回真实图片/签名 URL；demo unscanned 例外会明确标 `scan_verified=false`、`publishable=false`。`catalog.image.select` 要求候选选择确认票据并以 revision/idempotency key 写首选状态，不等同审核、批准或发布。
- 原始只读审计发现图片幂等键不完整：`packages/contracts/src/mcp.ts` 中 `catalog.image.generate.idempotency_key` 是可选；当 MCP 参数和 HTTP header 均缺少 key 时，`apps/api/src/mcp-image-handlers.ts` 原先退化成 `image-${workspaceId}-${productId}-${direction}`。应用层完整 intent hash 还包含 task/content version、SKU、来源素材、模式、商品版本、画布尺寸、count、营销 brief 等；因此相同商品/方向但不同图片生成参数会撞到旧 key 并返回 `IDEMPOTENCY_KEY_REUSED`，完全相同意图则会重放旧任务。模型调用前会释放失败的点数预留；这是请求可用性合同缺口，不是权限绕过。该缺口已按下一条修复。
- **已修复并定向验证：** 当请求参数和 `Idempotency-Key` header 均未提供幂等键时，API 现在以 workspace/product、归一化 direction、size、有效来源素材、规范化 count/mode、task 与内容版本关联/版本、有效 SKU、商品版本及确认营销 brief 派生 SHA-256 key。该 key 稳定重放完全相同的已解析业务意图，改变影响意图字段会得出不同 key；用户传入显式 key/header 的优先级保持不变。新增 `apps/api/src/image-generation-idempotency.test.ts`，单次定向执行 11/11 通过，覆盖 key 稳定性和 size/source/count/mode/task/content/SKU/product/brief 变化。`git diff --check` 通过。没有调用 provider、真实模型或生产数据，也没有重跑已通过的 multimodal/install-smoke 测试。
- **幂等边界：** fallback key 会保留 `sourceAssetIds` 与 `skuIds` 的数组顺序；现有服务也保留输入顺序，顺序可能影响素材提示/生成结果，因此本轮没有擅自排序。若业务合同将这些数组视为无序集合，语义相同但顺序不同的请求会生成不同 key；目前没有证据证明这会导致重复扣费或错误重放。是否规范化应由明确的顺序合同和定向测试决定。
- 视频入口的脚本/分镜复用已确认商品事实、产品品牌 scope、规则预检、模型成本 gate、commercial access、创意点预留和文本中转用量/结算证据；rendering 另外检查视频成本预检、故事板质量、候选与正式商品绑定限制，生产环境强制请求幂等 key。`withOwnedVideoAction` 以 action key 持久声明准备/dispatch/accepted 事件，同 key 异 intent 冲突、处理中或 outcome unknown 要求查询原任务；接受后通过 `video.get` 以 workspace + provider job billing event 反查作用域并要求结算 receipt。完成后下载地址只在对象已归档且扫描 clean 时提供；归档失败或扫描未完成不会给正式下载路径。读取状态移除 provider `videoUrl`，避免把外部临时 URL 暴露给用户。
- 视频轮询合同是显式的：`multimodal.video.get` 收到仍未结算的结果就返回 queued/pending receipt；结算后尝试归档，失败保留 status event 和重试 `video.get` 的下一步；provider 明确失败记录失败状态。聊天卡片图片轮询有 1–5 次上限和手动查询恢复；插件视频技能要求按同一 provider job id 轮询。`multimodal.video.request` 的 MCP schema 虽将 key 声明可选，但 API production handler 对 rendering 已 fail-closed 强制 key；生产脚本/分镜也走相同强制检查。公开视频 idempotency contract 已有 1/1 既有收据，本次未重跑。
- 上传合同：插件只暴露 merchant 工作区工具；source/mirror bridge 将用户附件绝对 `file_path` 转为服务端 API 支持的文件输入，API 不接受该本地路径字段。bridge 必须恰有 `file_path` 或 `content_base64`，缺失/同时提供在桥接边界拒绝；这一缺参 source/mirror 回归已有 2/2 收据。服务端验证类型/大小/安全分类、workspace scope、对象存储、权益与扫描状态；视频文件会拒绝从一般 merchant 素材上传。真实 provider 素材扫描回调和对象存储下载验收不在本轮证据范围。
- 导出与历史交付：`deliverable.list` 按当前 workspace 及可访问 brand 过滤，返回分页元数据和摘要，不开放无范围全量资产；历史素材/图片不会随 `content.export` 导出。导出 handler 要求 `content_version_id` 与 `deliverable_ref` 二选一、验证 task scope 与 canonical action scope，格式白名单、25MB 限制和 bundle verification；插件只接受 JSON/Markdown/ZIP、校验非空/大小/ZIP 签名/JSON 格式，生成仅当前会话可读的 0600 文件并设置会话配额。只有成功返回 resource link 才有可点下载入口。真实宿主附件下载行为、生产导出 API 权限与对象存储签名读未由源码审计证明。
- 已有测试收据为合同/桥接层和 mock/隔离环境，不构成真实商家身份下的中转鉴权、provider request ID、实际用量/成本结算、图片/视频成片、视频完成轮询、扫描、归档、播放器/抽帧或导出下载证明；本次没有发送付费模型请求或写入生产数据，也未重跑 install-smoke、multimodal 或其他已通过测试。
- **工具能力与随包技能表述核对：** MCP 当前确实暴露 `catalog.image.generate/get`、`multimodal.image.edit` 与 `multimodal.video.request/get`；图片生成返回候选，视频工具区分脚本、分镜与 `rendering`，视频成片仍依赖已配置的平台中转/provider 和服务端门禁。随包 `ecommerce-video-marketing` 与 `storyboard-prompt-assistant` 明确只产出文本，不渲染成片；主商家技能也要求按当前 `tools/list`、工作区配置、权限、费用与审计门禁决定能否调用，并禁止把任务 ID/排队状态说成成品。源码与 MCP schema/工具快照相符，但这只是能力合同，不是 provider 可用或成功证据；真实 provider 鉴权、请求/响应、provider request ID、实际 usage/cost/结算和图片/视频成品仍未验证。曾发现主技能图片规则与成功状态/API 语义冲突；现已修正为仅 MCP 返回真实图片附件时展示，本地 fixture 仅可在明确演示上下文展示并标注，排队状态或无附件时不得用占位图/原图冒充结果。视觉契约测试已补充对应正反向断言；定向安全 runner 于 2026-10-10 01:25:41 对该文件一次运行通过 3/3（exit 0，Vitest 224ms）。

### Ops Customer Delivery 授权、账号关联与控件复核（只读）

- 目标 workspace 必须由运营人员显式选择；空选择不读取租户数据且禁用刷新/新建。页面用 `customer.delivery.read/update` 分别控制读取和写入口，缺少 update 时传入 `readOnly` 并不提供保存、上传、归档、培训写入及账号关联回调；workspace 切换会清空列表并以新目标发起读取。已有桌面浏览器回归覆盖无 read 不发 RPC、无目标时无 RPC/写入口、A→B 清空旧租户行、撤销权限/切换 workspace/关闭/取消后的迟到账号绑定响应不污染界面；这些回归已有通过收据，本次未重跑。
- “生效账号”查询在目标变更时清空旧选项、选择和 cursor；加载更多复用已提交查询；关联前校验当前 workspace、revision、原因和显式确认，响应需匹配所选 identity 且 revision 前进。已关联状态只读显示登录名，不提供改绑。查询搜索浏览器回归 1/1、页面账号搜索/分页/绑定 UI 及迟到响应用例已有历史通过记录；实际目录检索与成功绑定仅在页面 stub 下覆盖，未声称真实运营账号目录端到端已验收。
- Ops API 将全部 `ops.customer-delivery.*` 纳入控制面方法集，并为资产上传额外要求经过鉴权的 `customer.delivery.update`、platform workbench 和 platform scope。已有 strict loopback API 测试证明工作区商家不能调用平台交付方法、目标缺失/冲突被拒绝；账号关联 handler 的 transport 测试证明不存在/不可绑定账号不写入成功结果。尚缺一个专门使用 `denied_capabilities: [customer.delivery.update]` 的 API 回归，直接对 `accounts.list` 与 `account.bind` 分别断言 403 且无 repository dispatch；页面 fixture 的权限测试不能代替此服务端负向测试。
- 本次未确认可复现的跳转、搜索或数据展示故障：筛选提交把关键词/负责人传给服务端并重置第 1 页；分页回调改变页码；详情 drawer 的“编辑客户档案”关闭详情后进入档案步骤；跨页行号回归 1/1 已有通过收据。搜索/分页所用页面 fixture 不证明生产 API 返回总数、筛选和行数据在同一快照，也没有覆盖所有按钮的一体化真实桌面矩阵。该审计只读源码和已有测试，不运行已通过测试、不触发账号绑定/业务写入。

### 随包图片局部编辑与充值 MCP App 控件合同复核（只读）

- `ui/image-local-edit.html` 控件盘点：来源素材 ID、预览 URL、原图尺寸、修改说明、模型标识、区域名称、品牌/商品/规则快照、可编辑/不可修改区域 JSON；画布支持鼠标拖拽与键盘方向键/Shift 缩放；“创建候选”“重置区域”“复制请求 JSON”；结果候选 ID/模型/原图保留状态及 fallback JSON。提交契约调用 `multimodal.image.edit`，payload 字段与 MCP bridge/API handler 的 `request_json` 结构相符，服务端按当前 workspace 检查素材扫描/权益、产品范围、模型成本和候选归档。没有触发真实调用。
- **明确 UI 缺陷：**成功提交路径在 `renderCandidate()` 前直接调用 `normalizeResult(response)`，但 `image-local-edit.html` 全文没有 `normalizeResult` 定义。因而宿主调用成功后仍会抛 `ReferenceError` 并进入失败提示，候选 ID、图片和待审核结果不会显示；这使“创建候选”按钮的结果呈现与服务端成功事实不一致。已报告 owner；本只读任务未改代码。
- **区域几何/校验风险：**指针坐标按整个正方形 `stage` 归一化，但原图 `<img>` 使用 `object-fit:contain`；长宽比非 1:1 时画布有留白，选区会相对真实图像偏移。`editableJson` 为合法空数组时允许提交；JSON 解析失败时 `normalizedRegions()` 静默回退空数组，导致 `regionIssue()` 把编辑范围视为不受限（即使 `buildRequest()` 后续会拒绝 malformed JSON，用户仍会看到绿色编辑层缺失而有效状态/提交启用）。建议修复时令可编辑区域必须至少含一个有效矩形，坏数据/空数据 fail-closed，并以 object-fit 后的实际图像内容区域计算坐标。未验证它是否已由服务端全量拒绝，故列为客户端合同缺口风险，不声称已越过服务端权限。
- `ui/recharge.html` 控件盘点：我的/工作区 scope（工作区仅由 `billing.status.viewer.available_scopes` 开放）、概览/订单/套餐 tabs、刷新准入状态、各套餐打开商家后台；没有客户端金额输入、支付提交或账务写工具，目录限定为服务端批准且可执行 SKU，订单查询走 `billing.recharge.list` 与 `subscription.orders.list`，套餐走 `commercial.catalog.get`。与“插件不收款、等待 grant/access revision”的合同一致。tab 键盘导航、aria busy/status/error、未知余额保持待确认均由源码确认；这不等于真实宿主点击验收。
- **异步交错风险：**`orders()`/`catalog()` 请求未按当前 `S.tab` 与 `S.scope` 绑定请求序号。用户快速改变 tab 或 scope 时，旧请求仍会更新隐藏列表、清除共享错误/写 live status；相同订单容器的旧 scope 响应也可能覆盖新 scope 请求的结果。建议增加请求代次或 abort/只接受仍匹配的 scope+tab 响应。没有触发这些调用或任何账务/商业 API。
- 既有可核验收据：`apps/plugin/install-smoke.test.ts` 曾有 29/29 通过，覆盖充值页静态安全/渲染源码断言；`apps/plugin/mcp/bridge.test.ts` 历史 bridge 快照曾 157/159（2 项失败由后续窄回归覆盖），它只覆盖资源挂载/工具合同，不验证真实浏览器 UI。没有发现单独的 image-local-edit/recharge 页面交互浏览器测试收据；本轮不重跑任何已通过测试，也不将静态断言视作按钮或服务端旅程通过。

### API/MCP 多租户权限对抗复核与修复

- **已修复授权前副作用：** `routeMcp()` 曾在工作台/能力授权门禁之前，将 platform-scope MCP 请求中的任意 `workspace_id` 写入进程级 `knownWorkspaces`。`ops.users.list` 是有效平台 scope 方法且接受该字段；被拒绝的 workspace 商家请求因此可能污染集合。现在移除了这条从请求参数注册工作区的路径。`platformOverviewWorkspaceIds()` 在持久化 workspace inventory 可用时只使用权威目录；不再把进程内 ID 合并到持久化目录。平台身份 inventory 为空时不再回退到请求头或 principal 的 workspace。只有已验证的 platform operations 身份进入平台聚合 fan-out；无此身份返回空 ID 集合。修复位于 `apps/api/src/server.ts` 与 `apps/api/src/mcp-ops-overview-handlers.ts`。
- 该修复的新增回归包含源码正则检查旧的请求参数注册模式，以及 helper/handler mock 对权威目录去重、非平台身份拒绝和空目录不回退请求 workspace 的检查。正则项是静态防回归，不是一次真实未授权 MCP 请求或进程状态污染验收；生产鉴权链和 PostgreSQL workspace inventory 仍未由这些测试证明。
- 新增独立回归 `apps/api/src/mcp-workspace-inventory-security.regression.test.ts`，变更后的单次定向运行 **3/3 通过**：源码边界断言确认 MCP route 不再从 `params.workspace_id` 注册 workspace；平台摘要 ID 投影确认 authoritative directory 可用时忽略进程本地任意 ID、非平台身份无 fan-out；overview handler fixture 确认 authoritative directory 空时不会退回请求 workspace/本地集合，且 workspace summary 不会被调用。未发真实 HTTP/MCP 请求，也未连接 PostgreSQL；真实授权身份与 PG 运行时仍待环境验收。既有 `ops.users.list` workbench mismatch 安全矩阵未重跑。
- **未发现其他新增问题：** 本次检查的商家 MCP workspace 解析将请求 workspace/header 作为身份范围一致性检查；商品/任务列表在分页计数前施加可访问 brand/product 集合；资产列表先按 workspace 列表再按授权 asset IDs 投影；充值订单 cursor fingerprint 绑定 workspace、scope、actor 与状态筛选；平台 Support cursor 每次均由显式 `target_workspace_id` 创建单工作区查询，且平台角色及目标 workspace capability 在读取前检查。没有由这些路径确认跨租户游标读取或受限搜索总数泄漏的新证据。已修复的 `deliverable.list` 品牌分页/计数问题未复审、未重跑。

### Ops Console capability 与 API endpoint 对照（只读）

- **确定的新增不匹配：平台财务 CSV 导出按钮未按导出能力门禁。** `FinancePage` 只在 `billing.platform.read` 存在时挂载 `FinanceSearchSection`；该 section 的“导出当前筛选”按钮仅按记录非空、非加载/过期状态控制，没有消费 `billing.export`。但 `packages/contracts/src/authz.ts` 将 `ops.finance.export` 明确绑定到平台 `billing.export`，与读取/详情所需的 `billing.platform.read` 分离。因此具有财务检索能力但没有导出能力的账号仍能点击并发起请求，服务端拒绝后显示导出错误。建议将 `canExport` 能力投影传入组件并禁用/隐藏该按钮及重试入口，同时保持 API 拒绝作为最终边界。此处为源码合同对照，未执行导出、未运行测试。
- 本次核对的其他目标面未发现确定的不匹配：退款仅在平台 scope 展示且按 `billing.refund.execute` 投影，表单还要求运行态为 provider；Members 的变更控件由 `workspace.member.manage` 与目标成员约束控制，API 分别将 `ops.member.upsert/suspend` 绑定该能力；Platform Support 读取使用 `support.ticket.read`、回复使用 `support.ticket.update` 并绑定平台 scope endpoint；公共规则读取使用 `rule.read`，状态变更基于 `rule.update`，激活另受 `rule.publish.approve` 限制；审计导出仅对明确选定的 workspace 且有 `audit.export` 开放，和 workspace-scoped `ops.audit.export` policy 一致。
- Stores 页有多个不同的工作区/平台 capability 与 API 方法；本次有限核对到的平台 canonical backfill 控件会同时验证 platform scope 和 `canonical.backfill.update` 的 platform scope 投影，品牌读取/绑定分别由 `customer.content.read/update` 控制。未确认新增 mismatch；不代表所有 Stores 子控件或真实运营 API 页面均已端到端覆盖。
- 只读核对已有源码、权限注册表和测试，不触发业务写、不重跑既有绿测。当前只报告上面这一项确定 mismatch。
- **已修复并作独立 UI 回归：**`FinancePage` 继续用 `billing.platform.read` 开放财务搜索，另行读取 `billing.export` 并传给 `FinanceSearchSection`；导出按钮仅在该能力为真时展示，因此单有读取能力的用户仍可检索但看不到导出入口。新增 `FinanceSearchSection.export-permission.regression.test.tsx`，单次运行 3/3 通过，覆盖缺少导出能力仍可检索且无导出按钮、具备能力时展示按钮，以及页面将两项能力分别接线。该 UI regression 使用静态渲染/mock，不证明真实服务端拒绝、真实角色投影或服务端到页面的端到端行为；没有重跑旧 Finance/权限 suites。

### Ops ConfigCenter 精确 capability 门禁修复

- 修复 ConfigCenter 将套餐与平台设置两个编辑面都绑定宽泛 `canPlatformOps` 的权限错配：套餐表单和保存按钮现在只要求 `workspace.settings.update`；平台设置行输入、启用开关及保存按钮只要求 `platform.settings.update`。`store.connection.update` 或 `commercial.update` 不再意外解锁这两个设置面板。服务端 API 的 capability/角色矩阵未因此取得运行环境验收证据。
- 平台变更原因提示改为“原因可留空，系统使用默认审计说明”，与 `savePlatform` 补默认 reason 并由 API 使用默认审计说明的实际合同一致。
- 新增 `ConfigurationCenterSection.capabilities.regression.test.tsx`，单次定向运行 2/2 通过：分别验证只有 `workspace.settings.update`、只有 `platform.settings.update` 时各自面板可编辑且另一个保持禁用，并验证 `store.connection.update` + `commercial.update` 不解锁任一编辑面板。此为静态 UI 渲染及 mock authorization 验收，不代表真实服务端角色、权限投影或账务运行环境已验证；没有重跑旧 Finance/security tests。

### Ops Support 未决写入恢复修复

- 普通 Support Queue 的负责人分配、状态变更、添加备注原先每次点击确认都生成新幂等键。若服务端已提交但响应丢失，重试会带新键，无法命中 repository 的原事件幂等重放。现按 action kind 和 workspace/ticket/revision/输入内容指纹固定未决意图键；失败保留原键，同意图重试复用；成功确认后清除，显式改变目标/输入/版本才建立新键。
- 新增 `useSupportDomain.uncertain-mutation.browser.test.tsx`，单次定向运行 1/1 通过。fake repository 模拟“首次已提交副作用后返回 504，第二次同键重放”；覆盖 assign、transition、comment 三类，逐项检查相同 target、revision、内容与幂等键且副作用恰一次。未连接真实 API/Postgres，也未重跑原 Support hook/detail suites。
- Platform Support 对不确定回复仍只在 sessionStorage 保存 workspace/ticket/actor/visibility/revision/key/body hash，不存客服正文。为刷新后恢复新增不含正文的活动意图指针；页面按同一身份恢复目标工单，查询未找到精确事件时允许重新录入正文，只有摘要匹配原 intent 才构造沿用原键/版本/可见范围的待确认回复。发送端仍要求核对服务端事件；不匹配或权限拒绝不会改用新键自动发送。
- 新增 `PlatformSupportWorkspace.reply-recovery.browser.test.tsx`，单次定向运行 1/1 通过：预置仅元数据的旧 intent，刷新态重新加载工单、输入原正文、摘要校验，模拟同键写入后 504 再点一次；断言两次请求 target/body/visibility/revision/key 一致、后端事件只写一次，成功后清除两个 session marker。此为 browser + fake API 恢复合同验收，不是生产工单写入证据；旧 Platform Support 测试未重跑。

### Merchant 品牌资料上传与切店保存竞态修复

- `MaterialBrandFields` 店铺/系列表单组件在 pending 上传期间会保持挂载。旧上传响应可拿到已切换 scope 的最新字段，却调用上传开始时捕获的旧 scope `onChange`，将另一店铺/系列草稿与 Logo/文档 asset id 合并写到旧 scope。现为全局、店铺、系列、单图配置传入含 workspace/storage identity 的稳定 `scopeKey`，跟踪 scope generation 和 draft revision；上传响应只在开始时 scope 仍匹配的情况下合入最新草稿，切走又切回也不会应用旧响应。文件仍作为工作区素材登记，可重新在目标 scope 选择。
- 放弃未保存品牌草稿后切店，原保存入口曾在新 scope 的 `brand-scopes` 读取完成前仍可用，保存闭包可能以旧 revision 提交尚未清理的草稿。现在切换提交时立即标记读取中并清除 dirty 标志，读取中禁用保存按钮，保存函数也拒绝 pending 状态；写入期间禁用店铺切换。
- 新增桌面浏览器 `demo/merchant-studio/brand-scope-upload-race.browser.spec.js`，本轮文件单次收据 **2/2 通过**：延迟上传跨店/切回时不把 asset 写入另一 scope，并保留两边最新草稿；确认放弃旧 draft 后人为延迟下一 scope 读取，保存保持禁用且没有 PUT，读取完成展示服务端新 scope 数据。该 fixture 用 stub API，不验证真实 API/RLS/对象存储；既有品牌上传重试与 BrandTree 绑定绿测未重跑。

#### 插件随包页面缺陷修复进度

- 已定义 image-edit Host 响应规范化：支持 MCP `structuredContent`、常见 `result` wrapper 和 JSON text content；候选呈现使用规范化对象，不再因缺失函数引用而吞掉成功结果。新增浏览器回归在 stub `callTool` 返回 `structuredContent` 时确认 `multimodal.image.edit` 调用、候选 ID/模型/审核状态渲染，1/1 通过。该 stub 不调用真实 API/provider。
- 画布现在按原图宽高与 `object-fit:contain` 的实际图像内容矩形转换指针坐标，不再把 letterbox 留白计入归一化区域。客户端对可编辑区域缺失/空数组/无效矩形、不可修改区域非数组/无效矩形 fail-closed。API contract 中 `editableRegions` 本身是可选约束，空数组等同未提供，不是服务端权限绕过；这里是 UI 必须显式声明绿色可编辑范围的误操作防护。独立桌面浏览器回归 `apps/plugin/ui/image-geometry.regression.browser.test.ts` 1/1 通过：200×100 原图在 contain 画布上的指针 y 坐标映射为 0.300，`editableRegions=[]` 禁止提交。此前综合文件中的尝试因目标 JSON textarea 位于折叠 details 而超时；修正 harness 后只运行独立失败用例，没有重跑另外两项已通过用例。
- 充值页对 `billing.status`、订单列表、套餐目录增加请求代次及当前 tab/scope 保护；旧工作区订单响应不能覆盖切回“我的”后的新结果。仅用内存 deferred stub 验证“我的”已到账记录不会被迟到的工作区待支付响应替换，1/1 通过。未调用账务、目录 API 或写接口；真实宿主和商业数据仍未验收。
- 上述 UI 修复与后续插件 parser 更新属于 production profile `0.1.0+codex.20261010011930`；本机 personal 插件路径 manifest 已显示此版本且 CLI 显示启用。基于 commit `40f22acd` 的新版本 bridge verifier 已通过并确认运行时文件/工具清单一致；当前 ChatGPT 会话刷新仍未验证。


## 本机 stdio 工具覆盖清单（只读枚举）

基于当前源码 bridge 的标准 `initialize` → `tools/list` 运行态快照生成；共 134 项、名称唯一 134 项，`ops.*` 为 0。这里是插件暴露入口及声明参数清单，不代表每项业务操作均已执行。工具名/参数取自当前 MCP `inputSchema`；`required` 是必填项，括号内为可选参数名。

### 工作区与引导（13）

- `onboarding.status` — 无必填参数；可选：store_links_text
- `merchant.start` — 无必填参数；可选：requested_platform、requested_goal、attachment_count、idempotency_key
- `merchant.first_value` — 无必填参数；可选：platform、account_id、product_id、example、draft、draft_title、draft_prompt、idempotency_key
- `workspace.health` — 无必填参数
- `workspace.invitations.list` — 无必填参数
- `workspace.invitation.accept` — 必填：expected_revision；可选：reason
- `workspace.interactive.confirm` — 必填：confirmation；可选：intent_hash
- `workspace.metrics` — 无必填参数；可选：platform、account_id、date_from、date_to、risk_limit
- `workspace.data.export.request` — 必填：reason、idempotency_key
- `workspace.data.export.get` — 必填：request_id
- `workspace.deactivate` — 必填：reason
- `workspace.activate` — 必填：reason
- `workspace.data.delete.request` — 必填：scope、reason、idempotency_key

### 商业与账务（25）

- `commercial.service-boundary.accept` — 必填：policy_version、policy_checksum、acceptance_ref、accepted_at、idempotency_key
- `commercial.access.get` — 无必填参数
- `commercial.catalog.get` — 无必填参数
- `commercial.upgrade.quote.create` — 必填：target_sku_code、idempotency_key
- `commercial.upgrade.quote.get` — 必填：upgrade_quote_id
- `commercial.subscription.get` — 无必填参数
- `commercial.notifications.list` — 无必填参数；可选：cursor、limit
- `commercial.notifications.mark-read` — 必填：notification_id、idempotency_key
- `commercial.order.create` — 必填：purchase_kind、sku_code、idempotency_key、reason；可选：upgrade_quote_id、checkout_id、onboarding_order_id
- `commercial.order.request.get` — 必填：idempotency_key
- `commercial.upgrade.quote.request.get` — 必填：idempotency_key
- `commercial.checkout.create` — 必填：onboarding_sku_code、subscription_sku_code、idempotency_key、reason
- `commercial.order.payment.create` — 必填：order_id、idempotency_key
- `commercial.checkout.request.get` — 必填：idempotency_key
- `commercial.order.payment.get` — 必填：order_id
- `creative-points.balance.get` — 无必填参数
- `creative-points.statement.list` — 无必填参数；可选：cursor、limit
- `subscription.get` — 无必填参数
- `subscription.orders.list` — 无必填参数；可选：limit、scope
- `billing.export` — 无必填参数；可选：limit、format、from_at、to_at、scope
- `billing.status` — 无必填参数
- `billing.model-usage.statement` — 无必填参数；可选：from_at、to_at、limit、scope、manual_attention_cursor
- `billing.recharge.get` — 必填：order_id；可选：scope
- `billing.recharge.list` — 无必填参数；可选：states、limit、cursor、scope
- `billing.transactions` — 无必填参数；可选：limit、scope

### 商品与任务（42）

- `brand-unit.list` — 无必填参数；可选：brand_id、platform、account_id
- `brand-unit.create` — 必填：name；可选：brand_id
- `brand-unit.bind-store` — 必填：brand_id、platform、account_id；可选：expected_revision、reason
- `brand-unit.product.create` — 必填：brand_id、title；可选：product_id、source_product_id
- `brand-unit.listing.create` — 必填：brand_id、canonical_product_id、platform、account_id；可选：listing_id、remote_product_id、reason
- `brand-unit.listing.list` — 无必填参数；可选：brand_id、canonical_product_id、platform、account_id
- `brand-unit.access.grant` — 必填：brand_id、external_subject、role；可选：reason
- `canonical.product.consistency` — 无必填参数
- `campaign.batch.create` — 必填：brand_id；可选：platform、account_id、product_ids_json、targets_json、idempotency_key
- `campaign.batch.list` — 无必填参数；可选：platform、account_id、limit
- `campaign.batch.get` — 必填：campaign_id
- `campaign.batch.pause` — 必填：campaign_id、expected_revision、idempotency_key、reason
- `campaign.batch.resume` — 必填：campaign_id、expected_revision、idempotency_key、reason
- `catalog.search` — 无必填参数；可选：scope、query、platform、account_id、store_name、brand_name、sku_id、remote_product_id、listing_status、product_state、sync_status、date_from、date_to、include_knowledge、limit、offset
- `catalog.categories` — 无必填参数；可选：query
- `catalog.title.optimize` — 必填：product_id；可选：platform、keyword、objective
- `catalog.title.accept` — 必填：product_id、platform、suggestion_id、title；可选：actor_id、expected_version
- `catalog.import` — 必填：platform、title；可选：brand_id、account_id、draft_only、remote_id、local_product_key、category、price、stock、sku_count、skus_json、images、asset_ids_json、attributes_json、selling_points_json、store_name、store_differentiation
- `catalog.import.batch` — 无必填参数；可选：products_json、source_asset_id、draft_only、idempotency_key
- `catalog.sku.update` — 必填：product_id、sku_id；可选：name、price、stock、images_json、attributes_json、expected_version
- `catalog.product.update` — 必填：product_id；可选：title、category、images_json、attributes_json、selling_points_json、store_differentiation、price、expected_version
- `catalog.facts.confirm` — 必填：product_id
- `catalog.product.disable` — 必填：product_id、reason
- `catalog.product.enable` — 必填：product_id
- `catalog.image.generate` — 无必填参数；可选：product_id、title、platform、account_id、task_id、content_version_id、mode、sku_ids_json、asset_ids_json、size、direction、selling_points_json、traffic_keywords_json、promotion_labels_json、marketing_labels_json、headline、subheadline、cta、count、idempotency_key
- `catalog.image.get` — 无必填参数；可选：job_id、visual_ref
- `catalog.image.select` — 必填：job_id、visual_ref、expected_revision、idempotency_key、reason、confirmation_ticket_nonce_hash、confirmation_ticket_intent_hash
- `catalog.image.review` — 必填：product_id；可选：images、visual_refs_json、authenticity_evidence_json
- `task.history` — 无必填参数；可选：query、platform、state、product_id、account_id、brand_name、store_name、remote_product_id、publish_status、date_from、date_to、limit、offset
- `task.resume` — 必填：task_id
- `task.clone` — 必填：task_id；可选：request_text、target_product_id、target_platform、target_account_id、region
- `task.timeline` — 必填：task_id；可选：limit
- `task.create` — 必填：product_id、platform；可选：brand_id、account_id、region
- `task.create.draft` — 必填：product_id、platform；可选：request_text
- `task.answer` — 必填：task_id、answers_json；可选：expected_version
- `task.request.create` — 必填：request_text；可选：expected_scopes、idempotency_key
- `task.sku.split` — 必填：task_id；可选：idempotency_key
- `task.group.create` — 必填：entries_json；可选：request_text、idempotency_key
- `task.select_direction` — 必填：task_id、direction_id；可选：expected_version
- `task.plan.confirm` — 必填：task_id；可选：actor_id、expected_version、price_impact_confirmed
- `knowledge.product.list` — 必填：product_id
- `knowledge.product.update` — 必填：product_id、asset_id、expected_revision、reason；可选：approval_status、rights_status

### 客服与反馈（3）

- `support.customer.replies.list` — 无必填参数；可选：ticket_id、related_task_id、related_order_id、limit、cursor
- `feedback.list` — 必填：task_id
- `feedback.submit` — 必填：task_id、rating；可选：content_version_id、reason、comment

### 品牌及其他（8）

- `platform.mapping.preflight` — 必填：input_json
- `platform.store.alias.set` — 必填：platform、account_id、alias、expected_revision
- `brand.get` — 无必填参数；可选：brand_unit_id
- `brand.extract` — 无必填参数；可选：asset_ids_json
- `brand.upsert` — 必填：name；可选：brand_unit_id、positioning、audience、tone_json、forbidden_terms_json、details_json、visual_rules_json、source、conflict_resolutions_json
- `creative.brief` — 必填：product_id、asset_type；可选：platform、placement、goal、audience、dimensions_json、duration_seconds、text_density、sku_ids_json、promotion_json
- `creative.preview` — 必填：product_id、asset_type；可选：platform、text_density、count
- `creative.directions.update` — 必填：task_id、action；可选：direction_ids_json、direction_id、changes_json、feedback、expected_version

### 知识与规则（17）

- `rule.list` — 无必填参数；可选：platform、category、brand、store、campaign
- `rule.sync.status` — 无必填参数；可选：interval_hours
- `rule.history` — 必填：pack_id
- `knowledge.rule.create` — 必填：name、content、scope、source_kind、source_reference、source_checked_at、version、status；可选：scope_value、platform、category、brand、store、campaign、severity、action、owner_id、effective_from、effective_to、tags_json
- `knowledge.rule.list` — 无必填参数；可选：scope、scope_value、status、as_of、platform、category、brand、store、campaign、text
- `knowledge.asset.create` — 必填：kind、name、content_json；可选：source、tags_json、approval_status、rights_status
- `knowledge.asset.update` — 必填：asset_id；可选：name、content_json、source、tags_json、approval_status、rights_status
- `knowledge.asset.list` — 无必填参数；可选：kind、text、tags_json
- `knowledge.brand.preference.get` — 无必填参数
- `knowledge.brand.preference.update` — 必填：preferences_json、version；可选：status、source、expected_revision
- `knowledge.feedback.record` — 必填：kind、reason；可选：platform、content_id、details、metadata_json
- `knowledge.learning.list` — 无必填参数；可选：status
- `knowledge.learning.confirm` — 必填：suggestion_id；可选：note
- `knowledge.learning.dismiss` — 必填：suggestion_id；可选：note
- `knowledge.competitor.create` — 必填：competitor_name、source_json、summary、structure_json、selling_points_json、expression_json
- `knowledge.competitor.list` — 无必填参数；可选：competitor_name、text
- `knowledge.competitor.reference` — 必填：competitor_id、own_brand_name、own_selling_points_json

### 素材与多模态（12）

- `asset.list` — 无必填参数
- `asset.parse` — 必填：asset_id
- `asset.facts.confirm` — 必填：asset_id、facts_json、reason
- `asset.metadata.update` — 必填：asset_id、material_category、expected_revision
- `asset.preference.update` — 必填：asset_id、verdict；可选：reasons_json、note、expected_revision
- `asset.upload` — 必填：name、mime_type；可选：file_path、content_base64、sha256、rights_scope、applicable_platforms_json、applicable_regions_json、usage_scopes_json、valid_from、valid_to、ai_modification_allowed、continuation_kind、continuation_product_id、continuation_task_id、continuation_content_version_id、continuation_sku_ids_json、continuation_direction、continuation_count、continuation_idempotency_key
- `asset.upload.batch` — 必填：assets_json
- `asset.generation.confirm` — 必填：job_id
- `asset.rights.update` — 必填：asset_id、rights_status；可选：rights_scope、applicable_platforms_json、applicable_regions_json、usage_scopes_json、valid_from、valid_to、ai_modification_allowed
- `multimodal.image.edit` — 必填：request_json
- `multimodal.video.request` — 必填：prompt、output、context_json；可选：idempotency_key
- `multimodal.video.get` — 必填：provider_job_id

### 内容与交付（14）

- `deliverable.list` — 无必填参数；可选：query、platform、account_id、product_id、task_id、state、date_from、date_to、limit、cursor
- `content.generate` — 必填：task_id；可选：idempotency_key
- `content.draft.generate` — 必填：draft、draft_title、idempotency_key；可选：draft_prompt、platform
- `generation.get` — 必填：job_id
- `content.review` — 必填：content_version_id
- `content.review.decide` — 必填：content_version_id、code、field、status；可选：reason、expected_revision
- `content.visual.select` — 必填：content_version_id、visual_refs_json、expected_revision、reason；可选：idempotency_key
- `content.versions` — 必填：task_id；可选：limit、offset
- `content.diff` — 必填：content_version_id；可选：against_version_id
- `content.export` — 无必填参数；可选：content_version_id、deliverable_ref、format
- `content.approve` — 必填：task_id、content_version_id；可选：expected_version
- `content.draft.confirm` — 必填：task_id、body_json；可选：reason、workspace_id
- `content.modify` — 必填：content_version_id、reason；可选：changes_json、module_key、locked_fields_json、expected_revision
- `content.restore` — 必填：content_version_id；可选：expected_version

技能入口中明确提及的可调用完整工具名均可在该快照中找到。静态反引号扫描的非工具字符串经上下文核对为：明确隐藏的 `workspace.bootstrap`、嵌套属性 `brand.upsert.visual_rules_json`、视频完整方法名的简称、权限 `customer.content.update` 及导出文件 `review-findings.json`，不是失效工具入口。此项为可达性与 schema 暴露面核对，不验证 API 执行结果。既有 release/stdio contract 测试收据另见本报告验证记录；本轮未重跑这些测试。

### Merchant 导出错误呈现与技能格式声明复核（增量）

- `deliverable.list` 的品牌授权过滤已在分页和总数计算前完成；游标绑定可访问品牌集合。对应新增回归曾定向通过 1/1，使用内存 fixture，未验证真实 PostgreSQL/RLS 或跨品牌生产数据。
- 导出请求失败时，商家界面原先只呈现 HTTP 状态码，未读取安全的服务端错误码、说明及 `next_actions`，用户无法区分权限、素材或任务状态阻断。现仅读取最多 64 KiB JSON envelope，保留格式受限的 code、清理后的 message 与最多 3 条安全 next action；detail、request/trace ID、内部 workspace/task ID、URL、控制字符及凭据样式内容不进入异常文案。`demo/merchant-studio/src/content-export-error.regression.test.ts` 单次定向安全 runner 收据为 1/1 通过（exit 0，1.85s），覆盖过期门禁提示保留及内部字段过滤；未重跑旧 export/bridge 测试，没有真实导出/API 调用。
- 主商家技能此前列出 JSON/Markdown/HTML 导出，但 MCP 当前实际支持 manifest/JSON/Markdown/交付包，宿主端将可下载内容限制为 JSON/Markdown/ZIP。技能 frontmatter 和说明现已对齐此范围，明确不支持 HTML；未增加 renderer，也不将交付包能力混同成 HTML。
- 即使错误文案修复/描述对齐通过，真实 ChatGPT 附件点击、跨工作区导出授权、对象存储签名读取仍没有真实宿主/生产 API 证据；不执行真实导出或业务写入。

### 电商视觉/视频外部仓库核查与生产插件安装收据

以下是公开仓库 README 的声明，作为方法调研来源；本项目没有运行这些仓库的代码、eval、生成脚本或示例，也没有验证其效果、安全性、平台规格准确性或兼容性：

- 做图技能：[xianyu110/ecommerce-image-skills README](https://github.com/xianyu110/ecommerce-image-skills/blob/main/README.md) 自述包含 12 个电商图片 Agent Skills、平台规格与脚本辅助流程；其 README 声明 MIT。这里记录的是仓库自述，不是我们对其产物的独立验证。
- 视觉规划技能：[oldred-byte/ec-visual-skill README](https://github.com/oldred-byte/ec-visual-skill/blob/main/README.md) 自述规划 5 张主图和 10 屏详情页并包含生成前审核关卡；README 声明 MIT。未执行该 Skill，也未复制其代码。
- 视频制作技能：[xianyu110/ecommerce-video-skills README](https://github.com/xianyu110/ecommerce-video-skills/blob/main/README.md) 自述提供脚本、分镜、字幕/配音及本地 FFmpeg 拼接；README 声明 MIT，并标明 `edge-tts` 依赖为 LGPL-3.0。其演示、离线测试和最终成片效果均未在本项目执行或验证。
- 带货视频 Skill：[ymh3753201/ai-commerce-video README](https://github.com/ymh3753201/ai-commerce-video/blob/main/README.zh-CN.md) 自述提供方案、素材准备和付费视频生成工作流；README 声明 MIT。没有调用该仓库提到的模型/中转，也没有验证服务商、费用或结果。

**许可证与架构兼容性尚未评估。** 上述 MIT / LGPL-3.0 是各仓库 README 对自身或依赖的声明，不是法律结论；本次没有做许可证兼容审查。也没有评估将其依赖或生成代码接入本项目 ChatGPT→stdio/MCP→模型中转链路是否满足真实鉴权、成本/用量留证、素材权限、扫描和审计约束。因本项目宪法要求模型经已配置中转且保留证据，外部直连/API key/本地渲染路线不能据 README 自述直接视为可接入生产。插件内现有工作流参考已按 Store Nova 门禁整理；没有复制或安装这些上游仓库的 Skill 或执行器。

插件更新方面，基于 commit `40f22acd` 的本地 stdio production-profile tar 位于 `artifacts/local-plugin/merchant-marketing-0.1.0+codex.20261010011930-darwin-arm64.tar.gz`，SHA256 为 `7635f806ceb794e00eb4947e68ed0679ce88d8f874791e0c6cfe32aed8d405ad`。构建状态 `release_status=local_stdio_candidate`、`ready_to_install=true`、`source_dirty=false`、`ci_test_certificate=false`；这是本地 ChatGPT stdio 插件候选，不是 ECS 发布候选；打包 provenance 对 tar/source 检查 `checked_files=85`；安装后 runtime inventory 为 source/install `69/69`，另外 verifier 确认 stdio 工具清单 `134/134` 一致。安装缓存不含 `.agents/plugins/marketplace.json` 是打包器按安装规则排除 `.agents` 项的预期行为，不能把 tar 的 85 项 provenance 描述成安装缓存有 85 项。没有配置时 `workspace.health` 以 `MCP_CONFIGURATION_REQUIRED` fail-closed。尚未验证当前 ChatGPT 宿主会话是否刷新；需要新会话/重新加载后才能验证工具快照已更新。当前 personal source/cache 均安装版本 `0.1.0+codex.20261010011930` 且保持启用；QA `merchant-local` 仍禁用，未新增或更改其缓存。安装器要求重启并重新登录；ChatGPT 新会话工具快照仍未验证。该收据证明本地包和 stdio 契约安装结果，不证明真实模型请求、生成成片、真实商家租户写入或生产权限矩阵。
