import { describe, expect, it } from 'vitest'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, service } from '../apps/api/src/server.js'
import { server as applicationServer } from '../apps/api/src/server.js'
import { createPublishWorker } from '../packages/workers/src/factories.js'
import { InMemoryJobRunner, WorkerFailure } from '../packages/workers/src/runner.js'

const request = async (base: string, workspaceId: string, path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers)
  headers.set('x-workspace-id', workspaceId)
  const response = await fetch(`${base}${path}`, { ...init, headers })
  return { status: response.status, body: await response.json() as { data: any; error: { code: string } | null } }
}

const start = async () => {
  const server = applicationServer
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return { server, base: `http://127.0.0.1:${address.port}` }
}

describe('quality gates', () => {
  it('rejects cross-tenant product creation and cross-tenant publish confirmation over HTTP', async () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
    const owner = `ws_owner_${suffix}`
    const attacker = `ws_attacker_${suffix}`
    const productId = `prod_owner_${suffix}`
    service.products.set(productId, { id: productId, workspaceId: owner, platform: 'taobao', storeName: 'owner', remoteId: `TB-${suffix}`, title: 'owner product', skuCount: 1, stock: 1, factsConfirmed: true, source: 'fixture', updatedAt: new Date().toISOString() })
    const account = service.registerPlatformAccount({ workspaceId: owner, platform: 'taobao', remoteAccountId: `quality-${suffix}`, credentialRef: 'fixture://quality' })
    await grantCreativePointsForTests(owner)
    await grantCreativePointsForTests(attacker)
    grantContinuousFeatureEntitlementForTests(owner)
    grantContinuousFeatureEntitlementForTests(attacker)
    const { server, base } = await start()
    try {
      const deniedProduct = await request(base, attacker, '/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: attacker, product_id: productId, platform: 'taobao' }) })
      expect(deniedProduct.status).toBe(404)
      expect(deniedProduct.body.error?.code).toBe('PRODUCT_NOT_FOUND')

      const created = await request(base, owner, '/v1/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace_id: owner, product_id: productId, platform: 'taobao', account_id: account.id }) })
      const taskId = created.body.data.id as string
      await request(base, owner, `/v1/tasks/${taskId}/directions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direction_id: 'A' }) })
      await request(base, owner, `/v1/tasks/${taskId}/plan/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_version: 2 }) })
      const contentVersionId = service.createDraft(taskId).id
      await request(base, owner, `/v1/tasks/${taskId}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content_version_id: contentVersionId }) })
      const preview = await request(base, owner, `/v1/tasks/${taskId}/publish-preview`, { method: 'POST' })
      const deniedPublish = await request(base, attacker, '/v1/publish-jobs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `attacker-${suffix}` }, body: JSON.stringify({ workspace_id: attacker, task_id: taskId, content_version_id: contentVersionId, confirmation_hash: preview.body.data.confirmationHash, remote_snapshot_hash: preview.body.data.remoteSnapshotHash }) })
      expect(deniedPublish.status).toBe(403)
      expect(deniedPublish.body.error?.code).toBe('TENANT_SCOPE_DENIED')
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('reports retry attempts, backoff retries, and dead-letter outcomes', async () => {
    let now = 0
    const worker = createPublishWorker(async () => { throw new WorkerFailure({ code: 'RATE_LIMITED', message: 'retry', retryable: true }) }, { now: () => now, baseDelayMs: 10, maxDelayMs: 100 })
    const job = worker.enqueue({ workspaceId: 'ws_retry_stats', idempotencyKey: 'retry-stats', payload: { taskId: 'task_retry', contentVersionId: 'cv_retry', platform: 'taobao', idempotencyKey: 'publish-retry-stats' }, maxAttempts: 3 })
    const states: string[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await worker.runNext()
      expect(result).toBeDefined()
      states.push(job.state)
      if (job.state === 'queued') now = job.notBefore
    }
    const stats = { enqueued: worker.jobs.size, attempts: job.attempt, retries: Math.max(0, job.attempt - 1), deadLetter: [...worker.jobs.values()].filter(item => item.state === 'dead_letter').length, states }
    expect(stats).toEqual({ enqueued: 1, attempts: 3, retries: 2, deadLetter: 1, states: ['queued', 'queued', 'dead_letter'] })
  })

  it('requires reconciliation for unknown results and only then permits a proven safe retry', async () => {
    const worker = createPublishWorker(async () => { throw new WorkerFailure({ code: 'TIMEOUT', message: 'outcome unknown', retryable: true, unknown: true }) })
    const job = worker.enqueue({ workspaceId: 'ws_unknown', idempotencyKey: 'unknown-reconcile', payload: { taskId: 'task_unknown', contentVersionId: 'cv_unknown', platform: 'taobao', idempotencyKey: 'publish-unknown-reconcile' } })
    await worker.runNext()
    expect(job.state).toBe('unknown')
    expect(() => worker.retryUnknown(job.id, { remoteAbsent: false, safeToRetry: true })).toThrow()
    expect(() => worker.retryUnknown(job.id, { remoteAbsent: true, safeToRetry: false })).toThrow()
    worker.retryUnknown(job.id, { remoteAbsent: true, safeToRetry: true })
    expect(job.state).toBe('queued')
  })
})
