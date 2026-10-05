# 商家商业 UI 实施记录

日期：2026-10-05。商家前端 owner。工作在 main/唯一主目录；未创建分支或提交，未改变图片流程。

已落代码：

- `CommercialPurchaseCenter.tsx` 接服务端当前可售目录、`commercial.subscription.get` 当前/未来/独立包/历史/订单分区；明确区分 unknown、成功空和未来合同间隙。购买依赖已读取且可确认的套餐事实，不靠余额猜档位。
- 普通商品、开通费、点数包统一 `commercial.order.create`，关闭从页面价格解码金额后调用 `billing.recharge.create` 的旧商业购买路径。未开通首购使用 commercial.checkout.create 原子建立独立开通费与首期明细；开通费不包含首期费用。
- 升级走 `commercial.upgrade.quote.create`，展示周期成交基价、剩余时间、原到期、报价到账截止、增量权益与差价；建单引用 `upgrade_quote_id`，不生成客户端差价，不改未来合同。
- 展示服务端冻结订单商品版本、数量、周期、权益、每行金额与合计。金额/版本更新提示重新确认，确认按钮与实际付款入口分开，确认后才调用 commercial.order.payment.create，不自动打开支付页面。缺冻结权益/周期/有效期限，拒绝确认付款。
- manual_transfer 展示真实服务端收款指引，无批准指引不显示假二维码/假链接；最终付款结果查原订单，不以 click/payment URL/paid 字段宣称权益生效。
- 原意图幂等键和已取得订单引用按账号与 Workspace 保留；关闭弹窗不取消原单；重进页面先读原单。未知响应用 commercial.order.request.get、commercial.checkout.request.get、commercial.upgrade.quote.request.get 查询同一原意图；查询暂未见提交记录仍保持待确认，不另建收费意图，展示请求标识与受控支持入口。
- `CommercialNotificationPanel.tsx` 放到 Topbar 原风险通知后面的独立商业区域，读 `commercial.notifications.list`，保留历史发布价/版本提示，携带通知目标进入财务目录重新读当前价格和销售状态，显示历史发布版本/价格与当前版本；已下架或失去资格时不可从历史通知付款。通知有独立 loading、empty、error、分页，不冒充风险通知已读取。
- 桌面 Ant Design tables/tabs/modal 与原主题字体和 token；商业正文、表单、金额 16px，关键按钮 44px，金额等宽右对齐，宽表局部滚动、明确标题/空状态、focus 轮廓，visited link 有区别。

已运行：

1. `npx tsc -p demo/merchant-studio/tsconfig.json --noEmit` 多轮通过，最终 DTO 对齐/原请求恢复/partial read 修改已复验。
2. 最终相关商业、目录、钱包、旧投影、风险通知、未读与账本窗口：8 文件 56 tests passed（commercial-purchase-client / commercial-purchase-center / commercial-catalog / billing-wallet-regression / current-commercial-entitlement / issue-read-state / unread-vs-zero / finance-window）。这包括原子首购调用、确认后独立支付请求、无客户端金额、原请求只查不重建，以及缺冻结明细/期限/非法金额/未来合同间隙的阻断。
3. `npm --prefix demo/merchant-studio run build` 通过：TypeScript project build、Vite production bundle、production copy guard。Vite 现有大 bundle 警告保留，不冒称已分包优化。
4. `git diff --check -- demo/merchant-studio/src` 通过。

gstack 设计要求复核：已读 plan-design-review SKILL 与完整 7-pass review-sections，并以已批准 PRD §15 为实施依据。此次是实现复核，不重新宣称完成一轮方案批准。信息层级为余额与资源 → 当前/未来/包/历史/订单 → 购买目录 → 用量趋势；状态表覆盖读等待/真实空/失败/冻结成功/部分开通/未知；支付旅程分选择、报价、订单明细、再次确认、付款、原单查询；不新增营销卡/假 QR/装饰动画；复用主题组件；键盘 focus 和桌面宽表已落代码；尚待实际浏览器、200%缩放、无阴影与辅助工具验收。

集成要求/尚未证实：

