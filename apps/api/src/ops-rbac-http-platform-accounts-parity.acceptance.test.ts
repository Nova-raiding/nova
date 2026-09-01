import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operationAudits, server, setAuthorizationRepositoryForTests, service, workspaceMembers } from './server.js'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'

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

async function callHttp(base: string, token: string, workspaceId: string) {
  const response = await fetch(`${base}/v1/platform-accounts`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-workspace-id': workspaceId,
      'x-ops-workbench': 'workspace',
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
      'x-workspace-id': workspaceId,
      'x-ops-workbench': 'workspace',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `platform-store-list-${Date.now()}`,
      method: 'platform.store.list',
      params: {},
    }),
  })
  return { response, body: await response.json() as Envelope }
}

function configureToken(token: string, actorId: string, workspaces: string[], extra: Record<string, unknown> = {}) {
  const configured = JSON.parse(process.env.API_AUTH_TOKENS ?? '{}') as Record<string, unknown>
  configured[token] = { workspaces, actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'], ...extra }
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify(configured))
}

function expectRequestEvidence(body: Envelope, workspaceId: string, decision = true) {
  expect(body.data).toBeNull()
  expect(body.error, JSON.stringify(body)).toMatchObject({ code: 'FORBIDDEN' })
  if (decision) {
    expect(body.error).toMatchObject({ details: { decision_id: expect.any(String), policy_version: AUTHZ_POLICY_VERSION, workbench: 'workspace' } })
  }
  expect(body.request_id).toMatch(/^req_/)
  expect(body.trace_id).toBe(body.request_id)
  expect(body.workspace_id).toBe(workspaceId)
}

function resultOf(body: Envelope) {
  if (!body.data || typeof body.data !== 'object') return undefined
  return 'result' in body.data ? body.data.result : body.data
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-rbac-platform-accounts-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('Ops HTTP/MCP platform account list parity', () => {
  it('returns the same allow result for the registered HTTP and MCP resource', async () => {
    const workspaceId = `ws_platform_accounts_allow_${Date.now()}`
    const actorId = `platform-accounts-allow-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `platform-accounts-${workspaceId}`, credentialRef: `vault://platform-accounts/${workspaceId}` })
    configureToken('platform-accounts-allow-token', actorId, [workspaceId])
    const base = await start()

    const [http, mcp] = await Promise.all([
      callHttp(base, 'platform-accounts-allow-token', workspaceId),
      callMcp(base, 'platform-accounts-allow-token', workspaceId),
    ])

    expect(http.response.status, JSON.stringify(http.body)).toBe(200)
    expect(mcp.response.status, JSON.stringify(mcp.body)).toBe(200)
    expect(http.body.error).toBeNull()
    expect(mcp.body.error).toBeNull()
    expect(resultOf(http.body)).toEqual(resultOf(mcp.body))
    expect(JSON.stringify(http.body.data)).not.toContain('vault://')
    expect(JSON.stringify(mcp.body.data)).not.toContain('vault://')
  })

  it('keeps explicit deny and cross-workspace scope mismatch aligned, with auditable decisions', async () => {
    const workspaceId = `ws_platform_accounts_deny_${Date.now()}`
    const foreignWorkspaceId = `${workspaceId}_foreign`
    const deniedActorId = `platform-accounts-deny-${Date.now()}`
    const scopeActorId = `platform-accounts-scope-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: deniedActorId, displayName: deniedActorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: scopeActorId, displayName: scopeActorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    configureToken('platform-accounts-deny-token', deniedActorId, [workspaceId], { denied_capabilities: ['store.connection.read'] })
    configureToken('platform-accounts-scope-token', scopeActorId, [foreignWorkspaceId])
    const base = await start()

    const [httpDeny, mcpDeny] = await Promise.all([
      callHttp(base, 'platform-accounts-deny-token', workspaceId),
      callMcp(base, 'platform-accounts-deny-token', workspaceId),
    ])
    for (const result of [httpDeny, mcpDeny]) expectRequestEvidence(result.body, workspaceId)
    expect(httpDeny.body.error?.details?.capability).toBe(mcpDeny.body.error?.details?.capability)
    expect(httpDeny.body.error?.details?.reason_code).toBe('AUTHZ_EXPLICIT_DENY')
    expect(mcpDeny.body.error?.details?.reason_code).toBe('AUTHZ_EXPLICIT_DENY')

    const [httpScope, mcpScope] = await Promise.all([
      callHttp(base, 'platform-accounts-scope-token', workspaceId),
      callMcp(base, 'platform-accounts-scope-token', workspaceId),
    ])
    for (const result of [httpScope, mcpScope]) expectRequestEvidence(result.body, workspaceId, false)
    expect(httpScope.body.error?.message).toMatch(/无权访问该工作区/u)
    expect(mcpScope.body.error?.message).toMatch(/无权访问该工作区/u)
    expect(JSON.stringify(httpScope.body)).not.toContain(foreignWorkspaceId)
    expect(JSON.stringify(mcpScope.body)).not.toContain(foreignWorkspaceId)

    const audits = await operationAudits.list(workspaceId)
    const denialAudits = audits.filter(audit => audit.action === 'authz.decision' && [deniedActorId, scopeActorId].includes(audit.actorId))
    expect(denialAudits).toHaveLength(2)
    expect(denialAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({ actorId: deniedActorId, after: expect.objectContaining({ result: 'deny', reason_code: 'AUTHZ_EXPLICIT_DENY', policy_version: AUTHZ_POLICY_VERSION, decision_id: expect.any(String) }) }),
    ]))
  })
})
