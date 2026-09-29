# ChatGPT App 内 Store Nova 插件真实链路验收（2026-09-29）

## 环境与结论

- **2026-09-29 07:46 CST 本地插件升级与宿主复验：通过。** 商品货号与 SKU ID 的 Skill、MCP 工具说明已分开，插件本地直装版本为 `0.1.0+codex.20260929074100`，源码与安装缓存 53 个运行文件及 131 个商家工具验真一致。首次升级版本的 macOS 缓存缺少 Keychain helper，App 的 MCP 握手失败并在[失败截图](evidence/2026-09-29-chatgpt-app/16-plugin-helper-startup-failed.png)中明确未伪造商品结果；现已修复升级脚本，使其在已验真缓存中自动编译 helper，相关插件测试 130 项、全仓类型检查通过。重新安装、完全重启 ChatGPT 后，新 Codex 会话通过 `onboarding.status` 和 `catalog.search` 实际查询生产数据，[Codex 会话截图](evidence/2026-09-29-chatgpt-app/18-final-plugin-natural-query.png)显示贵人鸟官方旗舰店、`QA测试商品请勿发布`、¥199、库存 3、事实未确认。另在 **ChatGPT Work** 新会话选择 Store Nova，真实调用 “Catalog search” 并返回同一结果，见[Work 会话截图](evidence/2026-09-29-chatgpt-app/19-chatgpt-work-plugin-product-code.png)。本轮没有再次导入、生成内容或发布。
- **2026-09-29 07:22 CST 货号查询修复已部署并在 App 复验。** 线上 API 双副本切至无迁移候选 `fd1ad6a7bd122a391350c185798ac07e92795f8c`，发布 ID `release-demo-product-code-20260929`，只改 6 个源码/测试文件。候选 `npm run typecheck`、完整 `npm run test:release-gates` 通过（Vitest 1325 通过、16 项既有跳过）；受保护部署脚本的候选/回滚 Compose 校验、双副本健康与公网发布身份检查通过，数据库仍为迁移 254。运营用同一 CSV 对同一 QA 商品重新导入，保持商品事实未确认。ChatGPT App 随后以 `catalog.search(scope="workspace", query="QA-DO-NOT-PUBLISH-20260929")` 真实命中 1 件商品，返回 `local_product_key`、`accountId=42169`、正确店铺名、`skuCount=0` 与 `factsConfirmed=false`，见[App 货号查询结果](evidence/2026-09-29-chatgpt-app/15-chatgpt-product-code-search.png)。商品货号现可按普通文本查询，仍与真正的 `sku_id` 区分；没有迁移数据库，也没有确认或发布这条 QA 商品。
- **2026-09-29 06:55 CST 店铺商品上传复验：桌面和 App 链路通过。** 运营后台选择 `ws_guirenniaoniao` 与人工登记店铺 `jd:42169` 后，[上传入口可用](evidence/2026-09-29-chatgpt-app/10-ops-store-upload-entry.png)。故意把 CSV 的店铺账号写成 `jd:42169` 时，页面提示归属不符并禁用导入；改为实际账号 `42169` 后预览通过。提交一条标为 `QA测试商品请勿发布`、货号 `QA-DO-NOT-PUBLISH-20260929` 的测试记录，填写资料来源与原因，后台明确显示[已导入 1 个商品](evidence/2026-09-29-chatgpt-app/11-ops-csv-import-success.png)。商家账号 `demo@ys.com` 在 1440px 桌面工作台的该店铺[看到这 1 件商品](evidence/2026-09-29-chatgpt-app/14-merchant-imported-product.png)。ChatGPT App 再用 `catalog.search(scope="workspace", query="QA测试商品请勿发布")` 只读查询，返回该商品、`platform=jd`、`accountId=42169`、店铺名“贵人鸟官方旗舰店”、店铺状态 `manually_registered`、`factsConfirmed=false`，见[App 真实结果](evidence/2026-09-29-chatgpt-app/12-chatgpt-imported-product.png)。另用 macOS 原生文件选择器选择含一条 SKU 的 XLSX，[预览 1 个商品](evidence/2026-09-29-chatgpt-app/13-ops-xlsx-preview.png)，未提交该 Excel，故没有第二条测试写入。此 CSV 只有商品货号、未填 `SKU编码`，App 原始结果 `skuCount=0`；首次回复仅按 SKU 找货号而误判“未找到”，随后以商品名重新查询并正确显示。需优化 App 的货号/SKU 提示。
- **2026-09-29 06:47 CST 复验更新：App 文案候选已真实交付。** 线上 API 双副本已从 schema 254 兼容候选 `2f6b4387329921e91558e332243be1b8901e0ad4` 更新为 `release-demo-draft-preflight-20260929`；没有迁移数据库。ChatGPT App 先读到工作区 `ws_guirenniaoniao`、人工登记店铺 1 家、授权店铺 0 家、未绑定商品 1 件，见[更新后只读结果](evidence/2026-09-29-chatgpt-app/08-postdeploy-read.png)。随后仅调用一次 `content.draft.generate`，返回贵人鸟儿童运动鞋雾霾蓝 42 号的待审核候选，明确未创建正式版本、未批准、未发布，见[App 候选与账务截图](evidence/2026-09-29-chatgpt-app/09-postdeploy-draft-settled.png)。服务端只读账本核对该次 `qwen3.8-flash` 用量为输入 348、输出 403 token，成本 ¥0.001161，`model_usage_ledger` 和 1 点创意点预留均为 `settled`。这证明此次候选生成链路通过，不代表其余 130 个工具或正式商品审核发布流程已全通过。
- 先前两次失败用量现为 `manual_attention`，各自 1 点预留仍为 `active`，错误仍是 `MODEL_USAGE_COST_MISSING`；没有补成本、退款或重放。必须用逐笔 provider 成本证据对账。
- 宿主：macOS ChatGPT App 的 Codex 工作区；插件为本地直装、stdio MCP，实际进程运行 `merchant-marketing/mcp/bridge.mjs`。
- 云端：`https://yxsona.com`，工作区 `ws_guirenniaoniao`。文本模型配置为 `qwen3.8-flash`，当前公网 release 为 `release-demo-product-code-20260929`，API 双副本和运营后台健康探针正常；数据库仍为迁移 254。
- **已在 App 中看到真实产出**：`onboarding.status` 返回 1 家人工登记店铺、0 家官方授权店铺；`catalog.search({scope:"workspace",limit:"10"})` 返回 1 件真实商品，并正确提示该商品未绑定店铺。见 [工作区截图](evidence/2026-09-29-chatgpt-app/01-onboarding-success.png)、[商品截图](evidence/2026-09-29-chatgpt-app/02-catalog-success.png)。
- 本地插件已从当前源码重新加入、重建 macOS Keychain helper；重启后的 ChatGPT App 再次调用 `onboarding.status` 成功，见 [更新后 App 截图](evidence/2026-09-29-chatgpt-app/06-updated-plugin-app-success.png)。云端 API 修复随后按本报告开头记录部署。
- **历史失败记录**：修复部署前，`content.draft.generate` 被错误的品牌范围授权挡住；`merchant.first_value` 的一次模型调用返回成本结算缺失，生成结果未交付，1 点创意点仍处于预留状态。见 [授权阻断](evidence/2026-09-29-chatgpt-app/03-draft-scope-block.png)、[模型阻断](evidence/2026-09-29-chatgpt-app/04-draft-cost-block.png)、[积分账本](evidence/2026-09-29-chatgpt-app/05-points-reserved.png)。
- 配置热修后、代码修复部署前，在 App 中用**新幂等键**验证了一次：`qwen3.8-flash` 返回 341/377 token，但中转价格接口在结算时超过 10 秒超时，仍被 `MODEL_USAGE_COST_MISSING` 阻断；结果未交付。见 [热修后截图](evidence/2026-09-29-chatgpt-app/07-priced-model-cost-timeout.png)。两次旧调用各有 1 点 `active` 预留，均未结算；此后仅在代码修复部署后又做了一次受控生成验收并成功结算。
- API 候选已加入并部署价格前置检查：先验证当前文本模型的中转价格、计费组与汇率，再预留创意点和调用模型。价格检查失败时返回 `MODEL_PRICING_PREFLIGHT_UNAVAILABLE`，并明确 `provider_executed=false`、`points_reserved=false`。App 的一次真实生成与账本结算已通过；价格接口持续稳定性仍需持续观测。

