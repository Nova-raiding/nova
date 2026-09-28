import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner, verifyAppliedMigrations } from '../packages/persistence/src/migration.js'
import { createIsolatedOpsFixture } from './isolated-ops-fixture.js'

const token = 'isolated-254-255-bridge-token'
const workspaceId = 'ws_bridge_254_255'
const apiDiagnostics = new WeakMap<ChildProcess, () => string>()

async function freeLoopbackPort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((done, reject) => listener.once('error', reject).listen(0, '127.0.0.1', done))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('isolated API port unavailable')
  await new Promise<void>(done => listener.close(() => done()))
  return address.port
}

async function startApi(input: { databaseUrl: string; redisUrl: string; port: number }): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8',
    NODE_ENV: 'development', AUTH_ENFORCEMENT: 'strict', PERSISTENCE_MODE: 'postgres',
    DATABASE_URL: input.databaseUrl, REDIS_URL: input.redisUrl,
    RUN_MIGRATIONS_ON_STARTUP: 'false', BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_254_or_255',
    SESSION_ID_HASH_SECRET: 'isolated-254-255-api-bridge-secret',
    API_BIND_HOST: '127.0.0.1', PORT: String(input.port),
    CONNECTOR_FIXTURE_MODE: 'false',
    API_AUTH_TOKENS: JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: 'bridge-actor', roles: ['merchant_admin'], workbenches: ['workspace'] } }),
  }
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/server.ts'], {
    cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Drain both streams so the child never blocks on a full pipe. Keep only
  // bounded diagnostics and never print generated database or Redis URLs.
  let diagnostics = ''
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
    diagnostics = `${diagnostics}${String(chunk)}`.slice(-4000)
  })
  apiDiagnostics.set(child, () => diagnostics.replaceAll(input.databaseUrl, '[database]').replaceAll(input.redisUrl, '[redis]'))
  const url = `http://127.0.0.1:${input.port}/readyz`
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`isolated API exited before readiness: ${diagnostics.replaceAll(input.databaseUrl, '[database]').replaceAll(input.redisUrl, '[redis]')}`)
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return child } catch { /* starting */ }
    await new Promise(done => setTimeout(done, 250))
  }
  child.kill('SIGTERM')
  throw new Error(`isolated API readiness timed out: ${diagnostics.replaceAll(input.databaseUrl, '[database]').replaceAll(input.redisUrl, '[redis]')}`)
}

async function stopApi(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(done => child.once('exit', () => done())),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('isolated API did not drain after SIGTERM')), 10_000)),
  ])
}

describe('254/255 API bridge on an owned PostgreSQL 17 fixture', () => {
  it('keeps the new route closed at 254 and serves it after a checked 255 migration', async () => {
    const evidenceDir = resolve('artifacts/bridge-254-255-isolation', randomUUID())
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
    const fixture = await createIsolatedOpsFixture({ evidenceDir })
    const databaseUrl = fixture.acceptanceDatabaseUrls?.legacyBackfill
    if (!databaseUrl) throw new Error('isolated empty PostgreSQL database unavailable')
    const admin = new Pool({ connectionString: databaseUrl })
    const appUrl = new URL(fixture.databaseUrl)
    appUrl.pathname = new URL(databaseUrl).pathname
    const app = new Pool({ connectionString: appUrl.toString() })
    let child: ChildProcess | undefined
    try {
      const migrations = await loadMigrations()
      expect(migrations.at(-1)?.version).toBe(255)
      await new MigrationRunner(admin, migrations.slice(0, 254)).run()
      await admin.query('GRANT SELECT ON schema_migrations TO merchant_app, merchant_ops')
      await admin.query('INSERT INTO workspaces(id,status) VALUES ($1,$2)', [workspaceId, 'active'])
      await admin.query("INSERT INTO workspace_members(id,workspace_id,external_subject,display_name,role,status,invited_by) VALUES ($1,$2,'bridge-actor','Bridge Actor','merchant_admin','active','isolated-bridge-fixture')", [randomUUID(), workspaceId])
      const port254 = await freeLoopbackPort()
      // The empty intermediate database has migration DDL but not the fixture's
      // separate runtime-grant normalization. Use its owned admin connection
      // for this process-level routing probe; exercise merchant_app RLS below.
      child = await startApi({ databaseUrl, redisUrl: fixture.redisUrl, port: port254 })
      const getBrand = (port: number) => fetch(`http://127.0.0.1:${port}/v1/brand-scopes`, {
        headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId },
      })
      const closed = await getBrand(port254)
      const closedBody = await closed.json()
      expect(closed.status, `${JSON.stringify(closedBody)} ${apiDiagnostics.get(child)?.() ?? ''}`).toBe(503)
      expect(JSON.stringify(closedBody)).toContain('BRAND_SCOPES_NOT_CONFIGURED')
      const absent = await admin.query<{ exists: string | null }>("SELECT to_regclass('merchant_brand_scoped_settings')::text AS exists")
      expect(absent.rows[0]?.exists).toBeNull()
      await stopApi(child); child = undefined

      expect(await new MigrationRunner(admin, migrations).run()).toEqual([255])
      const history = (await admin.query<{ version: number; name: string; checksum: string }>('SELECT version,name,checksum FROM schema_migrations ORDER BY version')).rows
      expect(history).toHaveLength(255)
      expect(() => verifyAppliedMigrations(history, migrations)).not.toThrow()
      const port255 = await freeLoopbackPort()
      child = await startApi({ databaseUrl, redisUrl: fixture.redisUrl, port: port255 })
      const opened = await getBrand(port255)
      expect(opened.status).toBe(200)
      expect(JSON.stringify(await opened.json())).toContain(workspaceId)

      await admin.query("INSERT INTO workspaces(id,status) VALUES ('ws_bridge_other','active')")
      await admin.query("INSERT INTO merchant_brand_scoped_settings(workspace_id,settings,updated_by_actor_id) VALUES ($1,'{\"schemaVersion\":1}'::jsonb,'fixture')", [workspaceId])
      const client = await app.connect()
      try {
        await client.query('BEGIN READ ONLY')
        await client.query("SELECT set_config('app.workspace_id','ws_bridge_other',true)")
        expect((await client.query('SELECT workspace_id FROM merchant_brand_scoped_settings')).rows).toEqual([])
        await client.query('COMMIT')
      } finally { await client.query('ROLLBACK'); client.release() }
    } finally {
      await stopApi(child)
      await app.end()
      await admin.end()
      const disposed = await fixture.dispose()
      if (disposed.leftRunning.length) throw new Error('isolated PostgreSQL fixture cleanup requires inspection')
    }
  }, 300_000)
})
