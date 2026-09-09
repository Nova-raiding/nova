# 商业化方案 CodeGraph / QA 覆盖矩阵

审计日期：2026-09-08（Asia/Shanghai）  
方案来源：[商业化方案 (1).md](</Users/lixiaomei/Downloads/商业化方案 (1).md>)  
审计范围：商业目录、购买/授予、创意点、连续权益、worker 门禁、服务履约、平台连接器、数据生命周期、生产发布证据。  
本轮已落地 API/MCP、worker、账本和迁移闭环；生产中转、对象存储、扫描器和平台 OAuth 仍按真实配置门禁 fail-closed。

## 2026-09-08 实现复核增量

- 本地 PostgreSQL 已真实迁移到 174：167 私测抵扣闭环、168 赠送批次 dispatch、169 赠送批次过期事实表、170 退款不可变流水、171 退款运行时 ACL、172 私测邀请码、173 私测邀请码不可变事件/RLS/ACL、174 私测权益目录激活均存在。
- 5000 元正式接入、基础版、成长版和两个点包的 v2 目录快照已 executable；费率为图片 1 点、批注编辑 1 点、文本 1 点、标准 15 秒视频 90 点。
- 六批次 500 点按支付成功后的月度排程生成；每批次按次月边界过期，第 6 批后不再生成第 7 批。worker 已接入 due dispatch/expiration。
- 私测流程已具备资格创建、业务审批、验证完成、1999 元试用窗口、1999 元抵扣、财务审批、3001 元待支付订单和人工转账核验入口。
- 图片、图片编辑、文本/视频生成入口已接入 V2 创意点预留；图片安全重试也走同一商业准入和费率快照。余额不足返回充值动作，provider 成功回执带用量/成本后结算，失败释放，未知结果保留对账。

## 判定口径

- `✅`：实现、针对性测试和真实运行证据均具备。
- `🟡`：存在实现和/或测试，但缺少真实生产链路、配置或用户可见证据。
- `⛔`：规则被设计为 fail-closed，当前有意不可执行；不能对外销售或宣称已交付。
- `❌`：当前没有完整实现或没有可核验的交付闭环。

单元测试只证明代码路径；“真实运行证据”必须来自 API/MCP、worker、数据库、插件宿主、后台或生产 doctor 的运行结果。静态文件存在不计为完成。

## CodeGraph 索引证据

读取的文件：`codegraph.json`、`.codegraph/codegraph.db`。

截至本次审计，CodeGraph 数据库报告：

| 指标 | 数量 |
|---|---:|
| nodes | 16,478 |
| edges | 62,336 |
| files | 1,176 |

商业化相关节点可以从以下入口追踪：

| 关系/入口 | CodeGraph 中的实现文件 |
|---|---|
| 方案目录与激活校验 | `packages/application/src/commercial-plan-catalog.ts` |
| 购买和原子授予 | `packages/application/src/commercial-purchase-service.ts`、`packages/persistence/src/commercial-contract-repository.ts` |
| 连续权益 | `packages/application/src/continuous-feature-entitlement.ts`、`packages/application/src/commercial-access-service.ts` |
| charged execution | `packages/application/src/commercial-execution.ts`、`packages/workers/src/commercial-access.ts` |
| 服务履约 | `packages/application/src/service-fulfillment.ts`、`packages/persistence/src/service-fulfillment-repository.ts` |
| 生产门禁 | `scripts/dev-doctor.ts`、`tests/*production*gate*`、`tests/*evidence*gate*` |

CodeGraph 证明了“文件、符号和关系被索引”，不证明运行环境已经配置或功能已经上线。

## 1. 5000 元正式接入

