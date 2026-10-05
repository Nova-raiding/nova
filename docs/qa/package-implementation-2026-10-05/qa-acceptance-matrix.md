# 套餐需求 QA 验收矩阵（持续更新）

QA 角色：第 10 名子 agent；需求全文与 23 个 implementation tasks 是验收基线，不以已实现的子集重定义完成。gstack qa-only / review / verify-feature 的实测与证据规则适用。业务源码由各开发 owner 修复，QA 独占测试清单、验收用例与证据。

最新状态：2026-10-05，main共享实现继续补齐全文范围。此前263链第七轮22PG、目录及双端支持已实际通过；当前追加gift read第11it、目录validator/bundle引用分页/三档比较、通知结果mark-read与264迁移，最新源码尚未冻结和重新验收。以下既有绿色为准确历史证据，不能代表新264链完成；最终发布/101尚未签收。

| 行为组 / 关联任务 | 必须证明的行为 | 当前独立 QA 证据 / 状态 |
|---|---|---|
| 01 目录生命周期 C3 D1 | 草稿 CRUD、批准、上下架、重上架、归档；在售与草稿并存；不可变身份 | round7 catalogue真实Ops/不可变/在售草稿/停售历史PG通过；桌面目录与草稿验证通过，销售全流程桌面待验 |
| 02 套餐与包可调价 C3 C6 | 三类售价版本化，有效旧单/报价固定旧价，新单新价，购买确认最新服务器快照 | round7有效旧quote保价、目录新价/历史冻结PG通过；两端实际付款确认待验 |
| 03 包与权益语义 C3 C4 | 固定定义、消费器、布尔/绝对/增量/服务组合；绑定包版本不随新包漂移 | round7 bundle不可变绑定、bool准入、storage/brand/store真实消费与来源恢复阻断通过；全源消费覆盖见后文 |
| 04 标准三档 C3 | 基础/成长/尊享固定 family/rank；尊享额度必填批准；legacy custom 不自动转换 | 需新建/编辑/审批桌面与 PG 证明；尚未证明 |
| 05 周期 C3 ENG5 | 自然月末/闰年，已实现倍数和天数，缺消费器禁止上架，无自动扣款 | 需 UTC 时钟 PG/worker 验收，不得以输入选项证明完成 |
| 06 首购 C1 | 开通费独立于首期，唯一有效开通意图，同 Workspace 合款原子核验依赖 | round7首购同receipt双单原子核验/注入失败整体rollback/依赖恢复/重放PG通过；Ops/商家首购桌面待验 |
| 07 开通赠点 C1 ENG5 | 核验首笔500，其后5个月周年各500，各自下周年到期；不一次发3000；改价不改赠点 | round7 gift逐期500/每批失效/重放/改价600新合同/漏窗不补发真实PG全部通过 |
| 08 商家当前/未来套餐 D3 ENG5 | 当前、已付未来、已购包、历史分区；未来点数/服务不可用；floating_append 核验序列固定 | round7并发浮动续期、未来授予一次/过期不补、账期排队真实PG通过；商家分区桌面待验 |
| 09 升级金额 C2 | 半期1500/2500/4000，原到期不变，连续升级使用目标完整周期价 | round7连续半期1500/2500、原到期和完整目标基价真实PG通过；桌面/API报价确认待验 |
| 10 升级权益 C4 | 只增剩余期比例消耗权益、绝对额度保留used/reserved、精确余数、独立包/赠点不重发 | round7连续升级、目标bool消费器、真实容量/数量不清零、独立赠点保留与恢复PG通过 |
| 11 晚核验 C2 ENG5 | 真实到账在半开截止前可晚核验；源变/已过原账期待处置，不重定价或延长 | round7源过期支付待处置不延长、不重新定价PG通过；运营处置桌面待验 |
| 12 运营代办 C5 D4 | 指定企业/用户开户、服务端预览、代购、确认真实流水金额和依赖；不填nonce/hash | Ops 页面/方法仍整合；需授权桌面实测 |
| 13 收款守恒 C5 ENG2 | 外部流水唯一、合款/分笔/不足/多付、分配与返款并发，原付款人返款与unknown冻结 | round7真实角色receipt现金分配/原付款人返款/unmatched/跨租户隔离PG通过；实际运营桌面待验 |
| 14 来源退款 ENG6 | 无授予现金退款、未来取消计划、升级依赖检查、开通依赖检查，不扣无关来源；外部成功本地失败恢复 | round7真实源点reserve/settle、服务scheduled/completed、容量/品牌/店铺/feature、未来取消/开通依赖、升级restore/外部回执重放通过 |
| 15 同事务/RLS ENG1 ENG2 | sale→receipt→Workspace→order→period→ledger，真实merchant_app/ops bootstrap与tenant FK/RLS | round7完整263迁移+角色bootstrap、真实app/ops链路、tenant隔离、immutability反例通过 |
| 16 上架通知 ENG3 | publish/outbox原子、200硬批次、lease/cursor/dedup、成员/私有读时复核、退成员拒绝 | round7真实PG publish/outbox、bounded fanout/lease/recovery/ACL/privacy通过；商家通知点击桌面待验 |
| 17 UI 状态 D2 D5 D6 | empty/error/loading/409/unknown不重建单，16px、金额确认、键盘/focus、1440×900/200% | 目录真实1440×900/200%、16px44px/Esc/输入保留通过；支持真实回复截图通过，购买unknown等桌面待验 |
| 18 本地插件 DX-T1 DX-T3 | 当前/受支持旧/兼容回滚三版本；旧upgrade无quote拒绝；safe错误授权动作；商家无Ops工具 | owner当前/旧stdio安全读通过；最终0.2.7 production包真实个人安装/stdio 131tools已通过，QA读JSON oktrue；ChatGPT宿主新快照/真实业务与兼容回滚仍待证据 |
| 19 配置/支持/文档 DX-T2 T4 T5 | manual_transfer独立批准模式；relay真实证据与缺配置拒绝；首单前真实人工工单交接；既有四手册同步 | 真实首单前工单、平台GUI内部/客户回复、仅客户公开回复、真实同企业第二用户工单404隔离全部通过；中转/销售配置仍待证明 |
| 20 发布与兼容 C6 ENG4 | 类型、风险测试、desktop、container、release gates；expand/compat/forward-only迁移恢复；101部署同身份测试 | 101当前real DB尾258、现网release e8c9f98e33df；本次新功能未部署；普通runbook桥仍NO-GO须逐项解决 |

