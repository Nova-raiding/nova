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
})
