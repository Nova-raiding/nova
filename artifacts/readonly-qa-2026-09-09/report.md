# 桌面用户视角只读 QA 审计

日期：2026-09-09（Asia/Shanghai）  
范围：Ops Console、Merchant Studio；知识库、规则、概览、客服、品牌/商品关系、批量生产、财务。  
设备范围：桌面视口 1440×1000；移动端未测试。  
原则：只读导航、筛选、状态查看和空查询；未提交创建、同步、发布、退款、撤销、审批或上传操作。

## 执行证据

- 现有桌面验收：`npm run test:browser:ops` → 9/9 passed；`npm run test:browser:merchant` → 22/22 passed。
- 专项浏览器产物：[`artifacts/readonly-qa-2026-09-09/`](./)
- 页面截图：[`screenshots/`](./screenshots/)
- 页面状态与按钮/输入清单：[`inventory.json`](./inventory.json)、[`ops-target-pages.json`](./ops-target-pages.json)、[`merchant-target-pages.json`](./merchant-target-pages.json)、[`special-pages.json`](./special-pages.json)
- API 健康：`http://127.0.0.1:8787/healthz` 返回 200；两个 UI 首页均返回 200。
- 专项巡检未捕获 console error 或 request failure；Ops 本地 workspace 视角下，平台权限/商业权限的 403 被页面转译为受控的权限或阻断状态。

## 发现

### QA-001（P1）商品关系链未就绪时，“创建任务”仍是可点击主操作

复现：

1. 打开 Merchant Studio → 商品与资产（`/merchant/products`）。
2. 查看任意当前商品卡片。
3. 页面同时显示“标准链待核验”“标准链结果尚未取得”“未绑定素材”，但卡片的“创建任务”按钮仍 `disabled=false`（专项 DOM 清单对前 5 个按钮均确认）。

证据：[`screenshots/merchant-target-02.png`](./screenshots/merchant-target-02.png)；`special-pages.json`/`merchant-target-pages.json` 中对应页面文本与按钮状态。

影响：用户会把可点击理解为可执行，进入后才遇到关系链阻断；批量入口也显示“至少选择 2 个”而非把“标准链未核验”作为明确前置条件，增加误操作和客服成本。

建议：服务端状态未取得、未验证或 canonical/listing 不完整时，禁用创建任务并在按钮旁显示唯一稳定错误码与“打开关系并核验”链接；批量选择器同步显示不可选原因。不要只依赖点击后的服务端拒绝。

### QA-002（P1）知识库素材的安全/解析阻断与“评价素材”可操作状态不一致

复现：

1. 打开 Merchant Studio → 商品与资产 → 知识库（`/merchant/products?section=knowledge`）。
2. 页面存在“安全检查未通过”“等待安全扫描”“内容读取失败/读取失败”等状态。
3. 对应列表仍出现可用的“评价素材”按钮；专项 DOM 清单确认该按钮可用，而“已完成解析”按钮在同一页面被禁用。

证据：[`screenshots/merchant-knowledge-base.png`](./screenshots/merchant-knowledge-base.png)（如需查看当前生成的同屏快照，可使用 `merchant-knowledge-base.png`；页面状态详见 [`special-pages.json`](./special-pages.json)）。

影响：用户无法判断“评价”是安全失败后的人工复核、还是会绕过扫描继续进入知识库；高风险素材的下一步不够单一明确。

建议：按状态拆分动作：扫描中仅允许刷新/查看状态，扫描失败仅允许查看失败证据与重新排队（若有死信证据），未解析不显示评价入口；每个状态展示原因、数据来源、下一步和是否会写入知识库。

### QA-003（P1）真实工作区的关系链阻断数量大，但缺少按错误码/对象批量收敛路径

复现：

1. 以 `ws_demo` 工作区打开 Ops Console → 平台连接（`/ops/stores?workbench=workspace`）。
2. 页面显示“存在未验证关系”，并列出多条“未找到规范商品映射”、`TASK_ACCOUNT_MISMATCH`、`TASK_CANONICAL_SCOPE_MISSING`、`TASK_LISTING_SCOPE_MISSING`、`PUBLISH_*_SCOPE_MISSING` 等阻断。
3. 每条记录主要提供单对象“查看详情/复制”或需要 `platform_ops` 的承接动作；页面没有按错误码筛选、批量 dry-run 结果导出或明确的处理队列摘要。

证据：[`screenshots/ops-stores-workspace-base.png`](./screenshots/ops-stores-workspace-base.png)；[`special-pages.json`](./special-pages.json) 的 `opsStores.base`。

影响：运营人员面对大量重复关系问题时，无法快速区分数据问题、权限问题和可自动修复问题；“品牌/商品/店铺”关系的可追溯性存在，但处置闭环不够可操作。

建议：提供稳定错误码筛选、对象类型/店铺筛选、只读 dry-run 汇总、批量承接前影响预览和每个错误码的唯一处理手册链接；继续保持未验证关系不自动放行发布。

