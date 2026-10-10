import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresReconciliationStatusRepository } from './reconciliation-status-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

async function waitForDelayedStatusInsert(database: Pool, applicationName: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await database.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_catalog.pg_stat_activity
         WHERE application_name=$1 AND wait_event='PgSleep'
           AND query ILIKE '%INSERT INTO workspace_reconciliation_status%'
       ) AS active`,
      [applicationName],
    )
    if (result.rows[0]?.active) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for controlled reconciliation status insert')
}

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
      const applicationName = `reconciliation_status_${randomUUID().replaceAll('-', '')}`
      appUrl.searchParams.set('application_name', applicationName)
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

      // Force the first INSERT to pause after its SELECT observed no row. This
      // makes the otherwise rare absent-row race deterministic across app
      // connections without changing repository behavior.
      await database.query(`
        CREATE FUNCTION public.test_delay_reconciliation_status_insert() RETURNS trigger
        LANGUAGE plpgsql AS $test_delay$
        BEGIN
          IF NEW.details->>'race_delay' = 'slow' THEN PERFORM pg_catalog.pg_sleep(0.75); END IF;
          RETURN NEW;
        END;
        $test_delay$;
        CREATE TRIGGER test_delay_reconciliation_status_insert
        BEFORE INSERT ON public.workspace_reconciliation_status
        FOR EACH ROW EXECUTE FUNCTION public.test_delay_reconciliation_status_insert();
      `)

      const conflictingSlowWrite = repository.upsert({
        workspaceId: 'ws_081_a', resourceType: 'race', resourceId: 'same-idempotency',
        status: 'failed', idempotencyKey: 'same-race-key', details: { marker: 'slow', race_delay: 'slow' },
        observedAt: '2026-08-29T00:00:00.000Z',
      })
      await waitForDelayedStatusInsert(database, applicationName)
      const conflictingFastWrite = repository.upsert({
        workspaceId: 'ws_081_a', resourceType: 'race', resourceId: 'same-idempotency',
        status: 'succeeded', idempotencyKey: 'same-race-key', details: { marker: 'fast' },
        observedAt: '2026-08-29T00:00:00.000Z',
      })
      const conflictingResults = await Promise.allSettled([conflictingSlowWrite, conflictingFastWrite])
      expect(conflictingResults.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(conflictingResults.find(result => result.status === 'rejected')).toMatchObject({
        status: 'rejected', reason: expect.objectContaining({ name: 'ReconciliationIdempotencyConflictError' }),
      })

      const olderWrite = repository.upsert({
        workspaceId: 'ws_081_a', resourceType: 'race', resourceId: 'stale-first-insert',
        status: 'failed', idempotencyKey: 'older-observation', details: { marker: 'older', race_delay: 'slow' },
        observedAt: '2026-08-29T00:00:00.000Z',
      })
      await waitForDelayedStatusInsert(database, applicationName)
      const newerWrite = repository.upsert({
        workspaceId: 'ws_081_a', resourceType: 'race', resourceId: 'stale-first-insert',
        status: 'succeeded', idempotencyKey: 'newer-observation', details: { marker: 'newer' },
        observedAt: '2026-08-29T00:00:01.000Z',
      })
      await Promise.all([olderWrite, newerWrite])
      await expect(repository.getLatest({ workspaceId: 'ws_081_a', resourceType: 'race', resourceId: 'stale-first-insert' }))
        .resolves.toMatchObject({ status: 'succeeded', lastIdempotencyKey: 'newer-observation', details: { marker: 'newer' }, revision: 2 })
    } finally {
      await app?.end()
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
