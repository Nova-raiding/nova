# ChatGPT 商家插件：项目深度评审与优化报告

日期：2026-09-07（Asia/Shanghai）。结论：**评审与局部优化完成，生产发布 NO-GO**。本报告不是上线批准；真实宿主成功链、商业准入、外部配置和关键授权契约尚未全部满足。

配套：[完整测试方案](test-strategy-2026-09-07.md)、[失败预演](PreMortem-merchant-marketing-2026-09-07.md)、[桌面黑盒报告](../../../artifacts/audit-2026-09-07/qa/desktop-report.md)、[本轮证据目录](../../../artifacts/audit-2026-09-07/)。

后续进展见[修复与复验记录](remediation-2026-09-07.md)。下文保留首次评审快照和原始测试计数；后续工作区存在并行修改，不将不同时间点的通过结果拼接为同一发布候选通过。

最新续轮：[撤销策略修复与真实复验](jit-revoke-policy-verification-2026-09-07.md)。已确认并修复撤销二次审批冲突，真实 PG 中签发/撤销及审计均成功；桌面刷新后的回执丢失仍阻断完整生命周期。此前[桌面 JIT 与测试隔离](jit-desktop-test-isolation-2026-09-07.md)的原始失败证据保留，生产结论不变。

## 1. 判断摘要

项目已有较深的商家状态机、商业 fail-closed、Outbox、RLS 和发布证据基础，但「代码覆盖广」和「当前商家可完成工作」之间仍有明显断层。最需要投入的不是继续扩充工具数，而是打通已批准范围的一条真实交付链，并确保数据库安全测试实际执行。

本轮确认的最高风险是：API/Repository 接受的 JIT 授权范围 JSON 与 schema 162 内第 152 号迁移要求互斥。合法的当前 API 请求无法入库，两个真实 PostgreSQL 安全测试因此失败。它不是仅修改测试夹具就能解决的问题。

同时，正式文本工作流所需方法被商业 disabled 策略从 bridge 工具发现/调用中阻断；当前商业目录、费率和外部生产配置也未就绪。正确阻断是安全行为，但不能被统计为功能上线成功。

本轮已实施六项边界明确的优化：账务 bigint 安全转换及重放身份字段、草稿导出审核证据边界、Outbox 普通重试、扫描终态重驱兼容、测试统计和原始证据保留、CodeGraph 排除构建产物。没有放开支付/费率/发布/模型门禁，没有迁移或转换既有授权数据。

## 2. 范围、方法与证据等级

围绕用户提供的项目宪法：真实 ChatGPT 插件 → MCP/API → 配置中转 → 商家流程/桌面运营 → 数据、权限与发布门禁。Merchant Studio 仅用于构建/调试检查，不作为正式商家验收入口；不检查手机和平板。

- **pm-skills**：实际读取已安装的 `intended-vs-implemented`、`test-scenarios`、`pre-mortem`；做意图与可达路径对照、成功/拒绝/恢复场景、Tigers/Paper Tigers/Elephants 分析。
- **CodeGraph 1.5.0**：检查原始索引、依赖/受影响测试、重建独立干净索引；对未索引 API 用 TypeScript AST 补偿，不把图当作全量事实。
- **gstack review + qa-only/browse**：结构性审查、真实性和边界检查、桌面黑盒实测与截图复核。
- **资深测试架构视角**：检查执行分母、skip、CI 编排、真实角色/数据库、跨进程与证据门禁；实际运行类型检查、定向回归、数据库、OIDC 桌面、容器健康和基础设施校验。
- **Merchant Marketing MCP**：执行当前安装连接的 `merchant_start`、`workspace_health` 启动与健康诊断；未继续连接店铺、生成内容、审批费率或发布。`merchant.start` 不是由当前 annotations 保证的只读方法，不把它加入自动化只读白名单。

六个边界清晰的 agent 分别负责产品、架构图、桌面、安全持久化、测试架构和扫描重驱；owner 复核改动并统一重跑关键验证。工作区原有大量未提交改动，基线 HEAD 为 `9986fe3`；本报告分析的是当时 dirty 工作区，不是该 commit 的纯净发布。已有改动保留，未自动提交。

当前 metadata 快照：repository `0.1.1`、plugin `0.1.0+codex.20260907102000`、migration `162`、MCP methods `282`、merchant bridge tools `142`、ops domains `14`。这些是声明分母，不是实际成功能力数量。

证据层级详见测试方案：E0 静态、E1 确定性测试、E2 本地真实进程/SQL、E3 外部真实宿主/中转/平台、E4 当前 release 发布证据。本轮集中在 E0–E2，辅以读取已有 E3 历史文件，不声称完成 E3/E4。

## 3. 当前实现地图

| 边界 | 实际入口与职责 | 主要审查点 |
| --- | --- | --- |
| ChatGPT 插件 | `apps/plugin/.mcp.json` → `bridge.sh` → `bridge.mjs`；工具发现及转发 | 商家/ops 分离、工具可达性、配置错误、宿主交付 |
| MCP/API | `apps/api/src/server.ts`；native MCP 与 `/mcp` 最终进入业务路由 | envelope/schema、身份、workspace/workbench、capability、商业准入、资源 scope |
| 商家状态机 | `packages/application/src/service.ts` | 商品事实→方向→方案→生成→审核→批准→导出/发布；快照及版本有效性 |
| 数据与一致性 | `packages/persistence`、PostgreSQL、RLS、CAS、Outbox | 同事务写入、非超级用户、租户隔离、重放与不可变证据 |
| 异步执行 | `apps/worker/src/main.ts`、`packages/workers/src/durable.ts` | claim/lease→授权/商业重检→provider→签名回调；Redis 只是投递提示 |
| 中转与计费 | `packages/ai`、商业目录/费率、usage/settlement | 五模态真实鉴权、请求/用量/成本、unknown 对账、禁止绕开中转 |
| 桌面运营 | `apps/ops-console`，当前 14 个导航域 | 租户/用户/权限/账务/规则/模型/审计，权限与异步状态准确 |
| 发布判定 | release metadata、health/ready/release probes、签名门禁 | 同源版本、迁移、真实宿主/平台/模型、容量/恢复/值守 |

API 两副本使用服务内存状态及约 1 秒刷新窗口，写入依赖持久化 revision/CAS；这需要多副本运行验证，不能从 Map 或事务代码单独推断全局一致性。本轮未做完整副本故障/长稳验收。

### CodeGraph 的有效结论与边界

原索引有 1,915 文件、78,412 节点、427,081 边；其中 `artifacts/` 含 762 文件、62,298 实际节点，占全部节点约 **79.45%**。构建输出污染了依赖排名和影响分析。

已在 `codegraph.json` 增加 `artifacts/` 排除，并创建独立索引，未覆盖原 `.codegraph/codegraph.db`。干净快照包含 1,153 文件、16,114 节点、61,412 边；1,154 文件发现，1 文件跳过，0 解析错误，artifacts 文件为 0。