| 方案功能 | 实现文件/入口 | 测试 | 真实运行证据 | 状态 |
|---|---|---|---|---|
| 插件账户开通 | `packages/application/src/commercial-purchase-service.ts`、认证/授权模块、`apps/plugin` | purchase/auth/plugin contract tests | 当前 production doctor 未取得 ChatGPT host/plugin bridge 的真实 evidence | 🟡 |
| 5000 元一次性接入费 | `commercial-plan-catalog.ts`、`166_commercial_catalog_executable_v2.sql` | `commercial-plan-catalog.test.ts`、catalog repository tests | 本地 PostgreSQL 已应用 166，v2 onboarding executable | 🟡 |
| 连续 6 个月每月 500 点 | `commercial-plan-catalog.ts`、`service-fulfillment.ts` | `service-fulfillment.test.ts`、`commercial-plan-coverage.test.ts` | 已解析纯规则；尚无数据库 grant worker 的真实执行证据 | 🟡 |
| 每批点数次月过期 | `service-fulfillment.ts` 的 grant schedule 规则、creative point lifecycle | point lifecycle/repository tests | 无真实定时发放和过期流水证据 | 🟡 |
| 第 6 个月后停止赠送 | `onboarding-grant-dispatch-repository.ts`、worker/ledger | dispatch/migration tests | 169 已应用；仍需生产定时运行证据 | 🟡 |
| 系统部署与基础调试 | `scripts/dev-doctor.ts`、compose/infra | release/runtime gate tests | doctor 显示 API、ops UI、production config 等仍有失败项 | 🟡 |
| 固定规则 | rules/knowledge/approval 模块 | rules/approval tests | 没有已授权平台规则的生产同步证据 | 🟡 |
| 商品品类规则 | rules/knowledge 模块 | rule contract tests | 没有真实平台同步和生效回执 | 🟡 |
| 大促节点规则 | campaign/rules 模块 | campaign lifecycle tests | 没有生产平台活动发布证据 | 🟡 |
| 一次系统培训 | `service-fulfillment.ts` | service fulfillment tests | 没有客户预约、完成确认、小时消耗的真实流程证据 | 🟡 |
| 上线验收 | fulfillment/support/acceptance 模块 | delivery/readiness tests | 没有绑定商业订单的客户验收回执 | 🟡 |
| 基础问题处理 | support ticket/SLA/audit 模块 | support/SLA tests | 没有生产客户工单和 SLA 证据 | 🟡 |

### 5000 元知识库内容

| 方案功能 | 实现文件/入口 | 测试 | 真实运行证据 | 状态 |
|---|---|---|---|---|
| 用户使用偏好录入 | knowledge/brand preference API/MCP、ops knowledge 页面 | knowledge/preference tests | 生产登录和租户绑定未验收 | 🟡 |
| 一个企业主体 | tenant/workspace/brand unit 模块 | tenant/brand unit tests | 尚无“企业主体→商业订单→权益”完整运行证据 | 🟡 |
| 店铺自动扫描录入 | connectors、sync worker、platform preflight | connector/sync tests | 淘宝/天猫/京东/拼多多/抖店/小红书生产 OAuth 均缺失 | 🟡 |
| 商品自动扫描录入 | catalog sync/import worker | sync/import tests | 没有真实平台商品扫描回执 | 🟡 |
| 品牌基础资产 | knowledge assets/storage/brand modules | asset/knowledge tests | 对象存储当前仍为 local mode | 🟡 |
| 品牌表达和视觉要求 | brand preference/rules/assets | preference/rules tests | 没有生产对象存储、扫描和真实租户 evidence | 🟡 |
| 按月套餐限制品牌/店铺/商品数量 | catalog entitlements、continuous entitlement、quota modules | entitlement/quota tests | 目录数量存在，但所有创建/同步入口端到端强制未证实 | 🟡 |

| 平台 | 代码/测试覆盖 | 真实运行状态 | 状态 |
|---|---|---|---|
| 淘宝/天猫 | Alibaba TOP adapter/profile + connector tests | production OAuth 缺失 | 🟡 |
| 京东 | JD adapter + tests | production OAuth 缺失 | 🟡 |
| 拼多多 | Pinduoduo adapter + tests | production OAuth 缺失 | 🟡 |
| 抖店 | profile/config + connector contracts | production OAuth 缺失 | 🟡 |
| 小红书 | profile/config + connector contracts | production OAuth 缺失 | 🟡 |

## 2. 1999 元 7 天私有试用

