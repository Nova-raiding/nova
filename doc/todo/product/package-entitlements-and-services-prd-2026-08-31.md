<!-- /autoplan restore point: /Users/lixiaomei/.gstack/projects/codexSkills/main-autoplan-restore-20260901-210919.md -->
# 商家营销插件商业化与 AI 创意点 PRD

状态：gstack CEO、设计、工程、DX 四阶段双评审完成（2026-09-01）；等待最终实施批准；实现、销售、生产均为 NO-GO
版本：2.0-draft
日期：2026-09-01
唯一业务来源：/Users/lixiaomei/Downloads/商业化方案.md

## 1. 权威、目标与冲突规则

本 PRD 只把《商业化方案》转成可实现、可测试、可审计的契约，不修改价格、额度、套餐或服务边界。用户新增的上位硬约束是：没有可用 AI 创意点时，除精确列明的恢复/控制白名单外，任何商家业务功能都不可使用。

冲突优先级：本轮用户指令 > 《商业化方案》 > 本 PRD > 架构/代码/测试/UI/销售材料。原文未确定的期限、计价、退款或服务政策只能列为待决策，不能由工程自行冻结。

成功标准：

- ChatGPT 插件、API/MCP、Worker、商家工作流和桌面 Ops 使用同一商业目录、权益快照与创意点账本。
- 创意点为 0、余额未知、账本不可读或余额不足当前动作时，在任何副作用、入队或外部调用前 fail-closed。
- 套餐、赠点、隐藏测试包、充值包与动作费率逐字逐数匹配原文。
- 真实支付、模型中转、平台、存储、RLS、Worker 和发布门禁以真实环境验收；代码、fixture 和本地回退不算完成。
- Ops 只验收 1440px 桌面工作台；手机和平板不在范围内。

## 2. 用户与核心问题

客户包括单品牌中小商家、多品牌多店铺团队、大型品牌/代运营集团或素材服务商。内部用户包括销售、财务、实施、客服、运营、审计和系统管理员。

当前任务不是补一个价格页，而是消除任务次数、图片 entitlement、人民币钱包和未来创意点四套解锁事实，建立单一的 CommercialAccessDecision。人民币收款/退款和 provider usage/cost 是独立账本，只通过 operation id 与点数关联，不得替代创意点解除门禁。

## 3. 冻结商业目录

### 3.1 四层收费结构

| 层级 | 状态 | 冻结口径 |
|---|---|---|
| 一次性系统接入 | 实现 | 5000 元/次，不是永久授权 |
| 月度服务套餐 | 实现 | 基础版、增长版、定制服务版 |
| AI 创意点充值 | 实现数据/支付闭环，生产前审批 | 500 点/300 元；2000 点/1000 元 |
| 专项增值服务 | 不实现、不销售 | 原文“需要讨论，估计不上”；签约时另立 SOW/PRD |

### 3.2 一次性系统接入

5000 元/次，包含：

- 插件账户开通。
- 连续 6 个月、每月 500 个 AI 创意点；6 笔独立、幂等、可审计 grant。
- 系统部署与基础调试。
- 平台固定规则、商品品类规则、大促节点规则的配置与接入。
- 一次系统使用培训、上线验收和基础问题处理。
- 用户偏好、一个企业主体、店铺/商品自动扫描、品牌基础资产、品牌表达和视觉要求的首次录入。
- 首次品牌、店铺、商品录入数量受所购月套餐上限约束。
- 平台：淘宝、天猫、京东、拼多多、抖音电商/抖店、小红书。

不包含品牌资料人工整理、大量历史素材清洗、超套餐上限的额外品牌接入、非标准平台、ERP/商品系统、私有化部署和人工代做素材。

赠点起算日和每笔到期日原文未明确；确认前只能建模和保存草稿配置，不能激活生产调度。

### 3.3 非公开测试方案

| 字段 | 冻结值 |
|---|---|
| 可见性 | 仅授权销售/Ops；不得公开展示或推荐 |
| 价格/周期 | 1999 元 / 7 天 |
| 权益 | 1 品牌、1 店铺、500 点、1 小时 1V1、完整体验核心功能、一次效果复盘 |
| 抵扣 | 验证结束后 7 天内正式购买，可抵扣 5000 元接入费 |

重复购买资格、客户身份口径与抵扣会计规则待业务/财务确认。系统必须支持 private SKU、权限控制、7 天到期、抵扣幂等和审计。

### 3.4 月度套餐

