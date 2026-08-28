# 全功能上线验收与闭环计划（2026-08-28）

<!-- AUTOPLAN STATUS: REVIEWED — NO-GO -->

## 目标

对 Merchant Studio、平台运营后台、API/MCP、Worker、数据库、模型中转、六平台连接器、支付商业化和部署运维进行完整的组件级与运行态验收；覆盖正向、反向、边界、权限、故障恢复、可访问性和 UI/UX。只有真实证据闭环的能力才能标记为可上线。

## 当前事实基线

- `npm run check`：105 个测试文件、725 项测试通过；类型检查、Ops Console 和 Merchant Studio 生产构建通过。
- 运行态：Merchant Studio `:18081`、API `:8787`、PostgreSQL、Redis、5 类 Worker 健康；Ops Console 测试实例 `:18082`。
- 浏览器：8 项综合回归通过。商家端 7 个一级模块、8 个页面状态、9 组安全交互；运营台总览、用户、任务、店铺、账务 5 个页面均已真实加载。用户目录桌面、键盘、390px、375px 和 844×390 横屏通过；移动菜单、表单错误聚焦、详情焦点归还和模型状态失败态已覆盖；正确同源代理配置下为 0 console error、0 failed request、0 RPC error。
- 运维：基础设施配置、Compose 资源门禁、生产运维合同、备份恢复、故障语义、标准化投影通过。
- 模型：容器 DNS 修复后，真实文案与 OCR 请求返回 200，均有 usage；OCR canary 的 1×1 测试图缺陷已改为 16×16 并补回归。生产成本门禁已改为 fail-closed，当前因中转回执缺 `cost_cny` 显示 `cost_gate_blocked`。
- 用户治理：已增加 `ops.users.list`、`ops.user.detail`、`ops.user.suspend`、`ops.user.activate`、服务端筛选/分页、跨工作区成员目录、身份摘要、成员历史、操作原因、自停用保护、角色层级门禁与审计；状态、角色变化和审计在 PostgreSQL 同一事务内提交，并增加 revision 冲突保护。迁移 044 提供事务内平台目录 RLS scope，非平台 scope 实测仍返回 0 行。成员治理已从账务页移到独立“用户与租户”导航。
- 开发体验：增加 `dev:doctor`、`dev:doctor:production`、`dev:ops-console`、`dev:stack` 并固定 Node 22+；本地诊断 12 pass/6 warn/0 fail，生产诊断 12 pass/1 warn/5 fail，明确区分容器 Relay 与宿主 Relay，并对无 Git、无 buildx、无持久 Relay、无真实生产配置 fail-closed。

## 已证实的上线阻断

1. 当前目录不是 Git 仓库或 worktree，无法形成可审计变更、提交、发布分支和回滚链路。
2. 根目录没有 `.env` 或托管 Secret 注入证据；API 重建后 `MODEL_RELAY_BASE_URL` 与 `MODEL_RELAY_API_KEY` 已实际丢失，证明昨天配置只在旧容器临时存在；宿主 `codex:relay:validate` 同样失败。
3. 模型中转不返回 `cost_cny` 或成本响应头，文案/OCR 的 `costObserved=false`；“实际成本 × 倍率”的账务规则不能闭环。
4. 图片生成、图片编辑、视频生成尚未执行真实计费 canary，也没有 release-bound evidence。
5. 平台运营后台现可跨工作区治理成员关系，但仍没有独立全局身份、登录会话、角色历史、风险与付费生命周期模型；当前目录不能冒充完整用户中心。
6. 生产配置仍为占位模板；`infra:production-gate` 与 `launch-preflight` fail-closed。
7. 六平台真实 canary 未运行；真实 OAuth、读、写、图片上传、写后回读和回执证据缺失。
8. 真实支付商户、退款、查询和对账证据缺失。
9. 真实云容量、6 小时稳定性、PITR/KMS/对象存储/OIDC/告警链路证据缺失。

## 产品与信息闭环要求

### 商家端

