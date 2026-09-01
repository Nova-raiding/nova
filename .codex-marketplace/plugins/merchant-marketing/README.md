# Merchant Marketing Codex Plugin

这是可安装的 Codex Plugin 源目录，包含：

- `.codex-plugin/plugin.json`：正式 manifest，版本 `0.1.0+codex.20260831225927`。
- `skills/merchant-marketing/SKILL.md`：唯一入口 Skill。
- `.mcp.json`：Codex 标准 stdio MCP 配置；`mcp/bridge.mjs` 将标准 `tools/list`、`tools/call` 转发到现有 API 的 `/mcp` 业务方法。
- `mcp/bridge.mjs`：插件侧传输适配器，固定注入 `X-Workspace-Id`，并将 API 的统一 envelope 解包为 Codex MCP 响应。

## 安装前验收

在仓库根目录执行：

```bash
python3 /Users/lixiaomei/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py apps/plugin
env PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin npm test -- --run apps/plugin/install-smoke.test.ts packages/contracts/src/mcp.test.ts
```

验收通过后，把 `apps/plugin` 作为 `merchant-marketing` 插件源加入团队或个人 marketplace，再按 Codex 的 marketplace 安装流程执行：

```bash
codex plugin add merchant-marketing@<marketplace-name>
```

安装环境示例（在启动 Codex 的环境中设置）：

```bash
export MERCHANT_MCP_BASE_URL=https://merchant.example.com
export MERCHANT_WORKSPACE_ID=<workspace-id>
# 可选：由网关校验的 Bearer token；插件不会保存平台账号密码或 access token
export MERCHANT_MCP_TOKEN=<mcp-token>
# 仅本地 fixture 开发可显式开启；Automation 和生产环境禁止设置
# export MERCHANT_ALLOW_FIXTURE_FALLBACK=true
# 仅已明确确认的交互会话按需开启；Automation 禁止设置
# export MERCHANT_MCP_WRITE_ENABLED=true
# 生产激活规则时由审批系统注入，不要写入仓库
export MERCHANT_RULE_APPROVAL_TOKEN=<rule-approval-token>
```

商家身份与角色由服务端 Bearer/OIDC 授权映射决定。安装包不会静态声明 `MERCHANT_ACTOR_ID` 或 `MERCHANT_MCP_ROLE`，也不会用客户端角色覆盖服务端成员权限；本地非严格鉴权测试需要模拟身份时，应在独立测试进程中显式注入，不能写进正式插件清单。

`MERCHANT_MCP_BASE_URL` 必须是商家服务的根 origin（例如 `https://merchant.example.com`），不能包含 `/mcp`；bridge 会自行请求 `${MERCHANT_MCP_BASE_URL}/mcp`。生产环境必须使用 HTTPS（本地开发可用 HTTP），并与已通过发布门禁的商家 Ingress 域名一致，不能指向独立示例网关或 Ops 域名。首次运行可不设置 `MERCHANT_WORKSPACE_ID`，先调用 `workspace.bootstrap` 创建工作区；bridge 会将脱敏的 workspace binding 保存到用户级 `CODEX_HOME/merchant-marketing/workspace-binding.json`，新会话自动恢复，也可按需改用环境变量覆盖。后续 `MERCHANT_WORKSPACE_ID` 是租户边界，不是平台授权凭证。生产网关必须校验 Codex/用户身份后再允许该工作区访问，不能仅相信客户端传入的工作区字符串。

bridge 对缺失或未解析的 `${MERCHANT_MCP_BASE_URL}`、`${MERCHANT_WORKSPACE_ID}` 默认失败关闭，避免 Codex App 或 Automation 静默分析错误工作区。只有本地 fixture 开发可以显式设置 `MERCHANT_ALLOW_FIXTURE_FALLBACK=true`，此时才回退到 `http://127.0.0.1:8790` 和 `ws_demo`；Automation 与生产环境禁止开启该选项。

插件运行时默认禁用高成本或高风险的 MCP 工具。`platform.connect`、`billing.recharge.create` 以及商品只读同步（`catalog.sync`、`catalog.sync.start`、`catalog.sync.get`）属于首步激活/只读数据入口，余额为 0 时仍可使用；商家明确要求生成、编辑、批准或发布时，Skill 先调用 `workspace.interactive.confirm` 开启当前 15 分钟交互写会话，不需要手工设置环境变量。Automation 不调用该确认工具并保持只读。该门禁发生在 API 转发前，避免模型误路由或不可信店铺文本触发任务创建、批准或发布等副作用；真实平台写入仍需叠加钱包、事实、审核、平台能力、确认哈希、幂等和审批门禁。

## 安装后第一步

