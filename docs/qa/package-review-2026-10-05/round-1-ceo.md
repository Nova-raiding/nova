# 套餐与权益包需求：第 1 轮 CEO / 产品评审

日期：2026-10-05。评审者：原生 GPT 独立子 agent。模式：HOLD SCOPE。结论：**DONE_WITH_CONCERNS / issues_open**，存在 9 个需求设计缺口，修订后应复审；不能称“没有问题”。未修改业务代码、未操作生产或支付、未运行外部模型 CLI。

方法来源：完整分段读取 `/Users/lixiaomei/.codex/skills/gstack-plan-ceo-review/SKILL.md`；其软链所指 skill 目录缺少 sections，实际 sections 已定位并读取 `/Users/lixiaomei/.gstack/repos/gstack/plan-ceo-review/sections/review-sections.md`。按 owner 的 autoplan skip list 跳过通用 preamble、交互提问、外部 CLI、正文报告注入和外发。执行 11 段业务评审及必需输出。本文中的错误码为建议契约，不能冒称现有实现。

## 0 前提、现状、替代方案与范围

前提成立：运营需要管理可售商品且必须能实际开通，单有编辑按钮不能达成目标。用户已经确认可改价格、开通费不含首期、开通赠点六个月每月 500 点、三档初始价格和剩余期差价；本次不重新挑战这些规则。真正结果是目录发布、通知、自助/运营代购、到账核验、已购权益及插件准入一致。若不处理，停售仍可选择历史版本、升级按全价、运营无法可靠代购等现存问题持续存在，不推算收入损失。

系统审计：HEAD `84bbf015`，`git diff main --stat` 空；有历史 stash，未打开/应用；最近提交集中插件与模型真实调用，本方案不能破坏这些准入约束。已读取 AGENTS.md 和 `doc/todo/architecture/package-entitlements-and-services-architecture-2026-08-31.md`。项目未发现根目录 TODOS.md，不创建平行事项体系，未完成任务交给 owner 集成现有需求。相关商业源码搜索没有 TODO/FIXME/HACK/XXX 命中。

### What already exists / 复用映射

| 子问题 | 复用基础 | 评审判断 |
|---|---|---|
| 目录版本 | commercial catalog V2、FinancePage、catalog handler | 扩展现有入口，禁止新建平行目录 |
| 商家下单 | `commercial-purchase-service.ts:35–53` | 已有服务端 SKU 快照，upgrade 当前映射 monthly，必须专用分支 |
| 金额与收款 | `commercial-contract-repository.ts:500–535,642–698` | 订单 immutable amount，核验精确金额，新增收款分配层复用授予核心 |
| 提前续费 | 同文件 `stackSubscriptionPeriod:248–310` | 已有 Workspace advisory lock 和未来账期顺延，不可用升级覆盖 |
| 开通赠点 | 同文件 `resolvedOnboardingSchedule:356`、`:734–766` | 六笔计划已有实现基础，沿用来源和到期，不重启 |
| 权限与真实链路 | commercial access、continuous entitlement、stdio bridge | 复用统一准入，购买不绕过 RBAC、点数和模型 readiness |

### 实现替代方案

| 方案 | 努力/风险 | 利弊及复用 | 完整度 |
|---|---|---|---|
| A 最小补丁：修目录停售、扩 FinancePage，余流程以现有独立订单驱动 | M / 中 | 改动少、复用多；无法独立完成报价与收款分配，也难表达升级事实 | 6/10 |
| B 推荐：现有 V2 目录/订单/账本增加销售投影、权益包、报价、收款分配和事务协调 | L / 中 | 达成全部授权范围；多组件同步复杂，但保留 append-only 历史和真实门禁 | 10/10 |
| C 独立重建计费中心后迁移旧系统 | XL / 高 | 分层自由；重复门禁、迁移面大且产生双事实源 | 8/10 |

推荐 B，原因是必要的新事实类型无法靠表单补丁替代，而全量重建没有业务理由。不是因“少文件”牺牲授权闭环。核心仅增加明确的事实与协调边界；周期 UI 的多选项可先草稿展示，消费器未实现不得销售。

```text
CURRENT                        THIS PLAN                     12-MONTH IDEAL
旧/新商业并行、停售不可靠 --> 单一版本目录 + 统一收款与授予 --> 每笔收款可追溯到合同、权益与实际使用
全价 upgrade、客服入口         商家自助 + Ops 同规则          无需猜测“钱到了/权益到了/能用了”
```

