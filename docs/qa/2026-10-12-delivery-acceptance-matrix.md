# 2026-10-12 当前交付验收证据矩阵（owner 最终整合）

唯一目标为 ECS `101 / merchant-demo-85575f9c`。PASS 仅覆盖表内范围；未验证的业务不计通过。本轮按并发上限 6 分批启动 10 个 agent，owner 复核并重跑受影响检查；CodeGraph 用于调用关系与索引核查，gstack 和 pm-verify-feature 用于真实运行验收。

| 验收范围 | 状态 | 当前证据与边界 |
|---|---|---|
| 实际 ChatGPT 本地 stdio 认证读取 | PASS | 正式插件重新绑定后，08:55Z 连续 workspace_health / onboarding_status / workspace_health 成功；业务 needs_input / in_progress。安装版本 `0.1.1+codex.20261012144725`，插件源码 c6d6f771，90文件一致。早期 Background 和宿主失败保留，不推断所有进程上下文均恢复。 |
| 标准重开 ChatGPT | PASS（只读调用） | 标准退出重开后的新会话真实调用 `workspace_health` 成功，返回 `needs_input / provide_materials`；macOS 钥匙串授权由用户在系统窗口完成。证明当前 Aqua 登录域的重启链路，不证明系统重启后的密钥持久恢复或商家资料齐备。见 [收据](../../artifacts/owner-release/2026-10-12-chatgpt-browser/chatgpt-standard-reopen-tool-receipt.json)。 |
| Codex 后台 MCP 连接器 | BLOCKED（宿主凭据） | 本轮只读重试返回 `MCP_CREDENTIAL_SOURCE_TEMPORARILY_UNAVAILABLE`，未向后端发送请求。与上方 ChatGPT 桌面成功调用属于不同宿主上下文。 |
| 宿主中转 Responses | PASS | 实际 deepseek-v4-pro 请求 HTTP200、111 tokens；模型目录403保留。不是商家文本结算/成本证据。 |
| 商家及 Ops 桌面浏览器修复 | PASS | 真实登录后导航、必填校验、零空订单请求、模型验收边界均部署后复测。Ops 真实 platform / ops_admin / rules_admin；企业审计403、平台审计200保持真实 scope。 |
| 风险匹配源码检查 | PASS | 全量 typecheck exit0；环境/模型20、配置24、runner相邻76、财务27及3个浏览器场景、fixture27、目标密码浏览器1；批次重叠不合计。临时容器清理完成。 |
| 唯一 demo 候选部署 | PASS | a36dda6061b3be9f1bc2517083305c8736866469 / release-a36dda60-desktop-ui；共享锁内审查部署，两UI镜像变化，API仅身份刷新。15服务healthy、四探针200；11 canonical及7外部容器保留。 |
| 当前 demo inventory / 新候选部署 | 当前运行健康；本地候选 NO-GO | 2026-10-12 12:16:57Z 只读状态：15 个 canonical 服务 healthy、四探针 200，运行发布仍为 a36dda60；`scope=inventory_only`、`release_approved=false`，应用服务源码修订混合。本地 HEAD 包含 f698e2a6 规则身份修复，但没有绑定当前 HEAD 的 owner GO、迁移比较、共享锁/入口核验和回滚包，也缺少当前主机容器逐项 owner 分类，不能触发部署。 |
| live migration 完整链 | 历史候选 a36dda60 部署核验通过；当前候选待核验 | 已归档的部署比较显示 source/live 各 278 项、逐项相等且版本连续；见 [migration comparison](../../artifacts/owner-release/2026-10-12-chatgpt-browser/deploy-agent/migration-comparison.json) 和 [owner GO receipt](../../artifacts/owner-release/2026-10-12-chatgpt-browser/owner-go-issued.json)，对应候选为 a36dda60。不能替代对新候选的 live 核验或真实 RLS 测试。 |
| 跨租户/RLS/并发 | 隔离 DB 部分通过；demo 待验证 | 2026-10-12 隔离 PostgreSQL fixture 共通过 4 项 RLS/租户隔离测试：outbox tenant boundary、authorization RLS/ACL、legacy products/workspace/brand/account/listing RLS attack matrix、customer-delivery tenant isolation；另有 1 项 worker knowledge-generation fence。两次运行回执：[第一批](../../artifacts/isolated-postgres/run-whtUAy/run-result.json)、[RLS attack matrix](../../artifacts/isolated-postgres/run-f3LAVT/run-result.json)，fixture 均已销毁且 `leftRunning=[]`。仍缺 canonical demo 第二租户真实身份、API 拒绝及并发证据；隔离 fixture 不计 demo 通过。 |
| worker 业务任务及幂等 | 隔离 DB 部分通过；demo 待验证 | worker knowledge-generation fence 在真实 PostgreSQL fixture 中通过（资料重建、权限限制或撤销审批后阻止 provider dispatch）。outbox tenant boundary 已计入上一行 RLS/租户隔离统计，不重复计数。demo 容器健康通过，但未驱动 canonical demo 的真实任务、回调、产物与结算链。 |
| 五模态商家生成与成本 | 离线门禁通过；真实生成待输入/验证 | 本轮重跑 relay/model gate、用量、定价、视频异步结算、预算预检、evidence gate 与 contract 的 9 个测试文件，304 项通过；含直连凭据不能替代 relay 凭据的 fail-closed 回归。没有发送付费商家请求；text/image/image-edit/OCR/video 当前 release 的真实鉴权、provider request ID、usage、人民币 cost 与产物证据仍缺，需测试费用上限、合法素材与可用权益。 |
| 规则及清单对账 | 离线合同通过；demo 待验证 | 本轮组合重跑 platform-rule-sync、storage reconciliation runner、API storage contract 与 API rules E2E，4 个测试文件共 48 项通过；新增 API 回归验证签名规则平台身份冲突时两平台均非 ready，生产生成在 provider/job 前阻断。修复仍未部署。demo 上小红书规则状态仍缺少新鲜只读证据，对象清单对账状态未知、商家资料待补；未执行规则同步或触发对账，也不以静态配置或未知余额计通过。 |

已部署候选仍是 a36dda60。规则身份冲突修复在提交 f698e2a6；其离线测试通过，但该提交及当前工作区改动尚未部署。完整业务验收尚未通过。详见 [运行验收报告](2026-10-12-chatgpt-desktop-backends.md)，历史收据保存在 `artifacts/owner-release/2026-10-12-chatgpt-browser/`。
