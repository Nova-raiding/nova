import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { authorizationScopeHash, PostgresAuthorizationRepository } from './authorization-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('authorization event scope integrity PostgreSQL probe', () => {
  postgresIt('rejects forged subject/workspace context at the database boundary', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_authz_event_scope_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      await new MigrationRunner(database, migrations).run()

      const subject = randomUUID()
      const otherSubject = randomUUID()
      const now = Date.parse('2026-09-01T10:00:00.000Z')
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('event_scope_ws','active')`)
      await database.query(`INSERT INTO platform_identities (id,issuer,external_subject,display_name) VALUES ($1,'event-scope-probe',$2,'Event Scope Subject'),($3,'event-scope-probe',$4,'Other Subject')`, [subject, subject, otherSubject, otherSubject])

      const repository = new PostgresAuthorizationRepository(database, () => new Date(now))
      const role = await repository.assignPlatformRole({ subjectIdentityId: subject, role: 'auditor', assignedBy: 'probe-admin', reason: 'scope integrity probe', expectedAuthorizationRevision: 0 })
      const grant = await repository.issueGrant({
        grantKind: 'support', accessMode: 'read', subjectIdentityId: subject, workspaceId: 'event_scope_ws',
        capabilities: ['customer.content.read'], resourceScope: { ticket_ids: ['scope-ticket'] },
        reason: 'scope integrity probe', ticketRef: `SCOPE-${subject}`, issuedBy: 'probe-issuer', approvedBy: 'probe-approver',
        approvedAt: new Date(now).toISOString(), expectedAuthorizationRevision: 1,
        expiresAt: new Date(now + 15 * 60_000).toISOString(), maxUses: 1,
      })
      const eventTime = new Date(now).toISOString()
      const validRoleEvent = { id: randomUUID(), assignmentId: role.id, subjectIdentityId: subject, eventType: 'assigned', actorId: 'probe', reason: 'valid event', authorizationRevision: 1, assignmentRevision: 1, snapshot: '{}' }
      await database.query(`INSERT INTO platform_role_assignment_events (id,assignment_id,subject_identity_id,event_type,actor_id,reason,authorization_revision,assignment_revision,snapshot_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`, [validRoleEvent.id, validRoleEvent.assignmentId, validRoleEvent.subjectIdentityId, validRoleEvent.eventType, validRoleEvent.actorId, validRoleEvent.reason, validRoleEvent.authorizationRevision, validRoleEvent.assignmentRevision, validRoleEvent.snapshot, eventTime])
      await expect(database.query(`INSERT INTO platform_role_assignment_events (id,assignment_id,subject_identity_id,event_type,actor_id,reason,authorization_revision,assignment_revision,snapshot_json,created_at) VALUES ($1,$2,$3,'assigned','probe','forged subject',1,1,'{}',$4)`, [randomUUID(), role.id, otherSubject, eventTime])).rejects.toThrow(/scope is invalid/u)

      const scope = { ticket_ids: ['scope-ticket'] }
      expect(authorizationScopeHash(scope)).toMatch(/^[0-9a-f]{64}$/u)
      await database.query(`INSERT INTO ops_access_grant_events (id,grant_id,subject_identity_id,workspace_id,event_type,actor_id,reason,authorization_revision,grant_revision,snapshot_json,created_at) VALUES ($1,$2,$3,$4,'issued','probe','valid event',2,1,'{}',$5)`, [randomUUID(), grant.id, subject, 'event_scope_ws', eventTime])
      await expect(database.query(`INSERT INTO ops_access_grant_events (id,grant_id,subject_identity_id,workspace_id,event_type,actor_id,reason,authorization_revision,grant_revision,snapshot_json,created_at) VALUES ($1,$2,$3,$4,'issued','probe','forged scope',2,1,'{}',$5)`, [randomUUID(), grant.id, otherSubject, 'other_ws', eventTime])).rejects.toThrow(/scope is invalid/u)
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
