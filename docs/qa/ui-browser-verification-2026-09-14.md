# 桌面 UI 浏览器验收报告（2026-09-14）

## 结论

- 桌面 UI 浏览器健康度：**98/100**。
- 商家端完整 Playwright 套件：**22/22 通过**。
- 运营端真实 OIDC + 隔离 PostgreSQL 套件：**10/10 通过**。
- 运营端组件测试：**92 个测试文件、536 条用例全部通过**。
- 商家端与运营端生产构建均通过，页面实际加载对应 CSS 产物。

此结论只覆盖本次桌面 UI 与浏览器契约，不替代模型中转、真实支付、生产配置、迁移和发布门禁的最终上线批准。

## 验收范围

- 商家登录页、运营概览、知识库折叠二级菜单、商品目录、规则库、营销任务。
- 商品与店铺身份一致性、真实空状态、错误与重试、模型未就绪 fail-closed。
- 发布确认、服务端 500、超时重试与幂等证据。
- 运营控制台所有桌面页面、平台登录、401 重登录、角色边界、用户目录、成员治理、长列表滚动。
- `/ops/users` 一屏布局、账号菜单、CSS 静态资源和浏览器控制台错误。

## 本轮修复

- 将商家浏览器测试改为先展开“知识库”，再进入“商品目录 / 规则库 / 营销任务”，与真实折叠菜单一致。
- 旧 `/merchant/publish` 路径安全回落到知识库；不再加载已经移除的独立发布中心，也不展示伪发布数据。
- 将首次未登录 `/v1/auth/session` 的预期 401 与真正的网络/API 故障区分。
- 用户中心统一使用“已开通用户”，删除重复的账号申请入口和重复消息中心。
- 财务流水使用服务端游标加载更多，不再对当前页做误导性的前端分页。

## 未纳入提交

- “商品原图上传接口尚未配置”的运营空面板没有真实 API，已放入可恢复的 Git stash，未进入构建与提交。
- 全仓 `npm run typecheck` 仍受另一组未提交的 `start-api-launchagent.mjs` 测试缺少类型声明影响；两个 UI 自身的 TypeScript 生产构建均通过。

## 证据命令

```text
npm run test:ops-console
npm run build:ops-console
npm run build:merchant-studio
npm run test:browser:ops
npm run test:browser:merchant
docker compose -f infra/local/docker-compose.yml ps
```
