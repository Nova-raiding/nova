# 用户目标逐项证据审计

审计日期：2026-08-27

最新回归校正：Docker 悬空镜像已清理，业务卷未删除；API/PostgreSQL/Redis/UI/Worker 均健康。迁移链源码、构建产物和数据库均为 1–39，备份恢复验收通过；品/批量运营入口已接入 PostgreSQL 并补齐事务一致性回归；同版本不同 payload 的多副本快照竞态、批量计划/订阅订单/删除请求/用量消费/权益消费/钱包扣款/工作区 bootstrap owner 的幂等与身份意图漂移已修复；素材上传摘要改为服务端计算并校验；Redis/分布式限流验收脚本已改为显式声明所需生产依赖，Redis 恢复脚本失败时会自动恢复 Worker；坏发布快照已隔离，自动化 Worker 已恢复健康；50 个工作区 Compose 验收通过；全量回归 96 个测试文件、645 个测试，MCP 运行态 167 个工具，CodeGraph 为 253 个文件、4,069 个节点、17,783 条边。以下外部平台、支付、relay、云资源和 Codex App 宿主门禁仍按“本地完成、生产待外部”保留。

判定口径：代码闭环和本地测试不等于真实平台生产可用；凡需要真实平台、支付、relay、云资源或 Codex App 宿主行为的项目，必须保留外部门禁。

| 用户目标 | 当前证据 | 判定 |
|---|---|---|
| Codex App 插件入口 | `apps/plugin/.codex-plugin/plugin.json`、MCP bridge、Skill、安装 smoke | 本地完成；真实 marketplace/App 宿主验收待外部 |
| 用户不配置 Codex/业务模型 Key，模型经自有 relay | `scripts/validate-codex-relay.ts`、五模态 relay gate、生产 Skill 禁止宿主 `image_gen` 旁路、模型成本记录 | 代码完成；真实 Codex Responses relay 和业务 relay 未配置，生产阻断 |
| 用户充值后解锁能力 | `billing.recharge.*`、支付回调验签/幂等、钱包账本、能力卡、全量高成本入口钱包门禁 | 本地完成；真实支付宝/微信 provider、查单、退款和回调待外部 |
| 运营后台 | `apps/ops-console`、运营角色、审计、账单、队列、告警、自动化策略、模型/平台 readiness | 本地完成；真实 OIDC、DNS/TLS、通知、OTel/Dashboard 待外部 |
| 下载后第一步绑定店铺 | `merchant.start` 当前步骤 `bind-store`、Skill/README 首步流程、`STORE_ONBOARDING_REQUIRED` | 本地完成；真实 OAuth callback/商家身份绑定待外部 |
| 六个平台、同平台多店铺 | 六平台 profiles、`platform + accountId` 作用域、店铺目录、同平台多店测试和隔离门禁 | 本地完成；六平台真实 OAuth/read evidence 待外部 |
| 商品、SKU、详情、规格、价格 | 商品/SKU 模型、事实确认、价格/库存/属性快照、平台写入字段校验 | 本地完成；真实平台字段映射和回读待外部 |
| 主图/副图生成与素材优化 | 图片 create/optimize、素材权益/扫描/OCR、SKU 图片范围、审核选择、媒体上传 readiness | 本地完成；真实图片模型、对象存储和六平台媒体 canary 待外部 |
| SEO/GEO 标题 | `catalog.title.optimize`、平台长度规则、事实证据、人工接受和重新确认 | 本地完成；真实排名/收录不作承诺 |
| 批量发布 | `publish.batch.prepare/confirm/get/pause/resume/retry_failed`、最多 50 项、父子事务、幂等、失败重试确认 | 本地完成；真实平台 published 回执和跨进程故障演练待外部 |
| 上传后自动化运营 | Automation policy、六平台店铺作用域、定时扫描、同步、风险告警、自动暂停、租约和人工确认边界 | 本地完成；云 Worker、真实连接器和通知到达待外部；禁止无人值守自动发布 |
| 生产发布证据 | 六平台九项 capability（含 `media_upload`）、容量、relay、支付、镜像和配置 preflight | 示例门禁通过；真实 release evidence 尚未提供，不能宣称生产完成 |

## 当前唯一类别的未闭合项

以下不是可由本地代码伪造完成的项目：

1. Codex host relay 与业务模型 relay 的真实 HTTPS 配置、五模态调用回执和成本账单。
2. 六个平台真实 OAuth、全/增量同步、创建/更新、状态查询、撤权、媒体上传及 published 回执。
3. 支付服务商真实 checkout/query/refund/callback 与对账凭证。
4. 50/500 工作区真实云容量、6 小时稳定性、公平性和故障恢复报告。
5. 托管 Secret/KMS、对象存储、OIDC、OTel/告警、值班和回滚演练。

这些项目已有 fail-closed 代码和验收脚本，但必须由真实环境产生证据后才能关闭。

## 本轮代码状态校正（2026-08-27）

