# 商业运营页面规格

状态：实施规格；生产仍以 PRD 上线门禁为准  
适用页面：`apps/ops-console` 的“账务与商业配置”域  
权威需求：`doc/todo/product/package-entitlements-and-services-prd-2026-08-31.md` §15  
上位设计系统：`design-system/merchant-ops-console/MASTER.md`

本文件只定义商业运营页面的布局、组件、状态、权限、错误与无障碍表现。价格、点数、有效期、资格、抵扣、退款和服务政策一律来自服务端版本化契约；前端不得补常量、推定待决策条款或把人民币钱包、任务额度、通用 add-on 当作创意点事实。

## 1. 页面边界

- 仅实现 1440×900 桌面运营工作台；不设计或验收手机、平板、触控导航、汉堡菜单和营销落地页。
- 使用现有 React、Ant Design、根 `ConfigProvider` 与 `MASTER.md` token，不在业务组件中新增颜色、圆角或阴影常量。
- 保留 224px 左侧任务导航与 56px 身份/范围上下文条。页面不能覆盖、复制或弱化当前身份、workbench、workspace scope、策略版本和受控授权状态。
- 页面只消费服务端商业目录、权益快照、创意点账本、`CommercialAccessDecision`、支付、费率、服务履约和 capability projection；API 是最终权限门。
- 当前顶级域仍为“账务与商业配置”。不得为本需求新增顶级导航域。
- 业务主表使用平面 1px border 数据容器。禁止 Card 套 Tabs 套 Table、营销式 KPI、渐变英雄区、大页头表单、装饰图表和滚动 reveal。
- Drawer/Modal 才使用 elevation；动效仅用于 Drawer、Modal、Collapse 和加载反馈，150–200ms，并服从 `prefers-reduced-motion`。

## 2. 固定页面框架

```text
┌─ Sidebar 224 ─┬──────────────────── 工作区 ────────────────────┐
│ 账务与商业配置 │ 身份 / workbench / workspace / 策略 / 临时授权 56 │
│               ├───────────────────────────────────────────────┤
│               │ 面包屑 · H1 账务与商业配置 · AccessLevelTag     │
│               │ 说明 · 最近核验时间 · 1 个页面级主动作           │
│               ├───────────────────────────────────────────────┤
│               │ CommercialAccessStatusBar                     │
│               ├───────────────────────────────────────────────┤
│               │ 任务 Tabs（可深链）                            │
│               ├───────────────────────────────────────────────┤
│               │ FilterBar                                     │
│               ├───────────────────────────────────────────────┤
│               │ 主 Table / 工作队列                            │
│               │                              Detail Drawer →  │
└───────────────┴───────────────────────────────────────────────┘
```

页面内容区在 1440px 视口使用 24px 水平 padding；主表应获得除 Sidebar 和 Drawer 外的全部可用宽度，不设置营销型窄 `max-width`。

页面只保留一个 H1。进入页面或切换域后焦点移到 H1；切换 Tab 后焦点移到该视图标题或错误摘要，而不是 Tab 内第一个危险动作。

## 3. 信息架构与深链

任务 Tabs 的顺序和职责固定如下：

1. `阻断与恢复`：默认视图；处理零点、不足、unknown、stale 和支付后未恢复。
2. `Workspace 权益`：查看套餐/合同权益快照及其版本，不复制编辑商业目录。
3. `创意点账本`：查看可重建余额与 grant/reserve/settle/release/refund/reverse/expire/adjust 明细。
4. `商业目录`：查看和治理接入服务、月套餐、点数充值包及非公开测试 SKU。
5. `订单与支付`：串联 SKU、payment、grant、access revision、抵扣、退款与对账状态。
6. `创意点费率`：治理草稿费率版本和审批记录；未批准时保持阻断。
7. `服务履约`：记录培训、1V1、复盘、工时及履约证据。

URL 必须保存并恢复：