| 方案功能 | 实现文件/入口 | 测试 | 真实运行证据 | 状态 |
|---|---|---|---|---|
| 1999 元/7 天 SKU | private-trial conversion state machine | private-trial service/migration tests | 私测 SKU 对外仍保持 private，不走公开购买入口 | 🟡 |
| 一个品牌、一个店铺、500 点 | 独立私测订单创建与 1999 元支付核验；支付事务创建 7 天 entitlement snapshot、500 点 grant/ledger，并保留 max_brands/max_stores | `private-trial-initial-grant.contract.test.ts`、迁移 174、商业契约测试 | 待本地 PostgreSQL 迁移 174 后执行完整 API/MCP 与桌面 Ops 验收；生产支付仍未配置 | 🟡 |
| 1 小时 1 对 1 | service fulfillment | fulfillment tests | 没有试用订单服务消耗证据 | 🟡 |
| 核心功能和一次复盘 | generation/knowledge/service fulfillment | feature tests | 中转、平台授权、存储等生产门禁仍未通过 | 🟡 |
| 7 天内购买正式版抵扣 5000 元 | `private-trial-conversion-repository.ts`、payment verify MCP | private-trial service/migration tests | 资格窗口、1999 抵扣、3001 待支付和 manual_transfer 核验已形成 | 🟡 |
| 测试版不公开 | offer visibility=`private` + 私测邀请 | catalog/邀请 MCP + 172/173 migration | 邀请码只返回一次、数据库只存哈希；支持生成、列表不返明文、撤销、过期和按客户兑换；真实宿主证据仍缺 | 🟡 |

## 3. 月费套餐

| 套餐 | 目录值 | 实现/测试 | 真实运行证据 | 状态 |
|---|---|---|---|---|
| 基础版 2000/月 | 1 品牌、5 店铺、5000 点、5 小时、4 工作小时响应、无复盘 | `LOCAL_PLAN_ENTITLEMENTS` + catalog tests | 本地 PostgreSQL 166 已批准且 executable；真实服务/SLA 仍未绑定订单 | 🟡 |
| 成长版 5000/月 | 3 品牌、15 店铺、12500 点、10 小时、2 工作小时响应、每月复盘 | 同上 | 本地 PostgreSQL 166 已批准且 executable；真实服务/SLA 仍未绑定订单 | 🟡 |
| 定制版 10000/月起 | 数量、点数、小时数、SLA、复盘和流程按合同 | custom entitlement validation + fulfillment | 没有报价、里程碑、审批和定制交付运行证据 | 🟡 |

| 月费共同能力 | 实现/测试覆盖 | 真实运行证据 | 状态 |
|---|---|---|---|
| 持续系统、云知识库、品牌知识库 | application/knowledge/storage | 本地单人环境可用；对象存储/KMS production gate 仍未通过 | 🟡 |
| 自然语言、文本、图片、视频生成 | AI relay/multimodal/application | 当前运行环境未提供可核验的中转鉴权、用量、成本证据 | 🟡 |
| 图片标注/编辑 | image generation/edit contracts | 代码和测试存在；生产 relay/asset evidence 不足 | 🟡 |
| 批量营销素材 | campaign/batch delivery | 没有生产批量交付回执 | 🟡 |
| 竞品分析 | competitor knowledge/reference | 没有周期报告商品和运行回执 | 🟡 |
| 记忆学习 | preferences/knowledge/learning | 没有到期冻结和恢复运行证据 | 🟡 |
| 自动检查 | review/rules/scanner | scanner production gate 未通过 | 🟡 |
| 50g 存储 | storage quota ledger | 已按十进制 50,000,000,000 bytes 固化；对象存储/KMS production gate 未通过 | 🟡 |
| 1 对 1、响应 SLA、月度复盘 | service fulfillment/support SLA | 有服务记录模型，无套餐订单绑定和真实交付 evidence | 🟡 |
| API/内部系统接入 | HTTP/API/MCP surfaces | API 有基础，定制项目报价、里程碑、验收缺失 | 🟡 |

## 4. 人工服务边界

| 方案条目 | 实现/测试 | 真实运行证据 | 状态 |
|---|---|---|---|
| 系统指导、问题排查、品牌配置、生成指导、拒审分析、流程优化 | support、service fulfillment、rules、audit | 可以记录事件，但没有客户可见预约/小时消耗闭环 | 🟡 |
| 不包含无限修改、全套代做、完整营销策略、日常运营、7×24/非工作时段 | 版本化服务边界协议 + 商家侧 `commercial.service-boundary.accept` + 分配前审计查验 | 商家身份、确认凭证、协议校验和、确认时间会写入审计；运营后台不能单独伪造确认；真实宿主证据仍缺 | 🟡 |

## 5. 增值服务

