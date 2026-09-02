import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, operationAudits, server, service, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'

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
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function headers(token: string, workspaceId: string) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-ops-workbench': 'workspace', 'x-workspace-id': workspaceId }
}

async function callHttp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/v1/brand-profile`, {
    method: 'PUT',
    headers: headers(token, workspaceId),
    body: JSON.stringify({ name: 'Parity Brand', positioning: '可审计写入', audience: '务实商家', tone: ['清晰', '克制'], forbidden_terms: ['虚假承诺'], source: 'http-parity-test' }),
  })
  return { response, body: await response.json() as Envelope }
}

async function callMcp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: headers(token, workspaceId),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'brand.upsert',
      params: {
        name: 'Parity Brand',
        positioning: '可审计写入',
        audience: '务实商家',
        tone_json: JSON.stringify(['清晰', '克制']),
        forbidden_terms_json: JSON.stringify(['虚假承诺']),
        source: 'mcp-parity-test',
      },
    }),
  })
  return { response, body: await response.json() as Envelope }
}

function resultOf(body: Envelope) {
  return body.data && typeof body.data === 'object' && 'result' in body.data ? body.data.result : body.data
}

function comparableProfile(body: Envelope) {
  const profile = resultOf(body) as Record<string, unknown>
  return { name: profile.name, positioning: profile.positioning, audience: profile.audience, tone: profile.tone, forbiddenTerms: profile.forbiddenTerms }
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'brand-profile-upsert-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('brand profile upsert HTTP/MCP parity', () => {
  it('writes the same authenticated workspace facts through HTTP and MCP', async () => {
    const httpWorkspaceId = `ws_brand_upsert_http_${Date.now()}`
    const mcpWorkspaceId = `${httpWorkspaceId}_mcp`
    const httpActorId = `brand-upsert-http-${Date.now()}`
    const mcpActorId = `brand-upsert-mcp-${Date.now()}`
    for (const [workspaceId, actorId] of [[httpWorkspaceId, httpActorId], [mcpWorkspaceId, mcpActorId]] as const) {
      await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'parity-acceptance' })
      service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `brand-upsert-store-${workspaceId}`, credentialRef: `vault://brand-upsert/${workspaceId}` })
      await grantCreativePointsForTests(workspaceId)
      grantContinuousFeatureEntitlementForTests(workspaceId)
    }
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'brand-upsert-http-token': { workspaces: [httpWorkspaceId], actor_id: httpActorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
      'brand-upsert-mcp-token': { workspaces: [mcpWorkspaceId], actor_id: mcpActorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const [http, mcp] = await Promise.all([
      callHttp(base, 'brand-upsert-http-token', httpWorkspaceId),
      callMcp(base, 'brand-upsert-mcp-token', mcpWorkspaceId),
    ])

    for (const result of [http, mcp]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(200)
      expect(result.body.error).toBeNull()
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
    }
    expect(comparableProfile(http.body)).toEqual(comparableProfile(mcp.body))
    expect(service.getBrandProfile(httpWorkspaceId)).toMatchObject({ name: 'Parity Brand', positioning: '可审计写入' })
    expect(service.getBrandProfile(mcpWorkspaceId)).toMatchObject({ name: 'Parity Brand', positioning: '可审计写入' })
  })

  it('denies an explicit write capability over both transports before mutating the workspace', async () => {
    const workspaceId = `ws_brand_upsert_deny_${Date.now()}`
    const actorId = `brand-upsert-deny-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'parity-acceptance' })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `brand-upsert-store-${workspaceId}`, credentialRef: `vault://brand-upsert/${workspaceId}` })
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'brand-upsert-deny-token': { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], denied_capabilities: ['customer.content.update'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const [http, mcp] = await Promise.all([
      callHttp(base, 'brand-upsert-deny-token', workspaceId),
      callMcp(base, 'brand-upsert-deny-token', workspaceId),
    ])

    for (const result of [http, mcp]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({ code: 'FORBIDDEN', details: { capability: 'customer.content.update', policy_version: AUTHZ_POLICY_VERSION } })
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
    }
    expect(http.body.error?.details?.reason_code).toBe(mcp.body.error?.details?.reason_code)
    expect(service.getBrandProfile(workspaceId)).toBeUndefined()
    const audits = await operationAudits.list(workspaceId)
    expect(audits.filter(audit => audit.action === 'brand_profile.updated')).toHaveLength(0)
  })
})
