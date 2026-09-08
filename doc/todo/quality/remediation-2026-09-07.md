# 深度评审后续修复记录

日期：2026-09-07；关联[原始评审](project-review-2026-09-07.md)与[测试方案](test-strategy-2026-09-07.md)。本轮只处理已观察到的 A-01 授权契约和 A-11 素材投影，不批准商业能力、付费调用或生产发布。

## 最新续轮：桌面签发已修复，测试入口已隔离，撤销政策待确认

用户确认后完成实际 JIT 表单提交修复、独立 PG17/Redis/OIDC/API/UI 启动器、安全默认测试入口与专用 PG/runtime 入口。真实签发/刷新成功；撤销因 approval 义务与公开 schema 不一致返回 403，未擅自放宽权限。详见[桌面与隔离验收报告](jit-desktop-test-isolation-2026-09-07.md)。以下保留此前后端和素材验收历史。

## A-01：18:40 CST 后端验收快照

最新代码对应的隔离 PG16 复现：2 个文件、2 失败、零跳过，错误均为 `ops access grant scope is invalid`。证据：`artifacts/audit-2026-09-07/runtime/postgres-1788772470212.json`。

根因不仅是 migration 152 要求 `type + ids` 而 API 签发 `workspace_ids`：Worker 使用真实 job/aggregate ID 预留执行，Repository 又错误地拿该 ID 去匹配工作区 ID 数组。只改 SQL 或把测试的任务 ID 改成工作区 ID，会隐藏第二个问题。

已独立核查唯一生产 reservation 调用的两个 Worker HTTP 入口：均先查询当前工作区的持久 Outbox 事件，再校验 aggregate、event ID、operation 和授权 snapshot；发布入口还核查真实 publish job。Repository 不是任意任务 ID 归属验证器，数据库 reservation 表也没有到 outbox 的 event 外键；本轮不能宣称只靠 RLS 就证明事件真实存在。

用户随后明确要求“继续”，本轮按已提出的 15 文件范围执行。已完成的最小完整修复：

1. 前向迁移 163 对齐当前 API 的唯一 `workspace_ids` 契约。保留 migration 152 和历史 scope/hash/事件，不自动转换；对仍有效的不兼容旧授权明确阻断。兼容检查与触发器替换置于同一事务和表锁范围。
2. 仅对 workspace 类型按 `workspaceId` 匹配，保留 reservation 中真实 resource/job ID；历史 task/brand/account 等内部精确资源范围仍精确匹配，不能扩大。
3. 验证授权 revision 的 PostgreSQL bigint 返回类型，不用硬编码 revision 掩盖链路差异。
4. 补齐真实签发→消费→任务预留→撤权→拒绝新执行/历史重放；新库、升级、active 旧格式阻断、旧证据不变、跨租户与伪造事件负例。
5. 同步迁移 loader、tail metadata、专项静态门禁和 CI 分母，修正全迁移测试中与当前公开 API 不一致的旧前置夹具。

初始估计 8 文件，接线审查后收敛为 15 个实现/测试/CI 文件。依据 gstack investigate 先确认扩展范围，得到继续指示后再修改。新增 163，旧 152 未改；没有迁移业务数据库，也没有自动转换旧授权。

2026-09-07 18:39–18:40 CST owner 验收：隔离 PostgreSQL **17.11**（与 CI 同主版本）**5 文件 / 6 passed / 0 failed / 0 skipped**；授权、迁移接线与签名 HTTP 专项 **8 文件 / 89 passed / 0 failed / 0 skipped**。SQL 审计覆盖 RLS 遮挡时报 42501、旧 writer 持锁时迁移等待、独立活动旧格式阻断、历史 scope/hash/event 不变；新授权保留真实 job ID，BIGINT 版本安全解码。

其中 34 项 Worker 测试包含 32 项真实 loopback 签名 HTTP 入口测试，但依赖受控内存持久层；PG 集成则使用真实数据库角色。这两组证据独立成立，**不能拼接宣称 HTTP→真实 PG→Worker→模型完整 E3 通过**。CI 新增五文件专项和实际执行集合/零跳过校验，原始 JSON 保留于 CI 日志。完整本轮记录见 [A-01 验收报告](authorization-163-verification-2026-09-07.md)。

