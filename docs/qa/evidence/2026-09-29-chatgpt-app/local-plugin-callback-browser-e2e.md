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
