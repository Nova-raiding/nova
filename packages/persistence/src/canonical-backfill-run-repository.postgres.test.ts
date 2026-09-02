import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  CanonicalBackfillRunRevisionConflictError,
  PostgresCanonicalBackfillRunRepository,
} from './canonical-backfill-run-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'
const postgresIt = databaseUrlValue ? it : it.skip

const databaseConnection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('canonical backfill run repository PostgreSQL scope and CAS', () => {
  postgresIt('keeps runs workspace-scoped and makes stale updates non-repeatable', async () => {
    const base = new URL(databaseUrlValue)
    const databaseName = `probe_backfill_run_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseConnection(base, databaseName) })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query(`
        INSERT INTO workspaces (id, status)
        VALUES ('backfill_scope_alpha', 'active'), ('backfill_scope_beta', 'active')
      `)

      app = new Pool({
        connectionString: databaseConnection(base, databaseName, 'merchant_app', 'merchant_app_local_only'),
        max: 2,
      })
      const repository = new PostgresCanonicalBackfillRunRepository(app)
      const run = await repository.create({
        workspaceId: 'backfill_scope_alpha',
        dryRun: false,
        batchLimit: 50,
        createdBy: 'ops-alpha',
        reason: 'scope and CAS regression',
      })

      await expect(repository.get({ workspaceId: 'backfill_scope_beta', id: run.id })).resolves.toBeUndefined()
      await expect(repository.update({
        workspaceId: 'backfill_scope_beta',
        id: run.id,
        expectedRevision: run.revision,
        status: 'running',
      })).rejects.toThrow('CANONICAL_BACKFILL_RUN_NOT_FOUND')

      const started = await repository.update({
        workspaceId: 'backfill_scope_alpha',
        id: run.id,
        expectedRevision: run.revision,
        status: 'running',
      })
      expect(started.revision).toBe(run.revision + 1)

      await expect(repository.update({
        workspaceId: 'backfill_scope_alpha',
        id: run.id,
        expectedRevision: run.revision,
        status: 'paused',
      })).rejects.toBeInstanceOf(CanonicalBackfillRunRevisionConflictError)

      const paused = await repository.update({
        workspaceId: 'backfill_scope_alpha',
        id: run.id,
        expectedRevision: started.revision,
        status: 'paused',
        cursorProductId: 'canonical_product_50',
      })
      expect(paused).toMatchObject({ status: 'paused', revision: started.revision + 1, cursorProductId: 'canonical_product_50' })

      const resumed = await repository.update({
        workspaceId: 'backfill_scope_alpha',
        id: run.id,
        expectedRevision: paused.revision,
        status: 'running',
      })

      const completed = await repository.update({
        workspaceId: 'backfill_scope_alpha',
        id: run.id,
        expectedRevision: resumed.revision,
        status: 'completed',
        lastResult: { inserted: 50 },
      })
      expect(completed).toMatchObject({ status: 'completed', revision: resumed.revision + 1, lastResult: { inserted: 50 } })
      expect(completed.cursorProductId).toBeUndefined()
      await expect(repository.get({ workspaceId: 'backfill_scope_alpha', id: run.id })).resolves.toEqual(completed)
    } finally {
      await app?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
