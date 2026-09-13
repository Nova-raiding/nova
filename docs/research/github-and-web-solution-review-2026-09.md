# GitHub / 全网方案调研与采用决策（2026-09）

> 范围：桌面 ChatGPT 商家插件、MCP/API、六平台连接器、五模态模型中转、发布对账和运营后台。本文只记录可验证的公开方案与本仓库的采用决策，不复制外部项目代码。

## 结论

本项目不应整体替换为某个电商开源平台。当前目标是“ChatGPT 插件 + 商家营销工作流 + 受控平台写入”，而不是通用商城或 OMS。最适合吸收的是三个结构性模式：

1. 连接器按 capability port 拆分，平台只实现自己具备的能力，并由运行时 readiness/guard 决定是否开放。
2. 外部副作用使用 UNKNOWN 保留、签名回执、独立 reconciliation 和 conformance/mutation 验收。
3. MCP 使用 OAuth Protected Resource Metadata、scope challenge、短期令牌和每工具授权检查。

## 候选方案

### OpenLinker：连接器能力端口

来源：[openlinker-project/openlinker](https://github.com/openlinker-project/openlinker)

公开实现强调：统一的 capability ports、每个连接多个店铺、统一 ID mapping、连接器测试、OAuth、凭据校验、retry classification 和 outcome tracking；其文档把集成拆成 catalog、inventory、orders、content suggestion 等能力，而不是让每个平台实现一个巨型接口。

采用决策：**采用设计思想，不复制代码**。

落地到本项目：

- 保留 `packages/connectors` 的平台独立配置。
- 将每个平台 readiness 拆成 OAuth、read、write、mapping、media、receipt 六类证据。
- 新增平台时只实现该平台支持的 capability，未实现能力返回稳定 `NOT_CONFIGURED`/readiness 阻断。
- 每个连接器必须有 fixture、contract、真实 canary 三层测试。

### durable-agent-outbox：外部副作用和 UNKNOWN

来源：[mstevens843/durable-agent-outbox](https://github.com/mstevens843/durable-agent-outbox)

公开实现提供十二状态状态机、canonical idempotency key、签名 receipt、audit legality checker、Postgres/SQLite store，以及 17 个 conformance 场景和故意损坏的实现来证明测试确实能抓住错误。

采用决策：**采用 UNKNOWN/receipt/conformance 思路；不直接引入 pre-1.0 依赖**。

落地到本项目：

- `publish`、图片生成、模型费用结算都不能自行解释 UNKNOWN。
- 远端状态和 provider usage/cost 必须从独立证据源回读。
- 继续强化“相同意图重放成功、不同 payload 幂等冲突、撤销不跨越已发生副作用”的测试。
- 为发布和模型结算增加负向测试/突变测试，而不是只验证 happy path。

### MCP 官方规范：OAuth Resource Metadata

来源：[MCP Authorization Specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx)

规范要求 MCP server 提供 Protected Resource Metadata，并通过 `authorization_servers` 暴露授权服务器；401 响应可以携带 `resource_metadata` 和 scope challenge，客户端需要支持 OAuth/OIDC discovery。

采用决策：**保留并继续验证现有实现**。

CodeGraph/源码已确认 `apps/api/src/server.ts` 包含：

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-authorization-server`
- `authorization_servers`
- `code_challenge_methods_supported: ['S256']`
- `/mcp` 401 时的 `WWW-Authenticate` metadata 指向

后续应增加直接 HTTP acceptance test，验证 metadata URL、issuer、audience、scope 和 challenge 在生产 origin 下仍一致。

### OpenOMS：运营后台和多租户 OMS

来源：[openoms-org/openoms](https://github.com/openoms-org/openoms)

公开方案包含多租户、PostgreSQL RLS、RBAC、自定义状态、CSV 导入预览、自动化规则、后台审计、2FA、Webhook 和后台分页。

采用决策：**只借鉴运营后台的产品模式，不替换现有领域模型**。

适合吸收：

- 导入必须先预览再确认。
- 队列需要状态、筛选、重试分类和负责人。
- 每个后台动作显示 revision、原因和审计结果。
- 多租户列表默认服务端分页。

## 与当前方案的差距

| 领域 | 当前代码 | 主要缺口 | 优先级 |
| --- | --- | --- | --- |
| MCP | Bridge、共享注册表、OAuth metadata、工具隐藏 | 实时工具数与部分旧文档存在漂移；需发布时自动冻结 | P1 |
| 连接器 | 六平台配置和映射框架 | 真实 OAuth/read/write/media canary 尚未全齐 | P0 |
| 模型 relay | 五模态、usage/cost、UNKNOWN、结算 | 生产环境证据和真实 provider 回执未齐 | P0 |
| 发布 | prepare/confirm、哈希、远端回查、reconcile | 真实平台回执和连续 canary 未齐 | P0 |
| 批量任务 | 可恢复批量计划、逐项状态 | 需要更强的负向/conformance 覆盖 | P1 |
| 知识库 | 规则、素材、品牌、学习、竞品上下文 | 持久 documents/chunks/vector 自动绑定仍不完整 | P1 |
| 运营后台 | RBAC、工作区/平台双工作台、审计 | 全量分页和生产身份仍需验收 | P1 |

## 本轮已验证

2026-09 当前工作区执行：

```text
8 test files passed
214 tests passed
CodeGraph index state: complete
CodeGraph: 1,240 files / 17,494 nodes / 65,953 edges
```

定向测试覆盖 Bridge、商家对话、MCP surface、插件 manifest、发布确认、商业执行、模型 generator 和 relay pricing。

注意：CodeGraph 当前仍报告 1 个新增、4 个修改文件待同步；它可以证明结构关系，不能证明生产配置或外部平台已上线。

## 下一轮实施顺序

1. 把 MCP tools/list 数量、隐藏规则、manifest、shared registry 绑定成单一 release gate。
2. 为 connector capability readiness 建立统一的正向/负向 contract matrix。
3. 为 publish/model settlement 加入 conformance + mutation 风格的 UNKNOWN 测试。
4. 增加 MCP OAuth metadata 的 HTTP acceptance test，并在 HTTPS/public origin 约束下验证。
5. 只在上述测试稳定后，继续进行桌面浏览器、容器和真实外部 canary 验收。

