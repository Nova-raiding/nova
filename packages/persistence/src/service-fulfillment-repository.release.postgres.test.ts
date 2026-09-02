import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresServiceFulfillmentRepository, ServiceFulfillmentRepositoryError } from './service-fulfillment-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
  ?? 'postgres://merchant:merchant_local_only@127.0.0.1:54329/merchant'

describe('service fulfillment PostgreSQL release evidence', () => {
  it('enforces tenant scope, idempotency, revision, quota, correction audit and unresolved 6x500 schedule', async () => {
    const base = new URL(databaseUrlValue)
    const databaseName = `service_154_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base); isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws_service_a','active'),('ws_service_b','active')")

      const repository = new PostgresServiceFulfillmentRepository(database)
      const allocationInput = {
        workspaceId: 'ws_service_a', idempotencyKey: 'allocation:sept:one-to-one',
        orderSnapshotId: 'order_snapshot_a', entitlementSnapshotId: 'entitlement_snapshot_a',
        serviceType: 'one_to_one', unit: 'minute' as const, allocatedQuantity: 300,
        periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z',
        sourceChecksum: 'a'.repeat(64),
        actorId: 'ops_a', reason: 'Verified contract service allocation', evidence: { order_snapshot: 'evidence://order/a' },
      }
      const allocation = await repository.createAllocation(allocationInput)
      expect(allocation).toMatchObject({ createdByActorId: 'ops_a', creationReason: 'Verified contract service allocation', creationEvidence: { order_snapshot: 'evidence://order/a' } })
      expect(await repository.createAllocation(allocationInput)).toEqual(allocation)
      await expect(repository.createAllocation({ ...allocationInput, allocatedQuantity: 301 }))
        .rejects.toMatchObject({ code: 'SERVICE_ALLOCATION_IDEMPOTENCY_CONFLICT' })

      const schedule = await repository.appendEvent({ workspaceId: 'ws_service_a', allocationId: allocation.id, type: 'scheduled', expectedRevision: 1, idempotencyKey: 'event:schedule:1', actorId: 'ops_a', reason: 'Customer selected a time', scheduleAt: '2026-09-05T02:00:00.000Z' })
      expect(schedule.allocation).toMatchObject({ revision: 2, status: 'scheduled', usedQuantity: 0 })
      expect(await repository.appendEvent({ workspaceId: 'ws_service_a', allocationId: allocation.id, type: 'scheduled', expectedRevision: 1, idempotencyKey: 'event:schedule:1', actorId: 'ops_a', reason: 'Customer selected a time', scheduleAt: '2026-09-05T02:00:00.000Z' })).toEqual(schedule)

      await expect(repository.appendEvent({ workspaceId: 'ws_service_b', allocationId: allocation.id, type: 'started', expectedRevision: 2, idempotencyKey: 'cross-tenant', actorId: 'ops_b', reason: 'must not see tenant A' }))
        .rejects.toMatchObject({ code: 'SERVICE_ALLOCATION_NOT_FOUND' })
      await expect(repository.appendEvent({ workspaceId: 'ws_service_a', allocationId: allocation.id, type: 'started', expectedRevision: 1, idempotencyKey: 'stale', actorId: 'ops_a', reason: 'stale writer' }))
        .rejects.toMatchObject({ code: 'SERVICE_FULFILLMENT_REVISION_CONFLICT' })

      const started = await repository.appendEvent({ workspaceId: 'ws_service_a', allocationId: allocation.id, type: 'started', expectedRevision: 2, idempotencyKey: 'event:start:1', actorId: 'ops_a', reason: 'Session began' })
      const completed = await repository.appendEvent({ workspaceId: 'ws_service_a', allocationId: allocation.id, type: 'completed', expectedRevision: started.allocation.revision, idempotencyKey: 'event:complete:1', actorId: 'ops_a', reason: 'Session delivered', actualQuantity: 60, evidence: { attendance_record: 'evidence://attendance/1' } })
      expect(completed.allocation).toMatchObject({ revision: 4, status: 'completed', usedQuantity: 60 })
      expect(completed.event.evidence).toEqual({ attendance_record: 'evidence://attendance/1' })

      const corrected = await repository.appendEvent({ workspaceId: 'ws_service_a', allocationId: allocation.id, type: 'adjusted', expectedRevision: 4, idempotencyKey: 'event:correct:1', actorId: 'ops_supervisor', reason: 'Verified attendance record showed 55 minutes', actualQuantity: 55, correctsEventId: completed.event.id, evidence: { review: 'evidence://audit/1' } })
      expect(corrected.allocation.usedQuantity).toBe(55)
      expect(corrected.event.before).toMatchObject({ usedQuantity: 60, correctedActualQuantity: 60 })
      expect(corrected.event.after).toMatchObject({ usedQuantity: 55, correctedActualQuantity: 55 })

      const secondSchedule = await repository.appendEvent({ workspaceId: 'ws_service_a', allocationId: allocation.id, type: 'scheduled', expectedRevision: 5, idempotencyKey: 'event:schedule:2', actorId: 'ops_a', reason: 'Customer selected another time', scheduleAt: '2026-09-12T02:00:00.000Z' })
      const secondStart = await repository.appendEvent({ workspaceId: 'ws_service_a', allocationId: allocation.id, type: 'started', expectedRevision: secondSchedule.allocation.revision, idempotencyKey: 'event:start:2', actorId: 'ops_a', reason: 'Second session began' })
      await expect(repository.appendEvent({ workspaceId: 'ws_service_a', allocationId: allocation.id, type: 'completed', expectedRevision: secondStart.allocation.revision, idempotencyKey: 'event:complete:too-large', actorId: 'ops_a', reason: 'Invalid excessive time', actualQuantity: 246, evidence: { attendance_record: 'evidence://attendance/2' } }))
        .rejects.toMatchObject({ code: 'SERVICE_FULFILLMENT_QUOTA_EXCEEDED' })

      const catalog = await database.query<{ sku_id: string; version_id: string }>("SELECT s.id AS sku_id,v.id AS version_id FROM commercial_catalog_skus s JOIN commercial_catalog_sku_versions v ON v.sku_id=s.id WHERE s.code='onboarding_once'")
      await database.query(`INSERT INTO commercial_orders_v2 (id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id) VALUES ('onboarding_order_a','ws_service_a',$1,$2,500000,'CNY','sandbox','pending','order-a',$3,'ops_a')`, [catalog.rows[0]!.sku_id, catalog.rows[0]!.version_id, 'b'.repeat(64)])
      const draftInput = { workspaceId: 'ws_service_a', onboardingOrderId: 'onboarding_order_a', entitlementSnapshotId: 'order_snapshot_a', sourceChecksum: 'c'.repeat(64), actorId: 'ops_a', reason: 'Create unresolved schedule from verified onboarding order', evidence: { order: 'evidence://order/onboarding-a' } }
      const drafts = await repository.saveOnboardingGrantScheduleDraft(draftInput)
      expect(drafts).toHaveLength(6)
      expect(drafts.map(row => row.sequence)).toEqual([1, 2, 3, 4, 5, 6])
      expect(drafts.every(row => row.points === 500 && row.status === 'unresolved' && row.dueAt === null && row.expiresAt === null)).toBe(true)
      expect(drafts.every(row => row.createdByActorId === 'ops_a' && row.creationEvidence.order === 'evidence://order/onboarding-a')).toBe(true)
      expect(await repository.saveOnboardingGrantScheduleDraft(draftInput)).toEqual(drafts)
      await expect(repository.saveOnboardingGrantScheduleDraft({ ...draftInput, sourceChecksum: 'd'.repeat(64) }))
        .rejects.toBeInstanceOf(ServiceFulfillmentRepositoryError)

      await expect(database.query("UPDATE workspace_service_fulfillment_events SET reason='tamper' WHERE workspace_id='ws_service_a'"))
        .rejects.toMatchObject({ code: '55000' })
      await expect(database.query("DELETE FROM onboarding_point_grant_schedules_v2 WHERE workspace_id='ws_service_a'"))
        .rejects.toMatchObject({ code: '55000' })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
