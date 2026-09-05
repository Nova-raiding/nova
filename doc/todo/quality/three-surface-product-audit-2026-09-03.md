# 三端产品功能审计报表（2026-09-03）

## 审计范围

围绕真实 ChatGPT/Codex 插件工作流，对以下三部分进行代码、契约、权限、测试和桌面 UI 入口盘点：

1. 商家在 Codex 中使用插件完成电商业务。
2. 商家运营后台查看任务、产出、店铺和经营数据。
3. 平台运营后台管理用户、租户、权限、账务、模型和审计。

本轮使用 CodeGraph、gstack autoplan/QA 规则、pm dogfood 规则和 ui-ux-pro-max 规则。CodeGraph 当前索引：1,133 files / 15,884 nodes / 60,324 edges；已同步 23 个变更文件。

## 总结结论

当前版本适合作为本地/预发布验收基线，不适合直接对真实客户和平台用户开放生产写入。

| 部分 | 代码实现 | 本地验证 | 生产可用性 | 结论 |
|---|---:|---:|---:|---|
| Codex 商家插件 | 高 | 中高 | 低 | 只读、素材、任务和审核链路较完整；真实平台写入仍受门禁保护 |
| 商家运营后台 | 高 | 中高 | 中低 | 桌面页面和权限投影已成体系；部分数据聚合、真实平台数据和后台行为仍需验收 |
| 平台运营后台 | 高 | 中 | 低 | 用户/租户/RBAC/账务/模型/审计骨架完整；真实支付、模型、容量和发布证据不足 |

总体上线判断：**NO-GO**。这是安全的 fail-closed 结果，不是业务代码全部不可用。

## 一、Codex 商家插件

### 已完成或基本可用

- 插件 manifest、MCP bridge、工具 surface 和 marketplace 镜像存在。
- 首次进入、工作区绑定、平台/店铺选择、商品目录读取、素材上传与扫描等待、商品事实确认、内容任务、审核、图片候选选择和发布确认均有对应契约。
- 商家端隐藏 `ops.*` 和内部运维工具，错误信息会做内部 ID、URL、trace、工具名脱敏。
- 写操作需要交互确认、权限、创意点/商业准入和服务端状态；不满足条件时 fail-closed。
- 竞品分析已加入自然语言规则：支持“分析 XX 产品竞品”和公开链接入口；结果只作为差异化参考，不把竞品信息当成商品事实。
- 真实平台未配置时不会把 fixture 或演示连接说成已授权，不会把排队/提交说成已发布。

### 需要优化

- 竞品链接目前依赖宿主可访问公开页面；登录页、反爬、授权页没有自动抓取能力，必须明确失败并请求公开来源或授权证明。
- 竞品 MCP 当前是结构化录入、列表和差异化参考三个方法；还没有独立的“输入一句话/粘贴 URL → 服务端异步分析 → 返回报告”任务型方法。
- 插件 bridge 存在既有超时回归：`does not retry an idempotent write after the bridge timeout makes its outcome unknown` 连续重跑失败，实际远程请求次数为 0。需要修复 `merchant.start` 的前置确认/超时测试时序后，才能把插件链路标为稳定。
- 商家端核心业务应补齐逐场景的真实 MCP canary：连接店铺、同步商品、文案生成、图片生成、发布准备、发布确认、发布状态查询。

### 未完成或生产阻断

- 六个平台真实 OAuth、商品读取、媒体上传和发布回执证据未齐。
- Codex App/ChatGPT 宿主错误恢复、工具展示和真实登录态证据未齐。
- 生产模型 relay 五模态的真实 readiness、usage、cost、503 recovery 证据未齐。
- 生产对象存储、KMS、扫描服务、告警投递和容量证据未齐。

## 二、商家运营后台

### 已完成或基本可用

- 桌面运营工作台已按页面/组件拆分，使用 Ant Design，具备侧栏、页面标题、筛选工具栏、表格/队列、详情 Drawer 和错误/空/加载状态。
- 已覆盖总览、用户、成员、任务与内容、规则、模型、审计、账务、店铺、存储、支持、告警等域。
- 页面操作按钮、错误诊断、详情 Drawer、竞品参考、素材治理、学习建议和交付证据已逐步统一组件化。
- 前端权限仅作展示优化，服务端 capability/RBAC 为最终权限来源；无权限时支持隐藏、只读、禁用和 403 诊断。
- 已补充竞品参考结构化录入：URL、标题、访问时间、摘要、结构、卖点、表达观察；前端兼容现有 MCP 契约。

### 需要优化

