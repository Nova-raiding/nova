# CodeGraph 生产链路孤儿功能审计（2026-09-21）

## 结论

**NO-GO（针对本报告列出的高风险运营链路）。** 本轮没有修改业务实现，只审计现有关系并记录缺口。确认 2 个需要在生产候选前修复的高风险断链，以及 1 个不阻断生产但应清理或明确替代关系的孤儿组件：

| 优先级 | 发现 | 生产影响 | 判定 |
|---|---|---|---|
| P0 | `AuthorizationGovernanceSection` 没有生产调用者，用户中心路由只挂载 `UsersGovernanceWorkspace` | 服务端已有平台角色和 JIT 临时授权的读取、签发、撤销契约，组件也已实现，但桌面运营后台没有真实入口；管理员无法从产品路径执行或核验这组高风险动作 | 孤儿功能、真实入口断链 |
| P0 | `listCommercialRefunds` 没有调用者，而同一退款面板直接开放申请、审批、完成操作 | 操作员必须手填退款请求 ID，页面不读取当前退款状态、修订和历史；服务端状态机虽会拒绝非法迁移，但桌面工作流无法先读后写，也无法可靠恢复中断流程 | 读写链路断裂、关键状态不可见 |
| P2 | `AutoSyncSection` 没有调用者，商店页使用 `AutomationPolicySection` 与 `AutomationScanSection` | 当前功能已有替代入口，因此不是能力缺失；旧组件会制造“代码存在即已交付”的误判，并增加未来双实现漂移风险 | 遗留孤儿、非上线阻断 |

## 审计基线与可信边界

- 当前独立 worktree：`197ba8530d2815b6ef534f674a49f323ff3d597e`，审计开始时工作树干净。
- 复用的 CodeGraph 1.5.0 数据位于同一提交的主 worktree，最后索引时间 `2026-09-21T06:28:03.002Z`，包含 1,654 files、23,801 nodes、92,660 edges；索引 `state=complete`、`pendingRefs=0`、`worktreeMismatch=null`。
- 共享索引状态同时报告 `pendingChanges.added=2`、`modified=2`。主 worktree 后续存在并发未提交修改，因此本报告没有把全库统计当作冻结发布证明。三个发现涉及的六个前端文件已逐一比较 SHA-1，与当前独立 worktree 完全一致。
- CodeGraph 仅用于筛选零调用者和调用关系；每个结论均由当前 worktree 的 import、路由挂载、组件实现和测试引用再次核对。没有访问或修改生产数据，没有执行部署。

## 发现 1：角色与 JIT 授权治理组件不可达（P0）

### 关系证据

- CodeGraph `callers AuthorizationGovernanceSection` 返回空数组。
- `apps/ops-console/src/components/users/AuthorizationGovernanceSection.tsx:70` 实现了角色读取/分配/撤销、JIT grant 读取/签发/撤销，并调用 `ops.authorization.roles.list`、`role.assign`、`role.revoke`、`grants.list`、`grant.issue`、`grant.revoke`。
- 全仓生产代码没有 import 或渲染该组件；命中仅来自组件自身及直接渲染它的测试。
- 真实用户中心路由在 `apps/ops-console/src/pages/UsersPage.tsx:30` 只渲染 `UsersGovernanceWorkspace`。后者负责入驻申请和用户目录，不提供上述平台角色/JIT 控制面。

### 未覆盖的高风险路径

现有 `AuthorizationGovernanceSection.test.tsx` 直接挂载孤儿组件，证明组件局部逻辑可以工作，却没有证明从导航进入用户中心后能到达该组件。当前缺少以下真实路径覆盖：

1. 有权管理员从桌面导航进入授权中心；
2. 读取目标身份当前角色或指定工作区的 JIT grant；
3. 带 revision、原因、审批 token 执行签发/撤销；
4. 刷新后从服务端重新读取结果，并在审计中心看见对应记录；
5. 无权角色、跨工作区和过期 grant 被明确拒绝。

### 根因

功能组件和服务端契约分别完成后，没有把组件纳入页面 registry/真实路由。测试以“直接渲染组件”为边界，绕过了产品入口。`audit:ops-surface` 只要在任意源码中看到方法字符串就会计为前端引用，因此无法发现“引用只存在于不可达组件”。

### 修复门槛

- 在桌面用户治理信息架构中挂载授权治理入口，或明确删除该组件并提供等价的受管入口；不得开放给缺少读取能力的角色。
- 新增从 `opsPageRegistry`/`UsersPage` 出发的路由级测试，而不只是直接渲染子组件。
- 浏览器验收必须覆盖一次角色或 JIT grant 的读取和一次受控撤销，并保留服务端审计证据。

## 发现 2：商业退款只写不读（P0）

### 关系证据

