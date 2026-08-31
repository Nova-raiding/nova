# 图片执行异常对账闭环：产品验收标准

版本：v1.0  
评审角色：资深产品经理  
评审日期：2026-08-31  
适用范围：ChatGPT 插件 → API/MCP → 图片生成 Worker → 模型中转 → 资产归档 → 商家桌面工作台/运营后台

2026-08-31 实施快照：Provider 状态接口已 fail-closed；Worker 已直接查询 Provider，并将扁平化状态/证据提交 API；API 写入不可变 `reconciliation_evidence`，迁移 096/097 已在本地 PostgreSQL 应用并通过 RLS、append-only 与幂等测试。真实 Provider 状态转换、usage/cost、平台宿主和生产发布证据尚未完成，因此本验收文档继续保留在 `doc/todo`。

## 1. 产品定义

“图片执行异常对账闭环”不是单纯的失败重试，也不是“接口返回 200”。它要求系统能够回答并留证：

1. 哪一个 workspace、商品/任务、请求事件和执行尝试发生了异常；
2. 模型供应商是否实际收到请求，供应商 request ID 是什么；
3. 生成结果、资产归档、扫描/真实性检查、候选事件和用量/扣费是否一致；
4. 系统如何在不重复调用模型、不重复扣费、不跨租户读取的前提下收敛；
5. 无法自动确认时，谁需要处理、下一步是什么、告警何时关闭。

目标状态链：

```text
queued → leased → provider_started →
  completed（业务成功且证据齐全）
  failed（确定失败且可解释）
  outcome_unknown（外部结果未确认，禁止盲重试）
```

业务侧还必须能区分：

```text
provider_completed → archiving → archived / reconciliation_required
```

`provider_started`、`outcome_unknown`、归档不完整、事件/用量/资产证据缺失，均属于“需要对账”，不能展示为成功。

## 2. 验收原则

- 业务真相以持久化数据库和可验证回执为准，内存 Map、静态类型和日志存在不算完成。
- 同一 `workspace_id + job_id + event_id + intent_hash` 是一次执行的绑定；任何字段不匹配必须 fail-closed。
- 已进入 `provider_started` 后，恢复路径只能查询、补偿和收敛，不能自动再次调用模型。
- 所有重试必须幂等；重复回调只能产生一份资产归档、一组候选事件和一笔用量结算。
- unknown 不得显示“已完成”，也不得给“再次生成/再次扣费”作为默认动作。
- 不同 workspace 的读取、租约、回调、对账和运营查询都必须被 API 鉴权与 PostgreSQL/RLS 同时限制。
- 生产结论必须使用真实中转、真实 PostgreSQL/RLS、真实对象存储和桌面浏览器证据；本地 fixture 只能证明契约。

## 3. P0 功能验收标准