## 本轮发现及行动

1. 新升级政策字段未暴露于 Ops 编辑器，但后端报价要求 `upgradePolicy.approved/version`：已报 owner 补编辑/审批/发布校验；没有可配置路径不能签收自助升级。
2. 首购合款 `allocateBatchAndFulfill` 已存在，但初审时实际 API 只单行：已报 owner 补 batch contract/API/桌面；复核新增契约正在出现，仍需测试。
3. `audit-ops-surface` 实际失败，新方法未 UI 引用：checkout、batch allocation、unmatched cash、request lookup 共9项；已报 Ops owner，禁止通过 server-only 豁免代替接线。
4. 新 PG 用例进入隔离/CI/default pending manifest；新增目录非hermetic计数45并明确contain断言；同时发现既有两项image PG未CI注册，仅补入口，不改其业务实现。
5. QA `qa-pg-round-1.log` 未运行任何PG断言：owned fixture container_start / POSTGRES_NOT_READY。`artifacts/isolated-postgres/run-npWQdY/run-result.json` 与fixture-failed保存失败和 exact-ID owned cleanup；没有触及共享/业务数据。必须资源稳定后重新执行。

## 101 只读审计

SSH 连接成功。当前Compose项目 `merchant-demo-85575f9c`，API/replica/6 worker/UI/Ops/payment/gateway/PG16/Redis健康（registry未定义health）。API工作目录 `/var/lib/merchant-release-security/demo-deploy-e8c9f98e33df`，API image ID `sha256:1316371541db2bd63ec7eca183f339aed7f8cc2102611fa27136c12837e67398`。实时 `schema_migrations` 尾258 `knowledge_generation_claim_usage_evidence`，其后257/256/255/254连续；该尾部只读采样不是全链checksum/双运行角色边界证明。

公网 `/api/releasez` 当前 ready=true，release ID `release-e8c9f98e33df-demo-qa`，SHA `e8c9f98e33df2c5639d35764dd072e7d37657b96`，manifest SHA `16892ade4386a20adc3a29643ceeb2377f2dd85ed511bb7efcfc296067f0f8d7`，image set `sha256:2166f0d725e6fd2b08e2575ee255bb2ad9c50835a42e99e2b53c7dc7b5b628e0`。这是旧部署健康，不能充作商业新增部署成功。本 agent 只读审计，未部署/迁移/切流。

