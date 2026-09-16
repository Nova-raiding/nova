# 桌面运营后台真实后端只读验收

在候选 API 网关可访问、持久数据库迁移完成、真实平台管理员和工作区管理员会话可用后，执行 `node infra/scripts/smoke-ops-real-backend.mjs`。环境变量需提供 `OPS_SMOKE_API_BASE_URL`、`OPS_SMOKE_WORKSPACE_ID`、`OPS_SMOKE_EXPECT_WORKSPACE_ACTOR_ID`、`OPS_SMOKE_EXPECT_PLATFORM_ACTOR_ID`，以及工作区与平台两个工作台的独立授权凭据：各自选择 `OPS_SMOKE_*_COOKIE` 或 `OPS_SMOKE_*_TOKEN`。凭据必须由真实身份网关签发，分别对各自预期 actor 授权，工作区凭据只对预期 workspace 授权；不要把凭据提交到仓库、写进命令行参数或保存脚本输出。

脚本依次读取 `/mcp` 的 `ops.session`、工作区成员、账务、规则和审计，再在平台工作台读取 `ops.session` 与五模态模型状态。它校验会话身份、角色、工作台和租户，以及返回行的工作区归属、模型中转和成本字段；只输出方法名与通过状态。可选设置 `OPS_SMOKE_DENIED_WORKSPACE_ID` 为工作区凭据明确无权访问的另一个真实工作区；脚本再以该凭据请求成员列表，只有 HTTP 403/404 才算租户拒绝通过，200 空列表不算隔离证据。未获得两个真实会话、MCP 返回错误、跨租户行、fixture 标记或契约缺失均为阻断。

这项 smoke 只能证明已访问的只读接口和返回数据范围；零行列表不能证明业务数据完整，也不能替代桌面浏览器验收、账务对账、模型真实调用、发布门禁或 ChatGPT 插件安装测试。
