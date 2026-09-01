import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { creativePointsForTests, operationAudits, server, setAuthorizationRepositoryForTests, service, workspaceMembers } from './server.js'
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

async function callRevokeHttp(base: string, token: string, workspaceId: string, platform: string, accountId: string, headerAccount = false) {
  const response = await fetch(`${base}/v1/platform-accounts/${platform}${headerAccount ? '' : `?account_id=${encodeURIComponent(accountId)}`}`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${token}`,
      'x-workspace-id': workspaceId,
      'x-ops-workbench': 'workspace',
      ...(headerAccount ? { 'x-account-id': accountId } : {}),
    },
  })
  return { response, body: await response.json() as Envelope }
}

async function callRevokeMcp(base: string, token: string, workspaceId: string, platform: string, accountId: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-workspace-id': workspaceId,
      'x-ops-workbench': 'workspace',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: `platform-revoke-${Date.now()}`, method: 'platform.revoke',
      params: { platform, account_id: accountId },
    }),
  })
  return { response, body: await response.json() as Envelope }
}

async function callTaskTimelineHttp(base: string, token: string, workspaceId: string, taskId: string) {
  const response = await fetch(`${base}/v1/tasks/${encodeURIComponent(taskId)}/timeline`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-workspace-id': workspaceId,
      'x-ops-workbench': 'workspace',
    },
  })
  return { response, body: await response.json() as Envelope }
}

async function callTaskTimelineMcp(base: string, token: string, workspaceId: string, taskId: string) {
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
      id: `task-timeline-cross-tenant-${Date.now()}`,
      method: 'task.timeline',
      params: { task_id: taskId },
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
  // Keep the acceptance slice on the in-memory test adapter so its seeded
  // commercial entitlement is deterministic; strict authorization remains on
  // explicitly rather than relying on the environment name.
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
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
    await creativePointsForTests.grant({ workspaceId, idempotencyKey: `platform-accounts-allow-${workspaceId}`, sourceType: 'test_fixture', sourceId: `platform-accounts-allow-${workspaceId}`, points: 100 })
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

  it('keeps a foreign task account inaccessible over HTTP and MCP without leaking the foreign tenant', async () => {
    const workspaceId = `ws_task_scope_owner_${Date.now()}`
    const foreignWorkspaceId = `ws_task_scope_foreign_${Date.now()}`
    const actorId = `task-scope-owner-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    const foreignAccount = service.registerPlatformAccount({ workspaceId: foreignWorkspaceId, platform: 'taobao', remoteAccountId: `task-scope-foreign-${foreignWorkspaceId}`, credentialRef: `vault://task-scope/${foreignWorkspaceId}` })
    const foreignProduct = service.importProduct({ workspaceId: foreignWorkspaceId, platform: 'taobao', accountId: foreignAccount.id, localProductKey: `task-scope-product-${foreignWorkspaceId}`, title: '跨租户任务商品', stock: 1 })
    const foreignTask = service.createTask({ workspaceId: foreignWorkspaceId, productId: foreignProduct.id, platform: 'taobao', accountId: foreignAccount.id })
    configureToken('task-scope-owner-token', actorId, [workspaceId])
    const base = await start()

    const [http, mcp] = await Promise.all([
      callTaskTimelineHttp(base, 'task-scope-owner-token', workspaceId, foreignTask.id),
      callTaskTimelineMcp(base, 'task-scope-owner-token', workspaceId, foreignTask.id),
    ])

    for (const result of [http, mcp]) {
      expect(result.response.status, JSON.stringify(result.body)).toBe(403)
      expect(result.body.data).toBeNull()
      expect(result.body.error).toMatchObject({ code: 'FORBIDDEN' })
      expect(JSON.stringify(result.body)).not.toContain(foreignWorkspaceId)
      expect(JSON.stringify(result.body)).not.toContain(foreignAccount.id)
      expect(result.body.request_id).toMatch(/^req_/)
      expect(result.body.trace_id).toBe(result.body.request_id)
      expect(result.body.workspace_id).toBe(workspaceId)
    }
    expect(http.body.error?.details?.reason_code).toBe(mcp.body.error?.details?.reason_code)
    expect(http.body.error?.details?.required_scope).toBe(mcp.body.error?.details?.required_scope)
  })

  it('uses the exact account scope for platform revoke over HTTP and MCP', async () => {
    const workspaceId = `ws_revoke_scope_${Date.now()}`
    const foreignWorkspaceId = `${workspaceId}_foreign`
    const actorId = `revoke-scope-owner-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'merchant_admin', status: 'active', invitedBy: 'acceptance-test' })
    const localAccount = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `revoke-local-${workspaceId}`, credentialRef: `vault://revoke/${workspaceId}` })
    const foreignAccount = service.registerPlatformAccount({ workspaceId: foreignWorkspaceId, platform: 'taobao', remoteAccountId: `revoke-foreign-${foreignWorkspaceId}`, credentialRef: `vault://revoke/${foreignWorkspaceId}` })
    await creativePointsForTests.grant({ workspaceId, idempotencyKey: `revoke-scope-${workspaceId}`, sourceType: 'test_fixture', sourceId: `revoke-scope-${workspaceId}`, points: 100 })
    configureToken('revoke-scope-owner-token', actorId, [workspaceId])
    const base = await start()

    const [http, mcp] = await Promise.all([
      callRevokeHttp(base, 'revoke-scope-owner-token', workspaceId, 'taobao', localAccount.id, true),
      callRevokeMcp(base, 'revoke-scope-owner-token', workspaceId, 'taobao', foreignAccount.id),
    ])

    expect(http.response.status, JSON.stringify(http.body)).toBe(503)
    expect(http.body.error?.code).toBe('PLATFORM_REVOKE_REMOTE_FAILED')
    expect(service.getPlatformAccount(workspaceId, localAccount.id, 'taobao').tokenState).toBe('revoked')
    expect(mcp.response.status, JSON.stringify(mcp.body)).toBe(403)
    expect(mcp.body.error).toMatchObject({ code: 'FORBIDDEN', details: { required_scope: 'account', reason_code: 'AUTHZ_SCOPE_MISMATCH' } })
    expect(JSON.stringify(mcp.body)).not.toContain(foreignWorkspaceId)
    expect(JSON.stringify(mcp.body)).not.toContain(foreignAccount.id)
  })
})