## 11:40 增量证据

- 串行隔离PG第二轮（`qa-pg-round-2.log`, `artifacts/isolated-postgres/run-s61pUC/vitest.json`）：目录和通知各1项真实PG passed；receipt全迁移后缺 `commercial_order_terms_v3`，1项failed。整体FAIL，不能合并宣称通过。根因为loadMigrations仍只注册至258；QA经owner授权仅新增259–263注册和正向尾号/名称测试，不改历史SQL。
- `qa-test-entrypoints-round-2.log`：CI分母2、pending manifest17、外部商用规则coverage6，共25断言 passed。这只证明入口与既有规则，不证明新商业运行链。
- `qa-transaction-collection-round-2.log`：migration17、pending17、CI分母2，共36断言passed；新增全链交易5项在默认环境明确pending5，不能记作业务passed。
- 新增交易PG测试使用新随机DB完整263迁移、真实merchant_app/merchant_ops连接、migration后ensure-app-role.sql bootstrap；含首购batch故障回滚/重放/RLS、首期等待开通恢复、连续升级/目标Boolean实际消费器、有效quote改价锁价/过账期待处置、并发浮动续期/未来计划/过期窗口。待源退款接口落地后追加来源restore。
- `qa-ops-entry.png` 是实际gstack 1440×900截图，仅登录页；授权商品页验收尚未达到。

## 11:42 全链第一次验收

`qa-full-chain-pg-round-1.log` / `artifacts/isolated-postgres/run-Cd4yOc/vitest.json`：全链263 fixture成功启动，receipt现金守恒/并发/租户隔离1组 passed；registry-derived zero/unknown/insufficient外部零副作用1组 passed。交易5组因beforeAll真实merchant_ops写 `commercial_catalog_skus` INSERT permission denied而全部未执行；整体FAIL，不允许改用superuser逃过角色验收。已通知目录/role owner补精确ACL与bootstrap闭包。第6组来源升级退款restore已追加，覆盖无关250点及开通赠点保留、单账期日期、恢复原基价4000元半期下一档报价、外部成功重放不重复回收。

## 11:48 全链第二次验收及分类

`qa-full-chain-pg-round-2.log` / `artifacts/isolated-postgres/run-EzImIA/vitest.json`：8项真实断言，3 passed / 5 failed，整体FAIL。依赖首期恢复、未来浮动续期/点数worker、receipt守恒各1项 passed。

- 真正阻断：Ops callback/refund对 `commercial_orders_v2` 的FOR UPDATE权限缺失；已由receipt owner修261+bootstrap闭包。邀请码创建新Workspace之前未设置精准workspace scope造成RLS拒绝，application owner已修，需重跑。
- 两个失败来自QA对原始PostgreSQL bigint revision的错误数值假设（`"3"`/`"1"`与number比较）。已在测试只读SQL显式`revision::int`，不修改业务或弱化金额/账期断言；有效quote在改价后金额150000和过账期收款进入reconciliation事实上已走通。
- 所有断言继续使用真实merchant_app/ops；不切superuser、不扩大租户RLS。两次失败现场与测试报告保留。
- 专用桌面spec已准备且`node --check`通过，owner要求候选ready前暂不启动，不能将语法检查算浏览器通过。

## 11:52 全链第三次验收

`qa-full-chain-pg-round-3.log` / `artifacts/isolated-postgres/run-V1y0Vd/vitest.json`：句柄35152已明确terminal exit1，8项6 passed / 2 failed。交易6项中5 passed：依赖恢复、连续按剩余有效期升级/Boolean权限消费、有效quote改价冻结/迟到账处置、未来浮动续期/worker点数、安全升级来源退款恢复。receipt1项 passed；该文件在测试后仍由owner追加用例，不能把round3绿色绑定后来读取的Ops锁/immutable/跨workspace新断言。