跳过文件正是 `apps/api/src/server.ts`：1,583,824 字节，超过该版本硬编码 1,048,576 字节限制；现有 CLI/config 没有可用的大小配置开关。AST 补查显示约 18,546 行、114 imports；`routeMcp` 5,899 行，HTTP `route` 2,417 行。bridge 跨进程调用也不会完整形成静态调用边。

因此，server/bridge 的 affected=0 是盲区，不是无影响；五个核心入口合并得到的 214 个候选测试也受到同名符号匹配影响，不能视为准确覆盖清单。该图采集约 16:31，早于本轮最后修复；它是架构快照，不是最终代码覆盖报告。

证据：[干净索引与限制](../../../artifacts/audit-2026-09-07/codegraph/clean-build.json)、[AST 热点](../../../artifacts/audit-2026-09-07/codegraph/source-hotspots.json)。建议按边界渐进拆出 MCP admission 与 ops 域 handler，每一步保留契约/负例测试；本轮不做高风险大文件重写。

## 4. 发现与处理

### A-01 / P0 / 历史快照：授权范围契约互斥（已通过前向迁移修复）

| 层 | 当前要求 |
| --- | --- |
| API `server.ts:11417` | `workspace_ids` 恰好一个且等于目标 workspace，不允许其他 `*_ids` |
| Repository `authorization-repository.ts:190–203` | 恰好一类 `*_ids` 数组；非 `*_ids` 字段只能是字符串 |
| 数据库 migration 152:10–13 | `type="workspace"` 且 `ids=[workspace_id]` |

`workspace_ids` 形式被数据库拒绝；`type+ids` 形式在 repository 连接前被拒绝；混合两套字段也不合法。真实 PG16 全迁移到当前 schema 后，授权 release 与授权 RLS probe 均报 `ops access grant scope is invalid`。输入 stub 复核也证明 canonical 形式在连接前报 `AUTHORIZATION_GRANT_INVALID`。

影响：当前 JIT/支持授权签发无法正常贯通；相关后续隔离/重放断言尚未走到，不能报告通过。没有据此认定存在越权漏洞。

建议：产品/安全 owner 确认一个唯一范围契约。优先评估新前向迁移 163 对齐现有 `workspace_ids`，继续严格绑定单个工作区、拒绝混合/跨工作区；若选择 canonical，则必须同步 API、验证、执行预留、权限投影、Worker 和前端。两种方案都先审计旧 grant，不能改 JSON 后继续使用旧 scope hash/授权快照。本轮不改旧迁移或授权数据。

准出：fresh/upgrade、错误范围、撤权后新事件拒绝、已有结果重放、并发预算、真实 app/ops RLS 全部零 skip。现有测试时钟还需按签发→消费→预留→撤权递增，不能让预留时间在真实撤权之后却声称在其之前。

### A-02 / P0 / 当前产品阻断：正式工作流声明与工具可达性不一致

Skill 要求 `task.understand → creative.directions → content.generate → content.review`，而 `apps/plugin/mcp/bridge.mjs:89–108` 的商业 disabled 集合在 tools/list 过滤并在调用处拒绝这些方法（约 2648/2660）；`packages/contracts/src/commercial-operation-registry.ts` 的当前可计点执行集合为空。现有 merchant conversation 测试甚至明确断言 blocked 且远端调用数为 0。

图片入口虽存在 bridge 例外，可见不等于能执行：共享 registry 与非 fixture API 仍有准入阻断。不要把 fixture service/Studio 成功、工具注册或负例通过当作真实商家成功链。

建议先明确获批的最小商业能力/费率和验收范围，再由授权 owner 配置；不能为测试开绿灯。恢复后必须从真实 ChatGPT 工具发现开始跑完整交付场景 TASK-01，不直接调用 service 代替。

#### A-02 解锁条件定位（本轮续查）

| 阻断 | 当前来源 | 需要的批准/配置 | 放行验证 |
| --- | --- | --- | --- |
| `STORAGE_UNIT_UNRESOLVED` | 迁移 146 与 `commercial-plan-catalog.ts` 只保存 `50g`，`normalizedBytes=null` | 产品/财务确认 g 的实际字节单位，并生成新的不可变目录版本与 checksum | `validateResolvedPlanEntitlements` 通过；目录版本 `approved + executable + effective_at` |
| `ORDER_TERMS_REQUIRED` | custom 套餐只有 `starts_at`，缺少订单条款和履约边界 | 商业/法务补齐最低价、报价有效期、退款/履约条款 | V2 SKU snapshot 可解析且购买服务只接受该服务端快照 |
| `ONBOARDING_GRANT_SCHEDULE_UNRESOLVED` | onboarding grant 的开始时间与到期规则为空 | 商业 owner 确认授予起算、月度发放、过期及取消规则 | entitlement snapshot `unresolved_blockers=[]` 且履约 source chain 可审计 |
| `CREATIVE_POINT_PACK_EXPIRY_UNRESOLVED` | 500/2000 点包 `expiryRule=null` | 商业/财务确认有效期、退款与过期处理 | 点包 SKU 与 rate card 同时 approved，重复下单/结算回归通过 |
| `BUSINESS_APPROVAL_REQUIRED` / 未解析模型费率 | 费率卡 pending，视频/文本还缺公式 | 财务批准每模态点数、计费模式、上限和生效时间 | `ops.commercial.readiness.report` 中四模态 rate 均 executable，且 relay/request/usage/cost 证据齐全 |

这些字段必须通过新的版本化快照和审计事件落库；不能直接 UPDATE migration 146 的 seed 行，也不能把 `MCP_POINT_CHARGED_ENABLED_METHODS` 临时加回去作为验收捷径。

### A-03 / P0 / 当前环境阻断：生产证据不完整

本地 13 个服务健康、API health/ready 正常，不等于 release ready。`releasez` HTTP 200 但 `ready=false`：支付仍是 fixture、平台 OAuth 0/6、五模态 readiness 不完整、存储/扫描/告警生产条件未满足，production gate/write gates 关闭；商业可执行目录和批准费率数量为 0。

当前安装 MCP 的两次诊断成功：开始进入 `connect_store`，健康查询可用店铺数为 0；响应没有本次正式宿主 release/request/trace 全链证据。这只证明当前会话能访问工具连接，不构成 ChatGPT.app 上线验收。

历史 `artifacts/model-relay-live-20260906/relay/relay-live-20260906/` 中 text/image/image_edit/ocr 报告记录 HTTP 200、usage/cost 与 relay pricing snapshot；video 为 HTTP 503、blocked、无 usage/cost。尊重历史证据，不把它改写成当前版本“五模态全通过”。本轮未产生新的付费中转调用。

`npm run codex:relay:validate` 在当前宿主配置检查失败，报告缺少指定 `model_providers.openai`、base_url、responses wire_api、env_key。可能涉及 validator 对当前 provider 配置形式的兼容性；不能据此直接宣称已工作的 MCP/宿主整体不可用。需对齐部署约定后独立验证，不暴露或改写用户凭据。

### A-04 / P1 / 已修复：账务 bigint 返回类型破坏幂等与回调

