# 发布任务查询的品牌级访问门禁

## 结论

已完成并落地：`publish.get` 的 MCP 与 REST 查询现在都会沿 `publish_job → task → brand` 关系执行品牌 `viewer` 权限校验。

同一工作区不再意味着可以读取所有品牌的发布任务；未获品牌授权的成员会收到 `BRAND_ACCESS_REQUIRED`。

## 代码落点

- `apps/api/src/server.ts`
  - MCP `publish.get`
  - REST `GET /v1/publish-jobs/:id`
- `apps/api/src/security.e2e.test.ts`
  - 授权品牌可读取
  - 未授权品牌的 MCP 查询被拒绝
  - 未授权品牌的 REST 查询被拒绝

## 验证证据

- `npx vitest run apps/api/src/security.e2e.test.ts --no-file-parallelism`
- 结果：46 个测试通过

## 边界

这只证明本地服务的租户/品牌访问控制闭环。真实 ChatGPT 宿主、生产 OAuth、平台写入、托管数据库与发布门禁仍需在真实运行环境完成验收；因此不改变整体生产 NO-GO 结论。