- 首购batch阻断为QA callback缺providerOrderId，已按真实DTO显式补providerOrderId/paymentSubjectRef；直接pay测试调用删除不属于VerifiedPaymentGrantInput的verified字段。未cast绕类型。等待第四次运行证明。
- 邀请RLS问题已走通，confirm末尾审计INSERT的$2同时identity_id/actor_id类型推断冲突，是新的运行失败；application owner已收到准确SQL栈。
- `qa-entrypoint-final-round-2.log` 56项55 passed / 1 failed；当前Ops UI审计仍遗漏unmatched receipt list/match/record三个控制面，`qa-ops-surface-round-2.json`明确列出。不能将它们加入server-only白名单冒充PRD完成；须真实运营UI接线和实际验收。

## 11:56 全链第四次验收

`qa-full-chain-pg-round-4.log` / `artifacts/isolated-postgres/run-l4drpQ/vitest.json`：句柄36743显式terminal exit1；六文件11项9 passed / 2 failed，另1个cleanup unhandled error，整体FAIL。邀请码实际创建/激活/一次消费/无付费权益事实、目录批准销售/冻结包/RLS、通知有界恢复/ACL、registry-derived零/未知/不足副作用矩阵均passed；交易5/6 passed。

- 首购batch完成时真实Ops INSERT `commercial_access_decisions_v2` permission denied，receipt owner补261+bootstrap精确append-only事实ACL；不能切管理员执行。
- receipt owner刚新增真实点操作seed line77违反 `creative_point_operations_check`，且客户端异常路径没有finally release导致fixture afterAll DROP FORCE产生57P01 unhandled；已通知owner修合法seed与cleanup，不掩盖业务失败。
- Vitest未处理异常序列化了已销毁隔离fixture的临时连接口令；日志和JSON口令字段已脱敏，原始失败类型/栈/断言仍保留。未输出或读取共享业务凭证。
- 非points-only退款仍需真实已履约service、已分配源点和依赖开通退款拒绝证据；receipt owner承接新独占PG blockers文件，QA随后登记和串行执行。

证据更正：round3 receipt绿色仅绑定该次Vitest加载版本；owner在round4前追加grant操作seed和unmatched return等用例。round4 seed失败，最新immutable反例尚未执行。最终必须冻结源码后重新跑，不以事后读到的测试源码补全过去执行证据。

## 12:00 真实桌面目录验收

`qa-browser-catalog-round-2.log`：owned隔离PG/Redis/真实password session/API/1440×900 Chrome，句柄45561明确exit0，1完整test passed（15.2s）。5张PNG目录为 `artifacts/ops-jit-isolation/2026-10-05T03-59-02.028Z-5c141f42-7f4f-4916-bc21-f4acc1c7a4e5/commercial-packages/`。覆盖三类目录、销售价格/周期分区、草稿无效校验保留输入且无mutation、16px/settled44px、Esc恢复焦点、6×500开通赠点默认和不含首期提示、200%桌面及去阴影。已直接查看200% PNG，目录与按钮可读、表格局部横向区域。

第一轮因QA取Ant Modal动画scale首帧导致8.8px断言失败（44×0.2），只将测量改为retry等待settled真实boundingBox，未修改UI或放宽44标准。该绿色不包含商品批准上架/真实付款/商家升级/首单前支持全流程，后续必须继续实际验收。

新 `commercial-source-refund-blockers.release.postgres.test.ts` 默认pending5已注册CI/config。eng owner当前独占追加storage实际消费交易PG测试，QA待其冻结/count后更新清单再串行运行。

## 12:03 首单前支持真实运行

`qa-browser-support-round-2.log`，句柄91989明确terminal exit1；实际Chrome登录商家→财务首单前支持→POST 201→真实ticket回执与截图通过，未创建付款/订单意图。`artifacts/ops-jit-isolation/2026-10-05T04-03-06.814Z-ed3175cf-acb7-4c2c-a549-4e0f007e60b5/commercial-support/01-real-no-order-receipt.png` 已落。

Ops真实platform password cookie调用 `ops.support.ticket.get`，指定精确当前企业，403；该run/api.log明确 `AUTHZ_WORKBENCH_MISMATCH`，capability `support.ticket.read`。既有平台客服queue是aggregate-only，不能选择真实单客户工单；当前无法从平台运营工作台读取/回复首单支持。已报root/application owner；不切workspace header或伪造授权把测试跑绿。客户可见回复与同企业他人实际工单拒绝因前置失败尚未执行，不可claimpassed。首轮仅QA把HTTP创建201错误expect200（已修），并非生产错误。

