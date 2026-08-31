import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresReconciliationStatusRepository } from './reconciliation-status-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('persistence migration 081 reconciliation status acceptance', () => {
  postgresIt('uses merchant_app for workspace-scoped idempotent latest status reads and writes', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_081_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      const role = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(`SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='merchant_app'`)
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolcanlogin: true }])
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      const migrations = (await loadMigrations()).filter(item => item.version <= 81)
      expect(migrations.at(-1)?.version).toBe(81)
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_081_a','active'),('ws_081_b','active')`)
      const appUrl = new URL(isolated)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString() })
      const repository = new PostgresReconciliationStatusRepository(app)
      const first = await repository.upsert({ workspaceId: 'ws_081_a', resourceType: 'asset', resourceId: 'asset-1', status: 'running', idempotencyKey: 'check-1', observedAt: '2026-08-29T00:00:00.000Z' })
      const replay = await repository.upsert({ workspaceId: 'ws_081_a', resourceType: 'asset', resourceId: 'asset-1', status: 'running', idempotencyKey: 'check-1', observedAt: '2026-08-29T00:00:00.000Z' })
      expect(replay).toEqual(first)
      const latest = await repository.upsert({ workspaceId: 'ws_081_a', resourceType: 'asset', resourceId: 'asset-1', status: 'succeeded', idempotencyKey: 'check-2', details: { clean: true }, observedAt: '2026-08-29T00:00:01.000Z' })
      expect(latest.revision).toBe(2)
      const stale = await repository.upsert({ workspaceId: 'ws_081_a', resourceType: 'asset', resourceId: 'asset-1', status: 'failed', idempotencyKey: 'check-old', details: { clean: false }, observedAt: '2026-08-29T00:00:00.500Z' })
      expect(stale).toEqual(latest)
      expect((await repository.getLatest({ workspaceId: 'ws_081_a', resourceType: 'asset', resourceId: 'asset-1' }))).toEqual(latest)
      expect(await repository.getLatest({ workspaceId: 'ws_081_a' })).toEqual(latest)
      expect(await repository.getLatest({ workspaceId: 'ws_081_b' })).toBeUndefined()
    } finally {
      await app?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
