# ChatGPT 商家插件测试方案

版本：2026-09-07；责任角色：测试架构 owner；状态：可执行方案，外部验收尚未完成。

配套材料：[本轮评审](project-review-2026-09-07.md)、[桌面实测](../../../artifacts/audit-2026-09-07/qa/desktop-report.md)。本方案不替代现有发布清单，也不表示已经批准发布、收款或模型计费。

## 1. 目标和范围

验收对象是「真实桌面 ChatGPT 插件入口 → MCP/API → 授权和商业准入 → 已配置中转 → 商家状态机/Worker → PostgreSQL/Redis/存储 → 真实回执 → 发布门禁」。商家产品只有 ChatGPT 内插件；Merchant Studio 是调试工具；运营后台是桌面工作台。手机、平板和未授权平台功能不进入验收分母。

测试首先防止越租户访问、未确认发布、重复扣费、任务丢失、错误成功声明和证据造假；再验证功能、恢复体验和容量。源码存在、方法注册、fixture 成功、容器 healthy 分别只是局部证据。

### 规范优先级

本轮用户提供的 AGENTS.md/项目宪法 > 当前明确批准的业务规则及安全边界 > 当前契约/发布 metadata > 对应版本实现说明 > 历史 PRD/旧验收记录。文档冲突须登记并由产品 owner 对齐，不能通过放开商业 disabled、fixture 或权限门禁来使测试变绿。

零点、余额未知、未批准费率的准入规则沿用现行商业 PRD；测试不能自行批准费率、创意点目录、支付或平台权限。

## 2. 证据分层和测试状态

| 层 | 内容 | 能证明 | 不能证明 |
| --- | --- | --- | --- |
| E0 静态 | 类型、schema、依赖图、注册表、源码门禁检查 | 声明和结构一致 | 真实身份/SQL/宿主/外部行为 |
| E1 确定性 | domain、service、bridge 子进程、API stub、UI fixture | 状态机、协议、故障与拒绝语义 | 官方平台和真实模型成功 |
| E2 本地集成 | 独立 PostgreSQL、Redis、实际 API/Worker、桌面 OIDC 测试网关 | 真实 SQL/事务/RLS、进程间协议、浏览器联动 | 正式 IdP、公网宿主、云恢复、平台授权 |
| E3 外部验收 | 真实 ChatGPT.app、固定 MCP origin、配置中转、授权测试店铺、云设施 | 指定版本、环境、动作的真实成功/拒绝/恢复 | 其他平台、其他版本或未经测试规模 |
| E4 发布 | 同一 release 的签名、不可变 artifacts、容量、恢复与值守 | 当前发布候选满足准出条件 | 下一次版本自动继承通过 |

统一状态：`pass`=观察结果符合该用例的预期；`fail`=实际违背预期；`blocked`=必要配置/权限/证据缺失；`skipped`=没有执行；`not_run`=本轮未安排。未知模型结果是业务状态，不是测试通过状态。

「缺少凭据时正确阻断」可作为 E1/E2 负例 pass；同一能力的 E3 成功用例仍为 blocked。不能用负例通过替代能力上线。既有历史通过必须保留原 SHA、日期、环境和证据级别。

## 3. 环境与数据设计

| 环境 | 依赖与身份 | 数据/用途 | 进入条件 |
| --- | --- | --- | --- |
| PR 确定性环境 | Node 22；当前锁定依赖；显式 fixture | 不访问共享业务库；不产生外部模型或平台请求 | 类型、单元、协议与门禁负例可独立运行 |
| PR 隔离集成环境 | PostgreSQL 17 对齐 CI；Redis；独立 API/Worker；app/ops 非超级用户 | 每次 run UUID 数据库/命名空间；admin 只负责建库迁移 | 显式测试 DB URL；所有目标用例执行，零 skip |
| 桌面每日环境 | 实际本地容器、OIDC 测试网关、构建后的 Ops UI | 专用测试身份和测试租户；可取消的交互 | 构建来源可追溯，health/ready 与权限检查通过 |
| 预发布外部环境 | ChatGPT.app、公网 HTTPS MCP、已配置 relay、官方授权、托管存储/扫描 | 专用店铺/商品/SKU；模型额度/预算和写入范围明确 | 真实鉴权、合规素材、可执行费率、范围授权齐全 |
| 容量与恢复环境 | 与目标部署相同版本/角色/限制的独立环境 | 合成负载数据；真实外部流量按已批准预算 | 不使用共享开发/生产数据做故障注入 |

最初评审的本地 PostgreSQL 实测为 **16-alpine**，CI 定义为 **17-alpine**；随后授权专项与桌面隔离续轮已使用自建 PG17，分别保留各次版本与原始报告。PG16 历史通过不能改写为 PG17 通过，也不能将专项 PG17 通过扩展为所有数据库场景已验收。

**迁移 schema dump 的工具版本也是验收前置条件。** PostgreSQL 17 服务端的迁移验收必须使用 PostgreSQL 17 客户端 `pg_dump`；CI 在执行专项前安装 PG17，并通过 `PG_DUMP_BIN=/usr/lib/postgresql/17/bin/pg_dump` 显式绑定。维护者在本机若只有 PG16 客户端，应将结果记录为“工具版本阻断”，不能通过改 PATH、忽略 `pg_dump` 错误或把该文件标记 skipped 来宣称迁移通过。运行隔离迁移套件前至少核对：

