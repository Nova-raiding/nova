import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let api: typeof import('./server.js')
let base = ''
let storageRoot = ''

function validPngHeader(width: number, height: number) {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8); bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  let crc = 0xffffffff
  for (const byte of bytes.subarray(12, 29)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29)
  return bytes
}

describe('asset image dimensions persistence', () => {
  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'merchant-asset-dimensions-'))
    vi.stubEnv('ASSET_STORAGE_ROOT', storageRoot)
    vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DEPLOYMENT_PROFILE', 'local_acceptance'); vi.stubEnv('LOCAL_COMPOSE', 'true'); vi.stubEnv('ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'true')
    api = await import('./server.js')
    await new Promise<void>((resolve, reject) => {
      api.server.once('error', reject)
      api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', reject); resolve() })
    })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    base = `http://127.0.0.1:${address.port}`
  })
  afterAll(async () => {
    if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    await rm(storageRoot, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })

  it('persists dimensions with the uploaded bytes and serves them again on a fresh list read', async () => {
    const workspace = `ws_asset_dimensions_${Date.now()}`
    await api.grantCreativePointsForTests(workspace)
    api.grantContinuousFeatureEntitlementForTests(workspace)
    const response = await fetch(`${base}/v1/assets/upload`, { method: 'POST', headers: { 'x-workspace-id': workspace, 'content-type': 'image/png', 'x-asset-name': 'proof.png' }, body: validPngHeader(1280, 720) })
    expect(response.status).toBe(201)
    const uploaded = (await response.json() as { data: { id: string; sha256: string; sourceRevision: number; imageDimensions?: unknown } }).data
    expect(uploaded.imageDimensions).toEqual({ width: 1280, height: 720, sha256: uploaded.sha256, sourceRevision: uploaded.sourceRevision })
    const refreshed = await fetch(`${base}/v1/assets`, { headers: { 'x-workspace-id': workspace } }).then(r => r.json()) as { data: Array<{ id: string; sha256: string; sourceRevision: number; imageDimensions?: unknown }> }
    expect(refreshed.data.find(row => row.id === uploaded.id)?.imageDimensions).toEqual(uploaded.imageDimensions)
  })

})
