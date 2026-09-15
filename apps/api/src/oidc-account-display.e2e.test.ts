import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'

let api: typeof import('./server.js')
let base: string
const signingSecret = 'oidc-account-display-http-test-secret'
const issuer = 'https://oidc-account-display.example.test'
const displayHeader = 'x-oidc-display-login'
const versionHeader = 'x-oidc-proof-version'

type Identity = { subject: string; workspaceId: string; sid: string; authTime: string; expiresAt: string }
type Proof = { headers: Record<string, string>; body: string }
type Session = {
  actor_id: string
  account_login: string | null
  identity_id: string
  roles: string[]
  capabilities: string[]
  scopes: unknown[]
  effective_permissions: unknown[]
}
type Envelope = { data: { result: Session } | null; error: { code: string; details?: Record<string, unknown> } | null }

function identity(workspaceId = `ws_oidc_display_${randomUUID()}`): Identity {
  const now = Math.floor(Date.now() / 1000)
  return { subject: `subject-${randomUUID()}`, workspaceId, sid: `session-${randomUUID()}`, authTime: String(now - 10), expiresAt: String(now + 3600) }
}

// Build the wire proof independently of the production parser, so a regression
// in the parser cannot also silently redefine what the HTTP test signs.
function proof(user: Identity, options: { legacy?: boolean; login?: string; encodedLogin?: string; method?: string; params?: Record<string, string> } = {}): Proof {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = randomBytes(24).toString('base64url')
  const body = JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: options.method ?? 'ops.session', params: options.params ?? {} })
  const bodyDigest = createHash('sha256').update(body).digest('hex')
  // Intentionally no gateway roles: a wrong alias-member match must not be
  // hidden by MEMBER_ROLE_MISMATCH before its privilege escalation is observed.
  const fields = ['POST', '/mcp', user.workspaceId, 'workspace', issuer, user.subject, user.sid, '', '', user.authTime, user.expiresAt, timestamp, bodyDigest, nonce]
  const encodedLogin = options.encodedLogin ?? Buffer.from(options.login ?? 'operator@example.test', 'utf8').toString('base64url')
  const canonical = (options.legacy ? fields : ['oidc-v2', ...fields, encodedLogin]).join('\n')
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-workspace-id': user.workspaceId,
      'x-ops-workbench': 'workspace',
      'x-oidc-workspace': user.workspaceId,
      'x-oidc-workbench': 'workspace',
      'x-oidc-issuer': issuer,
      'x-oidc-sub': user.subject,
      'x-oidc-sid': user.sid,
      'x-oidc-auth-time': user.authTime,
      'x-oidc-session-expires-at': user.expiresAt,
      'x-oidc-timestamp': timestamp,
      'x-oidc-body-sha256': bodyDigest,
      'x-oidc-nonce': nonce,
      'x-oidc-signature': createHmac('sha256', signingSecret).update(canonical).digest('hex'),
      ...(options.legacy ? {} : { [versionHeader]: '2', [displayHeader]: encodedLogin }),
    },
  }
}

async function post(request: Proof) {
  const response = await fetch(`${base}/mcp`, { method: 'POST', ...request, credentials: 'omit', signal: AbortSignal.timeout(5000) })
  return { status: response.status, body: await response.json() as Envelope }
}

async function session(request: Proof): Promise<Session> {
  const response = await post(request)
  expect(response.status).toBe(200)
  expect(response.body.error).toBeNull()
  expect(response.body.data?.result).toBeDefined()
  return response.body.data!.result
}

async function member(user: Identity, role: 'operator' | 'merchant_admin' = 'operator', status: 'active' | 'suspended' = 'active') {
  return api.workspaceMembers.upsert({ workspaceId: user.workspaceId, externalSubject: user.subject, displayName: 'OIDC display HTTP fixture', role, status, invitedBy: 'oidc-display-http-test' })
}