| 权益 | 基础版 | 增长版 | 定制服务版 |
|---|---:|---:|---:|
| 月费 | 2000 元 | 5000 元 | 10000 元起 |
| 品牌 | 1 | 3 | 订单具体值 |
| 店铺 | 最多 5 | 最多 15 | 订单具体值 |
| 每月 AI 创意点 | 5000 | 12500 | 订单具体值 |
| 云端存储 | 50g | 50g | 50g |
| 每月 1V1 | 最多 5 小时 | 最多 10 小时 | 合同具体值 |
| 常规响应 | 工作日 4 小时内 | 工作日 2 小时内 | 合同具体值 |
| 效果复盘 | 无 | 每月 1 次 | 按周或按月 |
| 售后 | 标准 | 优先 | 专属负责人 |
| 专属规则/审核/负责人/工作流/API/陪跑 | 无 | 无 | 订单/SOW 明确后可用 |

三档均包含系统持续使用、云端知识库、自然语言模型、文案/图片/视频生成、图片批注修改、批量素材、竞品分析与创意参考、创作/营销/驳回/规则记忆学习和自动检查。

“50g”是原文标签，GB/GiB 未明确。确认前不得由本地常量或前端自行换算字节。

### 3.5 人工服务边界

包含：系统操作指导、常规排查、基础品牌资料配置、生成方法指导、驳回原因分析、流程优化建议。

不包含：无限改稿、人工代做全部素材、整套营销策划、日常代运营、全天候在线、非工作时间紧急服务、内部系统开发。

原文未规定预约取消、爽约、15 分钟取整、培训人数、30 天保修或 95% SLA。本期不冻结这些规则；服务先用可审计的人工排期、工时扣减和交付记录履约。

## 4. AI 创意点与费率

AI 创意点控制图片、视频和模型调用成本，不等于 Token、人民币、任务次数、图片 add-on 或 provider 成本。月套餐未用点默认当月失效、不结转。接入赠点、试用点、月度点与充值点分别保存来源、版本、账期/有效期、订单和证据；原文未给出的充值点有效期不得自行填写。

原文将费率标为“整体需要讨论”。以下值进入首个草稿 rate-card，但业务/财务批准前保持 pending_business_approval，不得生产扣点或销售：

| action | 原文动作 | 费率 |
|---|---|---:|
| image.generate.standard | 标准图片 | 1 点/张 |
| image.edit.annotation | 批注修改图片 | 1 点/张 |
| video.generate.standard_15s | 15 秒标准视频 | 90 点起/条 |

“90 点起”的变量与文本模型费率未明确；没有唯一已批准费率时相应动作 fail-closed。

店铺扫描、商品录入、知识库查询、历史记录查看执行后不扣点，但执行前仍必须满足可用点数大于 0；“不扣点”不等于零点豁免。

账本采用 append-only：grant → reserve → settle/release → refund/reverse → expire/adjust。每笔包含 workspace、来源订单、版本、账期、动作、点数、幂等键、actor、任务、provider request/usage/cost。余额为可重建投影；不足时不拆单、不调用 provider、不创建副作用。provider 已执行但结算未知时保持 reserved，禁止交付和重复调用，进入对账。

## 5. 全局 fail-closed 门禁

所有商家业务请求和异步任务先取得服务端 CommercialAccessDecision，再检查订阅、权限、对象范围、品牌/店铺/存储、模型与平台 readiness：

- available_points > 0：仅允许继续后续准入。
- available_points = 0：非白名单返回 CREATIVE_POINTS_EXHAUSTED。
- unknown、账本不可读、快照失败或 reservation 不可判定：返回 CREATIVE_POINTS_UNAVAILABLE。
- 收费动作还需 available_points >= quoted_points；否则 CREATIVE_POINTS_INSUFFICIENT。
- 前端禁用不是安全门禁；人民币钱包余额永不参与该决定。

### 5.1 精确恢复白名单

必须逐 HTTP route、MCP method、Worker action 枚举；未分类的新入口默认拒绝并使契约测试失败。只允许：

1. 登录、身份/会话恢复、必要 workspace bootstrap。
2. 套餐、订阅、订单、账期、点数余额与到期状态读取。
3. 套餐购买/升级、点数充值下单与支付状态查询。
4. 验签、防重的支付回调与对账。
5. 本 workspace 自有历史/数据导出及删除申请。
6. 必要客服恢复入口。
7. 具独立 capability 的 Ops 财务、调账、配置诊断/修复和审计。

不在白名单：平台连接/授权/同步，扫描，在线商品/知识库/历史浏览，品牌/商品/listing/任务创建，上传，规则操作，生成、编辑、审核、批量、发布、服务预约及其他商家业务。

