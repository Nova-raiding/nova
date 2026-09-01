import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operationAudits, server, service, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'

type Envelope<T = unknown> = {
  request_id?: string
  trace_id?: string
  workspace_id?: string
  data: { result?: T } | T | null
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

async function callHttp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/v1/catalog/categories?query=鞋`, {
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
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'catalog.categories', params: { query: '鞋' } }),
  })
  return { response, body: await response.json() as Envelope }
}

function configureTokens(workspaceId: string, allowedActor: string, deniedActor: string) {
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
    'categories-allow-token': { workspaces: [workspaceId], actor_id: allowedActor, roles: ['merchant_admin'], workbenches: ['workspace'] },
    'categories-deny-token': { workspaces: [workspaceId], actor_id: deniedActor, roles: ['merchant_admin'], denied_capabilities: ['customer.content.read'], workbenches: ['workspace'] },
  }))
}

function resultPayload(body: Envelope) {
  return body.data && typeof body.data === 'object' && 'result' in body.data ? body.data.result : body.data
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-rbac-http-mcp-categories-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('Ops RBAC HTTP/MCP catalog categories parity', () => {
  it('returns the same authorized read over HTTP and MCP', async () => {
    const workspaceId = `ws_categories_parity_allow_${Date.now()}`
    const actorId = `categories-parity-allow-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `categories-parity-store-${workspaceId}`, credentialRef: `vault://categories-parity/${workspaceId}` })
    configureTokens(workspaceId, actorId, `unused-denied-${Date.now()}`)
    const base = await start()

    const [http, mcp] = await Promise.all([
      callHttp(base, 'categories-allow-token', workspaceId),
      callMcp(base, 'categories-allow-token', workspaceId),
    ])

    expect(http.response.status, JSON.stringify(http.body)).toBe(200)
    expect(mcp.response.status, JSON.stringify(mcp.body)).toBe(200)
    expect(http.body.error).toBeNull()
    expect(mcp.body.error).toBeNull()
    expect(resultPayload(http.body)).toEqual(resultPayload(mcp.body))
    expect(resultPayload(http.body)).toEqual([expect.objectContaining({ category_code: expect.any(String) })])
  })

  it('denies the same missing capability over HTTP and MCP and records one decision audit per request', async () => {
    const workspaceId = `ws_categories_parity_deny_${Date.now()}`
    const actorId = `categories-parity-deny-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    configureTokens(workspaceId, `unused-allow-${Date.now()}`, actorId)
    const base = await start()

    const [http, mcp] = await Promise.all([
      callHttp(base, 'categories-deny-token', workspaceId),
      callMcp(base, 'categories-deny-token', workspaceId),
    ])

    for (const result of [http, mcp]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({
        code: 'FORBIDDEN',
        details: {
          capability: 'customer.content.read',
          reason_code: 'AUTHZ_EXPLICIT_DENY',
          decision_id: expect.any(String),
          policy_version: AUTHZ_POLICY_VERSION,
          workbench: 'workspace',
        },
      })
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
      expect(result.body.workspace_id).toBe(workspaceId)
    }

    expect(http.body.error?.details?.capability).toBe(mcp.body.error?.details?.capability)
    expect(http.body.error?.details?.reason_code).toBe(mcp.body.error?.details?.reason_code)
    const audits = await operationAudits.list(workspaceId)
    const denialAudits = audits.filter(audit => audit.action === 'authz.decision' && audit.actorId === actorId)
    expect(denialAudits).toHaveLength(2)
    for (const audit of denialAudits) {
      expect(audit.after).toMatchObject({
        capability: 'customer.content.read',
        result: 'deny',
        reason_code: 'AUTHZ_EXPLICIT_DENY',
        policy_version: AUTHZ_POLICY_VERSION,
        decision_id: expect.any(String),
        request_id: expect.stringMatching(/^req_/),
        trace_id: expect.stringMatching(/^req_/),
      })
    }
  })
})
