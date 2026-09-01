# 工作包 05：迁移、联调、真实证据与发布门禁

主责：QA/SRE/发布 owner

唯一需求依据：[商家营销插件商业化与 AI 创意点 PRD](../product/package-entitlements-and-services-prd-2026-08-31.md)

实现约束依据：[商业化架构](../architecture/package-entitlements-and-services-architecture-2026-08-31.md)

## 目标与冻结顺序

从工作包 01 开始同步建设验证环境和发布门禁，最后证明正式 ChatGPT 插件、API/MCP、数据库/RLS、Worker、1440px Ops、支付、中转、对象存储/scanner 和平台真实链路满足同一 PRD。

迁移顺序固定为：

`expand → seed approved/draft facts → legacy read-only inventory → shadow decision/projection → reconcile → full-surface cutover → observe → contract`

新迁移编号必须在合并时读取目录中的最新编号再分配，不在工作包预写固定起点。ChatGPT 插件、HTTP、MCP、Bridge 和 Worker 必须作为一个切面同步切换，禁止逐入口留下绕过窗口。

## 迁移边界

- fresh install、从当前生产基线逐版本 upgrade、重复执行、失败中断恢复和备份恢复均必须验证。
- legacy task/usage/wallet/addon/entitlement 只做只读 inventory 和 shadow 对照；不得产生任何创意点 grant，也不得贡献 `available_points`。
- shadow 比较 access decision、balance projection、订单/grant/revision 原子性和入口分类；任何未分类入口、跨租户记录、重复 grant、余额差异或 paid-but-ungranted 未处置均阻止 cutover。
- cutover 后旧二进制必须因 schema/contract version 不兼容而 fail-closed；回退只能使用经演练的兼容版本和恢复步骤，不删除业务或容器数据。
- contract 只在观察期完成、对账为零且正式证据齐全后执行；删除 legacy 结构需单独授权，不属于默认迁移动作。

## 证据等级

| 等级 | 必须证明 | 不能替代它的证据 |
|---|---|---|
| E0 | 文档、schema、静态清单存在 | 不能证明运行功能 |
| E1 | 单元、属性、契约、错误 golden、入口穷举 | fixture 不能证明租户/Worker/外部链路 |
| E2 | 真 PostgreSQL、FORCE RLS、事务、并发、迁移、真实 Worker | 本地服务不能证明正式插件或供应商 |
| E3 | 正式安装 ChatGPT 插件 + 真实沙箱 API/MCP + 1440px Ops | 截图或演示数据不能证明生产依赖 |
| E4 | 生产 canary、真实支付/中转/存储/scanner/平台回执 | 通用 readiness 或其他 capability 不能代替逐项证据 |

P0 至少达到 E3；支付、模型、平台写、对象存储和 readiness 的对外声明必须达到 E4。

## E1 契约与无副作用门禁

1. 冻结目录逐字段验证 5000、6×500、1999/7 天、2000/5000/10000、5000/12500、1/3、5/15、50g、5/10 小时、4/2 小时、500/300、2000/1000、图片 1、编辑 1、视频 90 起及其批准状态。
2. 从 HTTP router、MCP registry、Bridge tools 和 Worker actions 生成全量 manifest；每项恰有一个商业分类，新增未分类入口使 CI 失败。
3. zero/unknown/insufficient 时所有非白名单入口一致拒绝；捕获 DB mutation、outbox、queue、对象预留、relay、scanner 和 platform connector 调用数均为 0。
4. 错误在 HTTP/MCP/Bridge/Ops 中保持同一 code、request/trace、balance state、revision 和 nextAction；敏感信息保持脱敏。
5. private SKU 隐藏、支付/grant 幂等、费率未批准、merchant.start 无写、恢复白名单和 legacy 非贡献均有 golden/属性测试。

## E2 真库、Worker 与迁移门禁

