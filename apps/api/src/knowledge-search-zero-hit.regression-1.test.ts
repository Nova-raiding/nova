import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Regression: ISSUE-003 — a ready owned product document can be excluded by
// platform/account/store search filters, leaving zero hits. Generation must
// not silently freeze an empty knowledge context.
// Found by /qa on 2026-09-15.
// Report: .gstack/qa-reports/qa-report-store-nova-2026-09-15.md

type Api = typeof import('./server.js')
type Envelope = { data: unknown; error: { code: string; details?: Record<string, unknown> } | null }
const workspaceId = `ws_knowledge_zero_hit_${crypto.randomUUID().replaceAll('-', '')}`
const actor = 'knowledge_zero_hit_owner'
const token = `disposable_knowledge_zero_hit_${crypto.randomUUID()}`
const surfaces = ['mcp', 'content', 'content-jobs'] as const
let api: Api
let persistence: Awaited<Api['persistenceReady']>
let base: string

async function mcp(method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { workspace_id: workspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as Envelope }
}

async function generate(surface: typeof surfaces[number], taskId: string) {
  if (surface === 'mcp') return mcp('content.generate', { task_id: taskId })
  const response = await fetch(`${base}/v1/tasks/${encodeURIComponent(taskId)}/${surface}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'idempotency-key': crypto.randomUUID() }, body: '{}',
  })
  return { status: response.status, body: await response.json() as Envelope }
}

function fixtureTask() {
  const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: crypto.randomUUID(), credentialRef: `fixture://${workspaceId}/taobao` })
  const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '检索零命中商品', category: '女装外套', stock: 8 })
  api.service.confirmProductFacts(workspaceId, product.id)
  const task = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
  api.service.selectDirection(task.id, 'A')
  api.service.confirmProductionPlan(workspaceId, task.id, actor)
  return { task, product }
}

async function effects(taskId: string) {
  const { updatedAt: _probeTime, ...points } = await persistence.creativePoints!.getBalance(workspaceId)
  return {
    points, statement: await persistence.creativePoints!.listStatement(workspaceId),
    ledger: await persistence.actionLedger!.list(workspaceId), usage: await persistence.usage!.get(workspaceId),
    context: await persistence.contextSnapshots!.getByTask({ workspaceId, taskId }),
    jobs: structuredClone([...api.service.generationJobs]), content: structuredClone([...api.service.contentVersions]),
    snapshots: structuredClone([...api.service.taskInputSnapshots]), task: structuredClone(api.service.getTask(taskId)),
  }
}

describe('ready knowledge with zero retrieval hits at real HTTP/MCP boundaries', () => {
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
    vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'disposable-knowledge-zero-hit-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actor, roles: ['workspace_owner', 'rules_admin'] } }))
    api = await import('./server.js')
    persistence = await api.persistenceReady
    expect(persistence.mode).toBe('memory')
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: actor, displayName: actor, role: 'workspace_owner', status: 'active', invitedBy: 'isolated-zero-hit-regression' })
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('loopback server did not bind')
    base = `http://127.0.0.1:${address.port}`
    expect((await mcp('billing.status')).status).toBe(200)
  })
  afterAll(async () => {
    vi.restoreAllMocks()
    if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  for (const surface of surfaces) {
    it(`${surface} rejects zero search hits despite ready owned knowledge, without business effects`, async () => {
      const { task, product } = fixtureTask()
      const repository = persistence.knowledge!
      const ready = await repository.createDocument({ workspaceId, productId: product.id, knowledgeType: 'product_facts', title: '已就绪知识', extractedText: '商品的真实知识文本', contentHash: crypto.randomUUID(), approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
      expect((await repository.listDocuments(workspaceId, { productId: product.id })).map(document => document.id)).toContain(ready.id)
      const realSearch = repository.search.bind(repository)
      const search = vi.spyOn(repository, 'search').mockImplementation(async input => input.workspaceId === workspaceId && input.productId === product.id ? [] : realSearch(input))
      const setter = vi.spyOn(api.service, 'setDurableKnowledgeDocuments')
      const reserve = vi.spyOn(persistence.creativePoints!, 'reserve')
      const ledger = vi.spyOn(persistence.actionLedger!, 'record')
      const context = vi.spyOn(persistence.contextSnapshots!, 'save')
      const enqueue = vi.spyOn(api.service, 'enqueueGeneration')
      const model = vi.spyOn(api.service, 'generateDraft')
      const before = await effects(task.id)
      try {
        const result = await generate(surface, task.id)
        expect(result.status, JSON.stringify(result.body)).toBe(409)
        expect(result.body.error?.code).toBe('KNOWLEDGE_CONTEXT_UNAVAILABLE')
        expect(search).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, productId: product.id, platform: product.platform }))
        expect(await effects(task.id)).toEqual(before)
        for (const spy of [setter, reserve, ledger, context, enqueue, model]) expect(spy).not.toHaveBeenCalled()
      } finally {
        for (const spy of [search, setter, reserve, ledger, context, enqueue, model]) spy.mockRestore()
      }
    })
  }

  it('preserves old generation for a product with no live knowledge documents', async () => {
    const { task } = fixtureTask()
    const result = await generate('mcp', task.id)
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(400)
    expect(result.body.error?.code ?? '').not.toMatch(/^KNOWLEDGE_/u)
  })
})
