# Commercial transaction persistence implementation

Owner: eng_review. Shared main work directory; no branches, commits, production writes or payment actions from this owner.

Implemented migration 259 and the transaction repository used by the contract repository. New public purchasing uses explicitly frozen purchase kind and approved immutable catalog version/policy. Catalog resolution acquires the controlled sales projection lock before workspace/order/period/point writes. Receipt allocation calls the payment/grant method with the same SQL client so funds, qualification, dependency release, period revisions, points and outbox commit or roll back together.

First checkout creates two independent orders and their explicit dependency atomically. Opening qualification comes from verified source payment. Ordinary arrival uses the original half-open UTC payment window; a late verification preserves timely ordinary funds. Upgrade quotations freeze full source/target contracts, period revision, precise amount and cumulative entitlement remainder. A valid quotation continues using its frozen target version after a newly approved price is published, while an unavailable sale cannot authorize a fresh purchase. Upgrade delivery changes the current authoritative entitlement revision and retains its original period end; a stale source or period ending before verification becomes visible reconciliation instead of granting benefits.

Renewal is resolved by serialized verification order and appends after all already paid periods. Future points remain scheduled until their actual UTC period starts; an elapsed grant window expires visibly. Future contracts are never rewritten by a current upgrade. Opening gift schedules use the approved frozen count (1–24) and positive safe-integer points rather than permanently assuming six batches of 500; the original catalog default remains unchanged.

Source refund approval freezes the originating contract and point schedules. Completion cancels the source contract or restores the latest upgrade's prior entitlement, full cycle price and cumulative remainder. It does not shorten or lengthen expiry and does not erase historical snapshots. Unknown external payout keeps the source hold frozen. Requests require a matching approved frozen recovery policy; already used or committed services, partial contract valuations and prior base contracts with paid upgrades require explicit recovery decisions before automatic payout. The current requested-only rejection path does not release approved financial commitments.

Actor-scoped original-intent lookup returns immutable orders and quotes. Portfolio and frozen order view expose qualification, current/future periods, point packs and historical purchase snapshots. Checkout attachment clamps gateway resource expiry to the original order cutoff and cannot extend its payment window.

## Evidence

- `npm run build --workspace @merchant-marketing/persistence`: exit 0 after the transaction/restore implementation; final follow-up check belongs to the root integration gate.
- `npx vitest run packages/persistence/src/commercial-transaction-policy.test.ts packages/persistence/src/commercial-contract-repository.test.ts`: 2 files, 22 tests passed; no pending assertions. These cover frozen UTC cutoff, configurable schedule and monthly anniversaries, approval/cycle/rank boundaries, original repository compatibility, and callback replay fixtures.
- QA owner independently owns and executes `commercial-transaction-repository.release.postgres.test.ts` with real isolated PostgreSQL, merchant roles and source refund restoration. Unit fixture evidence above is not database, API/MCP, desktop or production acceptance. Those outcomes must be recorded by the QA/integration owner before deployment.

## Remaining integration gates

Register migration 259 and new exports; inject receipt same-client grant and refund preflight callbacks; execute worker schedules using workspace-scoped database roles; run the real PostgreSQL release suite and integrated typecheck/release gates. Merchant desktop/local stdio/API/MCP and candidate deployment health verification belong to the parent owner. No live funds or production database were changed by this implementation owner.
# Upgrade-only policy follow-up

The user explicitly requires upgrade-only tier changes. A newly appended purchase/renewal now reads the exact frozen identities of all still-effective paid current/future periods under the existing Workspace transaction lock. A target below any of those tiers is rejected with `COMMERCIAL_DOWNGRADE_NOT_ALLOWED`; a different family is rejected with `COMMERCIAL_PLAN_FAMILY_MISMATCH`. Missing current-revision entitlement/plan identity remains unresolved, and prices are never used to rank a plan.

Current-period upgrades are a separate operation: their quote/order checks the actual current tier only. Current basic → growth remains valid when the already-paid future plan is premium, because the time sequence is still growth → premium. The future high-water floor is not applied to the current upgrade quote. Same-tier renewal retains the existing renewal policy, and changing the current tier still requires its frozen upgrade quote.

Strict prior-order replay occurs before the fresh-intent floor; the payment/grant paths do not reclassify historical pending orders. Existing frozen lower future periods and valid old pending orders are preserved without a rewrite, refund or automatic top-up. New source recovery/contract changes continue to use the existing locks and blockers.

Eight targeted no-downgrade tests plus four transaction-policy tests pass. They cover merchant/Ops fresh low-tier refusal, cross-family refusal, frozen-price-independent ranking, same-tier renewal with historical lower future facts, exact old pending replay, and current basic → growth quote/order with future premium preserved. The current quote test checks the same original period and 27/31 remaining-time price (174194 fen). This is targeted unit evidence; real transaction PostgreSQL fixtures remain owner-controlled.
