# 6f4f6e75 isolated staging MCP functional test

- Release: `release-6f4f6e75`
- Candidate project: `merchant-demo-6f4f6e75s`
- Workspace: `ws_candidate_6f4f6e75s` (synthetic acceptance fixture)
- Transport: local plugin bridge over loopback TLS tunnel to isolated ECS candidate
- ChatGPT native app surface: not run; CUA is safety-denied for `com.openai.codex`

## Results

| Tool | Result | Evidence |
|---|---|---|
| `tools/list` | `PASS` | 120 tools exposed |
| `workspace.interactive.confirm` | `PASS` | structured response received |
| `billing.status` | `PASS` | structured response received |
| `catalog.import` | `PASS` | structured response received |
| `catalog.facts.confirm` | `PASS` | structured response received |
| `catalog.title.optimize` | `PASS` | structured response received |
| `catalog.image.generate` | `MODEL_RELAY_EVIDENCE_REQUIRED` | 平台正在核对本次生成记录，暂时不能继续。没有生成新内容、扣费或发布；当前任务和已有产物已保留，核对完成后可继续。 |
| `content.draft.generate` | `MODEL_PROVIDER_REQUEST_FAILED` | 模型请求被中转服务拒绝。未生成新内容、未重复扣费；请更换可用模型或稍后重试。 |
| `multimodal.video.request` | `MCP_GATEWAY_ERROR` | 服务暂时不可用，未确认操作是否完成。请稍后重试；如仍失败，再检查工作区连接。 |

## Interpretation

- `catalog.import`, `catalog.facts.confirm`, and `catalog.title.optimize` passed. The title output carried product facts, keyword evidence, score 82, and no ranking guarantee.
- `catalog.image.generate` reached the real image relay and compositor (provider HTTP 200, one parsed image, 1024×1024), then stopped at `MODEL_RELAY_EVIDENCE_REQUIRED` because this minimal candidate has no worker/ClamAV archive path; no deliverable or charge was exposed.
- `content.draft.generate` returned a real relay `429` with provider request/idempotency evidence and `retryable=true`; it did not fabricate content or silently repeat billing.
- Valid `multimodal.video.request` storyboard direct HTTP evidence is in `video-storyboard-valid.json`: provider text-relay completed with a three-shot storyboard, rule preflight non-blocking, and `simulated=false`.
- Malformed video context `{}` returned `INVALID_REQUEST` with product/brand/rules issues in `video-context-invalid.json`; it no longer becomes a 500.
- The gateway timeout regression is fixed in commit `2ae590a5`; its regression assertions are in commit `8b32f70f`.