Dream state delta：本方案足以朝该理想前进；仍须明确以下时序和业务语义，不能以配置能力存在代替商品获准出售。

NOT in scope：公开/团队插件市场、ChatGPT OAuth、移动端、自动扣款、降级/退款新品政策、跨周期价格换算、外部竞品研究、独立计费平台重建。现有退款/补偿能力仅作为异常恢复复用，不在评审中引入新政策。

时间审问：基础阶段要冻结首购依赖与商品档位；核心阶段会碰到报价有效期与延迟核验；集成阶段会碰到未来续费和多单收款；验收阶段会碰到升级增量、重复发放与 rollback。这里是依赖次序，不作压缩工期承诺。

## 问题清单与建议补丁

1. **CEO-01 P1 CRITICAL GAP：首购合购与开通门槛可能死锁。** 需求第 212 行要求正式套餐购买检查开通资格，第 264 行又要求首次创建开通费和首期两笔订单。当前资格在第一笔款核验后才生效。建议冻结：普通独立套餐下单要求已开通；首次合购允许服务端创建同一 checkout 的依赖订单，但套餐授予必须依赖开通订单核验成功。同单等额收款按明细分配，在一笔事务中先记开通再授予首期。部分到账仅完成已足额且依赖满足的订单，其余明确待核验；不得提前使用套餐。为此制定批次/行状态，不只是“在实施时明确”。

2. **CEO-02 P1 CRITICAL GAP：已付款升级因晚核验可能无法兑现。** 第 234 行锁价且不因支付回调延迟改变金额，第 272 行却要求升级使用“有效报价”；到款、核验、报价过期、原套餐到期四个时点不清。建议区分报价接受截止、真实到账时点、核验完成时点；在报价接受窗口内到账可核验原价，不因回调迟到重报。核验时原账期已结束，禁止创建已过期套餐或负剩余权益，进入 paid_pending_resolution 并按已有人工对账/补偿流程处理，不自动再扣钱或延长原到期日。真实到账超出窗口的转账进入待核验异常，不无声吞款。失效时间必须不晚于原账期结束。

3. **CEO-03 P1：提前续购与当前升级关系未定义。** 第 9 节要求提前续期，第 230–240 行只谈当前账期。源码 `stackSubscriptionPeriod` 明确将已付续费排到未来。建议当前升级只作用于唯一当前账期；未来已付套餐按原合同继续，UI 展示未来待生效版本并告知本次升级不改未来合同。若未来改档未在现有受控流程内实现，则明确阻断该额外动作，不能覆盖订单或多收款。已过期新购、同级续购、升级三条分别有契约。

4. **CEO-04 P1：价格可改但档位身份/升级比较基准缺失。** 第 230 行列三方向，第 4.1 节允许价格修改甚至目标不高于当前价；不得以价格高低推断档位。建议定义不可随售价变化的 plan_family 和 rank（基础/成长/尊享），身份建立后固定；同 rank 新版本为续购，升 rank 才为升级；价格负/零按文档已有“政策未批准阻断”，提供明确错误，不自行发零元升级。私测/custom 不能猜 rank。

5. **CEO-05 P1：增量权益算法类型尚未封闭。** 第 240 行“规定增量”“按批准规则”本身是安全门禁，却没有规定运行时怎样判断配置完整。具体点数/服务数值是商品参数，不应虚构。但规则结构必须定义：布尔权限升级后立即按目标集合；品牌/店铺/存储上限切至目标配置，历史消耗保留；可消耗点数/服务时长必须绑定批准的 upgrade_policy（差额是否按剩余期折算、整点取整、有效期、已用/预留处理），无 policy 只能草稿/不可报价。验收用独立明确 fixture 参数验证，生产按批准版本，不沿用价格四舍五入到“分”的规则来取整点数。

6. **CEO-06 P2：审批语义自相矛盾。** 第 4 节写“编辑会使旧审批失效”，第 6 节又要求批准内容不可变且在售 v1 与草稿 v2 共存。建议改为“新草稿未经审批；不得继承来源版本审批；修改本草稿使其审批失效。v1 审批及已售合同不受影响”。批准版本不能原地编辑。