- `view`：当前任务 Tab。
- `workspace`：当前授权范围内的目标 Workspace。
- 当前视图的筛选、分页和排序。
- `record`：当前 Drawer 的对象标识。

浏览器前进、后退和刷新必须恢复相同视图。目标记录不存在、已越权或 scope 已变化时关闭 Drawer，在数据区显示明确错误，不得保留旧租户数据。

`private SKU` 无读取 capability 时，入口、子 Tab、筛选项、搜索提示、行和数量全部不渲染；深链访问由统一 403 页面处理。

## 4. 首屏层级

### 4.1 PageHeader

- 面包屑：`运营后台 / 账务与商业配置 / 当前视图`。
- H1：`账务与商业配置`。
- 描述：一句说明当前视图的任务和资源范围，不重复商业卖点。
- `AccessLevelTag`：显示平台、Workspace、受控支持或只读；状态使用图标和文字。
- 页面级最多一个主动作。动作由当前视图和服务端 `nextAction` 决定，不由角色名推算。

### 4.2 CommercialAccessStatusBar

紧凑单行或两行信息条展示：

- `balance_state` 与稳定状态 code。
- `available_points`、`reserved_points`；unknown 时显示“未知”，绝不显示 0。
- 最早到期时间；服务端未返回则显示“未返回”，不推定有效期。
- `access_revision`、目录/费率版本、最后核验时间。
- 服务端许可的 `nextAction`。

状态条不显示人民币钱包为准入条件，不显示任务次数。金额只出现在订单/支付证据中。

### 4.3 可行动汇总

首屏仅允许四个紧凑、可过滤的工作量摘要：

- 阻断。
- unknown。
- paid-but-ungranted。
- 待履约。

摘要是当前授权范围和当前筛选的入口，不是营销 KPI。无对应读取权限时不显示数量，避免泄露敏感对象存在性。

## 5. 视图规格

### 5.1 阻断与恢复（默认）

`AccessBlockQueueTable` 列：状态、Workspace、原因 code、available/quoted 点数、decision revision、发生时间、最后核验、next action、操作。

- Workspace 固定左侧；操作固定右侧；服务端分页、筛选和排序。
- 默认显示未恢复记录；可筛选 EXHAUSTED、INSUFFICIENT、UNAVAILABLE、STALE、RATE_CARD_UNAVAILABLE 和 paid-but-ungranted。
- 行动作仅为“查看与恢复”，打开 720px `AccessRecoveryDrawer`。

`AccessRecoveryDrawer` 顺序：

1. 当前 decision 与错误 code。
2. 点数来源、到期和 reservation 摘要。
3. 相关套餐/订单/payment/grant/access revision 证据。
4. 服务端许可的恢复动作。
5. 审计、request ID、trace ID、revision。

恢复闭环固定为：

`阻断记录 → Workspace decision → 点数来源/到期 → 支付、grant 或对账 → 重取 access revision → RECOVERED`

支付成功不能单独显示为“已恢复”。只有 grant 到账且新 `CommercialAccessDecision` 通过后，才显示 RECOVERED 和新 revision。授权 Ops 恢复动作属于精确白名单，不因目标 Workspace 余额为 0 而被 UI 禁用；它仍需独立 capability、reason、expected revision、idempotency key 和审计证据。

### 5.2 Workspace 权益

`WorkspaceEntitlementTable` 列：Workspace、套餐/合同快照版本、状态、品牌上限、店铺上限、存储标签、服务权益、点数账期、更新时间、详情。

- 权益来自订单/合同快照，表格不能提供直接修改套餐价格或额度的输入框。
- 定制套餐的订单具体值按服务端标签和单位原样展示。
- `50g` 在业务确认单位前只显示服务端原始标签，前端不得换算 GB/GiB。
- Drawer 使用 `Descriptions` 展示只读快照、来源订单、版本、有效期和审计证据。

### 5.3 创意点账本

`CreativePointsLedgerTable` 列：时间、事件类型、点数增减、事件后投影、来源、账期/到期、operation、actor、幂等键、状态、详情。

