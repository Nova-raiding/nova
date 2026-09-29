import { afterAll, describe, expect, it, vi } from 'vitest'

const api = await import('./server.js')

type Envelope = {
  data?: { result?: { job_id?: string; execution?: { state?: string }; job?: { id?: string; state?: string } } } | null
  error?: { code?: string; message?: string } | null
}

describe('image generation receipt replay', () => {
  afterAll(async () => {
    if (api.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('returns the original job handle without reserving points again', async () => {
    const workspaceId = `ws_image_receipt_${crypto.randomUUID()}`
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    const product = api.service.importProduct({ workspaceId, platform: 'taobao', title: '幂等图片回执商品', category: '鞋服', stock: 1 })
    api.service.confirmProductFacts(workspaceId, product.id)
    const idempotencyKey = `image-receipt-${crypto.randomUUID()}`
    const direction = '纯净白底商品主图'
    const existing = api.service.enqueueImageGeneration({ workspaceId, productId: product.id, imageMode: 'create', direction, count: 1, idempotencyKey })
    await api.creativePointsForTests.reserve({ workspaceId, actionKey: `image:${idempotencyKey}`, idempotencyKey: `commercial.reserve:image:${idempotencyKey}`, points: 1, rateCardVersion: 'receipt-replay-v1' })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      api.server.once('error', onError)
      api.server.listen(0, '127.0.0.1', () => {
        api.server.removeListener('error', onError)
        resolve()
      })
    })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('API did not bind')
    const call = (id: number) => fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-test-commercial-fixture': 'server-e2e' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'catalog.image.generate', params: { workspace_id: workspaceId, product_id: product.id, mode: 'create', direction, count: '1', idempotency_key: idempotencyKey } }),
    }).then(async response => ({ status: response.status, body: await response.json() as Envelope }))

    const replay = await call(1)
    expect(replay.status, JSON.stringify(replay.body)).toBe(200)
    expect(replay.body.error).toBeNull()
    expect(replay.body.data?.result).toMatchObject({ job_id: existing.id, job: { jobId: existing.id } })

    const reservation = await api.creativePointsForTests.getReservationByActionKey(workspaceId, `image:${idempotencyKey}`)
    expect(reservation).toMatchObject({ status: 'active', points: 1 })
  })
})
