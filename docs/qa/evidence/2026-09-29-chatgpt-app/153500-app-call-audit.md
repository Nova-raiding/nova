# 153500 版 ChatGPT App 调用审计

本文件只计本地直装插件 `0.1.0+codex.20260929153500` 的真实 ChatGPT App 会话。`143500` 版的 116/116 历史调用另见 [正向业务矩阵](positive-business-coverage-matrix.md)，不能折算为本版调用或业务成功。

## 当前精确进度

15:59:15 会话 `rollout-2026-09-29T15-59-15-01a0ec2c-d20f-7383-bda0-788b6d16f74d.jsonl` 第 13/15 行在 App 中输出完整 Merchant Marketing 工具名清单：**暴露 116 项**，与 [116 方法清单](../../2026-09-29-chatgpt-app-116-tool-checklist.md) 逐名归一化比对，缺失 0、新增 0。下表只统计真正执行的方法调用及其同 `call_id` 工具输出；单纯查询 `ALL_TOOLS` 不计调用覆盖。

| App 原始会话与行号 | 实际调用方法与输入 | 工具结果 | 业务结论 |
| --- | --- | --- | --- |
| `15:56:28` 第 21/24 行 | `onboarding.status({})` | `isError=false`；提示可由公开链接、手工资料或图片开始，结构化引导仍显示 0 店铺/商品/素材/任务和创意点 `unknown` | 入门状态读取成功；未创建内容 |
| `15:57:20` 第 25/29 行 | `workspace.health({})`、`creative-points.balance.get({})` | 两项均输出结构化结果；前者为需要提供商品资料、可用店铺 0，后者余额 `unknown`/`null`。调用脚本只打印 `structuredContent`，未保留两项的 `isError` 字段 | 仅空态与余额未知读取；不能据此判定收费操作可用 |
| `15:59:51` 第 17/20、22/25 行 | `asset.upload` 两次：分别传本地 Excel 文件 `纪梵希.xlsx11111.xlsx` 与 `迪奥.xlsx` 的路径、文件名和 Excel MIME 类型 | 两次 `isError=true`、`CREATIVE_POINTS_UNAVAILABLE`；第二次提示会话受商业恢复门禁限制，未转发业务请求 | Excel 未成功上传，知识库未出现可核验的新素材对象 |
| `16:00:42` 第 32/38 行 | `commercial.access.get({})`、`commercial.catalog.get({})`、`subscription.get({})`、`billing.status({})` | 前三项 `isError=false`；工作区为专用 QA `ws_57fd2361ed5b44c7891f3d37`，订阅 `trialing` 且 V2 权益 `unknown`。`billing.status` 为 `isError=true`、`COMMERCIAL_ENTITLEMENT_REQUIRED` | 商业目录可读不代表已购买；当前工作区仍无可确认权益 |

**当前版基线 116 项中，唯一已调用 8/116，剩余 108 项；实际调用 9 次。** 其中 4 次明确 `isError=false`，3 次明确 `isError=true`，另 2 次因调用脚本只打印结构化字段而无法从原始输出确认 `isError`。本版没有 Excel 上传、内容生成或其他完整正向业务闭环证据。后续批次须按同一版本、新旧会话各自原始 `custom_tool_call` 与 `custom_tool_call_output` 继续累计。
