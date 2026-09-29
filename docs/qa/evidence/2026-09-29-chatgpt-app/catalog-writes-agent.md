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

## 同日后续：独立 API 与 PostgreSQL 正向验证

后续用 CodeGraph 索引定位 `mcp-catalog-import.ts`、`mcp-catalog-batch-import.ts`、`mcp-catalog-product-update.ts`、`mcp-catalog-title.ts`、`mcp-brand-profile-handlers.ts` 及品牌单元路径。执行既有定向测试：

```sh
npx vitest run apps/api/src/feature-gap.e2e.test.ts apps/api/src/brand-profile-upsert-http-mcp-parity.acceptance.test.ts apps/api/src/spreadsheet-batch-import.e2e.test.ts --reporter=dot
```

结果为 **3 个文件、32/32 通过**。覆盖内存仓库上的商品草稿导入、标题建议与接受、商品/SKU 修改、事实确认、批量导入与失败原子性、品牌档案版本和表格来源路径；这些不是 PostgreSQL 持久化或 ChatGPT App 证据。

新增 `apps/api/src/catalog-positive-isolated.postgres.test.ts`，仅当 `CATALOG_ISOLATED_POSTGRES_URL` 指向本机回环地址、且 `CATALOG_ISOLATED_WORKSPACE_ID` 为专用隔离 fixture 工作区时启用。用 `createIsolatedOpsFixture` 创建带随机工作区的 tmpfs PostgreSQL/Redis 容器，运行：

```sh
CATALOG_ISOLATED_POSTGRES_URL="<createIsolatedOpsFixture 返回的 databaseUrl>" \
CATALOG_ISOLATED_WORKSPACE_ID="<createIsolatedOpsFixture 返回的 workspaceId>" \
npx vitest run apps/api/src/catalog-positive-isolated.postgres.test.ts --reporter=dot
```

结果 **1/1 通过**，`npm run typecheck` 退出码 **0**。测试通过本地 API `/mcp` 顺序调用 `catalog.import(draft_only=true)`、`catalog.product.update`、`catalog.sku.update`、`catalog.facts.confirm`、`catalog.import.batch(draft_only=true)` 和 `catalog.search`。每次商品变更用 `PostgresBusinessRepository.get` 从真实 PostgreSQL 快照读回，最后用 `listProductsPage` 核对标准商品表中的两条记录，再通过 API 搜索核对商品可见。专用容器 **2/2 停止，0 遗留**；没有生产数据库写入。首次运行时测试把响应包装字段 `draft_only` 误当持久商品字段，修正测试断言后通过，未发现商品实现缺陷。

**严格边界：** PostgreSQL 读回覆盖商品快照与标准商品表，不覆盖品牌档案/品牌单元在同一数据库中的持久化；既有品牌正向用例仍是内存仓库。以上正向调用发生在本地 API 测试进程，**不是已安装 stdio 插件或真实 ChatGPT App 的正向调用**，也没有生产模型中转、创意点与账务证据。独立 `demo@sn.com` 工作区尚未具备可执行正向制作所需的素材、权益和交互写会话，不能据此将最初 11 项插件 App 矩阵标为通过。
