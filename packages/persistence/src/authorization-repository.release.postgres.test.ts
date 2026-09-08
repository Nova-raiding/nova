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

describe('authorization execution reservation PostgreSQL release acceptance', () => {
  postgresIt('persists a grant-bound reservation, enforces event idempotency, and replays after revoke', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_authz_reservation_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let createdDatabase = false
    let database: Pool | undefined
    let ops: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      createdDatabase = true
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])
      const identityId = randomUUID()
      await database.query(`INSERT INTO workspaces (id,status) VALUES ('ws_reservation_a','active')`)
      await database.query(`INSERT INTO platform_identities (id,issuer,external_subject,display_name) VALUES ($1,'release-test',$2,'Reservation Subject')`, [identityId, `reservation-${identityId}`])
      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only'), max: 4 })
      const repository = new PostgresAuthorizationRepository(ops)
      const now = new Date(Date.now())
      const scope = { workspace_ids: ['ws_reservation_a'], reason_tag: 'approved release repair' }
      const grant = await repository.issueGrant({ grantKind: 'temporary', accessMode: 'write', subjectIdentityId: identityId, workspaceId: 'ws_reservation_a', capabilities: ['customer.content.update'], resourceScope: scope, reason: 'release reservation test', ticketRef: `RES-${identityId}`, issuedBy: 'release-issuer', approvedBy: 'release-approver', approvedAt: now.toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), maxUses: 1 })
      const admittedAt = new Date(Date.now() + 1_000).toISOString()
      const consumed = await repository.consumeGrant({ id: grant.id, subjectIdentityId: identityId, workspaceId: 'ws_reservation_a', capability: 'customer.content.update', scopeHash: authorizationScopeHash(scope), expectedRevision: 1, actorId: 'release-worker', reason: 'admit reservation release event', at: admittedAt })
      expect(grant.authorizationRevision).toBe(1)
      expect(consumed).toMatchObject({ id: grant.id, useCount: 1, revision: 2, authorizationRevision: 2 })
      // Pass the real driver-decoded revision directly, without a test-side
      // Number() conversion that could hide an invalid repository contract.
      const input = { reservationId: `reservation-${identityId}`, eventId: `event-${identityId}`, decisionId: `decision-${identityId}`, subjectIdentityId: identityId, workspaceId: 'ws_reservation_a', capability: 'customer.content.update', resourceId: 'task-reservation-release', scopeHash: authorizationScopeHash(scope), expectedAuthorizationRevision: consumed!.authorizationRevision, grantId: grant.id, expectedGrantRevision: consumed!.revision, at: admittedAt }
      await expect(repository.reserveExecution({ ...input, workspaceId: 'ws_reservation_b' })).resolves.toBeUndefined()
      await expect(repository.reserveExecution({ ...input, scopeHash: '0'.repeat(64) })).resolves.toBeUndefined()
      expect((await database.query('SELECT count(*)::integer AS count FROM authorization_execution_reservations')).rows[0].count).toBe(0)
      const first = await repository.reserveExecution(input)
      expect(first).toMatchObject({ reservationId: input.reservationId, eventId: input.eventId, resourceId: 'task-reservation-release', authorizationRevision: 2, grantRevision: 2 })
      await expect(repository.reserveExecution(input)).resolves.toMatchObject({ reservationId: input.reservationId, eventId: input.eventId })
      for (const changed of [{ resourceId: 'another-job' }, { decisionId: 'another-decision' }, { reservationId: 'another-reservation' }, { expectedAuthorizationRevision: 3 }, { expectedGrantRevision: 3 }]) {
        await expect(repository.reserveExecution({ ...input, ...changed })).rejects.toMatchObject({ code: 'AUTHORIZATION_EXECUTION_RESERVATION_CONFLICT' })
      }
      await expect(repository.getGrant(grant.id, identityId)).resolves.toMatchObject({ resourceScope: scope, scopeHash: authorizationScopeHash(scope), authorizationRevision: 2, useCount: 1 })
      await repository.revokeGrant({ id: grant.id, subjectIdentityId: identityId, actorId: 'release-approver', reason: 'release reservation revoke', expectedRevision: 2, expectedAuthorizationRevision: 2 })
      await expect(repository.reserveExecution(input)).resolves.toMatchObject({ reservationId: input.reservationId, eventId: input.eventId })
      await expect(repository.reserveExecution({ ...input, reservationId: 'new-reservation-after-revoke', eventId: 'new-event-after-revoke' })).resolves.toBeUndefined()
      const row = await database.query(`SELECT reservation_id,event_id,decision_id,resource_id,grant_id,authorization_revision,grant_revision FROM authorization_execution_reservations`)
      expect(row.rows).toHaveLength(1)
      expect(row.rows[0]).toMatchObject({ decision_id: input.decisionId, resource_id: input.resourceId, authorization_revision: '2' })
      await database.query(`UPDATE authorization_revisions SET revision=9007199254740993 WHERE subject_identity_id=$1`, [identityId])
      await database.query(`UPDATE ops_access_grants SET authorization_revision=9007199254740993 WHERE id=$1`, [grant.id])
      await expect(repository.getAuthorizationRevision(identityId)).rejects.toMatchObject({ code: 'AUTHORIZATION_REVISION_CONFLICT' })
      await expect(repository.getGrant(grant.id, identityId)).rejects.toMatchObject({ code: 'AUTHORIZATION_REVISION_CONFLICT' })
    } finally {
      await ops?.end()
      await database?.end()
      try { if (createdDatabase) await admin.query(`DROP DATABASE "${databaseName}"`) } finally { await admin.end() }
    }
  }, 240_000)
})
