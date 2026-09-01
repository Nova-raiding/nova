# 全功能上线验收与闭环计划（2026-08-28）

更新：2026-08-29 源码/契约对账。

> 当前权威基线为 Repository `0.1.1`、plugin `0.1.0+codex.20260831125200`、247 个 MCP 方法、148 个商家工具、13 个 Ops 一级域和迁移链 106；105 增加 durable authorization grants。历史数据库段落仅作计划快照，当前发布验收以 `release-checklist-0.1.1.md`、`release-metadata.json` 和 CI 配置为准。

<!-- AUTOPLAN STATUS: REVIEWED — NO-GO -->

## 目标

对桌面 ChatGPT 插件、桌面平台运营后台、API/MCP、Worker、数据库、模型中转、六平台连接器、支付商业化和部署运维进行完整的组件级与运行态验收；覆盖正向、反向、边界、权限、故障恢复、可访问性和 UI/UX。Merchant Studio 仅作为开发调试工具，不是商家产品入口。只有真实证据闭环的能力才能标记为可上线。

## 项目范围宪法

- 商家只在桌面 ChatGPT 插件中完成营销工作；运营人员只使用桌面运营后台。
- 手机和平板不在本项目的产品需求、验收项或上线阻断项内。既有移动视口用例只能作为非阻断回归信息，不得据此扩展产品范围或形成发布否决。
- 所有“已通过”必须注明证据层级：真实桌面宿主、本地 fixture、预生产或生产。宿主链路通过不等于平台、支付、云资源或生产数据通过。

## 当前事实基线

- 最新本地回归基线：263 个测试文件通过、8 个文件跳过；1,743 项测试通过、16 项跳过。根项目类型检查、Ops Console 与 Merchant Studio 生产构建通过；Docker 镜像已按当前源码重建并健康运行。发布前必须用固定命令重新生成该数字，并附跳过清单。
- 运行态：Merchant Studio `:18081`、API `:8787`、PostgreSQL、Redis、5 类 Worker 健康；Ops Console 测试实例 `:18082`。
- 浏览器：当前完整矩阵为 92 个场景，覆盖 Merchant 开发调试面、Ops 12 域、深链、桌面可访问性、用户/成员生命周期、数据删除、发布批次和规则审批；完整单命令回归 92/92 通过。移动视口不属于产品验收或上线门禁。
- 桌面 ChatGPT 真实宿主：2026-08-29 对 `merchant.start`、`workspace.health`、`catalog.search`、`billing.status` 四个核心只读入口验收，结果 4/4 通过。宿主、插件和 MCP 链路为真实运行；店铺、商品和余额数据仍来自本地 `ws_demo`/fixture，因此不构成六平台或支付生产证据。
- 运维：基础设施配置、Compose 资源门禁、生产运维合同、备份恢复、故障语义、标准化投影通过。
- 模型：生产调用以稳定 relay receipt 建立持久结算账本，覆盖 `pending_cost`、`pending_wallet`、`settled`、`waived`、`manual_attention`。本地真实文本、图片、图片编辑、OCR、视频 canary 已全部取得 HTTP 200、provider/task ID、usage 与版本化 CNY 成本快照；综合证据绑定 `local-owner-20260828-r3`，其中复用查询的视频任务来源为 r2。5 秒视频实测成本 ¥544.265625，当前必须由成本门禁保持默认禁用。正式生产 release 仍需托管 Secret 与签署证据。
- 用户治理：迁移 045 已提供持久全局身份、认证会话、风险状态和策略；运营台支持跨工作区查询、工作区停用/恢复、封禁/解封、风险策略转换、会话撤销、成员历史、角色层级、操作原因、revision 冲突与审计。用户目录和导出同时展示每个租户的真实套餐生命周期、任务额度消耗和钱包余额；PostgreSQL 工作区状态读取已改为真实事务范围；运行态验证停用后重启 API 仍保持 `disabled`，普通操作返回 `WORKSPACE_DISABLED`，恢复后数据保留。
- 运行安全：迁移服务保留 owner 权限，API/Worker 使用 `NOSUPERUSER NOBYPASSRLS` 的运行角色；Ops 请求并发限制为 8，认证会话观测增加安全的 60 秒只读快路径，限流键改为 workspace + actor + surface，运营角色独立 600/min，浏览器实测无 429。
- 数据边界：租户运行角色 `merchant_app` 与平台控制面角色 `merchant_ops` 已分离；API 在商品/任务入口与仓储分页中执行品牌授权过滤。当前数据库 RLS 是 workspace 级，品牌级隔离依赖 API/仓储授权，不应写成数据库品牌 RLS。
- 数据库演进：当前可执行发布验收基线到迁移 106；060/062 以非事务 `CREATE/DROP INDEX CONCURRENTLY` 配合 session advisory lock 执行，063 强制 listing 的 workspace/brand/canonical 组合完整性，064 增加身份 bootstrap，065 增加素材解析租约，066 增加平台媒体规格注册表，067 增加字段映射预检审批，068 增加 campaign 生命周期运行角色授权，069 增加 legacy 商品/任务/发布记录的平台与店铺账号作用域触发器，070/071/072 补齐商品—素材关系及完整性校验，073 提供平台运营读取所需的受控工作区商业摘要视图，074/075/076/077 补齐模型 usage 关联、查询索引、canonical 回填索引和任务/发布任务作用域触发器，078/079 补齐素材快照绑定回填与知识水合快照，080 增加 workspace 存储配额与幂等预留账本，081–100 补齐 reconciliation、知识 revision、生命周期权限、图片执行/对账证据、平台作用域、canonical 审计、品牌完整性和告警投递账本，101/102 增加 canonical backfill 批次控制与人工冲突队列，103 收紧告警通知账本应用角色 ACL，104 增加一次性交互确认票据及最小权限消费约束，105 增加 durable authorization grants（持久化授权授予/撤销、JIT 时效与次数预算及双人写审批约束）。001–106 的真实 PostgreSQL fresh/upgrade/RLS/concurrency 尚未绑定同一正式 release artifact；生产大表耗时、触发器开销、锁等待、失败恢复与副本延迟仍待预生产证据。
- 开发体验：增加统一 doctor/stack/Ops 命令并固定 Node 22+；业务 Relay 已通过安全启动入口恢复，并新增 `dev:stack:relay:build` 防止重建绕过环境加载器。buildx v0.36.1 已完成 arm64+amd64 OCI smoke，宿主 Relay 合同和桌面 ChatGPT 请求均已通过；当前生产诊断为 17 pass/1 warn/1 fail，只剩真实生产配置。当前目录是 `main` 的唯一 Git worktree。

