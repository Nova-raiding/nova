# 174000 版 31 项只读 stdio：认证前置未满足

核查日期：2026-09-29。目标安装包：本地 `merchant-marketing@merchant-local` `0.1.0+codex.20260929174000`；目标商家 `demo@sn.com`，唯一 QA 工作区 `ws_57fd2361ed5b44c7891f3d37`。

安装包 README 与 `mcp/managed-token.mjs` 表明，独立 stdio bridge 支持从子进程环境接收正式短期 MCP 令牌；正式路径是商家密码登录、会话身份和工作区核对、签发同工作区 MCP 令牌，再由 bridge 调用。历史 [生产 API 31 项读取](production-api-31-readonly-20260929.md)证明旧轮次曾完成该流程，但不能替代本轮凭据或调用结果。

本子任务可见的会话上下文没有 `demo@sn.com` 密码或可安全引用的现有商家会话，进程环境没有授权凭据变量。按 owner 指示不从系统其他账户或未授权存储搜取，不借用其他商家工作区、旧 Keychain 凭据或模拟令牌。因此未发起本轮正式登录、MCP token 签发、`initialize`、`tools/list` 或 31 项 `tools/call`。**本轮执行 0/31，业务结果 0/31；没有认证成功或失败的生产响应。**

31 项具体方法及每项状态仍以[前轮逐项表](160709-31-readonly-stdio-keychain-block.md)为索引；那份表记录的是 160709 版 Keychain 阻断，不能写作 174000 版调用结果。本文件只属独立 stdio 认证前置核查，不是 ChatGPT App 验收。
