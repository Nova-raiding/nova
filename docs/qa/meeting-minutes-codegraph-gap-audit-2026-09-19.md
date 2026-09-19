# 2026-09-18 会议纪要驱动的 CodeGraph / gstack 功能闭环审计

审计范围：会议纪要中的用户侧规则、运营后台、财务、客户交付和上线准备；链路覆盖 ChatGPT 插件入口、MCP/API、商家工作台、运营后台、数据库/RLS、worker 与 ECS。

结论：**代码层面大部分会议待办已经存在，但当前系统仍为 NO-GO，不能上线使用。** 主要阻断不在页面数量，而在生产运行时仍是 fixture、平台写入关闭、发布身份为空，以及支付/素材入口与会议冻结口径不完全一致。

## 证据基线

- 会议原文：`/Users/lixiaomei/Downloads/智能纪要：AI商品生成平台项目推进会 2026年9月18日/智能纪要：AI商品生成平台项目推进会 2026年9月18日.md`
- CodeGraph 1.5.0：1,516 files / 21,488 nodes / 82,282 edges；`state=complete`、`pendingRefs=0`、`worktreeMismatch=null`。
- `npm run typecheck`：通过。
- `npm run audit:ops-surface`：141/141 方法有前端引用，`unreferenced_count=0`。
- `npm run test:release-gates`：144 个文件通过、7 个 PostgreSQL 文件跳过；848 tests passed、14 skipped。跳过原因是当前没有隔离 PostgreSQL URL，不能当作生产 RLS 已验收。
- 全量核心 `npm test`：本轮初跑暴露 8 个旧契约断言（7 个旧架构断言，加 1 个清单证据断言）；已按当前实现修正，受影响契约 8 文件/30 测试与清单输入验证 1 文件/124 测试均通过；其余 7/8 安全分片通过。随后 `npm run test:ops-console`：101 个文件、710 个测试通过。
- `npm run audit:ops-surface`：141/141 方法有前端引用；`release:metadata:validate`、运营后台构建、商家工作台构建和 `git diff --check` 均通过。商家构建仍有单 bundle 大于 500KB 的性能警告，未作为功能失败隐藏。
- 本轮 owner 修复已提交并推送：`639f3917`、`3e3522ab`（`origin/main` 已同步）；没有切换线上。

## 会议待办核对

| 会议待办 | 当前证据 | 状态 | 仍缺什么 |
|---|---|---|---|
| 商品类别字段及品牌/平台/店铺关系 | `products.category` 已在 `004_business_entities.sql`；产品导入、品牌树、canonical/listing scope 均有 category/brand/account 关系 | **代码已完成，生产数据未证实** | 需要在候选迁移后的真实 PostgreSQL/RLS 环境验证旧数据回填、唯一 scope 和跨租户拒绝 |
| 选择平台 → 选择店铺 | `ManualStoreAccount`、人工店铺导入和商家端平台账户读取链路存在；六平台不走 OAuth 自动接入 | **部分完成** | 需要桌面真实会话证明三层选择后商品导入、品牌/系列过滤和空状态能继续；当前平台连接器仍是 fixture |
| 关闭视频上传 | 商家 UI 和商家 REST/MCP 上传均拒绝视频；运营客户交付专用视频入口保持独立 | **代码已完成，生产路径未证实** | 需要桌面真实会话验证商家拒绝与运营交付成功，并保留直接 API 反例证据 |
| 品类规则只读、运营统一维护 | 商家端规则页面明确只读；运营 `RuleCenterSection` 有 Markdown 草稿入口，但平台正式规则仍要求签名清单，未验证来源不会变成可执行规则 | **基本完成，治理链未闭环** | 需要真实运营角色上传/审核/发布/回滚一次，并证明匹配品类的商家只读同步；当前现网规则接口曾返回 403，属于授权/数据证据缺口 |
| 仅保留支付宝，微信/银行卡置灰 | 生产或 `PAYMENT_ALIPAY_ONLY=true` 时，充值与订阅升级服务端拒绝微信；商家端仅发送支付宝；银行卡无通道 | **代码已完成，真实支付未证实** | 需要真实支付宝沙箱/生产配置、回调、账务入账和运营对账证据；银行卡继续保持 disabled |
| 新增体验版 | 运营交付/商业目录已有 `basic/growth/custom`，私有试用 `private_validation_7d` 仍是 draft/non-executable；没有明确的体验版可选项闭环 | **未完成** | 明确体验版是独立账号版本还是私有 7 天验证 SKU；补齐目录、交付表单、权限快照、有效期、创意点和过期行为，并做支付/人工开通验收 |
| 员工管理入口 | 已有“用户中心/成员管理”、`ops.members.list`、`ops.member.upsert/suspend` 和审计；没有独立“员工管理”页面/导航项 | **部分完成** | 若会议要求独立入口，需要把成员管理改名/收敛为员工管理并补邀请、角色、启停、原因、三管理员审批口径；现有能力不能自动视为新入口已交付 |
| 客户资料交付入口 | `CustomerDeliveryPage`、档案、付款凭证、清单、培训与视频上传链路存在 | **代码已完成，账号生效链缺口** | 交付档案当前不唯一绑定“被开通商家账号”，不能自动根据“完成交付”开通指定账号；需要确认绑定字段和开通动作，再做真实跨租户/重试验收 |
| 提交修改后的代码 | `7b55c6c3` 已推送到 `origin/main`；候选配置、迁移、release evidence、受控切换和回滚仍未完成 | **代码已提交，尚未上线** | 仍需生成 candidate-bound release、真实证据和受控切换；不能因本地构建通过宣称上线 |

