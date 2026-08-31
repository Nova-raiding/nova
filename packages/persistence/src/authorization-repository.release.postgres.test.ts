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
    let database: Pool | undefined
    let ops: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
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
      const scope = { task_ids: ['task-reservation-release'] }
      const grant = await repository.issueGrant({ grantKind: 'temporary', accessMode: 'write', subjectIdentityId: identityId, workspaceId: 'ws_reservation_a', capabilities: ['customer.content.update'], resourceScope: scope, reason: 'release reservation test', ticketRef: `RES-${identityId}`, issuedBy: 'release-issuer', approvedBy: 'release-approver', approvedAt: now.toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), maxUses: 1 })
      const input = { reservationId: `reservation-${identityId}`, eventId: `event-${identityId}`, subjectIdentityId: identityId, workspaceId: 'ws_reservation_a', capability: 'customer.content.update', resourceId: 'task-reservation-release', scopeHash: authorizationScopeHash(scope), expectedAuthorizationRevision: 1, grantId: grant.id, expectedGrantRevision: 1, at: now.toISOString() }
      const first = await repository.reserveExecution(input)
      expect(first).toMatchObject({ reservationId: input.reservationId, eventId: input.eventId, grantRevision: 1 })
      await expect(repository.reserveExecution(input)).resolves.toMatchObject({ reservationId: input.reservationId, eventId: input.eventId })
      await repository.revokeGrant({ id: grant.id, subjectIdentityId: identityId, actorId: 'release-approver', reason: 'release reservation revoke', expectedRevision: 1, expectedAuthorizationRevision: 1 })
      await expect(repository.reserveExecution(input)).resolves.toMatchObject({ reservationId: input.reservationId, eventId: input.eventId })
      const row = await database.query(`SELECT reservation_id,event_id,grant_id,authorization_revision,grant_revision FROM authorization_execution_reservations`)
      expect(row.rows).toHaveLength(1)
    } finally {
      await ops?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
