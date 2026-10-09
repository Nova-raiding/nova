# Store Nova 项目全量评审

日期：2026-10-09
范围：ChatGPT 本地 stdio 插件、MCP/API、商家工作台、桌面运营台、模型中转、租户权限、生产健康和可运行测试。按项目 `AGENTS.md` 未进行生产写操作、部署或真实付费模型调用。

本轮完成了大范围代码、隔离 API、MCP、本地浏览器 fixture 和 gstack dogfood/design 走查；本报告不声称每个生产页面和每条付费业务链路都已通过。当前本地 ChatGPT 插件安装后的 stdio 实际调用、生产运营身份及真实中转图片/视频输出仍未验证；不把公开市场、ChatGPT OAuth 或签名作为门槛。

## 修改

- 套餐权益与目录摘要改用统一中文单位格式，修复 `2business_hour`、`12500creative_points` 和重复拼接 `GB`。不改变服务端权益或账本数据。
- 概览低库存/缺主图待办在旧指标缺少 `entityType` 时仍可将商品标题作为搜索词跳转到商品目录；标题不作为商品 ID。
- 新增商品目录关键词、近 7 天添加筛选、无匹配反馈、重置与分页浏览器回归，并纳入 merchant candidate runner。修复同页 Ant Design `Space.direction` 弃用警告。
- 修复 PostgreSQL RLS 攻击矩阵：事务固定在同一 `PoolClient`；预期拒绝的写入通过 savepoint 回滚。
- 修复浏览器入口：将商品风险跳转 Playwright spec 纳入 merchant 隔离 runner；移除错误传入 Playwright 的 Vitest 文件，改用真正的浏览器 spec。
- 新增隔离资产下载授权/对象读取 PostgreSQL 验收、运营公共规则 Markdown 上传浏览器验收，以及公共规则详情异常格式的 UI 边界回归测试。
- 修正默认测试 suite 的 PostgreSQL pending 白名单：移除会在无数据库时直接失败的资产下载用例；创意点并发撤销用例保留精确 pending，并加入隔离 PostgreSQL runner 与 CI 验收清单。
- 电商商品图参考增加商品身份锁定、买家决策顺序、渠道规则核对、真实性复核；视频策划增加跨镜头一致性、转场/动作衔接、声音方案合同。实际生成仍走 Store Nova MCP、中转鉴权、权限、成本/用量及扫描归档门禁；未引入第三方 provider/API/CLI 或本地生成脚本。源包与 marketplace 的 manifest/package、运行 bridge、技能和商品图参考文件已核对一致；测试资产存在版本差异，不声称全目录完全相同。技能已装入本机 `merchant-local` QA 缓存版本 `0.1.0+codex.20261009105046`，134/134 工具清单一致且未配置时 fail-closed；QA 实例保持 disabled。当前启用的 `@personal` 仍是旧版，dirty source candidate 未用于替换它；未验证 ChatGPT 宿主实际加载或真实付费成片。
- 外部技能检索参考了 [Ecommerce Image Workflow](https://github.com/nexu-io/open-design/blob/main/skills/ecommerce-image-workflow/SKILL.md)、[ecommerce-image-skills](https://github.com/xianyu110/ecommerce-image-skills) 和 [AI video storyboard skill](https://github.com/aicontentskills/ai-video-storyboard-skill)；本地参考文件也标注 [ec-visual-skill](https://github.com/oldred-byte/ec-visual-skill)。采纳参考图保真、镜头/图片规划和交付复核要点，写入本地插件技能；未原样安装会调用 Open Design 私有 CLI/外部 provider 的工作流，也未接入带强制营销导流的外部手册，以免绕过本项目 MCP、中转权限和审核门禁。
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
| ChatGPT 本地插件入口 / MCP 工具 | stdio initialize、tools/list、调用桥接、身份绑定、权限拒绝；视觉生成和视频请求的拒绝路径 | 本地 stdio/manifest/bridge 合同；运行 bridge、skills、image reference 的 source/marketplace 文件一致 | 当前本地 ChatGPT 安装包的 stdio 实际调用未验；缺少真实角色授权及付费 provider 成片证据 |
| 商家概览 | 待办指标、低库存/缺主图跳转、通知/风险提示、导航 | 浏览器风险目的地测试；生产只读检查概览 | 生产只读不能证明每种角色/待办组合；无逐项生产按钮写入验证 |
| 商品目录 | 搜索框、关键词大小写/空格、添加日期筛选、无结果/空店、重置、分页、商品摘要数字 | fixture Playwright 搜索筛选 1/1；商品数据单测 21/21 | 商品详情所有编辑控件和生产搜索组合未逐项验证；完整商家浏览器矩阵仍有边界 |
| 商品详情 / 商品知识 | 商品与素材绑定、资料审核、revision CAS、租户/角色拒绝、审计、待索引状态 | 商品知识 e2e 1/1；模块单测 19/19；本地 MCP 工具合同 | 不能证明生产工作区实际数据或索引 worker 的端到端状态；高风险写操作未对生产执行 |
| 商家成员 | 页面路由、工作区成员读写、邀请、角色调整、停用、并发签发 MCP token | 隔离浏览器实际登录后完成邀请、角色调整、停用；4 个并发 MCP token 签发均为 200，browserErrors=[] | 不覆盖跨工作区越权和邀请邮件交付；跨工作区 A→B→A 浏览器验证仍在进行 |
| 商家任务 / 内容 | 任务列表、搜索、状态/平台筛选、任务详情和生成/审核路径 | `/v1/tasks` 非法筛选返回 400，OpenAPI 与定向 API 契约覆盖 | 商家 UI 每个状态的按钮、生成任务成功和付费模型链路未全部浏览器验收 |
| 商家发布 | 发布页导航、渠道/任务状态显示与发布流程入口 | 路由登记与发布 API/OpenAPI 合同核对 | 真实渠道授权、发布确认、回调/线上状态及每个按钮未在生产验证 |
| 商家财务 / 用量趋势 | 日期草稿、查询应用、重置；套餐权益单位及数据格式 | 状态测试 3/3；财务/导航定向测试在验证清单中 | 生产存在“实际消耗”正数语义疑问；未核实账本权威口径，也未改生产账本 |
| 素材库 / 预览 / 回收站 | 预览打开与关闭、Escape 与焦点返回；下载授权；恢复/删除部分冲突、准确确认词、撤销清理和弹层焦点陷阱 | 扩展后的回收站 Playwright 1/1；预览 Escape/焦点专测 4/4；资产下载隔离 PostgreSQL 1/1；回收站状态单测各 3/3 | 浏览器中的 `/api/mcp` 轮询在隔离 fixture 返回 404；本测试没有验证插件在线。对象存储仍是 mock |
| 品牌资产 / 上传 | Logo 上传拒绝、错误状态、同一文件重选重试与成功引用状态 | 本地 mock 浏览器重试专测 1/1，已接入素材浏览器 runner | 未验证真实对象存储/扫描 worker；生产只读检查不能替代写路径验收 |
| 商家规则 / 类目 | 搜索规范化、平台类目过滤、结果数量、`/merchant/rules` 直达与字段模板标题 | 原规则搜索测试 3/3；category discovery 回归在路由校正后 4/4 | 所有规则编辑/发布按钮未在真实商家租户逐项覆盖；无真实租户规则编辑/发布浏览器闭环 |
| 运营总览、用户、商家、规则 | 实际导航按钮、路由授权、拒绝恢复、用户目录账号归属筛选 | Ops 桌面矩阵 1/1；导航单测 13/13；拒绝恢复 3 文件 15 项；用户目录组件 20/20 | 用户目录默认仅商家账号；缺少 `identity.read` 时请求 guard 生效，搜索、状态/归属筛选、查询、刷新控件均禁用。隔离浏览器已验证查询后表格出现平台账号；无权限 UI 状态尚未浏览器覆盖 |
| 运营财务、交付、存储、审计 | 次级导航权限过滤、路由页面数据展示和 Models 退役状态 | 真实桌面隔离矩阵覆盖这些路由；导航 13/13 | 验收覆盖了代表性路由和主操作，不代表每张表格每行操作均完整遍历；生产授权用户页面不可用 |
| 运营客服工单 | 新建、分配、状态变更、添加备注写操作权限 | 权限定向组件测试 2 个文件 8/8 | 无独立浏览器/真实 API 角色矩阵；服务端仍是最终授权边界 |
| 运营模型矩阵 | 文本/图片/图片编辑等模型通道数据字段映射 | API 返回独立 `image_edit_model`；矩阵组件/契约测试已更新；Ops Console 全量 TypeScript 检查通过 | 真实中转鉴权、用量、成本和故障证据仍受生产证据阻断 |
| 运营公共规则详情 | 异常内容边界、快速切换详情时的请求竞态 | 异常内容边界与详情竞态浏览器用例通过；Ops Console 全量 TypeScript 检查通过 | 未覆盖真实运营用户、多租户生产数据下的规则批准/发布 |
| API / 搜索、任务筛选 | 商品搜索布尔参数、任务 `state`/`platform` 参数校验、OpenAPI 合同 | 更新后的商品/任务 HTTP 定向测试 12/12；repository 搜索测试 14/14；OpenAPI 合同 6/6；`/v1/products` 与 `/v1/tasks` 文档补充 401 | 其他 query 参数与所有 API 过滤组合未穷举；本矩阵不声称全 API 参数穷举 |
| API / 商品筛选 | `facts_confirmed` 和 `platform` 参数白名单及早期拒绝 | API agent 报告商品列表定向文件 10/10 | 搜索全组合及真实生产数据分布未穷举 |
| 图像/视频任务 | 商品图工作流参考、视频规划约束、stdio permission denial | 安装契约 1/1；新视觉权限拒绝 e2e 1/1（共享记录） | 权限拒绝测试证明 fixture 下 fail-closed，不证明授权成功生成；无 provider、扣费、任务轮询成功或归档证据 |

### 插件图像与视频技能调研结论

插件源中增加了 `references/product-image-workflow.md`，并列入本地打包工具的 required 拷贝清单；内容引用公开的 `ecommerce-image-skills` 与 `ec-visual-skill` 思路，将商品身份锁定、买家决策顺序、渠道规则来源/版本、真实性检查写成工作流指导。主技能补充跨镜头一致性、镜头衔接和声音方案约束。现有 `ecommerce-video-marketing` 技能继续承接脚本/分镜方法。manifest 与 required 清单包含这些本地技能；新技能安装在本机 QA 缓存，source inventory 134/134 一致，缺配置返回 `MCP_CONFIGURATION_REQUIRED`。缓存保持 disabled；启用的 `@personal` 还是旧版。这里增强的是内容指导，不是增加图像/视频 renderer、模型或真实生成能力；ChatGPT 宿主加载、provider 成功、用量/成本与成片归档仍未实测。

这属于提示/工作流能力增强，并未新增图像或视频模型本身。没有把第三方 CLI/provider/API、密钥或绕过业务中转的生成链路装进插件；真实生成仍必须走 Store Nova MCP、鉴权、角色权限、成本/用量、扫描和归档链路。权限拒绝 e2e 1/1 只证明拒绝时没有回退调用，不能当作生成成功证据。

## 发现

| 优先级 | 发现 | 证据与处理 |
|---|---|---|
| 高 | 商家生产商品区可见 Demo/QA 名称记录，另有零库存、零规格、零价格记录。 | 线上登录态只读检查观察到，属于生产数据隔离/导入治理问题。未删除或更改数据；需核查来源并通过受审计的数据流程处置。 |
| 高 | 不能证明真实 ChatGPT 宿主下的图片生成与视频成片链路。 | MCP fixture/合同测试通过，但真实 provider 成功、任务查询、用量/成本、扫描和归档证据缺失。健康状态不能替代成片验收。 |
| 高 | 生产 capability 与 capacity 证据为 blocked。 | `https://yxsona.com/api/healthz` 与运营健康端点返回 HTTP 200、服务状态 ok；健康数据报告 `CAPABILITY_EVIDENCE_PATH`、`CAPACITY_REPORT_PATH` 无法读取。保存于 2026-10-09 01:48Z 的只读健康收据记录线上 `release-b92b954d`；03:46Z 的只读门禁健康收据记录 `release-c337ae2e`、relay 与五模态 setup/cost gate configured/ready。阶段收据仍标记 `formal_go=false`，capability/capacity 证据文件仍 blocked/unreadable；credentialed workflow、规范 Keychain 读取、扫描 canary、同任务视频归档和正式容量证据尚待验收。本工作区 HEAD `2dcb9678` 不等于生产 SHA `c337ae2e`，因此本轮未提交改动不在该生产版本中。健康与 setup 字段不能证明鉴权业务调用、实际用量/成本或成片。 |
| 中 | 财务“实际消耗”为正值，而点数变动可能被理解为增加。 | 线上只读观察到正值与负数预留并存。未核实账本权威符号/列定义，未改动符号。 |
| 高 | 支付链接验证曾接受 HTTP 与嵌入式账号密码。 | Ops 与商家客户端已拒绝 HTTP/userinfo；Ops UI 保留 provider 合同中的 HTTPS、`weixin://`、`alipays://` 精确 scheme，并拒绝 `fixture://` 和 `fixture.invalid`。服务端 provider/存储校验目前仅做协议前缀匹配，仍可能接收 userinfo、`fixture.invalid` 或格式不完整的值，未与 UI allowlist 统一。生产 provider 返回值及深链在桌面 OS 的实机行为仍未验证；扩展后的目标测试正在等待共享 safe-test 锁，尚未记为通过。 |
| 中 | 目录未知数值被误显示为 0。 | 本轮将商品摘要数值转换收紧为只接受 number/string，避免 null/空值/boolean 被 JavaScript 数字转换误判为有效 0；真实 0 仍保留。目录数据单测文件 21/21 通过。 |
| 中 | 任务列表筛选非法值会静默形成空结果。 | `/v1/tasks` 对 `state` 与 `platform` 采用白名单校验，并在 OpenAPI 描述 400；任务列表白名单定向测试 6/6、商品/任务联合定向测试 9/9、更新后的 OpenAPI 合同 6/6。 |
| 中 | 模型矩阵把图片编辑通道展示成普通图片模型。 | API 增加独立 `image_edit_model` 映射，前端按专属字段展示；Ops Console TypeScript 检查通过，目标矩阵测试已有 agent 通过记录。 |
| 中 | 运营事件页代码、页面闭环矩阵、路由清单不一致。 | `IncidentsPage` 与客户端存在但路由清单没有 incidents；矩阵把事件列为 workspace 范围。不能在权限未澄清时直接挂到 platform 控制台。 |
| 中 | 全仓默认 `npm test` 尚无一次性通过证据。 | 8 分片全量调用中，分片 3/8、5/8 完整通过；1、2、4、7、8 触及每分片 300 秒上限；分片 6 被当时的 handler 语法错误和 stale OpenAPI/pending 清单阻断。修复后，18 个原加载失败文件 101/101 通过；仅重跑失败/超时分组的 16 分片中，7、8、12、16 完整通过，9/10/15 的确定性问题已修复并针对性复验，1/2/4 仍触及运行预算。多个 5 秒单测在资源竞争下超时，相关文件提高预算单独验证通过。 |
| 中 | 仍有 13 个 Playwright spec 未接入命名的 `test:browser:*` runner。 | 当前 `tests/browser-gate-entrypoints.test.ts` 配置型未调度清单为 13 个；账户归属用例已进入专用隔离 runner 和 `test:browser:all`，隔离 Playwright 1/1 通过。剩余 spec 涉及生产只读、多角色 token、真实扫描器、手工运营授权或隔离业务写入；未把配置匹配本身计作覆盖。账户标签是另一条 spec，已有隔离通过证据。 |
| 中 | Ops 仍有路由闭环与测试身份契约缺口。 | 新增权限过滤的财务/存储/审计次级入口，OpsSidebar 13 项测试通过；Models 明确退役。Ops 现为 platform-only，members/tasks/knowledge workspace-only 页面仍留在注册表但不能由 OpsShell 激活；Incidents 页面代码未挂载且不属于当前 domain。未接 runner 的 MCP browser spec 引用 workspace 场景，与当前拒绝行为冲突。Stores 品牌店铺的“打开任务”回调只在非 platform 分支出现，目标 tasks 会被守卫拒绝，仍需正确 workspace 身份复现；客服详情的“回到任务队列”死链已改回可达 `/ops/support`，保留 URL 编码的 task_id，组件测试 6/6。 |
| 中 | Ops 403 恢复按钮可能把无用户权限的角色送回同一拒绝页。 | 支持角色没有 `users` 权限；从旧链接进入 `/ops/users` 后，原按钮固定返回用户中心，形成循环。已修复为按授权投影和当前工作台可达性选择恢复路由，无可达目标时隐藏按钮。3 个测试文件、15 项通过，包含实际点击从 `/ops/users` 回到总览。 |
| 低 | `KnowledgeGovernanceSection.readState` 在全套高负载运行中有一项超过 5 秒。 | 独立复验文件 7/7 通过，目标用例耗时 551ms；当前没有产品回归证据。 |
| 中 | 品牌 Logo/文档上传的延迟响应会覆盖上传期间编辑的用户画像或品牌卖点。 | `MaterialBrandFields.uploadBrandAsset` 曾在 `await uploadAsset` 后合并启动时捕获的 `value`；现改为合并最新 draft。延迟上传浏览器回归 1/1 通过：上传等待时编辑全局用户画像，响应后内容保留。待上传列表现以唯一 ID 管理，并在超限时拒绝整批新增、显示未加入数量；其目标测试 3/3 通过。 |

## 验证

- 本轮修复 bridge 错误合同测试中 4 处可选响应索引类型问题后，`npm run typecheck` 完成且无错误；Ops Console 与 Merchant Studio 生产构建均通过。
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
- 插件视觉工作流安装契约 1/1：检查源技能文件、required 拷贝清单和本地 stdio `tools/list` 的工具暴露；尚未实测实际本地安装包解包或原生 ChatGPT 安装，也未调用生成工具/provider。
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
- 2026-10-09 03:46Z 公网健康收据显示 relay/setup 与成本门禁 ready，但阶段记录仍无 formal Go；工作区当前改动未发布到生产（生产 release SHA `c337ae2e` 与当前 HEAD `2dcb9678` 不同）。
- 全仓默认 `npm test` 未在一次调用内完整验证；`test:release-gates` 当前工作树门禁已通过，但未纳入 browser runner 的其余配置型 Playwright spec 尚未逐项完整重跑/接入。需要独立角色账号或写入 fixture 的用例仍不能安全连生产。
- 较早的工作树快照有过 `SAFE_TEST_TIMEOUT_MS=900000 npm run test:release-gates` 通过收据（runtime 前置 23/23、PG16 migration 1/1、181 个测试文件通过、7 个声明跳过文件、1532 项断言通过、16 项登记 pending、Node gates 168/168）。它不覆盖本轮之后的改动，不能作为当前最终工作树的完整 release gate 证明。测试全绿也不等于可以部署：本地工作区尚未冻结候选身份/manifest；101 报告中的运行 SHA `c337ae2e` 与本地 HEAD 不同，`release_approved=false`、`formal_production_approved=false`。能力/容量证据路径不可读，embedding 未就绪，五模态真实 provider 用量/成本回执缺失；因此当前候选尚未发布，未执行生产部署。本轮插件 candidate tar 仍需在提交并冻结候选后重新生成。

登录页截图位于 [`artifacts/qa-evidence/gstack-full-review-2026-10-09/`](../../artifacts/qa-evidence/gstack-full-review-2026-10-09/)。隔离 PostgreSQL 与运营浏览器结果在 `artifacts/isolated-postgres/`、`artifacts/ops-jit-isolation/`。四个临时 worktree 已审计：资产下载、规则上传、规则详情 UI 补丁已整合；只更新迁移尾断言至 269 的 worker 补丁已过时，因为当前迁移链已更后。临时 worktree 已移除，主工作目录为唯一 worktree。

本轮增量复验：客服建单失败保留表单并复用重试幂等键浏览器 1/1；Ops search/race/filter/rule 浏览器与 Ops controller 共 27 项通过；video settlement 9/9、MCP contracts 48/48、商家 session/task/product/publish 定向测试均通过；bridge 错误合同 10/10。定向批次曾有一项店铺筛选源码断言落后实现，修正后该文件 3/3。`npm run typecheck`、Ops Console 与 Merchant Studio 生产构建通过。视频响应现仅在 clean scan 返回 `download_path`。商家成员隔离 E2E 已通过邀请、角色调整、停用与并发 token 签发；结果见本轮增量记录。

### 本轮新增发现与修复

- 素材回收站浏览器旅程扩展到部分恢复冲突、彻底删除的原因/准确确认文本、部分清理冲突保留选择，以及撤销清理请求；Playwright 1/1 通过。隔离页面同时向缺失的本地 `/api/mcp` 轮询地址发出 404，因此该次测试不能记作零控制台错误或插件在线验收；两个 409 是明确模拟的服务端冲突。
- 发布历史在刷新后总数缩小时修正到有效页，独立本地浏览器回归 1/1 通过；已为其增加 `test:browser:merchant:publish-history` 并接入 `test:browser:all`，browser-entrypoint ledger 单测 20/20 通过。
- 插件回跳采用已验证 pairing workspace，并校验当前选择及 installation key 一致；session probe 遇网络错误时出现可重试错误状态。针对性测试：插件连接 11/11，登录/会话错误展示 6/6。
- Merchant Studio 商品店铺筛选改用 `platform + account_id` 复合值，避免不同平台同一远端账号 ID 串店；服务端和 SQL 搜索新增平台 slug 与中文平台名匹配。平台 slug/中文名搜索有独立 API/repository 定向回归；搜索专项测试明细见验证段，未在生产数据上穷举组合。
- Postgres 商品/任务的通用 query、storeName、brandName LIKE 搜索现在把 `%`、`_`、反斜杠和 `!` 当作字面字符；店铺/品牌过滤值先 trim，brandName 同时匹配商品属性与 workspace canonical brand profile，以对齐 service fallback。新增特殊字符组合 4 项、过滤语义 SQL 6/6、Service fallback 2/2 通过；通用 LIKE 与商品编码此前 9 项通过。query 纯空格输入的 durable/fallback 一致性目标测试 11/11 已通过（service + persistence 两文件）；repository SQL 使用 RecordingClient 验证，未在真实 PostgreSQL 执行。
- 品牌素材上传响应按最新草稿合并字段，延迟上传完成时不再覆盖同时编辑的用户画像。延迟浏览器回归 1/1 通过。
- Ops 规则审计包切换和 workspace A→B 时以请求序号隔离旧 RPC 响应；企业目录提交查询后重置分页、审计过滤立即取消旧列表/详情/导出请求并清空旧状态。延迟 RPC/浏览器回归 2 文件 4 项通过，覆盖旧 list 和 export 的迟到响应。
- Finance 搜索字段由误导的“企业名称或 Workspace”改为真实支持的 Workspace ID，并为分隔符解析增加测试。客服创建失败状态留在弹窗、保留输入，并在失败重试中复用同一幂等键；创建期间禁关闭，创建成功后的刷新失败不再误报为创建失败。修正隔离浏览器 harness 后目标回归 1/1 通过；仍是内存模型 fixture，不证明真实 API/权限/数据库幂等。规则激活校验 rejection 被安全处理、纯空白理由被拒绝；Rule browser 测试 2/2 通过。退款已加确认前 single-flight 保护、定向测试 2/2。SLA 刷新/失败会标明旧快照并禁用 correction；切换 workspace 时隐藏上一工作区报告指标、周期和 checksum，并提示旧快照已隐藏，跨工作区 correction 被阻断；组件/SSR与源契约定向测试 8/8。真实 workspace 并发请求仍未后端 E2E 验证。工单列表的 scanTruncated 提示透传和队列测试 4/4；真实 API 扫描上限与跨页完整性仍未端到端验证。
- Merchant Studio 任务详情状态守卫复用共享 `TASK_STATES`，并只在 UI 显示/处理层保留旧 `content_generated` 防御分支；DB CHECK、共享 canonical enum 与 MCP `task.history` enum 均不含该旧状态，未查询真实生产数据库，不能断言历史数据中绝无该值。阻塞状态显示事实确认进度，列表总数缩小时修正页码。取消任务和 `failed_terminal` 的重试语义尚未确定。插件 bridge `task.history` schema 已与 `TASK_STATES` 完全同步，source/mirror parity 以及 159 项 bridge 测试通过。应用 service 内仍保留较窄 TaskState 类型，暂未统一。
- 发布历史若 `state=reconciling` 但 `remoteState=published`，现同时展示“平台已发布”和“任务对账未结案”，阻止重复提交；组件测试 1/1。发布成功后固定跳回商品页，用户需再找任务记录，保留为导航改进项。
- 尚未修复/验收的确定/高可信缺口：Ops Workspace stores 的品牌店铺“打开任务”回调导向 platform-only workbench，需在正确工作区上下文浏览器复现。Merchant Studio 品牌/规则保存取消、店铺连接、素材上传目标切换等仍缺完整的多店浏览器旅程。文件待上传使用独立 ID、超限整批拒绝并显示未加入数量，3/3；上传期间禁止关闭弹窗；卸载时 abort 上传并阻断迟到响应污染，同时释放 preview URL，上传目标回归 7/7；预览生成失败不会把服务端已确认上传误报成失败。仍存在响应不确定性：超时/卸载后的 AbortError 不证明服务端未持久化；当前界面可能报失败并保留待传文件，重试依赖内容哈希去重，非可信素材可能重新扫描/修订。未验证“服务端提交后断开响应”，需通过资产列表/状态回查确认。实际上传路由/代理有效文件大小限制待核验，不在 UI 猜阈值；商品页码 clamp 2/2；退款 single-flight 2/2；合同外链打开前复用 HTTPS validator，违规 userinfo/hash/non-default-port 不会调用 window.open，定向测试 1/1；该外链 UI guard 比 MCP 下载入口多拒绝 `%5c` 与 Unicode Cf，服务端入口另有 DNS/IP/TLS 防护；两处语法 guard 不完全一致，未证明为绕过，安全边界以服务端校验为准。Ops 充值链接 HTTP/userinfo 验证修复已覆盖基础目标测试 20/20；入口合同的最新运行证据需继续核对。商家成员邀请/角色/停用隔离旅程现已通过，跨工作区 selector 浏览器旅程仍在补验。
- 评审覆盖盘点确认 `test:browser:all` 是明确命名的页面子集，不是逐个点击全项目每个按钮。尚欠的高风险浏览器旅程包括任务创建到审核/发布、品牌/规则保存与取消、财务退款决策、真实角色下客服分配/回复/关闭及退款闭环、知识导入/审核、套餐购买/通知、店铺/平台连接、规则和知识运营表单等。13 个 config-only specs 仍不代表已调度执行。
- 电商技能调研采用公开 GitHub 技能作为方法参考并继续维护在项目本地插件内；未安装依赖第三方 provider/API key 的脚本。现有视频技能增加“无事实证据则删去或标待核验”及镜头时长之和精确等于用户目标时长，QA cache source/installed hashes一致。QA 插件已安装但 disabled，`@personal` production bundle 尚未替换；也未宣称 ChatGPT 宿主已加载新技能。
