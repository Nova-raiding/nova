# 图片候选状态结构化契约（已完成的本地部分）

日期：2026-08-31

## 已完成

`catalog.image.get` 的插件结构化结果现在明确返回：

- `candidate_state.state`：`ready`、`processing`、`failed` 或 `unknown`；
- `candidate_state.next_action`：唯一下一步动作及是否允许；
- `candidate_state.recovery.retryable`：是否允许安全重试读取；
- `candidate_state.recovery.reconciliation_required`：是否必须先查询/对账；
- 未知结果不会被表达为成功，也不会建议重新生成。

`ready` 仍保持原有候选选择组件；旧的归档、扫描、候选数量和图片字段保持兼容。marketplace 镜像已同步。

## 验证证据

- `apps/plugin/mcp/bridge.test.ts`：47/47 通过；
- `tests/plugin-manifest.test.ts` 与 `tests/mcp-surface-contract.test.ts`：17/17 通过；
- `codegraph sync .` 已同步 bridge、测试与相关改动。

## 尚未完成

这份文档只覆盖插件结构化投影，不代表普通图片生成已经达到生产级完成。以下仍在 `doc/todo`：

- 普通图片生成的 Durable Worker、结果 callback 和跨进程恢复；
- Merchant Studio 图片任务卡和完整错误恢复交互；
- 真实 ChatGPT Host、模型中转、对象存储、平台媒体和成本结算证据。