```sh
PG_DUMP_BIN=/usr/lib/postgresql/17/bin/pg_dump
"$PG_DUMP_BIN" --version
PG_DUMP_BIN="$PG_DUMP_BIN" npm run test:postgres:isolated
```

如果本机没有 PG17 客户端，应在具备 PG17 客户端的 CI/专用容器中执行，并保留原始版本输出、数据库服务端版本、Vitest JSON 和 release SHA；不能用本地 PG16 的历史结果替代当前 release 的 PG17 证据。

数据基线：租户 A/B；A 下品牌 A1/A2；每品牌两个同平台店铺且设置同名别名；同名商品和相同 SKU 外部标识；owner/operator/reviewer/viewer，以及 platform_ops/support/finance 等实际注册角色。增加被停用身份、撤销店铺、过期授权、余额 0/unknown/充足、草稿/批准/过期规则与素材。

每个测试对象带 `run_id`；记录创建范围和清理清单。只清理本次创建的独立测试容器/数据库/对象；不得 `down -v`、truncate 共享表或清空业务库。失败时先保留日志、trace、余额/事件快照再清理。生产租户不用于破坏性验证。

## 4. 风险覆盖矩阵

P0 是上线关键不变量；P1 是重要功能和恢复质量；P2 是可维护性与易用性。下表是 40 个一级场景（35 个 P0、5 个 P1），每行包含多个参数/断言，不等于 40 个原子自动化用例；不是本轮通过清单。

