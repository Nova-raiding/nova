# 成员治理目标约束服务端投影

## 完成范围

- `ops.members.list` 为每个成员返回服务端计算的 `governance`：`protectedTarget`、`canChangeTarget`、`canDeactivateTarget` 和必要的 `reasonCode`。
- 前端 `memberCapabilities` 只消费 capability projection 与成员治理投影；治理投影缺失时拒绝目标写操作，不根据原始 role 字符串放权。
- mutation 成功后重新读取成员列表，确保新成员对象带有最新服务端治理投影，而不是把没有治理证据的写入结果直接放回列表。
- 服务端原有最后 owner、platform_ops、self-suspension 和 revision/CAS 门禁继续保留。

## 验证证据

- API 成员审计/并发集成与前端成员治理回归：2 个文件、6/6 通过。
- `npm run typecheck`：通过。
- 服务端验证断言覆盖 `ops.members.list` 返回治理投影。

## 边界

可分配角色清单、持久 JIT、真实 OIDC/RLS、decision audit 和生产角色矩阵仍在 [`doc/todo/ops/ops-rbac-acceptance-plan-2026-08-31.md`](../../todo/ops/ops-rbac-acceptance-plan-2026-08-31.md)，不能据此宣称完整 RBAC 或生产上线完成。
