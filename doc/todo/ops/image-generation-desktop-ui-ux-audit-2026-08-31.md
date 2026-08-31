# 图片任务桌面端 UI/UX 审计（只读）

审计角色：资深 UI/UX 设计师  
审计技能：`ui-ux-pro-max`  
审计范围：`demo/merchant-studio` 桌面工作台的图片任务状态、候选图、异常恢复交互。  
审计日期：2026-08-31

## 结论

当前结论：**UI Conditional / 生产 NO-GO（本地代码闭环大部分已实现，真实生产与故障验收仍待完成）**。

已具备真实任务查询、任务发现、状态轮询退避、刷新按钮、错误提示、候选门禁、深链接和候选选择；本地代码已形成“状态 → 异常提示 → 候选审查 → 选择”的闭环。图片失败重试仍没有独立服务端契约，因此 UI 不虚构重试动作；`unknown`、归档、扫描/真实性门禁和人工审核继续保持 fail-closed。真实生产与故障注入验收仍未完成。

本报告保留为 TODO 验收清单；本轮已落地的代码和验证证据记录在文末，未闭合门禁前不迁移到 `doc/done`。

## 审计依据

`ui-ux-pro-max` 针对本次审计返回的规则：

- 错误恢复必须提供清晰下一步，不能只有错误文案。
- 异步错误需用 `role="alert"` 或 `aria-live` 告知辅助技术用户。
- 长耗时操作需要稳定 loading/skeleton，避免空白或闪烁。
- 图片需有描述性 `alt`、非首屏懒加载、尺寸/比例占位和失败兜底。
- React 动态列表使用稳定唯一 key，不能使用数组索引。

代码图谱当前索引：773 files、10,769 nodes、40,218 edges；无 pending refs。本审计以源码证据为准，不把静态存在当成功能完成。

## 已实现且可保留

| 能力 | 证据 | 评价 |
| --- | --- | --- |
| 任务查询与深链接 | `demo/merchant-studio/src/api.ts:659`；`App.tsx:6961` 通过 `image_job` 注入面板 | 已有真实入口，但依赖外部传入 job ID，页面内没有创建/列表入口 |
| 周期刷新与卸载清理 | `App.tsx:5935-5954` | 有 5 秒轮询和清理；仅在失败或成功且完整归档后停止，归档阶段持续 hydration；当前仍无退避 |
| 错误播报 | `App.tsx:5954-5956` | 状态区有 `aria-live`，错误有 `role="alert"` |
| 基础候选显示 | `App.tsx:5957` | 已升级为带门禁证据、稳定 key、失败兜底和比例占位的候选卡片 |
| 手动刷新 | `App.tsx:5958` | 有按钮且 loading 时禁用；未知结果保持只读刷新/对账语义 |
| 桌面可访问性基础 | `styles.css` 已有 44px 控件、focus-visible、reduced-motion 规则 | 可复用，但图片面板专属规则缺失 |

## 问题清单

