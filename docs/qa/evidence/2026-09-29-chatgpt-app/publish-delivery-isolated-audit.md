# 发布、审核与交付隔离验收（2026-09-29）

## 范围与证据级别

本轮沿 `插件 tools/list → API/MCP → 内容版本与发布服务 → 下载文件` 核对。使用 CodeGraph 1.5.0 的 `status` 和 `explore` 跟踪 `preparePublish`、`exportContent` 等调用；图索引为 complete，2,334 files / 33,624 nodes，存在少量未同步改动。CodeGraph 只作为入口定位，不作为运行成功证据。gstack QA 指南用于逐方法成功/失败路径、权限、租户、文件及回归记录。测试使用隔离服务和 fixture connector，没有生产发布，也没有真实平台回执。

## 运行结果

| 层级 | 命令/文件 | 结果 | 实际验证 |
| --- | --- | --- | --- |
| API/MCP | `npx vitest run --no-file-parallelism apps/api/src/mcp-content-knowledge-http.e2e.test.ts apps/api/src/mcp-completion-content.e2e.test.ts apps/api/src/manual-publish-read-boundary.e2e.test.ts apps/api/src/mcp-native-http.e2e.test.ts packages/contracts/src/content-export-http-mcp-parity.test.ts` | 5 files、18/18 passed | 带 bearer 的内容恢复、版本冲突、跨租户、人工发布读取边界、原生 MCP/HTTP 与导出契约 |
| API/MCP | `npx vitest run --no-file-parallelism apps/api/src/server.e2e.test.ts` | 81/81 passed | 完整内容版本、审核、导出、发布准备/确认/状态、批量发布生命周期、失效确认、拒绝回执 |
| 交付下载 | `npx vitest run --no-file-parallelism apps/api/src/customer-delivery-asset-download.e2e.test.ts apps/api/src/customer-delivery-contract-download.test.ts apps/api/src/customer-delivery-access.e2e.test.ts` | 3 files、137/137 passed | 交付访问复核、跨租户/未绑定资产拒绝、合同文件下载与并发限流 |
| 插件 stdio | `npx vitest run --no-file-parallelism apps/plugin/mcp/bridge.test.ts apps/plugin/mcp/first-use-chain.e2e.test.ts apps/plugin/mcp/merchant-conversation-flow.test.ts` | 初次 115/116；版本对齐后 `bridge.test.ts` 98/98 passed，另 2 文件 18/18 passed | 文件资源、非法 ZIP 拒绝、隐藏工具、登录至 stdio 的隔离流程 |

运行日志分别在 `/tmp/store-nova-publish-delivery-round.log`、`/tmp/store-nova-publish-server-full.log`、`/tmp/store-nova-customer-delivery-round.log`、`/tmp/store-nova-publish-bridge.log`、`/tmp/store-nova-publish-bridge-rerun.log`。曾用 `-t` 只选 7 项运行 `server.e2e.test.ts`，断言均通过，但项目的 pending-assertion reporter 将其余 74 项跳过标为异常；随后运行整文件，81/81 通过，以上以整文件结果为准。

## 逐方法状态

| 方法 | 本轮实际结果 | 证据与限制 |
| --- | --- | --- |
| `deliverable.list` | ChatGPT App 已成功，隔离 API 空/列表路径已有覆盖 | App 截图 `21-chatgpt-work-knowledge-readonly-top.png`；当前工作区无正式内容交付物，因此未证实实体详情/下载 |
| `content.versions`、`content.diff` | 隔离 API 成功 | `server.e2e.test.ts` 的完整 MCP 流程及版本恢复用例；生产工作区没有可用正式版本 |
| `content.restore` | bearer API 成功；旧 `expected_version` 返回 409 `VERSION_CONFLICT` | `mcp-content-knowledge-http.e2e.test.ts`：源版本生成新 `review_required` 版本且保留 `parentId`；未在真实 App 执行写入 |
| `content.review`、`content.approve` | 隔离 API 成功 | `server.e2e.test.ts` 完整 MCP 流程：审核非阻断，批准后任务为 `approved`；跨租户读取返回 `WORKSPACE_SCOPE_MISMATCH` |
| `content.export` | 隔离 API 与 stdio 文件处理成功 | MCP 返回 manifest；HTTP 下载为 200、`no-store`，manifest 的 `publish_receipt=null`；stdio 将 ZIP/Markdown 写为用户可见 `resource_link`，权限 0600/目录 0700，不向模型暴露正文或 Base64；非法 ZIP 无资源链接且 fail closed。未在真实 App 下载正式内容文件 |
| `publish.prepare`、`publish.confirm`、`publish.get` | 仅隔离 API 成功，商家插件隐藏 | `server.e2e.test.ts` 完整 MCP 流程准备后以确认哈希与幂等键提交，状态为 `queued`；缺少幂等键/确认令牌被拒，规则刷新重新校验。当前 `manual` 运营档不开放插件自动发布，不能算 App 成功或真实平台发布 |
| `publish.batch.prepare/confirm/get/pause/resume/retry_failed` | 仅隔离 API 成功，商家插件隐藏 | `server.e2e.test.ts` 批量用例验证重复任务拒绝、部分成功、失效 ticket 无副作用、暂停/恢复/失败项重试；没有生产发布 |
| `publish.manual.list/get` | 仅隔离 API 读取边界，商家插件隐藏 | 人工档无店铺时 list 为 200 空列表；缺失记录为 404；跨租户 403；不是发布成功证据 |
| `delivery.bundle.verify` | 商家插件隐藏 | 无用户可达成功路径；不计入插件通过数 |
| 客户交付资产与合同下载 HTTP 路径 | 隔离 API 成功 | 137 项套件覆盖权限边界、工作区与绑定关系、不满足访问条件的资源拒绝、最多两路并发下载；这是桌面运营/交付子系统证据，不等于 ChatGPT 插件的 `content.export` 下载成功 |

## 发现与待办

1. 初次运行时 `apps/plugin/mcp/bridge.test.ts:1165` 的版本断言落后于并行升级中的 manifest（085500 对 090000）。owner 对齐后，本轮重跑桥接完整文件 98/98 通过；这是测试版本漂移，未发现导出或权限逻辑失败。
2. 正式内容成功路径仍需一个已确认事实、合法权限且真实模型证据完整的生产任务/版本，才能在 ChatGPT App 宿主中测试 `review / approve / restore / export` 和实际文件下载。现有生产工作区未提供这类正式版本；候选草稿不等于正式版本。不要以 fixture、空列表或 404 冒充宿主成功。
3. 当前商家插件明确隐藏全部 `publish.*`。真实平台回执、回滚与自动发布均不属于当前 ChatGPT 用户可用表面；无需为“所有工具测试”在生产制造外部发布。用户可见的人工发布流程须另按真实后台与回填记录验收。
