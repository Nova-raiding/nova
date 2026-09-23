# Store Nova Codex 插件

macOS 新安装当前仍使用本地登录 CLI：它在 `127.0.0.1` 随机端口接收 PKCE S256 回调，服务端签发的工作区 access/refresh token 作为一个绑定 API origin 与 workspace 的原子包写入 macOS Keychain。`storenova://` Helper 目前仅为开发与恢复原型，不能作为生产默认入口。launchd 只保存非敏感连接配置。旧 `install-local-macos.sh` 仅用于既有 launchd token 部署的兼容维护，不推荐新用户使用。

当前商家主流程为：**公开链接/手工资料 → 内容生产 → 工具支持时审核、导出**。这是产品范围与目标顺序，每个阶段以实际工具支持和服务端结果为准；未绑定候选的审核/导出缺口见下文。实际工具以当前连接的 `tools/list` 与运行态契约测试为准，不在文档中固化工具数量，也不以数量证明生产就绪。

这是可安装的 Codex Plugin 源目录，包含：

- `.codex-plugin/plugin.json`：正式 manifest；其版本必须与插件 `package.json` 一致，安装时以当前包内值为准。
- `skills/merchant-marketing/SKILL.md`：唯一入口 Skill。
- `.mcp.json`：Codex 标准 stdio MCP 配置；`mcp/bridge.mjs` 将标准 `tools/list`、`tools/call` 转发到现有 API 的 `/mcp` 业务方法。
- `mcp/bridge.mjs`：插件侧传输适配器，固定注入 `X-Workspace-Id`，并将 API 的统一 envelope 解包为 Codex MCP 响应。

交给技术安装人员或商家时，先阅读仓库根目录的[安装与配置手册](../../docs/store-nova-chatgpt-plugin-install-manual.md)。手册包含本地源码安装、macOS Keychain 登录、工作区绑定、模型中转边界、重启验收和 `MCP_CONFIGURATION_REQUIRED` 排障；不要把开发环境示例直接复制到生产商家电脑。

### 生成包含本地运行环境的安装包

在仓库根目录执行 `node apps/plugin/scripts/package-local-plugin.mjs`。打包机会下载 nodejs.org 官方 Node v22.16.0 归档，并同时校验固定在源码中的平台 SHA-256 与官方 SHASUMS，按当前操作系统及架构生成独立包。macOS 构建还会编译 Keychain helper，并把源码、二进制及哈希证明一起放进包；生成的 `.tar.gz` 是未签名验收候选，不能直接作为用户交付物。macOS 正式交付使用已签名、公证并装订票据的 `.dmg`，Windows 正式交付使用签名 helper 的 `.zip`。文件名包含 `darwin-arm64`、`darwin-x64` 或 `win32-x64` 等平台标识。API、数据库、worker、运营后台不进入用户包；bridge 通过 HTTPS 使用云端服务。

有 Developer ID Application 证书的 macOS 发布机设置 `STORENOVA_MAC_SIGNER_THUMBPRINT`、`STORENOVA_MAC_TEAM_ID` 与 `STORENOVA_MAC_NOTARY_PROFILE` 后运行 `node apps/plugin/scripts/build-signed-macos-package.mjs <输出.dmg>`。脚本签名包内 Node、Keychain helper 和 DMG，要求 Apple 公证通过、票据装订，并在只读挂载的最终 DMG 中核验可执行文件签名、摘要与 Gatekeeper 评估，随后输出 `.dmg` 与 `.sha256`。正式用户打开该 DMG 并运行 `install-all.command`：入口先核验本机 ChatGPT.app 的 OpenAI 签名、原生架构与 Gatekeeper 公证；若未安装，则打开 OpenAI 官方通用下载页，等待用户完成原版安装后再继续安装插件。DMG 不包含、重签或修改 ChatGPT.app。随后用户输入管理员分配的工作区并在浏览器确认授权。安装器使用包内 `runtime/node`，写入个人插件源、安装缓存和启用配置，不要求用户安装 Node、Swift 或 Codex CLI。最后完全重启 ChatGPT，在新对话调用 `onboarding.status` 验证。商家账号、工作区、网络以及 ChatGPT 桌面应用仍是使用服务的必要条件。

