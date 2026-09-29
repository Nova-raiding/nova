import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import argon2 from 'argon2'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'

let api: typeof import('./server.js')
let repository: MemoryPasswordAuthRepository
let base: string

async function login(login: string, role: 'platform_admin' | 'ops_admin' | 'security_admin' = 'platform_admin') {
  const password = 'SuperAdminContractPassword123!'
  await repository.ensurePlatformAccount({ login, passwordHash: await argon2.hash(password), roles: [] })
  const identityId = (await repository.listAccounts()).find(account => account.login === login)!.identityId
  await api.persistenceReady.then(async persistence => persistence.authorization?.assignPlatformRole({
    subjectIdentityId: identityId, role, assignedBy: 'super-admin-contract-test',
    reason: 'Verify real MCP authorization boundary', expectedAuthorizationRevision: 0,
  }))
  const response = await fetch(`${base}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password, account_type: 'platform' }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  expect(cookie).toBeTruthy()
  return cookie!
}

async function call(cookie: string, method = 'ops.authorization.matrix.get', params: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { cookie, origin: base, 'x-ops-workbench': 'platform', 'content-type': 'application/json',
      'x-actor-id': 'hyp@sn.com', 'x-account-login': 'hyp@sn.com' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'super-admin-boundary', method, params }),
  })
  return { status: response.status, body: await response.json() as { data: { result: unknown } | null; error: { code: string } | null } }
}

async function createPlatformIdentity(login: string) {
  const password = 'RulesAdminContractPassword123!'
  await repository.ensurePlatformAccount({ login, passwordHash: await argon2.hash(password), roles: [] })
  const identityId = (await repository.listAccounts()).find(account => account.login === login)!.identityId
  return { login, password, identityId }
}

async function loginExisting(login: string, password: string) {
  const response = await fetch(`${base}/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password, account_type: 'platform' }),
  })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  expect(cookie).toBeTruthy()
  return cookie!
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('OPS_DATABASE_URL', '')
  vi.stubEnv('REDIS_URL', '')
  api = await import('./server.js')
})

beforeEach(async () => {
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('OPS_AUTH_MODE', 'password')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED', 'true')
  vi.stubEnv('MERCHANT_BEARER_HOSTNAME', '')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('OPS_API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('PLATFORM_ACCOUNT_LOGIN', '')
  vi.stubEnv('PLATFORM_ACCOUNT_PASSWORD_HASH', '')
  repository = new MemoryPasswordAuthRepository()
  api.setPasswordAuthRepositoryForTests(repository)
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error)
    api.server.once('error', failed)
    api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', failed); resolve() })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  api?.setPasswordAuthRepositoryForTests()
  vi.unstubAllEnvs()
})

describe('authorization MCP password session boundary', () => {
  it('denies another platform administrator despite forged allowlisted account headers', async () => {
    const result = await call(await login('devide@sn.com'))
    expect(result.status).toBe(403)
    expect(result.body.error?.code).toBe('FORBIDDEN')
  })

  it.each(['hyp@sn.com', 'hxd@sn.com'])('allows designated administrator %s', async account => {
    const result = await call(await login(account))
    expect(result.status).toBe(200)
    expect(result.body.error).toBeNull()
    const matrix = result.body.data?.result as { items: Array<{ method: string; role_access: Record<string, string> }> }
    for (const method of ['workspace.activate', 'workspace.deactivate']) {
      const item = matrix.items.find(candidate => candidate.method === method)
      expect(item).toBeDefined()
      expect(item?.role_access).toMatchObject({ workspace_owner: 'govern', platform_admin: 'hidden', ops_admin: 'hidden', workspace_admin: 'hidden' })
    }
  })

  it('denies an allowlisted login without the platform administrator role', async () => {
    const result = await call(await login('hyp@sn.com', 'security_admin'))
    expect(result.status).toBe(403)
    expect(result.body.error?.code).toBe('FORBIDDEN')
  })

  it('grants two independent platform identities rules_admin through the authenticated Ops mutation', async () => {
    const administratorCookie = await login('hyp@sn.com')
    const maker = await createPlatformIdentity('rules-maker@example.test')
    const checker = await createPlatformIdentity('rules-checker@example.test')

    for (const target of [maker, checker]) {
      const before = await call(administratorCookie, 'ops.authorization.roles.list', { subject_identity_id: target.identityId })
      expect(before.status).toBe(200)
      expect(before.body.data?.result).toMatchObject({ subject_identity_id: target.identityId, authorization_revision: 0, assignments: [] })

      const assigned = await call(administratorCookie, 'ops.authorization.role.assign', {
        subject_identity_id: target.identityId,
        role: 'rules_admin',
        expected_authorization_revision: '0',
        reason: `QA-RULES-ADMIN-${target.login}: independently authorised local acceptance identity`,
      })
      expect(assigned.status).toBe(200)
      expect(assigned.body.data?.result).toMatchObject({
        subjectIdentityId: target.identityId,
        role: 'rules_admin',
        assignedBy: expect.any(String),
        authorizationRevision: 1,
        revision: 1,
      })

      const after = await call(administratorCookie, 'ops.authorization.roles.list', { subject_identity_id: target.identityId })
      expect(after.body.data?.result).toMatchObject({
        subject_identity_id: target.identityId,
        authorization_revision: 1,
        assignments: [expect.objectContaining({ subjectIdentityId: target.identityId, role: 'rules_admin' })],
      })
    }

    const sessions = await Promise.all([maker, checker].map(async target => {
      const cookie = await loginExisting(target.login, target.password)
      const session = await call(cookie, 'ops.session')
      expect(session.status).toBe(200)
      return session.body.data?.result as { identity_id: string; canonical_roles: string[]; capabilities: string[]; effective_permissions: Array<{ source: string }> }
    }))

    expect(sessions.map(session => session.identity_id)).toEqual([maker.identityId, checker.identityId])
    for (const session of sessions) {
      expect(session.canonical_roles).toContain('rules_admin')
      expect(session.capabilities).toEqual(expect.arrayContaining(['rule.read', 'rule.update', 'rule.publish.approve']))
      expect(session.effective_permissions).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'platform_assignment' })]))
    }
  })
})