pg 将 bigint 返回为字符串，原账务 row 类型声明为 number；严格等值比较会把同额重放/回调判成冲突，返回金额也可能与接口类型不符。单元 stub 原先使用数字掩盖了问题。

修复 `billing-repository.ts`：在仓储边界统一十进制、安全整数、正金额校验；覆盖订单、流水、余额、回调、结算/退款与事件金额；补齐结算/退款重放查询 `actor_id`，保持返回原结果的完整性。越界不得静默舍入。

验证：新增 17 个 red→green 单元场景；定向 38 tests 通过；真实 PG app role 完成创建/重放、到账/重放、扣款/重放、结算/重放，余额 850、1 张订单、3 条流水、数值类型正确，另一租户和事务后无 scope 不可见。未访问真实支付接口。

遗留：debit 幂等查询在 workspace lock 之前且锁后未重查；并发相同 key 可能返回余额不足或唯一约束错误，而不是等价重放。退款有类似竞态。唯一索引有防重复写的作用，不能直接宣称双扣；需要 BILL-02 屏障并发测试再做独立修复。

### A-05 / P1 / 已修复：普通 retryable 任务被 SQL 永久排除

`Outbox.claimPending` 原先只允许 `last_error IS NULL`，但 dispatcher 普通失败会保留 last_error、设置退避并 ACK 投递提示；重启恢复无法重新 claim。

修复 `repository.ts:342`：允许明确布尔 `retryable:true` 且 unknown 为 false/缺省的错误记录，继续排除 terminal、unknown、非法错误值、未到期、有效 lease 和错误租户/路由。没有自动重放结果未知任务。

验证 `tests/outbox-retry.postgres.test.ts` 的 3 个真实 SQL + dispatcher 场景：退避前后、fresh dispatcher 恢复成功、各种拒绝态、并发领取和路由边界。测试使用 admin 建模执行 SQL，不作为 app-role RLS 证明；RLS 由独立 probe 验证。

### A-06 / P1 / 已修复：扫描失败终态无法进入受控重驱

deadLetter 当前写 `last_error.terminal=true`，但扫描失败列表和 redrive 仍要求 `published_at` 非空。真实 migration-109 acceptance 原先在“应列出 1 条”处返回 0。

修复扫描仓储兼容当前 terminal 布尔标记及历史 published 终态，保留 unknown、lease、失败码、次数、revision、租户、授权与商业快照守卫。重驱创建新事件，不改旧记录。

验证：10 种拒绝态单测；PG 同时测试两种终态格式、并发幂等、新 event ID、旧 outbox 全行不变、worker 只领取新事件，2 场景通过。没有重驱现有业务任务。

遗留：migration 109 的全字段终态不可变触发器主要覆盖 published 形式，terminal 标记的调度字段尚缺同等数据库约束，应另做前向迁移安全加固。本轮 redrive 保证旧行不变，不声称数据库所有入口都已强制此不变量；该入口也不能宣称有额外双人审批。

### A-07 / P1 / 已修复：自动审核草稿导出误标批准冻结

草稿同样有自动 `reviewSnapshot`，导出此前只判断 snapshot 存在就给出 `frozenAtApproval=true`。现限定 approved/delivered 才能输出批准冻结证据；未批准版本明确 available/frozen=false，不删除自动审核信息。

新增草稿生成→导出的负例，强化批准版本及后续规则变更后的 ZIP 字节稳定性；定向 application 138 tests 通过。其他原有 service 工作区改动保留。

### A-08 / P1 / 部分修复：测试执行与门禁容易形成错误信心

已修复 `tests/test-summary.ts`，按 assertion 实际状态区分 executed/failed/skipped/pending/todo；全 skip 文件不因 Vitest status=passed 被计作执行通过。空报告、损坏、计数矛盾、零执行都失败；保留原始 JSON、stdout/stderr、退出码、signal 和唯一 run 目录。21 个定向回归通过。

仍需处理的静态缺口：

- 约 62 个环境条件数据库测试文件，25 个不在当前 CI DB 白名单（其中 24 个会真实 skip，另一个使用默认连接）；关键 authorization/RLS/worker settlement 不应被跳过。
- 根 `npm test/check` 中 6 个测试隐式连接本机 54329；CI PG 服务为 5432，且 check 在 DB release job 外执行。这不是一个完全离线的“纯单元”入口。
- 当前 browser:all 白名单遗漏 canonical product、image generation、dirty guard、RBAC matrix、workspace roles 等 5 个 spec；当前 CI 没有完整桌面/容器故障/长稳 job。
- ChatGPT host evidence gate 主要拒绝空值/fixture/local，仍允许非目标宿主字符串；schema 检查不是实际 ChatGPT 运行证明。
- capacity gate 的 raw_metrics_ref 不校验引用字节/实际采样窗口；backup restore 脚本主要核验迁移与表存在，未充分验证业务数据、余额、事件和 RLS。

建议优先增加明确隔离 DB runner、目标文件分母和零 skip 门禁，再扩大测试数量。宿主/容量/恢复证据需要独立实现与负例，不改写历史证据来通过。

### A-09 / P2 / 未修复：桌面筛选未命中被渲染成全页错误

任务 ID 输入不存在值触发 `ops.marketing.queue` 404，UI 出现两处全页数据错误并保留旧 50 条结果；重试复现，清除恢复。有 stale 提示，未发现静默伪成功。建议对“未命中/无权限/读取失败”分别给就地空结果、权限阻断、可重试错误，不降低 API scope 守卫。详见 DESKTOP-001 截图。

工作台随导航自动改变符合当前固定 domain→workbench 映射，列为产品 UX 观察，不认定越权。一次财务页 502 后权限 fail-closed、重试恢复；原因未定位，不编造根因。

### A-10 / P2 / 未修复：规范、指标与运维说明漂移

历史“最终 PRD”不含图片/视频/RBAC、建议 3–4 个问题，当前 Skill 则覆盖这些能力且强调单问题；README 方法数/迁移数亦混杂历史值。`merchant.start` 在 Skill 被称只读，但现有 authz/bridge annotations 并非 readOnlyHint=true，不能自行扩大只读自动化白名单。

增长事件计数不等于去重用户漏斗和真实首次价值时间；未完成产品口径及真实埋点观察前，不建议据此判断激活率。发布信任目录文档与实际固定 `/run` 信任根/指纹材料要求也需要对齐。

建议先建立规范优先级和版本索引、从 metadata 生成事实表；不批量重写旧 PRD 或自动将历史失败改为通过。

### A-11 / P1 / 历史快照：bridge 素材投影变更尚未完成契约验收（当前已通过）

16:52 全套运行时 source/mirror 整文件比较失败，两份文件在该轮中途的 16:56 又被写入；随后 hash 相同，单独 parity/schema 测试通过。不能将该独立通过改写成原全套通过。具体写入者和顺序未观察到，不归因本轮 agent。

16:59 全套重跑及 17:02 定向重现又发现两份 bridge 的素材安全投影测试稳定失败，这次不是时序问题。`bridge.mjs:2448–2449` 改为优先取完整 asset，而测试仍使用旧 action 投影；约 2472 行还增加候选指导字段：

