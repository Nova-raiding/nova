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

## 2026-10-14 续验记录

本续记保留 10 月 12 日矩阵为历史快照，并记录本次对当前 `main` 与唯一 Demo 的新鲜检查；新旧证据不合并计数。

| 验收范围 | 状态 | 当前证据与边界 |
|---|---|---|
| 当前源码候选 | `426b3db5b76a231217b85b553318c52bbdb0b766`，工作树干净 | `main` 与 `origin/main` 指向该提交。打包时插件源码输入干净；之后本续记文件产生唯一未提交改动。候选变更涉及 API、插件桥接、商家 UI、Ops UI 和共享包；不能按单独插件静态文件更新处理。已检查的候选差异未发现持久化迁移文件；这不代替 live migration chain 核验。 |
| 当前 Demo 运行状态 | 运行健康；候选未获准 | 2026-10-14T00:36:00Z 只读 `deploy:101:status`：`/releasez`、API `/healthz`、`/readyz`、Ops `/healthz` 均为 HTTP 200。API 当前提交 `9b97209c`，商家/Ops UI 为 `a36dda60`，worker 为 `52e30bce`，gateway 为 `88457a96`，payment 为 `811a01a8`，源码版本混合。结果为 `scope=inventory_only`、`release_approved=false`；该字段本身不授予批准。 |
| 容器归属与发布记录 | BLOCKED | 新鲜 inventory 包含 Demo API/UI/worker，也列出 gateway、payment、ClamAV、Postgres、Redis 等运行容器。尚无绑定候选完整 SHA 的当前 owner GO 记录、逐容器 owner 分类、当前 live migration chain 对比与候选回滚身份；依部署 runbook 必须 STOP/NO-GO。本轮没有构建、部署、迁移、重启或改服务器。 |
| 当前插件会话认证 | BLOCKED（缺本地凭据） | Store Nova MCP `workspace_health` 返回 `UNAUTHENTICATED`，未完成健康读取。安装后按正式 `login.sh --workspace ws_guirenniaoniao` 启动本地 PKCE 登录，等待浏览器授权超时并返回 `LOCAL_PLUGIN_LOGIN_TIMEOUT`；没有写入钥匙串凭据。商品检索接口虽返回该工作区数据，但与未认证响应矛盾，故不作为认证或真实业务验收证据。未调用生成、扣点或发布。 |
| 授权流程口径 | 修正 | 当前仓库 `AGENTS.md` 与商家营销 PRD 规定 ChatGPT 侧走本地直装/stdio；远程 ChatGPT OAuth 是历史方案，不是本次上线门禁。Merchant Studio 当前浏览器账号 `demo@sn.com` 显示 QA 标记，工作区 `ws_57fd2361ed5b44c7891f3d37`，与插件请求中的 `ws_guirenniaoniao` 不一致；一键连接入口同时受服务端门禁禁用。没有提交该 OAuth，也没有创建本地凭据。 |
| 本机 arm64 插件安装候选 | PASS（安装与文件校验）；宿主重启/登录待办 | 从 `426b3db5b76a231217b85b553318c52bbdb0b766` 打包并安装 `0.1.3+codex.20261013165836`，内置 Node `v22.16.0`。安装器成功更新本机插件目录和启用配置，提示需重启 ChatGPT、需登录。production 包 provenance 校验通过；73/73 运行文件匹配，134 项工具快照与源码一致；未配置状态下 `workspace.health` 正确 fail-closed 为 `MCP_CONFIGURATION_REQUIRED`。当前会话刷新及工作区登录尚未验证。包：[arm64 本地安装候选](../../artifacts/local-plugin/merchant-marketing-0.1.3+codex.20261013165836-production-darwin-arm64.tar.gz)。 |
| 当前已完成的自动化证据 | 局部通过 | `apps/plugin/install-smoke.test.ts` 29/29、`local-plugin-connect-request.e2e.test.ts` 8/8、`npm run typecheck` 通过；此前媒体目标回归 302 项通过。它们证明对应自动化范围，不证明这轮工作区登录、真实模型生成、商品详情长图展示、视频播放或当前 Demo 部署完成。 |

