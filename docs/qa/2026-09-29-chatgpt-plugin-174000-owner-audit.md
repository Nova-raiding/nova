# Store Nova 本地插件 174000 版 owner 验收记录

日期：2026-09-29。目标安装包：`merchant-marketing/0.1.0+codex.20260929174000`。目标账号：`demo@sn.com`；目标工作区：`ws_57fd2361ed5b44c7891f3d37`（QA，不发布）。

## 本轮实测

| 检查 | 结果 | 证据边界 |
|---|---|---|
| 已安装 bridge 标准 `tools/list` | 116 项；`catalog.image.generate`、`catalog.image.get` 可见；`multimodal.video.request`、`multimodal.video.get` 不可见 | 仅工具发现。此只读探测显式使用无令牌的 `environment` 来源，以避开初始化前的钥匙串失败；没有业务调用。 |
| ChatGPT App 当前会话 | 应用进程运行，环境变量指向上述 QA 工作区和 `https://yxsona.com`；现有 App 任务复核时 Store Nova MCP 工具为 0 项 | 当前会话未形成任何 Merchant Marketing 工具调用，不能算 App 验收通过。电脑控制工具拒绝操作 `com.openai.codex`。 |
| 浏览器账号 | 商家后台显示 `demo@sn.com`、QA 工作区账号且已登录；工作区页面显示 0 家店铺，素材页显示 0 项 | 仅商家后台只读结果，不能替代插件调用。 |
| Keychain 读取 | 当前 helper 可执行、hash 和签名有效；QA 条目存在；macOS 返回 `-25308`。在钥匙串“访问控制”加入当前 helper 后，从自动化进程重试仍返回相同错误 | 自动化进程连临时测试条目的 `SecItemAdd` 都返回 `-25308`，说明该进程不能完成需图形授权的钥匙串操作。测试条目未被创建。 |
| 本地 OAuth 重新绑定 | 授权页核对 `demo@sn.com` 与 QA 工作区并提交；回调显示“绑定未完成”，CLI 返回 `LOCAL_PLUGIN_LOGIN_FAILED` | 该后台进程不能保存凭据。本轮没有取得可用于调用 MCP 的认证会话。 |
| 桌面连接助手 | 当前安装包没有 `bundle-status.json` 或已签名的 `Store Nova Connect.app`；注册脚本要求 `signed_notarized` 和 `ready_to_install=true` | 当前无法使用一键连接入口恢复凭据；不能放宽签名门禁来替代正式连接。 |
| 相关自动化测试 | 5 个文件、229 项通过：插件安装、bridge、MCP surface、图片模型、视频模型 | 这些是代码/隔离测试，不等于当前 ChatGPT App 的业务成功。 |

## 状态结论

174000 版当前 **0/116 项获得本轮真实 ChatGPT App 工具调用结果**。图片和视频均没有本轮真实生成产物或模型费用收据。此前 143500 版的 116/116 App 入口调用记录在 `docs/qa/2026-09-29-chatgpt-app-116-tool-checklist.md`，其中 22 项非错误、94 项错误或门禁；不得转记为 174000 版通过。

恢复动作：在用户图形终端运行当前已安装包的 `scripts/login-local-macos.mjs`，完成同账号、同 QA 工作区授权与 Keychain 保存；完整重启 ChatGPT 并在新会话复核 `onboarding.status`、`workspace.health`、创意点及工具清单。若 App 不暴露工具，继续按安装器和宿主日志定位。正向图片验收还须有 QA 商品事实、可用素材、权益、交互确认及账务证据。视频成片工具在此安装版商家 surface 未暴露，不能标记为成片功能通过。