## 会议范围之外但上线必须补齐的 P0

1. **生产模式和写入能力**：现网 `/api/healthz` 为 `setup.mode=fixture`、`writesEnabled=false`；六个平台均 `fixture_ready`，不是人工运营数据的真实生产闭环。
2. **发布身份**：现网 `/api/releasez` 的 `release_id`、Git SHA、manifest SHA、image-set digest 全为空，`ready=false`。
3. **生产配置**：101 上活动 `production.yaml` 仍是阻断占位配置；不能用本地 `production-*.yaml` 直接替代并跳过 candidate-bound 校验。
4. **ChatGPT 插件真实链路**：本地 MCP token 路由与测试存在，但现网旧镜像曾对 `/api/v1/auth/mcp-token` 返回 404；真实 Apps OAuth client、回调、challenge token、工作区/商家绑定仍未形成当前 release 证据。
5. **模型中转五模态**：健康接口显示 provider 配置存在，但当前 health 仍是 fixture；缺少绑定当前 release、provider request id、实际 usage/cost、失败和对账证据。
6. **OSS/恢复**：现网仍显示 `objectStorage.mode=local`；`/run/release-evidence/restore.json` 缺失，不能宣称真实对象存储和备份恢复已完成。
7. **真实数据库/RLS**：本轮发布门禁有 7 个 PostgreSQL 文件跳过；必须在隔离 PostgreSQL 完成迁移链、RLS、跨租户拒绝、重启恢复和当前候选镜像验收。
8. **平台人工数据闭环**：既定方案是不做六平台 OAuth，而由运营上传商品资料。当前人工店铺/商品代码存在，但需要把“运营上传 → 绑定平台/店铺/品类/品牌 → 商家可见 → 生成 → 审核/导出”的桌面真实路径固定成一条验收脚本，并禁止自动同步/发布文案重新出现。
9. **仓库回归基线**：核心 8/8 分片、运营后台此前 101/101 文件已通过；本轮发布门禁 144/144 文件通过；PostgreSQL 隔离测试仍因当前环境没有隔离 PostgreSQL URL 而跳过，不能把本地绿色等价为生产 RLS 已验收。全量运营浏览器回归存在 AntD 弃用警告且单个客户交付场景约 30 秒，本轮改动已用关键交付/导航/用户目录定向测试复验。

## 明确不作为本轮 gap

- 淘宝自动接入和六平台 OAuth：按项目宪法/会议决策不做；只能保留人工运营录入和只读状态。
- 微信、银行卡支付：不补开发，按会议决策保持置灰/disabled；本轮已收紧生产/显式支付宝-only 服务端入口，测试环境仍保留旧渠道以支持非生产回归。
- 商家端素材下载、商家视频素材上传、手机/平板适配：不作为默认产品范围；服务端仍需保留运营客户交付视频的专用能力。
- GitHub CLI、Kubernetes/ACK、告警强制开启：不纳入当前 ECS 发布路径。