| 方案条目 | 当前覆盖 | 状态 |
|---|---|---|
| 深度品牌知识库 3000–10000/品牌 | 底层知识库能力存在，无增值 SKU/订单/交付 | ❌ |
| 大促素材 5000/项目起 | 有 campaign 工具，无人工项目商品 | ❌ |
| 竞品报告 2000/月起 | 有竞品分析模块，无周期报告商品 | ❌ |
| 人工素材制作 | 未产品化 | ❌ |
| 定制 API/系统开发 10000 起 | 有 API 基础，无报价/里程碑/验收 | ❌ |
| 企业安全服务 | RLS、角色、审计、导出、删除基础存在；独立数据库/私有部署未交付 | 🟡 |

## 6. 创意点和计费门禁

| 规则 | 实现/测试 | 真实运行证据 | 状态 |
|---|---|---|---|
| 标准图片 1 点 | active v2 rate + MCP reserve/settle/release | 本地 Postgres 169、API/worker 健康；真实 relay 成本证据仍是生产门禁 | 🟡 |
| 图片标注编辑 1 点 | active v2 rate + MCP reserve/settle/release | 本地 API/账本闭环；真实 provider receipt 仍需生产证据 | 🟡 |
| 15 秒视频 90 点起 | active v2 rate + MCP reserve/settle/release | 本地 API/账本闭环；真实视频 provider 仍需生产证据 | 🟡 |
| 文本生成 | active v2 rate + MCP reserve/settle/release | 本地 API/worker 健康；真实 relay 成本证据仍是生产门禁 | 🟡 |
| 点包价格与有效期 | point pack catalog + lifecycle repository | catalog/point lifecycle tests；本地真实订单/核验/幂等回放已验证 | v2 点包价格和 30 个自然日有效期已冻结并迁移 | 🟡 |
| 扫描、商品录入、知识库查询、历史记录免费 | operation registry/access service | 生产平台和商业权益未贯通 | 🟡 |
| 点数用完购买点包/升级 | wallet reserve/settle/release + purchase skeleton | 点包可创建订单并由平台人工转账核验后原子授予；升级仍需正式订单与履约证据 | 🟡 |
| 月度点数当月有效 | lifecycle/expiry foundation | 没有月末真实流水证据 | 🟡 |

## 7. 停服、数据、退款和交付

| 方案规则 | 实现/测试 | 真实运行证据 | 状态 |
|---|---|---|---|
| 到期停止生成、扫描、规则更新、学习同步、新任务 | V2 continuous entitlement + worker recheck | 没有完整生产 worker 运行证据 | 🟡 |
| 停止维护和 1 对 1 | 服务分配必须绑定 executable 且当前有效的权益周期；预约时间必须落在权益周期内；周期结束后数据库事务拒绝新履约事件 | 本地 PostgreSQL 回归测试覆盖跨周期预约拒绝；真实生产到期 worker/客户预约证据仍需配置 | 🟡 |
| 续费 7 天宽限 | 未发现完整续费宽限实现 | 现有 7 天是删除宽限，不能替代续费宽限 | ❌ |
| 到期后导出 | data export request/repository | 无到期窗口运行证据 | 🟡 |
| 90 天保留、提前通知、清理 | retention config + deletion approval/execution | 对象存储 production gate 和通知/自动清理 evidence 不足 | 🟡 |
| 超 90 天重新开通收恢复费 | 未发现恢复费 SKU/流程 | 无 | ❌ |
| 部署前退款协商、验收后 5000 不退 | `commercial_refund_events_v2` + refund MCP：申请→不同操作者审批→外部退款凭证→订单 refunded | 每笔申请必须提交 deployment_status / policy_approval；法务政策仍需逐笔留痕 | 🟡 |
| 月费剩余点数退款、点包有效期 | 退款完成时通过创意点生命周期做负向回滚，并写入退款/账本关联证据；点包退款要求 expiry_policy_ref | 本地 API/数据库闭环已实现；真实支付回执和法务补充协议仍需配置 | 🟡 |
| 定制项目分阶段付款 | 未发现完整 milestone billing | 无 | ❌ |
| 故障延长/补点 | 未发现商业补偿规则 | 无 | ❌ |
| 不保证流量、销量、100% 过审 | 可写入协议/文档 | 没有用户确认和版本留痕运行证据 | 🟡 |

## 8. 本次新增的关键门禁测试