### QA-004（P1，发布阻断）平台规则与商业能力在当前环境没有可上线证据

复现：

1. Ops Console → 平台规则（`/ops/rules?workbench=workspace`）：六个平台均显示“未配置”，原因是签名规则清单地址或验签密钥不完整。
2. Ops Console → 账务与退款（`/ops/finance?workbench=platform`）：显示“商业化开通仍被阻断”，`monthly_custom` 缺少可执行证据，支付查单未就绪，且当前会话缺少 `commercial.access.read`。
3. Merchant Studio → 规则与检查（`/merchant/rules`）：本次真实工作区页面显示 API 已连接但生效规则包为 0，74 项字段检查均阻断；阻断原因明确指向 `platform.mapping.preflight` 与商家确认。

证据：[`screenshots/ops-06.png`](./screenshots/ops-06.png)、[`screenshots/ops-07.png`](./screenshots/ops-07.png)、[`screenshots/merchant-target-05.png`](./screenshots/merchant-target-05.png)。

影响：这是正确的 fail-closed 行为，但也意味着当前环境不能宣称可发布或可上线。Merchant 页面“API 已连接”与“规则包 0/全部阻断”应在页面首屏更强地合并为“不可交付”结论，避免只看到连接成功而误判能力可用。

建议：保留阻断，增加页面级 readiness banner、配置责任人、证据缺口和验证命令/链接；平台规则来源、版本、有效期、批准证据齐全前，所有生成/发布入口统一显示同一阻断原因。

### QA-005（P2）客服入口可发现，但跨页面覆盖与空查询回执仍偏弱

复现：

1. Merchant Studio 首页点击“客服回复”，弹窗能打开并明确说明只展示客户可见回复。
2. 不填写工单/订单 ID，点击“读取客户回复”，页面显示“请输入客服工单 ID、任务 ID 或订单 ID”，没有发起未限定范围的查询。
3. Ops workspace 直接打开 `/ops/support?workbench=workspace` 显示“无权访问客服”，而侧栏默认不展示客服入口；平台连接页说明需通过受控支持入口处理客户问题，但当前角色没有直接进入路径。

证据：[`screenshots/merchant-support-modal.png`](./screenshots/merchant-support-modal.png)、[`screenshots/merchant-support-02.png`](./screenshots/merchant-support-02.png)、[`screenshots/ops-support-base.png`](./screenshots/ops-support-base.png)。

影响：权限控制本身是正确的，但用户无法从“无权访问”页面直接理解申请何种授权、应去哪里提交受控支持请求；商家客服仅按 ID 查询，缺少已授权工单列表/最近回复入口时可操作性较弱。

建议：在 403 页面展示 capability 名称、申请人/入口和脱敏工单号查询说明；商家端保留当前严格的 ID 必填与客户可见过滤，并增加“从任务/订单上下文带入 ID”的只读链接。

### QA-006（P2）概览的计数口径和数据新鲜度需要更显著区分

复现：

1. Merchant Studio 概览显示 7 个已连接店铺、2 家需处理、125 项需处理问题，同时插件钱包显示 20,500 点、生成能力可用但平台发布能力仍因写入门禁阻断。
2. Ops workspace 总览显示钱包余额缺少 `commercial.rate.read`、模型能力暂无数据、存储 64.8 MB 且 23 项一致性问题，并显示生产证据未通过。
3. 页面整体同时使用“已连接真实 API/在线”和“演示授权/fixture/不可发布/暂无数据”，状态文字虽存在，但首屏层级不统一。

证据：[`screenshots/merchant-target-01.png`](./screenshots/merchant-target-01.png)、[`screenshots/ops-01.png`](./screenshots/ops-01.png)。

影响：熟悉系统的运营人员能读懂，但普通商家可能把“API 在线”“钱包可用”理解为“可以生成并发布”；聚合计数也没有统一显示 as-of 时间与来源。

建议：将连接性、数据新鲜度、能力 readiness、发布门禁拆成四个明确状态；每个计数显示来源/更新时间和“未知≠0”文案，阻断项置于动作入口之前。

## 正向观察

- Ops/商家权限边界可见且 fail-closed：缺少 capability 时不伪造财务、平台规则或客服数据。
- Merchant 规则页在 API 成功返回空列表时显示真实空态，没有混入演示规则。
- 发布中心明确区分“平台已受理”和“已生效”，并保留未知状态先对账的提示。
- 客服空查询不会默认查询全量客户内容；客户可见过滤说明清楚。
- 当前桌面浏览器巡检未发现未捕获的前端异常或请求失败。

## 结论

桌面 UI 的基础导航、空态和权限 fail-closed 通过；但当前 `ws_demo` 的关系链、规则包、平台能力证据和商业能力仍不足以支持上线。优先修复 QA-001～QA-004 的可操作性与 readiness 汇总，再以真实平台规则签名、支付 provider、模型中转成本证据和生产 canary 重新执行同一套验收。移动端不在本审计范围。
