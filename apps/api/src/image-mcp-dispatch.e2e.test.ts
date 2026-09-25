import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableCommercialFixtureHarnessForTests, server, workspaceMembers } from './server.js'

describe('extracted image MCP dispatch', () => {
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('requires a workspace member before the extracted read handler validates its arguments', async () => {
    const workspaceId = `ws_image_dispatch_${Date.now()}`
    const actorId = `image-dispatch-${Date.now()}`
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'image-dispatch-e2e-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'image-dispatch-test-token': { workspaces: [workspaceId], actor_id: actorId, roles: ['workspace_owner'] },
    }))
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    enableCommercialFixtureHarnessForTests()
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: '图片读取者', role: 'workspace_owner', status: 'active', invitedBy: 'test' })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(0, () => { server.removeListener('error', onError); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    const url = `http://127.0.0.1:${address.port}/mcp`
    const call = async (authorization?: string) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-test-commercial-fixture': 'server-e2e', ...(authorization ? { authorization } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'image-read-dispatch', method: 'catalog.image.get', params: { workspace_id: workspaceId } }),
      })
      return await response.json() as { error?: { code?: string } }
    }
    const denied = await call()
    expect(denied.error?.code).toBeTruthy()
    expect(denied.error?.code).not.toBe('INVALID_REQUEST')
    const member = await call('Bearer image-dispatch-test-token')
    expect(member.error?.code).toBe('INVALID_REQUEST')
  })
})
