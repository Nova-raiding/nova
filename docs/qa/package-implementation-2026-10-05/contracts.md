# 共享商业契约与本地 stdio Bridge 实施记录

日期：2026-10-05。范围：共享 MCP/schema、商业/HTTP 精确准入注册表、动作 RBAC、OpenAPI、源码 Bridge。不是生产链路验收结论。

## 已写入代码

- 套餐生命周期加入 submit/reject/archive/delete_draft、必填 expected_revision、指定 version_id、family/tier_rank/cycle_json/bundle_refs_json；购买增加 upgrade_quote_id/checkout_id/onboarding_order_id。
- 新增精确方法：商家升级报价 create/get、当前与未来套餐查询、商业通知；Ops 权益定义、权益包列表/版本变更/引用；代购 preview/create、Ops 升级报价；收款、分配预览/确认、返款提议/决策/完成、未知归属收款登记/列表/绑定。
- 商家旧 purchase_kind=upgrade 无 quote 在共享验证和真实 Bridge 参数验证阶段拒绝，不能按全价创建升级订单。客户端不能提交金额或权益。
- getMcpMethodPolicy(method, params) 按审批、发布、编辑动作选择独立权限；未传 params 的静态注册仍提供 fail-closed draft policy，API owner 必须传实际参数。
- 收款权限拆为 commercial.receipt.record/allocate/return.propose/return.approve/return.complete，仅平台管理员、运营管理员、平台财务默认授予；租户角色不授予。
- 所有新 MCP 方法明确注册商业分类；商家恢复方法只加入精确 allowlist。新 HTTP 商家路由在 HTTP authz、商业注册与 OpenAPI 同步声明。
- 商业错误安全投影保留 field_errors/blockers/business_reason/order_id/upgrade_quote_id，经现有深度/长度/密钥路径脱敏边界处理；不暴露任意 payload。

## 验证

命令见 contracts-tests.log：6 文件、110 测试通过，含实际共享验证拒绝旧升级、禁止客户端价格、revision、独立动作权限、分页上限与精确恢复列表。`node --check apps/plugin/mcp/bridge.mjs` 和所拥有文件 `git diff --check` 通过。

先前 surface 测试观察到源码与安装镜像未同步、API/OpenAPI 接线未完成，以及既有入口 skill 引用 creative.directions 不可达。安装镜像依 owner 整合步骤同步，本 agent 未写安装缓存。

## gstack review 复核与未完成证据

依 gstack review checklist 检查枚举消费者、参数信任边界、精确注册和权限作用域；修复新方法未注册 authz/HTTP classification 的实际测试失败。新增注册不等于 handler 已完成。

仍由 owner 完成：API 中央动态动作 policy 参数接线、所有方法真实 PostgreSQL/RLS 与桌面运行、当前插件/受支持旧插件/回滚兼容服务器三版本矩阵、实际安装镜像同步、真实通知 worker 与支付/代购闭环。当前 110 测试不证明这些外部链路。

## 整合追加：原子首购、原请求恢复、合款与支付确认

- 新增商家/Ops 的 order.request.get、upgrade.quote.request.get、checkout.request.get，参数仅原幂等键（Ops 再加明确目标 Workspace），schema 不接受自报 actor；实际 API 查询必须绑定真实创建 actor。
- 新增商家 checkout.create 和 Ops checkout.preview/create；输入仅两个 SKU 与审计/幂等/服务器确认 hash，复用后端原子首购两笔依赖明细实现。
- 新增 Ops receipt.allocations.preview/confirm。allocations_json 长度不超过 33000，1–100 项，每项只能包含 receipt_id/order_id/amount_fen/expected_revision；金额是正整数分、revision 非负整数，租户与授予字段拒绝。
- 新增 commercial.order.payment.create，在确认冻结订单明细后才申请支付资源；不以创建订单直接打开付款链接，不通过重试延长订单期限。
- sale_state 统一真实目录投影 unlisted/on_sale/off_sale/archived/deleted。
- 新确认 HTTP 路由同时登记 OpenAPI、HTTP authz 与商业精确分类。安装镜像仍留给 owner 整合。

