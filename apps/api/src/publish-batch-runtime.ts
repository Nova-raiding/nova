import { DomainError, type MerchantService, type PublishJob } from '../../../packages/application/src/service.js'
import type { BusinessEntityType } from '../../../packages/persistence/src/index.js'
import type { PublishBatch, PublishBatchItem } from './server.js'

type SnapshotInput = { entityType: BusinessEntityType; entityId: string; entityVersion: number; payload: Record<string, unknown> }
type PersistSnapshotsAndEvent = (input: { workspaceId: string; snapshots: SnapshotInput[]; aggregateId: string; eventType: string; sequence: number; eventPayload: Record<string, unknown> }) => Promise<unknown>

export function createPublishBatchRuntime(dependencies: {
  service: MerchantService
  publishBatches: Map<string, PublishBatch>
  persistedPublishBatches: Map<string, PublishBatch>
  persistSnapshotsAndEvent: PersistSnapshotsAndEvent
  publishEventPayload: (job: PublishJob) => Record<string, unknown>
}) {
  const { service, publishBatches, persistedPublishBatches, persistSnapshotsAndEvent, publishEventPayload } = dependencies
  function batchStateFromItems(items: PublishBatchItem[]): PublishBatch['state'] {
    // `submitted` only means the platform accepted the request. The final
    // publish receipt is required before a batch can be reported completed.
    if (items.length && items.every(item => item.state === 'published')) return 'completed'
    if (items.some(item => item.state === 'failed' || item.state === 'rejected' || item.state === 'unknown')) return items.some(item => ['queued', 'submitted', 'published'].includes(item.state)) ? 'partial' : 'failed'
    if (items.every(item => item.state === 'paused')) return 'paused'
    if (items.some(item => ['queued', 'submitted', 'published'].includes(item.state))) return 'queued'
    return 'prepared'
  }

  async function savePublishBatch(batch: PublishBatch, eventType = 'publish.batch.updated') {
    const previous = persistedPublishBatches.get(batch.id)
    const next = structuredClone(batch)
    next.updatedAt = new Date().toISOString()
    next.revision += 1
    const eventPayload = { batch_id: next.id, state: next.state, items: next.items.map(item => ({ task_id: item.taskId, state: item.state, job_id: item.jobId ?? null })) }
    try {
      await persistSnapshotsAndEvent({ workspaceId: next.workspaceId, snapshots: [{ entityType: 'publish_batch', entityId: next.id, entityVersion: next.revision, payload: next as unknown as Record<string, unknown> }], aggregateId: next.id, eventType, sequence: next.revision, eventPayload })
    } catch (error) {
      if (previous) {
        for (const key of Object.keys(batch as unknown as Record<string, unknown>)) delete (batch as unknown as Record<string, unknown>)[key]
        Object.assign(batch, structuredClone(previous))
        publishBatches.set(batch.id, batch)
      } else {
        publishBatches.delete(batch.id)
      }
      throw error
    }
    for (const key of Object.keys(batch as unknown as Record<string, unknown>)) delete (batch as unknown as Record<string, unknown>)[key]
    Object.assign(batch, next)
    publishBatches.set(batch.id, batch)
    persistedPublishBatches.set(batch.id, structuredClone(batch))
    return batch
  }

  /**
   * Bulk publish admission must make the parent batch and child publish job
   * recoverable together. The normalized projections and outbox event are
   * committed in one workspace transaction; a restart can therefore never
   * observe a durable child without its parent batch item.
   */
  async function persistPublishJobWithBatch(input: { batch: PublishBatch; task: ReturnType<typeof service.getTask>; job: import('../../../packages/application/src/service.js').PublishJob; itemState: PublishBatchItem['state']; error?: PublishBatchItem['error'] }) {
    const next = structuredClone(input.batch)
    const item = next.items.find(candidate => candidate.taskId === input.task.id)
    if (!item) throw new DomainError('PUBLISH_BATCH_ITEM_NOT_FOUND', `任务 ${input.task.id} 不属于该批次`, 400)
    Object.assign(item, { state: input.itemState, jobId: input.job.id, contentVersionId: input.job.contentVersionId, confirmationHash: input.job.confirmationHash, remoteSnapshotHash: input.job.remoteSnapshotHash, ...(input.job.accountId ? { accountId: input.job.accountId } : {}), ...(input.error ? { error: input.error } : { error: undefined }) })
    next.state = batchStateFromItems(next.items)
    next.updatedAt = new Date().toISOString()
    next.revision += 1
    // confirmPublish is called with deferCommit for this path. Persist the
    // exact post-commit task state atomically with the job and parent batch;
    // only then mutate the process-local service indexes.
    const persistedTask = structuredClone(input.task)
    persistedTask.state = 'publishing'
    persistedTask.version += 1
    await persistSnapshotsAndEvent({
      workspaceId: next.workspaceId,
      snapshots: [
        { entityType: 'task', entityId: persistedTask.id, entityVersion: persistedTask.version, payload: persistedTask as unknown as Record<string, unknown> },
        { entityType: 'publish_job', entityId: input.job.id, entityVersion: input.job.revision, payload: input.job as unknown as Record<string, unknown> },
        { entityType: 'publish_batch', entityId: next.id, entityVersion: next.revision, payload: next as unknown as Record<string, unknown> },
      ],
      aggregateId: input.job.id,
      eventType: 'publish.requested',
      sequence: input.job.revision,
      eventPayload: { ...publishEventPayload(input.job), batch_id: next.id, batch_revision: next.revision },
    })
    for (const key of Object.keys(input.batch as unknown as Record<string, unknown>)) delete (input.batch as unknown as Record<string, unknown>)[key]
    Object.assign(input.batch, next)
    publishBatches.set(next.id, input.batch)
    persistedPublishBatches.set(next.id, structuredClone(next))
    service.commitPublishConfirmation(input.job)
    return input.batch
  }

  async function refreshPublishBatch(batch: PublishBatch) {
    let changed = false
    for (const item of batch.items) {
      if (!item.jobId) continue
      const job = service.publishJobs.get(item.jobId)
      if (!job) continue
      const nextState = (job.state === 'published' ? 'published' : job.state === 'submitted' ? 'submitted' : job.state === 'rejected' ? 'rejected' : job.state === 'unknown' ? 'unknown' : job.state === 'queued' || job.state === 'submitting' ? 'queued' : item.state) as PublishBatchItem['state']
      if (item.state !== nextState || item.error?.message !== job.rejection?.message) {
        item.state = nextState
        if (job.rejection) item.error = { code: job.rejection.rawCode, message: job.rejection.message ?? '平台拒绝发布' }
        changed = true
      }
    }
    const state = batch.state === 'paused' ? 'paused' : batchStateFromItems(batch.items)
    if (batch.state !== state) { batch.state = state; changed = true }
    if (changed) await savePublishBatch(batch, 'publish.batch.reconciled')
    return batch
  }

  return { batchStateFromItems, savePublishBatch, persistPublishJobWithBatch, refreshPublishBatch }
}
