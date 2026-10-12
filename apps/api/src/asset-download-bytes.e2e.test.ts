import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LocalObjectStorage } from '../../../packages/storage/src/object-storage.js'

// This suite deliberately exercises the API's memory persistence fixture. It
// preserves upload/download byte-integrity coverage without claiming PG/RLS proof.
const workspaceId = `ws_asset_bytes_memory_${randomUUID().replaceAll('-', '')}`
const apiToken = `asset-bytes-memory-${randomUUID()}`
let api: typeof import('./server.js') | undefined
let storageRoot = ''
let base = ''
let removeStorageOverride: (() => void) | undefined
let storage: LocalObjectStorage & { get: ReturnType<typeof vi.fn> }

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null }

describe('memory-only asset upload/download byte integrity', () => {
  beforeAll(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'memory-asset-download-'))
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('PERSISTENCE_MODE', 'memory')
    vi.stubEnv('DATABASE_URL', '')
    vi.stubEnv('OPS_DATABASE_URL', '')
    vi.stubEnv('RUN_MIGRATIONS_ON_STARTUP', 'false')
    vi.stubEnv('DEPLOYMENT_PROFILE', 'local_acceptance')
    vi.stubEnv('LOCAL_COMPOSE', 'true')
    vi.stubEnv('API_BIND_HOST', '127.0.0.1')
    vi.stubEnv('PORT', '0')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'memory-asset-bytes-test-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [apiToken]: { workspaces: [workspaceId], actor_id: 'asset-bytes-owner', roles: ['workspace_owner'], workbenches: ['workspace'] },
    }))
    vi.stubEnv('ASSET_STORAGE_ROOT', storageRoot)
    vi.stubEnv('ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'true')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')

    api = await import('./server.js')
    expect((await api.persistenceReady).mode).toBe('memory')
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: 'asset-bytes-owner', displayName: 'Asset Bytes Owner', role: 'workspace_owner', status: 'active', invitedBy: 'memory-asset-bytes-test' })
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)

    const local = new LocalObjectStorage(storageRoot)
    storage = Object.assign(local, { get: vi.fn(local.get.bind(local)) })
    removeStorageOverride = api.setAssetStorageForTests(storage)
    if (!api.server.listening) {
      await new Promise<void>((resolve, reject) => {
        api!.server.once('listening', resolve)
        api!.server.once('error', reject)
        api!.server.listen(0, '127.0.0.1')
      })
    }
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('ASSET_DOWNLOAD_TEST_SERVER_BIND_FAILED')
    base = `http://127.0.0.1:${address.port}`
  }, 60_000)

  afterAll(async () => {
    if (api?.server.listening) await new Promise<void>(resolve => api!.server.close(() => resolve()))
    removeStorageOverride?.()
    vi.unstubAllEnvs()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('rejects a foreign workspace before object read and returns the authorized integrity-checked bytes', async () => {
    const bytes = new TextEncoder().encode('memory fixture asset bytes for integrity coverage')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const headers = { authorization: `Bearer ${apiToken}`, 'x-workspace-id': workspaceId }
    const uploadedResponse = await fetch(`${base}/v1/assets/upload`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'text/plain', 'x-asset-name': 'tenant-proof.txt', 'x-asset-sha256': sha256 },
      body: bytes,
    })
    const uploaded = await uploadedResponse.json() as Envelope<{ id: string; scanStatus?: string }>
    expect(uploadedResponse.status).toBe(201)
    expect(uploaded.error).toBeNull()
    const asset = uploaded.data!
    expect(asset.scanStatus).toBe('clean')

    storage.get.mockClear()
    const foreignResponse = await fetch(`${base}/v1/assets/${encodeURIComponent(asset.id)}/download`, {
      headers: { authorization: `Bearer ${apiToken}`, 'x-workspace-id': `${workspaceId}_foreign` },
    })
    const foreign = await foreignResponse.json() as Envelope<unknown>
    expect(foreignResponse.status).toBe(403)
    expect(foreign.error?.code).toBeTruthy()
    expect(storage.get).not.toHaveBeenCalled()

    const authorizedResponse = await fetch(`${base}/v1/assets/${encodeURIComponent(asset.id)}/download`, { headers })
    const returned = new Uint8Array(await authorizedResponse.arrayBuffer())
    expect(authorizedResponse.status).toBe(200)
    expect(authorizedResponse.headers.get('content-type')).toBe('text/plain')
    expect(createHash('sha256').update(returned).digest('hex')).toBe(sha256)
    expect(returned).toEqual(bytes)
    expect(storage.get).toHaveBeenCalledTimes(1)
    expect(storage.get).toHaveBeenCalledWith(workspaceId, expect.stringMatching(new RegExp(`^clean/${workspaceId}/`)), { includeQuarantine: false })
  }, 60_000)
})
