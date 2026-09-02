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

- 实际执行 `codegraph sync .`，同步后索引为 **1,064 files / 14,617 nodes / 55,127 edges**，状态为 up to date。
- 实际使用 `codegraph query`/`codegraph explore` 定位：`CommercialAccessService`、`PostgresCreativePointRepository`、`PostgresCommercialCatalogRepository`、共享 operation registry、API/MCP 恢复读取、Worker 商业复核、Bridge 和 `CommercialOperationsWorkspace` 的实现、调用者与测试关系。
- CodeGraph 是结构关系证据；行为结论仍以源码、真实运行和测试为准。它发现 `CommercialAccessService` 有测试覆盖，也发现旧 `CommercialOffer.includedTasks`/addon/wallet 代码仍存在，不能把“新代码存在”误写成旧语义已完全切除。
- 本轮聚焦测试命令实际通过：**12 files / 144 tests passed**。覆盖目录、access decision、registry、创意点仓储、catalog 仓储、Worker recheck、API 静态/行为契约、Bridge/Ops parser 与本地真实点数 seed。该结果不是 E3/E4。
- 本轮实时容器复核发现 API、PostgreSQL、Redis、Ops UI 等 7 个服务 healthy，但 6 个 Worker 均 unhealthy；日志为 `expected complete migration chain through 151, found 152 migrations through 152`。因此早先的“全部容器健康”证据已经失效。

## 3. 恰好 65 项验收台账