### 5.2 全链覆盖

门禁覆盖插件 bridge、MCP 分发、全部商家 HTTP、批量/定时任务、入队前及 Worker 执行前复核、重试/补偿/内部 action。Worker 保存 decision snapshot revision 并执行前重读；余额耗尽、不足或 revision 漂移时拒绝执行，不调用模型/平台，不产生对象。

## 6. 停费、退款与数据

停月费后停止 AI 文案/图片/视频、店铺商品自动扫描、规则更新、持续学习/云同步、维护与 1V1、新素材任务。全局点数门禁优先：余额为 0 时即使处于建议宽限期也只开放恢复白名单。

以下是原文建议/隐藏/待法务审核，不是已批准生产规则：

- 建议 7 天续费宽限。
- 建议数据保留 90 天、到期通知、保留期内导出。
- 超过 90 天重新开通可收恢复费。
- 部署前可协商退款；部署验收后接入费不退。
- 月服务开通后剩余点可退为隐藏条款。
- 未用充值点按约定有效期处理。
- 故障可延长服务或补偿点数。

法务、财务、合同批准前生产收款保持 NO-GO，不得实现“隐藏退款条款”。交付不承诺流量、销售结果或 100% 通过平台审核。

## 7. UI 要求

ChatGPT 插件先展示 access decision。零点时只提供余额/到期、充值包、升级、支付状态、导出和客服恢复；不得输出其他可执行业务 action。收费动作确认必须显示费率版本、预计点数、执行后余额；无批准费率无确认按钮。错误返回稳定 code、requestId、余额状态和 nextAction。

桌面 Ops 的信息架构：

- 商业目录：接入费、月套餐、private test SKU、充值包、草稿费率。
- Workspace 权益：套餐快照、点数余额和 grant/reserve/settle/expire 明细。
- 零点阻断队列：workspace、原因、revision、恢复动作、审计。
- 订单支付：套餐、充值、抵扣、退款状态、对账。
- 服务履约：培训、1V1、复盘、响应承诺的人工排期/工时/记录。
- Readiness：六平台与五模态真实鉴权、usage、cost、error、canary。

使用现有 React/Ant Design 与仓库设计系统，1440px 高密度桌面布局。状态用文字+图标；表格支持筛选、固定关键列、详情抽屉和错误摘要；异步写入呈现 loading/success/error。满足 WCAG 2.2 AA 的焦点、可访问名称、错误关联和 4.5:1 正文对比度。禁止增加移动端验收或营销落地页风格。

## 8. 契约、安全与数据

- 目录、订单快照、点数账本、费率和 access decision 全部版本化；前端无生产套餐常量。
- workspace 表带 workspace_id、RLS 与 FORCE RLS；repository 使用 workspace transaction。
- 目录生效/停用、赠点、调账、退款、private SKU、费率批准和门禁恢复需要独立 capability、actor、reason、before/after、evidence、审计。
- 商家不能改余额；客服不能发布套餐/调账；财务不能读非必要客户内容。
- 写请求带 expected_revision、idempotency_key、reason；响应带 server labels、units、version、balance state、nextAction、requestId。
- 失败保持 unknown/error，禁止渲染成 0 或空数据。
- 模型走已配置中转并保留真实 request/usage/cost/error；缺配置 fail-closed。
- 平台写继续使用人工确认票据、权限复核和真实回执；点数门禁不替代发布门禁。

## 9. 已有底座与必须替换

可复用：workspace/RLS、支付回调验签防重、人民币收款流水、entitlement consumption、存储 reserve/settle、模型成本证据、MCP/HTTP、plugin bridge、Outbox/Worker、发布 prepare/confirm/reconcile、Ops/merchant 框架。

必须替换/扩展：

- 2000/6500 错误目录常量与测试。
- includedTasks/monthly_tasks_used 作为点数事实。
- 人民币钱包作为业务解锁条件。
- 只含价格/店铺/任务的 Offer/订单快照。
- 宽泛 bridge read-only/onboarding 豁免。
- 少数 handler 的局部门禁及 NODE_ENV=test 绕过。

## 10. 非目标

手机/平板、非标准平台、ERP/PIM、私有化、人工代做、大量历史清洗、专项增值服务产品化、任意 DAG、无人值守发布、驳回自动重发、人民币钱包兜底、自创新的预约/保修/SLA 算法，以及用 fixture/静态代码证明生产完成。

## 11. 错误、恢复与失败模式