| ID / 优先级 | 目标、角色和起始数据 | 操作步骤 | 可观察预期及主要断言 | 层/现有落点 |
| --- | --- | --- | --- | --- |
| HOST-01 / P0 | 新 ChatGPT 会话、已安装目标插件 | 安装/发现工具 → 开始 → 读取健康 | 实际工具含必要入口、无 ops；身份/workspace 绑定正确；版本/hash 可关联 | E1+E3；plugin bridge、host evidence gate |
| HOST-02 / P0 | 无绑定、缺 token、错误 MCP 地址 | 分别调用开始/查询 | 明确配置阻断；无生产 fixture fallback、无错误租户缓存 | E1+E3；bridge tests |
| HOST-03 / P1 | 两个可恢复任务 | 输入“继续上次任务” → 选择 → 刷新会话 | 多候选先消歧；恢复同一任务；不新建、不生成、不扣费 | E1+E3；merchant conversation/service |
| HOST-04 / P0 | 真实宿主附件/图片/导出能力 | 上传 → 扫描 → 查候选 → 打开附件 | 真实可见附件；不以 URL/JSON 冒充可打开交付；候选不标已发布 | E3；15 场景宿主门禁 |
| AUTH-01 / P0 | 租户 A 普通成员，已知 B 的资源 ID | 在 REST/MCP 替换 workspace/brand/account/product/version/asset ID | 拒绝或 scope 内空结果；正文、签名 URL 不泄漏；DB/outbox/账务/外部调用零副作用 | E1+E2；RLS attack matrix、resource scope |
| AUTH-02 / P0 | app/ops 非超级用户、A/B 数据 | 无 scope/伪造 scope/事务结束后读取；尝试 UPDATE/DELETE | FORCE RLS 生效；无 scope 不可读；ops 只读允许投影；审计追加不可改 | E2；authorization RLS probes |
| AUTH-03 / P0 | JIT 授权、MFA、双人审批 | 同人审批、过期、撤销、旧 revision、重复消费 | scope/hash/时效/次数预算均校验；maker≠approver；重放结果遵循已受理证据 | E1+E2；authorization repository release |
| AUTH-04 / P0 | worker 已入队、授权随后撤销 | enqueue → revoke → claim → execute | 调 provider 前重新授权；拒绝不得产生模型/平台副作用 | E1+E2；execution-authorization、handler |
| COMM-01 / P0 | 余额 0/unknown、旧钱包有钱 | 调非白名单与恢复白名单 | 按现行商业规则阻断业务；旧钱包/订阅不能解锁创意点能力 | E1+E2；commercial zero-side-effect |
| COMM-02 / P0 | 目录/费率未批准或版本过期 | 请求估算/生成/支付 | fail-closed；不自行批准、不扣款、不访问 provider | E1+E3；commercial registry/readiness |
| BILL-01 / P0 | PG bigint、正整数金额 | 创建订单 → 同 key 重放 → 等额回调 → 重复回调 | 金额类型/数值一致；一张订单、一笔到账；回调来源留证 | E1+E2；billing repository 新回归 |
| BILL-02 / P0 | 同租户足额/临界余额，多客户端 | 同 key/不同 key 并发扣款与退款 | 同 key 同结果；冲突 key 拒绝；余额等式正确；无重复流水 | E2；应补并发集成，不只 mock |
| BILL-03 / P0 | 预占、provider 接收/成功/未知 | 成本缺失、结算失败、receipt 重放 | 不重复调用/扣点；未知不盲目退款重试；可对账恢复 | E1+E2+E3；creative-point-relay-settlement |
| MODEL-01 / P0 | 五模态分别配置/缺项 | text/image/image_edit/ocr/video 各调用一次 | 正确 relay 与真实鉴权；每模态 request ID、usage、成本来源；无宿主绕过 | E1+E3；model-relay-canary/gate |
| MODEL-02 / P0 | 401/429/500/503/超时/断连注入 | 发起 → 观察错误 → 恢复查询 | 错误类别准确；有界重试；provider_started/unknown 不再生成 | E1+E3；provider request/relay usage |
| MODEL-03 / P0 | HTTP 200 但 usage/cost 缺失 | 调用并尝试交付/结算 | 不宣称正式成功；保留已产生调用与待对账记录，不伪造 0 成本 | E1+E3；model-relay-evidence-gate |
| MODEL-04 / P0 | 视频 queued/job id，非 HTTPS 或失败产物 | 多次查询 → 终态 | queued 不等于成片；只有可访问 HTTPS 产物与最终回执才可交付 | E1+E3；video provider |
| ASSET-01 / P0 | 正常/恶意/重复字节素材 | 上传 → 自动扫描 → 读取/下载 | 隔离期间不可下载；签名/新鲜度验证；去重不覆盖历史权益/引用 | E1+E2+E3；storage、scanner、asset |
| ASSET-02 / P0 | 文档含“忽略规则/发布”文本 | 解析 → 查看候选 → 人工确认 | 文件内容只作数据；不发起工具或授权；来源和人工字段可追溯 | E1+E3；content trust/parse |
| ASSET-03 / P1 | OCR 不支持/失败、有保留素材 | 解析失败 → 人工补录 → 恢复 | 使用原 asset；manual 与 OCR 明确区分；不重复上传/丢失素材 | E1+E3；asset.facts.confirm |
| TASK-01 / P0 | 已确认商品/店铺/SKU、准入齐备 | 方向 → 方案 → 中转 → 审核 → 批准 | 真实 bridge 可达；快照与费用贯通；每步独立确认、版本正确 | E1+E2+E3；当前 disabled 需标 blocked |
| TASK-02 / P0 | 方案确认后事实/价格/规则改变 | 分别在生成/批准/发布前修改版本 | 拒绝陈旧快照；价格按 SKU 两位小数展示并重新确认 | E1+E2+E3；service 状态机 |
| TASK-03 / P0 | A/B 店同名商品，多 SKU | 创建多平台/逐 SKU 任务；混用 ID | 原子失败无部分子任务；不同店/SKU 不串价格、库存、内容/图片 | E1+E2；task group/split |
| CONTENT-01 / P0 | 同一自动审核草稿及批准版本 | 批准前导出 → 批准 → 导出 → 更改当前规则再导出 | 草稿不宣称批准冻结；批准历史证据和 ZIP 字节稳定 | E1+E2；本轮 service 导出回归 |
| CONTENT-02 / P0 | 审核 P0 阻断、P1/P2 建议 | 尝试接受/忽略 → 修改 → 重审 | P0 不可被“已知悉”绕过；修改派生新版本，旧批准不复用 | E1+E3；content review |
| IMAGE-01 / P0 | 仅上传图片、无店铺/商品 | 独立 optimize → 查询 → 选图 | 不强制先连店；明确未绑定候选、不可发布；权益与事实检查有效 | E1+E3；image generation |
| IMAGE-02 / P0 | 同任务多个已归档候选 | 选择顺序 → 改顺序 → 用旧确认发布 | 商家明确选图；派生新待审版；旧批准/预览/hash 失效 | E1+E2+E3；visual selection |
| PUB-01 / P0 | 批准版、授权测试商品 | prepare → 核对字段/选图 → 独立确认 → get | 最新双 hash+幂等 key；一个任务；以真实回执/远端回读判成功 | E1+E2+E3；publish 状态机 |
| PUB-02 / P0 | 店铺撤权/媒体适配器缺失/远端变化 | prepare 后改变依赖 → confirm | 正确阻断；不换店、不删图降级、不用旧图冒充 | E1+E3；publish preflight |
| PUB-03 / P0 | 平台已接收但回包丢失/重复回调 | 断连 → 查询 → 重复确认 | unknown 不盲目重发；未确认 published 不显示成功；回执追加不覆盖 | E2+E3；publish reconciliation |
| WORK-01 / P0 | retryable、terminal、unknown 三类事件 | claim → 失败 → 到期恢复/重领 | 普通可重试事件能再执行；terminal/unknown 不被自动重放 | E1+E2；durable 与 PG outbox 联测 |
| WORK-02 / P0 | 双 worker、有效/过期 lease | 同时 claim → 续租 → 进程退出 → 接管 | 同一事件仅一有效执行；旧 lease callback 被拒；最终队列收敛 | E2；durable、repository |
| OPS-01 / P1 | 14 个当前导航域及对应角色 | 遍历租户/成员/任务/规则/模型/账务/审计等域 | loading/empty/error/blocked/ready 状态准确；按钮权限与 API 一致 | E1+E2；ops 浏览器 specs |
| OPS-02 / P1 | 有/无结果，慢旧请求 | 查询筛选 → 无结果 → 清除 → 连续变更条件 | 未命中就地反馈；不误导全局故障；旧请求不覆盖新结果 | E1+E2；含 DESKTOP-001 回归需求 |
| OPS-03 / P1 | 双工作台权限、未保存表单 | 菜单切换/浏览器后退/刷新/键盘操作 | 范围变化可见；脏表单保护；角色撤销及时隐藏并服务端拒绝 | E1+E2；dirty guard、RBAC matrix |
| DATA-01 / P0 | 新库、受支持旧版库、历史数据 | 全量升级 → 重跑 → 改 checksum/缺版本 | 迁移完整且重跑无副作用；漂移拒绝；业务不变量保持 | E2；migration release probes |
| DATA-02 / P0 | 两 API 实例，B 缓存预热 | A 写 → B 读/写 → 同 revision 并发 → 重启 | 可见性满足声明窗口；CAS 冲突准确；回滚后无幽灵内存状态 | E2；replica smoke 扩展 |
| AUTO-01 / P0 | 真宿主 Automation 或宿主不支持 | 创建/运行/暂停只读巡检 | 精确白名单；不生成/充值/发布；缺能力明确无执行；无基线不编造变化 | E1+E3；Automation 协议 |
| REL-01 / P0 | 同 release 完整证据与各类篡改副本 | 缺/过期/旧 SHA/错 origin/错签名/nonce 重放 | 门禁非零退出；fixture/另一宿主证据不可过关 | E1+E4；release gates |
| REL-02 / P0 | 备份与业务/审计哨兵 | 备份 → 独立库恢复 → app/ops 读取/写入校验 | 数据摘要、余额等式、事件连续性、RLS/ACL 全保持；记录 RTO/RPO | E2+E4；恢复脚本需补数据断言 |

