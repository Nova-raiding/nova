import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { configuredOAuthRedirectUri, oauthStates, server, service, workspaceMembers } from './server.js'
import { hashPkceVerifier, OAuthStateStore, redactSecrets } from '../../../packages/security/src/oauth.js'

type Envelope<T = unknown> = { workspace_id: string; data: T | null; error: { code: string; details?: Record<string, unknown> } | null }

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function json(response: Response) { return { response, body: await response.json() as Envelope } }

async function configureBearerMembers(entries: Array<{ token: string; workspaceId: string; actorId?: string; role?: 'workspace_owner' | 'merchant_admin' | 'operator' | 'support' | 'finance' | 'platform_ops'; grantWorkspaces?: string[]; gatewayRoles?: string[] }>) {
  const grants: Record<string, { workspaces: string[]; actor_id: string; roles?: string[] }> = {}
  for (const entry of entries) {
    const actorId = entry.actorId ?? `${entry.token}-actor`
    const role = entry.role ?? 'workspace_owner'
    grants[entry.token] = { workspaces: entry.grantWorkspaces ?? [entry.workspaceId], actor_id: actorId, ...(entry.gatewayRoles ? { roles: entry.gatewayRoles } : {}) }
    await workspaceMembers.upsert({ workspaceId: entry.workspaceId, externalSubject: actorId, displayName: actorId, role, status: 'active', invitedBy: 'security-test' })
  }
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify(grants))
}

beforeEach(() => vi.stubEnv('SESSION_ID_HASH_SECRET', 'test-session-hash-secret'))

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