桌面只读复核发现：`AuthorizationGovernanceSection.tsx:251` 仍提交旧 `type/ids`，API `server.ts:11420` 明确要求 `workspace_ids`；现有前端用例只测 helper/源码字符串，没有表单提交 payload 回归。该组件及其测试不在已确认 15 文件范围内，依据 gstack investigate 暂停扩大补丁并请求下一步确认。因此 A-01 不能标记为桌面工作流已关闭。

本轮全量 `npm run check` 因发现已有测试直接写共享环境而中止（exit 130），不是全量通过。已确认新增 1 条 `scanner-callback` 合成素材，未删除；同一窗口观测到共享 Redis 重启，当前健康。详见本轮报告的影响记录。此前“独立 PG 不操作业务库”的结论仅适用于专用 PG harness，不能扩大为整个全量检查没有副作用。

现有业务库仅做只读聚合审计：schema 162、3 条历史 canonical 授权、0 条当前有效授权；没有导出授权 ID/正文或修改数据。此统计只对应本机观测时点，不能代替生产迁移前的重新审计。

## A-11：素材安全投影修复与验证

根因：`currentAsset ?? merchantAssetSummary(action)` 以完整素材摘要整体替代 action 摘要，丢失 action 的正式 readiness。简单把精确响应断言改成当前输出，并不能修复丢失信息和冲突状态提示。

修复范围限定为 source/mirror 的 `bridge.mjs` 与 `bridge.test.ts` 四个文件；只操作素材函数和对应测试，不覆盖并行修改的商业方法集合。安装缓存保持原状。

本轮增加独立状态与隐私回归，覆盖正式 readiness 保留、扫描失败/未知、显式权益拒绝、pending 权益、解析阻断与 action-only 输出。最终状态：**DONE_WITH_CONCERNS（本地修复完成；授权与外部上线验收仍阻断）**。

独立复核追加了三类同根缺陷：共享 summary 的 nested CTA 未统一权益拒绝；asset/action merge 覆盖明确拦截或等待扫描；upload 分支在共享 summary 后又覆盖拒绝提示。均限定在上述四个文件修正，不把权益失败伪装成扫描失败，也不把 action 缺少扫描字段当作新的扫描证据。

上传进一步覆盖旧 `awaiting_confirmation` 不能绕过未完成扫描、轮询最新 rejected/unusable 必须保留、最新可信扫描/display 替换过时 awaiting_scan；pending 不自动升级为 approved。结构化响应与真实 stdio 文本联合断言，服务器仍是生成准入的权威。

Owner 最终完整命令：

```sh
npx vitest run --no-file-parallelism apps/plugin/mcp/bridge.test.ts .codex-marketplace/plugins/merchant-marketing/mcp/bridge.test.ts --reporter=json --outputFile=artifacts/audit-2026-09-07/continuation/final-owner-bridge.json
```

结果：**2 文件 / 254 passed / 0 failed / 0 skipped**，其中 **80 项素材回归**全部执行通过。`npm run typecheck`、两份 `node --check`、四文件 `git diff --check` 均通过；独立只读复核的 16 组函数组合断言无剩余本范围 must-fix。

运行前 17:54:12 与运行后 17:55:21 CST 的四文件 hash 均相同，两份实现和两份测试分别一致：bridge `15e790aa7ea76826fb1a482faa30267abf307723f58e50407af373ae7103f7ca`，tests `3ee33ae25b9da0a8ae6ecb15be50c14586b2934d69fd43dcc1abcda81299feee`。完整记录含素材投影、扫描分类、轮询及上传文本的区域 hash，见 `continuation/run-manifest.json`。

红测保留于 `runtime/bridge-asset-a11-*-red.json`；agent 最后定向报告 `runtime/bridge-asset-a11-final-consumers-serial.json` 为 80 passed / 174 未选，不冒充全文件零跳过。owner 上述完整报告才是 254 项零跳过的依据。曾在并行定向执行中出现一次 100ms 扫描轮询调度失败，原报告保留；未扩大生产超时，最终按仓库串行文件策略复验通过。

实际连接的 MCP 只读查询返回 13 个素材、13 个 draft；该安装缓存响应不包含当前源码新增的候选指导，因此只证明连接可读，不能作为本轮编辑后 bridge 的运行证据。编辑源的验收使用独立 stdio 子进程和受控 HTTP 服务，属于本地协议层，不冒充真实 ChatGPT 上线验收。