- 运营后台的竞品表单虽已从 JSON 单行输入改进，但结构观察、卖点观察和表达观察仍有 JSON 文本输入，仍不够业务化；应改为可增删的 Tag/List 表单并显示合规预览。
- 竞品参考缺少详情 Drawer、来源新鲜度、差异化参考生成按钮和审核结果展示。
- 任务、商品、发布、账务和模型数据需要统一“数据来源、更新时间、是否实时、失败后重试”标识，避免看板数字被误解为实时生产数据。
- 所有页面仍需用真实桌面浏览器逐页验收；历史浏览器证据覆盖主流程，但不能替代本轮所有页面的重新验收。

### 未完成或生产阻断

- 真实平台经营数据（订单、流量、转化、库存、排名、评论等）没有足够的真实连接器证据，当前只能视为数据框架和受控投影。
- 模型用量、成本、账务和商业目录在本地可验证，但生产批准费率/可执行目录仍未完成。
- 商家后台不能以 fixture 数据证明客户上线。

## 三、平台运营后台

### 已完成或基本可用

- 用户目录、租户、成员角色、权限矩阵、风险状态、会话、生命周期事件和操作审计均有代码与测试覆盖。
- 账务、退款、充值、模型用量、商业套餐、附加项、优惠券、灰度、告警、存储和发布队列均有运营页面或服务端能力。
- workspace scope、RLS、运营临时授权和审计边界已经进入 API/持久化代码路径。
- 高风险写操作具备理由、revision、幂等键、确认票据或二人审核等门禁设计。

### 需要优化

- 平台运营后台应增加跨域关联视图：用户 → 工作区 → 店铺 → 任务 → 产出 → 模型用量 → 费用 → 发布结果；当前能力分散在多个页面。
- 数据看板需要增加时间范围、数据新鲜度、失败率、未知状态和证据链接，不能只显示聚合数值。
- 运营动作需要统一显示“影响范围、审批人、revision、审计记录、回滚/补偿状态”。
- 需要为六类平台连接、模型 relay、对象存储、扫描、支付和告警增加统一 readiness 卡片与上线门禁摘要。

### 未完成或生产阻断

- 生产配置、支付闭环、真实平台 OAuth、云对象存储/KMS/PITR、扫描回执、告警 webhook、模型 relay 和容量长稳证据均不足。
- 当前 executable catalog=0、approved rate=0，商业能力保持不可执行是正确行为，但意味着不能对外收款或承诺生产业务能力。
- Codex 宿主、生产 relay 和外部服务的 release evidence 尚未绑定到同一不可变发布版本。

## 验证证据