| 编号 | 优先级 | 问题 | 证据/影响 | 最小改进方案 |
| --- | --- | --- | --- | --- |
| UI-IMG-01 | P0 | 未知状态不可辨识 | `labels` 仅覆盖 `queued/running/succeeded/failed`（`App.tsx:5950`）；`outcome_unknown` 等会落到“状态待确认”，用户不知道是否可重试 | 建立显式状态映射：排队、处理中、归档中、结果未知、已完成、不可重试失败；每个状态配“发生了什么/下一步/禁止动作” |
| UI-IMG-02 | P0 | 失败恢复只有刷新 | 错误区只展示文案，唯一动作是“刷新任务状态”（`App.tsx:5955-5958`）；没有按 retryable/non-retryable/unknown 分支 | 消费 `nextAction`；可重试失败显示幂等重试，未知只显示刷新/进入对账，非可重试显示修正输入/联系运营 |
| UI-IMG-03 | P0 | 候选无安全与真实性门禁 | `ImageGenerationJob` 有 `archiveState`、`reviewStatus`、`nextAction` 和 `outputs`（`api.ts:318-338`），但面板只消费 `images` URL | 每张候选呈现归档、扫描、真实性、人工审核四个独立状态；未满足门禁时禁用选择并解释原因 |
| UI-IMG-04 | P0 | 没有候选选择/排序/确认动作 | `ImageGenerationJobPanel` 只渲染 `<figure>`，没有选择主图/副图、取消、顺序或提交 | 最小增加候选卡片选择态、角色（主图/副图）、版本范围和选择确认；选择前显示门禁原因 |
| UI-IMG-05 | P1 | 画廊没有专属布局样式 | `image-generation-job-panel`、`image-candidate-grid` 在 `styles.css` 中无匹配规则；当前会退化为浏览器默认 figure 流式布局 | 桌面 3–4 列网格，固定 `aspect-ratio` 与背景占位，统一间距；候选数超过 50 分页或虚拟化 |
| UI-IMG-06 | P1 | 图片 key 使用数组索引 | `App.tsx:5957` 使用 ``${job.jobId}-${index}``；React stack 规则要求稳定唯一 ID | 以 `outputs.visualRef` 或 `assetId` 作为 key；无唯一 ID 时由 API 提供稳定 candidate ID |
| UI-IMG-07 | P1 | alt 文案不描述图片事实 | `alt={`图片候选 ${index + 1}`}` 只有序号；无法帮助读屏用户区分来源/审核状态 | alt 至少包含候选序号、商品/任务上下文和当前可用状态；装饰图标标记 `aria-hidden` |
| UI-IMG-08 | P1 | 图片加载失败无单图恢复 | `<img>` 没有 `onError`、重读动作或失败占位；单张 CDN 失败会留下破损图 | 每张卡保留元数据并显示“图片读取失败—重新读取”；不能清空整个任务状态 |
| UI-IMG-09 | P1 | loading 语义不足且可能覆盖可信状态 | 每次轮询都 `setLoading(true)`（`App.tsx:5940`）；刷新期间状态 chip 变“读取中”，但没有 `aria-busy`/稳定 skeleton | 首次加载与后台刷新分离；保留上次可信状态，增加 `aria-busy` 和“正在更新”轻提示；终态停止轮询 |
| UI-IMG-10 | P1 | 只有深链接，没有桌面任务发现入口 | `TaskWorkspace` 仅在 `imageJobId` 存在时渲染面板（`App.tsx:6961`）；没有普通图片任务列表/创建入口 | 从商品工作区进入任务详情，并在任务页显示当前工作区图片任务列表；未配置 API 明确阻断，不显示假任务 |
| UI-IMG-11 | P1 | 证据字段已在客户端契约中但未呈现 | `outputs` 包含 `mimeType/sizeBytes/sha256/reviewStatus`，面板不显示；用户无法核对归档证据 | 候选详情抽屉显示来源素材、版本、生成时间、存储/哈希、扫描与审核证据 |

### 当前代码对账（2026-08-31）

上述问题清单保留为原始审计记录；当前源码已覆盖 UI-IMG-01、03、04、06、07、08、09、10、11 的本地实现：状态映射、门禁证据、候选选择、稳定 key、可访问 alt、单图失败恢复、轮询退避、任务发现列表和归档摘要均已落地。UI-IMG-02 仍遵守服务端 `nextAction`，未知结果不提供未经授权的重试；UI-IMG-05 已有桌面画廊样式。当前未关闭项是生产级证据：真实 Provider、对象存储、OIDC/多账户权限、网络故障注入、正式 ChatGPT Host 和 canary，不能仅凭本地代码迁移到 `doc/done`。

## 三条最小交互链路

### A. 正常完成

`排队中 → 处理中 → 归档中 → 可审查 → 用户选择 → 选择已确认`

每一步都要有文字状态，不依赖颜色；“生成完成”不能等同于“候选可发布”。

### B. 结果未知

`结果未知 → 刷新状态/进入对账 → 已确认成功并归档 或 已确认失败`

未知结果禁止直接“再次生成”，避免重复扣费。主动作只能是刷新、查看证据或进入运营对账。

### C. 可恢复失败

`可重试失败 → 使用同一幂等请求重试 → 处理中`

重试提交期间按钮禁用并显示进度；不能创建第二个任务。不可恢复失败则进入修正输入或人工处理，不显示泛化“重试”。

## 最小改进顺序

1. P0：补齐状态字典、`nextAction` 消费和 unknown/failed 恢复分支。
2. P0：将 `outputs` 转为候选卡片，增加四类门禁状态、禁用原因和主/副图选择确认。
3. P1：补齐画廊 CSS、稳定 key、描述性 alt、图片失败占位和首屏/非首屏加载策略。
4. P1：增加任务发现入口与详情抽屉；页面刷新/深链接保持工作区与店铺上下文。
5. P1：使用桌面浏览器验证 1280/1440/1920 宽度、键盘、读屏播报、网络中断、CDN 单图失败和终态停止轮询。

