# Relay current-release receipt audit — 2026-10-05 (round 9)

Read-only review. No refresh request, provider mutation, ledger mutation, or
credential payload was accessed.

## Current endpoint/session state

- Target log session `/var/lib/merchant-assets/relay-session.json`: absent.
- `GET https://ai.wormholexyz.xyz/api/status`: HTTP 200.
- Authenticated `GET /api/pricing`: HTTP 200.
- `GET /api/log/self?p=1&page_size=1&type=2`: HTTP 401.

## Current-release binding search

The candidate HEAD is `59eb1e8db78005a2f9be1b8a808507422ffc82b8`; the live
release identity remains `ecs-3dc76c93b536`. A repository-wide search found no
relay provider receipt/ledger artifact that binds a provider request ID,
actual CNY cost, receipt hash, current candidate SHA, and current image-set
digest together.

Historical relay probe files use `relay-live-20260906` and mark successful
costs as `relay_pricing_snapshot` (derived pricing). Historical September
ledger exports contain cost and receipt fields but no current-release SHA or
image binding. They cannot satisfy the current release gate.

## Idempotency boundary

The current code still requires explicit provider CNY fields, separates quota
from currency, rejects mixed/unpriced statements and duplicate provider rows,
binds explicit user IDs to the authenticated log user, and fails closed on
conflicting cost or budget-link replays. No current provider self-log receipt
was available to exercise this path against real data.

The relay gate remains blocked pending a trusted target-workspace session and a
current-release provider statement matched to durable idempotent ledger rows.