- API owner 已接收 subscription wire shape：`schema_version= commercial.subscription.v1`、`status=available`、`onboarding_qualified`、`current/future/packs/history/orders`。snapshot 保持 repo camelCase。必须返回真实冻结订单 `snapshot.{name,version,quantity,cycle,benefits}`、`expires_at` 和获授权 manual transfer instructions，不能用当前目录替代订单。
- 原请求恢复精确方法已由 contracts/API owner 落地，UI 已接；尚需真实超时后查原请求/恢复窗口与授权隔离运行时验收。
- 无订单支持交接已接真实支持登记 API，按 support_handoff 展示仓储 available/blocked 状态与负责人；真实登录、首次登记、运营回复及客户读取闭环尚待 owner 运行时验收。
- 未进行实际商家 PG 登录、真实发布 fanout/通知、银行收款核验/授予、模型调用或本地插件安装验收；本报告不把单元、静态渲染或健康 200 当成功证据。

## 首单前真实人工支持增量

- 新增 `MerchantSupportRequestPanel.tsx`。目录/首购页常驻入口及读取、付款失败入口均可填写标题和说明，不要求订单、任务或已有工单。接口复用现有 `/api` 代理，通过 POST `/v1/support/requests` 实际登记；只在校验真实 receipt 后显示 ticket_number/status/submitted，不使用固定成功文案或假外链。
- 客户查询 GET `/v1/support/requests/{ticket_id}`，固定构建认证路径，不跟随 arbitrary replies_path。显示服务端本人企业工单及客户可见回复；失败不当作成功空列表，缓存回执重进页面需先经服务端核对。
- 共享 `packages/contracts/src/merchant-support-request.ts` DTO。请求显式限定 subject/message/idempotency_key/request_id/trace_id/version/step；客户端不提交 customer_id、workspace_id 或身份投影。请求文本脱敏，敏感或格式非法的排障标识不发送；服务端再次脱敏并拒绝敏感诊断字段，由应用 owner 落地。
- 提交前保存原内容和幂等键；超时、未知或冲突结果保持原意图，锁定编辑并用原键恢复，未取得真实回执不显示已联系。账号作用域改变后旧响应不写入新页面。已确认工单才允许显式填写新问题。
- 最终增量验证：merchant-support-request / commercial-purchase-client / commercial-purchase-center / unread-vs-zero 共 4 文件 33 tests passed；TypeScript production project build、Vite production build 和 production copy guard 通过；diff whitespace check 通过。支持测试是客户端 HTTP mock/渲染验证，未冒称真实工单已登记；实际 API/数据库/运营回复与商家浏览器测试交由集成 owner。

## 赠点来源与冻结计划增量

- 接共享 `packages/contracts/src/commercial-point-origins.ts`，保留真实 subscription.onboarding_gifts 与 statement entry.commercial_origin；首次 generic commercial_order_v2 也按 server origin 区分开通赠点/套餐点数/权益包，不客户端猜来源。
- `CommercialGiftDetails.tsx` 在已购分区后展示“开通赠点计划”紧凑表，冻结来源订单/版本/政策、期数与每期点数、逐批约定发放和到期、原生持久状态、grant/expiry 引用及 blockers。expired_by_time 单独描述“有效窗口已结束”，不伪造执行过期或授予。unknown/null/missing 显示未读取完整，仅 available+真实空计划显示没有计划。
- 财务“创意点来源账本”列真实来源标签、来源订单/版本、期次、事件、点数变动与发生时间；缺 origin 明确尚未核实，保留原消费趋势。部分页/不可识别流水明确不是完整账本。
- 首购 Modal“冻结开通赠点说明”只读取 order.snapshot.kind/onboarding_gift_policy，动态说明数量、核验首笔、月周年及下周年到期；不硬编码旧500默认，冻结新600依约显示，不借当前销售版本改变原单。未返回已核实冻结计划显示未核实。
- meaningful scoped tests：commercial-gift-details / commercial-purchase-center / merchant-support-request / unread-vs-zero，4 文件 35 tests passed；production tsc-b/Vite/copy guard 通过，diff check 通过。测试覆盖unknown与成功空区分、原500冻结/新600独立说明、时间结束不造执行状态、generic初始来源精确标签、HTTP producer origin normalization保留。未启动 PG/browser/global typecheck；真实投影接线、来源隔离与每期运行状态交 API/QA owner 验收。

