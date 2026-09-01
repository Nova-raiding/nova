# 品牌树店铺导航

日期：2026-08-31

## 结论

品牌树中的店铺节点已从只读标签升级为桌面端可访问导航动作。工作区成员点击或键盘聚焦店铺后，运营台会设置对应平台与店铺的营销队列筛选、刷新队列数据并进入任务页；未配置回调时仍保持纯展示，平台运营聚合视图不暴露客户品牌明细。

## 交互与实现

- 店铺动作使用原生 `button`，具备明确 accessible name、最小 44px 高度、hover/focus-visible 状态。
- 不新增客户数据读取接口，复用现有 `queueFilters` 和 `model.load`。
- 平台与店铺范围来自服务端 `workspace.health.capabilityCards.brandNavigation`，不由前端猜测。

## 验证证据

- Ops Console workspace 测试：61 个测试文件、275 项通过。
- `npm run typecheck -- --pretty false`：通过。
- `npm run build:ops-console`：通过。
- `git diff --check`：通过。
- CodeGraph 已同步：781 files / 10,912 nodes / 40,650 edges。
- 本地 Compose 真实运营台 `ops-deeplink.spec.js`：15/15 通过，包含“平台连接”域的深链刷新、导航历史和旧 hash 迁移。
- 2026-08-31 增量复核：工作区 `ws_demo` 在 1440px 桌面真实访问中显示 `Release QA Brand` 与 `fixture-store-ws_demo-taobao`；无 4xx，且平台专属 Canonical 冲突队列未挂载、未发请求。
- CodeGraph 最新同步：826 files / 11,701 nodes / 43,643 edges，`pendingRefs=0`、`worktreeMismatch=null`。

真实生产 OIDC、PostgreSQL/RLS、真实店铺数据和正式 ChatGPT 宿主验收仍属于独立上线门禁。

## 增量：空状态、权限与店铺绑定

- 无 `customer.content.read` 时，品牌树显示可读屏宣布的权限阻断；有 `customer.content.update` 且暂无品牌时，显示品牌名称输入和真实 `brand-unit.create` 创建入口。
- 已授权、可读、未撤销且尚未绑定的店铺可从品牌卡片选择；绑定调用 `brand-unit.bind-store`，携带服务端品牌 `revision`、明确平台/账号范围和审计原因。
- revision 冲突由服务端 409 fail-closed，界面保留失败告警，要求刷新后重试，不覆盖并发绑定。
- Ops Console 页面回归 17/17、全局类型检查、Compose 资源门禁、API/OPS UI 构建和 diff check 通过。
- 本地只读运行态 `workspace.health` 返回 `brand_release_qa` revision 3 与 6 个店铺；1440px 桌面验收品牌/店铺可见、0 个 4xx、无页面异常。

该增量归档的是本地代码与 Compose 可验证子能力；真实 OIDC 角色切换、生产 PostgreSQL/RLS、多副本并发、正式 ChatGPT 宿主和外部平台证据仍是整体上线门禁。
