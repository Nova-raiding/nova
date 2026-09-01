# 运营后台与 ChatGPT 插件链路验收审计

日期：2026-08-30  
范围：桌面运营后台、ChatGPT 插件入口、`/api/mcp`、API 权限、Postgres/RLS、模型中转、账务和发布门禁。

## 结论

本地真实运行链路可验收，生产上线仍为 NO-GO。运营后台当前包含 13 个业务域；插件用户默认只能查看自己的订单、账单和模型用量，工作区账务必须显式选择并具备授权角色。钱包余额仍属于工作区，个人账务是按订单/流水/用量的 actor 归属过滤，不把余额伪装成个人余额。

本地容器中的五种模型能力已配置并通过 readiness；支付仍是 fixture，不能作为真实收款、退款或支付回调上线证据。

## 已完成的修复

- 账务订单、流水、订阅订单增加创建者/actor 归属；`billing.export`、`billing.transactions`、订阅和模型用量默认 `mine`，工作区范围显式授权。
- `billing.reconciliation` 增加 `workspace_owner`、`merchant_admin`、`finance`、`platform_ops` 运营财务角色门禁。
- 支付 provider 回调在测试环境外不再接受无签名密钥；staging/preview 缺少回调密钥时 fail-closed。生产还必须满足 provider readiness、HTTPS、nonce 和时间窗口。
- 订阅订单使用 `workspace_id + idempotency_key` 的 PostgreSQL 唯一约束和 `ON CONFLICT` 读回；模型 worker 回执必须绑定有效的动作授权，未知、释放、退款或人工终止动作直接拒绝，不写入用量台账。
- 客服/CRM 读取和写入纳入平台运营临时客户数据授权；跨工作区存储对账必须显式声明 `platform_scope=platform`；生产 `/metrics` 必须配置独立 scrape token。
- 运营导航按实际权限收窄：只有 `platform_ops` 看到平台级用户、存储、模型和跨工作区财务页面；租户管理员保留店铺域。
- 运营审计导出按权限显示；店铺授权撤销和退款增加二次确认；存储和商业配置读取失败显示真实错误，不再伪装成“未接入”或可编辑空表单。
- 发布元数据的运营域数量更新为 13，并补充账务桌面浏览器回归用例。

## 角色与账务契约

| 角色 | 默认账务范围 | 工作区账务 | 平台级运营页面 |
| --- | --- | --- | --- |
| 普通成员/operator | mine | 拒绝 | 拒绝 |
| workspace_owner / merchant_admin | mine | 可显式授权 | 仅租户管理域 |
| finance | mine | 可显式授权 | 财务域 |
| platform_ops | mine | 可显式授权 | 平台级运营域 |

个人页面入口：插件中的“套餐与钱包 / 我的订单 / 我的账单”；数据通过 ChatGPT 插件 → MCP → API → workspace/actor 权限过滤返回。运营后台的财务检索用于被授权的运营人员，不应被当作普通用户账单页面。

## 已验证证据

