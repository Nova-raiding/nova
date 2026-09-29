# 本地插件安装健康审计（只读）

审计时间：2026-09-29，当前桌面会话。范围仅限本机安装、辅助程序、MCP 发现和 ChatGPT 客户端日志；未操作图形界面，未调用生产业务写入。

| 检查项 | 结果与证据 |
| --- | --- |
| 启用版本 | `codex plugin list` 显示 `merchant-marketing@merchant-local` 为 `installed, enabled`，版本 `0.1.0+codex.20260929111500`。旧的 `@personal` 版本为 `disabled`。 |
| 安装目录 | `~/.codex/plugins/cache/merchant-local/merchant-marketing/0.1.0+codex.20260929111500` 存在。缓存中的 `mcp/bridge.mjs` SHA-256 为 `2d8f9b6f11fa4f156a2dd46683c15f04f16bd46676dedef2ddeba540d6c916d5`，与 Git 提交 `063b0752` 的镜像文件相同。 |
| macOS 凭据辅助程序 | 对安装目录中的 `mcp/keychain-credential.mjs` 调用 `assertKeychainHelperReady()` 返回成功；可执行文件与构建清单存在且哈希校验通过。未读取任何凭据。 |
| 安装包 MCP 自检 | 使用安装目录的 `bridge.mjs` 发出本地 `initialize` 和 `tools/list`：进程退出码 0，服务名 `merchant-marketing`，版本 `0.1.0+codex.20260929111500`，发现 116 项工具，包含 `onboarding.status`。这只是协议发现，不等于业务功能通过。 |
| ChatGPT 实际发现 | 当前 ChatGPT 进程日志在 `2026-09-29T03:26:28.826Z` 记录该服务 `status=starting`，在 `03:26:29.035Z` 记录 `server=merchant-marketing status=ready error=null failureReason=null`。当前进程日志中该服务没有 `status=failed`，也没有 `mcp_extension_tool_discovery_failed` 或 `MCP_KEYCHAIN_HELPER_INVALID`。日志位于 `~/Library/Logs/com.openai.codex/2026/09/29/`，进程号为 `22940`；此处只保留状态摘要，不复制会话标识或凭据。 |

结论：111500 版的本地安装和 ChatGPT 工具发现目前正常。仍需由 owner 在 ChatGPT 对话中逐项调用并核对中文产出、真实数据与权限结果。源码中的 `bridge.mjs` 正由其他 agent 修改，当前工作树哈希不同于已安装的 111500 缓存；后续修订必须发布新版本、重新安装并重新验证，不能把当前缓存的结果计入新版本验收。
