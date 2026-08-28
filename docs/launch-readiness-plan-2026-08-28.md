# 全功能上线验收与闭环计划（2026-08-28）

<!-- AUTOPLAN STATUS: REVIEWED — NO-GO -->

## 目标

对 Merchant Studio、平台运营后台、API/MCP、Worker、数据库、模型中转、六平台连接器、支付商业化和部署运维进行完整的组件级与运行态验收；覆盖正向、反向、边界、权限、故障恢复、可访问性和 UI/UX。只有真实证据闭环的能力才能标记为可上线。

## 当前事实基线

- `npm run check`：111 个测试文件、767 项测试通过；类型检查、Ops Console 和 Merchant Studio 生产构建通过。
- 运行态：Merchant Studio `:18081`、API `:8787`、PostgreSQL、Redis、5 类 Worker 健康；Ops Console 测试实例 `:18082`。
- 浏览器：13 项综合回归通过。商家端 7 个一级模块、8 个页面状态、9 组安全交互；运营台总览、用户、任务、店铺、账务 5 个页面均已真实加载。用户目录桌面、键盘、390px、375px 和 844×390 横屏通过；移动菜单、表单错误聚焦、详情焦点归还、模型状态失败态和结算处置入口已覆盖；正确同源代理配置下为 0 console error、0 failed request、0 RPC error。
- 运维：基础设施配置、Compose 资源门禁、生产运维合同、备份恢复、故障语义、标准化投影通过。
- 模型：生产调用以稳定 relay receipt 建立持久结算账本，覆盖 `pending_cost`、`pending_wallet`、`settled`、`waived`、`manual_attention`，提供批量重试、人工处置、revision 冲突与审计；缺成本继续 fail-closed，也可在显式开关下从中转定价接口生成可审计 CNY 快照。运行态对账接口返回 `completed`、`unsettled_records=0`；当前容器仍因中转 Secret 缺失而不能形成真实 release evidence。
- 用户治理：迁移 045 已提供持久全局身份、认证会话、风险状态和策略；运营台支持跨工作区查询、封禁/解封、风险策略转换、会话撤销、成员历史、角色层级、操作原因、revision 冲突与审计。迁移 044 提供平台目录 RLS，API/Worker 改用 `merchant_app` 非超级用户角色；真实事务探针证明 workspace A 可见、切换 workspace B 后为 0 行。剩余缺口收窄为付费生命周期、工单、批量治理和导出。
- 运行安全：迁移服务保留 owner 权限，API/Worker 使用 `NOSUPERUSER NOBYPASSRLS` 的运行角色；Ops 请求并发限制为 8，认证会话观测增加安全的 60 秒只读快路径，限流键改为 workspace + actor + surface，运营角色独立 600/min，浏览器实测无 429。
- 开发体验：增加 `dev:doctor`、`dev:doctor:production`、`dev:ops-console`、`dev:stack` 并固定 Node 22+；最终本地诊断 14 pass/5 warn/0 fail，生产诊断 14 pass/1 warn/4 fail，明确区分容器 Relay 与宿主 Relay，并对无 buildx、无持久 Relay、无真实生产配置 fail-closed。当前目录已恢复为 `main` 的唯一 Git worktree。

## 已证实的上线阻断

1. 根目录没有 `.env` 或托管 Secret 注入证据；API 重建后 `MODEL_RELAY_BASE_URL` 与 `MODEL_RELAY_API_KEY` 已实际丢失，证明昨天配置只在旧容器临时存在；宿主 `codex:relay:validate` 同样失败。
2. 当前环境没有可重复注入的中转 Secret，也没有 release-bound 成本证据；虽然代码已支持中转 `cost_cny`、成本响应头及显式定价快照推导，但“实际成本 × 倍率”尚未用当前 release 的真实回执闭环。
3. 图片生成、图片编辑、视频生成尚未执行真实计费 canary，也没有 release-bound evidence。
4. 平台运营后台已有持久全局身份、登录会话、风险策略和跨工作区成员治理，但付费生命周期、工单、批量治理和导出仍未完成，不能宣称完整运营 CRM。
5. 生产配置仍为占位模板；`infra:production-gate` 与 `launch-preflight` fail-closed。
6. 六平台真实 canary 未运行；真实 OAuth、读、写、图片上传、写后回读和回执证据缺失。
7. 真实支付商户、退款、查询和对账证据缺失。
8. 真实云容量、6 小时稳定性、PITR/KMS/对象存储/OIDC/告警链路证据缺失。

