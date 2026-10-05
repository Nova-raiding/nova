只读评审发现 **4 项需求缺口**。未读取其他评审意见或技能文件，未修改文件、执行业务操作、运行测试或委派。以下不重复 §2.1 已列问题，也不将尊享额度、跨周期升级等已有配置门禁报为漏项。

**P1-01：普通订单的到期规则没有落成契约**

章节：§4.1、§13.2、§14。文档要求“有效旧单继续履约、过期关闭”，但只有升级报价明确成功到账截止。普通开通、套餐、权益包订单尚未定义有效期来源、与支付链接期限的关系，以及分笔到账跨越截止的判定。

源码证据：[订单契约](/Users/lixiaomei/Desktop/code/codexSkills/packages/contracts/src/commercial-order.ts:54)没有订单截止字段；migration 153 建单表无订单有效期；[migration 181](/Users/lixiaomei/Desktop/code/codexSkills/packages/persistence/src/migrations/181_commercial_checkout_resource.sql:5)仅增加 `checkout_expires_at`。[支付服务](/Users/lixiaomei/Desktop/code/codexSkills/packages/application/src/commercial-payment-service.ts:36)按 pending 状态发起支付，不能提供文档所引用的普通订单到期政策。

最小文案补丁：

> 普通订单必须冻结已批准的成功到账截止；支付链接到期不自动改变订单截止，重新发起支付不得延长订单。分笔收款以截止前可信到账且合法分配的累计金额是否足额判定；足额但晚核验允许依原快照履约，截止后才足额进入已收款待处置。首购各明细分别判定并保留依赖状态。有效期配置缺失禁止建单。

验收补上截止前后、分笔跨截止、链接重建及关闭与核验竞态。

**P1-02：未来已付续期的点数是否提前可用未定义**

章节：§4.1、§12.3、§13.2。文档区分当前与未来合同，但未规定提前续购后，可消耗额度何时进入可用余额。“核验后点数一致提交”可能被实现为立即可消费，与未来账期生效形成两种解释。

源码证据：[支付授予](/Users/lixiaomei/Desktop/code/codexSkills/packages/persistence/src/commercial-contract-repository.ts:660)先顺延账期，随后在 :730 插入 grant、:769 增加可用余额；[点数分配](/Users/lixiaomei/Desktop/code/codexSkills/packages/persistence/src/creative-point-repository.ts:391)只检查到期，不检查未来生效时间。现有 [PG 续期测试](/Users/lixiaomei/Desktop/code/codexSkills/packages/persistence/src/commercial-contract-repository.release.postgres.test.ts:75)验证窗口顺延与准入，没有断言未来点数不可消费。

最小文案补丁：

> 未来账期核验后冻结合同及发放计划；套餐点数和可消耗服务额度按批准发放时点进入可用状态，默认不得早于对应账期开始。待生效额度不能参与余额、预留或消费。发放 worker 重跑、延迟及回滚均沿用原计划，不提前发放或重置到期。

验收补上提前连续续购、跨生效时点消费、worker 崩溃恢复及过期窗口处理。

**P1-03：并发续购只要求检查冲突，没有规定冲突结果**

章节：§13.2、§16。文档同时要求保存预定起止、付款时按锁定顺延策略核验冲突，但未说明两张待支付续购单占用同一未来窗口时，后核验订单能否顺延；升级期间原档位待支付续购能否成为未来较低档合同也未明确。锁序只能保证串行，不能决定合同结果。

源码证据：[账期顺延函数](/Users/lixiaomei/Desktop/code/codexSkills/packages/persistence/src/commercial-contract-repository.ts:268)按核验时最新 active 账期末尾重新计算；[并发 PG 测试](/Users/lixiaomei/Desktop/code/codexSkills/packages/persistence/src/commercial-contract-repository.release.postgres.test.ts:372)验证不重叠，并不验证预定窗口冲突或升级交错政策。

最小文案补丁：

> 续购快照明确顺延模式及基准 revision：允许浮动顺延的订单按 Workspace 核验事务提交顺序追加；固定窗口订单遇冲突进入已收款待处置，不静默移期。待支付原档位续购遇当前升档时，须有批准的未来档位衔接规则；未配置则禁止激活并进入待处置，已付未来合同仍保持不变。

验收覆盖两续购核验顺序互换、续购与升级交错、源账期期满及响应丢失重放。

**P1-04：新增合同复用退款流程时，权益回收范围未定义**

章节：§5、§12.4、§14。文档沿用已有退款回收，并引入升级增量、组合依赖及未来合同，但没有定义这些订单退款后应撤销哪些权益、是否恢复源档位、是否取消未发批次。历史合同不可改写并不能决定当前授权如何变化。

源码证据：[退款完成路径](/Users/lixiaomei/Desktop/code/codexSkills/packages/persistence/src/commercial-refund-repository.ts:110)调用通用负点数调整；[调整分配](/Users/lixiaomei/Desktop/code/codexSkills/packages/persistence/src/creative-point-lifecycle-repository.ts:290)按 Workspace 有效 grant 消费，没有按退款订单限定来源。因此“复用现有流程”不能证明只回收本次购买权益。

最小文案补丁：

> 新订单类型接入退款前必须批准来源回收政策：限定订单及派生批次，明确已用/预留、未发计划、功能授权、升级源档位及后续合同的处理；不得扣除无关开通赠点或独立包。历史事实保留，以补偿事件更新投影。政策或兼容执行器缺失时阻断退款执行并保留待处置；回滚仍须支持已经批准的处理意图。

验收补上升级退款、未来续期退款、组合开通退款及外部退款成功后本地失败恢复。

六项核对结论：

- **scope：基本完整。** 用户确认的价格可修改、5000 开通不含首期、500×6 赠点、三档初价及人工到账激活均已纳入。
- **architecture：部分完整。** §16 事务/RLS/锁序要求明确；续购冲突及退款状态转换仍需补定义。
- **data-flow：需补齐。** 普通订单截止、未来额度生效、退款派生权益流存在上述缺口。
- **security：需求层面未发现新增缺口。** 已核对 catalog handler、MCP schema、migration 153 的 FORCE RLS/不可变事实及 §16 受控函数要求；不代表运行环境通过。
- **tests：需补分支断言。** 已读支付、账期、退款测试源码；上述四项需形成确定预期，不能仅断言不重复、不重叠。
- **performance：需求层面基本覆盖。** §16 已规定分页、展开限制、分批 fan-out、租约及容量指标；核对了赠点 dispatch 的限批与 `SKIP LOCKED` 路径。真实负载、失败恢复和回滚兼容仍待实施验收。