# 商家真实商业交易桌面脚本交接

2026-10-05。脚本 owner：商家前端；主流程 owner：DX；runtime/串行浏览器 owner：QA/root。

新增 `dogfood/chatgpt-all-functions/commercial-sales-merchant.js`，由 DX 独占的 `ops-commercial-sales-isolated.spec.js` 导入。只创建调用者已有 browser 的隔离 context，不启动 browser、PG 或任何服务，不拦截 API，不种收费或授予事实。登录强制显式 loopback URL/真实 username/password，无默认账号。调用者负责 finally 关闭 `studio.context()`。

导出步骤：loginCommercialMerchant；readCurrentContract（真实 UI 刷新时捕获 subscription.get）；assertSaleNotice（真实通知刷新并进入当前目录）；assertCurrentPlan、assertFuturePlans、assertMerchantPointPack；openMerchantProduct、prepareMerchantPurchase（首购原子 checkout，两独立分项）；prepareMerchantUpgrade（原截止不变，报价与订单金额严格一致）；confirmMerchantFrozenPayment（勾选再次确认，读取批准收款指引，仅不代表到账）；closeMerchantCheckout；submitMerchantSupport、assertMerchantSupportReply；readMerchantPointStatement、assertMerchantGrantLedger（真实完整已发流水）。所有 RPC waiter 在 UI action 前注册，绑定本次发出的 request，避开旧 background refresh。

selector 按真实 accessible name 与原有商品 SKU 文本：套餐与权益包 region、当前套餐 tab、未来待生效（n）tab、独立权益包（n）tab；通知 `.notification-trigger` 后“套餐与权益包通知” region；升级行“计算升级差价” → “确认服务端订单与付款明细” dialog → “计算剩余期差价” → “生成补差价 ¥... 的订单明细” → 冻结确认 checkbox → “确认支付 ¥...”。参数只包含 SKU 意图，不包含客户金额/优惠/权益。

已读现 `scripts/merchant-browser-candidate.ts`、目录与支持 isolated spec、QA 验收矩阵。仅执行 `node --check` 与 `git diff --check` 通过，未启动或执行浏览器，不能判定行为通过。

运行缺口：

- 当前通用 candidate runner 的 fixture/manual_transfer 配置不等于批准 C6 运行证据。DX/root 必须在唯一 owned runtime 中完成真实受控批准 probe/lease；缺失保留 closed。此 helper 不提供绕过或批准开关。
- gift ledger helper 只接受真实 sourceType/sourceIds 并检查已发行；未来六批计划、每批周年到期、worker 重放与旧500/新600合同必须由真实 worker/PG 证明。当前商家 UI 可展示冻结赠点权益与真实余额/流水消费趋势，没有六批赠点计划状态列表；不能把余额增量截图当作完整赠点计划验收。
- 已购合同表显示冻结 SKU/日期/权益，不显示目录可变名称或当前价格。assertCurrentPlan 若需要 priceFen，必须由 summary 的来源订单真实金额证明；禁止拿目录新价格替代。API 不返回对应订单金额时断言应失败并报告缺口。
- readMerchantPointStatement 当前拒绝有 next_cursor 的部分第一页；大量流水场景应补真实分页读取而不是把第一页当完整账本。默认 controlled 小样本应无游标。
- 支持全流程应在真实运营 GUI 写 customer/internal 两种回复后断言本人客户仅见公开回复，既有 ops-commercial-support-isolated.spec.js 另有同企业他人拒绝案例；不能由“收到 POST201”替代两端闭环。

未修改商家业务源码，无可证实新业务 bug，脚本交由 DX/root 集成并在 C6 前提满足后串行实际执行。

## 独立历史账号与赠点需求核对

登录 helper 已支持 overrides `{username,password,baseUrl}`，并兼容 root 指定 `{loginIdentifier,password}`；两种账号字段冲突或空值拒绝，不静默回落 fresh 客户。未传时沿用原真实环境账号；每次新 context，不能复用第一客户 cookie。node syntax 和三项拒绝边界（冲突账号、空账号、非 loopback）通过，未启动 fixture。

PRD §12.1 明确“商家购买详情、已购页及点数账本须明确区分开通赠点与套餐点数”；§15 明确“首购确认列开通费、首期费及总额，赠点计划独立说明”。这要求来源区分与计划说明；PRD 没有逐字要求新增独立“六批状态”页面或六个状态卡，不能凭空扩大页面范围。当前冻结权益摘要只有通用创意点数量，已购分区未暴露开通来源/六批时间，财务账本是消费趋势，不足以证明这些明确要求已经完成。

最小真实补齐方案交 root 安排：在同权限 `commercial.subscription.get` 增加只读 onboarding_grants 投影，直接查询已存在 onboarding_point_grant_schedules_v2（真实 workspace/RLS，不造模拟计划），包含来源开通 order_id/冻结版本、每行 sequence/points/due_at/expires_at/status/grant_id（原生状态，不按日期客户端猜已发）；同时提供账本 grantSourceType/grantSourceId 对应的安全来源标签。成功空与仓储缺失错误区分。首购确认从冻结开通订单的赠点政策说明批次数/每批点数/首次核验发放/周年与逐批到期，不硬编码500；已购页用一个 compact table 区分“开通赠点”和月套餐来源，只有真实发放记录可称已发。点数账本用同来源列与到期列，保留当前消费趋势。旧合同500与新合同600均显示各自冻结事实，升级不重启计划。该 API/UI 当前未实施；商家 owner 未越界改 backend，需 root 分派后再接真实投影并运行桌面与 RLS 验收。