## 上线验收门槛

- [ ] `queued/processing/archiving/unknown/succeeded/failed` 均有独立文案和允许动作。
- [ ] unknown 不提供直接重试；retryable 失败使用同一幂等请求。
- [ ] 候选卡同时呈现归档、扫描、真实性、人工审核状态。
- [ ] 未过门禁的候选不可选择；用户能看到阻断原因。
- [ ] 候选使用稳定 ID key，图片有比例占位、懒加载和单图失败恢复。
- [ ] 首次加载、后台刷新、错误和终态均有可访问反馈，且不抢焦点。
- [ ] 桌面浏览器真实 API 验收通过；API/模型中转缺配置时显示明确阻断。

## 最终判定

**Conditional：本地实现项可视为已落地，但不能标记为生产完成；仍需真实 API/Provider/对象存储、权限、网络故障和已审核候选选择验收。**

## 2026-08-31 Provider 生命周期状态呈现增量

- 按 `ui-ux-pro-max` 的异步反馈、错误恢复、live region 和防重复提交规则复核并调整状态呈现：Merchant Studio 对 `dispatching`、`provider_started`、`outcome_unknown` 使用明确的生命周期文案；`outcome_unknown` 明示“进入运营台对账，禁止重复生成或扣费”，不显示安全重试动作。
- Ops Console 图片执行队列对 `dispatching`、`provider_started` 提供“已提交模型请求/模型已受理”的状态标签；仅 `outcome_unknown`、`manual_attention` 或服务端标记 `reconciliationStatus=required` 提供“打开对账”，其他 Provider 进行态只显示“仅观测，不可重复生成”。对账弹窗继续要求证据引用与原因，错误使用可访问的 alert 语义。
- 新增状态策略单元测试，补充 Ops 状态契约测试；定向 UI 测试 14/14、类型检查、Ops Console 构建和 Merchant Studio 构建通过，CodeGraph 已同步到 860 files / 12,187 nodes / 45,613 edges，仍有 watcher pending artifact。
- 当前 API 的运营队列投影仍只返回 `provider_started/outcome_unknown`，`dispatching` 标签用于前向兼容与 Merchant 详情；若要在 Ops 真实展示 `dispatching`，需先由服务端 execution/reconciliation 投影提供该状态，不能由前端猜测或伪造。
- 本增量只证明本地桌面 UI 代码与构建层行为；真实 OIDC/RLS、Provider/relay 查询、双副本崩溃恢复、真实读屏与生产 ChatGPT Host/canary 仍未闭合，因此文档继续保持 `TODO / UI NO-GO`，不迁移到 `doc/done`。

### 2026-08-31 文档与代码对账校正

- UI-IMG-01、UI-IMG-03 至 UI-IMG-11 已在当前 Merchant Studio 代码中落地：状态字典、门禁摘要、稳定候选 ID、描述性 alt、比例占位、单图失败兜底、首次加载/后台刷新区分、任务发现入口和证据字段展示均有源码与定向测试证据。
- UI-IMG-02 仅完成失败原因聚焦和 `nextAction` 展示；图片生成没有可安全复用的服务端 retry contract，因此未添加会造成重复扣费或重复调用风险的假重试按钮。
- 按 `ui-ux-pro-max` 的错误恢复、异步状态播报、焦点错误摘要、懒加载和比例占位规则复核，当前交互符合本地实现约束；无数据库匹配的 React 图片画廊专项查询不作为证据，采用已有代码与浏览器契约测试验证。

## 2026-08-31 增量实现

### 当前实现增量（2026-08-31）

