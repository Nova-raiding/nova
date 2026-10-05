# 平台支持工单桌面 UI 交接证据

日期：2026-10-05。共享 main，未提交、未建立分支、未发生产请求。范围仅平台支持 UI、对应客户端、支持域导航/权限映射和 scoped 测试；没有修改商家接口或账务业务。

## 实现与真实契约

`/ops/support` 已注册真实 `SupportRoute`，侧栏“客服工作台”仅在 server-projected `support.ticket.read` 允许时显示；不会根据角色标签或本地 has-all-Ops 推断许可。平台模式渲染 `PlatformSupportWorkspace`，不调用旧 workspace-scoped support hook；租户模式保留旧工作流。平台模式读取实际授权企业目录 `ops.workspaces.list`（`workspace.directory.read`），明确选择目标 Workspace，然后使用：

- `ops.support.platform.tickets.list`：`target_workspace_id`、真实20条分页、原 `{id,createdAt}` cursor_json。
- `ops.support.platform.ticket.get`：明确企业和原 ticket_id，显示实际客户/企业、无订单或任务、描述、完整事件历史。
- `ops.support.platform.ticket.comment`：真实 `support.ticket.update` 能力；原企业、工单、正文、visibility、expected_revision、稳定 idempotency_key。确认前预览客户可见/内部范围与正文。

使用既有平台 RPC transport；不伪造或修改 x-workspace-id/workbench/actor/role 头。客户端拒绝混企业行、aggregate 行、外工单事件以及与原键不符的写入响应。目录或读取能力缺失显示明确阻断；尚未读取不能显示为零工单。工单无需订单或任务即可处理，客户身份使用实际工单 customerId，不在 UI 改写。

## 错误与原意图恢复

网络/超时/5xx/无法证明原回复响应时保留原企业、原工单、运营 actor、原 revision、原 visibility、原 key 和 SHA-256 正文摘要。正文只冻结在内存，不写 sessionStorage；不保存密码、Token 或完整银行凭证。结果未知时不能生成另一条回复；可调用 platform.get，严格核对原 event.idempotencyKey、真实 actorId、scope、eventType、visibility、正文摘要（以及服务端提供时的 expectedRevision）。null、其他 actor/范围/正文/可见性或未找到原事件都不能当作成功。当前会话可以用完全相同正文、可见范围、revision 和原 key 重试；刷新失去正文后仅查询，不编造正文重发。服务端脱敏导致正文摘要不一致时保持待核实，不假称恢复成功。

企业切换/页面卸载会使旧响应无效；真实事件回复后按原 sequence 排序，不把重放事件伪装成新回复。已知非5xx失败要求刷新版本重新预览；独立能力控制读取与回复。

## 已执行检查

```sh
npx tsc -p apps/ops-console/tsconfig.json --noEmit
npx vitest run apps/ops-console/src/api/platformSupportClient.test.ts apps/ops-console/src/components/support/PlatformSupportWorkspace.test.tsx apps/ops-console/src/pages/SupportPage.test.tsx apps/ops-console/src/navigation/routes/SupportRoute.test.tsx apps/ops-console/src/navigation/opsNavigation.test.ts apps/ops-console/src/components/OpsSidebar.test.tsx tests/ops-domain-map-coherence.test.ts apps/ops-console/src/authz/authorization.test.ts
```

Ops scoped TypeScript exit 0；8 文件122测试通过；scoped diff whitespace check 无错误。覆盖 platform exact 请求字段、无订单工单、跨企业 fail closed、原键/正文/actor/可见性恢复、真实路由、角色不可推断权限、侧栏及13域映射一致。release-metadata 的实际13域更新及 metadata validate 由契约 owner 执行。

## 交给 QA 的实际桌面链路（仍待运行）

以真实平台会话进入 `/ops/support` → 读取授权企业目录 → 明确选择商家登记工单的 Workspace → 读取工单 → 查看无订单/任务工单及不可变客户 ID → 预览并记录客户可见回复 → 商家原工单查询确认可见 → 记录内部备注并确认商家查询不泄露该备注。另验证其他企业不可读取、缺失 write cap 禁用回复、网络结果未知查询原键和同键重试不产生第二事件。

本文件记录源码/类型/单元与 SSR 证据，不宣称真实 API/RLS、平台 cookie、桌面浏览器、容器或生产上线已验收。用户数据、付款和生产均未在本子任务执行。
