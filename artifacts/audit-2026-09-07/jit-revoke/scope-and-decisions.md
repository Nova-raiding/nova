# 本轮边界与已确认决策

用户本轮“继续”承接上一轮明确问题：签发继续要求审批；撤销保留管理权限、原因、版本与审计，不再要求二次审批。

- 生产改动仅 `packages/contracts/src/authz.ts`：拆开 issue/revoke，策略版本 `2026-08-31.v2` → `2026-09-07.v1`。管理 capability、platform workbench/scope、数据分类、写操作和 allow_and_deny 审计不变。
- 当前版本联动测试三份改用 `AUTHZ_POLICY_VERSION`；新增一份 enforce 策略/真实签名 HTTP 回归。合计 5 个代码/测试文件；不将原有工作区修改归入本轮。
- 未修改 MCP schema、API handler、repository、迁移、商业准入、模型、前端或桌面 spec。旧 bridge/persistence 的 v2 历史透传 fixtures 保留。
- 版本变化是新决策语义标识，不回写历史审计或 grant，不批量增加 subject revision。已有 worker/context 的版本检查按现有逻辑生效；目标部署尚未发布，不能声称旧任务跨版本已验收。
- 新 HTTP 负例揭示既有 repository 冲突仍由 API 映射为 500 INTERNAL_ERROR。测试只证明真实拒绝和零变更，不将其称为正确 409/404 恢复契约；本轮不扩改错误映射。

## 验证方法

使用 gstack investigate：先独立原子策略红测，再新 HTTP/策略红测，最小生产补丁，Owner 定向与完整安全 check；使用 pm-skills verify-feature：独立 PG17/Redis + 签名 OIDC + 真实 API/构建 UI，真实浏览器操作、截图/视频、只读持久审计。CodeGraph 只读 impact/query 用源码引用补齐，索引不完整不等于无影响。

新测试红测为 33 项中 12 fail / 21 pass / 0 skip；后补的 6 项边界没有称为旧策略红测。最终 Owner 定向 7 文件 / 296 pass / 0 skip，包含新文件 39 项（19 HTTP / 20 策略）。E1 Memory 仓储不是 PG 事务/RLS 或正式 IdP 证据。

## 新发现与暂停边界

Owner 未改断言的原桌面 suite：1440×900 在撤销 HTTP 200、有效列表移除之后，无法找到“最近一次 JIT 已撤销”；1280×800 因 serial 前置失败未执行。原完整生命周期仍 fail，不能因后端修复而标绿。

源码因果链：AuthorizationGovernanceSection 的 receipt 存在组件本地 state；撤销后调用 clearAuthorizationScopedData；该函数清空 opsSession；UsersGovernanceWorkspace 根据能力投影可能卸载授权分区，导致本地回执和导航状态丢失。真实缺失已复现；卸载路径为源码分析，需要后续完整父组件回归锁定。

依据 gstack investigate 的 >5 文件影响范围约束，本轮不扩改前端。下一步需要确认追加修复与父组件真实挂载/桌面回归；仍须清理失效权限和客户数据，不能为保留回执而保留旧权限。该暂停不撤回本轮策略补丁与已完成后端验证。

不连接共享业务库、不停启共享服务、不调用付费模型、不部署或提交；只清理本轮唯一 ID 核验过的可重建合成容器，保留所有成功/失败证据。