| 场景 | code | 副作用/恢复 |
|---|---|---|
| 0 点 | CREATIVE_POINTS_EXHAUSTED | 无；充值/升级 |
| 不足本次费率 | CREATIVE_POINTS_INSUFFICIENT | 无；充值/升级 |
| 余额 unknown/账本失败 | CREATIVE_POINTS_UNAVAILABLE | 无；重试/客服/Ops |
| 无批准费率 | RATE_CARD_UNAVAILABLE | 无；Ops 审批 |
| 重复支付回调 | 既有幂等结果 | 不重复 grant |
| provider 失败 | 原 reservation release | 可安全重试 |
| provider 已执行、结算 unknown | 保持 reserved | 禁交付/重调；对账 |
| Worker revision 漂移 | COMMERCIAL_ACCESS_STALE | 不执行；重新发起 |
| 跨租户 | TENANT_SCOPE_DENIED | 无；审计告警 |
| readiness 缺失 | READINESS_BLOCKED | 无外调；配置/canary |

关键失败模式与控制：充值到账与余额投影用同事务/outbox；默认拒绝注册表防漏放；白名单精确枚举；行锁、唯一幂等键和并发测试防双扣；grant source/expiry 防混账；legacy task 不换算点数；private SKU 用权限与资格/抵扣幂等；access decision 不读钱包；unknown 保持独立状态；“90 点起”未定场景保持阻断。

## 12. 测试与上线门禁

证据等级：E0 静态；E1 单元/契约；E2 真 PostgreSQL/RLS/Worker；E3 正式插件与桌面浏览器连接真实沙箱；E4 生产 canary/真实回执。P0 至少 E3；支付、模型、平台写、对象存储和 readiness 对外声明需 E4。

必须通过：

1. 目录逐字段验证 5000、6×500、1999/7 天、2000/5000/10000、5000/12500、1/3、5/15、50g、5/10 小时、4/2 小时、充值包和动作费率。
2. 0 点时所有非白名单 HTTP/MCP/Worker 一致拒绝，且无 DB/队列/模型/平台/scanner/存储副作用。
3. 0 点时身份、商业读取、充值/升级、支付、导出、客服和授权 Ops 修复可用，并验证权限/RLS。
4. 余额不足收费动作在 provider 前拒绝；零扣点动作仅余额大于 0 时可用且余额不变。
5. 点数状态机的幂等、并发、账期、消费顺序、退款、expire 和 unknown 对账。
6. 真实支付沙箱验证签名、防重、金额/币种/SKU、到账解锁。
7. 真 PostgreSQL 验证 RLS/FORCE、append-only、迁移、跨租户和回滚。
8. 正式 ChatGPT 插件验证零点、恢复、充值后恢复和 Bridge/MCP parity。
9. 1440px Ops 验证目录、private SKU、费率、账本、阻断队列、RBAC、深链、刷新、loading/error/empty/unknown、键盘与可访问性。
10. 五模态真实中转和六平台逐能力 canary；缺证据保持 blocked。
11. 类型、单元/API/契约、桌面浏览器、容器、迁移、备份恢复、并发和 release gates 全通过。

生产/销售继续 NO-GO，直到财务批准成本与费率；业务确认 6×500 日期、50g 单位、private test 资格/抵扣、“90 点起”变量；法务批准退款、7 天宽限、90 天保留/删除；真实支付、点数账本、中转、平台、存储、导出、RLS、Worker/发布门禁达到 E3/E4；服务容量覆盖承诺。

## 13. 需求追踪

| 原文/新增要求 | 位置 |
|---|---|
| 5000 接入费、连续 6 月每月 500 点 | 3.2、4 |
| 1999/7 天隐藏测试与抵扣 | 3.3 |
| 2000/5000/10000 月套餐；5000/12500 点 | 3.4 |
| 品牌 1/3、店铺 5/15、50g、5/10 小时、4/2 小时 | 3.4 |
| 六平台与持续功能 | 3.2、3.4 |
| 500/300、2000/1000 点包；图片 1、编辑 1、视频 90 起 | 3.1、4 |
| 扫描/录入/查询/历史不扣点 | 4 |
| 无点不能使用任何业务功能 | 5 |
| 停费/导出/7天与90天建议/退款交付 | 6 |
| 增值服务待讨论、估计不上 | 3.1、10 |

## 14. gstack CEO 评审记录

### 14.1 前提挑战与选择性范围

- 唯一范围来自《商业化方案》：成立；旧 PRD/代码冲突时改后者。
- 零点门禁覆盖零扣点业务：成立；不扣点只表示余额不变。
- 精确恢复白名单：成立；避免无法充值/导出的死锁。
- 钱包可替代点数：拒绝；无需求授权且会双重收费。
- 建议/待讨论条款已批准：拒绝；继续作为生产门禁。

