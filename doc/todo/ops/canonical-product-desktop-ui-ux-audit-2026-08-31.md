# Canonical Product 状态与阻断交互审计

> 2026-08-31 实施进度：API/MCP 已输出统一 canonical consistency 契约（版本、可用性、live/snapshot、freshness、revision、scope、relation、blocking、permission-aware nextAction、evidence）；Ops Console Stores 页面已接入计数、状态筛选、阻断原因、商品详情抽屉和孤儿关系对象表/详情抽屉；Merchant Studio 已接入独立状态面板、过期/未知/失败态和重试，且不再把“已读取”当作标准链已验证。真实 workspace 仍返回 36 个 `legacy_only`、1 个 `conflict`、1 个 `blocked`，生产平台/权限/正式宿主和多状态桌面验收仍未全部闭合，本文件继续保留在 `doc/todo`。

> 2026-08-31 UI 纠偏：Ops Console 现在消费 `contractStatus`/`availability` 的 `unknown`、`unavailable` 状态；读取不可用明确显示“这不是零结果”，并提供重新检查动作，`freshness=unknown` 不再提示结果可作为依据。组件回归 5/5、TypeScript 和生产构建通过。真实多状态权限、桌面读屏与正式宿主证据仍未完成，本文件继续保留在 `doc/todo`。

> 2026-08-31 证据定位增量：一致性详情抽屉补齐服务端返回的商品对象 ID、品牌/平台/店铺 scope、Listing/批次/任务/发布关系计数、检查 revision/时间、blocking 影响和稳定错误码；不开放服务端标记为无权限的修复动作。Ops 组件及 Stores 页面回归 13/13、TypeScript、生产构建通过。真实权限矩阵和桌面多状态验收仍缺，本文件继续保留在 `doc/todo`。

> 2026-08-31 切读控制面交互增量：功能开关编辑器对 `canonical.product.read_mode=canonical_read` 增加专用风险提示；生产环境明确显示 `canonical-cutover-evidence` 前置条件，非生产环境提示先核对一致性报告和回滚审计。提示使用 `role="alert"`，只改善决策反馈，不绕过服务端门禁；Ops Console 61 个测试文件、277 项通过，TypeScript、生产构建和 release gates 通过。真实桌面多状态/权限和正式宿主证据仍缺，本文件继续保留在 `doc/todo`。

日期：2026-08-31  
范围：桌面运营台 `apps/ops-console`、商家端 `demo/merchant-studio`   
角色：资深 UI/UX 只读审计  
结论：**TODO / UI NO-GO**

本审计使用 `ui-ux-pro-max` 的可访问性、错误反馈、异步状态和数据密集型后台规则，并结合当前代码与测试进行复核。本轮已形成 UI 实现，本文保留为未闭合验收清单。

## 1. 审计基准

Canonical 商品链的服务端定义来自：

```text
workspace → brand → canonical_product → listing(platform + store)
          → campaign_item → task → snapshot/content/publish
```

UI 必须让用户区分以下事实，而不能将“已读取”误认为“已验证”：

| 状态 | 交互含义 | 是否允许继续 |
|---|---|---|
| `verified` | 显式关系、品牌/平台/店铺 scope 和字段版本均一致 | 可以进入后续门禁，但仍受发布检查约束 |
| `backfilled` | 关系已补齐，尚未完成字段核对 | 不可以 |
| `legacy_only` | 只有旧商品链，无法证明 canonical 身份 | 不可以，需补齐映射 |
| `conflict` | 商品、品牌、平台、店铺、远端 ID 或版本冲突 | 不可以，需查看冲突证据 |
| `blocked` | 缺账号、权限、listing、规则或迁移错误 | 不可以，需执行明确修复动作 |
| `unknown/unavailable` | 服务端没有返回可信结果或读取失败 | 不可以，需重试或转人工；不能显示绿色完成 |

`ui-ux-pro-max` 重点规则：错误必须可感知且靠近上下文；异步状态应以有意义的 live status 告知而非只更新数字；每个阻断应显示具体原因、影响和下一步；键盘焦点和错误摘要必须可达。

## 2. 当前实现与交互完成度

