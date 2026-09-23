# Store Nova ChatGPT 插件安装与配置手册

这份手册给技术安装人员、平台管理员和商家使用。目标是把一台新的桌面 ChatGPT 电脑配置到：

1. ChatGPT 能加载Store Nova插件；
2. 插件能连接商家 API/MCP；
3. 服务端能识别正确的工作区和用户身份；
4. 商家能在新会话中查看工作区状态或上传资料；
5. 模型、支付和平台授权缺少时，页面明确阻断，不把演示数据说成真实能力。

商家不需要提供平台账号密码、模型 API Key 或支付宝/微信商户密钥。当前六平台运营采用人工流程；模型中转和支付密钥由管理员在服务端配置。

## 重要：本地部署与 ChatGPT OAuth 是两条不同链路

如果交付目标是“用户本地安装”，默认采用本地桌面模式：ChatGPT/Codex 启动本机
stdio bridge，由 bridge 连接 Store Nova API/MCP。这条链路不使用 ChatGPT 远程 MCP OAuth，
不要求 OpenAI Apps challenge，也不发布到公开或团队插件市场。

本地模式仍然需要 Store Nova 自己的身份边界：商家在运营后台用账号密码登录，插件
使用平台为该工作区签发的短期 Bearer 凭据调用 `/mcp`。账号密码不会写入插件、环境变量、
聊天或日志；不能用 Cookie、平台密码或共享演示 token 代替用户凭据。

默认业务地址是 `https://yxsona.com`，必须使用服务端签发、绑定工作区且可撤销的 Bearer
凭据。浏览器中出现的 Store Nova 授权确认页是本地 CLI 的 PKCE 登录，不是 ChatGPT OAuth；
不能取消 Store Nova 自己的登录、工作区/RLS 或审计授权。

### 本地桌面模式（推荐给本地安装用户）

先完成 A2 的本地安装，再按 A3 使用本地 CLI 完成浏览器授权和 Keychain 写入。商家后台的
“连接 ChatGPT 本地插件”按钮及 Helper 已有原型，但在 Helper 完成签名、公证、安装实例绑定和
抗协议劫持验收前，生产环境必须保持关闭。短期 access/refresh token 只写入当前 macOS 用户的
Keychain，不进入 URL、命令行、launchd、仓库或聊天。

本地模式的请求路径是：

    桌面 ChatGPT/Codex → 本地 stdio bridge → 本地 API 或 https://yxsona.com/mcp → Store Nova 模型中转

因此“不要 ChatGPT auth”并不等于“取消 Store Nova 登录”。取消后端身份校验会失去工作区
隔离、审计和撤权能力，不允许作为交付方案。

### 本地连接凭据如何产生

CLI 生成随机 state 和 PKCE S256 verifier/challenge，打开
`GET /v1/auth/local-plugin/authorize`。商家在浏览器登录并确认后，服务端经
`POST /v1/auth/local-plugin/authorize` 把一次性 code 返回 CLI 的 `127.0.0.1` 随机端口；CLI 再
调用 `POST /v1/auth/local-plugin/token` 完成交换。服务端校验浏览器同源、商家会话、唯一工作区、
精确回调和 PKCE，CLI 校验 state、响应工作区和 token 契约后才写 Keychain。

access token 过期时 bridge 沿用 `POST /v1/auth/mcp-token/refresh` 轮换并原子更新 Keychain，
不能回退到共享 token。撤销账号或身份会使现有 token 失效。

## 先判断你是哪一种使用者

| 角色 | 负责什么 | 不应该做什么 |
| --- | --- | --- |
| 平台管理员 | 准备商家 API 根地址、工作区、OIDC/Bearer 映射、服务端模型和支付配置 | 不把密钥写进插件包、仓库或聊天 |
| 技术安装人员 | 在商家电脑安装/更新插件，注入连接环境，重启 ChatGPT，完成只读验收 | 不替商家保存平台账号密码，不默认开启写权限 |
| 商家 | 在 ChatGPT 中用自然语言选择店铺、上传资料、确认内容和发布 | 不填写 `product_id`、`account_id`、模型 Key 或平台密码 |

## A. 技术安装人员：从零安装

### A1. 准备条件