验证：contracts-followup-tests.log 中 6 文件共 112 测试通过，比基线新增原子首购/actor 注入拒绝/批量收款上限、字段和整数约束/预览 hash 必填的两组行为测试；源码 Bridge 语法与所拥有文件 diff whitespace 检查通过。仍未用契约测试替代实际数据库、安装插件及生产支付验收。

## 实际 HTTP 路由统一处理器

新增 `http-commercial-routes.test.ts`，19 项测试通过（http-commercial-tests.log）。HTTP 套餐目录、升级报价、当前/未来套餐、商业通知、原子首购及原请求恢复、普通订单和显式支付资源路径现在实际调用 `callCommercialMethod`，由 server 注入同一 `handleCommercialMcpMethod` 及完整真实依赖。HTTP 不再直接走旧全价 purchase.create；无 quote 升级、客户端金额/身份/租户字段、无效分页及损坏路径会在调用商业仓储前拒绝。缺统一适配器明确 503。测试也执行实际共享目录处理器，证实仅 current on_sale approved executable 当前版本输出，合法空目录返回 200 空数组。

权限入口仍由 server 的既有 HTTP authz 前置执行，模块继续用可信请求绑定的 Workspace 调用共享处理器；单元测试不声称证明真实账号/RLS、生产支付或桌面界面。全项目类型检查与真实运行由 owner 合并验收。

## 精确 worker 与免费支持登记注册

新增 signed worker-only `POST /v1/internal/commercial/notifications/tick` 精确 HTTP machine policy，分类 MACHINE_INFRASTRUCTURE。新增 Worker `automation.tick.execute` 与 `knowledge.embedding.execute` 两个精确操作，POINT_REQUIRED_NO_CHARGE，分别消费 `feature.automation` / `feature.knowledge`，不替换既有模型预算/计费。

商家支持登记是专属 HTTP `POST /v1/support/requests` 与 `GET /v1/support/requests/{ticketId}`。仅这两个 exact recovery 操作可以免点数访问，identityOnly 身份入口仍要求 server 实际 session 与 active membership，caller-owned ticket 由支持处理器验证。没有复用平台 Ops 创建授权，没有新增免费通配符。OpenAPI 输入与实际支持处理器长度/UUID校验一致；共享商家支持 DTO 不允许客户端指定身份、企业或优先级。

`contracts-worker-tests.log`：4 文件 33 测试通过；新增4项测试验证通知只允许 exact worker POST、两个业务 Worker 的非收费功能权限映射、支持两个 exact 身份恢复操作且不能访问后代/错误 verb。测试证明注册和映射，不证明部署后签名、会员和所有权真实闭环；实际消费者由 owner 接线验收。

## C6 运行协议证明探针注册

精确注册 public readonly `GET /internal/commercial-runtime-attestation` 为 infrastructure / MACHINE_INFRASTRUCTURE，并加入 OpenAPI。无 POST/HEAD 或子路径隐式允许。该探针仅用于逐个 API/api-replica 容器 loopback 的进程、sales protocol、已验证 manifest hash 与实际数据库迁移 checksum hash 核对，不返回用户事实或秘密，不作为商业交易完成证据。

`runtime-attestation-contract-tests.log`：3 文件28测试通过；新测试验证 exact GET infrastructure 分类、无 MCP 商业权限引用及错误 verb/descendant 拒绝。响应生成、DB实际checksum读取及部署helper逐副本采集由 root 实现与真实运行验收。此次没有重复全仓构建。

## 平台支持工作台与租户支持分开

实际 QA 发现原 `ops.support.ticket.get` 是 workspace scope/workbench，平台 session 访问会硬拒绝 AUTHZ_WORKBENCH_MISMATCH。这是边界保护，不能通过伪造租户请求头绕过。

