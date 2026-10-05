# C6 runtime write gate audit

2026-10-05. Scope: commercial method classification and the central API/MCP `enforceCommercialRuntimeMethod` helper. This report is implementation/test evidence, not production fleet acceptance.

## Changes

The method classifier covers the complete registered commercial MCP inventory. V3 order/checkout/upgrade quote creation and actual `catalog-v2.mutate` publication require the approved Sale lease. New refund requests/approvals, receipt-return proposals/approvals, point adjustments and private eligibility/credit issuance use a separate `new_recovery_intent` operation; compatibility and rollback reject it even if the caller supplies an approval ID.

Fresh legacy subscription create/change and private-trial order/conversion creation are retired independently of Sale mode. Their old handlers do not implement V3 frozen terms, and conversion replay does not strictly compare all original intent fields. The gate returns explicit V3 purchase/quote alternatives and original-order read actions instead of invoking those legacy writers. Original legacy facts and payment fulfillment remain accessible.

Committed V3 actor-bound order/checkout/quote keys can continue into their original repositories for strict intent comparison. Finding a prior key is not authorization to create a replacement order or change the price; checkout requires both original child facts. Cash recording, matching, reads, rejection of a proposed return/point adjustment, and existing catalog administration retain their existing authorization checks.

## Durable recovery facts

Single and batch receipt/payment fulfillment loads exact scoped immutable order snapshots. The predicate checks scope, source version, approval/executability/checksum and original creation timing; late money can continue to the transaction repository's disposition checks. Batch fulfillment validates every original order rather than accepting one successful item as batch proof.

Service commands load exact scoped allocation/source-order facts and compare their frozen source checksum. The source lookup requires an actual paid order and an approved executable frozen SKU. Allocation creation and execution still run the service repository's current-source, entitlement-revision, amount and refund-hold checks under its original transaction lock.

Refund completion loads immutable requested/approved event history, checks distinct approval identity and unchanged amount/source, and uses the actual approval event ID. Cash-return completion loads its exact workspace or approved platform-null row, checks its durable approved/external-unknown/completed state and maker/approver separation. Client evidence JSON, bounded list searches and balance changes are never recovery proof.

## Verification and boundaries

18 targeted Vitest tests passed: complete registered method inventory, actual publication method, legacy retirement, new-approval denial in rollback, cash/original fulfillment preservation, unknown-write rejection, exact order proof, immutable refund approval and return external-unknown recovery. Strict scoped TypeScript compilation of the module/policy and their tests passed before the final server integration; owner runs integrated type checking and API/release gates after all writers freeze.

Both the normal MCP entry and HTTP commercial adapter already call the central helper. The helper now uses the complete classification instead of a four-method partial list. Existing worker scheduling and original worker grants remain their source-bound transaction workflows; this patch does not create a new worker grant path or waive due-time, qualification, funds or source-recovery restrictions.

Remaining acceptance: owner must verify integrated authenticated API/MCP behavior, compatibility/rollback original-order fulfillment and approved recovery, and real fleet/lease enforcement. No production deployment or full-chain acceptance is claimed by these unit tests.

## Historical schema follow-up

The original payment/checkout/snapshot paths referenced migration-259 terms unconditionally and would reject genuine old-prefix orders with a missing-relation error. They now use the shared same-client relation/prefix verifier. A missing relation permits V2 fulfillment only after verifying every contiguous historical migration name/checksum against the bundled release; current or incomplete schemas fail closed, and actual query failures are propagated.

The old-order fallback additionally requires an original `commercial-order.v2` frozen snapshot, its canonical SHA256, catalog checksum and order SKU identity, and approved executable SKU validity at the original creation time. A V3 snapshot cannot fall back when its terms are missing. Modern terms still select the V3 transaction implementation and immutable payment deadline. The final V3 onboarding qualification insertion is skipped only on the verified historical prefix; original V2 payments, grants and schedules are preserved.

25 targeted scripted tests passed, including real bundled migration identities for prefixes 254–257, old immutable order reads, original checkout replay, V2 grant writes, corrupt/V3 snapshot denial, current schema missing-table denial and unmodified query-error propagation. Strict scoped TypeScript and diff checks passed. These are unit/scripted evidence; the owner runs the real PostgreSQL bridge fixture separately.

## Actor-bound replay lookup follow-up