## 推荐收口顺序

1. 先修正两项需求偏差：支付宝-only 服务端门禁、商家上传视频服务端拒绝并保留交付视频专用通道。
2. 确认体验版和独立员工入口的产品定义，补齐真实数据模型与桌面验收。
3. 完成客户交付档案到指定商家账号的唯一绑定和“交付完成后是否开通”的明确动作。
4. 在隔离 PostgreSQL 应用最新迁移并跑 RLS/恢复；生成真实 OSS、支付、模型中转和 ChatGPT host evidence。
5. 将本轮 owner 复核后的提交生成 immutable release candidate，做 release-bound preflight、数据库迁移、受控切换、桌面浏览器全流程和回滚；健康接口四元组全部匹配后才可 GO。

当前上线判定：**NO-GO**。本次没有删除业务数据、没有清理容器/数据库卷，也没有切换 101 上的线上服务。

## 本轮已落地的代码修复

- 生产环境或显式 `PAYMENT_ALIPAY_ONLY=true` 时，充值与订阅升级的微信渠道由服务端稳定拒绝；商家充值客户端只发送支付宝。
- 商家 REST/MCP 素材上传服务端拒绝视频扩展名和 `video/*` MIME；运营客户交付专用视频上传入口保持独立，不受该限制影响。
- 修正迁移 218/219 的发布尾版本回归断言，9 项定向迁移回归通过。
- 修正运营财务路由测试对 `/ops/finance` 的过期 overview 期望，路由回归 3/3 通过。
- 新增 `meeting-minutes-gap-regression.test.ts`，2 项定向回归通过；完整发布门禁为 144 个测试文件通过、848 tests passed、7 个 PostgreSQL 文件跳过；类型检查通过。CodeGraph 已同步，当前索引为 1,516 files / 21,488 nodes / 82,282 edges。
- 客户交付页补齐只读权限态、培训凭证展示/上传边界、工作区清空态；交付仓储补齐已归档过滤、已付款完成门禁和有效证据时间投影。
- MCP 充值职责收敛为商家后台创建订单、插件只读查询；平台告警的客户实体筛选保留数据授权边界；CI 纳入 migration-219 PostgreSQL 发布测试；桌面浏览器测试清理增加硬上限，避免残留浏览器阻塞验收。
- 商家财务页已改为调用服务端 `billing.recharge.create/get`，展示真实订单状态和支付链接；不再使用静态二维码或伪造充值成功。交付清单项完成必须保留扫描资产证据，交付生效还必须存在未删除视频资产；API/Worker Dockerfile 补齐构建平台和 npm cache 约束；发布元数据同步为 11 个运营域。
- 最新本地证据：`npm run typecheck`、`npm run test:release-gates`（144 文件/848 passed）、核心安全分片（7/8 分片通过，剩余旧断言已定向修复并以 124/124 通过）、运营后台全量（101 文件/710 passed）、运营后台构建和 CodeGraph 同步均通过；本轮客户交付组件与页面有效路径定向回归通过。
- 本轮新增修复：客户交付列表的档案/接入/验收状态恢复为可点击入口；只读运营打开详情时，合同、清单和保存动作全部禁用；权限丢失会关闭正在编辑的详情；Ant Design Drawer/Table 弃用 API 已迁移。同步清理了 `CustomerDeliveryPage.test.tsx` 中与会议决策冲突的旧交付视频主流程断言。商家账号菜单已挂接本地插件连接入口，客服入口会携带当前任务关联 ID；相关契约测试 8 文件/30 测试通过。
- 最新线上只读证据：`https://yxsona.com/api/healthz` 返回 `writesEnabled=false`、`setup.mode=fixture`、六平台 `fixture_ready`、`objectStorage.mode=local`、`productionGate=false`；`/api/releasez` 的 release/git SHA/manifest/image digest 仍为空且 `ready=false`；`https://ops.yxsona.com/healthz` 返回 `ok`。
- 最新 CodeGraph：同步 `10` 个变更文件后，索引为 1,516 files / 21,489 nodes / 82,258 edges，`pendingChanges=0`、`worktreeMismatch=null`。

这些修复不改变真实支付、OAuth、OSS 或平台连接器的生产状态；上线判定仍保持 NO-GO。
