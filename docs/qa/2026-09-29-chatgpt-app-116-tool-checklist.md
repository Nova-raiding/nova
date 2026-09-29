# Store Nova ChatGPT App 逐项验收清单（116 项，按版本记证）

**2026-09-29 13:24 最终核对：125100 版在同一真实 ChatGPT App 会话中已逐一调用全部 116/116 个精确方法；22 项非错误返回、94 项错误或明确门禁。跨四版去重调用覆盖亦为 116/116。** 这里的“覆盖”只表示工具在 App 中实际调用并有原始返回；本轮新增 84 项无一形成真实业务对象的正向闭环。专用 QA 工作区缺店铺、商品、正式任务、可用创意点/权益等前置资源，余额 `unknown` 触发大量安全门禁，不能把 116 项写成“功能全部通过”。逐项原始行号、分类、用户可见中文答复见[本轮 84 项与最终矩阵审计](evidence/2026-09-29-chatgpt-app/full-84-app-run-audit.md)。

**当前本地安装版为 143500。** 133000 版 13:32 的新 ChatGPT App 会话针对参数错误中文展示复测四项，均返回中文结构化拒绝，见[133000 版复测](evidence/2026-09-29-chatgpt-app/133000-chinese-argument-errors-app.md)。143500 版又定向复测品牌偏好空态与中文套餐说明 2 项，见[143500 版复测](evidence/2026-09-29-chatgpt-app/143500-brand-preference-chinese-app.md)。143500 版尚未重新执行 116 项完整调用；下表 `125100 App 实际状态` 是旧版全量矩阵，不冒充最新版全量业务通过。

**114000 版 App 结果：22 项有真实会话工具调用；其中 10 项返回非错误的只读或入门结果、12 项返回明确阻断；其余 94 项尚无本版 App 调用证据。** 本表是逐项执行清单，不能把调用通达、空态读取或安装成功写成业务流程通过。该历史轮次版本为 `merchant-marketing@merchant-local 0.1.0+codex.20260929114000`；[本地中文插件复测](evidence/2026-09-29-chatgpt-app/114000-chinese-plugin-round.md)记录安装器成功、116 项工具和定向测试。下面的精确方法及最小参数最初取自 **102500 版**安装缓存的 stdio `tools/list`：116 项，响应 SHA-256 `125a4692a94f80036ae00a00e33f783ae8c2ac65da5c3f30691d99b950e6dec6`；对照 `packages/contracts/src/mcp.ts` 的 `MCP_METHOD_SCHEMAS` 必填字段，115 项一致。这个哈希是旧版取样证据，不是 114000 App 调用证据。`asset.upload` 由桥接器接收本机 `file_path` 或 `content_base64` 再转为 API 请求，故其已安装工具 schema 与 API 源合同有意不同。

**123300 版 App 新轮次：13 个不同方法已调用，4 项非错误返回、9 项明确阻断；其余 103 项没有该版 App 调用证据。** 本地安装记录为 `0.1.0+codex.20260929123300`，逐项原始 JSONL 结果见[123300 版只读调用审计](evidence/2026-09-29-chatgpt-app/123300-app-readonly-raw-audit.md)。`knowledge.rule.list` 是模型误选的工具；随后 `rule.list` 已独立补调，两项都因余额 unknown 被安全阻断。123300 与 114000 的方法状态分列，绝不合并为当前版本通过数。

**124800 版 App 初始取样：6 个不同方法实际调用且均非错误返回；110 项未调用。125100 版 12:52 初始取样：2 个不同方法实际调用且均非错误返回；114 项当时未调用。** 逐项结果见[两版原始知识库只读审计](evidence/2026-09-29-chatgpt-app/124800-125100-app-knowledge-raw-audit.md)。随后同一 125100 会话在 13:09–13:24 持续追加调用，最终达到上文 116/116；初始 2 项数字仅为历史时间点，不能当作最终状态。124800 的四项知识库列表为空，`knowledge.brand.preference.get` 未返回结构化对象；125100 的竞品列表为空且中文明确说明无记录。空态查询不折算为知识资产、学习建议或竞品资料正向闭环。

取样方式：以仅用于发现工具的本地测试环境启动**安装缓存内的 bridge 进程**，向标准输入发送 `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`；地址为 `https://merchant.example.com`，未设置真实令牌，也未发送 `tools/call`。按已安装 `inputSchema.required` 生成表内参数，再与源码 `MCP_METHOD_SCHEMAS` 核对。此取样不会访问生产 API。

