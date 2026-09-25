import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Regression: ISSUE-004 — approved knowledge longer than the generation
// context limit was silently sliced to 8,000 characters, discarding facts.
// Found by /qa on 2026-09-15.
// Report: .gstack/qa-reports/qa-report-store-nova-2026-09-15.md

type Api = typeof import('./server.js')
type Envelope = { data: unknown; error: { code: string; details?: Record<string, unknown> } | null }
const workspaceId = `ws_knowledge_truncation_${crypto.randomUUID().replaceAll('-', '')}`
const actor = 'knowledge_truncation_owner'
const token = `disposable_knowledge_truncation_${crypto.randomUUID()}`
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
  const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '超长知识商品', category: '女装外套', stock: 8 })
  api.service.confirmProductFacts(workspaceId, product.id)
  const task = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
  api.service.selectDirection(task.id, 'A')
  api.service.confirmProductionPlan(workspaceId, task.id, actor)
  return { task, product }
}

async function readyDocument(productId: string, extractedText: string, chunks: readonly string[] = []) {
  const repository = persistence.knowledge!
  const asset = await repository.createAsset({ workspaceId, kind: 'product_facts', name: '完整已审核知识', content: { extractedText }, productId, sourceVersion: 1 })
  const document = await repository.createDocument({ workspaceId, knowledgeAssetId: asset.id, productId, knowledgeType: 'product_facts', title: '完整已审核知识', extractedText, contentHash: crypto.randomUUID(), approvalStatus: 'pending', rightsStatus: 'unknown', indexState: 'queued' })
  if (chunks.length) {
    await repository.replaceChunks(workspaceId, document.id, chunks.map((content, ordinal) => ({ ordinal, content })))
  }
  await repository.updateAsset(workspaceId, asset.id, { approvalStatus: 'approved', rightsStatus: 'cleared' })
  const pending = await repository.listDocuments(workspaceId, { id: document.id })
  const approved = pending[0]!
  return (await repository.transitionQueuedIndexState(workspaceId, document.id, 'ready', { revision: approved.revision, contentHash: approved.contentHash }))!
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

describe('approved knowledge must not be silently truncated at generation HTTP/MCP boundaries', () => {
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
    vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'disposable-knowledge-truncation-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actor, roles: ['workspace_owner', 'rules_admin'] } }))
    api = await import('./server.js')
    persistence = await api.persistenceReady
    expect(persistence.mode).toBe('memory')
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: actor, displayName: actor, role: 'workspace_owner', status: 'active', invitedBy: 'isolated-truncation-regression' })
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
    it(`${surface} rejects >8000 approved chunk characters before freezing or charging`, async () => {
      const { task, product } = fixtureTask()
      const tail = 'TAIL_APPROVED_FACT'
      const chunks = ['A'.repeat(5_000), `${'B'.repeat(3_100)}${tail}`]
      const document = await readyDocument(product.id, 'approved complete source text', chunks)
      expect(chunks.join('\n').length).toBeGreaterThan(8_000)
      expect((await persistence.knowledge!.search({ workspaceId, productId: product.id })).map(result => result.document.id)).toContain(document.id)
      const setter = vi.spyOn(api.service, 'setDurableKnowledgeDocuments')
      const reserve = vi.spyOn(persistence.creativePoints!, 'reserve')
      const ledger = vi.spyOn(persistence.actionLedger!, 'record')
      const context = vi.spyOn(persistence.contextSnapshots!, 'save')
      const enqueue = vi.spyOn(api.service, 'enqueueGeneration')
      const model = vi.spyOn(api.service, 'generateDraft')
      const before = await effects(task.id)
      try {
        const result = await generate(surface, task.id)
        const frozen = api.service.getTask(task.id).inputSnapshot?.knowledgeContext?.documents?.find(item => item.id === document.id)
        expect(result.status, JSON.stringify({ status: result.status, frozen_length: frozen?.content.length, approved_tail_preserved: frozen?.content.endsWith(tail) })).toBe(413)
        expect(result.body.error?.code).toBe('KNOWLEDGE_CONTEXT_TOO_LARGE')
        expect(await effects(task.id)).toEqual(before)
        for (const spy of [setter, reserve, ledger, context, enqueue, model]) expect(spy).not.toHaveBeenCalled()
      } finally {
        for (const spy of [setter, reserve, ledger, context, enqueue, model]) spy.mockRestore()
      }
    })
  }

  it('also rejects an extracted-text fallback longer than the limit', async () => {
    const { task, product } = fixtureTask()
    await readyDocument(product.id, 'C'.repeat(8_001))
    const before = await effects(task.id)
    const result = await generate('mcp', task.id)
    expect(result.status).toBe(413)
    expect(result.body.error?.code).toBe('KNOWLEDGE_CONTEXT_TOO_LARGE')
    expect(await effects(task.id)).toEqual(before)
  })

  it('preserves exactly 8000 approved chunk characters even when model budget rejects generation', async () => {
    const { task, product } = fixtureTask()
    const tail = 'TAIL_APPROVED_FACT'
    const chunks = ['A'.repeat(4_000), `${'B'.repeat(3_999 - tail.length)}${tail}`]
    const document = await readyDocument(product.id, 'approved complete source text', chunks)
    expect(chunks.join('\n').length).toBe(8_000)
    const before = await effects(task.id)
    const result = await generate('mcp', task.id)
    expect(result.status, JSON.stringify(result.body)).toBe(413)
    expect(result.body.error?.code).toBe('CONTEXT_BUDGET_EXCEEDED')
    const frozen = api.service.getTask(task.id).inputSnapshot?.knowledgeContext?.documents?.find(item => item.id === document.id)
    expect(frozen).toMatchObject({ id: document.id, title: document.title, revision: document.revision, content: chunks.join('\n') })
    expect(frozen?.content.endsWith(tail)).toBe(true)
    const after = await effects(task.id)
    expect(after.points.availablePoints).toBe(before.points.availablePoints)
    expect(after.points.reservedPoints).toBe(before.points.reservedPoints)
    expect(after.points.settledPoints).toBe(before.points.settledPoints)
    expect(after.context).toEqual(before.context)
    expect(after.jobs).toEqual(before.jobs)
    expect(after.content).toEqual(before.content)
    expect(after.usage).toEqual(before.usage)
  })

  it('preserves generation when the product has no live imported document', async () => {
    const { task } = fixtureTask()
    const result = await generate('mcp', task.id)
    expect(result.status, JSON.stringify(result.body)).toBeLessThan(400)
  })
})
