import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type Api = typeof import('./server.js')
type Envelope = { data: { result?: unknown } | null; error: { code: string; details?: Record<string, unknown> } | null }

const workspaceId = `ws_knowledge_mcp_conflict_${crypto.randomUUID().replaceAll('-', '')}`
const actor = `knowledge-mcp-conflict-${crypto.randomUUID()}`
const token = `disposable-knowledge-mcp-conflict-${crypto.randomUUID()}`
let api: Api
let persistence: Awaited<Api['persistenceReady']>
let base: string

async function generate(taskId: string) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-workspace-id': workspaceId,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'content.generate',
      params: { workspace_id: workspaceId, task_id: taskId },
    }),
  })
  return { status: response.status, body: await response.json() as Envelope }
}

function fixtureTask() {
  const account = api.service.registerPlatformAccount({
    workspaceId,
    platform: 'taobao',
    remoteAccountId: crypto.randomUUID(),
    credentialRef: `fixture://${workspaceId}/taobao`,
  })
  const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '知识冲突契约商品', category: '女装外套', stock: 8 })
  api.service.confirmProductFacts(workspaceId, product.id)
  const task = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
  api.service.selectDirection(task.id, 'A')
  api.service.confirmProductionPlan(workspaceId, task.id, actor)
  return { task, product }
}

describe('MCP generation contract when approved knowledge changes during admission', () => {
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
    vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'knowledge-mcp-conflict-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [token]: { workspaces: [workspaceId], actor_id: actor, roles: ['workspace_owner', 'rules_admin'] },
    }))
    api = await import('./server.js')
    persistence = await api.persistenceReady
    expect(persistence.mode).toBe('memory')
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: actor, displayName: actor, role: 'workspace_owner', status: 'active', invitedBy: 'knowledge-mcp-conflict-regression' })
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
    if (!address || typeof address === 'string') throw new Error('loopback server did not bind')
    base = `http://127.0.0.1:${address.port}`
    const ready = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'billing.status', params: { workspace_id: workspaceId } }),
    })
    expect(ready.status).toBe(200)
  })

  afterAll(async () => {
    vi.restoreAllMocks()
    if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('returns a conflict without a deliverable result or stale/current knowledge snapshot', async () => {
    const { task, product } = fixtureTask()
    const repository = persistence.knowledge!
    const staleText = 'STALE_APPROVED_FACT_MUST_NOT_ESCAPE'
    const changedText = 'NEW_APPROVED_FACT_MUST_NOT_ESCAPE'
    const asset = await repository.createAsset({
      workspaceId,
      kind: 'product_facts',
      name: '并发变更测试资料',
      content: { facts: [staleText] },
      productId: product.id,
      approvalStatus: 'approved',
      rightsStatus: 'cleared',
    })
    await repository.createDocument({
      workspaceId,
      knowledgeAssetId: asset.id,
      productId: product.id,
      knowledgeType: 'product_facts',
      title: '并发变更测试资料',
      extractedText: staleText,
      contentHash: crypto.randomUUID(),
      approvalStatus: 'approved',
      rightsStatus: 'cleared',
      indexState: 'ready',
    })

    const realSearch = repository.search.bind(repository)
    const search = vi.spyOn(repository, 'search')
    let mutated = false
    search.mockImplementation(async input => {
      const results = await realSearch(input)
      if (!mutated && input.workspaceId === workspaceId && input.productId === product.id) {
        mutated = true
        // Return the search snapshot while adding another approved document
        // before admission performs the required final-state comparison.
        await repository.createDocument({
          workspaceId,
          productId: product.id,
          knowledgeType: 'product_facts',
          title: changedText,
          extractedText: changedText,
          contentHash: crypto.randomUUID(),
          approvalStatus: 'approved',
          rightsStatus: 'cleared',
          indexState: 'ready',
        })
      }
      return results
    })

    const reserve = vi.spyOn(persistence.creativePoints!, 'reserve')
    const ledger = vi.spyOn(persistence.actionLedger!, 'record')
    const context = vi.spyOn(persistence.contextSnapshots!, 'save')
    const enqueue = vi.spyOn(api.service, 'enqueueGeneration')
    const setKnowledge = vi.spyOn(api.service, 'setDurableKnowledgeDocuments')
    const generateDraft = vi.spyOn(api.service, 'generateDraft')
    const taskBefore = structuredClone(api.service.getTask(task.id))
    const balanceBefore = await persistence.creativePoints!.getBalance(workspaceId)
    const ledgerBefore = await persistence.actionLedger!.list(workspaceId)

    try {
      const response = await generate(task.id)
      expect(mutated).toBe(true)
      expect(response.status, JSON.stringify(response.body)).toBe(409)
      expect(response.body.error?.code).toBe('KNOWLEDGE_CONTEXT_CHANGED')
      expect(response.body.data).toBeNull()
      expect(response.body.data?.result).toBeUndefined()
      const serialized = JSON.stringify(response.body)
      expect(serialized).not.toContain(staleText)
      expect(serialized).not.toContain(changedText)

      const taskAfter = api.service.getTask(task.id)
      expect(taskAfter.inputSnapshot?.knowledgeContext?.documents ?? []).toEqual(taskBefore.inputSnapshot?.knowledgeContext?.documents ?? [])
      expect(await persistence.contextSnapshots!.getByTask({ workspaceId, taskId: task.id })).toBeUndefined()
      expect(await persistence.creativePoints!.getBalance(workspaceId)).toMatchObject({
        availablePoints: balanceBefore.availablePoints,
        reservedPoints: balanceBefore.reservedPoints,
        settledPoints: balanceBefore.settledPoints,
      })
      expect(await persistence.actionLedger!.list(workspaceId)).toEqual(ledgerBefore)
      for (const spy of [reserve, ledger, context, enqueue, setKnowledge, generateDraft]) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of [search, reserve, ledger, context, enqueue, setKnowledge, generateDraft]) spy.mockRestore()
    }
  })
})