The central gate must query committed original V3 intents before rejecting fresh writes in rollback; moving every lookup after the fresh-write gate would incorrectly close legitimate replays. Its shared finder now has an explicit `onlyV3` option. The server passes this option only for V3 gate probes. A verified historical prefix without V3 terms returns no V3 intent, while the default finder still reads exact actor/key V2 facts and verifies their immutable checksums, preserving original request recovery.

Current V3 probes require a frozen V3 snapshot and its original terms row. A current missing relation raises `COMMERCIAL_SCHEMA_INCOMPLETE`, and an actual query failure propagates; neither becomes a guessed “no prior request.” The quote finder applies the equivalent verified historical relation check. Three additional tests cover historical lookup separation, current V3 replay evidence, and unmodified failure handling: 28 targeted tests now pass, with strict scoped TypeScript and diff checks passing.

Gift read adapter review at 12:50 found tenant scope on every source join and origin kinds derived from immutable SKU snapshots. It also found the plan's `policy_ref` selected from `grantSchedule.policyRef` instead of the approved top-level `payload.policyRef`, a 100-batch projection bound inconsistent with the actual 24-batch consumer, and absent complete frozen snapshot/batch source checksum validation. These findings were handed to the application owner; closure requires reviewing their final adapter and actual scoped PostgreSQL evidence. No complete gift-read acceptance is claimed here.

The subsequent adapter delta closes the three concrete projection findings: top-level frozen policy, 24-batch bound, and approved/executable SKU content hash plus per-batch source checksum/execution fact checks. Tenant joins remain scoped and statement kinds still derive from the immutable source order. Real dispatch/expiry/origin and cross-workspace execution evidence remains the application/QA owner's responsibility.

The V3 subscription summary now checks its migration-259 qualification relation in the same transaction before any composite query. A verified old prefix raises `COMMERCIAL_SCHEMA_INCOMPLETE` rather than reporting an empty current contract; a current incomplete schema also fails closed. The real route mapper converts that typed error to a safe structured 503. Actual qualification query errors propagate, and the existing commercial access port continues to treat unavailable qualification as unknown. Two additional tests cover these boundaries: 30 targeted tests now pass. This does not assert support for the entire V3 portfolio on the old schema.

## Lifecycle diagnostic ordering and frozen plan identity

The actual migration identity is important: the cursor entitlement function was introduced by 254 and its revision filtering replaced by 259. Migration 263 concerns activation invites. The initial review inference that the function was absent on 255 was incorrect; for a valid entitlement there, the missing 259 qualification projection is the subsequent unknown-admission reason. The implementation uses the real fixed signatures/versions, not that earlier inference.

`hasCommercialFunctionForVerifiedPrefix` checks only the release-owned V2/V3 projection signatures with `to_regprocedure`, using introduced versions 223/254 and the unchanged full historical name/checksum verifier. Normally present V3 projections continue to be used; only a fully verified earlier prefix can use the old V2 projection. The reader joins the exact underlying snapshot and authoritative period revision in tenant scope. A saturated 200-row old noncursor projection reports unavailable instead of inferring absence from truncation. Existing migration-153 SELECT grants cover the joins; no ACL or historical SQL was changed.

`requireCommercialLifecycleDiagnostic` reads only the actual durable entitlement projection via `ContinuousFeatureEntitlementService`. Empty/invalid authority yields 402, unknown/ambiguous authority yields 503, and success returns explicitly diagnostic evidence without `allowed` or `qualified`. The caller may use it only before returning an unavailable lifecycle error and must still stop. Supported lifecycle writes continue through full qualification, feature and commercial admission; no old schema is labeled qualified and no points reservation or business mutation occurs in the diagnostic.

The portfolio also exposes `plan_family` and `tier_rank` from the same complete frozen SKU chosen for `skuCode`: current upgrade target, source recovery restored snapshot, then original order SKU. The full internal SKU is removed before returning the view; missing plan metadata remains null. A targeted current/future test verifies distinct frozen tiers with identical displayed SKU names, preventing name/price guesses.

46 targeted tests passed across the historical contract, schema compatibility and lifecycle diagnostic modules, including the actual fixed function migration identities and authoritative revision SQL. Real API bridge fixture and final integrated route ordering are verified by the root owner; this report does not claim full production acceptance.
