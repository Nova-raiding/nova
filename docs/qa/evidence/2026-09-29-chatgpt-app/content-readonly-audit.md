# Content and creative production MCP audit — 2026-09-29 08:22 CST

## Scope and authentication

- Installed local `merchant-marketing` cache: `0.1.0+codex.20260929074100`, stdio `mcp/bridge.mjs`; production origin `https://yxsona.com`; workspace `ws_guirenniaoniao`.
- Used the merchant account supplied by the user to obtain a short-lived, workspace-scoped MCP bearer through the production password session and `/v1/auth/mcp-token`. The bearer and session cookie stayed in process memory and were not printed or saved.
- Every business call below went through the installed stdio bridge with `MERCHANT_MCP_WRITE_ENABLED=false` and production mode. No write, generation, model cost, publication, or product data change was requested.

## Actual production results

| MCP method | Input | Actual result | Acceptance scope |
| --- | --- | --- | --- |
| `deliverable.list` | `limit=5` | Authenticated success (`isError=false`); structured result includes `items`, `count`, `totalMatched`, `nextCursor`, `hasMore`, `asOf`, `storageMode`, `empty_state`, `action_cards`. | Read-only endpoint works. No existing deliverable was exported or opened. |
| `task.history` | `limit=5`, then `limit=10` | Authenticated success (`isError=false`). Second call returned `items=[]`, `total=0`. | Confirms there is no formal task in this production demo workspace to use for a successful content-version path. |
| `generation.get` | random nonexistent `job_id` | Authenticated bridge returned `FORBIDDEN`; no generation job was queried successfully. | Protected resource-scope denial observed; successful job status path remains untested. |
| `content.versions` | random nonexistent `task_id` | Authenticated bridge returned `FORBIDDEN`; no task versions were read. | Protected resource-scope denial observed; successful version-list path remains untested. |
| `content.diff` | random nonexistent `content_version_id` | Authenticated bridge returned `FORBIDDEN`; no diff was read. | Protected resource-scope denial observed; successful diff path remains untested. |

`task.history` was used only to find a valid task for the content methods; it returned zero tasks. These `FORBIDDEN` responses are expected fail-closed outcomes for unowned or nonexistent brand-scoped references, not proof that successful reads work.

## Installed tool surface and local checks

- `tools/list`: 131 merchant tools total; 14 in `deliverable.*`, `creative.*`, `content.*`, `generation.*`.
- Read-only among those 14: `deliverable.list`, `generation.get`, `content.versions`, `content.diff`. The remaining ten tools are writes, point-gated actions, or local artifact creation; none was exercised on production in this round.
- `creative.directions`, `content.review`, and `content.modify` appear in implementation and guidance, but are disabled and absent from the merchant tool list. Local bridge calls returned `COMMERCIAL_OPERATION_DISABLED` before API forwarding.
- Existing local API/contract tests for content and review passed 24/24 across six suites. This is local automated coverage, not production success evidence.
- Earlier ChatGPT App evidence shows one successful `content.draft.generate` with actual model usage and cost; this round did not repeat a charged call.

## Remaining prerequisites

To verify successful `generation.get`, `content.versions`, `content.diff`, export, review, approval, and formal generation in production, create a clearly labeled, confirmed test product and corresponding formal candidate task/version under a controlled test plan. The current production QA product has unconfirmed facts; this audit made no changes to it.