Windows 用户必须同时取得同一发布生成的 `<名称>.zip` 和包外 `<名称>.install.ps1`，先确认包外安装器的 Authenticode 签名来自平台公布的生产发布者，再运行该 `.install.ps1`。签名安装器绑定整个 ZIP 的 SHA-256，先验证整包，随后在已验证的内容中检查本机 ChatGPT 的 OpenAI 发布者、Microsoft Store 签名与 x64 架构；缺失时通过官方 Store/winget 安装原版客户端，再安装插件。ZIP 不包含或修改 ChatGPT 客户端。用户输入管理员分配的工作区并在浏览器确认授权，也可稍后运行 `login.cmd --workspace ws_平台分配的工作区`。不要直接运行 ZIP 内 `install.cmd`、`install-chatgpt.ps1`、`install-plugin.ps1` 或 Node 脚本；这些批处理/PowerShell 安装入口已改为拒绝。重启 ChatGPT 后在新对话验证 `onboarding.status`。Windows 包仅能在真实 Windows 构建及安装环境完成发布验收。

有生产签名证书的 Windows 发布机运行 `powershell.exe -NoProfile -File apps/plugin/scripts/build-signed-windows-package.ps1 -OutputPath <输出.zip> -CertificateThumbprint <证书指纹> -TimestampServer <可信时间戳服务地址>`。证书私钥留在 Windows 证书库或签名硬件中；证书必须包含代码签名用途、处于有效期内，正式包拒绝自签名证书和 CI 测试证书。脚本签名自包含 helper 与包外 `<输出>.install.ps1`，核验两者证书链与时间戳，并核验包内官方 Node 的 Authenticode 发布者和时间戳。包外签名安装器内嵌最终 ZIP 哈希并在执行包内代码前验证；独立 `.sha256` 仅作辅助校验，不是信任根。已有输出不会被覆盖，缺少证书、时间戳或校验失败时不会留下候选交付物。CI 临时测试证书和包只用于 GitHub Actions，不得作为用户交付物。

当前 `storenova://` 连接助手只作为开发与故障恢复原型随包提供源码和本机构建脚本，独立包不会携带 `.app`。在完成签名/公证、安装实例密码学绑定和抗 scheme 劫持验收前，安装与升级脚本不会自动注册该 scheme，也不得把它作为生产“一键连接”路径。生产页面继续使用受约束的手工登录流程；验收器会明确返回 `production_ready=false`，避免把源码存在误报成可发布能力。

`storenova://` 连接助手仍只有源码；它与正式登录所需的凭据 helper 是不同组件。Windows 开发机可设置 `STORENOVA_WINDOWS_CSC_PATH` 后运行 `node scripts/build-connect-helper-windows.mjs`，它只生成未签名的连接助手 EXE 和 SHA-256 文件，不会写注册表、安装协议或访问 Credential Manager。`verify-connect-helper-windows.ps1` 会核对 SHA-256、Authenticode 和签名者；即使签名通过，在安装实例绑定完成前仍返回 `production_ready=false`，不会注册 `storenova://`。

Windows 包内 `install-chatgpt.ps1` 和 `install.cmd` 均拒绝直接安装；包外签名安装器验证整包后才调用包内安装逻辑。打包流程仍核对凭据 helper 的哈希、有效 Authenticode 签名和发布签名者指纹。此检查不代表 `storenova://` 连接助手已通过其独立的安装实例绑定门禁。

### 本地安装（不使用 ChatGPT OAuth）

本插件支持本地桌面模式：ChatGPT/Codex 启动已安装包中的 stdio bridge，bridge 通过 HTTPS
连接 Store Nova API。它不使用 ChatGPT 远程 MCP OAuth，也不要求 OpenAI Apps challenge 或
公开/团队插件市场上架。浏览器中的确认页属于 Store Nova 本地插件登录，只用于把当前商家
会话授权给本机 CLI，不是 ChatGPT OAuth。

若 `MERCHANT_MCP_BASE_URL` 指向公网 `https://yxsona.com`，本地 bridge 仍可通过 HTTPS 和
服务端签发的短期 Bearer 调用，不需要 ChatGPT OAuth；只有把公网 `/mcp` 直接登记为 ChatGPT
云端远程 MCP 时才需要 OAuth。“本地安装”不能绕过公网服务端的身份、工作区/RLS 和审计门禁。

