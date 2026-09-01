import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { operationAudits, server, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'

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
    'x-ops-workbench': 'workspace',
    'x-workspace-id': workspaceId,
  }
}

async function callHttp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/v1/rules`, { headers: headers(token, workspaceId) })
  return { response, body: await response.json() as Envelope }
}

async function callMcp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...headers(token, workspaceId), 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'rule.list', params: {} }),
  })
  return { response, body: await response.json() as Envelope }
}

function resultOf(body: Envelope) {
  return body.data && typeof body.data === 'object' && 'result' in body.data
    ? (body.data as { result?: unknown }).result
    : body.data
}

function configureTokens(workspaceId: string, allowedActor: string, deniedActor: string) {
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
    'rules-parity-allow-token': { workspaces: [workspaceId], actor_id: allowedActor, roles: ['merchant_admin'], workbenches: ['workspace'] },
    'rules-parity-deny-token': { workspaces: [workspaceId], actor_id: deniedActor, roles: ['merchant_admin'], denied_capabilities: ['customer.content.read'], workbenches: ['workspace'] },
  }))
}

beforeEach(() => {
  // The local service intentionally serves the in-memory rule projection when
  // no durable rule repository is configured. This keeps the parity assertion
  // about transport/authz semantics instead of turning missing production
  // infrastructure into the expected result.
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-rbac-http-rules-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('Ops RBAC HTTP/MCP rules parity', () => {
  it('returns the same authorized rule read over HTTP and MCP', async () => {
    const workspaceId = `ws_rules_parity_allow_${Date.now()}`
    const actorId = `rules-parity-allow-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    configureTokens(workspaceId, actorId, `unused-denied-${Date.now()}`)
    const base = await start()

    const [http, mcp] = await Promise.all([
      callHttp(base, 'rules-parity-allow-token', workspaceId),
      callMcp(base, 'rules-parity-allow-token', workspaceId),
    ])

    expect(http.response.status, JSON.stringify(http.body)).toBe(200)
    expect(mcp.response.status, JSON.stringify(mcp.body)).toBe(200)
    expect(http.body.error).toBeNull()
    expect(mcp.body.error).toBeNull()
    expect(resultOf(http.body)).toEqual(resultOf(mcp.body))
  })

  it('keeps explicit deny and cross-workspace scope denial aligned with auditable evidence', async () => {
    const workspaceId = `ws_rules_parity_deny_${Date.now()}`
    const deniedActorId = `rules-parity-deny-${Date.now()}`
    const scopeActorId = `rules-parity-scope-${Date.now()}`
    const otherWorkspaceId = `${workspaceId}_other`
    await workspaceMembers.upsert({ workspaceId, externalSubject: deniedActorId, displayName: deniedActorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: scopeActorId, displayName: scopeActorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'rules-parity-deny-token': { workspaces: [workspaceId], actor_id: deniedActorId, roles: ['merchant_admin'], denied_capabilities: ['customer.content.read'], workbenches: ['workspace'] },
      'rules-parity-scope-token': { workspaces: [workspaceId], actor_id: scopeActorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()

    const denied = await Promise.all([
      callHttp(base, 'rules-parity-deny-token', workspaceId),
      callMcp(base, 'rules-parity-deny-token', workspaceId),
    ])
    for (const result of denied) {
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
    }

    const scoped = await Promise.all([
      callHttp(base, 'rules-parity-scope-token', otherWorkspaceId),
      callMcp(base, 'rules-parity-scope-token', otherWorkspaceId),
    ])
    for (const result of scoped) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({ code: 'FORBIDDEN' })
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
    }

    const audits = await operationAudits.list(workspaceId)
    const denialAudits = audits.filter(audit => audit.action === 'authz.decision' && audit.actorId === deniedActorId)
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