beforeAll(async () => {
  // Import the composition root only after pinning memory adapters. These HTTP
  // tests must never use a developer's local Postgres/Redis or start containers.
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('DATABASE_URL', '')
  vi.stubEnv('OPS_DATABASE_URL', '')
  vi.stubEnv('REDIS_URL', '')
  api = await import('./server.js')
})

beforeEach(async () => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('OPS_AUTH_MODE', 'oidc')
  vi.stubEnv('OIDC_PROXY_SIGNING_SECRET', signingSecret)
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'oidc-display-http-session-hash-secret')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED', 'true')
  vi.stubEnv('MERCHANT_BEARER_HOSTNAME', '')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('OPS_API_RATE_LIMIT_PER_MINUTE', '10000')
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error)
    api.server.once('error', failed)
    api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', failed); resolve() })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('OIDC display test server did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterEach(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('OIDC account display HTTP boundary', () => {
  it('returns the signed Unicode login without changing actor, durable identity or authorization when it changes', async () => {
    const user = identity()
    await member(user)
    const first = await session(proof(user, { login: '运营账号@example.test' }))
    const renamed = await session(proof(user, { login: 'Cafe\u0301@example.test' }))
    expect(first).toMatchObject({ actor_id: user.subject, account_login: '运营账号@example.test', roles: ['operator'] })
    expect(renamed.account_login).toBe('Cafe\u0301@example.test')
    expect(renamed.account_login).not.toBe('Café@example.test')
    expect(renamed.actor_id).toBe(first.actor_id)
    expect(first.identity_id).toEqual(expect.any(String))
    expect(first.identity_id).not.toBe(user.subject)
    expect(renamed.identity_id).toBe(first.identity_id)
    expect(renamed.roles).toEqual(first.roles)
    expect(renamed.capabilities).toEqual(first.capabilities)
    expect(renamed.scopes).toEqual(first.scopes)
    expect(renamed.effective_permissions).toEqual(first.effective_permissions)
  })

  it('keeps two different subjects with the same displayed login on different durable identities', async () => {
    const firstUser = identity(), secondUser = identity(firstUser.workspaceId)
    await member(firstUser)
    await member(secondUser)
    const first = await session(proof(firstUser, { login: 'same@example.test' }))
    const second = await session(proof(secondUser, { login: 'same@example.test' }))
    expect(first.account_login).toBe(second.account_login)
    expect(first.actor_id).toBe(firstUser.subject)
    expect(second.actor_id).toBe(secondUser.subject)
    expect(second.identity_id).not.toBe(first.identity_id)
  })

  it('accepts a legacy proof with null display and does not carry a previous v2 login into that request', async () => {
    const user = identity()
    await member(user)
    const displayed = await session(proof(user, { login: 'temporary-label@example.test' }))
    const legacy = await session(proof(user, { legacy: true }))
    expect(legacy).toMatchObject({ actor_id: user.subject, account_login: null, identity_id: displayed.identity_id })
    expect(legacy.roles).toEqual(displayed.roles)
    expect(legacy.capabilities).toEqual(displayed.capabilities)
  })

  it.each(['legacy-add-login', 'legacy-add-version', 'legacy-add-both', 'v2-remove-login', 'v2-remove-version', 'v2-remove-both', 'v2-change-login', 'v2-change-version'] as const)('rejects header alteration without falling back to another proof format: %s', async alteration => {
    const user = identity()
    await member(user)
    const request = proof(user, { legacy: alteration.startsWith('legacy-') })
    if (alteration === 'legacy-add-login' || alteration === 'legacy-add-both') request.headers[displayHeader] = Buffer.from('forged@example.test').toString('base64url')
    if (alteration === 'legacy-add-version' || alteration === 'legacy-add-both') request.headers[versionHeader] = '2'
    if (alteration === 'v2-remove-login' || alteration === 'v2-remove-both') delete request.headers[displayHeader]
    if (alteration === 'v2-remove-version' || alteration === 'v2-remove-both') delete request.headers[versionHeader]
    if (alteration === 'v2-change-login') request.headers[displayHeader] = Buffer.from('forged@example.test').toString('base64url')
    if (alteration === 'v2-change-version') request.headers[versionHeader] = '3'
    const response = await post(request)
    expect(response.status).toBe(401)
    expect(response.body.data).toBeNull()
    expect(response.body.error).not.toBeNull()
  })

  it.each([
    ['padding', Buffer.from('valid').toString('base64')],
    ['invalid alphabet', 'not%base64url'],
    ['invalid UTF8', Buffer.from([0xc3, 0x28]).toString('base64url')],
    ['empty display', ''],
    ['leading whitespace', Buffer.from(' operator').toString('base64url')],
    ['trailing whitespace', Buffer.from('operator ').toString('base64url')],
    ['control character', Buffer.from('operator\u0000').toString('base64url')],
    ['bidi format character', Buffer.from('operator\u202e').toString('base64url')],
    ['line separator', Buffer.from('operator\u2028').toString('base64url')],
    ['too many codepoints', Buffer.from('x'.repeat(257)).toString('base64url')],
    ['too many UTF8 bytes', Buffer.from('中'.repeat(171)).toString('base64url')],
  ])('rejects an invalid display encoding even under an otherwise valid signature: %s', async (_label, encodedLogin) => {
    const user = identity()
    await member(user)
    const response = await post(proof(user, { encodedLogin }))
    expect(response.status).toBe(401)
    expect(response.body.data).toBeNull()
  })

  it('rejects a replayed v2 proof and an actor header claiming the display login', async () => {
    const user = identity()
    await member(user)
    const request = proof(user, { login: 'display-only@example.test' })
    await session(request)
    expect((await post(request)).status).toBe(401)
    const mismatch = proof(user, { login: 'display-only@example.test' })
    mismatch.headers['x-actor-id'] = 'display-only@example.test'
    expect((await post(mismatch)).status).toBe(403)
  })

  it('does not select an earlier administrator membership by the operator display login or permit member mutation', async () => {
    const user = identity()
    const adminSubject = `admin-alias-${randomUUID()}@example.test`
    await member({ ...user, subject: adminSubject }, 'merchant_admin')
    await member(user)
    const current = await session(proof(user, { login: adminSubject }))
    expect(current).toMatchObject({ actor_id: user.subject, account_login: adminSubject, roles: ['operator'] })
    expect(current.capabilities).not.toContain('workspace.member.manage')
    const before = await api.workspaceMembers.list(user.workspaceId)
    const response = await post(proof(user, {
      login: adminSubject, method: 'ops.member.upsert',
      params: { external_subject: `must-not-create-${randomUUID()}`, display_name: 'Must not be created', role: 'operator', reason: 'OIDC display must not authorize this operation' },
    }))
    expect(response.status).toBe(403)
    expect(response.body.error?.code).toBe('FORBIDDEN')
    expect(await api.workspaceMembers.list(user.workspaceId)).toEqual(before)
  })

  it.each(['suspended', 'non-member'] as const)('does not borrow an active administrator membership for a %s with the same display login', async state => {
    const user = identity()
    const adminSubject = `active-admin-${randomUUID()}@example.test`
    await member({ ...user, subject: adminSubject }, 'merchant_admin')
    if (state === 'suspended') await member(user, 'operator', 'suspended')
    const before = await api.workspaceMembers.list(user.workspaceId)
    const response = await post(proof(user, { login: adminSubject }))
    expect(response.status).toBe(403)
    expect(response.body.error?.code).toBe(state === 'suspended' ? 'MEMBER_SUSPENDED' : 'WORKSPACE_MEMBERSHIP_REQUIRED')
    expect(response.body.data).toBeNull()
    expect(await api.workspaceMembers.list(user.workspaceId)).toEqual(before)
  })
})