- 安装人员有该电脑的当前用户权限；单入口会检查原版 ChatGPT 桌面端，缺失时引导从官方渠道安装。
- 已从平台管理员拿到以下非敏感配置：
  - 商家 API 根地址，例如 `https://merchant.example.com`；地址不能带 `/mcp`、查询参数或凭据。
  - 管理员分配的工作区标识，例如 `ws_xxx`。
- 已拿到对应平台的 Store Nova 插件包。本项目直接本地部署，不发布到公开插件市场。

### A2. 安装包含运行环境的平台包

平台交付两个独立包：macOS `darwin-arm64` 或 `darwin-x64`，Windows `win32-x64`。包内包括对应平台的 Node 运行时；macOS 还包括已编译的 Keychain helper，Windows 包必须包括已签名、单文件且自带 .NET 运行时的 Credential Manager helper。用户电脑不需要预装 Node、Swift、.NET SDK 或 Codex CLI。包内不含 OpenAI 客户端二进制；安装时需从 OpenAI 或 Microsoft 官方渠道获取原版客户端。Store Nova 商家账号、管理员分配的工作区和网络连接仍需具备。

macOS 用户打开已签名、公证并装订票据的正式 DMG 后运行 `install-all.command`。入口先核验本机原版 ChatGPT.app 的签名与公证；缺失时打开 OpenAI 官方下载页，待用户完成原版安装后继续。随后按提示输入分配的工作区；也可运行 `sh install.sh`，然后运行 `sh login.sh --workspace ws_<管理员分配的工作区>`。工作区留空时安装器会明确报告“已安装、待绑定”，不会报告可用。直接打包产生的 `.tar.gz` 只用于内部验收，不交付用户。Windows 用户必须取得同一发布的 ZIP 和包外 Authenticode 签名 `.install.ps1`，先验证生产发布者签名，再运行包外安装器；它先核对整个 ZIP 的 SHA-256，随后检查官方 Microsoft Store 客户端身份，缺失时从官方渠道安装原版 ChatGPT，再安装插件并输入工作区；也可稍后运行 `login.cmd --workspace ws_<管理员分配的工作区>`。不得直接运行 ZIP 内脚本，包内 `install.cmd`、`install-chatgpt.ps1` 和 `install-plugin.ps1` 会拒绝安装。登录时在浏览器核对商家账号与工作区并确认授权。最后完全退出并重新打开 ChatGPT，在新对话调用 `onboarding.status` 核验真实宿主身份和工作区。安装器写入本机个人插件源、安装缓存和启用配置，不发布到公开或团队市场。

macOS 正式 DMG 在持有 Developer ID Application 证书和 Apple 公证 Keychain profile 的发布机上运行 `apps/plugin/scripts/build-signed-macos-package.mjs` 生成。缺少签名身份、公证接受结果、装订票据或 Gatekeeper 验证时不产生可交付包。发布机凭据不进入用户包。

Windows 管理员应从独立可信渠道公布生产发布者证书指纹。用户在 PowerShell 中先运行 `Get-AuthenticodeSignature -LiteralPath <名称>.install.ps1`，确认 `Status` 为 `Valid`、`SignerCertificate.Thumbprint` 与公布值一致，再运行 `powershell.exe -NoProfile -File <名称>.install.ps1`；没有公布指纹、生产签名无效或只拿到 ZIP 时停止安装。CI 的临时测试证书不是生产发布者证书。

Windows 包必须在 Windows x64 发布机上构建。发布机安装构建工具并持有可信 Authenticode 生产代码签名证书后，运行 `apps/plugin/scripts/build-signed-windows-package.ps1`，提供输出 ZIP、证书指纹和可信时间戳服务地址。正式发布拒绝自签名及 CI 测试证书；已有输出不覆盖。脚本核对包内官方 Node 的签名与时间戳，签名自包含凭据 helper 和包外安装器，生成 ZIP、包外签名安装器与辅助 `.sha256` 文件；任何门禁失败都不会留下候选交付物。独立 `.sha256` 文件不是信任根。构建工具只属于发布机环境，用户电脑无需安装。当前 macOS 构建机不能代替 Windows 实机安装验收。

#### 开发人员从源码安装

