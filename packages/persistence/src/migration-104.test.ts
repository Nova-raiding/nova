import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresInteractiveConfirmationTicketRepository } from './interactive-confirmation-ticket-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('migration 104 interactive confirmation tickets', () => {
  it('registers a tenant-isolated, one-time ticket table with least-privilege runtime ACL', async () => {
    const sql = await readFile(new URL('./migrations/104_interactive_confirmation_tickets.sql', import.meta.url), 'utf8')
    expect(sql).toContain('PRIMARY KEY (nonce_hash)')
    expect(sql).toContain("intent_hash ~ '^[0-9a-f]{64}$'")
    expect(sql).toContain('ALTER TABLE interactive_confirmation_tickets ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain('ALTER TABLE interactive_confirmation_tickets FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('CREATE POLICY interactive_confirmation_tickets_workspace_isolation')
    expect(sql).toContain("current_setting('app.workspace_id', true)")
    expect(sql).toContain('CREATE TRIGGER interactive_confirmation_ticket_one_time_guard')
    expect(sql).toContain('IF OLD.consumed_at IS NOT NULL')
    expect(sql).toContain('IF NEW.consumed_at IS NULL')
    expect(sql).toContain('GRANT SELECT, INSERT ON TABLE interactive_confirmation_tickets TO merchant_app')
    expect(sql).toContain('GRANT UPDATE (consumed_at) ON TABLE interactive_confirmation_tickets TO merchant_app')
    expect(sql).toContain('REVOKE DELETE, TRUNCATE ON TABLE interactive_confirmation_tickets FROM merchant_app')
    expect((await loadMigrations()).find(item => item.version === 104)).toMatchObject({ version: 104, name: 'interactive_confirmation_tickets' })
  })

  postgresIt('enforces RLS, global nonce uniqueness, and exactly-once concurrent consumption', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_104_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_confirm_a','active'),('ws_confirm_b','active')`)

      const appUrl = new URL(isolated)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString(), max: 4 })
      const repository = new PostgresInteractiveConfirmationTicketRepository(app)
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
      const issued = { workspaceId: 'ws_confirm_a', actorId: 'actor-a', sessionId: 'session-a', intentHash: 'a'.repeat(64), nonceHash: 'b'.repeat(64), expiresAt }
      await expect(repository.issue(issued)).resolves.toEqual(issued)
      const consumeInput = { workspaceId: issued.workspaceId, actorId: issued.actorId, sessionId: issued.sessionId, intentHash: issued.intentHash, nonceHash: issued.nonceHash }
      await expect(Promise.all([repository.consume(consumeInput), repository.consume(consumeInput)])).resolves.toEqual(expect.arrayContaining([true, false]))

      const second = { ...issued, workspaceId: 'ws_confirm_b', nonceHash: 'c'.repeat(64) }
      await repository.issue(second)
      await expect(repository.consume({ ...consumeInput, workspaceId: 'ws_confirm_a', nonceHash: second.nonceHash })).resolves.toBe(false)
      await expect(repository.issue({ ...issued, workspaceId: 'ws_confirm_b' })).rejects.toThrow(/duplicate key|unique constraint/u)

      const privileges = await database.query(`SELECT
        has_table_privilege('merchant_app','interactive_confirmation_tickets','SELECT') AS can_select,
        has_column_privilege('merchant_app','interactive_confirmation_tickets','consumed_at','UPDATE') AS can_consume,
        has_column_privilege('merchant_app','interactive_confirmation_tickets','actor_id','UPDATE') AS can_change_actor,
        has_table_privilege('merchant_app','interactive_confirmation_tickets','DELETE') AS can_delete`)
      expect(privileges.rows).toEqual([{ can_select: true, can_consume: true, can_change_actor: false, can_delete: false }])
      await expect(app.query(`UPDATE interactive_confirmation_tickets SET actor_id='other' WHERE nonce_hash=$1`, [second.nonceHash])).rejects.toThrow(/permission denied/u)
      await expect(app.query(`DELETE FROM interactive_confirmation_tickets WHERE nonce_hash=$1`, [second.nonceHash])).rejects.toThrow(/permission denied/u)
      await expect(app.query('BEGIN')).resolves.toBeDefined()
      await expect(app.query(`SELECT set_config('app.workspace_id',$1,true)`, [second.workspaceId])).resolves.toBeDefined()
      await expect(app.query(`UPDATE interactive_confirmation_tickets SET consumed_at=NULL WHERE nonce_hash=$1`, [second.nonceHash])).rejects.toThrow(/cannot be cleared/u)
      await expect(app.query('ROLLBACK')).resolves.toBeDefined()
    } finally {
      await app?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