## 已证实的上线阻断

1. 业务中转与桌面 ChatGPT 宿主已从 macOS 安全环境重复注入并真实调用成功，但仍没有托管生产 Secret 来源；本地配置不能替代生产 Secret Manager。
2. 本地 release `local-owner-20260828-r3` 已形成统一五模态成本证据；正式 release 尚未绑定同一份 Secret、镜像 digest 集、Git commit 和组织签署。
3. 图片生成、图片编辑、视频生成的真实计费 canary 已完成；视频成本不满足当前商业上限，仍保持禁用；生产区域、生产配额和长稳证据仍缺失。
4. 平台运营后台已有 12 个独立一级域，并包含支持工单、事故、feature flag、财务与审计契约；本地全域浏览器矩阵已完成，仍缺真实 OIDC、生产规模和正式环境运行证据，不能因本地通过宣称完整生产运营控制面。
5. 生产配置仍为占位模板；`infra:production-gate` 与 `launch-preflight` fail-closed。
6. 六平台真实 canary 未运行；真实 OAuth、读、写、图片上传、写后回读和回执证据缺失。
7. 真实支付商户、退款、查询和对账证据缺失。
8. 真实云容量、6 小时稳定性、PITR/KMS/对象存储/OIDC/告警链路证据缺失。
9. 生产证据门禁已固定为 `/run/release-security/evidence-trust` 的 Ed25519 公钥、key ID、公钥指纹和 nonce consumer 摘要，并校验 root owner、mode、父目录与非符号链接；nonce consumer 固定为 `/usr/local/libexec/merchant/consume-production-evidence-nonce`。仓库不会自动配置这些外部受保护文件，真实环境尚未提供与演练，因此仍为 NO-GO。
10. capability evidence 已由正式 preflight 强制 `--require-signed-production`，并绑定 release、image-set、manifest、Git 与 nonce；部署后还会验证 `/releasez`、认证数据库业务路径和签名六平台 canary。rollback 已强制签名 known-good bundle、不可变 artifact 与资源 kind 限制，生产恢复已强制签名 backup attestation。剩余阻断是外部 attester、真实签名 artifacts 和生产部署/回滚/恢复演练尚未形成同一 release 的证明。

