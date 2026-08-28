# ChatGPT 浏览器全功能测试报告

测试时间：2026-08-28（Asia/Shanghai）  
测试对象：Merchant Studio `http://127.0.0.1:18081`、Ops Console `http://127.0.0.1:18082`  
方式：Google Chrome + Playwright，从浏览器真实点击、输入、截图并记录 console、请求失败、HTTP 错误和 JSON-RPC 业务错误。

## 结果摘要

- Merchant Studio：8 项浏览器用例覆盖 7 个主入口、全局搜索、移动端菜单和 9 类安全交互；最终 `badResponses=[]`、`requestFailures=[]`、`consoleMessages=[]`。
- Ops Console：5 项浏览器用例覆盖总览、用户与租户、任务与内容、店铺管理、账务与退款、模型失败态及三种移动视口；最终无 HTTP 错误、无 JSON-RPC 业务错误、无非预期请求失败、无 console error。
- 自动回归：111 个测试文件、767 项测试全部通过；Merchant Studio、Ops Console 构建和根 TypeScript 类型检查通过。
- 容器：API、UI、PostgreSQL、Redis 和 5 个 Worker 均为 healthy。
- Git：当前目录是 `main` 的唯一 worktree；代码与中转适配器位于同一工作树，但 Relay Secret 未随 worktree 恢复。

## 浏览器覆盖

| 表面 | 已验证功能 |
|---|---|
| 运营概览 | 健康状态、运营指标、钱包门禁、平台连接、同步恢复、能力证据 |
| 商品与资产 | 商品/平台搜索、待确认筛选、分页、素材状态、素材评价编辑器、视觉强规则面板 |
| 营销任务 | 任务列表、恢复入口可见性、分页和状态展示 |
| 发布中心 | 发布队列、回执和审核前置门禁 |
| 规则与检查 | 规则/品类标签页、平台筛选、关键词筛选、只读证据 |
| 帮助与设置 | 两个面板的打开、内容和关闭 |
| 移动端 | 390×844、375×812、844×390；原生菜单按钮、Escape 焦点返回、表单错误聚焦、页面无横向溢出 |
| Ops Console | 总览、用户与租户、任务/内容、店铺自动化、财务/退款；用户详情与历史、跨租户成员治理、模型状态失败态 |

## 本轮新增并验证的闭环

- 平台身份中心持久化全局身份、认证会话与风险策略；支持封禁/解封、风险转换、会话撤销、revision 冲突和审计。
- 模型账务新增持久结算状态机、批量重试、人工重试/豁免/转人工与对账接口；运行态返回 `completed` 且未结算记录为 0。
- API/Worker 改用 `merchant_app` 非超级用户数据库角色；真实事务 RLS 探针在 workspace A 可见、切换 workspace B 后为 0 行。
- Ops 首屏请求并发限制为 8，限流按 workspace + actor + surface 分桶；复测不再出现 429，交互请求不被后台加载饿死。
- 修复 E2E 共享匿名限流桶污染：纵向套件隔离非目标限流副作用，限流本身继续由独立 security E2E 和分布式 smoke 验证。

## 已发现并修复

### ISSUE-001（高）UI 容器重建 API 后持续 502

Nginx 在启动时缓存了旧 API 容器 IP。改为运行时 DNS 解析 `merchant-api`，API 容器替换后无需重启 UI。修复后平台账号、能力证据和健康接口均恢复 200。

### ISSUE-002（高）首页运营指标 HTTP 500

两条历史内容版本使用旧 schema：模块缺少 `factSourceIds`，视觉 Brief 缺少数组及必填文本。审核读取直接访问 `.length` 导致异常，并使 `workspace.metrics` 整体失败。现在读取时只做兼容归一化、不改写历史快照，并输出 `MISSING_SOURCE`、`VISUAL_BRIEF_INCOMPLETE`、`TECHNICAL_SCHEMA_INVALID`。两条审核和指标接口均恢复 200。

### ISSUE-003（高）本地生产身份门禁在 API 重启后使 UI 401

Compose 仍使用旧 token 数组格式，且 `ws_demo` 没有 owner 成员。现改为带 `actor_id`/roles 的 token grant，并由仅限本地 Compose 的幂等 SQL 初始化 `actor_demo` owner。

### ISSUE-004（中）素材图片原生请求缺少工作区头

`<img src>` 无法附加 `X-Workspace-Id`，导致素材预览 403。现由前端使用带租户头的 authenticated fetch 读取 Blob；对象存储未配置时不再自动发起必失败请求，并明确禁用正文读取。

### ISSUE-005（中）Ops Console 本地运行被 CORS 全面阻断

本地 Vite 直接跨域请求 API，首次测试 52 个 MCP 请求均被浏览器拦截。现提供 `/api` 同源开发代理，保持生产 API 的 CORS 收紧策略。复测四页真实数据正常。

## 当前环境无法完成的外部能力

这些是健康接口明确返回的部署门禁，不计为“已通过”：

- 六个平台官方连接器、真实 OAuth/read/write/canary 尚未配置。
- 模型名称合同存在，但 API 重建后 Relay URL/Key 丢失；宿主和容器均未形成可重复的持久 Secret 配置，成本字段也仍缺失。
- S3 兼容对象存储、生命周期和版本化尚未配置；页面已明确显示不可读取正文。
- 插件钱包余额为 ¥0.00，生成、图片、视频和发布写入被正确阻断。
- 生产写入关闭，因此未执行撤销授权、真实发布、退款、成员变更、商业配置保存等有外部副作用的操作。

要把上述能力也标记为通过，必须提供可测试的沙箱平台账号、模型 Relay、对象存储、测试钱包资金和生产证据配置。

## 证据

- Merchant 数据：[merchant-all-inventory.json](./merchant-all-inventory.json)、[merchant-interactions.json](./merchant-interactions.json)
- Ops 数据：[ops-all-inventory.json](./ops-all-inventory.json)、[ops-inventory.json](./ops-inventory.json)
- 截图：[screenshots/merchant-pages](./screenshots/merchant-pages)、[screenshots/merchant-interactions](./screenshots/merchant-interactions)、[screenshots/ops-pages](./screenshots/ops-pages)
- 500 现场：[issue-002-workspace-metrics-500.png](./screenshots/issue-002-workspace-metrics-500.png)