采用 SELECTIVE EXPANSION：只加入版本、RLS、幂等、审计、默认拒绝和真实证据；不加入新收费方式、复杂服务政策或增值产品。

### 14.2 现有杠杆

| 子问题 | 可复用 | 缺口 |
|---|---|---|
| 订单/支付 | billing、nonce、快照 | 完整 SKU 与点数 grant |
| 点数 | entitlement/usage | 统一可过期账本 |
| 门禁 | API/MCP/权限中间件 | 默认拒绝 access decision |
| 异步 | Outbox/Worker auth | 点数 revision 复核 |
| 存储 | quota reserve/settle | 套餐 50g 口径 |
| UI | Ant Design/Ops/审计 | 目录、账本、阻断与恢复 |
| 外部证据 | readiness/成本/发布确认 | 联合商业准入 |

梦想状态：CURRENT（多余额、错误常量）→ THIS PLAN（唯一目录、账本、默认拒绝、恢复白名单）→ 12-MONTH（批准版本自动驱动合同、账单、插件与 Ops，真实证据逐能力放行）。本期不做 ERP、低代码工作流或专项服务市场。

| 方案 | 完整度 | 决策 |
|---|---:|---|
| 每个 handler 补余额判断 | 3/10 | 拒绝，必然漏放 |
| 人民币钱包全局门禁 | 2/10 | 拒绝，违背原文 |
| 中央 access decision + 单一点数账本 | 10/10 | 采用 |

### 14.3 双重外部声音与十一项检查

Claude subagent 与 Codex 均识别 12 项主要问题，对六个维度形成 6/6 共识：旧 PRD 改写商品、正确问题是统一点数准入、必须删除钱包兜底/未授权政策、采用中央门禁/单一账本、存在毛利/退款/试用风险、多账本会形成合同错账。无策略分歧。

1. 架构：检查插件→MCP/API→账本→Worker→provider；中央门禁防漏放。
2. 错误救援：第 11 节覆盖耗尽、不足、unknown、费率、支付、provider、revision、租户与 readiness。
3. 安全：默认拒绝、精确白名单、RLS/FORCE、capability、审计。
4. 数据/交互：充值、异步、账期、试用、导出与 unknown 有状态；未决期限不伪造。
5. 代码质量：复用分发/仓储/Outbox，删除多重解锁，新入口强制分类。
6. 测试：第 12 节覆盖全表面、无副作用、真库、插件、桌面和 E3/E4。
7. 性能：使用带 revision 的余额投影、索引和短事务，不逐请求扫描全账本。
8. 可观测：返回 requestId、余额/策略版本、nextAction；监控拒绝、unknown、对账积压与漏放。
9. 部署：expand/backfill/shadow/cutover；legacy task 不换点；对账非零不切换。
10. 长期：保持单一商业事实，不提前产品化增值服务。
11. UX：商家优先恢复，Ops 高密度且显式 unknown/error；不做移动端。

决策审计：恢复 5000/12500、6×500、1999 测试包并删除钱包兜底属于原文纠错；中央默认拒绝与精确白名单属于必要工程约束；增值服务/复杂政策不做属于范围控制；GB/GiB、赠点日期、费率变量保留人工决策。

## 15. gstack 设计评审记录

### 15.1 双重设计声音结论

Claude subagent 与 Codex 均判定当前商业 UI 为 NO-GO：RBAC、范围条、错误边界、Ant Design token 和 Drawer 焦点底座可复用，但页面仍传播“任务额度 + 人民币钱包 + 简化 Offer”的旧事实。两路均要求在现有“账务与商业配置”域内重建任务型信息架构，不新增顶级业务域。

| 维度 | 当前 | 目标 | 结论 |
|---|---:|---:|---|
| 信息架构 | 2/10 | 9/10 | Card 长页改为可深链的任务 Tabs |
| 核心旅程 | 2/10 | 9/10 | 默认进入阻断与恢复 |
| 状态/错误 | 3/10 | 9/10 | exhausted/insufficient/unavailable/stale 分离 |
| 权限/信任 | 4/10 | 10/10 | 拆分目录、费率、点数、private SKU、恢复能力 |
| 视觉层级/密度 | 4/10 | 9/10 | 1440px 平面筛选 + sticky Table + Drawer |
| 设计系统 | 5/10 | 9/10 | 延续现有 token，移除局部硬编码与卡片嵌套 |
| 无障碍/键盘 | 5/10 | 9/10 | H1、错误摘要、aria-sort、焦点恢复、live region |

