<!-- /autoplan restore point: /Users/lixiaomei/.gstack/projects/codexSkills/main-autoplan-restore-20260908-092104.md -->
# 用户登录、付费开通与创意点系统设计

Status: DRAFT_FOR_GSTACK_REVIEW
Date: 2026-09-08
Scope: ChatGPT 插件、商家运营后台、平台管理后台的统一身份、会话、付费开通与创意点入口

> **产品决策已更新（2026-09-09）**：本设计稿中的“外部 OIDC/OAuth、邀请制、业务 API 不自建密码库”是历史草案，不再是用户可见登录方案。请以 [《大麦商家营销平台产品总文档》](../damai-product-master-document.md) v2.0 为准：平台运营和商家均使用大麦账号密码；ChatGPT 仍可在底层使用 OAuth/MCP 协议，但密码只在大麦授权页输入。本文仅保留可复用的会话、权益和账务状态机，认证实现必须先完成 v2.0 Phase 1 决策。

> **执行边界**：下文保留用于追溯 2026-09-08 的历史讨论；凡出现“OIDC 直登、只允许邀请、排除自建密码、充值已完成或插件展示预计扣点”，均不得作为当前开发/验收依据。当前唯一可执行认证和商业状态以总文档 §6、§15、§24–§26 为准。

## 问题

项目已经具备 OIDC 代理证明、会话投影、成员生命周期、能力权限、RLS 和本地 OIDC 端到端测试，但当前云端 pilot 仍依赖静态 Bearer token，并且用户看不到完整的登录、退出、会话续期、邀请接受和身份切换体验。结果是后台可以运行，却不能安全地交给真实商家、平台管理员或 ChatGPT 用户使用。

## 用户结果

- 商家从 `ops.yxsona.com` 登录后只进入自己的工作区。
- 平台管理员从 `admin.yxsona.com` 登录后只进入平台控制台。
- ChatGPT 用户连接“大麦”时复用同一身份，并绑定服务端判定的工作区。
- 会话过期、账号未邀请、缺少权限、工作区停用和网络故障都显示明确恢复动作。
- 浏览器、ChatGPT 和 API 不保存或暴露平台测试 token。

## 历史待确认前提（已由 v2.0 覆盖）

1. ~~正式身份源采用外部 OIDC/OAuth 2.1 服务，不在业务 API 内自建密码库。~~ 已改为大麦账号密码；OAuth/MCP 仅保留为 ChatGPT 宿主授权协议。
2. ~~商家账号采用邀请制。~~ 已改为商家默认自助注册后待审核，邀请链接只是同一身份流程的可选入口；平台运营账号仍由 Owner 预置。
3. `admin` 与 `ops` 是两个入口和默认权限边界，但最终授权只信任服务端会话与持久化权限，不信任域名或前端参数。
4. 单人 pilot 先接入一个真实身份提供商账号，但会话、租户和角色模型保持可扩展，不做单用户硬编码。
5. ChatGPT App 使用远程 HTTPS MCP + OAuth；网页登录和 ChatGPT 授权共享主体身份，但使用独立客户端和回调地址。
6. 5000 元是一次性正式开通/系统接入费，不是任意金额钱包充值；必须绑定服务端批准且不可由客户端改价的入驻 SKU。
7. 正式开通包含连续 6 个月、每月 500 个 AI 创意点；1999 元是仅定向提供、不对外公开的 7 天验证 SKU，验证结束后 7 天内正式购买可抵扣 5000 元系统接入费。

## 现有商业能力审计

| 能力 | 当前状态 | 证据与缺口 |
|---|---|---|
| 任意金额钱包充值 | 仅历史兼容 primitive | 旧 `billing.recharge.create` 不是正式入口；不得用于 ChatGPT 商业准入。 |
| 服务端 SKU 下单 | 本地订单 primitive 存在 | `commercial.order.create` 可创建批准 SKU 的 V2 订单快照，但当前没有正式 checkout resource/UI。 |
| 支付到账后发放创意点 | 底层账本 primitive 存在 | 原子记账路径存在；微信/支付宝 provider、checkout、回调验签、退款和对账尚无生产证据。 |
| 按使用扣除创意点 | 已实现核心账本闭环 | 执行前冻结报价并预占；中转成功后必须有 provider request、真实 usage、成本证据才结算；失败释放，未知结果保持待对账。 |
| 5000 元首次开通 | 商业规则已由正式资料确认，运行配置未发布 | 一次性系统接入费，包含连续 6 个月、每月 500 创意点；当前代码中的入驻 SKU 仍为 draft、`executable: false`，需要完成排期、有效期与审批后发布。 |
| 1999 元 / 7 天验证 | 商业规则已确认，运行配置未发布 | 私有测试 SKU：1 个品牌、1 个店铺、500 创意点、1 小时一对一服务、完整核心功能和一次效果复盘；验证结束后 7 天内正式购买可抵扣 1999 元。 |
| 运营按用户开通 | 身份治理与商业只读证据已存在，主流程未闭环 | 用户目录支持搜索、停用/恢复和身份治理；商业工作台能看订单、grant、权益和账本，但支付对账、目录发布等写入口仍明确保持 BLOCKED。 |