| 字段 | 测试原契约 | 当前响应 |
| --- | --- | --- |
| asset_actions[0].scan_status | quarantined | blocked |
| readiness_status | blocked | 缺失 |
| mime_type | 缺失 | image/png |
| candidate_generation_guidance | 缺失 | 新增 |

重新上传指导和 user_action_required 仍保留。当前只能确认接口/测试契约不一致，不能仅放宽断言或认定新增字段泄漏隐私；先确认 readiness 语义和允许字段，再同步精确投影及隐私负例。本轮没有修改这两份正在变动的 bridge 或测试。

证据：[独立失败 JSON](../../../artifacts/audit-2026-09-07/runtime/bridge-asset-projection-recheck.json)、[诊断](../../../artifacts/audit-2026-09-07/runtime/bridge-asset-projection-diagnosis.log)。目标运行实际执行 2 项且均失败，另外 178 项按 `-t` 排除，不能将其当作完整 suite。

## 5. 本轮执行结果

### 5.1 续轮状态更新（2026-09-07）

以下结果优先于本报告前文的历史快照；历史失败日志仍保留，不被覆盖：

| 项目 | 当前结果 | 证据边界 |
| --- | --- | --- |
| A-01 授权范围契约 | 前向迁移 163、API、repository、worker 边界与桌面表单已统一为单元素 `workspace_ids`；隔离 PG17、签名 HTTP、真实 OIDC 桌面 2 个视口均通过 | 不代表共享业务库已迁移；预发布/生产存量授权仍需 operator 审计 |
| A-11 bridge 素材投影 | 源码与 marketplace 镜像 hash 相同；两份 bridge 测试合计 262/262 通过，覆盖 blocked/quarantined/rights/readiness/隐私字段负例 | 仅证明当前源码/镜像契约；不等同于 ChatGPT 正式宿主 E3 成功 |
| 撤销后桌面回执 | 1440×900、1280×800 隔离 OIDC+PG+Redis 验收 2/2 通过 | 不替代宿主、中转五模态、容量/恢复 E3/E4 |
| 授权仓储错误映射 | `NOT_FOUND`→404、revision/conflict→409、invalid→400；API 定向回归 138/138 通过 | 不改变授权 evaluator、仓储事务或数据写入，仅提供客户端可恢复错误契约 |
| 交付治理 gate 契约 | 新增必填 gate fixture 已同步；交付治理/API 定向回归 105/105 通过，类型检查通过 | gate 仍以未验证/阻断为默认，不将空证据显示为成功 |


| 检查 | 结果 | 证据边界 |
| --- | --- | --- |
| 初次 `npm run check` | 643 files：600 pass / 1 fail / 42 skipped；4,189 tests：4,108 pass / 17 fail / 64 skipped | 与账务 TDD 红阶段重叠；唯一失败为新增账务断言；原日志保留，不作为最终结果 |
| 16:52 `npm run check` | 647 files：602 pass / 1 fail / 44 skipped；4,236 tests：4,166 pass / 1 fail / 69 skipped | A-11 中途 mirror 不一致；退出 1，后续链式步骤未执行 |
| 16:59 `npm run check` 重跑 | **647 files：601 pass / 2 fail / 44 skipped；4,236 tests：4,165 pass / 2 fail / 69 skipped；退出 1** | 根/两 UI 类型检查通过；两个失败是 A-11 的 source/mirror 素材投影；链式后续未执行，不以改断言掩盖 |
| Ops tests 独立补跑 | **87 files / 495 tests 全通过** | 因 check 链式中断独立执行，不写成 check 全绿 |
| Ops / Merchant Studio build | 两项通过 | Studio 有 >500 kB chunk 警告；仅调试台构建，不纳入商家正式入口 |
| PostgreSQL 最终集成 | **7 files：5 pass / 2 fail；10 tests：8 pass / 2 fail / 0 skipped** | 独立 PG16，全迁移；两失败均 A-01；本次没有跳过安全失败 |
| 桌面 OIDC 定向 E2E | **3 tests 通过** | 本地签名测试网关；遍历导航域、503 不报成功、用户目录及取消确认；复用来源容器 DB/Redis，非数据隔离/正式 IdP/真实宿主，含数据导出 |
| gstack 桌面黑盒 | 8 页面、2 桌面视口、13 张截图；1 confirmed medium | 部分只读功能，无全系统评分；未执行付费/发布/用户变更 |
| 本地 doctor | 初次与最终均 **37 pass / 16 warn / 0 fail** | 13 服务健康；warn/blocked 与 release ready 分开 |
| release metadata / infra validate | 通过 | YAML、fixture evidence schema 和 metadata 静态一致，不代表云发布 |
| 当前 MCP 开始/健康 | 两次成功，连接店铺数 0 | 当前工具连接；不证明真实宿主安装、附件、付款或发布 |
| 当前 MCP 商业准入/目录/余额 | `commercial.access.get` 只读诊断允许；目录 6 个 SKU 全为 `draft` 且 `executable=false`；创意点余额 10,000、状态 known | 余额不等于生成准入；目录阻断项包含 `STORAGE_UNIT_UNRESOLVED`、`ORDER_TERMS_REQUIRED`、`ONBOARDING_GRANT_SCHEDULE_UNRESOLVED`、`CREATIVE_POINT_PACK_EXPIRY_UNRESOLVED`、`BUSINESS_APPROVAL_REQUIRED`；未调用生成、扣点或发布 |
| `npm run dev:doctor` 交叉验证 | **37 pass / 16 warn / 0 fail**；目录版本 7、可执行目录 0、已批准可执行费率 0；支付 fixture、六平台 OAuth 缺失、对象存储/扫描器/告警未达生产 ready | 与 MCP 结果一致；doctor 的 PASS 只代表本地依赖/容器健康，不提升生产发布结论 |
| Bridge 实际 `tools/list`/拒绝路径 | 标准发现、运营工具隔离、收费方法隐藏、禁用生成不转发、生产 relay 证据门禁 4/4 通过 | 证明当前 bridge 正确失败关闭；不是正式 ChatGPT 宿主安装或真实收费成功证据 |
| ChatGPT/Codex 宿主证据 gate | 收紧 `host` 标识，只接受 `codex-app-*`/`chatgpt-*` 形式；新增 Chrome/Electron/iOS/任意外部主机负例，17/17 通过；类型检查通过 | 不能凭任意非本地主机字符串冒充目标宿主；仍需真实宿主生成 15 项 E3 场景证据 |
| `npm run test:release-gates` | **113 files / 542 tests 通过；6 files / 13 tests 按未配置真实 PG 环境跳过** | 发布门禁代码完整通过；跳过项仍不能作为真实 RLS/生产证据，A-02/A-03 结论不变 |
| 2026-09-08 `npm run check` | **根测试 598 files / 4503 passed / 70 skipped；Ops Console 88 files / 501 tests；metadata 与双前端构建通过** | 完整本地门禁通过；PG skip、商业目录、生产 relay、支付/平台/存储/告警与真实 ChatGPT E3 仍是外部上线准出项 |
| 宿主 relay validator | 失败（配置形状/缺项） | A-03；未修改配置、未调用新的付费模型 |

