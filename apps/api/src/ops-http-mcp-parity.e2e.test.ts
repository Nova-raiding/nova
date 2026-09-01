import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { server, service, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'

type Envelope<T = unknown> = {
  request_id?: string
  trace_id?: string
  workspace_id?: string
  data: { result: T } | null
  error: { code: string; details?: Record<string, unknown> } | null
}

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

async function callMcp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'platform.store.list', params: { workspace_id: workspaceId } }),
  })
  return { response, body: await response.json() as Envelope }
}

async function callHttp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/v1/platform-accounts`, {
    headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId },
  })
  return { response, body: await response.json() as Envelope }
}

function configureToken(token: string, actorId: string, workspaceId: string, role: string, workbenches: string[]) {
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
    [token]: { workspaces: [workspaceId], actor_id: actorId, roles: [role], workbenches },
  }))
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-http-mcp-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('Ops HTTP/MCP authorization parity', () => {
  it('allows the same workspace-scoped capability over HTTP and MCP for a merchant workbench', async () => {
    const workspaceId = `ws_http_mcp_allow_${Date.now()}`
    const actorId = `merchant-allow-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'ops-http-mcp-parity' })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `parity-store-${workspaceId}`, credentialRef: `vault://parity/${workspaceId}` })
    configureToken('merchant-allow-token', actorId, workspaceId, 'merchant_admin', ['workspace'])
    const base = await start()

    const http = await callHttp(base, 'merchant-allow-token', workspaceId)
    const mcp = await callMcp(base, 'merchant-allow-token', workspaceId)

    expect(http.response.status, JSON.stringify(http.body)).toBe(200)
    expect(mcp.response.status, JSON.stringify(mcp.body)).toBe(200)
    expect(http.body.error).toBeNull()
    expect(mcp.body.error).toBeNull()
    expect(http.body.data).not.toBeNull()
    expect(mcp.body.data).not.toBeNull()
  })

  it('denies the same workspace capability over HTTP and MCP for a finance identity without that capability', async () => {
    const workspaceId = `ws_http_mcp_deny_${Date.now()}`
    const actorId = `finance-deny-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'finance', status: 'active', invitedBy: 'ops-http-mcp-parity' })
    configureToken('finance-deny-token', actorId, workspaceId, 'finance', ['workspace'])
    const base = await start()

    const http = await callHttp(base, 'finance-deny-token', workspaceId)
    const mcp = await callMcp(base, 'finance-deny-token', workspaceId)

    for (const result of [http, mcp]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({
        code: 'FORBIDDEN',
        details: {
          decision_id: expect.any(String),
          capability: expect.any(String),
          reason_code: expect.any(String),
          workbench: 'workspace',
        },
      })
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
      expect(result.body.workspace_id).toBe(workspaceId)
      expect(JSON.stringify(result.body)).not.toContain('ws_unrelated_tenant')
    }

    expect(http.body.error?.details?.reason_code).toBe(mcp.body.error?.details?.reason_code)
    expect(http.body.error?.details?.capability).toBe(mcp.body.error?.details?.capability)
  })
})