## 推荐的最简用户体验

1. 用户在 ChatGPT 或大麦商家后台打开大麦账号页，用账号密码登录；ChatGPT 底层只执行受限 authorization code 交换。
2. 系统自动建立主体与 workspace 关联；用户只看到名称、登录账号和短账号编号，不需要复制内部 UUID。
3. 未开通时，普通用户只显示“支付 5000 元正式开通”；被授予私有验证资格的用户才显示“1999 元 / 7 天验证”，不在公开目录展示。
4. 支付 provider 签名回调成功后，系统原子完成订单 paid、创意点到账、商业权益生效和 access revision 更新；用户刷新或自动轮询后直接进入工作台。
5. 回调延迟时显示“支付确认中”；支付已成功但 grant 缺失时显示“到账异常，已进入人工处理”，不要求用户再次支付。
6. 后续充值只购买批准的创意点包；插件仅显示余额是否足够和恢复动作，不显示预计/实际扣点数；数值明细仅在商家后台展示。

运营人员通过账号、名称、订单号或 workspace 搜索用户。内部 user ID 仅用于审计和关联，不作为用户必须理解或人工搬运的凭据。正常支付不需要运营手工开通；运营台只负责邀请、例外审核、支付/grant 对账和经双人审批的点数调整。

## 在线支付与线下转账状态机

```text
账号密码已登录 / workspace 已绑定
              |
              v
      选择服务端批准的 5000 元 SKU
              |
       +------+------+
       |             |
   在线支付       银行转账
       |             |
 provider 签名    上传凭证/流水号
       |             |
       |        运营确认实际到账
       |             |
       +------v------+
        verified payment fact
              |
              v
  PostgreSQL 单事务：paid + entitlement + grant + ledger + access revision + outbox
              |
       +------+------+
       |             |
    全部成功       任一步失败
       |             |
   自动开通       整体回滚并进入对账
```

线下转账不能直接调用 `workspace.activate` 或 `ops.user.activate` 代替商业开通。这两个现有方法只代表恢复被停用的 workspace/身份，不代表已经收款。平台后台应新增“确认线下到账”命令，要求目标订单、金额、币种、银行流水号、到账时间、凭证引用、原因、期望订单 revision 和幂等键；服务端把运营确认转换为受审计的 verified payment fact，再复用 `recordVerifiedPaymentAndGrant`。

单人 pilot 允许同一平台运营人员提交并确认，但响应必须标记 `single_operator_pilot`，并保留完整审计。生产配置默认要求 maker/checker 为不同主体；不能通过前端参数关闭双审。

## 权限分层

- `authenticated_pending_activation`：可以登录、查看账号、订单、支付状态、协议和帮助，不能生成、扫描、同步或发布。
- `commercial_active`：存在可执行 entitlement、已知创意点余额和最新 access revision，才允许进入收费能力。
- `suspended`：身份或 workspace 被安全/运营停用；即使有余额也不能执行。
- `reconciliation_required`：支付事实与 grant/access revision 不一致，只允许查询和提交恢复材料。

商业准入由订单、权益、点数和 access revision 共同决定，不新增一个容易漂移的布尔“已开通”字段。

## 已确认的商品与权益

### 5000 元一次性正式开通

- 插件账号开通。
- 连续 6 个月，每月发放 500 个 AI 创意点，共 3000 点。
- 系统部署与基础调试。
- 平台固定规则、商品品类规则和大促节点规则的配置与接入。
- 一次系统使用培训。
- 上线验收和基础问题处理。
- 用户使用偏好、一个企业主体、店铺自动扫描、商品自动扫描、品牌基础资产、品牌表达与视觉要求的知识库录入。
- 支持淘宝、天猫、京东、拼多多、抖店、小红书。
- 品牌、店铺和商品首次录入数量受后续购买的月度套餐上限约束。

明确不包含：品牌资料人工整理、大量历史素材清洗、超出月度套餐上限的额外品牌接入、非标准平台开发、客户内部 ERP/商品系统接入、私有化部署和人工代做营销素材。