## 5. 关键场景的执行细则

### 正式内容成功链 TASK-01

目标：证明商家能从真实 ChatGPT 完成一个可交付任务。前提：明确授权的测试工作区/店铺/商品/SKU；有效素材与人工事实；可执行商业目录/费率；有效 relay；对应方法实际出现在该会话 tools/list。角色：允许创建内容的商家，审批角色按当前策略。

1. 新宿主会话开始，保存插件/hash/实际工具清单和服务端 scope。
2. 商家指定店铺与商品；同名时消歧，记录事实与素材来源。
3. 确认方向和方案；有价格影响则逐 SKU 展示并独立确认。
4. 调用已配置中转；记录 request/trace/provider ID、任务版本、usage、成本与扣点状态。
5. 审核；P0 先修改复审；批准当前版本。
6. 导出并在真实宿主打开附件，核对正文、图片类别、事实引用、审核版本和交付状态。

预期：一个任务、一组受控版本，费用准确，无未经确认发布。任何 disabled/费率缺失/配置不足记录 blocked；不得直接从 service 或 Studio 创建成功结果来补这一用例。

### 账务并发 BILL-02

目标：验证重试与并发的业务等价性。前提：隔离数据库、真实 app role、测试余额刚好足够一次请求；禁用真实支付接口。角色：同一授权商家的两个客户端。

1. 用屏障同时发送 N=2/10/50 个相同幂等 key 请求，等待全部结果。
2. 查询全部响应与账务：同 key 返回相同交易/任务结果，仅一条有效扣款。
3. 同 key 改金额/资源/actor，必须冲突且无新增流水。
4. 改为不同 key，在临界余额并发；总成功金额不得超额，余额与流水等式一致。
5. 对同一 debit 并发退款、重复回调、结算重放；独立断言唯一流水和最终余额。

不能只断言无重复写入：其中一个相同请求返回 500/余额不足而另一个成功，也属于幂等体验缺陷。金额须覆盖 pg bigint 字符串、MAX_SAFE_INTEGER、非法/非整数/越界输入。

### 模型未知结果 MODEL-02/BILL-03

前提：受控 provider 故障注入在已接收后断开连接；可查询回执；固定费用预算。步骤：提交一次 → 模拟接收后 503/超时 → 重复用户“继续” → 查询/对账 → 恢复终态。

分别核对：provider 请求次数=1；没有第二次扣点；结果未知时不盲目退款；usage/cost 缺失明确 pending；最终有可关联 receipt 和客户结算。若回调丢失但 provider 成功，恢复应只补证据/结算，不能重新生成。五模态、同步 API 与 worker 各一组。

### Worker 普通重试 WORK-01

前提：独立 PostgreSQL Outbox + 实际 dispatcher；初次 provider 调用明确未执行并返回 retryable，排除 outcome_unknown。步骤：claim → recordFailure(nextAttemptAt) → ACK 投递提示 → 在截止前验证不重领 → 到期 restore/claim → 执行成功。

断言真实数据库 attempts/next_attempt_at/lease/error/published 状态、队列提示和执行次数。再以 terminal 和 unknown 做对照，二者必须不自动重领。此处必须跨真实 repository 与 dispatcher 联测；内存 fake 不能替代 SQL 条件。

### 桌面权限与筛选 OPS-02/03

前提：1280×800、1440×900，以及主要业务分辨率；同一身份有/无平台角色各一组；测试网关签名身份。步骤：任务查询未命中 → 清除 → 慢请求交错；商家工作台导航到平台域 → 后退；表单未保存时导航 → 取消；随后撤销权限刷新。

预期：未命中就地展示，不标系统故障；范围切换可见且经过服务端授权；后退恢复正确上下文；取消导航保留草稿；未授权按钮不能通过直接 API 生效。保存截图、console、失败请求与授权结果。明确区别正常拒绝、用户体验观察和可复现权限漏洞。

## 6. 执行入口与 CI 改进

先执行不依赖业务数据库的类型、metadata 和构建入口：

```sh
npm run typecheck
npm run test:ops-console
npm run release:metadata:validate
npm run build:ops-console
npm run build:merchant-studio
npm run infra:validate
```

**运行下列命令前必须核实数据库/容器目标。** 现有 `npm test/check` 中有 6 个 PG 测试使用 54329 默认连接，不是完全离线命令；必须先按环境评估，CI 改造前不要把它叫纯单元层。release-gates 也应先核查子命令、环境和证据目标，不默认对当前部署具有发布授权。`test:browser:all` 只包含当前白名单，不代表全部桌面 spec 已执行。

```sh
npm run dev:doctor
npm test
npm run test:release-gates
```

