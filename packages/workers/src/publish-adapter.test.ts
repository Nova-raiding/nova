import { describe, expect, it } from 'vitest'
import { FakePlatformConnector } from '../../connectors/src/fake-connector.js'
import { jdProfile } from '../../connectors/src/profiles/jd.js'
import { createPublishWorker } from './factories.js'
import { createPublishHandler } from './publish-adapter.js'

describe('publish adapter post-write verification', () => {
  it('retains the receipt and remote status, without treating acceptance as published', async () => {
    const connector = new FakePlatformConnector(jdProfile, { configured: true, allowFakeWrites: true })
    const worker = createPublishWorker(createPublishHandler(connector, async payload => ({
      ...payload,
      accountId: 'acct_1',
      fields: { title: '京选外套', category: '服饰 > 外套', price: 199, stock: 10 },
    })))
    const job = worker.enqueue({ workspaceId: 'ws_1', idempotencyKey: 'publish-adapter-1', payload: { taskId: 'task_1', contentVersionId: 'cv_1', platform: 'jd', idempotencyKey: 'publish-adapter-1' } })
    await worker.runNext()
    expect(job.state).toBe('succeeded')
    expect(job.result).toMatchObject({ remoteStatus: { found: true, state: 'submitted', simulated: true }, receipt: { status: 'submitted' } })
    expect((job.result as { remoteStatus: { state: string } }).remoteStatus.state).not.toBe('published')
  })

  it('allows published only when queryWrite provides explicit remote evidence', async () => {
    const base = new FakePlatformConnector(jdProfile, { configured: true, allowFakeWrites: true })
    const connector = Object.create(base) as typeof base
    connector.queryWrite = async (_ctx: Parameters<typeof base.queryWrite>[0], request: Parameters<typeof base.queryWrite>[1]) => ({ found: true, state: 'published' as const, remoteId: request.remoteId, requestId: 'remote-status-1', simulated: false })
    const worker = createPublishWorker(createPublishHandler(connector, async payload => ({ ...payload, accountId: 'acct_1', fields: { title: '京选外套', category: '服饰 > 外套', price: 199, stock: 10 } })))
    const job = worker.enqueue({ workspaceId: 'ws_1', idempotencyKey: 'publish-adapter-2', payload: { taskId: 'task_1', contentVersionId: 'cv_1', platform: 'jd', idempotencyKey: 'publish-adapter-2' } })
    await worker.runNext()
    expect(job.state).toBe('succeeded')
    expect((job.result as { remoteStatus: { state: string; requestId?: string } }).remoteStatus).toMatchObject({ state: 'published', requestId: 'remote-status-1' })
  })

  it('forwards the request trace id instead of substituting the in-process job id', async () => {
    const contexts: Array<{ traceId?: string }> = []
    const base = new FakePlatformConnector(jdProfile, { configured: true, allowFakeWrites: true })
    const connector = Object.create(base) as typeof base
    connector.createProduct = async (...args: Parameters<typeof base.createProduct>) => {
      contexts.push({ ...(args[0].traceId ? { traceId: args[0].traceId } : {}) })
      return base.createProduct(...args)
    }
    const handler = createPublishHandler(connector, async payload => ({
      ...payload,
      accountId: 'acct_1',
      fields: { title: '京选外套', category: '服饰 > 外套', price: 199, stock: 10 },
    }))
    const baseJob = {
      id: 'job_in_process_1', kind: 'publish' as const, workspaceId: 'ws_1', idempotencyKey: 'publish-trace', attempt: 1, maxAttempts: 5,
      payload: { taskId: 'task_1', contentVersionId: 'cv_1', platform: 'jd', idempotencyKey: 'publish-trace' }, state: 'running' as const, notBefore: 0, createdAt: 0,
    }

    await handler({ job: baseJob, now: 1, attempt: 1, traceId: 'trace_request_1' })
    // The per-process `job_<uuid>` used to be published as `traceId`, which made
    // every connector line unjoinable with the API request and worker streams.
    expect(contexts[0]?.traceId).toBe('trace_request_1')
    expect(contexts[0]?.traceId).not.toBe(baseJob.id)

    await handler({ job: baseJob, now: 2, attempt: 1 })
    expect(contexts[1]?.traceId).toBeUndefined()
  })

  it('marks an unstructured post-write query failure unknown without repeating the write', async () => {
    const base = new FakePlatformConnector(jdProfile, { configured: true, allowFakeWrites: true })
    const connector = Object.create(base) as typeof base
    let writes = 0
    connector.createProduct = async (...args: Parameters<typeof base.createProduct>) => {
      writes += 1
      return base.createProduct(...args)
    }
    connector.queryWrite = async () => { throw new Error('connection reset by peer') }
    const worker = createPublishWorker(createPublishHandler(connector, async payload => ({
      ...payload,
      accountId: 'acct_1',
      fields: { title: '京选外套', category: '服饰 > 外套', price: 199, stock: 10 },
    })))
    const job = worker.enqueue({ workspaceId: 'ws_1', idempotencyKey: 'publish-query-reset', payload: { taskId: 'task_1', contentVersionId: 'cv_1', platform: 'jd', idempotencyKey: 'publish-query-reset' } })

    await worker.runNext()

    expect(writes).toBe(1)
    expect(job.state).toBe('unknown')
    expect(job.lastError).toMatchObject({ code: 'PUBLISH_STATUS_UNKNOWN', unknown: true, retryable: false })
  })
})