source refund blockers最终7项（新增实际source point reserve/settle拒绝）已更新pending清单；service采用真实Ops消费器和冻结source额度校验，不用超级用户伪造metadata。

## 12:09 全链第五次验收与补测范围

`qa-full-chain-pg-round-5.log` / `artifacts/isolated-postgres/run-5BmbDr/vitest.json`：句柄63715显式terminal exit1；21项13 passed / 8 failed，另1 cleanup unhandled error，整体FAIL。交易9中8 passed，新增实际storage/brand/store source恢复阻断和feature无来源未使用证明拒绝均执行通过。首购batch此前Ops ACL已走通，仅QA读取gift.points bigint字符串与number比较错误，已显式只读SQL `points::int`，不改业务或弱化6×500断言。

source blockers7全部止于fixture准备的catalog有效时间：firstAt是昨天，SKU publish effectiveAt是现在，真实approved guard正确拒绝；退款service/points/future/dependency分支尚未到达。owner修测试clock，不削弱guard。receipt业务1passed，cleanup仍有57P01（该test origin），不能让它混进绿色；已要求等待真实backend结束后去FORCE/drop精确ownedDB且不吞未处理错误。临时fixture口令已脱敏，保留全部错误栈和断言现场。

QA追加第10个交易PG：真实旧500合同6个月逐期dispatch/expiry/replay；实际批准开通费和赠点600的新版本，新合同600但老合同继续500；漏发窗口只记expired不重发。文件和default pending10已冻结待执行。此为500/600关键运行证据，纯mockSQL单元不能替代。sourceblockers7的下一完整serial分母为22。

`qa-entrypoints-final-round-3.log`：quality入口16/pending17/CI分母2，共35断言passed；Ops surface实际扫描unreferenced=0。只是接线/收集证明，不表示最新业务runtime全绿。

平台支持root新增受控platform methods与GUI后，第三轮真实两端fixture7663正在运行。GUI明确从已授权目录选目标企业、真实预览确认回复；再通过授权邀请+客户自主激活第二同企业账号验证本人隔离。不切tenant workbench、不追加付费grant。

## 第六轮进行中的事实与支持 GUI 状态

`qa-full-chain-pg-round-6.log` / `artifacts/isolated-postgres/run-7a6lD9/`，原句柄8059仍运行，未形成最终结果。交易10项中原9项全部通过，新增赠点逐期/改价案例失败；默认reporter尚未输出失败栈。source blockers7项在beforeAll初始化超过120秒，全部skipped，不能计为退款拒绝运行成功。zero-side-effect真实PG矩阵1项通过。维持原fixture等待终态，不重启并行测试，也不停止另一用户独立PG进程。

支持第三轮句柄7663已terminal exit1：真实platform ticket get和企业目录200通过，随后QA选择器点击Ant虚拟隐藏ARIA option超时；已改为可见dropdown真实行，并保留正常点击、不强制注入企业。客户可见/内部回复与同企业他人工单404尚未执行，等待当前PG终态和DX runner商业lease段冻结后重跑。

## 第六轮终态

8059明确terminal exit1，run-7a6lD9/vitest.json：22项14 passed / 1 failed / 7 skipped，7files 5passed/2failed，无unhandled error。catalog/notification/invitation/receipt/zero最新版本均通过，交易原9项通过。gift failure准确位于test257：expected500 received1000；余额读取漏传模拟的2027 due，默认实际2026当前时间把未来过期批次仍视为有效。QA已使用现有getBalance(ws,due)显式同clock，保持500断言，未改变业务规则，修后尚待真实PG重跑。source blockers beforeAll line26达到120000ms hook超时，7案例未执行；不把skip当退款通过，后续单独串行复验。

第七轮：root明确授权完整七文件22项重验，句柄99166，qa-full-chain-pg-round-7.log。仅source blockers beforeAll迁移/role bootstrap等待120→300秒，保留第六轮失败证据；业务时序/断言未改，gift余额读取显式due。启动前root确认其他团队全局检查已终态且不会并发PG/release-gates；不将机器资源归因作业务通过证据。所有结论等待本轮真实终态。

## 第七轮真实PG全部通过

