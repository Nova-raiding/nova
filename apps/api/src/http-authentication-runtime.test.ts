import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { authenticateRequest } from './http-authentication-runtime.js'
import type { AuthenticationRuntime } from './server.js'

function fixture(input: { origin?: string; authorization?: string; workspace?: string; status?: string; validSession?: boolean } = {}) {
  const req = { url: '/mcp', method: 'POST', headers: { cookie: 'damai_session=owned-fixture', origin: input.origin ?? 'https://merchant.fixture.invalid', ...(input.authorization !== undefined ? { authorization: input.authorization } : {}), ...(input.workspace ? { 'x-workspace-id': input.workspace } : {}) } } as unknown as IncomingMessage
  const principals = new WeakMap()
  const hydrate = vi.fn(async () => {})
  const authenticateBearer = vi.fn(async () => undefined)
  const dependencies = {
    mcpIntegrationMode: () => 'local_stdio', isProduction: () => true,
    header: (request: IncomingMessage, key: string) => request.headers[key],
    passwordAuthRepository: { authenticate: async () => input.validSession === false ? undefined : ({ account: { accountType: 'merchant', status: input.status ?? 'active', identityId: 'owned-identity', login: 'owned@fixture.invalid', roles: ['merchant'], workspaceIds: ['ws_invited'] }, sessionId: 'owned-session' }), authenticateMcpAccessToken: authenticateBearer },
    environment: { VITEST: 'true' }, localPluginTokenContext: () => ({ issuer: 'https://merchant.fixture.invalid' }), requestPrincipals: principals, hydrateDurableAuthorizationContext: hydrate,
  } as unknown as AuthenticationRuntime
  return { req, dependencies, principals, hydrate, authenticateBearer }
}

describe('local stdio invitation cookie boundary', () => {
  it.each(['workspace.invitations.list', 'workspace.invitation.accept'])('allows only the same-origin assigned-workspace %s browser recovery', async method => {
    const f = fixture({ workspace: 'ws_invited' })
    await authenticateRequest(f.req, f.dependencies, { method, workspaceId: 'ws_invited' })
    expect(f.principals.get(f.req)).toMatchObject({ identityId: 'owned-identity', accountLogin: 'owned@fixture.invalid', workbench: 'workspace' })
    expect(f.hydrate).toHaveBeenCalledOnce()
    expect(f.authenticateBearer).not.toHaveBeenCalled()
  })
  it.each([
    ['different origin', { origin: 'https://attacker.invalid' }, { method: 'workspace.invitation.accept', workspaceId: 'ws_invited' }],
    ['missing origin', { origin: '' }, { method: 'workspace.invitations.list', workspaceId: 'ws_invited' }],
    ['foreign header workspace', { workspace: 'ws_foreign' }, { method: 'workspace.invitation.accept', workspaceId: 'ws_foreign' }],
    ['foreign body workspace', { workspace: 'ws_invited' }, { method: 'workspace.invitation.accept', workspaceId: 'ws_foreign' }],
    ['inactive account', { status: 'merchant_pending' }, { method: 'workspace.invitation.accept', workspaceId: 'ws_invited' }],
    ['other method', {}, { method: 'ops.member.upsert', workspaceId: 'ws_invited' }],
    ['method prefix', {}, { method: 'workspace.invitation.accept.extra', workspaceId: 'ws_invited' }],
    ['invalid session', { validSession: false }, { method: 'workspace.invitation.accept', workspaceId: 'ws_invited' }],
    ['forged bearer', { authorization: 'Bearer forged-token' }, { method: 'workspace.invitation.accept', workspaceId: 'ws_invited' }],
    ['malformed bearer', { authorization: 'invalid' }, { method: 'workspace.invitation.accept', workspaceId: 'ws_invited' }],
  ] as const)('rejects %s without cookie fallback', async (name, options, invocation) => {
    const f = fixture(options)
    const code = name === 'different origin' || name === 'missing origin' ? 'AUTH_CSRF_ORIGIN_INVALID'
      : name.startsWith('foreign') ? 'FORBIDDEN'
        : name === 'inactive account' || name === 'invalid session' ? 'AUTH_SESSION_INVALID' : 'UNAUTHENTICATED'
    await expect(authenticateRequest(f.req, f.dependencies, invocation)).rejects.toMatchObject({ code, status: code === 'FORBIDDEN' || code === 'AUTH_CSRF_ORIGIN_INVALID' ? 403 : 401 })
    expect(f.principals.has(f.req)).toBe(false)
    expect(f.hydrate).not.toHaveBeenCalled()
  })
})
