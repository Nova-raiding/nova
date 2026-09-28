import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner, verifyAppliedMigrations } from '../packages/persistence/src/migration.js'
import { assertBridgeStartupMigrationVersion, assertWorkerReadinessDependencies } from '../apps/worker/src/main.js'
import { createIsolatedOpsFixture } from './isolated-ops-fixture.js'

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
    } finally {
      await app.end()
      await admin.end()
      await fixture.dispose()
    }
  }, 120_000)
})
