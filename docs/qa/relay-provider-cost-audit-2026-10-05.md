# Relay provider cost and receipt audit — 2026-10-05

This is a redacted, read-only audit. No token, refresh cookie, session file, or
provider response body containing credentials is copied into the repository.

## Endpoint observations

The configured relay origin is reachable over HTTPS. A public `GET /api/status`
returned HTTP 200 and a provider request ID. `GET /api/log/self` returned HTTP
401 (`AUTH_UNAUTHORIZED`), and unauthenticated `POST /api/user/auth/refresh`
also returned HTTP 401. These observations prove reachability and the endpoint
contract, but do not prove that the target workspace can read provider logs.

The local process had no `MODEL_RELAY_LOG_BASE_URL`,
`MODEL_RELAY_LOG_USER_TOKEN`, `MODEL_RELAY_LOG_REFRESH_COOKIE`,
`MODEL_RELAY_LOG_SESSION_FILE`, or `MODEL_RELAY_LOG_USER_ID` values. Therefore
no provider-log query or refresh was attempted with guessed credentials.

## Receipt and ledger status

The existing canary artifacts under `artifacts/model-relay-live-20260906` use
versioned pricing snapshots and provider request IDs. They are historical and
are not bound to the current release. The 2026-09-30 audit was blocked before
billable requests because both observed credentials reported
`unlimited_quota=true`.

The provider-log client now exposes an optional `costCny` only when the provider
log explicitly reports a currency-named field (`cost_cny`, `costCny`,
`actual_cost_cny`, or `actualCostCny`). New API `quota` remains a separate
provider billing unit and is never converted to CNY. An explicitly present but
malformed cost field rejects the record, preserving fail-closed behavior.

Duplicate provider record IDs remain a hard error in `listAll`; a replay cannot
silently create a second receipt. Downstream model-usage and creative-point
settlement still require the immutable provider request ID, usage, and verified
actual CNY receipt before settlement.

## Verification

`npx vitest run packages/ai/src/provider-usage-log.test.ts` passed 17/17,
including explicit currency-cost parsing, quota/currency separation, malformed
cost rejection, refresh rotation, and duplicate-record protection.

The production gate remains blocked until a trusted target-workspace session is
injected and a provider log statement plus matching ledger rows can be queried
and archived for the candidate release.
