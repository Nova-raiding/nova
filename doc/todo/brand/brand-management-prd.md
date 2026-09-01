# 品牌信息治理方案

## 目标

让商家能在 ChatGPT 插件和桌面运营工作台中看懂、配置并验证自己的品牌主链：

`品牌 → 平台 → 店铺 → 标准商品 → 店铺商品 → 内容任务 → 发布结果`。

品牌信息必须来自已确认的数据和持久化的 `brand-unit.*` 接口；不得让模型自行补全品牌事实。

## 角色与权限

| 角色 | 可见范围 | 允许动作 |
| --- | --- | --- |
| 工作区成员 | 当前工作区内被授权的品牌 | 查看品牌树、绑定店铺、创建标准商品/刊登、发起后续任务（由品牌角色决定） |
| 工作区管理员 | 当前工作区全部品牌 | 上述动作、授予品牌角色 |
| 平台运营 | 全平台聚合指标、连接和风险状态 | 查看数量/状态，进入受控支持流程；不直接读取品牌名、商品、内容或令牌 |

API 的租户范围、品牌访问角色和服务端授权是最终门禁；前端只负责减少无权限请求和解释阻断原因。

## 交互闭环

1. 空状态提示“创建品牌”，使用 `brand-unit.create`，成功后保留 revision 和审计证据。
2. 选择品牌后按平台分组绑定店铺，使用 `brand-unit.bind-store`，携带 `expected_revision`，冲突时要求刷新而不是覆盖。
3. 创建标准商品并建立刊登，使用 `brand-unit.product.create`、`brand-unit.listing.create`。
4. 品牌树展示绑定结果；点击店铺进入商品/刊登和任务入口。
5. 后续生成、审核、发布都必须带品牌/标准商品/刊登链路；失败状态显示错误码、下一步和重试入口。
6. 每次写操作都能从审计中心追溯 actor、workspace、brand、revision、请求结果。

## 数据来源与一致性

- 品牌树：`workspace.health` 的 `capabilityCards.brandNavigation`，它由 `brand-unit` 持久化仓库构建并按品牌访问权限过滤。
- 品牌明细：`brand-unit.list`；刊登：`brand-unit.listing.list`。
- 品牌资料/语气/视觉规则：`brand.get`、`brand.extract`、`brand.upsert`；这些是内容生成约束，不替代品牌单元和店铺绑定。
- 任务和发布必须沿用 canonical product/listing 关联；无法形成完整链路时 fail-closed，并返回下一步动作。

## 平台运营边界

平台运营的后续版本提供脱敏聚合：工作区数、品牌数、绑定店铺数、未绑定数、链路阻断数和最近失败数。聚合接口不得返回品牌名称、商品标题、内容、素材、平台令牌或跨租户可复用的明细 ID。需要查看具体品牌时，必须切换到明确的工作区授权会话。

## 页面设计

- 使用既有 Ops Console 的 Ant Design、数据密集型布局和高对比度状态标签。
- “平台连接”页面新增“品牌、平台与店铺”卡片，品牌为一级标题，平台为蓝色标签，店铺为可识别的店铺标签。
- 空、加载、错误、无权限和 revision 冲突都必须有可解释状态；不使用 hover-only 操作。
- 桌面优先；键盘可聚焦，图标有可访问名称，状态不能只靠颜色表达。

## 验收与发布门禁

- API：品牌树按工作区隔离；无品牌权限的成员看不到该品牌；平台运营不会收到品牌明细。
- UI：工作区角色能看到真实品牌树；空状态和 API 错误可恢复；平台角色不因租户接口被动产生 403 噪声。
- 运行：类型检查、品牌/权限 E2E、Ops Console 单测、桌面浏览器验收、容器健康检查和 CodeGraph 同步全部通过。
- 配置缺失、模型中转失败、店铺未授权、品牌链路不完整必须显式阻断，不能伪造成功。

## 当前代码落地与证据（2026-08-31）