在目标仓库根目录执行：

    node apps/plugin/scripts/install-local-plugin.mjs

该脚本只使用当前仓库里的本地源适配器完成 ChatGPT/Codex 所需的插件发现和缓存安装，随后比较源码与安装缓存的 manifest、Skill、Bridge 哈希和实际 `tools/list`。它不会上传插件、不会发布到公开或团队插件市场，也不要求真实 ChatGPT OAuth。

Codex CLI 目前把本地插件源也归在 `plugin marketplace` 命令组下；这是本机安装协议的命令名称，不代表项目需要上架插件市场。脚本发现同名本地源指向另一个工作树时会失败关闭，不会覆盖另一个候选目录。

检查安装状态：

    codex plugin list

应看到 `merchant-marketing@merchant-local` 为 `installed, enabled`。插件更新后重新执行本地安装脚本，再重启 ChatGPT；已经打开的对话不会自动刷新旧的 MCP 工具快照。

### A3. 在商家后台一键连接（安全预览，生产默认关闭）

1. 使用将要运行 ChatGPT 的同一个 macOS 用户登录商家后台。
2. 打开“连接本地插件”，确认页面显示的账号与目标工作区正确。
3. 点击“连接 ChatGPT 本地插件”，并在 macOS/浏览器提示中允许打开 Store Nova Helper。
4. 在 Store Nova 授权页确认工作区。页面显示“已连接”只证明 Helper 已完成授权、钥匙串写入和本地
   bridge 检查；它不代表 ChatGPT 已重新加载插件。
5. 按 A4 **完全退出并重新打开 ChatGPT**，新建会话后按 A5 调用 `onboarding.status` 验证。

如果页面显示“需安装”，先重新执行 A2；如果显示“已过期”“被拒绝”或“验证失败”，按页面提示
重试。一次性连接链接不得复制到聊天、配置文件或另一台电脑，也不要把页面状态当作最终宿主验收。

#### CLI 正式路径

进入 A2 实际安装得到的插件目录：

    cd /absolute/path/to/installed/merchant-marketing/<version>
    node scripts/build-keychain-helper.mjs
    node scripts/login-local-macos.mjs \
      --base-url https://yxsona.com \
      --workspace ws_<管理员分配的工作区>

第一条命令只在本机构建 Keychain helper，不读取凭据；构建失败时不会降级到文件或环境变量
存储。第二条命令使用浏览器授权和钥匙串边界。成功输出不包含 token，
并明确 `credential_source=keychain`、`host_verified=false`：这表示本地凭据配置完成，不表示
ChatGPT 宿主已经加载或验收通过。

`install-local-macos.sh` 是旧 launchd token 部署的兼容入口，只供既有安装迁移和维护；新用户
不得使用它，也不要手工把 `MERCHANT_MCP_TOKEN` 或 refresh token 写入 launchd。

### A4. 完全重启 ChatGPT

    osascript -e 'tell application "ChatGPT" to quit'
    open -a ChatGPT

重启后必须开启一个新会话。关闭当前窗口但不退出应用，不能保证插件进程重新读取环境。

### A5. 做只读验收

在新会话中直接调用只读入口，或输入：

> 请调用 Store Nova 的 onboarding.status，检查当前身份和工作区。

首次调用会读取工作区和准入状态。正常结果应继续询问上传资料、选择商品或查看工作区；不应出现 `MCP_CONFIGURATION_REQUIRED`、`MERCHANT_MCP_BASE_URL is required` 或“插件连接配置未加载”。

注意 `merchant.start` 本身受商业准入门禁：工作区余额为 0、余额未知或缺套餐权益时分别返回 `CREATIVE_POINTS_EXHAUSTED`（402）、`CREATIVE_POINTS_UNAVAILABLE`（503）、`COMMERCIAL_ENTITLEMENT_REQUIRED`（402）。这是准入阻断而不是安装错误；此时 `onboarding.status` 和 `workspace.health` 仍可正常读取状态，便于区分“装错了”和“还没开通”。

技术人员还可以在插件源仓库执行安装缓存校验：

