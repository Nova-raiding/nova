# Merchant Ops Console 运行手册

## 登录与部署边界

运营后台只支持 Store Nova 平台账号密码登录。账号由受控平台 bootstrap 流程创建，登录后 API 通过 HttpOnly `damai_session` cookie 识别平台会话。不要配置 SSO、OIDC 或网关身份头登录。

ChatGPT 用户端独立使用本地直装 stdio 插件。商家账号密码绑定发生在 Store Nova 本地安装/登录流程中，插件随后使用工作区受限的短期凭据调用 MCP。

## 配置

- `VITE_API_BASE`：生产 MCP/API 的 HTTPS 地址。
- `OPS_AUTH_MODE=password`：生产唯一支持的运营后台认证模式。
- API 生产环境必须配置相互隔离的 `DATABASE_URL` 与 `OPS_DATABASE_URL`。租户请求使用 `merchant_app` 并受 workspace RLS；平台控制面使用 `merchant_ops`，不得访问 tenant tables。
- ECS 和 Kubernetes 生产配置不得包含 `OIDC_PROXY_SIGNING_SECRET` 或 `OPS_AUTH_MODE=oidc`。发布 readiness 会拒绝非 password 模式。
- `MERCHANT_BEARER_HOSTNAME` 必须精确匹配商家 API 域名；此设置不授予运营后台权限，也不能替代账号密码会话或 API 的 workspace 授权。

## 运营能力

运营后台的角色、租户、任务、商家店铺、规则、模型、存储、财务、审计和知识操作均由 API 服务端鉴权。隐藏按钮或前端导航限制不构成授权边界。

当前侧栏和深链接共有 11 个一级域：总览 `overview`、用户与租户 `users`、成员与权限 `members`、任务与内容 `tasks`、商家与店铺 `stores`、规则治理 `rules`、模型服务 `models`、存储与对账 `storage`、账务与退款 `finance`、审计中心 `audit`、知识治理 `knowledge`。功能开关页面已下线，旧地址应返回 404。生产验收逐域覆盖角色可见性、直接 URL、刷新、前进/后退、query 保留和错误恢复。

- 调整套餐名称、月价、年价、店铺额度和任务额度，金额单位为元并保留两位小数。
- 启停六个平台及调整店铺别名；尚未通过生产 readiness 的平台只能保持 fixture/API 或只读状态。
- 查看跨工作区用量、订阅、成员数、钱包余额、充值、消费和退款流水。
- 创建充值退款；服务端要求 `finance`、`merchant_admin` 或 `workspace_owner` 角色，并记录原因与审计。
- 创建或调整工作区成员角色；服务端记录操作审计并执行生产角色门禁。
- 知识治理：查看规则、品牌资产、客户资产、来源、版本、有效期、确认状态和权益状态。
- 学习建议与竞品参考必须展示证据、作用域和权利状态，不会自动激活全局规则或复制受保护内容。
- 内容生成运营查看文案、图片、局部编辑、视频脚本/分镜候选的来源快照、模型版本、检查结果和审核状态。
- 平台驳回队列保留原始回执；修正必须创建新版本，不直接重放旧写请求。
- 失败任务安全重试、异常确认、修正版创建和队列分配都要求原因/操作者上下文并写操作审计。

## API 响应与故障诊断

- 运营台以 `ApiEnvelope` 为传输边界；真实结果、合法空结果、错误和可重试错误必须分别表达。空数组和 JSON-RPC `result: null` 是合法空结果；缺少可识别 envelope/result 的成功响应按 `API_INVALID_RESPONSE` 处理。
- client 保留 `request_id`、`trace_id`、`workspace_id`、`warnings`、`next_actions`、`error.details`、`error.retryable` 与 `Retry-After`。
- 仓储不可用错误不等同于“暂无数据”；检查 API 数据源配置，不回退 fixture 或伪造空列表。
- 只有错误明确可重试、存在有效 `Retry-After`，或 HTTP 状态为 408/425/429/502/503/504 时，client 才标记为可重试。

发布前使用生产构建配置验证账号密码登录、HttpOnly 会话、角色矩阵、跨工作区拒绝和 API 健康状态。不得用本地 fixture 结果代替生产身份库、PostgreSQL/RLS 或真实部署证据。