赠点产品表面复核：主展示中文订单/发放/账本事件状态与数量、时间，不陈列政策 JSON 和 schedule/grant 原始标识。订单、冻结版本、原始状态与 blockers 保留在原生可展开详情，summary 16px/44px 并带 focus 轮廓；未知仍称尚未核实，不映射为已发放。构建 tsc-b/Vite/copy guard 通过。新主文案测试首跑将 Ant data-row-key 属性误当可见文案失败，修正为文本断言后重跑，2 文件 13 tests passed（终态 exit0）；未以失败首跑宣称通过。实际浏览器与键盘展开交 QA owner 验收。

## CEO-I4/I5 同族升级与逐项权益比较

已读 ceo-scope-audit.md，核查原实现确实所有异 SKU 都显示升级，商品行为行摘要不满足指定权益行为行的三档比较。

- portfolio current/future/history DTO 接真实冻结 `plan_family/tier_rank`（eng 仓储以当前升级、来源恢复或原始 SKU 快照解析，非当前目录）；catalog target 从 server raw/payload 解析相同批准身份。源/目标任一身份缺失，显示不可判定并阻断，不靠 SKU、名称或价钱猜档位。只允许同系列更高 rank 请求升级报价；相同 rank 按同档续购，低档明确不支持降档，跨系列明确不兼容。服务端报价仍核实权益兼容与冻结金额。
- 新 `CommercialPlanComparison.tsx` 展示“套餐权益对比”区域，权益/费用行为行，批准系列 rank1/2/3 为三列，显示真实当前批准价格/周期、点数、配额、服务及注册功能权限。功能名称来自共享注册定义，权限0/1精确显示不包含/包含；未列权益不擅自补零。缺尊享或同rank多个SKU不选最大历史版本、不猜尊享价格/额度，标未上架或版本待核实。开通费、首期套餐与开通赠点独立说明，原包列表与冻结订单摘要保留。
- 16px 字体、760px 局部表格滚动与44px可展开版本详情；未新增手机要求。身份和比较测试涵盖成长→基础、尊享→成长、跨族、基本→成长、同档异SKU续购、源未知阻断，以及批准三档真实2000/5000/10000与点数/GB/权限对照、缺档不猜、重复档位歧义和非法permission不显示包含。
- 最终 scope commercial-plan-comparison / commercial-purchase-center / commercial-catalog / commercial-gift-details，4 文件 21 tests passed（终态exit0）。merchant production tsc-b/Vite/copyguard 和 diff check 通过；没有 PG/browser/global typecheck。实际桌面/200%及新summary冻结身份运行由 owner 验收。

## 购买结果通知与可靠已读状态

- 商业通知列表校验真实 notification_kind/read_at，购买结果还需 order_id 与 approved 四状态；缺已读字段不默认为未读零。逐消息16px标签已读/未读，计数明确仅已读取页，未读计数不覆盖原风险通知事实。
- catalog_publication 保留历史发布版本/价格与“查看当前商品与价格”；purchase_result 精确区分立即生效/未来待生效/待开通依赖/待处置，并提示历史处理结果需重新查当前。按钮“查看已购与相关订单”进入订单与恢复tab、预填真实原订单ID，不进入商品购买或自动发付款请求。
- 标记已读 POST `/v1/commercial/notifications/{id}/read` 只提交原 idempotency_key；服务端负责真实member/workspace身份。仅校验匹配 notification_id/read_at/replayed 的成功receipt后更新标签；未知失败保持原读取事实并显示“已读结果待确认”，按钮“用原标识重试已读登记”重用保存key。刷新真实list可核对已读事实；不写财务、不触发重复授予。账号/Workspace改变时商业panel重新挂载，不能沿用原成员消息。
- 最新禁降级前端补齐：同档新增续购也核查 paid future 的真实冻结身份；已有同族更高未来档位时禁新增低档续购，未来身份未知则不可判定；当前basic→growth若futurepremium仍允许本期升级报价。保留合法旧future事实，不改写账期。
- 最终scope commercial-notification-read / commercial-purchase-center / issue-read-state / unread-vs-zero，4 文件44 tests passed（终态exit0）；merchant production tsc-b/Vite/copyguard+diffcheck通过。4 notification tests覆盖真实producer四态/缺read状态拒绝、未知重试原key且无客户端身份/资金字段、错误receipt不更新，以及未读取不制造未读零；futurefloor新增反例通过。未启动 fixture/browser/global检查，真实投递/read持久/abort恢复交 DX/QA 运行。
