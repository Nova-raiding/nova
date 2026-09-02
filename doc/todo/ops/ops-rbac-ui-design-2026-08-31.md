# 运营后台 RBAC 与 Ant Design 桌面工作台设计规范 v1

日期：2026-08-31  
状态：可进入产品/架构对齐与前端拆分  
范围：`apps/ops-console` 桌面运营工作台（建议验收视口 1280×800、1440×900、1920×1080）  
明确不在范围：手机、平板、触控导航及其适配，不作为需求、验收项或上线门禁。

## 1. 结论

当前后台已有 Ant Design、13 个路由域、懒加载、基础导航隐藏与服务端 403 兜底，但还不是可信的权限工作台。核心问题不是“颜色不够好看”，而是身份、资源范围和动作权限没有形成统一视觉语言：侧栏对所有角色写死“平台级/全平台”，页头长期暴露连接配置和原始角色串，各页面分别用 `canXxx`、隐藏按钮或无解释的 `disabled` 表达权限。

v1 采用“身份 × 资源范围 × 能力”三层访问模型，并只做桌面：

1. 左侧导航只回答“我能进入哪些工作域”。
2. 顶部范围条持续回答“我正以什么身份、在哪个租户/平台范围操作”。
3. 页面和区块回答“这里是可操作、只读，还是因前置条件暂不可用”。
4. API 仍是最终授权门；客户端状态只改善理解和减少无意义请求，不构成安全边界。

## 2. 证据与设计评审

### 2.1 当前实现证据

- `opsNavigation.ts` 已按角色过滤 13 个域，`OpsConsoleController.tsx` 对深链越权显示 403。
- `OpsSidebar.tsx` 的范围面板固定显示“平台级 / 全平台”，与 `workspace_owner`、`merchant_admin` 等租户角色冲突。
- `OpsHeader.tsx` 将 API 地址、工作区、操作员、Token 和完整原始角色串放在全局首屏，导致主任务被诊断配置挤压。
- 动作权限散落在 `canPlatformOps`、`canQueue`、`canFinance`、`canModelMarkup`、`canWriteFeatureFlags` 等布尔值中；禁用状态经常只有视觉变灰，没有统一原因或申请路径。
- 现有截图显示：首屏留白大、标题与连接表单争抢层级、数据页面依赖大卡片堆叠、原始英文角色和 ID 噪音较高。
- 当前角色/域与动作条件存在待架构收敛的差异，例如财务动作允许部分工作区角色，但财务导航只给 `finance/platform_ops`；`platform_ops` 能进入规则域，而 `canRules` 未包含该角色。UI 不应自行猜测，应消费统一能力响应。

### 2.2 竞品原则（用于交互，不复制视觉）

- Google Cloud IAM 将权限理解为 principal、role、resource，并强调资源层级与继承。对应本项目：界面必须同时显示身份、角色来源和资源范围，而非只显示角色名。
- Stripe 组织团队权限可按账户授予不同角色，并建议最小权限。对应本项目：平台角色与租户角色不能混成一个“超级角色”标签。
- AWS 的拒绝体验区分显式/隐式拒绝，并提供可追查的授权上下文。对应本项目：403 和动作失败需要 request ID、缺失能力、当前范围和恢复路径，但不能泄露敏感策略内容。
- Ant Design 官方支持通过 `ConfigProvider` 的全局/组件 token 统一主题，Table 支持 sticky/virtual；因此 v1 不再为每个页面手写随机阴影、圆角和间距。

参考：

- <https://docs.cloud.google.com/iam/docs/overview>
- <https://docs.stripe.com/get-started/account/orgs/team>
- <https://docs.aws.amazon.com/IAM/latest/UserGuide/troubleshoot_access-denied.html>
- <https://ant.design/docs/react/customize-theme/>
- <https://ant.design/components/table/>

### 2.3 gstack 七项设计评审

| 维度 | 当前 | v1 规范后 | 结论 |
| --- | ---: | ---: | --- |
| 信息架构 | 5/10 | 9/10 | 13 域保留，但改成任务导向分组与统一上下文条 |
| 状态覆盖 | 5/10 | 9/10 | 定义 loading/empty/error/success/partial/permission 六态 |
| 用户旅程 | 5/10 | 8/10 | 从“先配连接”改为“先确认身份与待办，再处置” |
| AI 模板感 | 4/10 | 9/10 | 去掉卡片拼盘、装饰性指标和大面积空白 |
| 设计系统 | 5/10 | 9/10 | 统一 AntD token、页面骨架和权限组件 |
| 桌面与无障碍 | 6/10 | 9/10 | 键盘、焦点、表格、Drawer、表单契约明确；不扩展到移动端 |
| 未决策项 | 4/10 | 8/10 | UI 决策已锁定；能力契约仍需产品/架构 owner 最终确认 |

