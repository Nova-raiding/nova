# 插件商家知识库到发布链路审计（源码证据）

审计范围：`apps/plugin/mcp/bridge.mjs`、商家营销 skill、MCP/authz 契约及 API 知识库/内容处理器。

## 已确认存在的闭环

- 插件暴露素材、品牌、任务、审核、版本、发布和知识库方法；`bridge.mjs` 对商家隐藏 `ops.*` 及内部 Codex 生成入口。
- API 在 `server.ts:401-406` 以工作区为范围注入知识上下文；`buildBoundedKnowledgeGenerationContext` 在 `server.ts:367-384` 只选 active 规则、已批准且权益为 cleared 的知识资产、confirmed 学习建议，并限制数量。
- `content.review.decide`、`content.modify`、`content.approve`、`publish.prepare/confirm` 均存在服务端处理和快照/审计事件；知识规则、资产、反馈、学习建议和竞品分析也有持久化事件（`server.ts:15442-15556`）。
- 相关 HTTP E2E：`apps/api/src/mcp-content-knowledge-http.e2e.test.ts` 通过，1 个文件/1 个测试通过。

## 生产级缺口

### P1：商家规则需要明确分层

MCP/authz 契约把 `knowledge.rule.create` 列在 `customer.content.update`（`packages/contracts/src/authz.ts:480`）。处理器现已允许 canonical `reviewer`，并继续拒绝没有规则治理权限的 `workspace_owner`；平台规则的发布/激活仍需要独立审批。需要继续在产品层明确 merchant draft rule 与官方 platform rule 的分层。

结果：具备 reviewer 权限的商家可写入草稿规则，平台规则发布仍由规则治理角色控制。仍需产品决策：是否为普通 owner 增加受限 merchant rule 草稿入口，并与官方规则明确分层。

### P1：竞品分析写入也不是所有商家可用

`knowledge.competitor.create/reference` 处理器要求 `competitor_reviewer` 或运营角色（`server.ts:15538-15555`），而 authz 契约同样把它们放在 `customer.content.update`（`authz.ts:480`）。普通工作区 owner 未必具备该额外角色，因此“同行创意”入口存在角色错配风险；应补 owner/operator 真实身份 E2E 或拆出商家可写的竞品观察权限。

### P2：插件层未强制“生成前三类知识查询”

Skill 要求每次正式生成前依次读取 `knowledge.rule.list`、`knowledge.asset.list`、`knowledge.learning.list(status=pending)`（`apps/plugin/skills/merchant-marketing/SKILL.md:147-151`）。bridge 的 `tools/call` 只是转发单次调用并做结果包装（`bridge.mjs:2636-2668`），没有会话级前置查询证明或阻断。服务端确实在生成时直接从 `knowledgeForWorkspace` 构造快照，但这不能证明宿主对话完成了要求的读取/展示步骤。若该顺序是硬门禁，应由 API 生成入口记录知识读取/确认快照，或由任务状态机强制，否则只能视为提示词协议。

### 已修复：反馈记录补齐 actor 审计

`knowledge.feedback.record` 现已取得 `requestActor(req)`，将 `actor_id` 写入反馈事件，并调用 `recordOperationAudit`。知识 HTTP E2E 已回归通过；仍可补充断言审计记录内容的专门测试。

## 未修改代码

本次只做源码/测试审计，没有对业务代码做修改；唯一验证命令为：

`pnpm vitest run apps/api/src/mcp-content-knowledge-http.e2e.test.ts`（通过）。