下面两条是仓库维护者验收，不是普通商家安装步骤。`validate_plugin.py` 需要 Python 的 PyYAML；缺少时先安装依赖：

    python3 -c 'import yaml' 2>/dev/null || python3 -m pip install --user pyyaml

    REPO_ROOT=/path/to/codexSkills
    python3 /path/to/codex/plugin-creator/scripts/validate_plugin.py "$REPO_ROOT/apps/plugin"
    node "$REPO_ROOT/apps/plugin/scripts/verify-installed-bridge.mjs" \
      --source "$REPO_ROOT/apps/plugin" \
      --installed /absolute/path/to/installed/merchant-marketing/<version>

校验器只证明 bridge 和 manifest 一致，不代表 ChatGPT 宿主、支付、模型中转或发布已经验收。

## B. 平台管理员：配置模型中转

普通商家不执行本节。商品文案、图片、图片编辑、OCR 和视频请求由服务端使用 `MODEL_RELAY_*`；商家不需要填写这些值。

如果团队还要求 ChatGPT/Codex 的宿主对话也经Store Nova中转，由管理员在安装人员的用户环境执行：

    CODEX_RELAY_BASE_URL="https://<Responses兼容中转站>/v1" \
    CODEX_RELAY_MODEL="<必须出现在 /v1/models data[] 的模型 ID>" \
    CODEX_RELAY_API_KEY_ENV="WORMHOLE_API_KEY" \
    npm run codex:relay:configure

    npm run codex:relay:validate

`CODEX_RELAY_MODEL` 不能直接填 ChatGPT 当前显示的默认模型名。它必须是中转站 `/v1/models` 返回的真实 ID，并且声明 `openai` 或 `openai-response` 能力；否则校验会 fail-closed。当前这台安装机已验证使用 `deepseek-v4-pro`，而 `gpt-5.6-sol` 未被该中转站声明，不能作为宿主 relay model。

命令只写入用户级 `~/.codex/config.toml` 的 provider、模型、地址和本地模型目录，不写入 Key。Key 必须由系统密钥管理器注入 `WORMHOLE_API_KEY`，然后完全重启 ChatGPT 并开启新会话。

服务端业务模型的配置与宿主模型配置不是同一组变量：

| 变量 | 链路 | 谁配置 |
| --- | --- | --- |
| `MERCHANT_MCP_BASE_URL` | ChatGPT 插件 → 商家 API/MCP | 技术安装人员/平台管理员 |
| `MERCHANT_WORKSPACE_ID` | 请求的租户边界 | 平台管理员分配 |
| Keychain credential package | 插件到网关的 access/refresh token、API origin 与 workspace 原子包 | 本地登录 CLI 写入；商家不手工复制 |
| `MERCHANT_STRICT_AUTH` | 非本机 API 的强制鉴权门禁；生产必须为 `true` | 技术安装人员/平台管理员 |
| `DEPLOY_ENV` | 本地插件 bridge 的部署环境判定；安装到用户电脑时必须为 `local_desktop` | 技术安装人员/平台管理员 |
| `MODEL_RELAY_BASE_URL`、`MODEL_RELAY_API_KEY`、`AI_MODEL` 等 | 商家 API → 业务模型 | 服务端密钥管理器 |
| `CODEX_RELAY_BASE_URL`、`CODEX_RELAY_MODEL`、`WORMHOLE_API_KEY` | ChatGPT/Codex 宿主 → 宿主模型中转 | 平台管理员 |

不要把 Keychain 中的本地插件凭据当成模型 Key，也不要把宿主模型配置复制给普通商家。

## C. 商家第一次使用

技术人员完成 A 节后，商家只需：

1. 打开新的 ChatGPT 会话；
2. 选择第一个快捷提示“@Store Nova 开始使用”，先查看服务端核验的进度；
3. 由平台运营先为该商家建立人工店铺记录并导入商品资料，商家在插件中选择被分配的店铺与商品。**当前上线档为 `manual`，不接入六平台 OAuth，插件内没有“经平台官方页面授权”这一步**（`platform.connect`、`platform.store.list` 已从商家工具面隐藏，调用得到 `Unknown tool`）；
4. 需要生成、审核、批准时按对话中的一次性确认继续；需要内容上线时，由运营在官方商家后台人工发布并回填结果，插件不提供 `publish.*` 工具。

