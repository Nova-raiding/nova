import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture } from './postgres-scope-fixture-cleanup.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = source ? it : it.skip

function databaseUrl(base: URL, name: string, user?: string, password?: string) {
  const url = new URL(base)
  url.pathname = `/${name}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('creative-point first-grant PostgreSQL concurrency regression', () => {
  postgresIt('keeps an unknown balance fail-closed and serializes concurrent idempotent first grants', async () => {
    const base = new URL(source!)
    const suffix = randomUUID().replaceAll('-', '')
    const databaseName = `creative_points_148_${suffix}`
    const admin = new Pool({ connectionString: base.toString(), max: 4 })
    let database: Pool | undefined
    let app: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName), max: 4 })
      await new MigrationRunner(database, await loadMigrations()).run()

      const workspaceId = `ws_first_grant_${suffix}`
      await database.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [workspaceId])
      app = new Pool({
        connectionString: databaseUrl(base, databaseName, 'merchant_app', 'merchant_app_local_only'),
        max: 12,
      })
      const repository = new PostgresCreativePointRepository(app)

      await expect(repository.getBalance(workspaceId)).resolves.toMatchObject({
        availablePoints: null, reservedPoints: null, settledPoints: null, revision: 0,
      })
      await expect(repository.reserve({
        workspaceId,
        idempotencyKey: `reserve-before-grant:${suffix}`,
        actionKey: `image.generate:${suffix}`,
        rateCardVersion: 'test-v1',
        points: 1,
      })).rejects.toMatchObject({ code: 'CREATIVE_POINT_BALANCE_UNKNOWN' })

      const beforeGrant = await database.query<{ accessStates: number; operations: number; grants: number; ledger: number }>(`
        SELECT
          (SELECT count(*)::int FROM creative_point_access_state WHERE workspace_id=$1) AS "accessStates",
          (SELECT count(*)::int FROM creative_point_operations WHERE workspace_id=$1) AS operations,
          (SELECT count(*)::int FROM creative_point_grants WHERE workspace_id=$1) AS grants,
          (SELECT count(*)::int FROM creative_point_ledger_events WHERE workspace_id=$1) AS ledger
      `, [workspaceId])
      expect(beforeGrant.rows[0]).toEqual({ accessStates: 0, operations: 0, grants: 0, ledger: 0 })

      const grantInput = {
        workspaceId,
        idempotencyKey: `first-grant:${suffix}`,
        sourceType: 'qa_regression_fixture',
        sourceId: `source:${suffix}`,
        points: 37,
        at: '2026-10-01T00:00:00.000Z',
      }
      const concurrent = await Promise.all(Array.from({ length: 8 }, () => repository.grant(grantInput)))
      const grantId = concurrent[0]!.value.id
      expect(concurrent.map(result => result.value.id)).toEqual(Array(8).fill(grantId))
      expect(concurrent.every(result => result.balance.availablePoints === 37)).toBe(true)
      await expect(repository.getBalance(workspaceId)).resolves.toMatchObject({
        availablePoints: 37, reservedPoints: 0, settledPoints: 0, revision: 1,
      })

      const sameSourceReplay = await repository.grant({ ...grantInput, idempotencyKey: `alternate-key:${suffix}` })
      expect(sameSourceReplay.value.id).toBe(grantId)
      expect(sameSourceReplay.balance).toMatchObject({ availablePoints: 37, revision: 1 })
      await expect(repository.grant({ ...grantInput, points: 38 })).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
      await expect(repository.grant({ ...grantInput, idempotencyKey: `changed-key:${suffix}`, points: 38 }))
        .rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })

      // A distinct idempotency key per caller exercises source-level
      // idempotency under a first-grant race, independently of operation-key
      // replay tested above. Matching source facts must converge on one grant.
      const concurrentSourceWorkspaceId = `ws_source_race_${suffix}`
      await database.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [concurrentSourceWorkspaceId])
      const concurrentSourceGrants = await Promise.all(Array.from({ length: 8 }, (_, index) => repository.grant({
        ...grantInput,
        workspaceId: concurrentSourceWorkspaceId,
        idempotencyKey: `source-race:${suffix}:${index}`,
        sourceId: `source-race:${suffix}`,
      })))
      const sourceRaceGrantId = concurrentSourceGrants[0]!.value.id
      expect(concurrentSourceGrants.map(result => result.value.id)).toEqual(Array(8).fill(sourceRaceGrantId))
      expect(concurrentSourceGrants.every(result => result.balance.availablePoints === 37)).toBe(true)

      const persisted = await database.query<{ operations: number; grants: number; ledger: number; balance: number; revision: number }>(`
        SELECT
          (SELECT count(*)::int FROM creative_point_operations WHERE workspace_id=$1 AND kind='grant') AS operations,
          (SELECT count(*)::int FROM creative_point_grants WHERE workspace_id=$1) AS grants,
          (SELECT count(*)::int FROM creative_point_ledger_events WHERE workspace_id=$1 AND event_type='granted') AS ledger,
          (SELECT available_points::int FROM creative_point_access_state WHERE workspace_id=$1) AS balance,
          (SELECT revision::int FROM creative_point_access_state WHERE workspace_id=$1) AS revision
      `, [workspaceId])
      expect(persisted.rows[0]).toEqual({ operations: 1, grants: 1, ledger: 1, balance: 37, revision: 1 })

      const sourceRacePersisted = await database.query<{ operations: number; grants: number; ledger: number; balance: number; revision: number }>(`
        SELECT
          (SELECT count(*)::int FROM creative_point_operations WHERE workspace_id=$1 AND kind='grant') AS operations,
          (SELECT count(*)::int FROM creative_point_grants WHERE workspace_id=$1) AS grants,
          (SELECT count(*)::int FROM creative_point_ledger_events WHERE workspace_id=$1 AND event_type='granted') AS ledger,
          (SELECT available_points::int FROM creative_point_access_state WHERE workspace_id=$1) AS balance,
          (SELECT revision::int FROM creative_point_access_state WHERE workspace_id=$1) AS revision
      `, [concurrentSourceWorkspaceId])
      expect(sourceRacePersisted.rows[0]).toEqual({ operations: 1, grants: 1, ledger: 1, balance: 37, revision: 1 })
    } finally {
      await app?.end()
      await database?.end()
      await dropDrainedPostgresFixture(admin, databaseName)
      await admin.end()
    }
  }, 180_000)
})