## 2026-08-29 发布门禁复核

| 检查 | 本次结果 | 发布含义 |
|---|---|---|
| known-good release bundle、production evidence、backup attestation、固定 trust/replay 代码门禁 | 定向测试 4 个文件、16 项全部通过 | 签名、绑定、过期、重放和篡改拒绝逻辑已实现；不代表正式控制面已经签发 artifact |
| Production trust anchor | 拒绝：`/run/release-security/evidence-trust` 未配置为真实非符号链接目录 | 正确 fail-closed；发布安全控制面仍须配置固定公钥、key ID、摘要、nonce consumer 与 attester |
| Cloud capacity evidence | 拒绝示例证据：非 pass、`cloud_gate=false`、非预生产/生产、非 HTTPS、平台/模型 mock ratio 非零 | 示例和本地压测不能放行；必须提交绑定同一 release 的真实云 50 家、长稳、公平性和扩容报告 |
| Connector/worker fault acceptance | 本地通过：429 进入 retry/dead-letter，timeout 进入 unknown/proof-required | 故障语义代码已闭环；仍需在同一正式 release 的预生产环境验证真实队列、平台限流和恢复收敛 |

本轮 PRD 对账还确认：品牌 audience 复用、并发版本冲突可合并差异、三方向去重质量门禁、结构化营销意图澄清、竞品来源/防抄袭双门禁、campaign 生命周期 adapter、可验证 delivery bundle、视觉真实性、平台媒体规格变体规划和资产预览生产链均已有真实 application/multimodal caller 与测试。它们从“代码未实现”阻断项中移除，但其生产 provider、平台回执、对象存储产物和人工/外部证明仍按各自门禁验收。

## 产品与信息闭环要求

### 商家端

- 店铺授权 → 商品同步 → 商品事实确认 → 素材治理 → 任务创建 → 方向确认 → 内容生成 → 审核 → 发布预览 → 二次确认 → 平台回执 → 失败修正版/重试，必须逐步可恢复。
- 每个阻断状态展示原因、责任方、下一步、重试入口和支持路径。
- 钱包、套餐额度、加购权益、模型实际成本、倍率、预扣、结算、退款和对账必须一致。

### 平台运营端

- 平台级用户中心已覆盖 `user_id/external_subject`、注册来源、状态、最后登录、风险状态、所属工作区和角色；继续补齐付费状态及生命周期操作。
- 用户、工作区、成员关系分层；平台管理员可跨租户检索，工作区管理员只能管理本工作区。
- 用户详情、封禁/解封、邀请/撤权、角色/成员历史、登录会话撤销、受审计操作、按筛选导出和当前目录批量停用已完成。上线 CRM 范围冻结为“支持工单所需的受限客户投影与导出”；跨租户 CDP/360° CRM 不属于本次上线范围，另立 PRD。
- “成员与权限”已从用户/财务混合视图拆成独立 `/ops/members` 导航和深链接。

## 工程闭环要求

- 每个外部调用有超时、限流、重试分类、幂等、未知结果对账、审计和可观测字段。
- 模型回执必须提供 provider request ID、usage、人民币成本；缺成本时不向用户完成最终结算并产生运营告警。
- 所有运行配置来自 Secret Manager/环境合同，可重复重建；不依赖手工复制容器环境。
- 正向测试覆盖完整业务成功路径；反向覆盖未登录、越权、跨工作区、无店铺、无商品、无事实确认、余额不足、无权益、模型失败、平台 429/5xx/超时、重复提交和进程重启。

## UI/UX 与可访问性要求

- 桌面 ChatGPT 插件与桌面运营后台不得出现横向破版；关键控制可键盘操作，焦点可见且路由切换后进入主内容。
- 表单使用持久标签、字段内错误、错误摘要和恢复操作；异步按钮有 loading/disabled 防重复提交。
- 空状态说明“为什么为空”和下一步，不只显示 `No data`。
- 风险、状态和结果不能只靠颜色；文字与 UI 对比度满足 WCAG AA。
- 桌面大表格具备筛选、分页、排序和数据导出；平台运营高频操作支持批量处理。

## 验收证据矩阵

