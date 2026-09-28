import { describe, expect, it } from 'vitest'
import { normalizeCurrentCommercialEntitlement } from './api.js'

describe('merchant current plan V2 read', () => {
  const v2 = {
    schema_version: 'commercial.entitlement.v2',
    status: 'available',
    plan: 'growth',
    period: { start: '2026-09-27T12:53:13.872Z', end: '2026-10-27T12:53:13.872Z' },
    entitlement_id: 'ces_growth',
  }

  it('shows the active Growth period from the V2 entitlement only', () => {
    expect(normalizeCurrentCommercialEntitlement({ commercial_entitlement: v2 })).toEqual({
      status: 'available', plan: 'growth', period: v2.period, entitlementId: 'ces_growth',
    })
  })

  it('does not turn a legacy Trial into a current plan when V2 is absent or unknown', () => {
    const legacy = { plan: 'starter', status: 'trial' }
    expect(normalizeCurrentCommercialEntitlement({ ...legacy, legacy_commercial_entitlement: legacy })).toEqual({ status: 'unknown' })
    expect(normalizeCurrentCommercialEntitlement({ ...legacy, commercial_entitlement: { ...v2, status: 'unknown' } })).toEqual({ status: 'unknown' })
  })

  it('rejects incomplete or invalid V2 periods', () => {
    expect(normalizeCurrentCommercialEntitlement({ commercial_entitlement: { ...v2, period: { start: 'bad', end: v2.period.end } } })).toEqual({ status: 'unknown' })
    expect(normalizeCurrentCommercialEntitlement({ commercial_entitlement: { ...v2, period: { start: v2.period.end, end: v2.period.start } } })).toEqual({ status: 'unknown' })
    expect(normalizeCurrentCommercialEntitlement({ commercial_entitlement: { ...v2, entitlement_id: '' } })).toEqual({ status: 'unknown' })
  })
})
