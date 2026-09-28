import { describe, expect, it } from 'vitest'
import type { CommercialEntitlementSnapshotV2 } from '../../../packages/persistence/src/commercial-contract-repository.js'
import { readSubscriptionV2Entitlement } from './mcp-subscription-v2-projection.js'

const now = new Date('2026-09-28T00:00:00.000Z')
const snapshot: CommercialEntitlementSnapshotV2 = {
  id: 'ces_growth',
  workspaceId: 'ws_gn',
  subscriptionPeriodId: 'period_growth',
  sourceOrderId: null,
  sourceOrderStatus: null,
  periodStart: '2026-09-27T00:00:00.000Z',
  periodEnd: '2026-10-27T00:00:00.000Z',
  periodStatus: 'active',
  catalogVersionId: 'sku-version-monthly-growth-v2',
  skuCode: 'growth',
  resolvedBenefits: [{ code: 'max_brands', quantity: 3 }, { code: 'max_stores', quantity: 15 }],
  unresolvedBlockers: [],
  executable: true,
  checksum: 'a'.repeat(64),
  createdAt: '2026-09-27T00:00:00.000Z',
}

const read = (rows: readonly CommercialEntitlementSnapshotV2[]) => readSubscriptionV2Entitlement({
  workspaceId: 'ws_gn', now, listSnapshots: async (workspaceId, limit) => {
    expect(workspaceId).toBe('ws_gn')
    expect(limit).toBe(200)
    return rows
  },
})

describe('merchant subscription V2 projection', () => {
  it('shows the sole active V2 Growth snapshot without using legacy Trial fields', async () => {
    await expect(read([snapshot])).resolves.toEqual({
      schema_version: 'commercial.entitlement.v2', status: 'available',
      plan: 'growth', period: { start: snapshot.periodStart, end: snapshot.periodEnd },
      sourceVersion: snapshot.catalogVersionId, checksum: snapshot.checksum,
      entitlement_id: snapshot.id, subscription_period_id: snapshot.subscriptionPeriodId,
      code: null,
    })
  })

  it('does not disclose another tenant snapshot or promote a malformed snapshot', async () => {
    for (const row of [
      { ...snapshot, workspaceId: 'ws_other' },
      { ...snapshot, unresolvedBlockers: ['ORDER_UNVERIFIED'] },
      { ...snapshot, checksum: 'invalid' },
      { ...snapshot, periodEnd: '2026-09-27T23:59:59.999Z' },
    ]) {
      await expect(read([row])).resolves.toMatchObject({ status: 'unknown', plan: null, entitlement_id: null, code: 'COMMERCIAL_ENTITLEMENT_REQUIRED' })
    }
  })

  it('fails closed for absent, ambiguous, unavailable, and potentially truncated reads', async () => {
    await expect(read([])).resolves.toMatchObject({ status: 'unknown', code: 'COMMERCIAL_ENTITLEMENT_REQUIRED' })
    await expect(read([snapshot, { ...snapshot, id: 'ces_other' }])).resolves.toMatchObject({ status: 'unknown', code: 'COMMERCIAL_ENTITLEMENT_AMBIGUOUS' })
    await expect(readSubscriptionV2Entitlement({ workspaceId: 'ws_gn', now, listSnapshots: async () => { throw new Error('database unavailable') } }))
      .resolves.toMatchObject({ status: 'unknown', code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE' })
    await expect(read(Array.from({ length: 200 }, (_, index) => ({ ...snapshot, id: `ces_${index}` }))))
      .resolves.toMatchObject({ status: 'unknown', code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE' })
  })
})
