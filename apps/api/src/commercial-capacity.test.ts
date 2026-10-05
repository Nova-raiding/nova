import { describe, expect, it, vi } from 'vitest'
import { createCommercialCapacity } from './commercial-capacity.js'
describe('production commercial capacity authority', () => {
  it('does not read or allow legacy subscription quotas when authoritative repository is missing', async () => {
    const legacyGet = vi.fn(async () => ({ includedStores: 999999 }))
    const capacity = createCommercialCapacity({ persistence: () => ({}), memoryCommercial: {} as never,
      memorySubscriptions: { get: legacyGet } as never, service: { listPlatformAccounts: () => [] }, isProduction: () => true })
    await expect(capacity.storeCapacity('ws_no_authority')).rejects.toMatchObject({ code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE', status: 503 })
    await expect(capacity.requireStorageCapacityLimit('ws_no_authority')).rejects.toMatchObject({ code: 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE', status: 503 })
    expect(legacyGet).not.toHaveBeenCalled()
  })
})
