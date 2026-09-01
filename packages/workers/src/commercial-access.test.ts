import { describe, expect, it, vi } from 'vitest'
import type { DurableOutboxEvent } from './durable.js'
import { createCommercialAccessGuard, parseWorkerCommercialAccessSnapshot, type WorkerCommercialAccessSnapshot } from './commercial-access.js'

const now = Date.parse('2026-09-01T10:00:00.000Z')
function event(overrides: Record<string, unknown> = {}): DurableOutboxEvent {
  return {
    id: 'evt_generation', workspaceId: 'ws_a', aggregateId: 'generation_1', eventType: 'generation.requested', sequence: 1, createdAt: '2026-09-01T09:59:00.000Z',
    payload: { commercial_access_snapshot: {
      schema_version: 1, decision_id: 'commercial_enqueue_1', workspace_id: 'ws_a', operation: 'generation.execute', access_mode: 'POINT_CHARGED',
      access_revision: 'access_7', balance_state: 'known', entitlement_snapshot_id: 'entitlement_snapshot_3', entitlement_snapshot_checksum: 'a'.repeat(64),
      rate_version: 'rate_2', quoted_points: 2, reservation_id: 'reservation_1', decided_at: '2026-09-01T09:59:00.000Z', ...overrides,
    } },
  }
}

function live(snapshot: WorkerCommercialAccessSnapshot) {
  return {
    recheckId: 'commercial_recheck_1', workspaceId: snapshot.workspaceId, operation: snapshot.operation, accessMode: snapshot.accessMode,
    accessRevision: snapshot.accessRevision, balanceState: snapshot.balanceState, entitlementSnapshotId: snapshot.entitlementSnapshotId,
    entitlementSnapshotChecksum: snapshot.entitlementSnapshotChecksum, rateVersion: snapshot.rateVersion, quotedPoints: snapshot.quotedPoints,
    reservationId: snapshot.reservationId, reservationState: 'active' as const, allowed: true, ready: true, checkedAt: '2026-09-01T09:59:59.000Z',
  }
}

describe('worker commercial execution gate', () => {
  it('binds positive balance, subscription, rate and active reservation before provider I/O', async () => {
    const recheck = vi.fn(async ({ snapshot }: { snapshot: WorkerCommercialAccessSnapshot }) => live(snapshot))
    await expect(createCommercialAccessGuard(recheck, { now: () => now }).assertCommercialAccess(event(), 'generation.execute'))
      .resolves.toMatchObject({ allowed: true, ready: true, reservationState: 'active' })
    expect(recheck).toHaveBeenCalledOnce()
  })

  it('rejects missing and malformed charged snapshots before recheck', async () => {
    const recheck = vi.fn()
    const guard = createCommercialAccessGuard(recheck, { now: () => now })
    await expect(guard.assertCommercialAccess({ ...event(), payload: {} }, 'generation.execute')).rejects.toMatchObject({ code: 'COMMERCIAL_EXECUTION_SNAPSHOT_INVALID', retryable: false })
    await expect(guard.assertCommercialAccess(event({ balance_state: 'zero' }), 'generation.execute')).rejects.toMatchObject({ code: 'COMMERCIAL_EXECUTION_SNAPSHOT_INVALID' })
    await expect(guard.assertCommercialAccess(event({ reservation_id: undefined }), 'generation.execute')).rejects.toMatchObject({ code: 'COMMERCIAL_EXECUTION_SNAPSHOT_INVALID' })
    await expect(guard.assertCommercialAccess(event({ workspace_id: 'ws_b' }), 'generation.execute')).rejects.toMatchObject({ code: 'COMMERCIAL_EXECUTION_SNAPSHOT_INVALID' })
    await expect(guard.assertCommercialAccess(event({ entitlement_snapshot_id: undefined, entitlement_snapshot_checksum: undefined, subscription_snapshot_id: 'legacy_subscription', subscription_snapshot_checksum: 'a'.repeat(64) }), 'generation.execute')).rejects.toMatchObject({ code: 'COMMERCIAL_EXECUTION_SNAPSHOT_INVALID', message: expect.stringContaining('legacy subscription') })
    expect(recheck).not.toHaveBeenCalled()
  })

  it('supports point-required zero-charge work without inventing a reservation', async () => {
    const noCharge = event({ access_mode: 'POINT_REQUIRED_NO_CHARGE', quoted_points: 0, rate_version: null, reservation_id: undefined })
    const guard = createCommercialAccessGuard(async ({ snapshot }) => ({ ...live(snapshot), reservationId: undefined, reservationState: 'not_required' }), { now: () => now })
    await expect(guard.assertCommercialAccess(noCharge, 'generation.execute')).resolves.toMatchObject({ quotedPoints: 0, reservationState: 'not_required' })
    await expect(guard.assertCommercialAccess(event({ access_mode: 'POINT_REQUIRED_NO_CHARGE', quoted_points: 0, reservation_id: undefined }), 'generation.execute')).rejects.toMatchObject({ code: 'COMMERCIAL_EXECUTION_SNAPSHOT_INVALID' })
    await expect(guard.assertCommercialAccess(event({ rate_version: null }), 'generation.execute')).rejects.toMatchObject({ code: 'COMMERCIAL_EXECUTION_SNAPSHOT_INVALID' })
  })

  it('fails closed on stale revision, unavailable readiness and consumed reservation', async () => {
    const snapshot = parseWorkerCommercialAccessSnapshot(event(), 'generation.execute')
    await expect(createCommercialAccessGuard(async () => ({ ...live(snapshot), accessRevision: 'access_8' }), { now: () => now }).assertCommercialAccess(event(), 'generation.execute')).rejects.toMatchObject({ code: 'COMMERCIAL_EXECUTION_REVISION_STALE', retryable: false })
    await expect(createCommercialAccessGuard(async () => ({ ...live(snapshot), ready: false }), { now: () => now }).assertCommercialAccess(event(), 'generation.execute')).rejects.toMatchObject({ code: 'COMMERCIAL_EXECUTION_NOT_READY', retryable: true })
    await expect(createCommercialAccessGuard(async () => ({ ...live(snapshot), reservationState: 'consumed' }), { now: () => now }).assertCommercialAccess(event(), 'generation.execute')).rejects.toMatchObject({ code: 'COMMERCIAL_EXECUTION_RESERVATION_INVALID', retryable: false })
  })
})
