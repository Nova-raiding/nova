import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import argon2 from 'argon2'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'

let api: typeof import('./server.js')
let base: string
let repository: MemoryPasswordAuthRepository

type Session = { actor_id: string; account_login: string | null; identity_id: string; roles: string[]; capabilities: string[]; scopes: unknown[]; effective_permissions: unknown[] }
type Envelope = { data: { result: Session } | null; error: { code: string; details?: Record<string, unknown> } | null }

async function createAccount(login: string, roles = ['platform_admin']) {
  const password = 'AccountDisplayPassword123!'
  await repository.ensurePlatformAccount({ login, passwordHash: await argon2.hash(password), roles: [] })
  const identityId = (await repository.listAccounts()).find(account => account.login === login)!.identityId
  if (roles.length) await api.persistenceReady.then(async persistence => persistence.authorization?.assignPlatformRole({ subjectIdentityId: identityId, role: roles[0] as 'platform_admin', assignedBy: 'password-account-display-test', reason: 'Fixture canonical platform authorization role', expectedAuthorizationRevision: 0 }))
  const response = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'platform' }) })
  expect(response.status).toBe(200)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  expect(cookie).toBeTruthy()
  return { login, identityId, cookie: cookie! }
}

async function post(cookie: string, options: { forgedOidc?: boolean; method?: string; params?: Record<string, unknown> } = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      cookie,
      origin: base,
      'x-ops-workbench': 'platform',
      'content-type': 'application/json',
      ...(options.forgedOidc ? { 'x-oidc-sub': 'forged-admin', 'x-oidc-roles': 'platform_admin', 'x-oidc-signature': '0'.repeat(64), 'x-oidc-display-login': 'admin@example.test' } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'password-session-account-display', method: options.method ?? 'ops.session', params: options.params ?? {} }),
  })
  return { status: response.status, body: await response.json() as Envelope }
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
  repository = new MemoryPasswordAuthRepository()
  api.setPasswordAuthRepositoryForTests(repository)
  vi.stubEnv('PLATFORM_ACCOUNT_LOGIN', '')
  vi.stubEnv('PLATFORM_ACCOUNT_PASSWORD_HASH', '')
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error)
    api.server.once('error', failed)
    api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', failed); resolve() })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('password account display test server did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  api?.setPasswordAuthRepositoryForTests()
  vi.unstubAllEnvs()
})

describe('password account identity HTTP boundary', () => {
  it('keeps login labels separate from the stable actor and authorization projection', async () => {
    const account = await createAccount('ops-account@example.test')
    const first = await post(account.cookie)
    const second = await post(account.cookie, { forgedOidc: true })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.body.data?.result).toMatchObject({ actor_id: account.identityId, identity_id: account.identityId, account_login: account.login, roles: ['platform_admin'] })
    expect(second.body.data?.result.actor_id).toBe(first.body.data?.result.actor_id)
    expect(second.body.data?.result.identity_id).toBe(first.body.data?.result.identity_id)
    expect(second.body.data?.result.roles).toEqual(first.body.data?.result.roles)
    expect(second.body.data?.result.capabilities).toEqual(first.body.data?.result.capabilities)
    expect(second.body.data?.result.scopes).toEqual(first.body.data?.result.scopes)
    expect(second.body.data?.result.effective_permissions).toEqual(first.body.data?.result.effective_permissions)
  })

  it('does not merge distinct accounts that share an account display label', async () => {
    const first = await createAccount('same-label@example.test')
    const otherPassword = 'AccountDisplayPassword123!'
    await repository.ensurePlatformAccount({ login: 'second-account@example.test', passwordHash: await argon2.hash(otherPassword), roles: ['platform_admin'] })
    const login = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'second-account@example.test', password: otherPassword, account_type: 'platform' }) })
    expect(login.status).toBe(200)
    const secondCookie = login.headers.get('set-cookie')?.split(';')[0]!
    const firstSession = await post(first.cookie)
    const secondSession = await post(secondCookie)
    expect(firstSession.body.data?.result.identity_id).not.toBe(secondSession.body.data?.result.identity_id)
    expect(firstSession.body.data?.result.actor_id).not.toBe(secondSession.body.data?.result.actor_id)
  })

  it('rejects requests with OIDC identity headers but no password session', async () => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-oidc-sub': 'forged', 'x-oidc-roles': 'platform_admin', 'x-oidc-signature': '0'.repeat(64), 'x-ops-workbench': 'platform' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'legacy-oidc-only', method: 'ops.session', params: {} }) })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
  })

  it('does not let a password account without platform role borrow a forged OIDC administrator claim', async () => {
    const account = await createAccount('no-role@example.test', [])
    const response = await post(account.cookie, { forgedOidc: true })
    expect(response.status).toBe(200)
    expect(response.body.data?.result).toMatchObject({ identity_id: account.identityId, account_login: account.login, roles: [] })
    expect(response.body.data?.result.capabilities).not.toContain('authorization.grant.manage')
  })
})
