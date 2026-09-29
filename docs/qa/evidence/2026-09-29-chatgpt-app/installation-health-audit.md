# 本地插件安装健康审计（只读历史快照）

审计时间：2026-09-29 11:26 CST（对应桌面日志 03:26 UTC），记录 `0.1.0+codex.20260929111500` 的历史快照，不代表当前安装版本。范围仅限本机安装、辅助程序、MCP 发现和 ChatGPT 客户端日志；未操作图形界面，未调用生产业务写入。后续 `0.1.0+codex.20260929114000` 的运行证据见[114000 版调用核对](114000-runtime-log-audit.md)。

| 检查项 | 结果与证据 |
| --- | --- |
| 启用版本 | `codex plugin list` 显示 `merchant-marketing@merchant-local` 为 `installed, enabled`，版本 `0.1.0+codex.20260929111500`。旧的 `@personal` 版本为 `disabled`。 |
| 安装目录 | `~/.codex/plugins/cache/merchant-local/merchant-marketing/0.1.0+codex.20260929111500` 存在。缓存中的 `mcp/bridge.mjs` SHA-256 为 `2d8f9b6f11fa4f156a2dd46683c15f04f16bd46676dedef2ddeba540d6c916d5`，与 Git 提交 `063b0752` 的镜像文件相同。 |
| macOS 凭据辅助程序 | 对安装目录中的 `mcp/keychain-credential.mjs` 调用 `assertKeychainHelperReady()` 返回成功；可执行文件与构建清单存在且哈希校验通过。未读取任何凭据。 |
| 安装包 MCP 自检 | 使用安装目录的 `bridge.mjs` 发出本地 `initialize` 和 `tools/list`：进程退出码 0，服务名 `merchant-marketing`，版本 `0.1.0+codex.20260929111500`，发现 116 项工具，包含 `onboarding.status`。这只是协议发现，不等于业务功能通过。 |
| ChatGPT 实际发现 | 当前 ChatGPT 进程日志在 `2026-09-29T03:26:28.826Z` 记录该服务 `status=starting`，在 `03:26:29.035Z` 记录 `server=merchant-marketing status=ready error=null failureReason=null`。当前进程日志中该服务没有 `status=failed`，也没有 `mcp_extension_tool_discovery_failed` 或 `MCP_KEYCHAIN_HELPER_INVALID`。日志位于 `~/Library/Logs/com.openai.codex/2026/09/29/`，进程号为 `22940`；此处只保留状态摘要，不复制会话标识或凭据。 |

结论：该快照只能证明 111500 版当时的本地安装和 ChatGPT 工具发现正常。后续 114000 版只有 `onboarding.status` 一项真实 App 调用记录；116 项工具仍需按各自准确版本记录调用与业务结果。当前工作树与已安装缓存不一致时，必须重新发布本地版本、安装并验收，不能继承旧缓存结果。

## 12:23 工作区环境复核

以下是 2026-09-29 12:23 左右的只读快照。ChatGPT 主进程 `88816`（12:22:01 启动）和插件桥接进程 `90167`（12:23:49 启动）的非敏感环境变量均为：`MERCHANT_WORKSPACE_ID=ws_guirenniaoniao`、`MERCHANT_MCP_TOKEN_SOURCE=keychain`、`MERCHANT_MCP_WRITE_ENABLED=false`、`MERCHANT_MCP_BASE_URL=https://yxsona.com`。与此同时，`launchctl getenv MERCHANT_WORKSPACE_ID` 为 `ws_57fd2361ed5b44c7891f3d37`，其他三个相关 launchd 值分别为 `keychain`、`false`、`https://yxsona.com`。检查未输出访问令牌或刷新令牌。

桥接代码的优先级为：已继承的进程环境优先；仅缺失时从 launchd 补齐；`workspaceId()` 再优先使用进程中的工作区，其次读取作用域完全匹配的用户级绑定，最后才考虑显式启用的本地 fixture。当前 `~/.codex/merchant-marketing/workspace-binding.json` 是旧的 loopback 绑定，工作区为 `ws_be87dca95d714bc1bbdb6c21`、API 源为 `http://127.0.0.1:8787`，缺少 actor 指纹；`diagnose-workspace-binding.mjs` 对生产源和新工作区的只读诊断为 `stale=true`、`reusable=false`，原因包含源、身份指纹和工作区变化。

因此当前 ChatGPT 进程仍会请求贵人鸟工作区。更改 launchd 不会修改已经运行的 ChatGPT 及其子进程环境。切换到新工作区时，先确认对应 `https://yxsona.com` 与该工作区的钥匙串凭据已绑定，再完整退出并重启 ChatGPT，核对新主进程及 bridge 进程的非敏感环境和实际工具结果；否则钥匙串读取会按工作区精确匹配而失败关闭。
