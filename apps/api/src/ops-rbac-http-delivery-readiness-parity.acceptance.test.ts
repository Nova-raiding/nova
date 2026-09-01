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
  const response = await fetch(`${base}/v1/delivery-readiness`, { headers: headers(token, workspaceId) })
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

function configureTokens(entries: Record<string, Record<string, unknown>>) {
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify(entries))
}

function expectDenied(result: { response: Response; body: Envelope }, workspaceId: string, expectedReason?: string, decision = true) {
  expect(result.response.status, JSON.stringify(result.body)).toBe(403)
  expect(result.body.data).toBeNull()
  expect(result.body.error).toMatchObject({ code: 'FORBIDDEN' })
  if (decision) {
    expect(result.body.error).toMatchObject({ details: {
      ...(expectedReason ? { reason_code: expectedReason } : {}),
      decision_id: expect.any(String),
      policy_version: AUTHZ_POLICY_VERSION,
      workbench: 'workspace',
    } })
  }
  expect(result.body.request_id).toMatch(/^req_/)
  expect(result.body.trace_id).toBe(result.body.request_id)
  expect(result.body.workspace_id).toBe(workspaceId)
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-rbac-delivery-readiness-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('Ops RBAC HTTP/MCP delivery readiness parity', () => {
  it('allows the same workspace.health read over HTTP and MCP', async () => {
    const workspaceId = `ws_delivery_readiness_allow_${Date.now()}`
    const actorId = `delivery-readiness-allow-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    configureTokens({ allow: { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'] } })
    const base = await start()

    const [http, mcp] = await Promise.all([
      callHttp(base, 'allow', workspaceId),
      callMcp(base, 'allow', workspaceId),
    ])

    expect(http.response.status, JSON.stringify(http.body)).toBe(200)
    expect(mcp.response.status, JSON.stringify(mcp.body)).toBe(200)
    expect(http.body.error).toBeNull()
    expect(mcp.body.error).toBeNull()
    expect(http.body.workspace_id).toBe(workspaceId)
    expect(mcp.body.workspace_id).toBe(workspaceId)
    expect(http.body.data).toEqual(expect.objectContaining({ status: expect.any(String), dimensions: expect.any(Object) }))
    expect(mcp.body.data).toEqual(expect.objectContaining({ result: expect.objectContaining({ connectorReadiness: expect.any(Object) }) }))
  })

  it('keeps explicit deny and cross-workspace scope mismatch aligned and auditable', async () => {
    const workspaceId = `ws_delivery_readiness_deny_${Date.now()}`
    const foreignWorkspaceId = `${workspaceId}_foreign`
    const deniedActorId = `delivery-readiness-deny-${Date.now()}`
    const scopeActorId = `delivery-readiness-scope-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: deniedActorId, displayName: deniedActorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: scopeActorId, displayName: scopeActorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    configureTokens({
      deny: { workspaces: [workspaceId], actor_id: deniedActorId, roles: ['merchant_admin'], workbenches: ['workspace'], denied_capabilities: ['workspace.summary.read'] },
      scope: { workspaces: [foreignWorkspaceId], actor_id: scopeActorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
    })
    const base = await start()

    const [httpDeny, mcpDeny] = await Promise.all([
      callHttp(base, 'deny', workspaceId),
      callMcp(base, 'deny', workspaceId),
    ])
    expectDenied(httpDeny, workspaceId, 'AUTHZ_EXPLICIT_DENY')
    expectDenied(mcpDeny, workspaceId, 'AUTHZ_EXPLICIT_DENY')

    const [httpScope, mcpScope] = await Promise.all([
      callHttp(base, 'scope', workspaceId),
      callMcp(base, 'scope', workspaceId),
    ])
    expectDenied(httpScope, workspaceId, undefined, false)
    expectDenied(mcpScope, workspaceId, undefined, false)
    expect(httpScope.body.error?.message).toMatch(/无权访问该工作区/u)
    expect(mcpScope.body.error?.message).toMatch(/无权访问该工作区/u)
    expect(JSON.stringify(httpScope.body)).not.toContain(foreignWorkspaceId)
    expect(JSON.stringify(mcpScope.body)).not.toContain(foreignWorkspaceId)

    const audits = await operationAudits.list(workspaceId)
    const decisions = audits.filter(audit => audit.action === 'authz.decision' && [deniedActorId, scopeActorId].includes(audit.actorId))
    expect(decisions).toHaveLength(2)
    expect(decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: deniedActorId, after: expect.objectContaining({ capability: 'workspace.summary.read', result: 'deny', reason_code: 'AUTHZ_EXPLICIT_DENY', decision_id: expect.any(String), request_id: expect.stringMatching(/^req_/), trace_id: expect.stringMatching(/^req_/) }) }),
    ]))
  })
})
