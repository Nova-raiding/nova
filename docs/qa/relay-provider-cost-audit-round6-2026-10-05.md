# Relay actual-cost and idempotency audit — 2026-10-05 (round 6)

This audit intentionally contains no token, cookie, session payload, or
provider response body.

## Session probe

The configured origin was `https://ai.wormholexyz.xyz`, with target log user
`7`. The configured owner-only session path
`/var/lib/merchant-assets/relay-session.json` is absent. A read-only probe was
run with refresh-cookie and session-file inputs disabled; it stopped before any
network request with `missing_non_refresh_session`. The refresh endpoint was
not called, because rotating a cookie is a state-changing operation and no
reviewable target session was available.

## Actual-cost boundary

`NewApiSelfLogClient` accepts cost only from explicit currency-named provider
fields (`cost_cny`, `costCny`, `actual_cost_cny`, or `actualCostCny`). New API
`quota` remains a provider billing unit and is never converted to CNY. A
statement containing an unpriced row, malformed amount, non-CNY currency, or
duplicate provider record is rejected before settlement. `readActualCostReceipt`
now also rejects any explicit `user_id` that differs from the authenticated
target user (`PROVIDER_USAGE_IDENTITY_MISMATCH`).

## Idempotency boundary

The usage repositories bind a receipt to the workspace and provider request
ID/receipt key. Exact replays preserve the original row and revision; a replay
with a different cost or budget link fails closed (`MODEL_USAGE_COST_CONFLICT`
or `MODEL_USAGE_BUDGET_LINK_CONFLICT`). No fixture or quota-only row is
accepted as actual-cost evidence.

## Verification

`npx vitest run packages/ai/src/provider-usage-log.test.ts --no-file-parallelism`
passed 23/23, including cross-user rejection, quota-only rejection, malformed
and non-CNY cost rejection, exact receipt lookup, duplicate records, and
session rotation safety. `npx vitest run
packages/persistence/src/model-usage-repository.test.ts --no-file-parallelism`
passed 22/22, including exact replay and conflicting-cost rejection.

The production evidence gate remains blocked until an owner-provided,
target-workspace session is made available and a real provider statement plus
matching ledger rows can be queried and archived for the candidate release.
