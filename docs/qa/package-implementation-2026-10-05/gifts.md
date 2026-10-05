# Frozen onboarding gifts and point ledger origins

2026-10-05 application_backend owner; main directory, no branch/commit. PRD §12.1/15. gstack review principles applied: immutable purchase source, SQL tenant scope, unknown result retention, actual consumer evidence.

## Implementation

- Shared DTO: `packages/contracts/src/commercial-point-origins.ts`. Existing `commercial.subscription.get` appends `onboarding_gifts`; existing statement method appends each entry's `commercial_origin`. No additional customer method/page.
- `PostgresCommercialPointOriginReadRepository(pool)` reads source order and frozen SKU snapshot, frozen monthly schedule, actual dispatch/grant and expiry facts under `withWorkspaceTransaction`. Paid schedules must be complete; frozen approved/executable catalog content checksum and each schedule source checksum must agree. Policy comes from actual top-level frozen `payload.policyRef`, count 1..24 matching the grant consumer. No current catalog lookup or business writes.
- Initial opening gift and subscription grant both use `commercial_order_v2`; distinction comes from frozen source SKU kind. Later onboarding and `commercial_schedule_v3` grants resolve their actual schedule/order. Already issued grant expiry is identified by real expired ledger + operation `grant_id`; unissued window expiry uses the real onboarding expiration table. `expired_by_time` is separately named and does not imply expiry was executed.
- Mixed consumption and unresolved/missing grant sources stay unknown. A failed schema/query does not turn into an empty gift plan. RLS queries and all joins bind exact workspace. Errors at optional API read port become explicit unknown fields.
- Order view pure helper `projectFrozenOnboardingGiftPolicy` receives frozen `sku.payload.grantSchedule`. Root wires it into server snapshot.kind/onboarding_gift_policy. Merchant owner renders compact gift and statement source views using these shared DTOs.

## Verification

- Scoped Vitest: `commercial-gift-policy-view.test.ts` (7) and `commercial-point-origin-read-repository.test.ts` (3), 10 passed, exit 0. Covers frozen 500 versus separately approved 600, malformed rule => null, frozen checksum/schedule inconsistency => unavailable, policy_ref and actual expiry/time distinction, missing SQL schema => unknown with null plans.
- Added one isolated actual PostgreSQL acceptance case to `commercial-transaction-repository.release.postgres.test.ts` (now 11 cases), preserving existing 10 cases/fixtures. It requires normal available/known read views; initial gift versus subscription; cross-workspace no leak; actual reservation spanning two grants with unknown singular attribution; actual issued gift expiry and later dispatch; approved two-month plan second schedule `commercial_schedule_v3` attribution. Root/QA owns serialized PG launcher. **This new case has not yet been executed; prior PostgreSQL evidence does not prove this read adapter.**
- No global typecheck, PostgreSQL fixture, browser launcher or deployment launched by this owner during this scope. Root integrates ports/server and runs final unique gates; QA owns runtime/GUI verification.