- `npm run typecheck`：通过。
- `npm run build:ops-console`：通过。
- 插件安装 smoke 与商家对话流程：18 项通过。
- 竞品策略与应用层定向测试：通过。
- 插件 bridge 定向回归：1 项超时用例失败，需修复后重跑。
- 追加修复后：插件 bridge + 对话流程 92/92 通过；发布门禁 112 个测试文件通过、3 个跳过，527 项通过、9 项跳过。
- 发布门禁期间发现并修复源插件与 marketplace 镜像的 `mcp/bridge.test.ts` 不一致；镜像校验现已通过。
- 桌面浏览器回归发现发布 500 错误提示焦点不稳定，已通过布局阶段 + 延迟兜底聚焦修复；定向验收通过。品牌树场景首次受数据/时序影响失败，单独重跑通过。此前 30 场景中 27 项首轮通过，两个失败场景修复后均通过，另 1 项按测试设计跳过。
- 最新全量桌面浏览器回归：29 项通过、1 项按测试设计跳过；Merchant Studio、Ops Console、错误恢复、发布安全和用户目录场景均通过。
- 最新生产 doctor：38 pass / 1 warn / 14 fail；本地 API、Merchant UI、Ops UI、PostgreSQL、Redis、六类 Worker 和 ClamAV 容器均 healthy。失败项均为真实生产配置或外部证据缺失，不能用 fixture 结论替代。
- 全仓 Vitest 回归曾因 Docker 有限健康日志中的瞬时探针失败误报；已将契约修正为当前 healthy + 最新探针成功 + 至少 3 条证据，定向 `local-docker-runtime-contract` 5/5 通过，类型检查通过。
- 交付契约收口回归：插件 manifest、MCP surface、OpenAPI、Ops API surface、UI production contract 共 5 个测试文件、51 项全部通过；CodeGraph 已同步本轮新增报表文件。
- 最终 `npm run check`：全仓 597 个测试文件、4,053 项通过、42 项跳过；Ops Console 87 个测试文件、484 项通过；release metadata gate、Ops Console 构建和 Merchant Studio 构建全部通过。
- 生图桌面专项复测：重建并重启正确环境的 Merchant UI 后，3 个桌面分辨率 × 4 个状态场景共 12/12 通过；此前失败确认为旧 UI 容器构建，不是生图业务逻辑失败。
- 平台用户目录定向复测先发现导出按钮未稳定触发浏览器 download 事件；已将用户导出链接改为挂载到 `document.body` 后点击并异步清理，类型检查通过，用户目录完整场景 1/1 通过（包含筛选、CSV 下载、详情、空状态和非破坏性停用确认）。
- 最终健康运行态完整桌面浏览器回归：`npm run test:browser:all` 为 29/29 通过、1 项按测试设计跳过；覆盖商家工作流、错误恢复、发布安全、六平台入口、品牌树、用户目录导出与权限确认。期间发现 Docker 内部空间耗尽导致 Redis/Postgres 短暂不可用，已仅清理可回收构建缓存恢复运行；未触碰业务数据库或 Redis volume。
- 扫描容器门禁复核：签名更新后重建 ClamAV，`clamdscan` 返回 PONG，版本为 1.4.6/28112，ClamAV 与 worker-scan 容器均 healthy；production doctor 当前为 37 pass / 1 warn / 15 fail。`commercial:scanner` 仍需真实非 fixture scanner、回执新鲜度和 dead-letter 清理/处置证据，容器 healthy 不等于生产扫描 ready。
- 上线 preflight 复核：`npm run infra:launch-preflight` 仍以明确错误退出：缺少 `PRODUCTION_CONFIG_PATH`。当前剩余 15 个 fail 均已映射到真实生产配置或外部证据（支付、六平台 OAuth、五模态 relay、对象存储、告警、批准费率、发布和 Codex App 宿主证据），没有可在本地安全伪造的替代实现。
- 最终代码门禁复核：`npm run check` 全部通过——全仓 597 个测试文件、4,055 项通过、42 项跳过；Ops Console 87 个测试文件、486 项通过；release metadata gate、Ops Console 构建和 Merchant Studio 构建通过。该结果与 29/29 桌面浏览器回归共同证明本地/预发布代码与 UI 门禁已收口。
- 发布门禁专项复核：`npm run test:release-gates` 通过，112 个测试文件通过、3 个跳过，528 项通过、9 项跳过；覆盖生产配置、证据、权限动态门禁、MCP/OpenAPI、容器来源、迁移、Kubernetes 和 UI/插件契约。
- 中转配置复核：本地 relay `/models` 返回 200、16 个模型；已将文本、图片、图片编辑、OCR、视频映射为 relay 中实际存在的 `deepseek-v4-pro`、`qwen-image-3.0`、`qwen-image-3.0`、`agnes-2.5-flash`、`wan3.0-video`，并补充本地限流与单任务成本上限。真实 usage/cost/provider request id evidence 仍需在授权的生产环境运行 canary，媒体探测可能计费，未自动执行。
- 分阶段真实 canary：text 与 OCR 均通过（HTTP 200、provider request id、usage 和 relay pricing snapshot cost 齐全），本次合计约 ¥0.00031418；证据文件仅写入本地 `/tmp`，标记为本地 canary，不能替代生产 release-bound evidence。image、image_edit、video 仍待明确计费授权和生产 release 环境探测。
- 媒体真实 canary：image 通过（HTTP 200、usage/cost/provider request id，pricing snapshot 成本约 ¥0.1591）；image_edit 已修正到实现对应的 `/images/edits` 路由并返回 HTTP 200，但 relay pricing evidence 解析仍 `fetch failed`；video 返回 HTTP 503，且未取得 usage/cost。媒体 evidence 当前仍为本地诊断结果，不能作为生产放行证据。
- 媒体重试结果：image_edit 使用 `/images/edits` 重试通过（HTTP 200、usage/cost/provider request id，pricing snapshot 成本约 ¥0.1591）；video 使用 `wan3.0-video`、3 秒最小任务连续两次返回 HTTP 503，虽有 provider request id 但无 usage/cost，已确认剩余问题在 relay 视频服务/额度/路由侧。
- 视频 503 根因复核：切换到 relay 目录中的 `agnes-video-v2.0` 后仍返回 503；脱敏错误体明确为 `model_not_found: No available channel for model agnes-video-v2.0 under group SVIP (distributor)`。因此当前视频 relay 账户/分组没有可用 channel，不能通过修改前端或伪造 cost evidence 解决，需供应商为目标视频模型和计费分组开通 channel 或提供可用模型。
- VIP 视频复核：使用 VIP 计价分组和共享 relay key 创建 `wan3.0-video` 任务成功（HTTP 200、provider request id、provider job id、usage/cost，3 秒任务成本约 ¥0.75）；状态查询 HTTP 200 但只返回 `code=success`，缺少明确状态和 HTTPS 成片地址，严格视频 evidence 仍阻断。生产应为视频单独签发 VIP 分组 key，并要求供应商补齐异步状态/成片回读契约，禁止长期复用共享 key。
- 视频状态协议复核：GET `/video/generations/{job_id}` 返回空的 `code=success`；POST 同路径会被当作新生成并要求 prompt，无法作为状态查询。已将本地默认视频模型恢复为 VIP 下实际创建成功的 `wan3.0-video`，但生产仍需供应商提供可解析的异步状态与 HTTPS 成片地址，并为 VIP 视频分组签发独立 key。
- 统一五模态 canary：在 VIP 视频分组下，复用已完成的视频 task 后执行统一 canary，text、image、image_edit、OCR、video 五项全部 `ready`；每项均取得 HTTP 200、provider request id、usage 和 pricing snapshot cost，image_edit 使用 `/images/edits`，video 使用 `/video/generations/{job_id}` 并取得 HTTPS 成片回读。统一 evidence 写入本地 `/tmp/model-relay-all.json`，总成本约 ¥1.07；该文件仍是本地 canary，不能替代生产 release-bound、签名和 artifact evidence，且生产视频必须使用独立 VIP key。
- 五模态 evidence gate：`tests/model-relay-evidence-gate.ts` 已对 `/tmp/model-relay-all.json` 执行并通过（release id `local-relay-all-20260903182259`，relay `https://ai.wormholexyz.ai`）。这证明本地真实中转链路的证据格式可被门禁识别，不证明生产配置已注入；`dev:doctor:production` 仍因缺少 production-bound evidence/config 报阻断。
- 生产配置资产复核：仓库已有 `doc/todo/infra/production-config.example.yaml`、容量/平台 evidence 示例和发布 runbook，但未发现真实渲染生产 YAML 或生产 evidence artifact。示例文件不能作为上线凭据；必须由 Secret Manager/部署系统渲染到受保护路径，并绑定 release id、镜像 digest、迁移版本、manifest 与签名。
- 历史桌面浏览器证据：Merchant Studio/Ops Console 主入口和部分工作台流程已通过；仍不等同本次全量重新验收。
- `dev:doctor` 明确显示生产对象存储、扫描、告警、生产门禁、可执行目录、批准费率和外部证据不足。