**当前交付结论：**当前 `main` 已打包并安装到本机 arm64 插件目录，安装包来源、文件完整性和 MCP 工具面 smoke test 通过；ChatGPT 重启后的宿主加载、工作区登录、真实图像/详情页/视频生成交付仍待验收。当前 `426b3db5` 候选的唯一 Demo 部署仍为 NO-GO，须按 `docs/runbooks/ecs-demo-direct-deploy.md` 补齐新鲜容器归属、迁移、回滚和绑定候选 SHA 的 owner GO 证据。

### 2026-10-14 续验补充：ChatGPT MCP 与商品图准入

| 验收范围 | 状态 | 当前证据与边界 |
|---|---|---|
| Store Nova ChatGPT MCP 只读会话 | PASS（只读） | 本轮 `workspace_health` 返回工作区会话状态与商品选择步骤；`commercial_access_get` 标识 `ws_guirenniaoniao` 且允许 recovery control；`billing_status` 报余额已知、可用 12,390 创意点。`catalog_search(scope=workspace)` 读到该工作区的商品。此证据仅说明当前 ChatGPT MCP 只读接口可访问，不代表本机 stdio 插件已完成本地 PKCE 绑定。 |
| 本机 stdio 插件 PKCE | BLOCKED（浏览器身份/工作区不匹配） | Chrome 授权页面针对 `ws_guirenniaoniao` 返回 `MCP_OAUTH_WORKSPACE_AMBIGUOUS`，正文为“本地插件请求与当前账号工作区不一致”；未授权成功，未确认本机钥匙串写入，也未重试其他账号。 |
| 未绑定商品图候选生成 | BLOCKED（请求准入/当前附件） | `merchant_start` 明确等待本条请求的商品图片附件；工作区旧资产有待解析/待权益的素材。随后单次未绑定候选生成尝试被服务端拒绝 `PROTECTED_PRODUCT_MUTATION_BLOCKED`，没有返回 job/visual_ref，未形成图片产物。未对旧素材做事实确认或权益批准，也没有店铺发布。 |
| 当前工作区、余额与商品事实 | 仅作只读核对 | workspace catalog 可见“贵人鸟儿童运动鞋（雾霾蓝）六屏详情候选”，但其平台为未绑定淘宝草稿、商品属性和图片字段为空，canonical 状态为 `legacy_only`，相关知识资产列表为空。不能据此启动正式绑定详情页或商品视频验收。 |

本补充没有改动业务代码；工作树唯一变更仍为本验收文档。真实图像/详情页/视频链路仍需在正确工作区会话中提供当前商品素材，并按产品服务端准入完成可审计的生成测试。不得把 ChatGPT MCP 只读可用等同于本机 stdio PKCE 成功。

### 2026-10-14 代码路径回归与专项测试补充

CodeGraph 1.5.0 的已索引调用边显示 `apps/api/src/mcp-image-handlers.ts::handleImageMcpMethod` 在未绑定图片候选和商品绑定图片请求两处调用 `apps/api/src/protected-product-runtime.ts::requireProtectedProductIntent`，由其进入 `packages/application/src/protected-product-intent.ts::validateProtectedProductIntent`。CodeGraph 的 API/stdio 调用边用于定位链路；其中 application 校验器文件记录的索引时间早于本次改动，故本轮对该文件以当前源码和实际回归测试为准，没有把旧索引当成修复后图谱。

本次请求词“无新增配件”命中受保护商品拦截。TDD 先复现该误判；第一次加宽否定词规则又被对抗用例“无论如何新增商品配件”证明会错误放过肯定修改。最终规则仅把紧邻的“无新增/无添加”当作否定，并保留肯定变更拦截。修复提交：`e2884c277d9d0f2079a3655b1721407048739728`。