新增三个明确 platform scope 方法：`ops.support.platform.tickets.list`、`ops.support.platform.ticket.get`、`ops.support.platform.ticket.comment`。每个都必须指定 target_workspace_id，原 workspace 支持策略保留；新请求拒绝 params.workspace_id/actor/role 伪造。读复用 support.ticket.read，评论/客户回复复用实际既有 support.ticket.update，追加 revision/idempotency 约束，分类为 OPS_CONTROL。源码及项目源镜像 Bridge 保持这些 Ops 工具不对商家 tools/list 暴露；OpenAPI 精确枚举同期补齐。

root 明确授权 platform_admin 获得支持回复所需 support.ticket.update；没有添加财务审批权限。新增正例与 merchant/workspace_owner/admin/operator 平台工作台拒绝反例。

platform-support-contract-tests.log：3 文件57测试通过，含新增5个 schema/策略/实际 evaluator 行为测试。列表及回复真实 target Workspace 二次授权、服务数据所有权与平台 UI 由 application/DX/root 实现验收。发布元数据只按实际源读取，目前383 methods、131商家tools；Ops domain count 等实际导航落盘再采集，不预写规划值。

### Notification read-state contract follow-up

Added exact `commercial.notifications.mark-read` with only `notification_id` and an 8–128 character original idempotency key. Strict schema rejects caller workspace/member/actor, read timestamp, financial amount and order fields. Shared notification DTO preserves publication fields and adds `notification_kind` (`catalog_publication`/`purchase_result`), nullable `read_at`, optional `order_id`, and exact `result_state` (`active`/`scheduled`/`awaiting_dependency`/`reconciliation_required`). Event ID and cursors remain opaque.

Root approved central authorization: `billing.self.read` capability, self scope, metadata **write**, idempotency obligation. This grants no order/payment/entitlement authority. Exact MCP/HTTP operations are non-charged `RECOVERY_CONTROL`; HTTP is authenticated `POST /v1/commercial/notifications/{notificationId}/read`. Visibility and trusted active-member ownership are enforced by worker repository/API owners, not inferred from DTO existence.

Source Bridge and repository mirror expose the method with non-destructive, idempotent write annotations and explicit safe-without-financial-confirmation behavior. It remains outside the read-only set. Transport preserves bound authentication/workspace headers and explicitly omits caller `params.workspace_id` for this exact method; explicit workspace argument is rejected. Retry uses the same original idempotency header/key. Tool description states no orders/payments/entitlement changes.

46 targeted tests passed across notification, package and authorization contracts (`notification-contract-tests.log`); includes actual source child stdio tools/list discovery, strict parameter negatives and exact authenticated HTTP registration. No API/PG fixture or global typecheck ran. Existing 0.2.7/131-tool installed proof is retained and does not prove this new 132-tool source or a refreshed host snapshot. Per root, no metadata bump/package/install until migration 264 and final commercial sources freeze.


### Frozen migration 264 registration and metadata

Registered `264_commercial_result_notifications_and_reads.sql` in the actual `loadMigrations()` SQL reader and ordered production migration array. The new tail test compares the loader output with actual file bytes, checks the complete contiguous 1–264 sequence and the frozen SHA-256 `ef962eb7ef1cba894f622b32e7b43962b6ccdb121b1ddbba822f404d57fbe83a`. Existing loader tail assertion advances to 264. The frozen SQL was not edited.

Release metadata is synchronized to source/expected migration 264, actual MCP methods 384 and actual merchant tools 132, retaining repository 0.2.7/plugin 042504 and all historical installed evidence. `release:metadata:validate` passed. Five targeted files passed 43 tests (`migration-264-registration-tests.log`), covering migration tail/checksum, existing migration integrity, notification contract/source stdio, and release metadata. No PostgreSQL or global typecheck was started, and no bump/package/install was performed.

SQL review found the new notification read idempotency table permits 8–128 character keys. Only mark-read's shared schema, Bridge schema and OpenAPI were aligned to 128, preserving the frozen SQL and rejecting a 129-character key. This registration evidence is not proof that migration 264 ran against PostgreSQL, that ACL bootstrap is complete, or that the already-installed 131-tool plugin contains the new method.
