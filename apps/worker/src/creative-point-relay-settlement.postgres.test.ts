import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresCreativePointLifecycleRepository } from '../../../packages/persistence/src/creative-point-lifecycle-repository.js'
import { PostgresCreativePointRepository } from '../../../packages/persistence/src/creative-point-repository.js'
import { loadMigrations, MigrationRunner } from '../../../packages/persistence/src/migration.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import { CreativePointRelaySettlement } from './creative-point-relay-settlement.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, name: string, user?: string, password?: string) {
  const value = new URL(base); value.pathname = `/${name}`
  if (user) value.username = user
  if (password) value.password = password
  return value.toString()
}

describe('creative point relay settlement PostgreSQL E2', () => {
  postgresIt('persists a verified receipt and settles while keeping unknown outcomes active', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `relay_settlement_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName) })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws_relay','active')")
      app = new Pool({ connectionString: databaseUrl(base, databaseName, 'merchant_app', 'merchant_app_local_only') })
      const points = new PostgresCreativePointRepository(app)
      const receipts = new PostgresCreativePointLifecycleRepository(app)
      await points.grant({ workspaceId: 'ws_relay', idempotencyKey: 'grant', sourceType: 'test_approved_adjustment', sourceId: 'relay-e2', points: 10 })
      const reservation = await points.reserve({ workspaceId: 'ws_relay', idempotencyKey: 'reserve-success', actionKey: 'generation.execute', rateCardVersion: 'rate-v1', points: 3 })
      const unknownReservation = await points.reserve({ workspaceId: 'ws_relay', idempotencyKey: 'reserve-unknown', actionKey: 'generation.execute', rateCardVersion: 'rate-v1', points: 2 })
      const event = (reservationId: string, quotedPoints: number, id: string): DurableOutboxEvent => ({
        id, workspaceId: 'ws_relay', aggregateId: id, eventType: 'generation.requested', sequence: 1, createdAt: new Date().toISOString(),
        payload: { commercial_access_snapshot: { schema_version: 1, decision_id: id, workspace_id: 'ws_relay', operation: 'generation.execute', access_mode: 'POINT_CHARGED', access_revision: 'revision-1', balance_state: 'known', entitlement_snapshot_id: 'entitlement-1', entitlement_snapshot_checksum: 'b'.repeat(64), rate_version: 'rate-v1', quoted_points: quotedPoints, reservation_id: reservationId, decided_at: new Date().toISOString() } },
      })
      const bridge = new CreativePointRelaySettlement(points, receipts, 'relay.e2')

      const succeededEvent = event(reservation.value.id, 3, 'evt_success')
      const providerRequestId = await bridge.recordSucceeded(succeededEvent, { modality: 'text', model: 'model-e2', providerRequestId: 'provider-success-e2', inputTokens: 4, outputTokens: 6, totalTokens: 10, costCny: 0.08, observedAt: new Date().toISOString() })
      await bridge.settleForDelivery(succeededEvent, [providerRequestId!])
      await bridge.recordProviderOutcome(event(unknownReservation.value.id, 2, 'evt_unknown'), { providerOutcome: 'unknown', providerRequestId: 'provider-unknown-e2' })

      const states = await database.query<{ id: string; status: string }>(`SELECT id,status FROM creative_point_reservations WHERE workspace_id='ws_relay' ORDER BY id`)
      expect(Object.fromEntries(states.rows.map(row => [row.id, row.status]))).toMatchObject({ [reservation.value.id]: 'settled', [unknownReservation.value.id]: 'active' })
      const providerReceipts = await database.query<{ providerRequestId: string; outcome: string; usage: unknown; cost: unknown }>(`SELECT provider_request_id AS "providerRequestId",outcome,usage,cost FROM creative_point_provider_receipts_v2 WHERE workspace_id='ws_relay' ORDER BY provider_request_id`)
      expect(providerReceipts.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ providerRequestId: 'provider-success-e2', outcome: 'succeeded', usage: expect.any(Object), cost: expect.any(Object) }),
        expect.objectContaining({ providerRequestId: 'provider-unknown-e2', outcome: 'unknown' }),
      ]))
      const settled = await database.query<{ count: string }>(`SELECT count(*)::text AS count FROM creative_point_ledger_events WHERE workspace_id='ws_relay' AND event_type='settled'`)
      expect(settled.rows[0]?.count).toBe('1')
    } finally {
      await app?.end(); await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 300_000)
})
