# 知识库 9 项工具：本地 stdio 安全门禁验证

- 时间：2026-09-29 13:09 CST。
- 测试对象：已安装 Store Nova 插件 `0.1.0+codex.20260929125100`，`mcp/bridge.mjs`，从 `tools/list` 实测暴露 116 项工具，以下 9 项均在列表中。
- 工作区：`ws_57fd2361ed5b44c7891f3d37`（独立 QA 工作区）。
- 安全设置：子进程显式设置 `MERCHANT_MCP_WRITE_ENABLED=false`、`MERCHANT_STRICT_AUTH=true`、`MERCHANT_ALLOW_FIXTURE_FALLBACK=false`。未调用 `workspace.interactive.confirm`。测试用子进程不加载商家凭据；前 8 项在桥接门禁处返回，未请求生产 API。该验证**不是 ChatGPT App 内验收**，也不是写入成功证明。

| 工具 | 最小安全参数（示例） | 本次 stdio 结果 | 结论 |
| --- | --- | --- | --- |
| `knowledge.rule.create` | `{"name":"QA 门禁验证","content":"仅验证本地写入门禁，不提交","scope":"global","source_kind":"internal","source_reference":"qa://gate-only","source_checked_at":"<当前 ISO 时间>","version":"qa-1","status":"draft"}` | `INTERACTIVE_WRITE_DISABLED`，`isError=true` | 本地写入门禁通过；正向写入未测 |
| `knowledge.asset.create` | `{"kind":"brand","name":"QA 门禁验证","content_json":"{}"}` | 同上 | 同上 |
| `knowledge.asset.update` | `{"asset_id":"qa_nonexistent","content_json":"{}"}` | 同上 | 同上；正向测试需先创建 QA 资产 |
| `knowledge.brand.preference.update` | `{"preferences_json":"{}","version":"qa-1"}` | 同上 | 同上 |
| `knowledge.feedback.record` | `{"kind":"feedback","reason":"QA 门禁验证，不提交"}` | 同上 | 同上 |
| `knowledge.learning.confirm` | `{"suggestion_id":"qa_nonexistent"}` | 同上 | 同上；正向测试需 QA 学习建议 |
| `knowledge.learning.dismiss` | `{"suggestion_id":"qa_nonexistent"}` | 同上 | 同上；正向测试需另一条 QA 学习建议 |
| `knowledge.competitor.create` | `{"competitor_name":"QA 门禁验证","source_json":"{}","summary":"仅验证本地写入门禁","structure_json":"{}","selling_points_json":"[]","expression_json":"{}"}` | 同上 | 同上 |
| `knowledge.competitor.reference` | `{"competitor_id":"qa_nonexistent","own_brand_name":"QA 品牌","own_selling_points_json":"[]"}` | 仅用不可连接的 `127.0.0.1:1` 和无凭据子进程调用，返回 `MCP_AUTH_REQUIRED` | **不受本地写入确认门禁保护**；生产正向路径未测 |

前 8 项的实际中文消息均为“当前操作需要商家明确确认。请先确认后继续；如果创意点余额为零、待确认或不足，系统只会返回服务端授权的恢复入口。”第 9 项先用空参数验证到桥接 schema 错误“缺少必填字段 competitor_id”；再用完整参数、不可连接的本地端点和空凭据，验证它跳过写入确认门禁，停在 `MCP_AUTH_REQUIRED`，未触达生产 API。

## 发现与后续验收条件

`knowledge.competitor.reference` 位于桥接 `SAFE_WITHOUT_INTERACTIVE_WRITE` 集合。注释称其“只创建审计记录”，但 API 的 `mcp-knowledge-handlers.ts` 在成功构建差异化参考后确实执行 `recordOperationAudit`。因此它会改变审计状态；在用户要求确认所有写入的语境下，应决定是否也要求 `workspace.interactive.confirm`，并补充契约/回归验证。本轮没有对生产端点运行这项有效调用。

完整正向验收仍需：确认 ChatGPT App 的身份确实绑定此 QA 工作区；准备测试规则、资产、品牌偏好、反馈与两条学习建议、公开竞品测试资料；在明确打开写入会话后通过 App 调用，并核对同租户对象、版本、来源、审计及数据库前后差异。不可把本轮 8 项拒绝结果计为 8 项业务功能通过。

直接用 macOS Keychain token source 在无 GUI 的 shell 启动已安装桥接时，`initialize` 15 秒未响应；改用无凭据、`NODE_ENV=test` 的隔离子进程后完成上述本地门禁检查。这也意味着本轮证据不覆盖真实 ChatGPT App 的 Keychain 鉴权链路。