## 实测覆盖

### 08:53 CST 全工具复测增量（仍在验收中）

- [131 项逐工具验收矩阵](2026-09-29-plugin-all-tools-matrix.md)分别记录 App 成功、生产 MCP 成功、权限或参数阻断、本地契约及未测成功路径；工具发现或本地校验不计为业务成功。
- 本轮最初安装的插件暴露 **131** 个工具；升级后已安装 `0.1.0+codex.20260929083842`，本地安装验收确认 **119** 个工具。ChatGPT Work 本轮真实调用了 `onboarding.status`、`asset.list`、`billing.status`、`creative-points.balance.get`、`rule.sync.status`，均返回生产工作区数据；见[五接口截图](evidence/2026-09-29-chatgpt-app/20-chatgpt-work-five-readonly-tools.png)。第二组实际调用 `catalog.categories`、`canonical.product.consistency`、五个 `knowledge.*` 只读接口和 `deliverable.list`；见[知识库截图](evidence/2026-09-29-chatgpt-app/21-chatgpt-work-knowledge-readonly-top.png)。再次调用 `catalog.search(scope=workspace)` 返回两件商品，一件 QA 商品事实未确认，另一件商品事实已确认但店铺账号未绑定；见[商品总览截图](evidence/2026-09-29-chatgpt-app/22-chatgpt-work-all-products.png)。此前 `content.draft.generate` 的一次真实中转、成本和点数结算证据仍有效。
- 多组 agent 使用商家演示账号签发的短期工作区 MCP 凭据，经本地 stdio 插件调用生产只读工具。账务 13 项均完成调用，其中 `billing.export` 明确返回仅商家后台可导出，模型用量和交易明细只返回后台入口；素材列表返回 11 件，图片任务不存在时正确返回 `IMAGE_GENERATION_JOB_NOT_FOUND`；任务和批量计划列表当前均为空，带虚构 ID 的受保护查询按预期拒绝。以上是**读取或安全阻断**证据，不是写入成功路径证据。
- 桌面生产复测：运营后台选定 `ws_guirenniaoniao` 和人工登记的 `jd:42169` 后，`上传 Excel / CSV` 启用，XLSX 模板可下载；商家后台能查看 QA 商品。当前商家生产页面没有自己的 Excel 导入入口，“知识库”导航实际显示素材库。正式任务、审核、导出、图片生成、素材上传会话、批量生成和发布没有完成线上成功路径；不能称为全功能通过。
- 已发现并在**本地插件新版**修正：只读邀请查询被写门禁误挡；`merchant.first_value(draft=true)`、竞品参考和字段映射预检被误标为纯只读；12 个平台/运营权限工具被商家错误列出；图片任务查询的二选一参数契约缺失。`0.1.0+codex.20260929083842` 已经本地直装，源码/缓存各 119 个工具、53 个运行文件一致；完整重启 ChatGPT 后，新 Work 会话真实调用 `onboarding.status` 和 `catalog.search` 成功，见[升级后截图](evidence/2026-09-29-chatgpt-app/26-upgraded-119-tool-plugin-app-readonly.png)。随后发现 3 个分片上传工具固定返回 503，已在 `0.1.0+codex.20260929090000` 隐藏，并把授权回调黑底文本页改为同页状态弹框；新版已本地安装，源码/缓存各 116 个工具、53 个运行文件一致，ChatGPT 重启后的业务调用待复验。隔离 Chromium 已覆盖回调处理中→成功和处理中→失败，见[浏览器证据](evidence/2026-09-29-chatgpt-app/local-plugin-callback-browser-e2e.md)。非法导出申请 ID 在生产返回 500 的 API 修复仍只是本地候选，尚未部署。主分支含迁移 255，而生产数据库为 254；本轮不迁移数据库，也不能直接用主分支全量 API 发布。
- 当前公网 API 与 Ops 健康返回 `status=ok`，API 双副本和主要容器 healthy；但 `/api/healthz` 的 `productionEvidence.capability`、`productionEvidence.capacity` 都为 `blocked`，原因是证据路径不可读。正式发布门禁仍须补齐真实且可读的候选证据，不能把健康探针当作发布批准。
- 第二轮隔离验证已覆盖目录写入 37 项、正式任务和内容 106 项、知识库 API 21 项与桥接 98 项、账务定向 165 项及独立 PostgreSQL 支付链路。它们验证了实现和权限边界，**不计入生产 ChatGPT App 成功数**。账务证据见[隔离支付审计](evidence/2026-09-29-chatgpt-app/billing-write-isolated-audit.md)，正式内容见[隔离内容审计](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md)。
- 当前主分支 `npm run typecheck` 和 `npm run test:release-gates` 已通过；Vitest 1387 通过、16 跳过，后续 Node 与基础设施门禁也退出 0。此结果是本地代码质量证据；生产 API 仍为 `release-demo-product-code-20260929`，本轮未部署 API、未迁移数据库。

