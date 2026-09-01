# 运营后台 RBAC 与插件全能力治理产品方案

日期：2026-08-31  
状态：产品方案，待架构、设计与工程复核  
范围：ChatGPT 商家营销插件、API/MCP、桌面运营后台、worker、PostgreSQL/RLS 与发布门禁  

## 0. 结论先行

当前项目不是“没有权限”，而是权限语义分散：工作区成员角色、OIDC/Bearer 声明角色、Ops 子域角色、品牌角色、Feature Flag 内部角色和 `platform_ops` 临时客户数据票据分别存在，但没有同一份可审计的权限目录。前端导航只能回答“菜单是否显示”，不能准确回答“哪个范围的哪类数据可以看、能执行哪种动作、是否要审批”。

推荐采用“控制面与客户数据面分离的 RBAC + Scope + Obligation”模型：

```text
最终许可 = 身份有效
        AND 角色授予的 capability
        AND 资源范围匹配（platform/workspace/brand/store/self）
        AND 对象状态允许
        AND 强制条件满足（MFA/原因/二次确认/双人审批/JIT 票据）
        AND 没有显式 deny
```

这不是一次纯 UI 重构。正确顺序是先冻结权限词典与服务端鉴权契约，再让 Ant Design 后台消费同一个权限投影。否则只会把当前分散逻辑换一套更漂亮的壳。

本方案选择 gstack 的 **HOLD SCOPE / ideal architecture** 思路：不扩展到手机、平板或新平台，不虚构上线成功；在用户明确要求的“插件全功能对应后台权限 + 桌面 Ant Design 重构”范围内做完整设计。

## 1. 取证边界与当前事实

### 1.1 本次审查方法

- CodeGraph 已同步当前工作树：`783 files / 10,934 nodes / 40,772 edges`；重点追踪 `visibleOpsDomains → canViewOpsDomain → domainRoles`、`OpsConsoleController → useOpsConsoleModel`、MCP 路由鉴权和成员仓储/RLS。
- `packages/contracts/src/mcp.ts` 在方案起草时列出 231 个 MCP 方法；截至本轮收口已动态增长到 **247 个**，其中包含由 policy registry 生成全量角色访问矩阵的 `ops.authorization.matrix.get`。发布门禁必须读取 `MCP_METHODS.length`，不得硬编码数量。
- 桌面运营后台当前有 **13 个业务域**：总览、用户、成员、客服、事故、任务、店铺、规则、模型、功能开关、存储、财务、审计。
- 本文只把源码、测试和历史文档当作实现证据；它们不等同于生产运行成功。生产 OIDC、真实平台 OAuth、支付、模型中转、真实多租户数据和发布门禁仍须运行态证据。

### 1.2 当前可复用实现

| 已有能力 | 当前证据 | 复用判断 |
| --- | --- | --- |
| 导航域可见性 | `apps/ops-console/src/navigation/opsNavigation.ts` | 保留域注册方式，替换硬编码角色数组为权限目录投影 |
| 页面与组件注册 | `opsPageRegistry.tsx`、13 个 Page、领域 Section | 保留懒加载与模块边界；按 capability 拆页面内读/写动作 |
| 会话角色投影 | `ops.session`、`useOpsConsoleModel.ts` | 扩展为 `effective_permissions`、`scope`、`obligations`，不再让前端自行推导 |
| 工作区成员生命周期 | `MembersRepository`、`ops.member.*` | 保留邀请/激活/停用/revision/最后 owner 保护；角色从单值演进为角色分配集合 |
| 品牌访问 | `brand-unit.access.grant` 与品牌级 access | 保留为对象范围层，不与平台角色合并 |
| 平台运营客户数据 JIT | `X-Ops-Customer-Access-Grant`、15 分钟票据、审计 | 保留并提升为统一临时授权模型；默认拒绝不能回退 |
| RLS/平台范围 | workspace RLS、迁移 090/091 | 继续作为数据层最终边界；应用层许可不能替代 RLS |
| 审计与并发控制 | operation audit、revision、idempotency | 所有敏感写动作统一复用 |
| 领域错误呈现 | `OpsPageError`、`opsErrorPresentation.ts` | 继续区分未认证、无权限、未配置、真实空态和上游失败 |

### 1.3 已确认的不一致与风险

1. `domainRoles` 只将 `platform_ops` 视为全域特权，但同时混有 `platform_admin`、`ops_admin`、`reviewer`、`rules_admin` 等角色；它们的来源和作用范围没有统一契约。
2. `featureFlagActor()` 会把 `platform_ops` 映射成 Feature Flag 域内的 `platform_admin`。同名/异名角色在不同域发生隐式转换，审计时难以解释“为何允许”。
3. `MemberRole` 只有 `workspace_owner | merchant_admin | operator | support | finance | platform_ops` 单值，知识编辑、竞品审核、规则管理员等却来自 gateway capability role。成员管理页面无法展示用户真实的有效权限组合。
4. `OpsSidebar` 对所有可登录角色硬编码“平台级 / 全平台 / 正在查看全平台运营数据”。工作区 owner、商家管理员、财务和 support 会看到错误范围提示，这是信任与越权感知问题。
5. `platform_ops` 在导航层可见所有域，但服务端明确规定其默认不能读取客户商品、素材、内容和任务正文。页面“可见”与数据“可读”没有清晰表达聚合态、受控态和无权态。
6. 当前 `canXxx` 在 `useOpsConsoleModel.ts` 和各组件继续散落。即使 API 最终拒绝，页面仍可能错误显示按钮、发出不该发的请求，或者将 403 当作数据为空。
7. 非 managed 本地模式默认放宽导航/动作，适合本地联调但不能成为权限验收依据；生产契约必须 fail-closed。

## 2. Problem Statement

### 问题陈述

平台运营人员、商家负责人和商家执行人员在通过 ChatGPT 插件和桌面运营后台处理营销业务时，无法从一套一致的权限模型中判断自己能看到什么、能操作什么、操作哪个租户/品牌/店铺，以及何时需要审批或临时授权；这会导致越权风险、合法操作被误拒、错误导航和无法解释的审计记录。

### 用户分群

- 平台侧：平台所有者、身份/租户管理员、日常平台运营、客服、财务、规则管理员、模型管理员、安全审计员、发布管理员。
- 商家侧：工作区所有者、商家管理员、运营、内容编辑、内容审核/发布、规则管理员、财务、只读审计员。
- 最终客户数据主体：工作区、品牌、店铺、商品、素材、内容版本、任务、发布、账务与审计对象。

