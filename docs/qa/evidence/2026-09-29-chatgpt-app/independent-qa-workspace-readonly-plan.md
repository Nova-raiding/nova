# 独立 QA 商家工作区：生产只读核查（2026-09-29）

本轮没有在生产创建、修改或删除账号、工作区或业务数据，也没有使用 GUI。以下是后续受控实测的操作边界，不是已完成 116 工具生产验收的证明。

## 生产事实

- `GET https://yxsona.com/api/healthz` 返回 `status=ok`、Postgres `ready=true`、`mode=production`；六个平台连接均为 `manual_operations`。健康响应的 `writesEnabled=false` 属平台连接写入状态，不能据此推断工作区引导接口被禁用。
- `GET https://yxsona.com/api/releasez` 返回 `ready=true`，部署 SHA `fd1ad6a7bd122a391350c185798ac07e92795f8c`。下述接口及权限路径已在该 SHA 中核对。
- 生产库只读聚合：工作区总数 1；活跃、尚未绑定工作区的商家密码账号数 0。因此目前没有现成的独立 QA 商家身份/工作区。已知 `devide@sn.com` 是活跃 `platform_admin`；不要复用贵人鸟工作区做有状态全量测试。
- 生产 API 容器配置为 `OPS_AUTH_MODE=password`、`MCP_INTEGRATION_MODE=local_stdio`；`ALLOW_MERCHANT_SELF_REGISTRATION` 未设置。公开 `/v1/auth/register` 因而关闭（`AUTH_PUBLIC_REGISTRATION_DISABLED`）。

## 最少受控创建流程（尚未执行）

1. 授权平台账号在平台工作台调用 `POST /v1/ops/merchant-accounts`，传独占 QA 邮箱和强密码、`enterprise_name`/`contact_name`、`workspace_ids: []`、`bootstrap_workspace: true`、明确 `reason`。接口要求平台运营/管理员身份；成功时创建活跃商家身份和零工作区账号，返回 201、`next_action=workspace_bootstrap`。此步不会自动授予付费权益，响应仍为 `vip_access=pending_billing_verification`。
2. QA 商家用该身份登录 `POST /v1/auth/login`，持会话 Cookie、正确同源 `Origin` 调用 `POST /v1/auth/workspace-bootstrap`，传 QA 标记的 `display_name`。仅活跃、零工作区且风控通过的商家可用；成功返回随机 `ws_<24 hex>`、活跃工作区与 owner 绑定。重复引导返回 409，跨源返回 403。
3. 该商家通过 `/v1/auth/mcp-token` 或本地插件安装器取得短期工作区 MCP 令牌，并按项目的本地 stdio 链路接入 ChatGPT App。先核验令牌指向新工作区、`workspace.health`/会话身份以及跨工作区拒绝，再开始有状态工具测试。严格鉴权时 MCP `workspace.bootstrap` 只复用已有绑定，不能直接创建生产工作区。

接口与权限依据：`apps/api/src/server.ts` 的商家开通路由，`apps/api/src/http-password-auth-routes.ts` 的首次工作区路由，`apps/api/src/mcp-workspace-setup-handlers.ts` 的严格鉴权分支；隔离链路测试见 `apps/api/src/mcp-oauth-identity.e2e.test.ts`。

## 标记、隔离和收尾边界

- 每轮生成唯一 `QA-DO-NOT-PUBLISH-YYYYMMDD-<run-id>`；写入企业名、工作区显示名、操作原因及所有测试商品/素材/交付物名称。工作区 ID 由服务端随机生成，不能靠 `ws_qa_` 前缀辨识。记录登录邮箱、账号/身份/工作区 ID、审计 ID、测试时间、令牌到期时间和产物清单；密码与令牌不写进证据。
- 使用自有测试邮箱、测试素材及独立授权的测试店铺/配额。不要使用贵人鸟数据、真实顾客、真实支付或发布目标。创建工作区只解决租户隔离，不能自动打开商业权益、平台连接、模型额度或全部 116 工具；这些能力需各自核验门禁。
- 结束时先导出所需证据，撤销本地插件令牌/会话；QA owner 可调用 `workspace.deactivate`，返回 `dataRetained=true`，以后可 `workspace.activate` 恢复。平台授权账号可在平台工作台对 QA 身份调用 `ops.user.suspend(scope=identity)` 和 `ops.user.session.revoke`；不能自停用，需按 revision、幂等键、原因执行并保留审计。`platform_admin` 具 `identity.update` 与 `identity.session.revoke` 能力。
- 工作区停用是保留数据的归档边界，**不是删除**。`workspace.data.delete.request` 需要至少 7 天宽限期和后续双人审批；不能把它当作常规 QA 清理。生产数据删除需另行审查范围与恢复方案。

生命周期/权限依据：`apps/api/src/mcp-workspace-lifecycle-handlers.ts`、`apps/api/src/server.ts` 的身份变更处理、`packages/contracts/src/authz.ts`；隔离测试见 `apps/api/src/workspace-status-authz.e2e.test.ts` 与 `apps/api/src/identity-mutation-role-contract.e2e.test.ts`。
