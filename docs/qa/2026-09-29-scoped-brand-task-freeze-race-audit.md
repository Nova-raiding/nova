# Scoped brand task freeze concurrency audit (2026-09-29)

## Scope and finding

This audit covers the interval from `resolveForTask` returning to the confirmed task snapshot committing in PostgreSQL. The current implementation does not make that interval atomic. A brand settings update or asset reassignment can commit after the resolver transaction releases its locks and before the task snapshot commits. The frozen task can therefore reflect an earlier brand revision or asset assignment than the database state at task persistence time. Whether that is acceptable requires an explicit freeze linearization point; the code currently does not define one across these operations.

This is a source and test contract audit. No live production concurrency claim is made.

## Reproducible call chain

`codegraph status` reported an up-to-date index; `codegraph explore resolveForTask hydrateScopedBrandForTask` located the resolver and hydration relationship. Direct source review completed the handler and persistence edges:

1. `apps/api/src/mcp-task-continuation-handlers.ts:67-79` handles `task.plan.confirm`. It awaits `hydrateScopedBrandForTask`, calls `service.confirmProductionPlan`, then awaits `persistSnapshot`.
2. `apps/api/src/scoped-brand-task-hydration.ts:27-32` awaits `repository.resolveForTask` and only after it returns calls `service.setScopedBrandForTask`.
3. `packages/persistence/src/scoped-brand-settings-repository.ts:126-155` runs the resolver in `withWorkspaceTransaction`. It reads settings without a row lock, loads bindings, and reads selected existing assignment rows `FOR SHARE`.
4. `packages/persistence/src/repository.ts:591-622` commits that transaction before returning its result. Its row locks are released at that commit.
5. `packages/application/src/service.ts:4655-4661` captures the scoped brand from the pending in-memory map, then mutates the task to `plan_confirmed` and increments its version.
6. `apps/api/src/server.ts:4707-4715` persists the task through `persistSnapshotAndEvent`; `apps/api/src/server.ts:3238-3264` opens a separate workspace transaction for the business snapshot and outbox event.

Thus, the database lock held during resolution does not cover the in-memory freeze or the task snapshot commit. The settings row is also not locked by the resolver's initial read. A missing assignment has no row to lock, so an insertion into that gap is another boundary to account for.

## Existing evidence and its limits

`packages/persistence/src/scoped-brand-settings.release.postgres.test.ts:111-145` pauses `resolveForTask` before its transaction ends and checks that `assignAsset` times out with PostgreSQL `55P03`. It then releases the resolver and successfully reassigns the asset. This proves the existing assignment row lock works while the resolver transaction is open. It does not run `setScopedBrandForTask`, `confirmProductionPlan`, or task snapshot persistence while that lock is held; it cannot establish an atomic task freeze.

`apps/api/src/scoped-brand-routes.contract.test.ts:154-183` checks that a resolved revision reaches a confirmed task snapshot in a sequential mock flow. Its repository and persistence dependencies are mocks, so it cannot detect a PostgreSQL commit between resolution and snapshot persistence. `packages/application/src/service-scoped-brand.test.ts` checks that a confirmed task rejects later in-memory brand replacement; it does not cover database concurrency.

## Why a callback inside the resolver is unsafe

Keeping `resolveForTask` open while a callback confirms and persists the task would still use two database transactions: the brand read transaction and the task snapshot transaction. The task transaction could commit, followed by a failure or rollback of the brand transaction. Conversely, `confirmProductionPlan` mutates the service's in-memory task before task persistence; a persistence failure leaves that in-memory task confirmed even if no durable task snapshot was written. Nested pool acquisition can also stall when `DB_POOL_MAX=1` (the default is 20 at `apps/api/src/server.ts:3102`) and introduces lock-order risk. A callback alone is therefore not a safe minimal fix.

## Smallest correct change to design and verify

1. Stage the confirmed task and its input snapshot without publishing the mutation to shared service state. The stage should include the exact scoped brand revision and selected assignment identity/revision used to calculate effective values.
2. In one workspace-scoped PostgreSQL transaction, resolve and protect the brand state, validate the task's expected version, write the task snapshot, and append its state event. The transaction must define behavior for absent settings and absent assignment rows, so concurrent inserts cannot silently change the chosen scope. Use one SQL client and a documented lock order for brand writes and task confirmation.
3. After the database commit succeeds, install the staged task in memory. On a transaction error, discard the stage. If the post-commit in-memory installation fails, reload the committed task from persistence rather than recomputing its frozen inputs.
4. Exercise two independent PostgreSQL sessions with barriers at the brand read, task write, and commit boundaries. Cover concurrent settings update, reassignment, missing-row insertion, task version conflict, forced snapshot write failure, and transaction rollback. Assert both persisted task state and service state after each failure. Keep tenant RLS enabled in these tests.

The resulting guarantee should be phrased around the chosen commit/linearization point and supported by those tests. The current sequential and lock-duration tests do not establish it.

## Change record

No runtime code, schema, or data was changed in this audit. No deployment was performed.
