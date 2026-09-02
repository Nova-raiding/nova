# 商业化 65 项需求验收追踪台账

日期：2026-09-02  
结论：**未完成；销售与生产 NO-GO**  
唯一上游业务来源：`/Users/lixiaomei/Downloads/商业化方案.md`  
权威产品契约：`doc/todo/product/package-entitlements-and-services-prd-2026-08-31.md`  
权威架构：`doc/todo/architecture/package-entitlements-and-services-architecture-2026-08-31.md`  
实施分解：`doc/todo/work-packages/package-entitlements-work-package-01-commercial-core.md` 至 `05-migration-test-release-gates.md`

## 1. 65 项的推导规则

原始《商业化方案》、权威 PRD、架构和五个工作包均没有一份编号为“65 项”的权威清单。因此本台账不能声称恢复了原本不存在的编号。本台账按以下规则从上游建立 **恰好 65 个、互不替代、可独立失败的验收能力**：

1. 原始方案的价格、权益、点数、停服、服务边界分别追踪；同一事实只保留一次，不因在 PRD、架构和工作包重复出现而重复计数。
2. 只有当 actor、事务边界、运行表面或外部依赖不同、且能够独立通过或失败时才拆项。例如 API 余额读取、Worker 外调前复核、ChatGPT 恢复体验是三个独立能力。
3. 未批准的日期、有效期、单位、费率公式、资格、抵扣、退款和保留政策不猜测；正确状态是 `BLOCKED`，不是用默认值“完成”。
4. `PASS` 只表示该行声明的证据等级已满足；`FAIL` 表示当前仓库或运行环境已经证明不满足；`BLOCKED` 表示依赖业务/财务/法务批准或 E3/E4 外部环境，当前不能合法验收。
5. fixture、静态代码和组件截图最多属于 E0/E1；真 PostgreSQL/Worker 属于 E2；正式安装 ChatGPT 插件与真实沙箱、1440×900 桌面浏览器属于 E3；生产支付、中转、存储、scanner、平台回执属于 E4。

## 2. CodeGraph 与本轮执行证据

- 首轮实际执行 `codegraph sync .` 得到 1,064 files / 14,617 nodes / 55,127 edges；整合各 lane 后再次同步，最终索引为 **1,124 files / 15,661 nodes / 58,679 edges**，状态为 up to date。
- 实际使用 `codegraph query`/`codegraph explore` 定位：`CommercialAccessService`、`PostgresCreativePointRepository`、`PostgresCommercialCatalogRepository`、共享 operation registry、API/MCP 恢复读取、Worker 商业复核、Bridge 和 `CommercialOperationsWorkspace` 的实现、调用者与测试关系。
- CodeGraph 是结构关系证据；行为结论仍以源码、真实运行和测试为准。它发现 `CommercialAccessService` 有测试覆盖，也发现旧 `CommercialOffer.includedTasks`/addon/wallet 代码仍存在，不能把“新代码存在”误写成旧语义已完全切除。
- 整合后重新执行聚焦测试：**16 files / 189 tests passed**。覆盖目录、access decision、registry、购买服务、服务履约、创意点仓储/lifecycle、catalog/contract 仓储、Worker recheck、API、Ops parser/UI 与本地真实点数 seed。该结果不是 E3/E4。
- 本轮中途曾发现 migration tail 漂移和 6 个 Worker unhealthy；最终 owner 完成 migration 160 与镜像重建后，复核为 **13/13 服务 healthy**，Worker 正常轮询。台账只采用最终证据，但保留中途失败记录说明为何必须重建后复验。

## 3. 恰好 65 项验收台账