以下是本轮 OIDC 浏览器验收的历史复现命令。独立监听端口和证据目录**只隔离服务监听与文件，不隔离数据**：runner 复用来源容器的 DB、Redis 和配置，默认 actor_demo/ws_demo。再次执行前必须确认目标容器及测试身份/租户；当前筛选场景包含实际数据导出，只取消变更确认，不代表所有动作都没有文件/审计副作用。

```sh
OPS_E2E_SOURCE_CONTAINER=local-api-1 \
OPS_E2E_OUTPUT_DIR=artifacts/audit-2026-09-07/ops-oidc \
node --import tsx scripts/run-ops-oidc-e2e.ts \
  dogfood/chatgpt-all-functions/ops-all.spec.js \
  dogfood/chatgpt-all-functions/ops-users.spec.js \
  --grep 'walk every|does not report|operates the platform' --workers=1
```

建议按以下顺序落地，不扩大为平台重写：

1. **显式隔离 DB 入口**：去掉测试隐式连接共享本机的默认值；普通层无数据库时显式 skip，关键数据库 release job 缺配置直接 fail。将 app/ops role bootstrap 放在需要它的步骤之前。
2. **数据库安全执行清单**：现有 `PERSISTENCE_RELEASE_DATABASE_URL` 统一供给 RLS、authorization reservation、事件 scope、产品 scope、worker settlement。runner 保存 JSON，检查预期文件分母、执行数>0、failed=0、skipped/pending/todo=0。不得仅靠 job 名称“without skips”。
3. **桌面清单完整性**：为 `canonical-product-desktop`、`image-generation-desktop`、`ops-workbench-dirty-guard`、`ops-rbac-desktop-matrix`、`merchant-workspace-roles` 建明确入口；不同角色/夹具用独立 project/env，不把不兼容用例硬塞同一会话。
4. **宿主门禁**：显式识别目标 ChatGPT 宿主与 App 版本，拒绝其他宿主冒充；保留原证据而非重写旧 host 字符串。按真实支持矩阵制定 schema，兼容命名不等于兼容证据。
5. **调度**：PR 跑 E0/E1 和隔离关键 E2；每日跑完整桌面/Worker/replica；候选发布跑 E3/E4、容量/恢复。安全相关变更禁止仅使用 CodeGraph affected 缩减测试。

CodeGraph 使用「索引文件数、跳过原因、关键入口是否被索引、源 hash」作为先决检查。当前 API 大文件和跨进程 bridge 均有静态图盲区，采用人工入口→测试映射补偿；affected 返回 0 不能作为无需测试的依据。

### 真实宿主门禁的 15 项显式映射

以当前 `tests/codex-app-host-evidence-gate.ts` 的 REQUIRED_SCENARIOS 为分母，每项独立证据；不得用本表合并行减少原始场景数。

| 宿主场景 ID | 一级场景落点 / 必验内容 |
| --- | --- |
| plugin_discovery、merchant_start | HOST-01；真实安装、工具发现与启动 |
| wallet_recharge_entry | COMM-02 + BILL-01；真实宿主充值入口与支付准入，实际付款须单独授权 |
| platform_oauth_entry | HOST-02 + PUB-02；官方授权入口/回跳及正确店铺绑定 |
| asset_attachment、automatic_scan | HOST-04 + ASSET-01；附件真实上传、隔离、扫描和宿主读取 |
| error_recovery | MODEL-02 + BILL-03；503、request/trace、unknown、只查询/对账恢复 |
| image_generation、candidate_images_rendered | IMAGE-01；真实中转结果与宿主可见候选图 |
| candidate_primary_cta、candidate_selection_persisted | IMAGE-02；主操作明确、选择及顺序持久化 |
| selection_not_reviewed、selection_not_published | IMAGE-02 + CONTENT-02 + PUB-01；选图不冒充审核批准/真实发布 |
| automation_read_only、automation_host_absent | AUTO-01；只读白名单、缺宿主能力时明确未执行 |

## 7. 容量、长稳与故障方案

沿用仓库 `capacity-evidence-gate.ts` 的预算，不凭空增加生产承诺：

| 阶段 | 租户 | 客户连接 | 持续 RPS / 分钟 | 突发 RPS / 秒 | 异步 jobs/min | p95 上限 |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| pilot_50 | 50 | 150 | 30 / 30 | 60 / 60 | 50 | 1000ms |
| wave_100 | 100 | 300 | 60 / 30 | 120 / 60 | 100 | 1200ms |
| wave_250 | 250 | 375 | 75 / 30 | 150 / 60 | 250 | 1600ms |
| target_500 | 500 | 750 | 150 / 30 | 300 / 60 | 500 | 2000ms |

每阶段先稳态、再突发；**每个申请容量放行的 profile 均需 ≥6h 长稳**，不是只有 target_500 需要。探索性短测只作 E2 观测，不能通过相应 profile 门禁。duplicate_writes=0、lost_jobs=0、噪声租户造成其他租户 p95 劣化≤20%。同时采集 p99、错误率、队列年龄/深度、DB pool wait/锁/事务时长、Redis 重投、Worker lease 续租失败、模型/存储吞吐和成本。

故障在独立环境依次注入：API 副本退出、Redis 重启、DB 连接池耗尽、Worker claim 后退出、provider 接收后超时、receipt 已写但 ACK 丢失、扫描中断、存储访问拒绝、告警投递失败。恢复后验证队列收敛及业务/账务不变量，不仅检查进程重新 healthy。