| ID | 独立验收能力与通过标准 | 上游与工作包 | CodeGraph/实现证据 | 测试或运行证据 | 状态 |
|---|---|---|---|---|---|
| C01 | 权威边界不漂移：专项增值服务、移动端、ERP/PIM、私有化不被当成本期已售能力 | 原文一、二、四；PRD 1/10；WP01–05 | PRD、架构和五工作包均引用同一原文并列非目标 | 文档交叉核对；无新增公开增值 SKU | PASS |
| C02 | 5000 元一次性接入 SKU 及“非永久授权”语义被版本化保存 | 原文 2.1/核心规则；PRD 3.2；WP01 | `commercial-plan-catalog.ts`、migration 146、`PostgresCommercialCatalogRepository` | `commercial-plan-catalog.test.ts`、catalog repository tests 通过 | PASS |
| C03 | 接入赠点必须为连续 6 笔、每笔 500 点、幂等可审计；日期未批准不得调度 | 原文 2.1；PRD 3.2/12；WP01/03 | catalog 保存 6×500 与 blocker；没有可生产启用的 schedule transaction | 起算/到期日仍未获业务批准 | BLOCKED |
| C04 | 接入仅覆盖淘宝/天猫/京东/拼多多/抖店/小红书六平台，不能扩大为非标准平台 | 原文 2.1；PRD 3.2；WP03 | catalog/PRD 平台枚举；平台运行能力由 connector registry 独立控制 | E1 范围契约可复核；真实平台能力见 C49 | PASS |
| C05 | 接入 checklist 必须记录账户开通、部署调试、规则、培训、验收、基础问题和首次资料录入的 actor/time/evidence | 原文 2.1；PRD 3.2；WP03 | CodeGraph 未找到完成的 onboarding/service fulfillment repository 与命令 API | `ops.commercial.service-fulfillment.list` 当前明确返回 repository unavailable | FAIL |
| C06 | 明确排除人工资料整理、大量历史清洗、超额品牌、非标平台、ERP、私有化、人工代做 | 原文 2.1；PRD 3.2/10；WP03 | 目录未发布这些权益；工作包禁止实现 | E0/E1 范围审计通过 | PASS |
| C07 | 非公开测试 SKU 为 1999 元/7 天，且无 capability 时不可发现 | 原文 2.1；PRD 3.3；WP01/04 | migration 146、`PostgresCommercialCatalogRepository` 在 SQL 查询层过滤 private | private catalog tests 与 Ops private hidden test 通过 | PASS |
| C08 | 测试 SKU 权益为 1 品牌、1 店铺、500 点、1 小时 1V1、核心功能和一次复盘 | 原文 2.1；PRD 3.3；WP01/03 | catalog payload/benefits 保存冻结值 | catalog 全字段测试通过；不代表真实履约 | PASS |
| C09 | 测试 SKU 的资格、客户身份口径和重复购买规则必须批准后才能执行 | PRD 3.3/18；WP01/03 | private eligibility 执行闭环尚未实现 | 业务/财务决策仍缺失 | BLOCKED |
| C10 | 测试结束 7 天内抵扣 5000 元接入费必须幂等并有会计证据 | 原文 2.1；PRD 3.3；WP01/03 | 只有 blocker/契约，没有 V2 credit transaction | 抵扣会计规则未批准 | BLOCKED |
| C11 | 基础版完整冻结：2000/月、1 品牌、5 店、5000 点、50g、5 小时、工作日 4 小时 | 原文 2.2；PRD 3.4；WP01 | catalog + migration 146 持久化原始 `50 g`，不伪造 bytes | catalog 全字段测试通过 | PASS |
| C12 | 增长版完整冻结：5000/月、3 品牌、15 店、12500 点、50g、10 小时、工作日 2 小时、月复盘 | 原文 2.2；PRD 3.4；WP01 | catalog + migration 146 | catalog 全字段测试通过 | PASS |
| C13 | 定制版为 10000 元起；品牌/店铺/点数/服务必须来自已批准订单/SOW 的有限具体值 | 原文 2.2；PRD 3.4；WP01 | catalog 可表达 starts-at/custom；V2 订单与权益快照 repository 尚缺 | Ops V2 order/entitlement API 当前 503；无批准订单闭环 | BLOCKED |
| C14 | 三档持续功能必须由 V2 entitlement snapshot 驱动，不能由旧 task/addon/wallet 解锁 | 原文 2.2；PRD 3.4/9；WP01/02 | CodeGraph 仍可见 legacy `includedTasks`/addon 类型；V2 entitlement repository 尚缺 | `ops.commercial.entitlements.list` 明确 fail-closed 503 | FAIL |
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
| C25 | refund/reverse 必须追加冲正事件，不能修改历史 | PRD 4；架构 7；WP01 | 当前 repository 公共能力只有 grant/reserve/release/settle，未找到完整 refund/reverse command | 无对应行为测试/API | FAIL |
| C26 | 月度未用点到期且不结转；expire 必须追加事件并保持投影可重建 | 原文 AI 点规则；PRD 4；WP01 | 查询可排除过期 grant，但未找到完整 period-expire event/scheduler 闭环 | 无月账期 expire E2 证据 | FAIL |
| C27 | Ops 点数 adjust 必须独立 capability、approval、reason、before/after、expected revision 和审计 | PRD 8；架构 9；WP01/04 | capability 已预留；写 API/repository 尚未接入 | UI 仅提示只读/写 API 未接入 | FAIL |
| C28 | 多 grant 按最早到期稳定分配，不足不拆单、不使用 `SKIP LOCKED` 跳过早期来源 | PRD 4/11；架构 7/8；WP01 | creative point repository allocation/排序 SQL | E1 repository 测试通过 | PASS |
| C29 | operation/grant 自然键和 request hash 幂等；同 key 不同事实冲突 | PRD 4/8；架构 7；WP01 | repository unique keys/idempotency checks | 冲突与并发内存测试通过 | PASS |
| C30 | 真 PostgreSQL 200 并发争抢最后点数不得超卖、双扣或负余额 | PRD 12；架构 14；WP01/05 | `creative-point-security-release.postgres.test.ts` + repository workspace lock/allocation | `f82bf55` 落地、`f246f84` 收口；真 PG 200 并发 reservation 与最早到期顺序通过 | PASS |
| C31 | 余额与流水读取必须 workspace scoped；statement 使用稳定 keyset pagination | PRD 7/8；架构 7；WP01 | `getBalanceDetails`、`listStatement`，workspace predicate + createdAt/id cursor | repository/API statement tests 通过 | PASS |
| C32 | provider request/usage/cost/error receipt 必须绑定 operation；结果未知保持 reserved、禁止交付/重调 | PRD 4/8/11；架构 8/10；WP01/02 | commit `bd93fca` 已使 provider-accepted/settlement-unknown 进入 durable unknown 且不交付、不盲重试；点数 provider receipt 持久化与 settle 闭环仍未完整接入 | Worker/Bridge tests 证明局部门禁，不证明 E2/E4 receipt 闭环 | FAIL |
| C33 | workspace 点数表必须复合租户 FK、ENABLE/FORCE RLS；ledger/event 禁 UPDATE/DELETE/TRUNCATE | PRD 8/12；架构 7/14；WP01/05 | migrations 144/148/150/151 与 security release tests | `f82bf55` + `f246f84` 真 PG 验证 6 表 FORCE RLS、5 个复合租户 FK、append-only UPDATE/DELETE/TRUNCATE 全拒绝 | PASS |
| C34 | HTTP route、MCP method、Bridge tool、Worker action 必须 exact classification；新增未分类使 CI 失败 | PRD 5/12；架构 5；WP01/02 | `commercial-operation-registry.ts`、registry checksum/totality；原生 ChatGPT `tools/list` 通过 `isNativeMcpToolEnabled` 解析同一 registry | registry/contract/native MCP E2E 验证 disabled tool 不可发现且直接调用为 method-not-found | PASS |
| C35 | workspace-scoped `commercial.access.get` HTTP/MCP 恢复读取必须使用权威 decision | PRD 5.1/7；架构 5/9；WP02 | API MCP case 与 `/v1/commercial/access`；CommercialAccessService | server/registry tests；本地 API path 存在 | PASS |
| C36 | `creative-points.balance.get` HTTP/MCP 恢复读取必须保留 unknown=null，不伪造 0 | PRD 5.1/7；架构 9；WP02 | API MCP + `/v1/creative-points/balance` | contract/server/Ops parser tests 通过 | PASS |
| C37 | `creative-points.statement.list` HTTP/MCP 必须读取同一账本并保持租户分页 | PRD 5.1；架构 9；WP02 | API MCP + `/v1/creative-points/statement` → repository | server/repository tests 通过 | PASS |
| C38 | `commercial.catalog.get` HTTP/MCP 必须读取 V2 目录，private 数据仍按 capability 隐藏 | PRD 5.1/8；架构 9；WP02 | API MCP + `/v1/commercial/catalog` → catalog repository | registry/catalog tests 通过 | PASS |
| C39 | 0/unknown/不足时非白名单请求在 dispatch 前统一拒绝，错误 envelope 保留业务 code、request/revision/nextActions | PRD 5/11；架构 6/9；WP02 | CommercialAccessService、API gate、Bridge projection；`nativeMcpCommercialErrorData` 写入原生 MCP `error.data`；Bridge 保存会话商业错误快照 | 五错误码 transport 测试；blocked 后业务写在 API 前拒绝，仅 allowed=true 的新 revision 清除快照 | PASS |
| C40 | 必须穷举证明拒绝时 DB/outbox/queue/storage/relay/scanner/connector 副作用全部为 0 | PRD 12；架构 14；WP02/05 | 有局部 provider/Worker 无调用测试；未发现全量 manifest × side-effect spy E2/E3 证据 | 144 聚焦测试不能覆盖全表面 | BLOCKED |
| C41 | Bridge 与原生 ChatGPT MCP 必须消费共享注册表；旧任意金额 `billing.recharge.create` 禁用且不得请求 API | PRD 9/17；架构 5/9；WP02 | plugin bridge 对齐共享 registry；原生 `tools/list`/`tools/call` 也使用 `isNativeMcpToolEnabled` | Bridge + native MCP E2E 验证旧充值、收费生成和 asset.scan 不可见/不可调用 | PASS |
| C42 | `merchant.start` 被阻断时不得写 intent/触发扫描/返回业务 action，只给恢复动作 | PRD 5/7/17；架构 5/9；WP02 | Bridge merchant.start projection + API commercial gate + 会话商业错误快照 | plugin lane 105/105；阻断后 `task.create` 在 API 前拒绝 | PASS |
| C43 | 套餐购买/升级、V2 点包下单、支付状态查询作为恢复入口，价格只能来自 active SKU snapshot | PRD 5.1/8/12；架构 9/11；WP02 | V2 catalog 有读；V2 order repository/API 尚未实现，legacy 任意金额入口被禁用 | `ops.commercial.orders-v2.list` 503，无新下单闭环 | FAIL |
| C44 | 验签回调必须原子提交 paid→snapshot/period→grant→balance→revision→audit/outbox，重放不重复 grant | PRD 5.1/12；架构 8.3；WP01/02 | 现有 billing/provider 底座存在，但 CodeGraph 未定位完整 V2 PaymentGrantService/UoW | 无 V2 故障注入真库证据 | FAIL |
| C45 | 收费 Worker 外调前复核 access revision、snapshot、rate、active reservation 和 readiness | PRD 5.2；架构 8.4；WP02 | `packages/workers/src/commercial-access.ts`、`createApiCommercialAccessGuard` | Worker recheck tests 通过 | PASS |
| C46 | 零扣点 Worker 也必须复核正余额，但不得凭空要求 reservation | PRD 5.2；架构 8.2/8.4；WP02 | Worker commercial access guard 支持 no-charge snapshot | Worker tests 通过 | PASS |
| C47 | stale/unknown/已消费 reservation 时不得 provider 调用、自动重试或 dead-letter 重放 | PRD 11；架构 8.4/12；WP02 | worker handler 顺序与 retry classification；commit `bd93fca` 补齐 revision/entitlement/rate/reservation/readiness drift 矩阵 | 每种 drift 的 provider call=0；provider accepted unknown 不上报 terminal delivery | PASS |
| C48 | 文本、图片、图片编辑、OCR、视频五模态必须走真实中转并保存鉴权/request/usage/cost/error | PRD 8/12；架构 10/14；WP02/05 | relay fail-closed 与 evidence parser 已加固 | 无五模态逐项 E4、simulated=false 生产证据 | BLOCKED |
| C49 | 六平台必须逐 capability 保存真实 OAuth、读、写、媒体上传、状态回读和 canary | PRD 12；架构 14/16；WP02/05 | connector/readiness 底座存在 | fixture connector 不能替代；无六平台逐能力 E4 | BLOCKED |
| C50 | `50g` 在 GB/GiB 未批准时 normalized bytes=null，新增存储必须 fail-closed | PRD 3.4/7；架构 2/10；WP01/02 | catalog 保存 raw unit 与 unresolved blocker；V2 entitlement storage adapter 尚未闭环 | 业务单位未批准；无法生产放行 | BLOCKED |
| C51 | 接入、培训、1V1、复盘、响应承诺必须形成 workspace/order/snapshot 绑定的 allocation/event/audit | PRD 3.2/3.5/7；WP03 | 当前 API 明确报告 service fulfillment repository unavailable | 无真实 actor/time/evidence E2/E3 | FAIL |
| C52 | 本 workspace 数据导出/删除申请是恢复入口；`content.export` 不能冒充客户数据导出 | PRD 5.1/6；架构 5/9；WP02 | registry 明确 content.export 非恢复；未定位独立商业 data-export/delete request 完整闭环 | 无正式插件恢复验收 | FAIL |
| C53 | Ops 商业准入摘要必须显示 known/unknown、available/reserved、revision、费率和 nextAction | PRD 7；WP04 | API `ops.commercial.access.summary` → UI status bar | parser 拒绝 known/unknown 矛盾且不造 0；定向 UI tests/build 通过 | PASS |
| C54 | 阻断与恢复必须为默认任务视图，读取真实阻断事实并能打开恢复详情 | PRD 7/15；WP04 | UI 表格/Drawer 已存在；API `access-blocks.list` 明确 503 | 页面骨架/fixture 不能替代 repository | FAIL |
| C55 | Workspace 权益页必须读取 V2 immutable snapshot，不回退旧 task/addon | PRD 7/9；WP04 | UI parser/table 已存在；API entitlement list 明确 503 fail-closed | 无 V2 repository/E2 | FAIL |
| C56 | 创意点账本页必须读取真实 ledger、保留 unknown/error、支持稳定分页/详情 | PRD 7；WP04 | API statement + Ops ledger parser/table | repository/server/UI tests 通过；E3 见 C64 | PASS |
| C57 | 商业目录与 private SKU UI 必须 capability 隐藏，且只展示服务端 price/benefit/version/blocker | PRD 7/8；WP04 | catalog API + parser/table；private 查询层过滤 | catalog/parser/component tests 通过 | PASS |
| C58 | 订单支付页必须串起 SKU→payment→grant→access revision，paid 不得显示 recovered | PRD 7/15；WP04 | DTO/table 已存在；API orders-v2 明确 503 | 无真实 V2 order/grant 状态 | FAIL |
| C59 | 费率页必须显示服务端版本、批准状态和 blocker；无 approved rate 不显示执行确认 | PRD 7；WP04 | catalog `listRates` → API → parser/table | catalog/UI parser tests 通过；仅只读 E1 | PASS |
| C60 | 服务履约页必须读取真实服务事实并以独立 capability 执行 reason/revision/audit 写入 | PRD 7；WP03/04 | UI 明示“履约写入 API 尚未接入”；服务读 API 503 | fixture/静态页面不算完成 | FAIL |
| C61 | migrations 必须 fresh/upgrade/repeat/interrupted/forward-fix 连续，运行二进制、数据库与 source tail 一致 | PRD 12；架构 11/14；WP05 | source 已注册到 migration 154；共享本地 DB 仍为 152；运行 Worker 镜像仍期望 151 | 三个 tail 不一致，尚未由 owner 统一 migrate/rebuild | FAIL |
| C62 | API、MCP、PostgreSQL/RLS、Redis、全部 Worker、Ops/merchant UI 容器必须健康 | AGENTS 硬约束；PRD 12；WP05 | Docker compose 真实运行 | 本轮 6 个 Worker unhealthy；镜像 schema check 期望 151 | FAIL |
| C63 | 正式安装 ChatGPT 插件必须完成零点阻断→看点包→下单→支付→grant→新 revision→恢复 | PRD 12；架构 14；WP02/04/05 | 安装验收器证明源码/缓存 8 文件 hash 一致、128 tools、5 个必要恢复入口齐、ops=0、旧 recharge=0 | `current_conversation_refresh.verified=false`，且 V2 order/payment 闭环缺失；无同一正式会话 E3 | BLOCKED |
| C64 | 1440×900 桌面 Ops 必须以 finance/support/platform Ops 验证 RBAC、深链、刷新、409、unknown、键盘/焦点 | PRD 7/12/15；WP04/05 | 真实 platform Bearer 负向会话已验证唯一 H1、7 Tabs、无 read 不请求、URL 后退/前进、标题焦点和无页面横向滚动 | finance/support/platform 完整能力会话、409 数据和恢复 Drawer 正向链路仍缺；负向截图不算完整 E3 | FAIL |
| C65 | 生产门禁必须具备真实支付、五模态、六平台、存储/KMS/scanner、备份恢复、capacity、告警及 release 绑定证据 | PRD 12/18；架构 14/16；WP05 | release/evidence gates 与 doctor 保持 fail-closed | payment=fixture、storage=local、scanner 非真实 readiness 缺失、alerts=false、productionGate=false、approved catalog/rate=0 | BLOCKED |

