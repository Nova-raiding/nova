# Relay current-release receipt audit — 2026-10-05 (round 10)

Read-only review. No refresh, provider mutation, ledger write, or credential
payload access was performed.

The target session file remains absent. Live probes returned HTTP 200 for
`/api/status` and authenticated `/api/pricing`, and HTTP 401 for
`/api/log/self?p=1&page_size=1&type=2`. The pricing snapshot reports 39 model
rows and 5 groups; `deepseek-v4-pro` is still `peak_offpeak`, so the pricing
client rejects it with `MODEL_PRICING_MODE_UNSUPPORTED` instead of using a
fallback ratio.

The candidate remains `59eb1e8db78005a2f9be1b8a808507422ffc82b8`, while the
live release remains `ecs-3dc76c93b536`. A search for candidate-bound files
containing both provider receipt fields and the candidate SHA found none. No
current-release actual-cost receipt with provider log proof and idempotent
ledger matching is available.

Relay tests passed 63/63 (provider usage, pricing, and model-usage
idempotency). The relay gate remains blocked pending a trusted target-workspace
session and current-release receipt evidence.
