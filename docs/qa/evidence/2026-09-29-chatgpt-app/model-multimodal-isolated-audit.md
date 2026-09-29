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

## 图片五方法逐项补测与 relay 边界（09:15）

追加运行 `npx vitest run --no-file-parallelism apps/plugin/mcp/bridge.test.ts --testNamePattern='forwards catalog.image.select|requires exactly one image-job lookup key|executes catalog.image.review|binds the minimal image chooser|restores the preferred image|returns generated data URI images|does not retry a model call when provider usage cost needs reconciliation' --reporter=dot`：**7/7 通过，91 项按筛选跳过**。这只验证本地插件桥接行为，未请求生产 relay。

| 方法 | 隔离 API/MCP 成功路径 | 对应 relay 测试与真实边界 |
| --- | --- | --- |
| `catalog.image.generate` | `product-image-review.e2e` 成功创建两张候选并归档，但明确返回 `mode=simulated`、`providerExecuted=false`，不构成 relay 成功。 | `image-generator.test.ts` 用 mock `fetch` 验证 HTTPS relay 请求体、批准的源图字节、输出图单位与成本回执、幂等键；它不是线上中转请求。生产正常走 durable worker，先持久授权快照、钱包预留和出站准入；缺持久化/worker 返回 `IMAGE_GENERATION_DURABLE_NOT_CONFIGURED`。 |
| `catalog.image.get` | 隔离生成、扫描标记 clean 后，按 `visual_ref` 与 `job_id` 成功读取归档图片和短期选择票据，签名展示 URL 可打开；篡改 workspace/签名参数拒绝。 | 只读，不调 relay。生产候选须通过**原始用量、成本、创意点结算**核验；证据不足时返回待对账状态且不放出图片。插件桥接 `job_id` / `visual_ref` 二选一检查通过。 |
| `catalog.image.select` | 隔离候选清洁后，持正确 ticket、revision、幂等键成功选中；重放返回同一 revision，票据缺失/错绑/过期/并发复用拒绝；结果 `publishable=false`、`remote_write_performed=false`。 | 不调 relay；生产要求已归档可读候选及结算证据。插件桥接保留完整 ticket 转发的测试通过。 |
| `catalog.image.review` | 隔离用外部图片列表检查格式/重复；对 `visual_refs_json` 的归档候选可持久化审阅状态。 | 不调 relay。生产 `platformGovernanceGatesRequired()` 时仅允许归档 `visual_ref` 加真实性证据；仅传调用者图片 URL 被 `VISUAL_AUTHENTICITY_EVIDENCE_REQUIRED` 拒绝。此方法的归档审阅分支**会写快照和审计事件**，应按写操作确认，不能仅因基础 URL 检查分支看似只读就称只读。 |
| `multimodal.image.edit` | `product-image-review.e2e` 验证受保护商品违规编辑被拦截与合格源图候选行为；未产生真实线上图片。 | `image-generator.test.ts` 使用 mock `fetch` 成功提交源图 base64 和局部区域，解析带用量的中转图片响应；缺使用量 sink 在生产出站前拒绝，结果图片不合法但 provider 已收费时保留回执、转待对账，不能当作无成本失败。API 先检查同租户素材扫描、rights=approved、AI 修改许可、商品事实、规则及费率。生产无编辑 provider 返回 `IMAGE_EDIT_NOT_CONFIGURED`，不应显示候选成功。 |

配置与成功的区分：`/api/healthz` 的 image/image_edit `ready=true` 说明中转地址、模型和配置门禁可通过；未给出本轮生产图片/编辑请求 ID、实际用量或成本。因此五方法的完整 App → 生产 API → relay → 归档/审阅/选择链路仍待授权素材与明确费用确认后验收。当前演示商品 `QA-DO-NOT-PUBLISH-20260929` 事实未确认，不能作为正式图片生成输入。
