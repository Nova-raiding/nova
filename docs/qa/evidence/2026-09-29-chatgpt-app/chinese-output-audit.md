# Store Nova 插件中文输出只读审计

审计范围：当前清单的 116 个已暴露工具所依赖的 MCP → API 返回路径。此文为源码与 CodeGraph 调用关系审计，不是 ChatGPT App 逐项实测通过证据。未操作桌面 App、未调用生产写接口、未修改桥接器。

## 可直接到达用户的英文

| 优先级 | 路径和证据 | 用户影响 | 最小处理建议 |
| --- | --- | --- | --- |
| 高 | `packages/contracts/src/mcp.ts:1704-1812` 的 `validateMcpRequest` 生成 `request must be an object`、`params.<字段> is required`、`must be valid JSON` 等英文。`apps/api/src/server.ts:10506-10507` 将这些 `errors.join('; ')` 原样作为 `DomainError` 消息返回。 | 116 项工具只要参数缺失或格式错误，ChatGPT 可见的错误解释是英文。 | 在契约校验层给这些固定模板提供中文消息，同时保持字段名、错误码和参数 schema 不变；补缺参、JSON 错误及特殊 URL 错误的契约/API 测试。若桥接器做中文展示，仍需确保 API 的错误消息不向其它桌面入口泄漏英文。 |
| 高 | `apps/api/src/mcp-catalog-batch-import.ts:79-80` 将 `SKU price`、`SKU stock` 拼进面向商家的“必须是非负数字”；同文件第 80 行使用纯英文 `price`、`stock`、`sku_count` 作为字段标签，第 84 行还有 `price/stock 无效`。 | Excel/CSV 或商品 JSON 批量导入出错时，用户需要猜测价格、库存含义。 | 只翻译错误中的字段显示名为“SKU 价格”“SKU 库存”“价格”“库存”“SKU 数量”；JSON 参数名保留原值。 |
| 中 | `packages/application/src/spreadsheet-batch.ts:101,117,119` 的真实表格解析错误写作 `platform 和 title 表头`、`platform不能为空`、`title不能为空`；`mcp-catalog-batch-import.ts:45` 将 `SpreadsheetBatchImportError.message` 透传。 | 使用中文模板的商家遇到缺列时仍会看到英文列名，可能找不到对应列。 | 错误写明“平台（platform）”“商品标题（title）”，并保持模板机器列名的可复制性；将对应列名与行号显示在中文说明中。 |
| 中 | `apps/api/src/mcp-first-value-preview.ts:100,124,132-142` 的 `nextActions`/`next_actions` 文本把 `content.generate`、`platform + account_id`、`workspace.health` 等方法或参数直接放在中文操作说明里。 | 正文大体中文，但普通商家会看到无法理解的内部方法名。 | 对用户可见建议改成“生成正式内容”“选择平台和店铺”等中文操作；机器可执行的 `method`/`next_action` 字段仍保留原协议标识。 |
| 中 | `apps/api/src/mcp-workspace-overview.ts:79-103`、`mcp-billing-status.ts:20-36`、`mcp-subscription-v2-projection.ts:22,58` 返回 `required/pending/blocked`、`known/unknown`、`included_quota_available/recharge_required` 等英文状态值；同一结果也含中文 `title`、`summary`、`message`。 | 若模型直接抄出状态值，最终回答可能中英混杂。 | 在 ChatGPT 展示层映射状态为中文短语；协议枚举继续保留，避免破坏客户端与测试。重点覆盖待处理、未知、额度不足、已完成四类。 |
| 中 | `packages/contracts/src/mcp.ts` 的方法 `description` 大量使用英文（源码 `description:` 英文开头的行约 229 条，含隐藏方法），例如第 735、739 行的商业能力描述；桥接器从契约构建工具定义。 | 工具描述可能影响 ChatGPT 如何理解及复述结果。 | 逐项核对当前 116 项 `tools/list` 描述；面向模型的自然语言说明改为中文，保留工具名、schema、参数键。隐藏方法不计入当前 App 覆盖。 |

## 边界与验收

- `codegraph status .` 显示已有索引 2,343 文件、33,756 节点；使用 `codegraph explore` 追踪了 `handleCatalogSearch`、`billingStatusProjection` 等 API 投影，并以源码行核对上表。索引有待同步文件，所以结论以当前磁盘源码为准。
- 工具名、JSON 键、错误码、状态枚举是协议数据；不建议在服务端任意翻译其取值。需要中文的是错误正文、展示标签、操作建议和 ChatGPT 最终回复。
- 对 `support.customer.replies.list` 等来自商家或客服输入的正文，不能静态保证原文全中文；展示层应将英文原文和中文解释区分，避免改写证据。
- 此审计没有测到当前安装版 App 的真实输出。修复后应在全新 ChatGPT 会话中用中文提示，分别触发缺参、表格缺列/数值错误、工作区状态与额度状态，保存工具原始结果和最终中文回复；不能将空数据或预期拒绝记为业务正向通过。