| ID | 验收标准 | 必须看到的证据 | 当前判断 |
|---|---|---|---|
| RECON-P0-01 | 异常可定位 | job、workspace、event、attempt、provider request ID、trace/request ID、发生/更新时间可查询 | 本地闭环：Ops 对账查询与脱敏证据导出已覆盖 job/workspace/event/attempt/request ID/时间；生产 trace 与 Provider 证据仍待验证 |
| RECON-P0-02 | 状态不误报 | provider 超时、回调超时、API 重启、归档失败分别进入 `outcome_unknown` 或 `reconciliation_required`，不得进入成功 | 本地闭环：未知/归档不完整均 fail-closed，成功收口有归档与 clean 扫描门禁；跨进程故障注入仍待验证 |
| RECON-P0-03 | 跨 API 实例/重启可恢复 | API A 创建、API B hydration 后回调成功；API 重启后仍能查询并处理同一任务 | 本地 Compose 已实测 API A 写入商品/任务、API B 通过共享 PostgreSQL/Redis 读取成功；API 重启后同一图片任务回调与处理仍缺真实故障注入证据 |
| RECON-P0-04 | 安全对账 | 对 provider_started/unknown 先按 provider request ID 或幂等键查询；没有确定结果时保持 unknown | 部分完成：Worker 已按 provider request ID 查询并将结果交由 API 校验、持久化；未知响应 fail-closed；真实 Provider、usage/cost 和外部证据仍未验证 |
| RECON-P0-05 | 终态收敛 | provider 已成功且归档/事件完整才 `completed`；确定失败才 `failed`；无法确认必须进入人工对账 | 本地闭环：回调、人工 completed/failed 和 projection recovery 均有服务端门禁；真实 Provider 查询和补偿演练仍待验证 |
| RECON-P0-06 | 不重复执行 | Worker 崩溃、重复投递、重复回调、租约过期等场景下 provider 调用次数不超过业务允许次数，provider_started 后恢复不得重调 | 租约基础测试已有；需故障注入和跨进程证据 |
| RECON-P0-07 | 资产证据一致 | 候选对象、资产元数据、归档 receipt、候选事件与 job 终态可相互追溯；缺一项不可标记完成 | 未完成：归档原子性/补偿闭环仍是风险项 |
| RECON-P0-08 | 用量与账务一致 | provider request ID、usage、cost、action ledger/扣费、失败返还或待结算状态可关联；异常不得静默丢账 | 未完成：真实图片中转 usage/cost 与账务对账证据缺失 |
| RECON-P0-09 | 租户隔离 | workspace A 无法读取、claim、回调或对账 workspace B 的任务；RLS 和 HTTP 层均有否定测试 | 本地 RLS 已有证据；需纳入自动化发布门禁 |
| RECON-P0-10 | 操作闭环 | 对账任务有负责人、原因、最后动作、下一动作、告警状态和关闭依据；关闭不能仅依赖人工改状态 | 本地闭环：Ops 工作面、负责人分配、告警状态、证据/理由/revision/幂等收口、对账投影和不可变审计均已落地；真实通知到达、值班演练和生产观测仍待验证 |

## 4. P1 体验与运维验收标准

| ID | 标准 |
|---|---|
| RECON-P1-01 | 商家桌面端展示 queued、processing、archiving、failed、unknown、quarantined 的独立文案和下一步；unknown 主动作只能是刷新/查看对账。 |
| RECON-P1-02 | 页面刷新、后退、直接打开任务 URL 后保留 workspace、店铺、商品和任务上下文；不得创建第二个任务。 |
| RECON-P1-03 | 运营台展示缩略图、归档状态、扫描状态、真实性证据、人工审核、provider request ID、错误和处理记录；“视觉通过”不得冒充安全通过。 |
| RECON-P1-04 | 轮询、告警和对账任务有超时、退避、去重、死信/人工介入和恢复后的关闭规则。 |
| RECON-P1-05 | 所有异常可导出脱敏证据包，至少包含 release、job、event、attempt、状态转移、provider request ID、资产/用量关联和验证结果。 |

### 当前实现增量（2026-08-31）

- 已增加 `ops.marketing.image.evidence.export` MCP/API 操作，按 workspace 与 `job_id` 读取图片任务、执行租约、对账状态、Provider 观察、请求事件引用、资产摘要及 action/model usage 关联。
- 导出为 JSON，明确不包含图片字节、存储 URL/key、原始 Provider payload、凭据、完整 visual brief/聊天内容；同时返回 workspace、事件绑定、Provider request 绑定、计费关联和脱敏排除项校验结果。
- Ops Console 图片执行详情已提供“导出脱敏证据包”入口，并记录不可变运营审计事件。
- 仍不能将此项迁移到 `doc/done`：真实 Provider request、生产对象存储/扫描、模型用量成本和 ChatGPT Host 端导出下载证据仍需在真实环境闭环验证。

### P0-10 运营闭环增量（2026-08-31）

- 告警通知新增持久化投递账本（迁移 100），记录 `disabled`/`blocked`/`delivered`/`failed`、重试次数、请求 ID 与失败原因；告警入口保持异步，不因远端 Webhook 延迟阻塞业务响应。
- 该增量已通过迁移加载、通知契约和图片异常回归；真实 Webhook 到达、生产 PostgreSQL/RLS 和外部观测平台证据仍未完成，因此本验收文档继续保留在 `doc/todo`。