99166明确terminal exit0，run-Sgzgj1/vitest.json / qa-full-chain-pg-round-7.log：7文件22 passed / 0failed / 0skipped，无unhandled，26.89秒。交易10项（包含冻结6×500、新批准600、逐期失效和漏窗不补发）全部执行通过；source blockers7项真实Ops服务scheduled/completed、App源点reserved/settled、零点取消拒绝、未来合同取消保留无关点、开通paid月依赖拒绝全部通过；最新catalog/notification/invite/receipt/registry-zero均通过。该绿色绑定本轮冻结源码和真实隔离PG，不包含尚未验证的浏览器销售/ChatGPT宿主/101上线。

DX确认runner可选商业lease段freeze，support缺少显式salesflag仍保持C6 closed。随后仅启动支持GUI第四轮，句柄81414，qa-browser-support-round-4.log，无并行PG。

## 支持第四轮实际进展与邀请阻断

81414明确terminal exit1。真实商家无订单登记POST201→平台GUI从授权企业目录选择→读工单→内部及客户可见两次实际preview/confirm回复200→商家读取仅客户可见内容，全部执行通过。三PNG在artifacts/ops-jit-isolation/2026-10-05T04-31-33.067Z-91667cf9-ca1f-42d5-9bc8-e019355aa187/commercial-support/，已直接查看客户回复PNG（ticket/status/客户回复可见，内部备注未出现）。

随后真实平台POST /v1/ops/merchant-accounts创建同企业第二用户邀请503，api.log:123 request req_1db32778-8488-4861-99d8-aa02183a4eeb error_code42501，payloadcreate_workspace=false、精确现有workspace_ids、无capabilities/付费grant。因此同企业他人工单实际404隔离尚未执行，不能称支持全绿。已报root与application owner查真实HTTPpool/role/scope差异；不扩大RLS、不用假第二身份绕过，ownedfixture正常disposed，无livefixture。

邀请owner定位existing branch的SELECT FOR SHARE需要UPDATE权限，已改精准scope普通SELECT，未扩大Ops Workspace写权限；激活仍在同事务复核active workspace，企业暂停会回滚。原1个invitation PG中追加同企业第二用户/无UPDATE/暂停反例，分母仍22。修后需单文件真实PG+支持GUI顺序复验，不以之前新企业路径绿色补证现有企业路径。

root独立只读101运行API配置键存在性检查：manual_transfer批准、receiver/account/verificationpolicy和runtime evidence缺失（未输出值）。正式购买配置阻断仍未解决，root已向用户询问配置来源；localownedfixture验收继续，不生成伪正式收款/门禁证据。

邀请最小修真实复验：30470terminal exit0，qa-invitation-existing-workspace-pg.log / run-IK6GlH/vitest.json：1test通过，实际覆盖第二同企业用户、merchant_ops无Workspace UPDATE、disabled企业激活完整rollback（pending保留）。此前“suspended”描述更正为真实schema disabled值。仅省略existing SELECT FOR SHARE，不增ACL或减身份/企业状态复核。然后启动支持GUI第五轮79541，等待终态。

支持第五轮79541terminal exit1：真实邀请201/自主激活200通过，权限修复已实际HTTP证明。第二用户工单401的真实api日志次序为127 support request→128UNAUTHENTICATED→129 login200；QA只等待登录按钮hidden（loading时也hidden），漏等待login响应。已加真实login200 wait（与第一用户相同），不改业务或伪会话。开始第六轮37239，qa-browser-support-round-6.log，唯一ownedfixture；本人隔离仍以最后实际404断言为准。

## 支持第六轮完整真实验收通过

37239明确terminal exit0，qa-browser-support-round-6.log / artifacts/ops-jit-isolation/2026-10-05T04-37-21.945Z-16b7f2f6-414c-4ce2-a31b-3ce3c1342daf/playwright.json：1完整test passed22.3秒，真实Chrome1440×900、passwordcookie、API和隔离PostgreSQL，无HTTPmock或工作台授权伪造。商家无订单登记201→平台GUI授权目录选择→内部/客户回复各真实preview-confirm200→商家仅客户可见回复→运营真实邀请同企业第二用户201/自主激活200/实际login200→第二用户support201→第一用户GET第二用户真实工单404且无正文泄露全部通过；无order/payment/receipt写。三PNG在该run/commercial-support，已直接查看本轮平台回复PNG。ownedfixture正常disposed，root可串行完整release-gates PG。

## 整体发布门禁当前仍失败