| 领域 | 代码/组件 | 自动化 | 浏览器/运行态 | 外部证据 | 当前判断 |
|---|---|---|---|---|---|
| 桌面 ChatGPT 插件 | 有；Merchant Studio 仅为调试面 | bridge/Skill/资源契约通过 | 真实宿主四个核心只读入口 4/4 通过；数据为本地 fixture | 六平台真实 OAuth/读写与真实支付缺失 | 本地宿主链路通过，生产未上线 |
| Ops Console | 12 个一级域 | 路由、角色、组件与写操作契约通过 | 全域深链 14/14、用户/删除 6/6、成员生命周期 1/1、规则生命周期与审批均通过；纳入 92 场景矩阵 | 真实 OIDC 与生产数据量验收缺失 | 未上线 |
| API/MCP | 217 个唯一 MCP 方法/契约；商家 bridge 147 个工具 | 注册表 217/217 无重复；bridge 不暴露 `ops.*`；定向测试通过，外部平台/支付仍需生产 canary | 本地健康 | 外部平台/支付缺失 | 部分完成 |
| Workers | 5 类 | 运维/故障测试通过 | 健康 | 长稳与真实队列缺失 | 部分完成 |
| PostgreSQL/恢复 | 80 个迁移 | workspace RLS、独立 Ops DB role、备份恢复、状态事务、并发索引、媒体规格、映射审批、campaign 运行角色授权、商品—素材关系、legacy 平台/店铺作用域、受控 Ops 摘要视图、模型 usage 关联、canonical 发布作用域、素材快照回填、知识水合快照和存储配额合同通过 | 当前 runner 链尾为 080；080 的真实 fresh/upgrade/RLS/concurrency 尚未进入 CI | 云 PITR、大表在线迁移、触发器开销与生产角色证据缺失 | 部分完成 |
| 图片局部编辑 | 有 | bridge/multimodal/交互资源契约通过 | 本地资源支持鼠标与键盘区域编辑、候选不覆盖原图 | 生产 provider 与桌面 ChatGPT 宿主专项验收缺失 | 部分完成 |
| 品牌隔离 | API/仓储已实现 | 商品/任务授权与分页定向测试通过 | 本地角色探针通过 | 生产越权探针；数据库仍为 workspace RLS | 部分完成 |
| 模型中转 | 五模态适配器及持久结算账本 | 状态机、重试、人工处置、fail-closed 通过 | 五模态真实 canary、成本快照及视频状态回读通过 | 托管生产 Secret/正式 release 签署缺失 | 部分完成 |
| 六平台连接器 | 有 | fixture/契约通过 | 未验证真实平台 | production canary 缺失 | 未上线 |
| 支付商业化 | 有 | 本地合同通过 | 未验证真实商户 | 查询/退款/对账缺失 | 未上线 |
| 部署运维 | Compose/K8s 有 | 本地门禁通过 | 本地健康 | 生产配置/DNS/TLS/OIDC/云证据缺失 | 未上线 |

## 执行顺序

1. 修复所有本地可解决的 P0：容器外部 DNS、canary 假失败、测试工具链、运营 UI 信息闭环和平台用户模型。
2. 补齐组件、API 和浏览器正反向测试，建立可重复的全功能测试命令与证据目录。
3. 接入持久 Secret 配置和中转成本字段，完成五模态真实 canary。
4. 选择一个主平台和真实支付沙箱完成端到端闭环，再扩展六平台。
5. 在 staging 执行容量、稳定性、OIDC、对象存储、告警和恢复演练。
6. 使用同一 release ID 汇总 capability、relay、payment、capacity 和 deployment evidence，只有 `launch-preflight` 全绿才发布。

## 明确不接受的完成口径