| 能力 | 商家端 | 运营台 | 判定 |
|---|---|---|---|
| 展示 canonical 商品身份 | 商品一致性卡片消费当前工作区状态；商品列表保留兼容态 | 表格展示 legacy/canonical ID、listing/task 引用 | 已实现，待真实多状态验收 |
| 展示标准链状态 | 明确标准链已验证/待核验，不把读取当通过 | `verified/legacy_only/conflict/blocked` 标签与计数 | 已实现 |
| 展示阻断原因 | 失败、过期、未验证均显示原因和下一步 | 稳定 finding code、影响关系和详情抽屉 | 已实现 |
| 展示证据 | 显示报告新鲜度、生成时间和工作区范围 | 展示关系引用、报告状态和错误摘要 | 已实现 |
| 下一步动作 | 显示重新检查或打开关系问题 | 根据状态和 finding code 给出权限感知的下一步说明 | 已实现，修复动作仍为只读提示 |
| 按状态筛选 | 商品状态由服务端投影到一致性卡片 | `Segmented` 支持全部/verified/legacy/conflict/blocked | 已实现 |
| 商品详情/关系追踪 | 可从状态卡片看到当前摘要 | Drawer 展示 canonical、listing、task、finding code | 已实现，完整 campaign 链证据待外部数据 |
| 安全继续门禁 | 继续动作仍由服务端任务/发布门禁决定 | 一致性页明确只读，不提供绕过按钮 | 已实现 |
| API 读取失败语义 | 能显示错误并停止部分操作 | 能显示数据集错误/重试 | 已有基础，但缺 canonical 专用语义 |

## 3. 代码证据

### 商家端

- `demo/merchant-studio/src/data-consistency.ts:1-22` 已将商品状态与 `canonicalScope.verification_status` 绑定；缺少服务端状态时保持待核验，不推导为通过。
- `demo/merchant-studio/src/App.tsx:4720-4733,4886-4889` 已接入 Canonical 状态面板，呈现新鲜度、错误、状态标签、阻断原因和重试。
- `demo/merchant-studio/src/App.tsx:4527-4529` 商品行只根据 `factsConfirmed` 显示“事实已确认/待确认”，没有标准商品 ID、listing ID、关系 revision 或冲突原因。
- 2026-08-31 增量已修复商品列表这一缺口：真实 API 商品行现在显示标准链状态、读取模式和 canonical ID；标准链状态缺失或不是 `verified` 时，勾选任务组和创建任务均被阻断，并显示原因 tooltip。
- `demo/merchant-studio/src/App.tsx:4845-4850` 的“下一步”来自固定批量条件提示，不是服务端返回的 canonical `next_actions`，也没有对应的逐项执行按钮。
- `demo/merchant-studio/src/api.ts:586-602` 的商品分页接口没有 canonical consistency 状态字段；`demo/merchant-studio/src/api.ts:659` 的图片任务查询也不能补充商品标准链状态。
- `demo/merchant-studio/src/App.tsx:5739-5747` 和 `7909-7912` 仍以事实确认状态展示商品/任务上下文，但没有告诉用户该事实是否已映射到唯一 canonical 商品及 listing。

### 运营台

- `apps/ops-console/src/pages/StoresPage.tsx:35` 已组合 `CanonicalProductConsistencySection`。
- `apps/ops-console/src/components/stores/CanonicalProductConsistencySection.tsx:39-87` 已提供状态计数、状态筛选、错误/新鲜度提示、商品级表格和详情抽屉。
- 2026-08-31 增量已修复下一步动作漂移：运营台现在消费 finding 的服务端 `nextAction`；无动作时明确保持只读，权限不足时显示所需角色，不再根据错误码在前端自行猜测修复动作。
- 2026-08-31 增量：consistency 响应中的 `read_control`、`revision` 和 `unified_link_audit.items` 已接入运营台顶部摘要，运营可确认切读模式、检查版本和已持久化审计数量。
- `apps/ops-console/src/hooks/useOpsConsoleModel.ts:470-578` 已通过真实 `canonical.product.consistency` MCP 客户端读取 workspace-scoped 报告。

## 4. 关键 UX 缺口