7. **CEO-07 P2：重新上架通知事件去重粒度冲突。** 第 218 行按商品版本/收件人去重，第 4 节又允许同版本重新上架。若 v1 下架后重新上架，通知会被旧键压掉。建议去重键是一次销售发布事件 id + Workspace/用户；事件含版本，投递重试同事件不重发，新发布事件可发新通知。通知消费时和详情访问时重新校验目标用户权限，避免队列延迟后退出企业者仍收到私有商品信息。

8. **CEO-08 P2：下架前旧订单的规则仍标“建议/待业务确认”，不能叫最终方案无问题。** 第 4.1 节与第 11 节未冻结。建议保留旧快照的已创建有效订单可付/可授予，与改价锁单规则一致；下架禁新订单/新报价；归档不否定有效旧单。对违规/错误商品的强制暂停履约是已有例外风控动作，不能偷偷等同普通下架。报价转订单的销售状态校验与锁价窗口需写清。

9. **CEO-09 P2：方案缺少按业务结果的可观测与回滚验收。** 第 9 节列异常/重放和容器健康，但没有“钱到权益未到”、赠点漏发、通知积压的可查询结果与恢复入口。建议复用 Ops 的对账/审计，不新增庞大监控产品：以 payment/order/grant/quote/outbox ids 串联，能够查待授予原因、重试结果与异常分配；上线停用新下单/升级写入口时仍保留旧单核验、已付授予、账本和 worker；回滚应用不删新事实和迁移。健康检查不能替代业务对账。

## 1 Architecture Review

目录、商业订单、收款事件/分配、授予事实和异步投递分界合理，建议 B。首购多单依赖和升级不能直接进入当前 monthly 顺延器（CEO-01/03）。单点为 PostgreSQL，真实收款核验权限与回执也为外部依赖；故障应保持待核验。10 倍先压通知 fanout，100 倍先压付款分配锁和 Workspace 锁；不得为了吞吐去除商业事实锁。

```text
Ops / Merchant / stdio MCP
  -> 身份 + Workspace + RBAC
  -> Catalog approved version + Sales projection
  -> Checkout / Order / Upgrade quote
  -> Payment receipt + Allocation
  -> Dependency validation + Workspace lock
  -> Qualification / Period / Entitlement / Point ledger / Audit / Outbox
  -> Worker [points due | notification delivery] -> Merchant + Plugin access
```

状态：草稿→待审批→批准/拒绝；销售未上架→在售→下架→显式重上架/归档；报价 open→accepted/expired/conflict；订单 pending→payment_verified→granted 或 paid_pending_resolution（应由事实/投影表达），禁止 pending→granted 无支付。首购依赖保证套餐不得先于开通授予。对应失败与恢复见第 2、9 段。

## 2 Error & Rescue Map

所有错误应带 actor、Workspace、request id、order/quote/version id，不日志输出完整转账凭证或密码。下表是设计契约建议；已有 CommercialPurchaseError / CommercialContractError 可承载，不新增 catch-all 吞错。

| Codepath | 命名错误/触发 | 现方案覆盖 | 救援动作 | 用户所见/验收 |
|---|---|---|---|---|
| Publish | CATALOG_CONFIGURATION_UNRESOLVED / 消费器或政策缺失 | 有门禁 | 留草稿，列逐项 blocker | 不可发布；API/PG |
| Mutate | CATALOG_REVISION_CONFLICT / stale revision | 已明确 | 409 保留输入、读新版本再提交 | 冲突；双标签页 |
| Checkout | ONBOARDING_DEPENDENCY_UNSATISFIED / 未开通 | GAP CEO-01 | 首购依赖订单或拒绝普通单 | 明细待核验；首次合购 |
| Quote | UPGRADE_POLICY_UNRESOLVED / 无权益算法 | GAP CEO-05 | 拒绝报价，无扣款 | 说明配置未批准 |
| Quote | UPGRADE_QUOTE_EXPIRED / 过接受截止 | 部分 | 重新报价，保留旧报价审计 | 失效；边界时刻 |
| Verify | UPGRADE_PERIOD_ENDED / 到款后期满才核验 | GAP CEO-02 | 记到账/异常，禁止过期授予，转对账 | 钱已到待处理 |
| Allocate | PAYMENT_ALLOCATION_EXCEEDED / 总分配超实款 | 已明确 | 锁流水、拒绝重分配，不授予 | 实款/剩余可分配 |
| Verify | PAYMENT_EVIDENCE_UNVERIFIED / 无到账凭证 | 已明确 | 待核验，列证据不足原因 | 未开通 |
| Grant | GRANT_TRANSACTION_FAILED / DB 超时/中断 | 原则有、救援不具体 | 查询提交结果，幂等重试；不能另建赠点计划 | 处理中/待授予 |
| Notify | NOTIFICATION_DELIVERY_FAILED / worker 错误 | 有重试、重上架键 GAP | 事件 id 幂等、指数退避和死信可查 | 权益已生效，通知待投递 |
| Read | COMMERCIAL_REPOSITORY_UNAVAILABLE / 仓储不可读 | 已明确 | 明确不可用，不返回成功空目录 | 重试入口 |