## 产品与信息闭环要求

### 商家端

- 店铺授权 → 商品同步 → 商品事实确认 → 素材治理 → 任务创建 → 方向确认 → 内容生成 → 审核 → 发布预览 → 二次确认 → 平台回执 → 失败修正版/重试，必须逐步可恢复。
- 每个阻断状态展示原因、责任方、下一步、重试入口和支持路径。
- 钱包、套餐额度、加购权益、模型实际成本、倍率、预扣、结算、退款和对账必须一致。

### 平台运营端

- 平台级用户中心已覆盖 `user_id/external_subject`、注册来源、状态、最后登录、风险状态、所属工作区和角色；继续补齐付费状态及生命周期操作。
- 用户、工作区、成员关系分层；平台管理员可跨租户检索，工作区管理员只能管理本工作区。
- 用户详情、封禁/解封、邀请/撤权、角色/成员历史、登录会话撤销和受审计操作已完成；继续补齐工单、批量操作和数据导出。
- 将“成员管理”从财务配置中拆出，形成独立导航和深链接。

## 工程闭环要求

- 每个外部调用有超时、限流、重试分类、幂等、未知结果对账、审计和可观测字段。
- 模型回执必须提供 provider request ID、usage、人民币成本；缺成本时不向用户完成最终结算并产生运营告警。
- 所有运行配置来自 Secret Manager/环境合同，可重复重建；不依赖手工复制容器环境。
- 正向测试覆盖完整业务成功路径；反向覆盖未登录、越权、跨工作区、无店铺、无商品、无事实确认、余额不足、无权益、模型失败、平台 429/5xx/超时、重复提交和进程重启。

## UI/UX 与可访问性要求

- 桌面与 390px/375px 移动端无横向破版；关键控制可键盘操作，焦点可见且路由切换后进入主内容。
- 表单使用持久标签、字段内错误、错误摘要和恢复操作；异步按钮有 loading/disabled 防重复提交。
- 空状态说明“为什么为空”和下一步，不只显示 `No data`。
- 风险、状态和结果不能只靠颜色；文字与 UI 对比度满足 WCAG AA。
- 大表格具备筛选、分页、排序、移动端降级和数据导出；平台运营高频操作支持批量处理。

## 验收证据矩阵

