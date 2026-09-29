# Asset upload and facts MCP audit — 2026-09-29

Scope: existing isolated API runtime over real HTTP `/mcp`, plus production read-only health. No production asset writes, provider calls, or DB migration were made.

| Method | Evidence | Result and limit |
| --- | --- | --- |
| `asset.upload` | `demo-unscanned-mcp.e2e.test.ts` | Local demo upload persisted bytes; authenticated download matched source. Response was `unscanned`, and there was no scan receipt or scanner job. This does not prove a live production upload or malware scan. |
| `asset.upload.batch` | `demo-unscanned-mcp.e2e.test.ts` | Local HTTP MCP accepted two text assets and rejected an executable disguised as PNG, returning per-item success/failure and `partial: true`. |
| `asset.parse` | `demo-unscanned-mcp.e2e.test.ts`, `asset-parse.e2e.test.ts`, `asset-parse-durable.e2e.test.ts`, `asset-ocr-rate-gate.e2e.test.ts` | Text parser returned extracted facts; unsupported image followed failure/manual path. Local parser explicitly reported `simulated: true`, `providerExecuted: false`. OCR relay execution in production remains unverified here. |
| `asset.facts.confirm` | `asset-parse.e2e.test.ts`, `asset-parse-durable.e2e.test.ts` | Local HTTP MCP saved manual facts with `extractedFactsSource: manual` and actor; durable conflict/failure tests passed. No production facts were changed. |
| `asset.rights.update` | `product-image-review.e2e.test.ts`, `asset-scan-worker.e2e.test.ts` | Local HTTP MCP updated rights status, scope, platforms, regions, usage and AI-edit permission, and image generation gate reacted. Production rights update remains unverified. |
| `upload.session.create`, `.part`, `.complete` | `mcp-upload-session.e2e.test.ts` | All three exposed HTTP MCP calls returned `UPLOAD_TRANSPORT_NOT_CONFIGURED`. API initializes `new UploadSessionManager()` without transport. The in-memory manager unit test proves only behavior when a test transport is injected. These tools cannot complete an upload in the deployed API design. |

Production `/api/healthz` reported S3-compatible object storage configured and the asset scanner control gate ready. Those readiness flags do not establish that the `upload.session.*` transport exists. The same response reported `productionEvidence.capability` and `.capacity` blocked because their configured paths could not be read.

Implementation limits before enabling multipart sessions: durable per-workspace session state and ownership checks, awaitable part persistence, verified object transport and final asset registration/scanning. Local plugin candidate `0.1.0+codex.20260929085500` now hides all three session tools; bridge and marketplace mirror expose 116 merchant tools and reject a direct hidden-method call before API forwarding. The API retains its fail-closed error for non-plugin callers. Installation and ChatGPT App restart are separate owner verification steps.

Commands passed: first targeted Vitest run 56/56, second targeted run 36/36, new handler gate test 1/1, new HTTP MCP session gate test 3/3; plugin bridge 98/98, install smoke 28/28, upgrade installer 6/6, MCP surface 16/16. `verify-installed-bridge` compared the source and local marketplace trees: `ok=true`, 53 runtime files, 116 tools on each side. Full `npm run typecheck` reached merchant studio and failed on four `storageScope` props in `demo/merchant-studio/src/App.tsx`; these are unrelated in-progress shared edits, not failures from this audit.
