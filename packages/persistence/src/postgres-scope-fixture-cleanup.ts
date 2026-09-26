import { setTimeout as wait } from 'node:timers/promises'

interface FixturePool { end(): Promise<void> }
type DrainQuery = { text: string; values: string[]; query_timeout: number }
interface FixtureAdmin extends FixturePool {
  query(sql: string | DrainQuery, values?: string[]): Promise<{ rows: { connections?: number }[] }>
}
interface DrainClock { now(): number; wait(milliseconds: number): Promise<unknown> }

/** Exact prefixes inventoried from independently created PostgreSQL test databases. */
export const POSTGRES_SCOPE_FIXTURE_PREFIXES = [
  'brand_profile_assoc_',
  'release_claim_fence_',
  'business_repository_',
  'campaign_lifecycle_',
  'catalog_146_',
  'commercial_catalog_166_',
  'creative_points_148_',
  'oauth_commercial_',
  'onboarding_schedule_164_',
  'point_adjust_159_',
  'private_trial_payment_',
  'probe_app_rls_scope_',
  'probe_authz_audit_',
  'probe_authz_event_scope_',
  'probe_authz_reservation_acl_',
  'probe_authz_rls_',
  'probe_backfill_run_',
  'probe_canonical_backfill_',
  'probe_delivery_evidence_',
  'probe_delivery_receipt_identity_',
  'probe_ops_summary_',
  'probe_platform_audit_',
  'probe_product_rls_',
  'probe_resource_scope_',
  'probe_workspace_audit_',
  'release_069_fresh_',
  'release_069_restore_',
  'release_069_upgrade_',
  'release_070_072_fresh_',
  'release_070_072_upgrade_',
  'release_073_fresh_',
  'release_073_upgrade_',
  'release_074_fresh_',
  'release_074_upgrade_',
  'release_077_',
  'release_078_fresh_',
  'release_078_upgrade_',
  'release_079_',
  'release_105_',
  'release_109_',
  'release_118_bad_',
  'release_118_valid_',
  'release_119_120_',
  'release_127_',
  'release_128_',
  'release_129_',
  'release_130_',
  'release_131_',
  'release_137_',
  'release_179_',
  'release_203_',
  'release_208_',
  'release_209_',
  'release_210_',
  'release_211_',
  'release_231_',
  'release_232_',
  'release_canonical_brand_',
  'release_fresh_',
  'release_migration_integrity_',
  'release_password_auth_',
  'release_plugin_rls_',
  'release_payment_callback_',
  'release_restore_',
  'release_upgrade_',
  'service_154_',
  'support_sla_scan_',
  'workspace_bootstrap_',
] as const

function assertFixtureName(databaseName: string) {
  if (!POSTGRES_SCOPE_FIXTURE_PREFIXES.some(prefix => databaseName.startsWith(prefix)
    && /^[a-f0-9]{32}$/u.test(databaseName.slice(prefix.length)))) {
    throw new Error('POSTGRES_SCOPE_FIXTURE_NAME_INVALID')
  }
}

/** Does not close admin: multi-database fixtures retain their original cleanup order. */
export async function dropDrainedPostgresFixture(
  admin: FixtureAdmin,
  databaseName: string,
  clock: DrainClock = { now: Date.now, wait },
): Promise<void> {
  assertFixtureName(databaseName)
  // pool.end() can resolve before TCP end. Never kill those closing backends.
  // Every catalog probe is autocommit and has its own bounded query timeout.
  const deadline = clock.now() + 5_000
  while (true) {
    const result = await admin.query({
      text: 'SELECT count(*)::integer AS connections FROM pg_stat_activity WHERE datname=$1',
      values: [databaseName], query_timeout: 1_000,
    })
    const connections = result.rows[0]?.connections
    if (typeof connections !== 'number' || !Number.isInteger(connections) || connections < 0) {
      throw new Error('POSTGRES_SCOPE_FIXTURE_DRAIN_INVALID')
    }
    if (connections === 0) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      return
    }
    const remaining = deadline - clock.now()
    if (remaining <= 0) throw new Error('POSTGRES_SCOPE_FIXTURE_DRAIN_TIMEOUT')
    await clock.wait(Math.min(25, remaining))
  }
}

/** Attempts each finalizer even after failure; preserves every error without listeners. */
export async function withPostgresFixtureCleanup(
  cleanup: () => Promise<unknown>,
  primaryFailure?: unknown,
  finalizers: readonly (() => Promise<unknown>)[] = [],
): Promise<void> {
  const failures: unknown[] = []
  try { await cleanup() } catch (error) { failures.push(error) }
  for (const finalize of finalizers) {
    try { await finalize() } catch (error) { failures.push(error) }
  }
  if (failures.length === 0) return
  if (primaryFailure !== undefined) {
    throw new AggregateError([primaryFailure, ...failures], 'Acceptance assertion and fixture cleanup failed', { cause: primaryFailure })
  }
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, 'Fixture cleanup and finalizers failed', { cause: failures[0] })
}

/** Backwards-compatible cleanup for the original two tenant-scope probes. */
export async function disposePostgresScopeFixture(
  admin: FixtureAdmin,
  databaseName: string,
  pools: readonly (FixturePool | undefined)[],
  clock: DrainClock = { now: Date.now, wait },
  primaryFailure?: unknown,
): Promise<void> {
  assertFixtureName(databaseName)
  await withPostgresFixtureCleanup(async () => {
    await Promise.all(pools.map(pool => pool?.end()))
    await dropDrainedPostgresFixture(admin, databaseName, clock)
  }, primaryFailure, [() => admin.end()])
}