注入错误与非预期错误必须分开统计；现有 gate 要求 `error_count=0`，故障段应使用单独故障验收报告，不能把预期 503 从原始数据中删除。云门禁要求平台/model mock ratio=0；未批准足够预算时只能完成本地负载层，真实容量标 blocked。

恢复演练先设计业务哨兵：任务/内容摘要、批准快照、余额=充值−扣款+退款、outbox/receipt 对应、审计连续性与 app/ops 权限。记录开始、恢复可读、恢复可写、最终校验完成四个时间点；RTO/RPO 由业务/SRE 签定目标后验收，不能凭本地表存在推断云 PITR 达标。

## 8. 证据记录与准出

每次 run 保存：

```text
run_id, case_id, requirement_id, risk, evidence_level
git_sha, dirty_diff_sha256, source_manifest_sha256, release_id
image_digest, bridge_sha256, plugin_version, host_type, app_version
environment, postgres_version, identity_mode, connector/model/storage/scanner_mode
config_version, pricing_version, data_version, mock_ratios
started_at, ended_at, expires_at, actor_role, tenant_alias, scope
expected, observed, status, blocker, assertions
request_id, trace_id, event_id, job_id, provider_request_id
usage, observed_cost, cost_source, customer_settlement_state
raw_report, logs, screenshots/trace, immutable_artifact_ref+sha256, verifier
```

原始报告必须保留 passed/failed/skipped/pending/todo，禁止只输出通过比例再删除 JSON。日志脱敏，不能包含 bearer、cookie、数据库密码或无关商家正文。原始 metrics 必须真实存在并校验 hash/窗口；声明“6h”不能替代六小时采样。

准出条件：所有计划 P0 成功/拒绝/恢复场景符合预期；关键集成和桌面 suite 零 skip；没有越租户读写、重复扣费、丢任务、未授权写入或虚假交付；当前 release 的镜像/迁移/bridge/source hash 一致；五模态与真实 ChatGPT 证据完整；相应平台、支付、存储/扫描、容量、恢复与值守无 missing/expired/fixture 状态。

任一 P0 blocked 维持 NO-GO。P1 遗留必须明确影响、临时措施、owner 和完成条件；测试通过率不能平均掉安全阻断。负责签字：产品 owner 确认可交付范围；工程 owner 确认实现与来源；测试 owner 确认证据；安全/财务/SRE 分别确认权限、费率账务与发布恢复。

发布采用双条件合取：**runtime readiness AND evidence readiness**。除了签名 artifacts，目标部署必须实际通过鉴权、DB/RLS、worker、扫描器、对象存储健康与授权测试租户 smoke；证据通过不自动让当前部署可写。保持与 `docs/production-readiness-evidence-design.md` 的运行时/证据双维度设计一致。

## 9. 执行排期与交接

| 顺序 | 交付 | 主责 | 完成判据 |
| --- | --- | --- | --- |
| 本轮 | 证据审计、确定性缺陷修复、桌面/PG重点验证、本测试方案 | 工程+测试 | 本轮报告中逐项有命令与结果 |
| 下一 PR | DB/桌面执行分母、零 skip runner、显式宿主 schema、规范优先级索引 | 测试架构+产品+工程 | CI 实际执行全部目标文件，坏配置/漏文件/skip 均失败 |
| 首次预发布前 | 先修授权范围契约，保持本轮 retry 回归，再补并发扣款、跨副本和恢复哨兵 | 后端+测试 | 隔离集成零 skip，成功/拒绝/恢复三类齐备 |
| 外部配置完成后 | ChatGPT、五模态、官方平台、支付/存储 canary | 产品+平台+财务+测试 | 当前 release 的真实证据与费用对账齐备 |
| 发布决策前 | 容量/长稳、回滚/恢复、告警值守、签名证据总门禁 | SRE+安全+测试 owner | E4 门禁通过及责任人签字；否则 NO-GO |

执行日期取决于外部权限、批准费率和正式配置到位；本方案不给未授权工作设置虚假的完成时间。用例负责人应在每轮开始前固定范围和版本，结束后将 not_run/blocked 项转入下一轮清单。

## 10. 后续复验细化：授权契约与素材投影

本节细化既有风险场景，不改变上文 40 个一级场景的分母。执行结果另见[修复记录](remediation-2026-09-07.md)；下表不是全部通过声明。