当前品牌资料与品牌单元主链已经有代码实现，但本文件仍保留在 `doc/todo/brand`，因为上线证据尚未闭合，不能迁移到 `doc/done`。

| 能力 | 代码落地 | 当前证据 | 结论 |
| --- | --- | --- | --- |
| 品牌资料读取、候选抽取、商家确认后保存 | `demo/merchant-studio/src/App.tsx`、`apps/api/src/server.ts`、`packages/application/src/service.ts` | `brand-extraction.e2e.test.ts`、`brand-review.e2e.test.ts`；4 项通过 | 已实现，待真实环境验收 |
| 品牌视觉规则与字体/主体限制 | `packages/application/src/service.ts` | 品牌视觉规则 E2E 覆盖“未授权字体阻断→授权后继续” | 已实现，待真实中转链路证据 |
| 品牌→店铺→标准商品→刊登主链 | `packages/application/src/brand-units.ts`、`packages/persistence/src/brand-unit-repository.ts`、MCP `brand-unit.*` | CodeGraph 已同步，相关 API/MCP 测试已有 | 已实现，待 PostgreSQL/RLS 多租户实测 |
| HTTP 品牌资料成员与写入权限 | `enforceBrandProfileHttpAccess`；GET/POST/PUT `/v1/brand-profile*` | `security.e2e.test.ts` 覆盖无成员、support 越权、owner 成功、platform_ops 无授权；47 项通过 | 已实现并闭合代码安全门禁 |
| 平台运营客户数据隔离 | HTTP 共享客户数据授权预检 + MCP 授权边界 | 平台运营边界测试覆盖；无临时授权返回 `OPS_CUSTOMER_ACCESS_REQUIRED` | 已实现，待真实授权会话浏览器验收 |
| 桌面品牌树、空/错误/无权限交互 | Ops Console / Merchant Studio 相关组件 | 代码与静态契约已有；桌面真实多角色、多状态验收未完成 | 未完成 |

本次验证：类型检查通过；品牌抽取/审核 E2E 4/4 通过；安全与访问控制 E2E 47/47 通过。仍未满足迁移门禁的项目包括：真实 PostgreSQL/RLS、多副本并发、真实 ChatGPT 插件入口→MCP 链路、带临时授权的 platform_ops 浏览器验收、生产配置与发布门禁证据。因此本文件暂不迁移。

## 增量实现与验证（2026-08-31）

- `BrandTreeSection` 现在显式区分加载、接口错误和真实空态；错误态提供可恢复的重试入口，不再把 `workspace.health`/店铺数据集失败渲染为“当前工作区没有品牌”。
- Ops Console 的平台运营会话（含 `platform_ops` 角色）不渲染客户品牌明细树，仅保留平台级脱敏的品牌治理聚合；工作区成员会话仍从 `workspace.health.capabilityCards.brandNavigation` 读取品牌树。
- `ops.alerts.list` 的 `platform_scope=platform` 同样只返回按告警编码/级别/平台/状态/通知态聚合的数量和脱敏下一步；平台运营不能用店铺、实体类型或实体 ID 筛选客户明细，安全 E2E 已覆盖。
- `ops.stores.list` 的 `platform_scope=platform` 已改为按平台、授权状态、数据模式和读写能力聚合，不返回 workspace/account 标识；聚合行在运营台只读，不能执行改名或撤销。
- Ops Console 全量回归：61 个测试文件、272 项通过；类型检查通过；`npm run build:ops-console` 通过；`git diff --check` 通过；CodeGraph 已同步（778 files / 10,873 nodes / 40,493 edges）。
- 发布门禁回归：55 个测试文件通过、1 个跳过；319 项通过、6 项跳过。输出中的 source-manifest 失败行属于测试内置的负向断言，不是门禁失败。
- 本增量只收紧展示边界和状态语义，未改变 API/MCP 授权门禁，也未将真实 PostgreSQL/RLS、平台运营临时授权浏览器验收或生产外部依赖误标为完成；文档继续保留在 `doc/todo/brand`。