2026-09-08 续查：`npm run codex:relay:validate` 仍以退出码 1 失败；进一步确认当前配置声明 `model_provider=openai`，但仅存在 `model_providers.damai_relay`，validator 现已明确报告该 provider/section 不一致，并不会擅自选择替代 provider。当前 shell 未完成宿主 relay 合同，因此仍缺少有效 `base_url`/`wire_api="responses"`/`env_key` 证据。本轮没有运行 `test:model-relay-canary`，因为媒体 canary 可能产生真实费用，且当前没有新的付费调用授权；保留现有历史中转证据，不把它升级为当前 release 证据。配置诊断定向测试 17/17、类型检查通过。

最终数据库原始报告：[postgres-1788771142349.json](../../../artifacts/audit-2026-09-07/runtime/postgres-1788771142349.json)；[16:52 check 日志](../../../artifacts/audit-2026-09-07/runtime/check-final.log)、[16:59 重跑日志](../../../artifacts/audit-2026-09-07/runtime/check-stable.log)；[Ops tests](../../../artifacts/audit-2026-09-07/runtime/ops-tests-final.log)；[OIDC 日志](../../../artifacts/audit-2026-09-07/runtime/ops-oidc.log)。原始失败与后续通过分别保存，不覆盖最初证据。日志和数据库序列化信息应按内部测试材料处理，外发前脱敏。

没有执行真实支付、平台写入、费率批准、付费五模态 canary、生产 deploy、容量长稳或共享环境故障演练。未执行项目的“生产发布总门禁”，因为必要外部条件已明确缺失，不应为了生成报告创建伪生产证据。

隔离 PG 验收用显式带本轮 label 的 `merchant-audit-pg-20260907` 容器，不访问共享业务数据库；UUID 测试库完成后删除，容器已按其精确名称停止并 auto-remove。只移除了本次可重建夹具数据，没有移除原有业务数据或容器；失败日志均保留。OIDC 桌面检查另有共享依赖边界，不能与该数据库隔离证据混为一谈。

### 最终来源稳定性

[run-manifest.json](../../../artifacts/audit-2026-09-07/run-manifest.json) 保存了最终重跑前后 HEAD、1,343 个文件的合并摘要、关键文件 SHA、命令结果与环境边界。关键 bridge/API 及本轮 service/persistence/test-summary 改动前后摘要相同；但整个文件集摘要不同，**不能签为冻结发布候选**。

只读核对发现 `packages/ai/src/image-generator.ts` 与其测试在 17:04:50 又被修改，晚于本轮最终 Vitest 约 17:04:18 结束、早于 17:05:58 摘要采集。没有把这些后续变更归因给本轮 agent，也没有覆盖它们；本报告不声称最后一刻新增源码已被此前全套验证。下一轮完整验收应先协调冻结工作区，再捕获前后内容摘要。文件名 `check-stable.log` 仅表示重跑尝试，不是稳定性认证。

## 6. 优化顺序与准出

| 顺序 | 责任角色 | 最小交付 | 完成条件 |
| --- | --- | --- | --- |
| 已完成 | API/数据库 + 安全 owner | 统一 A-01 授权范围契约，前向迁移 163，桌面表单同步 | 隔离 fresh/upgrade/撤权/重放/RLS 与真实桌面专项通过；预发布存量审计仍待执行 |
| 已完成 | 插件 owner + 测试 | 明确 A-11 素材安全投影允许字段和 readiness 语义，保持 source/mirror 同步 | source/mirror hash 一致；262/262 bridge 契约与隐私负例通过 |
| 立即 | 产品 + 商业/财务 + 平台 | 明确获批最小商业工作流、费率、真实 ChatGPT 宿主和中转配置 | A-02/A-03 的当前 release E3 证据完整，且无 disabled/fixture 假通过 |
| 下一 PR | 测试架构 + CI owner | DB 隔离与零 skip、桌面分母、明确宿主 schema | 缺配置/漏文件/全 skip/非目标宿主均失败 |
| 预发布前 | 产品 + 商业/财务 + 平台 | 定义获批最小工作流，配置目录/费率与外部依赖 | ChatGPT→中转→审核→交付有当前版本真实证据 |
| 同阶段 | 后端 + 测试 | BILL-02 并发、终态数据库不可变、跨副本恢复 | 无重复扣款/丢事件，安全拒绝与幂等返回正确 |
| 后续小 PR | 桌面/架构 owner | 筛选错误反馈、规范索引、按域拆分 server | 桌面回归与契约不变；CodeGraph 关键入口可检查 |
| 发布前 | SRE + 安全 + 测试 owner | 五模态/平台/存储扫描、容量/恢复/告警、签名证据 | 同一 release E3/E4 无 blocked/missing/expired/fixture |

详细场景、环境、数据、容量预算、故障注入、证据字段及 go/no-go 见[测试方案](test-strategy-2026-09-07.md)。不能用全局通过率平均掉 P0 失败；任一关键能力 blocked 仍为 NO-GO。

2026-09-08 续查：补强 `/readyz` 商业生产门禁。新增持久化只读检查，要求至少存在已批准且生效的可执行商业目录、已批准可执行费率，并且至少一个收费 MCP 操作由商业注册表显式启用；否则以 `PRODUCTION_READINESS_BLOCKED` 返回结构化 `commercial` 原因。新增 production-readiness 回归全部通过，根类型检查通过。当前真实环境仍返回阻断：目录 executable=0、approved rate=0、收费 MCP 方法未启用；因此该改动将原先可能出现的基础设施“假绿”收紧为明确 NO-GO。

同轮完整 `npm run check` 暴露 3 个现有 API 回归（596 个文件通过、3 个失败、44 个真实 PG 用例跳过）：平台媒体规格读者的 draft 隔离错误码缺失；platform_ops 平台告警聚合被错误拒绝；跨租户平台用户目录未返回目标工作区成员计数。两个文件单独串行重跑仍稳定失败，不能归因于随机并发，也不能把本轮 `/readyz` 改动标记为全绿；这些是下一次上线阻断修复项。

随后修复平台角色边界：补回 `platform_ops` 的平台运营识别，并明确 `rules_admin` 只能读取 active 证据、不能读取 draft/expired 规格。类型检查、diff 检查及三组回归合计 **92/92** 通过。完整 `npm run check` 的原始 3 失败记录仍保留；修复后尚未再次消耗完整 4 分钟级全套检查，因此不能把整套门禁写成已重跑全绿。

随后已完成修复后的完整重跑：`npm run check` **598 files / 4504 tests 通过，44 files / 70 tests 跳过**；Ops Console **88 files / 501 tests 通过**；release metadata、Ops Console build、Merchant Studio build 全部通过。`npm run test:release-gates` **113 files / 542 tests 通过，6 files / 13 tests 因未配置真实 PG 跳过**。`npm run dev:doctor` 当前 **37 pass / 16 warn / 0 fail**，但仍明确报告支付 fixture、六平台 OAuth、对象存储、扫描器、告警、可执行商业目录/费率和宿主/ChatGPT 证据缺失；`npm run codex:relay:validate` 仍失败，原因是宿主 provider section 与 `model_provider` 不一致。

