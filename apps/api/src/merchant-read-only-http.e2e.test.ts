import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { service, server, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'

type Envelope = { data: unknown; error: { code: string } | null }

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

describe('merchant read-only HTTP routes', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'merchant-read-only-http-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'merchant-read-only-token': { actor_id: 'merchant-read-only-actor', roles: ['merchant_admin'], workbenches: ['workspace'], workspaces: ['ws_merchant_read_only'] },
    }))
    setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
  })

  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    setAuthorizationRepositoryForTests(undefined)
    vi.unstubAllEnvs()
  })

  it('keeps store discovery and sync history readable without a commercial rate card', async () => {
    const workspaceId = 'ws_merchant_read_only'
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'merchant-read-only-actor', displayName: 'read-only merchant', role: 'merchant_admin', status: 'active', invitedBy: 'merchant-read-only-http-test' })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: 'read-only-store', credentialRef: 'vault://read-only-store' })
    const base = await start()
    const headers = { authorization: 'Bearer merchant-read-only-token', 'x-workspace-id': workspaceId }

    for (const path of ['/v1/platform-accounts', '/v1/sync-jobs?limit=50&offset=0']) {
      const response = await fetch(`${base}${path}`, { headers })
      const body = await response.json() as Envelope
      expect(response.status, JSON.stringify(body)).toBe(200)
      expect(body.error).toBeNull()
      expect(body.data).not.toBeNull()
    }
  })
})