describe('security and access-control acceptance gates', () => {
  it('fails closed in staging instead of trusting caller supplied identity headers', async () => {
    const workspaceId = `ws_staging_auth_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('API_AUTH_TOKENS', '{}')
    const base = await start()
    const call = (headers: Record<string, string>) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.health', params: { workspace_id: workspaceId } }),
    }).then(response => response.json() as Promise<Envelope>)
    expect((await call({ 'x-actor-id': 'forged-admin', 'x-role': 'platform_ops' })).error?.code).toBe('UNAUTHENTICATED')

    await configureBearerMembers([{ token: 'staging-token', workspaceId, actorId: 'staging-owner', role: 'workspace_owner', gatewayRoles: ['workspace_owner'] }])
    expect((await call({ authorization: 'Bearer staging-token' })).error).toBeNull()
  })

  it('denies automation policy changes by support members in staging', async () => {
    const workspaceId = `ws_staging_automation_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'staging')
    await configureBearerMembers([{ token: 'staging-support-token', workspaceId, actorId: 'staging-support', role: 'support', gatewayRoles: ['support'] }])
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `support-${Date.now()}`, credentialRef: 'vault://security/staging-support' })
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer staging-support-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'automation.policy.update', params: { workspace_id: workspaceId, platform: 'taobao', account_id: account.id, enabled: 'true', reason: '越权开启自动化尝试' } }),
    }).then(value => value.json() as Promise<Envelope>)
    expect(response.error?.code).toBe('FORBIDDEN')
  })

  it('fails closed when an authenticated production identity has no active workspace membership', async () => {
    const workspaceId = `ws_member_gate_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'member-gate-token': { workspaces: [workspaceId], actor_id: 'member-gate-user' } }))
    const base = await start()
    const call = () => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer member-gate-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.health', params: { workspace_id: workspaceId } }),
    })

    const denied = await call()
    expect(denied.status).toBe(403)
    expect((await denied.json() as Envelope).error?.code).toBe('WORKSPACE_MEMBERSHIP_REQUIRED')

    await workspaceMembers.upsert({ workspaceId, externalSubject: 'member-gate-user', displayName: '成员门禁测试', role: 'workspace_owner', status: 'active', invitedBy: 'bootstrap' })
    const allowed = await call()
    expect(allowed.status).toBe(200)
  })

  it('rejects a workspace member whose stored role exceeds the signed identity role', async () => {
    const workspaceId = `ws_member_role_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'member-role-token': { workspaces: [workspaceId], actor_id: 'member-role-user', roles: ['operator'] } }))
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'member-role-user', displayName: '角色冲突测试', role: 'workspace_owner', status: 'active', invitedBy: 'bootstrap' })
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer member-role-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.health', params: { workspace_id: workspaceId } }),
    })
    expect(response.status).toBe(403)
    expect((await response.json() as Envelope).error?.code).toBe('MEMBER_ROLE_MISMATCH')
  })

  it('restricts the cross-workspace user directory and suspension to platform operations', async () => {
    const workspaceId = `ws_user_governance_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([
      { token: 'tenant-admin-token', workspaceId, actorId: 'tenant-admin', role: 'merchant_admin', gatewayRoles: ['merchant_admin'] },
      { token: 'platform-ops-token', workspaceId, actorId: 'platform-operator', role: 'platform_ops', gatewayRoles: ['platform_ops'] },
    ])
    await workspaceMembers.upsert({ workspaceId, externalSubject: 'target-user', displayName: '待停用用户', role: 'operator', status: 'active', invitedBy: 'security-test' })
    const base = await start()
    const call = (token: string, method: string, params: Record<string, string> = {}) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    expect((await call('tenant-admin-token', 'ops.users.list')).error?.code).toBe('FORBIDDEN')
    expect((await call('tenant-admin-token', 'ops.user.detail', { external_subject: 'target-user' })).error?.code).toBe('FORBIDDEN')
    expect((await call('tenant-admin-token', 'ops.user.suspend', { external_subject: 'target-user', reason: '越权停用尝试' })).error?.code).toBe('FORBIDDEN')
    expect((await call('tenant-admin-token', 'ops.member.upsert', { external_subject: 'target-user', role: 'platform_ops', reason: '越权授予平台角色' })).error?.code).toBe('PLATFORM_ROLE_GRANT_DENIED')
    expect((await call('tenant-admin-token', 'ops.member.upsert', { external_subject: 'target-user', role: 'workspace_owner', reason: '越权授予所有者角色' })).error?.code).toBe('WORKSPACE_OWNER_GRANT_DENIED')
    expect((await call('tenant-admin-token', 'ops.member.upsert', { external_subject: 'target-user', role: 'support', reason: '调整租户内角色' })).data?.result).toMatchObject({ role: 'support', status: 'active' })
    const directory = await call('platform-ops-token', 'ops.users.list', { query: 'target-user' })
    expect(directory.data?.result).toMatchObject({ total: 1, items: [expect.objectContaining({ externalSubject: 'target-user', status: 'active' })] })
    expect((await call('platform-ops-token', 'ops.user.suspend', { external_subject: 'target-user', reason: '安全测试停用' })).data?.result).toMatchObject({ status: 'suspended' })
    expect((await call('platform-ops-token', 'ops.user.suspend', { external_subject: 'platform-operator', reason: '自我停用尝试' })).error?.code).toBe('SELF_SUSPENSION_DENIED')
    expect((await call('platform-ops-token', 'ops.user.activate', { external_subject: 'target-user', reason: '安全测试恢复' })).data?.result).toMatchObject({ status: 'active' })
    const detail = await call('platform-ops-token', 'ops.user.detail', { external_subject: 'target-user' })
    expect(detail.data?.result).toMatchObject({
      identity: { externalSubject: 'target-user', displayName: '待停用用户', membershipCount: 1, activeMembershipCount: 1 },
      memberships: [expect.objectContaining({ workspaceId, role: 'support', status: 'active' })],
    })
    expect(detail.data?.result.audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'user.suspend', reason: '安全测试停用' }),
      expect.objectContaining({ action: 'user.activate', reason: '安全测试恢复' }),
    ]))
    expect((await call('platform-ops-token', 'ops.user.activate', { external_subject: 'target-user', reason: '重复恢复尝试' })).error?.code).toBe('MEMBER_ALREADY_ACTIVE')
  })

  it('globally suspends an identity, revokes its sessions, and does not revive old sessions on activation', async () => {
    const workspaceId = `ws_identity_lifecycle_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([
      { token: 'identity-target-token', workspaceId, actorId: 'identity-target', role: 'operator', gatewayRoles: ['operator'] },
      { token: 'identity-target-fresh-token', workspaceId, actorId: 'identity-target', role: 'operator', gatewayRoles: ['operator'] },
      { token: 'identity-platform-token', workspaceId, actorId: 'identity-platform-ops', role: 'platform_ops', gatewayRoles: ['platform_ops'] },
    ])
    const base = await start()
    const call = (token: string, method: string, params: Record<string, string> = {}) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params } }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    const targetSession = await call('identity-target-token', 'ops.session')
    const identityId = targetSession.data?.result.identity_id as string
    expect(identityId).toMatch(/^[a-f0-9-]{36}$/)
    const detail = await call('identity-platform-token', 'ops.user.detail', { identity_id: identityId })
    expect(detail.data?.result.sessions[0]).not.toHaveProperty('providerSessionHash')
    const revision = detail.data?.result.identity.revision as number

    const suspended = await call('identity-platform-token', 'ops.user.suspend', { scope: 'identity', identity_id: identityId, expected_revision: String(revision), idempotency_key: 'suspend-identity-1', reason: '全局安全停用测试' })
    expect(suspended.data?.result).toMatchObject({ identity: { accessStatus: 'suspended' }, revokedSessionIds: [expect.any(String)] })
    expect((await call('identity-target-token', 'ops.session')).error?.code).toBe('IDENTITY_SUSPENDED')

    const activated = await call('identity-platform-token', 'ops.user.activate', { scope: 'identity', identity_id: identityId, expected_revision: String(suspended.data?.result.identity.revision), idempotency_key: 'activate-identity-1', reason: '安全复核后恢复身份' })
    expect(activated.data?.result.identity.accessStatus).toBe('active')
    expect((await call('identity-target-token', 'ops.session')).error?.code).toBe('SESSION_REVOKED')

    const freshSession = await call('identity-target-fresh-token', 'ops.session')
    expect(freshSession.error).toBeNull()
    const refreshedDetail = await call('identity-platform-token', 'ops.user.detail', { identity_id: identityId })
    const activeSession = refreshedDetail.data?.result.sessions.find((session: { id: string }) => session.id === freshSession.data?.result.session_id)
    expect(activeSession).toMatchObject({ status: 'active', revision: 1 })
    expect((await call('identity-platform-token', 'ops.user.session.revoke', { identity_id: identityId, session_id: activeSession.id, expected_revision: String(activeSession.revision), idempotency_key: 'revoke-fresh-session-1', reason: '撤销可疑新会话' })).data?.result.session.status).toBe('revoked')
    expect((await call('identity-target-fresh-token', 'ops.session')).error?.code).toBe('SESSION_REVOKED')
  })

  it('restricts the global model markup policy to platform operations', async () => {
    const workspaceId = `ws_model_markup_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([
      { token: 'markup-owner-token', workspaceId, actorId: 'markup-owner', role: 'workspace_owner', gatewayRoles: ['workspace_owner'] },
      { token: 'markup-finance-token', workspaceId, actorId: 'markup-finance', role: 'finance', gatewayRoles: ['finance'] },
      { token: 'markup-platform-token', workspaceId, actorId: 'markup-platform', role: 'platform_ops', gatewayRoles: ['platform_ops'] },
    ])
    const base = await start()
    const call = (token: string, method: string, params: Record<string, string> = {}) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    expect((await call('markup-owner-token', 'ops.commercial.model-markup.get')).error?.code).toBe('FORBIDDEN')
    expect((await call('markup-finance-token', 'ops.commercial.model-markup.update', { multiplier: '3.000', expected_revision: '1', reason: '越权修改' })).error?.code).toBe('FORBIDDEN')
    const current = await call('markup-platform-token', 'ops.commercial.model-markup.get')
    expect(current.error).toBeNull()
    const policy = current.data?.result as { multiplier: number; revision: number }
    const updated = await call('markup-platform-token', 'ops.commercial.model-markup.update', { multiplier: policy.multiplier.toFixed(3), expected_revision: String(policy.revision), reason: '平台运营权限回归验证' })
    expect(updated.error).toBeNull()
    expect(updated.data?.result).toMatchObject({ multiplier: policy.multiplier, revision: policy.revision + 1, updatedBy: 'markup-platform' })
  })

  it('redacts provider model costs from merchant reconciliation roles', async () => {
    const workspaceId = `ws_cost_redaction_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([
      { token: 'merchant-cost-token', workspaceId, actorId: 'merchant-cost-user', role: 'operator', gatewayRoles: ['operator'] },
      { token: 'finance-cost-token', workspaceId, actorId: 'finance-cost-user', role: 'finance', gatewayRoles: ['finance'] },
    ])
    const base = await start()
    const call = (token: string) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'billing.reconciliation', params: { workspace_id: workspaceId } }),
    }).then(response => response.json() as Promise<Envelope<{ result: { model_usage: { provider_cost_cny: string | null } } }>>)

    expect((await call('merchant-cost-token')).data?.result.model_usage.provider_cost_cny).toBeNull()
    expect((await call('finance-cost-token')).data?.result.model_usage.provider_cost_cny).toBe('0.000000')
  })

  it('allows a platform operator to govern users without a tenant membership in the routing workspace', async () => {
    const routingWorkspace = `ws_platform_route_${Date.now()}`
    const targetWorkspace = `ws_platform_target_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'platform-only-token': { workspaces: [routingWorkspace], actor_id: 'platform-only-operator', roles: ['platform_ops'] } }))
    await workspaceMembers.upsert({ workspaceId: targetWorkspace, externalSubject: 'target-only-user', displayName: '目标用户', role: 'operator', status: 'active', invitedBy: 'security-test' })
    const base = await start()
    const call = (method: string, params: Record<string, string>) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer platform-only-token', 'content-type': 'application/json', 'x-workspace-id': routingWorkspace },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { workspace_id: targetWorkspace, ...params } }),
    }).then(value => value.json() as Promise<Envelope<{ result: any }>>)
    const response = await call('ops.users.list', { query: 'target-only-user' })
    expect(response.error).toBeNull()
    expect(response.data?.result.items).toEqual([expect.objectContaining({ externalSubject: 'target-only-user', workspaceId: targetWorkspace })])
    const detail = await call('ops.user.detail', { external_subject: 'target-only-user' })
    expect(detail.error).toBeNull()
    expect(detail.data?.result.identity).toMatchObject({ externalSubject: 'target-only-user', membershipCount: 1 })
    expect((await call('ops.user.suspend', { external_subject: 'target-only-user', reason: '跨租户停用验证' })).data?.result).toMatchObject({ workspaceId: targetWorkspace, status: 'suspended' })
  })

  it('prevents removing the last active workspace owner', async () => {
    const workspaceId = `ws_last_owner_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'owner-token', workspaceId, actorId: 'sole-owner', role: 'workspace_owner', gatewayRoles: ['workspace_owner'] }])
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ops.member.upsert', params: { workspace_id: workspaceId, external_subject: 'sole-owner', role: 'operator', reason: '错误降权尝试' } }),
    }).then(value => value.json() as Promise<Envelope>)
    expect(response.error?.code).toBe('LAST_WORKSPACE_OWNER_REQUIRED')
  })

  it('filters brands by grant and enforces minimum brand roles for writes in staging', async () => {
    const workspaceId = `ws_brand_access_${Date.now()}`
    vi.stubEnv('NODE_ENV', 'staging')
    await configureBearerMembers([
      { token: 'brand-owner-token', workspaceId, actorId: 'brand-owner', role: 'workspace_owner', gatewayRoles: ['workspace_owner'] },
      { token: 'brand-editor-token', workspaceId, actorId: 'brand-editor', role: 'operator', gatewayRoles: ['operator'] },
    ])
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `brand-store-${workspaceId}`, credentialRef: 'vault://brand-access' })
    const source = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: 'brand-access-source', title: '品权限商品', stock: 3 })
    const base = await start()
    const ownerHeaders = { authorization: 'Bearer brand-owner-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const editorHeaders = { authorization: 'Bearer brand-editor-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const mcp = (headers: Record<string, string>, id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }) }).then(response => response.json() as Promise<Envelope<{ result: any }>>)

    expect((await mcp(ownerHeaders, 1, 'brand-unit.create', { brand_id: 'brand_access', name: '权限品' })).error).toBeNull()
    expect((await mcp(ownerHeaders, 2, 'brand-unit.bind-store', { brand_id: 'brand_access', platform: 'taobao', account_id: account.id })).error).toBeNull()
    expect((await mcp(editorHeaders, 3, 'brand-unit.list', {})).data?.result).toMatchObject({ count: 0 })
    expect((await mcp(editorHeaders, 3.1, 'workspace.health', {})).data?.result.capabilityCards.brandNavigation).toMatchObject({ presentation: 'tree', hierarchy: ['brand', 'platform', 'store'], items: [] })
    expect((await mcp(editorHeaders, 4, 'brand-unit.list', { brand_id: 'brand_access' })).error?.code).toBe('BRAND_ACCESS_REQUIRED')

    expect((await mcp(ownerHeaders, 5, 'brand-unit.access.grant', { brand_id: 'brand_access', external_subject: 'brand-editor', role: 'viewer' })).error).toBeNull()
    expect((await mcp(editorHeaders, 6, 'brand-unit.list', {})).data?.result).toMatchObject({ count: 1 })
    expect((await mcp(editorHeaders, 6.1, 'workspace.health', {})).data?.result.capabilityCards.brandNavigation.items).toEqual([expect.objectContaining({ id: 'brand_access', title: '权限品', platforms: [expect.objectContaining({ platform: 'taobao', stores: [expect.objectContaining({ accountId: account.id })] })] })])
    expect((await mcp(editorHeaders, 7, 'brand-unit.product.create', { brand_id: 'brand_access', title: '无编辑权限', source_product_id: source.id })).error?.code).toBe('BRAND_ACCESS_REQUIRED')

    expect((await mcp(ownerHeaders, 8, 'brand-unit.access.grant', { brand_id: 'brand_access', external_subject: 'brand-editor', role: 'editor' })).error).toBeNull()
    expect((await mcp(editorHeaders, 9, 'brand-unit.product.create', { brand_id: 'brand_access', title: '可编辑商品', source_product_id: source.id })).error).toBeNull()
  })

  it('resolves an independent OAuth callback for every platform', () => {
    const template = { PUBLIC_OAUTH_REDIRECT_URI: 'https://merchant.test/v1/oauth/callback/{platform}' }
    expect(configuredOAuthRedirectUri('jd', template)).toBe('https://merchant.test/v1/oauth/callback/jd')
    expect(configuredOAuthRedirectUri('taobao', template)).toBe('https://merchant.test/v1/oauth/callback/taobao')
    expect(configuredOAuthRedirectUri('tmall', { ...template, TMALL_OAUTH_REDIRECT_URI: 'https://tmall.test/v1/oauth/callback/tmall' })).toBe('https://tmall.test/v1/oauth/callback/tmall')
    expect(configuredOAuthRedirectUri('pinduoduo', { PUBLIC_OAUTH_REDIRECT_URI: 'https://merchant.test/v1/oauth/callback' })).toBe('https://merchant.test/v1/oauth/callback/pinduoduo')
  })

  it('binds OAuth state to scope, consumes once, expires, and verifies PKCE hash format', () => {
    let now = 100
    const store = new OAuthStateStore(50, () => now)
    const state = store.issue({ workspaceId: 'ws_secure', actorId: 'actor', platform: 'jd', codeChallenge: hashPkceVerifier('verifier') })
    expect(() => store.consume(state, { workspaceId: 'ws_other', platform: 'jd' })).toThrow(/scope/i)
    expect(store.consume(state, { workspaceId: 'ws_secure', platform: 'jd' }).codeChallenge).toBe(hashPkceVerifier('verifier'))
    expect(() => store.consume(state, { workspaceId: 'ws_secure', platform: 'jd' })).toThrow(/consumed/i)
    const expired = store.issue({ workspaceId: 'ws_secure', actorId: 'actor', platform: 'jd' })
    now = 200
    expect(() => store.consume(expired, { workspaceId: 'ws_secure', platform: 'jd' })).toThrow(/expired/i)
    expect(hashPkceVerifier('verifier')).toBe(hashPkceVerifier('verifier'))
  })

  it('does not expose credential-shaped values through the redaction helper', () => {
    const safe = redactSecrets({ access_token: 'token', refresh_token: 'refresh', nested: { authorization_code: 'code' }, title: 'visible' })
    expect(safe).toEqual({ access_token: '[REDACTED]', refresh_token: '[REDACTED]', nested: { authorization_code: '[REDACTED]' }, title: 'visible' })
    const encoded = JSON.stringify(safe)
    expect(encoded).not.toContain('"access_token":"token"')
    expect(encoded).not.toContain('"refresh_token":"refresh"')
    expect(encoded).not.toContain('"authorization_code":"code"')
  })

  it('rejects oversized JSON bodies before application processing', async () => {
    vi.stubEnv('REQUEST_BODY_LIMIT_BYTES', '32')
    const base = await start()
    const { response, body } = await json(await fetch(`${base}/v1/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_body_limit' },
      body: JSON.stringify({ product_id: 'prod_fixture_1', platform: 'taobao', padding: '012345678901234567890123456789' }),
    }))
    expect(response.status).toBe(413)
    expect(body.error?.code).toBe('REQUEST_BODY_TOO_LARGE')
  })

  it('fails closed for production CORS and accepts only the configured origin', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ALLOWED_ORIGINS', 'https://merchant.example')
    const base = await start()
    const denied = await fetch(`${base}/v1/products`, { headers: { origin: 'https://evil.example', 'x-workspace-id': 'ws_cors' } })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
    const allowed = await fetch(`${base}/v1/products`, { headers: { origin: 'https://merchant.example', 'x-workspace-id': 'ws_cors' } })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://merchant.example')
    const preflight = await fetch(`${base}/v1/tasks`, { method: 'OPTIONS', headers: { origin: 'https://merchant.example', 'access-control-request-method': 'POST' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT')
  })

  it('binds bearer tokens to an allowlisted workspace in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-a', workspaceId: 'ws_bearer_auth' }])
    service.registerPlatformAccount({ workspaceId: 'ws_bearer_auth', platform: 'taobao', remoteAccountId: 'auth-store', credentialRef: 'vault://auth-store' })
    const base = await start()
    const missing = await fetch(`${base}/v1/products`, { headers: { 'x-workspace-id': 'ws_bearer_auth' } })
    expect(missing.status).toBe(401)
    expect((await missing.json() as Envelope).error?.code).toBe('UNAUTHENTICATED')
    const denied = await fetch(`${base}/v1/products`, { headers: { authorization: 'Bearer token-a', 'x-workspace-id': 'ws_other' } })
    expect(denied.status).toBe(403)
    const allowed = await fetch(`${base}/v1/products`, { headers: { authorization: 'Bearer token-a', 'x-workspace-id': 'ws_bearer_auth' } })
    expect(allowed.status).toBe(200)
  })

  it('accepts only a short-lived signed OIDC gateway identity in managed ops mode', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('OPS_AUTH_MODE', 'oidc')
    vi.stubEnv('OIDC_PROXY_SIGNING_SECRET', 'oidc-test-secret')
    await workspaceMembers.upsert({ workspaceId: 'ws_oidc', externalSubject: 'oidc-user', displayName: 'oidc-user', role: 'merchant_admin', status: 'active', invitedBy: 'security-test' })
    service.registerPlatformAccount({ workspaceId: 'ws_oidc', platform: 'taobao', remoteAccountId: 'oidc-store', credentialRef: 'vault://oidc-store' })
    const base = await start()
    const path = '/v1/products'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const authTime = String(Number(timestamp) - 10)
    const sessionExpiresAt = String(Number(timestamp) + 3600)
    const canonical = ['GET', path, 'ws_oidc', 'https://issuer.example.com', 'oidc-user', 'oidc-session-1', 'merchant_admin,operator', 'mfa', authTime, sessionExpiresAt, timestamp].join('\n')
    const signature = createHmac('sha256', 'oidc-test-secret').update(canonical).digest('hex')
    const headers = { 'x-workspace-id': 'ws_oidc', 'x-oidc-issuer': 'https://issuer.example.com', 'x-oidc-sub': 'oidc-user', 'x-oidc-sid': 'oidc-session-1', 'x-oidc-workspace': 'ws_oidc', 'x-oidc-roles': 'operator,merchant_admin', 'x-oidc-amr': 'mfa', 'x-oidc-auth-time': authTime, 'x-oidc-session-expires-at': sessionExpiresAt, 'x-oidc-timestamp': timestamp, 'x-oidc-signature': signature }
    const missing = await fetch(`${base}${path}`, { headers: { 'x-workspace-id': 'ws_oidc' } })
    expect(missing.status).toBe(401)
    const allowed = await fetch(`${base}${path}`, { headers })
    expect(allowed.status).toBe(200)
    const conflicting = await fetch(`${base}${path}`, { headers: { ...headers, 'x-workspace-id': 'ws_other' } })
    expect(conflicting.status).toBe(403)
    const bearer = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer ignored', 'x-workspace-id': 'ws_oidc' } })
    expect(bearer.status).toBe(401)
  })

  it('keeps the merchant host bearer boundary separate from the OIDC ops host', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('OPS_AUTH_MODE', 'oidc')
    vi.stubEnv('OIDC_PROXY_SIGNING_SECRET', 'oidc-test-secret')
    // The ephemeral test server is addressed through 127.0.0.1; production
    // sets this to merchant.example.com in the Kubernetes ConfigMap.
    vi.stubEnv('MERCHANT_BEARER_HOSTNAME', '127.0.0.1')
    await configureBearerMembers([{ token: 'merchant-ui-token', workspaceId: 'ws_merchant_host' }])
    service.registerPlatformAccount({ workspaceId: 'ws_merchant_host', platform: 'taobao', remoteAccountId: 'merchant-host-store', credentialRef: 'vault://merchant-host-store' })
    const base = await start()
    const path = '/v1/products'
    const merchant = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer merchant-ui-token', 'x-workspace-id': 'ws_merchant_host' } })
    expect(merchant.status).toBe(200)
    vi.stubEnv('MERCHANT_BEARER_HOSTNAME', 'ops.merchant.example.com')
    const opsBearer = await fetch(`${base}${path}`, { headers: { host: 'ops.merchant.example.com', authorization: 'Bearer merchant-ui-token', 'x-workspace-id': 'ws_merchant_host' } })
    expect(opsBearer.status).toBe(401)
  })

  it('allows a signed OIDC identity to bootstrap once before a workspace is assigned', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('OPS_AUTH_MODE', 'oidc')
    vi.stubEnv('OIDC_PROXY_SIGNING_SECRET', 'oidc-test-secret')
    const base = await start()
    const path = '/mcp'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const authTime = String(Number(timestamp) - 10)
    const sessionExpiresAt = String(Number(timestamp) + 3600)
    const canonical = ['POST', path, '', 'https://issuer.example.com', 'new-oidc-user', 'bootstrap-session-1', '', '', authTime, sessionExpiresAt, timestamp].join('\n')
    const signature = createHmac('sha256', 'oidc-test-secret').update(canonical).digest('hex')
    const headers = {
      'content-type': 'application/json',
      'x-workspace-bootstrap': 'true',
      'x-oidc-issuer': 'https://issuer.example.com',
      'x-oidc-sub': 'new-oidc-user',
      'x-oidc-sid': 'bootstrap-session-1',
      'x-oidc-auth-time': authTime,
      'x-oidc-session-expires-at': sessionExpiresAt,
      'x-oidc-timestamp': timestamp,
      'x-oidc-signature': signature,
    }
    const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.bootstrap', params: { display_name: 'OIDC 首次工作区' } }) }).then(json)
    expect(response.body.error).toBeNull()
    expect((response.body.data as { result: { workspaceId: string; owner: { actorId: string } } }).result).toMatchObject({ workspaceId: expect.stringMatching(/^ws_[a-f0-9]{24}$/), owner: { actorId: 'new-oidc-user' } })
  })

  it('does not allow bootstrap to assign ownership to a different external subject', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('OPS_AUTH_MODE', 'oidc')
    vi.stubEnv('OIDC_PROXY_SIGNING_SECRET', 'oidc-test-secret')
    const base = await start()
    const path = '/mcp'
    const timestamp = String(Math.floor(Date.now() / 1000))
    const authTime = String(Number(timestamp) - 10)
    const sessionExpiresAt = String(Number(timestamp) + 3600)
    const canonical = ['POST', path, '', 'https://issuer.example.com', 'authenticated-user', 'bootstrap-session-2', '', '', authTime, sessionExpiresAt, timestamp].join('\n')
    const signature = createHmac('sha256', 'oidc-test-secret').update(canonical).digest('hex')
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-bootstrap': 'true', 'x-oidc-issuer': 'https://issuer.example.com', 'x-oidc-sub': 'authenticated-user', 'x-oidc-sid': 'bootstrap-session-2', 'x-oidc-auth-time': authTime, 'x-oidc-session-expires-at': sessionExpiresAt, 'x-oidc-timestamp': timestamp, 'x-oidc-signature': signature }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.bootstrap', params: { display_name: '错误 owner 工作区', external_subject: 'different-user' } }) })
    expect(response.status).toBe(403)
    expect((await response.json() as Envelope).error?.code).toBe('FORBIDDEN')
  })

  it('rejects wildcard workspace grants unless explicitly enabled for a controlled local deployment', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'pilot-token', workspaceId: 'ws_any', grantWorkspaces: ['*'] }])
    vi.stubEnv('ALLOW_WILDCARD_WORKSPACE_GRANT', 'false')
    service.registerPlatformAccount({ workspaceId: 'ws_any', platform: 'taobao', remoteAccountId: 'wildcard-store', credentialRef: 'vault://wildcard-store' })
    const base = await start()
    const denied = await fetch(`${base}/v1/products`, { headers: { authorization: 'Bearer pilot-token', 'x-workspace-id': 'ws_any' } })
    expect(denied.status).toBe(403)
    vi.stubEnv('ALLOW_WILDCARD_WORKSPACE_GRANT', 'true')
    const allowed = await fetch(`${base}/v1/products`, { headers: { authorization: 'Bearer pilot-token', 'x-workspace-id': 'ws_any' } })
    expect(allowed.status).toBe(200)
  })

  it('requires an HTTPS OAuth callback in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-a', workspaceId: 'ws_oauth' }])
    const base = await start()
    const response = await fetch(`${base}/v1/platform-accounts/jd/authorize`, {
      method: 'POST',
      headers: { authorization: 'Bearer token-a', 'x-workspace-id': 'ws_oauth', 'content-type': 'application/json' },
      body: JSON.stringify({ actor_id: 'actor' }),
    })
    expect(response.status).toBe(503)
    expect((await response.json() as Envelope).error?.code).toBe('OAUTH_REDIRECT_URI_REQUIRED')
  })

  it('accepts six platform-specific HTTPS callback routes before enforcing connector readiness', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-a', workspaceId: 'ws_oauth_callbacks' }])
    vi.stubEnv('JD_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/jd')
    vi.stubEnv('TAOBAO_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/taobao')
    vi.stubEnv('TMALL_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/tmall')
    vi.stubEnv('PDD_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/pinduoduo')
    vi.stubEnv('XHS_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/xiaohongshu')
    vi.stubEnv('DOUYIN_OAUTH_REDIRECT_URI', 'https://merchant.test/v1/oauth/callback/douyin')
    const base = await start()
    for (const platform of ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin']) {
      const response = await fetch(`${base}/v1/platform-accounts/${platform}/authorize`, {
        method: 'POST',
        headers: { authorization: 'Bearer token-a', 'x-workspace-id': 'ws_oauth_callbacks', 'content-type': 'application/json' },
        body: JSON.stringify({ actor_id: 'actor' }),
      })
      expect(response.status).toBe(503)
      expect((await response.json() as Envelope).error?.code).toBe('NOT_CONFIGURED')
    }
  })

  it('allows a browser OAuth callback without the merchant Bearer token', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    // The callback boundary is the one-time state/PKCE record, not an API token.
    const callbackState = oauthStates.issue({ workspaceId: 'ws_callback', actorId: 'actor', platform: 'jd', codeVerifier: 'verifier' })
    const base = await start()
    const response = await fetch(`${base}/v1/oauth/callback/jd?state=${encodeURIComponent(callbackState)}&code=fixture`)
    expect(response.status).not.toBe(401)
    expect((await response.json() as Envelope).error?.code).toBe('OAUTH_STATE_STORE_UNAVAILABLE')
  })

  it('requires a registered platform account for production task binding', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-a', workspaceId: 'ws_auth' }])
    const base = await start()
    service.registerPlatformAccount({ workspaceId: 'ws_auth', platform: 'taobao', remoteAccountId: 'remote-acct-1', credentialRef: 'vault://opaque' })
    service.products.set('prod_auth_1', { ...service.products.get('prod_fixture_1')!, id: 'prod_auth_1', workspaceId: 'ws_auth' })
    const headers = { authorization: 'Bearer token-a', 'x-workspace-id': 'ws_auth', 'content-type': 'application/json' }
    const accepted = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: 'prod_auth_1', platform: 'taobao', account_id: 'remote-acct-1' }) })
    expect(accepted.status).toBe(201)
    const accounts = await fetch(`${base}/v1/platform-accounts`, { headers }).then(response => response.json() as Promise<Envelope<{ items: Array<{ platform: string; accountId?: string }> }>>)
    expect(accounts.data?.items.find(item => item.platform === 'taobao')?.accountId).toBe('remote-acct-1')
    const accountStatus = accounts.data?.items.find(item => item.platform === 'taobao') as { readEnabled?: boolean; writeEnabled?: boolean } | undefined
    expect(accountStatus?.readEnabled).toBe(false)
    expect(accountStatus?.writeEnabled).toBe(false)
    const denied = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: 'prod_auth_1', platform: 'taobao', account_id: 'not-authorized' }) })
    expect(denied.status).toBe(404)
    expect((await denied.json() as Envelope).error?.code).toBe('PLATFORM_ACCOUNT_NOT_FOUND')
  })

  it('rejects production publish before queueing when platform write readiness is incomplete', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-publish', workspaceId: 'ws_publish_gate' }])
    const productId = `prod_publish_gate_${Date.now()}`
    service.products.set(productId, { ...service.products.get('prod_fixture_1')!, id: productId, workspaceId: 'ws_publish_gate' })
    service.registerPlatformAccount({ workspaceId: 'ws_publish_gate', platform: 'taobao', remoteAccountId: 'remote-publish-gate', credentialRef: 'vault://opaque' })
    const base = await start()
    const headers = { authorization: 'Bearer token-publish', 'x-workspace-id': 'ws_publish_gate', 'content-type': 'application/json' }
    const created = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: productId, platform: 'taobao', account_id: 'remote-publish-gate' }) }).then(response => response.json() as Promise<Envelope<{ id: string }>>)
    const taskId = created.data!.id
    const generationBeforeRecharge = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'content.generate', params: { task_id: taskId } }) }).then(response => response.json() as Promise<Envelope>)
    expect(generationBeforeRecharge.error?.code).toBe('RECHARGE_REQUIRED')
    const restGenerationBeforeRecharge = await fetch(`${base}/v1/tasks/${taskId}/content`, { method: 'POST', headers }).then(async response => ({ status: response.status, body: await response.json() as Envelope }))
    expect(restGenerationBeforeRecharge.status).toBe(402)
    expect(restGenerationBeforeRecharge.body.error?.code).toBe('RECHARGE_REQUIRED')
    const asyncGenerationBeforeRecharge = await fetch(`${base}/v1/tasks/${taskId}/content-jobs`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'security-generation-before-recharge' }, body: JSON.stringify({}) }).then(async response => ({ status: response.status, body: await response.json() as Envelope }))
    expect(asyncGenerationBeforeRecharge.status).toBe(402)
    expect(asyncGenerationBeforeRecharge.body.error?.code).toBe('RECHARGE_REQUIRED')
    const batchBeforeRecharge = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'publish.batch.confirm', params: { batch_id: 'batch_not_created', confirmations_json: '[]' } }) }).then(response => response.json() as Promise<Envelope>)
    expect(batchBeforeRecharge.error?.code).toBe('RECHARGE_REQUIRED')
    await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers, body: JSON.stringify({ direction_id: 'A' }) })
    // Seed the content version directly after the mandatory production-plan
    // confirmation: model configuration is a separate gate, while this test
    // isolates the publish connector gate.
    service.confirmProductionPlan('ws_publish_gate', taskId, 'security-test')
    const draftVersion = service.createDraft(taskId)
    service.approveContent(taskId, draftVersion.id)
    const preview = service.preparePublish(taskId)
    const response = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { ...headers, 'idempotency-key': 'publish-gate-1' }, body: JSON.stringify({ task_id: taskId, content_version_id: draftVersion.id, confirmation_hash: preview.confirmationHash, remote_snapshot_hash: preview.remoteSnapshotHash, account_id: 'remote-publish-gate' }) })
    const body = await response.json() as Envelope
    expect(response.status).toBe(503)
    expect(body.error?.code).toBe('PLATFORM_WRITE_NOT_READY')
    expect(service.listPublishJobs('ws_publish_gate')).toHaveLength(0)
  })

  it('requires a bound store for production product imports across MCP and REST', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-import', workspaceId: 'ws_import_gate' }])
    const base = await start()
    const headers = { authorization: 'Bearer token-import', 'x-workspace-id': 'ws_import_gate', 'content-type': 'application/json' }
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'catalog.import', params: { platform: 'taobao', title: '未绑定商品' } }) }).then(response => response.json() as Promise<Envelope>)
    expect(mcp.error?.code).toBe('STORE_ONBOARDING_REQUIRED')
    const rest = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', title: '未绑定商品' }) }).then(response => response.json() as Promise<Envelope>)
    expect(rest.error?.code).toBe('STORE_ONBOARDING_REQUIRED')
  })

  it('enforces the production first-run store onboarding sequence', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-onboarding', workspaceId: 'ws_onboarding_gate' }])
    const base = await start()
    const headers = { authorization: 'Bearer token-onboarding', 'x-workspace-id': 'ws_onboarding_gate', 'content-type': 'application/json' }
    const health = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'workspace.health', params: {} }) }).then(response => response.json() as Promise<Envelope>)
    expect(health.error).toBeNull()
    const billing = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'billing.status', params: {} }) }).then(response => response.json() as Promise<Envelope>)
    expect(billing.error).toBeNull()
    const catalog = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'catalog.search', params: {} }) }).then(response => response.json() as Promise<Envelope>)
    expect(catalog.error?.code).toBe('STORE_ONBOARDING_REQUIRED')
  })

  it('requires every production task entry to retain an explicit bound store', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-task-store', workspaceId: 'ws_task_store_gate' }])
    const productId = `prod_unbound_task_${Date.now()}`
    service.products.set(productId, { ...service.products.get('prod_fixture_1')!, id: productId, workspaceId: 'ws_task_store_gate', accountId: undefined })
    service.registerPlatformAccount({ workspaceId: 'ws_task_store_gate', platform: 'taobao', remoteAccountId: 'bound-store', credentialRef: 'vault://bound-store' })
    const base = await start()
    const headers = { authorization: 'Bearer token-task-store', 'x-workspace-id': 'ws_task_store_gate', 'content-type': 'application/json' }
    const mcp = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'task.create', params: { product_id: productId, platform: 'taobao' } }) }).then(response => response.json() as Promise<Envelope>)
    expect(mcp.error?.code).toBe('PLATFORM_ACCOUNT_REQUIRED')
    const rest = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: productId, platform: 'taobao' }) }).then(async response => ({ status: response.status, body: await response.json() as Envelope }))
    expect(rest.status).toBe(400)
    expect(rest.body.error?.code).toBe('PLATFORM_ACCOUNT_REQUIRED')
    const group = await fetch(`${base}/v1/task-groups`, { method: 'POST', headers, body: JSON.stringify({ entries: [{ product_id: productId, platform: 'taobao' }] }) }).then(async response => ({ status: response.status, body: await response.json() as Envelope }))
    expect(group.status).toBe(400)
    expect(group.body.error?.code).toBe('PLATFORM_ACCOUNT_REQUIRED')
    const mcpGroup = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'task.group.create', params: { entries_json: JSON.stringify([{ product_id: productId, platform: 'taobao' }, { product_id: productId, platform: 'taobao' }]) } }) }).then(response => response.json() as Promise<Envelope>)
    expect(mcpGroup.error?.code).toBe('PLATFORM_ACCOUNT_REQUIRED')
  })

  it('does not allow a publish request to switch a task to another store account', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-store-scope', workspaceId: 'ws_store_scope' }])
    const productId = `prod_store_scope_${Date.now()}`
    service.products.set(productId, { ...service.products.get('prod_fixture_1')!, id: productId, workspaceId: 'ws_store_scope' })
    service.registerPlatformAccount({ workspaceId: 'ws_store_scope', platform: 'taobao', remoteAccountId: 'store-a', credentialRef: 'vault://opaque-a' })
    service.registerPlatformAccount({ workspaceId: 'ws_store_scope', platform: 'taobao', remoteAccountId: 'store-b', credentialRef: 'vault://opaque-b' })
    const task = service.createTask({ workspaceId: 'ws_store_scope', productId, platform: 'taobao', accountId: 'store-a' })
    const base = await start()
    const response = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { authorization: 'Bearer token-store-scope', 'x-workspace-id': 'ws_store_scope', 'content-type': 'application/json', 'idempotency-key': 'store-scope-conflict' }, body: JSON.stringify({ task_id: task.id, content_version_id: 'version-not-reached', confirmation_hash: 'hash-a', remote_snapshot_hash: 'snapshot-a', account_id: 'store-b' }) })
    const body = await response.json() as Envelope
    expect(response.status).toBe(409)
    expect(body.error?.code).toBe('STORE_ACCOUNT_CONFLICT')
    expect(service.listPublishJobs('ws_store_scope')).toHaveLength(0)
  })

  it('revokes a production account locally before remote cleanup and blocks reuse', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'token-revoke', workspaceId: 'ws_revoke' }])
    const productId = `prod_revoke_${Date.now()}`
    service.products.set(productId, { ...service.products.get('prod_fixture_1')!, id: productId, workspaceId: 'ws_revoke', accountId: 'remote-revoke' })
    service.registerPlatformAccount({ workspaceId: 'ws_revoke', platform: 'taobao', remoteAccountId: 'remote-revoke', credentialRef: 'vault://opaque' })
    const base = await start()
    const headers = { authorization: 'Bearer token-revoke', 'x-workspace-id': 'ws_revoke' }
    const response = await fetch(`${base}/v1/platform-accounts/taobao`, { method: 'DELETE', headers: { ...headers, 'x-account-id': 'remote-revoke' } })
    expect(response.status).toBe(503)
    expect((await response.json() as Envelope).error?.code).toBe('PLATFORM_REVOKE_REMOTE_FAILED')
    const accounts = await fetch(`${base}/v1/platform-accounts`, { headers }).then(result => result.json() as Promise<Envelope<{ items: Array<{ platform: string; state: string; readEnabled: boolean }> }>>)
    const taobao = accounts.data?.items.find(item => item.platform === 'taobao')
    expect(taobao).toMatchObject({ state: 'revoked', readEnabled: false })
    const denied = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ product_id: productId, platform: 'taobao', account_id: 'remote-revoke' }) })
    expect(denied.status).toBe(428)
    expect((await denied.json() as Envelope).error?.code).toBe('STORE_ONBOARDING_REQUIRED')
    const deniedWithoutExplicitStore = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ product_id: productId, platform: 'taobao' }) })
    expect(deniedWithoutExplicitStore.status).toBe(428)
    expect((await deniedWithoutExplicitStore.json() as Envelope).error?.code).toBe('STORE_ONBOARDING_REQUIRED')
    const deniedTaskGroupWithoutExplicitStore = await fetch(`${base}/v1/task-groups`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ entries: [{ product_id: productId, platform: 'taobao' }, { product_id: 'missing-second-product', platform: 'jd' }] }) })
    expect(deniedTaskGroupWithoutExplicitStore.status).toBe(428)
    expect((await deniedTaskGroupWithoutExplicitStore.json() as Envelope).error?.code).toBe('STORE_ONBOARDING_REQUIRED')
    const deniedCatalogAfterLastRevoke = await fetch(`${base}/v1/products`, { headers })
    expect(deniedCatalogAfterLastRevoke.status).toBe(428)
    expect((await deniedCatalogAfterLastRevoke.json() as Envelope).error?.code).toBe('STORE_ONBOARDING_REQUIRED')
  })

  it('protects worker-only generation result callbacks with a separate internal token', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    await configureBearerMembers([{ token: 'api-token', workspaceId: 'ws_worker' }, { token: 'worker-token', workspaceId: 'ws_worker' }])
    vi.stubEnv('WORKER_API_TOKEN', 'worker-token')
    vi.stubEnv('WORKER_API_SIGNING_SECRET', 'worker-signing-secret')
    const productId = `prod_worker_${Date.now()}`
    service.products.set(productId, { ...service.products.get('prod_fixture_1')!, id: productId, workspaceId: 'ws_worker' })
    const task = service.createTask({ workspaceId: 'ws_worker', productId, platform: 'taobao' })
    service.selectDirection(task.id, 'A')
    service.confirmProductionPlan('ws_worker', task.id, 'test-worker')
    const job = service.enqueueGeneration({ workspaceId: 'ws_worker', taskId: task.id, idempotencyKey: `worker-${Date.now()}` })
    const base = await start()
    const body = JSON.stringify({ content: { title: 'worker', detail: 'worker', sellingPoints: ['fact'] } })
    const denied = await fetch(`${base}/v1/generation-jobs/${job.id}/result`, { method: 'POST', headers: { authorization: 'Bearer api-token', 'x-workspace-id': 'ws_worker', 'content-type': 'application/json' }, body })
    expect(denied.status).toBe(403)
    const signWorkerRequest = (path: string) => createHmac('sha256', 'worker-signing-secret').update(`POST\n${path}\nws_worker`).digest('hex')
    const deferredPath = `/v1/generation-jobs/${job.id}/defer`
    const deferred = await fetch(`${base}${deferredPath}`, { method: 'POST', headers: { authorization: 'Bearer worker-token', 'x-workspace-id': 'ws_worker', 'x-worker-workspace-signature': signWorkerRequest(deferredPath), 'content-type': 'application/json' }, body: JSON.stringify({ code: 'QUOTA_EXHAUSTED', message: '额度窗口等待中', retry_after_seconds: 12 }) })
    expect(deferred.status).toBe(200)
    expect((await deferred.json() as Envelope<{ state: string; waitingReason: string; nextAttemptAt: string }>).data).toMatchObject({ state: 'queued', waitingReason: 'provider_quota' })
    const resultPath = `/v1/generation-jobs/${job.id}/result`
    const accepted = await fetch(`${base}${resultPath}`, { method: 'POST', headers: { authorization: 'Bearer worker-token', 'x-workspace-id': 'ws_worker', 'x-worker-workspace-signature': signWorkerRequest(resultPath), 'content-type': 'application/json' }, body })
    expect(accepted.status).toBe(200)
  })

  it('exposes opaque credential locators only through the worker execution gate', async () => {
    vi.stubEnv('WORKER_API_TOKEN', 'worker-context-token')
    const workspaceId = `ws_worker_context_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'jd', remoteAccountId: `remote-${Date.now()}`, credentialRef: 'vault://kv/workspaces/scoped/account' })
    const job = service.createSyncJob({ workspaceId, platform: 'jd', accountId: account.id })
    const base = await start()
    const path = `/v1/sync-jobs/${job.id}/execution-context`
    const denied = await fetch(`${base}${path}`, { headers: { 'x-workspace-id': workspaceId } })
    expect(denied.status).toBe(403)
    const allowed = await fetch(`${base}${path}`, { headers: { authorization: 'Bearer worker-context-token', 'x-workspace-id': workspaceId } })
    expect(allowed.status).toBe(200)
    expect((await allowed.json() as Envelope<{ credential_ref: string }>).data).toEqual(expect.objectContaining({ credential_ref: account.credentialRef }))
  })

  it('accepts only the signed worker automation scheduler endpoint in staging', async () => {
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'worker-token': ['ws_worker_automation'] }))
    vi.stubEnv('WORKER_API_TOKEN', 'worker-token')
    vi.stubEnv('WORKER_API_SIGNING_SECRET', 'automation-secret')
    const base = await start(); const workspaceId = 'ws_worker_automation'; const path = '/v1/internal/automation/tick'
    const unsigned = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer worker-token', 'x-workspace-id': workspaceId } })
    expect(unsigned.status).toBe(403)
    const signature = createHmac('sha256', 'automation-secret').update(`POST\n${path}\n${workspaceId}`).digest('hex')
    const signed = await fetch(`${base}${path}`, { method: 'POST', headers: { authorization: 'Bearer worker-token', 'x-workspace-id': workspaceId, 'x-worker-workspace-signature': signature } })
    expect(signed.status).toBe(200)
    expect((await signed.json() as Envelope<{ executed: unknown[]; unattendedAutoResubmit: boolean }>).data).toMatchObject({ executed: [], unattendedAutoResubmit: false })
  })

  it('fails closed when production worker workspace signing is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('WORKER_API_TOKEN', 'worker-token')
    vi.stubEnv('WORKER_API_SIGNING_SECRET', '')
    const base = await start()
    const response = await fetch(`${base}/v1/internal/automation/tick`, { method: 'POST', headers: { authorization: 'Bearer worker-token', 'x-workspace-id': 'ws_worker_missing_signing' } })
    expect(response.status).toBe(503)
    expect((await response.json() as Envelope).error?.code).toBe('WORKER_AUTH_MISCONFIGURED')
  })

  it('enforces a per-workspace request rate limit', async () => {
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '2')
    const base = await start()
    const headers = { 'x-workspace-id': `ws_rate_${Date.now()}` }
    await fetch(`${base}/v1/products`, { headers })
    await fetch(`${base}/v1/products`, { headers })
    const limited = await fetch(`${base}/v1/products`, { headers })
    const body = await limited.json() as Envelope
    expect(limited.status).toBe(429)
    expect(body.error?.code).toBe('RATE_LIMITED')
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(body.error?.details).toEqual(expect.objectContaining({ retry_after_seconds: expect.any(Number) }))
  })

  it('prevents cross-tenant job reads and idempotency-key reuse for another intent', async () => {
    const base = await start()
    const owner = `ws_owner_${Date.now()}`
    const attacker = `${owner}_attacker`
    const productId = `prod_security_${Date.now()}`
    service.products.set(productId, { id: productId, workspaceId: owner, platform: 'taobao', storeName: 'owner', remoteId: 'remote', title: 'product', skuCount: 1, stock: 1, factsConfirmed: true, source: 'fixture', updatedAt: new Date().toISOString() })
    const account = service.registerPlatformAccount({ workspaceId: owner, platform: 'taobao', remoteAccountId: `security-owner-${Date.now()}`, credentialRef: 'fixture://security-owner' })
    const create = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': owner }, body: JSON.stringify({ product_id: productId, platform: 'taobao', account_id: account.id }) }).then(response => response.json() as Promise<Envelope>)
    const taskId = (create.data as { id: string }).id
    await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': owner }, body: JSON.stringify({ direction_id: 'A' }) })
    await fetch(`${base}/v1/tasks/${taskId}/plan/confirm`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': owner }, body: JSON.stringify({ expected_version: 2 }) })
    const draft = await fetch(`${base}/v1/tasks/${taskId}/content`, { method: 'POST', headers: { 'x-workspace-id': owner } }).then(response => response.json() as Promise<Envelope>)
    const contentVersionId = (draft.data as { id: string }).id
    await fetch(`${base}/v1/tasks/${taskId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': owner }, body: JSON.stringify({ content_version_id: contentVersionId }) })
    const preview = await fetch(`${base}/v1/tasks/${taskId}/publish-preview`, { method: 'POST', headers: { 'x-workspace-id': owner } }).then(response => response.json() as Promise<Envelope>)
    const data = preview.data as { confirmationHash: string; remoteSnapshotHash: string }
    const key = `security-idem-${Date.now()}`
    const publish = { task_id: taskId, content_version_id: contentVersionId, confirmation_hash: data.confirmationHash, remote_snapshot_hash: data.remoteSnapshotHash }
    const first = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': owner, 'idempotency-key': key }, body: JSON.stringify(publish) })
    expect(first.status).toBe(202)
    const firstBody = await first.json() as Envelope
    const jobId = (firstBody.data as { id: string }).id
    const crossTenantRead = await fetch(`${base}/v1/publish-jobs/${jobId}`, { headers: { 'x-workspace-id': attacker } })
    expect([403, 404]).toContain(crossTenantRead.status)
    const crossTenantCreate = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': attacker, 'idempotency-key': `${key}-attacker` }, body: JSON.stringify(publish) })
    expect(crossTenantCreate.status).toBe(403)
    expect((await crossTenantCreate.json() as Envelope).error?.code).toBe('TENANT_SCOPE_DENIED')
    const conflicting = await fetch(`${base}/v1/publish-jobs`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': owner, 'idempotency-key': key }, body: JSON.stringify({ ...publish, remote_snapshot_hash: 'different' }) }).then(response => response.json() as Promise<Envelope>)
    expect(conflicting.error?.code).toBe('IDEMPOTENCY_CONFLICT')
  })
})
