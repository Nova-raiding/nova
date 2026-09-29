# Formal content workflow isolated-runtime audit — 2026-09-29

## Method evidence

- `apps/api/src/server.e2e.test.ts`: 80/80 passed. Its complete MCP catalog-to-version case exercises `task.create`, `task.select_direction`, `task.plan.confirm`, `content.codex.commit`, `content.review`, `content.versions`, `content.diff`, `content.export` (manifest), and `content.approve` through HTTP, followed by tenant-scope rejection. The test uses a fixture connector and a nonproduction Codex commit, so it is isolated workflow evidence, not production model-relay or ChatGPT App evidence.
- `apps/api/src/mcp-completion-content.e2e.test.ts`, `mcp-content-knowledge-http.e2e.test.ts`, `commercial-review-gate.e2e.test.ts`, and `review-decisions.e2e.test.ts`: 11/11 passed. These use bearer-authenticated HTTP MCP calls in isolated runtimes and cover task request idempotency, SKU split, direction update, restore with version conflict, review decision gating, and protected resource/tenant checks. Some commercial methods intentionally return `COMMERCIAL_OPERATION_DISABLED` in their fixture configuration.
- `apps/api/src/product-image-review.e2e.test.ts` and `brand-extraction.e2e.test.ts`: 15/15 passed. They cover image candidate selection into a new content version, content re-review/approval, creative brief/preview gates, and brand extraction.
- `apps/api/src/knowledge-consumption.e2e.test.ts`: 1/1 passed after adding exact `content.generate` execution and point-reservation assertions. Bearer-authenticated MCP generated a formal `review_required` version and persisted its frozen rule/asset context, then REST read the version back. This uses the deterministic local fixture: `execution.mode=simulated`, `providerExecuted=false`, no provider request ID, usage, or CNY cost. The fixture's action-specific creative-point reservation was `active` with `settledPoints=null`; this is not a settled charge or proof of production billing. No external provider was called.

CodeGraph exploration of `handleMcpContentVersion` confirmed `content.export` scopes the content version, checks canonical task scope, validates the format and size, and verifies bundle bytes before returning Base64. This source relationship was inspected; the tests above are the runtime evidence.

## Production/App gap

Earlier authenticated production bridge audit found `task.history` returned zero formal tasks in the demo workspace. Calls to `generation.get`, `content.versions`, and `content.diff` with nonexistent references returned `FORBIDDEN`. Therefore successful production `content.generate`, read, review, version export, and approval paths cannot yet be claimed for the ChatGPT App. Creating a confirmed, clearly marked demo product and formal task/version through the production workflow is the prerequisite. The production model-relay request, provider usage, cost, point settlement, and App-visible formal version remain unverified. Do not treat the isolated fixture or fail-closed responses as production success.

## Command nuance

Filtering `server.e2e.test.ts` to a single case passed that case but made the repository pending-assertion reporter exit nonzero because it counted 79 intentionally skipped cases. The full-file run above exited zero.
