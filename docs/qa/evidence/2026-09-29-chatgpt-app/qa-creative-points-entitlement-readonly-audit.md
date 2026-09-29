# 专用 QA 工作区创意点与权益：生产只读核查

核查日期：2026-09-29（上海时间）。目标账号 `demo@sn.com`，工作区 `ws_57fd2361ed5b44c7891f3d37`。所有生产数据库查询均在 `BEGIN READ ONLY` 中执行，连接到承载该账号的 `merchant-demo-85575f9c-postgres-1`；HTTP 仅使用现有商家会话做 GET。未读取或输出密码、Cookie、令牌，也未发放点数、下单或改动任何数据。

## 当前生产事实

1. `GET /api/v1/auth/session` 返回 `demo@sn.com`、`roles=[merchant]`、唯一工作区为目标 QA ID。生产库有该登录的账号、身份、绑定各 1 条，成员为该工作区唯一活跃 `workspace_owner`。账号及身份于 2026-09-29 12:12:21 创建；同邮箱在贵人鸟工作区没有成员或绑定。此前创建前四表核查均为 0 条，故这个账号没有可继承的历史工作区权益。
2. `GET /api/v1/creative-points/balance` 返回目标 QA `workspace_id`、`balance_state=unknown`、`available_points=null`、`reserved_points=null`、`settled_points=null`、`access_revision=null`。`GET /api/v1/creative-points/statement` 返回 0 条。
3. 生产库中，QA 工作区的 `creative_point_access_state`、`creative_point_grants`、`creative_point_ledger_events`、`creative_point_operations`、私测试用邀请/资格、V2 订单/期间/权益快照、调账提案/决定均为 **0 条**；存储配额行也为 0。当前没有可用的专用创意点或已批准的专用试用资格。
4. QA 工作区现在有旧版 `workspace_subscriptions` 1 条，状态 `trialing`、套餐 `trial`、标称 1 店/5 任务；`workspace_commercial_settings` 1 条。这些行不是 V2 已支付权益或创意点余额，不能据此放行付费模型动作。旧版订阅行与先前创建时的 0 条基线不同，需把读取过程可能的初始化行为和真正的付费授予分开记录。
5. 贵人鸟 `ws_guirenniaoniao` 单独有 2 笔历史创意点授予，授予总额 12,600 点（100 点 `demo_evaluation`，12,500 点 `commercial_order_v2`），及其流水；该工作区绑定的旧账号是 `demo@ys.com`，创建于 2026-09-25。授予总额不是当前可用余额，更不是 `demo@sn.com` 的权益。迁移 246 将历史 demo evaluation 授予限定到 `ws_guirenniaoniao`。
6. `GET /api/v1/commercial/access` 的 `commercial.access.get` 决策属于 `RECOVERY_CONTROL`，返回 `allowed=true` 同时 `balance_state=unknown`。源码对恢复查询固定这样投影，并未由这一步读取真实余额。真实余额未知的证据是独立的 `/creative-points/balance` 与持久化事实。商业目录 GET 有 12 项可见商品；目录可见不代表本工作区已购买。

其他可查询运行数据库 `merchant-demo-cd7ops-postgres-1`、`merchant-production-postgres-1`、`local-postgres-1` 对 `demo@sn.com` 均为 0 账号；隔离恢复容器的连接未成功，不对其作结论。线上 `/api/releasez` 报告 `release_git_sha=fd1ad6a7bd122a391350c185798ac07e92795f8c`、`ready=true`；这只代表当前部署身份与健康，不代表全部发布门禁通过。

## 正式发放路径与本次阻断