| 领域 | 代码/组件 | 自动化 | 浏览器/运行态 | 外部证据 | 当前判断 |
|---|---|---|---|---|---|
| Merchant Studio | 有 | 通过 | 基础浏览/安全交互通过 | 六平台真实写入缺失 | 未上线 |
| Ops Console | 有 | 通过 | 五页、身份/会话/风险/结算交互及三种移动视口通过 | 付费生命周期/工单/批量/导出缺失 | 未上线 |
| API/MCP | 178 个 MCP 工具 | 767 项测试含契约 | 健康 | 外部平台/支付缺失 | 部分完成 |
| Workers | 5 类 | 运维/故障测试通过 | 健康 | 长稳与真实队列缺失 | 部分完成 |
| PostgreSQL/恢复 | 46 迁移 | 备份恢复、平台 RLS 及非超级用户真实 scope 探针通过 | PostgreSQL ready | 云 PITR 缺失 | 部分完成 |
| 模型中转 | 五模态适配器及持久结算账本 | 状态机、重试、人工处置、fail-closed 通过 | 本地对账 completed、未结算 0 | 当前 release 的成本/媒体 canary 缺失 | 未上线 |
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
| 6 | Design | 移动端宽表限制在自身滚动容器内 | auto | Responsive usability | 390px 实测发现整页横向溢出 | 放宽浏览器断言或隐藏字段 |
| 7 | Eng | API/Worker 使用独立非超级用户数据库角色 | auto | Tenant isolation | owner/superuser 会绕过 FORCE RLS，无法证明运行态租户隔离 | 只保留 SQL policy 而继续用 owner 连接 |
| 8 | Eng | 模型调用以 relay receipt 驱动持久结算状态机 | auto | Financial correctness | 钱包失败和缺成本必须可重试、可人工处置且不可重复扣款 | 仅写告警或依赖进程内状态 |
| 9 | Eng | 限流按 workspace、actor 和 surface 分桶 | auto | Operability | workspace 单桶使 Ops 首屏并发拖垮同租户交互请求 | 单纯提高所有用户全局限额 |
| 10 | QA | E2E 纵向套件隔离非目标限流副作用 | auto | Test fidelity | 共享匿名桶达到 120 后产生 429 并遗留排队任务，污染后续配额断言 | 把可复现失败标记为 flaky |

## GSTACK REVIEW REPORT

| Review | Runs | Status | Score | Main findings |
|---|---:|---|---:|---|
| CEO | 1 | complete | 5/10 | 建议先完成一个主平台闭环；虽已恢复 Git worktree，但缺真实支付/平台证据与成本闭环时不可发布。 |
| Codex / outside voice | 1 | complete | 5/10 | 本地工程质量已显著收口，但外部生产证据不能由测试替代。 |
| Engineering | 4 | complete | 8/10 | 已补持久身份/会话/风险、非超级用户运行角色、真实 RLS 探针、模型结算状态机及对账处置 API；外部中转、平台、支付和云证据仍缺。 |
| Design | 4 | complete | 8/10 | 已覆盖身份详情/历史、会话撤销、风险策略、结算状态/批量重试/人工处置、错误隔离和三种移动视口；仍缺付费生命周期、工单、批量用户治理和导出。 |
| DX | 3 | complete | 6/10 | 已固定 Node 22+、恢复唯一 Git worktree，并增加统一 doctor/stack/Ops 命令；仍无 buildx、持久 Secret 和可渲染真实生产配置。 |

**VERDICT: NO-GO（本地可验证门禁通过，生产发布门禁未通过）**

已验证的收口结果：`npm run check` 为 111/111 文件、767/767 用例；两个前端生产构建通过；13 项真实浏览器回归覆盖运营后台五页面、模型错误态、身份/会话/风险、结算处置、用户详情键盘流程、移动菜单、表单错误聚焦和 390px/375px/横屏。API 与全部 Worker 健康；非超级用户数据库角色下的跨租户 RLS 实测、平台治理、原子审计和模型结算对账接口均在最终容器生效。CodeGraph 最终索引为 359 文件、5,145 节点、21,562 边。示例 capability/capacity JSON 能通过结构门禁，但生产运行时明确拒绝把 example 当作 release evidence。

**UNRESOLVED DECISIONS:**

- 选择首个真实上线平台及其 OAuth、读写、上传、回读验收账号与责任人。
- 确定真实支付宝/微信商户、退款、查询、对账沙箱和财务签署人。
- 要求中转站返回 `cost_cny`（或可审计成本头），完成图片、编辑、视频 canary，并设置 release-bound `MODEL_RELAY_COST_EVIDENCE=true`。
- 基于已恢复的 Git worktree 建立提交/发布/回滚链路，并确定 Secret Manager、云对象存储、KMS、OIDC、告警、PITR 和容量环境。
- 决定运营 CRM 剩余范围：付费生命周期、工单、批量治理和导出。