## 店铺导航增量（2026-08-31）

- 品牌树店铺节点已补为键盘可达的明确按钮；点击后设置平台/店铺营销队列筛选、刷新队列并跳转任务页，复用现有 Ops Console 数据链路。
- Ops Console workspace 测试 61 个文件、275 项通过，类型检查与生产构建通过；完成文档见 [`doc/done/brand/brand-tree-store-navigation-2026-08-31.md`](../../done/brand/brand-tree-store-navigation-2026-08-31.md)。
- 品牌树仍不能整体迁移：真实 OIDC、PostgreSQL/RLS、真实店铺数据和正式 ChatGPT 宿主验收未完成。

## 2026-08-31 真实桌面深链复核

- 在本地 Compose 真实运营台执行 `ops-deeplink.spec.js`：15/15 通过，覆盖 13 个一级域的深链刷新、导航 `pushState`、前进/后退及旧 hash 迁移；“平台连接”品牌树所在域的路由保持稳定。
- 该结果补强桌面路由证据，但不等价于品牌树多角色数据验收：本轮未获得真实 OIDC、平台运营临时授权、生产 PostgreSQL/RLS、真实店铺数据或正式 ChatGPT 宿主证据。
- 因此品牌管理整体继续保持 `TODO / NO-GO`；已完成的店铺导航子能力仍归档在 `doc/done/brand/brand-tree-store-navigation-2026-08-31.md`，未完成部分不迁移。

## 2026-08-31 品牌树无权限状态增量

- `BrandTreeSection` 新增 `canRead` 门控；缺少 `customer.content.read` 时显示带 `role="alert"` 的“当前账号无权读取品牌树”，明确说明这不是空结果，并提供切换授权工作区/联系管理员的恢复路径。
- 工作区有权限时继续显示真实品牌树；接口错误、加载中和真实空工作区仍保持独立状态。
- Ops Console 页面与 Canonical 冲突队列回归 16/16，类型检查、生产构建和 `git diff --check` 通过；真实 `ws_demo` 桌面验收显示品牌/店铺且无 4xx。
- 该增量完成代码和本地桌面证据，但真实 OIDC 角色切换、生产 PostgreSQL/RLS、多副本及正式 ChatGPT Host 证据仍缺，品牌管理整体继续 `TODO / NO-GO`，不迁移本文件。

## 2026-08-31 品牌空状态创建入口增量

- 品牌树真实空状态现在在具备 `customer.content.update` 时提供带标签的品牌名称输入和“创建品牌”按钮，提交调用模型层真实 `brand-unit.create`，成功后重新加载 `workspace.health`；创建失败显示可读屏告警并保留输入，避免误报成功。
- 缺少读取权限时仍优先显示权限阻断，不渲染创建表单；平台工作台不渲染客户品牌树。
- Ops Console 页面回归 16/16、全局类型检查、Compose 资源门禁、Ops Console 生产构建和 diff check 通过。
- 当前只证明本地代码与 Compose 行为；真实 OIDC 角色切换、生产 PostgreSQL/RLS、多副本、正式 ChatGPT Host 和生产审计证据仍缺，品牌管理整体继续 `TODO / NO-GO`。

## 2026-08-31 品牌店铺绑定入口增量

- 品牌卡片现在使用 `workspace.health.storeDirectory` 中真实可读、未撤销且尚未绑定的店铺作为候选；已绑定或 `refresh_required/revoked` 店铺不会出现在绑定选项中。
- 提交调用真实 `brand-unit.bind-store`，携带品牌当前 `revision`、明确 `brand_id/platform/account_id` 和审计 reason；服务端仍执行 workspace、品牌 editor 权限和平台账号归属校验。
- 服务端品牌树返回 revision，客户端在 revision 冲突时保留失败告警并要求重新加载，避免覆盖并发绑定。
- Ops Console 页面回归 17/17、全局类型检查、API/OPS UI 镜像构建、Compose 资源门禁和 diff check 通过；只读运行态 `workspace.health` 返回品牌 revision 与 6 个店铺，API/双副本健康。
- 未对演示数据库执行绑定写入，避免污染业务 fixture；品牌整体仍因真实 OIDC、生产 PostgreSQL/RLS、多副本并发、正式 ChatGPT Host 和外部平台证据缺失保持 `TODO / NO-GO`。

