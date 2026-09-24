import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let server: typeof import('./server.js').server
let grantCreativePointsForTests: typeof import('./server.js').grantCreativePointsForTests
let grantContinuousFeatureEntitlementForTests: typeof import('./server.js').grantContinuousFeatureEntitlementForTests
let service: typeof import('./server.js').service
const originalFetch = globalThis.fetch
let base = ''

beforeAll(async () => {
  vi.stubEnv('DEPLOYMENT_PROFILE', 'ecs')
  vi.stubEnv('ASSET_SCANNER_MODE', 'deferred')
  vi.stubEnv('DEMO_UNSCANNED_ASSETS_ENABLED', 'true')
  const module = await import('./server.js')
  server = module.server
  grantCreativePointsForTests = module.grantCreativePointsForTests
  grantContinuousFeatureEntitlementForTests = module.grantContinuousFeatureEntitlementForTests
  service = module.service
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  base = `http://127.0.0.1:${address.port}`
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(base)) return originalFetch(input, init)
    const headers = new Headers(init?.headers)
    headers.set('x-test-commercial-fixture', 'server-e2e')
    return originalFetch(input, { ...init, headers })
  }
})

afterAll(async () => {
  globalThis.fetch = originalFetch
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('explicit demo unscanned generated image', () => {
  it('returns an archived image without creating a scanner receipt', async () => {
    const workspaceId = 'ws_demo'
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const generate = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'catalog.image.generate', params: { product_id: 'prod_fixture_1', count: '1', direction: '白底主图' } }) }).then(response => response.json()) as any
    expect(generate.error).toBeNull()
    const job = generate.data.result.job
    expect(job.archiveState).toBe('archived')
    expect(job.candidates[0].scanStatus).toBe('unscanned')
    expect(service.assets.get(job.candidates[0].assetId)).toMatchObject({ scanStatus: 'unscanned' })
    expect(service.assets.get(job.candidates[0].assetId)?.scanReceiptId).toBeUndefined()
    const get = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'catalog.image.get', params: { job_id: job.jobId } }) }).then(response => response.json()) as any
    expect(get.error).toBeNull()
    expect(get.data.result.images).toHaveLength(1)
    expect(get.data.result.images[0]).toMatch(/^data:image\//u)
  })
})
