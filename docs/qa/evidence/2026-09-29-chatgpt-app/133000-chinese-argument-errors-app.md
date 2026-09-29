# 133000 版 ChatGPT App 中文参数错误复测

2026-09-29 13:32，中国标准时间。通过本地直装安装 `merchant-marketing@0.1.0+codex.20260929133000`，安装器返回 `ok=true`、`mode=local_stdio`、116 项工具；重启 ChatGPT 桌面 App 后，在新会话逐项调用四个故意缺参的工具。原始会话：`~/.codex/sessions/2026/09/29/rollout-2026-09-29T13-31-42-01a0eba5-bccd-7960-be00-b534f07a5b39.jsonl`。

| 工具与参数 | 调用/输出行 | 结构化结果 | 用户可见文字 |
| --- | ---: | --- | --- |
| `campaign.batch.get({})` | 31/34 | `isError=true`, `TOOL_ARGUMENTS_INVALID` | 参数不完整或格式不正确，请补充后重试。 |
| `catalog.image.get({})` | 36/39 | 同上 | 同上 |
| `workspace.data.export.request({})` | 41/44 | 同上 | 同上 |
| `support.customer.replies.list({limit:"10"})` | 48/51 | 同上 | 同上 |

四项 `structuredContent.message` 均给出中文具体缺参原因；第 54 行 App 最终答复也全部用中文说明，未出现原先 `tool call error / Caused by / Mcp error` 的英文宿主包装。参数在插件本地拒绝，没有有效导出申请或客服数据访问。本轮只验证参数错误展示，**不继承 125100 版的 116/116 调用覆盖为 133000 版的全量验收**；125100 版逐项结果见[116 项清单](../../2026-09-29-chatgpt-app-116-tool-checklist.md)。

定向回归：桥接器 110/110、插件镜像清单 6/6、发布元数据 4/4；本地安装成功。生产 API 的客服工单 UUID 修复已在源码提交，但没有部署，故本轮没有把生产 `INTERNAL_ERROR` 标成已解决。
