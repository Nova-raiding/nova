import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip
const connection = (base: URL, database: string, user?: string, password?: string) => { const url = new URL(base); url.pathname = `/${database}`; if (user) url.username = user; if (password) url.password = password; return url.toString() }

describe('failed-provider release PostgreSQL concurrency acceptance', () => {
  postgresIt('does not release when success arrives first or holds the operation lock concurrently', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_failed_provider_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined; let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      await new MigrationRunner(database, migrations).run()
      const roleSql = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
      await database.query(roleSql)
      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 6 })
      const points = new PostgresCreativePointRepository(app)
      const lifecycle = new PostgresCreativePointLifecycleRepository(app)
      const prepare = async (label: string) => {
        const workspaceId = `ws-${label}-${randomUUID()}`; const actionKey = `image:${label}:${randomUUID()}`; const providerRequestId = `provider:${label}:${randomUUID()}`
        await database!.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [workspaceId])
        await points.grant({ workspaceId, idempotencyKey: `grant:${label}`, sourceType: 'test', sourceId: label, points: 10 })
        const reservation = (await points.reserve({ workspaceId, idempotencyKey: `reserve:${label}`, actionKey, points: 3, rateCardVersion: 'image-v1' })).value
        await lifecycle.recordProviderReceipt({ workspaceId, operationId: reservation.operationId, provider: 'worker-relay', providerRequestId, outcome: 'failed', receiptHash: 'a'.repeat(64), at: new Date().toISOString() })
        const release = (sourceEventId?: string) => points.releaseFailedProviderReservation({ workspaceId, reservationId: reservation.id, actionKey, providerRequestId, idempotencyKey: `release:${label}`, ...(sourceEventId ? { sourceEventId } : {}), at: new Date().toISOString() })
        return { workspaceId, actionKey, providerRequestId, reservation, release }
      }
      const successReceipt = (f: Awaited<ReturnType<typeof prepare>>, suffix: string) => lifecycle.recordProviderReceipt({ workspaceId: f.workspaceId, operationId: f.reservation.operationId, provider: 'model-relay', providerRequestId: f.providerRequestId, outcome: 'succeeded', usage: { modality: 'image', model: 'relay-image' }, cost: { currency: 'CNY', actual: 0.01 }, receiptHash: suffix.repeat(64), verifiedAt: new Date().toISOString(), at: new Date().toISOString() })

      const first = await prepare('success-first')
      await successReceipt(first, 'b')
      await expect(points.release({ workspaceId: first.workspaceId, reservationId: first.reservation.id, idempotencyKey: 'unsafe-generic-release', at: new Date().toISOString() })).rejects.toMatchObject({ code: 'CREATIVE_POINT_BALANCE_UNKNOWN' })
      await expect(first.release()).rejects.toMatchObject({ code: 'CREATIVE_POINT_BALANCE_UNKNOWN' })
      await expect(points.getReservation(first.workspaceId, first.reservation.id)).resolves.toMatchObject({ status: 'active' })

      const concurrent = await prepare('success-concurrent')
      const successClient = await app.connect()
      try {
        await successClient.query('BEGIN')
        await successClient.query("SELECT set_config('app.workspace_id', $1, true)", [concurrent.workspaceId])
        await successClient.query('SELECT id FROM creative_point_operations WHERE workspace_id=$1 AND id=$2 FOR SHARE', [concurrent.workspaceId, concurrent.reservation.operationId])
        const releasePromise = concurrent.release().then(value => ({ value }), error => ({ error }))
        await successClient.query(`INSERT INTO creative_point_provider_receipts_v2 (id,workspace_id,operation_id,provider,provider_request_id,outcome,usage,cost,receipt_hash,verified_at,created_at) VALUES ($1,$2,$3,'model-relay',$4,'succeeded',$5::jsonb,$6::jsonb,$7,$8::timestamptz,$8::timestamptz)`, [`cppr_${randomUUID()}`, concurrent.workspaceId, concurrent.reservation.operationId, concurrent.providerRequestId, JSON.stringify({ modality: 'image', model: 'relay-image' }), JSON.stringify({ currency: 'CNY', actual: 0.01 }), 'c'.repeat(64), new Date().toISOString()])
        await successClient.query('COMMIT')
        await expect(releasePromise).resolves.toMatchObject({ error: { code: 'CREATIVE_POINT_BALANCE_UNKNOWN' } })
      } finally { successClient.release() }
      await expect(points.getReservation(concurrent.workspaceId, concurrent.reservation.id)).resolves.toMatchObject({ status: 'active' })

      const replay = await prepare('released-replay')
      const sourceEventId = `failed-event:${randomUUID()}`
      await expect(replay.release(sourceEventId)).resolves.toMatchObject({ value: { status: 'released' }, balance: { availablePoints: 10, reservedPoints: 0 } })
      await expect(replay.release(sourceEventId)).resolves.toMatchObject({ value: { id: replay.reservation.id, status: 'released' } })
      await expect(replay.release(`different-event:${randomUUID()}`)).rejects.toMatchObject({ code: 'CREATIVE_POINT_IDEMPOTENCY_CONFLICT' })
      const releaseCount = await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM creative_point_operations WHERE workspace_id=$1 AND kind='release' AND idempotency_key=$2`, [replay.workspaceId, 'release:released-replay'])
      expect(releaseCount.rows[0]?.count).toBe(1)

      const settledWorkspace = `ws-settled-${randomUUID()}`; const settledAction = `image:settled:${randomUUID()}`
      await database.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [settledWorkspace])
      await points.grant({ workspaceId: settledWorkspace, idempotencyKey: `grant:settled:${settledWorkspace}`, sourceType: 'test', sourceId: settledWorkspace, points: 10 })
      const settledReservation = (await points.reserve({ workspaceId: settledWorkspace, idempotencyKey: `reserve:settled:${settledWorkspace}`, actionKey: settledAction, points: 3, rateCardVersion: 'image-v1' })).value
      const apiReceipt = { workspaceId: settledWorkspace, operationId: settledReservation.operationId, provider: 'model-relay', providerRequestId: `api:${randomUUID()}`, outcome: 'succeeded' as const, usage: { modality: 'image', model: 'relay-image', total_tokens: 1 }, cost: { currency: 'CNY', actual: 0.01 }, receiptHash: 'd'.repeat(64), verifiedAt: new Date().toISOString(), at: new Date().toISOString() }
      const workerReceipt = { ...apiReceipt, provider: 'worker-relay', providerRequestId: `worker:${randomUUID()}` }
      await lifecycle.recordProviderReceipt(apiReceipt)
      await lifecycle.recordProviderReceipt(workerReceipt)
      await points.settle({ workspaceId: settledWorkspace, reservationId: settledReservation.id, actualPoints: 3, idempotencyKey: `settle:${settledAction}`, metadata: {}, at: new Date().toISOString() })
      await expect(lifecycle.recordProviderReceipt(apiReceipt)).resolves.toBeUndefined()
      await expect(lifecycle.recordProviderReceipt(workerReceipt)).resolves.toBeUndefined()
      await expect(lifecycle.recordProviderReceipt({ ...apiReceipt, providerRequestId: `late:${randomUUID()}`, receiptHash: 'e'.repeat(64) })).rejects.toMatchObject({ code: 'CREATIVE_POINT_RESERVATION_FINALIZED' })
      const receiptCount = await database.query<{ count: number }>(`SELECT count(*)::int AS count FROM creative_point_provider_receipts_v2 WHERE workspace_id=$1 AND operation_id=$2 AND outcome='succeeded'`, [settledWorkspace, settledReservation.operationId])
      expect(receiptCount.rows[0]?.count).toBe(2)
    } finally {
      await app?.end(); await database?.end()
      // All test pools are closed first. A non-forced drop catches leaked
      // clients instead of terminating their connections during Vitest teardown.
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 120_000)
})
