import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { authorizationScopeHash, PostgresAuthorizationRepository } from './authorization-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base); url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('migration 105 PostgreSQL release acceptance', () => {
  postgresIt('enforces dual-boundary RLS/ACL, atomic use budgets, append-only events, and immediate revoke', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_105_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let ops: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      const identityId = randomUUID()
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_authz_a','active'),('ws_authz_b','active')`)
      await database.query(`INSERT INTO platform_identities (id,issuer,external_subject,display_name) VALUES ($1,'release-test','authz-subject','Authz Subject')`, [identityId])

      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only'), max: 4 })
      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only') })
      const now = Date.parse('2026-08-31T10:00:00.000Z')
      const repository = new PostgresAuthorizationRepository(ops, () => new Date(now))
      const role = await repository.assignPlatformRole({ subjectIdentityId: identityId, role: 'support_agent', assignedBy: 'security-admin', reason: 'approved support rotation', expectedAuthorizationRevision: 0 })
      const scope = { ticket_ids: ['ticket-105'] }
      const grant = await repository.issueGrant({ grantKind: 'support', accessMode: 'read', subjectIdentityId: identityId, workspaceId: 'ws_authz_a', capabilities: ['customer.content.read'], resourceScope: scope, reason: 'investigate approved ticket', ticketRef: `SUP-${identityId}`, issuedBy: 'support-lead', approvedBy: 'security-admin', approvedAt: new Date(now).toISOString(), expectedAuthorizationRevision: 1, expiresAt: new Date(now + 15 * 60_000).toISOString(), maxUses: 1 })
      const consume = { id: grant.id, subjectIdentityId: identityId, workspaceId: 'ws_authz_a', capability: 'customer.content.read', scopeHash: authorizationScopeHash(scope), expectedRevision: 1, actorId: 'support-user', reason: 'open approved customer record', at: new Date(now).toISOString() }
      const consumed = await Promise.all([repository.consumeGrant(consume), repository.consumeGrant(consume)])
      expect(consumed.filter(Boolean)).toHaveLength(1)
      expect(await repository.getAuthorizationRevision(identityId)).toBe(3)
      const consumedGrant = consumed.find(Boolean)!
      const roleEventId = (await database.query<{ id: string }>(
        `SELECT id FROM platform_role_assignment_events WHERE assignment_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [role.id],
      )).rows[0]!.id
      const grantEventId = (await database.query<{ id: string }>(
        `SELECT id FROM ops_access_grant_events WHERE grant_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [grant.id],
      )).rows[0]!.id
      await expect(database.query(`UPDATE platform_role_assignment_events SET reason='tampered' WHERE id=$1`, [roleEventId])).rejects.toThrow(/append-only/u)
      await expect(database.query(`DELETE FROM ops_access_grant_events WHERE id=$1`, [grantEventId])).rejects.toThrow(/append-only/u)
      await repository.revokeGrant({ id: grant.id, subjectIdentityId: identityId, actorId: 'security-admin', reason: 'customer withdrew approval', expectedRevision: consumedGrant.revision, expectedAuthorizationRevision: 3 })
      await repository.revokePlatformRole({ id: role.id, subjectIdentityId: identityId, actorId: 'security-admin', reason: 'support rotation ended', expectedRevision: 1, expectedAuthorizationRevision: 4 })
      expect(await repository.listActiveGrants(identityId, 'ws_authz_a', new Date(now).toISOString())).toEqual([])
      expect(await repository.listActivePlatformRoles(identityId, new Date(now).toISOString())).toEqual([])
      expect(await repository.getAuthorizationRevision(identityId)).toBe(5)

      const acl = await database.query(`SELECT
        has_table_privilege('merchant_app','ops_access_grants','SELECT') AS app_grant_select,
        has_table_privilege('merchant_app','platform_role_assignments','SELECT') AS app_role_select,
        has_table_privilege('merchant_ops','ops_access_grant_events','UPDATE') AS ops_event_update,
        has_table_privilege('merchant_ops','ops_access_grants','DELETE') AS ops_grant_delete`)
      expect(acl.rows).toEqual([{ app_grant_select: false, app_role_select: false, ops_event_update: false, ops_grant_delete: false }])
      await expect(app.query('SELECT * FROM ops_access_grants')).rejects.toMatchObject({ code: '42501' })
      const directOps = await ops.connect()
      try {
        await directOps.query('BEGIN READ ONLY')
        expect((await directOps.query('SELECT id FROM ops_access_grants')).rows).toEqual([])
        await directOps.query('ROLLBACK')
      } finally { directOps.release() }
    } finally {
      await app?.end()
      await ops?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