- 图片异常队列现在返回 `alertState`、`lastAction`、`nextAction`、负责人和 `closureEvidence`；超过 15 分钟未更新的执行进入 `open`，其余为 `monitoring`。
- 详情弹窗展示告警、最后动作和关闭依据；人工收口仍必须经过服务端状态、证据引用、理由、revision 和审计门禁，不能直接修改状态。
- 该增量仍未达到上线完成：告警通知渠道、值班演练、跨副本故障注入和真实 Provider/账务证据尚未完成。

### P0-07 资产证据一致性增量（2026-08-31）

- 归档审计不再只检查 receipt digest 的格式；现在按当前 workspace/job/asset、对象 SHA-256、大小、MIME 和候选创建时间确定性重算 digest，合法长度但内容被篡改的 receipt 会返回 `ARCHIVE_RECEIPT_DIGEST_MISMATCH` 并继续阻断交付。API feature-gap 回归 22/22 通过；历史缺失 receipt、真实对象存储恢复和生产归档演练仍未完成。

- 每个生成候选在进入隔离区时生成 `archiveReceiptId` 与 `archiveReceiptDigest`，并同时写入候选对象、资产隔离事件和 `product.image_candidates_generated` 事件。
- 脱敏证据包导出候选级归档 receipt 引用；生成链在自动标记归档完成前要求候选具备 asset、receipt、摘要和 clean 扫描状态。
- 兼容历史 fixture/旧快照时 receipt 字段仍可为空，因此本项仍需历史数据回填/一致性扫描、归档失败恢复演练和真实对象存储证据，不能迁移到 `doc/done`。
- 新增只读 `ops.marketing.image.archive.audit` MCP/API 操作，按 workspace 扫描已有候选并报告 asset 缺失/越权、receipt 缺失或摘要格式错误、未 clean/仍在 quarantine 等缺口；扫描结果和下一动作写入运营审计，不自动改写历史数据。
- 审计只证明缺口可发现，不代表历史数据已修复；在完成受控回填、归档失败补偿/孤儿清理和真实对象存储演练前，P0-07 继续保持未完成。
- 图片候选的读取、clean 判断和归档完成判断已统一要求 asset 关联候选具备 `archiveReceiptId`、64 位 `archiveReceiptDigest`，避免旧路径只依赖扫描状态而绕过归档证据；无 asset 的历史 fixture 仍保持兼容并继续不可交付。
- 归档审计进一步校验候选输出保存的 MIME、大小、SHA-256 和 storage key 必须与当前资产一致；发现 `ASSET_METADATA_MISMATCH` 时只报告缺口并阻断可信收口，不自动改写历史候选。`feature-gap.e2e.test.ts` 归档审计回归 23/23 通过，TypeScript、差异检查和 CodeGraph 同步通过。历史 receipt 回填、真实对象存储恢复和跨副本故障演练仍未完成，因此 P0-07 继续保留在 `doc/todo`。

### P0-08 用量与账务关联增量（2026-08-31）

- 图片账务审计进一步收紧：除 action/usage 存在及 settlement 外，逐条校验 execution、action ledger、model usage 的 Provider request ID 一致性，并要求非 waived usage 具备实际 `costCny` 与 `customerChargeCny`；缺失、错配或多 request ID 会返回明确阻断码。API/模型结算相关回归 88/88 通过；真实 Provider usage/cost 与钱包对账仍未完成。
- 告警 Webhook 增加统一 outbound URL 主机校验；staging/production 必须显式配置 `OPS_ALERT_WEBHOOK_ALLOWED_HOSTS`，缺失、内网地址或未列入 allowlist 时 fail-closed，避免异常通知成为 SSRF 旁路。通知契约回归 2/2 通过；真实通知到达、值班演练和生产密钥仍未验收。

- 新增只读 `ops.marketing.image.billing.audit` MCP/API 操作，按任务核对请求事件中的 `action_id`、执行记录中的 Provider request ID、Action Ledger、Model Usage 记录及结算状态。
- 缺少 request ID、请求事件、action ledger、usage/cost 关联、Provider request 绑定或最终结算时，返回明确错误码和人工下一动作；不会自动扣费、退款或把异常任务标记为可交付。
- 本地代码和测试不等同于真实图片中转成本证据；真实 Provider usage/cost、钱包结算和失败返还仍未完成，P0-08 继续保留在 TODO。
| RECON-P1-06 | 键盘可完成刷新、查看证据、进入人工对账和关闭；状态播报使用可访问的 status/alert，不依赖颜色。 |

