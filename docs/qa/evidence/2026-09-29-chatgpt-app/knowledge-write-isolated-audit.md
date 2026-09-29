# 知识库写入流程隔离验证 — 2026-09-29

## 验证边界

本轮使用临时测试工作区、测试身份和本地随机端口，经实际 HTTP `POST /mcp` 调用 API。测试中的商品、规则、资产、反馈和竞品均为隔离数据；**没有对生产工作区写入，也没有在 ChatGPT App 中执行知识库写入**。生产 App 的五项知识库只读调用另见 [只读证据](catalog-knowledge-readonly-audit.json) 和 [App 截图](21-chatgpt-work-knowledge-readonly-top.png)。

CodeGraph 查询 `handleMcpKnowledgeMethod` 定位到 `apps/api/src/mcp-knowledge-handlers.ts:38`；随后核对了 API 处理器、插件桥接器方法定义和现有测试。

## 实际执行结果

| 方法 | 隔离 HTTP/MCP 结果 | 证据 |
| --- | --- | --- |
| `knowledge.rule.create`、`knowledge.rule.list` | 草稿创建与查询成功；直接创建启用规则被拒绝。 | `apps/api/src/mcp-content-knowledge-http.e2e.test.ts`、`apps/api/src/knowledge-rule-update-http.regression-1.e2e.test.ts` |
| `knowledge.rule.update` | 可信来源草稿可由规则管理员按版本和审计原因启用；越权、旧版本、未验证人工来源均被拒绝。 | `apps/api/src/knowledge-rule-update-http.regression-1.e2e.test.ts`、`apps/api/src/knowledge-consumption.e2e.test.ts` |
| `knowledge.asset.create`、`knowledge.asset.update`、`knowledge.asset.list` | 创建、审批/权益更新、列表读回成功；跨工作区读取被拒绝。 | `apps/api/src/mcp-content-knowledge-http.e2e.test.ts` |
| `knowledge.brand.preference.get`、`knowledge.brand.preference.update` | 临时本地 HTTP 会话：初始读取返回 `null`；写入草稿后返回 `revision=1`，再次读取到相同偏好；旧版更新返回 HTTP 400 `VERSION_CONFLICT`。 | 本轮一次性 `node --import tsx` 本地 HTTP 调用；未保存令牌或业务数据 |
| `knowledge.feedback.record`、`knowledge.learning.list` | 两类反馈均成功生成待确认学习建议，列表可读回。 | `apps/api/src/mcp-content-knowledge-http.e2e.test.ts` |
| `knowledge.learning.confirm`、`knowledge.learning.dismiss` | 分别将测试建议变更为 `confirmed`、`dismissed`；确认记录不会自动启用规则。 | `apps/api/src/mcp-content-knowledge-http.e2e.test.ts` |
| `knowledge.competitor.create`、`knowledge.competitor.list`、`knowledge.competitor.reference` | 公开竞品结构化录入和读回成功；差异化参考返回 `differentiation_only`，并标记未复制竞品原文或品牌。 | `apps/api/src/mcp-content-knowledge-http.e2e.test.ts` |

执行命令：

```text
node --import tsx scripts/run-safe-tests.ts --no-file-parallelism apps/api/src/mcp-content-knowledge-http.e2e.test.ts apps/api/src/knowledge-rule-update-http.regression-1.e2e.test.ts apps/api/src/knowledge-consumption.e2e.test.ts packages/knowledge/src/knowledge.test.ts
```

结果为 **4 个文件、21/21 项通过**。另执行完整插件桥接器测试：

```text
npx vitest run apps/plugin/mcp/bridge.test.ts --no-file-parallelism
```

结果为 **98/98 项通过**。桥接器默认生产配置要求知识库写入先经过 `workspace.interactive.confirm` 的交互确认；`knowledge.competitor.reference` 只生成审计记录，是此门禁的显式例外。隔离 API 成功与桥接器门禁通过，均不代表 ChatGPT App 生产写入成功。

## 待完成

需在 ChatGPT App 的真实本地直装插件会话中，使用明确标记的测试数据逐项执行知识库写入、读回和审计核对，记录 App 可见结果及生产服务端证据。在完成前，这 15 个方法只能标记为“隔离 API/MCP 验证”，不能标记为生产全流程通过。
