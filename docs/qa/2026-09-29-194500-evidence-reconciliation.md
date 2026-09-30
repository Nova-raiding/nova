# 194500 本地插件与生产发布证据对账

采集时间：2026-09-29 19:37 CST。只读核对 `main`、本机插件清单、既有 App 原始事件与文档、公开健康接口及 ECS 状态；未调用业务写入、未迁移数据库、未部署。此表按观察时点判断，不把历史文档中的“当前”延伸到本轮。

## 当前可证事实

| 对象 | 本轮观察 | 只能证明 |
| --- | --- | --- |
| 本地源码 | `main` HEAD `fa509f1d0dd8c4a4ca5a7e7e2d39c1df3b25ff`；工作树有约 45 项修改/新增；`release-metadata.json` 指向插件 `0.1.0+codex.20260929194500` | 尚无干净、冻结、单一 SHA 的完整发布候选。并行改动继续发生，旧测试摘要不能自动覆盖它们。 |
| 本地插件 | `codex plugin list` 显示 `merchant-marketing@merchant-local` 已安装、已启用，版本 `0.1.0+codex.20260929194500` | 仅安装登记。未取得绑定该版的真实 ChatGPT App 业务成功事件、当前 QA 工作区身份返回或完整正向流程回执。 |
| 真实 App 历史事件 | [185400 入口验收](2026-09-29-chatgpt-plugin-185400-startup-fix.md)与[脱敏逐项记录](evidence/2026-09-29-chatgpt-app/185400-app-116-credential-gate.json)：116 个不同工具均返回 `MCP_CREDENTIAL_SOURCE_INVALID`，业务成功 0 | 证明 **185400** 版在真实宿主的工具入口和凭据失败保护；不证明 **194500** 版已重新加载、鉴权成功或任何业务功能通过。更早 143500 版 116/116 是调用覆盖，22 非错误、94 错误/门禁，也不继承。 |
| 公网健康 | `https://yxsona.com/api/healthz` 和 `https://ops.yxsona.com/healthz` 响应正常；API 健康详情中能力/容量证据仍为 `blocked`，向量 embedding 未就绪 | 现有旧服务可响应；健康码不等于新候选、五模态实际中转、容量或知识向量能力通过。 |
| ECS 发布身份 | `node infra/scripts/ecs-fast-status.mjs` 于 `2026-09-29T11:37:04Z` 输出 `release_approved=false`，警告 `application_services_have_mixed_source_revisions`。API `fd1ad6a7…`、商家 UI `f48c8454…`、Ops UI `fccee758…`、业务 worker `ffcda399…`；公网 `/releasez` 为旧 release `release-demo-product-code-20260929` | 旧混合修订仍运行且容器 healthy；**194500 本地插件及本地 API/UI/worker 候选没有同版生产部署证据**。 |
| 数据库 | [无迁移发布审计](evidence/2026-09-29-chatgpt-app/20260929-no-migration-release-audit.md)与本轮[界面复核](2026-09-29-ui-screenshot-fidelity-audit.md)均记录公网 demo 迁移尾 254；本地目标 255 | 不能把依赖 255 的候选按普通完整路径直接切到 254。用户明确要求不迁移现有库；本轮没有执行迁移。 |

## 易误读的声明与正确证据等级

