import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import argon2 from 'argon2'
import { signPaymentCallback } from '../../../packages/billing/src/callback-envelope.mjs'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import { enableCommercialFixtureHarnessForTests, productionReadinessDiagnostics, server, setPasswordAuthRepositoryForTests, workspaceMembers } from './server.js'

async function start() {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('canonical password identity and local plugin authentication', () => {
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    setPasswordAuthRepositoryForTests()
    vi.unstubAllEnvs()
  })

  it('exchanges a merchant browser session for a local desktop MCP token without ChatGPT OAuth', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
    const repository = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(repository)
    const workspaceId = `ws_local_desktop_${Date.now()}`
    const login = `local-desktop-${Date.now()}@example.test`
    const password = 'LocalDesktop1234!'
    const account = await repository.createMerchantAccount({ login, password, enterpriseName: 'Local desktop merchant', contactName: 'Local owner', workspaceIds: [workspaceId], actorId: 'platform-operator', reason: 'local desktop e2e' })
    await workspaceMembers.upsert({ workspaceId, externalSubject: login, displayName: 'Local owner', role: 'workspace_owner', status: 'active', invitedBy: 'local-desktop-e2e' })
    await workspaceMembers.bindIdentity({ workspaceId, externalSubject: login, identityId: account.identityId })
    const base = await start()
    const logged = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'merchant' }) })
    expect(logged.status).toBe(200)
    const cookie = logged.headers.get('set-cookie')?.split(';')[0]
    expect(cookie).toBeTruthy()
    const merchantCookieMcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { cookie: cookie!, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) })
    expect(merchantCookieMcp.status).toBe(401)
    const crossTenantHttp = await fetch(`${base}/v1/products`, { headers: { cookie: cookie!, 'x-workspace-id': 'ws_other' } })
    expect(crossTenantHttp.status).toBe(403)
    await expect(crossTenantHttp.json()).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } })
    const exchanged = await fetch(`${base}/v1/auth/mcp-token`, { method: 'POST', headers: { cookie: cookie!, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: workspaceId }) })
    expect(exchanged.status).toBe(200)
    const envelope = await exchanged.json() as { data?: { result?: Record<string, unknown> }; error?: unknown }
    const result = envelope.data?.result ?? envelope.data
    expect(result).toMatchObject({ token_type: 'Bearer', expires_in: 600, scope: 'merchant', workspace_id: workspaceId, account_login: login })
    const accessToken = (result as Record<string, unknown> | undefined)?.access_token
    const refreshToken = (result as Record<string, unknown> | undefined)?.refresh_token
    expect(typeof accessToken).toBe('string')
    expect(typeof refreshToken).toBe('string')
    const principal = await repository.authenticateMcpAccessToken({ accessToken: accessToken as string, clientId: 'local-desktop', issuer: base, audience: `${base}/mcp`, resource: `${base}/mcp`, scope: ['merchant'] })
    expect(principal).toMatchObject({ identityId: account.identityId, workspaceId, accountLogin: login })
    const initialized = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'x-workspace-id': workspaceId, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) })
    expect(initialized.status).toBe(200)
    await expect(initialized.json()).resolves.toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: expect.any(String) } } })
    const switched = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'x-workspace-id': 'ws_other', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }) })
    expect(switched.status).toBe(403)
    const rotated = await fetch(`${base}/v1/auth/mcp-token/refresh`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshToken }) })
    expect(rotated.status).toBe(200)
    const rotatedEnvelope = await rotated.json() as { data?: { result?: Record<string, unknown> } }
    const rotatedResult = (rotatedEnvelope.data?.result ?? rotatedEnvelope.data ?? {}) as Record<string, unknown>
    expect(rotatedResult).toMatchObject({ token_type: 'Bearer', expires_in: 600 })
    const revoke = await fetch(`${base}/v1/auth/mcp-token/revoke`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: rotatedResult?.refresh_token }) })
    expect(revoke.status).toBe(200)
    await expect(repository.authenticateMcpAccessToken({ accessToken: String(rotatedResult?.access_token), clientId: 'local-desktop', issuer: base, audience: `${base}/mcp`, resource: `${base}/mcp`, scope: ['merchant'] })).resolves.toBeUndefined()
    const csrf = await fetch(`${base}/v1/auth/mcp-token`, { method: 'POST', headers: { cookie: cookie!, origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: workspaceId }) })
    expect(csrf.status).toBe(403)
  })

  it('keeps the password-authenticated operations console usable in local stdio mode', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
    const repository = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(repository)
    const login = `local-ops-${Date.now()}@example.test`
    const password = 'LocalOps1234!'
    await repository.ensurePlatformAccount({ login, passwordHash: await argon2.hash(password), roles: ['platform_admin'] })
    const base = await start()
    const logged = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password, account_type: 'platform' }) })
    expect(logged.status).toBe(200)
    const cookie = logged.headers.get('set-cookie')?.split(';')[0]
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { cookie: cookie!, origin: base, 'x-ops-workbench': 'platform', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ops.session', params: {} }) })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ data: { result: { workbench: 'platform' } } })
    const opsBearer = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer legacy-ops-token', host: 'ops.yxsona.com', 'x-ops-workbench': 'platform', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ops.session', params: {} }) })
    expect(opsBearer.status).toBe(401)
    await expect(opsBearer.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
  })

  it('rejects legacy remote OAuth endpoints while local plugin credentials remain isolated', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    const base = await start()
    for (const path of ['/oauth/authorize', '/oauth/token', '/oauth/revoke', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource']) {
      const response = await fetch(`${base}${path}`, { method: path === '/oauth/authorize' ? 'GET' : path.startsWith('/.well-known') ? 'GET' : 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: path.endsWith('/token') || path.endsWith('/revoke') ? 'grant_type=refresh_token' : undefined })
      expect(response.status, path).toBe(401)
    }
    const remoteBearer = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer legacy-token', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }) })
    expect(remoteBearer.status).toBe(403)
    expect((await remoteBearer.json()).error.code).toBe('FORBIDDEN')
  })

  it('attributes a signed fixture recharge exactly once to the canonical local password identity and camouflages it from another member', async () => {
    const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`
    const workspaceId = `ws_oauth_payment_${suffix}`
    const callbackSecret = `oauth-payment-callback-${suffix}`
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('PAYMENT_MODE', 'fixture')
    vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
    vi.stubEnv('PAYMENT_CALLBACK_SECRET', callbackSecret)
    vi.stubEnv('PAYMENT_ONE_FEN_TEST_ENABLED', 'true')
    vi.stubEnv('PAYMENT_ONE_FEN_TEST_WORKSPACE_ID', workspaceId)
    enableCommercialFixtureHarnessForTests()

    const repository = new MemoryPasswordAuthRepository()
    setPasswordAuthRepositoryForTests(repository)
    const merchants = await Promise.all(['a', 'b'].map(async label => {
      const login = `local-payment-${label}-${suffix}@example.test`
      const password = `LocalPayment${label.toUpperCase()}1234!`
      const account = await repository.createMerchantAccount({ login, password, enterpriseName: `Local payment ${label}`, contactName: `Owner ${label}`, workspaceIds: [workspaceId], actorId: 'platform-operator', reason: 'Local plugin payment identity acceptance account' })
      await workspaceMembers.upsert({ workspaceId, externalSubject: login, displayName: `Local payment ${label}`, role: 'workspace_owner', status: 'active', invitedBy: 'mcp-local-payment-e2e' })
      return { account, login, password }
    }))

    const base = await start()
    const callMcp = async (merchant: (typeof merchants)[number], id: number, name: string, arguments_: Record<string, unknown>) => {
      const logged = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: merchant.login, password: merchant.password, account_type: 'merchant' }) })
      const cookie = logged.headers.get('set-cookie')?.split(';')[0]
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { cookie: cookie!, origin: base, 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-test-workspace-fixture': 'server-e2e', 'x-test-commercial-fixture': 'server-e2e' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }),
      })
      return { status: response.status, body: await response.json() as { result?: { structuredContent?: Record<string, any> }; error?: { code: number; data?: { code?: string } } } }
    }

    const idempotencyKey = `real-pay-test-oauth-${suffix}`
    const created = await callMcp(merchants[0]!, 1, 'billing.recharge.create', { channel: 'alipay', amount_cny: '0.01', idempotency_key: idempotencyKey })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
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
        const paid = await callMcp(merchants[0]!, 2, 'billing.recharge.get', { order_id: order.id })
        expect(paid.body.result?.structuredContent).toMatchObject({ id: order.id, state: 'paid', amount_cny: '0.01' })
      }
    }

    const hiddenFromB = await callMcp(merchants[1]!, 3, 'billing.recharge.get', { order_id: order.id })
    expect(hiddenFromB).toMatchObject({ status: 200, body: { error: { data: { code: 'BILLING_ORDER_NOT_FOUND' } } } })
    expect(await workspaceMembers.list(workspaceId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalSubject: merchants[0]!.login, identityId: merchants[0]!.account.identityId }),
      expect.objectContaining({ externalSubject: merchants[1]!.login, identityId: merchants[1]!.account.identityId }),
    ]))
    const otherLogged = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: merchants[1]!.login, password: merchants[1]!.password, account_type: 'merchant' }) })
    const otherCookie = otherLogged.headers.get('set-cookie')?.split(';')[0]
    const crossWorkspace = await fetch(`${base}/mcp`, { method: 'POST', headers: { cookie: otherCookie!, origin: base, 'content-type': 'application/json', 'x-workspace-id': `other-${workspaceId}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 3.1, method: 'tools/call', params: { name: 'billing.recharge.get', arguments: { order_id: order.id } } }) })
    expect(crossWorkspace.status).toBe(403)

    const transactions = await callMcp(merchants[0]!, 4, 'billing.transactions', { scope: 'mine', limit: '20' })
    const matching = (transactions.body.result?.structuredContent as { transactions: Array<Record<string, unknown>> }).transactions.filter(transaction => transaction.orderId === order.id)
    expect(matching).toEqual([expect.objectContaining({ type: 'recharge', amount_cny: '0.01', actorId: merchants[0]!.account.identityId })])
  })

  it('requires password Ops login and local stdio instead of ChatGPT remote OAuth', () => {
    const identityEnvironment: NodeJS.ProcessEnv = {
      NODE_ENV: 'production', OPS_AUTH_MODE: 'password', SESSION_ID_HASH_SECRET: 'session-secret', OPS_DATABASE_URL: 'postgres://control-plane', MERCHANT_BEARER_HOSTNAME: 'yxsona.com', MCP_INTEGRATION_MODE: 'local_stdio', PUBLIC_APP_BASE_URL: 'https://yxsona.com', PUBLIC_OPS_BASE_URL: 'https://ops.yxsona.com',
    }
    expect(productionReadinessDiagnostics(identityEnvironment).gates.identity).toEqual({ ready: true, reasons: [] })
    identityEnvironment.MCP_INTEGRATION_MODE = 'remote_oauth'
    expect(productionReadinessDiagnostics(identityEnvironment).gates.identity).toMatchObject({ ready: false, reasons: expect.arrayContaining(['mcp_integration_mode_must_be_local_stdio']) })

    identityEnvironment.OPS_AUTH_MODE = 'oidc'
    expect(productionReadinessDiagnostics(identityEnvironment).gates.identity).toMatchObject({ ready: false, reasons: expect.arrayContaining(['ops_auth_mode_must_be_password']) })
    identityEnvironment.OPS_AUTH_MODE = 'password'
    identityEnvironment.MCP_INTEGRATION_MODE = 'remote_oauth'
    identityEnvironment.MCP_OAUTH_REQUIRED = 'true'
    expect(productionReadinessDiagnostics(identityEnvironment).gates.identity).toMatchObject({ ready: false, reasons: expect.arrayContaining(['mcp_integration_mode_must_be_local_stdio', 'retired_external_auth_settings_present']) })
  })
})