### 1999 元 / 7 天私有验证

- 仅对明确需要测试的客户定向开放，不在公开定价页或通用 ChatGPT 安装流程展示。
- 1 个品牌、1 个店铺、500 个 AI 创意点、1 小时一对一服务、完整体验核心功能和一次效果复盘。
- 验证结束后 7 天内购买 5000 元正式开通 SKU，订单自动应用 1999 元抵扣，实付 3001 元；抵扣只能使用一次，不能提现或叠加。
- 超过 7 天未购买则抵扣资格过期；验证 workspace 保留审计数据，但收费能力按权益结束时间关闭。

现有 `private_trial_credits_v2.amount_fen = 500000` 把“目标正式订单金额”和“抵扣金额”混为一个字段。迁移时必须保留原事实并新增明确字段：`target_order_amount_fen = 500000`、`credit_amount_fen = 199900`、`payable_amount_fen = 300100`；服务端从验证订单和正式 SKU 快照计算并校验三者，客户端不能提交或覆盖金额。

### 发点排期

- 正式订单支付并完成开通时立即发放第 1 期 500 点。
- 后续 5 期按开通日的月度周年日发放；短月取当月最后一天。
- 每期必须有独立 schedule、grant、幂等键和账本事件，补偿任务只能补发缺失期次，不能重复发点。
- 每期 500 点在下一期发放时过期，不跨月累计；第 1 至第 5 期的 `expires_at` 等于下一期 `due_at`。
- 第 6 期在第 6 个服务月结束时过期；之后不再赠送。开通日为月末或目标月份没有同日时，统一取目标月份最后一天。
- 调度器必须先执行到期，再发放新一期，并分别写入 `expired` 与 `granted` 账本事件；同一 workspace、正式订单和期次只能成功一次。
- 服务暂停或身份停用不会延长点数有效期；退款、合同取消与恢复策略必须通过独立审批规则处理，不能修改历史 grant。

## 关键失败模式

| 失败 | 系统处理 | 用户/运营恢复动作 |
|---|---|---|
| 转账金额不是 5000 元 | 不确认订单、不发点 | 核对差额或退款后重新确认 |
| 同一银行流水号重复提交 | 幂等返回原结果；内容不一致则冲突 | 查看原订单，不重复开通 |
| 运营确认到账但 SKU 已失效 | fail closed，不读取旧目录价格 | 发布新的批准 SKU 或退款 |
| paid 但 grant/access revision 缺失 | 状态为 `reconciliation_required` | 进入支付与 Grant 对账，不让用户再次付款 |
| 模型成功但用量/成本证据缺失 | 保留预占，不交付最终结果 | 中转对账补证据，禁止重跑上游 |
| 模型明确失败 | 释放预占 | 用户可安全重试 |
| 身份被停用但商业余额仍有剩余 | 阻断所有收费执行 | 平台安全复核后恢复身份 |

## 工程落点

```text
OIDC/session gateway
  -> identity lifecycle + membership
  -> activation projection (derived, no mutable boolean)
  -> commercial.order.create
       -> approved catalog snapshot
       -> online provider callback
       -> offline transfer confirmation (new)
            -> commercial contract transaction
                 -> entitlement snapshot
                 -> creative point grant/ledger
                 -> access revision/outbox/audit
  -> commercial access guard
       -> worker preflight reservation
       -> model relay usage/cost receipt
       -> settle / release / reconcile
```

新增代码优先复用 `PostgresCommercialContractRepository.recordVerifiedPaymentAndGrant`，不再造第三套充值账本。旧 `billing.recharge.*` 只保留历史兼容和财务对账，并从 ChatGPT 原生商业入口继续隐藏。

## 已有能力复用

- `apps/api/src/server.ts`：OIDC 代理签名校验、nonce 防重放、会话投影和 fail-closed 配置检查。
- `packages/persistence/src/identity-lifecycle-repository.ts`：身份与成员生命周期持久化。
- `packages/persistence/src/authorization-repository.ts`：持久化授权和审计。
- `apps/ops-console/src/api/opsClient.ts`：managed session 模式、同源 Cookie 请求与工作台边界。
- `apps/ops-console/src/pages/OpsConsoleController.tsx`：未认证恢复提示、登录入口和权限验证门禁。
- `tests/local-oidc-gateway.ts`、`scripts/run-ops-oidc-e2e.ts`：隔离的登录、Cookie、CSRF、签名身份和浏览器 E2E 基础。

## 建议架构

