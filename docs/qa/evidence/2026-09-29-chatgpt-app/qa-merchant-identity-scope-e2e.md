# 独立商家身份与工作区边界复验

时间：2026-09-29。商家：`demo@sn.com`。独立测试工作区：`ws_57fd2361ed5b44c7891f3d37`。本轮只使用该商家的既有本机会话执行只读查询；没有修改贵人鸟账号、工作区或业务数据，也没有迁移数据库。

## 调用链和结果

1. 以该商家既有会话读取 `/api/v1/auth/session`：账号类型 `merchant`、状态 `active`，工作区列表仅有 `ws_57fd2361ed5b44c7891f3d37`。
2. 同一会话向 `/api/v1/auth/mcp-token` 申请 QA 工作区短期令牌：HTTP 200，返回 `account_login=demo@sn.com` 和准确 QA 工作区 ID。令牌只在测试进程内存中使用，没有打印或保存。
3. 使用该短期令牌调用生产 HTTPS `/mcp`：`onboarding.status` HTTP 200；`workspace.health` HTTP 200，返回 QA 工作区 ID，`storeDirectory` 长度 0。
4. `brand-unit.list` 返回 HTTP 428、`STORE_ONBOARDING_REQUIRED`。这说明当前 QA 工作区没有满足品牌列表入口所需的店铺前置数据，不能记为品牌功能正向通过。
5. 用同一商家令牌将 `/mcp` 的 `x-workspace-id` 和参数都改为贵人鸟工作区 `ws_guirenniaoniao`，只读 `workspace.health` 返回 HTTP 403、`FORBIDDEN`。没有跨租户数据返回。

本机 `launchctl` 中插件配置以及当时 ChatGPT 主进程 PID 24052 的相关环境变量均为 QA 工作区、`MERCHANT_MCP_TOKEN_SOURCE=keychain`、`MERCHANT_MCP_WRITE_ENABLED=false`、`MERCHANT_MCP_BASE_URL=https://yxsona.com`。CodeGraph `explore workspaceId loadWorkspaceBinding` 表明插件调用时优先使用显式 `MERCHANT_WORKSPACE_ID`，工作区绑定文件仅是后备；`explore loginLocalPlugin keychainCredential` 表明钥匙串凭据按 API origin 与工作区索引。CodeGraph 索引状态 complete、2,349 files、33,821 nodes、132,432 edges，仍有少量未同步文件；判断最终以磁盘代码和上述运行结果为准。

## 证据边界

以上证明生产 API/MCP 的商家身份、QA 工作区只读通达和跨租户拒绝；它不单独证明 **133000 版 ChatGPT App 当前会话**已正向取得业务对象。历史 12:29 App 新会话已有 QA 空店铺原始工具记录，见 [独立商家工作区与 ChatGPT App 实测](123300-qa-account-app-check.md)。`merchant.start`、品牌创建、批量任务等正向路径仍被 QA 工作区缺少专用店铺/商业权益/创意点的前置条件挡住，不能借用另一租户的资源。
