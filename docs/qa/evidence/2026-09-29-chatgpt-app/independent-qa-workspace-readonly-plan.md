# 独立 QA 商家工作区：生产只读核查（2026-09-29）

本文记录 owner 已完成的专用 QA 账号及首次工作区创建，以及本 agent 随后的生产只读核查。本 agent 没有在生产创建、修改或删除数据，也没有使用 GUI。工作区创建成功不等于 116 工具生产验收完成。

## 生产事实

- `GET https://yxsona.com/api/healthz` 返回 `status=ok`、Postgres `ready=true`、`mode=production`；六个平台连接均为 `manual_operations`。健康响应的 `writesEnabled=false` 属平台连接写入状态，不能据此推断工作区引导接口被禁用。
- `GET https://yxsona.com/api/releasez` 返回 `ready=true`，部署 SHA `fd1ad6a7bd122a391350c185798ac07e92795f8c`。下述接口及权限路径已在该 SHA 中核对。
- 创建前生产库只读聚合为 1 个工作区、0 个未绑定的活跃商家账号；创建后的最新只读聚合为 **2 个工作区**，分别是贵人鸟 `ws_guirenniaoniao` 和专用 QA `ws_57fd2361ed5b44c7891f3d37`。已知 `devide@sn.com` 是活跃 `platform_admin`；有状态测试应只在新 QA 工作区运行。
- 生产 API 容器配置为 `OPS_AUTH_MODE=password`、`MCP_INTEGRATION_MODE=local_stdio`；`ALLOW_MERCHANT_SELF_REGISTRATION` 未设置。公开 `/v1/auth/register` 因而关闭（`AUTH_PUBLIC_REGISTRATION_DISABLED`）。

### 指定账号 `demo@sn.com` 的生产核查

创建前四张身份/绑定表匹配 `demo@sn.com` 的记录均为 0。owner 首次开通请求因空密码返回 500，库中未留下部分记录；随后以有效独立密码单次重试开通得到 201，首次 `workspace-bootstrap` 得到 201。以下为该操作后的 `BEGIN READ ONLY` 持久化核查，查询没有选取密码哈希、Cookie 或 token：

- `platform_password_accounts` 现有且仅有 1 条 `demo@sn.com`，`status=active`、`roles=[merchant]`、`workspace_ids=[ws_57fd2361ed5b44c7891f3d37]`。对应 `platform_identities` 为 `active`、`risk_decision=allow`。
- 新工作区 `ws_57fd2361ed5b44c7891f3d37` 为 `active`、`capacity_tier=pilot_50`。其中仅 1 名成员，是与该账号身份 ID 一致的 `active workspace_owner`；`workspace_identity_bindings` 仅将 `damai-password/demo@sn.com` 绑定到新 ID。
- `demo@sn.com` 在 `ws_guirenniaoniao` 的身份绑定和成员记录均为 0；账号的唯一工作区 ID 也不是贵人鸟 ID。数据库隔离基线成立。
- 新工作区当前 `workspace_subscriptions`、V2 entitlement snapshot/period、旧版 `subscription_entitlements`、`demo_evaluation_entitlements`、`workspace_commercial_settings`、`workspace_storage_quotas` 均为 **0 条**；`platform_accounts` 测试店铺 **0**，`products` 与 `canonical_products` 各 **0**；创意点 access state 与 grants 各 **0 条**。这表示尚无正向商用权益、存储配额或可用点数证据，不应把零行解释为已获 0 元套餐或已授予额度。迁移 246 的数据库约束将现有 demo evaluation grant 限于 `ws_guirenniaoniao`，不能直接转给独立 QA 工作区。
- 审计存在 `auth.merchant_created`、`auth.login_succeeded`、`auth.merchant_workspace_bootstrapped` 身份事件，以及新工作区 `workspace.bootstrap` 操作审计。账号开通、首次绑定和审计事实均持久化。

下一步是用本地 stdio 插件令牌核验 ChatGPT App 只进入这个工作区，再读取该工作区商业/点数状态并决定各写入工具是否具备正向条件。

## 最少受控创建流程（前两步已由 owner 执行）

