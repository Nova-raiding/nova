# ChatGPT.app 宿主 Canary 验收清单

用途：在 Computer Use 管道恢复后，采集真实 ChatGPT.app 的插件安装、MCP 调用和图片选择证据。该清单不能用本地 fixture、公网 MCP curl 或模拟测试替代。

## 前置绑定

- 记录正式 `release_id`、插件版本、已安装 bridge 的 SHA-256。
- `mcp_base_url` 必须是正式公网 HTTPS 根 origin，不含 `/mcp`、凭据、query、localhost 或内网 IP。
- 宿主必须标识为真实 macOS ChatGPT.app；`simulated=false`。
- 每个场景保存不可变 artifact 引用，且 console/network errors 均为 0。

## 必测场景

按以下顺序执行并分别保存截图、宿主日志和 MCP 请求/响应摘要：

`plugin_discovery`、`merchant_start`、`merchant_payment_status`、`manual_publish_workflow`、`asset_attachment`、`error_recovery`、`image_generation`、`automatic_scan`、`candidate_images_rendered`、`candidate_primary_cta`、`candidate_selection_persisted`、`selection_not_reviewed`、`selection_not_published`、`automation_read_only`、`automation_host_absent`。

`merchant_payment_status` 仅验证 ChatGPT 能读取商家后台的支付/权益状态，不在插件内发起充值或真实扣款。`manual_publish_workflow` 验证六平台人工发布报告的查询和租户隔离，不要求平台 OAuth/API/Vault。

重点要求：

- 图片候选必须在 ChatGPT 对话中真实渲染，主图 CTA 不能绕过审核或发布确认。
- `error_recovery` 必须真实触发 503 `MODEL_PROVIDER_OUTCOME_UNKNOWN`，且只能进入查询/对账恢复，不能自动重试扣费。
- Automation 必须证明只读；没有宿主时必须 fail-closed，不得创建同步、生成、批准或发布任务。
- 每个场景必须绑定当前 release 和 bridge，不接受旧安装缓存或本地 fixture。

## 通过标准

使用 `tests/codex-app-host-evidence-gate.ts` 校验最终 evidence JSON；只有校验通过且与当前 release、MCP origin、bridge SHA 一致，才能移除“真实 ChatGPT 宿主验收”上线阻断。

## 采集文件

在真实 ChatGPT.app 中完成上述场景后，将每个场景的截图/宿主日志/MCP 摘要保存到同一生产 evidence root，并准备一个 capture JSON：

```json
{
  "release_id": "当前发布 ID",
  "environment": "production",
  "generated_at": "2026-09-23T02:00:00Z",
  "host": "chatgpt",
  "app_version": "真实 ChatGPT.app 版本",
  "plugin_version": "已安装插件版本",
  "mcp_base_url": "https://正式商家域名",
  "bridge_sha256": "已安装 bridge.mjs 的 SHA-256",
  "simulated": false,
  "scenarios": [
    { "id": "plugin_discovery", "state": "passed", "console_errors": 0, "network_errors": 0, "artifact_path": "artifacts/codex-host/plugin-discovery.json" },
    {
      "id": "error_recovery",
      "state": "passed",
      "console_errors": 0,
      "network_errors": 0,
      "artifact_path": "artifacts/codex-host/error-recovery.json",
      "error_recovery": {
        "trigger_http_status": 503,
        "trigger_error_code": "MODEL_PROVIDER_OUTCOME_UNKNOWN",
        "request_id": "真实请求 ID",
        "trace_id": "真实追踪 ID",
        "recovery_action": "query_provider",
        "retry_allowed": false,
        "before_state": "outcome_unknown",
        "after_state": "reconciled_succeeded",
        "reconciliation_required": true,
        "outcome_artifact_path": "artifacts/codex-host/error-outcome.json"
      }
    }
  ]
}
```

将示例时间和占位文本替换为本次真实宿主采集值，并按同样格式补齐其余 13 个场景。`generated_at` 必须是宿主采集时的 UTC 时间（`YYYY-MM-DDTHH:mm:ssZ` 或带三位毫秒）；执行下方 `--require-artifacts` 门禁时，采集时间不得晚于当前时间五分钟，也不得早于当前时间 24 小时。`artifact_path` 和 `error_recovery.outcome_artifact_path` 均指向 `--artifact-root` 内已存在的常规文件，不接受符号链接；示例路径以项目根目录为当前工作目录。采集器会计算 SHA-256，生成最终证据中的 `evidence_ref` 和 `outcome_evidence_ref`，不要在 capture JSON 中手填这两个字段。使用：

```bash
npm run codex:host:evidence -- \
  --capture /secure/capture.json \
  --output artifacts/codex-host/evidence.json \
  --artifact-root artifacts
npx tsx tests/codex-app-host-evidence-gate.ts \
  --file artifacts/codex-host/evidence.json \
  --release-id "$RELEASE_ID" \
  --expected-mcp-base-url "$MCP_BASE_URL" \
  --expected-bridge-sha256 "$BRIDGE_SHA256" \
  --artifact-root artifacts \
  --require-artifacts
```

采集器会拒绝 localhost、fixture、mock、模拟标记和缺失场景；它不能从本地浏览器或 Bridge 自行生成宿主证据。
