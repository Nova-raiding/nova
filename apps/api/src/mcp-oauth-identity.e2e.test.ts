import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { signPaymentCallback } from '../../../packages/billing/src/callback-envelope.mjs'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import { productionReadinessDiagnostics, server, setPasswordAuthRepositoryForTests, workspaceMembers } from './server.js'

async function start() {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

const callback = 'http://127.0.0.1:19091/oauth/callback'
const clientId = 'chatgpt-mcp-e2e'
const verifier = 'oauth-pkce-verifier-for-chatgpt-mcp-identity-000000000000000000000000'
const challenge = createHash('sha256').update(verifier).digest('base64url')

describe('canonical password identity MCP OAuth', () => {
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    setPasswordAuthRepositoryForTests()
    vi.unstubAllEnvs()
  })

  it('uses authorization code + PKCE, rotates refresh tokens, and never falls back to a static merchant token', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_OAUTH_REQUIRED', 'true')
    vi.stubEnv('MCP_OAUTH_CLIENTS', JSON.stringify({ [clientId]: [callback] }))
    const repository = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(repository)
    const workspaceId = `ws_mcp_oauth_${Date.now()}`
    const login = `oauth-${Date.now()}@example.test`
    const password = 'OauthPass1234!'
    const account = await repository.createMerchantAccount({ login, password, enterpriseName: 'OAuth merchant', contactName: 'OAuth owner', workspaceIds: [workspaceId], actorId: 'platform-operator', reason: 'MCP OAuth acceptance account' })
    const legacySubject = `legacy-oidc-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: legacySubject, displayName: 'OAuth owner', role: 'workspace_owner', status: 'active', invitedBy: 'mcp-oauth-e2e' })
    await workspaceMembers.bindIdentity({ workspaceId, externalSubject: legacySubject, identityId: account.identityId })
    const base = await start()
    const resource = `${base}/mcp`
    const authorize = new URL(`${base}/oauth/authorize`)
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: callback, state: 'state-one', code_challenge: challenge, code_challenge_method: 'S256', scope: 'merchant', resource })) authorize.searchParams.set(key, value)

    const loginPage = await fetch(authorize, { redirect: 'manual' })
    expect(loginPage.status).toBe(200)
    expect(await loginPage.text()).toContain('登录 Store Nova')

    const form = new URLSearchParams(authorize.searchParams)
    form.set('login', login); form.set('password', password)
    const authorized = await fetch(`${base}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' })
    expect(authorized.status).toBe(302)
    expect(authorized.headers.get('set-cookie')).toBeNull()
    const passwordCookie = authorized.headers.get('set-cookie')?.split(';')[0] ?? ''
    const redirect = new URL(authorized.headers.get('location')!)
    expect(redirect.origin + redirect.pathname).toBe(callback)
    expect(redirect.searchParams.get('state')).toBe('state-one')
    const code = redirect.searchParams.get('code')!

    const crossSiteCandidate = new URL(authorize); crossSiteCandidate.searchParams.set('state', 'attacker-controlled-state')
    const consentPage = await fetch(crossSiteCandidate, { headers: { cookie: passwordCookie }, redirect: 'manual' })
    expect(consentPage.status).toBe(200)
    expect(consentPage.headers.get('location')).toBeNull()
    expect(await consentPage.text()).toContain('登录 Store Nova')
    const unknownClient = new URL(crossSiteCandidate); unknownClient.searchParams.set('client_id', 'unknown-client')
    expect((await fetch(unknownClient, { headers: { cookie: passwordCookie }, redirect: 'manual' })).status).toBe(400)
    for (const inheritedName of ['constructor', 'toString', '__proto__']) {
      const inheritedAuthorize = new URL(authorize)
      inheritedAuthorize.searchParams.set('client_id', inheritedName)
      const rejectedAuthorize = await fetch(inheritedAuthorize, { redirect: 'manual' })
      expect(rejectedAuthorize.status, inheritedName).toBe(400)
      expect(rejectedAuthorize.headers.get('location')).toBeNull()
      const rejectedRefresh = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: inheritedName, refresh_token: 'invalid-refresh', resource }) })
      expect(rejectedRefresh.status, inheritedName).toBe(400)
      await expect(rejectedRefresh.json()).resolves.toEqual({ error: 'invalid_request' })
    }

    const shortVerifier = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback, code, code_verifier: 'a'.repeat(42), resource }) })
    expect(shortVerifier.status).toBe(400)
    expect(shortVerifier.headers.get('pragma')).toBe('no-cache')
    const wrongVerifier = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback, code, code_verifier: `${verifier}wrong`, resource }) })
    expect(wrongVerifier.status).toBe(400)
    await expect(wrongVerifier.json()).resolves.toEqual({ error: 'invalid_grant' })

    const exchanged = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback, code, code_verifier: verifier, resource }) })
    expect(exchanged.status).toBe(200)
    expect(exchanged.headers.get('pragma')).toBe('no-cache')
    const tokens = await exchanged.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string }
    expect(tokens).toMatchObject({ expires_in: 600, scope: 'merchant' })
    const principal = await repository.authenticateMcpAccessToken({ accessToken: tokens.access_token, clientId, issuer: base, audience: resource, resource, scope: ['merchant'] })
    expect(principal).toMatchObject({ identityId: account.identityId, accountLogin: login, workspaceId })

    const initialized = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })
    expect(initialized.status).toBe(200)
    await expect(initialized.json()).resolves.toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'merchant-marketing' } } })
    const cookieOnly = await fetch(`${base}/mcp`, { method: 'POST', headers: { cookie: 'damai_session=browser-session-must-not-authenticate-mcp', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1.1, method: 'initialize', params: {} }) })
    expect(cookieOnly.status).toBe(401)

    const health = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1.1, method: 'workspace.health', params: {} }) })
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({ data: { jsonrpc: '2.0', id: 1.1, result: expect.any(Object) } })

    const switched = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', 'x-workspace-id': 'ws_other' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }) })
    expect(switched.status).toBe(403)

    const ops = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ops.session', params: {} }) })
    expect(ops.status).toBe(403)
    await expect(ops.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    const legacyOps = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 3.1, method: 'ops.users.list', params: {} }) })
    expect(legacyOps.status).toBe(403)

    const refreshed = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource }) })
    expect(refreshed.status).toBe(200)
    const rotated = await refreshed.json() as { access_token: string; refresh_token: string }
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token)
    const replay = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token, resource }) })
    expect(replay.status).toBe(400)
    const revokedFamily = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${rotated.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} }) })
    expect(revokedFamily.status).toBe(401)

    const epochCode = await repository.issueMcpAuthorizationCode({ account, clientId, redirectUri: callback, codeChallenge: challenge, issuer: base, audience: resource, resource, scope: ['merchant'] })
    const epochTokens = await repository.exchangeMcpAuthorizationCode({ clientId, redirectUri: callback, code: epochCode.code, codeVerifier: verifier, issuer: base, audience: resource, resource, scope: ['merchant'] })
    const passwordSession = await repository.login({ login, password })
    await repository.changePassword({ token: passwordSession.token, currentPassword: password, newPassword: 'OauthPass5678!' })
    await expect(repository.authenticateMcpAccessToken({ accessToken: epochTokens.accessToken, clientId, issuer: base, audience: resource, resource, scope: ['merchant'] })).resolves.toBeUndefined()

    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('MCP_OAUTH_REQUIRED', undefined)
    vi.stubEnv('PUBLIC_APP_BASE_URL', 'https://yxsona.com')
    vi.stubEnv('MERCHANT_BEARER_HOSTNAME', '127.0.0.1')
    vi.stubEnv('MCP_OAUTH_CLIENTS', JSON.stringify({ [clientId]: ['https://chatgpt.com/oauth/callback'] }))
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'legacy-static-token': { actor_id: account.identityId, workspaces: [workspaceId], roles: ['workspace_owner'] } }))
    const staticFallback = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer legacy-static-token', cookie: passwordCookie, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'initialize', params: {} }) })
    // Missing/non-canonical production OAuth configuration is a runtime
    // blocker, not an opportunity to authenticate through the legacy token.
    expect({ status: staticFallback.status, body: await staticFallback.json() }).toMatchObject({ status: 503, body: { error: { code: 'MCP_OAUTH_NOT_CONFIGURED' } } })
  })

  it('lets only the invited OAuth identity view and accept an account-login invitation', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_OAUTH_REQUIRED', 'true')
    vi.stubEnv('MCP_OAUTH_CLIENTS', JSON.stringify({ [clientId]: [callback] }))
    const repository = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(repository)
    const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
    const workspaceId = `ws_oauth_invitation_${suffix}`
    const accounts = await Promise.all(['invited', 'other'].map(label => {
      const login = `oauth-${label}-${suffix}@example.test`
      return repository.createMerchantAccount({ login, password: `OAuth${label}Pass1234!`, enterpriseName: `OAuth ${label}`, contactName: `OAuth ${label}`, workspaceIds: [workspaceId], actorId: 'platform-operator', reason: 'OAuth invitation identity test' })
        .then(account => ({ account, login }))
    }))
    const invitation = await workspaceMembers.upsert({ workspaceId, externalSubject: accounts[0]!.login, displayName: 'Invited OAuth merchant', role: 'operator', status: 'invited', invitedBy: 'workspace-owner' })
    const base = await start()
    const resource = `${base}/mcp`
    const accessToken = async ({ account }: (typeof accounts)[number]) => {
      const issued = await repository.issueMcpAuthorizationCode({ account, clientId, redirectUri: callback, codeChallenge: challenge, issuer: base, audience: resource, resource, scope: ['merchant'] })
      return (await repository.exchangeMcpAuthorizationCode({ clientId, redirectUri: callback, code: issued.code, codeVerifier: verifier, issuer: base, audience: resource, resource, scope: ['merchant'] })).accessToken
    }
    const tokens = await Promise.all(accounts.map(accessToken))
    const invitedToken = tokens[0]!
    const otherToken = tokens[1]!
    const call = async (token: string, id: number, method: string, params: Record<string, unknown> = {}) => {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, workspace_id: workspaceId } }),
      })
      return { status: response.status, body: await response.json() as { data?: { result?: Record<string, any> }; error?: { code?: string } } }
    }

    const visible = await call(invitedToken, 1, 'workspace.invitations.list')
    expect(visible).toMatchObject({ status: 200, body: { data: { result: { unread_count: 1, invitations: [expect.objectContaining({ member_id: invitation.id, status: 'invited', revision: invitation.revision })] } } } })

    const isolated = await call(otherToken, 2, 'workspace.invitations.list')
    expect(isolated).toMatchObject({ status: 200, body: { data: { result: { unread_count: 0, invitations: [] } } } })

    const accepted = await call(invitedToken, 3, 'workspace.invitation.accept', { expected_revision: String(invitation.revision), reason: 'Accept OAuth invitation' })
    expect(accepted).toMatchObject({ status: 200, body: { data: { result: { accepted: true, member: expect.objectContaining({ externalSubject: accounts[0]!.login, status: 'active' }) } } } })
    const health = await call(invitedToken, 4, 'workspace.health')
    expect(health.status).toBe(200)
    expect((await workspaceMembers.list(workspaceId)).find(member => member.id === invitation.id)).toMatchObject({ externalSubject: accounts[0]!.login, identityId: accounts[0]!.account.identityId, status: 'active' })
  })

  it('attributes a signed fixture recharge exactly once to the canonical OAuth identity and camouflages it from another member', async () => {
    const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
    const workspaceId = `ws_oauth_payment_${suffix}`
    const callbackSecret = `oauth-payment-callback-${suffix}`
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_OAUTH_REQUIRED', 'true')
    vi.stubEnv('MCP_OAUTH_CLIENTS', JSON.stringify({ [clientId]: [callback] }))
    vi.stubEnv('PAYMENT_MODE', 'fixture')
    vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
    vi.stubEnv('PAYMENT_CALLBACK_SECRET', callbackSecret)
    vi.stubEnv('PAYMENT_ONE_FEN_TEST_ENABLED', 'true')
    vi.stubEnv('PAYMENT_ONE_FEN_TEST_WORKSPACE_ID', workspaceId)

    const repository = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(repository)
    const merchants = await Promise.all(['a', 'b'].map(async label => {
      const login = `oauth-payment-${label}-${suffix}@example.test`
      const password = `OAuthPayment${label.toUpperCase()}1234!`
      const account = await repository.createMerchantAccount({ login, password, enterpriseName: `OAuth payment ${label}`, contactName: `Owner ${label}`, workspaceIds: [workspaceId], actorId: 'platform-operator', reason: 'OAuth payment identity acceptance account' })
      await workspaceMembers.upsert({ workspaceId, externalSubject: login, displayName: `OAuth payment ${label}`, role: 'workspace_owner', status: 'active', invitedBy: 'mcp-oauth-payment-e2e' })
      return { account, login, password }
    }))

    const base = await start()
    const resource = `${base}/mcp`
    const authorizeAndExchange = async (merchant: (typeof merchants)[number], state: string) => {
      const authorize = new URL(`${base}/oauth/authorize`)
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: callback, state, code_challenge: challenge, code_challenge_method: 'S256', scope: 'merchant', resource })) authorize.searchParams.set(key, value)
      const form = new URLSearchParams(authorize.searchParams)
      form.set('login', merchant.login)
      form.set('password', merchant.password)
      const authorized = await fetch(`${base}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form, redirect: 'manual' })
      expect(authorized.status).toBe(302)
      const redirect = new URL(authorized.headers.get('location')!)
      expect(redirect.searchParams.get('state')).toBe(state)
      const code = redirect.searchParams.get('code')!
      const exchanged = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback, code, code_verifier: verifier, resource }) })
      expect(exchanged.status).toBe(200)
      return (await exchanged.json() as { access_token: string }).access_token
    }
    const [tokenA, tokenB] = await Promise.all([
      authorizeAndExchange(merchants[0]!, `payment-a-${suffix}`),
      authorizeAndExchange(merchants[1]!, `payment-b-${suffix}`),
    ])
    const callMcp = async (token: string, id: number, name: string, arguments_: Record<string, unknown>) => {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }),
      })
      return { status: response.status, body: await response.json() as { result?: { structuredContent?: Record<string, any> }; error?: { code: number; data?: { code?: string } } } }
    }

    const idempotencyKey = `real-pay-test-oauth-${suffix}`
    const created = await callMcp(tokenA, 1, 'billing.recharge.create', { channel: 'alipay', amount_cny: '0.01', idempotency_key: idempotencyKey })
    expect(created.status).toBe(200)
    const membersAfterA = await workspaceMembers.list(workspaceId)
    expect(membersAfterA.find(member => member.externalSubject === merchants[0]!.login)).toMatchObject({ identityId: merchants[0]!.account.identityId })
    expect(membersAfterA.find(member => member.externalSubject === merchants[1]!.login)).not.toHaveProperty('identityId')
    const order = created.body.result?.structuredContent as { id: string; state: string; amount_cny: string; paymentUrl?: string; payment_url?: string }
    expect(order).toMatchObject({ state: 'pending', amount_cny: '0.01' })
    expect(order.paymentUrl ?? order.payment_url).toMatch(/^fixture:\/\/alipay\//u)

    const providerTradeId = `alipay-fixture-${suffix}`
    const callbackPayload = { workspace_id: workspaceId, order_id: order.id, provider_trade_id: providerTradeId, amount_fen: 1, currency: 'CNY' as const, state: 'paid' as const }
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = `oauth-payment-${randomUUID().replaceAll('-', '')}`
    const signature = signPaymentCallback({ secret: callbackSecret, channel: 'alipay', workspaceId, orderId: order.id, providerTradeId, amountFen: 1, currency: 'CNY', state: 'paid', timestamp, nonce })
    const callbackHeaders = { 'content-type': 'application/json', 'x-payment-signature': signature, 'x-payment-timestamp': timestamp, 'x-payment-nonce': nonce }
    for (const replayed of [false, true]) {
      const callbackResponse = await fetch(`${base}/v1/billing/callback/alipay`, { method: 'POST', headers: callbackHeaders, body: JSON.stringify(callbackPayload) })
      expect(callbackResponse.status).toBe(200)
      await expect(callbackResponse.json()).resolves.toMatchObject({ data: { state: 'paid' }, error: null })
      if (!replayed) {
        const paid = await callMcp(tokenA, 2, 'billing.recharge.get', { order_id: order.id })
        expect(paid.body.result?.structuredContent).toMatchObject({ id: order.id, state: 'paid', amount_cny: '0.01' })
      }
    }

    const hiddenFromB = await callMcp(tokenB, 3, 'billing.recharge.get', { order_id: order.id })
    expect(hiddenFromB).toMatchObject({ status: 200, body: { error: { data: { code: 'BILLING_ORDER_NOT_FOUND' } } } })
    expect(await workspaceMembers.list(workspaceId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalSubject: merchants[0]!.login, identityId: merchants[0]!.account.identityId }),
      expect.objectContaining({ externalSubject: merchants[1]!.login, identityId: merchants[1]!.account.identityId }),
    ]))
    const crossWorkspace = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokenB}`, 'content-type': 'application/json', 'x-workspace-id': `other-${workspaceId}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 3.1, method: 'tools/call', params: { name: 'billing.recharge.get', arguments: { order_id: order.id } } }) })
    expect(crossWorkspace.status).toBe(403)

    const transactions = await callMcp(tokenA, 4, 'billing.transactions', { scope: 'mine', limit: '20' })
    const matching = (transactions.body.result?.structuredContent as { transactions: Array<Record<string, unknown>> }).transactions.filter(transaction => transaction.orderId === order.id)
    expect(matching).toEqual([expect.objectContaining({ type: 'recharge', amount_cny: '0.01', actorId: merchants[0]!.account.identityId })])
  })

  it('rejects duplicate critical parameters before any login or token exchange', async () => {
    vi.stubEnv('MCP_OAUTH_CLIENTS', JSON.stringify({ [clientId]: [callback] }))
    const base = await start()
    const resource = `${base}/mcp`
    const duplicate = `${base}/oauth/authorize?response_type=code&client_id=${clientId}&client_id=attacker&redirect_uri=${encodeURIComponent(callback)}&state=s&code_challenge=${challenge}&code_challenge_method=S256&scope=merchant&resource=${encodeURIComponent(resource)}`
    expect((await fetch(duplicate)).status).toBe(400)
    const token = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=refresh_token&client_id=${clientId}&refresh_token=a&refresh_token=b&resource=${encodeURIComponent(resource)}` })
    expect(token.status).toBe(400)
    await expect(token.json()).resolves.toEqual({ error: 'invalid_request' })
    const missingResource = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=refresh_token&client_id=${clientId}&refresh_token=a` })
    expect(missingResource.status).toBe(400)
    await expect(missingResource.json()).resolves.toEqual({ error: 'invalid_request' })
    const jsonToken = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant_type: 'refresh_token', client_id: clientId, refresh_token: 'a', resource }) })
    expect(jsonToken.status).toBe(415)
    const normalizedRedirect = `${base}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(`${callback}/`)}&state=s&code_challenge=${challenge}&code_challenge_method=S256&scope=merchant&resource=${encodeURIComponent(resource)}`
    expect((await fetch(normalizedRedirect)).status).toBe(400)
    const unsupportedOidcScope = `${base}/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callback)}&state=s&code_challenge=${challenge}&code_challenge_method=S256&scope=openid%20merchant&resource=${encodeURIComponent(resource)}`
    expect((await fetch(unsupportedOidcScope)).status).toBe(400)
  })

  it('fails closed before static-token fallback when required OAuth clients are invalid', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_OAUTH_REQUIRED', 'true')
    vi.stubEnv('MCP_OAUTH_CLIENTS', '{invalid-json')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ 'legacy-token': { actor_id: 'legacy', workspaces: ['ws_legacy'], roles: ['workspace_owner'] } }))
    const base = await start()
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer legacy-token', 'x-workspace-id': 'ws_legacy', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'initialize', params: {} }) })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'MCP_OAUTH_NOT_CONFIGURED' } })
  })

  it('does not start an OAuth lifecycle in production without a canonical public origin', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('MCP_OAUTH_REQUIRED', 'true')
    vi.stubEnv('PUBLIC_APP_BASE_URL', '')
    vi.stubEnv('MCP_OAUTH_ISSUER', '')
    vi.stubEnv('MCP_OAUTH_AUTHORIZATION_ENDPOINT', '')
    vi.stubEnv('MCP_OAUTH_TOKEN_ENDPOINT', '')
    vi.stubEnv('MCP_OAUTH_CLIENTS', JSON.stringify({ [clientId]: ['https://chatgpt.com/oauth/callback'] }))
    const base = await start()
    const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.example' }
    const authorize = new URL(`${base}/oauth/authorize`)
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: 'https://chatgpt.com/oauth/callback', state: 'state', code_challenge: challenge, code_challenge_method: 'S256', scope: 'merchant', resource: 'https://attacker.example/mcp' })) authorize.searchParams.set(key, value)
    const rejectedAuthorize = await fetch(authorize, { headers, redirect: 'manual' })
    expect(rejectedAuthorize.status).toBe(503)
    await expect(rejectedAuthorize.json()).resolves.toEqual({ error: 'temporarily_unavailable' })

    const rejectedToken = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: 'untrusted', resource: 'https://attacker.example/mcp' }) })
    expect(rejectedToken.status).toBe(503)
    await expect(rejectedToken.json()).resolves.toEqual({ error: 'temporarily_unavailable' })
  })

  it('makes production identity readiness depend on self-hosted MCP OAuth instead of static bearer grants', () => {
    const identityEnvironment: NodeJS.ProcessEnv = {
      NODE_ENV: 'production', OPS_AUTH_MODE: 'oidc', OIDC_PROXY_SIGNING_SECRET: 'oidc-secret', SESSION_ID_HASH_SECRET: 'session-secret', OPS_DATABASE_URL: 'postgres://control-plane', MERCHANT_BEARER_HOSTNAME: 'yxsona.com', MCP_OAUTH_REQUIRED: 'true', PUBLIC_APP_BASE_URL: 'https://yxsona.com', MCP_OAUTH_ISSUER: 'https://yxsona.com', MCP_OAUTH_AUTHORIZATION_ENDPOINT: 'https://yxsona.com/oauth/authorize', MCP_OAUTH_TOKEN_ENDPOINT: 'https://yxsona.com/oauth/token', MCP_OAUTH_CLIENTS: JSON.stringify({ chatgpt: ['https://chatgpt.com/oauth/callback'] }),
    }
    expect(productionReadinessDiagnostics(identityEnvironment).gates.identity).toEqual({ ready: true, reasons: [] })
    delete identityEnvironment.MCP_OAUTH_CLIENTS
    expect(productionReadinessDiagnostics(identityEnvironment).gates.identity).toMatchObject({ ready: false, reasons: expect.arrayContaining(['mcp_oauth_clients_missing_or_invalid']) })
    for (const redirect of ['ftp://localhost/callback', 'https://user@example.test/callback', 'https://example.test/callback#fragment', 'http://example.test/callback']) {
      identityEnvironment.MCP_OAUTH_CLIENTS = JSON.stringify({ chatgpt: [redirect] })
      expect(productionReadinessDiagnostics(identityEnvironment).gates.identity).toMatchObject({ ready: false, reasons: expect.arrayContaining(['mcp_oauth_clients_missing_or_invalid']) })
    }
    for (const redirect of ['http://localhost/callback', 'http://127.0.0.1/callback', 'http://[::1]/callback']) {
      identityEnvironment.MCP_OAUTH_CLIENTS = JSON.stringify({ chatgpt: [redirect] })
      expect(productionReadinessDiagnostics(identityEnvironment).gates.identity).toEqual({ ready: true, reasons: [] })
    }
  })
})
