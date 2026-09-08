// These files are real-runtime acceptance, not hermetic unit/API fixtures.
// Keep them reachable through explicit integration entrypoints, never through
// the default suite. This list remains explicit even if an individual test
// later removes its historical localhost fallback.
export const NON_HERMETIC_TEST_FILES = [
  'tests/local-docker-runtime-contract.test.ts',
  'tests/local-docker-fault-acceptance.test.ts',
  'tests/local-docker-release-gate.test.ts',
  'tests/local-creative-points-seed-runtime.test.ts',
  'packages/persistence/src/canonical-product-backfill.postgres.test.ts',
  'packages/persistence/src/canonical-backfill-run-repository.postgres.test.ts',
  'packages/persistence/src/commercial-point-adjustment-approval-repository.release.postgres.test.ts',
  'packages/persistence/src/migration-106-release.postgres.test.ts',
  'packages/persistence/src/migration-127-release.postgres.test.ts',
  'packages/persistence/src/migration-146-release.postgres.test.ts',
  'packages/persistence/src/migration-148-release.postgres.test.ts',
  'packages/persistence/src/service-fulfillment-repository.release.postgres.test.ts',
  'packages/persistence/src/migration-164-release.postgres.test.ts',
  'packages/persistence/src/migration-166-release.postgres.test.ts',
  'apps/api/src/canonical-backfill-contract.test.ts',
] as const
