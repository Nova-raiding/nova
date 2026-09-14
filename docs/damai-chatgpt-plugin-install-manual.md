# 大麦 ChatGPT 插件安装与配置手册

这份手册给技术安装人员、平台管理员和商家使用。目标是把一台新的桌面 ChatGPT 电脑配置到：

1. ChatGPT 能加载大麦插件；
2. 插件能连接商家 API/MCP；
3. 服务端能识别正确的工作区和用户身份；
4. 商家能在新会话中查看工作区状态或上传资料；
5. 模型、支付和平台授权缺少时，页面明确阻断，不把演示数据说成真实能力。

商家不需要提供平台账号密码、模型 API Key 或支付宝/微信商户密钥。平台 OAuth、模型中转和支付密钥由管理员在服务端配置。

## 先判断你是哪一种使用者

| 角色 | 负责什么 | 不应该做什么 |
| --- | --- | --- |
| 平台管理员 | 准备商家 API 根地址、工作区、OIDC/Bearer 映射、服务端模型和支付配置 | 不把密钥写进插件包、仓库或聊天 |
| 技术安装人员 | 在商家电脑安装/更新插件，注入连接环境，重启 ChatGPT，完成只读验收 | 不替商家保存平台账号密码，不默认开启写权限 |
| 商家 | 在 ChatGPT 中用自然语言选择店铺、上传资料、确认内容和发布 | 不填写 `product_id`、`account_id`、模型 Key 或平台密码 |

## A. 技术安装人员：从零安装

### A1. 准备条件

- macOS 桌面端 ChatGPT/Codex 已安装并能启动。
- 技术安装人员有该电脑的用户权限，可以执行 `codex`、`launchctl` 和 `open`。
- 已从平台管理员拿到以下非敏感配置：
  - 商家 API 根地址，例如 `https://merchant.example.com`；地址不能带 `/mcp`、查询参数或凭据。
  - 管理员分配的工作区标识，例如 `ws_xxx`。
  - 如果网关没有使用宿主 OIDC，才需要一个由网关签发的 Bearer token。
- 已拿到大麦插件 marketplace 的来源。来源可以是公司内部 Git marketplace，也可以是本机的 marketplace 目录。

### A2. 注册 marketplace 并安装插件

如果管理员给的是本机 marketplace 目录：

    codex plugin marketplace add /absolute/path/to/.codex-marketplace
    codex plugin add merchant-marketing@merchant-local

如果管理员给的是 Git marketplace：

    codex plugin marketplace add https://github.com/your-org/your-marketplace.git --ref main
    codex plugin add merchant-marketing@your-marketplace

检查安装状态：

    codex plugin list

应看到 `merchant-marketing@<marketplace>` 为 `installed, enabled`。插件更新后必须重新执行 `codex plugin add ...`，再重启 ChatGPT；已经打开的对话不会自动刷新旧的 MCP 工具快照。

### A3. 注入插件连接环境

在启动 ChatGPT 的同一个 macOS 用户会话中执行：

    launchctl setenv MERCHANT_MCP_BASE_URL "https://<商家API根地址>"
    launchctl setenv MERCHANT_WORKSPACE_ID "ws_<管理员分配的工作区>"

只有网关明确要求静态 Bearer token 时才设置：

    launchctl setenv MERCHANT_MCP_TOKEN "<网关签发的短期token>"

生产环境不要设置以下开发开关：

    launchctl setenv MERCHANT_ALLOW_FIXTURE_FALLBACK "false"
    launchctl setenv MERCHANT_MCP_WRITE_ENABLED "false"

检查变量是否存在，但不要打印 token：

    for name in MERCHANT_MCP_BASE_URL MERCHANT_WORKSPACE_ID MERCHANT_MCP_TOKEN; do
      value=$(launchctl getenv "$name" 2>/dev/null || true)
      if [ -n "$value" ]; then
        case "$name" in
          *TOKEN) echo "$name=PRESENT" ;;
          *) echo "$name=$value" ;;
        esac
      else
        echo "$name=MISSING"
      fi
    done

### A4. 完全重启 ChatGPT

    osascript -e 'tell application "ChatGPT" to quit'
    open -a ChatGPT

重启后必须开启一个新会话。关闭当前窗口但不退出应用，不能保证插件进程重新读取环境。

### A5. 做只读验收

在新会话中输入：

> 启动大麦插件并检查连接状态

首次调用会读取工作区和准入状态。正常结果应继续询问上传资料、选择平台或查看工作区；不应出现 `MCP_CONFIGURATION_REQUIRED`、`MERCHANT_MCP_BASE_URL is required` 或“插件连接配置未加载”。

技术人员还可以在插件源仓库执行安装缓存校验：

下面两条是仓库维护者验收，不是普通商家安装步骤。`validate_plugin.py` 需要 Python 的 PyYAML；缺少时先安装依赖：

    python3 -c 'import yaml' 2>/dev/null || python3 -m pip install --user pyyaml

    REPO_ROOT=/path/to/codexSkills
    python3 /path/to/codex/plugin-creator/scripts/validate_plugin.py "$REPO_ROOT/apps/plugin"
    node "$REPO_ROOT/apps/plugin/scripts/verify-installed-bridge.mjs" \
      --source "$REPO_ROOT/apps/plugin" \
      --installed /absolute/path/to/installed/merchant-marketing/<version>

校验器只证明 bridge 和 manifest 一致，不代表真实平台 OAuth、支付或发布已经开通。

## B. 平台管理员：配置模型中转

普通商家不执行本节。商品文案、图片、图片编辑、OCR 和视频请求由服务端使用 `MODEL_RELAY_*`；商家不需要填写这些值。

