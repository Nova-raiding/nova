# 插件及运营后台上线前全面测试方案与首轮报告

日期：2026-09-14  
范围：ChatGPT 插件、MCP/API、商家后台、平台运营后台、充值与创意点、知识库、数据库/RLS、Worker、发布门禁。

## 上线判定

当前结论：**NO-GO，不具备面向真实用户上线条件**。

已通过的本地证据不能替代真实生产证据。当前必须先解决真实支付、知识库生产检索和生产配置/发布门禁问题，再进行最终 canary。

### 2026-09-15 续验更新（11:05 +08:00）

结论仍为 **NO-GO**，但此前“支付对账 worker 路由缺失”和本地确定性发布门禁失败已在当前工作区得到修复与复验：

- 当前源码指纹下，真实 API HTTP → 签名 reconcile worker → PostgreSQL application role → Redis 工作区租约的隔离验收通过。覆盖未签名／错误角色／跨租户拒绝、支付只入账一次、退款成功／失败／未知、并发互斥、租约替换后 fail-closed 和持久审计。外部支付边界为本轮独立 localhost 状态 stub，真实支付和真实退款调用均为 0，因此不构成支付宝生产 canary。证据：`artifacts/payment-reconciliation/run-DhXjCp/run-result.json`；自建 PostgreSQL／Redis 已清理，`leftRunning=[]`，未触碰共享容器。
- 定向回归 9 文件 229 项通过；全项目 `npm run typecheck` 通过；`npm run test:release-gates` 退出 0，共 128 文件／597 项通过。该默认入口中的 7 个 PostgreSQL 文件按设计跳过，不能算真实数据库证据。
- 新建隔离 PostgreSQL 17 后，完整 `npm run test:postgres:isolated` 共 20 文件／21 项全部通过，包含迁移 210 的 MCP OAuth 主体绑定、RLS／ACL 最小权限和跨成员商业支付隔离。证据：`artifacts/isolated-postgres/run-Yr6axi/`，自建容器已全部清理。
- 当前源码重新执行桌面 Chrome 1440×900 验收，账号签名展示、工作台跨租户拒绝、平台只读客服查看客户交付共 4 项通过，无跳过／重试，并生成 shot-scraper PNG 和 WebM。证据：`artifacts/ops-jit-isolation/2026-09-15T03-02-20.977Z-6fdfe3fd-650b-4cf9-a7ba-04c9e81ededd/`；自建 PostgreSQL／Redis `leftRunning=[]`。
- 共享本地 API、replica、六类 worker、PostgreSQL、Redis、ClamAV 和两个 UI 当前均为 healthy，但共享数据库迁移尾仍是 209，而工作区新增迁移尾为 210；这只证明旧部署健康，不证明本轮源码已经部署。

仍阻断上线的事实：真实 ChatGPT 插件连接读取引导状态和历史任务均返回权限拒绝，无法恢复商家任务；本轮源码／迁移 210 尚未部署到共享或生产环境；支付宝真实小额支付、回调、查单、退款和对账证据仍缺；知识库生产索引／跨副本检索与五模态真实中转成本证据仍缺；没有目标生产配置文件，因此未执行最终 `infra:launch-preflight` 和生产 canary。以上任一项未补齐前不得给 GO。

## 测试矩阵

| 模块 | 核心场景 | 必须验证的事实 | 通过门槛 |
|---|---|---|---|
| 安装 | marketplace 安装、manifest、Skill 加载 | 版本、入口、镜像字节一致 | 安装后新会话可发现插件 |
| MCP | initialize、tools/list、resources/list/read | 认证、工具枚举、引导资源、无 Ops 泄漏 | 与共享 contracts 逐项一致 |
| 引导 | onboarding.status → workspace → OAuth → 商品 → 素材 → 内容 → 发布 | 每一步状态、绑定对象、阻断与下一步真实可执行 | 不使用 fixture 冒充真实状态 |
| 商家工作流 | 商品读取、素材扫描、知识读取、任务、审核、发布 | 租户、店铺 account_id、版本和确认哈希 | 全链路可恢复且 fail-closed |
| 充值 | 目录、下单、支付回调、查询、对账、退款 | 金额、币种、点数、grant、access_revision | 真实 provider、签名回调、对账证据齐全 |
| 消耗 | 并发预留、结算、失败释放、重复请求 | 不超扣、不跨租户、不把 unknown 当成功 | PG + worker release tests 通过 |
| 知识库 | 规则/资产/学习读取与消费 | 来源、审批、权益、版本、租户隔离 | 真实持久化索引和跨副本检索通过 |
| 商家后台 | 登录、概览、知识库、商品、任务、发布、账务 | 空态、错误态、账号范围、写权限 | 桌面浏览器无阻断错误 |
| 平台运营后台 | 总览、用户、财务、任务、知识、授权、模型 | 超级管理员权限、数据集刷新、错误呈现 | 无错误数据、无隐藏权限阻断 |
| 基础设施 | API/DB/Redis/ClamAV/Workers、迁移、RLS | 健康、迁移尾、镜像 digest、Secret 绑定 | release gates 全绿 |

## 执行顺序