- `GET /v1/image-generation-jobs/:id` 现在返回任务 `revision` 和每个候选的 `gate`：归档、扫描、权益、真实性、人工审核、`selectable` 与阻断原因；这些字段直接来自服务端任务/素材状态，不由 UI 猜测。
- Merchant Studio 图片任务面板已使用稳定 `visual_ref` 作为候选 key，展示执行/归档/Provider request/revision，区分首次加载与后台刷新，终态停止轮询，并对未知结果保持只读对账语义。
- 候选画廊已加入固定比例占位、懒加载、单图失败兜底、描述性 `alt`、门禁明细和“生成完成不等于可发布”提示；未满足门禁的候选不会显示为可选择。
- 已补齐绑定内容版本时的选图提交：商家可选择 1–6 张已满足门禁的候选并填写原因，客户端先读取当前内容版本 revision，再通过 `content.visual.select` 携带幂等键提交；服务端会再次校验 workspace、任务、商品版本、扫描、人工审核和真实性证据。未绑定内容版本的任务明确禁止直接选择。
- 运营台视觉候选动作已补齐确认弹窗、必填审核原因（至少 4 个字符）、通过/阻断的不同风险提示，以及提交中的禁用状态；仍由服务端 workspace 权限和 revision 冲突门禁决定最终结果。
- 本轮定向回归 85/85、TypeScript 与 Merchant Studio Docker 构建通过；真实 `imggen_b1ddaf33-2253-4bad-9d59-530d761e3049` 返回 `succeeded/archived`，候选 `review_status=unreviewed`、`selectable=false`，真实阻断原因为“尚未完成人工视觉审核”。
- 尚未迁移到 `doc/done`：任务发现入口、真实多状态/权限/网络故障浏览器验收，以及一个已审核候选的真实选择成功/版本冲突验收仍未全部闭合。

### 2026-08-31 P1-06 可访问反馈增量

- Merchant Studio 图片任务面板将正常状态与读取错误拆分为单一 `role=status` 和独立 `role=alert`，避免错误被错误地当作普通状态播报。
- 刷新和选图提交控件增加明确 accessible name/说明；候选选择数量通过一个 polite、atomic live region 播报；装饰性刷新图标从读屏树隐藏。
- 定向 Merchant Studio/API/入口测试 20/20 通过，生产构建通过。真实桌面键盘、读屏、网络中断和多状态浏览器验收仍未完成，文档继续保持 UI NO-GO。

### 2026-08-31 UI-IMG-01 状态字典增量

- 图片任务发现列表和详情标题现在根据执行态、归档态和任务态计算展示状态：`结果待对账`、`归档中，等待安全扫描`、`部分归档，等待补偿`、`归档未确认，等待对账` 与 `生成完成，等待候选审查` 分离展示。
- 业务 `succeeded` 但归档尚未完成时不会再显示为绿色完成；动作仍由服务端 `nextAction` 和候选门禁决定。
- Merchant Studio 类型检查、定向测试 20/20 和生产构建通过；真实浏览器多状态、网络中断和读屏验收仍未完成。

- `ops.marketing.queue` 已新增 `imageExecutions` 工作区范围队列投影，覆盖 `provider_started` 与 `outcome_unknown`，返回 attempt、event、provider request、归档状态和下一动作。
- Ops Console 已将图片执行异常纳入任务表，并提供只读“查看执行证据”弹窗；未知结果不显示普通重试动作。
- 商家工作台已展示执行/归档/Provider request 证据和对账提示。
- 以上仅完成可见性与证据读取部分；品牌级过滤、独立分页、人工转派/收口动作、真实 provider 查询和生产 evidence 仍未完成，结论继续为 `TODO / UI NO-GO`。
- 本轮新增：运营队列按当前操作者可见品牌过滤，未能证明品牌归属的任务不返回；图片执行行提供只读证据弹窗。独立分页、人工动作和真实 provider 查询仍未完成。

### 2026-08-31 当前增量：图片任务发现入口

- API 新增 workspace-scoped `GET /v1/image-generation-jobs` 分页读取，先完成工作区 hydration，再按操作者可见商品过滤；响应只返回任务摘要、商品/平台/店铺上下文、状态、候选数和 revision，不暴露其他工作区数据。
- Merchant Studio 营销任务页新增“图片任务”发现区：真实 API 未配置时明确阻断；真实空结果显示“暂无图片任务”，不会创建或混入演示任务；列表使用稳定 `jobId`，查看动作通过 `image_job` 深链进入既有详情面板。
- 定向 service/API/UI 回归新增并通过：workspace 隔离、分页排序、列表响应和桌面入口契约；该入口仍是只读发现，不提供隐式生成、重试或发布。
- 任务发现代码闭环已完成，但真实多账户权限、网络中断浏览器证据、真实 provider 任务和生产宿主证据仍未完成，因此继续 `TODO / UI NO-GO`，不迁移到 `doc/done`。

### 2026-08-31 当前增量：归档阶段持续轮询与就近恢复

- 商家端图片任务只有在 `state=succeeded` 且 `archiveState=archived` 时才停止轮询；归档中、部分归档和归档未确认会继续刷新同一深链接任务，避免停留在旧快照。
- 任务读取失败时，`role=alert` 区域内直接提供“刷新任务状态”按钮，同时保留上次可信任务数据。
- `npm run typecheck -- --pretty false`、商家端定向测试 20/20 和 `npm run build:merchant-studio` 通过；Compose 桌面浏览器深链接返回 200，图片任务接口返回 200，控制台无错误。
- 本增量只关闭本地代码/构建层缺口；真实键盘/读屏、多状态故障注入、生产 API/对象存储和宿主证据仍未闭合，文档继续保持 `TODO / UI NO-GO`。