### 当前行为与 workaround

- 产品/工程通过前端 `roles.includes(...)`、服务端多处 `requireOperationsRole(...)` 和各领域自有角色表人工对齐。
- 平台客服若要看客户正文，依赖单独的 HMAC 临时票据；后台尚无统一的申请、审批、剩余时间和撤销视图。
- 低权限用户通过菜单隐藏、禁用按钮和 API 403 混合判断权限，无法预先看到明确的只读原因。
- 审计人员需要从多处源码或日志反推“角色 → 权限 → 数据范围”。

### 影响

- 用户影响：不知道自己为什么看不到、为何只读、是否选错工作区；平台角色容易误以为可以直接查看客户正文。
- 业务影响：多租户数据泄露、误退款/误发布/误停用用户、客服处理变慢、权限变更难审计。
- 工程影响：新增一个插件方法或后台模块时，要在导航、Hook、组件、API、领域服务和 RLS 多处手工补规则，极易漂移。

### 证据强度

| 证据 | 来源 | 强度 |
| --- | --- | --- |
| 全量 MCP 方法与 13 个 Ops 域尚无单一权限目录 | 当前 contracts/UI 源码清点 | 强 |
| `domainRoles`、`canXxx`、领域 permission map 并存 | 当前源码与 CodeGraph | 强 |
| Sidebar 对工作区角色也显示全平台范围 | 当前 `OpsSidebar.tsx` | 强 |
| `platform_ops` 默认拒绝客户数据，只能用限时票据 | API 实现与完成文档 | 强 |
| 生产 SSO、真实多租户与外部 provider 尚未闭环 | 当前项目审计文档 | 强 |
| 用户对权限困惑的频次、客服工单量 | 尚无行为数据 | 弱，需上线后埋点验证 |

### 5 Whys

1. 为什么用户不知道自己能做什么？因为 UI 只按角色隐藏域，页面动作又各自推导。
2. 为什么各自推导？因为没有统一的 capability 与 scope 目录。
3. 为什么没有统一目录？因为成员角色、gateway role 和各领域角色随功能迭代分别增加。
4. 为什么这会成为安全问题？因为同一语义在 UI、API、worker、RLS 有不同名字和默认值。
5. 根因：系统把“职位角色”直接当作“最终授权”，没有将角色、能力、资源范围、对象状态和强制条件分层。

### 成功标准

- 100% 的 MCP 方法和 Ops 页面动作都有唯一 permission ID、scope、风险级别、审计义务和角色模板映射。
- UI、API/MCP、worker 使用同一版本化权限目录；任何差异由 CI 阻断。
- 任何角色打开后台后，Sidebar 范围、页面可见性、只读态和 API 实际许可一致。
- `platform_ops` 无 JIT 票据时对客户正文 100% 拒绝；聚合数据不包含客户正文、prompt、对象 ID 或下载入口。
- 新权限默认 deny；角色变更、敏感操作、JIT 授权和审批均可从不可变审计重建。
- 在真实 OIDC + 两个工作区 + 多角色会话中完成负向越权测试、桌面浏览器验收和 RLS SQL probe。

### Anti-scope

- 不做手机或平板适配，也不把移动端回归作为上线门禁。
- 不增加未授权电商平台或虚构平台连接能力。
- 不以静态矩阵、fixture 或本地 token 证明生产权限链成功。
- 不让平台客服、运营或管理员获得永久客户正文“超级权限”。

## 3. 竞品模式与可借鉴项

本次只采用官方帮助中心的权限设计事实，不复制竞品业务边界。

| 产品 | 官方模式 | 可借鉴 | 不应照搬 |
| --- | --- | --- | --- |
| Shopify | 区分 Organization role、Store role、POS role、Partner role；权限按 Store/Organization 范围授予；Owner 与系统管理员角色不可随意修改；文件权限拆为 View/Create/Edit/Delete | 平台/组织与店铺范围分层；系统角色锁定；敏感权限显式标记 | Shopify Store 权限通常不能细到单个商品，本项目已有 brand/store 对象范围，不能降级 |
| HubSpot | Permission Set 可复用；对象动作拆 View/Create/Edit/Delete；数据范围可选 All/Team/Own；可比较权限历史；资产限制可覆盖账号权限 | “角色模板 + capability + data scope”；权限比较器；显式 deny/资产限制优先 | 不采用“新权限默认打开”的升级行为；本项目必须新增权限默认 deny |
| Salesforce Marketing Cloud | 标准角色 + 自定义角色 + 单项权限；Viewer、Channel Manager、Security Admin、Content Editor/Publisher 分工；显式 deny 覆盖 grant，未授予默认 deny | Viewer 作为一等角色；安全管理与营销执行分离；内容创建/发布分权；deny 优先 | 不把多个标准角色盲目叠加；Salesforce 官方也提示角色冲突风险 |
| Google Ads | Email-only、Billing、Read-only、Standard、Admin 五级；Billing 与操作分离；manager account 与子账号范围分离 | 只读与财务专职角色简单清晰；账号层级范围明确 | 其粗粒度五级不足以覆盖内容审批、模型成本和临时客户访问 |

官方资料：

