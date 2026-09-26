import { createHash } from 'node:crypto'
import argon2 from 'argon2'
import { describe, expect, it } from 'vitest'
import { MemoryPasswordAuthRepository } from './password-auth-repository.js'

describe('password authentication', () => {
  it('bootstraps the first platform administrator once and repairs an existing matching account', async () => {
    const hash = await argon2.hash('BootstrapPass123', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
    const auth = new MemoryPasswordAuthRepository()
    await auth.ensurePlatformAccount({ login: 'first@example.com', passwordHash: hash })
    const repaired = await auth.bootstrapFirstPlatformAdmin({ login: 'first@example.com', passwordHash: hash })
    expect(repaired.status).toBe('repaired')
    expect(await auth.bootstrapFirstPlatformAdmin({ login: 'first@example.com', passwordHash: hash })).toEqual({ identityId: repaired.identityId, status: 'existing' })
    await expect(auth.bootstrapFirstPlatformAdmin({ login: 'other@example.com', passwordHash: hash })).rejects.toThrow('PLATFORM_ADMIN_BOOTSTRAP_CONFLICT')
    const otherHash = await argon2.hash('AnotherBootstrap123', { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 })
    await expect(auth.bootstrapFirstPlatformAdmin({ login: 'first@example.com', passwordHash: otherHash })).rejects.toThrow('PLATFORM_ADMIN_BOOTSTRAP_CONFLICT')
    await expect(new MemoryPasswordAuthRepository().bootstrapFirstPlatformAdmin({ login: 'broken@example.com', passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$invalid$invalid' })).rejects.toThrow('PLATFORM_ACCOUNT_PASSWORD_HASH_INVALID')
  })

  it('requires an explicit operator bootstrap intent and binds only the same merchant identity once', async () => {
    const auth = new MemoryPasswordAuthRepository()
    const input = { login: 'first-workspace@example.com', password: 'FirstWorkspace1234!', enterpriseName: '测试企业', contactName: '管理员', workspaceIds: [], actorId: 'platform-operator', reason: '受保护的首次工作区引导' }
    await expect(auth.createMerchantAccount(input)).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_PROVISIONING_INVALID' })
    const account = await auth.createMerchantAccount({ ...input, bootstrapWorkspace: true })
    expect(account.workspaceIds).toEqual([])
    await expect(auth.bindBootstrappedWorkspace({ login: input.login, identityId: 'wrong-identity', workspaceId: 'ws_first' })).rejects.toMatchObject({ code: 'AUTH_BOOTSTRAP_ACCOUNT_CHANGED' })
    const bound = await auth.bindBootstrappedWorkspace({ login: input.login, identityId: account.identityId, workspaceId: 'ws_first' })
    expect(bound.workspaceIds).toEqual(['ws_first'])
    expect((await auth.bindBootstrappedWorkspace({ login: input.login, identityId: account.identityId, workspaceId: 'ws_first' })).revision).toBe(bound.revision)
    await expect(auth.bindBootstrappedWorkspace({ login: input.login, identityId: account.identityId, workspaceId: 'ws_other' })).rejects.toMatchObject({ code: 'AUTH_BOOTSTRAP_ACCOUNT_CHANGED' })
  })
  it('requires eight characters with letters and numbers', async () => {
    const auth = new MemoryPasswordAuthRepository()
    await expect(auth.register({ login: 'short@example.com', password: 'test123', enterpriseName: '企业', contactName: '管理员', termsAgreed: true })).rejects.toMatchObject({ code: 'AUTH_PASSWORD_POLICY_INVALID' })
    await expect(auth.register({ login: 'valid@example.com', password: 'test1234', enterpriseName: '企业', contactName: '管理员', termsAgreed: true })).resolves.toMatchObject({ account: { login: 'valid@example.com' } })
  })

  it('pages only merchant registration applications with a stable total', async () => {
    const auth = new MemoryPasswordAuthRepository()
    await auth.ensurePlatformAccount({ login: 'ops@example.com', passwordHash: 'unused' })
    await auth.register({ login: 'first@example.com', password: 'CorrectHorse123', enterpriseName: '甲企业', contactName: '甲', termsAgreed: true })
    await auth.register({ login: 'second@example.com', password: 'CorrectHorse123', enterpriseName: '乙企业', contactName: '乙', termsAgreed: true })

    const page = await auth.listMerchantRegistrationApplications({ limit: 1, offset: 1 })

    expect(page).toMatchObject({ total: 2, limit: 1, offset: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.accountType).toBe('merchant')
    expect(page.items[0]).not.toHaveProperty('passwordHash')
  })

  it('registers with an Argon2id hash, logs in with an opaque session, and rotates refresh', async () => {
    const auth = new MemoryPasswordAuthRepository()
    const registered = await auth.register({ login: 'merchant@example.com', password: 'CorrectHorse123', enterpriseName: '示例企业', contactName: '张三', termsAgreed: true })
    expect(registered.account.status).toBe('merchant_pending')
    expect(registered.account.identityId).toBe(registered.account.id)
    expect(JSON.stringify(registered)).not.toContain('passwordHash')
    await expect(auth.login({ login: 'merchant@example.com', password: 'bad' })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' })
    await expect(auth.login({ login: 'merchant@example.com', password: 'CorrectHorse123' })).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_NOT_ACTIVE' })
    await auth.activateMerchantAccount({ login: 'merchant@example.com', workspaceIds: ['ws_demo'] })
    const logged = await auth.login({ login: 'merchant@example.com', password: 'CorrectHorse123', ip: '127.0.0.1' })
    expect(logged.token).toEqual(expect.any(String))
    expect(logged.principal.account).not.toHaveProperty('passwordHash')
    const refreshed = await auth.refresh(logged.token)
    expect(refreshed.token).not.toBe(logged.token)
    expect(await auth.authenticate(logged.token)).toBeUndefined()
    expect((await auth.authenticate(refreshed.token))?.sessionId).toBe(refreshed.principal.sessionId)
  })

  it('allows only one winner when the same session is refreshed concurrently', async () => {
    const auth = new MemoryPasswordAuthRepository()
    await auth.register({ login: 'refresh-race@example.com', password: 'CorrectHorse123', enterpriseName: '企业', contactName: '管理员', termsAgreed: true })
    await auth.activateMerchantAccount({ login: 'refresh-race@example.com', workspaceIds: ['ws_demo'] })
    const logged = await auth.login({ login: 'refresh-race@example.com', password: 'CorrectHorse123' })
    const outcomes = await Promise.allSettled([auth.refresh(logged.token), auth.refresh(logged.token)])
    const winners = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof auth.refresh>>> => outcome.status === 'fulfilled')
    const losers = outcomes.filter(outcome => outcome.status === 'rejected')
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toMatchObject({ reason: { code: 'AUTH_SESSION_INVALID' } })
    expect(await auth.authenticate(winners[0]!.value.token)).toBeDefined()
  })

  it('locks after five failures and uses one-time reset to revoke sessions', async () => {
    const auth = new MemoryPasswordAuthRepository()
    await auth.register({ login: 'lock@example.com', password: 'CorrectHorse123', enterpriseName: '企业', contactName: '李四', termsAgreed: true })
    await auth.activateMerchantAccount({ login: 'lock@example.com', workspaceIds: ['ws_demo'] })
    for (let i = 0; i < 5; i += 1) await expect(auth.login({ login: 'lock@example.com', password: 'wrong-password' })).rejects.toBeDefined()
    await expect(auth.login({ login: 'lock@example.com', password: 'CorrectHorse123' })).rejects.toMatchObject({ code: 'AUTH_ACCOUNT_LOCKED' })
    const reset = await auth.requestPasswordReset('lock@example.com')
    expect(reset.token).toEqual(expect.any(String))
    await auth.confirmPasswordReset(reset.token!, 'NewCorrectHorse123')
    await expect(auth.confirmPasswordReset(reset.token!, 'AnotherCorrect123')).rejects.toMatchObject({ code: 'AUTH_RESET_TOKEN_INVALID' })
    const logged = await auth.login({ login: 'lock@example.com', password: 'NewCorrectHorse123' })
    expect(logged.principal.account.status).toBe('active')
    expect(auth.events.map(event => event.eventType)).toEqual(expect.arrayContaining(['auth.registered', 'auth.login_failed', 'auth.locked', 'auth.password_reset_requested', 'auth.password_reset_confirmed']))
  })

  it('does not expose account existence in reset requests and rejects platform registration through the merchant flow', async () => {
    const auth = new MemoryPasswordAuthRepository()
    expect(await auth.requestPasswordReset('unknown@example.com')).toEqual({ accepted: true })
    await auth.ensurePlatformAccount({ login: 'ops@example.com', passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$invalid$invalid' })
    await expect(auth.listAccounts()).resolves.toEqual([
      expect.objectContaining({ login: 'ops@example.com', accountType: 'platform', identityId: expect.any(String) }),
    ])
    await expect(auth.register({ login: 'ops@example.com', password: 'CorrectHorse123', enterpriseName: '企业', contactName: '管理员', termsAgreed: true })).rejects.toMatchObject({ code: 'AUTH_LOGIN_ALREADY_EXISTS' })
  })

  it('keeps platform bootstrap idempotent after a partial initialization retry', async () => {
    const auth = new MemoryPasswordAuthRepository()
    const hash = '$argon2id$v=19$m=19456,t=2,p=1$invalid$invalid'
    await auth.ensurePlatformAccount({ login: 'retry-ops@example.com', passwordHash: hash })
    await auth.ensurePlatformAccount({ login: 'retry-ops@example.com', passwordHash: hash })
    await expect(auth.listAccounts()).resolves.toEqual([
      expect.objectContaining({ login: 'retry-ops@example.com', accountType: 'platform' }),
    ])
  })

  it('lets platform provision an active merchant account and lets the merchant rotate its password', async () => {
    const auth = new MemoryPasswordAuthRepository()
    const account = await auth.createMerchantAccount({
      login: 'provisioned@example.com',
      password: 'InitialPass123',
      enterpriseName: '已开通企业',
      contactName: '企业管理员',
      workspaceIds: ['ws_enterprise'],
      actorId: 'platform_ops',
      reason: '开通企业 VIP 账号',
    })
    expect(account).toMatchObject({ accountType: 'merchant', status: 'active', workspaceIds: ['ws_enterprise'] })
    const logged = await auth.login({ login: account.login, password: 'InitialPass123' })
    await auth.changePassword({ token: logged.token, currentPassword: 'InitialPass123', newPassword: 'RotatedPass123' })
    await expect(auth.authenticate(logged.token)).resolves.toBeUndefined()
    await expect(auth.login({ login: account.login, password: 'InitialPass123' })).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' })
    await expect(auth.login({ login: account.login, password: 'RotatedPass123' })).resolves.toBeDefined()
    expect(auth.events.map(event => event.eventType)).toEqual(expect.arrayContaining(['auth.merchant_created', 'auth.password_changed']))
  })

  it('returns a stable password-policy code when changing a password', async () => {
    const auth = new MemoryPasswordAuthRepository()
    const account = await auth.createMerchantAccount({
      login: 'policy@example.com',
      password: 'InitialPass123',
      enterpriseName: '企业',
      contactName: '管理员',
      workspaceIds: ['ws_policy'],
      actorId: 'platform_ops',
      reason: '测试密码策略',
    })
    const logged = await auth.login({ login: account.login, password: 'InitialPass123' })
    await expect(auth.changePassword({ token: logged.token, currentPassword: 'InitialPass123', newPassword: 'short' }))
      .rejects.toMatchObject({ code: 'AUTH_PASSWORD_POLICY_INVALID' })
  })

  it('revokes one access token or the complete refresh-token family and treats the type hint as advisory', async () => {
    const auth = new MemoryPasswordAuthRepository()
    const account = await auth.createMerchantAccount({
      login: 'oauth-revoke@example.com',
      password: 'InitialPass123',
      enterpriseName: '企业',
      contactName: '管理员',
      workspaceIds: ['ws_oauth_revoke'],
      actorId: 'platform_ops',
      reason: 'OAuth revoke test',
    })
    const context = { clientId: 'chatgpt', issuer: 'https://merchant.example', audience: 'https://merchant.example/mcp', resource: 'https://merchant.example/mcp', scope: ['merchant'] }
    const verifier = 'oauth-pkce-verifier-for-revoke-test-000000000000000000000000'
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const code = await auth.issueMcpAuthorizationCode({ ...context, account, redirectUri: 'https://chatgpt.com/oauth/callback', codeChallenge: challenge })
    const pair = await auth.exchangeMcpAuthorizationCode({ ...context, redirectUri: 'https://chatgpt.com/oauth/callback', code: code.code, codeVerifier: verifier })

    await auth.revokeMcpOAuthToken({ ...context, token: pair.accessToken, tokenTypeHint: 'refresh_token' })
    await expect(auth.authenticateMcpAccessToken({ ...context, accessToken: pair.accessToken })).resolves.toBeUndefined()
    await expect(auth.refreshMcpOAuthToken({ ...context, refreshToken: pair.refreshToken })).resolves.toBeDefined()

    const familyCode = await auth.issueMcpAuthorizationCode({ ...context, account, redirectUri: 'https://chatgpt.com/oauth/callback', codeChallenge: challenge })
    const family = await auth.exchangeMcpAuthorizationCode({ ...context, redirectUri: 'https://chatgpt.com/oauth/callback', code: familyCode.code, codeVerifier: verifier })
    await auth.revokeMcpOAuthToken({ ...context, token: family.refreshToken, tokenTypeHint: 'refresh_token' })
    await expect(auth.authenticateMcpAccessToken({ ...context, accessToken: family.accessToken })).resolves.toBeUndefined()
    await expect(auth.refreshMcpOAuthToken({ ...context, refreshToken: family.refreshToken })).rejects.toMatchObject({ code: 'MCP_OAUTH_INVALID_GRANT' })
    await expect(auth.revokeMcpOAuthToken({ ...context, token: 'unknown-token', tokenTypeHint: 'access_token' })).resolves.toBeUndefined()
  })

  it('binds multi-workspace PKCE grants and tokens to the selected workspace and invalidates removed bindings', async () => {
    const auth = new MemoryPasswordAuthRepository()
    const account = await auth.createMerchantAccount({ login: 'multi-pkce@example.com', password: 'InitialPass123', enterpriseName: '企业', contactName: '管理员', workspaceIds: ['ws_first', 'ws_second'], actorId: 'platform_ops', reason: 'multi workspace auth' })
    const context = { clientId: 'local-desktop', issuer: 'https://merchant.example', audience: 'https://merchant.example/mcp', resource: 'https://merchant.example/mcp', scope: ['merchant'] }
    const redirectUri = 'http://127.0.0.1:12345/merchant-mcp-callback'
    const verifier = 'multi-workspace-pkce-verifier-000000000000000000000000000'
    const codeChallenge = createHash('sha256').update(verifier).digest('base64url')
    const issue = (workspaceId?: string) => auth.issueMcpAuthorizationCode({ ...context, account, redirectUri, codeChallenge, ...(workspaceId ? { workspaceId } : {}) })
    await expect(issue()).rejects.toMatchObject({ code: 'MCP_OAUTH_WORKSPACE_AMBIGUOUS' })
    await expect(issue('ws_foreign')).rejects.toMatchObject({ code: 'MCP_OAUTH_WORKSPACE_AMBIGUOUS' })
    const first = await issue('ws_first')
    const second = await issue('ws_second')
    const unexchangedSecond = await issue('ws_second')
    expect(first.workspaceId).toBe('ws_first')
    expect(second.workspaceId).toBe('ws_second')
    const pair = await auth.exchangeMcpAuthorizationCode({ ...context, redirectUri, code: second.code, codeVerifier: verifier })
    await expect(auth.authenticateMcpAccessToken({ ...context, accessToken: pair.accessToken })).resolves.toMatchObject({ workspaceId: 'ws_second' })
    await auth.activateMerchantAccount({ login: account.login, workspaceIds: ['ws_first'], actorId: 'platform_ops', reason: 'remove second workspace' })
    await expect(auth.exchangeMcpAuthorizationCode({ ...context, redirectUri, code: first.code, codeVerifier: verifier })).resolves.toBeDefined()
    await expect(auth.exchangeMcpAuthorizationCode({ ...context, redirectUri, code: unexchangedSecond.code, codeVerifier: verifier })).rejects.toMatchObject({ code: 'MCP_OAUTH_INVALID_GRANT' })
    await expect(auth.authenticateMcpAccessToken({ ...context, accessToken: pair.accessToken })).resolves.toBeUndefined()
    await expect(auth.refreshMcpOAuthToken({ ...context, refreshToken: pair.refreshToken })).rejects.toMatchObject({ code: 'MCP_OAUTH_INVALID_GRANT' })
  })
})
