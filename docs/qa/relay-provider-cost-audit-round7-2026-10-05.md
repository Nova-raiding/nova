# Relay actual-cost and pricing audit — 2026-10-05 (round 7)

This is a read-only audit. It contains no API key, refresh cookie, session
payload, or provider response body.

## Live endpoint observations

- `GET https://ai.wormholexyz.xyz/api/status`: HTTP 200. The authenticated
  status payload contains the quota conversion fields required by the pricing
  client.
- `GET https://ai.wormholexyz.xyz/api/pricing` with the configured relay API
  key: HTTP 200; the snapshot reported 39 model rows, 5 groups, and a
  versioned pricing snapshot.
- `GET /api/log/self?p=1&page_size=1&type=2`: HTTP 401.
- The configured owner-only target session
  `/var/lib/merchant-assets/relay-session.json` is absent. No refresh request
  was sent, because refresh rotates credentials and is a write operation.

## Pricing and actual-cost boundary

The live pricing snapshot marks `deepseek-v4-pro` as `peak_offpeak`. The
pricing client rejects that dynamic tariff with
`MODEL_PRICING_MODE_UNSUPPORTED`, so it cannot be billed from a fallback token
ratio. The live fixed-unit image model can produce a versioned
`relay_pricing_snapshot` quote, which is explicitly derived pricing evidence,
not a provider actual-cost receipt.

The repository continues to require explicit provider CNY fields for actual
cost, rejects quota-only or mixed unpriced statements, binds receipt identity
to the authenticated user, rejects duplicate provider records, and fails
closed on conflicting cost/idempotency replays.

The configured local relay artifact exists but is historical and expired
(`generated_at` 2026-09-20, `expires_at` 2026-09-21), has an empty release ID,
and has no release SHA, image-set digest, or production-evidence marker. It
cannot be used as evidence for the current candidate.

## Verification

Relay-focused tests passed 93/93: provider usage 23, pricing 18, creative
settlement 30, and model-usage repository 22. No external writes were made.

Current release readiness remains blocked until a trusted target-workspace
session permits querying `/api/log/self` and a current-release provider
statement can be matched to durable idempotent ledger rows.
