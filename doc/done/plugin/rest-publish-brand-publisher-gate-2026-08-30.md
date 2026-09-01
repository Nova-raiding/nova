# REST 发布品牌权限门禁（2026-08-30）

## 完成范围

- REST `POST /v1/publish-jobs` 与 MCP `publish.confirm` 统一执行任务所属品牌的 `publisher` 角色校验。
- 品牌权限校验位于平台能力检查、钱包扣款、任务槽预留、发布任务创建和事件持久化之前。
- `viewer` 成员可以查看任务，但不能创建发布任务；越权请求返回 `BRAND_ACCESS_REQUIRED`。

## 代码证据

- `apps/api/src/server.ts`
- `apps/api/src/security.e2e.test.ts`

## 验证证据

- `security.e2e.test.ts`：46 项通过。
- 回归断言确认越权 REST 请求不会产生发布任务。

## 未宣称事项

该修复只证明本地服务端权限门禁和回归测试成立，不代表真实平台写入、OAuth、回读、撤权、生产宿主及发布 canary 已完成；相关证据仍由 release todo 门禁控制。
