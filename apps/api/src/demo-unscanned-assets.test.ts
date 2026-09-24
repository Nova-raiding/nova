import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let api: typeof import('./server.js')
let base = ''
let storageRoot = ''

async function envelope(response: Response) {
  return await response.json() as { data: Record<string, any> | null; error: { code: string } | null }
}

describe('ECS deferred demo assets', () => {
  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'merchant-demo-unscanned-'))
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('DEPLOYMENT_PROFILE', 'ecs')
    vi.stubEnv('ASSET_SCANNER_MODE', 'deferred')
    vi.stubEnv('DEMO_UNSCANNED_ASSETS_ENABLED', 'true')
    vi.stubEnv('ASSET_STORAGE_ROOT', storageRoot)
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    api = await import('./server.js')
    await new Promise<void>((resolve, reject) => {
      api.server.once('error', reject)
      api.server.listen(0, '127.0.0.1', resolve)
    })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    vi.unstubAllEnvs()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('requires explicit ECS deferred settings and skips only that scanner heartbeat', () => {
    const env = { NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs', ASSET_SCANNER_MODE: 'deferred', DEMO_UNSCANNED_ASSETS_ENABLED: 'true' }
    expect(api.demoUnscannedAssetsEnabled(env)).toBe(true)
    for (const key of ['DEPLOYMENT_PROFILE', 'ASSET_SCANNER_MODE', 'DEMO_UNSCANNED_ASSETS_ENABLED'] as const) {
      const changed = { ...env }
      delete (changed as Record<string, string | undefined>)[key]
      expect(api.demoUnscannedAssetsEnabled(changed)).toBe(false)
    }
    expect(api.scannerHeartbeatRequiredForProbe('/readyz', env)).toBe(false)
    expect(api.scannerHeartbeatRequiredForProbe('/readyz', { ...env, ASSET_SCANNER_MODE: 'clamav_worker' })).toBe(true)
    expect(api.productionReadinessDiagnostics(env).gates.asset_scanner?.ready).toBe(true)
    expect(api.productionReadinessDiagnostics({ ...env, DEMO_UNSCANNED_ASSETS_ENABLED: 'false' }).gates.asset_scanner?.ready).toBe(false)
  })

  it('uploads unscanned bytes, parses and downloads them within the workspace without scheduling a scan', async () => {
    const workspaceId = `ws_demo_unscanned_${Date.now()}`
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    const bytes = new TextEncoder().encode('title: 轻便外套\nstock: 8')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const headers = { 'x-workspace-id': workspaceId }
    const response = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain', 'x-asset-name': 'details.txt', 'x-asset-sha256': sha256 }, body: bytes })
    const uploaded = await envelope(response)
    expect(response.status).toBe(201)
    expect(uploaded.error).toBeNull()
    expect(uploaded.data).toMatchObject({ scanStatus: 'unscanned', sha256, sizeBytes: bytes.byteLength })
    expect(uploaded.data?.scanReceiptId).toBeUndefined()
    expect(uploaded.data?.storageKey).toMatch(new RegExp(`^quarantine/${workspaceId}/`))
    expect(() => api.assetScanJobIdForTests(workspaceId, String(uploaded.data?.id))).toThrow('ASSET_SCAN_JOB_NOT_FOUND')
    const download = await fetch(`${base}/v1/assets/${uploaded.data?.id}/download`, { headers })
    expect(download.status).toBe(200)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes)
    const crossWorkspace = await fetch(`${base}/v1/assets/${uploaded.data?.id}/download`, { headers: { 'x-workspace-id': 'ws_other' } })
    expect(crossWorkspace.status).toBe(404)
    const parsedResponse = await fetch(`${base}/v1/assets/${uploaded.data?.id}/parse`, { method: 'POST', headers })
    const parsed = await envelope(parsedResponse)
    expect(parsedResponse.status).toBe(200)
    expect(parsed.data).toMatchObject({ parseStatus: 'succeeded', extractedFacts: { title: '轻便外套', stock: '8' } })
  })

  it('keeps ordinary uploads quarantined with the demo gate disabled', async () => {
    vi.stubEnv('DEMO_UNSCANNED_ASSETS_ENABLED', 'false')
    try {
      const workspaceId = `ws_demo_default_${Date.now()}`
      await api.grantCreativePointsForTests(workspaceId)
      api.grantContinuousFeatureEntitlementForTests(workspaceId)
      const response = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { 'x-workspace-id': workspaceId, 'content-type': 'text/plain', 'x-asset-name': 'default.txt' }, body: new TextEncoder().encode('title: default route') })
      const uploaded = await envelope(response)
      expect(response.status).toBe(201)
      expect(uploaded.data?.scanStatus).toBe('quarantined')
      expect(api.assetScanJobIdForTests(workspaceId, String(uploaded.data?.id))).toBeTruthy()
    } finally {
      vi.stubEnv('DEMO_UNSCANNED_ASSETS_ENABLED', 'true')
    }
  })
})
