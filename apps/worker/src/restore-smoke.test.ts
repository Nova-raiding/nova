import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { probeIsolatedRestoreWorker } from './restore-smoke.js'

const workspaceId = 'ws_restore_probe'
const rows = Array.from({ length: 254 }, (_, index) => ({ version: index + 1, name: `migration_${index + 1}`, checksum: 'a'.repeat(64) }))
const chain = createHash('sha256').update(rows.map(row => `${row.version}|${row.name}|${row.checksum}`).join('\n')).digest('hex')
const input = { expectedMigrationVersion: 254, expectedMigrationChainSha256: chain, workspaceId }

function fixture(change: { role?: readonly Record<string, unknown>[]; migrations?: readonly Record<string, unknown>[]; workspaces?: readonly Record<string, unknown>[]; pong?: string } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const database = { query: async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('FROM pg_roles')) return { rows: change.role ?? [{ name: 'restore_app', rolsuper: false, rolbypassrls: false }] }
    if (sql.includes('schema_migrations')) return { rows: change.migrations ?? rows }
    if (sql.includes('FROM public.workspaces')) return { rows: change.workspaces ?? [{ id: workspaceId, status: 'active' }] }
    return { rows: [] }
  } }
  const redis = { ping: async () => change.pong ?? 'PONG' }
  return { database, redis, calls }
}

describe('isolated worker restore smoke', () => {
  it('uses only a read-only transaction, migration/workspace SELECTs, Redis PING and no dispatch path', async () => {
    const { database, redis, calls } = fixture()
    const result = await probeIsolatedRestoreWorker(database, redis, input)
    expect(result).toMatchObject({ status: 'pass', simulated: false, database_role: 'restore_app', redis_ping: 'PONG', migration_target_version: 254, migration_chain_sha256: chain })
    expect(calls.map(call => call.sql)).toEqual([
      'BEGIN TRANSACTION READ ONLY',
      'SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      'SELECT version, name, checksum FROM public.schema_migrations ORDER BY version',
      "SELECT set_config('app.workspace_id', $1, true)",
      'SELECT id, status FROM public.workspaces WHERE id = $1',
      'COMMIT',
    ])
    expect(calls.at(-2)?.values).toEqual([workspaceId])
  })

  it('fails closed for privileged role, wrong chain, missing workspace and Redis failure', async () => {
    for (const [change, message] of [
      [{ role: [{ name: 'restore_app', rolsuper: true, rolbypassrls: false }] }, /RLS-bound/u],
      [{ migrations: rows.slice(1) }, /chain row invalid/u],
      [{ workspaces: [] }, /workspace is not readable/u],
      [{ pong: 'NO' }, /Redis PING failed/u],
    ] as const) {
      const { database, redis, calls } = fixture(change)
      await expect(probeIsolatedRestoreWorker(database, redis, input)).rejects.toThrow(message)
      expect(calls.at(-1)?.sql).toBe('ROLLBACK')
      expect(calls.map(call => call.sql)).not.toContain('COMMIT')
    }
  })

  it('rejects a wrong expected digest before connecting', async () => {
    const { database, redis, calls } = fixture()
    await expect(probeIsolatedRestoreWorker(database, redis, { ...input, expectedMigrationChainSha256: '' })).rejects.toThrow(/binding/u)
    expect(calls).toEqual([])
  })
})
