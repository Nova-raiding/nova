# 17:40 本地插件安装核验

核验时间：2026-09-29 17:40 CST。执行 `node apps/plugin/scripts/upgrade-installed-plugin.mjs --source apps/plugin --marketplace merchant-local`，退出码 0，结果 `ok=true`。

- 已安装版本：`0.1.0+codex.20260929174000`，安装目录 `~/.codex/plugins/cache/merchant-local/merchant-marketing/0.1.0+codex.20260929174000`。
- 54 个运行文件与源文件逐项 SHA-256 一致；桥文件摘要 `f89f08430a4473d5013321c907499b47ab859de7d5f2b0cc15a92ed542440181`。
- 源与安装实例 `tools/list` 均为 116 项，没有缺失、重复或缓存漂移。未配置时 `workspace.health` 返回预期 `MCP_CONFIGURATION_REQUIRED`。
- 安装器明确给出 `current_conversation_refresh.verified=false`：当前 ChatGPT 宿主需要完整重启并新建会话。安装核验不证明任何真实 App 业务调用。
- `connect_helper.app_bundle_verified=false`，自定义 scheme 的未签名辅助程序不能记为生产连接路径。

本地版本安装完成；截至此记录，真实 ChatGPT 桌面 App 仍无该版本会话或调用证据。