[旧 131 项结果矩阵](2026-09-29-plugin-all-tools-matrix.md)及[111500 版证据清单](evidence/2026-09-29-chatgpt-app/111500-app-tool-evidence-audit.md)记录历史版本；其 App 截图、本地或生产 MCP 成功、隔离 E2E、工具发现，均不折算为 114000 版 App 通过。每次验收须保留新会话截图/工具名、输入、结构化输出、服务端请求 ID、同租户读回与审计；有模型调用时还要核对中转鉴权、用量、成本与创意点。

本版首轮实证：11:43:45，ChatGPT 桌面会话调用 `mcp__merchant_marketing__onboarding_status({})`，11:43:45.734 收到中文通用入门说明。该结果没有具体工作区状态、商家身份或结构化业务字段，所以表内记为“App 调用已证实；业务未核实”，**不计业务通过**。依据：[桌面运行日志与会话核对](evidence/2026-09-29-chatgpt-app/114000-runtime-log-audit.md)、[中文回复截图](evidence/2026-09-29-chatgpt-app/40-114000-chinese-reply-unverified-tool.png)。12:29 新会话经本地 MCP 再次调用 `onboarding.status({})` 与 `workspace.health({})`，两项返回 `isError=false`。`workspace.health` 的会话状态为 `needs_input`，`connected_store_count=0`；`onboarding.status` 仍处入门流程；当前可见品牌为空，结构化结果未提供可核验的品牌档案或品牌单元列表。前两项工具输出未提供工作区 ID，故**不能仅凭这两项输出证明它已绑定到预期 QA 工作区** `ws_57fd2361ed5b44c7891f3d37`；同会话后续结构化结果提供了工作区身份交叉核对。12:23 的另一会话曾读到 1 条不可选店铺账号记录，两个结果不可混写。随后同一 12:28:53 会话的 `canonical.product.consistency`、`commercial.access.get` 决策及 `subscription.get` 结构化输出均指向 QA 工作区 `ws_57fd2361ed5b44c7891f3d37`，为该会话补上独立身份核对；不把此前仅凭店铺数作的推断当证据。证据为本机 `12:28:53` 新会话原始工具事件与返回摘要，以及[独立 QA 工作区只读核查](evidence/2026-09-29-chatgpt-app/independent-qa-workspace-readonly-plan.md)。随后 12:30–12:33 同一会话又分三批调用 15 项只读工具；逐项原始结果见下方状态列。随后 12:34 同会话新增五项知识库只读调用，均因创意点余额不可用被门禁阻断，未取得列表。至此另 94 项本版无 App 调用证据。

表中尖括号是占位符，必须用明确标记的 QA 对象与实际读回版本替换；不准把占位符直接提交。`{}` 表示没有 schema 必填参数，不意味着无需前置资源。只读组可在生产 demo 执行；可逆写入只在确认真实对象与回退路径后执行；受限写入需要专用 QA 对象、前置确认和审计；预期阻断组只做安全拒绝验证，成功路径放在隔离环境。任何 404、空结果或门禁都按真实状态记录，不能记为正向业务通过。

### 12:30–12:34 原始工具证据

同一 ChatGPT 会话 `rollout-2026-09-29T12-28-53-01a0eb6c-39dd-7222-bf77-02ad332ca51f.jsonl` 的原始 `custom_tool_call` / `custom_tool_call_output` 按返回顺序逐项配对：第一批第 43/50 行、第二批第 68/75 行、第三批第 93/100 行、第四批第 118/125 行。以下只记录无敏感字段的状态摘要，未使用模型的最终总结作通过依据。

| 批次 | 非错误返回 | 明确阻断 |
| --- | --- | --- |
| 12:30，5 项 | `canonical.product.consistency`：QA 工作区、`clean`，verified/legacy/conflict/blocked 均 0。 | `brand-unit.list`、`brand-unit.listing.list`、`campaign.batch.list` 均 `STORE_ONBOARDING_REQUIRED`；`workspace.invitations.list` 为 `FORBIDDEN`。 |
| 12:31，5 项 | `workspace.metrics`：持久仓库、店铺空；`commercial.access.get`：仅恢复控制的 `allowed=true`，余额 unknown；`commercial.catalog.get`：目录 available、12 项；`creative-points.balance.get`：余额/可用性 unknown、点数 null；`creative-points.statement.list`：0 条。 | 无。 |
| 12:32，5 项 | `subscription.get`：QA 工作区 `trialing`；`billing.transactions`：只给 `open_merchant_console` 后台入口。 | `billing.status` 为 `COMMERCIAL_ENTITLEMENT_REQUIRED`；`catalog.search`、`asset.list` 为 `CREATIVE_POINTS_UNAVAILABLE`，余额 unknown 时安全停止；本次搜索入参仍是旧共享 QA 商品货号，未返回商品。 |
| 12:34，5 项 | 无。 | `knowledge.rule.list`、`knowledge.asset.list`、`knowledge.brand.preference.get`、`knowledge.learning.list`、`knowledge.competitor.list` 的原始结果均为 `isError=true`、`CREATIVE_POINTS_UNAVAILABLE`，没有取得知识库列表。 |

