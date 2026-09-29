# 任务、反馈与内容 17 项：本地桥接安全拒绝核验

时间：2026-09-29 13:08 CST。执行者：`task_content_writes` agent。使用已安装的 `merchant-marketing@merchant-local 0.1.0+codex.20260929125100` 的 `mcp/bridge.mjs`，通过本地 stdio 发送 `tools/list` 和逐项 `tools/call`。这是**非 ChatGPT App 证据**，也不是生产 API 业务成功证据。

进程明确设置 `MERCHANT_WORKSPACE_ID=ws_57fd2361ed5b44c7891f3d37`、`MERCHANT_MCP_WRITE_ENABLED=false`、`MERCHANT_MCP_TOKEN_SOURCE=environment`、空 access/refresh token、严格鉴权与禁用 fixture fallback。除工具发现外，没有读取生产资源；请求均在桥接器的交互写入或参数校验处停止。没有执行 `workspace.interactive.confirm`，没有创建任务、生成内容、扣点、审核、导出或发布。空 token 的本地拒绝测试**不能证明该进程实际通过了 QA 账号鉴权或生产租户隔离**。

| 范围 | 工具 | 本地调用参数 | 已安装工具可见 | 实际结果 |
| --- | --- | --- | --- | --- |
| 任务 | `task.clone` | `{}` | 是 | `isError=true`，`INTERACTIVE_WRITE_DISABLED` |
| 任务 | `task.create` | `{}` | 是 | 同上 |
| 任务 | `task.create.draft` | `{}` | 是 | 同上 |
| 任务 | `task.answer` | `{}` | 是 | 同上 |
| 任务 | `task.request.create` | `{}` | 是 | 同上 |
| 任务 | `task.sku.split` | `{}` | 是 | 同上 |
| 任务 | `task.group.create` | `{}` | 是 | 同上 |
| 任务 | `task.select_direction` | `{}` | 是 | 同上 |
| 任务 | `task.plan.confirm` | `{}` | 是 | 同上 |
| 反馈 | `feedback.submit` | `{}` | 是 | 同上 |
| 内容 | `content.generate` | `{}` | 是 | 同上 |
| 内容 | `content.draft.generate` | `{}` | 是 | 同上 |
| 内容 | `content.review.decide` | `{}` | 是 | 同上 |
| 内容 | `content.visual.select` | `{}` | 是 | 同上 |
| 内容 | `content.export` | `{"unknown_qa_argument":true}` | 是 | `isError=true`，JSON-RPC `-32602`；中文提示“不支持的字段 unknown_qa_argument” |
| 内容 | `content.approve` | `{}` | 是 | `isError=true`，`INTERACTIVE_WRITE_DISABLED` |
| 内容 | `content.restore` | `{}` | 是 | 同上 |

16 项门禁响应的中文正文为“当前操作需要商家明确确认。请先确认后继续；如果创意点余额为零、待确认或不足，系统只会返回服务端授权的恢复入口。”`content.export` 被列为免交互写入门禁的工具，因此用未知字段确保在本地参数校验处拒绝；这个结果不说明有效导出请求的业务门禁或产物可用。

## 交给 App 操作方的安全调用

在 ChatGPT App 新会话中，先调用带明确工作区 ID 的只读状态工具，确认工作区确为 `ws_57fd2361ed5b44c7891f3d37`。随后可逐项明确请求调用上述 16 个工具，传 `{}`，**不发送交互确认工具**；应记录原始工具调用、`INTERACTIVE_WRITE_DISABLED` 与中文用户可见结果。`content.export` 传 `{"unknown_qa_argument":true}`，预期本地 `-32602`。这些请求只覆盖拒绝路径；App 未实际调用的项目继续标为“未测试”，模型文字自称调用不能替代会话工具事件。

业务正向调用需真实 QA 商品、店铺、任务、方向、版本及相应权益/创意点，且先在 App 内由商家明确确认交互写入。最小合法参数已列在 [116 项逐项清单](../../2026-09-29-chatgpt-app-116-tool-checklist.md) 的相应行；占位 ID 必须从同一 QA 工作区的读回结果取得。当前 QA 工作区无店铺、商品、任务、内容版本、有效商业权益或创意点授予，故这 17 项均不得记为业务正向通过。`content.generate` 与 `content.draft.generate` 还需核对真实模型中转鉴权、用量、成本、点数及生成结果；`content.export` 需核对可用交付物，不能以接口返回路径代替下载成功。

