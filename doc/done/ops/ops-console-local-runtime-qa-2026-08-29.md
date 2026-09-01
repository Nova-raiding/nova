# 独立 Ops Console 本地运行态 QA

状态：**LOCAL QA COMPLETE / PRODUCTION RELEASE BLOCKED**  
日期：2026-08-29  
目标：`http://127.0.0.1:18082`  
API：同源代理 `http://127.0.0.1:18082/api/mcp`  
明确排除：商家 UI `http://127.0.0.1:18081`  
浏览器：Playwright + Chromium，桌面 `1440×900`、移动 `375×812`

## 结论

独立 Ops Console 的浏览器链路、配置持久化、12 个路由、真实 API 请求和桌面/移动布局均可运行；最终复测中 `/api/mcp` 认证请求为 HTTP 200，console error 与 page error 均为 `0`，桌面与移动 document 均无页面级横向溢出。当前环境仍存在明确的生产发布门禁，因此不能把本地 fixture 通过误判为生产可发布。

健康度：**6.5/10**。

- 运行链路：通过。
- 12 页桌面与移动路由：通过。
- 配置保存/重载：通过。
- 真实数据渲染：通过，但数据为本地 fixture/试运行环境，不等同生产 canary。
- console/page error：通过。
- 移动端 document 无横向溢出：通过；宽表在局部容器内滚动。
- 生产 readiness：失败，受数据生命周期、平台规则、模型成本证据、支付 provider 和 connector/canary 门禁阻断。

## 配置与 API 证据

通过页面真实表单填写 `/api`、工作区 `ws_demo`、操作员 `actor_demo` 和本地 pilot token，然后点击“保存并刷新”。重载后四项配置均保持，Token 仅验证为已设置，报告与截图未记录明文。

- localStorage 真源键：`ops_connection_config_v1`。
- 18082 首页：HTTP 200。
- 无凭据访问 8787 受保护端点：HTTP 401，符合预期。
- 配置后浏览器共观察到 `703` 个 `/api/mcp` HTTP 200 响应，覆盖 `ops.session`、`ops.audit.list`、`ops.members.list`、`ops.users.list`、`ops.support.tickets.list`、`ops.incidents.list`、`ops.marketing.queue`、`ops.feature-flags.list`、`ops.finance.search`、`billing.recharge.list`、`billing.reconciliation`、`workspace.health`、`workspace.metrics`、`rule.list`、`rule.sync.status`、`platform.model.status` 等真实方法。
- 样例 request ID：`req_9072cc1c-e53b-4aa0-b086-0dbf5b6816e1`、`req_ffa2e476-36b7-49e2-86d1-58e0d6e71272`、`req_5088f36f-390e-4b4e-9626-7d79ee9949e2`。
- console error：0；page error：0。
- 路由快速切换时有 11 个 `net::ERR_ABORTED`，均为浏览器取消尚未完成的上一页请求；没有对应 HTTP 5xx 或 console error。

配置证据：[final-config-persisted.png](../../../screenshots/ops-console-local-runtime/final-config-persisted.png)

## 12 页面复测

| 页面 | 路径 | 桌面可见数据 | 375px | 主要运行态结论 |
|---|---|---:|---:|---|
| 总览 | `/ops/overview` | 5 表 / 22 行 | 已复测 | Starter/trialing、6/6 平台、钱包与告警可见；数据生命周期 readiness 阻断 |
| 用户与租户 | `/ops/users` | 2 表 / 30 行 | 已复测 | 数据可见；结果超过 500 条时正确要求增加筛选 |
| 成员与权限 | `/ops/members` | 1 表 / 3 行 | 已复测 | 当前工作区成员可见 |
| 客服与 CRM | `/ops/support` | 1 表 / 2 行 | 已复测 | 本地 fixture 工单可见 |
| 事故中心 | `/ops/incidents` | 1 表 / 2 行 | 已复测 | 演练事故数据可见 |
| 任务与内容 | `/ops/tasks` | 2 表 / 3 行 | 已复测 | 任务/资产治理数据和人工确认警示可见 |
| 租户与店铺 | `/ops/stores` | 4 表 / 19 行 | 已复测 | 六平台店铺与授权状态可见；自动化默认关闭 |
| 平台规则 | `/ops/rules` | 2 表 / 12 行 | 已复测 | 六平台规则均未通过新鲜度门禁 |
| 模型服务 | `/ops/models` | 2 表 / 12 行 | 已复测 | 5/5 能力可见，但成本与供应商证据门禁阻断 |
| 功能开关 | `/ops/feature-flags` | 1 表 / 2 行 | 已复测 | 页面与筛选可用 |
| 账务与退款 | `/ops/finance` | 4 表 / 16 行 | 已复测 | 充值订单可见；支付 provider 和未结算成本阻断；移动溢出 |
| 审计中心 | `/ops/audit` | 1 表 / 25 行 | 已复测 | 明确显示已加载 24 条审计记录 |

