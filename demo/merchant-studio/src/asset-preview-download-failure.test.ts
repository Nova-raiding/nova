import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAssetBlob } from './api.js'

describe('material preview download failure', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rejects an unauthorized asset read instead of treating the error body as preview bytes', async () => {
    const fetchMock = vi.fn(async () => new Response('forbidden', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchAssetBlob('/api', 'asset-out-of-scope'))
      .rejects.toMatchObject({ message: '素材读取失败：HTTP 403', status: 403 })

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/assets/asset-out-of-scope/download', expect.objectContaining({
      credentials: 'include',
      headers: expect.any(Headers),
    }))
  })
})