- 数字右对齐并使用 tabular numbers；grant/reserve/settle/release/refund/reverse/expire/adjust 均用文字和图标标识。
- `LedgerEntryDrawer` 关联 Workspace、来源订单、目录/费率版本、任务、provider request/usage/cost、operation ID、request/trace、actor 和审计证据。
- 余额或投影不可判定时显示 UNAVAILABLE/unknown，禁止用空表或 0 代替。
- 调账不做行内编辑。授权操作通过确认 Modal，显示对象、影响、reason、expected revision 和幂等信息；商家和无调账 capability 的客服不渲染该动作。

### 5.4 商业目录

`CommercialCatalogTable` 按服务端返回的 SKU 类型筛选，不在前端复制生产套餐常量。列：SKU code、名称、类型、可见性、版本、价格/周期、权益摘要、审批/生效状态、有效窗口、操作。

详情 Drawer 分区展示：

- 一次性接入服务及其连续赠点 schedule。
- 月度套餐权益。
- 点数充值包。
- 非公开测试 SKU。
- unresolved 字段与阻断原因。

目录治理使用“查看版本 → 创建/编辑草稿 → 校验 → 提交审批/发布”的明确阶段，不提供表格内直接启用 Switch。草稿/发布必须使用不同 capability；未批准或未决字段不得出现生产启用动作。

`PrivateTrialSkuPanel` 必须遵守：

- 无读取 capability：完全隐藏，不泄露数量、筛选项或搜索提示。
- 有读取无写 capability：只读 Table/Descriptions，不渲染 disabled Form。
- 有分配 capability：先显示服务端资格判定，再允许创建订单。
- 重复购买资格、客户身份口径或抵扣规则未确认时，服务端返回阻断，UI 显示原因，不推定规则。

专项增值服务只可按服务端状态显示“未产品化/不可销售”，不得创建可售 SKU 或扩展新流程。

### 5.5 订单与支付

`RechargeOrderTable` 及订单列表必须串联：

`SKU → order snapshot → payment state → grant state → access revision`

列至少包含：订单号、Workspace、SKU/版本、购买点数、金额/币种、渠道、payment 状态、grant 状态、access revision、创建/支付时间、操作。

- paid-but-ungranted 使用阻断状态，提供授权查单/对账入口，不宣告到账解锁。
- 查单、对账、退款、导出分别消费独立 capability。
- 支付 URL 只接受安全协议并有明确可访问名称；外链行为在文本中说明。
- 重复回调展示既有幂等结果，不显示第二次 grant。
- 抵扣和退款规则未批准时只显示服务端状态与阻断原因，不生成前端计算结果。

### 5.6 创意点费率

`CreativePointRateTable` 列：action code、动作标签、单位、点数规则、版本、审批状态、生效窗口、阻断原因、操作。

- 费率只从服务端版本化 rate card 读取。
- 草稿和批准使用独立 capability；批准使用 `RateApprovalModal`，显示完整变更、影响、reason、expected revision 与审计要求。
- `90 点起` 的变量公式或文本费率未确认时显示 RATE_CARD_UNAVAILABLE；不得提供生产确认按钮。
- UI 不以人民币模型倍率代替创意点费率。

### 5.7 服务履约

`ServiceFulfillmentTable` 列：Workspace、服务类型、账期/订单、分配量、已用量、排期、状态、负责人、证据、操作。

- 只记录 PRD 已列的培训、1V1、复盘、响应承诺和工时证据。
- 不实现预约取消、爽约、取整、保修、SLA 算法或其他未批准政策。
- 写入需要独立服务履约 capability、reason、expected revision 和审计。

## 6. 统一状态与错误