随后运行项目隔离 PostgreSQL 入口 `npm run test:postgres:isolated`：独立 run-id 容器内 **8 files / 8 tests 通过**，报告见 `artifacts/isolated-postgres/run-gNpFAf/vitest.json`。该证据证明隔离迁移、RLS、商业履约与回填专项可运行，但不等同于已覆盖完整 44 个跳过的共享发布测试。

桌面 Ops JIT 再验收：`npm run test:browser:ops:jit` 在隔离 OIDC+PostgreSQL+Redis 环境、1440×900 与 1280×800 两个桌面视口 **2/2 通过**；证据目录为 `artifacts/ops-jit-isolation/2026-09-07T23-36-02.240Z-8dc8bd06-35ca-47e0-b023-c8f087e066bf`。

发布脚本只读复核：`npm run audit:ops-surface` 发现 109 个 Ops 合同方法中 107 个有直接前端引用，`ops.data.delete.approve/cancel` 属于由 `ops.data.delete.list` 驱动的间接能力；`npm run release:metadata:validate` 通过；`npm run infra:launch-preflight` 因未提供 `PRODUCTION_CONFIG_PATH` 退出 2，未伪造生产配置继续执行。

随后修正 Ops surface 审计器对模板化决策路由的识别：检测 `ops.data.delete.${decision}` 时将该注册族视为已覆盖。复核结果变为 **109/109 前端引用、unreferenced=0**；仍保留 indirect candidates 供人工审计，不隐藏动态路由。

2026-09-09 续查：补强 `/readyz` 运行时门禁，生产环境现在同时要求 `setupDiagnostics().productionGate=true`，把六平台 OAuth、生产能力/容量证据、告警、对象存储、五模态模型配置等运行时事实纳入阻断响应 `runtime_setup`；避免仅凭环境变量门禁产生假 ready。类型检查和 production-readiness **22/22** 通过。

运行时门禁修改后的根回归再次完成：`npm test` **598 files / 4504 tests 通过，44 files / 70 tests 跳过**；所有跳过项仍为需要真实 PostgreSQL 发布环境的专项，不被折算为通过。

发布质量门禁再收紧：`audit:ops-surface` 现在在 `unreferenced_count>0` 时返回非零退出码，并已纳入根 `npm run check` 链路；当前 109/109 覆盖，质量入口测试 6/6 通过。

CI 复核确认 `.github/workflows/ci.yml` 已执行 `npm run check`、`npm run test:release-gates`、隔离 PostgreSQL acceptance、无 skip 的迁移/授权专项、负载测试、构建、依赖审计和 infra validate；本轮未发现 CI 绕过新 Ops surface 门禁的路径。

进一步做 PostgreSQL 分母审计发现原 workflow 只显式列出 27/55 个仓库 PostgreSQL 测试文件；已补齐其余 28 个（含 worker settlement、RLS、账务、outbox、履约与 workspace export），并新增 `tests/postgres-ci-denominator.test.ts` 强制比较仓库文件集合与 CI 文件集合。当前 **55/55**，该测试和类型检查通过。

补齐后的 CI workflow 已通过 Ruby YAML 解析；PostgreSQL 分母、质量入口、release metadata 三项回归 **10/10**，Ops surface **109/109**，diff 检查通过。

2026-09-09 续查：补齐全量隔离 PostgreSQL 入口后，`npm run test:postgres:isolated -- --all` 已覆盖 **55 个 PostgreSQL 文件**；迁移 130 夹具、平台审计 ACL、outbox 109 重投、对象孤儿 ACL/时钟边界已修复。最近一次全量结果为 **55 files：51 pass / 1 fail（对象孤儿显式时间夹具已调整）/ 3 个迁移 schema-dump 失败**；3 个失败均为本机 PostgreSQL 16 `pg_dump` 对 PostgreSQL 17 服务端的工具版本不匹配，CI 已安装 PostgreSQL 17 client，不能在本机把该环境差异伪装成通过。outbox 109 两个 terminal/legacy 场景均通过；迁移 130、平台审计、商业/授权/RLS/worker 专项均通过。

本轮新增的数据库时钟修复：outbox 与 object-orphan claim 在未传显式探针时间时使用数据库 `now()`，避免应用/数据库毫秒偏差造成刚插入任务漏领；显式时间仍用于确定性测试。迁移 043 为新建 `object_storage_orphans` 增加 `merchant_app` 最小 ACL；迁移 130 PostgreSQL 夹具补齐真实品牌外键；平台审计测试接受 ACL 先于 append-only trigger 的 fail-closed 结果。定向持久化/迁移/分母回归 **12/12**，类型检查通过，`git diff --check` 通过。

当前上线结论仍为 **NO-GO**：真实商业目录/费率、支付、六平台 OAuth、对象存储/扫描/告警、模型 relay 合同、ChatGPT/Codex E3 宿主证据和生产配置仍缺失；不能以本地隔离 PG 或 CI 工具安装替代这些外部准出项。

最终复跑后对象孤儿验收已通过（3/3），outbox 109 两个场景也通过；全量隔离入口实际选择 **55 个文件**。剩余 3 个失败仅为本机 `pg_dump 16.15` 对 PostgreSQL 17.11 服务端的版本拒绝，CI 已切换到 PostgreSQL 17 client。该本机工具差异仍不能被计入生产通过证据。

2026-09-09 最终复核：`npm run test:release-gates` **113 files / 542 tests passed，6 files / 13 tests skipped**（真实 PG 环境未注入）；`audit:ops-surface` **109/109，unreferenced=0**；`dev:doctor` **37 pass / 16 warn / 0 fail**。`npm run codex:relay:validate` 仍明确失败：缺少 `model_providers.openai`、有效 `base_url`、`wire_api=responses` 与 `env_key`。商业状态仍为 payment fixture、六平台 OAuth 缺失、object storage/scanner/alerts 未 ready、executable catalog=0、approved rate=0、productionGate=false。未运行付费模型 canary、真实支付或生产部署。

随后将 migration 067/068/069 的 schema dump 改为读取 `PG_DUMP_BIN`，CI migration job 显式绑定 `/usr/lib/postgresql/17/bin/pg_dump`，并新增 workflow 静态测试防止客户端版本回退。分母/客户端门禁定向回归 **5/5**、类型检查、YAML 解析与 diff 检查通过。

2026-09-09 再验：release metadata gate 通过；`release:manifest` 在显式 release id 下可生成绑定当前源码 SHA/MCP registry/bridge hash 的 manifest。未提供生产 evidence 时，`release-manifest-gate` 仍返回非零并要求完整 artifact root、evidence files 与 trust anchor，证明本地 manifest 不能被误当成生产发布证据。`infra:launch-preflight` 在缺失 `PRODUCTION_CONFIG_PATH` 时退出 2，保持阻断。

