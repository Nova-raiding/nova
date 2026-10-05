import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { MerchantService } from '../../../packages/application/src/service.js'
import { handleHttpGenerationJobWorker, type HttpGenerationJobWorkerDependencies } from './http-generation-job-worker.js'

function fixture(plain: boolean, content: Record<string, unknown>) {
  const service = new MerchantService({ fixtureMode: true })
  const task = service.createTask({ workspaceId: 'ws_demo', productId: 'prod_fixture_1', platform: 'taobao', requestText: plain ? '只要纯文本，用于内部审核。' : '制作详情页' })
  service.selectDirection(task.id, 'A'); service.confirmProductionPlan('ws_demo', task.id, 'merchant', task.version)
  const job = service.enqueueGeneration({ workspaceId: 'ws_demo', taskId: task.id, idempotencyKey: 'worker-plain' })
  const auth = vi.fn(async () => undefined)
  const persist = vi.fn(async () => undefined)
  const readModules = vi.fn(() => { throw new Error('detail modules required') })
  const deps: HttpGenerationJobWorkerDependencies = {
    service, requireWorkerAuthorization: auth, resolveWorkspace: () => 'ws_demo', body: async () => ({ content, outputType: 'plain_text' }), enrichRequestObservation: () => undefined,
    persistSnapshot: persist, persistEvent: persist, jobWithQueueMetadata: value => ({ ...value, queue_state: 'done', queue_position: 0, estimated_wait_seconds: 0 }), providerSucceededButSettlementPending: () => false,
    refundTaskUsage: persist, releaseDistributedJobSlot: persist, header: () => undefined, readStaticBrief: () => undefined, readContentModules: readModules,
    requireGenerationRulePreflight: async () => ({ rule_hits: [] }), contentExecutionEvidence: async () => ({ providerExecuted: true }), rulesForTask: async () => undefined,
    persistSnapshotsAndEvent: persist, rollbackGenerationCompletion: () => { throw new Error('unexpected rollback') }, respond: () => true,
  }
  return { service, task, job, auth, readModules, run: () => handleHttpGenerationJobWorker({ method: 'POST' } as IncomingMessage, {} as ServerResponse, `/v1/generation-jobs/${job.id}/result`, deps) }
}
describe('worker frozen plain text contract', () => {
  it('accepts an empty-points plain result using server snapshot, retaining auth and persistence', async () => {
    const f = fixture(true, { title: '内部审核', detail: '纯文本待审核', sellingPoints: [] })
    await expect(f.run()).resolves.toBe(true)
    expect(f.auth).toHaveBeenCalledOnce()
    expect(f.readModules).not.toHaveBeenCalled()
    expect(f.service.getContentVersion('ws_demo', f.job.contentVersionId!).body).toEqual({ title: '内部审核', detail: '纯文本待审核', sellingPoints: [] })
  })
  it('does not let a callback claim plain mode for a frozen detail task', async () => {
    const f = fixture(false, { title: '内部审核', detail: '纯文本待审核', sellingPoints: ['test'] })
    await expect(f.run()).rejects.toThrow('detail modules required')
    expect(f.job.state).toBe('queued')
  })
  it('rejects visual extras even for a frozen plain task', async () => {
    const f = fixture(true, { title: '内部审核', detail: '纯文本待审核', sellingPoints: [], brief: {} })
    await expect(f.run()).rejects.toThrow('纯文本不得包含 brief')
    expect(f.job.state).toBe('queued')
  })
})