上述 20 项是 **8 个非错误读取、12 个阻断**。加上前面的 `onboarding.status`、`workspace.health` 两项，同版累计 22 个精确方法被调用，均不证明正式内容生成、支付、店铺连接或资料写入成功。首次两项输出本身未返回工作区 ID；后续三项结构化业务结果为同一会话提供了 QA 租户身份交叉核对。

## 最新 125100 轮次后续条件

当前版已在真实 ChatGPT App 中调用全部 116 项，且原始输出可逐项配对。**22 项非错误返回、94 项错误或门禁，不代表 116 项业务通过。** 九项知识写入的 App 中文最终答复明确提示创意点余额无法确认，调用已停止，没有业务成功；其余各批用户可见答复与原始工具结果分开核对。需要本 QA 工作区的可用权益、店铺、商品、任务、内容和知识对象后，才能继续正向流程测试并读回账务、审计和模型成本。124800 版的空态结果只保留在 124800 列，不从旧版继承为本版业务通过。

## 123300 轮次后续条件

本版 46 项只读中已有 **13 项**真实 App 调用，另 **33 项**未调用；已调用的非错误结果只有入门说明、两项订单空态和一个商家后台导出入口。该会话的上述返回没有可独立核验的工作区 ID，不能仅凭空列表确认当前身份为专用 QA 租户；下一批应先在同会话读取具明确工作区标识的只读状态，再比较服务端令牌作用域。创意点 `unknown` 触发的 8 项余额门禁须先排查真实权益/余额状态，不能当作业务查询成功。`brand-unit.list` 的店铺前置门禁另行记录，不用创建假店铺掩盖。

## 114000 轮次只读前置

46 项只读中，22 项已有 114000 版 App 工具事件，其中 12 项为权限或商业/店铺门禁；其余 **24 项**待该版 App 调用。当前独立 QA 工作区尚无店铺、商品、品牌档案、商业权益、点数或正式任务的正向对象证据，故列表查询可以先验证授权与真实空态，不能记为店铺、生成或审核流程成功。`support.customer.replies.list` 必须提供本工作区实际工单、任务或订单 ID；表内已修正旧 `{}` 模板。`catalog.search` 与 `brand.get` 的占位符也已改为本 QA 工作区对象，不能沿用贵人鸟演示数据。

需要真实本租户 ID 才能完成对象读取的有：`campaign.batch.get`、`commercial.order.payment.get`、`workspace.data.export.get`、`billing.recharge.get`、`catalog.image.get`、`rule.history`、`task.resume`、`task.timeline`、`feedback.list`、`generation.get`、`content.versions`、`content.diff`、`support.customer.replies.list`；`catalog.search` 需要本租户 QA 商品货号，`brand.get` 的定向档案读取需要本租户品牌单元 ID。当前这些对象缺失时记“前置数据缺失”，不提交虚构 ID 当成功。`workspace.invitations.list` 既有生产 403、`workspace.data.export.get` 非法 ID 既有 500，先按缺陷或权限复核；`billing.export`、`billing.model-usage.statement`、`billing.transactions` 可能仅返回后台入口，不记 ChatGPT 内导出/明细成功。

## 只读（46 项）

