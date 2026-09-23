# ChatGPT.app 宿主 Canary 验收清单

用途：在 Computer Use 管道恢复后，采集真实 ChatGPT.app 的插件安装、MCP 调用和图片选择证据。该清单不能用本地 fixture、公网 MCP curl 或模拟测试替代。

## 前置绑定

- 记录正式 `release_id`、插件版本、已安装 bridge 的 SHA-256。
- `mcp_base_url` 必须是正式公网 HTTPS 根 origin，不含 `/mcp`、凭据、query、localhost 或内网 IP。
- 宿主必须标识为真实 macOS ChatGPT.app；`simulated=false`。
- 每个场景保存不可变 artifact 引用，且 console/network errors 均为 0。
- 预生产验收必须另外保存隔离 `/releasez` 的原始 JSON；记录候选 API 与 TLS gateway 的完整 Docker ID、临时 `.mcp.json` 与 route 文件的 SHA-256，并与冻结 Git SHA、image-set digest 一起写入 `candidate_route`。每个场景和错误恢复对账使用不同的 artifact 文件。

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
  "environment": "preproduction",
  "host": "chatgpt",
  "app_version": "真实 ChatGPT.app 版本",
  "plugin_version": "已安装插件版本",
  "mcp_base_url": "https://正式商家域名",
  "bridge_sha256": "已安装 bridge.mjs 的 SHA-256",
  "simulated": false,
  "candidate_route": {
    "expected_git_sha": "40 位冻结 Git SHA",
    "expected_image_set_digest": "sha256:64 位镜像集摘要",
    "candidate_api_container_id": "64 位候选 API Docker ID",
    "gateway_container_id": "64 位隔离 TLS gateway Docker ID",
    "mcp_config_sha256": "64 位临时 .mcp.json SHA-256",
    "route_file_sha256": "64 位临时 route 文件 SHA-256",
    "release_probe_artifact_path": "/secure/captures/releasez.json"
  },
  "scenarios": [
    { "id": "plugin_discovery", "state": "passed", "console_errors": 0, "network_errors": 0, "artifact_path": "/secure/captures/plugin-discovery.json" }
  ]
}
```

其余场景按同样格式补齐；`error_recovery` 还必须包含 `trigger_http_status=503`、`trigger_error_code=MODEL_PROVIDER_OUTCOME_UNKNOWN`、`retry_allowed=false`，以及与场景记录不同的真实对账结果文件路径 `outcome_artifact_path`。上线后正式域名复测另采一份 `environment=production` 的证据，此时不使用 `candidate_route`。使用：

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
  --expected-git-sha "$RELEASE_GIT_SHA" \
  --expected-image-set-digest "$IMAGE_SET_DIGEST" \
  --artifact-root artifacts \
  --require-artifacts
```

采集器会拒绝 localhost、fixture、mock、模拟标记、缺失场景、复用场景文件以及不匹配的候选 `/releasez`；它只能检查操作员提供的证据一致性，不能从本地浏览器或 Bridge 自行生成宿主证据，也不能单独证明截图或宿主日志确由 ChatGPT 产生。上线前仍需人工核验真实宿主记录。
