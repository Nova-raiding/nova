# 任务与批量计划 MCP 线上只读及门禁验收

验收日期：2026-09-29。环境：生产 demo `https://yxsona.com`，商家工作区 `ws_guirenniaoniao`，本地直装 `merchant-marketing@merchant-local` 版本 `0.1.0+codex.20260929074100`。本轮在终端启动**已安装插件的 stdio bridge**，以 `demo@ys.com` 的真实商家登录换取短期工作区 Bearer 后调用 `initialize`、`tools/list`、`tools/call`。未记录或保存密码、Cookie、Bearer。此证据是插件 MCP 进程与线上 API 的验证，不能替代 ChatGPT App 对每个工具的界面验收。

首轮 `initialize` 成功，`tools/list` 返回 131 个商家工具；任务与批量计划域可见 17 个。调用时使用生产交互写门禁，未打开写会话；测试对象不存在时使用明确的 `qa_nonexistent_*` 标识，不修改生产数据。

| 工具 | 实际结果 | 范围与限制 |
| --- | --- | --- |
| `campaign.batch.create` | `INTERACTIVE_WRITE_DISABLED` | 插件本地拦截，未创建计划。 |
| `campaign.batch.list` | 成功，`items=[]` | 当前工作区无可访问批量计划。 |
| `campaign.batch.get` | `CAMPAIGN_BATCH_NOT_FOUND` | 以不存在的测试计划 ID 读取，验证缺失对象路径。 |
| `campaign.batch.pause` | `INTERACTIVE_WRITE_DISABLED` | 插件本地拦截，未暂停计划。 |
| `campaign.batch.resume` | `INTERACTIVE_WRITE_DISABLED` | 插件本地拦截，未恢复计划。 |
| `task.history` | 成功，`items=[]` | 当前工作区无可恢复的正式任务。 |
| `task.resume` | `FORBIDDEN`，`AUTHZ_SCOPE_MISMATCH` | 以不存在的测试任务 ID 读取；仅验证权限阻断。 |
| `task.clone` | `INTERACTIVE_WRITE_DISABLED` | 插件本地拦截，未复制任务。 |
| `task.timeline` | `FORBIDDEN`，`AUTHZ_SCOPE_MISMATCH` | 以不存在的测试任务 ID 读取；仅验证权限阻断。 |
| `task.create` | `INTERACTIVE_WRITE_DISABLED` | 插件本地拦截，未创建任务。 |
| `task.create.draft` | `INTERACTIVE_WRITE_DISABLED` | 插件本地拦截，未创建候选。 |
| `task.answer` | `INTERACTIVE_WRITE_DISABLED` | 插件本地拦截，未保存答案。 |
| `task.request.create` | `INTERACTIVE_WRITE_DISABLED` | 插件本地拦截，未创建自然语言任务。 |
| `task.sku.split` | `INTERACTIVE_WRITE_DISABLED` | 插件本地拦截，未拆分任务。 |
| `task.group.create` | `INTERACTIVE_WRITE_DISABLED` | 插件本地拦截，未创建任务组。 |
| `task.select_direction` | `INTERACTIVE_WRITE_DISABLED` | 插件本地拦截，未确认方向。 |
| `task.plan.confirm` | `INTERACTIVE_WRITE_DISABLED` | 插件本地拦截，未确认方案。 |

`campaign.batch.generate`、`campaign.batch.retry_failed` 和 `task.understand` 不在上述 131 个可见工具内。额外用本地 bridge 的 `tools/call` 对这三个名称进行门禁探测，均返回 `COMMERCIAL_OPERATION_DISABLED`、`isError=true`，未发往线上 API。因此批量计划创建后的逐商品生成当前不能从商家插件继续；不能将完整批量工作流记为通过。

代码核对：`apps/plugin/mcp/bridge.mjs` 的 `READ_ONLY_METHODS`、`COMMERCIAL_DISABLED_METHODS`、`ALWAYS_INTERACTIVE_WRITE_METHODS`、`SAFE_WITHOUT_INTERACTIVE_WRITE` 与 `tools/call` 拦截分支；`codegraph explore 'campaign.batch.list'` 指向批量计划应用层读取与调用链。该轮只证明真实空列表读取、无对象/无权限响应及本地交互写拦截；正式任务、批量计划的成功读写、审核与发布仍需具有合规测试数据和各自前置状态的单独验收。

后续同日其他 agent 修改了共享工作目录中的插件桥接文件，工具列表出现 119 个的未提交候选。**本文件只记录修改前 131 工具版本的首轮结果。**
