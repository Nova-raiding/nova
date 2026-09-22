import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { trustedPlatformRuleTestRepository } from './platform-rule-test-fixture.js'

const videoProvider = vi.hoisted(() => ({
  generate: vi.fn(async () => ({ status: 'queued' as const, providerJobId: 'video-provider-job-1' })),
  getStatus: vi.fn(),
}))

// Only the provider adapter is replaced. The pricing client below is the real
// one, so the preflight's pricing boundary is exercised end to end instead of
// being satisfied by a stubbed quote.
vi.mock('../../../packages/ai/src/video-generator.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../packages/ai/src/video-generator.js')>(),
  createVideoGeneratorFromEnv: () => videoProvider,
}))

type Envelope<T = unknown> = {
  data: { result: T } | null
  error: { code: string; details?: Record<string, unknown> } | null
}

type ApiModule = typeof import('./server.js')

let api: ApiModule
let baseUrl = ''
let pricingSnapshotRequests = 0

const realFetch = globalThis.fetch
const pricingSnapshot = {
  pricing_version: 'video-cost-preflight-e2e-v1',
  group_ratio: { VIP: 1 },
  data: [{ model_name: 'agnes-video-v2.0', quota_type: 1, model_ratio: 37.5, model_price: 0, completion_ratio: 1, enable_groups: ['VIP'] }],
}

/** Serve the relay snapshot the real RelayPricingClient reads, and leave every
 * other request (including the test's own MCP calls) on the real fetch. */
const snapshotFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  if (url.startsWith('https://relay.example.test/api/pricing')) {
    pricingSnapshotRequests += 1
    return new Response(JSON.stringify(pricingSnapshot))
  }
  if (url.startsWith('https://relay.example.test/api/status')) {
    return new Response(JSON.stringify({ data: { quota_per_unit: 500_000, usd_exchange_rate: 6.83, quota_display_type: 'CNY' } }))
  }
  return realFetch(input, init)
}

async function startServer() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    api.server.once('error', onError)
    api.server.listen(0, '127.0.0.1', () => {
      api.server.removeListener('error', onError)
      resolve()
    })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function callMcp<T>(token: string, workspaceId: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-workspace-id': workspaceId,
      'x-test-commercial-fixture': 'server-e2e',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { workspace_id: workspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as Envelope<T> }
}

function resultOf<T>(response: Awaited<ReturnType<typeof callMcp<T>>>) {
  expect(response.status).toBe(200)
  expect(response.body.error).toBeNull()
  expect(response.body.data).not.toBeNull()
  return response.body.data!.result
}