| ID | 独立验收能力与通过标准 | 上游与工作包 | CodeGraph/实现证据 | 测试或运行证据 | 状态 |
|---|---|---|---|---|---|
| C01 | 权威边界不漂移：专项增值服务、移动端、ERP/PIM、私有化不被当成本期已售能力 | 原文一、二、四；PRD 1/10；WP01–05 | PRD、架构和五工作包均引用同一原文并列非目标 | 文档交叉核对；无新增公开增值 SKU | PASS |
| C02 | 5000 元一次性接入 SKU 及“非永久授权”语义被版本化保存 | 原文 2.1/核心规则；PRD 3.2；WP01 | `commercial-plan-catalog.ts`、migration 146、`PostgresCommercialCatalogRepository` | `commercial-plan-catalog.test.ts`、catalog repository tests 通过 | PASS |
| C03 | 接入赠点必须为连续 6 笔、每笔 500 点、幂等可审计；日期未批准不得调度 | 原文 2.1；PRD 3.2/12；WP01/03 | catalog 保存 6×500 与 blocker；没有可生产启用的 schedule transaction | 起算/到期日仍未获业务批准 | BLOCKED |
| C04 | 接入仅覆盖淘宝/天猫/京东/拼多多/抖店/小红书六平台，不能扩大为非标准平台 | 原文 2.1；PRD 3.2；WP03 | catalog/PRD 平台枚举；平台运行能力由 connector registry 独立控制 | E1 范围契约可复核；真实平台能力见 C49 | PASS |
| C05 | 接入 checklist 必须记录账户开通、部署调试、规则、培训、验收、基础问题和首次资料录入的 actor/time/evidence | 原文 2.1；PRD 3.2；WP03 | commits `f82bf55`/`1478ad9` 落地 14 项 checklist、actor/time/evidence 与未决上限 blocker | application/persistence build 与隔离真 PG E2 通过；正式客户履约仍由 C63–C65 约束 | PASS |
| C06 | 明确排除人工资料整理、大量历史清洗、超额品牌、非标平台、ERP、私有化、人工代做 | 原文 2.1；PRD 3.2/10；WP03 | 目录未发布这些权益；工作包禁止实现 | E0/E1 范围审计通过 | PASS |
| C07 | 非公开测试 SKU 为 1999 元/7 天，且无 capability 时不可发现 | 原文 2.1；PRD 3.3；WP01/04 | migration 146、`PostgresCommercialCatalogRepository` 在 SQL 查询层过滤 private | private catalog tests 与 Ops private hidden test 通过 | PASS |
| C08 | 测试 SKU 权益为 1 品牌、1 店铺、500 点、1 小时 1V1、核心功能和一次复盘 | 原文 2.1；PRD 3.3；WP01/03 | catalog payload/benefits 保存冻结值 | catalog 全字段测试通过；不代表真实履约 | PASS |
| C09 | 测试 SKU 的资格、客户身份口径和重复购买规则必须批准后才能执行 | PRD 3.3/18；WP01/03 | private eligibility 执行闭环尚未实现 | 业务/财务决策仍缺失 | BLOCKED |
| C10 | 测试结束 7 天内抵扣 5000 元接入费必须幂等并有会计证据 | 原文 2.1；PRD 3.3；WP01/03 | 只有 blocker/契约，没有 V2 credit transaction | 抵扣会计规则未批准 | BLOCKED |
| C11 | 基础版完整冻结：2000/月、1 品牌、5 店、5000 点、50g、5 小时、工作日 4 小时 | 原文 2.2；PRD 3.4；WP01 | catalog + migration 146 持久化原始 `50 g`，不伪造 bytes | catalog 全字段测试通过 | PASS |
| C12 | 增长版完整冻结：5000/月、3 品牌、15 店、12500 点、50g、10 小时、工作日 2 小时、月复盘 | 原文 2.2；PRD 3.4；WP01 | catalog + migration 146 | catalog 全字段测试通过 | PASS |
| C13 | 定制版为 10000 元起；品牌/店铺/点数/服务必须来自已批准订单/SOW 的有限具体值 | 原文 2.2；PRD 3.4；WP01 | catalog 可表达 starts-at/custom；V2 订单与权益快照 repository 尚缺 | Ops V2 order/entitlement API 当前 503；无批准订单闭环 | BLOCKED |
| C14 | 三档持续功能必须由 V2 entitlement snapshot 驱动，不能由旧 task/addon/wallet 解锁 | 原文 2.2；PRD 3.4/9；WP01/02 | `3476080`/`c22e05b` 完成 V2 entitlement 唯一事实源与 HTTP/MCP central-gate cutover；legacy 四类准入 caller=0 | 缺失/不可用/重叠 snapshot fail-closed；6 files/114 + E2E 11、typecheck/build 通过 | PASS |
| C15 | 500 点/300 元点包只保存为待批准目录事实；未批准有效期前不可下单 | 原文 AI 点规则；PRD 3.1/4；WP01 | catalog + migration 146 标记 blocker/non-executable | catalog tests 证明不能解析为 executable | PASS |
| C16 | 2000 点/1000 元点包只保存为待批准目录事实；未批准有效期前不可下单 | 原文 AI 点规则；PRD 3.1/4；WP01 | catalog + migration 146 标记 blocker/non-executable | catalog tests 证明不能解析为 executable | PASS |
| C17 | 图片 1、批注编辑 1、15 秒视频 90 起作为同版草稿费率保存；无批准/唯一公式时阻断执行 | 原文 AI 点规则；PRD 4；WP01/02 | rate card migration 146；`resolveApprovedRate` 对草稿/歧义 fail-closed | rate repository 和 plan catalog tests 通过 | PASS |
| C18 | 扫描、商品录入、知识查询、历史读取不扣点，但余额必须已知且大于 0 | 原文 AI 点规则；PRD 4/5；WP01/02 | exact registry 的 `POINT_REQUIRED_NO_CHARGE`；`CommercialAccessService` | access service/registry tests 通过 | PASS |
| C19 | Access decision 必须区分 positive、EXHAUSTED、INSUFFICIENT、UNAVAILABLE、STALE、RATE_CARD_UNAVAILABLE | PRD 5/11；架构 6；WP01 | `commercial-access.ts`、`CommercialAccessService` | contract/application tests 全状态通过 | PASS |
| C20 | 人民币钱包、任务次数、图片 entitlement、addon 永不参与创意点准入 | PRD 2/9；架构 1/11；WP01 | `CommercialAccessService` 只依赖 balance/rate ports；CodeGraph 未显示 wallet caller | access service tests；但 legacy 代码仍须在 cutover 清点 | PASS |
| C21 | grant 必须保存 source、自然键、账期/有效期、actor/intent 并更新余额/revision | PRD 4/8；架构 7；WP01 | `PostgresCreativePointRepository.grant`、migration 144 | repository grant/idempotency tests 与本地点数 seed 通过 | PASS |
| C22 | reserve 必须在业务副作用前原子扣 available、增 reserved，并绑定 rate/version/intent | PRD 4/5；架构 8；WP01 | `PostgresCreativePointRepository.reserve`、migration 148 | repository reservation tests 通过 | PASS |
| C23 | settle 必须只结算原 reservation/allocation，不得重新选择来源 | PRD 4；架构 7/8；WP01 | repository `settle` | grant-reserve-settle 测试通过 | PASS |
| C24 | provider 明确未执行时 release 原 reservation；已过期 grant 不恢复可用点 | PRD 4/11；架构 8/12；WP01/02 | repository `release` 与正向修复 migrations 150/151 | release/expired adjustment tests 通过 | PASS |
| C25 | refund/reverse 必须追加冲正事件，不能修改历史 | PRD 4；架构 7；WP01 | `PostgresCreativePointLifecycleRepository.reverseSettlement` 追加 operation、反向 allocation、ledger/reversal fact 并推进 revision | commit `18a7bc2` lifecycle tests 通过；migration 158 加固 reversal allocation | PASS |
| C26 | 月度未用点到期且不结转；expire 必须追加事件并保持投影可重建 | 原文 AI 点规则；PRD 4；WP01 | lifecycle repository `expireGrant` 只接受已到期 grant，追加 operation/expired ledger 并重算 active projection | commit `18a7bc2` expiry lifecycle test 通过 | PASS |
| C27 | Ops 点数 adjust 必须独立 capability、approval、reason、before/after、expected revision 和审计 | PRD 8；架构 9；WP01/04 | `2ea5911`/`914a490` 两阶段 proposal→鉴权派生 distinct approver→lifecycle adjust；ops_admin 提议、finance 批准；DB 防自批并将 approval 写收敛为 insert-only | 真 PG E2 覆盖 maker/approver、跨租户 RLS、append-only、replay/revision conflict；DB migration 160 role verify 通过 | PASS |
| C28 | 多 grant 按最早到期稳定分配，不足不拆单、不使用 `SKIP LOCKED` 跳过早期来源 | PRD 4/11；架构 7/8；WP01 | creative point repository allocation/排序 SQL | E1 repository 测试通过 | PASS |
| C29 | operation/grant 自然键和 request hash 幂等；同 key 不同事实冲突 | PRD 4/8；架构 7；WP01 | repository unique keys/idempotency checks | 冲突与并发内存测试通过 | PASS |
| C30 | 真 PostgreSQL 200 并发争抢最后点数不得超卖、双扣或负余额 | PRD 12；架构 14；WP01/05 | `creative-point-security-release.postgres.test.ts` + repository workspace lock/allocation | `f82bf55` 落地、`f246f84` 收口；真 PG 200 并发 reservation 与最早到期顺序通过 | PASS |
| C31 | 余额与流水读取必须 workspace scoped；statement 使用稳定 keyset pagination | PRD 7/8；架构 7；WP01 | `getBalanceDetails`、`listStatement`，workspace predicate + createdAt/id cursor | repository/API statement tests 通过 | PASS |
| C32 | provider request/usage/cost/error receipt 必须绑定 operation；结果未知保持 reserved、禁止交付/重调 | PRD 4/8/11；架构 8/10；WP01/02 | `6b5704a` 串起 receipt→点数 lifecycle：success 先 settle 再交付，failed release，unknown 保持 active 且不交付/重试 | 真 PG 1/1；Worker 回归 23 files/234 + 1 skip；真实五模态 E4 由 C48 约束 | PASS |
| C33 | workspace 点数表必须复合租户 FK、ENABLE/FORCE RLS；ledger/event 禁 UPDATE/DELETE/TRUNCATE | PRD 8/12；架构 7/14；WP01/05 | migrations 144/148/150/151 与 security release tests | `f82bf55` + `f246f84` 真 PG 验证 6 表 FORCE RLS、5 个复合租户 FK、append-only UPDATE/DELETE/TRUNCATE 全拒绝 | PASS |
| C34 | HTTP route、MCP method、Bridge tool、Worker action 必须 exact classification；新增未分类使 CI 失败 | PRD 5/12；架构 5；WP01/02 | `commercial-operation-registry.ts`、registry checksum/totality；原生 ChatGPT `tools/list` 通过 `isNativeMcpToolEnabled` 解析同一 registry | registry/contract/native MCP E2E 验证 disabled tool 不可发现且直接调用为 method-not-found | PASS |
| C35 | workspace-scoped `commercial.access.get` HTTP/MCP 恢复读取必须使用权威 decision | PRD 5.1/7；架构 5/9；WP02 | API MCP case 与 `/v1/commercial/access`；CommercialAccessService | server/registry tests；本地 API path 存在 | PASS |
| C36 | `creative-points.balance.get` HTTP/MCP 恢复读取必须保留 unknown=null，不伪造 0 | PRD 5.1/7；架构 9；WP02 | API MCP + `/v1/creative-points/balance` | contract/server/Ops parser tests 通过 | PASS |
| C37 | `creative-points.statement.list` HTTP/MCP 必须读取同一账本并保持租户分页 | PRD 5.1；架构 9；WP02 | API MCP + `/v1/creative-points/statement` → repository | server/repository tests 通过 | PASS |
| C38 | `commercial.catalog.get` HTTP/MCP 必须读取 V2 目录，private 数据仍按 capability 隐藏 | PRD 5.1/8；架构 9；WP02 | API MCP + `/v1/commercial/catalog` → catalog repository | registry/catalog tests 通过 | PASS |
| C39 | 0/unknown/不足时非白名单请求在 dispatch 前统一拒绝，错误 envelope 保留业务 code、request/revision/nextActions | PRD 5/11；架构 6/9；WP02 | CommercialAccessService、API gate、Bridge projection；`nativeMcpCommercialErrorData` 写入原生 MCP `error.data`；Bridge 保存会话商业错误快照 | 五错误码 transport 测试；blocked 后业务写在 API 前拒绝，仅 allowed=true 的新 revision 清除快照 | PASS |
| C40 | 必须穷举证明拒绝时 DB/outbox/queue/storage/relay/scanner/connector 副作用全部为 0 | PRD 12；架构 14；WP02/05 | `3b030ce` 从 registry 派生 173 enabled 非恢复、35 disabled、29 charged 与 7 个 critical Worker | 7 files/50 tests；真 PG 8 类 durable fact 与 6 类外部端口均 0；charged 当前全 disabled，insufficient 分支用同 registry 预演批准后 enable | PASS |
| C41 | Bridge 与原生 ChatGPT MCP 必须消费共享注册表；旧任意金额 `billing.recharge.create` 禁用且不得请求 API | PRD 9/17；架构 5/9；WP02 | plugin bridge 对齐共享 registry；原生 `tools/list`/`tools/call` 也使用 `isNativeMcpToolEnabled` | Bridge + native MCP E2E 验证旧充值、收费生成和 asset.scan 不可见/不可调用 | PASS |
| C42 | `merchant.start` 被阻断时不得写 intent/触发扫描/返回业务 action，只给恢复动作 | PRD 5/7/17；架构 5/9；WP02 | Bridge merchant.start projection + API commercial gate + 会话商业错误快照 | plugin lane 105/105；阻断后 `task.create` 在 API 前拒绝 | PASS |
| C43 | 套餐购买/升级、V2 点包下单、支付状态查询作为恢复入口，价格只能来自 active SKU snapshot | PRD 5.1/8/12；架构 9/11；WP02 | `a514ca7`→`9b0b6c0` 提交链完成 MCP+HTTP+Bridge create/payment；schema 不接受 amount/currency/points/benefits/private eligibility，只消费 active approved executable server snapshot | 13 files/304 + native/error 2 files/9、真 PG、root build 通过；当前无 approved executable SKU，真实支付仍归 C63/C65 | PASS |
| C44 | 验签回调必须原子提交 paid→snapshot/period→grant→balance→revision→audit/outbox，重放不重复 grant | PRD 5.1/12；架构 8.3；WP01/02 | `PostgresCommercialContractRepository` 同事务提交 payment event、period、entitlement、grant、revision、decision audit、outbox | `ccf066b` fresh 真 PG 原子提交与重放仅 1 份测试通过 | PASS |
| C45 | 收费 Worker 外调前复核 access revision、snapshot、rate、active reservation 和 readiness | PRD 5.2；架构 8.4；WP02 | `packages/workers/src/commercial-access.ts`、`createApiCommercialAccessGuard` | Worker recheck tests 通过 | PASS |
| C46 | 零扣点 Worker 也必须复核正余额，但不得凭空要求 reservation | PRD 5.2；架构 8.2/8.4；WP02 | Worker commercial access guard 支持 no-charge snapshot | Worker tests 通过 | PASS |
| C47 | stale/unknown/已消费 reservation 时不得 provider 调用、自动重试或 dead-letter 重放 | PRD 11；架构 8.4/12；WP02 | worker handler 顺序与 retry classification；commit `bd93fca` 补齐 revision/entitlement/rate/reservation/readiness drift 矩阵 | 每种 drift 的 provider call=0；provider accepted unknown 不上报 terminal delivery | PASS |
| C48 | 文本、图片、图片编辑、OCR、视频五模态必须走真实中转并保存鉴权/request/usage/cost/error | PRD 8/12；架构 10/14；WP02/05 | relay fail-closed 与 evidence parser 已加固 | 无五模态逐项 E4、simulated=false 生产证据 | BLOCKED |
| C49 | 六平台必须逐 capability 保存真实 OAuth、读、写、媒体上传、状态回读和 canary | PRD 12；架构 14/16；WP02/05 | connector/readiness 底座存在 | fixture connector 不能替代；无六平台逐能力 E4 | BLOCKED |
| C50 | `50g` 在 GB/GiB 未批准时 normalized bytes=null，新增存储必须 fail-closed | PRD 3.4/7；架构 2/10；WP01/02 | catalog 保存 raw unit 与 unresolved blocker；V2 entitlement storage adapter 尚未闭环 | 业务单位未批准；无法生产放行 | BLOCKED |
| C51 | 接入、培训、1V1、复盘、响应承诺必须形成 workspace/order/snapshot 绑定的 allocation/event/audit | PRD 3.2/3.5/7；WP03 | migration 154、service fulfillment application/repository，绑定 workspace/order/entitlement、revision 与 append-only event | `f82bf55`/`1478ad9`：application/persistence build 通过，4 files/23 tests 含隔离真 PG 通过 | PASS |
| C52 | 本 workspace 数据导出/删除申请是恢复入口；`content.export` 不能冒充客户数据导出 | PRD 5.1/6；架构 5/9；WP02 | `72c7e46`/`557c067`/`6c87507` 落地独立 export request/get 与 delete request、workspace capability、审计及 ON CONFLICT 后 request-hash 并发幂等校验；`content.export` 仍非恢复 | 9 files/142 tests + 真 PG E2 1/1 通过；对象存储打包/签名交付仍由 C63/C65 约束 | PASS |
| C53 | Ops 商业准入摘要必须显示 known/unknown、available/reserved、revision、费率和 nextAction | PRD 7；WP04 | API `ops.commercial.access.summary` → UI status bar | parser 拒绝 known/unknown 矛盾且不造 0；定向 UI tests/build 通过 | PASS |
| C54 | 阻断与恢复必须为默认任务视图，读取真实阻断事实并能打开恢复详情 | PRD 7/15；WP04 | `commercial_access_decisions_v2` append-only repository/API；缺 repo 503，只有余额>0且 revision 增长才 resolved | `1478ad9`/`7b91db1` 定向 Ops backend tests 通过 | PASS |
| C55 | Workspace 权益页必须读取 V2 immutable snapshot，不回退旧 task/addon | PRD 7/9；WP04 | workspace entitlement snapshot V2 repository/API → Ops parser/table | 定向真仓储/API 测试通过；无旧 task fallback | PASS |
| C56 | 创意点账本页必须读取真实 ledger、保留 unknown/error、支持稳定分页/详情 | PRD 7；WP04 | API statement + Ops ledger parser/table | repository/server/UI tests 通过；E3 见 C64 | PASS |
| C57 | 商业目录与 private SKU UI 必须 capability 隐藏，且只展示服务端 price/benefit/version/blocker | PRD 7/8；WP04 | catalog API + parser/table；private 查询层过滤 | catalog/parser/component tests 通过 | PASS |
| C58 | 订单支付页必须串起 SKU→payment→grant→access revision，paid 不得显示 recovered | PRD 7/15；WP04 | V2 order/payment read model → API → UI；缺 grant 证据时强制 `grant_state=unknown` | `7b91db1` 防止 paid 被伪报 recovered；定向 backend/UI tests 通过 | PASS |
| C59 | 费率页必须显示服务端版本、批准状态和 blocker；无 approved rate 不显示执行确认 | PRD 7；WP04 | catalog `listRates` → API → parser/table | catalog/UI parser tests 通过；仅只读 E1 | PASS |
| C60 | 服务履约页必须读取真实服务事实并以独立 capability 执行 reason/revision/audit 写入 | PRD 7；WP03/04 | `8779010`/`76cbe73`/`5abd7e1`：5 个 OPS_CONTROL 写命令强制 reason/evidence/revision/idempotency，并在同租户事务验证 order→snapshot→period→executable entitlement source chain | 9 files/131 tests + 真 PG E2 通过；伪造/未决 source fail-closed，未创造 cancel/SLA/refund | PASS |
| C61 | migrations 必须 fresh/upgrade/repeat/interrupted/forward-fix 连续，运行二进制、数据库与 source tail 一致 | PRD 12；架构 11/14；WP05 | source、共享 DB 与重建后的运行二进制均理解连续 migration 160；fresh/repeat/interrupted 真 PG 通过 | 实测 `schema_migrations` 为 160 行、tail 160；Worker 正常轮询且无 mismatch | PASS |
| C62 | API、MCP、PostgreSQL/RLS、Redis、全部 Worker、Ops/merchant UI 容器必须健康 | AGENTS 硬约束；PRD 12；WP05 | Docker compose 真实重建运行 | 实测 API×2、UI×2、PostgreSQL、Redis、ClamAV、6 Worker 共 13 个服务全部 healthy | PASS |
| C63 | 正式安装 ChatGPT 插件必须完成零点阻断→看点包→下单→支付→grant→新 revision→恢复 | PRD 12；架构 14；WP02/04/05 | 安装验收器证明源码/缓存 8 文件 hash 一致、128 tools、5 个必要恢复入口齐、ops=0、旧 recharge=0 | `current_conversation_refresh.verified=false`，且 V2 order/payment 闭环缺失；无同一正式会话 E3 | BLOCKED |
| C64 | 1440×900 桌面 Ops 必须以 finance/support/platform Ops 验证 RBAC、深链、刷新、409、unknown、键盘/焦点 | PRD 7/12/15；WP04/05 | 真实 platform Bearer 负向会话已验证唯一 H1、7 Tabs、无 read 不请求、URL 后退/前进、标题焦点和无页面横向滚动 | finance/support/platform 完整能力会话、409 数据和恢复 Drawer 正向链路仍缺；负向截图不算完整 E3 | FAIL |
| C65 | 生产门禁必须具备真实支付、五模态、六平台、存储/KMS/scanner、备份恢复、capacity、告警及 release 绑定证据 | PRD 12/18；架构 14/16；WP05 | release/evidence gates 与 doctor 保持 fail-closed | payment=fixture、storage=local、alerts=false、productionGate=false、approved catalog/rate=0；scanner 基础 checks true 但历史 dead-letter=6、ready=false | BLOCKED |

