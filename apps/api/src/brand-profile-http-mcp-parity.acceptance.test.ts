import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, server, service, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'

type Envelope = {
  request_id?: string
  trace_id?: string
  workspace_id?: string
  data: { result?: unknown } | unknown | null
  error: { code: string; details?: Record<string, unknown> } | null
}

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function resultOf(body: Envelope) {
  return body.data && typeof body.data === 'object' && 'result' in body.data ? body.data.result : body.data
}

async function callHttp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/v1/brand-profile`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-ops-workbench': 'workspace',
      'x-workspace-id': workspaceId,
    },
  })
  return { response, body: await response.json() as Envelope }
}

async function callMcp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-ops-workbench': 'workspace',
      'x-workspace-id': workspaceId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'brand.get', params: {} }),
  })
  return { response, body: await response.json() as Envelope }
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'brand-profile-http-mcp-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('brand profile HTTP/MCP parity', () => {
  it('returns the same workspace profile and correlation evidence over both transports', async () => {
    const workspaceId = `ws_brand_profile_parity_${Date.now()}`
    const actorId = `brand-profile-parity-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'parity-acceptance' })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `brand-profile-store-${workspaceId}`, credentialRef: `vault://brand-profile/${workspaceId}` })
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    service.upsertBrandProfile({ workspaceId, name: 'Parity Brand', positioning: '可重放品牌资料', source: 'parity-acceptance' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'brand-profile-parity-token': { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'] } }))
    const base = await start()

    const [http, mcp] = await Promise.all([
      callHttp(base, 'brand-profile-parity-token', workspaceId),
      callMcp(base, 'brand-profile-parity-token', workspaceId),
    ])

    expect(http.response.status, JSON.stringify(http.body)).toBe(200)
    expect(mcp.response.status, JSON.stringify(mcp.body)).toBe(200)
    expect(http.body.error).toBeNull()
    expect(mcp.body.error).toBeNull()
    expect((resultOf(http.body) as { profile: unknown }).profile).toEqual(resultOf(mcp.body))
    expect(http.body.request_id).toMatch(/^req_/)
    expect(http.body.trace_id).toBe(http.body.request_id)
    expect(mcp.body.request_id).toMatch(/^req_/)
    expect(mcp.body.trace_id).toBe(mcp.body.request_id)
    expect(http.body.workspace_id).toBe(workspaceId)
    expect(mcp.body.workspace_id).toBe(workspaceId)
  })

  it('fails closed when the authenticated workspace is changed to a foreign tenant', async () => {
    const workspaceId = `ws_brand_profile_scope_${Date.now()}`
    const foreignWorkspaceId = `${workspaceId}_foreign`
    const actorId = `brand-profile-scope-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'parity-acceptance' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'brand-profile-scope-token': { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'] } }))
    const base = await start()

    const [http, mcp] = await Promise.all([
      callHttp(base, 'brand-profile-scope-token', foreignWorkspaceId),
      callMcp(base, 'brand-profile-scope-token', foreignWorkspaceId),
    ])

    for (const result of [http, mcp]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error?.code).toBe('FORBIDDEN')
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
      expect(result.body.workspace_id).toBe(foreignWorkspaceId)
      expect(JSON.stringify(result.body)).not.toContain(actorId)
    }
    expect(http.body.error?.details?.reason_code).toBe(mcp.body.error?.details?.reason_code)
    expect(http.body.error?.details?.capability).toBe(mcp.body.error?.details?.capability)
  })
})
