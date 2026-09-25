import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type Api = typeof import('./server.js')
type Envelope = { data: unknown; error: { code: string; details?: Record<string, unknown> } | null }

const workspaceId = `ws_rest_protocol_${crypto.randomUUID().replaceAll('-', '')}`
const actorId = `rest_protocol_owner_${crypto.randomUUID()}`
const token = `rest_protocol_token_${crypto.randomUUID()}`
let api: Api
let persistence: Awaited<Api['persistenceReady']>
let base = ''

async function merchantPost(taskId: string, route: 'content' | 'content-jobs', key: string) {
  const response = await fetch(`${base}/v1/tasks/${taskId}/${route}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-workspace-id': workspaceId,
      'x-test-commercial-fixture': 'server-e2e',
      'x-test-workspace-fixture': 'server-e2e',
      'idempotency-key': key,
    },
    body: '{}',
  })
  return { status: response.status, body: await response.json() as Envelope }
}

function fixtureTask() {
  const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: crypto.randomUUID(), credentialRef: `fixture://${workspaceId}/taobao` })
  const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: 'REST fail-closed 回归商品', category: '服饰', stock: 2 })
  api.service.confirmProductFacts(workspaceId, product.id)
  const task = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
  api.service.selectDirection(task.id, 'A')
  api.service.confirmProductionPlan(workspaceId, task.id, actorId)
  return task
}

describe('production charged REST generation protocol gate', () => {
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'rest-generation-protocol-regression-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['workspace_owner', 'rules_admin'] } }))
    api = await import('./server.js')
    persistence = await api.persistenceReady
    api.enableCommercialFixtureHarnessForTests()
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'workspace_owner', status: 'active', invitedBy: 'rest-generation-protocol-regression' })
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    await new Promise<void>((resolve, reject) => {
      api.server.once('error', reject)
      api.server.listen(0, '127.0.0.1', () => {
        api.server.removeListener('error', reject)
        resolve()
      })
    })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('REST protocol fixture did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it.each(['content', 'content-jobs'] as const)('%s fails before knowledge hydration, reservation, queueing, or provider dispatch', async route => {
    const task = fixtureTask()
    const key = `rest_protocol_${route}_${crypto.randomUUID()}`
    const reserve = vi.spyOn(persistence.creativePoints!, 'reserve')
    const hydrate = vi.spyOn(api.service, 'setDurableKnowledgeDocuments')
    const prepare = vi.spyOn(api.service, 'prepareGenerationContext')
    const enqueue = vi.spyOn(api.service, 'enqueueGeneration')
    const generate = vi.spyOn(api.service, 'generateDraft')
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const response = await merchantPost(task.id, route, key)
      expect(response).toMatchObject({
        status: 503,
        body: { error: { code: 'CREATIVE_ACTION_PROTOCOL_UNAVAILABLE', details: {
          route,
          access_classification: 'POINT_CHARGED',
          retryable: false,
          automatic_retry_allowed: false,
          point_reservation_created: false,
          provider_dispatched: false,
        } } },
      })
      expect(reserve).not.toHaveBeenCalled()
      expect(hydrate).not.toHaveBeenCalled()
      expect(prepare).not.toHaveBeenCalled()
      expect(enqueue).not.toHaveBeenCalled()
      expect(generate).not.toHaveBeenCalled()
    } finally {
      vi.stubEnv('NODE_ENV', 'test')
      reserve.mockRestore()
      hydrate.mockRestore()
      prepare.mockRestore()
      enqueue.mockRestore()
      generate.mockRestore()
    }
  })
})
