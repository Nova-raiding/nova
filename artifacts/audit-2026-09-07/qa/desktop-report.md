# 运营后台桌面黑盒 QA（2026-09-07）

状态：DONE_WITH_CONCERNS。方法：gstack qa-only；仅通过浏览器观测，不读取源码、不修改业务状态。截图采集窗口为 2026-09-07 16:28:30–16:34:31（Asia/Shanghai，以文件时间核对）；后续只读汇总并按 owner 指令收尾。

访问 8 个唯一页面路径，产生并逐一打开检查 13 张截图。确认 1 项 medium 查询交互问题、1 项工作台切换 UX 观察。另有 1 次瞬时 MCP 502，重试恢复，未将其计为已确认缺陷。未执行完整业务写流程，因此不据此生成全系统健康分或上线通过结论。

## 范围与环境

- 目标：`http://127.0.0.1:18082`；独立浏览器 tab 2。
- 桌面视口：1440 × 900、1280 × 800；不包含手机和平板。
- 会话：浏览器自动获得本机安全会话；UI 显示服务端验证的 `actor_demo`、`ws_demo`。没有复制或读取 Token。
- 当前授权仅验证本机已有身份；不代表 OIDC 登录、多租户隔离或 ChatGPT 宿主链路通过。
- 禁止范围：充值、发布、创建用户、修改配置、删除数据；这些操作只观察控件和权限提示。
- Framework：浏览器显示 React/Ant Design 静态资源和客户端导航；未读取源码。

## 已执行

| 页面 | 检查与结果 | 证据 |
| --- | --- | --- |
| `/` 商家总览 | 正常加载；真实平台接入 0/6、fixture 发布阻断、缺失生产证据均明确展示；`commercial.rate.read` 缺失时明确未请求商业报告；console 无错误 | [总览](screenshots/ops-initial-1440.png) |
| `/ops/members` | 当前角色 operator；只有成员查看权限；邀请表单和提交按钮 disabled；console 无错误 | [成员页](screenshots/ops-members-1440.png) |
| `/ops/tasks` | 已有素材和阻断原因可见；任务 ID 未命中筛选、重试、清除筛选、交付证据 Tab；清除筛选后错误消失；未执行治理动作 | [筛选前](screenshots/ops-tasks-before-filter-1440.png)、DESKTOP-001 |
| `/ops/knowledge` | 工作区规则默认页、资产权益 Tab；键盘 ArrowRight 可将焦点移到品牌偏好 Tab，未执行该 Tab 的 Enter 激活；录入、批准和权益确认未提交 | [知识库](screenshots/ops-knowledge-1440.png) |
| `/ops/stores` | 平台连接汇总能加载六平台登记店铺/官方 API/连接状态；不显示客户商品详情；未扫描、创建批次或保存策略 | [平台连接](screenshots/ops-stores-platform-1440.png)、DESKTOP-002 |
| `/ops/rules` | 六平台规则新鲜度阻断和 manual:// 非官方规则提示明确；创建规则草稿字段和按钮 disabled；1280 桌面无文档级横向溢出（scrollWidth=1280） | [平台规则](screenshots/ops-rules-1280.png) |
| `/ops/finance` | 瞬时 502 时权限 gate 关闭；点击“重试权限验证”后恢复；创意点账本 Tab 正常导航到 view=ledger；缺少 commercial.point.read / commercial.access.read 及目标 workspace 时明确空状态、提交禁用 | [502 阻断](screenshots/ops-billing-1280.png)、[恢复及账本权限](screenshots/ops-billing-recovered-1280.png) |
| `/ops/storage` | 展示脱敏 workspace 汇总列表；无当前 workspace 时容量空状态明确；1280 桌面无文档级横向溢出（scrollWidth=1280） | [存储](screenshots/ops-storage-1280.png) |

## 发现

### DESKTOP-001：不存在的任务 ID 筛选变成全页数据加载错误

- 严重度：medium；分类：UX / functional。
- URL：`http://127.0.0.1:18082/ops/tasks`，商家工作区。
- 操作：在“营销队列筛选”的“任务 ID”输入 `audit-no-such-task-20260907`，点击“应用筛选”；再点击错误面板“重试”。
- 实际：`POST /api/mcp` 返回 404，UI 显示“部分运营数据未刷新”“无法加载运营数据”，具体为 `ops.marketing.queue`、`任务不存在`；保留旧的任务队列（50）和素材列表。重试仍然 404。
- 预期：不存在的筛选值应明确显示该任务没有匹配结果或就地查询反馈，用户不应被引导“先修复数据读取问题”。该期望来自控件“筛选”的用户语义，并非否定 API 的资源不存在 / fail-closed 行为。
- 影响：正常查询未命中被表现为运营故障，旧结果仍存在，需要用户清除筛选恢复；清除后已验证错误消失。当前有明确 stale 提示，未发现静默伪装成功。
- Console：`Failed to load resource: the server responded with a status of 404 (Not Found)`，首次 08:30:13.391Z，重试 08:30:42.352Z。
- 证据：[操作前](screenshots/ops-tasks-before-filter-1440.png)、[查询结果](screenshots/issue-001-no-such-task-result.png)、[重试结果](screenshots/issue-001-retry-result.png)。

