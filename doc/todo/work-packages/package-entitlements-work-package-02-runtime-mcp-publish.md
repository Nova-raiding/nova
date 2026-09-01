# 工作包 02：模型/平台运行时、MCP Bridge 与发布安全

主责：开发者 2（后端/集成）
依据：[PRD](../product/package-entitlements-and-services-prd-2026-08-31.md)、[架构](../architecture/package-entitlements-and-services-architecture-2026-08-31.md)

## 目标

将文本、图片、图片编辑、OCR、视频、批量素材和六个平台能力接入统一 readiness、真实中转成本和人工确认发布链；保持无人值守发布为零。

## 范围

- Relay 五模态鉴权、provider request/usage/cost/error receipt、`operation_execution_attempts` 和 unknown/reconcile。
- 平台 capability：授权、商品读、内容写、媒体上传、状态回读；京东/淘宝/天猫/拼多多/小红书/抖音逐格 readiness。
- `workspace.health`、readiness evidence registry、release/digest/签名/过期/nonce 校验。
- `publish.prepare/confirm/get`：snapshot/restriction/auth/content/object/remote revision、intent hash、nonce、expires_at。
- Bridge/MCP merchant allowlist、商家六类卡片所需 DTO、批量最多 50 项、逐项 receipt。

## CodeGraph 复用证据

- `apps/plugin/mcp/bridge.mjs`、`apps/plugin/mcp/bridge.test.ts`、`packages/ai/src/provider-request.ts`。
- `packages/connectors/src/readiness.ts`、`capability-evidence.ts`、`platform-preflight.ts`、`http-connector.ts`、connector runtime。
- 现有 publish prepare/confirm、一次性 nonce、Worker auth recheck、unknown→reconcile/manual_attention、模型 usage/cost settlement。

## 关键实现与验收

1. Relay 缺 key、cost 或模型证据时 fail-closed；不得直连 provider，不交付伪结果。
2. provider timeout、连接断开、请求后 Worker 崩溃或不支持幂等均为 unknown；保持点数/钱包 reserved，不重复调用。
3. readiness 服务端确定映射：blocked > error > unknown > degraded > ready/read_only；证据绑定 release、commit、digest、workspace、capability、hash、签名、过期时间。
4. 无有效 confirmation ticket 的 Worker 平台写入数为 0；ticket consume 与 publish outbox 同事务；漂移即 invalidated/reprepare。
5. 六平台逐 capability E4 canary/readback；一个平台不得代表全部平台。视频未通过成本/渲染门禁只能销售脚本/分镜。
6. MCP/API DTO 返回 envelope、operationId/taskId/statusHref、server label/unit/limit；客户端不得推导状态或额度。

## 估算与依赖

- 估算：45–65 人日；外部平台开户、供应商审批和真实密钥等待不计入。
- 依赖工作包 01 的 snapshot/rate/operation 契约；工作包 05 可并行提供 E4 环境与门禁，02 的实现和 E1/E2/E3 不等待最终 E4，最终 E4 验收再由 05 统筹。
- 工作包 04 可先用契约 fixture 开发，但 E3/E4 必须接真实 API/MCP/沙箱。

## 风险与不包含

风险：provider 不幂等、外部写 unknown、CSP/structured content 限制、平台 capability 混淆、旧 readiness 计数 fallback。
不包含：供应商商业开户、平台应用审批、任意 ERP、无人值守发布、手机/平板。

## 完成定义

E2 真库/Worker/回执测试和 E3 ChatGPT+桌面端到端通过；E4 才能将对应模态或平台标记 production_sellable。
