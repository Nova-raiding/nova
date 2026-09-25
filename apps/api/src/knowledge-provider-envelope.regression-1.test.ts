import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Regression: ISSUE-004 — approved product knowledge reached the frozen task snapshot but vanished from the generation envelope.
// Found by /qa on 2026-09-15
// Report: .gstack/qa-reports/qa-report-store-nova-2026-09-15.md

type Api = typeof import('./server.js')
type Envelope = { data: any; error: { code: string; message: string } | null }
let api: Api
let persistence: Awaited<Api['persistenceReady']>
let base: string
const workspaceId = `ws_provider_knowledge_${crypto.randomUUID().replaceAll('-', '')}`
const token = 'disposable-provider-envelope-token'
const actor = 'provider_knowledge_owner'

async function generate(surface: 'mcp' | 'content-jobs', taskId: string) {
  const response = surface === 'mcp'
    ? await fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'content.generate', params: { workspace_id: workspaceId, task_id: taskId } }),
    })
    : await fetch(`${base}/v1/tasks/${encodeURIComponent(taskId)}/content-jobs`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'idempotency-key': crypto.randomUUID() },
      body: '{}',
    })
  return { status: response.status, body: await response.json() as Envelope }
}

function fixtureTask() {
  const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: crypto.randomUUID(), credentialRef: `fixture://${workspaceId}/taobao` })
  const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '知识信封回归商品', category: '女装外套', stock: 8 })
  api.service.confirmProductFacts(workspaceId, product.id)
  const task = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
  api.service.selectDirection(task.id, 'A')
  api.service.confirmProductionPlan(workspaceId, task.id, actor)
  return { task, product }
}

describe('approved durable knowledge in real HTTP/MCP generation envelopes', () => {
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
    vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'disposable-provider-knowledge-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actor, roles: ['workspace_owner', 'rules_admin'] } }))
    api = await import('./server.js')
    persistence = await api.persistenceReady
    expect(persistence.mode).toBe('memory')
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: actor, displayName: actor, role: 'workspace_owner', status: 'active', invitedBy: 'isolated-regression' })
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('API fixture did not bind')
    base = `http://127.0.0.1:${address.port}`
  })
  afterAll(async () => {
    vi.restoreAllMocks()
    if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  for (const surface of ['mcp', 'content-jobs'] as const) {
    it(`${surface} persists the complete retrieved document in the event-source envelope`, async () => {
      const { task, product } = fixtureTask()
      const document = await persistence.knowledge!.createDocument({ workspaceId, productId: product.id, knowledgeType: 'product_facts', title: '羽绒服材质说明', extractedText: '面料为聚酯纤维，填充物为白鸭绒。', contentHash: crypto.randomUUID(), approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
      const response = await generate(surface, task.id)
      expect(response.status, JSON.stringify(response.body)).toBeLessThan(400)
      const frozen = api.service.getTask(task.id).inputSnapshot?.knowledgeContext?.documents ?? []
      expect(frozen).toContainEqual(expect.objectContaining({ id: document.id, revision: document.revision, content: document.extractedText }))
      const context = await persistence.contextSnapshots!.getByTask({ workspaceId, taskId: task.id })
      expect(context).toBeDefined()
      expect((context!.envelope.knowledgeContext as { documents?: unknown[] }).documents).toEqual([
        { id: document.id, title: document.title, content: document.extractedText, revision: document.revision },
      ])
    })
  }

  it('rejects an oversized approved document before any paid generation side effect', async () => {
    const { task, product } = fixtureTask()
    // Under the upstream 8,000-character document gate, but still over the
    // provider's 4,000-token input budget. This probes the budget gate itself.
    await persistence.knowledge!.createDocument({ workspaceId, productId: product.id, knowledgeType: 'product_facts', title: '预算超限已确认资料', extractedText: '已确认事实'.repeat(1_200), contentHash: crypto.randomUUID(), approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
    const balanceBefore = await persistence.creativePoints!.getBalance(workspaceId)
    const ledgerBefore = await persistence.actionLedger!.list(workspaceId)
    const jobsBefore = api.service.generationJobs.size
    const response = await generate('content-jobs', task.id)
    expect(response.status, JSON.stringify(response.body)).toBe(413)
    expect(response.body.error?.code).toBe('CONTEXT_BUDGET_EXCEEDED')
    expect(await persistence.creativePoints!.getBalance(workspaceId)).toMatchObject({ availablePoints: balanceBefore.availablePoints, reservedPoints: balanceBefore.reservedPoints, settledPoints: balanceBefore.settledPoints })
    expect(await persistence.actionLedger!.list(workspaceId)).toEqual(ledgerBefore)
    expect(api.service.generationJobs.size).toBe(jobsBefore)
    expect(await persistence.contextSnapshots!.getByTask({ workspaceId, taskId: task.id })).toBeUndefined()
  })
})
