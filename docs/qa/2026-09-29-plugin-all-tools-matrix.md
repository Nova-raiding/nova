# Store Nova 已安装插件全工具验收矩阵（2026-09-29）

口径：下表以升级前本地直装版本 `0.1.0+codex.20260929074100` 的 131 项商家工具为分母，追踪本轮对每项工具的结果。131 项精确名称来自已认证 `tools/list`，与升级前安装缓存一致。随后已安装 `0.1.0+codex.20260929083842`：安装器逐文件校验 53 个运行文件，源码及缓存的实际 `tools/list` 均为 **119 项**，只移除表中标记的 12 项；完整重启 ChatGPT 后，新 Work 会话成功调用 `onboarding.status` 与 `catalog.search`，见[升级后 App 截图](evidence/2026-09-29-chatgpt-app/26-upgraded-119-tool-plugin-app-readonly.png)。无图形会话的终端无法读取托管 Keychain 凭据；终端鉴权使用用户提供的演示账号换取进程内短期 MCP 凭据。发现工具、参数 schema 校验或本地单测均**不算业务成功**。

状态：**App 成功**＝真实 ChatGPT 桌面会话看到生产业务结果；**生产 MCP 成功**＝认证后 stdio→生产 API 返回对应业务结果，尚未有对应 App 画面；**预期阻断**＝真实负向/权限/缺资源响应，仅证明安全边界；**产品门禁/后台办理**＝服务端明确转交商家后台，不能算 ChatGPT 内功能成功；**线上缺陷**＝真实请求错误且不符合契约；**本地契约**＝只见候选源码或测试；**未测试**＝没有可认定的生产/App 业务成功路径；隔离测试结果仅在备注中列出。较早桥接版本的结果在备注中单独标注。

**计数：** App 成功 16；生产 MCP 成功 18；预期阻断 26；产品门禁/后台办理 3；线上缺陷 1；本地契约 10；未测试 57；合计 131。当前已安装 `0.1.0+codex.20260929090000` 的源码与缓存各暴露 **116** 项；它在上一版 119 项基础上继续隐藏 3 项无法工作的分片上传工具。116 项版本尚待 ChatGPT 完全重启后复验，不把安装验收算作 App 业务成功。

当前生产仍为 API `release-demo-product-code-20260929`、DB 迁移 254；API 与商家网页修复尚未部署。表内“隐藏”12 项在新安装的本地插件中已实际隐藏。此表不宣称旧 131 项全通过，也不把运营后台 CSV 导入算作 `catalog.import` 插件工具成功。