设计工具状态：gstack designer 当前不可用，因此本轮不生成伪造 mockup；规范以现有 1440×1000 真实截图审查为基础。

## 3. 桌面信息架构

```text
┌─ 左侧主导航 224 ─┬──────────────── 主工作区 ────────────────┐
│ 品牌/产品         │ 全局上下文条 56                           │
│ 身份与范围摘要     │ 角色 · 数据范围 · 工作区 · 连接状态 · 账户 │
│                   ├─────────────────────────────────────────┤
│ 运营概览           │ 面包屑 / 页面标题 / 权限状态 / 主动作       │
│                    ├─────────────────────────────────────────┤
│ 组织与服务         │ 筛选/批量动作工具条                         │
│  用户与租户        │ 主表格、工作队列或详情区                    │
│  成员与权限        │                                         │
│  客服与 CRM        │ 详情使用右侧 Drawer，确认使用 Modal          │
│  事故中心          │                                         │
│                    │                                         │
│ 商家运营           │                                         │
│  任务与内容        │                                         │
│  平台连接          │                                         │
│  平台规则          │                                         │
│                    │                                         │
│ 财务与模型         │                                         │
│  模型服务          │                                         │
│  账务与商业配置     │                                         │
│                    │                                         │
│ 风险与系统         │                                         │
│  功能开关          │                                         │
│  存储与对账        │                                         │
│  审计中心          │                                         │
└───────────────────┴─────────────────────────────────────────┘
```

### 3.1 左侧导航

- 固定宽度 224px，可折叠为 64px；折叠是桌面密度能力，不是移动菜单。
- 域级 `view = false` 时不渲染入口；不得显示灰色菜单泄露不可见域。
- 每组若无可见域则整组隐藏；当前域始终有高对比选中态和 `aria-current="page"`。
- “受控支持入口”不再悬空放在导航底部；归入“客服与 CRM”，只有具备受控租户会话能力时显示。
- 导航标签采用业务中文，不显示 `platform_ops` 等内部代码。

### 3.2 全局上下文条

从现有大页头拆成一行固定上下文，内容顺序如下：

1. `当前身份`：头像/姓名 + 人类可读角色，例如“平台运营”。多角色显示主角色 + `+2`，Popover 展开来源。
2. `数据范围`：平台全局、工作区、指定店铺或受控支持会话；范围用文字 + 图标，不只靠颜色。
3. `工作区`：有切换权限时为带搜索 Select；无权限时为文本。切换后清空页面选择、取消旧请求并重新取数。
4. `会话状态`：SSO、剩余时长、受控会话到期；受控租户会话使用持续可见的警示条，并提供“退出受控会话”。
5. `连接健康`：正常仅显示小型成功状态；异常显示“连接异常”，点击打开诊断 Drawer。
6. 账户菜单：权限说明、审计我的操作、退出。

禁止把本地 API Token 输入框常驻生产页头。仅开发/本地模式在“连接诊断” Drawer 中显示，并标记“仅本机”。

### 3.3 页面骨架

- `PageHeader`：Breadcrumb、H1、1 句范围明确的描述、`AccessLevelTag`、最多 1 个主动作。
- `FilterBar`：白色平面工具条，不再包一层大 Card；常用筛选左对齐，刷新/导出/批量动作右对齐。
- `DataRegion`：表格或工作队列是页面主角；避免“Card 套 Table 套 Card”。
- `DetailDrawer`：查看、对比、轻量编辑；宽 560/720px 两档。关闭后焦点回到触发行。
- `ConfirmModal`：破坏性或跨范围动作，必须显示对象、范围、影响、原因、revision/并发提示。

## 4. 统一权限呈现模型

### 4.1 前端只消费能力，不重建策略

建议会话/页面能力响应统一为：

```ts
type AccessDecision = {
  effect: "allow" | "deny";
  level: "hidden" | "read" | "write" | "admin";
  scope: { kind: "platform" | "workspace" | "store" | "controlled_support"; id?: string };
  source: "role" | "temporary_grant" | "policy";
  reasonCode?: string;
  expiresAt?: string;
};
```

页面不根据角色名称推算动作。角色用于解释，`capabilityKey` 才决定呈现与调用，例如 `ops.users.read`、`ops.users.suspend`、`ops.finance.refund`。

### 4.2 四种权限状态