| 对象 | 必须覆盖的输入或顺序 | 核心断言 | 证据要求 |
| --- | --- | --- | --- |
| 素材正常/异常矩阵 | clean、blocked、quarantined、未知扫描；approved、pending、unknown、rejected 权益；正式 parse/facts blocked | 正式 readiness 不丢失；pending 不等于已授权；正式解析阻断不自动等于未绑定候选禁止 | 源码插件与 `.codex-marketplace` 镜像分别启动真实 bridge stdio 子进程，受控 HTTP 响应，保留原始断言；不等同于已安装缓存验收 |
| 素材视图冲突 | asset 和 action 两方向 clean/blocked、approved/rejected 冲突；clean 与 awaiting_scan display 冲突；ready/generate nested CTA 与明确 deny 冲突 | 明确 deny 不被 merge 覆盖；assets、asset_actions 与嵌套动作一致；未知扫描不显示通过；action 未提供扫描不冒充新扫描结论 | 每个冲突先红后绿；检查结构化输出，不只匹配一句提示 |
| 素材隐私与商业边界 | action-only、携带内部对象/存储路径/扫描详情；未绑定候选指导 | 只允许公开字段；无内部详情泄露；指导不等于实际调用或授权，不能标已批准/已发布 | 精确响应及敏感字段负例；API 准入组独立验证。真实宿主与模型成功仍须 E3 |
| 授权新建与执行 | API 当前 workspace_ids → PG 插入 → 消费返回真实 revision → 真实 job/aggregate ID 预留 | workspace scope 按工作区匹配，reservation 仍记录任务 ID；不可通过替换 fixture ID 或硬编码 revision 隐藏错误 | 真实 PG、非超级用户业务角色；PG17 专项已执行通过，HTTP 内存集成独立验证；真实目标部署串联仍待 E3 |
| Worker 授权边界 | 跨工作区、虚构 outbox event、aggregate/operation/snapshot 不匹配、撤权后新执行、历史重放 | HTTP 入口在预留前验证真实事件归属；新执行拒绝，重放遵守原幂等身份与不可变证据 | 必须经过两个真实 HTTP execution-check 入口；导出 helper 的单测不替代入口证据 |
| 迁移完整性 | 新库、162→163、163→164、164→165、165→166、166→167、167→168、168→169；仍有效 canonical 旧授权、已失效/撤销旧授权；并发创建旧格式 | active 不兼容授权导致迁移明确失败且不登记成功；历史 scope/hash/event 不变；onboarding schedule 的 blocked/activated 约束、orphan ACL、可执行商业 SKU/rate/event、private-trial 事实与 dispatch/expiration RLS 均生效；新旧触发器切换无放权窗口 | 独立数据库；表锁与事务失败证据；不迁移共享业务库，不自动转换授权 |
| 执行分母 | 所有新迁移/授权文件均出现在 loader、metadata、静态 gate、release command 和 CI | 目标文件集合一致、实际 assertion > 0、关键集成零 skip；报告保留失败与未执行项 | 校验文件集合而不只比较数量；保留原始 Vitest JSON 与运行前后源码 hash |
| 桌面签发表单契约 | 真正提交 JIT 表单，不 mock 返回成功；接入目标 API/PG；签发→列表→撤销 | 请求使用单工作区 workspace_ids；错误保留输入；真实状态/审计变化；不靠源码字符串或假生命周期证明通过 | 本轮发现组件仍发 type/ids，现有 helper 测试未覆盖；需确认新增组件/提交回归范围及完整隔离桌面 harness |
| 全量测试环境隔离 | 普通全量入口、真实扫描上传、Redis 故障注入、OIDC session 写入 | 普通测试不得默认写共享 ws_demo 或停启共享 Redis；危险/真实测试必须显式配置并确认隔离目标 | 本轮全量检查因已观察到共享写操作而中止；见 A-01 报告影响记录；分母不能隐去未执行项 |

## 11. 已确认续轮的执行入口与新增负例

桌面表单与测试隔离现已获确认并实施，最新实测见[续轮报告](jit-desktop-test-isolation-2026-09-07.md)，不改动前述 40 个一级场景分母。

- E1 表单必须真正填写并提交，验证唯一 workspace_ids、到期时间绑定、版本号、错误恢复和重复点击；不只测 helper 或源码字符串。
- E2 桌面使用自建 PG17/Redis、持久角色、签名 OIDC、真实 API 与桌面 UI。签发/刷新/撤销分步骤记录；签发成功不抵消撤销失败。
- 授权负例新增 issue/revoke 的审批义务与严格 MCP schema 一致性。后续“继续”已确认：签发需要审批，撤销不需要二次审批；管理权限、原因、双版本和审计保留。不得通过前端补 schema 未定义字段绕过。
- 普通 check/watch/summary 剥离业务和执行环境；13 个非隔离文件有显式清单。10 个 PG 使用自建容器专用入口，4 个 runtime/9 场景缺配置必须失败，旧 canonical API 的 6 场景单独标未迁移隔离。
- runtime 隔离负例覆盖共享 project/端口/workspace/DB/Redis、远程 Docker、宿主 bind/socket/device、privileged、外部 volume、环境密钥与目标被替换；配置拒绝应发生在任何请求或故障操作之前。
- 清理负例覆盖创建中断、子进程失败、报告缺失/漏文件/空断言/skip、容器归属核验失败。无法证明归属时留下待复核，不猜测性删除；只清理本次合成夹具。

## 12. 撤销策略确认后的验收增量

本节属于 AUTH-03/AUTH-04 与桌面治理场景的细化，不新增或缩减 40 个一级场景分母。已批准并实现的策略版本为 `2026-09-07.v1`；详细结果见[撤销续轮报告](jit-revoke-policy-verification-2026-09-07.md)。

