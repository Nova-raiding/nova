# 插件及运营后台上线前全面测试方案与首轮报告

日期：2026-09-14  
范围：ChatGPT 插件、MCP/API、商家后台、平台运营后台、充值与创意点、知识库、数据库/RLS、Worker、发布门禁。

## 上线判定

当前结论：**NO-GO，不具备面向真实用户上线条件**。

已通过的本地证据不能替代真实生产证据。当前必须先解决真实支付、知识库生产检索和生产配置/发布门禁问题，再进行最终 canary。

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

1. **P0：真实充值/支付未完成**

   `billing.recharge.create` 在本地 fixture 条件下可以创建 pending 订单；真实微信/支付宝 provider、HTTPS callback、签名校验、到账 grant、对账和退款证据尚未形成完整生产链路。不能把 fixture 订单或支付成功响应当作到账。该接口必须保持生产 fail-closed，直到 provider readiness 和真实 canary 完成。

2. **P0：知识库生产索引与检索证据不足**

   当前测试证明了契约、审批门禁和租户检查，但主要依赖内存 `KnowledgeModule`/fixture。真实 PostgreSQL 持久化、embedding/index worker、跨副本一致性和插件实际检索证据不足。没有这些证据，不能保证重启后、跨副本和真实商家任务仍只消费已批准知识。

3. **P0：生产发布门禁未全绿**

   `test:release-gates` 当前出现生产配置、Kubernetes digest/ConfigMap/Secret、release metadata、迁移尾、UI 契约等失败。部分失败是仓库测试与当前变更漂移，部分是实际配置缺失；在逐项复核和重新通过前不得发布。

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

- 真实支付 provider、callback、签名密钥、查询/退款/对账接口和生产 canary 全部通过。
- PostgreSQL/RLS/worker 创意点与知识库 release tests 在隔离生产等价环境通过。
- OpenAPI、MCP contracts、source/marketplace mirror、release metadata 和镜像 digest 全部一致。
- 商家与 Ops 浏览器套件在新基线下全绿；所有 console error、5xx、错误权限提示完成归因。
- 运营后台五个失败数据集有真实 API/数据库修复证据，不再依赖上次成功快照。
- 最终运行 `infra:launch-preflight`、`test:release-gates`、生产 canary，并保存 request/trace、支付、模型成本、RLS 和发布回执证据。