插件下载并启用后，第一步调用只读入口 `merchant.start`，展示当前步骤、四步 onboarding 和可直接复制的下一句；如尚未有工作区，再调用 `workspace.bootstrap`。随后展示京东、淘宝、天猫、拼多多、小红书、抖音六个平台的授权选项；商家选择平台和店铺后调用 `platform.connect`，授权回调完成后刷新 `workspace.health`，确认每个店铺的 `platform + account_id` 范围。小红书/抖音在官方能力未就绪时只能标记为 fixture/API 或待配置，不得显示为生产已授权。

同一平台可以绑定多个店铺；商家必须明确选择店铺，不能默认使用列表第一家。绑定成功后再调用 `billing.status` 展示钱包余额与充值入口，最后才进入“上传我的商品图片和资料”：在新会话输入框左下角点击“+”添加商品图片、PDF、Word、Excel、CSV 或文字资料。插件会按已选店铺建立素材库和商品档案，不会自动拿演示商品替代用户商品。

## 在插件中查看订单与账单

在 ChatGPT 会话中输入“查看我的订单和账单”，插件调用 `billing.status` 并在原生对话中展示余额、账务摘要和下一步操作；只有用户明确进入充值流程时才打开充值组件。账务查询默认 `scope=mine`，只展示当前认证用户创建或消费的记录；有权限的工作区角色可以切换到 `scope=workspace` 查看租户汇总。余额始终属于工作区共享钱包，不代表每个用户拥有独立资金账户。迁移前无法确定用户归属的旧记录只会出现在工作区视图，并明确标记为“历史未归属”。

也可以在新会话中输入“查看我的商品目录和平台连接状态”。插件应先调用 `workspace.health`，再调用 `catalog.search`：查看具体店铺时必须传 `platform + account_id`，只有明确要求全部店铺只读汇总时才传 `scope=workspace`。若出现 `MERCHANT_WORKSPACE_ID is required`、`WORKSPACE_SCOPE_REQUIRED` 或 MCP 工具不可见，应先修复环境变量、网关路由或身份映射，不要继续创建任务。

任务需要补充信息时，使用 `task.answer` 保存答案和输入快照；事实未明确确认前，不进入正式生成和发布。

当前 0.1.0 的商家侧 Codex MCP 源码运行态清单为 150 个工具（包含 `merchant.start`、只读的 `merchant.first_value`、`task.understand` 和当前工作区充值订单列表），覆盖完整主流程；运营、财务敏感工具、`asset.scan` 与 `content.codex.*` 开发入口不在商家插件展示。商家可在 Codex 内按六个平台、店铺、商品、任务和版本查找已批准/已交付内容摘要，以及与版本精确绑定的已归档主图候选摘要。列表不返回正文、图片字节或 URL；选中代表候选后由 `catalog.image.get` 按需读取。生成候选不会覆盖商品当前图片，也不能被称为平台已发布图。OAuth 授权回调仍由服务端 REST/官方页面承载；Merchant Studio 仅用于开发调试，商家不需要打开它。平台统一承担模型中转站费用，商家只需充值/购买额度，不需要提供自己的 Key。小红书/抖音在官方连接器证据齐全前仅显示为 fixture/API 可用，不代表生产可写。

安装缓存更新后必须重新验证：当前商家插件源码运行态 `tools/list` 为 150 个 MCP 工具，且不得包含任何 `ops.*`、`asset.scan`、`content.codex.prepare`、`content.codex.commit` 或运营敏感工具，以 ChatGPT App 当前运行态清单为准。

主图候选必须先由 `catalog.image.get` 展示、由 `catalog.image.review` 完成检查，再由商家明确选择 1–6 张及顺序后调用 `content.visual.select`。该操作不会改写原版本，而是派生一个新的 `review_required` 内容版本；选图确认、新版本审核与批准、最终发布确认是三个独立步骤，不得互相替代。任何选图集合或顺序变化都会使旧的 `publish.prepare` 预览和确认哈希失效，必须重新审核、批准、准备预览并获得新的明确确认。

`publish.prepare` 会展示已冻结选图的发布预览。当对应平台的官方媒体上传适配器未实现或未配置时，预览会标记 `IMAGE_PUBLISH_ADAPTER_UNAVAILABLE` 且提交失败关闭。插件禁止删掉已选图、回退商品旧图、改成纯文案发布或声称图片已发布；必须先配置对应平台适配器，然后重新执行 `publish.prepare` 和独立发布确认。

`content.export` 在 bridge 内把 bundle、Markdown、JSON 或 manifest 写入权限为 `0600` 的会话隔离临时文件，并返回 MCP `resource_link`；正文和 ZIP Base64 不进入模型文本或 `structuredContent`。生产环境必须显式配置绝对 `MERCHANT_ARTIFACT_DIR`，单文件限制 25MB、单会话最多 100 个文件/250MB。文件卡片出现只证明导出已生成，不证明用户已下载、内容已批准或平台已发布。

