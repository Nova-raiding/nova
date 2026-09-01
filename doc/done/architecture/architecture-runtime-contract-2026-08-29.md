# 大麦运行时架构与数据连续性契约

状态：实现中的上线基线（2026-08-29）

这份契约回答三个问题：业务事实放在哪里、模型每次能看到什么、如何证明一条数据从录入走到发布没有断链。

## 1. 唯一业务链

```text
用户 → Workspace → 品(BrandUnit)
                 → 标准商品(CanonicalProduct)
                 → Listing(平台 + 店铺)
                 → CampaignItem(批次目标)
                 → Task
                 → ContextSnapshot(冻结事实)
                 → ContentVersion
                 → Review/Approval
                 → PublishJob
                 → PlatformReceipt
```

`CampaignItem` 是批量执行、重试和计费的最小单位。批次父记录只表达批次状态，不再代表某一个平台或店铺。任何平台、店铺、商品和 Listing 关系都必须来自子项的稳定 ID；名称只能用于展示。

旧 `products/tasks/content_versions/publish_jobs` 只能作为迁移兼容投影。迁移顺序必须是：

```text
expand → backfill → shadow read → consistency check → cutover → retire legacy
```

在 consistency check 未通过前，不得删除旧数据，也不得把两套模型都当作可写事实源。

## 2. 存储边界

| 数据 | 生产事实源 | 说明 |
|---|---|---|
| 用户、工作区、品、商品、Listing、任务、版本、规则、账务 | PostgreSQL | 通过 workspace/brand/platform-account 作用域访问 |
| 队列租约、限流、短期缓存、OAuth nonce | Redis | 丢失后必须能从 PostgreSQL/outbox 重建 |
| 原图、视频、PDF、生成候选、交付包 | 私有对象存储 | 数据库只保存 artifact 元数据、hash、版本和引用 |
| OAuth、支付、中转站密钥 | Vault/KMS/Secret Manager | 不进入 Codex 对话、日志、数据库 JSON 或前端 |
| Codex 对话历史 | Codex 宿主 | 不作为业务事实源；业务任务只保存 ID、版本和 context hash |

录入一个“品”主要消耗 PostgreSQL 的 KB 级结构化数据；图片、视频和文档才是主要云存储成本。本地 volume 只允许用于开发、fixture、临时上传和预览缓存，不能作为生产业务事实源。

## 3. 上下文和 Token 契约

每轮插件调用只传递范围 ID：`workspace_id / brand_id / canonical_product_id / listing_id / task_id`。普通列表只返回摘要、游标和下一步，不返回二进制、完整历史或解析全文。

素材元数据接口支持 `GET /v1/assets?limit=20&offset=0` 分页（`limit` 最大 100），返回 `items/total/limit/offset`；未带分页参数的旧数组响应仅为兼容路径，新客户端应始终按页读取。

商品与素材的可追溯关系由 `product_asset_bindings` 持久化：商品投影写入时由 070/072 迁移触发器同步，仅接受同工作区 `business_entity_snapshots(entity_type='asset')` 中已存在的素材；072 只更新 `source` 投影，不覆盖人工维护的主图/副图/详情位或 `disabled` 状态，并拒绝关系表中的非法素材 ID。`GET /v1/products/:product_id/assets` 和 `GET /v1/assets/:asset_id/products` 提供双向反查。旧字段继续保留用于兼容，但不再承担唯一反查职责。

商品、任务、同步任务、发布任务、内容版本和反馈也遵循同一列表原则：前端按页读取并在本地仅保留当前工作区需要的摘要；无参数数组响应只为旧客户端兼容，不作为新页面的长期读取方式。

Merchant Studio 的商品列表必须把“平台 + 店铺”作为筛选上下文：筛选值会进入分页 API 请求，批量选择键仍为 `productId + platform + accountId`，未绑定店铺的商品只能进入修复流程，不能被当作可发布目标。

API 为兼容内存域服务与 PostgreSQL 快照恢复，使用 `workspace_id + excludeEntityTypes` 作为 hydration key，提供 1 秒短 TTL 和 single-flight 合并；任何成功业务写入都会失效对应工作区缓存，且失效期间完成的旧加载不会重新写入缓存。它只减少重复加载，不改变 PostgreSQL 的事实源，也不替代后续按实体类型/游标的增量 hydration。

