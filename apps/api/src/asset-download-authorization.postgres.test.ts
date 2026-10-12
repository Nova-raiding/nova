import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LocalObjectStorage } from '../../../packages/storage/src/object-storage.js'
import { PostgresStorageQuotaRepository } from '../../../packages/persistence/src/storage-quota-repository.js'

const databaseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const isolatedRedisUrl = process.env.MERCHANT_ISOLATED_REDIS_URL
const runId = process.env.MERCHANT_ISOLATED_POSTGRES_RUN_ID
const workspaceId = runId ? `ws_asset_download_${runId.replaceAll('-', '')}` : undefined
const apiToken = 'asset-download-isolated-owner-token'
let api: typeof import('./server.js') | undefined
let pool: Pool | undefined
let quotaPool: Pool | undefined
let storageRoot = ''
let base = ''
let removeStorageOverride: (() => void) | undefined
let storage: LocalObjectStorage & { get: ReturnType<typeof vi.fn> }

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null }

describe('isolated PostgreSQL asset download authorization/storage boundary', () => {
  beforeAll(async () => {
    if (!databaseUrl || !isolatedRedisUrl || !workspaceId || new URL(databaseUrl).hostname !== '127.0.0.1' || !/^[a-f0-9-]{36}$/u.test(runId ?? '')) {
      throw new Error('ASSET_DOWNLOAD_ISOLATED_POSTGRES_FIXTURE_REQUIRED')
    }
    storageRoot = await mkdtemp(join(tmpdir(), 'isolated-asset-download-'))
    // `NODE_ENV=test` selects memoryPersistence in the API composition root;
    // staging keeps the application on the real merchant_app Postgres pool.
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('PERSISTENCE_MODE', 'postgres')
    const applicationDatabaseUrl = new URL(databaseUrl)
    applicationDatabaseUrl.username = 'merchant_app'
    applicationDatabaseUrl.password = 'merchant_app_local_only'
    vi.stubEnv('DATABASE_URL', applicationDatabaseUrl.toString())
    const operationsDatabaseUrl = new URL(databaseUrl)
    operationsDatabaseUrl.username = 'merchant_ops'
    operationsDatabaseUrl.password = 'merchant_ops_local_only'
    vi.stubEnv('OPS_DATABASE_URL', operationsDatabaseUrl.toString())
    vi.stubEnv('REDIS_URL', isolatedRedisUrl)
    vi.stubEnv('RUN_MIGRATIONS_ON_STARTUP', 'false')
    vi.stubEnv('DEPLOYMENT_PROFILE', 'local_acceptance')
    vi.stubEnv('LOCAL_COMPOSE', 'true')
    vi.stubEnv('API_BIND_HOST', '127.0.0.1')
    vi.stubEnv('PORT', '0')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'isolated-asset-download-test-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [apiToken]: { workspaces: [workspaceId, `${workspaceId}_foreign`], actor_id: 'asset-download-owner', roles: ['workspace_owner'], workbenches: ['workspace'] },
    }))
    vi.stubEnv('ASSET_STORAGE_ROOT', storageRoot)
    vi.stubEnv('ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'true')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')

    api = await import('./server.js')
    await api.persistenceReady
    pool = new Pool({ connectionString: databaseUrl, max: 2 })
    const foreignWorkspaceId = `${workspaceId}_foreign`
    await pool.query("INSERT INTO workspaces (id,status) VALUES ($1,'active'),($2,'active') ON CONFLICT (id) DO NOTHING", [workspaceId, foreignWorkspaceId])
    const persistence = await api.persistenceReady
    if (!persistence.members) throw new Error('ASSET_DOWNLOAD_DURABLE_MEMBERS_REPOSITORY_REQUIRED')
    await persistence.members.upsert({ workspaceId, externalSubject: 'asset-download-owner', displayName: 'Asset Download Owner', role: 'workspace_owner', status: 'active', invitedBy: 'isolated-asset-download-test' })
    await persistence.members.upsert({ workspaceId: foreignWorkspaceId, externalSubject: 'asset-download-owner', displayName: 'Asset Download Owner', role: 'workspace_owner', status: 'active', invitedBy: 'isolated-asset-download-test' })
    quotaPool = new Pool({ connectionString: applicationDatabaseUrl.toString(), max: 2 })

    const local = new LocalObjectStorage(storageRoot)
    storage = Object.assign(local, { get: vi.fn(local.get.bind(local)) })
    removeStorageOverride = api.setAssetStorageForTests(storage)
    if (!api.server.listening) {
      await new Promise<void>((resolve, reject) => {
        api!.server.once('listening', resolve)
        api!.server.once('error', reject)
      })
    }
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('ASSET_DOWNLOAD_TEST_SERVER_BIND_FAILED')
    base = `http://127.0.0.1:${address.port}`
  }, 60_000)

  afterAll(async () => {
    if (api?.server.listening) await new Promise<void>(resolve => api!.server.close(() => resolve()))
    try {
      await (await api?.persistenceReady)?.close?.()
    } finally {
      removeStorageOverride?.()
      await Promise.all([quotaPool?.end(), pool?.end()])
      vi.unstubAllEnvs()
      if (storageRoot) await rm(storageRoot, { recursive: true, force: true })
    }
  })

  it('scopes asset listing and storage quota to the authorized workspace', async () => {
    const tenantWorkspaceId = workspaceId
    if (!tenantWorkspaceId || !api || !quotaPool) throw new Error('ASSET_DOWNLOAD_ISOLATED_POSTGRES_FIXTURE_REQUIRED')
    const bytes = new TextEncoder().encode('isolated tenant-scoped asset bytes')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    expect((await api.persistenceReady).mode).toBe('postgres')
    const healthResponse = await fetch(`${base}/healthz`)
    const health = await healthResponse.json() as Envelope<{ persistence?: { mode?: string; ready?: boolean } }>
    expect(healthResponse.status).toBe(200)
    expect(health.data?.persistence).toEqual({ mode: 'postgres', ready: true })
    expect((await quotaPool.query<{ role: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    )).rows).toEqual([{ role: 'merchant_app', rolsuper: false, rolbypassrls: false }])

    // Synthetic metadata isolates GET authorization/RLS from upload's separate
    // commercial entitlement gate. It grants no commercial rights or durable asset row.
    const asset = api.service.registerAsset({
      workspaceId: tenantWorkspaceId,
      name: 'tenant-proof.txt',
      mimeType: 'text/plain',
      sizeBytes: bytes.byteLength,
      sha256,
      storageKey: `quarantine/${tenantWorkspaceId}/tenant-proof.txt`,
    })

    const foreignWorkspaceId = `${tenantWorkspaceId}_foreign`
    await new PostgresStorageQuotaRepository(quotaPool).reserve({
      workspaceId: tenantWorkspaceId,
      reservationKey: 'asset:quota-scope-own-probe',
      assetId: 'asset_quota_scope_own_probe',
      bytes: 2,
      limitBytes: 9,
    })
    await new PostgresStorageQuotaRepository(quotaPool).reserve({
      workspaceId: foreignWorkspaceId,
      reservationKey: 'asset:quota-scope-probe',
      assetId: 'asset_quota_scope_probe',
      bytes: 1,
      limitBytes: 7,
    })
    const listAssets = async (targetWorkspaceId: string) => {
      const response = await fetch(`${base}/v1/assets?limit=100`, {
        headers: { authorization: `Bearer ${apiToken}`, 'x-workspace-id': targetWorkspaceId },
      })
      return { response, body: await response.json() as Envelope<{ items: Array<{ id: string }>; storage_quota?: { limitBytes: number; usedBytes: number; reservedBytes: number } }> }
    }
    const currentTenantAssets = await listAssets(tenantWorkspaceId)
    expect(currentTenantAssets.response.status).toBe(200)
    expect(currentTenantAssets.body.error).toBeNull()
    expect(currentTenantAssets.body.data?.items.map(item => item.id)).toEqual([asset.id])
    expect(currentTenantAssets.body.data?.storage_quota).toEqual({ limitBytes: 9, usedBytes: 0, reservedBytes: 2, availableBytes: 7, status: 'available' })

    const otherTenantAssets = await listAssets(foreignWorkspaceId)
    expect(otherTenantAssets.response.status).toBe(200)
    expect(otherTenantAssets.body.error).toBeNull()
    expect(otherTenantAssets.body.data?.items).toEqual([])
    expect(otherTenantAssets.body.data?.storage_quota).toEqual({ limitBytes: 7, usedBytes: 0, reservedBytes: 1, availableBytes: 6, status: 'available' })

    const foreignResponse = await fetch(`${base}/v1/assets/${encodeURIComponent(asset.id)}/download`, {
      headers: { authorization: `Bearer ${apiToken}`, 'x-workspace-id': foreignWorkspaceId },
    })
    const foreign = await foreignResponse.json() as Envelope<unknown>
    expect(foreignResponse.status).toBe(404)
    expect(foreign.error?.code).toBe('ASSET_NOT_FOUND')
    expect(storage.get).not.toHaveBeenCalled()

    const unauthorizedResponse = await fetch(`${base}/v1/assets?limit=100`, {
      headers: { authorization: `Bearer ${apiToken}`, 'x-workspace-id': `${tenantWorkspaceId}_unauthorized` },
    })
    expect(unauthorizedResponse.status).toBe(403)

    const unauthorizedDownloadResponse = await fetch(`${base}/v1/assets/${encodeURIComponent(asset.id)}/download`, {
      headers: { authorization: `Bearer ${apiToken}`, 'x-workspace-id': `${tenantWorkspaceId}_unauthorized` },
    })
    expect(unauthorizedDownloadResponse.status).toBe(403)
    expect(await unauthorizedDownloadResponse.text()).not.toContain(asset.id)
    expect(storage.get).not.toHaveBeenCalled()
  }, 60_000)
})
