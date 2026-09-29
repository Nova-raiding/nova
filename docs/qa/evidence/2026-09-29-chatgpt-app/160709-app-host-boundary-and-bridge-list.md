# 160709 本地插件宿主边界与工具清单

核对时间：2026-09-29 16:10 中国标准时间。当前安装缓存包 `@merchant-marketing/plugin` 版本为 `0.1.0+codex.20260929160709`。本文件严格区分 **已安装 stdio 桥接器发现** 与 **ChatGPT App 内实际调用**。

## 已安装桥接器发现

从该版本安装缓存中的 `mcp/bridge.mjs` 启动独立本地进程，只发送标准 MCP `tools/list`。使用 `MERCHANT_MCP_TOKEN_SOURCE=environment`、QA 工作区 ID 与生产域名作为本地配置，**没有提供令牌，也没有发送 `tools/call`**。进程正常退出、响应一行 JSON；清单有 116 个互不重复的方法，其中 46 个标记为只读。与 `docs/qa/2026-09-29-chatgpt-app-116-tool-checklist.md` 中的 116 个精确方法逐名对照，缺失 0、新增 0。按返回顺序以换行连接方法名的 SHA-256 为 `905bb19823baccf428fbca6338987e6f6fd01012d3f8d5d164dff361ce98c76f`。

这是安装包的工具目录证据，不证明 App 宿主加载、用户身份、生产 API 连通或任何业务功能通过。

## App 实际调用边界

当前 agent 的 `ALL_TOOLS` 中没有 `mcp__merchant_marketing__*`，因此本子会话不能调用 Store Nova 工具。机器上虽有 `ChatGPT.app` 进程，但从当前执行环境读取其窗口时，无可识别的对话输入或输出可访问性节点，屏幕抓取也返回 `could not create image from display`。没有可可靠定位与核对的 App 新对话入口，所以没有用盲键盘输入模拟测试。

截至本次检查，所检索到的最新真实桌面 App Store Nova 工具调用仍属于 **153500 版**：`~/.codex/sessions/2026/09/29/rollout-2026-09-29T16-00-42-01a0ec2e-2518-7cb3-a0ab-7021f7b78a84.jsonl`。其 `session_meta.originator=codex_work_desktop`；该版逐项统计见 `153500-app-call-audit.md`。不能把那些 call ID 继承到 160709 版。

**160709 版当前可核实的 App 实际调用为 0/116，剩余 116/116 未在该版本取得原始 `custom_tool_call`/同 `call_id` 输出。** 本轮也没有可称作该版 App 业务成功的用户可见产出。后续须从真实桌面 App 新会话读取安装版本与工具事件，再按原始调用和返回逐项累计；若 App 仍未加载插件，先恢复宿主入口与本地凭据作用域。