| 层 | 实测 | 结果 |
| --- | --- | --- |
| 本地 MCP 握手/工具发现 | `initialize`、`tools/list` | 成功发现 131 个商家工具；未暴露 `ops.*`。 |
| MCP UI 资源 | 6 个 `resources/read` | 6/6 返回。资源可读取不等于 App 已展示所有业务组件。 |
| 无前置参数只读调用 | 35 个线上工具调用 | 30 成功、2 个 `INVALID_REQUEST`、3 个 `FORBIDDEN`。后者为商家访问平台工作台能力被拒，权限边界生效，但仍出现在商家工具列表。 |
| ChatGPT App 工作区 | `onboarding.status` | 重新本地登录并完整重启 App 后成功；先前失效凭据返回 `UNAUTHENTICATED`，见 [失效截图](evidence/2026-09-29-chatgpt-app/00-auth-expired.png)。 |
| ChatGPT App 商品 | `catalog.search` 工作区范围 | 返回 1 件未绑定商品；返回的历史店铺名与人工登记店铺不同，不能自动合并归属。 |
| ChatGPT App 内容候选 | `workspace.interactive.confirm` → `content.draft.generate` | 确认成功，生成被 `AUTHZ_SCOPE_MISMATCH` 拦截。 |
| ChatGPT App 中转/账务 | `merchant.first_value(draft=true)` → 积分账本 | 真实调用一次；服务端第一响应为 `MODEL_USAGE_COST_MISSING`，插件错误重试后变成 `MODEL_ACTION_ALREADY_STARTED`。账本显示 1 点预留，未见结算/释放。 |
| ChatGPT App 上线复验 | `workspace.interactive.confirm` → `content.draft.generate` → 用量/创意点账本 | 一次真实调用返回待审核候选；模型 348/403 token、成本 ¥0.001161、1 点预留结算为 `settled`。 |
| 桌面店铺表格与 App 读取 | 错误归属 CSV 拦截、正确 CSV 导入、XLSX 原生选择与预览、App `catalog.search` | 1 条 QA 商品写入 `jd:42169` 后可在 App 查到；XLSX 仅预览，未导入。商品事实未确认、未发布。 |
| 货号搜索上线复验 | 同一 CSV 重导入 → App `catalog.search(query=商品货号)` | App 返回同一商品的真实 `local_product_key`、店铺归属和未确认状态；普通文本查询命中，SKU 数仍为 0。 |
| 插件版本升级与新会话 | 本地直装新版 → 缓存 helper 构建 → 完全重启 App → Codex/ChatGPT Work 自然语言货号查询 | 两种桌面会话入口均成功调用商家工具，返回真实店铺、商品、价格、库存和未确认状态；升级脚本已加入 helper 构建。 |

