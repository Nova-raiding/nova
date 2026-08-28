# Merchant Ops Console 运行手册

## 部署边界

`apps/ops-console` 是独立的 Ant Design 运营后台，不随 Codex 插件打包，也不承担商家端交互。Codex 用户端仍通过插件的 MCP stdio bridge 访问业务 API。

## 配置

复制 `.env.example` 并设置：

- `VITE_API_BASE`：生产 MCP/API 的 HTTPS 地址。
- `VITE_OPS_AUTH_MODE=oidc`：生产构建必须启用；运营台使用 SSO 网关提供的 httpOnly secure 会话并携带 `credentials: include`。未设置时仅允许本地/演示 Bearer 调试模式。
- Kubernetes 生产清单独立部署 `merchant-ops-ui`，访问域名为 `https://ops.merchant.example.com`；API 同时配置 `OPS_AUTH_MODE=oidc`，签名密钥由 `merchant-runtime-secrets` 的 `OIDC_PROXY_SIGNING_SECRET` 注入。商家演示站 `merchant-ui` 与运营台镜像不是同一个应用。
- 本地/演示环境可在页面输入工作区 ID、操作员 ID 和 Bearer token；token 仅保存在当前浏览器 localStorage，不写入构建产物。生产环境必须由 OIDC/SSO 网关建立短时、httpOnly、secure 会话，禁止让运营人员在页面输入或持久化长期 Bearer token。
- 网关下发的 Bearer token 必须包含目标工作区 grant，生产环境不能使用 `*` wildcard。
- OIDC 模式下 API 不信任浏览器直接提交的身份头；SSO 网关必须使用 `OIDC_PROXY_SIGNING_SECRET` 对以下换行分隔字段做 HMAC-SHA256（hex）签名：`HTTP 方法`、`URL path`、`workspace_id`、`subject`、逗号分隔且稳定排序的角色、Unix 秒时间戳。请求携带 `X-OIDC-Sub`、`X-OIDC-Workspace`、`X-OIDC-Roles`、`X-OIDC-Timestamp`、`X-OIDC-Signature`，时间戳容差为 60 秒。首次 `workspace.bootstrap` 是唯一例外：请求必须携带 `X-Workspace-Bootstrap: true`，此时 `workspace_id` 与 `X-OIDC-Workspace` 为空，并将空值纳入签名；创建成功后所有请求都必须携带已绑定 workspace。API 生产配置需同时设置 `OPS_AUTH_MODE=oidc` 和该密钥；缺少任一项会拒绝请求。
- 当商家 UI 与运营台共用 API Service 时，必须额外设置 `MERCHANT_BEARER_HOSTNAME=merchant.example.com`，并在渲染生产配置中声明 `merchant_bearer_hostname`；只有精确匹配该 Host 的生产请求才允许进入商家 Bearer 授权分支，`ops.merchant.example.com` 仍只接受 OIDC 网关断言。该配置不能使用通配符，也不能替代 API token 的工作区授权。

## 运营能力

- 调整套餐名称、月价、年价、店铺额度和任务额度，金额单位为元并保留两位小数。
- 启停京东、淘宝、天猫、拼多多、小红书、抖音及调整店铺别名；小红书/抖音未通过生产 readiness 时只能保持 fixture/API 或只读状态。
- 查看跨工作区用量、订阅、成员数、钱包余额、充值、消费和退款流水。
- 创建充值退款；服务端要求 `finance`、`merchant_admin` 或 `workspace_owner` 角色，并记录原因与审计。
- 创建或调整工作区成员角色；服务端记录操作审计并执行生产角色门禁。
- 知识治理：查看规则、品牌资产、客户资产、来源、版本、有效期、确认状态和权益状态。
- 学习建议：查看平台驳回/客户反馈产生的建议证据、作用域和影响范围；确认建议不会自动激活全局规则。
- 竞品参考治理：查看公开来源、获取时间和权利状态；仅允许差异化参考，不允许复制原文、Logo、包装或受保护图片。
- 内容生成运营：查看文案、图片、局部编辑、视频脚本/分镜候选的来源快照、模型版本、检查结果和审核状态。
- 平台驳回队列：按工作区、平台、店铺、商品、任务和内容版本定位原始回执，并关联新修正版；原始写请求不可直接重放。
- 队列处置：失败生成可执行安全重试；驳回/未知发布可确认异常；驳回内容可创建待审核修正版；generation/publish 队列项可分配负责人，使用 revision 做并发保护。处置、分配都要求原因或操作者上下文并写入操作审计；视觉候选另由 `ops.marketing.visual.review` 执行通过/阻断。

## 新增后台模块的推荐操作顺序

1. 先确认工作区、角色和 Bearer token grant，再进入知识或任务队列。
2. 对规则/资产/竞品资料先检查来源、版本、有效期和权益状态。
3. 对学习建议先查看证据和影响范围，再选择确认或驳回；不要把一次反馈直接升级为全局规则。
4. 对图片、视频和文案候选先查看关联的品牌/商品/规则快照及检查结果，再发起人工审核。
5. 平台驳回必须保留原始错误码、字段路径和回执；通过新内容版本修正，不能复用旧写请求。

后台能力分期：商业化/平台/审计/告警为 P0；知识规则和资产审核、学习建议、竞品权利审核、内容候选队列为 P1；跨工作区聚合、批量治理和视频成片运营为 P2。

## 发布前检查

1. API 使用生产 `NODE_ENV=production`，并配置真实 Bearer token 验证和 workspace grants。
2. `VITE_API_BASE` 使用 HTTPS，CORS 允许运营台域名但不允许任意来源。
3. 支付使用 provider 模式，回调地址和验签密钥引用通过生产配置门禁。
4. 运营台构建产物只包含 API 地址，不包含 token、支付密钥、OAuth secret 或平台凭证。
5. 发布前确认运营台 API 已开放知识治理和任务队列所需 MCP 方法，并完成角色矩阵测试；前端不能通过隐藏按钮绕过服务端权限。
6. 生产环境验证规则、资产和竞品数据在 API 重启后仍可从业务快照/outbox 恢复；不能依赖浏览器缓存或单进程内存。
7. 运营台显示的是安全投影：不输出模型 Key、平台 access/refresh token、支付密钥或原始生产证据文件。

## 本轮运行核验边界（2026-08-26）

- 当前源码的运营平台和 MCP 平台参数统一覆盖六个平台；若连接到旧的 8787 运行实例仍看不到小红书/抖音，必须先重新部署 API，不得据此判断源码状态。
- PostgreSQL migration 已统一将所有后续 workspace-scoped 表的 `workspace_id` 对齐为 `workspaces.id text`，并提供 033 兼容迁移修复已有 UUID 列与 RLS 策略；使用干净数据库和既有数据库各自重跑 migration/fixture 验收后，才能更新本地运行证据。
- Codex CLI 插件只读尝试发生模型侧超时，未执行任何写操作；Codex App 可视化连接在当前会话不可用。