beforeAll(async () => {
  vi.stubEnv('NODE_ENV', 'test')
  vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
  vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'video-cost-preflight-session-secret')
  vi.stubEnv('MODEL_RELAY_BASE_URL', 'https://relay.example.test')
  vi.stubEnv('MODEL_RELAY_ALLOWED_HOSTS', 'relay.example.test')
  vi.stubEnv('MODEL_RELAY_PRICING_DERIVATION_ENABLED', 'true')
  vi.stubEnv('MODEL_RELAY_API_KEY', 'video-cost-preflight-relay-key')
  vi.stubEnv('MODEL_RELAY_PRICING_GROUP', 'VIP')
  // The relay publishes CNY-per-second billing for this model; the preflight
  // estimate is therefore exactly 2 CNY per requested second.
  vi.stubEnv('MODEL_RELAY_VIDEO_PRICING_OVERRIDES', JSON.stringify({ 'agnes-video-v2.0': 2 }))
  vi.stubEnv('VIDEO_MODEL_RELAY_API_KEY', 'video-cost-preflight-key')
  vi.stubEnv('VIDEO_MODEL', 'agnes-video-v2.0')
  vi.stubEnv('VIDEO_DURATION_SECONDS', '3')
  vi.stubEnv('MODEL_RPM_LIMIT', '100')
  vi.stubEnv('MODEL_TPM_LIMIT', '100000')
  vi.stubEnv('MODEL_DAILY_CNY_LIMIT', '1000')
  vi.stubEnv('MODEL_MAX_TASK_COST_CNY', '10')
  vi.stubEnv('MODEL_VIDEO_MAX_REQUEST_CNY', '10')
  vi.stubEnv('MODEL_COST_ESTIMATE_VERSION', 'video-cost-preflight-e2e-v1')
  vi.stubEnv('MODEL_RELAY_VIDEO_COST_EVIDENCE', 'true')
  vi.stubGlobal('fetch', snapshotFetch)
  api = await import('./server.js')
  baseUrl = await startServer()
})

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
  api?.setRuleRepositoryForTests(undefined)
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('video cost preflight over the real HTTP boundary', () => {
  it('blocks an over-limit quote before provider, wallet, or quota side effects and stays safe on retry', async () => {
    const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
    const workspaceId = `ws_video_cost_${suffix}`
    const actorId = `video-cost-owner-${suffix}`
    const token = `video-cost-token-${suffix}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['workspace_owner'] },
    }))
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'workspace_owner', status: 'active', invitedBy: 'video-cost-preflight-e2e' })

    const account = api.service.registerPlatformAccount({
      workspaceId,
      platform: 'taobao',
      remoteAccountId: `video-cost-store-${suffix}`,
      credentialRef: `fixture://${workspaceId}/taobao`,
    })
    const product = api.service.importProduct({
      workspaceId,
      platform: 'taobao',
      accountId: account.id,
      localProductKey: `video-cost-product-${suffix}`,
      title: '视频成本门禁测试商品',
      stock: 1,
    })
    api.service.confirmProductFacts(workspaceId, product.id)
    api.setRuleRepositoryForTests(await trustedPlatformRuleTestRepository(workspaceId, 'taobao'))
    vi.stubEnv('PLATFORM_RULE_SYNC_MANIFEST_URL', 'https://rules.example.com/platform-rule-manifest.json')
    vi.stubEnv('PLATFORM_RULE_SYNC_SIGNING_SECRET', 'video-cost-preflight-signing-secret')
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)

    const recharge = resultOf<any>(await callMcp<any>(token, workspaceId, 'billing.recharge.create', {
      channel: 'alipay',
      amount_cny: '20.00',
      idempotency_key: `video-cost-recharge-${suffix}`,
    }))
    resultOf(await callMcp(token, workspaceId, 'billing.recharge.get', { order_id: recharge.id, confirm_test_payment: 'true' }))
    const before = resultOf<any>(await callMcp<any>(token, workspaceId, 'billing.status', {}))

    vi.stubEnv('NODE_ENV', 'production')
    const contextJson = JSON.stringify({
      brand: { id: 'brand-video-cost', version: '1' },
      product: { id: product.id, version: String(product.version) },
      rules: [{ id: 'rule-video-cost', version: '1' }],
    })
    const requestParams = (durationSeconds: string, idempotencyKey: string) => {
      return {
        prompt: '根据已确认商品事实生成通勤场景视频',
        output: 'rendering',
        idempotency_key: idempotencyKey,
        context_json: contextJson,
      }
    }

    const missingIdempotency = await callMcp(token, workspaceId, 'multimodal.video.request', { ...requestParams('3', `video-cost-render-missing-${suffix}`), idempotency_key: undefined })
    // 15 requested seconds at the relay's published 2 CNY/second is 30 CNY,
    // above the 10 CNY per-task ceiling: the preflight must refuse it.
    vi.stubEnv('VIDEO_DURATION_SECONDS', '15')
    const first = await callMcp(token, workspaceId, 'multimodal.video.request', requestParams('15', `video-cost-render-over-${suffix}`))
    const retry = await callMcp(token, workspaceId, 'multimodal.video.request', requestParams('15', `video-cost-render-over-${suffix}`))
    const after = resultOf<any>(await callMcp<any>(token, workspaceId, 'billing.status', {}))

    expect(missingIdempotency.status).toBe(400)
    expect(missingIdempotency.body.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
    expect(first.status).toBe(422)
    expect(first.body.error).toMatchObject({
      code: 'MODEL_TASK_COST_LIMIT_EXCEEDED',
      details: { estimated_cost_cny: 30, maximum_task_cost_cny: 10 },
    })
    expect(retry.status).toBe(first.status)
    expect(retry.body.error).toEqual(first.body.error)
    expect(videoProvider.generate).not.toHaveBeenCalled()
    expect(after.balance_cny).toBe(before.balance_cny)
    expect(after.action_entitlement).toEqual(before.action_entitlement)
    // The three-second request stays inside the same ceiling, so the very same
    // real pricing snapshot must release it to the provider. Before the fix
    // every request failed here with MODEL_VIDEO_COST_PREFLIGHT_FAILED.
    vi.stubEnv('VIDEO_DURATION_SECONDS', '3')
    const allowed = await callMcp<any>(token, workspaceId, 'multimodal.video.request', requestParams('3', `video-cost-render-under-${suffix}`))
    expect(allowed.status).toBe(200)
    expect(allowed.body.error).toBeNull()
    expect(allowed.body.data?.result).toMatchObject({ rendering: { status: 'queued', providerJobId: 'video-provider-job-1' } })
    expect(videoProvider.generate).toHaveBeenCalledTimes(1)
    // Live pricing, not a stub: the snapshot was really fetched and cached.
    expect(pricingSnapshotRequests).toBe(1)
  })
})


it('rejects fabricated and cross-workspace candidate video sources before calling the relay', async () => {
  vi.stubEnv('NODE_ENV', 'test')
  const workspaceId = `ws_video_candidate_${Date.now()}`
  const token = `candidate-token-${Date.now()}`
  const actorId = 'candidate-video-owner'
  vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['workspace_owner'] } }))
  await api.workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'workspace_owner', status: 'active', invitedBy: 'test' })
  const product = api.service.importProduct({ workspaceId: `${workspaceId}_other`, platform: 'jd', localProductKey: 'foreign-video', title: '其他工作区商品', stock: 1 })
  const before = videoProvider.generate.mock.calls.length
  for (const productId of ['missing-product', product.id]) {
    const response = await callMcp(token, workspaceId, 'multimodal.video.request', { output: 'rendering', prompt: '展示商品', context_json: JSON.stringify({ candidateOnly: true, brand: null, product: { id: productId, version: '1' }, rules: [] }), idempotency_key: `candidate-${productId}` })
    expect(response.body.error?.code).toBe('VIDEO_CANDIDATE_SOURCE_REQUIRED')
  }
  expect(videoProvider.generate.mock.calls.length).toBe(before)
})