桥接源码定位：`apps/plugin/mcp/bridge.mjs` 中 `SAFE_WITHOUT_INTERACTIVE_WRITE`、`allowsWriteTools()` 和 `tools/call` 分支；已安装版本在 `~/.codex/plugins/cache/merchant-local/merchant-marketing/0.1.0+codex.20260929125100/mcp/bridge.mjs`。本轮进程退出码 0，标准错误为空。

## 14:25 追加：任务到内容交付的隔离正向核验

本轮按 gstack QA 的入口、实际响应、租户、拒绝路径和证据等级检查，并用 CodeGraph 1.5.0 的 `explore handleMcpTaskWrite`、`explore handleMcpContentVersion`、`explore handleMcpContentReview` 定位调用链。索引状态为 complete、2,349 文件、33,821 节点，但有 1 个新增和 4 个修改文件未同步；以下结论以当前磁盘源码和实际测试为准。未访问生产数据，未调用生产收费模型。

| 隔离测试命令 | 结果 | 实际覆盖 |
| --- | --- | --- |
| `npx vitest run --no-file-parallelism apps/api/src/mcp-completion-content.e2e.test.ts apps/api/src/mcp-content-knowledge-http.e2e.test.ts apps/api/src/task-create-idempotency.e2e.test.ts apps/api/src/task-answers.e2e.test.ts` | 4 文件，6/6 通过 | 独立工作区、bearer 权限、任务复制/自然语言创建/SKU 拆分与幂等、答案保存和事实确认、内容版本恢复及跨租户拒绝；模型/视频依赖为测试桩 |
| `npx vitest run --no-file-parallelism apps/api/src/server.e2e.test.ts` | 1 文件，81/81 通过 | `task.create` → 方向选择 → 方案确认 → 测试专用 `content.codex.commit` → `content.review` → 版本/差异 → `content.export(manifest)` → `content.approve` → 反馈；还有 `task.create.draft` 边界 |
| `npx vitest run --no-file-parallelism apps/api/src/model-usage-settlement.test.ts apps/api/src/creative-point-reservation-owner.regression.test.ts apps/api/src/mcp-unbound-draft-pricing-preflight.test.ts apps/api/src/knowledge-consumption.e2e.test.ts` | 4 文件，30/30 通过 | 模型用量结算、收费动作预留归属、草稿价格预检失败关闭、知识消耗；中转服务为受控测试环境 |

总计 9 个文件、117/117 项通过。这些是**隔离 API/MCP 与单元测试**；`server.e2e.test.ts` 的内容版本通过仅限本地测试的 `content.codex.commit` 创建，不能证明正式 `content.generate` 真实模型中转、worker 完成、成本结算或 ChatGPT App 下载。对本轮已执行范围未发现确定的代码回归，因此未修改业务代码。

正式闭环的源码条件：`task.create.draft` 需要本租户、同平台、事实已确认且未绑定店铺/品牌的商品；`task.create` 需要可操作平台店铺、商品及规范化商品/店铺映射；`content.generate` 再检查任务作用域、规则预检、商业权益与点数、模型价格、幂等键和持久入队授权；`content.review` 与 `content.approve` 需要本租户真实内容版本；`content.export` 必须恰好指定 `content_version_id` 或 `deliverable_ref`，并核对实际交付文件。`content.draft.generate` 是未绑定内容候选，不创建正式版本，且仍需真实中转、价格证据和创意点。

**App 正向剩余前置**：当前 `demo@sn.com` 独立 QA 工作区仍缺自己的已确认商品、授权测试店铺/规范化映射、有效商业权益、创意点和模型调用预算；还缺从该工作区读回的 `task_id` 与 `content_version_id`。资源具备后，应在真实 ChatGPT App 会话中先核验工作区 ID，再由商家明确确认写入，按上面的业务顺序逐项调用，并交叉核对 API 请求 ID、同租户快照/审计、模型中转鉴权、token 用量、成本、创意点账本及导出文件。当前 17 项仍不得从“隔离通过”升格为“App 业务通过”。
