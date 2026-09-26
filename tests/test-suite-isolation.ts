// These files are real-runtime acceptance, not hermetic unit/API fixtures.
// Keep them reachable through explicit integration entrypoints, never through
// the default suite. This list remains explicit even if an individual test
// later removes its historical localhost fallback.
export const NON_HERMETIC_TEST_FILES = [
  // Optional Kubernetes/ACK checks are outside the ECS release denominator.
  // Their dedicated Vitest configuration collects both files explicitly.
  'tests/kubernetes-release-gate.test.ts',
  'tests/rendered-kubernetes-config.test.ts',
  'tests/local-docker-runtime-contract.test.ts',
  'tests/local-docker-fault-acceptance.test.ts',
  'tests/local-docker-release-gate.test.ts',
  'tests/local-creative-points-seed-runtime.test.ts',
  'packages/persistence/src/canonical-product-backfill.postgres.test.ts',
  'packages/persistence/src/canonical-backfill-run-repository.postgres.test.ts',
  'packages/persistence/src/commercial-point-adjustment-approval-repository.release.postgres.test.ts',
  'packages/persistence/src/migration-106-release.postgres.test.ts',
  'packages/persistence/src/migration-064-release.postgres.test.ts',
  'packages/persistence/src/migration-127-release.postgres.test.ts',
  'packages/persistence/src/migration-146-release.postgres.test.ts',
  'packages/persistence/src/migration-148-release.postgres.test.ts',
  'packages/persistence/src/service-fulfillment-repository.release.postgres.test.ts',
  'packages/persistence/src/private-trial-invites.release.postgres.test.ts',
  'packages/persistence/src/private-trial-payment.release.postgres.test.ts',
  'packages/persistence/src/brand-profile-association.release.postgres.test.ts',
  'packages/persistence/src/password-auth-repository.release.postgres.test.ts',
  'tests/mcp-oauth-commercial-payment.postgres.test.ts',
  'tests/postgres-rls-attack-matrix.postgres.test.ts',
  'packages/persistence/src/migration-164-release.postgres.test.ts',
  'packages/persistence/src/migration-166-release.postgres.test.ts',
  'packages/persistence/src/migration-207-release.postgres.test.ts',
  'packages/persistence/src/migration-208-release.postgres.test.ts',
  'packages/persistence/src/migration-209-release.postgres.test.ts',
  'packages/persistence/src/migration-210-release.postgres.test.ts',
  'packages/persistence/src/migration-212-release.postgres.test.ts',
  'packages/persistence/src/migration-214-release.postgres.test.ts',
  'packages/persistence/src/migration-218-release.postgres.test.ts',
  'packages/persistence/src/workspace-content-setup-repository.release.postgres.test.ts',
  'packages/persistence/src/image-generation-before-provider.release.postgres.test.ts',
  'packages/persistence/src/knowledge-index-cas.release.postgres.test.ts',
  'packages/persistence/src/commercial-refund-repository.release.postgres.test.ts',
  // Seeds a 5,000-ticket workspace to assert that an SLA-state filter stays
  // inside a bounded scan. It needs its own database and its own clock, so it
  // is owned-fixture acceptance rather than a hermetic unit test.
  'packages/persistence/src/support-repository-sla-filter.postgres.test.ts',
  'apps/api/src/content-generation-action-owner.postgres.test.ts',
  'apps/api/src/canonical-backfill-contract.test.ts',
  // These two are `REDIS_URL` gated. They carry no default-suite assertion at
  // all when the variable is absent (`describe.skipIf` reports every test as
  // pending and the run stays green), so they are executed only through
  // `npm run test:redis:isolated`, which requires an owned local Redis and
  // fails the gate on any pending assertion.
  'packages/workers/src/durable-redis-recovery.test.ts',
  'apps/worker/src/redis-queue-transport.test.ts',
] as const

export interface DefaultSuitePendingAllowance {
  /** Repository-relative path of a file the default suite still collects. */
  file: string
  /** Exact number of assertions the default suite reports as pending for it. */
  pending: number
  /** The environment binding the default suite does not provide. */
  binding: string
  /** Where `binding` is provided and the file is therefore executed for real. */
  executedBy: string
}

/** The CI step that supplies the release database bindings. */
export const CI_POSTGRES_ACCEPTANCE_STEP = 'Run PostgreSQL migration acceptance tests without skips'

