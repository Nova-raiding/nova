# Workspace lifecycle and deletion request: isolated MCP/API round

Date: 2026-09-29. All writes in this round target unique in-memory test workspaces through a locally started HTTP `/mcp` server. No production workspace, data, container, or migration was changed. CodeGraph resolved `handleWorkspaceLifecycleMethod` to the API lifecycle handler before extending existing tests.

| Method / control | Isolated path covered | Production/App status |
| --- | --- | --- |
| `workspace.deactivate` | Workspace owner succeeds; health reports disabled; catalog operations block; non-owner merchant and platform roles are refused even in shadow mode; audit retained. | No production or ChatGPT App write called. |
| `workspace.activate` | Workspace owner restores disabled workspace; missing reason fails; health/catalog access recover and audit records reason; non-owner merchant and platform roles are refused. | No production or ChatGPT App write called. |
| `workspace.data.delete.request` | Owner submits pending request, 7-day scheduled grace period and no approvals; identical idempotency key replays; changed intent conflicts; vague reason and operator role fail. | No production or ChatGPT App write called. |
| `ops.data.delete.cancel` | Authorized administrator cancels a pending request; cancelled request cannot advance to approval or execution in repository test; cross-tenant and support role are refused. | No production or ChatGPT App write called. |
| `ops.data.delete.approve` | Two independent administrators are required; requester/self, repeated approver and support role fail; approval remains pending after first reviewer and becomes approved after second. Execution before grace period fails. | No production or ChatGPT App write called. |

Relevant suites: `apps/api/src/workspace-status-authz.e2e.test.ts`, `apps/api/src/server.e2e.test.ts`, `apps/api/src/mcp-completion-ops.e2e.test.ts`, `packages/persistence/src/data-lifecycle-repository.test.ts`. The MCP test also asserts operation audit entries for request, cancel, and approval. Repository tests assert a cancelled request cannot execute and an approved request cannot execute before its scheduled date.

Run: `node --import tsx scripts/run-safe-tests.ts apps/api/src/workspace-status-authz.e2e.test.ts apps/api/src/mcp-completion-ops.e2e.test.ts packages/persistence/src/data-lifecycle-repository.test.ts --no-file-parallelism` → **3 files, 7/7 tests passed**. The separate `server.e2e.test.ts` lifecycle restoration test previously passed in the owner’s isolated server round; it was not rerun in this focused command. `git diff --check` passed for the two changed test files.

`npm run typecheck` passed after these test and evidence changes.

The cross-tenant cancellation negative test returned an error and no data, but its in-memory repository raised `DATA_DELETION_REQUEST_NOT_FOUND` as an unhandled error in the server log. The suite does not claim a clean 404 contract for that path. It is a separate API error-mapping defect to address before a production acceptance claim.

These isolated outcomes must not be counted as live ChatGPT App or production success.