如果团队还要求 ChatGPT/Codex 的宿主对话也经大麦中转，由管理员在安装人员的用户环境执行：

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
| `MERCHANT_MCP_TOKEN` | 插件到网关的可选 Bearer 身份 | 网关管理员注入 |
| `MODEL_RELAY_BASE_URL`、`MODEL_RELAY_API_KEY`、`AI_MODEL` 等 | 商家 API → 业务模型 | 服务端密钥管理器 |
| `CODEX_RELAY_BASE_URL`、`CODEX_RELAY_MODEL`、`WORMHOLE_API_KEY` | ChatGPT/Codex 宿主 → 宿主模型中转 | 平台管理员 |

不要把 `MERCHANT_MCP_TOKEN` 当成模型 Key，也不要把宿主模型配置复制给普通商家。

## C. 商家第一次使用

技术人员完成 A 节后，商家只需：

1. 打开新的 ChatGPT 会话；
2. 说“启动大麦插件并检查连接状态”；
3. 按对话提示选择平台和店铺，或上传商品图片/资料；
4. 需要生成、审核、批准或发布时，按对话中的一次性确认继续。

插件会通过服务端 OAuth 绑定店铺。商家不会把平台登录密码交给插件，插件也不会保存平台 access token。店铺选择始终以“平台 + 店铺账号”为范围，同名店铺不会自动选第一家。

## D. 当前问题的准确解释

本次现场验收遇到的是：

    MCP_CONFIGURATION_REQUIRED
    缺少 MERCHANT_MCP_BASE_URL

这表示 ChatGPT 宿主没有把插件连接地址注入 bridge，请求还没有到业务 API；它不是模型容量问题，也不是支付宝配置问题。

另一个常见问题是插件缓存落后于 marketplace 源码。修复方式是重新安装当前 marketplace 版本：

    codex plugin add merchant-marketing@<marketplace>

然后退出并重启 ChatGPT，再开启新会话。不要手工修改 `~/.codex/plugins/cache`，否则下次更新会被覆盖。

## E. 排障表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `MCP_CONFIGURATION_REQUIRED`，缺少 `MERCHANT_MCP_BASE_URL` | ChatGPT 进程没有收到插件 API 根地址 | 执行 A3，确认 `launchctl getenv` 有值，完全退出并重启 ChatGPT |
| `MERCHANT_WORKSPACE_ID is required` | 未分配工作区或环境注入到错误用户 | 让管理员分配工作区，在启动 ChatGPT 的同一用户会话执行 A3 |
| `401/403`、角色无权限 | OIDC/Bearer 映射失败或 token 过期 | 管理员检查网关身份映射和 token，不要改客户端角色变量 |
| 工具列表少、旧入口仍出现 | 本地插件缓存未更新，或对话保存了旧快照 | 重新执行 `codex plugin add`，重启 ChatGPT，开启新会话 |
| `Selected model is at capacity` | 宿主模型尚未把消息交给插件 | 在 ChatGPT 模型选择器切换可用宿主模型后重试 |
| `Codex host relay /models 未声明当前 host model` | `CODEX_RELAY_MODEL` 不是中转站实际提供的模型 ID，或缺少 Responses 能力声明 | 管理员先检查 `/v1/models`，用真实 ID 重新执行 `codex:relay:configure`，再通过 `codex:relay:validate` |
| `codex:relay:validate` 失败 | 宿主或业务 relay 缺少 HTTPS、Key、模型 ID 或 `/models` 目录声明 | 仅管理员补齐中转配置；商家不填写模型 Key |
| 能看到示例商品但不能读取真实商品 | 使用了 fixture 或平台 OAuth/API 尚未配置 | 标记为演示/待配置，完成官方授权和真实 connector 后再验收 |
| 生成/支付按钮不可用 | 创意点准入、模型成本证据或支付 provider 未通过 | 只查看服务端返回的阻断原因；不要改前端金额或绕过门禁 |

## F. 安全边界

- 不保存平台账号密码、OAuth code、access token 或支付商户密钥到插件包、仓库、日志或聊天。
- `MERCHANT_MCP_BASE_URL` 只写 API 根 origin，生产必须 HTTPS。
- 工作区由平台管理员分配；商家不能用任意字符串创建或切换租户。
- 读操作可以自动执行；生成、编辑、批准、发布、充值仍需要服务端准入和明确确认。
- 本地 `ws_demo`、fixture 商品、演示订单和示例模型不是生产证据。

## G. 安装完成清单

技术人员交付前逐项确认：

- [ ] `codex plugin list` 显示插件 `installed, enabled`。
- [ ] `MERCHANT_MCP_BASE_URL`、`MERCHANT_WORKSPACE_ID` 在启动 ChatGPT 的用户 launchd 环境中存在。
- [ ] 生产没有开启 `MERCHANT_ALLOW_FIXTURE_FALLBACK=true` 或全局 `MERCHANT_MCP_WRITE_ENABLED=true`。
- [ ] ChatGPT 已完全重启，并在新会话中重新加载工具。
- [ ] 首个只读入口能返回工作区/引导状态，而不是 MCP 配置缺失。
- [ ] 如启用宿主中转，`npm run codex:relay:validate` 通过，且密钥没有写入 `config.toml`。
- [ ] 真实平台 OAuth、模型 usage/cost evidence、支付回调和发布 canary 仍按生产门禁单独验收。

相关文档：

- [插件源说明](../apps/plugin/README.md)
- [产品使用介绍](product-usage-guide.md)
- [Codex 宿主中转配置参考](../doc/todo/model/codex-app-relay-setup.md)
- [安装后系统引导 PRD](plugin-onboarding-setup-prd.md)