新安装流程为：CLI 生成 PKCE S256 与 state，打开 Store Nova
`/v1/auth/local-plugin/authorize`，在 `127.0.0.1` 随机端口接收一次性回调，再向
`/v1/auth/local-plugin/token` 交换短期凭据并写入 Keychain。插件不接收密码或 Cookie；未登录、
跨来源、停用账号、工作区不匹配或 Keychain 写入失败时均失败关闭。

## 商品视频策划

插件内置两层视频策划技能：`ecommerce-video-marketing` 负责商品痛点、卖点、受众、平台调性和营销脚本；`storyboard-prompt-assistant` 负责逐镜头时长、景别、运镜、正/负提示词和连续性。它们只生成可审阅的脚本与分镜，真实成片仍必须经过商品事实、素材扫描、商家确认、平台模型中转、创意点、归档和发布前审核；脚本或分镜不等于已生成或已发布视频。

## 安装前验收

在仓库根目录执行：

```bash
# Plugin manifest, bridge surface, skill and mirror validation. Runs entirely
# from this checkout; no machine-local Codex tooling is required.
env PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin npm test -- --run apps/plugin/install-smoke.test.ts packages/contracts/src/mcp.test.ts

# Confirm a marketplace registration points at this checkout.
node apps/plugin/scripts/verify-marketplace-source.mjs --marketplace <marketplace-name> --expected "$(pwd)/.codex-marketplace"
```

验收通过后，从当前源码执行本地安装：

```bash
node apps/plugin/scripts/install-local-plugin.mjs
```

Codex CLI 将本地源码适配器放在 `plugin marketplace` 命令组下，这是本机发现和缓存安装协议，
不等于发布到公共或团队插件市场。脚本不会上传插件。

安装完成后，在安装后的插件目录使用 CLI 登录。商家后台的一键连接按钮与 Helper 尚未通过生产
签名、公证、安装实例绑定和 scheme 劫持验收，不作为正式安装路径：

```bash
cd /absolute/path/to/installed/merchant-marketing/<version>
node scripts/build-keychain-helper.mjs
node scripts/login-local-macos.mjs \
  --base-url https://yxsona.com \
  --workspace ws_<平台分配的工作区>
```

浏览器打开后，先登录对应商家账号并确认当前工作区授权。CLI 成功同样只证明凭据已写入
Keychain 且非敏感连接配置已设置，不代表 ChatGPT 已加载插件。完全退出并重新打开
ChatGPT/Codex，新建对话后调用只读 `onboarding.status` 验证真实宿主、身份与工作区。

商家身份与角色由服务端 Bearer/OIDC 授权映射决定。安装包不会静态声明 `MERCHANT_ACTOR_ID` 或 `MERCHANT_MCP_ROLE`，也不会用客户端角色覆盖服务端成员权限；本地非严格鉴权测试需要模拟身份时，应在独立测试进程中显式注入，不能写进正式插件清单。

`MERCHANT_MCP_BASE_URL` 必须是商家服务的根 origin（例如 `https://merchant.example.com`），不能包含 `/mcp`；bridge 会自行请求 `${MERCHANT_MCP_BASE_URL}/mcp`。生产环境必须使用 HTTPS（本地开发可用 HTTP），并与已通过发布门禁的商家 Ingress 域名一致，不能指向独立示例网关或 Ops 域名。商家工作区由平台运营预先创建并分配；插件首次连接只读取并绑定该工作区，不允许商家自行注册或创建工作区。bridge 会将脱敏的 workspace binding 保存到用户级 `CODEX_HOME/merchant-marketing/workspace-binding.json`，新会话自动恢复，也可按需用环境变量覆盖。后续 `MERCHANT_WORKSPACE_ID` 是租户边界，不是平台授权凭证。生产网关必须校验 Codex/用户身份后再允许该工作区访问，不能仅相信客户端传入的工作区字符串。

bridge 对缺失或未解析的 `${MERCHANT_MCP_BASE_URL}`、`${MERCHANT_WORKSPACE_ID}` 默认失败关闭，避免 Codex App 或 Automation 静默分析错误工作区。只有本地 fixture 开发可以显式设置 `MERCHANT_ALLOW_FIXTURE_FALLBACK=true`，此时才回退到 `http://127.0.0.1:8790` 和 `ws_demo`；Automation 与生产环境禁止开启该选项。

