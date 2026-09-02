import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { creativePointsForTests, grantContinuousFeatureEntitlementForTests, server, setAuthorizationRepositoryForTests, workspaceMembers } from './server.js'

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

function authHeaders(token: string, workspaceId: string) {
  return {
    authorization: `Bearer ${token}`,
    'x-workspace-id': workspaceId,
    'x-ops-workbench': 'workspace',
  }
}

async function callHttp(base: string, token: string, workspaceId: string, platform = 'taobao') {
  const response = await fetch(`${base}/v1/platform-accounts/${platform}/authorize`, {
    method: 'POST',
    headers: { ...authHeaders(token, workspaceId), 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  return { response, body: await response.json() as Envelope }
}

async function callMcp(base: string, token: string, workspaceId: string, platform = 'taobao') {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...authHeaders(token, workspaceId), 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `platform-connect-${Date.now()}`,
      method: 'platform.connect',
      params: { platform },
    }),
  })
  return { response, body: await response.json() as Envelope }
}

function configureTokens(entries: Record<string, Record<string, unknown>>) {
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify(entries))
}

function expectRequestEvidence(body: Envelope, workspaceId: string) {
  expect(body.request_id).toMatch(/^req_/)
  expect(body.trace_id).toBe(body.request_id)
  expect(body.workspace_id).toBe(workspaceId)
}

function stableErrorShape(error: Envelope['error']) {
  if (!error) return error
  const details = error.details
    ? Object.fromEntries(Object.entries(error.details).filter(([key]) => key !== 'decision_id'))
    : undefined
  return { code: error.code, message: error.message, ...(details ? { details } : {}) }
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-rbac-platform-connect-parity-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('TAOBAO_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/taobao')
  vi.stubEnv('PUBLIC_OAUTH_REDIRECT_URI', '')
  vi.stubEnv('TAOBAO_APP_KEY', '')
  vi.stubEnv('TAOBAO_CLIENT_ID', '')
  vi.stubEnv('TAOBAO_APP_SECRET', '')
  vi.stubEnv('TAOBAO_CLIENT_SECRET', '')
  vi.stubEnv('TAOBAO_OAUTH_AUTHORIZE_URL', '')
  vi.stubEnv('TAOBAO_OAUTH_TOKEN_URL', '')
  vi.stubEnv('TAOBAO_API_BASE_URL', '')
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('Ops RBAC HTTP/MCP platform connect parity', () => {
  it('keeps the allowed platform-connect request fail-closed at a stable 503 gate before connector handling', async () => {
    const workspaceId = `ws_platform_connect_allow_${Date.now()}`
    const actorId = `platform-connect-allow-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    await creativePointsForTests.grant({
      workspaceId,
      idempotencyKey: `platform-connect-allow-${workspaceId}`,
      sourceType: 'test_fixture',
      sourceId: `platform-connect-allow-${workspaceId}`,
      points: 100,
    })
    grantContinuousFeatureEntitlementForTests(workspaceId)
    configureTokens({
      allow: { workspaces: [workspaceId], actor_id: actorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
    })
    const base = await start()

    const [http, mcp] = await Promise.all([callHttp(base, 'allow', workspaceId), callMcp(base, 'allow', workspaceId)])

    for (const result of [http, mcp]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(503)
      expect(result.body.data).toBeNull()
      expect(['NOT_CONFIGURED', 'OAUTH_STATE_STORE_UNAVAILABLE']).toContain(result.body.error?.code)
      expectRequestEvidence(result.body, workspaceId)
    }
    expect(stableErrorShape(http.body.error)).toEqual(stableErrorShape(mcp.body.error))
  })

  it('keeps explicit deny and cross-workspace scope mismatch aligned before connector handling', async () => {
    const workspaceId = `ws_platform_connect_deny_${Date.now()}`
    const foreignWorkspaceId = `${workspaceId}_foreign`
    const deniedActorId = `platform-connect-deny-${Date.now()}`
    const scopeActorId = `platform-connect-scope-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: deniedActorId, displayName: deniedActorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: scopeActorId, displayName: scopeActorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    configureTokens({
      deny: {
        workspaces: [workspaceId],
        actor_id: deniedActorId,
        roles: ['merchant_admin'],
        denied_capabilities: ['store.connection.update'],
        workbenches: ['workspace'],
      },
      scope: {
        workspaces: [foreignWorkspaceId],
        actor_id: scopeActorId,
        roles: ['merchant_admin'],
        workbenches: ['workspace'],
      },
    })
    const base = await start()

    const [httpDeny, mcpDeny] = await Promise.all([callHttp(base, 'deny', workspaceId), callMcp(base, 'deny', workspaceId)])
    for (const result of [httpDeny, mcpDeny]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({
        code: 'FORBIDDEN',
        details: {
          capability: 'store.connection.update',
          reason_code: 'AUTHZ_EXPLICIT_DENY',
          decision_id: expect.any(String),
          policy_version: AUTHZ_POLICY_VERSION,
          workbench: 'workspace',
        },
      })
      expectRequestEvidence(result.body, workspaceId)
    }
    expect(stableErrorShape(httpDeny.body.error)).toEqual(stableErrorShape(mcpDeny.body.error))

    const [httpScope, mcpScope] = await Promise.all([callHttp(base, 'scope', workspaceId), callMcp(base, 'scope', workspaceId)])
    for (const result of [httpScope, mcpScope]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({ code: 'FORBIDDEN' })
      expect(result.body.error?.message).toMatch(/无权访问该工作区/u)
      expect(JSON.stringify(result.body)).not.toContain(foreignWorkspaceId)
      expectRequestEvidence(result.body, workspaceId)
    }
    expect(stableErrorShape(httpScope.body.error)).toEqual(stableErrorShape(mcpScope.body.error))
  })
})