本轮未覆盖其余需要素材、店铺授权、审核状态或可能发布/扣费的工具的线上写操作；不能宣称“131 个功能全通过”。

兼容候选从线上 API 基线 `bb417660402c341df1b0d1debd5778f8b963c568` 临时隔离移植 5 个文件（2 个测试、3 个源码），无 SQL/迁移文件差异。候选类型检查、106 项定向测试、完整 `test:release-gates` 通过（Vitest 1325 项通过、16 项既有跳过，后续脚本门禁退出 0）。新 API 镜像 digest `sha256:a4ffefcf27f6df39dc9191f77f011320afcbda5ab312acf407fe7abe4b10d2d6`；受保护候选、manifest 与当前版本回滚输入逐项核对后，只更新 `api api-replica`，两副本 healthy，公网 `/releasez`、`/api/healthz`、`/api/readyz`、Ops `/healthz` 通过。临时 worktree 已移除，当前只保留主工作目录。

主分支本地检查：`npm run typecheck`、`npm run test:release-gates` 通过（Vitest 1387 项通过、16 项跳过，后续 Node/脚本门禁也通过）；前置检查、授权及相关 API 定向测试 18 项通过。插件 bridge、安装与 manifest 相关 127 项通过。实际部署的 254 兼容候选另通过 106 项定向测试和完整发布门禁；App 文案生成及账本结算已经按本报告开头的记录复验。