## A-11 续轮整体检查快照（A-01 修复前的历史记录）

`npm run check` 的三个 TypeScript 检查通过，随后 Vitest：**4,192 passed / 6 failed / 69 skipped**；文件 **599 passed / 4 failed / 44 skipped**，耗时 499.32s，进程退出 1。由于此链在测试失败后中止，其后的 Ops 测试、metadata 和 build 不算执行；已另行独立补跑如下。

| 独立命令/观测 | 本轮结果 | 证据 |
| --- | --- | --- |
| `npm run test:ops-console` | 87 文件 / 495 断言通过、零跳过 | `continuation/ops-tests.log` |
| `npm run build:ops-console` | 通过 | `continuation/ops-build.log` |
| `npm run build:merchant-studio` | 通过；保留大 chunk 警告；仅调试面 | `continuation/studio-build.log` |
| `npm run release:metadata:validate` | 通过，只证明声明一致 | `continuation/metadata.log` |
| 本地容器和 API probes | 项目 13 个容器 healthy；8787/8788 的 livez/healthz/readyz 均 200 | `continuation/run-manifest.json` |

六个失败为：source/mirror 各两个 `multimodal.video.request` 工具发现与 shared disabled registry 不一致；视频请求未携带测试要求的 1080P 参数；视频报价使用按秒公式而测试要求显式分辨率公式。本轮未修改这些商业/模型区域，也未调整其精确断言。参见 `continuation/check.log`；这是观察到的契约分歧，不是在未查明产品批准前直接断言应采用哪一套商业规则。

17:49 CST 启动的 owner 独立复验：`api-contract-request-scope`、`asset-upload-security`、`server.test`（全文件，包含候选准入）、`video-generator`、`relay-pricing` 共 **5 文件 / 154 断言通过、零跳过**，原始报告 `continuation/final-owner-api-model.json`。工作区持续有并行修改，两个视频/计价失败在这次已不再复现；本轮没有修改这些区域，不将其通过归因于素材补丁，也不覆盖此前失败报告。

17:54 的完整 bridge 复验中此前四个工具发现断言也通过，原有六个失败在两次后续专项运行中均不再复现。商业集合及其测试仍有外部并行变更，本轮只认领素材范围修复；不将外部变更当作本轮批准商业能力的依据。

本次全量运行期间四文件继续补充独立复核发现的素材用例，且工作区存在外部并行写入；因此上述计数是该次实际运行记录，**不是最终源冻结后的全仓库通过证明**。最终素材专项报告和 hash 已单独记录，不能拼接为同一 release 的全量通过。69 个跳过也不能被独立 PG 的两个执行用例抵消；最终候选仍须固定全仓库来源后重跑完整检查和 E3/E4 门禁。

## 证据与安全边界

本轮日志存于 `artifacts/audit-2026-09-07/continuation/`，原始失败证据不覆盖。独立 PG 使用专用带 label 的临时容器，只清理本轮创建的数据；真实业务库不迁移、不清空、不重驱。

已核验本轮 `merchant-audit-pg-20260907` 的容器 ID、run/phase label 和 AutoRemove 后执行 stop；仅移除该临时容器及合成测试数据库，原始报告保留，可用原脚本重新生成测试数据。没有删除业务容器或持久卷。

结论仍为 NO-GO：A-01 已完成本地修复与隔离专项验证，目标环境迁移及真实宿主/模型/商业证据仍须按原测试方案逐项关闭，不能由 bridge 或授权的局部通过替代。

## 最新续轮：撤销审批策略（20:43 CST 后交接）

用户已确认签发需审批、撤销免二次审批；策略版本更新至 `2026-09-07.v1`，管理权限、原因、双版本及审计不变。Owner 定向 7 文件 / 296 passed、PG17 专项 6 文件 / 8 passed、完整安全 check exit 0；根套件 4,489 passed / 70 skipped，Ops 500 passed。真实 PG 撤销已成功；原桌面 suite 仍因成功后回执丢失失败，第二尺寸未执行，不宣称完整生命周期通过。详见[本轮完整报告](jit-revoke-policy-verification-2026-09-07.md)与[新增测试方案](test-strategy-2026-09-07.md#12-撤销策略确认后的验收增量)。
