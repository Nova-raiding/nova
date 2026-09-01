import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const videoProvider = vi.hoisted(() => ({
  generate: vi.fn(async () => ({ status: 'queued' as const, providerJobId: 'video-provider-must-not-run' })),
  getStatus: vi.fn(),
}))

const pricingQuote = vi.hoisted(() => vi.fn(async () => ({
  costCny: 544.265625,
  metadata: {
    pricing_version: 'video-cost-preflight-e2e',
    pricing_group: 'VIP',
  },
})))

vi.mock('../../../packages/ai/src/video-generator.js', () => ({
  createVideoGeneratorFromEnv: () => videoProvider,
  videoDurationSeconds: () => 5,
}))

vi.mock('../../../packages/ai/src/relay-pricing.js', () => ({
  createRelayPricingClientFromEnv: () => ({ quote: pricingQuote }),
}))

type Envelope<T = unknown> = {
  data: { result: T } | null
  error: { code: string; details?: Record<string, unknown> } | null
}

type ApiModule = typeof import('./server.js')

let api: ApiModule
let baseUrl = ''

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
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'video-cost-preflight-session-secret')
  vi.stubEnv('MODEL_RELAY_BASE_URL', 'https://relay.example.test')
  vi.stubEnv('MODEL_RELAY_ALLOWED_HOSTS', 'relay.example.test')
  vi.stubEnv('VIDEO_MODEL_RELAY_API_KEY', 'video-cost-preflight-key')
  vi.stubEnv('VIDEO_MODEL', 'agnes-video-v2.0')
  vi.stubEnv('VIDEO_DURATION_SECONDS', '5')
  vi.stubEnv('MODEL_RPM_LIMIT', '100')
  vi.stubEnv('MODEL_TPM_LIMIT', '100000')
  vi.stubEnv('MODEL_DAILY_CNY_LIMIT', '1000')
  vi.stubEnv('MODEL_MAX_TASK_COST_CNY', '10')
  vi.stubEnv('MODEL_RELAY_VIDEO_COST_EVIDENCE', 'true')
  api = await import('./server.js')
  baseUrl = await startServer()
})

afterAll(async () => {
  if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
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

    const recharge = resultOf<any>(await callMcp<any>(token, workspaceId, 'billing.recharge.create', {
      channel: 'wechat',
      amount_cny: '20.00',
      idempotency_key: `video-cost-recharge-${suffix}`,
    }))
    resultOf(await callMcp(token, workspaceId, 'billing.recharge.get', { order_id: recharge.id, confirm_test_payment: 'true' }))
    const before = resultOf<any>(await callMcp<any>(token, workspaceId, 'billing.status', {}))

    vi.stubEnv('NODE_ENV', 'production')
    const requestParams = {
      prompt: '根据已确认商品事实生成五秒通勤场景视频',
      output: 'rendering',
      idempotency_key: `video-cost-render-${suffix}`,
      context_json: JSON.stringify({
        brand: { id: 'brand-video-cost', version: '1' },
        product: { id: product.id, version: String(product.version) },
        rules: [{ id: 'rule-video-cost', version: '1' }],
      }),
    }

    const missingIdempotency = await callMcp(token, workspaceId, 'multimodal.video.request', { ...requestParams, idempotency_key: undefined })
    const first = await callMcp(token, workspaceId, 'multimodal.video.request', requestParams)
    const retry = await callMcp(token, workspaceId, 'multimodal.video.request', requestParams)
    const after = resultOf<any>(await callMcp<any>(token, workspaceId, 'billing.status', {}))

    expect(missingIdempotency.status).toBe(400)
    expect(missingIdempotency.body.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
    expect(first.status).toBe(422)
    expect(first.body.error).toMatchObject({
      code: 'MODEL_TASK_COST_LIMIT_EXCEEDED',
      details: { estimated_cost_cny: 544.265625, maximum_task_cost_cny: 10 },
    })
    expect(retry.status).toBe(first.status)
    expect(retry.body.error).toEqual(first.body.error)
    expect(pricingQuote).toHaveBeenCalledTimes(2)
    expect(videoProvider.generate).not.toHaveBeenCalled()
    expect(after.balance_cny).toBe(before.balance_cny)
    expect(after.action_entitlement).toEqual(before.action_entitlement)
  })
})
