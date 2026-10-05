# 运营代购与真实收款前端实施证据

日期：2026-10-05。工作目录：唯一主工作目录；分支 main。此报告描述本 owner 的前端与客户端实现，不宣称已上线或已通过完整 ChatGPT stdio 插件链路验收。

## 实现范围

- `apps/ops-console/src/components/commercial/CommercialOperationsWorkspace.tsx`：新增指定客户代购、首购联合结算、按剩余有效期升级、真实银行收款、单条及批次分配、未分配款申请返还/独立审批或拒绝/核实完成/外部未知冻结。
- `apps/ops-console/src/api/commercialOperationsClient.ts`：实际共享 MCP 方法 DTO、严格解析、请求与原请求查询；目录销售投影、版本、权益政策引用、周期和有效天数；权益定义与权益包客户端。
- `apps/ops-console/src/hooks/useCommercialOperations.ts`：真实身份查询、读订单、代购及五项收款独立 capability。代购沿现有 `commercial.payment.reconcile`，未虚构 `commercial.order.create`。
- 客户及企业来自 `ops.users.list`；必须显式选中 active 商家身份及其 Workspace。开户引导现有用户管理授权邀请流程；不收密码、手填商业授予数量或客户端标称到账状态。

## 购买与收款契约

当前上架且 currentSaleVersionId 等于版本 ID 的公开、批准、可执行目录项才可用于代购；历史批准版本和缺失销售投影不能购买。价格、周期、权益、当前及未来合同均读取服务端 preview。目录金额不在前端重算为升级金额，升级读取最终 `commercial-quote-view.ts` 的 snake 字段及权益增量明细。

首购使用 `ops.commercial.checkout.preview/create`，两行分别为一次开通费和依赖开通费的首期套餐；严格验证两行类别、金额总和、依赖、目标企业和理由。界面显示开通费不含首期，已具备开通资格时阻止重复首购。普通购买/续购/升级/点数包使用 `ops.commercial.order.preview/create`；确认依赖、服务端哈希和截止时间，建单成功不等于到账或授予。

普通运营不填写 nonce 或 hash。收款只接受真实人民币银行转账账户引用、流水号、付款方、实际到账时间、证据和原因；金额用 BigInt 转整数分，拒绝空值、非正数、小数超过两位、指数及安全整数溢出。客户端验证实收 = 已分配 + 已返 + 冻结返款 + 可用余款，拒绝矛盾 DTO。服务端单条预览确认携带原收款、订单、金额、revision、preview_hash 和稳定幂等键；批次原明细 JSON 全部确认，重复收款各行合计不得超可用余款。

返款使用原付款方及原返款意图，申请、审批/拒绝、核实完成或外部未知状态具有独立能力；完成必须真实外部流水，未知继续冻结，不发送第二笔返款。已付订单退款保留现有独立退款流程和来源政策提示；本前端不宣称已实现新的退款价格或撤销算法。

## 结果未知与恢复

每次实际写入使用本次确认的稳定键；页面关闭或刷新时仅在 sessionStorage 保留原键、操作类别/名称，不存证据或密码。目标 Workspace 改变使旧请求响应失效；返回原 Workspace 后恢复锁定，不能误把前一企业结果用于下一企业。

订单、升级报价、首购分别调用 actor-bound `ops.commercial.order.request.get`、`ops.commercial.upgrade.quote.request.get`、`ops.commercial.checkout.request.get`。只在确定原结果属于目标企业且订单行完整时解锁；null、空对象或未核实状态保持锁定。现金写入网络/超时/5xx/响应无法解析时关闭确认弹窗，让用户可以查询原企业事实，但仍禁止新写；未定义现金 request.get 的明确恢复入口前，不因余额或列表变化自动认定本次意图成功。

## 检查与边界

已执行 scoped Ops TypeScript 检查，零错误；客户端及组件回归检查见下面最终结果。DTO/API 调用用 mock 验证最终请求字段和稳定键，组件权限用真实 React SSR 输出验证。这些不证明 API、数据库/RLS、银行流水核实、worker 授予或真实桌面交互已成功。

