import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from '../packages/persistence/src/migration.js'
import { PostgresOutboxRepository } from '../packages/persistence/src/repository.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL outbox lease takeover', () => {
  const databaseName = `outbox_lease_${randomUUID().replaceAll('-', '')}`
  let admin: Pool | undefined
  let database: Pool | undefined
  let databaseCreated = false
  let repository: PostgresOutboxRepository

  beforeAll(async () => {
    const base = new URL(databaseUrl!)
    admin = new Pool({ connectionString: base.toString(), max: 2 })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    databaseCreated = true
    const isolated = new URL(base)
    isolated.pathname = `/${databaseName}`
    database = new Pool({ connectionString: isolated.toString(), max: 4 })
    const migrations = await loadMigrations()
    await new MigrationRunner(database, migrations).run()
    repository = new PostgresOutboxRepository(database)
  }, 240_000)

  afterAll(async () => {
    await database?.end()
    if (databaseCreated) await admin?.query(`DROP DATABASE "${databaseName}"`)
    await admin?.end()
  })

  it('reclaims an expired lease and fences the stale worker token', async () => {
    const workspaceId = `ws_lease_${randomUUID()}`
    await database!.query('INSERT INTO workspaces (id,status) VALUES ($1,$2)', [workspaceId, 'active'])
    const event = await repository.append({
      workspaceId,
      aggregateId: `lease_${randomUUID()}`,
      eventType: 'audit.retry.expired-lease',
      sequence: 1,
      payload: { source: 'isolated lease takeover regression' },
    })

    const firstClaimedAt = Date.now() + 10_000
    const firstLeaseMs = 1_000
    const [firstLease] = await repository.claimPending(workspaceId, {
      now: new Date(firstClaimedAt).toISOString(),
      leaseMs: firstLeaseMs,
      eventTypes: ['audit.retry.expired-lease'],
    })
    expect(firstLease).toMatchObject({ id: event.id, attempts: 1 })
    expect(firstLease?.leaseToken).toBeTruthy()

    const reclaimedAt = new Date(firstClaimedAt + firstLeaseMs + 1).toISOString()
    const [secondLease] = await repository.claimPending(workspaceId, {
      now: reclaimedAt,
      eventTypes: ['audit.retry.expired-lease'],
    })
    expect(secondLease).toMatchObject({ id: event.id, attempts: 2 })
    expect(secondLease?.leaseToken).toBeTruthy()
    expect(secondLease?.leaseToken).not.toBe(firstLease?.leaseToken)
    expect(await repository.claimPending(workspaceId, {
      now: reclaimedAt,
      eventTypes: ['audit.retry.expired-lease'],
    })).toEqual([])

    const persisted = await database!.query(
      'SELECT lease_token, attempts FROM outbox_events WHERE workspace_id=$1 AND id=$2',
      [workspaceId, event.id],
    )
    const currentToken = persisted.rows[0]?.lease_token as string
    expect(persisted.rows[0]?.attempts).toBe(2)
    expect(currentToken).toBe(secondLease?.leaseToken)
    await expect(repository.validateLease(workspaceId, event.id, firstLease!.leaseToken!, reclaimedAt))
      .rejects.toMatchObject({ code: 'OUTBOX_EVENT_NOT_FOUND' })
    await expect(repository.validateLease(workspaceId, event.id, currentToken, reclaimedAt))
      .resolves.toMatchObject({ id: event.id, attempts: 2, leaseToken: currentToken })
  })
})