```text
用户浏览器 / ChatGPT
        |
        v
统一 OIDC 身份提供商
        |
        +--> admin.yxsona.com -> 平台会话网关 -> ops-console(platform)
        |
        +--> ops.yxsona.com   -> 商家会话网关 -> ops-console(workspace)
        |
        +--> mcp.yxsona.com   -> ChatGPT OAuth/MCP 网关 -> API /mcp
                                      |
                                      v
                          身份映射 + 成员关系 + 权限投影
                                      |
                                      v
                           API/MCP + PostgreSQL RLS + 审计
```

网关完成 OIDC Authorization Code + PKCE、HttpOnly Secure Cookie、CSRF、刷新与退出；API 只接受网关签名且防重放的身份声明。工作区和角色由数据库成员关系计算，前端参数不能授予权限。

## 用户流程

1. 用户打开对应入口。
2. 未登录时看到用途明确的登录页，不显示后台空壳。
3. 登录后服务端解析主体身份并查找成员关系。
4. 只有一个可用工作区时直接进入；多个时显示工作区选择；没有时显示“等待邀请/申请加入”。
5. 会话即将过期时静默刷新；刷新失败时保留当前路径并要求重新登录。
6. 退出时撤销服务端会话、清除 Cookie 并返回对应登录页。

## 失败与恢复

| 场景 | 用户看到 | 系统行为 |
|---|---|---|
| 未登录 | 登录按钮与入口用途 | 不加载任何业务数据 |
| 登录回调失败 | 原因和重试 | 丢弃 state/code，不创建会话 |
| 未受邀 | 等待邀请/联系管理员 | 不自动创建平台或商家权限 |
| 多工作区 | 明确选择列表 | 服务端校验选择是否属于当前身份 |
| 权限不足 | 当前身份和所需权限 | 返回 403 并记录拒绝审计 |
| 会话过期 | 重新登录，保留返回路径 | 清除失效 Cookie，不降级到测试 token |
| 工作区停用 | 工作区已停用和联系入口 | 阻断 MCP、后台和 worker 写操作 |
| 身份源不可用 | 暂时无法登录 | 已有会话按有效期运行，新登录失败关闭 |

## 实施范围

- 新增账号密码 credential、注册、登录、重置、刷新、退出和当前会话端点。
- 新增 ChatGPT authorization code/PKCE 网关，并与同一大麦 identity 绑定。
- 新增商家自助注册后待审核、可选邀请接受和多工作区选择流程。
- 将 `admin`、`ops`、`mcp` 三个入口绑定到明确客户端和回调地址。
- 更新运营台未登录、无权限、过期和退出体验。
- 更新 ChatGPT App OAuth 元数据与安装说明。
- 发布一个 5000 元首次开通 SKU，明确它是可抵扣充值、服务费还是保证金，并固化对应创意点、有效期、退款和重复购买规则。
- 将签名支付成功与 workspace 商业权益激活、创意点 grant 放入同一幂等事务，并增加 paid-but-ungranted 自动对账。
- 将运营用户搜索、订单、支付、grant、权益和 access revision 串为同一用户时间线；正常订单自动开通，异常才提供受审计的人工恢复动作。
- 将后续充值统一迁移到 V2 创意点包，停止用历史钱包余额决定 ChatGPT/MCP 商业准入。
- 增加 API、数据库、浏览器、MCP 和容器级验收。

## 不在本次范围

- 短信验证码、微信/支付宝社交登录和企业 SSO 直登。
- 社交登录聚合。
- 手机和平板布局。
- 未获得平台批准前的真实商品发布。

## 验收标准

- 无静态测试 token 时，真实大麦账号密码用户可完成注册/登录、刷新、退出、重置和重新登录。
- 商家用户不能进入平台工作台，平台用户不能凭域名参数获得商家数据。
- 两个租户的 API、MCP、数据库/RLS 和审计证据互不泄漏。
- ChatGPT 工具扫描与首次连接使用 OAuth，缺少工作区时由服务端安全引导。
- 所有失败状态有问题、原因和唯一恢复动作。
- 未支付或金额不匹配时不能开通；同一支付回调重放不会重复发点或重复授权。
- 5000 元订单支付成功后，订单、权益、创意点 grant 和 access revision 可从同一 trace 对账；任何部分缺失都 fail closed。
- 每次模型执行在服务端都有 quote、预占、provider usage/cost、最终扣点或释放证据；插件不展示数值，商家后台可审计；余额不可为负，未知 provider 结果不可重复执行。
- 商家无需输入内部 ID；运营可按人类可识别账号找到用户，并看到开通状态和唯一恢复动作。
- 桌面浏览器 E2E 与容器健康检查通过。