| 状态 | 何时使用 | 导航/页面 | 动作 | 用户看到什么 |
| --- | --- | --- | --- | --- |
| 不可见 Hidden | 无域读取权限，或域存在本身敏感 | 隐藏导航；深链进入 403 | 不渲染 | 不泄露数据、数量和动作名 |
| 只读 Read-only | 可读数据但无写能力 | 页面正常显示 | 相关区块标“只读”；不把表单伪装成可编辑 | “当前角色可查看，不能修改”，可展开原因 |
| 禁用 Disabled | 有动作权限，但前置条件未满足或动作进行中 | 页面保留 | 禁用 + 可聚焦解释 | 明确缺少选择、原因、revision、数据或连接状态 |
| 拒绝 403 | 深链/服务端权威拒绝/授权在会话中变化 | 页面级或区块级 Result | 无操作 | 当前身份、范围、缺失能力、request ID、返回路径 |

只读与禁用不能混用：只读是权限结论，禁用是当前条件。只读数据优先使用 `Descriptions`、`Typography`、只读表格，不用整页 disabled Input，因为 disabled 值难读且语义错误。

### 4.3 角色与范围条文案

| 会话 | Badge | 主文案 | 辅助文案 |
| --- | --- | --- | --- |
| `platform_ops` 平台范围 | 平台级 | 正在查看平台聚合数据 | 客户内容默认不可见；进入具体工作区需受控授权 |
| `platform_ops` 受控会话 | 临时授权 | 正在支持工作区 `{name/id}` | 原因、授权人、到期时间持续可见；全部操作写审计 |
| `workspace_owner` | 工作区 | 工作区 `{name/id}` | 可管理成员与业务配置；不可跨租户 |
| `merchant_admin` | 工作区 | 工作区 `{name/id}` | 可执行租户管理动作；高风险动作按能力收窄 |
| `operator` | 工作区 | 工作区 `{name/id}` | 可处理任务与内容；账务、成员治理不可用 |
| `support` | 工作区/受控 | 当前工单或授权工作区 | 客户数据按工单范围最小化显示 |
| `finance` | 工作区/平台聚合 | 当前账务范围 | 退款、结算、导出按独立能力显示 |
| `rules_admin` | 平台规则 | 规则管理范围 | 不自动获得客户内容或账务权限 |

多个角色并存时不允许本地“模拟切换角色”。只显示有效能力的并集及来源。平台运营进入客户工作区必须走真实受控会话：选择目标 → 填原因/工单 → 服务端授权 → 重新换取会话 → 显示倒计时 → 主动退出或到期失效。

### 4.4 403 规范

页面级 `AccessDeniedResult`：

- 标题：`无权访问“账务与商业配置”`
- 说明：`当前身份“运营”在工作区 ws_xxx 缺少 ops.finance.read。`
- 附加：`授权可能已变更，请刷新会话后重试。请求 ID：req_xxx`
- 主动作：`返回运营总览`
- 次动作：`查看我的权限`；仅接入真实申请流后才显示“申请权限”。

动作 API 返回 403 时不跳走：关闭 loading，保留用户输入，在相关区块显示 Alert，并提供刷新权限/复制 request ID。若读取 API 返回 403，才用区块或整页 Result 替换数据区。

当前实现补充：JIT 签发区块已遵循该契约——签发 RPC 失败时不 reset 表单，使用统一 `OpsPageError` 展示错误代码及可用的 decision ID/reason code/缺失义务；提交按钮进入 loading 和 `aria-busy` 状态，避免重复签发。成功后才清空输入并刷新授权列表。

## 5. 13 个域的 UI 权限与页面形态

以下是界面契约，不替代产品/后端最终权限矩阵。`读` 表示展示数据，`写` 表示显示相关操作，`管` 表示高风险管理能力。

