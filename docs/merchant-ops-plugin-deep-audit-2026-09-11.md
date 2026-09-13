# 商家后台 / 运营后台 / ChatGPT 插件深度审计

日期：2026-09-11  
范围：`demo/merchant-studio`、`apps/ops-console`、`apps/plugin/mcp`、API/MCP 契约及现有测试。

## CodeGraph 覆盖基线

当前图谱包含 1,218 个文件、3,576 个函数、1,699 个方法、1,189 个接口和 893 个类型别名；语言分布为 TypeScript 1,025、TSX 155、JavaScript 34。该基线用于后续增量审计和变更影响分析。

## 证据边界

本轮使用 codeGraph 数据库、源码/测试覆盖分析和本地容器接口探测。当前机器未安装 `agent-browser`，CUA 也没有可接管的 Chrome 标签页，因此视觉与真实点击验收标记为“待桌面浏览器复核”，不以静态代码冒充 UI 通过。

## 功能闭环矩阵

| 域 | 已闭环 | 部分闭环/升级项 | P0/P1 风险 |
|---|---|---|---|
| 商家登录与 workspace | session、workspace scope、401/403 分流、能力弹框 | 无 workspace 的审核/申请绑定仍依赖平台侧动作 | P0：生产 OAuth 与真实租户证据未接入 |
| 商品 | 商品事实主入口、导入/详情/任务状态、权限隔离 | 商品→规则→图片→发布的跨页上下文需浏览器验证 | P1：失败恢复与批量任务可见性 |
| 知识库/规则 | 知识库导航、平台/品类/广告发布三分类、版本与阻断状态 | 规则创建→审核→生效→回滚→租户覆盖的完整 UI/权限闭环需核验 | P1：规则冲突优先级与来源证据 |
| 图片/素材 | 上传、扫描、版权/权益状态、图片候选选择 | 生成→选择→商品绑定→发布回执的真实 MCP 旅程需验证 | P0：扫描器、对象存储/KMS 生产证据 |
| 发布/同步 | 发布门禁、同步任务 API、worker 状态契约 | 失败重试、幂等、外部平台回执需预发验证 | P0：真实 OAuth、回执和 worker 运行证据 |
| 运营后台 | workspace/权限、商业账务、任务、规则和审计组件 | 跨域导航、scope 变更、多标签恢复需桌面验收 | P1：权限拒绝恢复动作一致性 |
| ChatGPT 插件 | MCP 工具契约、严格鉴权、候选图片 UI、错误码与重试 | MCP→后台→worker→审计的端到端真实链路需外部环境 | P0：生产中转与 MCP token 配置 |

## UI/UX Pro Max 评审结论

- 导航：新会话只保留知识库是正确的信息架构；商品、规则、图片、素材不应重复充当知识入口。
- 反馈：认证失效、能力不足、发布/支付/模型门禁必须使用弹框或阻断页；字段错误才使用 inline error。所有弹框需焦点管理、键盘关闭、request ID 和明确下一步。
- 可访问性：所有图标按钮需 aria-label；错误不能只依赖颜色；焦点环不得移除；加载和重试必须有可感知状态。
- 交互：批量任务、同步和发布必须显示进度、幂等状态、失败原因和可恢复动作，避免仅显示“处理中”。
- 信息层级：商品是经营事实主入口；知识库是规则/依据入口；运营后台是租户、授权、账务和审计主入口；插件是 ChatGPT 会话入口，三者不得互相复制导航。
- 视觉验收待补：桌面 1280px/1440px、空状态、错误弹框、规则三 Tab、登录焦点顺序和长列表滚动。

### 代码证据补充

源码已具备 `role="alert"`、`aria-live`、`aria-describedby` 和可聚焦错误区域；但仍存在素材区 `.inline-error`，需确认它是否属于可就地修正的局部错误，若是认证/权限/发布门禁类错误则应统一升级为全局弹框或阻断卡。该项列为 P1 交互复核，不直接删除现有错误反馈。

## 升级优先级

1. P0：补齐真实生产 OAuth、MCP、模型中转、扫描器、对象存储、支付、worker、RLS 和发布回执 evidence，并通过 release gate。
2. P1：把规则治理做成明确的创建/审核/生效/回滚/冲突优先级流程；规则缺来源或版本时强制 blocked。
3. P1：为商品→规则→图片→发布建立统一上下文 ID、跨页面包屑和失败恢复卡。
4. P1：运营后台统一 capability-denied、session-expired、scope-mismatch 的文案、弹框和恢复动作。
5. P2：完成桌面浏览器逐页 dogfood、键盘/读屏/高对比度验收及性能基线。

## 下一轮验收命令

```bash
npm run test:merchant-studio-smoke
npm run test:browser:merchant
npm run test:browser:ops
npm run test:release-gates
npm run test:postgres:isolated
```

其中浏览器测试必须在可接管的桌面浏览器标签页或 Playwright 环境中执行；生产门禁不得使用共享 local/release-sim 数据替代真实配置。

## 运行态补充证据

- 商家后台 production smoke：PASS，UI 200，6 平台入口可识别，读取商品 20 条；写入型 full flow 按生产只读策略跳过。
- 运营后台：`/ops/overview` 返回 HTTP 200；未认证 API 请求返回结构化 401/UNAUTHENTICATED，符合鉴权边界。
- ChatGPT 插件 MCP 桥接核心回归：144/144 通过；覆盖工具清单、严格鉴权、重试/错误恢复、图片候选选择和发布确认契约。
- Ops Console 完整单元回归：87 个测试文件、506 个测试全部通过。
- Merchant Studio 完整前端回归：31 个测试文件、125 个测试全部通过。
- 规则中心增量修复：创建表单新增平台/品类/广告发布分类并传递对应 scope；草稿创建失败时保留未保存状态。修复后 Ops Console JSON 回归为 183/183 套件、506/506 测试通过。
- Playwright 桌面实测：Merchant Studio 全区段巡检与安全交互测试 2/2 通过；Ops Console 两项测试因缺少 `OPS_OIDC_BASE_URL`、本地 OIDC 凭据和隔离 workspace，在认证前置阶段阻断，未进入页面断言。
- Ops OIDC 隔离运行器随后成功准备独立 PostgreSQL/认证环境；运营后台 Playwright 全套 10/10 通过，`playwright.json` 记录 `unexpected: 0`、`skipped: 0`。
- 商家后台完整 Playwright 套件：22/22 通过，`unexpected: 0`、`skipped: 0`、`flaky: 0`；JSON 证据见 `artifacts/merchant-browser-audit/playwright.json`。