## 根因与已完成的修复

1. `content.draft.generate` 只生成未绑定预览，没有品牌 ID，却在 `packages/contracts/src/authz.ts` 被映射为品牌级。已将**该方法**改为工作区级，正式 `content.generate` 仍为品牌级。新增定向授权测试；本地类型检查与 14 个相关 API 测试通过。
2. 旧调用的模型用量账本记录：模型 `qwen3.7-plus`，输入 325、输出 402 token，最初状态 `pending_cost`，错误 `MODEL_PRICING_MODEL_MISSING`。线上中转 `/api/pricing` 不含该模型；其中 `qwen3.8-flash`、`qwen3.8-max` 有 VIP 组价格。**没有**据此推断旧调用实际成本，也没有释放预留或重放旧模型调用。两笔旧用量目前转为 `manual_attention`，但点数预留仍为 `active`。
   - 配置热修的新模型列于中转 `/v1/models` 且有 VIP 价格；第二次旧调用最初的 `pending_cost` 原因是 `MODEL_PRICING_FETCH_TIMEOUT`。这是价格接口可用性问题，不能把“价格表有模型”误当成每次结算都通过。
3. 插件将带幂等键的模型写请求收到的 503 当作可重试临时错误，掩盖了成本结算阻断。已在本地 bridge 阻止 `MODEL_USAGE_COST_MISSING`、`MODEL_USAGE_SETTLEMENT_PENDING` 和明确需对账的响应重试，并改为提示用户查账、勿重复生成；新增回归测试通过。
4. App 曾显示笼统 `UNAUTHENTICATED`。失效凭据的刷新端点返回 `MCP_OAUTH_INVALID_GRANT`；本地重新登录并重启 App 后查询成功。已在本地 bridge 为服务端 `UNAUTHENTICATED` 加入明确的本地登录恢复指引和回归测试。
5. 已在 `merchant.first_value(draft=true)` / `content.draft.generate` 共用处理器中加入计费前置检查；定向测试覆盖价格缺失、价格超时、有效价格，以及超时后不预留积分、不写授权/审计、不调用 provider。该修复已通过免迁移兼容候选部署，并在 App 中完成一次真实候选及账本结算复验。

## 后续优化顺序

1. **模型与价格稳定性**：当前模型为有 VIP 价格的 `qwen3.8-flash`，前置检查已部署，真实一次结算成功。继续监测中转价格接口超时和快照缓存；失败必须在调用 provider 与预留创意点之前阻断。
2. **对账两次历史请求**：两条旧用量现为 `manual_attention`，各 1 点预留仍为 `active`。平台运营需逐笔核对 provider 请求/账单与调用时价格证据；现有 `retry` 不能录入缺失成本，不能拿当前估价补记，也不能盲目退款或重放。
3. **发布基线管理**：此次仅把 5 文件补丁移植到线上 `bb417660...`，API 双副本更新到 `2f6b4387...`，数据库保持迁移 254；其他服务仍是混合源码版本。后续完整发布不得把含迁移 255 的主分支直接倒灌到 demo。
4. **App 使用引导**：首次进入先显示当前账号、工作区、人工登记/官方授权店铺数；对未绑定商品提供明确“导入/确认商品事实”入口。`catalog.search(scope=workspace)` 不需要 `platform` 和 `account_id`，修正当前 App 回复中的误导提示。
5. **工具列表与参数契约**：在商家视角隐藏或标注平台专用读工具；对 `support.customer.replies.list` 和 `catalog.image.get` 补齐必填参数 schema 或给出明确缺参提示。上传 Excel/CSV 的入口与导入后未绑定商品状态需用真实桌面和 App 流程单独验收。
6. **货号与 SKU 术语**：API、插件 Skill 与 MCP 工具说明已按商品货号 `query`、具体变体系统 `sku_id` 区分；最终本地插件版本和 App 自然语言复验已通过。后续仍需在真实 SKU 商品上补充按变体 ID 精确搜索的线上验收。

剩余验收门槛：本轮已通过真实桌面 CSV 导入、XLSX 原生选择与预览、App 读取正确店铺归属。QA 商品尚待商家确认事实，正式审核/导出、需官方授权的店铺写入流程和其余工具仍须按各自前置条件逐项实测。不能以此次候选与导入成功宣称所有流程通过。
