# 入口、品牌、批量计划与工作区写入工具：本地安全拒绝轮次

时间：2026-09-29。对象：本机已安装 `merchant-marketing/0.1.0+codex.20260929125100/mcp/bridge.mjs`。本轮只证明标准 MCP stdio 工具层的拒绝路径，**不是 ChatGPT App 内真实调用，也不是业务正向通过**。

独立子进程使用 `MERCHANT_WORKSPACE_ID=ws_57fd2361ed5b44c7891f3d37`、`MERCHANT_MCP_WRITE_ENABLED=false`、`MERCHANT_MCP_TOKEN_SOURCE=environment`，访问与刷新令牌置空，`MERCHANT_STRICT_AUTH=true`，关闭演示数据回退。API 地址指向仅计数的本地 HTTP 监听器。`tools/list` 返回 116 项，下面 13 项均在其中；13 次调用后监听器收到 **0 次 HTTP 请求**，bridge 标准错误流为空。没有打开交互写会话，也没有用生产商品、店铺或贵人鸟 ID。

| 工具 | 本轮入参，也是 App 可用的最小安全试呼参数 | 实际返回 | 解释 |
| --- | --- | --- | --- |
| `merchant.start` | `{"attachment_count":-1}` | JSON-RPC `-32602`，中文参数格式错误 | 此方法可在交互写门禁外运行，故用非法参数确保本地拒绝 |
| `merchant.first_value` | `{"example":"false"}` | JSON-RPC `-32602`，中文“不受支持” | 不触发收费草稿或远端请求 |
| `brand-unit.create` | `{}` | `INTERACTIVE_WRITE_DISABLED`，中文确认提示 | 写门禁先于必填参数校验 |
| `brand-unit.bind-store` | `{}` | 同上 | 同上 |
| `brand-unit.product.create` | `{}` | 同上 | 同上 |
| `brand-unit.listing.create` | `{}` | 同上 | 同上 |
| `brand-unit.access.grant` | `{}` | 同上 | 同上 |
| `campaign.batch.create` | `{}` | 同上 | 同上 |
| `campaign.batch.pause` | `{}` | 同上 | 同上 |
| `campaign.batch.resume` | `{}` | 同上 | 同上 |
| `workspace.interactive.confirm` | `{"confirmation":"NO"}` | `INTERACTIVE_CONFIRMATION_REQUIRED`，中文“必须在当前交互会话明确确认写操作” | 无效确认值未打开写窗口 |
| `workspace.data.export.request` | `{}` | JSON-RPC `-32602`，中文“缺少必填字段 reason” | 此方法可在交互写门禁外运行，故用缺字段确保本地拒绝 |
| `platform.mapping.preflight` | `{}` | `INTERACTIVE_WRITE_DISABLED`，中文确认提示 | 预检可能写审计或映射批准，故不传有效映射 |

**计数口径：**13/13 完成已安装插件的本地拒绝路径试呼；0/13 完成 ChatGPT App 内调用；0/13 完成正向业务链路。App 主控若按上表试呼，须从会话原始工具记录确认调用和返回。宿主若因 schema 阻止缺字段请求，应记为“App schema 拦截”，不能算 bridge 门禁已执行。正向路径仍需要独立 QA 资源、准确权限/权益、明确交互确认和数据库前后审计。
