// Isolated PG17 restore probe. This entrypoint never runs the worker poll loop.
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { createClient } from 'redis'

const HEX = /^[a-f0-9]{64}$/u
const WORKSPACE = /^[A-Za-z0-9._:-]{1,128}$/u

export type RestoreSmokeInput = {
  expectedMigrationVersion: number
  expectedMigrationChainSha256: string
  workspaceId: string
}

type ReadClient = { query(sql: string, values?: readonly unknown[]): Promise<{ rows: readonly Record<string, unknown>[] }> }
type RedisProbe = { ping(): Promise<string> }

export async function probeIsolatedRestoreWorker(database: ReadClient, redis: RedisProbe, input: RestoreSmokeInput): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(input.expectedMigrationVersion) || input.expectedMigrationVersion < 242 || !HEX.test(input.expectedMigrationChainSha256) || !WORKSPACE.test(input.workspaceId)) throw new Error('invalid isolated restore probe binding')
  await database.query('BEGIN TRANSACTION READ ONLY')
  try {
    const role = await database.query("SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")
    if (role.rows.length !== 1 || role.rows[0]?.name !== 'restore_app' || role.rows[0]?.rolsuper !== false || role.rows[0]?.rolbypassrls !== false) throw new Error('restore database role is not isolated and RLS-bound')
    const migrations = await database.query('SELECT version, name, checksum FROM public.schema_migrations ORDER BY version')
    const rows = migrations.rows.map((row, index) => {
      const checksum = row.checksum == null ? '' : row.checksum
      if (row.version !== index + 1 || typeof row.name !== 'string' || typeof checksum !== 'string' || (checksum !== '' && !HEX.test(checksum))) throw new Error('restore migration chain row invalid')
      return `${row.version}|${row.name}|${checksum}`
    })
    if (rows.length !== input.expectedMigrationVersion || createHash('sha256').update(rows.join('\n')).digest('hex') !== input.expectedMigrationChainSha256) throw new Error('restore migration chain does not match capture')
    await database.query("SELECT set_config('app.workspace_id', $1, true)", [input.workspaceId])
    const workspace = await database.query('SELECT id, status FROM public.workspaces WHERE id = $1', [input.workspaceId])
    if (workspace.rows.length !== 1 || workspace.rows[0]?.id !== input.workspaceId || workspace.rows[0]?.status !== 'active') throw new Error('restore workspace is not readable and active')
    if (await redis.ping() !== 'PONG') throw new Error('isolated Redis PING failed')
    await database.query('COMMIT')
    return {
      schema_version: 'pg17-worker-restore-smoke/1', status: 'pass', simulated: false,
      migration_target_version: input.expectedMigrationVersion,
      migration_chain_sha256: input.expectedMigrationChainSha256,
      workspace_id_sha256: createHash('sha256').update(input.workspaceId).digest('hex'),
      database_role: 'restore_app', redis_ping: 'PONG', observed_at: new Date().toISOString(),
    }
  } catch (error) {
    await database.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'production' || process.env.RESTORE_SMOKE_MODE !== 'isolated_read_only') throw new Error('isolated read-only restore smoke mode required')
  const databaseUrl = process.env.DATABASE_URL
  const redisUrl = process.env.REDIS_URL
  if (!databaseUrl || !redisUrl) throw new Error('isolated database and Redis URLs required')
  const pg = new URL(databaseUrl)
  const redisTarget = new URL(redisUrl)
  if (!['postgres:', 'postgresql:'].includes(pg.protocol) || pg.username !== 'restore_app' || redisTarget.protocol !== 'redis:' || redisTarget.username !== 'restore') throw new Error('isolated restore credentials required')
  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000, query_timeout: 10_000, statement_timeout: 10_000 })
  const redis = createClient({ url: redisUrl, socket: { reconnectStrategy: false, connectTimeout: 5_000 } })
  try {
    const client = await pool.connect()
    try {
      await redis.connect()
      const result = await probeIsolatedRestoreWorker(client, redis, {
        expectedMigrationVersion: Number(process.env.RESTORE_SMOKE_EXPECTED_MIGRATION_VERSION),
        expectedMigrationChainSha256: process.env.RESTORE_SMOKE_MIGRATION_CHAIN_SHA256 ?? '',
        workspaceId: process.env.RESTORE_SMOKE_WORKSPACE_ID ?? '',
      })
      process.stdout.write(`${JSON.stringify(result)}\n`)
    } finally { client.release() }
  } finally {
    redis.destroy()
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`isolated worker restore smoke rejected: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
}