## 4. 汇总与缺口分组

台账总数校验：**65**。当前状态：

- `PASS`：38 项。
- `FAIL`：17 项。
- `BLOCKED`：10 项。

需要立即实现或修复的 `FAIL`：

- 商业核心/支付：C05、C14、C25–C27、C32、C43–C44。
- 服务与恢复：C51–C52。
- Ops 真实数据与命令：C54–C55、C58、C60。
- 桌面 E3：C64。
- 迁移与运行环境：C61–C62。

> 上述列表以表格状态为准；任何自动汇总脚本都必须从 `| Cnn |` 行解析，不能把说明文字中的编号计作新需求。

外部或决策 `BLOCKED`：C03、C09–C10、C13、C40、C48–C50、C63、C65。禁止用 fixture、默认日期、默认 bytes、默认费率、假支付或截图把这些行改成 PASS。

## 5. Owner 最终复核门槛

1. 先修复 migration tail 152 与 Worker 运行镜像不一致，重新构建/重启后证明所有容器 healthy。
2. 任何 agent 宣称完成一个 FAIL，必须同时补实现、与风险匹配的自动测试和所需 E2/E3 证据；owner 必须重新执行，不能只接受 agent 的文字报告。
3. UI 骨架不能把后端 503 变成 PASS；V2 order、entitlement、access-block、service fulfillment 与恢复写 API 是当前最明确的四个真实数据缺口。
4. 生产状态在 C48、C49、C63、C64、C65 及全部业务/财务/法务待决项完成前保持 NO-GO。