## 5. 最小故障验收矩阵

| 场景 | 期望状态 | 禁止结果 | 必须保留的证据 |
|---|---|---|---|
| provider 请求前 Worker 崩溃 | 可重新 lease，最多一次有效 provider 请求 | 伪造成功、重复扣费 | attempt、lease、event |
| provider 已开始后 Worker 崩溃 | `provider_started` 或 `outcome_unknown`，进入查询/人工对账 | 再次调用 provider | provider request ID、时间线 |
| provider 明确失败 | `failed`，按 retryable 分类 | 当作 unknown 或成功 | 错误码、错误信息、usage/退款结论 |
| provider 成功但 callback 超时 | `outcome_unknown`，不盲重试 | 新建第二任务 | request ID、回调重试记录 |
| callback 已归档，Worker 在 completed 前崩溃 | 重放 callback/对账后 execution 与业务终态一致 | 再次生成 | archive receipt、事件、终态 |
| 对象已上传但事件/快照失败 | `reconciliation_required`，可补偿事件 | 返回 already_completed 后永久结束 | 对象 key、hash、缺失事件、补偿结果 |
| `error + images` 同时回调 | 请求拒绝，状态不改变 | 静默丢图并返回成功 | 协议错误审计 |
| 同一回调并发 N 次 | 一份资产/事件/终态 | 重复资产、重复候选、重复扣费 | 幂等键和数据库唯一性 |
| workspace A 访问 B | 401/403/404（按公开契约）且无数据泄露 | 返回 B 的任务/执行记录 | API + RLS 否定证据 |

## 6. 完成定义（Definition of Done）

只有同时满足以下条件，才允许把相关文档从 `doc/todo/<功能>/` 迁移到 `doc/done/<功能>/`：

1. P0 验收项全部通过；任何一项“部分”“未完成”“待生产配置”都不能迁移。
2. 状态机、API/MCP 契约、数据库迁移、Worker 行为、商家桌面端和运营台文案彼此一致。
3. 单元/API 测试通过，并有真实 PostgreSQL/RLS、跨进程或重启、故障注入、对象存储和用量/账务对账证据。
4. CodeGraph 已同步，调用链能从插件/MCP 入口追到 API、outbox、Worker、relay、归档、账务和查询端；不能只验证孤立模块。
5. 已运行与风险匹配的 typecheck、全量测试、release gates、桌面浏览器验收、容器健康检查；原始输出或可验证证据已归档。
6. 生产中转未配置、真实 provider request ID/usage/cost 缺失、生产 RLS/对象存储/回滚未验证时，结论必须是 NO-GO，文档留在 todo。
7. Owner 完成一次文档—代码反向核对，并在文档中记录 commit/release、证据路径、时间、环境和剩余风险。

## 7. 文档迁移规则

### 允许迁移到 done

- 仅迁移“已完成且可复核”的功能文档；原文中的验收项、证据链接、版本和状态必须保留。
- 目标路径为 `doc/done/<功能目录>/`，例如 `doc/done/worker/`；文件名保持稳定，必要时在标题注明完成版本。
- 若一个文档包含多个功能，只能拆分后分别迁移；未完成部分继续留在对应 `doc/todo/<功能目录>/`。
- 迁移前必须更新 `doc/README.md` 的索引和完成/未完成统计，且不得保留失效的 `docs/` 引用。

### 必须留在 todo

- 只有代码骨架、内存测试、静态契约、fixture、模拟 provider、本地 Compose 或“已配置”描述，没有真实运行证据。
- 任何 P0 未通过、生产配置缺失、unknown 无安全查询、归档/事件/账务存在裂缝、租户隔离只做了静态检查。
- UI 仅有状态标签或列表，没有真实创建、追踪、恢复、候选门禁和运营证据面板。
- 文档结论与当前代码/测试不一致；应先修订文档或补实现，不能通过迁移掩盖漂移。

### 不得使用的“完成”措辞