无新增模型调用，因此无新增 malformed/refusal/empty 模型分支；套餐权限照常消费已有 readiness，不能因上架误宣布模型配置就绪。

## 3 Security & Threat Model

跨 Workspace 指定客户/订单是高影响、中可能 IDOR，已由 RBAC、tenant FK、RLS 缓解；验收必须覆盖 Ops 服务端真正代购权限，不能冒用商家身份。流水重复分配中可能、高影响，需锁实际收款事实；同 provider_event_id 全球唯一与合法一款多单分配是不同概念。私有通知延迟后越权是中可能、中影响，补 CEO-07 的投递与读取权限复核。输入须限制分项金额整数/币种、名称长度、code 格式、period enum、证据引用域及文件权限；HTML 名称仅作文本展示。沿用现有凭证存储，不引入新 secret 或 npm 依赖。日志脱敏、证据有最小权限、支付核验审计保留。

## 4 Data Flow & Interaction Edge Cases

```text
发布：SKU/version -> validate -> sales transaction/outbox -> fanout -> inbox
首购：Workspace/lines -> dependency/price -> immutable orders -> receipt/allocation -> grant
升级：active period/target -> quote/policy -> accepted payment -> revision check -> switch
读取：authorized scope -> query projection -> history/current distinction -> UI
每条 shadow：missing -> 400；empty list -> 合法空态；invalid/zero -> 类型/政策校验；
DB/upstream error -> 不冒充成功；commit response lost -> 同幂等键查结果；stale -> 409。
```

双击以同幂等键重放；离开页面后仍可订单 id 查状态；慢连接不得生成第二单；草稿冲突保留输入；返回旧页面刷新 sale revision；批次中三项仅一项已完成必须显示每行状态；队列积压两小时不可拖延支付/资格提交，但延迟赠点应按 due_at/expires_at 处理且不能补发已过期点当可用。主要未覆盖为 CEO-01/02/03/07。合法 0 差价不是数值空值，但当前政策未批准应明确阻断。

## 5 Code Quality Review

同一报价算法/商品读取/核验/授予须复用自助与 Ops，DRY 已在需求建立。现有 `commercial-purchase-service.ts` 三分支把 upgrade 归 monthly，需明确 discriminated request 类型，不能只在前端计算差额。`commercial-contract-repository.ts` 将收款、账期、赠点、快照放在大事务，新增复杂度应提取明确 quote/receipt-allocation/upgrade-grant helpers，仍保留事务 owner；不另设人民币钱包旁路。没有业务代码修改，不能声称检查新函数圈复杂度已通过。新增 policy 只覆盖注册消费器，避免通用任意 JSON 规则引擎。

## 6 Test Review

```text
UX: Ops catalog/pack CRUD + Merchant inbox/buy/current + Ops checkout/verify
Data: sales projection/outbox + immutable order + receipt allocation + period switch
Code: onboarding dependency + rank/period guard + quote amount + replay/conflict
Jobs: grant due/expire + publication/result notification retry
Integration: real PG/RLS + HTTP/MCP/stdio + authorized desktop + actual receipt
Rescue: section 2 named codes -> rejection/pending/retry/query paths
```

计划第 9、12、13 节已有 happy、租户、并发、worker 测试主干。需增测标题：`first checkout creates gated dependent lines and grants once`；`payment received within quote window verifies after deadline without repricing`；`late verification after period end queues paid exception`；`current upgrade preserves prepaid future renewal snapshot`；`same version republish emits new event exactly once`；`editable price never changes rank`；`unapproved upgrade benefit policy blocks quote`。单位覆盖公式/UTC/整分；真实 PG 覆盖收款锁、Workspace 锁、rollback；少量真实桌面/stdio 端到端。最有信心测试是一次转账分配开通+套餐，提交后断网重试，不重复赠点并能从插件读正确权益；敌意 QA 同时两 Ops 核验同流水；chaos 在 grant/outbox 提交前后断 worker。时钟固定、无随机等待。旧 37 测试是历史调研信息，本评审未重跑、不当新的验收证据。