| 优先级 | 缺口 | 用户风险 | 必须达到的交互 |
|---|---|---|---|
| P0 | canonical 状态缺失 | 用户会把“商品已读取/事实已确认”当作标准链已验证 | 商品行和详情必须显示服务端状态、状态解释和更新时间；`verified` 之外不得用绿色“可继续”语义 |
| P0 | 阻断原因不可定位 | 运营无法知道是缺 brand、listing、账号、scope 冲突还是版本冲突 | 本地已展示稳定错误码、对象 ID、scope、关系引用、证据时间、影响和服务端下一步；错误摘要可键盘定位，真实权限矩阵仍待验收 |
| P0 | 下一步不可执行 | 文案告诉用户“确认/处理”，但没有跳转或动作 | 每个 finding 绑定服务端允许的 `next_action`，按权限显示按钮；无权限时说明联系谁 |
| P0 | 运营台没有商品级入口 | 平台运营只能看到数量，无法处理实际冲突 | 增加 canonical 对账队列：状态筛选、workspace/brand/platform/store 过滤、详情抽屉 |
| P1 | 商家端状态模型过于粗 | “待确认”混合了读取中、legacy-only、冲突和阻断 | 使用状态徽章 + 文本解释，不依赖颜色；支持“仅看阻断/仅看待确认” |
| P1 | 关系链不可追踪 | 用户无法判断旧商品对应哪个标准商品和平台刊登 | 详情按链路展示 `legacy product → canonical product → listing → campaign item`，每段显示 ID、revision、scope |
| P1 | 服务端空响应与零结果混淆 | 空列表可能被理解为没有问题 | 本地已区分空报告、不可用/未知读取和真实零条记录，并保留重新检查动作；真实网络/权限故障仍需桌面验收 |
| P1 | 证据新鲜度不可见 | 用户可能依据过期 consistency 结果继续操作 | 显示 generated_at、检查版本、fresh/stale/expired；过期时阻断继续并提供刷新 |
| P2 | 批量修复缺少预览 | 一次操作可能影响多个商品/店铺 | 先展示受影响对象、冲突数量和 revision，再确认；完成后显示逐项结果 |

## 5. 建议的桌面交互结构

### 运营台：Canonical 对账工作面

```text
顶部：当前 workspace / 检查时间 / read mode / 总体门禁
  ├─ 状态计数：Verified | Backfilled | Legacy-only | Conflict | Blocked
  ├─ 筛选：workspace、品牌、平台、店铺、状态、更新时间
  ├─ 队列表格：商品名称（脱敏策略）| canonical ID | listing scope | 状态 | 原因 | 下一步
  └─ 详情抽屉：
       关系链 → finding 证据 → 影响范围 → 服务端允许动作 → 审计记录
```

状态筛选应支持键盘操作，不能只靠红/黄/绿颜色。默认排序应将 `blocked/conflict` 和最老检查结果置顶；表格空态必须区分“无记录”和“读取失败”。

### 商家端：商品列表与详情

```text
商品列表行：商品事实状态 · canonical 状态 · 平台/店铺 scope · 最近校验 · 主动作
商品详情：
  1. 身份：legacy product / canonical product / listing
  2. 阻断原因：稳定 code + 人话解释 + 对当前动作的影响
  3. 下一步：唯一主动作，辅以查看证据/返回列表
  4. 继续按钮：仅在服务端允许且状态满足时启用
```

对于 `legacy_only/conflict/blocked`，主动作应是“查看映射问题”“确认平台店铺”“补齐刊登关系”或“联系运营”，而不是泛化的“刷新”。对于 `unknown/unavailable`，应明确“无法确认，不代表通过”，并避免重复提交。

## 6. 上线前 UI 验收标准

- [ ] 两端均消费同一 workspace-scoped canonical consistency 契约，不从数量或本地启发式推导 canonical 通过态。
- [ ] 每个商品可见 `status`、`reason/finding`、`generated_at`、相关 ID 和唯一主 `next_action`。
- [ ] `legacy_only/conflict/blocked/backfilled` 均不能显示为“已确认/可继续/绿色完成”。
- [ ] API 空响应、读取失败、过期结果和真实零结果有不同 UI 文案与动作。
- [ ] 阻断详情支持键盘到达；错误摘要使用 `role="alert"` 或等价 live region，且不会只依赖颜色。
- [ ] 主动作在执行中有 loading/成功/失败反馈；失败后恢复焦点并保留稳定错误码。
- [ ] 运营台能从汇总数字钻取到具体商品和关系链，商家端能从商品状态进入对应详情。
- [ ] 所有动作由服务端权限和 `next_actions` 决定；UI 不自行推断可执行修复。
- [ ] 桌面浏览器验收覆盖空态、阻断态、冲突态、过期态、无权限态和正常 verified 态。
- [ ] 在上述证据和桌面验收完成前，本文件不得迁移到 `doc/done`。

## 7. 审计结论

