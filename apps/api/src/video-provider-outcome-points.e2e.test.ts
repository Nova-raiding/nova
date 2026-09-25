import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { trustedPlatformRuleTestRepository } from './platform-rule-test-fixture.js'

const videoProvider = vi.hoisted(() => ({
  generate: vi.fn(async (): Promise<never> => { throw Object.assign(new Error('provider response outcome unknown'), { code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerOutcome: 'unknown' }) }),
  getStatus: vi.fn(),
}))

vi.mock('../../../packages/ai/src/video-generator.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../packages/ai/src/video-generator.js')>(),
  createVideoGeneratorFromEnv: () => videoProvider,
}))

type Api = typeof import('./server.js')
let api: Api
let baseUrl = ''
const actualFetch = globalThis.fetch

async function callMcp(token: string, workspaceId: string, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-test-commercial-fixture': 'server-e2e' },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { workspace_id: workspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as { data?: { result?: Record<string, unknown> }; error?: { code?: string } } }
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
  vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'video-outcome-points-session-secret')
  vi.stubEnv('MODEL_RELAY_BASE_URL', 'https://relay.example.test')
  vi.stubEnv('MODEL_RELAY_ALLOWED_HOSTS', 'relay.example.test')
  vi.stubEnv('MODEL_RELAY_PRICING_DERIVATION_ENABLED', 'true')
  vi.stubEnv('MODEL_RELAY_API_KEY', 'video-outcome-points-relay-key')
  vi.stubEnv('MODEL_RELAY_PRICING_GROUP', 'VIP')
  vi.stubEnv('MODEL_RELAY_VIDEO_PRICING_OVERRIDES', JSON.stringify({ 'video-test-model': 0.25 }))
  vi.stubEnv('VIDEO_MODEL_RELAY_API_KEY', 'video-outcome-points-video-key')
  vi.stubEnv('VIDEO_MODEL', 'video-test-model')
  vi.stubEnv('VIDEO_DURATION_SECONDS', '5')
  vi.stubEnv('MODEL_RPM_LIMIT', '100')
  vi.stubEnv('MODEL_TPM_LIMIT', '100000')
  vi.stubEnv('MODEL_DAILY_CNY_LIMIT', '1000')
  vi.stubEnv('MODEL_MAX_TASK_COST_CNY', '20')
  vi.stubEnv('MODEL_VIDEO_MAX_REQUEST_CNY', '20')
  vi.stubEnv('MODEL_COST_ESTIMATE_VERSION', 'video-outcome-points-v1')
  vi.stubEnv('MODEL_RELAY_VIDEO_COST_EVIDENCE', 'true')
  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.startsWith('https://relay.example.test/api/pricing')) return new Response(JSON.stringify({ pricing_version: 'video-outcome-points-v1', group_ratio: { VIP: 1 }, data: [{ model_name: 'video-test-model', quota_type: 1, model_ratio: 37.5, model_price: 0, completion_ratio: 1, enable_groups: ['VIP'] }] }))
    if (url.startsWith('https://relay.example.test/api/status')) return new Response(JSON.stringify({ data: { quota_per_unit: 500_000, usd_exchange_rate: 6.83, quota_display_type: 'CNY' } }))
    return actualFetch(input, init)
  }) as typeof fetch)
  api = await import('./server.js')
  await new Promise<void>((resolve, reject) => { api.server.once('error', reject); api.server.listen(0, '127.0.0.1', () => resolve()) })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  api?.setRuleRepositoryForTests(undefined)
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('video provider outcome point reservation over MCP', () => {
  it('keeps one reserved point when the provider outcome is unknown', async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    const workspaceId = `ws_video_unknown_${suffix}`
    const token = `video-unknown-token-${suffix}`
    const actorId = `video-owner-${suffix}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['workspace_owner'] } }))
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'workspace_owner', status: 'active', invitedBy: 'video-outcome-points-e2e' })
    const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `video-store-${suffix}`, credentialRef: `fixture://${workspaceId}/taobao` })
    const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, localProductKey: `video-product-${suffix}`, title: '视频预留测试商品', stock: 1 })
    api.service.confirmProductFacts(workspaceId, product.id)
    api.setRuleRepositoryForTests(await trustedPlatformRuleTestRepository(workspaceId, 'taobao'))
    vi.stubEnv('PLATFORM_RULE_SYNC_MANIFEST_URL', 'https://rules.example.com/platform-rule-manifest.json')
    vi.stubEnv('PLATFORM_RULE_SYNC_SIGNING_SECRET', 'video-outcome-points-signing-secret')
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    const recharge = await callMcp(token, workspaceId, 'billing.recharge.create', { channel: 'alipay', amount_cny: '20.00', idempotency_key: `video-recharge-${suffix}` })
    expect(recharge.status).toBe(200)
    const orderId = recharge.body.data?.result?.id
    expect(typeof orderId).toBe('string')
    expect((await callMcp(token, workspaceId, 'billing.recharge.get', { order_id: orderId, confirm_test_payment: 'true' })).status).toBe(200)
    const before = await callMcp(token, workspaceId, 'creative-points.balance.get')
    expect(before.status).toBe(200)
    const beforeBalance = before.body.data?.result
    vi.stubEnv('NODE_ENV', 'production')
    const request = await callMcp(token, workspaceId, 'multimodal.video.request', {
      prompt: '根据已确认商品事实生成通勤场景视频', output: 'rendering', idempotency_key: `video-unknown-${suffix}`,
      context_json: JSON.stringify({ brand: { id: 'brand-video-unknown', version: '1' }, product: { id: product.id, version: String(product.version) }, rules: [{ id: 'rule-video-unknown', version: '1' }] }),
    })
    const after = await callMcp(token, workspaceId, 'creative-points.balance.get')
    expect(videoProvider.generate).toHaveBeenCalledTimes(1)
    expect(request.body.error?.code).toBe('MODEL_PROVIDER_OUTCOME_UNKNOWN')
    expect(after.status).toBe(200)
    expect(after.body.data?.result?.available_points).toBe(Number(beforeBalance?.available_points) - 1)
    expect(after.body.data?.result?.reserved_points).toBe(Number(beforeBalance?.reserved_points) + 1)
  })
})