桌面截图：

- [总览](../../../screenshots/ops-console-local-runtime/final-desktop-overview.png)、[用户](../../../screenshots/ops-console-local-runtime/final-desktop-users.png)、[成员](../../../screenshots/ops-console-local-runtime/final-desktop-members.png)、[客服](../../../screenshots/ops-console-local-runtime/final-desktop-support.png)
- [事故](../../../screenshots/ops-console-local-runtime/final-desktop-incidents.png)、[任务](../../../screenshots/ops-console-local-runtime/final-desktop-tasks.png)、[店铺](../../../screenshots/ops-console-local-runtime/final-desktop-stores.png)、[规则](../../../screenshots/ops-console-local-runtime/final-desktop-rules.png)
- [模型](../../../screenshots/ops-console-local-runtime/final-desktop-models.png)、[功能开关](../../../screenshots/ops-console-local-runtime/final-desktop-feature-flags.png)、[财务](../../../screenshots/ops-console-local-runtime/final-desktop-finance.png)、[审计](../../../screenshots/ops-console-local-runtime/final-desktop-audit.png)

移动截图：

- [总览](../../../screenshots/ops-console-local-runtime/final-mobile-overview.png)、[用户](../../../screenshots/ops-console-local-runtime/final-mobile-users.png)、[成员](../../../screenshots/ops-console-local-runtime/final-mobile-members.png)、[客服](../../../screenshots/ops-console-local-runtime/final-mobile-support.png)
- [事故](../../../screenshots/ops-console-local-runtime/final-mobile-incidents.png)、[任务](../../../screenshots/ops-console-local-runtime/final-mobile-tasks.png)、[店铺](../../../screenshots/ops-console-local-runtime/final-mobile-stores.png)、[规则](../../../screenshots/ops-console-local-runtime/final-mobile-rules.png)
- [模型](../../../screenshots/ops-console-local-runtime/final-mobile-models.png)、[功能开关](../../../screenshots/ops-console-local-runtime/final-mobile-feature-flags.png)、[财务](../../../screenshots/ops-console-local-runtime/final-mobile-finance.png)、[审计](../../../screenshots/ops-console-local-runtime/final-mobile-audit.png)

## Findings

### OPS-QA-001 · P0 / 外部门禁 · 当前环境不满足生产发布条件

总览和相关页面明确报告以下阻断，不属于浏览器测试误报：

- 数据生命周期：`DATA_RETENTION_DAYS < 90`、隔离资产保留期 `< 7`、Clean 资产保留期 `< 30`、删除申请宽限期不合规，并缺少 `LIFECYCLE_POLICY_REF`、`ALERT_CHANNEL_SECRET_REF` 等证据。
- 平台规则：六个平台均未通过规则新鲜度门禁。
- 模型服务：缺少实际 `cost_cny`、价格快照、计费分组、人民币汇率、供应商额度/成本/数据处理条款审批证据。
- 支付：provider 仍为 fixture，adapter 未完成，checkout/query API 非 HTTPS，且缺 provider API key。
- 平台 connector/readiness：写入被阻断，connector/主副图能力证据未配置，生产 canary 未完成。

证据：[总览 readiness](../../../screenshots/ops-console-local-runtime/final-desktop-overview.png)、[规则](../../../screenshots/ops-console-local-runtime/final-desktop-rules.png)、[模型](../../../screenshots/ops-console-local-runtime/final-desktop-models.png)、[财务](../../../screenshots/ops-console-local-runtime/final-desktop-finance.png)。

### OPS-QA-002 · P1 · 375px 多页面存在内容级横向溢出

所有移动页的 document 宽度均保持 `375/375`，没有 body 级横向滚动；但多个内部内容区显著宽于可视容器，部分内容被裁切或必须在局部容器内横向滚动：

- finance：主内容 `1475/375`，页面 section `1459/343`，财务表格 `1470/293`。
- users：主内容 `458/375`。
- support：表格 `980/293`。
- incidents：表格 `1040/293`。
- tasks：标签栏 `578/247`。
- stores：表格 `728/293`。
- rules：表格 `1120/293`。
- models：表格 `720/293`。
- feature-flags：表格 `900/343`。

finance 的旧桌面“整页 `1789/1440`”现象在本轮配置后未复现：当前 document 为 `1440/1440`，宽表在内部容器中为 `1470/1126`。因此桌面全局溢出已不能复现，但 375px 的内容泄漏仍成立。