## 7 Performance Review

销售/权益解析应按 SKU-current-version 查而非扫所有历史；引用查询和通知游标分页。fanout 分页批次，避免事务内每个用户一个投递请求；索引至少 Workspace/order、provider receipt、sales sku/revision、outbox next_attempt/status、notification recipient/read。锁粒度限收款流水与 Workspace，跨租户批次不做巨大事务。前三慢路径是通知 fanout、历史权益聚合、代购批次核验；没有实测不得虚构 p99，验收需实际报告单笔/批次响应和锁等待。缓存可售目录必须带 sale revision，不能缓存门槛或余额覆盖权威事实。没有额外独立性能缺陷，作为 CEO-09 落地约束。

## 8 Observability & Debuggability Review

CEO-09 为本段缺口。审计记录不等同实时异常查询。必要结果指标为已到账待授予数量/最老时间、分配差额、赠点到期漏发、通知 dead-letter；无需承诺新增监控产品。以 request/checkout/order/receipt/allocation/quote/grant/outbox id 贯穿 Ops/API/Worker，三周后可按事实重建。对账重试只调用幂等业务服务。现有转账核验页可复用来呈现阻断原因及恢复操作。

## 9 Deployment & Rollout Review

方案虽引用 runbook，但 CEO-09 的旧单与 worker 回滚边界缺少。建议 expand migrations（不改旧 146），映射销售事实并人工确认歧义 SKU，部署支持新旧读取、关闭新写入口，再启动权限/worker，真实闭环通过后开放新购/升级。旧部署与新部署混跑不能使某个版本绕过 sales projection。回滚先关闭新增写入，保留订单查询、收款核验/对账、既有 grant/expiry workers，回滚兼容应用，保留新表与 append-only 事实，不能删除账本。前五分钟查 healthz+日志和新写门禁，第一小时查业务对账、outbox、赠点调度；本次不实际部署。

```text
迁移扩展 -> 兼容代码(新购关) -> 目录核对 -> workers/契约验收 -> 开放新写
故障 -> 关新写 -> 查询真实收款/授予 -> 兼容应用回退 -> 保留事实 -> 对账恢复
```

## 10 Long-Term Trajectory Review

不可变价格/合同、版本引用和销售分离是正确一年轨迹；退款/补偿以追加事实继续兼容。售后事实修改可逆度 1/5，UI 两向改动 5/5，新表扩展 4/5；总体 3/5。主要知识债是“按批准规则”缺 schema，以及新需求附录与正文规则冲突（CEO-01/06/08）。owner 应将裁决写进正文并标附录覆盖关系，不能靠聊天史让后续工程猜测。No extra scope expansions。

## 11 Design & UX Review

桌面 scope 明确，移动端按项目宪法排除。信息优先为客户/Workspace 与当前权益→商品/版本及明细→真实收款分配→核验结果。商家优先当前套餐/到期→可升级→已购包与点数来源；历史通知不当当前售价。

```text
Ops 客户查询 -> Workspace确认 -> 商品明细 -> 待款订单 -> 收款分配
 -> [不足/证据缺失: 待核验] / [已足额: 核验 -> 每行授予结果]
Merchant 通知 -> 当前商品 -> [未开通: 首购明细] / [已开通: 新购或报价]
 -> 待支付 -> 已支付待授予 -> 我的套餐(当前/未来/历史分开)
```

loading/empty/error/success 已要求；partial 需 CEO-01/09 以订单行状态而非绿色“全部开通”表示。键盘、表单标签、焦点与冲突恢复已有基础，授权会话真实桌面验收尚待实现。Drawer/分步表单不是最终设计证据，交给 design 阶段验证。没有根 DESIGN.md，本评审未冒称符合设计系统。

## Failure Modes Registry