1. **安装与握手**：安装插件，开启新 ChatGPT 会话；验证 `initialize`、`tools/list`、`resources/list`、`resources/read`，确认 `onboarding.status` 可见且 `ops.*`、内部扫描工具不向商家暴露。
2. **配置引导**：在无工作区、无 token、无平台授权、仅账号记录、授权过期、撤权和真实 OAuth 成功六种状态下调用 `onboarding.status`，核对状态、绑定说明、下一步方法和错误码。
3. **商家只读链路**：按平台和 `account_id` 读取店铺、商品、素材、规则、知识资产、学习记录和任务历史；验证空态与跨租户拒绝。
4. **商家写链路**：上传素材并等待扫描；确认商品事实；创建任务；生成、审核、修改、批准；执行 `publish.prepare` → 明确确认 → `publish.confirm` → `publish.get`。任何 queued/unknown 不得显示成功。
5. **账务链路**：读取 `billing.status` 和 `commercial.catalog.get`；在 provider ready、provider missing、支付待确认、签名回调成功、grant 未到账、重复回调、退款和对账异常下验证状态转换与用户提示。
6. **知识库链路**：创建/审批规则和资产，验证来源与版本；在任务生成前读取规则、资产、pending learning；拒绝来源缺失、权益未知、跨租户或旧版本上下文。
7. **运营后台**：使用平台超级管理员、运营、财务、只读账号分别访问用户、财务、任务、知识、模型和授权页面；核对数据集刷新、空数据、权限错误、导出和审计。
8. **生产门禁**：运行类型检查、契约测试、PG/RLS release tests、容器健康、镜像与 Secret 校验、API/worker/plugin canary；只在全部门禁和真实外部依赖证据齐全后给 GO。

## 本轮实际结果

### 已通过

- 容器：API、API replica、UI、Ops UI、PostgreSQL、Redis、ClamAV、六类 worker 均为 healthy。
- TypeScript 类型检查通过。
- 插件 install/host/scheduled/contract 基础套件通过。
- MCP contracts、authz、native HTTP 相关测试通过。
- 账务/创意点/知识库单元与 API 组合测试：155/155 通过；扩展 API 组合测试 125/126 通过。
- OpenAPI、MCP parity、plugin manifest、surface contract 修复后 24/24 通过。
- `verify-installed-bridge`：源码与 marketplace 19 个运行文件一致，151 个商家工具，无 forbidden/duplicate tool。
- bridge 真实 JSON-RPC：`initialize`、`resources/list`、`resources/read(onboarding-v1)` 成功。

### 真实上线阻断

1. **P0：真实支付 canary 证据未完成（配置已恢复）**

   101 主机的支付宝生产配置、私钥/公钥、provider checkout/query/refund、HTTPS callback、对账和退款开关均已确认存在，payment-gateway 健康检查返回 200。当前缺的是一笔真实小额支付及其 callback、查单、退款、对账回执；本地 fixture 订单不能替代该证据。`billing.recharge.create` 在真实 canary 完成前继续保持 fail-closed。

2. **P0：知识库生产索引与检索证据不足**

   当前测试证明了契约、审批门禁和租户检查，但主要依赖内存 `KnowledgeModule`/fixture。真实 PostgreSQL 持久化、embedding/index worker、跨副本一致性和插件实际检索证据不足。没有这些证据，不能保证重启后、跨副本和真实商家任务仍只消费已批准知识。

3. **P0：生产发布门禁未全绿**

   `test:release-gates` 当前出现生产配置、Kubernetes digest/ConfigMap/Secret、release metadata、迁移尾、UI 契约等失败。部分失败是仓库测试与当前变更漂移，部分是实际配置缺失；在逐项复核和重新通过前不得发布。

   本地容器复核另外发现 6 个 worker 均为 unhealthy；日志显示数据库迁移链期望到 198、实际已到 199，导致 worker 持续重试。该迁移尾漂移必须在隔离数据库和 release gate 中统一后才能上线。

4. **P1：浏览器全链路未通过**

   Merchant browser suite 22 项仅 4 项通过；主要是旧测试寻找已删除的旧导航/标题，但仍需更新测试基线并重新验证真实页面。Ops browser suite 被 `ISOLATED_FIXTURE_MIGRATION_CHAIN_MISMATCH` 阻断，尚未形成平台运营后台真实验收证据。

5. **P1：部分 bridge 测试受环境与陈旧断言影响**

   `bridge.test.ts` 中失败项包括 launchd 注入 token 导致的远程确认、已禁用商业操作仍被旧断言期待、旧支付卡片和 loopback HTTP 被正确拒绝等。需统一测试环境与当前安全契约，不能直接把这些结果标为产品通过。

## 数据正确性专项

- 所有店铺数据必须以 `platform + account_id` 为复合范围；不能用店铺别名、列表第一项或旧缓存替代。
- `balance_state=unknown` 时余额必须为 `null`，不能显示为 0；待支付、已受理、queued、unknown 不得显示为到账/成功。
- fixture、账号记录、官方 API、撤权和 refresh_required 必须分别标识，不能混算为真实用户或真实店铺。
- 知识规则、资产和学习记录必须带来源、状态、版本和更新时间；pending、权益未知、来源缺失和跨租户内容必须 fail-closed。
- Ops 总览数据集刷新失败时必须显示失败数据集、原因、时间和是否使用旧快照，不能静默展示过期数字。
- 用户、财务、任务和授权页面的统计数字必须能回溯到同一查询范围和 request/trace id。

## GO 前置条件

支付宝真实接入按[生产接入 runbook](./payment-provider-production-runbook.md)执行；未完成六类 provider canary 证据时，支付能力保持 fail-closed。

- 真实支付 provider、callback、签名密钥、查询/退款/对账接口和生产 canary 全部通过。
- PostgreSQL/RLS/worker 创意点与知识库 release tests 在隔离生产等价环境通过。
- OpenAPI、MCP contracts、source/marketplace mirror、release metadata 和镜像 digest 全部一致。
- 商家与 Ops 浏览器套件在新基线下全绿；所有 console error、5xx、错误权限提示完成归因。
- 运营后台五个失败数据集有真实 API/数据库修复证据，不再依赖上次成功快照。
- 最终运行 `infra:launch-preflight`、`test:release-gates`、生产 canary，并保存 request/trace、支付、模型成本、RLS 和发布回执证据。