1. 授权平台账号在平台工作台调用 `POST /v1/ops/merchant-accounts`，以指定的 `demo@sn.com` 和独立强密码、`enterprise_name`/`contact_name`、`workspace_ids: []`、`bootstrap_workspace: true`、明确 `reason` 开通。接口要求平台运营/管理员身份；成功时创建活跃商家身份和零工作区账号，返回 201、`next_action=workspace_bootstrap`。此步不会自动授予付费权益，响应仍为 `vip_access=pending_billing_verification`。
2. QA 商家用该身份登录 `POST /v1/auth/login`，持会话 Cookie、正确同源 `Origin` 调用 `POST /v1/auth/workspace-bootstrap`，传 QA 标记的 `display_name`。仅活跃、零工作区且风控通过的商家可用；成功返回随机 `ws_<24 hex>`、活跃工作区与 owner 绑定。重复引导返回 409，跨源返回 403。
3. 该商家通过 `/v1/auth/mcp-token` 或本地插件安装器取得短期工作区 MCP 令牌，并按项目的本地 stdio 链路接入 ChatGPT App。先核验令牌指向新工作区、`workspace.health`/会话身份以及跨工作区拒绝，再开始有状态工具测试。严格鉴权时 MCP `workspace.bootstrap` 只复用已有绑定，不能直接创建生产工作区。

接口与权限依据：`apps/api/src/server.ts` 的商家开通路由，`apps/api/src/http-password-auth-routes.ts` 的首次工作区路由，`apps/api/src/mcp-workspace-setup-handlers.ts` 的严格鉴权分支；隔离链路测试见 `apps/api/src/mcp-oauth-identity.e2e.test.ts`。

## 标记、隔离和收尾边界

- 每轮生成唯一 `QA-DO-NOT-PUBLISH-YYYYMMDD-<run-id>`；写入企业名、工作区显示名、操作原因及所有测试商品/素材/交付物名称。工作区 ID 由服务端随机生成，不能靠 `ws_qa_` 前缀辨识。记录登录邮箱、账号/身份/工作区 ID、审计 ID、测试时间、令牌到期时间和产物清单；密码与令牌不写进证据。
- 使用自有测试邮箱、测试素材及独立授权的测试店铺/配额。不要使用贵人鸟数据、真实顾客、真实支付或发布目标。创建工作区只解决租户隔离，不能自动打开商业权益、平台连接、模型额度或全部 116 工具；这些能力需各自核验门禁。
- 结束时先导出所需证据，撤销本地插件令牌/会话；QA owner 可调用 `workspace.deactivate`，返回 `dataRetained=true`，以后可 `workspace.activate` 恢复。平台授权账号可在平台工作台对 QA 身份调用 `ops.user.suspend(scope=identity)` 和 `ops.user.session.revoke`；不能自停用，需按 revision、幂等键、原因执行并保留审计。`platform_admin` 具 `identity.update` 与 `identity.session.revoke` 能力。
- 工作区停用是保留数据的归档边界，**不是删除**。`workspace.data.delete.request` 需要至少 7 天宽限期和后续双人审批；不能把它当作常规 QA 清理。生产数据删除需另行审查范围与恢复方案。

生命周期/权限依据：`apps/api/src/mcp-workspace-lifecycle-handlers.ts`、`apps/api/src/server.ts` 的身份变更处理、`packages/contracts/src/authz.ts`；隔离测试见 `apps/api/src/workspace-status-authz.e2e.test.ts` 与 `apps/api/src/identity-mutation-role-contract.e2e.test.ts`。

## 可执行请求顺序与停止条件（前两步已完成，后续为草案）

API 外部前缀为 `https://yxsona.com/api`；本轮只读 `GET /api/v1/auth/session` 得到预期的 401，确认该反向代理路径存在。以下示例中的 Cookie、密码和 token 必须来自受控密钥输入，不能写入脚本、终端历史、日志或证据包。