| 域 | 当前主要角色证据 | v1 页面形态 | 权限提示重点 |
| --- | --- | --- | --- |
| 总览 | 任一有效角色 | 待办队列 + 健康摘要 + 上线阻断，按能力裁剪 | 不展示用户无权进入域的敏感数量 |
| 用户与租户 | `platform_ops` | 平台用户/租户目录，详情 Drawer | 平台身份动作标“影响所有租户” |
| 成员与权限 | owner/admin/platform_ops | 当前工作区成员表 + 邀请/改角色 | 自锁、越权授予、platform_ops/owner 委派要解释 |
| 客服与 CRM | support/platform_ops | 工单队列 + 客户最小化投影 | 受控工作区、脱敏、导出范围和到期时间 |
| 事故中心 | support 读；platform_ops 写 | 事故列表 + 指挥详情 Drawer | support 显示“只读事故响应”；平台动作要求原因 |
| 任务与内容 | operator/platform_ops（现有动作另有角色） | 待处理队列优先，平台聚合与客户内容分区 | 平台聚合不能暗示能读取客户内容 |
| 平台连接 | owner/admin/platform_ops | 连接健康表 + 授权/撤销操作 | 平台聚合与工作区店铺操作必须拆区 |
| 平台规则 | rules_admin/platform_ops 可见 | 同步健康 + 版本生命周期 | 来源、审批、版本冲突；修复当前域/动作差异 |
| 模型服务 | finance/platform_ops | 五模态 readiness + 成本证据 + 用量 | 配置/成本加价是独立管理能力，不因可读自动显示 |
| 功能开关 | 多角色可读；write/emergency 独立 | 开关表 + 审计 Drawer | 普通写与紧急关闭分离；紧急动作危险确认 |
| 存储与对账 | platform_ops | 脱敏汇总 + workspace 定位 | 不展示对象 key/下载；跨工作区范围常驻可见 |
| 账务与商业配置 | finance/platform_ops 可见；动作更细 | 使用 Tabs/分段导航拆成检索、退款、对账、套餐 | 每个动作单独能力；修复导航与动作授权差异 |
| 审计中心 | support/finance/platform_ops | 检索主表 + 最小化详情 Drawer | 平台范围不可直接导出；工作区切换后才可导出 |

## 6. 页面状态与反馈

| 区域 | Loading | Empty | Error | Success | Partial | Permission |
| --- | --- | --- | --- | --- | --- | --- |
| 页面首载 | 保留骨架尺寸的 Skeleton | 不使用页面空态代替未请求 | `Result error` + 重试 | 内容出现后不额外 toast | 顶部 warning 列出未加载区块 | 读取拒绝显示 403 |
| 表格 | 表头保留、行 Skeleton/Spin | 说明当前筛选 + 清除筛选/创建动作 | 表格区域 Alert + 重试 | 刷新时间更新 | 显示“已加载 n/总数”，失败分片单列 | 只读列照常，操作列显示只读原因 |
| 表单提交 | 按钮 loading、防重复提交 | 不适用 | 字段内错误；多错误聚焦摘要 | Message/Alert + revision/审计编号 | 部分成功列明成功/失败对象 | 无写权限不渲染编辑表单 |
| Drawer | 局部 Skeleton | “无详情记录” | Drawer 内重试，保持打开 | 保存后刷新并保留上下文 | 每个 Tab 独立状态 | 无详情权限则不打开 |
| 批量动作 | 显示对象数、锁定二次提交 | 0 个时按钮禁用且解释 | 逐条结果，不伪装全成功 | 成功数/失败数 + 审计证据 | 失败项可筛出重试 | 仅对可操作行启用选择框 |

任何成功反馈都要包含可核验结果：对象、状态、revision 或审计 ID。任何错误都包含恢复动作。空数据与读取失败不得复用同一视觉。

## 7. Ant Design 设计系统

### 7.1 全局 token

通过根 `ConfigProvider` 配置，不在业务组件内散落十六进制值：

```ts
{
  token: {
    colorPrimary: "#1D4ED8",
    colorInfo: "#2563EB",
    colorSuccess: "#15803D",
    colorWarning: "#B45309",
    colorError: "#B91C1C",
    colorText: "#0F172A",
    colorTextSecondary: "#475569",
    colorBgLayout: "#F5F7FA",
    colorBgContainer: "#FFFFFF",
    colorBorderSecondary: "#E2E8F0",
    borderRadius: 6,
    borderRadiusLG: 8,
    controlHeight: 36,
    controlHeightSM: 30,
    fontSize: 14,
    wireframe: false
  },
  components: {
    Layout: { siderBg: "#10234F", headerBg: "#FFFFFF" },
    Menu: { itemHeight: 40, itemBorderRadius: 6, itemMarginInline: 8 },
    Table: { headerBg: "#F8FAFC", headerColor: "#334155", rowHoverBg: "#EFF6FF", cellPaddingBlockSM: 10 },
    Card: { borderRadiusLG: 8 },
    Drawer: { paddingLG: 24 },
    Modal: { borderRadiusLG: 8 }
  }
}
```

字体：界面正文使用 `Fira Sans, Noto Sans SC, sans-serif`；中文标题用 `Noto Sans SC` 600；技术 ID、金额对齐列使用 `Fira Code` 与 tabular numbers。避免让不含中文字形的 Fira Sans 触发不可控系统回退。

### 7.2 密度与尺寸

