# 标准商品与店铺刊登桌面证据展示

## 完成范围

- Merchant Studio 商品行展示服务端返回的标准链状态、读取模式、规范商品 ID、店铺刊登 ID和刊登数量。
- `verified` 之外的状态继续阻断任务组选择、任务创建和图片生成等后续动作；页面不以事实已确认替代标准链验证。
- Ops Console 继续展示 workspace-scoped consistency 报告、状态筛选、阻断原因、关系引用、证据 revision、服务端 `nextAction` 和权限提示。

## 验证证据

- Merchant Studio 定向回归：3 个测试文件、8/8 通过。
- `npm run typecheck`：通过。
- `npm run build:merchant-studio`：通过。
- CodeGraph：索引状态 `complete`，`pendingRefs=0`，`worktreeMismatch=null`；本轮同步 826 files、11,710 nodes、43,679 edges。

## 边界

本文仅归档桌面展示与 fail-closed 入口这一已完成子能力，不代表标准商品/刊登修复主链整体上线。

- `brand-unit.product.create`、`brand-unit.listing.create` 仍由服务端权限、交互确认和显式输入控制，当前桌面端不绕过授权执行。
- 真实 OIDC、PostgreSQL/RLS、多副本并发、真实平台 API、正式 ChatGPT Host 和生产 worker 门禁仍未闭合。
- 总体产品文档继续保留在 [`doc/todo/brand/brand-management-prd.md`](../../todo/brand/brand-management-prd.md)，canonical UI 审计继续为 `TODO / UI NO-GO`。