| 状态 | 必须展示 | 可用恢复 | 禁止表现 |
|---|---|---|---|
| EXHAUSTED | available 明确为 0、revision、发生时间 | 充值、升级、查单、授权 Ops 修复 | 继续业务、钱包解锁 |
| INSUFFICIENT | available、quoted、差额、费率版本 | 充值、升级 | 拆单或调用 provider |
| UNAVAILABLE | “余额未知”、错误 code、request ID | 重试、对账、客服、诊断 | 渲染为 0、空表或正常 |
| STALE | old/new revision、受影响动作 | 重取 decision | 自动沿用旧 snapshot |
| RATE_CARD_UNAVAILABLE | 草稿/审批状态、缺失项 | 查看草稿、授权审批 | 显示执行确认按钮 |
| paid-but-ungranted | payment 与 grant 证据差异 | 查单、对账、授权修复 | 宣告已恢复 |
| RECOVERED | 新 revision、audit/request ID、核验时间 | 返回工作队列 | 只凭 payment success 判定 |

页面与每个 Tab 独立实现：

- Loading：保留表头和布局尺寸；能力未返回时不闪出完整导航或敏感数据。
- Empty：说明当前筛选无结果并提供清除筛选；不能替代尚未请求或读取失败。
- Error：数据区 `Alert/Result`，包含稳定 code、request ID、恢复动作；错误后保留筛选和输入。
- Partial：明确列出未加载区块和已加载数量，不伪装完整成功。
- Success：包含对象、revision、audit/request ID；toast 只能作为补充。
- 403：显示当前身份、scope、缺失 capability、request ID、返回路径；不循环重试。
- 409/revision conflict：显示客户端与服务端 revision，保留输入，要求刷新或重新确认；禁止静默覆盖。

多字段错误提交后将焦点移到 `CommercialErrorSummary`；摘要项链接至对应字段。unknown/error 使用 `role="alert"`；余额更新、恢复完成与后台刷新使用 `aria-live="polite"`。

## 7. 权限表现

组件只消费服务端 decision/capability，不根据角色字符串推导权限。目录读取/草稿/发布、费率读取/草稿/批准、点数读取/调账、private SKU 读取/分配、支付查单/对账/退款/导出、服务履约和门禁恢复必须分别授权。

| 权限状态 | 页面表现 |
|---|---|
| hidden | 不渲染入口、Tab、区块、字段、数量或动作；深链进入统一 403。 |
| read-only | 数据正常可读，使用 Table/Descriptions 与“只读”标识；不渲染编辑表单。 |
| disabled | 用户有动作能力但前置条件不足；动作可聚焦并解释缺少的输入、revision、审批或 readiness。 |
| 403 | 服务端权威拒绝；保留非敏感输入，显示身份、scope、capability、request ID 和恢复路径。 |

授权 Ops 的恢复、对账、配置诊断、调账和审计是精确恢复/控制白名单；目标 Workspace 为零点时仍按 capability 显示。点数门禁不扩大 Ops 权限，也不代替 RBAC、RLS、对象 scope、模型 readiness 或平台发布门禁。

## 8. Ant Design 组件规范

- Tabs：任务级导航；标签为稳定业务名，不显示动态错误详情。状态数量可用文字 Badge，但无权限时不得显示。
- FilterBar：平面白色工具条；常用筛选左对齐，刷新/导出右对齐；结果数由服务端返回。
- Table：默认 `size="small"`、sticky header、服务端分页/筛选/排序；首识别列固定左侧、操作列固定右侧，至少一列自适应。
- Drawer：560px 用于只读详情，720px 用于恢复与多证据详情；关闭后焦点回触发行。
- Modal：只用于发布、批准、调账、对账修复等短确认；默认焦点放原因字段或取消按钮，不承载长流程。
- Descriptions：只读权益、目录版本和私有 SKU 详情；不得用整页 disabled Input 伪装只读。
- Alert/Result：错误、权限和阻断；状态必须同时有图标、文字和稳定 code。
- Tooltip：禁用原因和截断 ID；内容必须可由键盘获得。
- Tag：只作辅助状态，不以颜色单独传意。

