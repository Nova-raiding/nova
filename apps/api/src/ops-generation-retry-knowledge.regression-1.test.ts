import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Regression: ISSUE-003 — ops retry bypassed the durable knowledge gate.
// Found by /qa on 2026-09-15
// Report: .gstack/qa-reports/qa-report-store-nova-2026-09-15.md

type Api = typeof import('./server.js')
type Envelope = { data: { result?: any } | null; error: { code: string; message: string } | null }
const workspaceId = `ws_ops_retry_knowledge_${crypto.randomUUID().replaceAll('-', '')}`
const actor = 'ops_retry_knowledge_owner'
const token = `disposable_ops_retry_${crypto.randomUUID()}`
let api: Api
let persistence: Awaited<Api['persistenceReady']>
let base: string

async function mcp(method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params: { workspace_id: workspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as Envelope }
}

function failedJob() {
  const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: crypto.randomUUID(), credentialRef: `fixture://${workspaceId}/taobao` })
  const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '运营知识重试商品', category: '女装外套', stock: 8 })
  api.service.confirmProductFacts(workspaceId, product.id)
  const task = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
  api.service.selectDirection(task.id, 'A')
  api.service.confirmProductionPlan(workspaceId, task.id, actor)
  const job = api.service.enqueueGeneration({ workspaceId, taskId: task.id, idempotencyKey: `initial-${crypto.randomUUID()}` })
  api.service.failGeneration({ workspaceId, jobId: job.id, code: 'PROVIDER_TIMEOUT', message: 'synthetic initial failure, no provider call' })
  return { account, product, task, job }
}

