import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

describe('authorization grant exact scope PostgreSQL probe', () => {
  postgresIt('rejects cross-tenant and non-workspace grant scopes at persistence boundary', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_grant_scope_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const databaseUrl = new URL(base)
      databaseUrl.pathname = `/${databaseName}`
      database = new Pool({ connectionString: databaseUrl.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()

      const subject = randomUUID()
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('grant_scope_a','active'),('grant_scope_b','active')`)
      await database.query(`INSERT INTO platform_identities (id,issuer,external_subject,display_name) VALUES ($1,'grant-scope-probe',$2,'Grant Scope Probe')`, [subject, subject])
      const common = [randomUUID(), subject, 'grant_scope_a', ['customer.content.read'], JSON.stringify({ type: 'workspace', ids: ['grant_scope_a'] }), 'a'.repeat(64)]
      const insert = `INSERT INTO ops_access_grants
        (id,grant_kind,access_mode,subject_identity_id,workspace_id,capabilities,resource_scope,scope_hash,reason,ticket_ref,issued_by,approved_by,approved_at,issued_at,expires_at,max_uses,authorization_revision)
        VALUES ($1,'support','read',$2,$3,$4,$5::jsonb,$6,'scope probe',$7,'issuer','approver','2026-09-01T09:59:00Z','2026-09-01T10:00:00Z','2026-09-01T10:10:00Z',1,1)`

      await expect(database.query(insert, [...common, 'grant-scope-valid'])).resolves.toBeDefined()
      await expect(database.query(insert, [randomUUID(), subject, 'grant_scope_a', ['customer.content.read'], JSON.stringify({ type: 'workspace', ids: ['grant_scope_b'] }), 'b'.repeat(64), 'grant-scope-cross-tenant'])).rejects.toThrow(/ops access grant scope is invalid/u)
      await expect(database.query(insert, [randomUUID(), subject, 'grant_scope_a', ['customer.content.read'], JSON.stringify({ type: 'brand', ids: ['brand_a'] }), 'c'.repeat(64), 'grant-scope-wrong-type'])).rejects.toThrow(/ops access grant scope is invalid/u)
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
