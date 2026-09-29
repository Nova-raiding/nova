# 商品目录写入链路：隔离 API/MCP 验收

日期：2026-09-29。环境：本地测试进程启动的临时 HTTP API/MCP 服务、测试工作区与 fixture；未向生产环境写入数据，未执行数据库迁移。这份证据证明隔离服务的行为，不能替代生产 ChatGPT App 中逐项调用的可见证据。

## 执行命令和结果

```sh
node --import tsx scripts/run-safe-tests.ts --no-file-parallelism apps/api/src/feature-gap.e2e.test.ts apps/api/src/spreadsheet-batch-import.e2e.test.ts apps/api/src/manual-store-record.e2e.test.ts apps/api/src/mcp-completion-content.e2e.test.ts
```

结果：4 个文件通过，**37/37 测试通过**。随后扩展现有商品更新用例，补齐 `catalog.product.update` → `catalog.sku.update` → 旧版本拒绝 → `catalog.facts.confirm` → `catalog.search` 读回的闭环，再执行：

```sh
node --import tsx scripts/run-safe-tests.ts --no-file-parallelism apps/api/src/feature-gap.e2e.test.ts
```

结果：该文件 **26/26 测试通过**。

## 已验证的写入路径

| 方法 | 证据 |
| --- | --- |
| `catalog.import` | 未绑定草稿、显式店铺导入、商品属性与 SKU 导入：[feature-gap.e2e.test.ts](../../../../apps/api/src/feature-gap.e2e.test.ts) |
| `catalog.import.batch` | `products_json` 跨店批量导入、原子性、重复身份与无效事实拒绝；经确认的 CSV 解析事实通过 `source_asset_id` 导入：[feature-gap.e2e.test.ts](../../../../apps/api/src/feature-gap.e2e.test.ts)、[spreadsheet-batch-import.e2e.test.ts](../../../../apps/api/src/spreadsheet-batch-import.e2e.test.ts) |
| `catalog.product.update`、`catalog.sku.update` | 商品标题、图片、属性及 SKU 价格与库存更新；旧版本写入返回 `PRODUCT_VERSION_CONFLICT`：[feature-gap.e2e.test.ts](../../../../apps/api/src/feature-gap.e2e.test.ts) |
| `catalog.facts.confirm`、`catalog.search` | 更新后重新确认事实，搜索结果读回已确认标题、库存和 SKU；批量导入后的待确认状态及幂等确认：[feature-gap.e2e.test.ts](../../../../apps/api/src/feature-gap.e2e.test.ts)、[spreadsheet-batch-import.e2e.test.ts](../../../../apps/api/src/spreadsheet-batch-import.e2e.test.ts) |
| `catalog.title.optimize`、`catalog.title.accept` | 基于事实的标题建议、人工采纳、重复采纳幂等、过期建议及平台/规则不匹配拒绝：[feature-gap.e2e.test.ts](../../../../apps/api/src/feature-gap.e2e.test.ts) |
| `catalog.product.disable`、`catalog.product.enable` | 停用后恢复，以及参数、角色与租户边界：[mcp-completion-content.e2e.test.ts](../../../../apps/api/src/mcp-completion-content.e2e.test.ts) |
| `ops.platform.product.import.batch` | 人工登记店铺的运营代导入、商家拒绝、跨工作区拒绝、店铺指派确认、审计记录与商家读回：[manual-store-record.e2e.test.ts](../../../../apps/api/src/manual-store-record.e2e.test.ts) |

`catalog.title.optimize` 的隔离测试只证明 API/MCP 业务行为；这里没有记录生产模型中转的真实鉴权、用量或成本，也没有证明 ChatGPT App 对上述每个写入工具的可见调用。生产端写入验收需要独立使用明确标记的 QA 商品，并核对 App 输出与服务端记录。