待 owner 集成验收：真实登录桌面运营后台 → 指定用户/Workspace → 服务端 preview → 首购两订单原子建单 → 实际收款记录 → 联合分配事务及 grant/dependency 状态；升级并发过期、原价/原到期、未来合同保留；多租户/RLS；现金未知恢复与返款独立审批；本地 stdio 插件兼容和商家当前/未来套餐投影。没有执行业务付款、生产写入或部署。

最终已执行命令：

```sh
npx tsc -p apps/ops-console/tsconfig.json --pretty false --noEmit
npm test --workspace merchant-ops-console -- src/api/commercialOperationsClient.test.ts src/api/commercialOperationsClient.purchase.test.ts src/api/commercialOperationsClient.pagination.test.ts src/components/commercial/CommercialOperationsWorkspace.test.tsx
git diff --check -- apps/ops-console/src/api/commercialOperationsClient.ts apps/ops-console/src/components/commercial/CommercialOperationsWorkspace.tsx apps/ops-console/src/hooks/useCommercialOperations.ts
```

最近一轮结果：scoped TypeScript exit 0；4 个测试文件、37 个测试全部通过；diff whitespace 检查无错误。

## 后续增量：全局未知归属现金与原事实恢复（2026-10-05）

此前“缺少现金 request.get”“待匹配返款入口未接通”是当时的契约缺口，已由后续真实后端契约与本次前端补丁替代，不能继续作为固定未实现结论。新增真实 `receipt.unmatched.record/list/match`，受限平台全局队列每页50条，使用服务器 opaque cursor，尚未读取不显示为空。客户搜索来自真实 `ops.users.list`；必须明确选择 active 商家账号及 active Workspace，企业状态缺失时禁用匹配。服务端还必须核对账户与企业关系和状态，客户端的 evidence 不可充当授权依据。

未知归属款可通过 `receipt.unmatched.return.propose/decide/complete/list` 申请返还原付款方、独立审批或拒绝、登记外部未知并保持冻结、按真实银行返款流水核实完成。上述调用禁止 `target_workspace_id`，不会猜企业、生成钱包、建单或提前授予。所有写按钮分别按真实 receipt record/allocate/return propose/approve/complete 能力启用；未匹配返款列表也使用真实分页。

新增三类只读原事实查询：`receipt.request.get` 按 bank_transfer + approved receiving account + 原银行流水查询原核验 actor 的事实；`allocation.request.get` 按原企业及原创建 actor 幂等键查询；`return.request.get` 按原企业（或未匹配 NULL scope）及原申请 actor、原 return_id 查询。现金意图在 sessionStorage 仅保留稳定标识、原银行 tuple、时间、企业、订单、金额、原付款方及外部返款标识；不保存证据、密码或完整银行凭证。登记银行款实际由外部银行 tuple 服务端去重，本地显示的意图键不是虚构的服务端财务 nonce。

恢复严格核对原到账金额/付款方/时间/银行标识、匹配原款与目标企业；单条分配按原 key 查询、整批按原 key:index 查询全部明细，逐项核对原款、原订单、原金额。null、另一企业、另一金额、部分批次、未知外部结果或不一致真实外部流水不能当作原意图完成。独立审批/完成 actor 与原申请 actor 可以不同，审批/完成恢复读取获授权的真实原返款列表并按 return_id、原款、金额、付款方及预期状态核对（完成还需原外部流水）；不因列表读取成功而解锁，不宣称证明原操作 actor。当原商业结果已确定时清除本地意图锁并要求刷新真实队列/状态；旧版本只存 key 没有原事实的会话仍需对账负责人核实。

验证：`npx tsc -p apps/ops-console/tsconfig.json --noEmit`；`npx vitest run apps/ops-console/src/api/commercialOperationsClient.test.ts apps/ops-console/src/api/commercialOperationsClient.purchase.test.ts apps/ops-console/src/api/commercialOperationsClient.pagination.test.ts apps/ops-console/src/api/commercialOperationsClient.unmatched.test.ts apps/ops-console/src/components/commercial/CommercialOperationsWorkspace.test.tsx apps/ops-console/src/hooks/useCommercialOperations.test.ts`：6文件57测试通过。最后金额时间核对和 stale UI 清理增量另跑客户端未匹配与组件测试。该证据覆盖请求形状、金额守恒、分页、独立权限及原意图判定，不替代真实 API/RLS/桌面浏览器/容器验收；这些运行验收仍由 owner 集成执行。