金额、点数、revision、ID 使用 `Fira Code` 或 tabular numbers。表格数字右对齐，正文使用 `Fira Sans, Noto Sans SC, sans-serif`，中文标题使用 `Noto Sans SC` 600。颜色、间距、控件高度和圆角完全继承 `MASTER.md` 权威 Desktop Ops override。

## 9. 无障碍验收

- 所有操作可只用键盘完成，焦点顺序与视觉顺序一致，不使用可点击 `div`。
- 页面切换聚焦唯一 H1；Tab 切换和错误恢复有明确焦点目标。
- 表格内 Input、InputNumber、Switch 和图标按钮的可访问名称包含对应 SKU、action、Workspace 或订单标识。
- 排序列提供真实排序状态和 `aria-sort`；行点击不能是唯一详情入口，保留明确按钮。
- Drawer/Modal 关闭后焦点回到触发控件；若记录因刷新消失，焦点回到表格标题。
- Tooltip、Popover、sticky header 和固定列不能遮挡键盘焦点；200% 缩放仍能完成核心流程。
- 正文对比度至少 4.5:1；焦点和非文本边界至少 3:1；焦点环清晰可见。
- 图标配文字时对辅助技术隐藏；单独图标按钮具有可访问名称及 pressed/expanded 状态。
- 多错误有顶部摘要及字段关联；错误后保留输入；成功反馈通过 polite live region 播报可核验证据。
- 状态不只靠红/绿传达；必须显示中文标签和稳定 code。
- `prefers-reduced-motion: reduce` 时取消非必要过渡；业务状态不依赖动画结束。

## 10. 禁止项

- 不新增营销价格卡、成交 CTA、客户 Logo、视频、轮播、渐变 Hero 或销售推荐文案。
- 不新增移动端断点、触控手势、移动菜单或响应式验收。
- 不在前端硬编码价格、点数、套餐权益、有效期或恢复规则。
- 不把 `includedTasks`、`monthly_tasks_used`、人民币钱包、通用 add-on、优惠券、灰度或模型倍率作为创意点、目录或准入替代物。
- 不把 unknown 渲染为 0、空数据、可用或已恢复。
- 不因支付成功直接显示 RECOVERED。
- 不允许表格内直接启用生产目录或费率。
- 不向无 private SKU read capability 的用户泄露入口、数量、筛选项或搜索提示。
- 不用客户端 hidden/disabled 充当安全门禁。
- 不发明赠点日期、50g 单位、文本费率、视频变量、充值点有效期、测试资格/抵扣、退款、宽限、数据保留或服务算法。

## 11. 页面级验收

1440×900 真实桌面浏览器必须覆盖：

1. 默认进入阻断与恢复；URL 深链、刷新、前进/后退保持 view、scope、筛选和 Drawer 目标。
2. EXHAUSTED、INSUFFICIENT、UNAVAILABLE、STALE、RATE_CARD_UNAVAILABLE、paid-but-ungranted 与 RECOVERED 各自独立呈现。
3. 0 点目标 Workspace 的授权 Ops 恢复动作可用；无对应 capability 时隐藏、只读、禁用或 403 语义准确。
4. private SKU 对无读权限用户零泄露；有读无写时不渲染编辑表单。
5. 目录、权益、账本、订单和费率只显示服务端版本化数据；unknown 不变成 0，旧任务/钱包不参与准入。
6. payment → grant → new access revision 完整后才显示 RECOVERED，并展示 audit/request ID。
7. 每个 Tab 覆盖 loading、empty、error、partial、success、403 和 409；错误后保留输入与筛选。
8. 表格 sticky、固定列、服务端排序/筛选、Drawer 焦点恢复、错误摘要和 live region 可工作。
9. finance、support、platform Ops 的真实会话权限表现与服务端 capability 一致，不使用本地角色模拟。
10. 仅代码、fixture 或静态截图不构成上线证据；生产状态继续服从 PRD 的 E3/E4 门禁。