规则中心在按平台或店铺筛选后分页；分页只切分已通过作用域筛选的规则，不会把其他平台规则混入当前商品，也不会为了节省 Token 静默丢弃适用规则。

生成时按以下顺序组装冻结上下文：

1. 商品硬事实和 SKU（不可裁剪）；
2. 当前 Listing 的平台规则快照（不可用名称替代稳定 ID）；
3. 用户显式选择且通过安全/权益/事实检查的素材；
4. 当前品级、平台级 Top-K 知识摘要；
5. 可选历史建议和竞品观察（不得绕过审核，也不得复制原文）。

未建立持久化品级素材关系前，工作区知识资产不得默认注入任何商品任务。当前服务端因此将未绑定 knowledge assets 置为空，避免跨品污染和无意义 Token 消耗。

上下文必须保存 `context_hash + context_link_id + task/campaign_item/listing`。实际 provider usage 才是计费依据；预估 token 只用于预算拒绝和容量监控。默认目标：普通响应 <256KB，生成输入 <4,000 tokens（硬上限仍由模型配置控制），结构修复最多一次。

## 4. 数据连续性不变量

- 任意 Task 必须能回读唯一 workspace、商品、平台、店铺账号和冻结上下文。
- 任意 CampaignItem 必须能回读唯一 Listing；批次父级字段不得覆盖子项范围。
- 任意 ModelUsage 必须关联 action、task 或 campaign item、context hash 和 provider request ID。
- 任意 ContentVersion 必须关联事实版本、规则版本和上下文快照。
- 任意 PublishJob 必须校验平台、店铺账号、商品、Listing、内容版本和确认 hash 一致。
- 发布准备阶段会生成 `CanonicalExecutionBinding`：它固定 workspace、task、商品、平台、店铺账号、canonical 商品、Listing、Campaign 和 CampaignItem，并把摘要写入确认 hash；确认阶段和 Worker 进入连接器前都会重新计算并拒绝漂移。完全没有规范化绑定的历史任务只允许显式 `legacy_only` 兼容路径，不能被静默升级为规范化任务。
- 迁移 077 在 PostgreSQL 侧补充 task/publish job 的 workspace、platform、store scope 触发器；应用层绑定负责数据库尚未单独建列的 canonical 链快照，事件载荷同时携带绑定和摘要，便于队列重放、对账和审计。
- REST、MCP 和批量发布必须先在同一持久化事务中写入 post-commit 的 Task/PublishJob/Batch 状态，再提交进程内索引；失败时只能保留完整未创建态或完整已创建态，不能只存在其中一部分。
- Redis 清空后，业务任务仍能从 PostgreSQL/outbox 恢复；进程内 Map 不能是生产唯一状态。
- 删除必须是可恢复 saga：数据库引用、对象当前/历史版本、provider 对象和导出临时文件都要有逐项证明；任一步失败都不能登记 `completed`。

### 当前实现差距（P1）

当前规范化商品链仍处于“可报告、可回填、发布新任务强绑定”的渐进迁移阶段；历史 legacy 数据尚未完成全量冲突清零和 shadow-read/cutover，因此不能宣称已经删除兼容投影。真实平台 OAuth、低风险写入回读、对象存储恢复、支付结算、模型中转和 Codex App 宿主证据仍缺失，生产仍为 NO-GO。

生成图片候选即使完成格式、大小和 hash 校验，仍先写入对象存储隔离区，并登记为独立 asset；发布媒体载荷拒绝直接读取 quarantine，必须通过现有 `asset.scan` 受信扫描流程提升到 clean 区后再交付。视觉审核不等于恶意内容扫描，二者状态和证据分开保存。

## 5. 分阶段上线门禁

### 开发环境

- PostgreSQL、Redis、对象存储模拟器可运行；
- 单元、契约和跨模块测试通过；
- fixture 明确标记为非生产证据。

### 预发布环境

- 至少一个主平台完成真实 OAuth、商品读取、低风险写入、写后回读和撤销；
- 真实对象存储启用私有访问、KMS、版本化、生命周期和恢复演练；
- 支付回调、查单、退款、对账和模型实际成本均有证据；
- worker 完成 Redis/PostgreSQL/平台超时和重复回调故障演练。

### 生产环境

只有以上证据齐全，并且规则源定时同步、媒体 SVIP 计价、运营 RBAC/SSO 和 Codex App 现场验收均通过，才允许打开真实发布写入。当前仓库仍处于“本地可测、生产 NO-GO”。