- 不用单元测试替代真实浏览器和真实外部服务。
- 不把 fixture、示例 JSON、本地 Compose 或 UI “显示可用”当作生产证据。
- 不把“配置项存在”当作请求成功，也不把 usage 存在当作成本可结算。
- 不在缺全局用户模型时宣称平台运营后台完成。

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | Intake | 以真实运行证据覆盖旧文档完成结论 | auto | Evidence over assertion | 旧文档与当前配置、用户模型和外部证据矛盾 | 继续沿用“本地完成”口径 |
| 2 | Eng | 为 API/Worker 增加显式可覆盖 DNS | auto | Reliability | Docker 无外部上游导致所有容器外联失败 | 仅重启后碰运气 |
| 3 | Eng | 修复 OCR canary 1×1 图片 | auto | Test fidelity | 模型要求宽高大于 10，探针本身制造假失败 | 更换可用模型掩盖探针错误 |
| 4 | Product | 先交付跨租户成员治理，不宣称完整身份中心 | auto | Scope honesty | 解决平台运营最急需的查询、停用、恢复，同时保留身份/会话模型缺口 | 用成员聚合冒充全局用户表 |
| 5 | Eng | 中转站缺成本回执时阻断最终交付并告警 | auto | Financial correctness | usage 不能替代人民币实际成本，继续交付会造成不可核账损失 | 按估算成本静默结算 |
| 6 | Design | 移动端适配决策废止，不纳入上线门禁 | superseded | Scope discipline | 项目范围已冻结为桌面 ChatGPT 插件与桌面运营后台 | 继续把手机/平板问题列为上线阻断 |
| 7 | Eng | API/Worker 使用独立非超级用户数据库角色 | auto | Tenant isolation | owner/superuser 会绕过 FORCE RLS，无法证明运行态租户隔离 | 只保留 SQL policy 而继续用 owner 连接 |
| 8 | Eng | 模型调用以 relay receipt 驱动持久结算状态机 | auto | Financial correctness | 钱包失败和缺成本必须可重试、可人工处置且不可重复扣款 | 仅写告警或依赖进程内状态 |
| 9 | Eng | 限流按 workspace、actor 和 surface 分桶 | auto | Operability | workspace 单桶使 Ops 首屏并发拖垮同租户交互请求 | 单纯提高所有用户全局限额 |
| 10 | QA | E2E 纵向套件隔离非目标限流副作用 | auto | Test fidelity | 共享匿名桶达到 120 后产生 429 并遗留排队任务，污染后续配额断言 | 把可复现失败标记为 flaky |

## GSTACK REVIEW REPORT

| Review | Runs | Status | Score | Main findings |
|---|---:|---|---:|---|
| CEO | 1 | complete | 5/10 | 建议先完成一个主平台闭环；虽已恢复 Git worktree，但缺真实支付/平台证据与成本闭环时不可发布。 |
| Outside voice | 1 | complete | 5/10 | 本地工程质量已显著收口，但外部生产证据不能由测试替代。 |
| Engineering | 5 | complete | 9/10 | 修复 Worker/OIDC、PostgreSQL 状态事务、全局商业配置越权、CSV 注入、模型结算决策矩阵和发布证据信任边界；外部中转、平台、支付和云证据仍缺。 |
| Design | 5 | complete | 9/10 | 已覆盖桌面深链导航、身份生命周期、工作区治理、结构化危险操作、错误恢复、素材加载隔离和真实分页；仍缺工单和完整导出。手机和平板不在范围。 |
| DX | 3 | complete | 6/10 | 已固定 Node 22+、恢复唯一 Git worktree，并增加统一 doctor/stack/Ops 命令；仍无 buildx、持久 Secret 和可渲染真实生产配置。 |

**VERDICT: NO-GO（本地可验证门禁通过，生产发布门禁未通过）**

已验证的收口结果：源码注册表为 217 个唯一 MCP 方法/契约，桌面 ChatGPT 商家 bridge 为 147 个工具，Ops 为 12 个一级域，当前发布迁移链冻结到 079；桌面真实宿主四个核心只读入口 4/4 通过，但店铺、商品和余额仍是本地 fixture。图片局部编辑、品牌授权过滤、未知模型调用结果对账、订阅降级执行、规则独立审批、平台媒体规格与字段映射审批、campaign 生命周期运行角色授权、独立 Ops DB role、并发索引迁移，以及签名发布/回滚/恢复的 fail-closed 代码门禁均已实现。六平台、真实支付、托管云资源、受保护控制面配置和同一正式 release 的签名外部证据仍未取得，因此保持生产 NO-GO。

**UNRESOLVED DECISIONS:**

- 选择首个真实上线平台及其 OAuth、读写、上传、回读验收账号与责任人。
- 确定真实支付宝/微信商户、退款、查询、对账沙箱和财务签署人。
- 将本地五模态/定价快照证据绑定到正式 release、镜像 digest、Git commit 与托管 Secret，并完成组织签署。
- 基于已恢复的 Git worktree 建立提交/发布/回滚链路，并确定 Secret Manager、云对象存储、KMS、OIDC、告警、PITR 和容量环境。
