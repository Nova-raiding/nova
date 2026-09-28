import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner, verifyAppliedMigrations } from '../packages/persistence/src/migration.js'
import { assertBridgeStartupMigrationVersion, assertWorkerReadinessDependencies } from '../apps/worker/src/main.js'
import { createIsolatedOpsFixture } from './isolated-ops-fixture.js'

async function runWorkerOnce(input: { databaseUrl: string; redisUrl: string; workspaceId: string; evidenceDir: string; expectedVersion: number | null }): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8',
    NODE_ENV: 'development', DATABASE_URL: input.databaseUrl, REDIS_URL: input.redisUrl,
    WORKER_ROLE: 'sync', WORKER_WORKSPACES: input.workspaceId, WORKER_ONCE: 'true',
    WORKER_METRICS_PORT: '0', WORKER_READY_FILE: resolve(input.evidenceDir, `worker-${input.expectedVersion ?? 'partial'}.ready`),
    BRIDGE_SCHEMA_COMPATIBILITY_MODE: 'prefix_254_or_255',
  }
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/main.ts'], {
    cwd: resolve('.'), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-8_000)
  }
  child.stdout.on('data', append)
  child.stderr.on('data', append)
  const exit = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`isolated worker timed out at ${input.expectedVersion}`))
    }, 30_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolveExit(code) })
  })
  const diagnostics = output.replaceAll(input.databaseUrl, '[database]').replaceAll(input.redisUrl, '[redis]')
  if (input.expectedVersion === null) {
    expect(exit, `worker unexpectedly accepted an incomplete migration prefix: ${diagnostics}`).not.toBe(0)
    expect(diagnostics).toContain('exactly 254 or 255')
    return
  }
  expect(exit, `worker failed at ${input.expectedVersion}: ${diagnostics}`).toBe(0)
  expect(diagnostics).toContain('"message":"worker poll completed"')
  const readiness = JSON.parse(await readFile(env.WORKER_READY_FILE!, 'utf8')) as Record<string, unknown>
  expect(readiness).toMatchObject({ role: 'sync', workspaces: 1 })
}

describe('254/255 worker bridge on an owned PostgreSQL 17 fixture', () => {
  it('checks both prefixes through the production app role and requires a worker restart after migration', async () => {
    const evidenceDir = resolve('artifacts/bridge-254-255-worker-isolation', randomUUID())
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
    const fixture = await createIsolatedOpsFixture({ evidenceDir })
    const databaseUrl = fixture.acceptanceDatabaseUrls?.legacyBackfill
    if (!databaseUrl) throw new Error('isolated empty PostgreSQL database unavailable')

    const databaseName = new URL(databaseUrl).pathname.slice(1)
    const appUrl = new URL(fixture.databaseUrl)
    appUrl.pathname = `/${databaseName}`
    const admin = new Pool({ connectionString: databaseUrl })
    const app = new Pool({ connectionString: appUrl.toString() })
    try {
      const migrations = await loadMigrations()
      expect(migrations.at(-1)?.version).toBe(255)
      const roleSql = await readFile(new URL('../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
      const databaseGrant = /ON DATABASE merchant\b/gu
      expect([...roleSql.matchAll(databaseGrant)]).toHaveLength(3)
      const isolatedRoleSql = roleSql.replace(databaseGrant, `ON DATABASE "${databaseName}"`)

      await admin.query(isolatedRoleSql)
      await new MigrationRunner(admin, migrations.slice(0, 253)).run()
      await runWorkerOnce({ databaseUrl: appUrl.toString(), redisUrl: fixture.redisUrl,
        workspaceId: fixture.workspaceId, evidenceDir, expectedVersion: null })
      await new MigrationRunner(admin, migrations.slice(0, 254)).run()
      await admin.query(isolatedRoleSql)

      const bridgeMigrations = migrations
      const ready254 = await assertWorkerReadinessDependencies({
        database: app,
        expectedMigrations: migrations,
        bridgeMigrations,
        bridgeMode: 'prefix_254_or_255',
      })
      expect(ready254).toEqual({ migrationVersion: 254, apiReady: false })
      expect(() => assertBridgeStartupMigrationVersion(ready254.migrationVersion, 254)).not.toThrow()
      await runWorkerOnce({ databaseUrl: appUrl.toString(), redisUrl: fixture.redisUrl,
        workspaceId: fixture.workspaceId, evidenceDir, expectedVersion: 254 })

      expect(await new MigrationRunner(admin, migrations).run()).toEqual([255])
      await admin.query(isolatedRoleSql)
      const history = (await admin.query<{ version: number; name: string; checksum: string }>(
        'SELECT version,name,checksum FROM schema_migrations ORDER BY version',
      )).rows
      expect(history).toHaveLength(255)
      expect(() => verifyAppliedMigrations(history, migrations)).not.toThrow()

      const ready255 = await assertWorkerReadinessDependencies({
        database: app,
        expectedMigrations: migrations,
        bridgeMigrations,
        bridgeMode: 'prefix_254_or_255',
      })
      expect(ready255).toEqual({ migrationVersion: 255, apiReady: false })
      expect(() => assertBridgeStartupMigrationVersion(ready254.migrationVersion, ready255.migrationVersion))
        .toThrow('bridge database migration prefix changed; restart the worker before processing tasks')
      expect(() => assertBridgeStartupMigrationVersion(ready255.migrationVersion, ready255.migrationVersion)).not.toThrow()
      await runWorkerOnce({ databaseUrl: appUrl.toString(), redisUrl: fixture.redisUrl,
        workspaceId: fixture.workspaceId, evidenceDir, expectedVersion: 255 })
    } finally {
      await app.end()
      await admin.end()
      await fixture.dispose()
    }
  }, 120_000)
})