插件中的 `READ_ONLY_METHODS` 只用于 MCP 工具注解和传输重试，`SAFE_WITHOUT_INTERACTIVE_WRITE` 只用于当前会话的人工写确认；两者都不是商业恢复白名单，不能绕过服务端 `CommercialAccessDecision`。零创意点、余额未知、点数不足、准入修订过期或费率不可用时，只显示共享 exact registry 中已启用且由服务端在 `next_actions` 授权的恢复入口。`platform.connect`、`catalog.sync`、`content.export` 是业务操作，不属于零点恢复。客户端门禁只改善交互，真实安全边界始终在 API/MCP、RLS 和 Worker 的服务端复核。

共享 `COMMERCIAL_OPERATION_REGISTRY` 中所有 `surface=MCP + domain=COMMERCIAL + enabled=false` 的精确方法都不出现在 `tools/list`，直接调用也会在 API 前 fail-closed。这包括 `subscription.order.create`、`subscription.change`；充值创建仅在商家后台登录且 provider ready 时由服务端动态暴露，fixture/未配置环境仍隐藏。Bridge 不生成任意金额建议。

## 安装后第一步

### 从资料与制作目标开始

已有合法商家登录、当前工作区权限且服务端商业准入允许时，可提供公开商品链接、自己的图片、表格或手工资料，先制作内容候选；不需要先连接店铺，不以 OAuth 或四步店铺接入作为默认步骤。

公开链接只是待核验来源，不代表店铺授权、已确认商品事实或页面一定可读取。只能使用当前实际可用且被允许的能力核验公开内容；无法读取时改由商家提供自己的资料，不绕过登录或平台访问限制，不索取 Cookie、平台密码和验证码。

资料导入调用 `catalog.import` 并显式传 `draft_only="true"`，不猜造店铺账号；文本候选使用 `content.draft.generate`，结果标为“草稿候选（未批准、未发布）”。图片/视频候选仍走既有 MCP 和平台模型中转、扫描、事实、权益及计费门禁。工具缺失或接口不支持时明确阻断，不用宿主模型、静态示例或正式绑定路径替代。

审核与导出使用现有 `content.review`、`content.export` 接受的真实内容/版本标识。当前文本候选返回 `formalVersionCreated=false`，不产生可直接交给这两个工具的正式版本；只能先供人工审阅，不能宣称候选审核与文件导出已闭环。已有真实内容版本继续按原门禁审核、导出，输出保留事实来源、审核与批准状态；“已导出”不等于“已批准”或“已发布”。

当前插件隐藏店铺接入、商品/库存/订单同步、发布/批量发布及经营巡检自动化入口。不删除已有后端接口、业务数据或正式授权/审计门禁，也不通过兼容调用、直接 HTTP 或旧模板绕回隐藏能力。商业套餐订单、账单和支付恢复不是店铺订单同步，继续按服务端 exact recovery 契约执行。

### ChatGPT 宿主模型与Store Nova业务模型

聊天编排使用 ChatGPT/Codex 的宿主模型；商品文案、OCR、主图、图片编辑和视频使用服务端配置的Store Nova业务中转。插件不能替宿主模型申请容量，也不会把业务模型伪装成 ChatGPT 的模型选项。宿主出现 `Selected model is at capacity` 时，消息尚未进入插件 MCP，需等待容量恢复或在 ChatGPT 模型选择器切换可用模型。

如果团队要让宿主对话也经过Store Nova中转站，安装后由管理员在启动 ChatGPT 的用户环境执行一次：

```bash
CODEX_RELAY_BASE_URL="https://ai.wormholexyz.xyz/v1" \
CODEX_RELAY_MODEL="glm-5.2" \
CODEX_RELAY_API_KEY_ENV="WORMHOLE_API_KEY" \
npm run codex:relay:configure
npm run codex:relay:validate
```

命令只写入用户级 `~/.codex/config.toml` 的 provider、模型、地址和一个仅包含已验证模型的本地目录快照，不写入密钥；密钥由平台密钥管理器注入。验证通过后必须完全重启 ChatGPT 并开启新会话。普通商家不需要填写中转站地址、Key 或模型名；缺少平台中转配置时，业务生成会按服务端门禁安全停止。

### 图片附件需要宿主模型支持