当前代码已经具备若干安全的读取失败提示、商品事实确认提示和店铺身份阻断提示，但这些属于兼容商品/运营状态，不等价于 canonical product 的可验证状态机。服务端只读一致性报告已存在，前端未形成消费、定位和处置闭环。

因此本项保持：**TODO / UI NO-GO（代码实现已完成，外部验收未闭合）**。仍需真实多状态权限矩阵、过期/无权限桌面证据、完整 campaign 链数据以及服务端允许的商品级修复动作闭环；在这些证据完成前，不迁移到 `doc/done`。

### 2026-08-31 增量：阻断动作映射

一致性报告现在按稳定阻断码返回明确的服务端动作契约：`CANONICAL_MAPPING_MISSING` 指向 `brand-unit.product.create`，`LISTING_MAPPING_MISSING` 指向 `brand-unit.listing.create`。两者均要求 `platform_ops`、交互确认和显式输入；未获服务端授权时仍不可执行。其余阻断码继续只提供证据查看动作。该增量已由 application/API 契约测试覆盖，但真实 MCP 权限矩阵和桌面执行成功/失败证据仍缺失，因此本文件继续留在 `doc/todo`。

## 8. 2026-08-31 实现与验证记录

- UI 语义修复：`stale` 与 `unknown` 的 consistency 报告不再显示绿色“已验证”，统一进入“需处理”状态；错误摘要改用 `role="alert"`，让辅助技术在报告变化时播报阻断信息。Ops UI 定向回归 7/7 通过。真实桌面浏览器多状态、权限和正式 workspace 验收仍未完成。

- Ops Console canonical 组件测试与可访问性测试已通过，商家端一致性组件和数据语义测试已通过。
- Merchant Studio 新增 `canonicalProductActionAllowed` fail-closed 契约：真实 API 行只有服务端 `verified` 才允许继续；canonical 状态/读取模式/规范商品 ID 已落到商品列表状态列。相关 Merchant IA、数据一致性、Ops canonical 和可访问性测试 6 项通过；`npm run typecheck`、Merchant Studio production build 通过。
- Ops Console 的 canonical 组件回归 3 个测试文件、8 项通过，覆盖服务端 nextAction、权限不足提示、空态和无障碍错误摘要；`npm run typecheck`、Compose 健康检查通过。

- 2026-08-31 增量：Merchant Studio 商品行补充服务端返回的 `listing_id` 与 `listing_count`，与既有 canonical 状态、读取模式、规范商品 ID 同屏展示，避免“已映射但没有店铺刊登”被事实状态遮蔽。非 `verified` 仍继续 fail-closed 禁止进入任务/发布动作。根目录 Vitest 二进制定向回归 3 个文件、8/8 通过，`npm run typecheck` 与 `npm run build:merchant-studio` 通过。
- 该增量仍不代表商品/刊登修复动作完成：服务端 `nextAction` 要求 `platform_ops`、交互确认和显式输入，商家端当前只读展示并阻断；真实 OIDC/RLS、多角色桌面故障态、正式 ChatGPT Host 与真实外部平台证据仍缺，本文继续保持 `TODO / UI NO-GO`。
- API canonical 回归 78 项通过，Ops canonical 组件回归 2 项通过；类型检查和 CodeGraph 同步通过。
- CodeGraph 当前同步：773 files、10,771 nodes、40,218 edges，无 pending refs。
- 本地真实 `ws_demo` 读取返回 `attention_required`，包含 36 个 `legacy_only`、1 个 `conflict`、1 个 `blocked`，符合 fail-closed 展示；未伪造 verified 结果。
- 运营台桌面截图显示 API Token 未配置时的明确阻断态；该状态证明 fail-closed，不等同于正式权限矩阵验收。

### 2026-08-31 增量：商品行级证据可见性

- Ops Console 的商品级一致性表现在行内同时展示关系引用数量、证据生成时间、稳定 finding 原因、状态和服务端下一步；无需先打开详情抽屉才能判断阻断原因或证据新鲜度。
- `CanonicalProductConsistencySection` 与 `StoresPage` 定向回归 18/18，Ops Console production build、TypeScript 与 `git diff --check` 通过。该增量只改善证据可见性，不改变服务端只读/权限/发布 fail-closed 边界。
- 真实桌面多状态、生产 OIDC/RLS、完整 campaign 链和正式 ChatGPT Host 仍未验收，本文件继续保持 `TODO / UI NO-GO`，不迁移到 `doc/done`。