/**
 * Assertions the default suite reports as `pending` on purpose.
 *
 * These files are collected by the default suite and keep their hermetic
 * assertions, but each one also carries a `const postgresIt = databaseUrl ? it
 * : it.skip` block that needs a real PostgreSQL instance. They are deliberately
 * NOT added to NON_HERMETIC_TEST_FILES: that list feeds the default suite's
 * `exclude`, and Vitest's `exclude` wins over an explicit CLI argument, so a
 * file added here would silently disappear from the CI step that enumerates it
 * ("Run PostgreSQL migration acceptance tests without skips"), which
 * `tests/postgres-ci-denominator.test.ts` requires to name every
 * `*.postgres.test.ts` file on disk. Instead the pending assertions stay
 * visible, and the gate in `scripts/pending-assertion-gate.ts` asserts on the
 * exact count. Every entry names the missing binding and the entrypoint that
 * binds it; `tests/default-suite-pending.test.ts` verifies both still exist.
 *
 * The repository's own CI step states the intent explicitly: "The local safe
 * launcher intentionally runs only its audited disposable subset; CI's
 * dedicated PostgreSQL service is the authoritative full-surface execution
 * environment." `npm run test:postgres:all-local` now creates the same owned
 * fixture locally and binds every variable this manifest names, so "only CI
 * provides the binding" is no longer a reason a file cannot be executed on a
 * developer machine. CI remains the environment that runs it on every push.
 * See docs/runbooks/local-postgres-acceptance.md.
 *
 * Files that should NOT appear here:
 *   - anything in NON_HERMETIC_TEST_FILES (excluded from the default suite),
 *   - any assertion that has no executing entrypoint at all.
 */
export const DEFAULT_SUITE_PENDING_ALLOWANCES: readonly DefaultSuitePendingAllowance[] = [
  // PERSISTENCE_RELEASE_DATABASE_URL
  { file: 'apps/worker/src/creative-point-relay-settlement.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'apps/worker/src/knowledge-generation-worker-fence.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/charged-text-no-delivery.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/first-workspace-provisioning-repository.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/application-rls-allow-scope-mismatch.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/authorization-audit-rls.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/authorization-event-scope-integrity.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/authorization-execution-reservation-rls.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/authorization-grant-scope-integrity.postgres.test.ts', pending: 2, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/authorization-repository.release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/authorization-rls-boundary.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/authorization-rls-probe.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/local-plugin-install-rls.release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/billing-effective-amount.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/billing-repository.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  // Two `postgresIt` blocks: the task brand projection and the durable product
  // page's brand predicate. Both report one pending assertion without the
  // binding, and both run for real in the CI PostgreSQL step.
  { file: 'packages/persistence/src/business-repository.postgres.test.ts', pending: 2, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/commercial-contract-repository.release.postgres.test.ts', pending: 5, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/creative-point-security-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-067-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-068-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-069-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-070-072-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-073-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-074-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-077-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-078-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-079-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-081-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-084.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-085.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-086.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-087.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-088.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-104.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-105-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-109-release.postgres.test.ts', pending: 2, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-118-release.postgres.test.ts', pending: 2, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-119-120-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-126.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-128-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-129-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-130-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-131-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-136-workspace-audit.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-137-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-179-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-203-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-204-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-211-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-219-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-231-release.postgres.test.ts', pending: 3, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-232-release.postgres.test.ts', pending: 5, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/knowledge-generation-claim-boundary.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-250-role-replay.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/creative-point-action-claim.release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/charged-text-dispatch.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/charged-text-no-delivery.release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-integrity-release.postgres.test.ts', pending: 3, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-rls-integrity-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/object-orphan-repository.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/ops-workspace-summary-rls.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/payment-callback-repository.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/platform-authorization-audit.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/product-rls-tenant-boundary.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/resource-id-scope.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/workspace-data-export-repository.release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'tests/commercial-zero-side-effect-release.postgres.test.ts', pending: 1, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'tests/outbox-retry.postgres.test.ts', pending: 3, binding: 'PERSISTENCE_RELEASE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  // PLATFORM_MEDIA_SPEC_DATABASE_URL
  { file: 'packages/persistence/src/campaign-lifecycle.postgres.test.ts', pending: 1, binding: 'PLATFORM_MEDIA_SPEC_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/mapping-preflight-approval-repository.test.ts', pending: 1, binding: 'PLATFORM_MEDIA_SPEC_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/platform-media-spec-repository.test.ts', pending: 1, binding: 'PLATFORM_MEDIA_SPEC_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  // LEGACY_BACKFILL_DATABASE_URL
  { file: 'packages/persistence/src/migration-049.test.ts', pending: 1, binding: 'LEGACY_BACKFILL_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  { file: 'packages/persistence/src/migration-053.test.ts', pending: 1, binding: 'LEGACY_BACKFILL_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  // WORKSPACE_CATALOG_DATABASE_URL
  { file: 'packages/persistence/src/migration-051.test.ts', pending: 1, binding: 'WORKSPACE_CATALOG_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  // BRAND_CANONICAL_DATABASE_URL
  { file: 'packages/persistence/src/migration-063.test.ts', pending: 1, binding: 'BRAND_CANONICAL_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  // ASSET_PARSE_DATABASE_URL
  { file: 'packages/persistence/src/asset-parse-repository.test.ts', pending: 1, binding: 'ASSET_PARSE_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  // MODEL_BUDGET_DATABASE_URL
  { file: 'packages/persistence/src/model-daily-budget.postgres.test.ts', pending: 5, binding: 'MODEL_BUDGET_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
  // STORAGE_QUOTA_DATABASE_URL
  { file: 'packages/persistence/src/storage-quota-repository.postgres.test.ts', pending: 1, binding: 'STORAGE_QUOTA_DATABASE_URL', executedBy: CI_POSTGRES_ACCEPTANCE_STEP },
]
