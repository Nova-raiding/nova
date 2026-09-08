# JIT 撤销 403：只读根因分析

状态：**独立 P1，修复待用户确认**。未修改授权策略、API、组件或 MCP 契约；保留原始失败测试。本报告不把“签发成功”替代完整 JIT 生命周期验收。

## 真实运行证据

运行由 owner 的隔离 PostgreSQL 17／Redis／OIDC／API／桌面 UI harness 产生。此轮分析只读既有文件，未连接共享 API／数据库，也未重新发起任何业务请求。

- 运行目录：`artifacts/ops-jit-isolation/2026-09-07T11-48-11.350Z-17e83b9b-3f5f-4d5b-b497-f8e5629806b0/`。
- [脱敏 RPC 记录](../../ops-jit-isolation/2026-09-07T11-48-11.350Z-17e83b9b-3f5f-4d5b-b497-f8e5629806b0/jit-1440x900-192a3eae-b808-49b0-ae48-1c6e900025bc/trace.redacted.json)：1440 × 900，真实 OIDC 登录与权限投影成功；签发、自动刷新、显式刷新均返回 200，持久列表包含同一 grant，精确 `workspace_ids` 正确，authorization revision 从 0 增至 1。
- 同一记录第 284–298 行：真实确认对话框提交 `ops.authorization.grant.revoke`，具有 grant ID、subject ID、grant revision 1、authorization revision 1 和非空原因；响应为 403 `FORBIDDEN`。
- [API 日志](../../ops-jit-isolation/2026-09-07T11-48-11.350Z-17e83b9b-3f5f-4d5b-b497-f8e5629806b0/api.log)第 45 行：`authz_mode=enforce`、`authz_result=deny`、`authz_reason=AUTHZ_OBLIGATION_REQUIRED`、`authz_capability=authorization.grant.manage`。这不是 `AUTHZ_SCOPE_MISMATCH` 或 `AUTHZ_CAPABILITY_MISSING`。
- [撤销失败截图](../../ops-jit-isolation/2026-09-07T11-48-11.350Z-17e83b9b-3f5f-4d5b-b497-f8e5629806b0/jit-1440x900-192a3eae-b808-49b0-ae48-1c6e900025bc/failure-masked.png)已打开检查：作用范围和 grant revision 可见；失败后对话框仍打开，原因输入未清空。UI 没有伪装撤销成功。

## 根因与排除项

1. `packages/contracts/src/authz.ts:417` 将 grant.issue 与 grant.revoke 共用 `reason, revision, approval` 三项义务。
2. `apps/api/src/server.ts:5144–5146` 从真实请求提取已满足义务：`approval` 仅在同时提供 `approved_by` 和 `approved_at` 时满足。
3. 撤销的正式 schema（`packages/contracts/src/mcp.ts:672`）只接受 grant／subject ID、两个 revision 和 reason，以及所有方法共享的可选 `workspace_id`；没有审批字段，也没有 `target_workspace_id`。
4. 组件 `AuthorizationGovernanceSection.tsx:140–146` 正好提交正式撤销契约。策略判定发生在 `server.ts:5443`，缺审批产生 `AUTHZ_OBLIGATION_REQUIRED`，由 `server.ts:5455` 返回 403；`server.ts:11426–11429` 的撤销 handler 未被执行。
5. 平台方法的授权资源由 `server.ts:5155` 固定为 `platform:*`。`server.ts:10075–10082` 的工作区路由回退及日志中的 `ws_demo` 不是本次拒绝的直接原因。平台范围方法也跳过该路由中的租户成员／生命周期门禁（10062–10064、10108、10114）。

不能通过向 UI 请求填入 `target_workspace_id` 或审批字段来修复：`mcp.ts:500` 明确 `additionalProperties:false`，`server.ts:10101–10103` 会先返回 400 参数契约错误。不能生成假审批证据、将 enforce 改为 shadow 或移除其他安全检查。

## 最小修复建议（尚未授权、未实施）

需要产品／安全 owner 明确撤销是否应独立审批。若确认“撤销是立即收回访问，不要求新签发审批”，可仅在 `authz.ts:417` 拆分策略：

- 签发仍保留 `reason, revision, approval`。
- 撤销保留 `platform` 范围、`authorization.grant.manage` 能力、`allow_and_deny` 审计，仅要求 `reason, revision`。

这不是前端格式修复，而是后端安全策略语义变更，超出本次用户已确认的桌面签发表单／隔离测试入口范围，因此保持待确认。若产品要求撤销也要独立审批，则应另行设计一致的正式 schema、UI、持久审批与验收，不能只在客户端添加两个任意字符串。

现有持久仓储仍按 grant ID＋subject ID 精确查询，校验 grant revision 与 authorization revision，并记录撤销者、原因与事件（`packages/persistence/src/authorization-repository.ts:350`）。建议方案不移除这些边界。

## 覆盖缺口与可执行红测设计

- 已有 API 生命周期测试 `apps/api/src/ops-session-grant-contract.test.ts:95–141` 覆盖签发／撤销，但 `beforeEach:61–65` 未显式启用 `MCP_AUTHZ_MODE=enforce`。在没有外部配置时，`server.ts:5029–5031` 默认 shadow，故测试可绕过本次缺失审批义务而返回 200；这类结果不是 enforce 验收。
- 策略红测：在 `packages/contracts/src/authz.test.ts` 使用真实 `getMcpMethodPolicy('ops.authorization.grant.revoke')`，平台 grant.manage 能力＋platform scope＋reason/revision＋enforce，期望按确认后的撤销语义允许。当前策略会稳定返回 `AUTHZ_OBLIGATION_REQUIRED`。同时保留签发缺审批拒绝、撤销缺原因／revision 拒绝、无管理能力／错误工作台／显式 deny 拒绝。此项只有安全语义确认后才应转绿。
- API 红测：现有生命周期套件必须显式 enforce，并提供确实拥有 grant.manage 的身份 fixture（不能仅把 legacy platform_ops 当作 platform_admin）；真实 schema payload 不加审批字段。断言撤销后 authorization revision 递增、有效列表移除、旧访问失效及审计归属，同时验证 stale revision、subject 不匹配、无能力、workspace 工作台拒绝。
- 本地桌面 E2：保留当前 `dogfood/chatgpt-all-functions/ops-jit-isolated.spec.js` 的真实失败作为红证据；签发200＋刷新200＋撤销403不可写成完整通过。用户确认修复后由 owner 在全新隔离 fixture 上复跑 1440 × 900 和 1280 × 800，核对实际 RPC、PG 持久状态、撤销事件、截图／脱敏视频。无需把组件 E1 的 RPC mock 改成“允许”来掩盖真实策略失败；本地签名 IdP 仍不等于外部真实宿主 E3。

分析由桌面 owner 与独立只读子 agent 交叉核对。未新增未经验证的运行成功结论；1280 真实生命周期及 ChatGPT 宿主链路不在本次已通过证据内。