- **双人调账不是首次发放路径。** `ops.commercial.points.adjust.propose` 要求平台身份具 `commercial.point.adjust`、非空审批证据、预期 access revision；`decide` 需要另一身份具 `commercial.point.adjust.approve`。但提案前明确拒绝 `availablePoints=null`，批准执行前也再次拒绝。因此对当前 QA 工作区直接走该路会得到 `CREATIVE_POINT_BALANCE_UNKNOWN`，不可通过把未知余额解释成 0 或写数据库行绕过。
- **已批准的 V2 商品存在，但授予须有真实交易证据。** 生产库中 `basic`、`growth`、`points_500`、`points_2000` 与私有 `private_validation_7d` 均有 `approved` 且 `executable=true` 的版本。正式服务链是工作区下单、真实支付/受控人工转账核验、不可变订单和支付事实、`recordVerifiedPaymentAndGrant` 原子生成权益与创意点记录。不能以测试需求伪造支付回执、provider event 或人工转账。
- **私测试用也不是免费点数开关。** 独立邀请、资格审批、私有订单与 1,999 元真实人工转账核验完成后，服务端才授予 7 天/500 点权益。目前 QA 工作区邀请、资格、订单全为 0。
- 生产 demo 的创意点调整、公开订购和私测试用都不满足“现在直接给新 QA 工作区免费首次点数”的条件。若后续提供的“专用资源”是已批准的真实交易或已有 QA 发放凭证，必须先核对其工作区归属、时间、金额、审批和唯一业务引用，再决定是否走相应正式渠道。若只是希望无支付的 QA 初始点数，当前已部署正式业务流程没有安全的首次授予入口；需单独实现并审核带明确 QA 范围、两人批准、幂等、有效期、预算和审计的受控首授流程，完成生产发布门禁后使用。该方案不要求借用贵人鸟点数，也不等同于数据库迁移或直接 SQL 改数。

## Owner 下一步

1. 向资源提供方取得专用资源的**工作区 ID、来源类型、授权/支付事实引用、批准人、点数上限、有效期、测试预算**。先对照 QA ID；任何不一致停止，不做跨租户转移。
2. 若为真实已批准 V2 交易，按正式订单及支付核验工作流执行，由财务/运营分别保存审计证据；核对 `creative_point_grants` 来源、`creative_point_access_state` 修订、`ledger_events`、V2 entitlement，再由 ChatGPT App 调 `creative-points.balance.get` 验证。
3. 若为无支付的专用 QA 测试额度，先制定并落地受控首授入口与独立审批，测试通过并满足发布门禁后再发放。当前可继续做只读、空态及预期阻断验收；正向模型/内容/图片流程需要真实余额、已批准费率、中转鉴权和成本证据。

CodeGraph 1.5.0 `status --json`：索引 2,349 文件、33,821 节点、132,432 边，`pendingRefs=0`，有 1 新增/4 修改未同步。`codegraph explore 'creative point grant private trial eligibility commercial order settlement'` 定位 `CreativePointRepository`、私测转化与 worker 结算链；结论均以当前源码及上面的生产只读结果复核。关键源码：`packages/persistence/src/creative-point-repository.ts:291`；`packages/application/src/commercial-access-service.ts:162`；`apps/api/src/ops/commercial-point-adjustment.ts:26`；`apps/api/src/server.ts:11476`；`packages/persistence/src/commercial-contract-repository.ts:625`。

## 可审查的独立 QA 首次发放设计（尚未实现）

此设计仅处理**已有独立 QA 工作区的首次创意点授予**，不伪造订单、支付、订阅或 V2 权益。生产默认关闭；只允许经平台配置明确列出的 `ws_57fd2361ed5b44c7891f3d37`，并在调用时从持久化账号/身份/成员确认 `demo@sn.com` 是其活跃 owner。业务预算需由平台负责人批准；建议本次单次/该工作区累计硬上限 100 点、只能授予一次、到期不超过 72 小时，超过批准预算即拒绝。硬上限是设计建议，不代表已批准或已发放。