正常的权限禁用、fixture 阻断及生产证据缺失不归类为 UI 缺陷。

### DESKTOP-002：侧栏导航自动改变工作台（UX 观察）

- 状态：已复现的产品 UX 观察，暂不单独计为缺陷；是否符合设计需结合工作台规范判断，不能据此宣称越权。
- 起始 URL：`http://127.0.0.1:18082/ops/knowledge?workbench=workspace`；UI 显示 `ws_demo`、“商家工作区”已选中。
- 操作：点击左侧“平台连接”；并未点击工作台选择器。浏览器后退再点击同一侧栏按钮，第二次仍复现。
- 实际：跳转到 `/ops/stores?workbench=platform`；工作台变为“平台控制台”、平台级“全平台”、工作区“未进入工作区”，当前身份显示“平台运营”。
- 预期：当前工作台内的普通导航应保留已选工作台与工作区；如果目的地需要转换操作范围，应通过明确的工作台切换流程表达。
- 影响：用户点击商家导航会改变后续操作范围。当前身份已有平台角色、UI 仍显示服务端验证，本检查不能据此认定越权。
- Network/Console：导航及随后的可见加载正常；无 console error。
- 证据：[切换前](screenshots/issue-002-before-workspace-nav.png)、[第二次导航结果](screenshots/issue-002-result-platform-nav.png)、[第一次完成加载的平台页](screenshots/ops-stores-platform-1440.png)。
- 补充：平台连接页点“平台规则”自动回到 workspace；workspace 平台规则页点“账务与退款”又切到 platform。owner 独立源码复核回报：域到工作台存在固定映射；本黑盒检查未读取源码。

## Console 与网络摘要

| 事件 | 次数 | 结果 |
| --- | --- | --- |
| 不存在任务 ID 的 MCP 请求 404 | 2 | 首次筛选和一次重试均可复现，见 DESKTOP-001 |
| 切到财务页时 MCP 请求 502 | 1 | 08:33:53.722Z；UI 撤销未验证权限和业务导航；一次显式重试恢复，原因未定位 |
| 其余已执行导航和 Tab 操作 | 未观察到额外 console error | 每次交互后检查；没有观察到 uncaught JavaScript 异常 |

浏览器后退从平台连接恢复到知识库，地址被规范化为 `workbench=workspace`。财务账本导航后进入存储页时 `view=ledger` 参数仍保留，但未观察到存储页行为错误，故不列为缺陷。

502 的 owner 核实结果：当时未重启 local-api/ops-ui；同期独立 OIDC 测试使用其他监听端口。此处仅保留真实现象，不推断 502 的原因。

## 局限

本报告不会将本地桌面浏览器通过写为真实 ChatGPT 插件上线通过。不执行产生费用、真实发布或持久化业务变更的完整流程。

未覆盖：用户与租户、客服 CRM、事故中心、模型服务、功能开关、审计中心的独立页；完整登录和会话失效；不同身份/租户；交付物下载；账务、模型、worker 及平台发布的端到端写流程。未进行性能基准或完整无障碍审计；键盘仅做局部焦点检查。未使用 Merchant Studio 辅助页面，也未验证 ChatGPT 宿主。

本轮没有修改源文件或业务数据，没有进行充值、发布、创建用户、修改配置、扫描、删除、治理动作或审批。保留独立 tab 2 和全部证据文件。后续回归应覆盖：任务 ID 未命中/权限不足/真实读取失败三类反馈；每个侧栏入口的工作台范围保持或明确切换；MCP 502 后权限 gate 和重试恢复。

## 后续隔离验收补充（独立于上述黑盒轮次）

owner 后续在全隔离 PG17／Redis／OIDC 桌面 harness 获得 JIT 签发与刷新 200、撤销 403 的真实证据。只读根因分析记录为独立 P1，后端撤销审批策略修复尚待用户确认：[JIT 撤销 403 分析与覆盖建议](jit-revoke-readonly-diagnosis.md)。不计入本报告原先的 8 页／13 张截图，也不将其视为完整 JIT 或 ChatGPT 宿主验收通过。