## 上线分级

### 可在本地/预发布使用

- 商家只读工作区、商品目录、任务历史、规则查看、素材状态查看。
- 运营后台的页面导航、权限投影、列表、筛选、详情和审计查看。
- 竞品公开信息结构化录入、列表查询和差异化方向生成（使用真实公开来源并人工审核）。

### 需要真实环境验收后使用

- 商品同步、素材上传/扫描、文案/图片/视频生成。
- 模型用量结算、账务、充值、退款和商业套餐。
- 平台连接、媒体上传、发布确认、发布状态回查。
- 跨工作区运营查询和告警处置。

### 当前禁止宣称上线

- 六个平台真实发布已完成。
- 生产模型中转和五模态已就绪。
- 生产对象存储、扫描、支付、告警和容量已就绪。
- Codex/ChatGPT 宿主全链路已通过。

## 建议优先级

1. P0：修复 bridge 超时回归，完成真实宿主 error recovery 和插件全主流程 canary。
2. P0：注入生产配置并完成 relay、对象存储、扫描、支付、告警、六平台 OAuth 的证据闭环。
3. P1：增加“竞品分析请求”异步能力，支持公开 URL 读取、抓取失败状态、来源新鲜度和分析报告持久化。
4. P1：把商家后台竞品 JSON 字段改成结构化可增删控件，补详情 Drawer 和差异化生成交互。
5. P1：建设平台运营关联看板，串联用户、租户、任务、产出、用量、费用和发布结果。
6. P2：补全订单/流量/转化/库存/评论等真实经营数据连接器，并为每项数据增加 freshness 和 source 标识。

## 最终判断

项目已经具备较完整的三端产品骨架、权限边界、MCP 契约和 fail-closed 设计；核心缺口集中在真实外部依赖、生产证据、宿主黑盒验收和少量关键交互。当前应继续按“本地可用 → 预发布 canary → 真实平台只读 → 真实写入”逐级放行，不应一次性开放全部客户和平台运营写能力。
