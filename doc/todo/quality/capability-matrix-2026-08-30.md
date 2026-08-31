# Codex 商家营销插件能力矩阵

日期：2026-09-01
评估方式：CodeGraph 调用链、源码、MCP/OpenAPI 契约、定向测试和本地运行证据交叉复核。

## 结论口径

- **高**：核心实现、边界处理和本地测试基本闭环；仍需生产证据时单独标注。
- **中高**：主流程可用，但存在重要外部依赖或少量未闭环边界。
- **中**：代码和部分测试已具备，真实运行或跨层契约仍有缺口。
- **中低**：主要停留在 fixture、本地联调或受生产门禁阻断。
- **未完成**：缺少关键实现或无法形成可验证链路。

## 能力矩阵

| 能力域 | 商家可见能力 | 主要链路/入口 | 当前证据 | 完善度 | 关键缺口 |
|---|---|---|---|---|---|
| 插件入口 | ChatGPT 插件、Skill、MCP bridge、自然语言交互 | `plugin.json` → bridge → `/mcp` | 源码与 marketplace bridge 已同步；运行态工具面 148 个，相关 surface/manifest 测试通过 | 中 | 仍需真实桌面宿主与正式 release 证据 |
| 首次使用 | 欢迎、工作区健康、平台状态、唯一下一步 | `merchant.start`、`workspace.health` | 桌面宿主本地 fixture 四项只读入口通过 | 中高 | 真实宿主、真实 workspace 和生产数据证据 |
| 平台连接 | 京东、淘宝、天猫、拼多多、小红书、抖音授权 | `platform.connect` → OAuth callback | 六平台 profile/fixture 和授权状态处理存在 | 中低 | 官方 OAuth、scope、撤销、读写和 media canary |
| 商品同步 | 商品、SKU、价格、库存、图片、同步进度和失败重试 | `catalog.sync.start` → Worker → `catalog.sync.get` | Worker、幂等、失败恢复测试存在 | 中 | 真实平台 API 和多副本长稳证据 |
| 商品事实 | 平台原值、本地确认值、来源、SKU、素材关系 | `catalog.search`、`catalog.facts.confirm` | 应用层、规范化关系和 RLS 测试存在 | 中高 | legacy 商品到 canonical/listing 的完整 cutover |
| 品牌档案 | 品牌名、定位、人群、语气、禁用词、权益 | `brand.extract` → 人工确认 → `brand.upsert` | 提取、冲突、逐字段确认和 revision 测试通过 | 高 | 生产素材扫描、权限和持久化环境验收 |
| 品牌视觉规则 | Logo、颜色、字体授权、风格、禁用人物/IP/内容 | `brand.upsert.visual_rules_json` | 强规则校验和生成前阻断已实现 | 中高 | 外部视觉识别、真实素材权益和字体授权证据 |
| 素材治理 | 上传、去重、扫描、解析、事实确认、权益、偏好 | `asset.upload` / `asset.scan` / `asset.rights.update` | 本地安全和 API 测试较完整 | 中 | 生产 scanner、对象存储、KMS、生命周期和恢复 |
| 营销任务 | 意图理解、方向、Brief、方案确认、恢复、逐 SKU 任务 | `task.understand` → `task.plan.confirm` | 状态机、任务恢复、幂等测试存在 | 高 | 真实商家端完整黑盒回归 |
| 文案生成 | 标题、卖点、详情和营销内容 | `content.generate` → relay → `content.review` | 文本 Relay 有本地成本/用量路径 | 中 | 生产 relay、provider、计量和成本证据 |
| 图片/视频 | 主图、局部编辑、OCR、视频请求和状态查询 | `catalog.image.generate`、`multimodal.*` | 图片执行已具备 `leased → provider_reserved → provider_dispatching → provider_started` 状态语义；Worker 在调用前预约稳定 `provider_operation_key` 并透传 `Idempotency-Key`。migration 119 已注册并有专项测试；本地契约闭环通过 | 中 | 仍需真实 PostgreSQL/RLS、跨副本崩溃恢复、媒体 Provider 状态回读、价格门禁和生产可售证据 |
| 内容审核 | 规则检查、品牌禁用词、P0/P1/P2、版本差异 | `content.review`、`content.modify`、`content.approve` | 审核和版本测试较完整 | 高 | 平台最终审核仍需外部回执，不能由本系统替代 |
| 发布中心 | diff、选图冻结、哈希确认、幂等发布、状态回读 | `publish.prepare` → `publish.confirm` → `publish.get` | 状态机、未知状态和失败关闭已测试 | 中低 | 真实平台写入、媒体上传适配器、回读 canary |
| 批量发布 | 批次准备、暂停、恢复、失败项重试 | `publish.batch.*` | 本地批次状态和确认测试存在 | 中 | 真实平台批量写入和运营审核证据 |
| 钱包/账务 | 余额、充值订单、用量、退款、对账 | `billing.status`、`billing.recharge.*` | 本地账本和接口存在 | 中低 | 真实支付回调、退款、对账和资金凭证 |
| Automations | 每日巡检、每周简报、只读风险报告 | 宿主 Automations + `workspace.health/metrics` | 模板和只读白名单存在 | 中 | 真实宿主调度与通知证据；不自建调度器 |
| 运营后台 | 工作区、用户、成员、店铺、任务、规则、知识、账务、模型、告警、审计 | Ops Console → Ops API | 本地 Compose 和桌面浏览器回归较完整 | 中高 | 生产 OIDC、真实数据量、告警和值守 |
| 多租户与品牌隔离 | workspace RLS、品牌 ACL、任务/商品/发布 scope | API guard + PostgreSQL RLS + repository | 越权、RLS、scope 测试较完整 | 中高 | 生产数据库角色、真实数据和历史数据探针 |
| Worker/可靠性 | 同步、生成、发布、对账队列；重试、死信、未知状态 | Outbox → Worker → 状态投影 | 队列、幂等、失败/未知状态测试存在 | 中高 | Redis 多副本、容量、长稳、监控和值守 |
| 客服 SLA 月报 | 月报、迟到事实修正、双人审批、自动生成 | 工单事件 → report/correction → Ops/MCP；reconcile Worker → internal API | migration 112–116、Memory/Postgres repository、MCP/API、Ops UI、Worker 规划与 421 项发布门禁通过 | 中高 | 生产 PostgreSQL/RLS、Worker 凭据与定时、正式 OIDC/ChatGPT Host、告警和值班 canary |
| 发布门禁 | metadata、镜像、迁移、证据签名、回滚、备份 | release gates + deploy preflight | 代码层 fail-closed 门禁存在 | 中 | 真实 trust anchor、nonce、签名 artifacts 和正式 release |

