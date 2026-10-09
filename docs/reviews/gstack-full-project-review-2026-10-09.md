# Store Nova 项目全量评审

日期：2026-10-09
范围：ChatGPT 本地 stdio 插件、MCP/API、商家工作台、桌面运营台、模型中转、租户权限、生产健康和可运行测试。按项目 `AGENTS.md` 未进行生产写操作、部署或真实付费模型调用。

本轮完成了大范围代码、隔离 API、MCP、本地浏览器 fixture 和 gstack dogfood/design 走查；本报告不声称每个生产页面和每条付费业务链路都已通过。需要生产运营身份、原生 ChatGPT 宿主、真实中转图片/视频输出的环节仍未验证。

## 修改

- 套餐权益与目录摘要改用统一中文单位格式，修复 `2business_hour`、`12500creative_points` 和重复拼接 `GB`。不改变服务端权益或账本数据。
- 概览低库存/缺主图待办在旧指标缺少 `entityType` 时仍可将商品标题作为搜索词跳转到商品目录；标题不作为商品 ID。
- 新增商品目录关键词、近 7 天添加筛选、无匹配反馈、重置与分页浏览器回归，并纳入 merchant candidate runner。修复同页 Ant Design `Space.direction` 弃用警告。
- 修复 PostgreSQL RLS 攻击矩阵：事务固定在同一 `PoolClient`；预期拒绝的写入通过 savepoint 回滚。
- 修复浏览器入口：将商品风险跳转 Playwright spec 纳入 merchant 隔离 runner；移除错误传入 Playwright 的 Vitest 文件，改用真正的浏览器 spec。
- 新增隔离资产下载授权/对象读取 PostgreSQL 验收、运营公共规则 Markdown 上传浏览器验收，以及公共规则详情异常格式的 UI 边界回归测试。
- 修正默认测试 suite 的 PostgreSQL pending 白名单：移除会在无数据库时直接失败的资产下载用例；创意点并发撤销用例保留精确 pending，并加入隔离 PostgreSQL runner 与 CI 验收清单。
- 电商商品图参考增加商品身份锁定、买家决策顺序、渠道规则核对、真实性复核；视频策划增加跨镜头一致性、转场/动作衔接、声音方案合同。实际生成仍走 Store Nova MCP、中转鉴权、权限、成本/用量及扫描归档门禁；未引入第三方 provider/API/CLI 或本地生成脚本。已同步安装包和 marketplace 镜像。
- 外部技能调研：审阅了 [Ecommerce Image Workflow](https://github.com/nexu-io/open-design/blob/main/skills/ecommerce-image-workflow/SKILL.md)、[E-Commerce Video Marketing](https://github.com/nexscope-ai/eCommerce-Skills/blob/main/ecommerce-video-marketing/SKILL.md) 和 [Amazon Product Photography](https://github.com/nexscope-ai/Amazon-Skills/blob/main/amazon-product-photography/SKILL.md)。采纳参考图保真、镜头/图片规划和交付复核要点，写入本地插件技能；未原样安装会调用 Open Design 私有 CLI/外部 provider 的工作流，也未接入带强制营销导流的外部手册，以免绕过本项目 MCP、中转权限和审核门禁。
- 商家财务趋势把日期和周期改为草稿；点“查询”才应用，重置恢复默认区间。此前日期变动即时过滤而查询按钮没有行为。
- 商家通知下拉和风险详情根据接入模式使用与概览一致的安全提示；手动接入时不再要求“重新发起官方授权”。规则与类目搜索统一去空格并忽略大小写。
- 修复回收站提前彻底删除失败后的丢失确认状态：仅全部受理才关闭；部分成功时从选择中移除受理项并保留失败项、原因和确认词。另为成功空回收站添加 `role=status` 状态通知。新增状态回归 3/3、回收站服务端状态 3/3 通过；这两条仍缺浏览器交互覆盖。
- Ops 新增权限过滤的“运营数据与审计”次级导航，接入财务、存储和审计；Models 仍按退役状态隐藏，工作区专属域仍按身份边界隔离。
- MCP 新增商品知识读取/审批方法并补齐 OpenAPI、发布元数据及源/marketplace 测试镜像。审批使用 revision CAS、租户与角色校验、追加审计；回放只验证治理事件，不把商品事实错误投影到旧知识资产中。
- HTTP 商品搜索 `GET /v1/products` 的 `facts_confirmed` 现在严格只接收 `true|false`；非法值在工作区解析和数据库查询之前返回 `INVALID_REQUEST`，避免静默变成错误筛选。新增 API 回归 3/3 通过。
- 补上商品知识列表 handler 缺失的 `catch`，修复导致 19 个 API/MCP 测试套件无法加载的语法阻断；完整定点复验这些原失败套件。
- 默认 PostgreSQL 测试 pending 清单增加新合同租户 RLS 用例；CI 文件分母新增两个 RLS 回归文件。

## 页面与交互覆盖矩阵

矩阵记录的是本轮实际走查/自动化验证到的表面及其边界，不把源码存在、路由可配置或 mock 测试计作真实运行覆盖。按钮与表单项以所在页面的实际旅程列示；这不是“每个可见控件均已在生产逐一点击”的声明。

| 应用/页面 | 本轮核对的导航、控件和数据面 | 证据状态 | 未覆盖/已知缺口 |
|---|---|---|---|
| ChatGPT 本地插件入口 / MCP 工具 | stdio initialize、tools/list、调用桥接、身份绑定、权限拒绝；视觉生成和视频请求的拒绝路径 | 本地插件安装/manifest/bridge 合同；源与 marketplace 镜像同步 | 原生 ChatGPT 宿主不可控；没有真实角色授权、付费 provider 成片或宿主 UI 验收 |
| 商家概览 | 待办指标、低库存/缺主图跳转、通知/风险提示、导航 | 浏览器风险目的地测试；生产只读检查概览 | 生产只读不能证明每种角色/待办组合；无逐项生产按钮写入验证 |
| 商品目录 | 搜索框、关键词大小写/空格、添加日期筛选、无结果/空店、重置、分页、商品摘要数字 | fixture Playwright 搜索筛选 1/1；商品数据单测 21/21 | 商品详情所有编辑控件和生产搜索组合未逐项验证；完整商家浏览器矩阵仍有边界 |
| 商品详情 / 商品知识 | 商品与素材绑定、资料审核、revision CAS、租户/角色拒绝、审计、待索引状态 | 商品知识 e2e 1/1；模块单测 19/19；本地 MCP 工具合同 | 不能证明生产工作区实际数据或索引 worker 的端到端状态；高风险写操作未对生产执行 |
| 商家成员 | 页面路由、工作区成员读写、邀请、角色调整、停用、并发签发 MCP token | 专用隔离 PostgreSQL/密码登录 E2E 脚本已纳入 `test:browser:merchant:members` 与 `test:browser:all`；脚本边界已审查，当前未运行 | 浏览器/数据库通过证据待当前 Ops 隔离测试结束后运行；不覆盖跨工作区越权和邀请邮件交付 |
| 商家任务 / 内容 | 任务列表、搜索、状态/平台筛选、任务详情和生成/审核路径 | `/v1/tasks` 非法筛选返回 400，OpenAPI 与定向 API 契约覆盖 | 商家 UI 每个状态的按钮、生成任务成功和付费模型链路未全部浏览器验收 |
| 商家发布 | 发布页导航、渠道/任务状态显示与发布流程入口 | 路由登记与发布 API/OpenAPI 合同核对 | 真实渠道授权、发布确认、回调/线上状态及每个按钮未在生产验证 |
| 商家财务 / 用量趋势 | 日期草稿、查询应用、重置；套餐权益单位及数据格式 | 状态测试 3/3；财务/导航定向测试在验证清单中 | 生产存在“实际消耗”正数语义疑问；未核实账本权威口径，也未改生产账本 |
| 素材库 / 预览 / 回收站 | 预览打开与关闭、Escape 与焦点返回；下载授权；彻底删除失败保留选择和确认语、成功空态播报 | 素材预览 Escape/焦点专测 1/1（含两张待上传图片）；资产下载隔离 PostgreSQL 1/1；回收站状态单测各 3/3 | 回收站部分失败/空态仍缺专门浏览器交互覆盖；预览测试是 mock，不覆盖真实对象存储 |
| 品牌资产 / 上传 | Logo 上传拒绝、错误状态、同一文件重选重试与成功引用状态 | 本地 mock 浏览器重试专测 1/1，已接入素材浏览器 runner | 未验证真实对象存储/扫描 worker；生产只读检查不能替代写路径验收 |
| 商家规则 / 类目 | 搜索规范化、规则内容与状态 | 搜索测试 3/3；商品风险与规则详情浏览器验收记录在验证节 | 所有规则编辑/发布按钮未在真实商家租户逐项覆盖 |
| 运营总览、用户、商家、规则 | 实际导航按钮、路由授权、拒绝恢复、用户目录账号归属筛选 | Ops 桌面矩阵 1/1；导航单测 13/13；拒绝恢复 3 文件 15 项；用户目录组件 20/20 | 用户目录默认仅商家账号；缺少 `identity.read` 时请求 guard 生效，搜索、状态/归属筛选、查询、刷新控件均禁用。隔离浏览器已通过首屏商家归属和平台账号选项选择，但 spec 缺少点击“查询”，未切换表格结果；已修正 spec，等待现有测试进程结束后再次运行；无权限 UI 状态尚未浏览器覆盖 |
| 运营财务、交付、存储、审计 | 次级导航权限过滤、路由页面数据展示和 Models 退役状态 | 真实桌面隔离矩阵覆盖这些路由；导航 13/13 | 验收覆盖了代表性路由和主操作，不代表每张表格每行操作均完整遍历；生产授权用户页面不可用 |
| 运营模型矩阵 | 文本/图片/图片编辑等模型通道数据字段映射 | API 返回独立 `image_edit_model`；矩阵组件/契约测试已更新；Ops Console 全量 TypeScript 检查通过 | 真实中转鉴权、用量、成本和故障证据仍受生产证据阻断 |
| 运营公共规则详情 | 异常内容边界、快速切换详情时的请求竞态 | 异常内容边界与详情竞态浏览器用例通过；Ops Console 全量 TypeScript 检查通过 | 未覆盖真实运营用户、多租户生产数据下的规则批准/发布 |
| API / 搜索、任务筛选 | 商品搜索布尔参数、任务 `state`/`platform` 参数校验、OpenAPI 合同 | 商品搜索及任务查询新定向测试文件 9/9，覆盖 business 与 service fallback；加入产品参数 400 后 OpenAPI 合同全文件 6/6 | 其他 query 参数与所有 API 过滤组合未穷举；本矩阵不声称全 API 参数穷举 |
| 图像/视频任务 | 商品图工作流参考、视频规划约束、stdio permission denial | 安装契约 1/1；新视觉权限拒绝 e2e 1/1（共享记录） | 权限拒绝测试证明 fixture 下 fail-closed，不证明授权成功生成；无 provider、扣费、任务轮询成功或归档证据 |

### 插件图像与视频技能调研结论

插件源中增加了 `references/product-image-workflow.md`，并列入本地打包工具的 required 拷贝清单；内容引用公开的 `ecommerce-image-skills` 与 `ec-visual-skill` 思路，将商品身份锁定、买家决策顺序、渠道规则来源/版本、真实性检查写成工作流指导。主技能补充跨镜头一致性、镜头衔接和声音方案约束。现有 `ecommerce-video-marketing` 技能继续承接脚本/分镜方法。合同测试检查了清单、主技能引用和本地 stdio 工具暴露；还没有解包实际生成的插件包或验证原生 ChatGPT 安装。

这属于提示/工作流能力增强，并未新增图像或视频模型本身。没有把第三方 CLI/provider/API、密钥或绕过业务中转的生成链路装进插件；真实生成仍必须走 Store Nova MCP、鉴权、角色权限、成本/用量、扫描和归档链路。权限拒绝 e2e 1/1 只证明拒绝时没有回退调用，不能当作生成成功证据。

## 发现

| 优先级 | 发现 | 证据与处理 |
|---|---|---|
| 高 | 商家生产商品区可见 Demo/QA 名称记录，另有零库存、零规格、零价格记录。 | 线上登录态只读检查观察到，属于生产数据隔离/导入治理问题。未删除或更改数据；需核查来源并通过受审计的数据流程处置。 |
| 高 | 不能证明真实 ChatGPT 宿主下的图片生成与视频成片链路。 | MCP fixture/合同测试通过，但真实 provider 成功、任务查询、用量/成本、扫描和归档证据缺失。健康状态不能替代成片验收。 |
| 高 | 生产 capability 与 capacity 证据为 blocked。 | `https://yxsona.com/api/healthz` 与运营健康端点返回 HTTP 200、服务状态 ok；健康数据报告 `CAPABILITY_EVIDENCE_PATH`、`CAPACITY_REPORT_PATH` 无法读取。线上 release SHA 与本地 `main` 不同，当前候选没有部署。 |
| 中 | 财务“实际消耗”为正值，而点数变动可能被理解为增加。 | 线上只读观察到正值与负数预留并存。未核实账本权威符号/列定义，未改动符号。 |
| 中 | 目录未知数值被误显示为 0。 | 本轮将商品摘要数值转换收紧为只接受 number/string，避免 null/空值/boolean 被 JavaScript 数字转换误判为有效 0；真实 0 仍保留。目录数据单测文件 21/21 通过。 |
| 中 | 任务列表筛选非法值会静默形成空结果。 | `/v1/tasks` 对 `state` 与 `platform` 采用白名单校验，并在 OpenAPI 描述 400；任务列表白名单定向测试 6/6、商品/任务联合定向测试 9/9、更新后的 OpenAPI 合同 6/6。 |
| 中 | 模型矩阵把图片编辑通道展示成普通图片模型。 | API 增加独立 `image_edit_model` 映射，前端按专属字段展示；Ops Console TypeScript 检查通过，目标矩阵测试已有 agent 通过记录。 |
| 中 | 运营事件页代码、页面闭环矩阵、路由清单不一致。 | `IncidentsPage` 与客户端存在但路由清单没有 incidents；矩阵把事件列为 workspace 范围。不能在权限未澄清时直接挂到 platform 控制台。 |
| 中 | 全仓默认 `npm test` 尚无一次性通过证据。 | 8 分片全量调用中，分片 3/8、5/8 完整通过；1、2、4、7、8 触及每分片 300 秒上限；分片 6 被当时的 handler 语法错误和 stale OpenAPI/pending 清单阻断。修复后，18 个原加载失败文件 101/101 通过；仅重跑失败/超时分组的 16 分片中，7、8、12、16 完整通过，9/10/15 的确定性问题已修复并针对性复验，1/2/4 仍触及运行预算。多个 5 秒单测在资源竞争下超时，相关文件提高预算单独验证通过。 |
| 中 | 仍有 18 个 Playwright spec 未接入命名的 `test:browser:*` runner。 | 当前 `tests/browser-gate-entrypoints.test.ts` 固定列出 18 个配置型未调度 spec；账户归属用例已进入专用隔离 runner 和 `test:browser:all`，修复后的单例结果尚未出炉。剩余 spec 涉及生产只读、多角色 token、真实扫描器、手工运营授权或隔离业务写入；未把配置匹配本身计作覆盖。账户标签是另一条 spec，已有隔离通过证据。 |
| 中 | Ops 仍有路由闭环与测试身份契约缺口。 | 新增权限过滤的财务/存储/审计次级入口，OpsSidebar 13 项测试通过；Models 明确退役。Ops 现为 platform-only，members/tasks/knowledge workspace-only 页面仍留在注册表但不能由 OpsShell 激活；Incidents 页面代码未挂载且不属于当前 domain。一个未接 runner 的 MCP browser spec 引用了不存在的 `openWorkspaceConsole` 并包含冲突的 workspace 测试。需要确认页面归属/旧 spec 去留，未擅自编造 workspace 登录或改路由。 |
| 中 | Ops 403 恢复按钮可能把无用户权限的角色送回同一拒绝页。 | 支持角色没有 `users` 权限；从旧链接进入 `/ops/users` 后，原按钮固定返回用户中心，形成循环。已修复为按授权投影和当前工作台可达性选择恢复路由，无可达目标时隐藏按钮。3 个测试文件、15 项通过，包含实际点击从 `/ops/users` 回到总览。 |
| 低 | `KnowledgeGovernanceSection.readState` 在全套高负载运行中有一项超过 5 秒。 | 独立复验文件 7/7 通过，目标用例耗时 551ms；当前没有产品回归证据。 |

## 验证

- `npm run typecheck` 通过。
- `npm run build:ops-console`、`npm run build:merchant-studio` 通过；商家构建仍有已知的大 chunk 提示。
- `npm run audit:ops-surface` 通过：187 个 contract methods、179 个前端字面引用、0 个未引用方法。
- `npm run test:plugin-import-contract`、`npm run test:merchant-studio-smoke` 通过；smoke 明确跳过生产写流程。
- MCP/视觉路由合同测试 4 个文件、9 项通过；商品财务格式和导航测试 3 个文件、24 项通过；镜像打包针对性安装测试通过。
- 商家风险跳转浏览器验收 3/3 通过；规则详情 UI 边界浏览器验收 2/2 通过；隔离运营公共规则 Markdown 上传验收 1/1 通过。
- 商家隔离演示的商品关系、图片任务及响应式 Playwright 共 18 项覆盖：14 项通过；其余 4 项首轮因 Vite 缺少 `VITE_API_BASE_URL=/api` 而失败，补齐本地环境后只复跑这 4 项，全部通过。浏览器没有触发真实图片生成 API。
- 新增商品目录搜索/筛选 Playwright 1/1 通过；实际验证 8 条 fixture 商品的关键词过滤、近 7 天条件、无结果与空店铺区分、重置及分页。新增 runner 合同验证 `tests/browser-gate-entrypoints.test.ts` 15/15 通过；后续新增运营账户标签隔离浏览器入口，单 spec 1/1 通过，入口合同 17/17。该验收使用隔离 PostgreSQL/Redis，未写业务数据或保存凭据，并确认伪造登录身份被忽略、刷新状态保持。
- Ops 桌面全 mock Playwright 14 项通过：canonical 状态 8/8、权限矩阵 5/5、脏表单历史导航 1/1。为避免用旧访问令牌伪造登录，这些浏览器 fixture 增加当前 cookie/password-session 标记；过期与键盘退出断言已对应到当前受控会话控件。
- Ops 路由可达性更新：`OpsSidebar.test.tsx` 13/13；新次级组只显示授权路由，保留主侧栏和 Models 退役状态。浏览器矩阵已改为点击非 Models 的实际导航按钮；隔离 PostgreSQL 上的真实桌面浏览器矩阵 1/1 通过，覆盖总览、用户、商家、规则、财务、交付、存储和审计，并确认 Models 不可见且无失败 API 请求。
- 商家财务趋势草稿/应用/重置状态测试 3/3 通过；商家风险通知与详情安全文案测试 14/14 通过；规则/类目搜索大小写和空格规范化测试 3/3 通过。
- 商品知识治理 e2e 1/1、知识模块单测 19/19 通过。覆盖租户/角色拒绝、商品与资产绑定、revision CAS、仍待索引状态及唯一 before/after 审计。
- OpenAPI/MCP 方法清单、默认 PostgreSQL pending、隔离入口、CI PostgreSQL 分母和 OpsSidebar 共 6 个文件 64/64 通过；`container-source-freshness` 和 bridge B package 两个原超时文件在 30 秒单测预算下 24/24 通过。
- 插件镜像完整性：源/marketplace `bridge.test.ts` 已同步；`tests/plugin-manifest.test.ts` 7/7、`apps/plugin/install-smoke.test.ts` 29/29 通过。MCP bridge 158/158 通过，工具数和合同参数已与新增的 134 工具状态同步。
- 插件本地内容链 e2e 新运行 2 项中 1 项通过、1 项最初失败：知识未审核时 API 正确拒绝且没有调用 provider/产出内容，但 bridge 把具体的 `KNOWLEDGE_REVIEW_REQUIRED` 商家恢复提示泛化了。修复可见文本和结构化消息映射后定向用例 2/2 通过，错误码及阻断行为保留。
- 插件视觉工作流安装契约 1/1：检查源技能文件、required 拷贝清单和本地 stdio `tools/list` 的工具暴露；尚未实测实际本地安装包解包或原生 ChatGPT 安装，也未调用生成工具/provider。
- 隔离 PostgreSQL 资产下载授权验收 1/1、RLS 攻击矩阵 1/1 通过。
- `tests/ops-e2e-isolation.test.ts`、`tests/browser-gate-entrypoints.test.ts`、`tests/quality-entrypoints.test.ts` 共 84 项通过；pending 白名单与入口合同针对性复验 41/41 通过。隔离 PostgreSQL 资产下载和点数并发撤销用例 2/2 通过。
- 运营台全套运行有 163 个文件、1094 项通过及一项 5 秒超时；该超时文件随后独立复验 7/7 通过。
- `tests/ecs-demo-component-update.test.ts` 单文件 39/39 通过；该文件不在当前并行 release-gates 测试命令里。
- 回收站失败保留确认状态逻辑及空态读屏状态：各 3/3 定向测试通过；HTTP 商品搜索无效 boolean 契约 3/3；账户标签 Playwright 1/1。入口合同测试历史批次分别通过 15/15、17/17；新增 merchant-members 入口后本轮全文件 19/19 通过。
- 公网未登录运营与商家登录页可见，空提交显示必填错误，无浏览器控制台错误。商家生产登录态只读检查覆盖概览、商品搜索/详情、素材库、品牌资产、回收站及部分财务页；认证后的运营生产页面不在可用身份下验证。
- 本轮新增视觉权限拒绝本地 stdio e2e 1/1：图片生成与视频请求均保留 `PERMISSION_DENIED`，没有 fallback、重试、轮询或 provider 调用。此项是 fail-closed 证据，不是成功生成证据。
- 本轮新增商家目录未知数值回归：`catalog-data.test.ts` 全文件 21/21 通过；HTTP 商品/任务列表定向测试 9/9，覆盖主 repository 与 service fallback；新增 `/v1/products` 参数错误响应后，OpenAPI 合同文件 6/6 通过。
- 本轮新增/修改的运营账号归属浏览器 spec 的两次复验均发现测试契约遗漏：第一次等待窗口过短、页面文案和默认筛选断言过时；第二次虽已通过首屏商家账号及切换平台账号选项，但 spec 未点击“查询”就断言平台账号已载入。已修正选项文案和提交动作；待当前隔离测试进程退出后第三次只重跑此失败用例。组件/model 已修复为商家账号默认，缺读取权限时请求层 fail-closed 且输入/筛选/查询/刷新控件禁用；组件测试 20/20 通过。无权限 UI 状态尚未浏览器覆盖。

## 未验证边界

- CUA 不允许本次会话控制原生 ChatGPT 应用，因此没有原生宿主 UI 验收；本地 stdio fixture 与 bridge 合同测试通过。
- 未发起真实付费中转图片/视频请求，没有声称生成成片、成本扣费或生产归档成功。
- 生产能力/容量证据文件不可读；本地候选未部署。
- 全仓默认 `npm test` 未在一次调用内完整验证；未纳入 browser runner 的其余配置型 Playwright spec 尚未逐项完整重跑/接入。需要独立角色账号或写入 fixture 的用例仍不能安全连生产。

登录页截图位于 [`artifacts/qa-evidence/gstack-full-review-2026-10-09/`](../../artifacts/qa-evidence/gstack-full-review-2026-10-09/)。隔离 PostgreSQL 与运营浏览器结果在 `artifacts/isolated-postgres/`、`artifacts/ops-jit-isolation/`。四个临时 worktree 已审计：资产下载、规则上传、规则详情 UI 补丁已整合；只更新迁移尾断言至 269 的 worker 补丁已过时，因为当前迁移链已更后。临时 worktree 已移除，主工作目录为唯一 worktree。
