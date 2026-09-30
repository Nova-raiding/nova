# Store Nova 本地插件 183900 版续查

日期：2026-09-29。当前安装包 `merchant-marketing/0.1.0+codex.20260929183900`。

| 项目 | 结果 |
|---|---|
| 安装验证 | 源码与安装包核验 `ok=true`；stdio 工具清单 116 项，无缓存漂移。 |
| 无凭据保护 | `workspace.health` 返回配置阻断；没有绕过鉴权。 |
| Keychain | 当前自动化进程读取 QA 凭据返回系统状态 `-25308`（`read`）；helper 已安全输出状态码，未输出令牌。 |
| App 时序 | ChatGPT 主进程 18:36 启动，早于 18:38 的 183900 包安装。 |
| 当前 App 旧会话 | Store Nova 工具 0 项；基础查询不可调用，无请求 ID。 |

验证器明确给出 `current_conversation_refresh.verified=false`。当前没有 183900 版真实 ChatGPT App 业务通过证据。需在安装完成后完整重启 ChatGPT 并开启新会话，再检查插件工具清单和本地绑定状态。

18:45 ChatGPT 主进程已在安装后重新启动。用户表示完成授权，但当前自动化进程读取 Keychain 仍返回 `-25308`；这不能判断图形宿主内的授权结果。旧 App 验收会话再次只读检查仍为 0 个 Store Nova 工具，因此必须在新会话重新获取工具快照后验证。

18:49 使用 ChatGPT 会话分叉接口从原验收任务建立 `01a0ecc8-8c9e-72f3-97e8-2e0484dab03c`，发起只读检查；新分叉仍报告 0 个 Store Nova 工具，基础三项未调用且无请求 ID。分叉会继承原任务历史，不能据此断言全新空白对话的工具快照；但它也没有提供任何本轮 App 成功调用。

## 启动日志补充与归因修正

检查宿主日志 `~/Library/Logs/com.openai.codex/2026/09/29/codex-desktop-aa003ca9-273d-4728-a882-810ee1745293-58086-t0-i1-104504-0.log`：18:45:30、18:45:38、18:46:06、18:46:14 均记录 `mcp_extension_tool_discovery_failed`，目标是 `merchant-marketing@merchant-local`，错误为 `MCP startup failed: handshaking with MCP server failed: connection closed: initialize response`。

因此不能继续将工具缺失简单归因于旧会话缓存。重启后的宿主确实尝试启动 bridge，但初始化前连接关闭。源码在读取 stdin 前顶层执行 `await loadManagedToken(...)`，Keychain 失败会抛错退出；本机同一包的凭据读取可重现 `keychain_osstatus=-25308`。应修复初始化与鉴权耦合：公开 MCP 协议初始化和工具发现可用，所有业务请求仍严格拒绝不可用的托管凭据。
