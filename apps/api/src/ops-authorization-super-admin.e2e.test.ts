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

async function call(cookie: string, method = 'ops.authorization.matrix.get') {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { cookie, origin: base, 'x-ops-workbench': 'platform', 'content-type': 'application/json',
      'x-actor-id': 'hyp@sn.com', 'x-account-login': 'hyp@sn.com' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'super-admin-boundary', method, params: {} }),
  })
  return { status: response.status, body: await response.json() as { data: { result: unknown } | null; error: { code: string } | null } }
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
  })

  it('denies an allowlisted login without the platform administrator role', async () => {
    const result = await call(await login('hyp@sn.com', 'security_admin'))
    expect(result.status).toBe(403)
    expect(result.body.error?.code).toBe('FORBIDDEN')
  })
})
