import { setTimeout as wait } from 'node:timers/promises'

interface FixturePool { end(): Promise<void> }
interface FixtureAdmin extends FixturePool {
  query(sql: string, values?: string[]): Promise<{ rows: { connections?: number }[] }>
}
interface DrainClock { now(): number; wait(milliseconds: number): Promise<unknown> }

/** Test-only cleanup for the two randomly named tenant-scope databases. */
export async function disposePostgresScopeFixture(
  admin: FixtureAdmin,
  databaseName: string,
  pools: readonly (FixturePool | undefined)[],
  clock: DrainClock = { now: Date.now, wait },
  primaryFailure?: unknown,
): Promise<void> {
  if (!/^probe_(?:product_rls|resource_scope)_[a-f0-9]{32}$/u.test(databaseName)) {
    throw new Error('POSTGRES_SCOPE_FIXTURE_NAME_INVALID')
  }
  let cleanupFailure: unknown
  try {
    await Promise.all(pools.map(pool => pool?.end()))
    // pg-pool may resolve end() before its clients' TCP end callbacks. Do not
    // kill those closing backends: their idle error event would escape the
    // otherwise successful test as 57P01. Wait for actual server-side drain.
    const deadline = clock.now() + 5_000
    while (true) {
      const result = await admin.query('SELECT count(*)::integer AS connections FROM pg_stat_activity WHERE datname=$1', [databaseName])
      const connections = result.rows[0]?.connections
      if (!Number.isInteger(connections) || connections! < 0) throw new Error('POSTGRES_SCOPE_FIXTURE_DRAIN_INVALID')
      if (connections === 0) {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
        break
      }
      const remaining = deadline - clock.now()
      if (remaining <= 0) throw new Error('POSTGRES_SCOPE_FIXTURE_DRAIN_TIMEOUT')
      await clock.wait(Math.min(25, remaining))
    }
  } catch (error) { cleanupFailure = error }
  try { await admin.end() } catch (error) {
    cleanupFailure = cleanupFailure === undefined ? error : new AggregateError([cleanupFailure, error], 'Fixture drain and admin shutdown failed', { cause: cleanupFailure })
  }
  if (cleanupFailure !== undefined) {
    if (primaryFailure !== undefined) throw new AggregateError([primaryFailure, cleanupFailure], 'Acceptance assertion and fixture cleanup failed', { cause: primaryFailure })
    throw cleanupFailure
  }
}
