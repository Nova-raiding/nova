# 本地插件授权回调浏览器验收

2026-09-29，使用隔离 Chromium 与真实 `loginLocalPlugin` 本地监听器执行。授权码和令牌均为测试值，换取令牌的 HTTP 响应由进程内 fixture 提供；未写入系统钥匙串、未修改 ChatGPT 安装配置，也未调用生产授权接口。

复现命令：`node dogfood/chatgpt-all-functions/local-plugin-callback-browser-e2e.mjs`。

| 路径 | 观察结果 |
| --- | --- |
| 正常 | 回调到达时显示「正在完成绑定」，换取令牌等待期间没有成功提示；凭据保存、会话配置、ChatGPT 启动 fixture 完成后显示「绑定已完成」。 |
| 换取令牌被拒 | 回调先显示等待，服务端拒绝后显示「绑定未完成」；凭据保存函数未调用。 |
| 浏览器安全 | 页面地址中的 `code` 和 `state` 已清除；页面正文不含测试授权码或令牌；两条路径均无页面脚本错误。 |

截图：[等待态](27-callback-success-pending.png)、[完成态](27-callback-success-result.png)、[失败态](27-callback-failure-result.png)。

此验收只证明本地回调页和安装器状态联动。生产商家登录、钥匙串持久化及 ChatGPT App 再读取须在安装升级后单独实测。

## 生产商家真实回调

新版插件 `0.1.0+codex.20260929090000` 安装后，在现有 Chrome 商家会话中确认 `demo@ys.com` 对 `ws_guirenniaoniao` 的本地插件授权。由 macOS Terminal 图形会话启动安装器后，真实生产授权页重定向至本机回调页；页面先显示处理中，随后显示[绑定完成截图](28-production-callback-binding-success.png)。地址栏只有 `/merchant-mcp-callback`，没有授权码或 state。安装器返回 `ok:true`、`credential_source:keychain`、`restart_required:true`、`host_verified:false`，未输出令牌。

此前从无图形交互的执行环境启动同一安装器，回调页正确显示绑定失败，安装器返回 `LOCAL_PLUGIN_LOGIN_FAILED`；诊断显示系统钥匙串报 `User interaction is not allowed`。改由 Terminal 图形会话执行后成功。该失败属于安装器运行环境的钥匙串权限问题，不代表生产授权成功；成功结果仍需要 ChatGPT 重启后的 `onboarding.status` 独立验证。
