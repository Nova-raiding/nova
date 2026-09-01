# 异步任务统一查询投影基线

## 结论

已完成第一阶段查询侧投影：保留原领域字段，同时为同步、生成、发布和任务恢复/时间线增加统一 `workflow` / `workflows` 信息。

投影包含：

- 任务范围：平台、店铺、商品、工作区
- 内部状态与商家状态
- 最近更新时间
- 已知/未知进度
- 唯一下一步动作
- 可恢复范围与是否需要人工对账
- 数据来源与是否为模拟结果

发布状态为 `unknown` 或 `reconciling` 时，投影固定为“发布结果待确认”，`retryable=false`，下一步只能查询或人工对账。

## 接入范围

- MCP：`catalog.sync.get`、`generation.get`、`publish.get`
- MCP：`task.history`、`task.resume`、`task.timeline`
- REST：同步任务详情、发布任务详情
- 插件 bridge：将 `workflow` 转为商家可读 `merchant_status`
- REST 发布任务列表：先按品牌权限过滤，再分页

## 代码与证据

- `apps/api/src/server.ts`
- `apps/api/src/server.e2e.test.ts`
- `apps/api/src/security.e2e.test.ts`
- `apps/plugin/mcp/bridge.mjs`
- `apps/plugin/mcp/bridge.test.ts`
- `.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs`
- `.codex-marketplace/plugins/merchant-marketing/mcp/bridge.test.ts`

## 验证

- API/MCP/bridge 定向回归：4 个测试文件、192 项通过
- 类型检查：通过
- 发布门禁：此前 48 个测试文件通过、1 个跳过；309 项通过、6 项跳过
- CodeGraph 已同步，当前索引 750 files / 11,175 nodes / 46,284 edges

## 尚未完成

这不是第 9 项全部完成声明。真实 Codex App 宿主、真实平台进度/回执、PostgreSQL 异步任务原生分页、附件句柄和真实重启恢复仍需独立证据；相关 todo 保留不迁移。