| 阶段 | 请求与输入 | 成功证据 | 失败时动作 |
| --- | --- | --- | --- |
| 只读预检 | `GET /api/healthz`、`GET /api/releasez`；确认部署 SHA、Postgres、relay、生产门禁 | `status=ok`、`ready=true`；记录 release SHA | 不开账号，记录阻断 |
| 开通身份 | 已登录的平台管理员 `POST /api/v1/ops/merchant-accounts`，`x-ops-workbench: platform`，正文 `{"login":"demo@sn.com","password":"<secret>","enterprise_name":"QA-DO-NOT-PUBLISH-<run-id>","contact_name":"QA <run-id>","workspace_ids":[],"bootstrap_workspace":true,"reason":"QA-DO-NOT-PUBLISH-<run-id> isolated App coverage"}` | 201；账号 `workspaceIds=[]`、`next_action=workspace_bootstrap`、身份 ID | 超时先按唯一登录名查询账号，不能盲重试；409 视为需人工核对原账号 |
| 首次绑定 | QA 商家 `POST /api/v1/auth/login` 后持商家会话 `POST /api/v1/auth/workspace-bootstrap`，`Origin: https://yxsona.com`，正文 `{"display_name":"QA-DO-NOT-PUBLISH-<run-id>"}` | 201；记录生成的 `workspace_id`；再次读取商家会话，确认只绑定该 ID | 403 核对 Origin、身份状态和风控；409 核对是否已有绑定，不创建第二身份掩盖孤儿数据 |
| 插件接入 | 商家会话通过本地安装器/`POST /api/v1/auth/mcp-token` 为新 ID 换取工作区 token；走本地 stdio App 链路 | 返回 `workspace_id` 等于新 ID；MCP 会话/健康只显示 QA 工作区；对贵人鸟 ID 的跨租户读取拒绝 | 任何作用域不一致立即撤销 token 并停止 |
| 商业与成本预检 | 在 QA 工作区读 `workspace.commercial.get`、`subscription.get`、`workspace.usage.get`、`billing.status`、`commercial.access.get`、创意点余额和平台店铺列表 | 记录有效权益、任务/店铺/点数/存储容量、模型费用上限 | 零额度或未知权益时只验授权拒绝；不可伪造支付、绕过余额或假称正向通过 |
| 有状态工具 | 按 116 工具矩阵逐项执行；所有对象名和理由带 run ID；每步记录 MCP 请求 ID、API 资源 ID、审计 ID、成本/用量前后值 | 结果可从 ChatGPT App 看见，且独立 QA 租户的持久状态和审计一致 | 任一跨租户、真实发布、额度超限或不可恢复副作用立即停机 |
| 留存与停用 | 收集审计/产物索引，撤销 refresh token，登出；由 QA owner `workspace.deactivate`，平台管理员冻结 QA 身份及撤销活跃会话 | 工作区 `disabled` 且 `dataRetained=true`；身份 `suspended`；保留 run ledger | 停用失败时保留令牌撤销证据并上报，不能提交删除申请代替停用 |

**配额的实际门禁**：`apps/api/src/commercial-capacity.ts` 在生产检查店铺容量；有效 V2 权益缺失/不明确会返回 402/409/503，店铺数达到额度返回 `STORE_QUOTA_EXCEEDED`。新商家开通响应为 `pending_billing_verification`，因此“账号创建成功”并不意味着店铺、模型、图片、视频的正向写入可测。`workspace.usage.get` 的 Postgres 实现会确保商业设置行存在并可能重置月度计数；把首次调用视为 QA 工作区自身的初始化读，不在共享工作区预检中调用它。

**留存和恢复**：测试后默认保留 QA 工作区及审计，停用工作区并冻结身份；重新测试时先由有权平台人员激活身份，再由 QA owner 执行 `workspace.activate`，复查权限与配额。停用/恢复都需理由并留审计。数据删除申请是独立的宽限与双审批流程，不纳入自动收尾。

## 安全自动化状态机草案

自动化器默认只有 `preflight` 模式，只执行健康、release、现有账号/工作区只读查询，输出脱敏的 `run-ledger.json` 草案。独立的 `create` 模式仅在调用方明确选择后执行上表前四步；账号开通和首次绑定之间、插件接入和有状态工具之间分别落盘状态，支持中断后核对恢复。状态顺序：`PRECHECKED → ACCOUNT_PROVISIONED → WORKSPACE_BOUND → TOKEN_SCOPED → ENTITLEMENT_CHECKED → TOOL_RUN → TOKEN_REVOKED → WORKSPACE_DISABLED → IDENTITY_SUSPENDED`。每个状态记录请求 ID、时间、release SHA、生成 ID 和响应代码；密钥只保存在受控凭据存储中。

在 `ACCOUNT_PROVISIONED` 或 `WORKSPACE_BOUND` 后超时，自动化器先用管理读接口核对唯一登录/工作区绑定，不重复 POST。每一步执行前校验当前 SHA 与 run ID；若部署切换、令牌作用域异常、余额不足或测试对象不带 QA 标记，直接停止。收费动作设置总预算、单动作上限和并发上限；真实支付、外部发布、删除、迁移、平台规则/模型全局修改均不属于这个自动化器。矩阵中这些工具只能用隔离环境正向测试或生产授权拒绝测试，并明确标成“未在生产正向执行”。

CodeGraph 辅助证据：索引 2,343 文件；追踪 `createMerchantAccount`、`WorkspaceBootstrapRepository.bootstrap`、`handlePasswordAuthRoute`、`handleWorkspaceLifecycleMethod` 以及身份 session revoke 的调用关系。生产路由版本以 `/api/releasez` 的 SHA 为准，不能以当前未部署工作树推断生产行为。