图片、PDF 或其他附件首先由 ChatGPT 宿主模型接收；消息成功发送后，服务端才会使用业务模型中转执行 OCR、文案或图片生成。若当前宿主模型不支持视觉附件（例如 Codex Spark 当前会提示“请移除图像或切换模型”），消息会在发送前被 ChatGPT 拦截，这不是 Merchant MCP 或业务中转故障。请切换到支持图片输入的宿主模型后重试；纯文字任务可以直接移除附件继续。业务模型不会替代宿主模型的输入能力，也不会出现在 ChatGPT 的模型选择器中。

插件下载并启用后，先调用只读 `onboarding.status` 核验真实身份与当前工作区；欢迎说明只介绍资料、内容、审核和导出，并询问一个制作目标或缺失资料。旧店铺接入进度仅保留为兼容状态，不展示默认 `0/4` 引导，也不阻断未绑定候选。已有明确目标时可调用 `merchant.start`，但只使用当前内容范围内、经服务端准入允许的下一步；旧连接/同步/发布建议不执行。`merchant.start` 可能记录意图，不是只读恢复入口。缺工作区时仅在服务端契约允许后调用 `workspace.bootstrap`，失败不得回退演示工作区。

当前登录、工作区/RLS、角色、交付、创意点、模型中转、成本证据与安全扫描门禁均保留。`billing.status` 展示服务端余额与恢复状态；旧人民币收款和 provider 成本账本不能解锁业务功能。内容制作不修改店铺授权或自动解除账号停用。

## 在插件中查看订单与账单

在 ChatGPT 会话中输入“查看我的订单和账单”，插件调用 `billing.status`、`subscription.orders.list` 或其他 exact recovery 查询，展示创意点的 `balance_state`、`available_points`、`quoted_points`、`access_revision`、`rate_card_version`、`request_id`、`trace_id` 和服务端授权的 `next_actions`。`balance_state=unknown` 时 `available_points` 必须保持 `null`，禁止显示为 0。旧钱包、任务额度和 add-on 只可作为历史证据，不贡献创意点也不解除门禁。

### 套餐、订阅、点数包与支付渠道

用户侧钱包读取只走服务端事实：`billing.status`（汇总）、`creative-points.balance.get`（余额）和 `creative-points.statement.list`（流水）。插件不得根据本地缓存、模型订阅或旧人民币钱包推导可用能力。

正式购买必须先调用 `commercial.catalog.get`，只展示服务端返回的公开、已批准、已生效且 `executable=true` 的 SKU。目录中的 `onboarding` 是一次性 ¥5000 开通，`monthly` 是月度订阅，`point_pack` 是创意点包；价格、周期、权益和版本都以服务端目录为准。随后调用 `commercial.order.create` 创建订单，再调用服务端提供的 checkout 入口。用户完成支付后，插件只能通过 `commercial.order.payment.get` 查询状态，并等待支付服务商签名回调、grant 到账和新的 `access_revision`，不能把“待支付”或“支付成功”直接说成“已到账”。

微信和支付宝由 API 服务端的支付 provider 负责下单和验签，插件不接触商户密钥，也不接受客户端自定义金额、点数、价格或权益。当前本地 fixture 环境只允许演示订单状态；未配置真实 provider、HTTPS callback、签名密钥和对账证据时，充值必须显示为不可用并保持 `writes=false`。`billing.recharge.create` 作为受登录与 provider 门禁保护的正式充值入口。

对话示例：用户说“看看我的钱包”时调用 `billing.status`；用户说“有哪些套餐和点数包”时调用 `commercial.catalog.get` 并列出可执行的公开 SKU；用户选择套餐后调用 `commercial.order.create` 创建待支付订单并展示订单号，再通过 `commercial.order.payment.get` 查询支付状态。若服务端未提供正式 checkout 入口，插件必须明确提示“支付配置尚未就绪”，不能改用旧接口、猜测支付链接或要求用户把微信/支付宝密钥发给模型。

可在新会话中输入“查看我的商品资料”，插件通过 `catalog.search(scope=workspace)` 查询当前授权工作区已有记录，无需先连接店铺。用户明确查询已有某店铺历史记录时必须校验具体范围，多候选不默认第一家。MCP 工具不可见、工作区不明或权限失败时，说明配置阻断，不继续创建任务。

已有任务需要补充信息时用 `task.answer` 保存答案和输入快照；未绑定候选没有正式任务时不伪造任务编号。正式内容的事实、制作方案、审核与批准仍按既有门禁执行。

