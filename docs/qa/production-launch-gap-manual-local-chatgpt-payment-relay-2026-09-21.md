# 生产上线差距审计：人工运营、本地 ChatGPT、支付与模型中转

日期：2026-09-21  
范围：仅审计 `manual operations`、桌面 `local_stdio` ChatGPT 插件链路、支付与五模态模型中转证据门禁。  
结论：**NO-GO**。源码门禁总体存在，但当前工作树没有绑定本次候选 release 的完整真实证据包；历史或本地文件不能替代生产证据。

## 根因

1. 人工运营独立校验器此前只要求“至少三个名为任意值的 pass 检查”，没有要求 `tenant_scope`、`manual_report`、`merchant_visibility` 三个语义检查，也没有拒绝模拟、过期或未来证据。外层 release manifest/bundle 会继续做哈希、签名和 release 绑定，但独立 manual gate 本身可接受泛化或陈旧 JSON，形成分层门禁不一致。
2. 本地 ChatGPT 部署是 `local_stdio bridge -> HTTPS /mcp`，不是远程 ChatGPT OAuth。代码已经隔离两种模式，并要求真实 ChatGPT/Codex App 宿主证据；本地 fixture、curl 或 localhost MCP origin 均不能替代宿主验收。当前工作树未发现本次候选的 `codexAppHost` 生产 evidence。
3. 支付门禁已经要求真实 provider 的 checkout、callback、callback replay、provider query、reconciliation、refund 六份独立不可变证据，并绑定 release、镜像、manifest、Git SHA、deployment nonce 和 Ed25519 信任锚。当前工作树未发现可用于本次候选的 payment evidence。
4. 模型中转门禁已覆盖 text、image、image_edit、ocr、video 五模态，要求 provider request ID、实际 usage、实际人民币 cost、不可变回执、生产 HTTPS relay 和不超过 24 小时的有效期。仓库中只有 `artifacts/model-relay-live-20260905/` 历史文件；它早于本次审计 16 天，且不能绑定当前 release，必须重新采集。

## 门禁矩阵

| 链路 | 源码门禁 | 本次候选真实证据 | 判定 |
|---|---|---|---|
| 六平台人工运营 | `manual-operations-evidence-gate.ts` + production config + release manifest/bundle | 未提供当前 release 的新鲜、非模拟 evidence | BLOCK |
| 本地 ChatGPT 插件 | `MCP_INTEGRATION_MODE=local_stdio`、OAuth 污染拒绝、host evidence gate | 未提供当前 release、bridge SHA 和公网 MCP origin 绑定的真实宿主 evidence | BLOCK |
| 支付 | provider config + signed production payment evidence | 未提供真实支付全流程 evidence | BLOCK |
| 五模态模型中转 | relay config + production relay evidence | 仅有 2026-09-05 历史文件，不可用于当前 release | BLOCK |
| 统一发布绑定 | release manifest + signed evidence bundle | 上述任一项缺失即不能生成合格 bundle | BLOCK |

## 本轮门禁修复

人工运营 evidence 现在必须同时满足：

- `simulated=false`；
- 严格 UTC `generated_at` 与 `expires_at`；
- 生成时间不早于 24 小时、不晚于当前时间 5 分钟；
- 到期时间在生成后 24 小时内且当前未过期；
- `tenant_scope`、`manual_report`、`merchant_visibility` 三项均存在且通过；
- 检查名不可重复；
- 原有 production、release、workflow、无官方 API 回执和租户隔离约束继续保留。

新增定向测试覆盖合法证据、任意三项伪证据、模拟证据、陈旧/过期/未来证据和重复检查名。

## 上线前必须补齐

1. 在候选 release 确定后重新执行人工运营 canary，生成 24 小时内 evidence；不得复用 capability fixture。
2. 在真实 macOS ChatGPT/Codex App 中安装当前 bridge，按 `docs/chatgpt-host-canary-runbook.md` 完成全部场景并采集宿主证据。
3. 通过真实支付 provider 完成 0.01 元级 checkout/callback/query/reconciliation/refund 闭环，保留六份不同的不可变 artifact。
4. 对生产 relay 重新执行五模态探测，保存每模态 provider receipt、usage 和 cost；不接受 skipped modality。
5. 将全部 evidence 与同一 release ID、Git SHA、镜像集合、渲染 Compose manifest 和 deployment nonce 绑定，生成并验证 release manifest 与受保护签名 bundle。
6. 运行 `npm run typecheck && npm run test:release-gates`，随后按 `docs/runbooks/ecs-candidate-safe-sync.md` 执行 ECS preflight。任何一步失败都保持 NO-GO。

## 非结论

- 本审计没有连接生产主机、修改容器、写数据库或声称已完成真实 ChatGPT/支付/relay 验收。
- 单元测试通过只证明 fail-closed 规则存在，不证明外部 provider、宿主或生产数据链路可用。

## 定向验证结果

- `tests/manual-operations-evidence-gate.test.ts`：3/3 通过。
- `tests/production-config-gate.test.ts -t "requires release-bound manual workflow evidence"`：目标断言 1/1 通过；全仓 pending-assertion reporter 因命令主动跳过其余 35 项而将该过滤命令标为非零退出，因此不把它记作完整文件通过。
- `tests/mcp-integration-mode-release-gate.test.ts`、`tests/codex-app-host-evidence-gate.test.ts`、`tests/model-relay-evidence-gate.test.ts`、`tests/production-evidence-gate.test.ts`：合计 52/52 通过。
- 完整 TypeScript 检查未形成有效结果：独立 worktree 的依赖安装没有完成，借用主工作树 `tsc` 时当前 worktree 无法解析 `vitest`、`pg` 和 Node 类型。该环境问题不是源码通过证据，发布前仍必须在依赖完整的候选目录运行正式 `npm run typecheck`。
