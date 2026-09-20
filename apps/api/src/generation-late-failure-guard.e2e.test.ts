import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableCommercialFixtureHarnessForTests, grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, server, service } from './server.js'

type Envelope<T = any> = { workspace_id: string; data: T | null; error: { code: string; message: string; details?: Record<string, unknown> } | null }

async function start() {
  enableCommercialFixtureHarnessForTests()
  vi.stubEnv('ALLOW_LOCAL_PAYMENT_FIXTURE', 'true')
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

function workerDecisionContent(productId: string) {
  const factSourceId = `product:${productId}:v1`
  const sellingPoints = ['迟到失败守卫卖点']
  return {
    title: '迟到失败守卫标题',
    detail: '迟到失败守卫详情',
    sellingPoints,
    modules: [{
      key: 'selling_points', title: '核心卖点', purpose: '回答购买理由', body: sellingPoints.join('；'),
      factSourceIds: [factSourceId], contentKind: 'fact',
      decisionContract: {
        buyerQuestion: '为什么值得购买？', pageTask: '说明已确认卖点',
        claim: { text: sellingPoints.join('；'), factSourceIds: [factSourceId], platforms: ['taobao'], limitations: ['仅适用于当前商品快照'] },
        evidence: { type: 'parameter', sourceIds: [factSourceId], status: 'verified' },
        visualContract: { requiredElements: ['商品与卖点'], protectedElements: ['商品外观'], prohibitedImplications: ['不得扩大未确认效果'], accessibilityText: sellingPoints.join('；') },
        priority: 1, optional: false,
      },
    }],
  }
}

beforeEach(() => vi.stubEnv('SESSION_ID_HASH_SECRET', 'test-session-hash-secret'))

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllEnvs()
})

/**
 * Drive one product through the real endpoints up to a *queued* generation job,
 * and return the handles a worker report would need. The two late-report tests
 * below continue from here to a *succeeded* job, because that is the state in
 * which the terminal guard refuses a write; the third test stays here, because
 * that is the state in which the guard has to let the write through.
 */
async function queuedGenerationJob(base: string, workspaceId: string, headers: Record<string, string>) {
  const json = (response: Response) => response.json() as Promise<Envelope>
  await grantCreativePointsForTests(workspaceId)
  grantContinuousFeatureEntitlementForTests(workspaceId)

  const imported = await fetch(`${base}/v1/products/import`, { method: 'POST', headers, body: JSON.stringify({ platform: 'taobao', remote_id: `late-failure-${Date.now()}`, title: '迟到失败守卫商品', sku_count: 1, stock: 5 }) }).then(json)
  expect(imported.error).toBeNull()
  const productId = (imported.data as { id: string }).id
  await fetch(`${base}/v1/products/${productId}/confirm`, { method: 'POST', headers })

  const task = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ product_id: productId, platform: 'taobao' }) }).then(json)
  expect(task.error).toBeNull()
  const taskId = (task.data as { id: string }).id
  await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers, body: JSON.stringify({ direction_id: 'A' }) })
  await fetch(`${base}/v1/tasks/${taskId}/plan/confirm`, { method: 'POST', headers, body: JSON.stringify({ expected_version: 2 }) })

  const queued = await fetch(`${base}/v1/tasks/${taskId}/content-jobs`, { method: 'POST', headers: { ...headers, 'idempotency-key': `late-failure-${Date.now()}` } }).then(json)
  expect(queued.error).toBeNull()
  const jobId = (queued.data as { id: string }).id
  return { productId, taskId, jobId, body: JSON.stringify({ content: workerDecisionContent(productId) }) }
}

async function succeededGenerationJob(base: string, workspaceId: string, headers: Record<string, string>) {
  const json = (response: Response) => response.json() as Promise<Envelope>
  const { productId, taskId, jobId, body } = await queuedGenerationJob(base, workspaceId, headers)
  const completed = await fetch(`${base}/v1/generation-jobs/${jobId}/result`, { method: 'POST', headers, body }).then(json)
  expect(completed.error).toBeNull()
  expect(completed.data).toMatchObject({ state: 'succeeded' })
  return { productId, taskId, jobId, body }
}

function timelineOf(base: string, workspaceId: string, headers: Record<string, string>, taskId: string) {
  return fetch(`${base}/v1/tasks/${taskId}/timeline?limit=200`, { headers })
    .then(response => response.json() as Promise<Envelope<Array<{ event_type: string }>>>)
}

/**
 * The worker outbox redelivers a result post when the endpoint answers non-2xx.
 * A job that already succeeded can therefore receive a second, late failure
 * report. Both failure branches of `POST /v1/generation-jobs/:id/result` must
 * treat that replay as a no-op terminal state: no phantom `generation.failed`
 * event, no refund and no slot release.
 */