商家侧 `tools/list` 数量以当前运行态契约测试为准，不在文档中固化易过期的数字。它不得包含任何 `ops.*`、`asset.scan`、`content.codex.*` 开发入口，也不得包含共享商业 registry 中 disabled 的操作。生成候选不会覆盖商品当前图片，也不能被称为平台已发布图。OAuth 授权回调仍由服务端 REST/官方页面承载；平台统一承担模型中转费用，商家不需要提供自己的 Key。

安装缓存更新后必须重新验证 `tools/list` 与共享 exact registry：恢复集合不得从前缀、HTTP 方法或“只读”推导，未分类或 disabled 操作必须 fail-closed。

可用下面的只读验收器核对源码与已安装缓存的关键运行文件哈希，并检查恢复入口、Ops 隔离和旧任意金额充值入口。它只证明安装 bridge；已经打开的 ChatGPT 对话可能保留启动时的工具快照，仍需开启新对话完成宿主验收。

```bash
node apps/plugin/scripts/verify-installed-bridge.mjs \
  --source apps/plugin \
  --installed /absolute/path/to/installed/merchant-marketing/<version>
```

升级时不要手工覆盖 `~/.codex/plugins/cache`。使用下面的入口让 Codex CLI 从本地源码适配器安装当前版本，并立即比较完整 Skill 运行树、bridge 文件与实际 `tools/list`；任一步不一致都会以非零状态失败：

```bash
node apps/plugin/scripts/upgrade-installed-plugin.mjs \
  --source apps/plugin \
  --marketplace merchant-local
```

同一版本的内容必须保持不可变；源码内容变化时先更新插件版本并同步本地源码适配器。升级验真通过后仍须完全退出 ChatGPT/Codex，并在新会话重新发现工具。

主图候选先由 `catalog.image.get` 展示，并按现有 `catalog.image.review` 与人工审阅要求检查。独立未绑定候选保持未批准、未发布。已有正式内容版本需要选图时，商家明确选择 1–6 张及顺序后才调用 `content.visual.select`，派生新的 `review_required` 版本；选图、审核与批准分别确认，不复用旧版本证据，也不附带平台发布操作。

平台发布及批量发布不属于当前商家入口。内容审核通过或文件导出成功都不代表已写入平台；现有后端发布审批、幂等、账号范围和媒体适配器门禁继续保留，不在插件中提供绕过路径。

`content.export` 在 bridge 内把 bundle、Markdown、JSON 或 manifest 写入权限为 `0600` 的会话隔离临时文件，并返回 MCP `resource_link`；正文和 ZIP Base64 不进入模型文本或 `structuredContent`。生产环境必须显式配置绝对 `MERCHANT_ARTIFACT_DIR`，单文件限制 25MB、单会话最多 100 个文件/250MB。文件卡片出现只证明导出已生成，不证明用户已下载、内容已批准或平台已发布。

`workspace.health` 可返回不含凭据的历史店铺目录与连接摘要；它们不能作为当前默认店铺选择、同步或发布菜单。用户明确查询历史数据时仍按工作区与具体店铺范围隔离，不把历史快照说成实时平台数据。

店铺目录中的授权和同步摘要仅代表最后观测记录，未知字段保持 `unknown`；访问令牌到期不等于整项授权到期，历史数据不证明当前可读或可发布。公开链接不能补齐这些授权证据。

## 当前不提供的店铺运营入口

同步、发布、批量发布和经营巡检 Automations 不属于本阶段商家工作流。旧 `scheduled/*.json` 与参考资料即使仍保留在仓库，也不作为当前入口或执行协议；不创建模板任务，不指导调用隐藏方法，不以直接 API 或替代调度器恢复它们。服务端内部调度配置不由商家插件开启。

本轮只收窄插件入口与引导，不删除后端接口、业务数据或审计记录，不改变服务端模型中转、费用、权限或发布门禁。只读注解不是权限或商业准入豁免；明确的用户确认也不能重新开放当前隐藏能力。

修改插件后在 Codex 中开启新会话，重新核验实际工具清单与 Skill。安装验证只能证明对应 bridge 文件和契约，不能替代真实宿主、内容生成、审核或导出验收。 `asset.scan` 不在生产商家插件展示；商业恢复类型仍以共享 exact registry 为唯一真值。