| 检查 | 结果 | 边界 |
|---|---|---|
| 受保护商品意图校验 | 71/71 通过 | 新回归覆盖“无新增配件/无添加”、肯定新增、以及“无论如何新增/添加”仍阻断；含原有 65 项规则测试。 |
| 商品主图 API 流程 | 12/12 通过 | 仅本地模拟 provider，覆盖候选归档、读取、审核/选择、受保护事实拦截和正式素材门禁；不代表远端付费模型生成。 |
| 图片 provider 与详情长图尺寸/投影 | 73/73 通过 | 包含 `1024x4096` 长画布请求、模型响应映射、归档辅助、详情编排和投影测试；provider 请求被测试替身模拟。 |
| 视频脚本/分镜/渲染审批/异步费用与 stdio | 96/96 通过 | 6 个单元/API 文件及 3 个 stdio/API 成本和 provider-outcome 文件；渲染 provider 均为 mock，验证一次性授权、异步状态/结算和成本预检契约。 |
| 类型检查 | 通过（全仓；后续 application 包单独重建） | 全仓 `npm run typecheck` 在首轮修补后通过；收窄正则后又运行 `npm run build --workspace @merchant-marketing/application` 成功。 |

这轮只修复商品意图中文否定词识别，没有扩大功能范围。真实素材生成、长详情页图片展示、视频 provider 交付和当前 Demo 部署仍未通过验收。唯一 Demo 的新鲜只读 inventory 于 `2026-10-14T01:40:38.350Z` 显示服务健康、四个探针 HTTP 200，但组件版本混合且 `scope=inventory_only`；容器逐项 owner 分类、候选 SHA 绑定的 owner GO、当前 migration chain 对比、共享锁证明和回滚身份仍未齐，故没有部署。

### 2026-10-14 发布同步与素材拒绝核对

- `e2884c277d9d0f2079a3655b1721407048739728`（意图校验修复）与 `5854c379`（本验收文档）已推送到 `origin/main`；push 返回更新范围 `426b3db5..5854c379`。本机没有 `gh` CLI，故远端 workflow 结果尚未读取；不得把 push 当作 CI 通过或 Demo 部署。
- 唯一 Demo 新鲜状态 `2026-10-14T01:40:38.350Z`：Demo 容器均 reported healthy，四个探针 HTTP 200，当前 release 仍为 `a36dda60`，API `9b97209c`、worker `52e30bce`，存在混合 revision。`scope=inventory_only`；尚缺逐项 owner 分类、候选 SHA 对应 GO、当前 migration chain、锁证明和回滚身份，部署仍 NO-GO。
- 单张未绑定图候选尝试返回 `IMAGE_SOURCE_ASSET_INVALID`，无 job/visual_ref。来源素材记录 `asset_1fe70d63-d081-4d72-8853-65ff4e801870` 显示权益 owned/approved、readiness ready，但扫描状态为 `unscanned`；服务端拒绝原因没有进一步细节，无法据此确认是扫描、文件内容还是其他来源校验。没有继续重试或修改素材权益。
- `creative_points.statement.list` 最近流水显示：`image:qa-image-20261014-01` 在 `2026-10-14T01:36:09Z` 预留并结算实际消耗 1 点；`asset-parse:asset_1fe...:attempt:1` 在 `01:45:08Z` 预留 40 点、`01:45:20Z` 结算 `actual_points=0`。当前可用余额为 12,389。最近流水窗口没有本次 `sn-acceptance-...` 图像请求对应的扣点事件；因此余额变化有独立账务流水解释，不把失败请求记作已生成或已扣点。`billing.transactions` 与 `billing.model-usage.statement` 在本次 MCP 上只返回“请查看当前状态”，以创意点账本作为可见流水证据。
