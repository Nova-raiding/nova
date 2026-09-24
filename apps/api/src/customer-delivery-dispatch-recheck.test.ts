import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MemoryAuthorizationRepository } from '../../../packages/persistence/src/authorization-repository.js'
import { MemoryPasswordAuthRepository } from '../../../packages/persistence/src/password-auth-repository.js'
import type { ProviderBeforeRequest } from '../../../packages/ai/src/provider-request.js'
import type { VideoGenerationInput } from '../../../packages/ai/src/video-generator.js'
import { trustedPlatformRuleTestRepository } from './platform-rule-test-fixture.js'

const controlledTransport = vi.hoisted(() => ({
  entered: undefined as (() => void) | undefined,
  waiting: Promise.resolve() as Promise<void>,
  provider: vi.fn(async () => ({ status: 'queued' as const, providerJobId: 'controlled-video-job' })),
}))

// Only the remote adapter is controlled. Preserve the real composition root's
// third-argument hook and invoke it after the asynchronous preflight, exactly
// where the actual adapter checks before fetch. Never contact a real provider.
vi.mock('../../../packages/ai/src/video-generator.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../packages/ai/src/video-generator.js')>(),
  createVideoGeneratorFromEnv: (_env: unknown, _usage: unknown, beforeRequest?: ProviderBeforeRequest) => ({
    generate: async (input: VideoGenerationInput) => {
      controlledTransport.entered?.()
      await controlledTransport.waiting
      if (!beforeRequest) throw new Error('Actual API beforeRequest hook was not wired')
      await beforeRequest({ operation: 'video_generate', workspaceId: input.usageContext?.workspaceId })
      return controlledTransport.provider()
    },
    getStatus: vi.fn(),
  }),
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

type Envelope = { data: { result?: { rendering?: { status: string; providerJobId: string } } } | null; error: { code: string; message?: string } | null }
let api: typeof import('./server.js')
let base = ''
const clientId = 'local-desktop'
const redirectUri = 'http://127.0.0.1:19091/merchant-mcp-callback'
const verifier = 'dispatch-recheck-pkce-verifier-only-for-controlled-test-000000000000'

beforeAll(async () => {
  for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL', 'REDIS_URL', 'PGHOST']) {
    if (process.env[key]) throw new Error(`Use safe-tests: inherited ${key} is forbidden`)
  }
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
  vi.stubEnv('MCP_INTEGRATION_MODE', 'local_stdio')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'dispatch-recheck-controlled-session-secret')
  vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
  vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('MODEL_RELAY_BASE_URL', 'https://relay.example.test')
  vi.stubEnv('VIDEO_MODEL_RELAY_API_KEY', 'controlled-no-network-key')
  vi.stubEnv('VIDEO_MODEL', 'controlled-video-model')
  vi.stubEnv('PLATFORM_RULE_SYNC_MANIFEST_URL', 'https://rules.example.test/manifest.json')
  vi.stubEnv('PLATFORM_RULE_SYNC_SIGNING_SECRET', 'controlled-dispatch-rule-secret')
  api = await import('./server.js')
  await api.persistenceReady
  await new Promise<void>((resolve, reject) => {
    api.server.once('error', reject)
    api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', reject); resolve() })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('Controlled dispatch listener did not bind')
  base = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  try {
    if (api?.server.listening) await new Promise<void>(resolve => { api.server.close(() => resolve()); api.server.closeAllConnections() })
  } finally {
    api?.setPasswordAuthRepositoryForTests()
    api?.setAuthorizationRepositoryForTests()
    api?.setRuleRepositoryForTests()
    vi.unstubAllEnvs()
  }
})

