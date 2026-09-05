# ChatGPT.app 宿主 Canary 验收清单

用途：在 Computer Use 管道恢复后，采集真实 ChatGPT.app 的插件安装、MCP 调用和图片选择证据。该清单不能用本地 fixture、公网 MCP curl 或模拟测试替代。

## 前置绑定

- 记录正式 `release_id`、插件版本、已安装 bridge 的 SHA-256。
- `mcp_base_url` 必须是正式公网 HTTPS 根 origin，不含 `/mcp`、凭据、query、localhost 或内网 IP。
- 宿主必须标识为真实 macOS ChatGPT.app；`simulated=false`。
- 每个场景保存不可变 artifact 引用，且 console/network errors 均为 0。

## 必测场景

按以下顺序执行并分别保存截图、宿主日志和 MCP 请求/响应摘要：

`plugin_discovery`、`merchant_start`、`wallet_recharge_entry`、`platform_oauth_entry`、`asset_attachment`、`error_recovery`、`image_generation`、`automatic_scan`、`candidate_images_rendered`、`candidate_primary_cta`、`candidate_selection_persisted`、`selection_not_reviewed`、`selection_not_published`、`automation_read_only`、`automation_host_absent`。

重点要求：

- 图片候选必须在 ChatGPT 对话中真实渲染，主图 CTA 不能绕过审核或发布确认。
- `error_recovery` 必须真实触发 503 `MODEL_PROVIDER_OUTCOME_UNKNOWN`，且只能进入查询/对账恢复，不能自动重试扣费。
- Automation 必须证明只读；没有宿主时必须 fail-closed，不得创建同步、生成、批准或发布任务。
- 每个场景必须绑定当前 release 和 bridge，不接受旧安装缓存或本地 fixture。

## 通过标准

使用 `tests/codex-app-host-evidence-gate.ts` 校验最终 evidence JSON；只有校验通过且与当前 release、MCP origin、bridge SHA 一致，才能移除“真实 ChatGPT 宿主验收”上线阻断。