证据：[375px finance](../../../screenshots/ops-console-local-runtime/final-mobile-finance.png)、[桌面 finance](../../../screenshots/ops-console-local-runtime/final-desktop-finance.png)。

### OPS-QA-003 · P1 · 移动首屏被连接配置占据，业务内容发现性弱

375px 初始视口几乎全部用于 API 地址、工作区、操作员和 Token 配置；业务页标题与数据需要继续向下访问。对日常运营人员而言，已配置成功后仍长期展示完整连接表单，首屏信息密度和任务可达性较差。

证据：[375px 总览](../../../screenshots/ops-console-local-runtime/final-mobile-overview.png)。

### OPS-QA-004 · P2 / 自动化限制 · 菜单关闭态未获得稳定程序化断言

“打开运营导航”可触发抽屉，截图中可见全部 12 个运营入口；选择“用户与租户”后路由到达 `/ops/users`。首次遍历的程序化菜单计数为 11（文本筛选漏计一个入口），二次关闭态校验在点击后挂起并已停止，因此不把关闭态判为自动化通过；实际打开态和路由跳转有截图/URL 证据。

证据：[移动菜单打开](../../../screenshots/ops-console-local-runtime/final-mobile-menu-open.png)。

## 发布判断

浏览器层 QA 已完成，未修改任何业务源码。Ops Console 独立运行态本身可访问、可配置、可请求真实 API，也没有发现 console/page crash；但 **P0 外部门禁未解除，且 P1 移动横向溢出仍存在，当前不可发布上线**。

发布前至少需要：

1. 清零总览展示的数据生命周期与生产证据阻断。
2. 六平台规则新鲜度、connector 写入能力与生产 canary 全部具备有效证据。
3. 模型成本/计费组与支付 provider 从 fixture 切换为经过 HTTPS、密钥和回调验证的生产配置。
4. 修复或明确验收 375px 下 finance 及其他宽表的局部横向滚动体验，再做一次移动端回归。

## 最终回归补充（2026-08-29）

重建 `local-ops-ui` 镜像并启用 `OPS_CONSOLE_BUILD_MODE=local` 后，以 `/api`、`ws_demo`、`actor_demo` 和本地 pilot token 配置真实页面，重新遍历 12 个路由：

- 桌面 `1440px`：12/12 路由 `document.scrollWidth === clientWidth === 1440`，API 请求为 HTTP 200，无 page/console error。
- 移动 `375px`：12/12 路由 `document.scrollWidth === clientWidth === 375`，无 page/console error；宽表保留在局部滚动容器内，不撑开页面。
- Finance 桌面端此前观察到的页面级 `1789px` 溢出已由内容层 `min-width: 0`、卡片约束和表格局部滚动修复，最终复测不再复现。
- Findings 中 OPS-QA-002 的页面级失败描述属于修复前历史观察；当前仍存在的是宽表的局部滚动，这是运营数据密度下的刻意交互。

## 权威后续复核（2026-08-29）

API/Ops UI Docker 构建成功，容器健康且 `/healthz` 返回 `ok`；本地 pilot token 下 `ops.marketing.queue` 经同源 `/api/mcp` 返回 200。CodeGraph 最新为 `652 files / 9,608 nodes / 40,325 edges`；全量质量门禁通过：`261 passed, 8 skipped` test files、`1,736 passed, 16 skipped` tests，类型检查与 diff 检查通过。生产 OIDC、真实平台 OAuth、支付、对象存储/KMS、canary、容量与恢复 evidence 仍需外部补齐。

### 最新回归（2026-08-29 12:48）

- 全量 `npm test`：263 个测试文件通过、9 个跳过；1746 项通过、17 项跳过。
- `npm run typecheck`、`npm run infra:validate`、`git diff --check` 和 Compose 配置校验通过。
- 自动化扫描的持久化规则评估已限制为每个工作区最多 4 个并发；新镜像重建后连续 5 次 `automation.scan` 均 HTTP 200，API/Ops health 均 HTTP 200，最近 2 分钟无连接池超时或 500。
- 运行时 DB role verifier 已覆盖 identity bindings、commercial/subscription 的特殊 RLS 策略；Compose 数据库实探针通过，tenant role 与 Ops role 权限边界成立。
- CodeGraph 已同步：657 files、9644 nodes、40490 edges，index up to date。

生产发布仍保持 **NO-GO**：本地运行态回归不能替代真实 OIDC、六平台、支付、云容量、签名 evidence、对象存储/KMS、备份恢复和 UI provenance。