新增文件：[tests/commercial-plan-coverage.test.ts](/Users/lixiaomei/Desktop/code/codexSkills/tests/commercial-plan-coverage.test.ts)

锁定三条门禁：

1. 目录中的所有 draft SKU、点包和费率不可执行；仍有 `blockers` 的规则不可执行。
2. 只有明确解析、active、executable、无 blocker 的 entitlement snapshot 才能激活；未批准费率由 `CommercialAccessService` 返回 `RATE_CARD_UNAVAILABLE`，不会进入 charged execution admission。
3. 过期、不可执行或带 unresolved blocker 的连续权益全部返回 `COMMERCIAL_ENTITLEMENT_REQUIRED`，不允许继续使用。

现有 `commercial-execution.ts` 是“已获准 admission 后”的 reserve → provider receipt → settle/release 协议；批准状态由 `CommercialAccessService` 的 rate resolver 和 worker recheck 负责。任何绕过 admission 直接调用 `executeCharged` 的调用方仍是后续审计缺口，不能被本测试误报为已封死。

## 9. 当前真实运行证据和缺口

### 私测首付授予测试任务

私测目录通过迁移 174 进入 approved/executable，但仍只能从邀请、资格和运营权限入口创建。支付成功后，服务端从不可变 SKU 快照派生 7 天周期，在同一事务写入权益快照和 500 点账本：

```bash
npm exec vitest run --no-file-parallelism \
  packages/application/src/private-trial-initial-grant.contract.test.ts
```

当前本地 PostgreSQL 已迁移至 179；仍需使用独立发布数据库完成 PostgreSQL/RLS 验收，并执行真实生产支付、平台 OAuth、桌面 Ops 与 ChatGPT 宿主验收；在这些运行证据完成前不能宣称生产支付闭环已上线。

验证命令：

```bash
npm exec vitest run --no-file-parallelism \
  tests/commercial-plan-coverage.test.ts \
  packages/application/src/commercial-plan-catalog.test.ts \
  packages/application/src/commercial-access-service.test.ts \
  packages/application/src/continuous-feature-entitlement.test.ts

npm run dev:doctor:production
```

本地针对性测试与全量回归已覆盖迁移、私测、API、Ops 工作台、商业注册表和 MCP 契约；本地 PostgreSQL 迁移尾为 179，并验证首付授予回归。独立发布 PostgreSQL/RLS 测试在未提供 `PERSISTENCE_RELEASE_DATABASE_URL` 时保持跳过。
当前本地 readiness 已报告商业目录 `executable=6`、已批准费率为 1，商业持久化和本地容器健康；生产 readiness 仍未通过，并且存在中转 evidence、ChatGPT host/plugin bridge、真实支付、六平台 OAuth、对象存储、扫描器、告警和发布证据等生产缺口。

因此本矩阵的当前结论是：**单人本地测试闭环已可执行（包含创意点不足引导购买、预占、provider 回执结算、失败释放、账本和人工转账开通）；方案尚未形成可对外售卖的真实生产闭环。**

## 缺口清单（按上线阻断排序）

1. 批准并启用 5000 元正式版、三档月费和两个点包；1999 元私测已在本地闭环中启用，但仍受真实支付与生产证据门禁约束。
2. 将六个月点数发放/次月过期规则接入数据库、定时 worker 和流水，并增加第 7 个月停止证据。
3. 落地 1999 元试用抵扣 5000 元的资格窗口、抵扣金额和订单补差价。
4. 打通真实支付/转账审核、订单授予、退款和验收状态。
5. 把品牌/店铺/商品/存储/服务小时数限制落实到所有入口。
6. 完成 ChatGPT 插件登录、租户绑定、权限开通及 host/plugin bridge 运行证据。
7. 接入至少一个真实平台 OAuth 做单人端到端扫描测试，再扩展到六个平台。
8. 确定 `50g` 的 GB/GiB 语义，启用对象存储、KMS 和生产扫描器。
9. 将现有模型中转的真实鉴权、用量、成本、错误和五模态 evidence 接入 release gate。
10. 实现续费宽限、90 天通知/清理、恢复费、定制里程碑计费和故障补偿；退款申请/审批/回滚流水已落地，但仍需法务政策与真实支付回执。
11. 完成 admin/ops 桌面后台生产部署，并验证运营开通、服务履约和账务审计。
