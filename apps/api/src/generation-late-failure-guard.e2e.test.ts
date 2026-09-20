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
    const mcp = (id: number, method: string, params: Record<string, unknown>) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { workspace_id: workspaceId, ...params } }),
    }).then(response => response.json() as Promise<Envelope<{ result: any }>>)
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

    const idempotencyKey = `late-failure-${Date.now()}`
    const queued = await fetch(`${base}/v1/tasks/${taskId}/content-jobs`, { method: 'POST', headers: { ...headers, 'idempotency-key': idempotencyKey } }).then(json)
    expect(queued.error).toBeNull()
    const jobId = (queued.data as { id: string }).id

    const body = JSON.stringify({ content: workerDecisionContent(productId) })
    const completed = await fetch(`${base}/v1/generation-jobs/${jobId}/result`, { method: 'POST', headers, body }).then(json)
    expect(completed.error).toBeNull()
    expect(completed.data).toMatchObject({ state: 'succeeded' })

    // Trigger the queued-time rule preflight for the replay the way a deleted
    // product does: `requireGenerationRulePreflight` throws PRODUCT_NOT_FOUND
    // before any content is written.
    service.products.delete(productId)

    const replayed = await fetch(`${base}/v1/generation-jobs/${jobId}/result`, { method: 'POST', headers, body }).then(json)
    const timeline = await fetch(`${base}/v1/tasks/${taskId}/timeline?limit=200`, { headers }).then(json)

    // A late report for a job that already succeeded is an idempotent replay of
    // the terminal state: `failGeneration` returns the succeeded job unchanged
    // and the handler must return before `persistSnapshot`, `persistEvent`,
    // `refundTaskUsage` and `releaseDistributedJobSlot` are reached. In this
    // harness the refund and the Redis slot release have no observable effect
    // (no charged usage exists — `observeLegacyTaskUsage` is shadow-only — and
    // the legacy `billing.usage.consume` route is commercially disabled), so the
    // guard is pinned by the response and by the event stream, both of which ran
    // only if the returned state was not checked.
    expect(replayed.error).toBeNull()
    expect(replayed.data).toMatchObject({ state: 'succeeded' })
    expect(service.getGenerationJob(workspaceId, jobId).state).toBe('succeeded')
    expect((timeline.data as Array<{ event_type: string }>).map(item => item.event_type)).not.toContain('generation.failed')
  })
})
