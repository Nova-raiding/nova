import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, server, workspaceMembers } from './server.js'

type Envelope<T = Record<string, any>> = { workspace_id: string; data: T | null; error: { code: string; details?: Record<string, unknown> } | null }

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

let storageRoot: string

beforeEach(async () => {
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'test-session-hash-secret')
  storageRoot = await mkdtemp(join(tmpdir(), 'asset-storage-quota-e2e-'))
  vi.stubEnv('ASSET_STORAGE_ROOT', storageRoot)
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
  await rm(storageRoot, { recursive: true, force: true })
})

describe('workspace storage quota accounting', () => {
  it('charges every physical object written under one asset id', async () => {
    const workspaceId = `ws_storage_quota_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'quota-owner-token': { workspaces: [workspaceId], actor_id: 'quota-owner', roles: ['workspace_owner'], workbenches: ['workspace'] },
    }))
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'quota-owner', displayName: 'quota-owner', role: 'workspace_owner', status: 'active', invitedBy: 'storage-quota-test' })
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    const base = await start()
    const headers = { authorization: 'Bearer quota-owner-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const mcp = (id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)
    const bytes = Buffer.from('identical-bytes-under-two-file-names-for-quota-accounting')
    const upload = (id: number, name: string) => mcp(id, 'asset.upload', { name, mime_type: 'text/plain', content_base64: bytes.toString('base64') })
    const usedBytes = async (id: number) => {
      const listed = await mcp(id, 'asset.list', {})
      expect(listed.error).toBeNull()
      return listed.data?.result.storage_quota.usedBytes as number
    }

    const first = await upload(1, 'quota-a.txt')
    expect(first.error).toBeNull()
    expect(await usedBytes(2)).toBe(bytes.byteLength)

    // Same bytes, different file name: `registerAsset` deduplicates on
    // (workspace, sha256) and the non trusted clean branch writes a second
    // object under the same asset id with a new object key. Both objects are
    // real stored bytes, so both must be charged.
    const second = await upload(3, 'quota-b.txt')
    expect(second.error).toBeNull()
    expect(second.data?.result.id).toBe(first.data?.result.id)
    expect(await usedBytes(4)).toBe(2 * bytes.byteLength)

    // Replaying the first upload rewrites the same object key, so the ledger
    // must stay idempotent instead of charging the bytes twice.
    const replay = await upload(5, 'quota-a.txt')
    expect(replay.error).toBeNull()
    expect(await usedBytes(6)).toBe(2 * bytes.byteLength)
  })
})