1. **提案。** 新增平台专用 `ops.commercial.qa-initial-grant.propose`，复用 `commercial.point.adjust` 权限但只允许平台工作台，参数含 `target_workspace_id`、正整数 `points`、`expires_at`、`expected_revision="0"`、唯一幂等键、原因和非空证据（QA run ID、测试目的、预算审批引用、授权人、需覆盖的方法清单）。服务端检查目标工作区 active、唯一 owner 绑定、原始余额 unknown 且 revision 0、没有历史创意点 grant/ledger、工作区在显式允许名单、点数及到期界限。提案只写不可变审批事实，不写余额。可复用 `commercial_point_adjustment_proposals_v2`，在 `evidence` 中持久绑定不可更改的 `purpose=qa_initial_grant` 和目标/预算摘要；现有普通调账 `decide` 必须拒绝这个 purpose，防止跨流程消费。
2. **异人审批。** 新增 `ops.commercial.qa-initial-grant.decide`，复用 `commercial.point.adjust.approve` 权限，审批人必须与提案人不同、身份来自已认证平台会话；批准或拒绝均写不可变 `commercial_point_adjustment_decisions_v2`。批准时再次核对目标、预算、到期和身份绑定。`platform_admin` 即使同时拥有两种能力，也不能用同一身份自批；推荐运营提出、财务审批。拒绝不发点。
3. **原子首授。** 批准后的执行调用 `PostgresCreativePointRepository.grant` 的专用受限分支：在该仓储现有 `lockState` 锁内增加 `requireUninitialized=true` 与 `expectedRevision=0` 校验，要求目标 workspace 尚无任何 grant、当前 revision 0、无已知余额。先按固定幂等键/来源识别**完全相同的历史成功重放**，再对新授予执行“必须为首次”的检查；否则重试会被自己创建的 grant 误拦。新授予在同一事务以 `sourceType=qa_initial_grant`、`sourceId=<proposal_id>`、`idempotencyKey=qa-initial:<proposal_id>` 生成 `creative_point_operations`、`creative_point_grants`、`creative_point_access_state` 和 `creative_point_ledger_events`。元数据保存提案/审批 ID、两个实际 actor、QA run ID、批准预算及到期。现有 `grant` 已具工作区范围、状态锁、来源唯一性和操作幂等性，代码见 `packages/persistence/src/creative-point-repository.ts:431`；不得在 HTTP handler 中直接执行 SQL 加点。若需额外操作审计，应与点数写入同事务或由可靠 outbox 承接，不可先报告成功再异步丢失审计。
4. **故障恢复与并发。** 现有 `approvals.decide` 与 `points.grant` 是两个事务。决定写入成功、授予失败时必须返回“审批已记账、发放待核查”，不得返回执行成功；相同审批幂等键重试时 `decide` 读回原决定，再以固定 `qa-initial:<proposal_id>` 重放授予。`grant` 的来源唯一键保证重复请求不双发；新校验必须在 workspace 状态锁内执行，阻断与另一 grant 并发抢首授。若另一授予已先完成，保留原批准记录但返回明确冲突供财务核查，绝不追加 QA 点数。可增只读的提案/决定/授予关联状态查询，便于恢复。
5. **读回门禁。** 执行成功后同时核对 `grant.source_type/source_id`、ledger 的 `granted` 事件、余额 revision 从 0 到 1、点数/到期、审批双 actor 与 API 操作审计；随后用 `demo@sn.com` 在真实 ChatGPT App 调 `creative-points.balance.get`、`creative-points.statement.list`，只接受同一 QA workspace。创意点首授不会自动产生 V2 套餐、存储额度、店铺授权或模型中转就绪；这些仍按各自门禁核查。

**最小改动映射。** API 命令及权限沿 `apps/api/src/mcp-commercial-ops-point-adjustment.ts`、`apps/api/src/ops/commercial-point-adjustment.ts`、`packages/contracts/src/authz.ts` 和 MCP 合同添加专用方法；现有审批仓储/表可复用，故设计本身不要求数据库迁移。仓储在 `packages/persistence/src/creative-point-repository.ts` 增加首授锁内条件，避免仅在 API 层预检造成竞态。若无法安全地让现有普通调账与首授共表隔离，就必须使用独立审批表并经发布流程迁移；不能以“无需迁移”为由牺牲两流程隔离。

**必须补的验证。** 扩展 `apps/api/src/ops/commercial-point-adjustment.test.ts` 的未知余额、非 QA 工作区、同人审批、过期、超额和权限拒绝；在 `packages/persistence/src/creative-point-repository.test.ts` 与对应 Postgres 测试覆盖 0 行首授、并发双批准、幂等重试、来源冲突、事务回滚及跨租户隔离；添加 API/MCP 端到端权限及审计读回，再在独立 QA 工作区做真实 App 读回。此处只列拟增加的测试，本轮未运行或实施。

**零金额试用核查。** 数据库 SKU 版本的 `price_fen` 约束允许 0，但当前生产全部已批准且 `executable=true` 的 SKU 共 6 个，零价 0 个、空价 0 个，最低价 30,000 分；私有 7 天试用价格为 199,900 分。`recordVerifiedPaymentAndGrant` 即使接受非负金额，也仍要求真实 provider event、订单与快照金额一致；线上支付回调路径要求正金额。故现有流程**没有**“只经审批即可零金额试用首授”的可执行通道，不能用虚构的 0 元支付事件来激活权益。若业务批准零价测试试用，须另行设计无支付的审批型 grant/entitlement 事实及审核，而不是改写真实付款状态。
