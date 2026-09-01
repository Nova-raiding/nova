# 成员可分配角色服务端投影

## 结论

已完成本地可验证切片：`ops.session` 根据当前真实工作台、授权能力和平台范围返回 `assignable_roles`。成员邀请和角色调整 UI 只消费该投影；投影缺失或为空时关闭变更入口并提示刷新，不再从前端角色字符串推断可分配角色。

## 实现

- API 在 `ops.session` 返回服务端计算的 `assignable_roles`。
- 工作区管理员可分配普通成员角色；只有具备 `workspace.status.update` 的会话可分配 `workspace_owner`；只有 platform workbench 可分配 `platform_ops`。
- Ops Console `MembersSection` 消费 `assignable_roles`，缺失策略 fail-closed；空成员工作区也不会回退到本地推断。
- 保持 `ops.members.list` 数组协议和成员治理 `governance` 投影兼容。

## 验证

- API security dual-workbench session 回归：通过，验证 platform/workspace 角色集合不同。
- Ops Console MembersSection、useMembers、API member audit 回归：9 tests passed。
- TypeScript typecheck、`git diff --check`：通过。
- CodeGraph sync 后 index state `complete`、`pendingRefs=0`、`worktreeMismatch=null`；仍有既有生成型 pending added artifact，未把它误报为源码未索引。

## 边界

这证明本地 API/UI 子链路，不证明真实 OIDC、生产 PostgreSQL/RLS、不可变审计 sink、worker 和发布门禁；整体发布结论继续为 NO-GO。