- 4px 基础网格：4/8/12/16/24/32。
- 页面水平 padding：1440 视口为 24px，1920 为 32px；内容不设窄营销型 max-width。
- 页面标题 24/32，区块标题 16/24，正文 14/22，辅助文字 12/20。
- 桌面按钮默认 36px；表格行 44px 左右。高风险主操作不以“触控 44px”强制拉高所有桌面按钮。
- 圆角只分 4/6/8 三档；数据容器使用 1px border，常态无阴影；Drawer/Modal 才用 elevation。

### 7.3 Table

- 数据页默认 `size="small"`、sticky header、服务端分页/筛选/排序；50+ 可见行或大数据集评估 `virtual`。
- 第一识别列固定左侧，操作列固定右侧；至少留一列自适应宽度，长 ID 使用 ellipsis + 可键盘触达 Tooltip/复制。
- 数字右对齐、金额/数量使用 tabular numbers；状态 Tag 同时有文字。
- 批量选择只选择当前授权对象；禁用 checkbox 的原因通过行内文字/Tooltip 可获得。
- 行点击不作为唯一详情入口，保留明确“查看详情”按钮。

### 7.4 Form / Drawer / Modal

- Form 默认 vertical，长筛选条可 inline；可见 Label 永远存在，错误与字段通过 `help/status` 关联。
- 只读对象不用 disabled Form；使用 Descriptions 或 `ReadOnlyField`。
- Drawer 用于不离开列表的详情和低风险编辑；Modal 只做确认和短表单，不承载长流程。
- 破坏性确认按钮使用 danger，默认焦点放取消或原因字段；原因至少 4 字只是最低规则，UI 同时提示工单/证据格式。
- 关闭 Drawer/Modal 后恢复触发控件焦点；未保存更改时拦截关闭。

### 7.5 Motion

- 仅保留状态必要动效：Drawer/Modal、Collapse、加载反馈；150–200ms。
- 不做页面滚动 reveal、卡片上浮或数据数字跳动。
- `prefers-reduced-motion: reduce` 时取消非必要过渡；业务状态不依赖动画结束事件。

## 8. 可实现组件清单

建议目录（名称可按团队规范调整）：

| 组件 | 职责 | 关键 props |
| --- | --- | --- |
| `OpsAppShell` | Layout、Sidebar、ContextBar、主内容 | `session`, `navigation`, `activeDomain` |
| `RoleScopeBar` | 当前身份、有效角色来源、资源范围、临时授权倒计时 | `identity`, `roles`, `scope`, `grant` |
| `WorkspaceScopeSelector` | 有权限时切换真实工作区 | `options`, `value`, `onChange`, `disabledReason` |
| `ConnectionHealthDrawer` | 将连接配置/诊断从主页头移出 | `health`, `environment`, `canConfigure` |
| `OpsNavigation` | 能力驱动的分组导航 | `items: {requiredCapability}` |
| `OpsPageHeader` | 面包屑、标题、描述、访问级别、主动作 | `accessDecision`, `primaryAction` |
| `AccessLevelTag` | 平台级/工作区/临时授权/只读 | `level`, `scopeKind`, `expiresAt` |
| `PermissionBoundary` | hidden/read/write/admin 呈现 | `decision`, `fallback`, `children` |
| `PermissionHint` | 可聚焦解释缺失能力或前置条件 | `reason`, `capability`, `requestId?` |
| `AccessDeniedResult` | 统一页面/区块 403 | `domain`, `decision`, `requestId`, `backTarget` |
| `OpsFilterBar` | 搜索、筛选、清空、刷新、导出 | `filters`, `actions`, `resultCount` |
| `OpsDataTable` | sticky、分页、状态、授权行选择 | `columns`, `queryState`, `rowAccess` |
| `OpsDataState` | loading/empty/error/partial 统一容器 | `state`, `retry`, `emptyAction` |
| `ReadOnlyField` | 可复制、可读的只读字段 | `label`, `value`, `sensitive` |
| `GovernanceDrawer` | 详情、审计、低风险编辑 | `entity`, `tabs`, `accessDecision` |
| `DangerActionModal` | 对象、范围、影响、原因、并发版本 | `target`, `impact`, `revision`, `onConfirm` |
| `AuditEvidenceNotice` | 成功后展示 revision/审计证据 | `auditId`, `requestId`, `revision` |

组件必须只接收服务端/统一权限层给出的 decision，不在内部硬编码角色数组。

## 9. 无障碍与键盘验收

