import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let api: typeof import('./server.js')
let base = ''
let storageRoot = ''
const workspaceId = `ws_demo_mcp_${Date.now()}`

async function call(method: string, params: Record<string, unknown>, id = 1) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'merchant-owner' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })
  return await response.json() as { data?: { result?: any }; error?: { code: string } }
}

describe('MCP deferred demo asset upload', () => {
  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'merchant-demo-mcp-'))
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('DEPLOYMENT_PROFILE', 'ecs')
    vi.stubEnv('ASSET_SCANNER_MODE', 'deferred')
    vi.stubEnv('DEMO_UNSCANNED_ASSETS_ENABLED', 'true')
    vi.stubEnv('ASSET_STORAGE_ROOT', storageRoot)
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    api = await import('./server.js')
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    await new Promise<void>((resolve, reject) => { api.server.once('error', reject); api.server.listen(0, '127.0.0.1', resolve) })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    vi.unstubAllEnvs()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('uploads one asset without receipt or scanner job and reads it through the authenticated workspace', async () => {
    const bytes = Buffer.from('title: MCP 外套\nstock: 5')
    const uploaded = await call('asset.upload', { name: 'mcp-details.txt', mime_type: 'text/plain', content_base64: bytes.toString('base64') })
    expect(uploaded.error).toBeNull()
    const asset = uploaded.data?.result
    expect(asset).toMatchObject({ scanStatus: 'unscanned', sizeBytes: bytes.byteLength })
    expect(asset.scanReceiptId).toBeUndefined()
    expect(() => api.assetScanJobIdForTests(workspaceId, asset.id)).toThrow('ASSET_SCAN_JOB_NOT_FOUND')
    const download = await fetch(`${base}/v1/assets/${asset.id}/download`, { headers: { 'x-workspace-id': workspaceId } })
    expect(download.status).toBe(200)
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes)
    const parsed = await call('asset.parse', { asset_id: asset.id }, 2)
    expect(parsed.error).toBeNull()
    expect(parsed.data?.result).toMatchObject({ parseStatus: 'succeeded', extractedFacts: { title: 'MCP 外套', stock: '5' } })
  })

  it('uses the same unscanned path per accepted batch item and rejects unsafe content', async () => {
    const items = [
      { name: 'batch-a.txt', mime_type: 'text/plain', content_base64: Buffer.from('batch source a').toString('base64') },
      { name: 'batch-malware.png', mime_type: 'image/png', content_base64: Buffer.from('MZ executable').toString('base64') },
      { name: 'batch-b.txt', mime_type: 'text/plain', content_base64: Buffer.from('batch source b').toString('base64') },
    ]
    const batch = await call('asset.upload.batch', { assets_json: JSON.stringify(items) }, 3)
    expect(batch.error).toBeNull()
    expect(batch.data?.result).toMatchObject({ succeeded: 2, failed: 1, partial: true })
    for (const asset of batch.data?.result.assets as Array<{ id: string; scanStatus: string }>) {
      expect(asset.scanStatus).toBe('unscanned')
      expect(() => api.assetScanJobIdForTests(workspaceId, asset.id)).toThrow('ASSET_SCAN_JOB_NOT_FOUND')
    }
    expect(batch.data?.result.items[1].error.code).toBe('ASSET_EXECUTABLE_REJECTED')
  })
})
