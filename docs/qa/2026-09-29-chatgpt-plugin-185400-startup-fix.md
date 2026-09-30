# 185400：ChatGPT 插件初始化修复与真实入口验收

日期：2026-09-29。安装版：`0.1.0+codex.20260929185400`。

## 已修复

183900 在读取 MCP 请求前顶层加载托管凭据，钥匙串失败会导致进程退出。ChatGPT 18:45 重启后日志明确记录 `mcp_extension_tool_discovery_failed` 和 `connection closed: initialize response`。先前将 0 工具主要归因于旧会话缓存不充分，现以实际宿主启动日志修正。

185400 将凭据读取延后到首次业务调用，并让并发调用共享同一次加载。初始化、工具清单和静态资源可用；凭据失败则锁定当前进程、清除继承的 access/refresh/expiry，在参数预处理和网络请求前拒绝全部业务调用。严格鉴权与 fixture 禁用保护保留。完成本地绑定后须重新加载插件进程。

## 验证结果

| 检查 | 结果 |
|---|---|
| bridge / managed token 完整回归 | 135/135 通过；包含逐一调用全部可见工具、凭据错误脱敏、stale token 与 fixture 不能绕过、0 HTTP 请求。 |
| 安装 / manifest / MCP 契约 | 50/50 通过。 |
| `npm run typecheck` | 通过。 |
| 本地安装校验 | 54 个运行文件与源码一致，116 个工具，无漂移；新版本缓存完成 helper 构建。 |
| 本机真实 Keychain 失败复现 | 新版进程正常退出，initialize 返回 185400，工具清单 116，业务调用返回凭据阻断，无 stderr。见 `evidence/2026-09-29-chatgpt-app/185400-real-keychain-startup.json`。 |
| ChatGPT App 真实工具调用 | 新分叉会话实际发现 116 个工具；随后同一会话逐项调用 116 个不同工具，原始 `McpToolCall` 事件逐条复核，全部返回 `MCP_CREDENTIAL_SOURCE_INVALID`。见下方证据。 |
| 容器只读健康 | 当前 demo API 双副本、UI、数据库、Redis 和 generation 等 worker 显示 healthy；同机遗留 `local-worker-*` 显示 unhealthy，此次未修改或重启这些容器，不能宣称整机全部健康。 |

App 会话：`01a0eccd-b2e0-78a1-b483-874a56759a6f`。逐项验收 turn：`01a0ecce-38b2-76a1-8342-5c94493458f9`。原始日志：`~/.codex/sessions/2026/09/29/rollout-2026-09-29T18-54-58-01a0eccd-b2e0-78a1-b483-874a56759a6f.jsonl`。

脱敏逐项证据：[`185400-app-116-credential-gate.json`](evidence/2026-09-29-chatgpt-app/185400-app-116-credential-gate.json)，保留每项工具、调用 ID、原始行号和返回码。所有调用参数为 `{}`，凭据失败保护在业务参数处理前生效；无服务端请求 ID。

## 尚未通过

**116/116 是真实 App 入口与凭据失败保护覆盖，业务正向成功数为 0。** 当前 App 的服务地址、QA 工作区、Keychain 来源和严格鉴权设置正确，没有 actor/role pin；本机 helper 的实际读取仍返回 `keychain_osstatus=-25308`。Apple 将该状态定义为不允许用户交互，参见 [Apple 错误码文档](https://developer.apple.com/documentation/security/errsecinteractionnotallowed)。此证据不能证明授权已成功保存，也不能只靠再次升级包消除系统交互限制。

图片、视频、文案、审核和导出尚无本轮正向产物或模型费用收据。当前生产商家清单也未开放视频成片请求/查询，不能将脚本当成视频成片。后续按 `2026-09-29-183900-positive-flow-plan.md` 的依赖顺序执行，先取得真实身份和权益返回，再生成 QA 产物。

此次仅安装本地插件，没有部署服务器、改变业务数据、清空凭据或放宽权限。电脑控制工具对 ChatGPT App 的安全拒绝仍存在；本轮真实 App 工具调用通过宿主提供的验收会话接口完成，不代表已完成鼠标界面演示。

## 后续 Keychain 状态取证

185400 安装后使用只读 `SecKeychainCopyDefault` / `SecKeychainGetStatus` 继续定位。默认钥匙串路径为 `~/Library/Keychains/login.keychain-db`；两次 API 状态均为成功，状态位为 `2`，按系统常量解析：`unlocked=false`、`read_permission=true`、`write_permission=false`；同时 helper 读取仍返回 `-25308`。

**归因修正：该状态不能证明用户图形会话里的 login 钥匙串锁定。** Owner 与独立 agent 复核 `launchctl managername` 为 `Background`；ChatGPT GUI 主进程与当前执行诊断/MCP 的后台进程不属同一启动链路。因此只能断言当前后台上下文的 Keychain 访问受限，不能据此要求用户反复解锁或更改 ACL。先前“先解锁 login”的操作建议证据不足。

历史对照 `evidence/2026-09-29-chatgpt-app/local-plugin-callback-browser-e2e.md` 记录：同一安装器曾在无图形交互执行环境报 `User interaction is not allowed`，在 macOS Terminal 图形会话启动后绑定成功。该历史使用另一商家工作区，不能继承为当前 QA 身份授权；它支持优先检查启动上下文。后续须通过正常图形会话的当前 QA 本地绑定与 App 调用验证，不从后台状态推断整个 GUI 锁定，也不绕过系统交互或改用弱化存储。