### 2026-08-31 安全重试轮询修复

- 修复 `ImageGenerationJobPanel` 安全重试后的轮询目标漂移：`catalog.image.retry` 返回新 durable job 后，面板现在使用返回的 `jobId` 继续读取新任务，不会继续轮询已失败的 predecessor。
- Merchant Studio 图片契约/轮询/IA 定向回归 10/10，Merchant Studio production build 通过；Compose Chrome 桌面 `merchant-deeplink.spec.js` 与 `merchant-task-auxiliary.spec.js` 共 13/13 通过。
- 该证据闭合本地重试状态管理与桌面基础链路；真实 Provider、对象存储归档、网络故障注入、真实多角色和正式 ChatGPT Host 仍缺，图片功能整体继续 `TODO / UI NO-GO`，不迁移到 `doc/done`。

### 2026-08-31 当前增量：失败动作可达性

- 当服务端 `nextAction.type=review_error` 且允许时，详情面板提供“查看失败原因”按钮，将键盘焦点定位到错误摘要；没有新增未获服务端授权的重试或扣费动作。
- 错误摘要保持 `role=alert`，且可被主动聚焦；类型检查、定向测试 20/20、Merchant Studio 构建和 CodeGraph 同步通过。

### 2026-08-31 当前增量：候选上下文与完整性摘要

- 图片任务详情接口为每个候选返回 `archive_receipt_id` 与 `archive_receipt_digest`；Merchant Studio 候选卡展示任务 ID、商品版本、来源素材数量、生成时间、文件类型/大小、SHA-256 摘要和归档凭证。
- 该信息只用于可追溯性展示，不改变服务端候选选择门禁；真实浏览器仍显示“扫描通过、权益待归档、人工审核待审核、真实性未检查”并保持不可选择，控制台无错误。
- 类型检查、商家端 20/20 定向测试、生产构建和 CodeGraph 同步通过；真实生产对象存储/真实性证据与已审核候选选择闭环仍未完成，继续保留 `TODO / UI NO-GO`。

### 2026-08-31 当前增量：轮询退避与并发保护

- 固定 `setInterval` 改为单定时器 `setTimeout`：同一任务始终只有一个下一次读取，避免慢接口响应造成并发轮询。
- 成功读取后恢复 5 秒周期；读取失败按 5→10→20→30 秒退避；隐藏标签页降为 30 秒检查；组件卸载会清理定时器。
- 只有失败，或成功且完整归档后才停止；归档中/部分归档/归档未确认继续 hydration。
- 类型检查、商家端定向测试 20/20、生产构建和 `git diff --check` 通过；该增量仍不替代真实多状态故障注入和生产证据。

### 2026-08-31 当前增量：轮询策略单元化

- 新增 `image-job-polling.ts` 纯策略模块及 3 个单元场景：归档中继续轮询、完整终态停止、失败 5→10→20→30 秒退避、隐藏标签页 30 秒节流。
- Merchant Studio 组件复用该策略，关键轮询行为不再只能由静态契约或构建间接证明。
- 该模块测试与商家端既有契约测试合计 23/23 通过，类型检查和生产构建通过；真实浏览器故障注入仍待外部验收。

### 2026-08-31 当前增量：HTTP 归档凭证契约

- `server.e2e.test.ts` 增加真实 HTTP 详情断言，验证候选的 `archive_receipt_id` 和 64 位 `archive_receipt_digest` 从服务端任务快照透传到客户端契约，同时覆盖 revision 乐观锁更新。
- API、图片轮询和 UI 契约回归 59/59 通过；类型检查、Merchant Studio 构建和 `git diff --check` 通过。

### 2026-08-31 当前增量：gstack 桌面交互验收

- 在 `1440x900` 桌面视口打开真实图片任务深链接，文档结构可读到任务状态、执行/归档/扫描/权益/人工审核/真实性门禁和下一步；当前候选因人工审核与真实性未完成保持不可选择。
- `document.documentElement.scrollWidth === clientWidth`（1440），未发现横向溢出；键盘 Tab 可连续到达任务刷新和任务恢复按钮；gstack `console --errors` 无错误。
- 该证据覆盖本地 Compose 的真实 API/桌面 bundle，不等价于生产宿主、真实 Provider 或生产对象存储验收，文档仍保持 `TODO / UI NO-GO`。