async function failedJobViaHttp(readyInitially = false) {
  const account = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: crypto.randomUUID(), credentialRef: `fixture://${workspaceId}/taobao` })
  const product = api.service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '运营知识真实入队商品', category: '女装外套', stock: 8 })
  api.service.confirmProductFacts(workspaceId, product.id)
  const task = api.service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
  api.service.selectDirection(task.id, 'A')
  api.service.confirmProductionPlan(workspaceId, task.id, actor)
  const ready = readyInitially ? await readyKnowledge(product.id) : undefined
  const fixtureCompletion = vi.spyOn(api.service, 'completeGeneration').mockImplementation(() => { throw new Error('synthetic fixture completion stopped before content creation') })
  let job: ReturnType<typeof api.service.getGenerationJob>
  try {
    const response = await fetch(`${base}/v1/tasks/${task.id}/content-jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'idempotency-key': `initial-http-${crypto.randomUUID()}` },
      body: '{}',
    })
    const payload = await response.json() as { data?: { id?: string; state?: string }; error?: { code?: string } }
    expect(response.status, JSON.stringify(payload)).toBe(202)
    job = api.service.getGenerationJob(workspaceId, payload.data!.id!)
    expect(['queued', 'failed']).toContain(job.state)
    if (job.state === 'queued') api.service.failGeneration({ workspaceId, jobId: job.id, code: 'PROVIDER_TIMEOUT', message: 'synthetic initial failure, no provider call' })
  } finally {
    fixtureCompletion.mockRestore()
  }
  const frozen = api.service.getTask(task.id).inputSnapshot?.knowledgeContext?.documents ?? []
  expect(frozen).toEqual(ready ? [expect.objectContaining({ id: ready.document.id, revision: ready.document.revision })] : [])
  expect(await persistence.contextSnapshots!.getByTask({ workspaceId, taskId: task.id })).toMatchObject({ taskId: task.id })
  const timeline = await mcp('task.timeline', { task_id: task.id })
  expect(timeline.status, JSON.stringify(timeline.body)).toBe(200)
  const requested = timeline.body.data!.result!.events.find((event: any) => event.aggregate_id === job.id && event.event_type === 'generation.requested')
  expect(requested).toMatchObject({ payload: { context_link_id: expect.any(String), context_hash: expect.any(String), input: expect.any(Object) } })
  return { account, product, task, job, ready }
}

async function readyKnowledge(productId: string) {
  const asset = await persistence.knowledge!.createAsset({ workspaceId, kind: 'product_facts', name: '运营重试知识', content: { productId }, productId, approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
  const document = await persistence.knowledge!.createDocument({ workspaceId, productId, knowledgeAssetId: asset.id, knowledgeType: 'product_facts', title: '旧知识', extractedText: '已确认的旧知识', contentHash: crypto.randomUUID(), approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
  return { asset, document }
}

async function effects(taskId: string, jobId: string) {
  const { updatedAt: _probeTime, ...points } = await persistence.creativePoints!.getBalance(workspaceId)
  return {
    points,
    statement: await persistence.creativePoints!.listStatement(workspaceId),
    usage: await persistence.usage!.get(workspaceId),
    ledger: await persistence.actionLedger!.list(workspaceId),
    context: await persistence.contextSnapshots!.getByTask({ workspaceId, taskId }),
    outbox: persistence.outbox ? await persistence.outbox.listAggregateEvents(workspaceId, jobId, 100) : null,
    jobs: structuredClone([...api.service.generationJobs]),
    content: structuredClone([...api.service.contentVersions]),
    task: structuredClone(api.service.getTask(taskId)),
    taskSnapshots: structuredClone([...api.service.taskInputSnapshots]),
  }
}

describe('ops generation retry uses current durable knowledge before financial and queue effects', () => {
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
    vi.stubEnv('MERCHANT_TEST_APPROVED_RATES', 'true')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'disposable-ops-retry-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actor, roles: ['workspace_owner', 'rules_admin'] } }))
    api = await import('./server.js')
    persistence = await api.persistenceReady
    expect(persistence.mode).toBe('memory')
    await api.workspaceMembers.upsert({ workspaceId, externalSubject: actor, displayName: actor, role: 'workspace_owner', status: 'active', invitedBy: 'isolated-ops-retry-regression' })
    await api.grantCreativePointsForTests(workspaceId)
    api.grantContinuousFeatureEntitlementForTests(workspaceId)
    await new Promise<void>(resolve => api.server.listen(0, '127.0.0.1', resolve))
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('loopback API did not bind')
    base = `http://127.0.0.1:${address.port}`
    expect((await mcp('billing.status')).status).toBe(200)
  })
  afterAll(async () => {
    vi.restoreAllMocks()
    if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it.each([
    ['rights_restricted', 'KNOWLEDGE_REVIEW_REQUIRED'],
    ['new_queued_document', 'KNOWLEDGE_INDEX_PENDING'],
  ] as const)('rejects retry when %s after initial failure, without debit, enqueue or stale context', async (change, code) => {
    const { product, task, job } = failedJob()
    const ready = await readyKnowledge(product.id)
    if (change === 'rights_restricted') await persistence.knowledge!.updateAsset(workspaceId, ready.asset.id, { rightsStatus: 'restricted' })
    else await persistence.knowledge!.createDocument({ workspaceId, productId: product.id, knowledgeType: 'product_facts', title: '新增知识仍在索引', extractedText: '不可提前使用的新知识', contentHash: crypto.randomUUID(), approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'queued' })
    const before = await effects(task.id, job.id)
    const setter = vi.spyOn(api.service, 'setDurableKnowledgeDocuments')
    const reserve = vi.spyOn(persistence.creativePoints!, 'reserve')
    const record = vi.spyOn(persistence.actionLedger!, 'record')
    const contextSave = vi.spyOn(persistence.contextSnapshots!, 'save')
    const retry = vi.spyOn(api.service, 'retryGeneration')
    const model = vi.spyOn(api.service, 'generateDraft')
    try {
      const response = await mcp('ops.marketing.generation.retry', { job_id: job.id, reason: '运营确认后重试，须重新检查知识' })
      expect(response.status, JSON.stringify(response.body)).toBe(409)
      expect(response.body.error?.code).toBe(code)
      expect(await effects(task.id, job.id)).toEqual(before)
      for (const spy of [setter, reserve, record, contextSave, retry, model]) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of [setter, reserve, record, contextSave, retry, model]) spy.mockRestore()
      if (api.service.getGenerationJob(workspaceId, job.id).state === 'queued') api.service.failGeneration({ workspaceId, jobId: job.id, code: 'PROBE_STOP', message: 'red-run quota cleanup' })
    }
  })

  it('keeps existing retry behavior for a product without imported knowledge', async () => {
    const { task, job } = failedJob()
    const response = await mcp('ops.marketing.generation.retry', { job_id: job.id, reason: '无导入知识的普通重试' })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.error).toBeNull()
    expect(response.body.data?.result).toMatchObject({ id: job.id, state: 'queued' })
    expect(api.service.getTask(task.id).workspaceId).toBe(workspaceId)
    api.service.failGeneration({ workspaceId, jobId: job.id, code: 'PROBE_STOP', message: 'quota cleanup' })
  })

  it('hydrates approved ready knowledge before a permitted retry', async () => {
    const { task, job, ready } = await failedJobViaHttp(true)
    const document = ready!.document
    const response = await mcp('ops.marketing.generation.retry', { job_id: job.id, reason: '当前知识已就绪' })
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.data?.result).toMatchObject({ id: job.id, state: 'queued' })
    const frozen = api.service.getTask(task.id).inputSnapshot?.knowledgeContext?.documents ?? []
    expect(frozen).toContainEqual(expect.objectContaining({ id: document.id, content: document.extractedText, revision: document.revision }))
    api.service.failGeneration({ workspaceId, jobId: job.id, code: 'PROBE_STOP', message: 'quota cleanup' })
  })

  // Regression: ISSUE-003 — retry let an empty frozen job gain newly indexed knowledge.
  // Found by /qa on 2026-09-15
  // Report: .gstack/qa-reports/qa-report-store-nova-2026-09-15.md
  it('rejects the same failed job when a previously empty frozen context gains a ready document', async () => {
    const { product, task, job } = await failedJobViaHttp()
    await readyKnowledge(product.id)
    const before = await effects(task.id, job.id)
    const setter = vi.spyOn(api.service, 'setDurableKnowledgeDocuments')
    const retry = vi.spyOn(api.service, 'retryGeneration')
    const reserve = vi.spyOn(persistence.creativePoints!, 'reserve')
    const record = vi.spyOn(persistence.actionLedger!, 'record')
    const contextSave = vi.spyOn(persistence.contextSnapshots!, 'save')
    try {
      const response = await mcp('ops.marketing.generation.retry', { job_id: job.id, reason: '旧任务冻结时无知识，新知识必须创建新任务' })
      expect(response.status, JSON.stringify(response.body)).toBe(409)
      expect(response.body.error?.code).toBe('KNOWLEDGE_CONTEXT_CHANGED')
      expect(await effects(task.id, job.id)).toEqual(before)
      for (const spy of [setter, retry, reserve, record, contextSave]) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of [setter, retry, reserve, record, contextSave]) spy.mockRestore()
      if (api.service.getGenerationJob(workspaceId, job.id).state === 'queued') api.service.failGeneration({ workspaceId, jobId: job.id, code: 'PROBE_STOP', message: 'red-run quota cleanup' })
    }
  })

  it('rejects a second retry after an old successful context preparation is revoked', async () => {
    const { task, job, ready } = await failedJobViaHttp(true)
    const { asset, document } = ready!
    const old = await mcp('ops.marketing.generation.retry', { job_id: job.id, reason: '旧知识还就绪时首次重试' })
    expect(old.status, JSON.stringify(old.body)).toBe(200)
    expect(api.service.getTask(task.id).inputSnapshot?.knowledgeContext?.documents).toContainEqual(expect.objectContaining({ id: document.id }))
    api.service.failGeneration({ workspaceId, jobId: job.id, code: 'PROVIDER_TIMEOUT', message: 'synthetic second failure, no provider call' })
    await persistence.knowledge!.updateAsset(workspaceId, asset.id, { rightsStatus: 'restricted' })
    const before = await effects(task.id, job.id)
    const second = await mcp('ops.marketing.generation.retry', { job_id: job.id, reason: '旧上下文已撤权，不得重试' })
    expect(second.status, JSON.stringify(second.body)).toBe(409)
    expect(second.body.error?.code).toBe('KNOWLEDGE_REVIEW_REQUIRED')
    expect(await effects(task.id, job.id)).toEqual(before)
    if (api.service.getGenerationJob(workspaceId, job.id).state === 'queued') api.service.failGeneration({ workspaceId, jobId: job.id, code: 'PROBE_STOP', message: 'red-run quota cleanup' })
  })

  it('rejects a stale durable knowledge snapshot when every old document is deleted', async () => {
    const { task, job, ready } = await failedJobViaHttp(true)
    const { document } = ready!
    const old = await mcp('ops.marketing.generation.retry', { job_id: job.id, reason: '旧知识还就绪时首次重试' })
    expect(old.status, JSON.stringify(old.body)).toBe(200)
    expect(api.service.getTask(task.id).inputSnapshot?.knowledgeContext?.documents).toContainEqual(expect.objectContaining({ id: document.id }))
    api.service.failGeneration({ workspaceId, jobId: job.id, code: 'PROVIDER_TIMEOUT', message: 'synthetic second failure, no provider call' })
    await persistence.knowledge!.deleteDocument(workspaceId, document.id)
    const before = await effects(task.id, job.id)
    const second = await mcp('ops.marketing.generation.retry', { job_id: job.id, reason: '旧知识已删除，应阻断旧上下文' })
    expect(second.status, JSON.stringify(second.body)).toBe(409)
    expect(second.body.error?.code).toBe('KNOWLEDGE_CONTEXT_CHANGED')
    expect(await effects(task.id, job.id)).toEqual(before)
  })

  it('rejects a still-ready document whose version changed since the previous retry', async () => {
    const { task, job, ready } = await failedJobViaHttp(true)
    const { document } = ready!
    const first = await mcp('ops.marketing.generation.retry', { job_id: job.id, reason: '首次重试冻结当前版本' })
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    expect(api.service.getTask(task.id).inputSnapshot?.knowledgeContext?.documents).toContainEqual(expect.objectContaining({ id: document.id, revision: document.revision }))
    api.service.failGeneration({ workspaceId, jobId: job.id, code: 'PROVIDER_TIMEOUT', message: 'synthetic second failure, no provider call' })
    await persistence.knowledge!.transitionIndexState(workspaceId, document.id, 'stale', 'knowledge changed after prior retry')
    const readyAgain = await persistence.knowledge!.transitionIndexState(workspaceId, document.id, 'ready', 'fixture reindex completed')
    expect(readyAgain.revision).toBeGreaterThan(document.revision)
    const before = await effects(task.id, job.id)
    const second = await mcp('ops.marketing.generation.retry', { job_id: job.id, reason: '同一文档已重新索引但版本不同' })
    expect(second.status, JSON.stringify(second.body)).toBe(409)
    expect(second.body.error?.code).toBe('KNOWLEDGE_CONTEXT_CHANGED')
    expect(await effects(task.id, job.id)).toEqual(before)
  })
})