- 店铺授权 → 商品同步 → 商品事实确认 → 素材治理 → 任务创建 → 方向确认 → 内容生成 → 审核 → 发布预览 → 二次确认 → 平台回执 → 失败修正版/重试，必须逐步可恢复。
- 每个阻断状态展示原因、责任方、下一步、重试入口和支持路径。
- 钱包、套餐额度、加购权益、模型实际成本、倍率、预扣、结算、退款和对账必须一致。

### 平台运营端

- 新增平台级用户中心：`user_id/external_subject`、注册来源、状态、最后登录、风险状态、所属工作区、角色、付费状态和生命周期操作。
- 用户、工作区、成员关系分层；平台管理员可跨租户检索，工作区管理员只能管理本工作区。
- 补齐用户详情、封禁/解封、邀请/撤权、角色历史、登录会话撤销、工单、受审计代操作和数据导出。
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
| Ops Console | 有 | 通过 | 五页、用户交互、390px 通过 | 完整身份中心缺失 | 未上线 |
| API/MCP | 172 个 MCP 工具 | 725 项测试含契约 | 健康 | 外部平台/支付缺失 | 部分完成 |
| Workers | 5 类 | 运维/故障测试通过 | 健康 | 长稳与真实队列缺失 | 部分完成 |
| PostgreSQL/恢复 | 44 迁移 | 备份恢复与平台 RLS scope 通过 | PostgreSQL ready | 云 PITR 缺失 | 部分完成 |
| 模型中转 | 五模态适配器 | 单测及 fail-closed 通过 | 文案/OCR 真实 200，状态阻断正确 | 成本、三类媒体缺失 | 未上线 |
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

## GSTACK REVIEW REPORT

| Review | Runs | Status | Score | Main findings |
|---|---:|---|---:|---|
| CEO | 1 | complete | 5/10 | 建议先完成一个主平台闭环；缺 Git、真实支付/平台证据与成本闭环时不可发布。 |
| Codex / outside voice | 1 | complete | 5/10 | 本地工程质量已显著收口，但外部生产证据不能由测试替代。 |
| Engineering | 3 | complete | 7/10 | 已修复 marketplace 漂移、跨租户操作 scope、平台目录 RLS、owner/platform 角色越权、成本 fail-closed、成员/审计原子事务与 revision 冲突；独立身份/会话模型仍缺。 |
| Design | 3 | complete | 7/10 | 已增加独立用户导航、身份详情/历史、双层成员治理、筛选分页、状态文案、移动菜单、错误隔离、表单错误聚焦、详情焦点归还和三种移动视口；仍缺会话、风险、付费和批量治理。 |
| DX | 2 | complete | 5/10 | 已固定 Node 22+ 并增加统一 doctor/stack/Ops 命令；仍无 Git、buildx、持久 Secret 和可渲染真实生产配置。 |

**VERDICT: NO-GO（本地可验证门禁通过，生产发布门禁未通过）**

已验证的收口结果：`npm run check` 为 105/105 文件、725/725 用例；两个前端生产构建通过；8 项真实浏览器回归覆盖运营后台五页面、模型错误态、用户详情键盘流程、移动菜单、表单错误聚焦和 390px/375px/横屏；API 健康；跨租户成员治理、平台 RLS scope、角色层级和原子审计在最终容器生效。示例 capability/capacity JSON 能通过结构门禁，但生产运行时明确拒绝把 example 当作 release evidence。

**UNRESOLVED DECISIONS:**

- 选择首个真实上线平台及其 OAuth、读写、上传、回读验收账号与责任人。
- 确定真实支付宝/微信商户、退款、查询、对账沙箱和财务签署人。
- 要求中转站返回 `cost_cny`（或可审计成本头），完成图片、编辑、视频 canary，并设置 release-bound `MODEL_RELAY_COST_EVIDENCE=true`。
- 恢复 Git/worktree 与发布/回滚链路，确定 Secret Manager、云对象存储、KMS、OIDC、告警、PITR 和容量环境。
- 决定完整身份中心的数据模型和范围：持久全局身份、会话撤销、角色历史、风险、付费、工单、批量治理和导出。
