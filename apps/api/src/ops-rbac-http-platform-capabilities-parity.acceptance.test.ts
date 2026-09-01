import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'
import { operationAudits, server, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'

type Envelope = {
  request_id?: string
  trace_id?: string
  workspace_id?: string
  data: { result?: unknown } | unknown | null
  error: { code: string; message?: string; details?: Record<string, unknown> } | null
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
  const response = await fetch(`${base}/v1/platform-capabilities`, { headers: headers(token, workspaceId) })
  return { response, body: await response.json() as Envelope }
}

async function callMcp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...headers(token, workspaceId), 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'workspace.health', params: {} }),
  })
  return { response, body: await response.json() as Envelope }
}

function resultOf(body: Envelope) {
  if (!body.data || typeof body.data !== 'object') return undefined
  return 'result' in body.data ? body.data.result : body.data
}

function configureTokens(entries: Record<string, Record<string, unknown>>) {
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify(entries))
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-rbac-platform-capabilities-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('Ops RBAC HTTP/MCP platform capabilities parity', () => {
  it('returns the same six-platform readiness projection over HTTP and MCP', async () => {
    const workspaceId = `ws_platform_capabilities_allow_${Date.now()}`
    const actorId = `platform-capabilities-allow-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    configureTokens({ allow: { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'] } })
    const base = await start()

    const [http, mcp] = await Promise.all([callHttp(base, 'allow', workspaceId), callMcp(base, 'allow', workspaceId)])
    expect(http.response.status, JSON.stringify(http.body)).toBe(200)
    expect(mcp.response.status, JSON.stringify(mcp.body)).toBe(200)
    const httpResult = resultOf(http.body) as { items: Array<{ platform: string; readiness: unknown }> }
    const mcpResult = resultOf(mcp.body) as { connectorReadiness: Record<string, unknown> }
    expect(httpResult.items).toHaveLength(6)
    expect(Object.fromEntries(httpResult.items.map(item => [item.platform, item.readiness]))).toEqual(
      Object.fromEntries(Object.entries(mcpResult.connectorReadiness).map(([platform, readiness]) => {
        const value = readiness as { platform: string; ready: boolean; reasons: string[]; verifiedCapabilities: string[] }
        return [platform, { platform: value.platform, ready: value.ready, reasons: value.reasons, verifiedCapabilities: value.verifiedCapabilities }]
      })),
    )
  })

  it('keeps explicit deny and cross-workspace scope mismatch aligned with decision audit evidence', async () => {
    const workspaceId = `ws_platform_capabilities_deny_${Date.now()}`
    const foreignWorkspaceId = `${workspaceId}_foreign`
    const deniedActorId = `platform-capabilities-deny-${Date.now()}`
    const scopeActorId = `platform-capabilities-scope-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: deniedActorId, displayName: deniedActorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: scopeActorId, displayName: scopeActorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    configureTokens({
      deny: { workspaces: [workspaceId], actor_id: deniedActorId, roles: ['merchant_admin'], workbenches: ['workspace'], denied_capabilities: ['workspace.summary.read'] },
      scope: { workspaces: [foreignWorkspaceId], actor_id: scopeActorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
    })
    const base = await start()

    const [httpDeny, mcpDeny] = await Promise.all([callHttp(base, 'deny', workspaceId), callMcp(base, 'deny', workspaceId)])
    for (const result of [httpDeny, mcpDeny]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({ code: 'FORBIDDEN', details: { capability: 'workspace.summary.read', reason_code: 'AUTHZ_EXPLICIT_DENY', decision_id: expect.any(String), policy_version: AUTHZ_POLICY_VERSION, workbench: 'workspace' } })
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
      expect(result.body.workspace_id).toBe(workspaceId)
    }

    const [httpScope, mcpScope] = await Promise.all([callHttp(base, 'scope', workspaceId), callMcp(base, 'scope', workspaceId)])
    for (const result of [httpScope, mcpScope]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error?.message).toMatch(/无权访问该工作区/u)
      expect(JSON.stringify(result.body)).not.toContain(foreignWorkspaceId)
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
    }

    const audits = await operationAudits.list(workspaceId)
    const denialAudits = audits.filter(audit => audit.action === 'authz.decision' && [deniedActorId, scopeActorId].includes(audit.actorId))
    expect(denialAudits).toHaveLength(2)
    expect(denialAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: deniedActorId, after: expect.objectContaining({ capability: 'workspace.summary.read', result: 'deny', reason_code: 'AUTHZ_EXPLICIT_DENY', policy_version: AUTHZ_POLICY_VERSION, decision_id: expect.any(String), request_id: expect.stringMatching(/^req_/), trace_id: expect.stringMatching(/^req_/) }) }),
    ]))
  })
})
