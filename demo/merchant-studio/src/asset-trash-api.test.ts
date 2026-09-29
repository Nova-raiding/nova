import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelAssetPurge, fetchTrashedAssets, requestAssetPurge, restoreAsset, trashAsset, type AssetMetadata, type TrashedAsset } from './api.js'

const asset: AssetMetadata = {
  id: 'asset/one', name: '主图.png', mimeType: 'image/png', sizeBytes: 128,
  rightsStatus: 'pending', scanStatus: 'clean', parseStatus: 'pending',
  contentTrust: { classification: 'untrusted', mode: 'data_only', canOverrideInstructions: false, canTriggerTools: false, requiresMerchantConfirmation: true },
  references: [], revision: 2, createdAt: '2026-09-29T00:00:00Z',
}

const deleted: TrashedAsset = {
  asset, deleted_at: '2026-09-29T01:00:00Z', expires_at: '2026-10-06T01:00:00Z', deleted_by: 'merchant-1', revision: 3,
}

function response(data: unknown) {
  return new Response(JSON.stringify({ request_id: 'request-1', trace_id: 'trace-1', workspace_id: 'ws_demo', data, warnings: [], next_actions: [], error: null }), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => vi.unstubAllGlobals())

function stubBrowserTimer() {
  vi.stubGlobal('window', {
    setTimeout: (callback: () => void) => globalThis.setTimeout(callback, 60_000),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
    dispatchEvent: () => true,
  })
}

describe('server-backed asset recycle-bin API', () => {
  it('reads the server recycle-bin rows and preserves deletion metadata', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ items: [deleted], total: 1, limit: 100, offset: 0 }))
    vi.stubGlobal('fetch', fetch)
    stubBrowserTimer()

    await expect(fetchTrashedAssets('/api')).resolves.toEqual([deleted])
    expect(fetch.mock.calls[0]?.[0]).toContain('/v1/assets/trash')
  })

  it('posts soft delete and URL-encodes the asset id', async () => {
    const fetch = vi.fn().mockResolvedValue(response(deleted))
    vi.stubGlobal('fetch', fetch)
    stubBrowserTimer()

    await expect(trashAsset('/api', asset.id)).resolves.toEqual(deleted)
    expect(fetch.mock.calls[0]?.[0]).toContain('/v1/assets/asset%2Fone/trash')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
  })

  it('posts restore and returns the canonical asset metadata', async () => {
    const restored = { ...asset, revision: 4 }
    const fetch = vi.fn().mockResolvedValue(response(restored))
    vi.stubGlobal('fetch', fetch)
    stubBrowserTimer()

    await expect(restoreAsset('/api', asset.id)).resolves.toEqual(restored)
    expect(fetch.mock.calls[0]?.[0]).toContain('/v1/assets/asset%2Fone/restore')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
  })

  it('posts an audited early-purge request with confirmation, reason and revision', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ asset_id: asset.id, purge_requested_at: '2026-09-29T02:00:00Z', revision: 4, status: 'purge_queued' }))
    vi.stubGlobal('fetch', fetch)
    stubBrowserTimer()
    await expect(requestAssetPurge('/api', { assetId: asset.id, assetName: asset.name, reason: '已确认提前删除', expectedRevision: 3 })).resolves.toMatchObject({ status: 'purge_queued', revision: 4 })
    expect(fetch.mock.calls[0]?.[0]).toContain('/v1/assets/asset%2Fone/purge')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ confirm_asset_name: asset.name, reason: '已确认提前删除', expected_revision: 3 }) })
  })

  it('posts revision-fenced cancellation for a purge request before worker claim', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ asset_id: asset.id, expires_at: deleted.expires_at, revision: 5, status: 'purge_cancelled' }))
    vi.stubGlobal('fetch', fetch)
    stubBrowserTimer()
    await expect(cancelAssetPurge('/api', asset.id, 4)).resolves.toMatchObject({ status: 'purge_cancelled', revision: 5 })
    expect(fetch.mock.calls[0]?.[0]).toContain('/v1/assets/asset%2Fone/purge/cancel')
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ expected_revision: 4 }) })
  })
})
