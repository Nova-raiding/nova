# 桌面运营后台真实后端只读验收

在候选 API 网关可访问、持久数据库迁移完成、真实平台管理员和工作区管理员会话可用后，执行 `node infra/scripts/smoke-ops-real-backend.mjs`。环境变量需提供 `OPS_SMOKE_API_BASE_URL`、`OPS_SMOKE_WORKSPACE_ID`、`OPS_SMOKE_EXPECT_WORKSPACE_ACTOR_ID`、`OPS_SMOKE_EXPECT_PLATFORM_ACTOR_ID`，以及工作区与平台两个工作台的独立授权凭据：各自选择 `OPS_SMOKE_*_COOKIE` 或 `OPS_SMOKE_*_TOKEN`。凭据必须由真实身份网关签发，分别对各自预期 actor 授权，工作区凭据只对预期 workspace 授权；不要把凭据提交到仓库、写进命令行参数或保存脚本输出。

脚本依次读取 `/mcp` 的 `ops.session`、工作区成员、账务、规则和审计，再在平台工作台读取 `ops.session` 与五模态模型状态。它校验会话身份、角色、工作台和租户，以及返回行的工作区归属、模型中转和成本字段；只输出方法名与通过状态。可选设置 `OPS_SMOKE_DENIED_WORKSPACE_ID` 为工作区凭据明确无权访问的另一个真实工作区；脚本再以该凭据请求成员列表，只有 HTTP 403/404 才算租户拒绝通过，200 空列表不算隔离证据。未获得两个真实会话、MCP 返回错误、跨租户行、fixture 标记或契约缺失均为阻断。

Cookie 请求会携带已验证 `OPS_SMOKE_API_BASE_URL` 的 origin（只有 scheme、host、port，不包含 `/api` 路径）；生产 API 仍执行可信来源检查。脚本不接受任意 origin 覆盖，也不读取浏览器 cookie。若服务器拒绝该 origin，先核对正常入口和已有部署允许来源，不关闭 CSRF 检查。

当前 `local_stdio` 部署的两类凭据不同：平台工作台使用已登录平台账号的密码会话 cookie；工作区商家会话访问 `/mcp` 则必须使用正常商家登录后换取、绑定该工作区的短期 MCP bearer，单独商家 cookie 不能替代它。平台 bearer 也不能被当作平台密码会话的替代方案。平台会话的角色与权限仍须有真实持久授权来源；商家须有该工作区的 active membership 与 identity 绑定。只获得其中一个凭据时保持阻断，不复用另一角色的凭据或使用 fixture/local token。

两个 `ops.session` 的 `identity_id` 与 `session_id` 均须为非空字符串；缺字段、空白或其他类型都算身份来源缺失并阻断，不能把缺失字段等同于已认证。脚本不会输出这两个来源字段或授权凭据。

这项 smoke 只能证明已访问的只读接口和返回数据范围；零行列表不能证明业务数据完整，也不能替代桌面浏览器验收、账务对账、模型真实调用、发布门禁或 ChatGPT 插件安装测试。