## 4. 汇总与缺口分组

台账总数校验：**65**。当前状态：

- `PASS`：55 项。
- `FAIL`：1 项。
- `BLOCKED`：9 项。

需要立即实现或修复的 `FAIL`：

- 商业核心/支付：C14、C25–C27、C32、C43–C44 的 E1/E2 已通过；真实支付仍由 C63/C65 阻断。
- 服务与恢复：C05/C51/C52 的 E1/E2 底座已通过；真实履约仍由 C60/C63/C64 约束。
- Ops 真实数据与命令：C54/C55/C58 真实读取、C60 服务写命令已通过。
- 桌面 E3：C64。
- 迁移与运行环境：C61–C62 已在 migration 160 和 13/13 healthy 下通过。

> 上述列表以表格状态为准；任何自动汇总脚本都必须从 `| Cnn |` 行解析，不能把说明文字中的编号计作新需求。

外部或决策 `BLOCKED`：C03、C09–C10、C13、C48–C50、C63、C65。禁止用 fixture、默认日期、默认 bytes、默认费率、假支付或截图把这些行改成 PASS。

## 5. Owner 最终复核门槛

1. 先修复 migration tail 152 与 Worker 运行镜像不一致，重新构建/重启后证明所有容器 healthy。
2. 任何 agent 宣称完成一个 FAIL，必须同时补实现、与风险匹配的自动测试和所需 E2/E3 证据；owner 必须重新执行，不能只接受 agent 的文字报告。
3. UI 骨架不能把后端 503 变成 PASS；V2 order、entitlement、access-block、service fulfillment 与恢复写 API 是当前最明确的四个真实数据缺口。
4. 生产状态在 C48、C49、C63、C64、C65 及全部业务/财务/法务待决项完成前保持 NO-GO。
