import { describe, expect, it, vi } from 'vitest'
import { planOnboardingDeliveryChecklist, planOnboardingGrantSchedule, ServiceFulfillmentError, ServiceFulfillmentService, type ServiceAllocation, type ServiceFulfillmentEvent } from './service-fulfillment.js'

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

describe('onboarding delivery checklist planning', () => {
  it('keeps source-listed delivery items and unresolved product limit explicit', () => {
    const items = planOnboardingDeliveryChecklist({ sourceChecksum: 'a'.repeat(64), maxBrands: 1, maxStores: 5, maxProducts: null, platforms: ['taobao', 'tmall', 'jd', 'pinduoduo', 'douyin', 'xiaohongshu'] })
    expect(items.map(item => item.itemCode)).toEqual(expect.arrayContaining(['plugin_account_activation', 'system_usage_training', 'launch_acceptance', 'store_initial_scan_entry', 'product_initial_scan_entry', 'brand_asset_initial_entry']))
    expect(items.find(item => item.itemCode === 'store_initial_scan_entry')).toMatchObject({ quantity: 5, status: 'allocated' })
    expect(items.find(item => item.itemCode === 'brand_asset_initial_entry')).toMatchObject({ quantity: 1, status: 'allocated' })
    expect(items.find(item => item.itemCode === 'product_initial_scan_entry')).toMatchObject({ quantity: null, status: 'unresolved', blockers: ['PRODUCT_INITIAL_IMPORT_LIMIT_UNRESOLVED'] })
  })

  it('rejects non-standard platforms rather than inventing a connector', () => {
    expect(() => planOnboardingDeliveryChecklist({ sourceChecksum: 'a'.repeat(64), maxBrands: 1, maxStores: 5, maxProducts: 10, platforms: ['erp' as never] })).toThrow(/platform/i)
  })
})

describe('ServiceFulfillmentService', () => {
  const input = { workspaceId: 'ws_a', allocationId: 'svc_1', type: 'scheduled' as const, expectedRevision: 1, idempotencyKey: 'idem_1', actorId: 'ops_1', reason: 'customer requested session', scheduleAt: '2026-09-05T02:00:00.000Z', evidence: { request: 'evidence://schedule/1' } }
  const build = (overrides: { points?: number | null; state?: 'known' | 'unknown'; allowed?: boolean; authorized?: boolean } = {}) => {
    const repository = { createAllocation: vi.fn().mockResolvedValue(allocation), appendEvent: vi.fn().mockResolvedValue({ allocation, event }) }
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

  it('creates an allocation only from revision zero and verified evidence', async () => {
    const { service, repository } = build()
    const command = { workspaceId: 'ws_a', expectedRevision: 0 as const, idempotencyKey: 'allocation_1', actorId: 'ops_1', reason: 'verified order', orderSnapshotId: 'order_snapshot_1', entitlementSnapshotId: 'entitlement_snapshot_1', serviceType: 'one_to_one', unit: 'minute' as const, allocatedQuantity: 300, periodStart: '2026-09-01T00:00:00.000Z', periodEnd: '2026-10-01T00:00:00.000Z', sourceChecksum: 'a'.repeat(64), evidence: { order: 'evidence://order/1' } }
    await expect(service.create(command)).resolves.toEqual({ allocation, accessRevision: '7' })
    expect(repository.createAllocation).toHaveBeenCalledOnce()
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
    await expect(service.record({ ...input, type: 'completed', actualQuantity: 30, scheduleAt: null, evidence: {} })).rejects.toBeInstanceOf(ServiceFulfillmentError)
    await expect(service.record({ ...input, type: 'adjusted', actualQuantity: 20, scheduleAt: null })).rejects.toBeInstanceOf(ServiceFulfillmentError)
    expect(repository.appendEvent).not.toHaveBeenCalled()
  })
})