- 页面切换后焦点移动到主内容 H1；导航保持 `aria-current`。
- 所有操作可只用键盘完成；可聚焦元素顺序与视觉顺序一致；不使用可点击 div。
- 焦点环 2px，和相邻颜色至少 3:1；sticky header、固定操作列、Popover 不得遮住焦点。
- 图标随可见文本出现时 `aria-hidden`；单独图标按钮必须有可访问名称和 pressed/expanded 状态。
- 正文对比度至少 4.5:1，组件边界和焦点至少 3:1；状态不用红/绿单独传达。
- Toast 不抢焦点；异步成功用 polite live region，阻断错误用 alert；批量结果读出成功/失败数量。
- 排序列提供 `aria-sort`；Tooltip 内容能由键盘获得；表格必须保留真实表格语义。
- 表单多错误时聚焦顶部错误摘要，摘要链接到字段；错误后保留输入。

## 10. 关键交互流程

### 10.1 正常进入

`SSO 完成 → 读取 session/capabilities → 渲染允许导航 → 默认进入第一个允许域/总览 → 并行读取当前域数据`。能力未返回期间显示验证 Skeleton，不先闪出全量导航。

### 10.2 工作区切换

`选择工作区 → 二次确认（仅有未保存内容时）→ 取消旧 workspace 请求 → 更新 URL scope → 清空选中行/Drawer → 拉取新 capability snapshot → 渲染新导航和页面`。不得只换页面文案而复用旧数据。

### 10.3 受控支持会话

`选择工单/目标工作区 → 填原因 → 服务端创建有时效授权 → 新会话生效 → 全局警示条显示范围与到期 → 操作写审计 → 退出/到期后清空客户数据并返回平台范围`。

### 10.4 运行中权限变化

动作返回 403 时：停止 loading、保留输入、显示 request ID 和“刷新权限”；刷新后若失去域读取权，导航移除并返回最近允许页。不得循环重试 403。

## 11. 前端落地顺序

- [x] **T1（P1）统一能力契约**：用 `AccessDecision/capabilityKey` 替代页面内角色数组；先解决财务、规则、任务域当前差异。验证：角色 × 域 × 动作契约测试。已由 `AuthorizationProvider`、`PermissionGate`、服务端 capability projection 及 `d497dc8`、`013ed94`、`962cbbd` 的定向测试证实；`6ab248a`、`acab8ae` 同时为前端消费的 policy/grant 状态提供本地精确 coverage 与 fail-closed 边界。
- [ ] **T2（P1）重构 Shell**：实现 `OpsAppShell + RoleScopeBar + ConnectionHealthDrawer`，移除首屏 Token 表单与硬编码全平台文案。验证：platform/workspace/controlled 三类会话截图与键盘路径。
- [x] **T3（P1）统一权限状态**：实现 `PermissionBoundary/Hint/AccessDeniedResult`，覆盖导航隐藏、只读、前置禁用、服务端 403。验证：每类状态至少一个浏览器用例；本地组件/契约测试由 `d497dc8`、`013ed94`、`3c80ff4`、`c432df7`、`60c71c8`、`818e62a` 等提交证实。`c432df7` 覆盖审计导出 capability/scope 限制、错误聚焦和键盘重试，`818e62a` 覆盖审计详情错误摘要焦点恢复；这些是本地 UI 证据，不替代完整浏览器矩阵。
- [ ] **T4（P2）统一页面骨架**：PageHeader、FilterBar、DataTable、Drawer、DangerActionModal；先迁移用户、成员、财务三个高风险页。验证：无 Card 套 Table、焦点恢复、错误保留输入。
- 本地可闭环子项：`PageHeader` 已由 `OpsPage` 统一承载用户、成员、财务页面的语义标题、描述关联和下一步状态播报；`PageHeader.test.tsx` 覆盖标题层级、`aria-describedby` 目标及空动作区，尚不代表 T4 的完整骨架迁移完成。
- [x] 本地可闭环子项：事故 `DataTable` 在保留已有行的同时以 `aria-busy` 和 `polite` live region 播报加载状态，详情按钮保持键盘可达；`IncidentsTable.test.tsx` 覆盖加载播报、行保留和操作名称。该证据不代表 T4 的完整骨架迁移完成。
- [x] 本地可闭环子项：事故详情 Drawer 在加载期间声明 `aria-busy` 并以 `polite` live region 播报“已有内容会保留”，避免 Spin 只有视觉反馈；`IncidentDetailDrawer.test.tsx` 覆盖桌面详情区域的加载语义。该证据不代表 T4 的完整骨架迁移完成。
- [x] 本地可闭环子项：配置中心读取失败会将焦点移至可聚焦错误摘要，并提供键盘可达的“刷新配置”恢复动作；`ConfigurationCenterSection.test.tsx` 覆盖错误播报、焦点与恢复契约。该证据不代表 T4 的完整骨架迁移完成。
- [x] 本地可闭环子项：平台连接目录刷新或读取失败时保留上一次成功的店铺表格，使用可聚焦 `role="alert"` 解释“旧数据仍可见”与初始空列表的区别，并提供键盘可达的“刷新店铺目录”；`StoreDirectorySection.test.tsx` 覆盖加载保留行、错误播报和恢复动作。该证据不代表 T4 的完整骨架迁移完成。
- [ ] **T5（P2）迁移其余 10 域**：按域逐一移除局部硬编码权限和随机样式。验证：13 域视觉快照 + 角色导航矩阵。
- [ ] **T6（P2）应用 AntD tokens**：根 ConfigProvider + 组件 token；清理业务组件内颜色/圆角/大面积 inline style。验证：1440/1920 桌面截图、对比度与 reduced-motion。
- [ ] **T7（P1）真实链路验收**：SSO → capability → 页面 → API 403/成功 → 审计证据，在真实桌面浏览器与容器环境验证；fixture 仅做开发辅助。