商家在花钱之前就应知道三类硬前置条件，缺任何一项都会被服务端拒绝：

| 前置条件 | 未满足时返回 |
| --- | --- |
| 创意点余额**已知**且大于 0 | `CREATIVE_POINTS_UNAVAILABLE`（503，工作区没有点数状态记录、余额未知；全新工作区即此状态）/ `CREATIVE_POINTS_EXHAUSTED`（402，余额为 0）/ `CREATIVE_POINTS_INSUFFICIENT`（402，余额不足） |
| 有效月付套餐权益 | `COMMERCIAL_ENTITLEMENT_REQUIRED`（402） |
| 生产素材扫描器已配置 | `IMAGE_SOURCE_ASSET_INVALID`（409，素材未通过扫描）；`GENERATED_IMAGE_SCAN_REQUIRED`（409，生成结果仍在隔离区） |

**只买创意点包不能创作**：点包只增加余额，公开目录中只有月付套餐 `basic`（¥2000）/ `growth`（¥5000）才产生套餐权益快照（`packages/persistence/src/commercial-contract-repository.ts` 的 `validatePeriod` 与核销路径）。店铺绑定也仍然必要：未绑定店铺时商品同步、正式任务与发布返回 `STORE_ONBOARDING_REQUIRED`（428）。扫描器由平台配置（`ASSET_SCANNER_MODE=clamav_worker` + 签名回执），商家无需也不能提交扫描证据。

商家不会把平台登录密码交给插件，插件也不会保存平台 access token。店铺选择始终以“平台 + 店铺账号”为范围，同名店铺不会自动选第一家。

## D. 当前问题的准确解释

本次现场验收遇到的是：

    MCP_CONFIGURATION_REQUIRED
    缺少 MERCHANT_MCP_BASE_URL

这表示 ChatGPT 宿主没有把插件连接地址注入 bridge，请求还没有到业务 API；它不是模型容量问题，也不是支付宝配置问题。

另一个常见问题是插件缓存落后于本地源码。修复方式是重新执行本地安装并验真：

    node apps/plugin/scripts/install-local-plugin.mjs

然后退出并重启 ChatGPT，再开启新会话。不要手工修改 `~/.codex/plugins/cache`，否则下次更新会被覆盖。

## E. 排障表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `MCP_CONFIGURATION_REQUIRED`，缺少 `MERCHANT_MCP_BASE_URL` | 本地连接未完成，或 ChatGPT 尚未重启读取非敏感连接配置 | 重新执行 A3 CLI，完全退出并重启 ChatGPT 后开启新会话 |
| `MERCHANT_WORKSPACE_ID is required` | 未分配工作区，或连接到了错误用户 | 让管理员确认工作区，在启动 ChatGPT 的同一 macOS 用户会话重新连接 |
| `401/403`、角色无权限 | OIDC/Bearer 映射失败或 token 过期 | 管理员检查网关身份映射和 token，不要改客户端角色变量 |
| `MCP_STRICT_AUTH_REQUIRED` | 本地连接未完成或旧 launchd 配置仍在生效 | 重新执行 A3 CLI；不要手工注入 token，完全退出并重启 ChatGPT |
| 工具列表少、旧入口仍出现 | 本地插件缓存未更新，或对话保存了旧快照 | 重新执行本地安装脚本，重启 ChatGPT，开启新会话 |
| `Selected model is at capacity` | 宿主模型尚未把消息交给插件 | 在 ChatGPT 模型选择器切换可用宿主模型后重试 |
| `Codex host relay /models 未声明当前 host model` | `CODEX_RELAY_MODEL` 不是中转站实际提供的模型 ID，或缺少 Responses 能力声明 | 管理员先检查 `/v1/models`，用真实 ID 重新执行 `codex:relay:configure`，再通过 `codex:relay:validate` |
| `codex:relay:validate` 失败 | 宿主或业务 relay 缺少 HTTPS、Key、模型 ID 或 `/models` 目录声明 | 仅管理员补齐中转配置；商家不填写模型 Key |
| 能看到示例商品但不能读取真实商品 | 使用了 fixture，或运营尚未为该商家建立人工店铺记录 | 标记为演示/待配置；由平台运营建立人工店铺记录并导入资料后再验收 |
| `STORE_ONBOARDING_REQUIRED`（428） | 当前工作区未绑定任何平台店铺，而该动作属于商品同步、正式任务或发布 | 先用上传素材、生成候选、查看/购买创意点等店铺边界外能力；联系平台运营建立人工店铺记录。错误响应里的 `next_actions` 是可执行的下一步 |
| `CREATIVE_POINTS_EXHAUSTED`（402） | 创意点余额为 0，零余额先于操作分类，除恢复类方法外全部拒绝 | 在商家后台购买创意点包或月付套餐；不要绕过门禁 |
| `COMMERCIAL_ENTITLEMENT_REQUIRED`（402） | 余额可能够，但没有有效月付套餐权益快照 | 购买月付套餐（`basic` ¥2000 / `growth` ¥5000）。只买点包不会产生权益 |
| `COMMERCIAL_PAYMENT_PROVIDER_UNAVAILABLE`（503） | 服务端未配置 `COMMERCIAL_PAYMENT_PROVIDER`，订单未创建、未落库 | 平台管理员配置支付通道；这是平台侧缺失，商家重试无效 |
| `IMAGE_SOURCE_ASSET_INVALID`（409） | 素材未通过生产安全扫描、商用权益或 AI 修改许可 | 平台会自动扫描，等待即可；扫描通过后按提示确认权益。不要手工改扫描状态 |
| 生成/支付按钮不可用 | 创意点准入、套餐权益、模型成本证据或支付 provider 未通过 | 只查看服务端返回的阻断原因；不要改前端金额或绕过门禁 |

