import { describe, expect, it, vi } from 'vitest'
import type { AssetMetadata } from '../../../packages/application/src/service.js'
import { BusinessSnapshotNotFoundError } from '../../../packages/persistence/src/business-repository.js'
import { requireCustomerDeliveryAsset } from './customer-delivery-assets.js'

const workspaceId = 'ws_delivery_asset_boundary'
const assetRef = 'asset_delivery_boundary'
const purposes = ['contract', 'video'] as const

// These are dependency-boundary fixtures, not evidence of a real upload,
// scanner run, signed-receipt admission, or PostgreSQL persistence.
function cleanFixture(overrides: Partial<AssetMetadata> = {}): AssetMetadata {
  return {
    id: assetRef,
    workspaceId,
    name: 'delivery.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 128,
    sha256: 'a'.repeat(64),
    storageKey: `clean/${workspaceId}/${assetRef}/source`,
    rightsStatus: 'pending',
    scanStatus: 'clean',
    scanVerdict: 'clean',
    scanReceiptId: 'receipt:delivery-boundary',
    scanReceiptDigest: 'b'.repeat(64),
    parseStatus: 'pending',
    contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
    references: [],
    revision: 1,
    createdAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  }
}

function memoryCache(asset = cleanFixture()) {
  const assets = new Map<string, AssetMetadata>([[assetRef, asset]])
  const get = vi.spyOn(assets, 'get')
  return { assets, get }
}

function notReady(purpose: typeof purposes[number]) {
  return { code: `CUSTOMER_DELIVERY_${purpose.toUpperCase()}_ASSET_NOT_READY`, status: 409 }
}

describe('customer delivery asset source boundary (unit fixtures, no scanner)', () => {
  it.each(purposes)('accepts fresh durable %s evidence without reading a stale rejected cache entry', async purpose => {
    const cache = memoryCache(cleanFixture({ scanStatus: 'blocked', scanVerdict: 'malicious' }))
    const asset = cleanFixture(purpose === 'contract' ? { mimeType: 'application/pdf' } : {})
    const get = vi.fn().mockResolvedValue({ payload: { ...asset } })

    await expect(requireCustomerDeliveryAsset({ workspaceId, assetRef, purpose, business: { get }, memoryAssets: cache.assets })).resolves.toBeUndefined()

    expect(get).toHaveBeenCalledExactlyOnceWith(workspaceId, 'asset', assetRef)
    expect(cache.get).not.toHaveBeenCalled()
  })

  it.each(purposes)('does not fall back to cached clean %s evidence after a durable miss', async purpose => {
    const cache = memoryCache()
    const get = vi.fn().mockRejectedValue(new BusinessSnapshotNotFoundError())

    await expect(requireCustomerDeliveryAsset({ workspaceId, assetRef, purpose, business: { get }, memoryAssets: cache.assets })).rejects.toMatchObject(notReady(purpose))

    expect(get).toHaveBeenCalledExactlyOnceWith(workspaceId, 'asset', assetRef)
    expect(cache.get).not.toHaveBeenCalled()
  })

  it.each(purposes)('re-reads durable %s evidence and rejects a revoked asset despite a clean cache', async purpose => {
    const cache = memoryCache()
    const get = vi.fn()
      .mockResolvedValueOnce({ payload: { ...cleanFixture() } })
      .mockResolvedValueOnce({ payload: { ...cleanFixture({ scanStatus: 'blocked', scanVerdict: 'malicious', revision: 2 }) } })
    const input = { workspaceId, assetRef, purpose, business: { get }, memoryAssets: cache.assets }

    await expect(requireCustomerDeliveryAsset(input)).resolves.toBeUndefined()
    await expect(requireCustomerDeliveryAsset(input)).rejects.toMatchObject(notReady(purpose))

    expect(get).toHaveBeenCalledTimes(2)
    expect(get).toHaveBeenNthCalledWith(1, workspaceId, 'asset', assetRef)
    expect(get).toHaveBeenNthCalledWith(2, workspaceId, 'asset', assetRef)
    expect(cache.get).not.toHaveBeenCalled()
  })

  it('propagates the original database error instead of masking it or consulting cache', async () => {
    const cache = memoryCache()
    const failure = new Error('isolated dependency fixture: database unavailable')
    const get = vi.fn().mockRejectedValue(failure)

    await expect(requireCustomerDeliveryAsset({ workspaceId, assetRef, purpose: 'video', business: { get }, memoryAssets: cache.assets })).rejects.toBe(failure)

    expect(cache.get).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong workspace', { workspaceId: 'ws_other' }],
    ['wrong asset id', { id: 'asset_other' }],
    ['missing receipt id', { scanReceiptId: undefined }],
    ['empty receipt id', { scanReceiptId: '' }],
    ['missing receipt digest', { scanReceiptDigest: undefined }],
    ['invalid receipt digest', { scanReceiptDigest: 'not-a-sha256' }],
    ['missing clean verdict', { scanVerdict: undefined }],
    ['quarantined asset', { scanStatus: 'quarantined' }],
    ['wrong storage workspace', { storageKey: `clean/ws_other/${assetRef}/source` }],
    ['quarantine storage path', { storageKey: `quarantine/${workspaceId}/${assetRef}/source` }],
    ['traversal storage path', { storageKey: `clean/${workspaceId}/${assetRef}/../source` }],
    ['empty storage path segment', { storageKey: `clean/${workspaceId}//source` }],
    ['backslash storage path', { storageKey: `clean/${workspaceId}/${assetRef}\\source` }],
    ['leading whitespace storage path', { storageKey: ` clean/${workspaceId}/${assetRef}/source` }],
  ] satisfies Array<[string, Partial<AssetMetadata>]>)('rejects durable %s without using a clean cache', async (_label, overrides) => {
    const cache = memoryCache()
    const get = vi.fn().mockResolvedValue({ payload: { ...cleanFixture(overrides) } })

    await expect(requireCustomerDeliveryAsset({ workspaceId, assetRef, purpose: 'contract', business: { get }, memoryAssets: cache.assets })).rejects.toMatchObject(notReady('contract'))

    expect(cache.get).not.toHaveBeenCalled()
  })

  it('does not accept a clean non-video asset for video delivery', async () => {
    const cache = memoryCache()
    const get = vi.fn().mockResolvedValue({ payload: { ...cleanFixture({ mimeType: 'application/pdf' }) } })

    await expect(requireCustomerDeliveryAsset({ workspaceId, assetRef, purpose: 'video', business: { get }, memoryAssets: cache.assets })).rejects.toMatchObject(notReady('video'))
    expect(cache.get).not.toHaveBeenCalled()
  })

  it('uses the in-memory fixture only when no durable source is configured', async () => {
    const cache = memoryCache()

    await expect(requireCustomerDeliveryAsset({ workspaceId, assetRef, purpose: 'video', memoryAssets: cache.assets })).resolves.toBeUndefined()

    expect(cache.get).toHaveBeenCalledExactlyOnceWith(assetRef)
  })
})