`workspace.health` 返回不含凭据的 `storeDirectory`。Codex 用别名/店铺名帮助商家选店，但所有店铺级调用最终都固定为 `platform + accountId`；同名、多候选、撤权或待刷新授权时必须阻断，不会默认选择列表第一家。`workspace.metrics` 支持按该组合执行单店分析；改别名不会改变授权代次或运营快照 hash。

店铺目录同时返回脱敏的最后已知授权摘要与同步摘要：实际授权回包报告的 scope、访问令牌到期时间、是否具备刷新能力、最近授权时间，以及最近同步尝试、最近完整成功和最近可用数据时间。访问令牌到期不等于店铺授权到期，健康检查不会读取或返回 Vault 凭据；旧快照或平台未返回的字段保持 `unknown`。撤权店仍可查看历史同步记录，但不能被显示为当前可读。

## Codex App 原生 Automations

生产环境默认关闭 API/Worker 的旧版内部 Automation tick；返回 codex_native_automations_only 且不会创建同步任务。
只有经过运营迁移审批的独立内部调度部署，才可显式设置 MERCHANT_INTERNAL_AUTOMATION_TICK_ENABLED=true。
商家插件和原生 Automation 模板不得设置该变量。

插件不实现独立定时任务服务。每日店铺风险巡检和每周六平台经营简报由 Codex App 原生 Automations 负责调度、历史与通知，插件通过根目录 `scheduled/*.json` 提供原生模板，并由 Skill 与现有只读 MCP 数据能力执行。安装后可从合并的默认入口 `创建六平台运营巡检 Automation（每日风险巡检或每周经营简报）` 进入，再选择插件提供的两个模板：

- `创建每日店铺风险巡检 Automation`
- `创建每周六平台经营简报 Automation`

两个模板覆盖京东（`jd`）、淘宝（`taobao`）、天猫（`tmall`）、拼多多/PDD（机器标识 `pinduoduo`）、小红书（`xiaohongshu`）和抖音（`douyin`）；完整提示词、只读工具白名单、输出结构和失败降级见 `skills/merchant-marketing/references/automations.md`。无人值守默认只调用 `workspace.health` 和 `workspace.metrics`，严格按 store/account 隔离，fixture、unbound 与真实店铺不得混算；流程禁止同步、内容生成、批准、充值、发布和任何平台写入。

`workspace.metrics` 支持可选的 `platform + account_id` 单店范围，以及 `date_from`、`date_to` 和 `risk_limit`；并返回按 `platform + accountId` 隔离的 `stores`、单列的 `unboundLocalData`、稳定 `riskItems`/`snapshotHash`、数据覆盖与基线状态。它不会保存 Automation 历史，也不会把账号记录等同于官方 API 可读；fixture、official API、仅账号记录和不可用状态必须分别呈现。

模板不假定 Codex App 会自动提供上一次运行结果。没有包含稳定 risk key 的宿主基线时，报告必须标记 `comparisonAvailable=false`、`comparisonReason=baseline_unavailable` 并只描述当前风险；只有宿主明确提供兼容基线时才比较变化。插件自身不保存快照，也不承诺未经过宿主实测的“仅变化时通知”。

`scheduled/*.json` 已按 Codex App `26.818.61809`（build 7019）桌面端实际解析器的 `name + prompt + schedule` 契约校验；桌面端会直接扫描已安装插件的 `scheduled/` 目录，当前 plugin manifest 契约不接受 `scheduledTasks` 字段，因此不添加臆测字段。App Server 的 `plugin/read.scheduledTasks` 当前返回 `null`，它不能作为桌面端“From Plugins”模板扫描结果；创建、Run now、历史和通知仍需在桌面 UI 完成真实 canary 后才能宣称可用。

只读入口会通过 MCP annotations 标记为 `readOnlyHint`，因此 `workspace.health`、目录查询、版本查看和状态查询不会被 Codex 的自动审批策略误判为写操作；发布、规则激活、素材权益确认等写操作仍保留人工确认门禁。

发布必须严格按 `publish.prepare` → 展示字段 diff/两个 hash → 用户明确确认 → `publish.confirm` 执行；批量发布使用 `publish.batch.prepare` → 逐项确认 → `publish.batch.confirm`，可暂停/恢复并对失败项重新确认重试。`publish.confirm` 的重复请求使用参数派生的稳定幂等键；返回 `unknown` 只能进入人工对账，不能改写为 `published`。

本插件默认不声明平台真实写权限；生产写入仍受服务端平台配置、人工确认和幂等门禁控制。修改插件后需在 Codex 中开启新会话，确保 Skill 和 MCP 工具重新加载。
当前发布元数据同步基线（2026-08-31）：`tools/list` 为 150 个 MCP 工具；`asset.scan` 仅用于测试/显式本地 fixture，不在生产商家插件展示。