describe('generation result late failure replay', () => {
  it('does not fail, refund or free the slot of an already succeeded job', async () => {
    const base = await start()
    const workspaceId = `ws_late_failure_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const json = (response: Response) => response.json() as Promise<Envelope>
    const { productId, taskId, jobId, body } = await succeededGenerationJob(base, workspaceId, headers)

    // Trigger the queued-time rule preflight for the replay the way a deleted
    // product does: `requireGenerationRulePreflight` throws PRODUCT_NOT_FOUND
    // before any content is written.
    service.products.delete(productId)

    const replayed = await fetch(`${base}/v1/generation-jobs/${jobId}/result`, { method: 'POST', headers, body }).then(json)
    const timeline = await timelineOf(base, workspaceId, headers, taskId)

    // A late report for a job that already succeeded is an idempotent replay of
    // the terminal state: `failGeneration` returns the succeeded job unchanged
    // and the handler must return before `persistSnapshot`, `persistEvent`,
    // `refundTaskUsage` and `releaseDistributedJobSlot` are reached. In this
    // harness the refund and the Redis slot release have no observable effect
    // (no charged usage exists — `observeLegacyTaskUsage` is shadow-only — and
    // the legacy `billing.usage.consume` route is commercially disabled), so the
    // guard is pinned by the response and by the event stream, both of which ran
    // only if the returned state was not checked.
    expect(
      replayed.error,
      'the generation terminal guard lets exactly the writes the domain state allows',
    ).toBeNull()
    expect(replayed.data).toMatchObject({ state: 'succeeded' })
    expect(service.getGenerationJob(workspaceId, jobId).state).toBe('succeeded')
    expect(
      (timeline.data as Array<{ event_type: string }>).map(item => item.event_type),
      'the generation terminal guard lets exactly the writes the domain state allows',
    ).not.toContain('generation.failed')
  })

  /**
   * The defer branch is the third sibling of the same terminal-state guard.
   * `service.deferGeneration` returns a succeeded job unchanged, so a late
   * `POST /defer` — a second executor, or the worker outbox redelivering a
   * non-2xx post — used to persist the unchanged snapshot and write a phantom
   * `generation.deferred` event directly after `generation.completed`. The two
   * `failGeneration` branches were fixed without it, which is exactly the
   * asymmetry this file exists to catch.
   */
  it('does not write a phantom generation.deferred event for an already succeeded job', async () => {
    const base = await start()
    const workspaceId = `ws_late_defer_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const json = (response: Response) => response.json() as Promise<Envelope>
    const { taskId, jobId } = await succeededGenerationJob(base, workspaceId, headers)
    const revisionBefore = service.getGenerationJob(workspaceId, jobId).revision

    const deferred = await fetch(`${base}/v1/generation-jobs/${jobId}/defer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ code: 'QUOTA_EXHAUSTED', message: '迟到重投的延迟回报', retry_after_seconds: 30 }),
    }).then(json)

    const timeline = await timelineOf(base, workspaceId, headers, taskId)
    const eventTypes = (timeline.data as Array<{ event_type: string }>).map(item => item.event_type)

    expect(deferred.error).toBeNull()
    expect(deferred.data).toMatchObject({ state: 'succeeded' })
    const job = service.getGenerationJob(workspaceId, jobId)
    expect(job.state).toBe('succeeded')
    expect(job.revision).toBe(revisionBefore)
    // The job record must not disagree with its own event stream.
    expect(eventTypes).toContain('generation.completed')
    expect(eventTypes).not.toContain('generation.deferred')
  })

  /**
   * The other half of the sentence, and the half the previous evidence file was
   * missing: the guard must still let a legitimate write through. A queued job
   * that reports provider quota backpressure has to get its
   * `generation.deferred` event — otherwise "the late replay was blocked" is
   * satisfied by a guard that refuses every write, including the real path, and
   * the merchant's task timeline silently stops recording retry windows.
   */
  it('still writes generation.deferred for a queued job under quota backpressure', async () => {
    const base = await start()
    const workspaceId = `ws_live_defer_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const json = (response: Response) => response.json() as Promise<Envelope>
    const { taskId, jobId } = await queuedGenerationJob(base, workspaceId, headers)

    const deferred = await fetch(`${base}/v1/generation-jobs/${jobId}/defer`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ code: 'QUOTA_EXHAUSTED', message: '配额窗口未恢复，等待重试', retry_after_seconds: 30 }),
    }).then(json)

    const timeline = await timelineOf(base, workspaceId, headers, taskId)
    const eventTypes = (timeline.data as Array<{ event_type: string }>).map(item => item.event_type)

    expect(deferred.error).toBeNull()
    expect(deferred.data).toMatchObject({ state: 'queued' })
    expect(service.getGenerationJob(workspaceId, jobId).state).toBe('queued')
    expect(
      eventTypes,
      'the generation terminal guard lets exactly the writes the domain state allows',
    ).toContain('generation.deferred')
  })

  /**
   * And the boundary of the guard: `failed` is *not* terminal for a write, which
   * is the other half of why the shared state table distinguishes "the domain
   * service refused the write" (`succeeded`) from "no execution may start"
   * (`succeeded` or `failed`). `retryGeneration` and `deferGeneration` move a
   * failed job back to `queued`, so collapsing the worker's set into the API
   * guard — or the API guard into the worker's — would silently skip the
   * snapshot and the event for a failure report the domain accepted, and the
   * durable job record would drift from the event stream.
   */
  it('still records a failure report for a job that has not succeeded', async () => {
    const base = await start()
    const workspaceId = `ws_live_failure_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId }
    const json = (response: Response) => response.json() as Promise<Envelope>
    const { taskId, jobId } = await queuedGenerationJob(base, workspaceId, headers)

    const failed = await fetch(`${base}/v1/generation-jobs/${jobId}/result`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ error: { code: 'AI_GENERATION_FAILED', message: '模型调用失败' } }),
    }).then(json)

    const timeline = await timelineOf(base, workspaceId, headers, taskId)
    const eventTypes = (timeline.data as Array<{ event_type: string }>).map(item => item.event_type)

    expect(failed.error).toBeNull()
    expect(failed.data).toMatchObject({ state: 'failed' })
    expect(service.getGenerationJob(workspaceId, jobId).state).toBe('failed')
    expect(
      eventTypes,
      'the generation terminal guard lets exactly the writes the domain state allows',
    ).toContain('generation.failed')
  })
})