| 方法 | 最小安全参数 | App 预期结果 | 副作用核对 | 114000 App 实际状态 | 123300 App 实际状态 | 124800 App 实际状态 | 125100 App 实际状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `onboarding.status` | `{}` | 返回结构化状态、来源和时间；unknown 不写成成功 | 核对工作区相关快照与操作审计前后差异；读前后应无变化 | 11:43、12:29 App 调用成功；仅入门/空态，商家身份与品牌业务未核实 | 调用成功；中文入门说明，业务状态未核实 | App 调用；中文通用入门说明，业务未核实 | App 非错误；中文入门说明，商家流程未完成 |
| `brand-unit.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | App 调用；STORE_ONBOARDING_REQUIRED，店铺前置阻断 | STORE_ONBOARDING_REQUIRED；中文店铺前置门禁，未取得列表 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `brand-unit.listing.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | App 调用；STORE_ONBOARDING_REQUIRED，店铺前置阻断 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `canonical.product.consistency` | `{}` | 返回结构化状态、来源和时间；unknown 不写成成功 | 核对工作区相关快照与操作审计前后差异；读前后应无变化 | App 只读返回；QA 租户、clean、四类计数均为 0，空态 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 非错误；QA 工作区一致性 clean，商品计数为 0 |
| `campaign.batch.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | App 调用；STORE_ONBOARDING_REQUIRED，店铺前置阻断 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `campaign.batch.get` | `{"campaign_id":"<已有 QA campaign_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 参数拒绝：缺 campaign_id；未测业务读取 |
| `workspace.health` | `{}` | 返回结构化状态、来源和时间；unknown 不写成成功 | 核对工作区状态、授权/导出/删除队列与审计；读前后应无变化 | 12:29 App 调用成功；connected_store_count=0、needs_input，店铺业务正向未覆盖 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 非错误；无可用店铺，流程仍需输入 |
| `workspace.invitations.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对工作区状态、授权/导出/删除队列与审计；读前后应无变化 | App 调用；FORBIDDEN，权限阻断 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `workspace.metrics` | `{}` | 返回结构化状态、来源和时间；unknown 不写成成功 | 核对工作区状态、授权/导出/删除队列与审计；读前后应无变化 | App 只读返回；durable_repository、stores 为空，未有运营业务对象 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 非错误；持久仓库工作区指标，店铺为空 |
| `commercial.access.get` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | App 只读返回；QA 租户 RECOVERY_CONTROL allowed，点数 unknown | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 非错误；QA 工作区仅恢复控制可用，余额待确认 |
| `commercial.catalog.get` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | App 只读返回；目录 available、12 项，不等于可购买或已付费 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 非错误；商业目录可读，不代表已购买 |
| `commercial.order.payment.get` | `{"order_id":"<已有 QA order_id>"}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 返回 QA 商业订单不存在 |
| `creative-points.balance.get` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | App 只读返回；balance_state/availability unknown、点数 null | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 非错误；余额 unknown、点数 null，生成不可放行 |
| `creative-points.statement.list` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | App 只读返回；entries 为空，无结算流水 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 非错误；创意点流水为空 |
| `support.customer.replies.list` | `{"related_order_id":"<本工作区已有 QA 订单 ID>","limit":"10"}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对工作区相关快照与操作审计前后差异；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 返回内部错误；缺陷待查，未取得列表 |
| `subscription.get` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | App 只读返回；QA 租户 trialing，不等于已支付 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 非错误；QA 工作区处于 trialing，非已付费 |
| `subscription.orders.list` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 | 只读成功；订单空数组，无支付对象 | 未在 124800 版 App 调用 | App 非错误；订阅订单为空 |
| `billing.export` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 | 后台门禁；available=false，仅 open_merchant_console | 未在 124800 版 App 调用 | App 非错误；仅返回后台入口，插件未导出账单 |
| `workspace.data.export.get` | `{"request_id":"<已有 QA request_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对工作区状态、授权/导出/删除队列与审计；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 返回 QA 导出单不存在 |
| `billing.status` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | App 调用；COMMERCIAL_ENTITLEMENT_REQUIRED，权益门禁 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 商业权益门禁拒绝 |
| `billing.model-usage.statement` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 | CREATIVE_POINTS_UNAVAILABLE；未取得账单 | 未在 124800 版 App 调用 | App 非错误；仅返回后台入口或状态，插件未取得用量明细 |
| `billing.recharge.get` | `{"order_id":"<已有 QA order_id>"}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 返回 QA 充值单不存在 |
| `billing.recharge.list` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | 未在此版 App 正向完成 | 只读成功；orders=[]、total=0 | 未在 124800 版 App 调用 | App 非错误；充值订单 0 条 |
| `billing.transactions` | `{}` | 返回真实工作区账务/订单/用量状态；pending 与到账分开 | 核对订单/账本、model_usage、创意点及审计前后差异；读前后应无变化 | App 只读返回；next_action=open_merchant_console，仅后台入口 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 非错误；仅返回后台入口，插件未展示交易明细 |
| `catalog.search` | `{"scope":"workspace","query":"<本 QA 工作区实际商品货号>"}` | 返回 QA 货号、店铺、库存、事实状态一致的商品 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | App 调用；CREATIVE_POINTS_UNAVAILABLE，余额 unknown 时安全停止 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.categories` | `{}` | 返回结构化只读结果；逐字段核对租户、版本和来源 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | 未在此版 App 正向完成 | CREATIVE_POINTS_UNAVAILABLE；未取得分类 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.image.get` | `{"job_id":"<已生成 QA 图片作业 ID>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 参数拒绝：需恰好提供 job_id 或 visual_ref |
| `rule.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对工作区相关快照与操作审计前后差异；读前后应无变化 | 未在此版 App 正向完成 | CREATIVE_POINTS_UNAVAILABLE；准确规则工具补调，未取得规则 | 未在 124800 版 App 调用 | App 非错误；当前无可执行规则 |
| `rule.sync.status` | `{}` | 返回结构化状态、来源和时间；unknown 不写成成功 | 核对工作区相关快照与操作审计前后差异；读前后应无变化 | 未在此版 App 正向完成 | CREATIVE_POINTS_UNAVAILABLE；未取得同步状态 | 未在 124800 版 App 调用 | App 非错误；六个平台规则同步均未配置且状态陈旧 |
| `rule.history` | `{"pack_id":"<已有 QA pack_id>"}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对工作区相关快照与操作审计前后差异；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `asset.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变；读前后应无变化 | App 调用；CREATIVE_POINTS_UNAVAILABLE，余额 unknown 时安全停止 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `brand.get` | `{"brand_unit_id":"<本 QA 工作区 brand-unit.list 返回的 ID>"}` | 返回所选品牌档案或明确 null；null 是未配置，不能算档案成功 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 非错误；当前无品牌档案，未返回品牌对象 |
| `brand.extract` | `{}` | 只返回来源、置信度和待确认候选；不自动建档 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变；读前后应无变化 | 未在此版 App 正向完成 | CREATIVE_POINTS_UNAVAILABLE；未取得候选字段 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `deliverable.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 | CREATIVE_POINTS_UNAVAILABLE；未取得交付物 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `task.history` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 | CREATIVE_POINTS_UNAVAILABLE；未取得任务 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `task.resume` | `{"task_id":"<已有 QA task_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `task.timeline` | `{"task_id":"<已有 QA task_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `feedback.list` | `{"task_id":"<已有 QA task_id>"}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `generation.get` | `{"job_id":"<已有 QA job_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `content.versions` | `{"task_id":"<已有 QA task_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `content.diff` | `{"content_version_id":"<已有 QA content_version_id>"}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对任务/内容版本/候选/审计，发布与账本变化另核；读前后应无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `knowledge.rule.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对知识记录/版本/来源、审计与租户隔离；读前后应无变化 | App 调用；CREATIVE_POINTS_UNAVAILABLE，余额 unknown，未取得知识记录 | CREATIVE_POINTS_UNAVAILABLE；误选工具，未取得知识规则 | App 空态读取；结构化数组为空，中文说明无规则 | App 非错误；知识规则列表为空 |
| `knowledge.asset.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对知识记录/版本/来源、审计与租户隔离；读前后应无变化 | App 调用；CREATIVE_POINTS_UNAVAILABLE，余额 unknown，未取得知识记录 | 未在 123300 版 App 调用 | App 空态读取；结构化数组为空 | App 非错误；知识素材列表为空 |
| `knowledge.brand.preference.get` | `{}` | 返回指定现存 QA 对象和版本；404 只记边界证据 | 核对知识记录/版本/来源、审计与租户隔离；读前后应无变化 | App 调用；CREATIVE_POINTS_UNAVAILABLE，余额 unknown，未取得知识记录 | 未在 123300 版 App 调用 | App 调用非错误；未返回结构化对象，偏好未核实 | App 非错误；无结构化偏好字段，业务状态未核实 |
| `knowledge.learning.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对知识记录/版本/来源、审计与租户隔离；读前后应无变化 | App 调用；CREATIVE_POINTS_UNAVAILABLE，余额 unknown，未取得知识记录 | 未在 123300 版 App 调用 | App 空态读取；结构化数组为空 | App 非错误；学习建议列表为空 |
| `knowledge.competitor.list` | `{}` | 返回同租户列表/数量；空列表只记通路与空状态 | 核对知识记录/版本/来源、审计与租户隔离；读前后应无变化 | App 调用；CREATIVE_POINTS_UNAVAILABLE，余额 unknown，未取得知识记录 | 未在 123300 版 App 调用 | App 空态读取；结构化数组为空 | App 非错误；竞品列表为空 |

## 可逆写入（3 项）

| 方法 | 最小安全参数 | App 预期结果 | 副作用核对 | 114000 App 实际状态 | 123300 App 实际状态 | 124800 App 实际状态 | 125100 App 实际状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `platform.store.alias.set` | `{"platform":"jd","account_id":"<QA 店铺账号 42169>","alias":"<经确认的 alias>","expected_revision":"<刚读回的版本>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.product.disable` | `{"product_id":"<已有 QA product_id>","reason":"QA 验收，勿发布"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.product.enable` | `{"product_id":"<已有 QA product_id>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |

## 受限写入（60 项）

| 方法 | 最小安全参数 | App 预期结果 | 副作用核对 | 114000 App 实际状态 | 123300 App 实际状态 | 124800 App 实际状态 | 125100 App 实际状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `merchant.start` | `{}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对工作区相关快照与操作审计前后差异 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `merchant.first_value` | `{"example":"true"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对工作区相关快照与操作审计前后差异 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `brand-unit.create` | `{"name":"<明确标记 QA 的名称>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `brand-unit.bind-store` | `{"brand_id":"<已有 QA brand_id>","platform":"jd","account_id":"<QA 店铺账号 42169>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `brand-unit.product.create` | `{"brand_id":"<已有 QA brand_id>","title":"<明确标记 QA 的名称>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `brand-unit.listing.create` | `{"brand_id":"<已有 QA brand_id>","canonical_product_id":"<已有 QA canonical_product_id>","platform":"jd","account_id":"<QA 店铺账号 42169>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `brand-unit.access.grant` | `{"brand_id":"<已有 QA brand_id>","external_subject":"<经确认的 external_subject>","role":"viewer"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `campaign.batch.create` | `{"brand_id":"<已有 QA brand_id>"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `campaign.batch.pause` | `{"campaign_id":"<已有 QA campaign_id>","expected_revision":"<刚读回的版本>","idempotency_key":"<本次唯一 QA 键>","reason":"QA 验收，勿发布"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `campaign.batch.resume` | `{"campaign_id":"<已有 QA campaign_id>","expected_revision":"<刚读回的版本>","idempotency_key":"<本次唯一 QA 键>","reason":"QA 验收，勿发布"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `workspace.interactive.confirm` | `{"confirmation":"I_CONFIRM_INTERACTIVE_WRITES"}` | 在用户明确交互后返回短期写入票据和范围；无业务对象自动修改 | 核对工作区状态、授权/导出/删除队列与审计 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 要求人工确认，未完成写入 |
| `workspace.data.export.request` | `{"reason":"QA 验收，勿发布","idempotency_key":"<本次唯一 QA 键>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对工作区状态、授权/导出/删除队列与审计 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 参数拒绝：缺 reason；未执行导出申请 |
| `platform.mapping.preflight` | `{"input_json":"<只含 QA 商品的映射 JSON>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 交互写入门禁拒绝，未完成写入 |
| `catalog.title.optimize` | `{"product_id":"<已确认 QA 商品 ID>","keyword":"通勤"}` | 返回候选/作业和真实模型状态；核对用量成本、点数与未发布 | 核对订单/账本、model_usage、创意点及审计前后差异 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.title.accept` | `{"product_id":"<已有 QA product_id>","platform":"jd","suggestion_id":"<已有 QA suggestion_id>","title":"<明确标记 QA 的名称>"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.import` | `{"platform":"jd","title":"<明确标记 QA 的名称>","draft_only":"true","local_product_key":"QA-DO-NOT-PUBLISH-<唯一串>"}` | 仅导入 QA 草稿，不绑定店铺或发布；读回货号和待确认事实 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.import.batch` | `{"products_json":"<单条 QA 商品 JSON 数组>"}` | QA 商品批量入待确认目录，核对原子性、店铺/货号/SKU，无发布 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.sku.update` | `{"product_id":"<已有 QA product_id>","sku_id":"<已有 QA sku_id>","stock":"<已核对的 QA 库存>","expected_version":"<刚读回的版本>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.product.update` | `{"product_id":"<已有 QA product_id>","title":"QA 商品标题请勿发布","expected_version":"<刚读回的版本>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.facts.confirm` | `{"product_id":"<已有 QA product_id>"}` | QA 商品事实变为已确认，版本递增，审计可见 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.image.generate` | `{"product_id":"<已确认 QA 商品 ID>","count":"1"}` | 返回候选/作业和真实模型状态；核对用量成本、点数与未发布 | 核对订单/账本、model_usage、创意点及审计前后差异 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.image.select` | `{"job_id":"<已有 QA job_id>","visual_ref":"<经确认的 visual_ref>","expected_revision":"<刚读回的版本>","idempotency_key":"<本次唯一 QA 键>","reason":"QA 验收，勿发布","confirmation_ticket_nonce_hash":"<经确认的 confirmation_ticket_nonce_hash>","confirmation_ticket_intent_hash":"<经确认的 confirmation_ticket_intent_hash>"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `catalog.image.review` | `{"product_id":"<已有 QA product_id>"}` | 返回归档候选检查结果；核对是否仅检查、未修改商品 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `asset.parse` | `{"asset_id":"<已有 QA asset_id>"}` | 返回候选/作业和真实模型状态；核对用量成本、点数与未发布 | 核对订单/账本、model_usage、创意点及审计前后差异 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `asset.facts.confirm` | `{"asset_id":"<已有 QA asset_id>","facts_json":"<经核对的合法 JSON>","reason":"QA 验收，勿发布"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `asset.preference.update` | `{"asset_id":"<已有 QA asset_id>","verdict":"unrated"}` | 返回 QA 素材状态/版本；扫描与权益门禁仍有效 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `brand.upsert` | `{"name":"<明确标记 QA 的名称>","brand_unit_id":"<现有贵人鸟品牌单元 ID>","source":"qa://merchant-confirmed"}` | 明确关联既有品牌单元，新版本读回；不从名称猜资料 | 核对商品/品牌/店铺快照、版本与操作审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `asset.upload` | `{"name":"<明确标记 QA 的名称>","mime_type":"<经确认的 mime_type>","file_path":"<本机小型 QA 文本或图片路径>"}` | 返回隔离素材 ID、扫描状态与权益状态；不得直接可用/发布 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `asset.upload.batch` | `{"assets_json":"<经核对的合法 JSON>"}` | 返回隔离素材 ID、扫描状态与权益状态；不得直接可用/发布 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `asset.generation.confirm` | `{"job_id":"<已有 QA job_id>"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `asset.rights.update` | `{"asset_id":"<已有 QA asset_id>","rights_status":"pending"}` | 保持 pending 并读回；仅真实权益证据经人工确认后才可批准 | 核对素材快照、扫描/权益、对象存储与审计；发布数不变 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `task.clone` | `{"task_id":"<已有 QA task_id>"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `feedback.submit` | `{"task_id":"<已有 QA task_id>","rating":"liked"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `task.create` | `{"product_id":"<已有 QA product_id>","platform":"jd"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `task.create.draft` | `{"product_id":"<已有 QA product_id>","platform":"jd"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `task.answer` | `{"task_id":"<已有 QA task_id>","answers_json":"<经核对的合法 JSON>"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `task.request.create` | `{"request_text":"为 QA 商品制作待审核候选，勿发布"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `task.sku.split` | `{"task_id":"<已有 QA task_id>"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `task.group.create` | `{"entries_json":"<经核对的合法 JSON>"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `creative.brief` | `{"product_id":"<已有 QA product_id>","asset_type":"banner"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `creative.preview` | `{"product_id":"<已有 QA product_id>","asset_type":"banner"}` | 返回候选/作业和真实模型状态；核对用量成本、点数与未发布 | 核对订单/账本、model_usage、创意点及审计前后差异 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `creative.directions.update` | `{"task_id":"<已有 QA task_id>","action":"regenerate"}` | 返回 QA 任务/计划 ID 和版本；不自动发布或重试 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `task.select_direction` | `{"task_id":"<已有 QA task_id>","direction_id":"<已有 QA direction_id>"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `task.plan.confirm` | `{"task_id":"<已有 QA task_id>"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `content.generate` | `{"task_id":"<已有 QA task_id>"}` | 返回候选/作业和真实模型状态；核对用量成本、点数与未发布 | 核对订单/账本、model_usage、创意点及审计前后差异 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `content.draft.generate` | `{"draft":"true","draft_title":"QA 候选请勿发布","idempotency_key":"<本次唯一 QA 键>","draft_prompt":"仅制作待审核候选，不发布"}` | 返回候选/作业和真实模型状态；核对用量成本、点数与未发布 | 核对订单/账本、model_usage、创意点及审计前后差异 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `content.review.decide` | `{"content_version_id":"<已有 QA content_version_id>","code":"<审核项代码>","field":"<经确认的 field>","status":"acknowledged"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `content.visual.select` | `{"content_version_id":"<已有 QA content_version_id>","visual_refs_json":"<经核对的合法 JSON>","expected_revision":"<刚读回的版本>","reason":"QA 验收，勿发布"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `content.export` | `{"content_version_id":"<已审核 QA 版本 ID>","format":"manifest"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `content.approve` | `{"task_id":"<已有 QA task_id>","content_version_id":"<已有 QA content_version_id>"}` | 返回明确人工决定和新版本；核对前置、审计与状态 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `content.restore` | `{"content_version_id":"<已有 QA content_version_id>"}` | 返回 QA 对象和版本或明确门禁；不得以 schema 通过代替业务结果 | 核对任务/内容版本/候选/审计，发布与账本变化另核 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `knowledge.rule.create` | `{"name":"<明确标记 QA 的名称>","content":"<经确认的 content>","scope":"global","source_kind":"internal","source_reference":"qa://internal-rule","source_checked_at":"<当前 ISO 时间>","version":"<实际版本>","status":"draft"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `knowledge.asset.create` | `{"kind":"brand","name":"<明确标记 QA 的名称>","content_json":"<经核对的合法 JSON>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `knowledge.asset.update` | `{"asset_id":"<已有 QA asset_id>","content_json":"<经核对的 QA 内容 JSON>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `knowledge.brand.preference.update` | `{"preferences_json":"<经核对的合法 JSON>","version":"<实际版本>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `knowledge.feedback.record` | `{"kind":"feedback","reason":"QA 验收，勿发布"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `knowledge.learning.confirm` | `{"suggestion_id":"<已有 QA suggestion_id>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `knowledge.learning.dismiss` | `{"suggestion_id":"<已有 QA suggestion_id>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `knowledge.competitor.create` | `{"competitor_name":"<明确标记 QA 的名称>","source_json":"<经核对的合法 JSON>","summary":"<经确认的 summary>","structure_json":"<经核对的合法 JSON>","selling_points_json":"<经核对的合法 JSON>","expression_json":"<经核对的合法 JSON>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `knowledge.competitor.reference` | `{"competitor_id":"<已有 QA competitor_id>","own_brand_name":"<经确认的 own_brand_name>","own_selling_points_json":"<经核对的合法 JSON>"}` | 返回同租户新版本/引用与审计，确认前不得提升可信度 | 核对知识记录/版本/来源、审计与租户隔离 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |

## 预期阻断（7 项）

| 方法 | 最小安全参数 | App 预期结果 | 副作用核对 | 114000 App 实际状态 | 123300 App 实际状态 | 124800 App 实际状态 | 125100 App 实际状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `commercial.service-boundary.accept` | `{"policy_version":"<实际版本>","policy_checksum":"<实际校验值>","acceptance_ref":"<真实条款引用>","accepted_at":"<当前 ISO 时间>","idempotency_key":"<本次唯一 QA 键>"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对订单/账本、model_usage、创意点及审计前后差异；请求前后必须无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `workspace.invitation.accept` | `{"expected_revision":"<刚读回的版本>"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对工作区状态、授权/导出/删除队列与审计；请求前后必须无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `commercial.order.create` | `{"purchase_kind":"purchase","sku_code":"<已批准 QA 套餐 SKU>","idempotency_key":"<本次唯一 QA 键>","reason":"QA 验收，勿发布"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对订单/账本、model_usage、创意点及审计前后差异；请求前后必须无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 交互写入门禁拒绝，未完成写入 |
| `workspace.deactivate` | `{"reason":"QA 验收，勿发布"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对工作区状态、授权/导出/删除队列与审计；请求前后必须无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `workspace.activate` | `{"reason":"QA 验收，勿发布"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对工作区状态、授权/导出/删除队列与审计；请求前后必须无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |
| `workspace.data.delete.request` | `{"scope":"<隔离租户范围>","reason":"隔离环境双人审批演练","idempotency_key":"<隔离唯一键>"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对工作区状态、授权/导出/删除队列与审计；请求前后必须无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 交互写入门禁拒绝，未完成写入 |
| `multimodal.image.edit` | `{"request_json":"<经核对的合法 JSON>"}` | 生产 demo 不执行正向写入；隔离环境用无写会话/无权限/缺资源请求核对明确拒绝 | 核对工作区相关快照与操作审计前后差异；请求前后必须无变化 | 未在此版 App 正向完成 | 未在 123300 版 App 调用 | 未在 124800 版 App 调用 | App 门禁；创意点余额无法确认，未完成正向业务 |

## 执行记录模板

每项记录：安装版本与新会话、工具名、QA 对象与工作区、App 画面、请求 ID、结构化结果、服务端读回、审计/账本差异、结论（正向通过 / 预期阻断 / 产品门禁 / 缺陷 / 未执行）。清单生成时未发起任何 `tools/call` 或生产写入。