- CodeGraph `callers listCommercialRefunds` 返回空数组。
- `apps/ops-console/src/api/commercialOperationsClient.ts:532` 已定义 `ops.commercial.order.refund.list` 客户端调用，API 在 `apps/api/src/server.ts:16221` 提供对应读取契约。
- `CommercialRefundOperationsPanel` 从 `apps/ops-console/src/components/commercial/CommercialOperationsWorkspace.tsx:572` 开始，只维护本地输入；在 629、631、633–642 行分别提供申请、审批和完成操作，没有调用退款列表。
- 全仓除定义外没有 `listCommercialRefunds` 调用；现有客户端测试只覆盖证据 JSON 校验，没有覆盖列表读取和由服务端状态驱动按钮可用性。

### 未覆盖的高风险路径

页面允许操作员手填 `workspace`、`orderId`、`requestId`、金额、点数和外部凭证后执行不可逆的“登记退款并回滚点数”，但没有展示服务端当前退款记录。由此缺失：

- 申请后重新读取 `requested` 状态并取得服务端事实；
- 审批人与申请人分离的可见证据；
- 中断或换班后恢复既有退款，而不是依赖人工保存请求 ID；
- 完成前核对订单、金额、点数、政策审批、外部退款 ID 与当前 revision；
- 已完成/已拒绝/并发修订冲突的明确桌面状态。

服务端状态机、幂等和双人审批约束仍是有效安全边界，因此这不是“可绕过退款”。风险在于真实运营路径不闭环，容易产生误操作、重复尝试和无法恢复的人工流程。

### 根因

退款写命令被接入 `CommercialOperationsWorkspace`，读取方法只停留在客户端对象中。现有 API surface 审计把对象成员定义本身视为引用，没有区分“已声明”和“被可达 UI 调用”；组件测试又集中在确认弹窗和证据格式，没有覆盖服务端状态回读。

### 修复门槛

- 以 `listCommercialRefunds` 返回的服务端记录驱动退款列表/详情和允许动作；手填 ID 只能作为受控检索条件，不能作为唯一状态来源。
- 申请、审批、完成后强制重新读取；展示 revision、申请人/审批人、金额、点数、证据和外部退款状态。
- 新增从页面加载到申请→第二身份审批→完成→回读的桌面集成测试，并覆盖跨租户、同人审批、过期 revision 和重复完成的拒绝路径。

## 发现 3：旧自动同步面板成为孤儿（P2）

### 关系证据与判定

- CodeGraph `callers AutoSyncSection` 返回空数组；生产源码也没有 import。
- `apps/ops-console/src/components/stores/AutoSyncSection.tsx:12` 保留“自动商品同步”开关和保存按钮。
- 当前 `StoresPage` 在 `apps/ops-console/src/pages/StoresPage.tsx:84-100` 实际挂载 `AutomationPolicySection` 和 `AutomationScanSection`，后者承接策略与扫描操作。

这属于遗留孤儿而非现有生产能力缺口。建议删除旧组件，或在代码注释/测试中明确其迁移关系；不要重新挂载形成两个自动化策略入口。

## 为什么既有检查没有发现

当前检查覆盖的是契约存在性和局部行为，不是产品可达性：

```text
API/MCP 方法字符串存在
        ↓
客户端对象中声明方法 ──────→ audit:ops-surface 计为“有前端引用”
        ↓
组件内部调用方法
        ↓
组件直接渲染测试通过
        ╳
页面 registry / 导航 / 权限可达性未验证
        ╳
真实先读后写工作流未验证
```

本轮 `audit:ops-surface` 报告 142 个契约方法、136 个前端引用、0 个未引用（另有 6 个登记为 server-only）。这类 surface 统计不能解释为 136 个引用均存在真实桌面入口，也不能解释为高风险命令已有状态回读闭环。

## 建议的定向门禁

1. 扩展 Ops surface 审计：分别报告“客户端声明”“生产调用者”“路由可达组件调用者”，禁止用定义位置满足引用计数。
2. 为高风险方法建立配对规则：退款、角色、grant、发布、删除、调账等命令必须有可达的读取/详情路径和成功后的回读。
3. 路由测试从 `opsPageRegistry` 启动，按权限角色断言入口存在/隐藏；子组件直接渲染测试只保留为局部测试。
4. CodeGraph 零调用者列表按 allowlist 管理；明确标注兼容导出、替代实现和待删除日期，避免把所有零入边一概视为缺陷。

## 本轮验证

本报告提交前执行以下定向检查：

- CodeGraph status、SQL 零入边筛选，以及三个候选的 `codegraph callers` 查询；
- 当前与共享索引工作树的六个相关前端文件 SHA-1 比对；
- `node scripts/audit-ops-surface.mjs`：142 个契约方法、136 个前端引用、0 个未引用，6 个已登记 server-only；
- 授权治理、商业操作客户端/工作区、商店页相关 Vitest：4 files、42 tests passed。独立 worktree 未安装依赖，测试在同一提交的主 worktree 运行；四个目标源码/测试范围的相关前端文件已先做 SHA-1 一致性校验。一次尝试从独立 worktree 直接借用 Vitest 因 Node 模块解析不到 React 而在收集期失败，不计为产品测试失败；
- `git diff --check`。

本轮只新增本报告，不修改业务代码，不声称修复上述缺口，也不把本地测试结果当作生产运行证据。