1. FORCE RLS、复合租户 FK、append-only、跨租户攻击矩阵和应用角色禁止 UPDATE/DELETE/TRUNCATE 通过。
2. 支付/grant/balance/access revision/audit/outbox 原子提交；故障注入任何一步回滚后状态一致。
3. 200 并发 reservation 不超卖、不双扣；最早到期顺序稳定；provider unknown 保持 reserved 并可幂等对账。
4. Worker 执行前验证 decision/snapshot/rate/reservation/readiness revision；stale、耗尽或缺证据时 provider/platform 调用数为 0。
5. fresh/upgrade/repeat/interrupted migration、shadow diff、投影重建、备份恢复和旧二进制 fencing 通过。

## E3/E4 联调与真实表面

- E3 正式插件完成：零点阻断 → 查看冻结点包 → 下单/支付状态 → grant 到账 → 新 access revision → 业务恢复；同时验证导出、客服恢复和错误诊断。
- E3 1440×900 Ops 验证目录、private SKU、费率、账本、阻断队列、paid-but-ungranted、服务履约、RBAC、深链、刷新、409、unknown、键盘和焦点。
- E4 支付逐渠道保存签名、防重、金额/币种/SKU、provider event 和到账解锁证据。
- E4 五模态逐项保存中转鉴权、provider request、usage、cost、error/reconcile 证据；缺配置或成本不得交付。
- E4 六平台逐 capability 保存 OAuth/鉴权、读取、写入、媒体上传、状态回读和 canary；一个平台或能力不得代表其他项。
- E4 对象存储/KMS/scanner、发布确认和真实回执分别验收；所有证据绑定 release、commit、digest、workspace/capability、签名与有效期。

## DX、TTHW 与值班验收

- 提供单一商业化 runbook：全新 checkout → doctor → 真库/Redis/API/Worker/Ops → 安装源码插件 → E1 fixture 场景；记录每步命令、预期输出、耗时、失败诊断和安全清理方式。
- doctor 必须检查数据库角色、迁移版本、商业目录/费率批准状态、支付、模型中转、Worker callback、对象存储/scanner、Bridge endpoint/token 和 Ops API；缺项明确返回阻断且不输出密钥。
- 值班可用 requestId/traceId/operationId/provider request id/access revision 查询完整链路，并区分 exhausted、insufficient、unavailable、stale、rate unavailable、paid-but-ungranted 和 provider unknown。
- 发布证据索引明确 E0–E4 来源、采集时间、release/digest、负责人、过期状态和复验命令；fixture/test/local 证据永远不能标记生产 ready。

## 发布硬门禁

- 财务未批准成本/费率，业务未确认 6×500 日期、50g 单位、private 资格/抵扣和“90 点起”变量，法务未批准退款/宽限/保留条款时，销售与生产保持 NO-GO。
- 真实支付、点数账本、中转、平台、存储、导出、RLS、Worker/发布门禁未达到 PRD 指定的 E3/E4 时保持 NO-GO。
- 任何跨租户、重复 grant/扣点、余额超卖、unknown 盲重试、fixture/过期证据标 ready、支付已成功但 grant/access revision 丢失均为 P0。
- “代码已合并”“测试 fixture 通过”“页面存在”均不能单独改变销售或生产状态。

## 分工与完成定义

| 工作包 | 主交付 | 本包验证重点 |
|---|---|---|
| 01 | registry、目录、订单/权益、创意点账本与 decision | E1 契约；E2 RLS/事务/并发/迁移 |
| 02 | API/MCP/Bridge/Worker/中转/平台门禁 | 全入口无旁路；E3 插件；E4 外部回执 |
| 03 | 接入与人工服务履约 | 未决规则不落地；真实 actor/time/evidence |
| 04 | ChatGPT 与 1440px Ops | 错误保真、RBAC、恢复闭环、可访问性 |
| 05 | 迁移、联调、证据、发布门禁 | 独立复核并重新执行 E1–E4 |

完成条件：工作包 01–04 的结果由本包重新验证，迁移和恢复演练通过，正式插件与桌面 Ops 达到 E3，所有对外外部能力具备对应 E4 证据，且所有业务/财务/法务待决项已明确批准。否则保持 NO-GO。

## 不包含

供应商开户和平台审批等待、缺失适配器的代开发、业务数据删除、ERP/PIM、专项增值服务、手机或平板适配，以及用 fixture 替代生产证据。