| 层 | 新增/复用的可执行覆盖 | 严格判据 |
| --- | --- | --- |
| E0 策略 | 两个 evaluator 各覆盖撤销不带审批、缺原因/版本/权限、显式 deny、错误工作台/scope；签发仍需审批 | 新版策略、确切 obligations、allow/deny 与 allow_and_deny 审计声明一致 |
| E1 签名 HTTP | canonical platform_admin/security_admin；新鲜 OIDC nonce；持久 Memory 角色；enforce + durable required | 合法撤销 200；grant/subject revision 各 +1；新会话与旧 grant 均失去访问；允许/拒绝审计可按 request/decision ID 关联 |
| E1 拒绝/重放 | 多余审批字段、缺 required、非数字版本、空白原因、无 durable 权限、伪造签名、错误工作台、双版本冲突、错误 subject、成功后的重复请求 | 拒绝且 grant/active/revision/成功 mutation 不变；不能用 nonce 拒绝冒充 repository 重放保护；不存在/冲突/非法输入分别映射 404/409/400 |
| E2 PG | 固定六文件/八场景的授权事务、事件/scope、RLS、迁移；桌面请求实际持久化审计 | 每文件实际执行、非空断言、零 skip；两业务角色非超级用户；原审批/scope/hash/历史事件不改写 |
| E2 桌面 | 原 1440×900 / 1280×800 serial suite：签名登录→签发→自动/手动刷新→撤销→列表移除→可见回执 | HTTP 200、数据库撤销和可见回执分别判定；回执缺失仍 fail；serial 未执行尺寸保留 not_run |
| 下一轮前端回归 | 真实父组件 + model 会话清空/重载、异步延迟、权限消失/恢复、失败重试 | 撤销回执与位置可解释；失效客户数据及时清除；不得保留旧 capability 维持 UI；重载失败不显示可继续授权的假成功 |

前一轮桌面已观察到撤销 200 后回执丢失。本续轮将回执与两层治理导航状态提升到 `useOpsConsoleModel`，但不恢复旧 session、能力或客户数据；平台工作台缺少 `session.workspace_id` 时仍允许以真实 actor 记录目标 grant 回执。2026-09-07 真实隔离桌面复验已通过 1440×900、1280×800 两个视口（2/2），并保留原失败证据与本轮通过证据；这不替代 ChatGPT 宿主、中转五模态或发布环境 E3/E4。

## 13. 授权错误的客户端可恢复性

授权仓储错误必须保留安全语义并映射为可行动的 HTTP 契约：对象不存在返回 404，修订/并发冲突返回 409，输入非法返回 400；未知数据库或系统错误仍返回 500。回归断言同时检查错误 code、status、用户提示和“不改变事务结果”，禁止用统一 500 掩盖刷新、修正输入或联系支持的不同路径。

## 14. 商业工作流解锁门禁（第 1 项）

正式内容链路的放行条件必须同时满足：真实 ChatGPT 会话的 `tools/list` 出现获批方法；商业目录存在 `active + executable` 费率版本；每个 SKU 的业务条款、单位、有效期和审批证据完整；创意点余额状态为 `known` 且满足报价；模型中转真实鉴权、请求 ID、usage、cost 和错误回执可关联。仅有余额、fixture 目录或服务端 handler 存在都不能放行。

本轮真实 MCP 只读核验结果：无可用店铺；目录 6 个 SKU 全为 `draft`/`executable=false`，阻断项包含 `STORAGE_UNIT_UNRESOLVED`、`ORDER_TERMS_REQUIRED`、`ONBOARDING_GRANT_SCHEDULE_UNRESOLVED`、`CREATIVE_POINT_PACK_EXPIRY_UNRESOLVED`、`BUSINESS_APPROVAL_REQUIRED`；创意点余额 10,000 但不构成准入。故本轮不得调用生成、扣点、平台写入或发布。

解锁后的 E3 准出顺序固定为：`merchant.start` → `workspace.health` → 真实工具发现 → 绑定已授权店铺/商品 → 方案与事实确认 → `workspace.interactive.confirm` → 中转生成 → 审核/批准 → 交付附件核验。任一步缺证据必须保留 blocked，并验证 provider 调用数、扣点流水、审计和发布副作用均为零。

## 15. 生产告警可投递门禁（新增）

生产 readiness 不仅检查生命周期中的告警策略引用，还必须验证 `OPS_ALERT_WEBHOOK_URL`、`OPS_ALERT_WEBHOOK_ALLOWED_HOSTS` 与 `OPS_ALERT_WEBHOOK_SECRET`。缺任一项、URL 不安全或主机不在白名单时，`/readyz` 返回 503，`setup.productionGate=false`，且不得接收真实流量。覆盖层级：

- 单元：URL、TLS、允许主机、签名和重试行为；
- API readiness：生产完整配置通过，逐项删除配置 fail-closed；
- 发布门禁：告警证据、生命周期、回滚和观测配置一起验证；
- 桌面验收：运维页面显示 blocked 原因，不将“已配置策略”误标为“可投递”。

此外，`setup.productionGate` 必须与 `productionReadinessDiagnostics` 同步收敛；授权、身份、扫描器、规则同步、成本或 release metadata 任一控制面失败时，插件和运营后台都必须显示 blocked，不能只依赖 `/readyz` 的 503。

容量证据在运行时还要验证当前 `RELEASE_ID`、`cloud_gate=true`、零平台/模型 mock、有效签署、未过期和 metrics 基本结构；完整容量阈值、云环境、故障注入、原始指标绑定由发布阶段 `capacity-evidence-gate` 继续执行。

商业准入必须在持久化目录和费率完成检查后才能进入 `setup.productionGate`；未检查状态不能被解释为通过。`/readyz` 负责将真实 catalog/rate/charged-operation 结果注入 setup，健康与插件诊断在没有该结果时保持 blocked。

## 16. Doctor 与 readiness HTTP 语义

`dev:doctor --production` 的 `runtime:api_ready` 不得只看 HTTP 200。必须解析非敏感响应体，要求 `setup.mode=production` 且 `productionGate=true`；本地/fixture API 即使返回 200 也必须标记 `production_ready=false` 并 FAIL。API 或 `/readyz` 不可达在生产模式同样是 FAIL。该契约由 `apiProbeReady` 单元回归覆盖，并作为发布前的负向门禁证据。
