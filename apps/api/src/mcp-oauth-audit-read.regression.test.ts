import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import { operationAudits, server, setAuthorizationRepositoryForTests, setPasswordAuthRepositoryForTests, workspaceMembers } from './server.js'

type Envelope<T = unknown> = { data?: { result?: T }; error?: { code: string; details?: Record<string, unknown> } | null }

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'isolated-audit-read-regression-session-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  setAuthorizationRepositoryForTests(new MemoryAuthorizationRepository())
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setPasswordAuthRepositoryForTests(undefined)
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

async function managedWorkspaceSession(role: 'workspace_owner' | 'platform_ops' = 'workspace_owner') {
  const suffix = randomUUID()
  const workspaceId = `ws_managed_audit_${suffix}`
  const login = `audit-${suffix}@example.test`
  const password = 'IsolatedAudit1234!'
  const repository = new MemoryPasswordAuthRepository()
  setPasswordAuthRepositoryForTests(repository)
  const account = await repository.createMerchantAccount({ login, password, enterpriseName: 'Isolated audit regression', contactName: 'Fixture owner', workspaceIds: [workspaceId], actorId: 'fixture-platform-owner', reason: 'Hermetic managed MCP audit regression' })
  await workspaceMembers.upsert({ workspaceId, externalSubject: login, displayName: 'Fixture member', role, status: 'active', invitedBy: 'audit-regression' })
  await workspaceMembers.bindIdentity({ workspaceId, externalSubject: login, identityId: account.identityId })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  const base = `http://127.0.0.1:${address.port}`
  vi.stubEnv('PUBLIC_APP_BASE_URL', base)
  const logged = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'merchant' }) })
  expect(logged.status).toBe(200)
  const cookie = logged.headers.get('set-cookie')?.split(';')[0]
  expect(cookie).toBeTruthy()
  const exchanged = await fetch(`${base}/v1/auth/mcp-token`, { method: 'POST', headers: { cookie: cookie!, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: workspaceId }) })
  expect(exchanged.status).toBe(200)
  type IssuedToken = { access_token: string; scope: string; workspace_id: string }
  const tokenEnvelope = await exchanged.json() as { data?: IssuedToken | { result?: IssuedToken } }
  const token = tokenEnvelope.data && 'result' in tokenEnvelope.data ? tokenEnvelope.data.result : tokenEnvelope.data as IssuedToken | undefined
  expect(token?.scope).toBe('merchant')
  expect(token?.workspace_id).toBe(workspaceId)
  expect(typeof token?.access_token).toBe('string')
  const call = async <T = unknown>(method: string, params: Record<string, unknown> = {}, requestWorkspaceId = workspaceId, workbench = 'workspace') => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token!.access_token}`, 'content-type': 'application/json', 'x-workspace-id': requestWorkspaceId, 'x-ops-workbench': workbench }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }) })
    return { status: response.status, body: await response.json() as Envelope<T> }
  }
  return { workspaceId, account, login, call }
}

describe('managed local MCP workspace audit.read parity', () => {
  it('honors advertised audit.read for a normal password-issued MCP identity and returns only redacted own-workspace rows', async () => {
    const { workspaceId, account, call } = await managedWorkspaceSession()
    const resourceId = `audit-fixture-${randomUUID()}`
    for (const target of [workspaceId, `${workspaceId}_foreign`]) await operationAudits.append({ workspaceId: target, actorId: 'isolated-fixture', action: 'credential.review', resourceType: 'regression_fixture', resourceId, before: { access_token: 'isolated-secret-must-not-leak' }, after: { state: 'reviewed' }, reason: 'Hermetic audit visibility fixture' })
    const session = await call<{ workbench: string; workspace_id: string; actor_id: string; capabilities: string[]; effective_permissions: Array<{ capability: string; effect: string }>; identity_id: string; session_id: string }>('ops.session')
    expect(session.status).toBe(200)
    expect(session.body.data?.result).toMatchObject({ workbench: 'workspace', workspace_id: workspaceId, actor_id: account.identityId, identity_id: account.identityId, session_id: expect.any(String) })
    expect(session.body.data?.result?.capabilities).toContain('audit.read')
    expect(session.body.data?.result?.effective_permissions).toEqual(expect.arrayContaining([expect.objectContaining({ capability: 'audit.read', effect: 'allow' })]))
    const audit = await call<{ records: Array<{ workspaceId: string; resourceId: string; redacted: boolean }> }>('ops.audit.list', { sources_json: '["operation"]', limit: '20' })
    expect(audit.status).toBe(200)
    expect(audit.body.error).toBeNull()
    const records = audit.body.data?.result?.records ?? []
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ workspaceId, resourceId, redacted: true })]))
    expect(records.every(row => row.workspaceId === workspaceId && row.redacted)).toBe(true)
    expect(JSON.stringify(audit.body.data?.result)).not.toContain('isolated-secret-must-not-leak')
  })

  it('retains exact tenant binding and denies platform audit, detail, export and unrelated ops methods', async () => {
    const { workspaceId, call } = await managedWorkspaceSession()
    expect((await call('ops.audit.list', {}, `${workspaceId}_foreign`)).status).toBe(403)
    expect((await call('ops.audit.list', { workspace_id: `${workspaceId}_foreign` })).body.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
    for (const method of ['ops.audit.platform.list', 'ops.audit.detail', 'ops.audit.export', 'ops.users.list']) {
      const denied = await call(method)
      expect(denied.status, method).toBe(403)
      expect(denied.body.error?.code, method).toBe('FORBIDDEN')
      expect(denied.body.data, method).toBeNull()
    }
    const platform = await call('ops.audit.platform.list', {}, workspaceId, 'platform')
    expect(platform.status).toBe(403)
  })

  it('does not treat an unsupported platform_ops membership label as audit.read or platform authorization', async () => {
    // This raw legacy membership label has no canonical workspace capability;
    // it must not be interpreted as the platform gateway role of the same name.
    const { call } = await managedWorkspaceSession('platform_ops')
    const denied = await call('ops.audit.list')
    expect(denied.status).toBe(403)
    expect(denied.body.error?.details).toMatchObject({ capability: 'audit.read' })
    expect(denied.body.data).toBeNull()
  })
})
