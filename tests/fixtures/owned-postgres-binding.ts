/**
 * The destructive RLS matrix may only run against the DB identity injected by
 * run-isolated-postgres-tests.ts after it validates owned container evidence.
 */
export function assertOwnedPostgresTestBinding(databaseUrlValue: string | undefined, runId: string | undefined): URL {
  if (!databaseUrlValue || !runId || !/^[a-f0-9-]{36}$/u.test(runId)) {
    throw new Error('ISOLATED_POSTGRES_FIXTURE_BINDING_REQUIRED')
  }
  let database: URL
  try { database = new URL(databaseUrlValue) } catch { throw new Error('ISOLATED_POSTGRES_FIXTURE_BINDING_REQUIRED') }
  if (!/^postgres(?:ql)?:$/u.test(database.protocol)
    || database.hostname !== '127.0.0.1'
    || database.username !== 'merchant'
    || !database.password
    || database.pathname !== '/merchant'
    || !/^\d+$/u.test(database.port)
    || Number(database.port) < 1
    || Number(database.port) > 65535
    || database.search
    || database.hash) {
    throw new Error('ISOLATED_POSTGRES_FIXTURE_BINDING_REQUIRED')
  }
  return database
}