### 15.2 权威信息架构

```text
账务与商业配置
├─ 阻断与恢复（默认）
├─ Workspace 权益
├─ 创意点账本
├─ 商业目录
│  ├─ 接入服务与月套餐
│  ├─ 点数充值包
│  └─ 非公开测试 SKU（能力驱动隐藏）
├─ 订单与支付
├─ 创意点费率
└─ 服务履约
```

URL 保存 view、workspace、筛选、排序和目标记录。首屏只保留阻断、unknown、paid-but-ungranted 和待履约四个可行动汇总；禁止营销式 KPI、Card 套 Tabs 套 Table。

核心恢复旅程：

`阻断队列 → Workspace decision → 点数来源/到期 → 支付/grant/对账 → 新 access revision → 已恢复`

支付成功不等于恢复；只有 grant 到账且新 CommercialAccessDecision 通过才显示 RECOVERED。

### 15.3 页面与组件

- CommercialAccessStatusBar：状态、available/reserved、最早到期、decision revision、最后核验。
- AccessBlockQueueTable + AccessRecoveryDrawer：EXHAUSTED/INSUFFICIENT/UNAVAILABLE/STALE 与 next action。
- WorkspaceEntitlementTable、EntitlementSnapshotDrawer。
- CreativePointsLedgerTable、LedgerEntryDrawer。
- CommercialCatalogTable、OfferVersionDrawer、PrivateTrialSkuPanel。
- CreativePointRateTable、RateApprovalModal。
- RechargeOrderTable：SKU、点数、payment state、grant state、access revision。
- ServiceFulfillmentTable：培训、1V1、复盘、工时和证据。
- CommercialErrorSummary、RevisionConflictAlert、AuditEvidenceNotice。

旧 ConfigurationCenter 的套餐字段改为只读快照；includedTasks、钱包解锁、通用 add-on、优惠券、灰度和模型倍率不得替代本 PRD 的目录/点数/费率。

### 15.4 状态、权限与可访问性

| 状态 | 呈现 | 恢复 |
|---|---|---|
| EXHAUSTED | available 明确为 0 | 充值、升级、查单、授权 Ops 修复 |
| INSUFFICIENT | available 与 quoted 差额 | 充值、升级 |
| UNAVAILABLE | 不显示 0；账本/投影未知 | 重试、对账、客服、诊断 |
| STALE | old/new revision | 重取 decision |
| RATE_CARD_UNAVAILABLE | 费率未批准 | 查看草稿、授权审批 |
| RECOVERED | 新 revision + audit/request ID | 返回业务流 |

private SKU 无 read capability 时整块、数量、筛选项和搜索提示全部隐藏。有读无写时使用 Descriptions/Table，不渲染 disabled 表单。目录草稿/发布、费率草稿/批准、点数读取/调账、private SKU、支付对账、服务履约和门禁恢复必须分别消费服务端 capability。

页面切换聚焦唯一 H1；表格 Input/Switch 使用含 SKU/action 的可访问名称；排序提供 aria-sort；unknown/error 使用 alert，余额与恢复更新使用 polite live region；多错误聚焦摘要并链接字段；Drawer 关闭回触发行；状态使用图标+文字+code。只验收 1440px 桌面。

### 15.5 设计实现与测试任务

1. 替换前端旧商业类型和展示语言。
2. 建立可深链 Tabs 及各自独立 loading/empty/error/permission。
3. 实现阻断队列、恢复 Drawer、权益快照和点数账本。
4. 重做完整目录、private SKU、充值包和草稿费率。
5. 扩展订单为 SKU → payment → grant → access revision。
6. 拆分粗粒度 canGlobalCommercial/canPlatformOps。
7. 增加 0/不足/unknown/stale、private 隐藏、paid-but-ungranted、409 保留输入、独立权限、键盘/焦点测试。
8. 用 1440×900 真实桌面浏览器验证 finance/support/platform Ops；fixture 截图不算完成。

PHASE 2 VERDICT：设计规格通过，可进入工程评审；当前 UI 实现仍为 NO-GO。

## 16. gstack 工程评审记录

### 16.1 双重工程声音结论

工程 subagent 与 Codex 均判定当前架构和代码为 NO-GO。现有鉴权注册表、HTTP 路由清单、RLS/outbox 和订单快照可作为底座，但运行时仍由任务次数、图片 entitlement、人民币钱包和可变 offer 共同决定能力；没有创意点事实账本、费率域、private SKU、服务履约域或跨 HTTP/MCP/Bridge/Worker 的 CommercialAccessDecision。

