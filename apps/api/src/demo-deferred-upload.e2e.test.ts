import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let api: typeof import('./server.js')
let base = ''
let storageRoot = ''

describe('ECS demo upload without malware scanning', () => {
  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'merchant-deferred-upload-'))
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

  it('requires the explicit demo configuration for the scanner readiness exception', () => {
    const env = { NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'ecs', ASSET_SCANNER_MODE: 'deferred', DEMO_UNSCANNED_ASSETS_ENABLED: 'true' }
    expect(api.demoUnscannedAssetsEnabled(env)).toBe(true)
    expect(api.productionReadinessDiagnostics(env).gates.asset_scanner).toEqual({ ready: true, reasons: [] })
    expect(api.productionReadinessDiagnostics({ ...env, DEMO_UNSCANNED_ASSETS_ENABLED: 'false' }).gates.asset_scanner?.ready).toBe(false)
    expect(api.scannerHeartbeatRequiredForProbe('/readyz', env)).toBe(false)
  })

  it('uploads and uses unscanned bytes only in the owning workspace', async () => {
    const workspaceId = `ws_demo_deferred_${Date.now()}`
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    const bytes = new TextEncoder().encode('title: 轻便外套\nstock: 8')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const headers = { 'x-workspace-id': workspaceId }
    const response = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain', 'x-asset-name': 'details.txt', 'x-asset-sha256': sha256 }, body: bytes })
    const uploaded = await response.json() as { data?: { id: string; scanStatus: string; sha256: string; scanReceiptId?: string }; error?: { code: string } }
    expect(response.status).toBe(201)
    expect(uploaded.error).toBeNull()
    expect(uploaded.data).toMatchObject({ scanStatus: 'unscanned', sha256 })
    expect(uploaded.data?.scanReceiptId).toBeUndefined()
    expect(() => api.assetScanJobIdForTests(workspaceId, uploaded.data!.id)).toThrow('ASSET_SCAN_JOB_NOT_FOUND')

    const download = await fetch(`${base}/v1/assets/${uploaded.data!.id}/download`, { headers })
    expect(download.status).toBe(200)
    expect(Buffer.from(await download.arrayBuffer())).toEqual(Buffer.from(bytes))
    const foreign = await fetch(`${base}/v1/assets/${uploaded.data!.id}/download`, { headers: { 'x-workspace-id': 'ws_other' } })
    expect(foreign.status).toBe(404)
    const parse = await fetch(`${base}/v1/assets/${uploaded.data!.id}/parse`, { method: 'POST', headers })
    expect(parse.status).toBe(200)
  })
})
