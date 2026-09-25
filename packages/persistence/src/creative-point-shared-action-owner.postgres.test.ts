import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import { creativePointRequestOwnership, mayReleaseCreativePointReservation } from '../../application/src/creative-point-reservation-ownership.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const baseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
  ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'

// Models the two reserve calls and failure cleanup made by API content.generate.
// This is a real PostgreSQL repository test, not an HTTP or worker execution test.
describe('charged action owner PostgreSQL modeled API sequence', () => {
  it('does not let modeled duplicate-request cleanup release the successful request’s active hold', async () => {
    const base = new URL(baseUrl)
    const name = `probe_authz_reservation_acl_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    const isolated = new URL(base)
    isolated.pathname = `/${name}`
    let database: Pool | undefined
    let app: Pool | undefined
    let primaryFailure: unknown
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      database = new Pool({ connectionString: isolated.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      expect((await database.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='creative_point_reservations' AND indexname='creative_point_reservations_workspace_action_key_unique'")).rows).toHaveLength(1)
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws_action_owner','active')")
      const appUrl = new URL(isolated)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      app = new Pool({ connectionString: appUrl.toString(), max: 4 })
      const points = new PostgresCreativePointRepository(app)
      const workspaceId = 'ws_action_owner'
      const actionKey = 'model:generation:same-client-key'
      await points.grant({ workspaceId, idempotencyKey: 'grant', sourceType: 'paid_order', sourceId: 'test-order', points: 10 })

      // Matches content.generate: both HTTP requests reserve with the same
      // commercial.reserve:<actionKey> before their separate enqueue paths.
      const [successfulRequest, failedRequest] = await Promise.all([
        points.reserve({ workspaceId, actionKey, idempotencyKey: `commercial.reserve:${actionKey}`, points: 4, rateCardVersion: 'approved-v1' }),
        points.reserve({ workspaceId, actionKey, idempotencyKey: `commercial.reserve:${actionKey}`, points: 4, rateCardVersion: 'approved-v1' }),
      ])
      expect(failedRequest.value.id).toBe(successfulRequest.value.id)
      expect([successfulRequest.replayed, failedRequest.replayed].sort()).toEqual([false, true])
      await expect(points.reserve({ workspaceId, actionKey, idempotencyKey: 'different-key-same-action', points: 4, rateCardVersion: 'approved-v1' }))
        .rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })

      // The second request fails after reservation. The current API catch
      // looks up the actionKey and releases this shared reservation, while
      // the first request has already queued a provider call.
      const owner = creativePointRequestOwnership(failedRequest)
      if (mayReleaseCreativePointReservation(owner, failedRequest.value)) {
        await points.release({ workspaceId, reservationId: failedRequest.value.id, idempotencyKey: `commercial.release:${actionKey}:${failedRequest.value.id}` })
      }

      const activeHold = await points.getReservationByActionKey(workspaceId, actionKey)
      expect(activeHold?.id).toBe(successfulRequest.value.id)
      expect(activeHold?.status).toBe('active')
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await app?.end()
        await database?.end()
        await dropDrainedPostgresFixture(admin, name)
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
