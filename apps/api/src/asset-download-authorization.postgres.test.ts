import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LocalObjectStorage } from '../../../packages/storage/src/object-storage.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const runId = process.env.MERCHANT_ISOLATED_POSTGRES_RUN_ID
const workspaceId = runId ? `ws_asset_download_${runId.replaceAll('-', '')}` : undefined
const apiToken = 'asset-download-isolated-owner-token'
let api: typeof import('./server.js') | undefined
let pool: Pool | undefined
let storageRoot = ''
let base = ''
let removeStorageOverride: (() => void) | undefined
let storage: LocalObjectStorage & { get: ReturnType<typeof vi.fn> }

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null }

describe('isolated PostgreSQL asset download authorization/storage boundary', () => {
  beforeAll(async () => {
    if (!databaseUrl || !workspaceId || new URL(databaseUrl).hostname !== '127.0.0.1' || !/^[a-f0-9-]{36}$/u.test(runId ?? '')) {
      throw new Error('ASSET_DOWNLOAD_ISOLATED_POSTGRES_FIXTURE_REQUIRED')
    }
    storageRoot = await mkdtemp(join(tmpdir(), 'isolated-asset-download-'))
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('PERSISTENCE_MODE', 'postgres')
    vi.stubEnv('DATABASE_URL', databaseUrl)
    vi.stubEnv('RUN_MIGRATIONS_ON_STARTUP', 'false')
    vi.stubEnv('DEPLOYMENT_PROFILE', 'local_acceptance')
    vi.stubEnv('LOCAL_COMPOSE', 'true')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'isolated-asset-download-test-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [apiToken]: { workspaces: [workspaceId], actor_id: 'asset-download-owner', roles: ['workspace_owner'], workbenches: ['workspace'] },
    }))
    vi.stubEnv('ASSET_STORAGE_ROOT', storageRoot)
    vi.stubEnv('ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'true')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')

    api = await import('./server.js')
    await api.persistenceReady
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
    await pool.query("INSERT INTO workspaces (id,status) VALUES ($1,'active') ON CONFLICT (id) DO NOTHING", [workspaceId])
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: 'asset-download-owner', displayName: 'Asset Download Owner', role: 'workspace_owner', status: 'active', invitedBy: 'isolated-asset-download-test' })
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)

    const local = new LocalObjectStorage(storageRoot)
    storage = Object.assign(local, { get: vi.fn(local.get.bind(local)) })
    removeStorageOverride = api.setAssetStorageForTests(storage)
    await new Promise<void>((resolve, reject) => {
      api!.server.once('error', reject)
      api!.server.listen(0, '127.0.0.1', resolve)
    })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('ASSET_DOWNLOAD_TEST_SERVER_BIND_FAILED')
    base = `http://127.0.0.1:${address.port}`
  }, 60_000)

  afterAll(async () => {
    if (api?.server.listening) await new Promise<void>(resolve => api!.server.close(() => resolve()))
    removeStorageOverride?.()
    await pool?.end()
    vi.unstubAllEnvs()
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
  })

  it('denies a foreign workspace before object read, then returns only the authorized integrity-checked bytes', async () => {
    const bytes = new TextEncoder().encode('isolated tenant-scoped asset bytes')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const headers = { authorization: `Bearer ${apiToken}`, 'x-workspace-id': workspaceId! }
    const uploadedResponse = await fetch(`${base}/v1/assets/upload`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'text/plain', 'x-asset-name': 'tenant-proof.txt', 'x-asset-sha256': sha256 },
      body: bytes,
    })
    const uploaded = await uploadedResponse.json() as Envelope<{ id: string; storageKey: string; scanStatus?: string }>
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
