# 大麦统一数据架构与连续性审计（2026-08-28）

状态：Route B 实施中。本文记录代码证据和剩余生产门禁，不把 fixture、Mock 或本地测试写成真实平台已上线。

## 结论

目标数据链已确定为：`Workspace → BrandUnit（品）→ CanonicalProduct（一品）→ Listing（平台店铺商品）→ CampaignItem → Task → ContextSnapshot → ModelUsage/ActionLedger → ContentVersion → PublishJob`。

本轮已修复四个会形成数据孤岛的断点：

1. 异步内容生成与同步生成共用冻结后的完整 ContextSnapshot，worker 校验 context hash 后才能调用模型。
2. worker 的模型 Token 用量回传统一结算入口，继续使用后台可控倍率；倍率不返回商家插件。
3. 平台规则只读取共享规则和当前 workspace 规则，禁止跨租户扫描。
4. CanonicalProduct 的跨平台批次优先按 Listing 的 `platform + accountId + remoteProductId` 找到对应店铺商品事实，不再用淘宝来源商品冒充京东商品。
5. 对象存储 orphan 清理已接入 automation worker，按 workspace 定时执行签名回调；重复失败会进入人工处理告警。
6. 模型成本证据与价格分组均按模态隔离：文本/OCR 可使用 VIP，图片/编辑/视频要求 SVIP；任一模态不会静默回退 `default`。

任务关系已增加规范化投影：`brand_id`、`canonical_product_id`、`listing_id`、`campaign_id`、`campaign_item_id`；ActionLedger 可按 `taskId`、`campaignItemId`、`contextLinkId`、`contextHash` 查询。迁移包含回填、约束和真实 PostgreSQL 001→048 顺序执行验证。

## 存储边界

| 数据 | 生产权威位置 | 本地位置 | 规则 |
|---|---|---|---|
| 品、平台账号、店铺、商品事实、Listing、任务、活动 | PostgreSQL | fixture/开发缓存 | 本地不是生产真相源 |
| 冻结上下文、规则版本、用量、账本、发布状态 | PostgreSQL | 测试内存仓储 | 必须可按 workspace/brand/task/campaign 查询 |
| 商品图、素材、生成图、视频 | S3 兼容对象存储 | 开发 fixture/临时缓存 | 数据库存 key、digest、归属和生命周期；失败进入 orphan queue |
| OAuth/平台凭据、支付密钥、模型中转 Key | Vault/KMS/Kubernetes Secret | `.env` 仅本地开发 | 不进入数据库正文、日志、插件响应或 Git |
| Codex 历史与记忆 | 宿主能力 | 宿主管理 | 不是商家业务数据库，不能替代云端品/店铺/任务存储 |

因此，“品录入”会消耗云端数据库；图片和视频会主要消耗对象存储。仅把它们存在用户本地会导致换设备、多人协作、后台治理和发布追溯全部断裂。

## 上下文与 Token 优化

- 每次生成先建立有版本号和 hash 的 ContextSnapshot，只传当前品、当前 Listing、当前平台规则、选中素材和任务指令。
- 预算包含固定 Prompt、事实、规则以及一次修复重试预留；无效预算配置 fail-closed，超硬限制返回 `CONTEXT_BUDGET_EXCEEDED`。
- 不再把整个 workspace 知识库无界塞入模型；后续切换为按 brand/platform/category 检索的 Top-K，并缓存相同 context hash。
- 对话历史只保留摘要和可追溯引用，业务事实从数据库重新取；长会话不能成为事实源。
- worker 只接收冻结且有界的输入，不再次扫描 workspace；模型回执带 action/task/campaign/context 关联。

## 多视角评审（gstack + PM council）

Verdict：架构方向正确，但只有代码门禁与真实环境门禁全部通过后才能称为可上线。

共识：用户视角、架构、反方和交付视角都把“异步生成上下文一致性、CanonicalProduct 单一事实链、可查询权限范围”列为 UI 美化前的 P0。

主要张力：一次性删除 legacy Product 风险过高，但长期保留双真相也不可接受。采用 expand → backfill → shadow-read → consistency gate → cutover → retire，保持现有接口兼容，不做大爆炸重写。

盲点：真实对象存储故障注入、真实支付回执、平台 OAuth/发布 canary、规则源定时拉取和生产告警仍需部署环境证据；宿主左侧导航也不能由插件伪装成可控制区域。

信心：对代码断点与修复结论为高；对生产第三方联调为中，直到 canary 留下可审计证据。

## 当前门禁

| 门禁 | 当前状态 | 通过条件 |
|---|---|---|
| 单测与类型检查 | 进行中 | 全仓测试、类型检查、构建全部通过 |
| 一品多平台多店 | 代码已补，待全量回归 | 同一 canonical 的两个 Listing 生成两个绑定正确商品事实的任务 |
| 权限 | 代码已补，待攻击矩阵 | 无品权限看不到任务/交付；viewer 只读；editor 可生成；publisher 才可发布 |
| 模型计费 | DeepSeek 文本、Qianwen OCR canary 已通过；媒体待 SVIP | 重复回执只结算一次，可追溯 task/campaign item/context，倍率仅运营后台可见 |
| 云存储 | 定时清理已接入，待真实故障注入 | S3 put 成功、DB 失败、delete 失败后能被定时 worker 清理 |
| 平台规则 | workspace 隔离已补 | 六平台定时同步、版本冻结、生成前违规检查和失效告警 |
| 真实上线 | 未通过 | PostgreSQL/Redis/S3/relay/payment/OAuth/publish canary 与回滚演练全有 evidence manifest |

## 下一步优先级

1. 全仓回归并修复所有失败，更新 CodeGraph 影响面。
2. 完成 compatibility snapshot → normalized tables 的历史回填和陈旧生成任务恢复。
3. 增加 Top-K 知识检索和 context hash cache。
4. 在中转后台把图片、图片编辑、视频模型加入 SVIP，再运行付费媒体 canary。
5. 在真实集成环境依次跑支付、对象存储、六平台只读/写入 canary。