同轮新增运行态证据：`npm run test:browser:ops:jit` 在隔离 OIDC + API + PostgreSQL + Redis 环境、1440×900/1280×800 桌面视口 **2/2 通过**，证据目录 `artifacts/ops-jit-isolation/2026-09-08T00-34-28.494Z-57bbb671-e627-47e0-bba3-fe8e3eea89b9`；`npm run test:browser:merchant` 商家 Studio/插件工作流 **22/22 通过**，`test-results/.last-run.json` 状态为 passed。两者均为本地/隔离运行态证据，不替代真实 ChatGPT.app 宿主与生产外部连接证据。

直接运行态探针复核：`/healthz` 与 `/readyz` 返回 HTTP 200，但响应明确标记 `mode=fixture`、`writesEnabled=false`、`productionGate=false`、`payment.mode=fixture`、`objectStorage.mode=local`、六平台 `oauthConfigured=false`，并列出生产下一步；未认证 `/mcp tools/list` 返回 **401 UNAUTHENTICATED**。这证明本地健康状态未被当作生产可写或未授权 MCP 成功。

gstack health 质量仪表盘：类型检查 **10/10**；测试命令退出 0，**599 files / 4506 tests passed，44 files / 70 tests skipped**，按 skill 规则测试项 **10/10**；lint、knip/dead-code、shellcheck、gbrain 在当前环境未安装，按规则标记 skipped 并重分配权重，综合分 **10.0/10（仅代表可用工具维度）**。健康历史写入 `~/.gstack/projects/codexSkills/health-history.jsonl`；跳过项与真实 PG/外部生产证据缺口不能被该分数掩盖。

补充执行说明：测试方案已明确迁移 schema dump 的客户端版本门禁。PostgreSQL 17 服务端必须配套 PG17 `pg_dump`；CI 通过 `PG_DUMP_BIN=/usr/lib/postgresql/17/bin/pg_dump` 显式绑定，本机仅有 PG16 客户端时必须记录为工具版本阻断，不得忽略 schema-dump 错误或把用例标记 skipped 后宣称通过。对应 `tests/postgres-ci-denominator.test.ts` 回归 **2/2**，文档、类型检查与 `git diff --check` 均通过。

最终构建复核：`npm run typecheck`、`npm run release:metadata:validate`、`npm run audit:ops-surface`（109/109）、`npm run build:ops-console`、`npm run build:merchant-studio` 均通过。Merchant Studio 构建仍有 Vite 的单 chunk 体积提示（约 831 kB），属于性能优化项而非功能或发布门禁通过依据；后续应在不改变宿主契约的前提下做路由级 code-splitting，并纳入 bundle budget。

门禁覆盖补强：将 PostgreSQL 17 schema-dump 客户端版本断言加入已在 release suite 执行的 `tests/quality-entrypoints.test.ts`，不再只依赖单独手工运行的分母测试。与 `tests/postgres-ci-denominator.test.ts` 合计 **8/8** 通过，`git diff --check` 通过。

随后完整复跑 `npm run test:release-gates`：**113 files / 542 tests passed，6 files / 13 tests skipped**。跳过项仍明确是未注入真实 PostgreSQL 的 release 专项；本次新增的门禁断言已在 release suite 实际执行并通过。

实时准出快照（2026-09-08）：`npm run dev:doctor` **37 pass / 16 warn / 0 fail**；本地容器、API/UI、PostgreSQL/Redis、Worker、迁移尾 163、FORCE RLS 9/9 均正常，但 `productionGate=false`。`npm run infra:launch-preflight` 以 exit 2 阻断（缺少 `PRODUCTION_CONFIG_PATH`）；`npm run codex:relay:validate` 以 exit 1 阻断（当前 `model_provider=openai` 与 `damai_relay` section 不一致，且 host relay 的 base URL、Responses wire API、env key 缺失）。该快照确认本地运行态健康不等于生产可发布。

元数据一致性修复：发现 Bridge 运行态/MCP 文档为 **143** 个商家工具，但 `tests/release-metadata-gate.ts` 与 `scripts/release-manifest.ts` 都错误排除了可见的 `rule.sync.now`，导致 `release-metadata.json` 错报 142。已统一两处计数逻辑、将元数据修正为 143，并同步使用指南。定向回归 **41/41**、metadata gate、MCP surface 通过；随后完整 `npm run test:release-gates` **113 files / 542 tests passed，6 files / 13 tests skipped**，修复前发现的 8 个 manifest/operations 连锁失败已消失。

结构性加固：新增 `scripts/merchant-bridge-surface.ts`，由 release metadata 与 release manifest 共同调用同一工具可见性/计数实现，避免两份隐藏列表再次漂移。共享实现后的 metadata、manifest、MCP 回归 **20/20**、类型检查和 diff 检查通过。

最终本地质量入口复跑：`npm run check` 全链路完成；核心 `npm test` 为 **599 files / 4508 passed / 70 skipped**，Ops Console 为 **88 files / 501 passed**，Ops surface **109/109**，release metadata 校验通过，Ops Console 与 Merchant Studio 生产构建通过。Merchant Studio 仍报告约 831 kB 单 chunk 的 Vite 性能提示，记录为后续 code-splitting 优化项，不作为功能准出依据。

后续完整根回归：Marketplace 与主 Bridge 镜像同步、配置缺失文案契约修复后，`npm test` **599 files / 4508 passed / 70 skipped**；两套 Bridge 各 131/131 通过。此前 7 个失败均已消除，`git diff --check` 通过。

最新运行态准出快照：`npm run dev:doctor` **37 pass / 16 warn / 0 fail**；容器、API/UI、Worker、迁移尾 163、FORCE RLS 9/9 正常，但支付仍为 fixture、六平台 OAuth 缺失、对象存储/scanner/告警未就绪、可执行目录与批准费率为 0、releasez 未注入不可变发布元数据。`infra:launch-preflight` 明确以 exit 2 阻断（缺 `PRODUCTION_CONFIG_PATH`）；`codex:relay:validate` 以 exit 1 阻断（缺 `model_providers.openai`、host relay base_url、Responses wire API 和 env_key，且 provider 不一致）。

最新桌面真实表面验收：Merchant Studio Playwright **22/22** 通过；隔离 PostgreSQL 的 Ops Console OIDC 全量为 **7 passed / 1 skipped**，覆盖完整 Ops sections、模型失败诊断、无凭据 fail-closed、401 重认证、品牌树和成员治理；独立 JIT 专项在 1440×900/1280×800 两个视口 **2/2 通过**。JIT 失败曾由 Ant Design loading accessible-name 前缀导致，已将验收定位器改为稳定语义匹配并复验通过。该证据验证桌面工作台行为，但不替代 ChatGPT 宿主 E3、生产平台 OAuth 或云发布证据。

`ops-users.spec.js` 中 workspace-only `merchant_admin/owner` token fixture 场景仍是条件跳过（当前运行未计入上述 JIT 2/2），未用伪造凭据强行变绿，保留为真实 workspace token 注入后的准出项。