// Real loopback HTTP -> real local-plugin bearer authentication -> MCP capability and
// commercial fixture admission -> real final dispatch hook. Identity/member/
// authz repositories and approved points/rules are isolated test fixtures;
// these assertions are not live PostgreSQL, payment or provider acceptance.
describe('inline API dispatch rechecks the current membership capability', () => {
  it.each([false, true])('keeps authorization revision unchanged while member downgrade=%s controls actual transport admission', async downgrade => {
    const suffix = randomUUID()
    const workspaceId = `ws_dispatch_role_${suffix}`
    const login = `dispatch-role-${suffix}@example.test`
    const passwordRepository = new MemoryPasswordAuthRepository()
    const authorizationRepository = new MemoryAuthorizationRepository()
    api.setPasswordAuthRepositoryForTests(passwordRepository)
    api.setAuthorizationRepositoryForTests(authorizationRepository)
    const account = await passwordRepository.createMerchantAccount({ login, password: 'ControlledDispatch1234!', enterpriseName: 'Controlled dispatch merchant', contactName: 'Controlled member', workspaceIds: [workspaceId], actorId: 'dispatch-test-operator', reason: 'isolated final authorization regression' })
    const member = await api.workspaceMembers.upsert({ workspaceId, externalSubject: login, displayName: 'Controlled member', role: 'workspace_owner', status: 'active', invitedBy: 'dispatch-test' })
    await api.workspaceMembers.bindIdentity({ workspaceId, externalSubject: login, identityId: account.identityId })
    const resource = `${base}/mcp`
    const code = await passwordRepository.issueMcpAuthorizationCode({ account, clientId, redirectUri, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), issuer: base, audience: resource, resource, scope: ['merchant'], workspaceId })
    const exchanged = await fetch(`${base}/v1/auth/local-plugin/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code: code.code, code_verifier: verifier, resource, workspace_id: workspaceId }),
    })
    expect(exchanged.status).toBe(200)
    const envelope = await exchanged.json() as { data: { access_token: string } }
    const tokens = envelope.data
    expect(await passwordRepository.authenticateMcpAccessToken({ accessToken: tokens.access_token, clientId, issuer: base, audience: resource, resource, scope: ['merchant'] })).toMatchObject({ identityId: account.identityId, accountLogin: login, workspaceId })
    const store = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `controlled-store-${suffix}`, credentialRef: `fixture://${workspaceId}/taobao` })
    const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: store.id, localProductKey: `product-${suffix}`, title: '真实事实测试商品', category: '外套', stock: 1 })
    api.service.confirmProductFacts(workspaceId, product.id)
    api.setRuleRepositoryForTests(await trustedPlatformRuleTestRepository(workspaceId, 'taobao'))
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    const revision = await authorizationRepository.getAuthorizationRevision(account.identityId)
    const entered = deferred()
    const waiting = deferred()
    controlledTransport.entered = entered.resolve
    controlledTransport.waiting = waiting.promise
    controlledTransport.provider.mockClear()
    const response = fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-test-commercial-fixture': 'server-e2e' },
      body: JSON.stringify({ jsonrpc: '2.0', id: suffix, method: 'multimodal.video.request', params: {
        workspace_id: workspaceId, prompt: '根据确认的商品事实生成展示视频', output: 'rendering', idempotency_key: `dispatch-${suffix}`,
        context_json: JSON.stringify({ brand: { id: 'controlled-brand', version: '1' }, product: { id: product.id, version: String(product.version) }, rules: [{ id: 'controlled-rule', version: '1' }] }),
      } }),
    }).then(async result => ({ status: result.status, body: await result.json() as Envelope }))
    try {
      await Promise.race([
        entered.promise,
        response.then(result => { throw new Error(`Request failed before controlled preflight: ${JSON.stringify(result)}`) }),
      ])
      expect(controlledTransport.provider).not.toHaveBeenCalled()
      if (downgrade) {
        const changed = await api.workspaceMembers.upsertWithAudit({ workspaceId, externalSubject: login, displayName: 'Controlled member', role: 'finance', status: 'active', expectedRevision: member.revision, actorId: 'dispatch-test-operator', action: 'member.upsert', reason: 'revoke content capability while dispatch is waiting' })
        // Memory upsert mirrors the persisted role transition but does not
        // retain optional identity metadata; restore only that immutable key.
        await api.workspaceMembers.bindIdentity({ workspaceId, externalSubject: login, identityId: account.identityId })
        expect(changed.member.revision).toBe(member.revision + 1)
      }
      expect(await authorizationRepository.getAuthorizationRevision(account.identityId)).toBe(revision)
      waiting.resolve()
      const result = await response
      if (downgrade) {
        expect(result).toMatchObject({ status: 403, body: { data: null, error: { code: 'AUTHZ_EXECUTION_REVOKED' } } })
        expect(controlledTransport.provider).not.toHaveBeenCalled()
      } else {
        expect(result.status, JSON.stringify(result.body)).toBe(200)
        expect(result.body.error).toBeNull()
        expect(result.body.data?.result?.rendering).toMatchObject({ status: 'queued', providerJobId: 'controlled-video-job' })
        expect(controlledTransport.provider).toHaveBeenCalledOnce()
      }
      expect(await authorizationRepository.getAuthorizationRevision(account.identityId)).toBe(revision)
    } finally {
      waiting.resolve()
      await response
      controlledTransport.entered = undefined
      controlledTransport.waiting = Promise.resolve()
      api.setPasswordAuthRepositoryForTests()
      api.setAuthorizationRepositoryForTests()
      api.setRuleRepositoryForTests()
    }
  })
})