最新基线校正：根构建现同步刷新 `@merchant-marketing/persistence` 发布产物，避免源码与 `dist` 漂移；当前全量回归为 93 个测试文件、625 项测试，CodeGraph 为 248 个文件、3,898 个节点、17,096 条边。

审计后又完成的本地闭环：Merchant Studio 已支持多文件素材上传、中文文件名、上传进度和隔离区提示；素材卡片可刷新状态、确认权益、确认事实并发起解析，服务端提供对应 REST 路由；任务理解返回多个商品候选时，页面可直接选择并回填稳定商品 ID。上述能力均不改变安全扫描、事实确认、钱包、模型 relay 或平台写入门禁。

当前回归基线为 93 个测试文件、624 项测试；本轮新增 Merchant Studio 与 Ops Console API 请求超时/取消契约，并覆盖响应体读取阶段，验证浏览器在延迟 API 下及时进入离线状态；同时将 Ops Console Ant Design vendor 按组件拆分，最大单个 JS chunk 约 404KB，并修复 PostgreSQL 月度用量读取跨月不 rollover、订阅读取查询不存在字段的问题；备份恢复验收脚本改为从当前迁移文件动态生成 schema 版本期望值，避免新增迁移后误报失败；此前新增的 Merchant Studio 九项 capability 动态计数回归、Compose/Kubernetes API 代理契约回归、Bearer/OIDC 域名边界回归、Nginx Secret 启动注入回归和 K8s UI/运营台 Nginx 缓存、PID 可写卷契约，补齐 API/Worker Docker 构建上下文与 workspace lockfile 契约、Worker 数据库连接超时契约，并为 `/healthz` 增加数据库活性探针；API 启动依赖初始化失败时立即退出，避免容器处于无监听器的假活状态。上述改动避免显示过时的 `9/8 canary`、部署后页面断 API、商家请求被错误套用 OIDC、镜像固化本机 token、API/Worker 镜像无法重建或只读根文件系统导致启动失败；同时修复规则 E2E 并行 server 关闭竞态，并让生产 preflight 强制声明商家 Bearer 域名。此前文档中的旧测试数属于历史记录，不作为当前验收数字。CodeGraph 当前索引为 248 个文件、3,898 个节点、17,096 条边，状态为 up to date。

## 收尾门禁复核（2026-08-27）

- OIDC 首次安装路径已补齐：有效签名身份可在没有 workspace claim 时仅调用 `workspace.bootstrap` 创建工作区；创建后仍强制 workspace 绑定，安全定向回归覆盖该边界。
- `npm run check`：类型检查通过，91/609 全量回归通过。
- `npm run test:summary`：91/609 通过；50 工作区、400 次 HTTP fake 负载通过，100 次重复发布请求收敛为 50 个唯一发布任务，去重写入 50 次。
- `npm run build --prefix demo/merchant-studio`：前端 TypeScript 与 Vite 生产构建通过。
- `npm run infra:validate`、`npm run evidence:validate`、`npm run capacity:evidence:validate`：全部通过。
- `npm run codex:relay:validate`、`npm run test:model-relay-canary -- --probe`：按 fail-closed 预期阻断，原因是当前环境缺少 Codex host relay、`MODEL_RELAY_BASE_URL`、API key 及五类模型配置；没有伪造成功结果。

## 最新页面缺口修复（2026-08-27）

知识库上传选择器此前遗漏服务端已支持的 DOCX、XLSX、JSON、SVG、AI/EPS 格式；现已补齐文件扩展名、MIME fallback 和契约测试。定向测试 20/20、全量 91/607、前端生产构建和 CodeGraph 同步均通过。

## 当前源码 HTTP 运行态复核（2026-08-27）

在隔离端口 `19001` API + `5176` Merchant Studio 预览上，`test:merchant-studio-smoke` 已通过：UI bundle、六平台 fixture 授权/同步、商品事实确认、多 SKU 选择、任务、内容生成、审核、发布预览和发布确认均通过；发布结果保持为 `queued`，没有伪造 `published`。此前 8793 旧进程的卡住现象未作为当前源码结论。

离线商品演示数据已明确标为“演示数据”，并覆盖六个平台；新增契约测试防止静态样例再次显示为官方 API 或 CSV 来源。最终全量回归为 91/607，CodeGraph 索引保持最新。

概览页离线连接、活动和统计样例也已明确标为演示状态；最终全量回归为 91/607，最新构建 bundle 与隔离 HTTP smoke 均通过。

顶部全局搜索此前是无行为的静态输入框；现已支持 ⌘/Ctrl-K 聚焦、回车跳转商品页并带入商品筛选，输入提示同步收敛为已实现的“搜索商品”，不再虚称任务/版本搜索。定向契约测试、全量回归和生产构建均通过。

## gstack health 质量复核（2026-08-27）

- TypeScript 类型检查：通过，0 个错误。
- Vitest：91 个测试文件、607 项测试全部通过。
- lint、dead-code、shellcheck、GBrain：当前项目未配置或未安装，按 gstack 规则记为 skipped，不伪造质量结论。
- 结论：已配置的自动质量维度没有发现回归；未配置的维度仍是工程治理缺口，不等同于已经检查通过。