以下措辞不能作为 done 依据：`已接入`、`接口存在`、`测试通过`、`本地健康`、`已配置`、`回调返回 200`。必须明确环境、数据来源、调用次数、状态收敛和原始证据。

## 8. 当前产品结论

截至 2026-08-31，本功能判定为 **TODO / NO-GO（已完成安全对账骨架，未完成生产闭环）**：

2026-08-31 增量：修复 Worker 在 `MODEL_PROVIDER_OUTCOME_UNKNOWN` / `MODEL_USAGE_SETTLEMENT_PENDING` 时发送失败回执并把 Provider 已执行请求误收敛为 `failed` 的问题；此类错误现在保持 `outcome_unknown`。同时新增 migration 093 收敛旧 `merchant_app` 对 canonical/product listing/image execution 表的 DELETE/TRUNCATE 权限，并在图片执行 claim 阶段校验请求事件类型、任务聚合和 intent hash。上述代码与本地数据库验证通过，但不替代真实 Provider 查询、归档、账务和生产证据。

- 已有：普通图片 Durable Worker 的执行状态、租约/owner token、provider request ID 字段、回调事件绑定校验、部分回调幂等与本地 RLS 验证基础。
- 已补充：执行仓储支持按租户/状态列表查询；`provider_started/outcome_unknown` 可在已有业务成功/失败终态证据下受控收敛；`reconcile` Worker 已有定期调用 `/v1/internal/image-generation-jobs/reconciliation` 的入口；未知 provider 结果仍保持人工注意且禁止自动重试；新增内存仓储收敛与租户过滤测试。
- 未完成：真实 provider 状态查询、归档失败可恢复提交协议、完整资产—事件—用量/扣费一致性、跨进程并发/故障注入证据、运营人工对账闭环和生产中转证据。
- 因此，相关文档必须继续放在 `doc/todo/worker/`；不得迁移到 `doc/done/worker/`，不得将普通图片执行标记为生产 ready。

### 2026-08-31 当前复核增量

- Worker 对 Provider 已执行但结果/用量结算未知的异常统一保持 `outcome_unknown`，不发送失败回执、不退款、不自动重试。
- migration 093 已在本地真实 PostgreSQL 应用；`merchant_app` 对 canonical、listing 和 image execution 表的 DELETE 权限实测均为 false。
- API 执行 claim 已校验 `image.generation.requested` 事件、job aggregate 与 intent hash；canonical consistency 已阻断 dangling legacy mapping。
- 当前全量回归为 316 个测试文件通过、15 个跳过，2109 个测试通过、28 个跳过；发布门禁为 50 个文件通过、1 个跳过，314 个测试通过、6 个跳过。
- 本地容器重建后 API 双副本、Ops/Merchant UI、generation/reconcile/sync/scan/automation/publish worker、Postgres、Redis、ClamAV 均 healthy；MCP 实际回读包含 `canonical_scope` 与 `imageExecutions`。
- 仍未完成真实 Provider 状态查询、归档/账务一致性、生产 relay key/cost、正式 ChatGPT Host 和外部平台证据，结论保持 `TODO / NO-GO`，不得迁移到 `doc/done`。

### 2026-08-31 当前增量：异常队列负责人

- `ops.marketing.queue.assign` 现支持 `item_type=image`，复用图片任务 revision 乐观锁、workspace/角色门禁、快照持久化和 `workspace_operation_audit` 审计事件。
- Ops Console 图片异常行现在展示负责人并提供分配入口；分配不会改变 `provider_started/outcome_unknown` 状态，也不会触发 Provider、退款或自动重试。
- API E2E 已验证图片队列负责人分配和跨工作区隔离；真实 Provider 查询、人工收口的结构化依据、用量/账务对账和生产证据仍未完成，因此本验收文档继续保留在 `doc/todo`。

### 2026-09-01 Provider dispatch fence 增量