| # | 精确 MCP 方法 | 升级前结果级别 | 当前已安装版本 | 前置条件 / 实际结果 | 证据 |
| ---: | --- | --- | --- | --- | --- |
| 1 | `onboarding.status` | App 成功 | 保留 | App 真实返回；无必填参数；当前 119 工具版本的新 ChatGPT Work 会话再次成功 | [App 工作区](evidence/2026-09-29-chatgpt-app/20-chatgpt-work-five-readonly-tools.png)；[新版 App 复验](evidence/2026-09-29-chatgpt-app/26-upgraded-119-tool-plugin-app-readonly.png) |
| 2 | `commercial.service-boundary.accept` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`policy_version`, `policy_checksum`, `acceptance_ref`, `accepted_at`, `idempotency_key`；隔离 PostgreSQL/支付 fixture 验证，非真实支付或生产写入 | [账务隔离 E2E](evidence/2026-09-29-chatgpt-app/billing-write-isolated-audit.md) |
| 3 | `merchant.start` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；无必填参数 | — |
| 4 | `merchant.first_value` | 生产 MCP 成功 | 保留 | 仅 example=true 静态预览成功；收费 draft=true 路径曾失败；无必填参数 | [工作区只读审计](evidence/2026-09-29-chatgpt-app/workspace-onboarding-readonly-audit.md) |
| 5 | `brand-unit.list` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [品牌规则只读审计](evidence/2026-09-29-chatgpt-app/brand-rule-readonly-audit.json) |
| 6 | `brand-unit.create` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`name` | — |
| 7 | `brand-unit.bind-store` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`brand_id`, `platform`, `account_id` | — |
| 8 | `brand-unit.product.create` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`brand_id`, `title` | — |
| 9 | `brand-unit.listing.create` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`brand_id`, `canonical_product_id`, `platform`, `account_id` | — |
| 10 | `brand-unit.listing.list` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [品牌规则只读审计](evidence/2026-09-29-chatgpt-app/brand-rule-readonly-audit.json) |
| 11 | `brand-unit.access.grant` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`brand_id`, `external_subject`, `role` | — |
| 12 | `canonical.product.consistency` | App 成功 | 保留 | App 真实返回；无必填参数 | [App 知识库](evidence/2026-09-29-chatgpt-app/21-chatgpt-work-knowledge-readonly-top.png) |
| 13 | `campaign.batch.create` | 预期阻断 | 保留 | 已安装插件的本地交互写门禁返回 `INTERACTIVE_WRITE_DISABLED`，未写入；写会话打开后的成功路径待测；必填：`brand_id` | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md) |
| 14 | `campaign.batch.list` | 生产 MCP 成功 | 保留 | 已安装插件 stdio→生产 API 返回 `items=[]`；真实计划详情待测；无必填参数 | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md) |
| 15 | `campaign.batch.get` | 预期阻断 | 保留 | 以不存在的测试计划 ID 返回 `CAMPAIGN_BATCH_NOT_FOUND`；成功读取真实计划待测；必填：`campaign_id` | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md) |
| 16 | `campaign.batch.pause` | 预期阻断 | 保留 | 已安装插件的本地交互写门禁返回 `INTERACTIVE_WRITE_DISABLED`，未写入；写会话打开后的成功路径待测；必填：`campaign_id`, `expected_revision`, `idempotency_key`, `reason` | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md) |
| 17 | `campaign.batch.resume` | 预期阻断 | 保留 | 已安装插件的本地交互写门禁返回 `INTERACTIVE_WRITE_DISABLED`，未写入；写会话打开后的成功路径待测；必填：`campaign_id`, `expected_revision`, `idempotency_key`, `reason` | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md) |
| 18 | `workspace.health` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [工作区只读审计](evidence/2026-09-29-chatgpt-app/workspace-onboarding-readonly-audit.md) |
| 19 | `workspace.invitations.list` | 预期阻断 | 保留 | 生产返回 FORBIDDEN；本地候选已修只读门禁，角色权限待复核；无必填参数 | [工作区审计](evidence/2026-09-29-chatgpt-app/workspace-onboarding-readonly-audit.md) |
| 20 | `workspace.invitation.accept` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`expected_revision` | — |
| 21 | `workspace.interactive.confirm` | App 成功 | 保留 | 生成前交互确认；需具体 request_id/操作；必填：`confirmation` | [App 生成与账务](evidence/2026-09-29-chatgpt-app/09-postdeploy-draft-settled.png) |
| 22 | `workspace.metrics` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [工作区只读审计](evidence/2026-09-29-chatgpt-app/workspace-onboarding-readonly-audit.md) |
| 23 | `commercial.access.get` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [账务只读审计](evidence/2026-09-29-chatgpt-app/billing-readonly-audit.md) |
| 24 | `commercial.catalog.get` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [账务只读审计](evidence/2026-09-29-chatgpt-app/billing-readonly-audit.md) |
| 25 | `commercial.order.create` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`purchase_kind`, `sku_code`, `idempotency_key`, `reason`；隔离 PostgreSQL/支付 fixture 验证，非真实支付或生产写入 | [账务隔离 E2E](evidence/2026-09-29-chatgpt-app/billing-write-isolated-audit.md) |
| 26 | `commercial.order.payment.get` | 预期阻断 | 保留 | 虚构订单 ID 返回 COMMERCIAL_ORDER_NOT_FOUND；真实订单读取待测；必填：`order_id`；隔离 PostgreSQL/支付 fixture 验证，非真实支付或生产写入 | [账务审计](evidence/2026-09-29-chatgpt-app/billing-readonly-audit.md)；[账务隔离 E2E](evidence/2026-09-29-chatgpt-app/billing-write-isolated-audit.md) |
| 27 | `creative-points.balance.get` | App 成功 | 保留 | App 真实返回；无必填参数；隔离 PostgreSQL/支付 fixture 验证，非真实支付或生产写入 | [App 五接口](evidence/2026-09-29-chatgpt-app/20-chatgpt-work-five-readonly-tools.png)；[账务隔离 E2E](evidence/2026-09-29-chatgpt-app/billing-write-isolated-audit.md) |
| 28 | `creative-points.statement.list` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [账务只读审计](evidence/2026-09-29-chatgpt-app/billing-readonly-audit.md) |
| 29 | `support.customer.replies.list` | 预期阻断 | 保留 | 缺任务/订单/工单 ID 返回 INVALID_REQUEST；成功路径待测；无必填参数 | `/tmp/storenova-plugin-qa-20260929/read-basic-output.jsonl` |
| 30 | `subscription.get` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [账务只读审计](evidence/2026-09-29-chatgpt-app/billing-readonly-audit.md) |
| 31 | `subscription.orders.list` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [账务只读审计](evidence/2026-09-29-chatgpt-app/billing-readonly-audit.md) |
| 32 | `billing.export` | 产品门禁/后台办理 | 保留 | 返回商家后台办理或查看入口；ChatGPT 内未完成明细/导出；无必填参数 | [账务只读审计](evidence/2026-09-29-chatgpt-app/billing-readonly-audit.md) |
| 33 | `workspace.data.export.request` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`reason`, `idempotency_key` | — |
| 34 | `workspace.data.export.get` | 线上缺陷 | 保留 | 非法 UUID 在线上返回 500 INTERNAL_ERROR，属缺陷；本地候选修为 400，尚未部署；必填：`request_id` | [工作区审计](evidence/2026-09-29-chatgpt-app/workspace-onboarding-readonly-audit.md) |
| 35 | `platform.settings.get` | 预期阻断 | 隐藏（12 项之一） | 生产返回 FORBIDDEN；新安装版本已隐藏平台工作台能力；无必填参数 | [平台与规则审计](evidence/2026-09-29-chatgpt-app/platform-rule-audit.md) |
| 36 | `platform.media.spec.list` | 预期阻断 | 隐藏（12 项之一） | 生产返回 FORBIDDEN；新安装版本已隐藏平台工作台能力；无必填参数 | [平台与规则审计](evidence/2026-09-29-chatgpt-app/platform-rule-audit.md) |
| 37 | `platform.media.spec.get` | 预期阻断 | 隐藏（12 项之一） | 商家缺 `platform.media_spec.read`，生产 MCP 403 `FORBIDDEN`；新安装版本已隐藏。使用不存在的 QA ID，未读取真实规格；必填：`id` | [平台与规则审计](evidence/2026-09-29-chatgpt-app/platform-rule-audit.md) |
| 38 | `platform.media.spec.create` | 本地契约 | 隐藏（12 项之一） | 升级前暴露，当前 119 工具版本已隐藏；无当前商家成功路径；必填：`platform`, `placement`, `device`, `version`, `spec_json`, `source_url`, `source_sha256`, `checked_at`, `expected_revision`, `idempotency_key`, `reason` | [桥接隐藏集](../../apps/plugin/mcp/bridge.mjs) |
| 39 | `platform.media.spec.update` | 本地契约 | 隐藏（12 项之一） | 升级前暴露，当前 119 工具版本已隐藏；无当前商家成功路径；必填：`id`, `patch_json`, `expected_revision`, `idempotency_key`, `reason` | [桥接隐藏集](../../apps/plugin/mcp/bridge.mjs) |
| 40 | `platform.media.spec.approve` | 本地契约 | 隐藏（12 项之一） | 升级前暴露，当前 119 工具版本已隐藏；无当前商家成功路径；必填：`id`, `expected_revision`, `idempotency_key`, `reason` | [桥接隐藏集](../../apps/plugin/mcp/bridge.mjs) |
| 41 | `platform.media.spec.expire` | 本地契约 | 隐藏（12 项之一） | 升级前暴露，当前 119 工具版本已隐藏；无当前商家成功路径；必填：`id`, `expected_revision`, `idempotency_key`, `reason` | [桥接隐藏集](../../apps/plugin/mcp/bridge.mjs) |
| 42 | `platform.mapping.preflight` | 本地契约 | 保留 | 候选本地调用返回 `INTERACTIVE_WRITE_DISABLED`；方法可能写映射审批和审计，未对生产执行；必填：`input_json` | [平台与规则审计](evidence/2026-09-29-chatgpt-app/platform-rule-audit.md) |
| 43 | `billing.status` | App 成功 | 保留 | App 真实返回；无必填参数 | [App 五接口](evidence/2026-09-29-chatgpt-app/20-chatgpt-work-five-readonly-tools.png) |
| 44 | `billing.model-usage.statement` | 产品门禁/后台办理 | 保留 | 返回商家后台办理或查看入口；ChatGPT 内未完成明细/导出；无必填参数 | [账务只读审计](evidence/2026-09-29-chatgpt-app/billing-readonly-audit.md) |
| 45 | `billing.recharge.get` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；必填：`order_id` | [账务只读审计](evidence/2026-09-29-chatgpt-app/billing-readonly-audit.md) |
| 46 | `billing.recharge.list` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [账务只读审计](evidence/2026-09-29-chatgpt-app/billing-readonly-audit.md) |
| 47 | `billing.transactions` | 产品门禁/后台办理 | 保留 | 返回商家后台办理或查看入口；ChatGPT 内未完成明细/导出；无必填参数 | [账务只读审计](evidence/2026-09-29-chatgpt-app/billing-readonly-audit.md) |
| 48 | `workspace.deactivate` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`reason` | — |
| 49 | `workspace.activate` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`reason` | — |
| 50 | `workspace.data.delete.request` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`scope`, `reason`, `idempotency_key` | — |
| 51 | `platform.store.alias.set` | 本地契约 | 保留 | 候选本地调用返回 `INTERACTIVE_WRITE_DISABLED`；未对生产执行别名写入；必填：`platform`, `account_id`, `alias`, `expected_revision` | [平台与规则审计](evidence/2026-09-29-chatgpt-app/platform-rule-audit.md) |
| 52 | `catalog.search` | App 成功 | 保留 | App 真实返回；无必填参数；隔离 API/MCP 目录写入 37/37 与更新闭环 26/26 通过；该结果不计入本列线上状态；当前 119 工具版本的新 ChatGPT Work 会话再次成功 | [App 商品总览](evidence/2026-09-29-chatgpt-app/22-chatgpt-work-all-products.png)；[目录隔离 E2E](evidence/2026-09-29-chatgpt-app/catalog-write-isolated-audit.md)；[新版 App 复验](evidence/2026-09-29-chatgpt-app/26-upgraded-119-tool-plugin-app-readonly.png) |
| 53 | `catalog.categories` | App 成功 | 保留 | App 真实返回；无必填参数 | [App 知识库](evidence/2026-09-29-chatgpt-app/21-chatgpt-work-knowledge-readonly-top.png) |
| 54 | `catalog.title.optimize` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`product_id`；隔离 API/MCP 目录写入 37/37 与更新闭环 26/26 通过；该结果不计入本列线上状态 | [目录隔离 E2E](evidence/2026-09-29-chatgpt-app/catalog-write-isolated-audit.md) |
| 55 | `catalog.title.accept` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`product_id`, `platform`, `suggestion_id`, `title`；隔离 API/MCP 目录写入 37/37 与更新闭环 26/26 通过；该结果不计入本列线上状态 | [目录隔离 E2E](evidence/2026-09-29-chatgpt-app/catalog-write-isolated-audit.md) |
| 56 | `catalog.import` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`platform`, `title`；隔离 API/MCP 目录写入 37/37 与更新闭环 26/26 通过；该结果不计入本列线上状态 | [目录隔离 E2E](evidence/2026-09-29-chatgpt-app/catalog-write-isolated-audit.md) |
| 57 | `catalog.import.batch` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；无必填参数；隔离 API/MCP 目录写入 37/37 与更新闭环 26/26 通过；该结果不计入本列线上状态 | [目录隔离 E2E](evidence/2026-09-29-chatgpt-app/catalog-write-isolated-audit.md) |
| 58 | `catalog.sku.update` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`product_id`, `sku_id`；隔离 API/MCP 目录写入 37/37 与更新闭环 26/26 通过；该结果不计入本列线上状态 | [目录隔离 E2E](evidence/2026-09-29-chatgpt-app/catalog-write-isolated-audit.md) |
| 59 | `catalog.product.update` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`product_id`；隔离 API/MCP 目录写入 37/37 与更新闭环 26/26 通过；该结果不计入本列线上状态 | [目录隔离 E2E](evidence/2026-09-29-chatgpt-app/catalog-write-isolated-audit.md) |
| 60 | `catalog.facts.confirm` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`product_id`；隔离 API/MCP 目录写入 37/37 与更新闭环 26/26 通过；该结果不计入本列线上状态 | [目录隔离 E2E](evidence/2026-09-29-chatgpt-app/catalog-write-isolated-audit.md) |
| 61 | `catalog.product.disable` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`product_id`, `reason`；隔离 API/MCP 目录写入 37/37 与更新闭环 26/26 通过；该结果不计入本列线上状态 | [目录隔离 E2E](evidence/2026-09-29-chatgpt-app/catalog-write-isolated-audit.md) |
| 62 | `catalog.product.enable` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`product_id`；隔离 API/MCP 目录写入 37/37 与更新闭环 26/26 通过；该结果不计入本列线上状态 | [目录隔离 E2E](evidence/2026-09-29-chatgpt-app/catalog-write-isolated-audit.md) |
| 63 | `catalog.image.generate` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；无必填参数 | — |
| 64 | `catalog.image.get` | 预期阻断 | 保留 | 虚构 `job_id` 返回 `IMAGE_GENERATION_JOB_NOT_FOUND`；真实任务读取待测。已安装 schema 未声明必填，候选改为 `job_id` / `visual_ref` 二选一 | [素材审计](evidence/2026-09-29-chatgpt-app/assets-readonly-audit.md) |
| 65 | `catalog.image.select` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`job_id`, `visual_ref`, `expected_revision`, `idempotency_key`, `reason`, `confirmation_ticket_nonce_hash`, `confirmation_ticket_intent_hash`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 66 | `catalog.image.review` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`product_id` | — |
| 67 | `rule.list` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [品牌规则只读审计](evidence/2026-09-29-chatgpt-app/brand-rule-readonly-audit.json) |
| 68 | `rule.sync.status` | App 成功 | 保留 | App 真实返回；生产 MCP 六平台均 `configured=false`、`stale=true`；无必填参数 | [App 五接口](evidence/2026-09-29-chatgpt-app/20-chatgpt-work-five-readonly-tools.png) |；[平台与规则审计](evidence/2026-09-29-chatgpt-app/platform-rule-audit.md) |
| 69 | `rule.sync.now` | 本地契约 | 隐藏（12 项之一） | 升级前暴露，当前 119 工具版本已隐藏；无当前商家成功路径；无必填参数 | [桥接隐藏集](../../apps/plugin/mcp/bridge.mjs) |
| 70 | `rule.history` | 生产 MCP 成功 | 保留 | 生产 MCP 对不存在的 QA 规则包 ID 返回空数组；仅验证空路径，真实规则历史待测；必填：`pack_id` | [平台与规则审计](evidence/2026-09-29-chatgpt-app/platform-rule-audit.md) |
| 71 | `rule.audit` | 预期阻断 | 隐藏（12 项之一） | 生产返回 FORBIDDEN；新安装版本已隐藏平台工作台能力；无必填参数 | [平台与规则审计](evidence/2026-09-29-chatgpt-app/platform-rule-audit.md) |
| 72 | `rule.publish` | 本地契约 | 隐藏（12 项之一） | 升级前暴露，当前 119 工具版本已隐藏；无当前商家成功路径；必填：`pack_id`, `name`, `version`, `scope`, `source_kind`, `source_reference`, `source_checked_at`, `checks_json`, `reason` | [桥接隐藏集](../../apps/plugin/mcp/bridge.mjs) |
| 73 | `rule.status` | 本地契约 | 隐藏（12 项之一） | 升级前暴露，当前 119 工具版本已隐藏；无当前商家成功路径；必填：`pack_id`, `version`, `status`, `reason` | [桥接隐藏集](../../apps/plugin/mcp/bridge.mjs) |
| 74 | `asset.list` | App 成功 | 保留 | App 真实返回；无必填参数 | [App 五接口](evidence/2026-09-29-chatgpt-app/20-chatgpt-work-five-readonly-tools.png) |
| 75 | `asset.parse` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`asset_id`；隔离 HTTP/MCP 素材流程有验证，非生产/App 成功；本地解析报告 `simulated=true`、`providerExecuted=false` | [素材隔离审计](evidence/2026-09-29-chatgpt-app/asset-upload-e2e-audit.md) |
| 76 | `asset.facts.confirm` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`asset_id`, `facts_json`, `reason`；隔离 HTTP/MCP 素材流程有验证，非生产/App 成功 | [素材隔离审计](evidence/2026-09-29-chatgpt-app/asset-upload-e2e-audit.md) |
| 77 | `asset.preference.update` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`asset_id`, `verdict` | — |
| 78 | `brand.get` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [品牌规则只读审计](evidence/2026-09-29-chatgpt-app/brand-rule-readonly-audit.json) |
| 79 | `brand.extract` | 生产 MCP 成功 | 保留 | 已认证生产 stdio/MCP 调用成功；无必填参数 | [品牌规则只读审计](evidence/2026-09-29-chatgpt-app/brand-rule-readonly-audit.json) |
| 80 | `brand.upsert` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`name` | — |
| 81 | `asset.upload` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`name`, `mime_type`；隔离 HTTP/MCP 素材流程有验证，非生产/App 成功 | [素材隔离审计](evidence/2026-09-29-chatgpt-app/asset-upload-e2e-audit.md) |
| 82 | `asset.upload.batch` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`assets_json`；隔离 HTTP/MCP 素材流程有验证，非生产/App 成功 | [素材隔离审计](evidence/2026-09-29-chatgpt-app/asset-upload-e2e-audit.md) |
| 83 | `upload.session.create` | 未测试 | 隐藏（新版新增） | 隔离 HTTP/MCP 返回 `UPLOAD_TRANSPORT_NOT_CONFIGURED`（503）；已从当前商家插件列表隐藏，真实 transport、持久化和租户绑定完成前没有成功路径；必填：`file_name`, `content_type`, `size_bytes`, `sha256` | [上传会话隔离审计](evidence/2026-09-29-chatgpt-app/asset-upload-e2e-audit.md) |
| 84 | `upload.session.part` | 未测试 | 隐藏（新版新增） | 隔离 HTTP/MCP 返回 `UPLOAD_TRANSPORT_NOT_CONFIGURED`（503）；已从当前商家插件列表隐藏；必填：`session_id`, `part_number`, `content_base64` | [上传会话隔离审计](evidence/2026-09-29-chatgpt-app/asset-upload-e2e-audit.md) |
| 85 | `upload.session.complete` | 未测试 | 隐藏（新版新增） | 隔离 HTTP/MCP 返回 `UPLOAD_TRANSPORT_NOT_CONFIGURED`（503）；已从当前商家插件列表隐藏；必填：`session_id` | [上传会话隔离审计](evidence/2026-09-29-chatgpt-app/asset-upload-e2e-audit.md) |
| 86 | `asset.generation.confirm` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`job_id` | — |
| 87 | `asset.rights.update` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`asset_id`, `rights_status`；隔离 HTTP/MCP 素材流程有验证，非生产/App 成功 | [素材隔离审计](evidence/2026-09-29-chatgpt-app/asset-upload-e2e-audit.md) |
| 88 | `deliverable.list` | App 成功 | 保留 | App 真实返回；无必填参数 | [App 知识库](evidence/2026-09-29-chatgpt-app/21-chatgpt-work-knowledge-readonly-top.png) |
| 89 | `task.history` | 生产 MCP 成功 | 保留 | 已安装插件 stdio→生产 API 返回 `items=[]`；当前无正式任务；无必填参数 | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md) |
| 90 | `task.resume` | 预期阻断 | 保留 | 以不存在的测试任务 ID 返回 `FORBIDDEN` / `AUTHZ_SCOPE_MISMATCH`；真实任务恢复待测；必填：`task_id` | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md) |
| 91 | `task.clone` | 预期阻断 | 保留 | 已安装插件的本地交互写门禁返回 `INTERACTIVE_WRITE_DISABLED`，未写入；写会话打开后的成功路径待测；必填：`task_id` | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md) |
| 92 | `task.timeline` | 预期阻断 | 保留 | 以不存在的测试任务 ID 返回 `FORBIDDEN` / `AUTHZ_SCOPE_MISMATCH`；真实时间线待测；必填：`task_id` | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md) |
| 93 | `feedback.list` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`task_id` | — |
| 94 | `feedback.submit` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`task_id`, `rating` | — |
| 95 | `task.create` | 预期阻断 | 保留 | 已安装插件的本地交互写门禁返回 `INTERACTIVE_WRITE_DISABLED`，未写入；写会话打开后的成功路径待测；必填：`product_id`, `platform`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md)；[正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 96 | `task.create.draft` | 预期阻断 | 保留 | 已安装插件的本地交互写门禁返回 `INTERACTIVE_WRITE_DISABLED`，未写入；写会话打开后的成功路径待测；必填：`product_id`, `platform` | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md) |
| 97 | `task.answer` | 预期阻断 | 保留 | 已安装插件的本地交互写门禁返回 `INTERACTIVE_WRITE_DISABLED`，未写入；写会话打开后的成功路径待测；必填：`task_id`, `answers_json` | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md) |
| 98 | `task.request.create` | 预期阻断 | 保留 | 已安装插件的本地交互写门禁返回 `INTERACTIVE_WRITE_DISABLED`，未写入；写会话打开后的成功路径待测；必填：`request_text`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md)；[正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 99 | `task.sku.split` | 预期阻断 | 保留 | 已安装插件的本地交互写门禁返回 `INTERACTIVE_WRITE_DISABLED`，未写入；写会话打开后的成功路径待测；必填：`task_id`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md)；[正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 100 | `task.group.create` | 预期阻断 | 保留 | 已安装插件的本地交互写门禁返回 `INTERACTIVE_WRITE_DISABLED`，未写入；写会话打开后的成功路径待测；必填：`entries_json` | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md) |
| 101 | `creative.brief` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`product_id`, `asset_type`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 102 | `creative.preview` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`product_id`, `asset_type`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 103 | `creative.directions.update` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`task_id`, `action`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 104 | `task.select_direction` | 预期阻断 | 保留 | 已安装插件的本地交互写门禁返回 `INTERACTIVE_WRITE_DISABLED`，未写入；写会话打开后的成功路径待测；必填：`task_id`, `direction_id`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md)；[正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 105 | `task.plan.confirm` | 预期阻断 | 保留 | 已安装插件的本地交互写门禁返回 `INTERACTIVE_WRITE_DISABLED`，未写入；写会话打开后的成功路径待测；必填：`task_id`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [任务与批量审计](evidence/2026-09-29-chatgpt-app/task-campaign-audit.md)；[正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 106 | `content.generate` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`task_id` | — |
| 107 | `content.draft.generate` | App 成功 | 保留 | 一次待审核文案候选；实际模型用量、成本和创意点结算；必填：`draft`, `draft_title`, `idempotency_key` | [App 生成与账务](evidence/2026-09-29-chatgpt-app/09-postdeploy-draft-settled.png) |
| 108 | `generation.get` | 预期阻断 | 保留 | 虚构 job_id 返回 FORBIDDEN；真实任务读取待测；必填：`job_id` | [内容审计](evidence/2026-09-29-chatgpt-app/content-readonly-audit.md) |
| 109 | `content.review.decide` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`content_version_id`, `code`, `field`, `status`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 110 | `content.visual.select` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`content_version_id`, `visual_refs_json`, `expected_revision`, `reason`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 111 | `content.versions` | 预期阻断 | 保留 | 虚构 task_id 返回 FORBIDDEN；真实版本读取待测；必填：`task_id`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [内容审计](evidence/2026-09-29-chatgpt-app/content-readonly-audit.md)；[正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 112 | `content.diff` | 预期阻断 | 保留 | 虚构 content_version_id 返回 FORBIDDEN；真实 diff 待测；必填：`content_version_id`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [内容审计](evidence/2026-09-29-chatgpt-app/content-readonly-audit.md)；[正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 113 | `content.export` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；无必填参数；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 114 | `content.approve` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`task_id`, `content_version_id`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 115 | `content.restore` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`content_version_id`；隔离 API E2E 106 项中的对应流程有验证；该结果不计入本列线上状态 | [正式内容隔离 E2E](evidence/2026-09-29-chatgpt-app/formal-content-isolated-audit.md) |
| 116 | `knowledge.rule.create` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`name`, `content`, `scope`, `source_kind`, `source_reference`, `source_checked_at`, `version`, `status`；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 117 | `knowledge.rule.list` | App 成功 | 保留 | App 真实返回；无必填参数；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [App 知识库](evidence/2026-09-29-chatgpt-app/21-chatgpt-work-knowledge-readonly-top.png)；[知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 118 | `knowledge.asset.create` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`kind`, `name`, `content_json`；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 119 | `knowledge.asset.update` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`asset_id`；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 120 | `knowledge.asset.list` | App 成功 | 保留 | App 真实返回；无必填参数；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [App 知识库](evidence/2026-09-29-chatgpt-app/21-chatgpt-work-knowledge-readonly-top.png)；[知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 121 | `knowledge.brand.preference.get` | App 成功 | 保留 | App 真实返回；无必填参数；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [App 知识库](evidence/2026-09-29-chatgpt-app/21-chatgpt-work-knowledge-readonly-top.png)；[知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 122 | `knowledge.brand.preference.update` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`preferences_json`, `version`；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 123 | `knowledge.feedback.record` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`kind`, `reason`；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 124 | `knowledge.learning.list` | App 成功 | 保留 | App 真实返回；无必填参数；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [App 知识库](evidence/2026-09-29-chatgpt-app/21-chatgpt-work-knowledge-readonly-top.png)；[知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 125 | `knowledge.learning.confirm` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`suggestion_id`；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 126 | `knowledge.learning.dismiss` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`suggestion_id`；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 127 | `knowledge.competitor.create` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`competitor_name`, `source_json`, `summary`, `structure_json`, `selling_points_json`, `expression_json`；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 128 | `knowledge.competitor.list` | App 成功 | 保留 | App 真实返回；无必填参数；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [App 知识库](evidence/2026-09-29-chatgpt-app/21-chatgpt-work-knowledge-readonly-top.png)；[知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 129 | `knowledge.competitor.reference` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`competitor_id`, `own_brand_name`, `own_selling_points_json`；隔离知识库 HTTP/MCP 21/21 与插件桥接 98/98 通过；该结果不计入本列线上状态 | [知识库隔离 E2E](evidence/2026-09-29-chatgpt-app/knowledge-write-isolated-audit.md) |
| 130 | `delivery.bundle.verify` | 本地契约 | 隐藏（12 项之一） | 升级前暴露，当前 119 工具版本已隐藏；无当前商家成功路径；必填：`manifest_json`, `files_json`, `expected_manifest_hash` | [桥接隐藏集](../../apps/plugin/mcp/bridge.mjs) |
| 131 | `multimodal.image.edit` | 未测试 | 保留 | 需真实商家对象、授权、素材、余额或交互写入确认后按方法复测；必填：`request_json` | — |

## 关键缺口

- 真实 App 成功路径集中在工作区、商品/知识库查询和一次文案候选；任务/批量 17 项虽已逐项调用，但 12 项只验证交互写门禁、3 项只验证缺对象或权限拒绝，正式创建、审核、版本、导出、素材上传、图片候选、邀请、订单和删除申请仍无完整 App 端到端证据。隔离目录、知识库、正式内容和账务 E2E 仅证明测试环境路径；`upload.session.*` 在隔离 HTTP/MCP 固定返回 503，待修复传输与持久化后才可重新暴露。
- `workspace.data.export.get` 的非法 ID 当前生产返回 500；本地候选已做 UUID 校验但尚未部署。`workspace.invitations.list` 的商家权限需确认。
- 升级前 131 项中的 15 项已在当前安装的 116 工具版本隐藏：12 项平台/交付内部工具和 3 项无上传 transport 的分片会话工具。上一版 119 项在新 ChatGPT Work 会话已验证 `onboarding.status` 和 `catalog.search`，见[升级后 App 截图](evidence/2026-09-29-chatgpt-app/26-upgraded-119-tool-plugin-app-readonly.png)；当前 116 项还需重启 ChatGPT 复验。平台规则同步六行当前均未配置且过期，规则执行成功路径仍待测。
- 商家后台 Excel/CSV 导入、商品列表和 App 查询已验证，但插件侧 `catalog.import`、正式资料确认及后续审核/导出不能据此判通过。
- `/tmp/storenova-plugin-qa-20260929` 的早期桥接器批量探测为辅助线索；其中无参数 `catalog.image.get`、`support.customer.replies.list` 等返回错误。对需要 ID 的功能须以真实归属对象完成成功路径。