## 当前发布判断

代码覆盖面已达到 RC 级别，本地联调能力主要为中高；但生产完整度受真实平台、支付、模型 Relay、对象存储/KMS/PITR、OIDC、容量和发布信任链约束，当前仍为 **NO-GO**。

## 复核记录

### 2026-09-01 CodeGraph 文档—代码映射复核（migration 119 复核）

- CodeGraph 当前索引为 **860 files / 12,187 nodes / 45,622 edges**，状态显示 index up to date。
- 图片生成调用链已落到 `packages/persistence/src/image-generation-execution-repository.ts`、`packages/ai/src/image-generator.ts`、`apps/worker/src/main.ts`：普通 claim 后先预约 provider operation，再进入 dispatching，Provider 调用使用稳定幂等键；已有 reservation 的过期 lease 会 fail-closed 为 `IMAGE_GENERATION_PROVIDER_OUTCOME_UNKNOWN`。
- 本轮复核确认 `packages/persistence/src/migrations/119_image_generation_execution_dispatch_fence.sql` 已由 `packages/persistence/src/migration.ts` 注册，且 `migration-117.test.ts` 与新增 `migration-119.test.ts` 均覆盖该注册及约束；此前“未注册/专项失败”记录已过时，本轮同步修正发布元数据、基础迁移断言与 release-gates 清单。
- 该修复只证明仓库迁移契约一致，不证明真实 PostgreSQL 非超级用户迁移、双副本崩溃恢复和 Provider/账务关联证据；能力矩阵继续留在 `doc/todo`，发布判断仍为 **NO-GO**。

### 2026-08-31 增量复核

- 发布执行前再校验 canonical scope：execution-check 和 publish media 在释放凭证/媒体前重新读取当前 canonical product、facts、唯一 listing 与 workspace read mode，旧任务 binding 失效时 fail-closed；API E2E 53/53、application 109/109 通过。真实 connector、生产 RLS 与 canary 仍缺失。
- 任务派生动作 `task.sku.split` 与同 scope `task.clone` 已在写入前重新校验 canonical product/facts/listing/read mode，避免从历史任务复制过期关系；API 相关回归 74/74、TypeScript 通过。真实 workspace 与生产 RLS/canary 仍缺失。
- 图片归档审计已从 digest 格式检查升级为基于 workspace/job/asset/对象元数据/候选时间的确定性 digest 重算，可识别合法格式的篡改 receipt；feature-gap 回归 22/22 通过。真实对象存储、历史回填和生产恢复演练仍缺失。
- 图片账务审计已强化为逐 usage 检查 Provider request ID、实际成本和客户计费金额，并校验 action ledger request ID；88/88 API/模型结算回归通过。真实中转成本、钱包结算与供应商账单仍需外部证据。
- Ops canonical 一致性组件已修复 stale/unknown 报告的误导性绿色状态，并将错误摘要设为可访问 alert；UI 定向回归 7/7 通过。真实桌面浏览器多状态验收仍缺失。
- 告警 Webhook 已接入统一 outbound host/private-address 校验，staging/production 缺少 `OPS_ALERT_WEBHOOK_ALLOWED_HOSTS` 时 fail-closed；通知回归 2/2 通过。真实通知到达和值班演练仍缺失。

