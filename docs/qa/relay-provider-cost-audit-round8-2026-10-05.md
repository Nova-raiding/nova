# Relay receipt and idempotency audit — 2026-10-05 (round 8)

Read-only review; no refresh request or write was performed.

## Current session and endpoints

- `/var/lib/merchant-assets/relay-session.json` is absent.
- `GET /api/status` returns HTTP 200.
- `GET /api/pricing` with the configured relay API key returns HTTP 200.
- `GET /api/log/self?p=1&page_size=1&type=2` returns HTTP 401.

The target workspace therefore has no queryable provider usage statement. The
refresh cookie was not used because refresh rotates credentials.

## Receipt evidence inventory

The historical `artifacts/model-relay-live-20260906` files include provider
request IDs and costs, but successful rows are labelled
`cost_source=relay_pricing_snapshot` (derived pricing), not provider-reported
actual cost. They are bound to release `relay-live-20260906`, not the current
candidate. `artifacts/model-relay/canary.json` is expired and has an empty
release ID. The 2026-09-29 ledger exports include costs and receipt hashes but
do not bind them to a current release SHA/image set or a readable provider
self-log statement.

No legal current-release actual-cost receipt was found. Existing code and
tests continue to enforce explicit CNY actual-cost fields, quota separation,
duplicate rejection, cross-user identity checks, and conflicting-cost
idempotency failures.

## Gate

Relay remains blocked until a trusted target-workspace session permits a
provider self-log query and that statement can be matched to current-release
durable ledger rows.
