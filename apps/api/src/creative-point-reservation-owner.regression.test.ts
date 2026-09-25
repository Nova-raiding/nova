import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type Envelope = {
  error: { code: string; details?: Record<string, unknown> } | null
  data: { result?: unknown } | null
}

let api: typeof import('./server.js')
let base = ''

async function callContentGenerate(token: string, workspaceId: string, taskId: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-workspace-id': workspaceId,
      'x-test-commercial-fixture': 'server-e2e',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'content.generate',
      params: { workspace_id: workspaceId, task_id: taskId, idempotency_key: 'shared-action-owner-race' },
    }),
  })
  return { status: response.status, body: await response.json() as Envelope }
}

describe('creative point reservation request ownership', () => {
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'creative-point-owner-regression-secret')
    api = await import('./server.js')
  })

  afterAll(async () => {
    if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('rejects an active reservation replay before generation and lets its creator release on pre-provider failure', async () => {
    const suffix = crypto.randomUUID()
    const workspaceId = `ws_creative_owner_${suffix}`
    const actorId = `creative-owner-${suffix}`
    const token = `creative-owner-token-${suffix}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['workspace_owner', 'rules_admin'] },
    }))

    await api.workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'workspace_owner', status: 'active', invitedBy: 'creative-point-owner-regression' })
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `store-${suffix}`, credentialRef: `fixture://${workspaceId}/taobao` })
    const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '预留所有权回归商品', category: '服饰', stock: 2 })
    api.service.confirmProductFacts(workspaceId, product.id)
    const task = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    api.service.selectDirection(task.id, 'A')
    api.service.confirmProductionPlan(workspaceId, task.id, actorId)

    await new Promise<void>((resolve, reject) => {
      api.server.once('error', reject)
      api.server.listen(0, '127.0.0.1', () => {
        api.server.removeListener('error', reject)
        resolve()
      })
    })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('API did not bind')
    base = `http://127.0.0.1:${address.port}`

    let announceGeneration!: () => void
    let rejectGeneration!: (error: Error) => void
    const generationEntered = new Promise<void>(resolve => { announceGeneration = resolve })
    const generationGate = new Promise<Awaited<ReturnType<typeof api.service.generateDraft>>>((_, reject) => { rejectGeneration = reject })
    const generate = vi.spyOn(api.service, 'generateDraft').mockImplementation(async () => {
      announceGeneration()
      return await generationGate
    })
    const actionKey = `model:content.generate:${task.id}`

    try {
      const ownerRequest = callContentGenerate(token, workspaceId, task.id)
      await generationEntered

      const replayRequest = await callContentGenerate(token, workspaceId, task.id)
      expect(replayRequest.status).toBe(409)
      expect(replayRequest.body.error).toMatchObject({
        code: 'CREATIVE_ACTION_BUSY',
        details: { action_key: actionKey, provider_dispatched: false, retryable: false },
      })
      expect(generate).toHaveBeenCalledTimes(1)
      expect(await api.creativePointsForTests.getReservationByActionKey(workspaceId, actionKey)).toMatchObject({ status: 'active' })

      rejectGeneration(new Error('known failure before provider dispatch'))
      const ownerResponse = await ownerRequest
      expect(ownerResponse.status).toBeGreaterThanOrEqual(400)
      expect(generate).toHaveBeenCalledTimes(1)
      expect(await api.creativePointsForTests.getReservationByActionKey(workspaceId, actionKey)).toMatchObject({ status: 'released' })
    } finally {
      generate.mockRestore()
    }
  })
})