两路评审同时否决旧架构文档的“ENG CLEARED”：其中的钱包联合预占、365 天赠点、60 天导入、15 分钟取整、取消/爽约、30 天质保、完整 SLA 算法、legacy task/add-on 转点、80% 销售容量线等均无需求依据，必须删除而非实现。最新迁移编号当前为 143，新 expand migration 必须在合并时重新取下一可用编号，当前候选从 144 开始。

### 16.2 必须建立的工程事实源

- 全局不可变目录：commercial_skus/versions、benefit_definitions、sku_version_benefits、creative_rate_card_versions/rules、private_sku_eligibility、configuration approval/events。
- Workspace 合同事实：orders/snapshots、subscription periods、entitlement snapshots、六次独立赠点 schedule、private redemption、implementation fee credit、service allocations/events。
- 创意点事实：grants、operations、reservations、allocations、append-only ledger、provider receipts、rebuildable balance projection、access revisions、audit/outbox。
- 每张租户表均含 workspace_id、租户 FK、ENABLE/FORCE RLS、USING + WITH CHECK；账本/事件表禁止应用角色 UPDATE/DELETE/TRUNCATE。
- 人民币支付/退款账本和 provider usage/cost 只以 operation_id 关联证据，永远不能解除商业门禁。

### 16.3 统一准入与事务边界

生成一份所有入口共用的 exact operation registry，分类仅为 RECOVERY_CONTROL、POINT_REQUIRED_NO_CHARGE、POINT_CHARGED；未知入口默认拒绝并使契约测试失败。Bridge 不得以 READ_ONLY_METHODS、SAFE_WITHOUT_INTERACTIVE_WRITE 或前缀规则扩大 API 白名单。即使不扣点，商家业务操作在 available_points=0 时也必须拒绝。

固定顺序为：schema → identity/session → tenant/RBAC/object scope → exact commercial classification → CommercialAccessDecision/quote/reservation → onboarding/readiness → business mutation/outbox/provider。任何知识 hydration、写库、排队、存储预留或外部调用均不得早于商业判定。

支付回调的 provider event/nonce、order paid、subscription/period/snapshot、当前到期 grant、balance projection、access revision、private credit、audit 与 outbox 必须同事务提交；不能出现 paid 已提交而 grant 未提交。收费动作先按 earliest-expiry 锁定 grant 并原子预占，Worker 在外部调用前复核 access revision、snapshot、rate、reservation 和 readiness；远端结果不明时保持 reserved/unknown，禁止交付或盲重试。

### 16.4 迁移与验证边界

includedTasks、monthly_tasks_used、旧 usage、人民币 wallet、通用 addon 不转换为创意点，只作为 legacy 只读对账历史；任何 legacy 来源不得贡献 available_points。新旧路径可 shadow，但 ChatGPT 插件、HTTP、MCP、Bridge 和 Worker 必须作为一个切面同步启用，不能逐入口留下绕过窗口。

E1 覆盖完整目录数值、状态/属性、入口穷举、精确白名单、错误包、private 隐藏和幂等；E2 使用真 PostgreSQL 覆盖 FORCE RLS、append-only、支付/grant/revision 原子性、200 并发预占、到期顺序、outbox 回滚、迁移重跑和 Worker revision drift；E3 使用正式安装插件与 1440px Ops 验证阻断—充值—到账—新 revision 恢复闭环；E4 使用真实支付回执、中转鉴权/用量/成本、对象存储/scanner 和平台 canary。静态代码、fixture 或已有通用 readiness 均不能证明本需求完成。

PHASE 3 VERDICT：目标工程方案可形成；当前架构文档与实现仍为 NO-GO，必须先按本 PRD 重写架构并从统一契约/注册表开始。

## 17. gstack DX 评审记录

### 17.1 双重 DX 声音结论

DX subagent 与 Codex 均判定当前开发体验为 NO-GO。MCP schema/RBAC 清单、统一 envelope、request/trace、Ops transport、Bridge 生产 fail-closed、Worker 授权复核、migration checksum/连续性和通用 doctor 可复用；但四类开发者都无法跑通“零点阻断 → 购买点包 → 支付到账 → grant → 新 access revision → 恢复业务”的 first working flow。