- API 类型检查通过。
- 账务聚焦测试：7 个文件、142 个测试通过；模型 worker 回执与结算测试 13/13 通过，覆盖缺少 action、未知授权、重放和成本缺失。
- 运营后台测试：57 个文件、250 个测试通过；Vite 构建通过。
- 桌面浏览器：运营后台现有 6/6，通过；插件账务回归通过，覆盖个人范围、月份筛选、CSV、键盘、错误状态、XSS 转义和明暗主题对比度。
- 全量桌面浏览器矩阵最终 96/96 通过，覆盖插件主流程、运营后台 13 个域、深链、数据删除、批量发布、成员生命周期和无障碍场景；其中用户目录空结果回归已修复并单独 3/3 通过。
- 交付治理 `Descriptions` 的响应式 `span` 告警已修复；Ops 全流程、域流程和无障碍针对性浏览器回归 19/19 通过，Ops UI 已重建并重新启动。
- 本地 Docker：API、Postgres、Redis healthy；迁移版本 83 已应用，actor 归属列存在；`/readyz` 显示五种模型 readiness 为 true。
- 中转站只读核验：模型目录与 `/api/pricing`、`/api/status` 均返回 200；用户日志分页 6 页、572 条记录完整，全部带 quota/token 字段。API 容器内五模态报价也已实测成功：文本 `deepseek-v4-pro`、图像/图像编辑 `qwen-image-3.0`、OCR `qwen3-max` 使用 VIP 组，视频 `happyhorse-1.1-t2v` 使用 SVIP 组并采用已配置的按秒成本证据。业务文本/OCR canary 已返回 HTTP 200、provider request id、usage 和成本。复核发现媒体 canary 原先始终使用通用 VIP key；现已修复为视频优先使用 `VIDEO_MODEL_RELAY_API_KEY`，无计费参数校验已能到达视频路由并返回 `prompt is required`，因此原视频 HTTP 503 证据需重新用视频专用 key 复测；图片接口仍需真实生成验证。该证据证明读取和成本快照链路可用，不等于供应商发票已完成双边平账。
- Codex 宿主 Responses 真实探测未通过：目录虽声明 `glm-5.2` 支持 `openai-response`，实际 `/v1/responses` 返回 `500 convert_request_failed / not implemented`；宿主顶层配置保持原状，避免切换到已知不可用的 provider。
- Compose 已将 `MODEL_RELAY_ALLOWED_HOSTS` 注入 API；容器内实测为 `ai.wormholexyz.xyz`，避免本地文件配置与运行时安全 allowlist 漂移。
- 全量 Vitest：302 个测试文件中 288 通过、14 按环境/设计跳过；1,938 个测试通过、22 跳过。运营台 57/57 文件、251/251 测试通过；发布门禁 40/40 文件、291 通过、1 跳过。
- `npm run infra:validate`、`npm run release:metadata:validate`、`git diff --check` 通过。

## 上线阻断项

- 告警 Webhook 现要求安全环境配置显式 host allowlist，并复用 outbound URL 私网/本地地址阻断；本地契约测试通过，但真实通知到达和告警值班演练仍缺失。

1. 必须让中转站完成并验证 Responses API 转换（当前真实探测为 `convert_request_failed`），再注入真实 OIDC、支付 provider、五模态中转 provider、密钥/Vault、对象存储、平台 OAuth 和连接器配置，并保留真实请求、鉴权、用量、成本、错误和审计证据。
2. 支付 provider 的真实创建订单、签名回调、查单、退款和对账仍未完成；本地支付是 fixture。
3. `/releasez` 仍需绑定不可伪造的 release id、git sha、manifest、镜像 digest 和各依赖版本；生产门禁不能依赖默认值。
4. 已修正 `infra/local/ensure-app-role.sql` 对平台媒体规格的历史宽表权限；上线前仍需在目标生产数据库执行 merchant_app/merchant_ops 正向与负向 SQL probe，验证最小权限和 RLS。
5. 上线前仍需在真实多副本环境执行订阅并发创建、支付回调重放和 worker 回执重放压测；本地 PostgreSQL 约束已具备，但本地 fixture 不能替代生产证据。
6. 需要接入告警 webhook、生产容量/并发证据、模型成本证据和发布 canary；没有这些证据不得标记 productionGate ready。

## 工具与复核说明

### 2026-08-31 历史 P0 复验

- 真实 Compose 桌面回归 `ops-all.spec.js`：2/2 通过，完整 13 域巡检与模型状态失败 fail-closed 场景均通过；生成的 `ops-all-inventory.json` 记录 HTTP、RPC、请求失败和 console 错误均为 0。
- `ops-data-deletion.spec.js`：3/3 通过，覆盖双击防重、500 后保留输入并可重试、取消申请校验/独立 loading/成功关闭弹窗。旧 `ops-rolef-inventory.json` 中的 P0-003 保留为历史证据，并追加当前复验结果，不再作为当前阻断。
- 这些是本地 Compose/fixture 桌面证据；真实 OIDC、生产数据量、托管 PostgreSQL/RLS、外部通知和正式 ChatGPT 宿主证据仍属于上线门禁。

本轮按 PM 多视角、架构评审、UI/UX Pro Max、前端、后端安全和 QA 六条独立审查线并行检查，owner 复核后整合。CodeGraph 已同步当前 88 个变更文件，并用于运营导航、模型回执调用链和受影响测试分析；它只提供结构关系证据，运行成功仍以 API、浏览器、数据库和容器实测为准。gstack review 在 `main` 分支按其安全规则不能直接宣称 PR review 已完成，故采用其检查清单并以测试、浏览器和容器证据替代。
