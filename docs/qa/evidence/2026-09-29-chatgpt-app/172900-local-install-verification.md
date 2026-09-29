# 17:29 本地插件安装验真

2026-09-29 17:29 CST 执行 `node apps/plugin/scripts/upgrade-installed-plugin.mjs --source apps/plugin --marketplace merchant-local`，返回退出码 0。安装版本为 `0.1.0+codex.20260929172900`，安装目录为 `~/.codex/plugins/cache/merchant-local/merchant-marketing/0.1.0+codex.20260929172900`。

安装器比较源码与安装缓存的 54 个运行文件，缺失 0、额外 0、摘要不匹配 0；`mcp/bridge.mjs` SHA-256 为 `3b4acb6d36ada504b36319adb6b691fa00fc29a4198496d086cdac9729c7a467`。`tools/list` 与源码均为 116 个方法，缺失/额外/重复均为 0。无配置的 `workspace.health` 按预期返回 `MCP_CONFIGURATION_REQUIRED`，只说明安全门禁，不能算工作区业务成功。

安装器明确 `current_conversation_refresh.verified=false`，要求完全重启桌面宿主并在新对话中验收。此前 [16:40 桌面调用](164046-desktop-onboarding-call.md) 属于 `160709` 版，不能折算到本版。因此本版当前**安装验真 116/116，真实 ChatGPT App 调用 0/116，正向业务闭环 0**。云端 API、数据库、worker、商家与运营 UI 未随本地插件安装更新。