## F. 安全边界

- 不保存平台账号密码、OAuth code、access token 或支付商户密钥到插件包、仓库、日志或聊天。
- `MERCHANT_MCP_BASE_URL` 只写 API 根 origin，生产必须 HTTPS。
- 工作区由平台管理员分配；商家不能用任意字符串创建或切换租户。
- 读操作可以自动执行；生成、编辑、批准、发布、充值仍需要服务端准入和明确确认。
- 本地 `ws_demo`、fixture 商品、演示订单和示例模型不是生产证据。

## G. 安装完成清单

技术人员交付前逐项确认：

- [ ] `codex plugin list` 显示插件 `installed, enabled`。
- [ ] `install-local-plugin.mjs` 返回 `ok: true`、`mode: local_stdio`、`public_marketplace_required: false`；安装缓存与源码版本一致。
- [ ] 在实际安装包目录运行 `build-keychain-helper.mjs` 成功，且 `login-local-macos.mjs` 返回 `credential_source=keychain`；输出中没有 token。
- [ ] 如果测试安全预览按钮：生产门禁保持关闭，且测试环境仅显示“本地凭据已就绪”，不冒充 ChatGPT 宿主已验证。
- [ ] 生产没有开启 `MERCHANT_ALLOW_FIXTURE_FALLBACK=true` 或全局 `MERCHANT_MCP_WRITE_ENABLED=true`。
- [ ] ChatGPT 已完全重启，并在新会话中重新加载工具。
- [ ] 新会话调用 `onboarding.status` 能返回真实工作区/引导状态，而不是 MCP 配置缺失。
- [ ] 如启用宿主中转，`npm run codex:relay:validate` 通过，且密钥没有写入 `config.toml`。
- [ ] 服务端已配置 `COMMERCIAL_PAYMENT_PROVIDER`，且商业目录中已有可售的月付套餐（`basic` / `growth`）。**未配置时商家下单返回 503 且订单不落库，运营的人工核验也找不到订单，交付后客户将无法自助开通。**
- [ ] 生产素材扫描器已按 `ASSET_SCANNER_MODE=clamav_worker` 配置并能签发扫描回执；否则素材永远停在隔离区。
- [ ] 模型 usage/cost evidence、支付回调和发布 canary 仍按生产门禁单独验收；当前人工平台流程不要求六平台 OAuth。

相关文档：

- [插件源说明](../apps/plugin/README.md)
- [产品使用介绍](product-usage-guide.md)
- [Codex 宿主中转配置参考](../doc/todo/model/codex-app-relay-setup.md)
- [安装后系统引导 PRD](plugin-onboarding-setup-prd.md)
