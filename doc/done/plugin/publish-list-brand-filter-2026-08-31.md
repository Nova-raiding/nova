# 发布任务列表的品牌隔离

## 结论

已完成：REST `GET /v1/publish-jobs` 现在先按任务关联品牌过滤，再执行分页，避免同一工作区内的品牌成员看到无权访问的发布任务，也避免 `total` 和 `offset` 泄露隐藏任务数量。

单任务 `GET /v1/publish-jobs/:id` 与 MCP `publish.get` 的品牌查看门禁保持一致。

## 代码与测试

- `apps/api/src/server.ts`
- `apps/api/src/security.e2e.test.ts`

覆盖：

- 已授权品牌任务可读取
- 未授权品牌单任务查询被拒绝
- REST 列表只返回已授权品牌任务
- 过滤后分页的 `total`、`items` 和越界页不泄露隐藏任务

## 验证

- `npx vitest run apps/api/src/security.e2e.test.ts --no-file-parallelism`
- 结果：46/46 通过

## 边界

这是本地 API 权限与分页闭环，不代表真实平台发布或真实 Codex App 宿主已验收。