## 2026-08-31 商品/刊登主链展示增量

- Merchant Studio 商品行现在同时展示 canonical 状态、读取模式、规范商品 ID、店铺刊登 ID 与刊登数量；`legacy_only/conflict/blocked` 继续禁止进入任务/发布动作。
- 定向回归 3 个文件、8/8 通过，全局类型检查与 Merchant Studio 生产构建通过。
- 该增量只完成桌面证据可见性；标准商品/刊登服务端修复动作仍要求 `platform_ops`、交互确认和显式输入，真实多角色与生产链路未闭合，品牌管理整体仍保持 `TODO / NO-GO`。

## 2026-08-31 品牌树写操作失败恢复增量

- `BrandTreeSection` 对 `brand-unit.create` 与 `brand-unit.bind-store` 的回调返回 `false` 增加显式失败处理；请求未完成时保留输入/店铺选择，并在对应操作区域显示 `role="alert"`，提示检查权限、店铺状态或 revision 后重试。
- 新增品牌树交互契约测试；品牌树与 Stores 页面定向回归 12/12 通过，Ops Console 生产构建通过，`ops-ui` Compose 镜像已重建并重启。
- 桌面浏览器复核：`ops.spec.js` 4/4 通过（含无凭据、401 会话门禁）；全域巡检 1 项因现有演示会话在“客服与 CRM”导航文案/可见性不一致而失败，未将其计入品牌树上线证据。
- 该增量只闭合本地 UI 的失败语义和恢复交互；真实 OIDC 多角色、生产 PostgreSQL/RLS、并发 revision 冲突、正式 ChatGPT Host 与外部平台数据证据仍缺，品牌管理整体继续 `TODO / NO-GO`，不迁移本文件。

## 2026-08-31 品牌资料提取确认桌面验收

- Merchant Studio 通过受控桌面 API 响应复核 `brand-profile/extract → 商家逐字段确认 → brand-profile PUT` 主链：提取候选不会自动落库，未勾选的品牌定位不会进入保存 payload，保存结果展示品牌 revision。
- `merchant-structured-dialogs.spec.js` 品牌资料用例 1/1 通过；该文件完整回归 11/11 通过；Merchant Studio TypeScript 与生产构建通过。
- 该证据使用本地浏览器和受控 fixture API，只证明交互和 HTTP payload 约束，不证明真实模型提取质量、生产 OIDC/RLS、外部对象存储或正式 ChatGPT Host；品牌管理整体继续 `TODO / NO-GO`，不迁移本文件。

## 2026-08-31 品牌树真实 Compose workspace 验收

- 通过桌面 Chrome 1440×1000 访问 `http://127.0.0.1:18082/ops/stores?workbench=workspace`，使用 local Compose 的真实 Bearer 认证、同源 `/api` 代理和 PostgreSQL seed 数据；页面显示“品牌、平台与店铺”、`Release QA Brand`、`brand_release_qa`、revision 及淘宝店铺任务入口。
- `dogfood/chatgpt-all-functions/ops.spec.js` 新增 workspace 品牌树用例，1/1 通过；浏览器监听到的 HTTP 4xx 数量为 0。
- 该结果证明本地真实运行链和桌面品牌树读取/导航，不等于生产真实 OIDC、RLS、多角色、真实店铺数据或正式 ChatGPT Host 证据；品牌管理整体继续 `TODO / NO-GO`，不迁移本文件。
