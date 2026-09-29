# 活动、任务、反馈、创意隔离运行验收（2026-09-29）

本轮以 API 的独立内存工作区、fixture 商品和平台账号执行 HTTP MCP；没有向生产提交任务、活动、反馈、发布或模型费用。CodeGraph `explore feedback.submit`、`explore campaign.batch.pause`、`explore creative.preview` 用来追溯处理器、应用服务和权限路径。gstack QA 用于核对可见工作流和证据边界；共享工作树已有并行改动，故没有执行该 skill 要求的清洁工作树提交与浏览器修复循环。

## 执行结果

命令 `npx vitest run apps/api/src/server.e2e.test.ts apps/api/src/task-answers.e2e.test.ts apps/api/src/product-image-review.e2e.test.ts --no-file-parallelism`：**3 文件、93/93 测试通过**。其中 `server.e2e.test.ts` 的黄金路径通过 API `/mcp` 真实请求执行以下方法：

| 方法 | 隔离成功路径及断言 |
| --- | --- |
| `campaign.batch.create` | 有品牌、商店、商品和 canonical listing 时创建草稿；跨平台目标、幂等重放成功；不一致目标、幂等冲突和超 50 个商品失败关闭。 |
| `campaign.batch.list` / `campaign.batch.get` | 读取刚创建的计划、目标、状态和 delivery manifest。 |
| `campaign.batch.pause` / `campaign.batch.resume` | 状态与 revision 正确变化；相同幂等键重放、意图冲突和过期 revision 断言通过。 |
| `task.create` / `task.create.draft` | 正式任务和无商店的 candidate-only 任务分别创建；候选不能直接发布。 |
| `task.clone` | candidate-only 任务可克隆；非法绑定商店被拒；另有带认证的跨租户克隆拒绝测试。 |
| `task.select_direction` / `task.plan.confirm` | 状态依次进入 direction_selected、plan_confirmed。 |
| `task.answer` | 非法改绑商品被拒；`task-answers.e2e` 验证创建时回答及商品事实确认持续存在。 |
| `task.resume` | `task-answers.e2e` 在提交回答前恢复已有任务并读回待答问题。 |
| `task.timeline` | 返回 `task.created` 与 `task_feedback_submitted` 事件。 |
| `feedback.submit` / `feedback.list` | 已有任务、内容版本下提交 neutral 反馈并读回一条；另有 REST 反馈跨工作区拒绝。 |
| `creative.brief` / `creative.preview` | 商品图片测试通过 banner/video brief 和 banner preview，验证尺寸、SKU 关联与不受信营销声明的阻断。 |

命令 `npx vitest run apps/plugin/mcp/bridge.test.ts apps/api/src/mcp-content-knowledge-http.e2e.test.ts apps/api/src/mcp-completion-content.e2e.test.ts --no-file-parallelism`：**3 文件、100/100 测试通过**。其用例包括桥接门禁、带认证 MCP 的 `task.request.create`、`task.sku.split`、`creative.directions.update` 和跨租户权限。

## 未完成的成功路径

生产 demo 的 `task.history` 和 `campaign.batch.list` 当前均为空，因此真实商家权限下无法读取已有正式任务或计划，也无法在 ChatGPT App 展示后续操作结果。插件的交互写门禁此前对写方法返回 `INTERACTIVE_WRITE_DISABLED`；本轮隔离 API 成功不等于生产 App 成功。生产批量生成 `campaign.batch.generate`、失败重试 `campaign.batch.retry_failed` 仍被插件商业门禁隐藏。`task.group.create` 的当前 HTTP MCP 用例只覆盖无商店与越权失败路径，尚缺成功路径。`creative.directions.update` 的隔离成功路径已覆盖，仍待逐方法 App 实际验收。

本轮无源码修复，也未改动生产数据。把上述方法的线上状态保持为原有未完成或预期阻断，不能据 193 个隔离测试宣称全部插件功能通过。