| 文档/说法 | 适用时点及证据等级 | 本轮结论 |
| --- | --- | --- |
| [界面截图逐页审计](2026-09-29-ui-screenshot-fidelity-audit.md)中的 `npm run test:release-gates`、双后台构建和截图“通过” | 18:00–18:40 历史源码/隔离浏览器候选。文件顶部已新增时点说明，且承认截图早于后续共享源码改动，旧线上 API 对品牌/用户请求为 404/400。 | 不得写为 194500 冻结候选的发布门禁、同版 API/UI 验收或生产部署通过；须重跑并保留精确 SHA。 |
| [185400 启动修复](2026-09-29-chatgpt-plugin-185400-startup-fix.md)的“116/116” | 真实 ChatGPT App 原始 `McpToolCall`；全为 `{}` 入参，全部在业务参数处理前被凭据门禁拒绝，无服务端请求 ID。 | 是当前可核的真实 App **负向入口覆盖**，不是 116 项功能成功，也不是 194500 结果。 |
| [旧版正向覆盖矩阵](evidence/2026-09-29-chatgpt-app/positive-business-coverage-matrix.md)的“116/116 已调用” | 125100/143500 旧版 App 事件；22 项非错误主要为状态、空态和后台入口，94 项错误/门禁。 | 旧版调用覆盖，业务闭环未全通过。不能与 185400/194500 的数量相加。 |
| [回调浏览器 E2E](evidence/2026-09-29-chatgpt-app/local-plugin-callback-browser-e2e.md)及 `27-callback-success-result.png` | 进程内 fixture 的回调 UI；[证据清理审计](2026-09-29-uncommitted-evidence-audit.md)已划清边界。 | 不能证明当前 `demo@sn.com` 的真实 Keychain 保存或 App 鉴权成功。 |
| [Windows 历史状态](evidence/2026-09-29-windows-remote/status.md)及[模型免费阈值修复](2026-09-29-model-free-threshold-fix.md) | 旧线上单次文本生成有独立服务端 provider、usage、成本与扣点账本；免费阈值修复是源码测试/PG 构造临时表验证，文件明确未部署。 | 只可记旧版单次文本历史成功和旧规则扣点事实。不能记新免费规则生效、五模态、194500 App 或全部功能通过。 |
| [Keychain GUI broker 开发记录](2026-09-29-keychain-gui-broker-development.md) | 49 项本地测试；文件明确缺签名 Aqua LaunchAgent、崩溃/重启生命周期和 Background 到 GUI 的真实 Keychain 调用。 | 开发候选，不是 194500 App 凭据恢复、发布就绪或生产连接成功证据。 |

## 宣称“已全量通过/已部署”前所需的最小证据

1. **冻结候选**：owner 整合并行改动，在 `main` 固定提交 SHA；按 `AGENTS.md` 跑该 SHA 的类型检查、发布测试、桌面浏览器和容器健康，记录原始退出码、测试跳过项及镜像摘要。当前任何历史成功摘要均须绑定其当时 SHA。
2. **194500 App 鉴权**：安装缓存与源码指纹一致；在真实 ChatGPT App 新会话保留插件版本/进程重载、`onboarding.status` 等原始工具事件、QA 工作区 `ws_57fd2361ed5b44c7891f3d37`、请求 ID 和中文可见结果；真实 Keychain 读取成功且不输出秘密。独立 stdio `tools/list`、fixture、宿主自然语言总结均不能替代。
3. **逐功能正向矩阵**：对 116 项逐一记录已调用、可用成功、业务正向闭环、预期拒绝和未满足前置；写入项需同租户对象读回、权限/审计、真实创意点前后账本。用户提供的两份 XLSX 需真实上传资产 ID、扫描/解析、事实人工确认和知识读回；此前两次上传因 `CREATIVE_POINTS_UNAVAILABLE` 拒绝，不能算完成。
4. **模型与交付**：文案、图片、图片编辑、OCR、视频分别保留真实中转鉴权、provider request、用量、成本、作业与交付物可见证据；审核、导出、支付、删除和发布按各自权限及门禁验收，错误或空态不能升格为完成。
5. **同版云端与发布**：候选 API、商家台、运营台、worker 与数据库/RLS 在隔离真实运行时合验，解决 254/255 兼容与用户“不迁移现有库”约束；按 ECS 手册建立受保护恢复、能力/容量、成本和审计证据，取得 `release_approved=true`；切流后以 `/releasez` 的同一 SHA/镜像摘要及 ChatGPT App 端到端复验确认。健康接口 `ok` 或本地插件安装不等于此项。

**本轮判定：194500 仅可证明本地已安装、已启用；全功能正向通过与云端候选部署均无证据，生产发布门禁仍为 `false`。**