## 12. NOT in scope

- 手机、平板、触控手势、汉堡菜单和横竖屏适配：本项目明确是桌面工作台。
- 自定义角色编辑器/策略语言：本轮先落预定义角色与服务端能力契约。
- 暗色主题：可由 token 扩展，但不是 v1 上线门禁。
- 本地模拟切换角色：会制造虚假权限证据；只允许真实会话/受控授权切换。
- 业务 API、RLS、worker、模型中转的具体实现：UI 只消费并如实呈现其真实结果。

## 13. What already exists

### 2026-08-31 权限错误播报增量

- `AccessDeniedResult` 的缺失能力、当前范围和请求 ID 证据区现在带 `role="alert"` 与 `aria-live="assertive"`，权限错误进入页面后可被辅助技术主动播报；“返回运营总览”和“刷新权限”仍保留键盘可达恢复动作。
- `permissionUx.test.tsx` 6/6 通过，`npm run typecheck`、`npm run build:ops-console` 和 `git diff --check` 通过。
- 该项只归档权限错误状态的可访问性补强；真实 OIDC 403、request/trace ID 传播、RLS 与桌面角色矩阵仍未完成，因此本设计文档继续保持 `TODO / UI NO-GO`。
- 完整 Ops Console 回归随后复核为 67 个测试文件、312/312 通过；该数字只证明当前前端回归，不替代真实 OIDC、RLS、审计 sink 和生产桌面证据。

### 2026-09-01 本地 authz/UI/audit 证据回填

- `6ab248a`、`acab8ae`：本地 policy coverage 以及 revoked/expired grant、scope 边界的 fail-closed 契约已验证；这不等同于全量 MCP/HTTP enforcement 或持久化 JIT grant。
- `013ed94`、`962cbbd`：权限验证状态、服务端 capability projection、只读/无权限/错误恢复状态已在 Ops UI 定向测试中验证。
- `c432df7`、`818e62a`：审计导出与详情错误具备 scope/capability 约束、敏感失败反馈、焦点恢复和可访问重试路径。
- `60c71c8`：canonical 页面如实展示服务端状态、next action、权限限制和错误/空结果区别。
- 以下仍明确未完成：全量 enforcement、真实 OIDC/RLS、持久 JIT、真实 audit sink，以及完整 1280/1440/1920 多角色桌面浏览器矩阵；本地契约和组件测试不能替代这些证据。

- 可复用：Ant Design、`Layout/Sider`、13 域路由注册、React.lazy、`OpsDataState`、错误边界、Drawer 焦点恢复、危险操作 Modal、服务端 403 兜底、部分领域能力布尔值与测试。
- 需要替换：硬编码“平台级/全平台”、常驻连接表单、页面各自定义权限文案、无原因 disabled、Card 拼盘、移动端验收条款。
- 设计真源：`design-system/merchant-ops-console/MASTER.md`；页面特例继续放在 `pages/*.md`，特例不得放宽权限和无障碍约束。

## 14. 待产品/架构 owner 最终确认

## 14.0 当前实现对账（owner 复核，2026-08-31）

设计稿中的部分“未见实现”来自早期快照，当前代码已完成以下 UI 基础设施：

