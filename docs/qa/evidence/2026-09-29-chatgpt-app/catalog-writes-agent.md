# 商品资料写入接口：本地插件拒绝路径核验

2026-09-29，使用当前已安装的 `merchant-marketing/0.1.0+codex.20260929125100/mcp/bridge.mjs`，对独立测试工作区 `ws_57fd2361ed5b44c7891f3d37` 执行 11 次标准 MCP `tools/call`。`launchctl` 中的工作区为同一 ID，`MERCHANT_MCP_WRITE_ENABLED=false`。调用进程显式设置 `NODE_ENV=test`、`MERCHANT_MCP_TOKEN_SOURCE=environment`、不提供令牌，且将 API 地址指向只计数的本地 HTTP 监听器。监听器收到 **0 次** HTTP 请求。该方法验证已安装 bridge 的本地拒绝行为；**不是 ChatGPT App 调用，也不是线上业务成功证据**。

| 工具 | 本次入参摘要 | 实际结果 | API 转发 | App 内安全试呼参数 |
| --- | --- | --- | --- | --- |
| `catalog.title.optimize` | 仅非法字段 `__qa_schema_probe__` | `INTERACTIVE_WRITE_DISABLED`，中文提示 | 否 | `{}`；预期交互写门禁 |
| `catalog.title.accept` | 同上 | `INTERACTIVE_WRITE_DISABLED`，中文提示 | 否 | `{}`；预期交互写门禁 |
| `catalog.import` | 同上 | `INTERACTIVE_WRITE_DISABLED`，中文提示 | 否 | `{}`；预期交互写门禁 |
| `catalog.import.batch` | 同上 | `INTERACTIVE_WRITE_DISABLED`，中文提示 | 否 | `{}`；预期交互写门禁 |
| `catalog.sku.update` | 同上 | `INTERACTIVE_WRITE_DISABLED`，中文提示 | 否 | `{}`；预期交互写门禁 |
| `catalog.product.update` | 同上 | `INTERACTIVE_WRITE_DISABLED`，中文提示 | 否 | `{}`；预期交互写门禁 |
| `catalog.facts.confirm` | 同上 | `INTERACTIVE_WRITE_DISABLED`，中文提示 | 否 | `{}`；预期交互写门禁 |
| `catalog.image.generate` | 仅非法字段 `__qa_schema_probe__` | JSON-RPC `-32602`，中文“不支持的字段” | 否 | `{"size":"invalid"}`；预期本地参数校验 |
| `catalog.image.select` | 仅非法字段 `__qa_schema_probe__` | JSON-RPC `-32602`，中文“需要…SHA-256 确认票据” | 否 | `{}`；预期确认票据校验 |
| `catalog.image.review` | 仅非法字段 `__qa_schema_probe__` | JSON-RPC `-32602`，中文“缺少必填字段 product_id” | 否 | `{}`；预期本地参数校验 |
| `brand.upsert` | 仅非法字段 `__qa_schema_probe__` | `INTERACTIVE_WRITE_DISABLED`，中文提示 | 否 | `{}`；预期交互写门禁 |

`catalog.image.generate`、`catalog.image.select`、`catalog.image.review` 在 bridge 的交互写豁免集合里，因此**不能**用真实有效参数做这一轮无副作用测试；`image.review` 会持久化审查快照。其余 8 项本地先查交互写门禁，再查参数。所有调用未使用真实商品、品牌、SKU、素材或贵人鸟数据。

## 待办与计数口径

- 11 项均完成“已安装 stdio bridge 拒绝路径”一轮，**0 项**完成正向业务链路或 ChatGPT App 证据；不可计为 11 项功能通过。
- owner 在 App 中用上表安全参数复核时，需要读取真实 `tools/call` 记录及返回，不能只根据模型文字判断。开始真实写入前须再次核对 App 的身份与工作区为独立 QA 工作区，准备真实 QA 商品和权益，并取得对应交互写确认。
- 本地返回文本均为中文；原始错误码与 JSON-RPC 数值保留作诊断。
