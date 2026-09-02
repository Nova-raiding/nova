import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'
import { operationAudits, server, service, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'
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

function headers(token: string, workspaceId: string) {
  return {
    authorization: `Bearer ${token}`,
    'x-workspace-id': workspaceId,
    'x-ops-workbench': 'workspace',
  }
}

async function callHttp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/v1/creative-points/balance`, { headers: headers(token, workspaceId) })
  return { response, body: await response.json() as Envelope }
}

async function callMcp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...headers(token, workspaceId), 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'creative-points.balance.get', params: {} }),
  })
  return { response, body: await response.json() as Envelope }
}

function configureTokens(entries: Record<string, Record<string, unknown>>) {
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify(entries))
}

function resultOf(body: Envelope) {
  return body.data && typeof body.data === 'object' && 'result' in body.data ? body.data.result : body.data
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'creative-points-http-mcp-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('creative points HTTP/MCP authorization parity', () => {
  it('returns the same authenticated workspace balance over HTTP and MCP', async () => {
    const workspaceId = `ws_points_parity_allow_${Date.now()}`
    const actorId = `points-parity-allow-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `points-parity-store-${workspaceId}`, credentialRef: `vault://points-parity/${workspaceId}` })
    configureTokens({ allow: { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'] } })
    const base = await start()

    const [http, mcp] = await Promise.all([callHttp(base, 'allow', workspaceId), callMcp(base, 'allow', workspaceId)])
    expect(http.response.status, JSON.stringify(http.body)).toBe(200)
    expect(mcp.response.status, JSON.stringify(mcp.body)).toBe(200)
    expect(http.body.error).toBeNull()
    expect(mcp.body.error).toBeNull()
    expect(resultOf(http.body)).toEqual(resultOf(mcp.body))
    expect(resultOf(http.body)).toMatchObject({ schema_version: 'creative-points.balance.v1', workspace_id: workspaceId })
  })

  it('keeps explicit deny aligned and records one decision audit per transport', async () => {
    const workspaceId = `ws_points_parity_deny_${Date.now()}`
    const actorId = `points-parity-deny-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    configureTokens({ deny: { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], denied_capabilities: ['billing.workspace.read'], workbenches: ['workspace'] } })
    const base = await start()

    const [http, mcp] = await Promise.all([callHttp(base, 'deny', workspaceId), callMcp(base, 'deny', workspaceId)])
    for (const result of [http, mcp]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({ code: 'FORBIDDEN', details: { capability: 'billing.workspace.read', reason_code: 'AUTHZ_EXPLICIT_DENY', policy_version: AUTHZ_POLICY_VERSION, workbench: 'workspace' } })
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
      expect(result.body.workspace_id).toBe(workspaceId)
    }
    expect(http.body.error?.details?.reason_code).toBe(mcp.body.error?.details?.reason_code)
    const audits = await operationAudits.list(workspaceId)
    const denialAudits = audits.filter(audit => audit.action === 'authz.decision' && audit.actorId === actorId)
    expect(denialAudits).toHaveLength(2)
    expect(denialAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ after: expect.objectContaining({ capability: 'billing.workspace.read', result: 'deny', reason_code: 'AUTHZ_EXPLICIT_DENY', policy_version: AUTHZ_POLICY_VERSION }) }),
    ]))
  })

  it('does not widen the authenticated workspace from an HTTP query parameter', async () => {
    const workspaceId = `ws_points_parity_scope_${Date.now()}`
    const foreignWorkspaceId = `${workspaceId}_foreign`
    const actorId = `points-parity-scope-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    configureTokens({ allow: { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'] } })
    const base = await start()
    const response = await fetch(`${base}/v1/creative-points/balance?workspace_id=${encodeURIComponent(foreignWorkspaceId)}`, { headers: headers('allow', workspaceId) })
    const body = await response.json() as Envelope
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.workspace_id).toBe(workspaceId)
    expect(JSON.stringify(body)).not.toContain(foreignWorkspaceId)
  })
})