- [Shopify Roles](https://help.shopify.com/en/manual/your-account/users/roles/)
- [Shopify Store permissions](https://help.shopify.com/en/manual/your-account/users/roles/permissions/store-permissions)
- [Shopify Organization permissions](https://help.shopify.com/en/manual/organization-settings/users/organization-permissions)
- [HubSpot permission sets](https://knowledge.hubspot.com/user-management/create-permission-sets)
- [HubSpot user permissions guide](https://knowledge.hubspot.com/user-management/hubspot-user-permissions-guide)
- [Salesforce Marketing Cloud roles](https://help.salesforce.com/s/articleView?id=sf.mc_overview_roles.htm&language=en_US&type=5)
- [Salesforce role permission precedence](https://help.salesforce.com/s/articleView?id=sf.mc_overview_marketing_cloud_roles.htm&language=en_US&type=5)
- [Google Ads access levels](https://support.google.com/google-ads/answer/9978556)

### 竞品后的第一性原理结论

竞品常把“角色模板”作为管理入口，但真正可靠的是模板背后的权限与范围。大麦的差异点不是角色更多，而是必须同时覆盖 ChatGPT 插件、MCP、worker、平台控制面和客户数据面。因此后台应展示“为什么有权”的可解释结果，而不只显示角色名。

## 4. Strategy Kernel

**DIAGNOSIS：** 当前最大障碍是权限定义没有单一事实源，平台控制面与客户工作区数据面又在同一后台和 MCP 表面相遇。继续新增 `roles.includes` 会让 UI 与服务端持续漂移。

**GUIDING POLICY：** 以服务端版本化 permission catalog 为唯一授权语义，角色只作为可管理模板；平台角色与商家角色永不互相隐式升级，客户数据访问必须绑定工作区/品牌/店铺范围，平台侧只通过可撤销 JIT 票据进入。

**SOURCE OF POWER：** 这是链路系统的最弱环修复。插件、MCP、API、worker、RLS、后台和审计都依赖同一份权限 ID 后，新增功能只需登记一次并由契约测试强制覆盖，减少每次迭代的安全漂移。

**COHERENT ACTIONS：**

1. 冻结角色词典、permission ID、scope 和风险等级。
2. 建立服务端 Policy Decision Point（PDP）与各入口 Policy Enforcement Point（PEP）。
3. `ops.session` 返回有效权限、范围、义务和拒绝原因；前端只渲染，不再重新发明策略。
4. Ant Design 后台按平台控制面/商家工作区双工作台重组，并提供权限比较、JIT 和审计视图。
5. 用契约、API、RLS、worker、桌面浏览器和生产 OIDC 证据共同验收。

**WHAT WE ARE NOT DOING：** 不创建一个能永久读取所有客户正文的“超级管理员”；不以菜单隐藏代替鉴权；不为了 UI 重构取消现有 JIT、RLS、revision、idempotency 或审计保护。

## 5. 目标角色模型

### 5.1 平台角色模板

| 角色 | 主要职责 | 默认数据范围 | 禁止事项 |
| --- | --- | --- | --- |
| `platform_owner` | 单一平台所有者；所有权转移、break-glass、平台管理员授予 | platform | 不用于日常运营；客户正文仍需 JIT |
| `platform_admin` | 身份、租户、平台角色、会话、风险处置 | platform metadata | 不管账务定价、客户内容、发布 |
| `platform_ops` | 日常总览、跨租户聚合、平台连接健康、事故协同 | platform aggregate + 指定 workspace metadata | 默认不能读客户商品/素材/内容/prompt；不能退款 |
| `platform_support` | 工单、评论、客户沟通、受控 CRM 导出 | assigned workspace/ticket | 客户正文只在 JIT grant 内；不能更改平台配置 |
| `platform_finance` | 收款、对账、退款复核、模型结算、商业目录读取 | platform finance / assigned workspace | 不读客户内容；不能管理用户身份 |
| `platform_commercial_admin` | 套餐、Addon、优惠券、灰度、模型加价 | platform commercial | 不执行退款和客户发布 |
| `platform_rules_admin` | 平台规则包、媒体规格生命周期 | platform rules | 规则审批与起草默认分人 |
| `platform_model_admin` | 中转模型配置、readiness、预算与成本证据 | platform model metadata | 不查看业务 prompt/输出；账务冲正由 finance |
| `platform_security_auditor` | 全平台脱敏审计、安全 evidence、权限历史 | read-only platform audit | 任何业务写操作均拒绝 |
| `platform_release_admin` | 发布门禁、canary、feature flag 日常发布 | environment/release | 紧急开关要求 MFA；不管理客户内容 |

`platform_owner` 是 break-glass 角色，不在日常导航中出现。现有 `ops_admin`、Feature Flag 域 `reviewer` 和隐式 `platform_admin` 映射应迁移为上述明确角色，禁止运行时偷偷改名。

### 5.2 商家角色模板

| 角色 | 主要职责 | 默认范围 | 禁止事项 |
| --- | --- | --- | --- |
| `workspace_owner` | 工作区所有权、管理员授予、停用工作区、数据删除最终确认 | workspace | 不能管理平台身份/全局配置；最后 owner 不可停用 |
| `merchant_admin` | 成员、店铺、品牌、订阅和日常业务配置 | workspace | 不能授予 owner/platform role；高风险删除需 owner |
| `merchant_operator` | 商品、任务、营销活动、同步与自动化执行 | assigned brand/store | 默认不能发布最终确认、退款、成员管理 |
| `content_editor` | 素材、创意方向、内容生成、修改、导出 | assigned brand/store | 不能最终审批或发布 |
| `content_reviewer` | 内容审核、视觉选择、驳回、批准 | assigned brand/store | 不能改模型/账务/成员；不能审批自己创建的高风险版本 |
| `publisher` | 发布预览、逐项确认、暂停/恢复/失败重试 | assigned store | 不能创建内容或修改冻结版本 |
| `merchant_rules_admin` | 工作区规则、知识规则、学习建议治理 | workspace/brand | 不能改平台全局规则 |
| `merchant_finance` | 工作区账单、订单、对账、退款申请/执行 | workspace finance | 不读客户内容；不能改平台商业目录 |
| `workspace_auditor` | 工作区全域只读、审计与导出 | workspace read-only | 所有写操作拒绝 |

兼容别名：现有 `operator` → `merchant_operator`，`finance` → 按角色来源映射 `merchant_finance` 或 `platform_finance`，`support` → `platform_support` 或显式的 workspace support assignment。迁移期响应同时返回 canonical role 与 legacy alias，服务端审计只写 canonical role。

### 5.3 权限不是角色

权限 ID 使用稳定格式：`<plane>.<resource>.<action>`，例如：

- `platform.identity.suspend`
- `platform.feature_flag.emergency_set`
- `workspace.member.invite`
- `workspace.catalog.product.edit`
- `workspace.content.approve`
- `workspace.publish.confirm`
- `workspace.billing.refund`
- `customer_data.content.read_jit`

范围独立表达：`platform | workspace:<id> | brand:<id> | store:<platform>:<account> | self`。一名用户可以持有多个角色分配，但每个分配必须带 scope 和有效期；显式 deny、账号暂停和对象状态阻断优先于所有 grant。

## 6. 访问状态图例

| 代码 | UI 行为 | API 行为 |
| --- | --- | --- |
| `N` 无权 | 不显示导航；直接深链显示 403 权限页，不加载业务数据 | 403，稳定 error code |
| `R` 只读 | 显示页面和只读原因；按钮不渲染或明确禁用 | 仅 GET/list/read method 允许 |
| `W` 操作 | 显示日常写动作 | 允许写入，要求 reason/revision/idempotency 视具体动作 |
| `A` 审批/高风险 | 显示高风险动作与影响预览 | MFA/二次确认/双人审批中的适用义务必须满足 |
| `J` 临时授权 | 显示锁定内容、工单、申请入口、剩余时间和撤销 | 仅有效 JIT grant + exact scope + TTL 内允许 |
| `S` 仅本人 | 只显示本人订单/账单/用量 | actor-scoped 查询，不能升级到 workspace |

## 7. 运营后台页面-角色矩阵

缩写：`PO` platform_owner，`PA` platform_admin，`POP` platform_ops，`PS` platform_support，`PF` platform_finance，`PC` platform_commercial_admin，`PR` platform_rules_admin，`PM` platform_model_admin，`SA` platform_security_auditor，`PD` platform_release_admin；`WO` workspace_owner，`MA` merchant_admin，`MO` merchant_operator，`CE` content_editor，`CR` content_reviewer，`PB` publisher，`MR` merchant_rules_admin，`MF` merchant_finance，`WA` workspace_auditor。

| 后台模块 | PO | PA | POP | PS | PF | PC | PR | PM | SA | PD | WO | MA | MO | CE | CR | PB | MR | MF | WA |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 平台总览/聚合健康 | R | R | R | R | R | R | R | R | R | R | N | N | N | N | N | N | N | N | N |
| 工作区总览 | J | N | R | J | R | N | N | N | R | N | R | R | R | R | R | R | R | R | R |
| 平台身份、会话、风险 | A | W | R | N | N | N | N | N | R | N | N | N | N | N | N | N | N | N | N |
| 租户/工作区治理 | A | W | R | N | R | R | N | N | R | N | A | W | N | N | N | N | N | N | R |
| 工作区成员与权限 | J | N | J | N | N | N | N | N | R | N | A | W | R | R | R | R | R | R | R |
| 客服与 CRM | J | N | R | W/J | N | N | N | N | R | N | R | R | N | N | N | N | N | N | R |
| 事故中心 | A | R | A | W | R | N | N | R | R | W | R | R | R | R | R | R | R | R | R |
| 任务与内容聚合 | R | N | R | R | N | N | N | R | R | N | N | N | N | N | N | N | N | N | N |
| 客户任务/内容正文 | J | N | J | J | N | N | N | N | R* | N | R | R | W | W | W | R | W | N | R |
| 店铺/品牌/平台连接 | J | N | R/J | J | N | N | R | N | R | N | A | W | W | R | R | W | R | N | R |
| 规则与媒体规格 | R | N | R | N | N | N | A | N | R | N | R | R | R | R | R | R | W | N | R |
| 模型服务/成本证据 | R | N | R | N | R | R | N | W | R | N | R | R | R | R | R | R | R | R | R |
| Feature Flags/发布开关 | A | R | R | R | N | N | N | R | R | A | N | N | N | N | N | N | N | N | N |
| 存储容量与对账 | R | N | R | N | R | N | N | N | R | N | R | R | R | R | R | R | R | R | R |
| 平台商业目录/加价 | R | N | R | N | R | W | N | R | R | N | N | N | N | N | N | N | N | N | N |
| 工作区账务/订单/退款 | J | N | R | N | W | R | N | R | R | N | A | W | N | N | N | N | N | W | R |
| 审计中心 | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R | R |
| JIT 授权中心 | A | W | R | 申请 | N | N | N | N | R | N | A | R | N | N | N | N | N | N | R |

`R*`：平台安全审计只看脱敏 evidence 和权限事件，不看客户正文。`POP` 对客户任务/内容的 `J` 只用于指定支持/事故场景，不能因为其能看聚合就自动获得正文。

## 8. 插件全能力到后台治理矩阵

下表覆盖 `packages/contracts/src/mcp.ts` 全量方法所属能力族（方案起草时 231，本轮收口 240）。方法新增时若未登记到权限目录和一个后台治理落点，CI 必须失败。

| # | 插件/MCP 能力族（当前方法） | 商家侧默认权限 | 平台侧后台治理 | 关键强制条件 |
| --- | --- | --- | --- | --- |
| 1 | `merchant.start`, `merchant.first_value` | WO/MA/MO/CE 可执行 | POP 只看转化聚合；PS 按工单 J | 首次绑定 workspace；禁止跨租户 |
| 2 | `workspace.bootstrap` | 新用户受控创建，成为 WO | PA 管租户元数据 | 防重复、身份绑定、审计 |
| 3 | `workspace.health`, `workspace.metrics` | 工作区角色 R | POP/PM/SA R 聚合 | 不返回凭据或业务正文 |
| 4 | `workspace.interactive.confirm` | 有写权限角色 W | 平台角色不能借此绕过 JIT | 短时写会话、明确确认 |
| 5 | `workspace.commercial.*`, `workspace.usage.get` | WO/MA/MF R；WO/MA 更新 | PF/PC R，POP 聚合 R | 工作区范围、revision |
| 6 | `workspace.activate/deactivate`, `workspace.data.delete.request` | WO A | PA/POP 只处理平台流程，不替代 owner 意愿 | MFA、影响预览、冷静期/审批 |
| 7 | `ops.session` | 全角色 R 自己 | 全角色 R 自己 | 返回 canonical roles、effective permissions、scope、obligations |
| 8 | `ops.workspaces.list`, `ops.users.*`, `ops.user.*` | N | PA W/A，POP R，SA R | 自停用拒绝、会话撤销、不可变审计 |
| 9 | `ops.members.list`, `ops.member.*` | WO A；MA W；其余 R | PA 无默认客户成员权；POP J；SA R | 最后 owner、禁止提升到 platform role、revision |
| 10 | `ops.support.*` | WO/MA R | PS W/J，POP R/J，SA R | 工单绑定 workspace；CRM 导出脱敏、限量 |
| 11 | `ops.incident*` | 工作区角色 R/评论 | POP A，PS W，PD/PM 按域 W，SA R | 状态机、指挥官、SEV 高风险变更 |
| 12 | `ops.feature-flag*` | N | PD W/A，POP/PS R，SA R | 紧急关闭 MFA；环境 scope；revision/idempotency |
| 13 | `ops.audit.*` | WA/WO/MA R workspace | SA/POP/PF/PS R；导出按范围 | 平台聚合脱敏；禁止 wildcard cursor |
| 14 | `ops.data.delete.*` | WO 申请/取消/最终确认 | PA/SA R；授权数据治理人员 A | 双人审批、不可逆影响说明、执行证据 |
| 15 | `ops.growth.funnel`, `ops.alerts.*` | 工作区角色 R；有权运营 ack | POP R/W，PS/PM/PD 按域 R/W | 聚合脱敏；ack 必须 reason |
| 16 | `ops.commercial.*` | WO/MA/MF 仅看适用于本 workspace 的结果 | PC W，PF/PM R，POP R | 全局与 workspace rollout 分离、revision |
| 17 | `subscription.*` | 本人 `S`；WO/MA/MF workspace R/W | PF 只处理支付/异常 | server-owned price、幂等、降级生效期 |
| 18 | `billing.recharge.*`, `billing.transactions`, `billing.export` | 默认 S；WO/MA/MF 显式 workspace R | PF R/W；POP 仅脱敏对账 R | 个人与工作区余额语义分开 |
| 19 | `billing.refund`, `billing.usage.refund` | MF W；WO/MA A | PF W/A；POP N | 原单校验、二次确认、reason、幂等 |
| 20 | `billing.reconciliation*`, `billing.model-usage.*` | MF R；WO/MA R | PF W/A，PM R，POP R | provider evidence、未知状态可见、禁止伪造成功 |
| 21 | `platform.settings.*` | WO/MA R 当前可用平台；无全局写 | POP/PR W | 全局设置与店铺设置分离 |
| 22 | `platform.media.spec.*` | MR/CE/CR R 生效规格 | PR W/A，SA R | draft→approved→expired；生产 evidence 必填 |
| 23 | `platform.model.status`, `billing.status` | 工作区角色 R readiness | PM W/R，PF/POP R | 缺配置 fail-closed，不显示 ready |
| 24 | `platform.connect`, `platform.revoke`, `platform.store.alias.set` | WO/MA W/A；MO 仅受派店铺 W | POP J 处理支持；SA R | OAuth 主体、店铺 scope、撤销二次确认 |
| 25 | `platform.mapping.preflight` | WO/MA/MO/PB R/W | POP/PR 聚合 R；支持场景 J | 精确平台/账号/商品范围 |
| 26 | `brand-unit.*`, `brand.*` | WO/MA W；CE/MO 按 brand W；其余 R | POP/PS 仅 J；SA R evidence | brand role 与 workspace role 叠加，不扩大范围 |
| 27 | `catalog.search/categories` | 工作区角色 R，按 brand/store | POP/PS J | 分页、数据来源、敏感字段脱敏 |
| 28 | `catalog.import*`, `sku/product.update`, enable/disable, facts.confirm | MO W；MA W；CE 仅事实编辑相关 | POP/PS J；SA R audit | 批量上限、校验、版本冲突、禁用影响预览 |
| 29 | `canonical.product.consistency` | MA/MO/PB R；有权角色修复 | POP 只看聚合；支持 J | 不允许平台角色直接读取商品正文 |
| 30 | `asset.list/upload*/parse/scan/facts/preference/rights` | CE/MO W；CR/MR R；MA W | POP/PS J；SA R evidence | 上传隔离、扫描 receipt、版权证明、对象 scope |
| 31 | `asset.generation.confirm`, `catalog.image.generate/get/review` | CE 发起，CR 审核，MA R | PM 看 provider 元数据；POP/PS J | 费用预检、显式确认、候选归档与扫描 |
| 32 | `task.*`（create/answer/understand/request/sku/group/history/resume/clone/timeline） | MO/CE W；CR/PB/MR R | POP 只看汇总；PS J | 状态机、恢复幂等、客户正文隔离 |
| 33 | `campaign.batch.*` | MO W；PB pause/resume/retry；CR R | POP 汇总 R；PS J | 批次 revision、失败项单独重试、审批门禁保留 |
| 34 | `creative.*`, `task.select_direction`, `task.plan.confirm` | CE/MO W；CR R/A | POP/PS J | 方向与计划显式确认、锁定字段 |
| 35 | `content.generate/codex.*` | CE/MO W | PM 只看模型元数据；POP/PS J | 中转鉴权、usage/cost/error evidence、无空结果冒充成功 |
| 36 | `content.review*`, `visual.select`, approve/modify/restore | CE 编辑；CR A；MA R/A | POP/PS J | 创建者与高风险审批者分离、版本 revision |
| 37 | `content.versions/diff/export`, `deliverable.list` | 工作区角色 R；导出按 brand | POP/PS J；SA 仅审计 evidence | 水印/脱敏/限量导出 |
| 38 | `publish.prepare/confirm/get` | PB W/A；CR/MA R | POP 只看汇总；PS J | 预览冻结、逐项确认、平台 readiness |
| 39 | `publish.batch.*` | PB W/A；MO 可 prepare 不可最终 confirm | POP 汇总 R；PS J | 逐项结果、暂停/恢复、未知态禁止当成功 |
| 40 | `sync*`, `catalog.sync*` | MO/MA W；PB R | POP 看平台健康；PS J | account scope、重试幂等、游标/版本 |
| 41 | `automation.policy.*`, `automation.scan/tick/pause` | MA/MO W；PB/WA R | POP 只看聚合与系统健康；PS J | 自动化不能绕过人工发布和付费确认 |
| 42 | `rule.*` | MR W/A；其余 R | PR 管平台规则；POP R | shared/global 与 workspace 私有严格分离 |
| 43 | `knowledge.rule/asset.*`, `knowledge.feedback.record` | MR/CE W；MO/CR R | POP/PS J；SA R audit | 数据来源、版权、workspace/brand scope |
| 44 | `knowledge.learning.*`, `knowledge.competitor.*` | MR/CR W/A；CE/MO R | POP 仅聚合；PS J | 建议不自动生效；竞品来源与差异化证据 |
| 45 | `feedback.*` | 工作区成员 S/W；MA/MR R | POP 聚合 R；PS J | 反馈不得泄露其他用户内容 |
| 46 | `delivery.bundle.verify` | PB/CR/MA R | POP/PD 看发布 evidence；SA R | digest、版本、不可把静态文件当已发布 |
| 47 | `multimodal.generate/image.edit/video.*`, `generation.get` | CE/MO W；CR R/A | PM 看 provider/成本；POP/PS J | 五模态中转、配额、成本、拒绝/空响应/超时显式 |
| 48 | `ops.tasks/brand-units/model-usage/marketing.summary` | N | POP/PM/PF/SA 按域 R | 只返回聚合计数，不含客户正文/对象 ID |
| 49 | `ops.marketing.queue*`, visual/retry/revision/ack | MO/CE/CR/PB/MR/PS 按职责 W | POP 单独角色 N；若同一人有 workspace role 则按该角色，不按 POP | 工作区成员身份或精确 JIT；平台角色不能隐式升级 |
| 50 | `ops.marketing.image.reconcile/evidence/archive/billing.audit` | MA/MO/CR/MF 按职责 R/W | PS J；PF/PM R；POP 聚合 R | 安全扫描、provider request、action ledger、usage 关联 |
| 51 | `ops.storage.reconciliation.list` | WO/MA/MF/WA R workspace | POP/PF/SA R platform aggregate | 不展示对象字节、下载 URL、凭据 |

说明：表内“平台 J”意味着必须先获得一个精确到 actor、workspace、scope、TTL、工单/事故理由的授权；它不是常驻角色权限。

## 9. 高风险动作与职责分离

| 动作 | 发起者 | 审批/执行 | 强制义务 |
| --- | --- | --- | --- |
| 平台所有权转移 | PO | 另一受信任主体/人工安全流程 | 强 MFA、冷静期、不可变 evidence |
| 授予平台角色 | PA | PO 或第二名 PA | 不能授予自己没有的 capability；到期时间可选 |
| 停用平台身份/全会话撤销 | PA | PA；不可自停用 | reason、revision、idempotency、审计 |
| 平台运营读取客户正文 | POP/PS 申请 | WO/MA 或受信任支持审批系统 | exact workspace/scope、≤15 分钟、可撤销、每次访问审计 |
| 工作区最后 owner 变更 | WO | 先转移 owner，再停用旧 owner | 事务保护；禁止留下 0 owner |
| 发布最终确认 | PB | 高风险内容由 CR 审批 | 冻结预览、逐项确认、平台 readiness |
| 退款/用量冲正 | MF/PF | 高金额双人审批 | 原单、金额、reason、idempotency、provider evidence |
| 数据删除 | WO | 第二审批人/数据治理 | 冷静期、影响清单、可恢复性、执行证明 |
| Feature Flag 紧急关闭 | PD | 单人可执行但强 MFA | reason、环境 scope、自动告警；恢复仍需 revision |
| 平台规则/媒体规格生效 | PR 起草 | 另一 PR 审批 | 来源 digest、有效期、不可同人自批高风险版本 |
| 模型加价/商业定价 | PC | PF 复核 | 生效时间、影响租户、回滚版本、审计 |

## 10. 后台信息架构与 Ant Design 产品输入

### 10.1 双工作台，不再伪装成单一“全平台”

```text
大麦运营中心
├── 平台控制台（只有平台角色）
│   ├── 平台总览
│   ├── 身份与租户
│   ├── 客服与事故
│   ├── 平台连接与规则
│   ├── 模型与商业化
│   ├── Feature Flags / 发布门禁
│   └── 平台审计 / JIT 授权
└── 商家工作区（只有有效 workspace membership）
    ├── 工作区总览
    ├── 成员与权限
    ├── 品牌 / 店铺 / 商品 / 素材
    ├── 任务 / 内容 / 活动
    ├── 审核 / 发布 / 自动化
    ├── 规则 / 知识治理
    ├── 账务 / 模型用量
    └── 工作区审计
```

同一用户若同时有平台与商家角色，必须用工作台切换器主动切换；不允许把两套权限在同一页自动合并。切换时清空旧 scope 的请求、缓存、筛选和选中对象。

### 10.2 桌面布局

- `Layout`：固定左侧域导航 + 顶部上下文栏 + 主内容区；不把手机抽屉作为验收项。
- 顶部必须始终展示：工作台类型、当前 workspace/brand/store、有效角色、只读/JIT 状态、授权剩余时间。
- 页面统一：`PageHeader`/Breadcrumb、权限说明条、KPI cards、筛选区、表格、详情 Drawer、危险操作 Modal。
- 权限管理用 `Tree`/分组 `Table` 呈现 capability；列为 View/Create/Edit/Delete/Approve/Export/Admin，另有 scope 和 obligation。
- “权限比较”使用两列/三列 Diff Table，可比较用户、角色模板、变更前后。
- 403 深链不是空白页：显示缺失 permission ID、当前 scope、申请入口或联系谁；绝不显示敏感对象是否存在。
- `R` 页面保留数据与权限说明，不能把所有按钮一律 disabled 后无解释。
- `J` 页面默认只显示脱敏壳和申请入口；授权后在明显的警示色上下文中显示，过期自动清空数据并返回锁定态。
- 列表状态必须覆盖 loading/empty/error/partial/stale/forbidden；partial 必须列出未纳入 workspace 数量。

### 10.3 角色管理主流程

```text
选择用户
  → 查看平台角色 / 工作区角色分栏
  → 选择角色模板
  → 选择 scope（workspace/brand/store）
  → 展开“将获得 / 将失去 / 需要审批”差异
  → 填写原因和有效期
  → 高风险时第二审批人确认
  → 提交 revision-protected 变更
  → 展示生效状态、审计 ID、会话是否需重登/撤销
```

### 10.4 JIT 客户数据访问主流程

```text
平台客服/运营打开受控对象
  → 看到脱敏概要与“申请临时访问”
  → 选择工单/事故、workspace、read/write scope、时长
  → owner/admin 或受信系统审批
  → 获取短时 grant；顶部持续倒计时
  → 每次 API 请求校验 exact scope 并写访问审计
  → 到期/撤销/切换 workspace 立即清空正文与缓存
```

## 11. 服务端与数据契约（给架构/后端）

### 11.1 单一权限目录

建议新增版本化 catalog，至少包含：

```ts
type PermissionDefinition = {
  id: string;
  plane: 'platform' | 'workspace' | 'customer_data';
  resource: string;
  action: 'view' | 'create' | 'edit' | 'delete' | 'approve' | 'publish' | 'export' | 'admin';
  allowedScopes: Array<'platform' | 'workspace' | 'brand' | 'store' | 'self'>;
  risk: 'low' | 'medium' | 'high' | 'critical';
  obligations: Array<'reason' | 'revision' | 'idempotency' | 'confirmation' | 'mfa' | 'two_person' | 'jit_grant'>;
  auditEvent: string;
};
```

HTTP、MCP、worker execution-check 和前端 session projection 必须引用同一 permission ID。`requireOperationsRole` 可保留为兼容适配器，但最终只能调用统一 `authorize(principal, permission, resource, context)`。

### 11.2 建议数据模型

- `role_templates(id, plane, name, system_managed, revision, status)`
- `permission_definitions(id, plane, resource, action, risk, obligations_json, catalog_version)`
- `role_template_permissions(role_id, permission_id, effect)`
- `principal_role_assignments(principal_id, role_id, scope_type, scope_id, valid_from, expires_at, granted_by, reason, revision)`
- `principal_permission_denies(principal_id, permission_id, scope_type, scope_id, reason, expires_at)`
- `access_requests(id, requester, workspace_id, permissions_json, ticket_ref, status, expires_at, revision)`
- `access_grants(id, request_id, actor_id, workspace_id, scopes_json, issued_at, expires_at, revoked_at, signer_key_id)`
- 继续复用 operation audit，但新增 `decision_id`、`catalog_version`、`matched_role_assignments`、`obligations_satisfied`。

所有租户表继续 FORCE RLS。平台聚合表/视图只输出经过定义的脱敏字段，不能通过 `platform_scope` 直接放宽客户明细表 RLS。

### 11.3 `ops.session` 目标响应

```json
{
  "actor_id": "actor_1",
  "workspace_id": "ws_1",
  "workbench": "workspace",
  "roles": ["merchant_operator", "content_editor"],
  "effective_permissions": [
    {"id":"workspace.task.edit","scope":{"type":"brand","ids":["brand_1"]},"effect":"allow","obligations":[]},
    {"id":"workspace.publish.confirm","scope":{"type":"workspace","ids":["ws_1"]},"effect":"deny","reason_code":"ROLE_PERMISSION_MISSING"}
  ],
  "temporary_grants": [],
  "catalog_version": "2026-08-31.1"
}
```

前端只能用该响应做预呈现；API 仍在每个请求重新授权，禁止信任前端 permission claim。

## 12. 失败与错误注册表

| Codepath | 失败 | API code | 用户看到 | 审计/告警 |
| --- | --- | --- | --- | --- |
| 会话解析 | 无角色或 membership 未激活 | `MEMBER_NOT_ACTIVE` / `WORKSPACE_MEMBERSHIP_REQUIRED` | 无访问权限，不加载页面数据 | 登录/拒绝事件 |
| 权限目录 | catalog 缺失/版本不支持 | `PERMISSION_CATALOG_UNAVAILABLE` 503 | 权限服务不可用，全部写入锁定 | P1 告警 |
| Scope 匹配 | workspace/brand/store 不匹配 | `RESOURCE_SCOPE_FORBIDDEN` 403 | 无权访问当前范围 | 拒绝审计，不泄露对象存在性 |
| JIT | 缺票据/过期/签名错/scope 错 | 现有 `OPS_CUSTOMER_ACCESS_*` | 临时授权无效或已过期 | 失败计数；成功访问逐次审计 |
| 角色变更 | stale revision | `ROLE_ASSIGNMENT_REVISION_CONFLICT` 409 | 权限已变化，刷新比较后重试 | 记录冲突指标 |
| 高风险义务 | 缺 MFA/审批/原因 | `AUTHORIZATION_OBLIGATION_REQUIRED` 403/409 | 列出缺失步骤，不提交 | 审批链审计 |
| 数据层 | RLS 拒绝 | 稳定映射为 403 | 无权访问，不显示“没有数据” | 高优先级安全指标 |
| 前端 chunk/API 部分失败 | 页面投影不可用 | 领域错误 | 显示 partial/error，保留其他域 | trace/request ID |
| 权限变更传播 | 旧会话缓存 | `SESSION_PERMISSION_STALE` 409 | 提示刷新/重新登录 | 传播时延指标 |

禁止 catch-all 后返回空数组；403、503 和真实 empty 必须是三种不同 UI 状态。

## 13. 优先级与实施分期

使用 ICE 评估“安全/用户影响、证据置信度、实施容易度”，分数用于排序而非承诺工期。

| 排名 | 工作项 | Impact | Confidence | Ease | ICE | 阶段 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| 1 | 权限目录 + 全量 MCP/页面动作清单 CI | 10 | 9 | 6 | 540 | P0 |
| 2 | 服务端统一 authorize/PDP，MCP/HTTP/worker PEP | 10 | 9 | 4 | 360 | P0 |
| 3 | 平台/商家角色与 scope 数据迁移，默认 deny | 10 | 8 | 4 | 320 | P0 |
| 4 | `ops.session` effective permission 投影 | 9 | 9 | 6 | 486 | P0 |
| 5 | 修正 Sidebar 范围与双工作台 | 9 | 10 | 7 | 630 | P0 |
| 6 | 页面内 R/W/A/J 状态与深链 403 | 9 | 9 | 6 | 486 | P0 |
| 7 | JIT 申请/审批/撤销后台 | 10 | 8 | 4 | 320 | P0 |
| 8 | 角色模板、权限比较、变更历史 UI | 8 | 8 | 5 | 320 | P1 |
| 9 | 高风险双人审批与 MFA obligation | 9 | 7 | 3 | 189 | P1 |
| 10 | 全链路真实 OIDC/RLS/worker/桌面验收 | 10 | 9 | 3 | 270 | P0 发布门禁 |

### Phase 0：冻结语义

- 从 `MCP_METHODS` 生成全量 MCP 方法与所有页面动作的 permission manifest。
- 决定 canonical role、legacy alias 和迁移规则。
- CI 检查：新增 method/action 未登记、页面角色硬编码、后端 method 无授权声明时失败。

### Phase 1：服务端先行

- 实现 permission catalog、role assignment、scope/deny/obligation。
- 将 API/MCP/worker 改为统一 PEP；保留现有 JIT、RLS、审计和 revision。
- `ops.session` 投影 effective permissions；新旧角色双读，审计只写 canonical。

### Phase 2：Ant Design 工作台重构

- 建立双工作台 Layout、上下文栏、permission-aware route/meta。
- 按 13 个域迁移 Page/Section；不做大而全单组件。
- 权限管理、比较、JIT、审批和审计页面组件化。
- 删除散落 `roles.includes` 前必须有同等或更强 API/测试覆盖。

### Phase 3：强验证与切换

- 两个真实测试工作区、多品牌/店铺、多角色、跨租户负向矩阵。
- OIDC 角色/成员不一致、身份暂停、JIT 过期/撤销、并发角色变更、RLS 旁路、worker 执行票据全部验证。
- 先 shadow-evaluate 新旧策略差异，只记录不生效；差异归零后按 workspace 灰度，最终删除 legacy role 推导。

## 14. 验收矩阵

### 契约与单元

- 每个 MCP 方法恰好映射一个或多个 permission ID，且 scope/obligation 明确。
- 每个 Ops route、页面动作和后台按钮来自 manifest，不允许自由字符串角色判断。
- 角色模板快照测试、显式 deny 优先、多个角色合并、scope 交集、JIT TTL、权限目录版本不匹配。

### API/MCP/worker

- 对每个角色至少一条允许和一条拒绝；关键对象做跨 workspace、跨 brand、跨 store IDOR 负测。
- 平台聚合响应字段白名单测试，确保无正文、prompt、对象 ID、URL、凭据。
- worker 在角色被撤销、授权过期或对象 revision 改变后不得继续执行旧授权任务。
- HTTP 与 MCP 对同一业务动作必须得到相同授权结论和 error code。

### PostgreSQL/RLS

- 使用真实 Postgres 角色执行正/负 SQL probe；应用层授权通过但 RLS scope 不匹配仍必须拒绝。
- 平台聚合只读 view 与客户明细表权限分离；`merchant_ops` 的 platform scope 不能变成客户正文 wildcard。
- 迁移前后角色分配数量、owner 唯一性、审计链和回滚脚本可核对。

### 桌面浏览器

- 固定 1280/1440 桌面视口，覆盖平台工作台和商家工作区；移动端不作为验收项。
- 每个角色验证导航域、深链、只读、写入、高风险、JIT、空/错/partial/stale 状态。
- 切换 workspace/工作台时旧正文、请求和缓存不可残留。
- 权限变化后的 session 刷新、重登录提示和操作中断可解释。

### 容器与上线门禁

- API、ops-ui、worker、Postgres、Redis 健康不等于权限验收通过；还要有真实 OIDC 和真实角色目录证据。
- 发布 canary 必须包含：平台角色无 JIT 读取客户正文返回 403；商家 A 读取商家 B 返回 403；合法 scoped 操作返回 2xx；审计事件落库。
- 缺 permission catalog、OIDC claim mapping、JIT signer、RLS migration 或 audit sink 任一项，productionGate fail-closed。

## 15. 给架构、UI、前后端的明确输入

### 给架构师

1. 以 permission catalog + PDP/PEP 为中心，不以“角色枚举越来越大”为中心。
2. 平台控制面与客户数据面建立独立数据流图和 trust boundary。
3. 明确角色分配、scope、deny、JIT、审批、审计和 RLS 的优先级与事务边界。
4. 设计 legacy role 双读、shadow decision、灰度与回滚，不能一次性切断现有插件链路。

### 给 UI/UX 设计师

1. 先设计工作台/范围感知，再设计表格视觉；用户任何时刻都要知道“我是谁、在哪个范围、为什么只读”。
2. 完成 13 个域的 `loading/empty/error/partial/stale/forbidden/read-only/JIT` 状态图。
3. 角色管理必须有权限差异预览；JIT 必须有申请、审批、倒计时、撤销和过期后的数据清除体验。
4. 使用 Ant Design token 与组件，不继续堆全局 CSS；只优化桌面密度和键盘可达性。

### 给前端工程师

1. 建立 `OpsRouteMeta`/`PermissionGate`/`ScopeBanner`/`ForbiddenResult`/`JitAccessPanel` 共用组件。
2. `visibleOpsDomains` 读取服务端 `effective_permissions`；移除 Sidebar 的全平台硬编码文案。
3. 请求层在工作台/scope 切换时 abort in-flight 请求并清缓存；403 不可降级为空数组。
4. 页面内动作使用 permission ID，不再新增 `roles.includes`。

### 给后端工程师

1. 对 `MCP_METHODS` 的全量方法生成/维护 manifest，并将 HTTP/MCP/worker 全部接入统一授权器。
2. 不破坏现有 `OPS_CUSTOMER_ACCESS_*` fail-closed 逻辑；把它接入统一 obligation，而不是删掉重做成永久角色。
3. 将 `platform_ops → platform_admin` 这类隐式领域映射替换为 canonical permissions。
4. 所有权限变更和敏感动作写 actor、scope、matched policy、catalog version、reason、revision、idempotency 与 evidence。

## 16. 争议点与推荐决策

1. **平台管理员是否可以直接读取客户数据？** 推荐“不可以”。平台 admin 管身份与控制面；客户正文只能 JIT。否则平台/商家分层失效。
2. **一人单角色还是多角色？** 推荐“多角色分配 + 明确 scope”，但 UI 使用受管理模板降低复杂度。现有单值 `MemberRole` 无法表达内容编辑 + 发布者等真实职责。
3. **平台运营是否继续全域导航？** 推荐拆成平台工作台的全域“聚合/控制面可见”，客户明细域显示受控入口；不能把全域导航等同于全数据权限。
4. **高风险动作是否全部双人审批？** 推荐只对所有权、数据删除、高金额退款、平台规则生效、定价/加价和客户数据写 JIT 使用双人审批；紧急 flag 关闭允许强 MFA 单人执行并即时告警。
5. **自定义角色何时开放？** 推荐 P1 后期，在 permission catalog 稳定且权限比较器可用后开放；P0 只提供系统模板，避免迁移期组合爆炸。

## 17. NOT in scope

- 手机、平板布局与触控交互。
- 新电商平台、新营销能力或自动发布绕过人工确认。
- 生产密钥、支付、平台 OAuth 或模型 provider 的虚构 evidence。
- 删除历史业务/容器数据来让权限迁移看起来通过。

## 18. 完成定义

这份产品方案完成了目标角色、全功能治理映射、页面可见/只读/可操作/JIT 矩阵、竞品模式、UI 信息架构、服务端权限契约、实施优先级和验收门禁。它不证明代码已落地或生产已可发布。只有 Phase 0-3 的实现与真实环境证据全部满足，才能把该目标标记为完成。
