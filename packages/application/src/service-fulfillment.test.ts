import { describe, expect, it, vi } from 'vitest'
import { planOnboardingGrantSchedule, ServiceFulfillmentError, ServiceFulfillmentService, type ServiceAllocation, type ServiceFulfillmentEvent } from './service-fulfillment.js'

const allocation: ServiceAllocation = {
  id: 'svc_1', workspaceId: 'ws_a', orderSnapshotId: 'ord_snap_1', entitlementSnapshotId: 'ent_snap_1',
  serviceType: 'one_to_one', unit: 'minute', allocatedQuantity: 300, contractLabel: null,
  periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z',
  revision: 2, status: 'scheduled', usedQuantity: 0,
}
const event: ServiceFulfillmentEvent = {
  id: 'event_1', workspaceId: 'ws_a', allocationId: 'svc_1', type: 'scheduled', revision: 2,
  idempotencyKey: 'idem_1', actorId: 'ops_1', reason: 'customer requested session',
  scheduleAt: '2026-09-05T02:00:00.000Z', actualQuantity: null, correctsEventId: null,
  evidence: {}, createdAt: '2026-09-02T00:00:00.000Z',
}

describe('onboarding grant schedule planning', () => {
  it('creates exactly six stable non-executable 500-point drafts', () => {
    const rows = planOnboardingGrantSchedule({ workspaceId: 'ws_a', onboardingOrderId: 'order_a', entitlementSnapshotId: 'snapshot_a' })
    expect(rows).toHaveLength(6)
    expect(rows.map(row => row.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(rows.every(row => row.points === 500 && row.status === 'unresolved' && row.dueAt === null && row.expiresAt === null)).toBe(true)
    expect(new Set(rows.map(row => row.naturalKey)).size).toBe(6)
    expect(rows[0]?.blockers).toEqual(['ONBOARDING_GRANT_START_DATE_UNRESOLVED', 'ONBOARDING_GRANT_EXPIRY_RULE_UNRESOLVED'])
  })
})

describe('ServiceFulfillmentService', () => {
  const input = { workspaceId: 'ws_a', allocationId: 'svc_1', type: 'scheduled' as const, expectedRevision: 1, idempotencyKey: 'idem_1', actorId: 'ops_1', reason: 'customer requested session', scheduleAt: '2026-09-05T02:00:00.000Z' }
  const build = (overrides: { points?: number | null; state?: 'known' | 'unknown'; allowed?: boolean; authorized?: boolean } = {}) => {
    const repository = { appendEvent: vi.fn().mockResolvedValue({ allocation, event }) }
    const access = { decide: vi.fn().mockResolvedValue({ balanceState: overrides.state ?? 'known', availablePoints: overrides.points === undefined ? 10 : overrides.points, allowed: overrides.allowed ?? true, accessRevision: overrides.state === 'unknown' ? null : '7' }) }
    const authorization = { authorize: vi.fn().mockResolvedValue(overrides.authorized ?? true) }
    return { service: new ServiceFulfillmentService(repository, access, authorization), repository, access, authorization }
  }

  it('checks capability and positive authoritative points before persistence', async () => {
    const { service, repository, access, authorization } = build()
    await expect(service.record(input)).resolves.toEqual({ allocation, event, accessRevision: '7' })
    expect(authorization.authorize).toHaveBeenCalledBefore(access.decide)
    expect(access.decide).toHaveBeenCalledBefore(repository.appendEvent)
  })

  it.each([
    [{ points: 0, allowed: false }, 'CREATIVE_POINTS_EXHAUSTED'],
    [{ points: null, state: 'unknown' as const, allowed: false }, 'CREATIVE_POINTS_UNAVAILABLE'],
  ])('fails closed without creating a fulfillment event: %s', async (override, code) => {
    const { service, repository } = build(override)
    await expect(service.record(input)).rejects.toMatchObject({ code })
    expect(repository.appendEvent).not.toHaveBeenCalled()
  })

  it('rejects missing capability before reading commercial access', async () => {
    const { service, repository, access } = build({ authorized: false })
    await expect(service.record(input)).rejects.toMatchObject({ code: 'SERVICE_FULFILLMENT_PERMISSION_DENIED' })
    expect(access.decide).not.toHaveBeenCalled()
    expect(repository.appendEvent).not.toHaveBeenCalled()
  })

  it('requires delivery evidence for completion and explicit before-target for corrections', async () => {
    const { service, repository } = build()
    await expect(service.record({ ...input, type: 'completed', actualQuantity: 30, scheduleAt: null })).rejects.toBeInstanceOf(ServiceFulfillmentError)
    await expect(service.record({ ...input, type: 'adjusted', actualQuantity: 20, scheduleAt: null })).rejects.toBeInstanceOf(ServiceFulfillmentError)
    expect(repository.appendEvent).not.toHaveBeenCalled()
  })
})