- 图片执行现在明确经过 `leased → provider_reserved → provider_dispatching → provider_started`；Worker 只有在 `begin_provider_dispatch` 成功提交后才允许调用 Provider，Provider 异常从 `provider_dispatching` 进入 `outcome_unknown`，不自动重派。
- migration 117 增加状态约束与恢复索引；Memory/Postgres/API/Worker 定向回归 105/105，release gates 77 文件通过、1 个跳过（423/7），TypeScript 和差异检查通过。
- 仍未完成真实 PostgreSQL/RLS 并发、双 Worker 崩溃恢复、Provider 幂等/queryStatus、usage/cost/settlement 绑定、容器与正式 ChatGPT Host 证据，继续 `TODO / NO-GO`，不迁移到 `doc/done`。
# 2026-08-31 implementation increment: cursor scan foundation

- Added tenant/query-bound cursor with scan watermark, stable `(updated_at DESC, job_id ASC)` keyset pagination, and fail-closed cursor validation.
- Added PostgreSQL migration 094 partial reconciliation index and verified it in the local database; `merchant_app` retains no DELETE/TRUNCATE privilege.
- Worker now consumes `next_cursor` across bounded pages and uses an independent image reconciliation interval.
- This increment is still not production-complete: durable checkpoint persistence, Worker-side Provider query ownership, provider response/usage/cost evidence, production artifact/archive evidence, and production relay/release evidence remain outstanding. Keep this document in `doc/todo`.

# 2026-08-31 implementation increment: Provider status safety boundary

- Added provider-neutral `queryStatus` parsing with explicit processing/succeeded/failed states, request-ID binding, relay URL security, response-size limits, and unknown-state fail-closed behavior.
- Reconciliation now records status evidence and refuses execution completion unless returned artifacts are durably archived and scan/integrity gates are satisfied.
- This remains a partial implementation: Provider status is currently invoked from the API adapter, query evidence is audit-only rather than a dedicated durable evidence table, and real Provider/usage/cost/production Host evidence is absent.

# 2026-08-31 implementation increment: controlled manual closure

- Added the `ops.marketing.image.reconcile` MCP operation and desktop Ops Console closure dialog. `completed` is fail-closed behind succeeded job state, archived outputs, and clean scan evidence; `failed` records an explicit reason and evidence reference.
- Both paths use workspace/role checks, idempotency keys, optimistic job revision checks, durable execution reconciliation, reconciliation status projection, immutable operation audit, and no automatic retry/refund.
- Idempotent replay is checked before the execution-state gate, so a retried request returns the original reconciliation projection after the first transition; a new idempotency key still cannot rewrite a terminal execution.
- Added a fail-closed projection-recovery path for the narrow crash window where the execution/job terminal state is durable but the reconciliation projection is missing. Recovery requires matching business terminal state and manual failure reason (or clean archived completion), records a separate recovery audit, and never calls the Provider again.
- Image reconciliation evidence now carries the frozen event `action_id`; the API rejects mismatched action-ledger references and refuses `completed` until the corresponding action ledger and model-usage records are settled/waived. Archived-but-unsettled images remain `reconciliation_required` with an explicit billing next action.
- Ops queue projections now read the workspace-scoped reconciliation status and expose only redacted status/revision/evidence-reference/reason fields, so operators can distinguish an unclosed execution from a recorded recovery without reading provider payloads.
- Typecheck, targeted API/MCP/Ops tests (174/174), release gates (319/325 with 6 expected skips), CodeGraph sync, and local Compose health checks passed.
- This remains TODO/NO-GO: real Provider query evidence, production asset/archive and usage/cost evidence, cross-process fault injection, and formal ChatGPT Host/platform canary evidence are still absent. Do not migrate this document to `doc/done`.
# 2026-08-31 实现增量

- Worker → API 的 reconciliation evidence 请求已补齐稳定 `idempotency_key`，并使用候选记录中的 `query_attempt`（缺省才回退到 execution attempt）；同一观测重试会复用同一键，响应内容变化交由 API/持久化层返回幂等冲突。Worker 定向测试 43/43、类型检查、差异检查和 CodeGraph 通过。
- 已补齐按 `next_attempt_at` 的 durable backoff/查询过滤：API 在冷却窗口内不返回待查询执行，Worker 对 processing/unknown 使用有界指数退避并写入下一次时间。仍未完成：真实 Provider 状态回读、对象归档/扫描/计费证据和多副本并发验收；因此本验收文档继续保留在 `doc/todo`。