随后独立复跑 `npm run test:browser:ops:jit`：隔离 PostgreSQL/OIDC、1440×900 与 1280×800 **2/2 通过**；失败原因修复仅涉及测试对 loading 可访问名称的稳定定位，不改变产品权限或后端断言。

新增 fail-closed 修复：生产 `/readyz`、`productionReadinessDiagnostics` 与 `setup.productionGate` 现在同时要求告警 Webhook URL、允许主机和签名密钥可验证；仅有生命周期告警引用但无法投递时不再放行。生产 readiness、告警通知和发布证据回归 **27/27**，`npm run test:release-gates` **113 files / 542 passed / 13 skipped**，类型检查和 diff 检查通过。

跨层一致性加固：`setup.productionGate` 进一步绑定完整 `productionReadinessDiagnostics`（授权、身份、扫描器、规则同步、成本、发布元数据等控制面），并将未就绪控制面的安全原因返回给插件/运营后台；避免 UI 显示可用而 `/readyz` 实际拒绝。API/告警/服务器回归 **87/87**，发布门禁再次 **113 files / 542 passed / 13 skipped**。

容量证据运行态加固：新增 `validateCapacityEvidenceRuntime`，在 API 读取容量报告时校验 release 绑定、`cloud_gate`、零 mock、签署、过期时间和 metrics 基本结构；完整阈值/签名/产物绑定仍由发布门禁负责。过期与错绑回归已覆盖，生产 readiness 不再接受过期容量证据。

运行时时间格式进一步收紧为带 `Z` 的 ISO instant，避免宽松日期解析绕过过期判断；容量 readiness 回归 23/23、类型检查和 diff 检查通过。

商业准入一致性加固：生产 `setup.productionGate` 默认将商业目录/费率视为未检查并阻断；只有 `/readyz` 完成 persistence-backed executable catalog、approved rate 和 enabled charged operation 检查后才传入 ready 结果。API/server 回归 **86/86**，metadata 与 readiness 回归 **27/27**，类型检查通过。

最终发布门禁复跑（2026-09-08 09:50）：`npm run test:release-gates` **113 files passed / 6 skipped；543 tests passed / 13 skipped**。相较此前 542 的记录，新增商业准入与容量运行态断言已实际纳入并通过；6 个跳过文件仍仅为未注入真实 PostgreSQL 的 release 专项，不作伪造绿灯处理。

续轮复核（2026-09-08 09:54）：`npm run dev:doctor` 仍为 **37 pass / 16 warn / 0 fail**；本地容器、运行态、迁移尾 163 和 FORCE RLS 9/9 正常，生产 gate 仍为 false。生产 readiness 与 doctor 回归 **33/33**、类型检查、release metadata gate 和 `git diff --check` 均通过。真实外部阻断保持不变：`infra:launch-preflight` exit 2（缺 `PRODUCTION_CONFIG_PATH`），`codex:relay:validate` exit 1（host relay schema/base URL/wire API/env key/provider section 不一致）。

高风险桌面续轮复验（2026-09-08）：Merchant Studio 真实浏览器 22 项最终状态为 `passed`；隔离 PostgreSQL/OIDC 的 Ops JIT 专项在 1440×900 与 1280×800 **2/2 通过**。未将本地 fixture 或 workspace token 缺失场景计入生产准出。

生产模式负向准出复验（2026-09-08）：`npm run dev:doctor:production` 以 **exit 1** 结束，并将 bridge、生产配置、支付、六平台 OAuth、五模态 relay、对象存储、scanner、告警、可执行目录/费率、release metadata、relay evidence、ChatGPT host error-recovery evidence 明确标为 FAIL；本地容器与数据库安全项保持 PASS。该结果证明生产入口不会把本地 fixture 健康误判为可上线。

真实 stdio Bridge→本地 API 边界复验（2026-09-08）：用 `MERCHANT_MCP_BASE_URL=http://127.0.0.1:8787`、真实 `/mcp` 端口和空 token 启动 `apps/plugin/mcp/bridge.mjs`。`initialize` 与 `tools/list` 正常返回当前 MCP surface；调用 `merchant.start` 未携带有效鉴权时返回结构化 `UNAUTHENTICATED`、`isError=true`，Bridge 进程正常退出且未执行商家操作。该证据覆盖插件入口到 API 的真实传输边界，不替代生产 ChatGPT 宿主验收。

门禁可观测性修复（2026-09-08）：发现生产模式 `dev:doctor` 仅按 `/readyz` HTTP 200 判定 `runtime:api_ready`，可能把本地/fixture API 的 200 误读为生产就绪。新增 `apiProbeReady`，生产模式现在要求响应体明确为 `setup.mode=production` 且 `productionGate=true`；本地/fixture 200 会显示 `production_ready=false` 并 FAIL。新增负例回归 **11/11**，`dev:doctor:production` 复验仍 exit 1 且明确标出该项，类型检查通过。

同轮补强：生产模式下 API/`/readyz` 不可达由原先的 WARN 改为 FAIL；生产 UI 仍可单独提示未启动，但不会以 UI 存活掩盖 API 缺失。`git diff --check` 通过。

修复后发布门禁最终复跑：`npm run test:release-gates` **113 files passed / 6 skipped；543 tests passed / 13 skipped**，无新增失败；跳过仍为未注入真实 PostgreSQL 的 release 专项。

迁移链续轮修复（2026-09-08）：工作树随后又新增迁移 **165 `object_storage_orphan_runtime_acl`** 和 **166 `commercial_catalog_executable_v2`**，造成 metadata、隔离 fixture、migration tail 断言再次滞后。已将 release metadata、migration runner 最新版本、隔离 fixture 分母、release-gates/CI 最新迁移测试以及 README/使用指南同步到 166；metadata gate 恢复通过。迁移/fixture 静态回归 **37/37**，真实隔离 PostgreSQL 专项扩展为 **10 个文件**，迁移 164 的约束/索引、迁移 166 的完整链执行、可执行 SKU、rate card 和审计事件均实际通过。迁移 163/164/165 的历史身份断言保持向前兼容，不被错误改写。

2026-09-08 续轮：工作树继续加入迁移 **167 `private_trial_conversion_closure`、168 `onboarding_grant_dispatch`、169 `onboarding_grant_expiration`**，并新增私有试用支付核验 MCP 方法。已同步 migration runner、metadata（MCP 289、migration 169）、OpenAPI、authz/商业操作注册表、CI 和 release-gates。关键契约回归 **30/30**，迁移/metadata/隔离链回归 **86/86**；真实 PostgreSQL 隔离验收 **10/10**；release-gates **119 files passed / 6 skipped，553 tests passed / 13 skipped**。全量 deterministic suite 最近一次为 **607 files passed / 44 skipped，未通过项仅为随后加入的 OpenAPI/文档/操作注册表漂移，已逐项修复并由上述门禁重跑确认**。

配置可发现性优化：`.env.example` 补充远程对象存储/KMS、生产告警 webhook、生产配置路径和 release evidence 路径，并明确空值仅用于本地开发；不会把空值或 local fixture 解释为生产 ready。
