# Relay provider cost and receipt audit — round 4 (2026-10-05)

This is a read-only, credential-free probe. No access token, refresh cookie,
request body, or provider log row was copied into the repository.

## Observations

The configured relay origin `https://ai.wormholexyz.xyz` responded over HTTPS:

| Path | HTTP | Bytes | Body SHA-256 | Redacted observation |
| --- | ---: | ---: | --- | --- |
| `/api/status` | 200 | 3090 | `1a4a3cd064b39474648d610f75b8765f3015ec24193d1d05b01f165a51d38e73` | `quota_per_unit=500000`, `usd_exchange_rate=6.83`, display `CNY` |
| `/api/pricing` | 200 | 26993 | `f9c7552e14f55406579989c706de2d4c6f4d01a3184edd7bdca64e3dd0d03865` | pricing version `a42d372ccf0b5dd13ecf71203521f9d2`, 39 models, 5 groups |
| `/api/log/self` | 401 | 91 | `906f2bbece07ef88cf37a8a2031b98f55913dd0e51389c5db788c172d7a32071` | log statement is unavailable without a trusted target-workspace session |

A 200 pricing/status snapshot establishes relay reachability and pricing
metadata only. It does not establish an actual-cost receipt for a model call.
No billable model request was sent by this probe.

## Fail-closed changes

`parseRelayUsage` and `NewApiSelfLogClient` now reject malformed explicit cost
fields, non-CNY currency markers, and currency-only records. New API `quota`
remains a provider billing unit and is never converted to CNY. Duplicate
provider record IDs and contradictory persisted costs remain hard errors.

## Verification

- `npx vitest run packages/ai/src/relay-usage.test.ts packages/ai/src/provider-usage-log.test.ts` — 58/58 passed.
- Actual-cost and idempotent settlement evidence remains blocked until a trusted
  target-workspace log session can read `/api/log/self` and be matched to the
  current release's provider request IDs and ledger rows.