- Canonical read 已覆盖发布准备前的动作校验：`publish.prepare` 与 `publish.batch.prepare` 会重新验证当前 canonical product/facts/listing 和任务 scope，阻断历史 binding 漂移；API 相关定向回归 57/57 通过。真实平台发布、回读和生产 canary 仍缺失。

- Canonical read 已扩展到 `task.create`：缺少唯一 canonical 商品、facts 或 listing 时 fail-closed，成功创建的任务携带 canonical/listing scope；API/application 定向测试 57/57 通过。批量任务、发布准备和真实生产切读仍未闭环。

- 图片 reconciliation 已从“只传回 query_attempt”推进为 durable backoff：API 读取最新 evidence 的 `next_attempt_at` 并过滤冷却中的执行，Worker 对 processing/unknown 写入有界指数退避。API/Worker/Persistence 定向测试 75/75 通过；真实 Provider、多副本并发和生产对象存储/计费证据仍缺失。

- 图片 reconciliation Worker 已补齐 API 强制的 `idempotency_key`，并透传/校验 `query_attempt`；同一 Provider 观测可稳定重放。Worker 定向测试 43/43 通过。该修复只闭合代码协议缺口，不代表真实 Provider、退避持久化或生产媒体链路已完成。

- Ops Console canonical 一致性页面已补齐孤儿关系对象下钻：`orphanFindings` 不再只计入摘要，而是按对象类型、ID、状态和错误码展示，并提供只读详情；Ops UI 定向测试 9/9 通过。真实桌面浏览器全状态验收仍缺失，因此能力继续保持本地中高、生产 NO-GO。

- Canonical facts 读取链已补齐：`canonical_products.facts` 贯通 Memory/Postgres repository、canonical product 创建和 `catalog.title.optimize`；`canonical_read` 下缺失 facts 返回 `CANONICAL_PRODUCT_FACTS_REQUIRED`，通过后生成上下文优先使用已确认的 canonical facts。定向 API/application/persistence/server 回归 71 项通过，TypeScript、`git diff --check` 通过；本地 Compose 全部服务 healthy。该证据仍不替代生产历史数据切换、真实 RLS 和正式宿主验收。
- CodeGraph 当前状态：779 files / 10,882 nodes / 40,524 edges；索引命令已执行。共享工作树仍有 pending changes，不能把该快照当作冻结 release manifest。

- 当前工作树复核：CodeGraph 已同步，最新索引为 779 files / 10,877 nodes / 40,497 edges；本地 Compose 的 API、UI、Postgres、Redis、ClamAV 与 6 个 Worker 均 healthy。该证据仍不替代生产环境证明。
- Canonical 读取链新增 `catalog.title.optimize` 门禁：仅显式 `canonical_read` 时要求唯一标准商品映射和唯一目标 listing，缺失/冲突返回 409；通过后使用 canonical 标题并返回 scope 证据。定向 API/application 测试 36 项通过。
- Canonical API E2E 已覆盖 workspace Feature Flag 灰度开启、无映射阻断、补齐唯一 canonical 商品/listing 后成功读取标准标题；功能缺口 E2E 21/21 通过。该证据仍属于本地运行，不替代生产多副本和真实数据验收。

- CodeGraph：773 files / 10,771 nodes / 40,227 edges；品牌权限、图片回调补偿、上下文/批次持久化和 canonical 一致性调用链已重新同步。
- 最新增量：canonical 读取模式已复用 workspace feature flag 控制面并 fail-closed；`canonical.product.consistency` 与 `catalog.search` 已返回读取控制观测字段。定向 canonical/API/队列/Stores 回归 80 项通过，默认仍为 `legacy_shadow`，不代表生产切读完成。
- 定向证据：安全访问 47/47、品牌抽取/审核 4/4、图片回调/租约/对账 85/85、上下文/品牌单元/应用服务 125 项通过、canonical/API/Stores 72 项通过；真实本地 PostgreSQL 的迁移、知识 hydration 和批次跨实例测试通过。
- 品牌资料 REST 写入现在强制 active workspace member 与工作区写角色；platform_ops 仍须临时客户数据授权。
- 普通图片 Durable Worker 成功回调重试会幂等补写任务快照和候选事件；真实 Provider、正式 ChatGPT Host、生产平台/支付/对象存储和发布信任链仍是 NO-GO 门禁。

- CodeGraph：746 files / 11,107 nodes / 46,118 edges，已同步。
- `npm run typecheck`：通过。
- 本轮定向核心测试与全量回归已通过；全量为 310 个测试文件通过、15 个跳过，2,075 项通过、28 项跳过。跳过项与 fixture 仍不构成生产证据。
- 共享工作树存在大量未提交变更；上述矩阵不把 fixture 或历史文档数字当作生产证据。
