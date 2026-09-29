# 模型中转与多模态分组审计（2026-09-29）

## 范围与证据级别

- 使用 `codegraph status .`（索引 2,329 文件、33,578 节点）及 `codegraph explore 'multimodal image edit relay cost evidence'` 跟踪 `apps/api/src/mcp-multimodal-handlers.ts` → `packages/ai/src/image-editor.ts` / 生成器 → `packages/ai/src/relay-usage.ts`。这是源码调用链证据，不是线上功能成功证据。
- 生产**只读** `GET https://yxsona.com/api/healthz` 返回 `status=ok`，平台中转 `configured=true`、host `ai.wormholexyz.xyz`，text/image/image_edit/OCR/video 的模型配置 `ready=true`，`costGate=ready`。embedding `ready=false`，原因含 `knowledge_vector_indexing_disabled` 和 `model_missing`；目前向量索引关闭。`setup.productionEvidence.capability` 和 `capacity` 均 `blocked`，原因为挂载证据文件不可读。`GET /api/releasez` 为 `release-demo-product-code-20260929`、`fd1ad6a7bd122a391350c185798ac07e92795f8c`。
- 未调用生产收费图片、图片编辑、视频或 OCR；演示商品事实未确认且缺已扫描、权益及 AI 修改许可素材。生产健康配置并不证明任一模态完成了真实 provider 请求与结算。此前只有一次文案候选具真实 App 模型用量和成本证据，详见主 QA 报告。

## 已安装商家插件的方法

| 方法 | 本轮结论 | 证据与缺口 |
| --- | --- | --- |
| `catalog.image.generate` | 线上成功路径未测 | API 隔离 E2E 可生成、归档及审阅模拟候选；该用例明确 `simulated=true`、`providerExecuted=false`。生产缺已确认商品事实/合格图片来源，未触发付费模型。 |
| `catalog.image.get` | 生产负向已测；成功读取待测 | 先前认证调用用虚构 job ID 返回 `IMAGE_GENERATION_JOB_NOT_FOUND`；候选契约要求 `job_id` 与 `visual_ref` 恰好一个。隔离 E2E 可按 job/ref 读归档图。 |
| `catalog.image.select` | 隔离 E2E；生产成功路径未测 | 隔离审阅后选择、过期/跨会话 ticket 拒绝、归档 SHA 证据门禁通过；必须先取得真实候选与确认 ticket。 |
| `catalog.image.review` | 隔离 E2E；生产成功路径未测 | 图像事实与真实性门禁有隔离请求验证；需要实际授权素材/归档候选。 |
| `multimodal.image.edit` | 隔离 E2E 和 relay 单测；生产成功路径未测 | 要求当前工作区的图片素材通过扫描、权益 `approved` 且允许 AI 修改，商品事实/规则/成本预检后才调中转。隔离用例验证违规编辑拦截和安全候选；未产生生产图片。 |

当前桥接器将 `catalog.image.retry`、`multimodal.generate` 禁用；`multimodal.video.request` 及 `multimodal.video.get` 默认隐藏，仅在非生产的本地视频验收开关和 loopback API 同时满足时开放。`platform.model.status` 是平台权限工具，商家插件隐藏。它们属于 API 契约/隔离测试范围，不能算当前已安装商家插件可见功能。桥接器当前还隐藏 `upload.session.*`（API 返回 `UPLOAD_TRANSPORT_NOT_CONFIGURED`）；须以最终安装版本 `tools/list` 复核，因为共享工作树中桥接器正在并行修改。

## 隔离测试

运行 `npx vitest run --no-file-parallelism`，全部成功：

1. 8 文件 / 106 用例：`product-image-review.e2e`、`video-cost-preflight.e2e`、`video-provider-outcome-points.e2e`、`asset-ocr-rate-gate.e2e`、`model-unknown-receipt`、`model-daily-budget-contract`、`image-generator`、`video-generator`。
2. 9 文件 / 148 用例：`platform-model-gate`、`direct-relay-config`、`relay-usage`、`relay-pricing`、`relay-contract-audit`、`model-usage-reconciliation`、`model-usage-settlement`、`image-mcp-dispatch.e2e`、`feature-gap.e2e`。
3. 3 文件 / 40 用例：`provider-dispatch-admission`、`image-facts`、再次运行 `asset-ocr-rate-gate.e2e`。最后一批重复一文件，不能按 294 计作不重复的用例数。

具体覆盖包括：图片 relay 配置和 HTTPS 校验、真实请求前使用量 sink/配额准入、provider 身份及图片单位证据、无成本证据的 fail-closed、视频成本预检、未知 provider 结果保留预留并待对账、失败前后重试边界、输出归档与真实性 ticket。测试使用隔离内存/fixture/provider stub；不代表线上调用成功。第三批预期故障注入打印 `MODEL_UNKNOWN_RECEIPT_WRITE_FAILED` 日志，但测试 40/40 通过。

## 待补的真实验收

1. 在真实商家工作流完成商品事实确认、图片扫描和使用权/AI 修改许可，再做小额、显式确认的图片候选生成；核对 App 可见候选、`job_id` 读取、审阅/选择、归档、实际 relay 请求 ID、用量、成本与创意点结算。
2. 图片编辑须用同一租户的合格源图走 App → MCP → API → relay → 归档；核对原图保留与未发布状态。
3. 视频默认未暴露给商家插件，不能写成“全部功能通过”；若产品决定开放，先完成本地验收开关、正式商用费率/时长/来源预检，再依发布门禁单独上线。当前不触发生产视频计费。
4. 修复发布证据挂载可读性，且不要用占位文件伪造通过；该门禁与模型配置 `ready` 是不同事实。
