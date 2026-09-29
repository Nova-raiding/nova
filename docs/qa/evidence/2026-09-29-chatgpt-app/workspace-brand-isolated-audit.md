# Workspace and brand-unit plugin round

Date: 2026-09-29. Scope: authenticated production read-only/negative evidence already captured in `workspace-onboarding-readonly-audit.md` and `brand-rule-readonly-audit.json`, plus isolated MCP/API suites in this round. No production invitation, export, or brand write was performed.

CodeGraph CLI: `status` found the 2,329-file index; `explore 'workspace data export get'`, `explore 'brand unit create list update'`, and `impact acceptWorkspaceInvitation` traced repository, handler and test dependencies. The index had pending changes; conclusions below were checked against current source and runtime tests.

| Tool | Production | Isolated evidence | Remaining gate |
| --- | --- | --- | --- |
| `brand-unit.list` | Authenticated MCP success | API brand scope and role suites passed | ChatGPT App invocation still needed |
| `brand-unit.listing.list` | Authenticated MCP success | API listing and scope suites passed | ChatGPT App invocation still needed |
| `brand-unit.create` | Not called | API create and duplicate paths passed | Interactive write confirmation plus production object |
| `brand-unit.bind-store` | Not called | API store binding, stale revision, invalid scope paths passed | Interactive write confirmation plus eligible store |
| `brand-unit.product.create` | Not called | API canonical creation, duplicate, cross-brand scope paths passed | Interactive write confirmation plus confirmed facts |
| `brand-unit.listing.create` | Not called | API listing creation, duplicate, cross-brand scope paths passed | Interactive write confirmation plus bound store/product |
| `brand-unit.access.grant` | Not called | API active-member/brand-role boundary paths passed | Interactive write confirmation plus reviewed member |
| `workspace.invitations.list` | Merchant account returned 403 `FORBIDDEN` | Direct handler test proves subject-scoped list | Verify production member role/projection; no pending invitation for that account is proven |
| `workspace.invitation.accept` | Not called | New handler regression tests prove matched-subject activation and foreign-subject denial | Real pending invitation and ChatGPT App interactive confirmation |
| `workspace.data.export.request` | Not called | Isolated MCP owner request, idempotent replay, conflict, low-role denial passed | Real owner/admin interactive confirmation and production export worker |
| `workspace.data.export.get` | Malformed ID returned 500 `INTERNAL_ERROR` | Isolated MCP existing read, malformed 400, missing 404, tenant isolation passed | Deploy already prepared UUID validation fix, then recheck production |

Commands and results: `node --import tsx scripts/run-safe-tests.ts apps/api/src/mcp-completion-ops.e2e.test.ts apps/api/src/feature-gap.e2e.test.ts apps/api/src/catalog-brand-scope.e2e.test.ts apps/api/src/security.e2e.test.ts --no-file-parallelism` → 110/110; `node --import tsx scripts/run-safe-tests.ts apps/api/src/server.e2e.test.ts packages/persistence/src/workspace-data-export-repository.test.ts packages/application/src/workspace-data-export.test.ts --no-file-parallelism` → 86/86; `node --import tsx scripts/run-safe-tests.ts apps/api/src/mcp-membership-handlers.test.ts --no-file-parallelism` → 2/2. Total 198/198 in isolated runs. `git diff --check` passed for the invitation patch.

`npm run typecheck` passed after the invitation fix.

Newly fixed local defect: the list resolves an invitation by either authenticated subject or account login, but acceptance previously updated membership by account login alone. If the invited `externalSubject` differs from the login, the listed invitation could not be accepted. The acceptance handler now updates the exact matched member's `externalSubject`, retaining the login as the audit actor. This is tested with distinct subject and login values and a foreign-subject rejection. It is a candidate fix only; no production deployment claim.
