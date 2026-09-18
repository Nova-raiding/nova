import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.BRAND_CANONICAL_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('persistence migration 203 workspace identity binding membership integrity', () => {
  postgresIt('preserves historical orphans while preventing new orphan bindings and member deletion', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_203_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(base)
      databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })

      const migrations = await loadMigrations()
      await new MigrationRunner(database, migrations.filter(migration => migration.version < 203)).run()
      await database.query(`
        INSERT INTO workspaces (id,status) VALUES ('ws_203_member','active'),('ws_203_orphan','active');
        INSERT INTO workspace_members (id,workspace_id,external_subject,display_name,role,status,invited_by)
        VALUES ('00000000-0000-4000-8000-000000000203','ws_203_member','subject_203','Member 203','workspace_owner','active','test');
        INSERT INTO workspace_identity_bindings (issuer,external_subject,workspace_id,display_name)
        VALUES
          ('issuer_203','subject_203','ws_203_member','Member 203'),
          ('issuer_203','orphan_203','ws_203_orphan','Historical orphan 203');
      `)

      await new MigrationRunner(database, migrations.filter(migration => migration.version === 203)).run()

      await expect(database.query(`SELECT convalidated FROM pg_constraint WHERE conname='workspace_identity_bindings_member_fk'`))
        .resolves.toMatchObject({ rows: [{ convalidated: false }] })
      await expect(database.query(`UPDATE workspace_identity_bindings SET display_name='Auditable orphan 203' WHERE external_subject='orphan_203'`))
        .resolves.toMatchObject({ rowCount: 1 })
      await expect(database.query(`INSERT INTO workspace_identity_bindings (issuer,external_subject,workspace_id,display_name) VALUES ('issuer_new_203','new_orphan_203','ws_203_orphan','New orphan 203')`))
        .rejects.toMatchObject({ code: '23503' })
      await expect(database.query(`DELETE FROM workspace_members WHERE workspace_id='ws_203_member' AND external_subject='subject_203'`))
        .rejects.toMatchObject({ code: '23503' })
      await expect(database.query('ALTER TABLE workspace_identity_bindings VALIDATE CONSTRAINT workspace_identity_bindings_member_fk'))
        .rejects.toMatchObject({ code: '23503' })
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await database?.end()
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [
        () => admin.end(),
      ])
    }
  }, 240_000)
})