root第五轮完整typecheck66495 terminalexit0（rootowner证据）。root完整release-gates首轮49603因旧tail258断言vs263失败，最小更新绑定release metadata尾号并保留全部254→255/256→257真实prefix场景。第二轮81789日志真实反例：API prefix254/255在creative-point-repository.refreshBalance SQL访问261的commercial_refund_source_holds_v2不存在；worker255 automation仅发tick，缺预期storage/orphans/cleanup。上述属于实际兼容运行缺口，全263的22PG通过不能替代旧prefix能力。QA已发root准确栈，不跳过场景或删除预期来绿；等待owner修后完整重新验收。root独占PG期间QA未起fixture。

插件安装差距最新更正：contracts owner已完成最终0.2.7 / plugin0.1.0+codex.20261005042504真实production个人安装+stdio，131工具/68运行文件一致，旧入口及配置归档完整、旧版本缓存/凭据未修改。QA只读plugin-final-personal-stdio.json明确ok=true，并核对plugin-production-release.md最终段；该证据属于owner实际进程，不冒充QA重跑。此前122/131差距为历史已修问题，仍保留失败日志。host_restarted/host_loaded_new_snapshot_verified仍未证，不把安装/stdio安全读当已配置商业API或ChatGPT宿主加载通过；dirty-source unsigned candidate状态仍在。

赠点read/API/UI补齐后，application owner在交易PG追加第11个独立it，保留原10；实盘pending10→11，完整七文件分母变23。新增检查gift available、两初始knownorigin/crossworkspace、跨两grant预留unknown、expiry/latergiftdispatch及商业2month seq2来源，当前未执行，不能归入之前22pass。rich赠点说明/六批UI与pointorigin也待新sales真实浏览器，静态存在不等于通过。DX扩展sales已覆盖脚本三档隔离批准值/三类调价/未来续期/停售归档旧单/赠点来源计划，等待最终freeze且rootgates终态才运行，无并发fixture。

## 最终scope继续补齐与兼容根因更正

root CEO全文复核发现明确剩余范围：目录发布复用交易validator、bundle真实分页/订单引用、商家源冻结rank及三档权益比较、通知结果/markread。通知新增独立264迁移已授权worker实现，最终loader/metadata/CI分母按实际freeze统一；不能把旧263/22PG数字当新链全部通过。QA保持无fixture，等待最终SQL/源码/metadata冻结，再按rootgates→QA最新完整PG→扩展salesGUI串行。

兼容报告更正：eng复核commercial函数实际在254已有，qualification_projection所依赖259事实缺失才是旧prefix正常准入读取关键差异。上述是后续准确根因；前文“schema缺commercial function”如出现仅是当时假设，不能作最终根因。root保留failclosed与真实prefix场景重新核验，QA未自行放宽资格。

生产profile新增必要验收：root只读发现requireStoreOnboarding的exact豁免未包含新增subscription/checkout/notifications/quote，本地NODEdev GUI未触发这层，不能替代production行为。已由root最小加入共享MCP_COMMERCIAL_METHODS精确集合（无regex商业wildcard、无模型/真实发布动作），保留真实身份/tenant/capability/C6。最终候选须用实际productionprofile API/MCP验证已激活但未绑定店铺、未商业开通商家可读目录/首购/当前/通知；模型与真实发布继续被原storegate拒绝且无外部副作用。修后该组仍pending，不用source存在或此前NODEdev绿色称完成。

QA原角色续接：新增264通知结果/已读PG实盘已是2个postgresIt，pending1→2；交易11+sourceblockers7+notification2+catalog/receipt/invite/zero各1，七文件预期24项。此为源码计数/入口登记，未真实执行收集，不称24pass。source/metadata尚未最终freeze；root独占signedmode/markread/bootstrapworker，QA保持无PG/browser，不重启之前已经终态fixture。

root迭代状态：第六轮完整typecheck96079明确exit0（packages/root/两端UI），35目标API tests93839exit0；完整release-gates round5原85297正在严格legacybridge。264metadata当时验证264/384methods/132merchanttools；仍非最终release冻结，bundle真分页需要新265专属Ops只读函数，root已授权CEO实现。当前24PG仅预期分母、尚未复验新264/265链；QA保持nofixture，不用旧263/22绿色替代新链。265loader/metadata及最终it分母待owner冻结实际收集。