| Codepath | 失败模式 | 救援/测试/可见/日志现方案 | 缺口 |
|---|---|---|---|
| 首购 | 套餐单门槛被开通单阻塞 | 依赖未冻结/只有概述/未定/有审计原则 | CEO-01 CRITICAL |
| 升级 | 真到账但核验晚于期满 | 未定/未列此时序/未定/有审计原则 | CEO-02 CRITICAL |
| 续购 | 未来已付档位被本期升级覆盖 | 未定/未列/未定/订单事实有 | CEO-03 |
| 权益 | 差价正确但增量赠点规则未批准 | fail-closed原则/未列类型/阻断提示原则/审计 | CEO-05 |
| 发布 | 同版本重上架无新通知 | 去重不正确/未列/静默/事件有 | CEO-07 |
| 支付分配 | 一笔款重复分配 | 有锁要求/有验收/显示拒绝/有审计 | 已覆盖 |
| Worker | 提交响应丢失重放双授予 | 有幂等要求/有重跑验收/处理中/审计 | 救援查询补 CEO-09 |
| 下架 | 旧单是否付款随实现猜测 | 待确认/待冻结/不确定/审计 | CEO-08 |
| 准入 | 余额/配置不可知却调用模型 | 已 fail-closed/已验收/明确阻断/真实日志 | 已覆盖 |

## 决策、Implementation Tasks 与 owner 交接

本阶段只提出补丁，不私自改需求。owner 采用 autoplan 决策原则处理 CEO-01 至 09，并逐项标记采用/改写/阻断理由；具体商品参数不能由工程凭空决定。推荐先统一首购/报价/账期语义，再运行设计和工程评审。任务为需求修訂而非现阶段业务实现授权：

- [ ] **T1 (P1, human ~2h / AI ~20min)** — 冻结首次 checkout 依赖、分项状态、部分到账与原子授予规则（CEO-01）；需求 §12/13；验收首购、部分合款、重复核验。
- [ ] **T2 (P1, human ~2h / AI ~20min)** — 写报价接受窗口、真实到账与延迟核验/期满异常状态（CEO-02）；需求 §12.4/13.2；验收边界时钟和人工核验。
- [ ] **T3 (P1, human ~1h / AI ~10min)** — 明确当前升级与未来已付续购独立、固定 rank（CEO-03/04）；需求 §4/12；验收顺延和改价。
- [ ] **T4 (P1, human ~1h / AI ~10min)** — 定义 upgrade_policy 所需字段和按权益类型门禁，生产数值留商品批准（CEO-05）；需求 §5/12.4；验收无 policy 不报价。
- [ ] **T5 (P2, human ~30min / AI ~5min)** — 修正草稿审批语义、冻结普通下架旧单规则和重上架事件去重（CEO-06/07/08）；需求 §4/6/12.2。
- [ ] **T6 (P2, human ~1h / AI ~10min)** — 加对账/可恢复状态和兼容回滚验收（CEO-09）；需求 §8/9/13；真实 PG + worker 故障验收。

无新增延期 TODO；跨周期/降级/自动扣款保留明确范围排除；规则未批准商品保持草稿。Durable learning：升级不能复用已存在的 `stackSubscriptionPeriod` 顺延语义，否则“保留原到期日”会变成下一期续费；已纳入报告，不外发配置写回。

## Completion Summary

| 检查项 | 结果 |
|---|---|
| Mode / 系统审计 / Step 0 | HOLD，复用 B，main 不动代码、stash 未应用 |
| Sections 1–11 | 全部评估，6 类图/流程覆盖（架构、数据shadow、状态、错误、部署、回滚，加 UI/test flow） |
| Error/rescue / Failure registry | 11 路径 / 9 模式，2 critical gaps |
| 发现 | 9 项：P1 5、P2 4；可配置商品参数与实现风险分开 |
| 重复问题 | 已知发布/停售 bug 是现有实现风险，未重新当新需求缺陷编号 |
| NOT in scope / 复用 / Dream state | 已写；0 范围扩张 |
| Stale diagrams | 原需求仅 1 个内容/销售状态图，与目标方向一致；升级顺延源码图只适用续费，需保留说明 |
| 外部声音 | 原生独立 GPT 子 agent；未运行 Claude/Codex 外部 CLI，不自称跨模型 |
| Lake score | 6/6 建议选择必要完整闭环，不以少量代码代替授权结果 |
| 未决 | 9 项需求裁决待 owner 整合，商品参数另由目录批准门禁处理 |

**VERDICT：第 1 轮 CEO 未清零；修訂后进入设计/工程并复审。**

**UNRESOLVED DECISIONS:**
- CEO-01 至 CEO-09：owner 逐项冻结或修正文案，不能声明最终无问题。