| 角色 | 当前阻断 |
|---|---|
| 插件开发者 | merchant.start 仍可能写 intent；Bridge bootstrap 后进入业务；README 明示 platform.connect/catalog.sync 零余额可用 |
| API/MCP 集成者 | 没有机器可读商业分类、稳定 decision/quote/reservation/error wire schema；OpenAPI 没有五类商业错误 |
| Ops 前端开发者 | transport 可诊断，但 DTO/页面仍是 offer/addon/coupon/rollout/wallet/includedTasks |
| 值班/迁移工程师 | README 迁移尾与仓库不一致；没有 commercial doctor、shadow diff、legacy 非贡献断言、cutover/forward-fix runbook |

当前无法测量商业链路 TTHW。fixture 只能新增 positive/zero/insufficient/unknown/paid-but-ungranted/stale 的 E1/E2 确定性场景，必须显著标记 simulated，不能成为 E3/E4 证据。

### 17.2 冻结 wire contract 与诊断要求

- 在共享契约中冻结 CommercialAccessDecision、quote、reservation、ledger entry、payment/grant/recovery result 及错误 details JSON Schema。
- 明确 HTTP status、MCP isError、retryable、request_id、trace_id、balance_state、available_points、quoted_points、access_revision、rate_card_version 与 next_actions 的逐错误映射；敏感字段继续脱敏。
- OpenAPI 必须由同一方法契约生成或做严格 parity；不能以 additionalProperties 掩盖商业方法参数/结果。
- Bridge 保真传递上述字段，只渲染服务端许可的恢复 action；不得生成 50/100/300 元等未授权推荐金额。
- dev:doctor 必须逐项报告目录版本、费率批准、点数投影、支付→grant、Worker 商业复核和全入口注册表 readiness；缺失在对应环境明确 BLOCKED。

### 17.3 DX 验收与工作包

1. 从 HTTP router、MCP registry、Bridge tools、Worker event/action 生成全量 manifest；每项恰有一个分类，新增未分类入口使 CI 失败。
2. 建立跨 HTTP/MCP/Bridge/Ops 的错误 golden matrix，并证明 0/unknown/不足/stale/无费率时 DB、outbox、queue、storage、relay、scanner、connector 副作用均为 0。
3. 从全新 checkout 计时启动真 PostgreSQL/Redis/API/Worker/Ops、安装源码插件、复现 fixture 阻断与 grant 恢复；runbook 记录命令、预期输出、清理和失败诊断。
4. 演练 fresh install、当前 migration tail 升级、重复执行、中断恢复、shadow diff、legacy 永不贡献点数、V2 切换、旧二进制 fencing 和 forward-fix；禁止删数据通过测试。
5. Worker 日志用 request/trace/operation/provider id 串联 decision/snapshot/rate/reservation；stale/unknown 禁止盲重试。
6. 正式安装 ChatGPT 插件和 1440×900 Ops 完成 E3；E4 artifact 绑定 release、bridge/OpenAPI hash、migration tail、真实 workspace、支付/中转/Worker request IDs，并明确 simulated=false。

DX 工作并入工程 WP：DX-0 契约注册表 → DX-1 Bridge 恢复体验、DX-2 集成场景、DX-3 Ops client、DX-4 Worker/值班 → DX-5 迁移切换 → DX-6 文档/证据。DX 不另造账本或商业规则。

PHASE 4 VERDICT：目标 DX 规格可形成；当前代码、文档、fixture、迁移和联调仍为 NO-GO。

## 18. autoplan 最终结论与批准门

四阶段双评审对目标无分歧：采用唯一不可变商业目录、append-only 创意点账本、中央默认拒绝 CommercialAccessDecision、精确恢复白名单、原子 payment→grant→access revision、全入口同步切换，以及 1440px 桌面 Ops。旧钱包/任务/add-on 只保留历史账务证据，不能解锁或换算点数。

仍待业务/财务/法务批准的内容保持阻断，不允许工程猜测：6×500 的起算/每笔到期日；50g 的 GB/GiB；文本费率；视频 90+ 的变量公式；充值点有效期；private SKU 资格/重复购买/5000 元抵扣会计；退款、宽限、数据保留。相关配置可建模为 unresolved，但不得生产激活。

批准后的实施顺序固定为：重写架构与页面级 UI 规格 → 共享契约/精确注册表 → 数据/RLS/账本 → 目录/private SKU/支付原子事务 → API/MCP/Bridge/Worker → 桌面 Ops → legacy shadow/cutover → E1/E2 → 正式插件与桌面 E3 → 真实外部 E4。每阶段失败继续 fail-closed，不以代码存在宣称完成。

PRD VERDICT：AUTOPLAN COMPLETE；AWAITING FINAL IMPLEMENTATION APPROVAL。
IMPLEMENTATION / SALES / PRODUCTION VERDICT：NO-GO。