| 设计项 | 当前代码证据 | 判定 |
| --- | --- | --- |
| `RoleScopeBar` / 工作台切换 | `components/authz/RoleScopeBar.tsx`、`OpsWorkbenchSwitcher.tsx`、`OpsConsoleController.tsx` | 本地已落地 |
| 连接诊断抽屉/折叠区 | `OpsHeader.tsx` 的连接状态摘要与可展开诊断字段 | 本地已落地 |
| 权限边界与 403 | `AccessDeniedResult.tsx`；controller 深链拒绝显示 capability、scope、request ID | 本地已落地 |
| 能力驱动导航与 deny-all | `authorization.ts` 消费服务端 projection；托管会话缺 projection 时不从 raw role 扩权 | 本地已落地 |
| AntD 全局主题 | `main.tsx` 根级 `ConfigProvider theme={opsTheme}` | 本地已落地 |
| 切换后的数据隔离 | workbench transition abort 请求、更新 URL/配置并 remount runtime；已有单测 | 本地已落地 |

这些实现仍不能替代真实生产验收。T7 继续保持未完成：需要真实 OIDC/受控支持会话、三种桌面尺寸的点击证据、API 403/审计/RLS/worker 联合证据。完整组件化迁移、全域视觉快照和散落角色判断收敛仍按 T4–T6 推进。

1. 预定义角色与 capability 的权威映射，以及多角色是并集还是存在显式 deny。
2. `platform_admin`、`ops_admin`、`reviewer` 等开关角色是否并入统一运营角色模型。
3. 平台运营进入客户工作区的授权来源、最大时长、审批人和到期处理。
4. 权限申请是否存在真实工单/API；没有之前 UI 不显示无效的“申请权限”按钮。
5. 角色/范围 snapshot 的 revision 与刷新机制，确保运行中撤权能 fail-closed。

上述 5 项不影响前端先实现状态组件和 Shell，但会阻断把权限矩阵标记为生产完成。

## 16. 当前实现复核（2026-08-31）

- 当前实现已由根 `ConfigProvider(theme=opsTheme)` 提供主题，并由 `OpsAntAppBoundary` 包裹 `useOpsConsoleModel` 的所有 `useApp()` consumer，避免 Ant Design 静态 message 上下文错误。
- Ops Console 测试 68 个文件、322 个测试通过，生产构建通过。按 UI/UX Pro Max 的错误宣告与键盘可达要求，拒绝页/权限错误已有 `role=alert`、`aria-live` 及刷新/返回动作。
- 这只证明本地代码和构建行为；真实 OIDC 角色矩阵、桌面焦点路径、服务端 403/审计联动和生产证据仍缺，因此本文继续保持 `TODO / UI NO-GO`，不迁移到 `doc/done`。
- JIT 状态条已补充服务端投影的访问模式、精确 resource scope 和 `use_count/max_uses`，并以 `aria-live="polite"` 暴露倒计时状态；组件回归覆盖读写模式、范围和使用预算。该 UI 仍不替代申请审批、撤销竞态和真实 OIDC 证据。
- 403 错误展示增量：`OpsRequestError.details` 中的 `decision_id`、`reason_code`、`obligations_missing` 现在被结构化映射并在折叠诊断区展示；页面仍区分客户端预判与服务端 request/trace ID。定向权限错误回归 30/30、Ops Console 全量回归 68/68（324 tests）及生产构建通过。
- 连接诊断增量：API/工作区/本地 Bearer 配置已移入真正的 Ant Design Drawer；Header 仅显示连接状态和入口，刷新中状态保留在主界面并带 `aria-busy`，保存成功后关闭诊断面板。Ops Console 68 个文件/324 个测试、生产构建和 TypeScript 通过；真实 OIDC 网关、生产配置和浏览器多角色证据仍是上线门禁。

## 15. 全量插件功能权限矩阵实现增量

授权中心新增独立“功能权限矩阵”标签页，数据只来自服务端 `ops.authorization.matrix.get`，不在前端复制角色到 capability 的映射。桌面交互采用搜索、工作台筛选、读写筛选和多角色对比；方法与 capability 固定在左侧，角色列横向滚动，表格纵向有界并保留 sticky header。四种访问状态同时显示文字 `不可见/只读/操作/治理`，不依赖颜色传意。

本地 1440px 桌面浏览器已验证 247/247 方法渲染、19 个角色响应完整性、四类状态以及精确搜索 `ops.authorization.matrix.get`。该界面明确提示最终执行还受当前工作台、资源 scope、显式 deny、JIT、义务与实时撤权影响；因此它是可审计的角色模板目录，不是“角色具备能力即可无条件执行”的授权承诺。1280/1920、真实 OIDC 与生产权限多状态仍属于上线阻断。