### 2026-08-31 当前专项测试复核

- `demo/merchant-studio/src/task-visual-contract.test.ts` 当前 3/3 通过，已不再存在旧审计中记录的 2 项静态契约失败。

### 2026-08-31 当前增量：商品列表发起图片任务

- 商品列表新增“生成图片”入口，使用现有 `catalog.image.generate` MCP 契约，不创建本地假任务。
- 入口在 API 未配置、商品事实未确认、店铺身份异常或 canonical 状态不可用时阻断；有素材时自动进入 `optimize`，无素材时进入 `create`。
- 结构化确认弹窗支持方向、1–6 张候选数量、取消零写入和提交后跳转 `image_job` 深链；文案明确生成完成仍需扫描、人工审核和候选选择。
- Merchant Studio `task-visual-contract` 现为 3 个测试文件共 36 项通过，类型检查和 `build:merchant-studio` 通过。

该增量关闭“商家无法从桌面商品工作区发起图片任务”的本地 UI 缺口；真实图片模型、对象存储、扫描和生产浏览器验收仍未完成，本审计继续保留在 `doc/todo`。
- 该测试修复/复核只证明当前源码契约与交互入口一致；真实 Provider、对象存储、网络故障、权限矩阵和正式 ChatGPT 宿主证据仍未完成，因此本审计继续保留在 `doc/todo/ops`。

### 2026-08-31 当前增量：终态读取复位 busy 状态

- 修复图片任务面板在完整终态读取后未执行 `setLoading(false)` 的缺陷。此前轮询虽已停止，但面板会永久保持 `aria-busy=true`，刷新按钮也会持续禁用。
- 现在无论读取结果是否继续轮询，只要组件仍然有效都会先清除 busy 状态；只有需要继续 hydration 的任务才会安排下一次读取。
- `task-visual-contract.test.ts` 与 `image-job-polling.test.ts` 共 6/6 通过，TypeScript、`build:merchant-studio` 和 `git diff --check` 通过。
- 本地 UI bundle 返回 HTTP 200；未携带真实 Bearer token 访问图片任务 API 返回 HTTP 401 `UNAUTHENTICATED`，符合生产鉴权 fail-closed，不能作为生产媒体链路通过证据。

该增量关闭本地终态交互阻断；真实 OIDC、Provider、对象存储、网络故障、权限矩阵和正式 ChatGPT 宿主验收仍未完成，本审计继续保留在 `doc/todo/ops`。

### 2026-08-31 当前增量：安全失败重试契约

- 新增 `catalog.image.retry` MCP/API 能力：仅允许 `failed + providerAttemptState=not_started + 无候选/对账证据` 的任务，复用冻结输入但创建新任务和新幂等键；Provider 已启动、结果未知、已有输出或非白名单失败原因均 fail-closed。
- 重试独立计费，重复使用同一重试幂等键不重复扣费；本地模式执行完成后仍必须归档，Durable 模式只持久入队并等待 Worker 回执，不回落为本地假执行。
- 服务层新增 Provider 尝试状态和重试次数；Provider 调用异常标为 `unknown`，避免把外部可能已扣费的请求再次生成。应用/契约测试 129/129、TypeScript build 通过。
- Merchant Studio 已接入桌面“安全重试”按钮：仅对白名单的 provider 未启动失败展示，提交后切换到新任务深链并继续轮询；服务端仍是最终安全判断。
- 该增量关闭了本地服务、MCP/API 契约和桌面 UI 缺口；真实 Provider、Durable Worker、账务流水、对象存储和 ChatGPT 宿主证据仍未完成，因此继续 `TODO / UI NO-GO`，不迁移到 `doc/done`。

### 2026-09-01 Provider dispatch 状态交互

- Ops/商家桌面端将 `provider_reserved`、`provider_dispatching`、`provider_started` 统一转译为“处理中/模型已受理”，`outcome_unknown` 转译为“结果待对账”；未知状态只提供查看/对账，不提供再次生成。
- 异步状态保留 `aria-live`，错误使用 `role=alert`；本地 UI 定向 14/14 通过，Ops/Merchant 构建与类型检查通过。
- 真实 Provider、多副本故障恢复、正式 OIDC/RLS 和生产桌面浏览器证据仍缺，文档继续留在 `doc/todo`。
