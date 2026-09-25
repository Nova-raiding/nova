import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type MerchantService, type Platform, type PublishJob, type Task } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { ApiPersistence } from './server.js'
import { runFencedSinglePublish, PublishCommitStatusUnknownError } from './publish-fenced-orchestrator.js'
import type { TransactionalInteractiveConfirmationTicketRepository, ReserveInteractiveConfirmationTicketInput, InteractiveConfirmationTicketReservation } from '../../../packages/persistence/src/interactive-confirmation-ticket-repository.js'

type JsonObject = Record<string, unknown>
type PublishAuthorization = ReturnType<typeof import('./server.js').requirePublishAuthorizationSnapshot>
type Snapshot = { entityType: 'task' | 'publish_job'; entityId: string; entityVersion: number; payload: Record<string, unknown> }
type PublishInput = { workspaceId: string; taskId: string; contentVersionId: string; confirmationHash: string; remoteSnapshotHash: string; params: JsonObject }
interface HttpPublishConfirmationDependencies {
  service: MerchantService
  body: (req: IncomingMessage) => Promise<JsonObject>
  header: (req: IncomingMessage, name: string) => string | undefined
  required: (input: JsonObject, key: string) => string
  resolveWorkspace: (req: IncomingMessage, workspaceId?: unknown) => string
  enforceTaskBrandAccess: (req: IncomingMessage, task: Task, role: 'publisher') => Promise<unknown>
  requireEnabledPlatform: (workspaceId: string, platform: Platform) => Promise<unknown>
  requireCurrentPlatformMapping: (task: Task) => Promise<unknown>
  isProduction: () => boolean
  resolveTaskPublishAccount: (task: { accountId?: string | null }, requestedAccountId?: string) => string | undefined
  platformWriteReady: (platform: Platform) => boolean
  assertPublishIdempotency: (workspaceId: string, input: Omit<PublishInput, 'workspaceId' | 'params'> & { idempotencyKey: string }) => void
  hydrateDurableIdempotentJob: (workspaceId: string, entityType: 'publish_job', key: string) => Promise<unknown>
  publishAuthorizationSnapshot: (req: IncomingMessage, workspaceId: string, task: Task) => PublishAuthorization
  requirePublishAuthorizationSnapshot: (snapshot: PublishAuthorization) => PublishAuthorization
  reservePublishConfirmationTicket: (req: IncomingMessage, workspaceId: string, input: PublishInput) => Promise<{ ticket: ReserveInteractiveConfirmationTicketInput; reservation: InteractiveConfirmationTicketReservation } | undefined>
  consumePublishConfirmationTicket: (req: IncomingMessage, workspaceId: string, input: PublishInput) => Promise<unknown>
  connectorMediaUploadReady: (platform: Platform) => boolean
  persistence: () => ApiPersistence
  reserveDistributedJobSlot: (workspaceId: string, reservationId: string) => Promise<boolean>
  releaseDistributedJobSlot: (workspaceId: string, reservationId: string) => Promise<unknown>
  persistSnapshotsAndEvent: (input: { workspaceId: string; snapshots: Snapshot[]; aggregateId: string; eventType: string; sequence: number; eventPayload: Record<string, unknown> }) => Promise<unknown>
  withCommercialWorkerSnapshot: (workspaceId: string, eventType: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>
  publishEventPayload: (job: PublishJob) => Record<string, unknown>
  scheduleFixturePublishObservation: (job: PublishJob) => void
  jobWithQueueMetadata: (job: PublishJob, workspaceId: string, type: 'publish') => unknown
  send: (res: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, req: IncomingMessage) => true
}

export async function handleHttpPublishConfirmationRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: HttpPublishConfirmationDependencies): Promise<boolean> {
  const { service, body, header, required, resolveWorkspace, enforceTaskBrandAccess, requireEnabledPlatform, requireCurrentPlatformMapping, isProduction, resolveTaskPublishAccount, platformWriteReady, assertPublishIdempotency, hydrateDurableIdempotentJob, publishAuthorizationSnapshot, requirePublishAuthorizationSnapshot, reservePublishConfirmationTicket, consumePublishConfirmationTicket, reserveDistributedJobSlot, releaseDistributedJobSlot, persistSnapshotsAndEvent, withCommercialWorkerSnapshot, publishEventPayload, scheduleFixturePublishObservation, jobWithQueueMetadata, send } = deps
  const persistence = deps.persistence()
  const connectorRuntime = { mediaUploadReady: deps.connectorMediaUploadReady }
  if (req.method === 'POST' && path === '/v1/publish-jobs') {
    const input = await body(req)
    const key = header(req, 'idempotency-key')?.trim()
    if (!key) throw new DomainError(ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, '发布确认必须携带 Idempotency-Key', 400)
    const workspaceId = resolveWorkspace(req, input.workspace_id)
    const taskId = required(input, 'task_id')
    const contentVersionId = required(input, 'content_version_id')
    const confirmationHash = required(input, 'confirmation_hash')
    const remoteSnapshotHash = required(input, 'remote_snapshot_hash')
    const task = service.getTask(taskId)
    if (task.workspaceId !== workspaceId) throw new DomainError(ERROR_CODES.TENANT_SCOPE_DENIED, '无权访问该任务', 403)
    await enforceTaskBrandAccess(req, task, 'publisher')
    await requireEnabledPlatform(workspaceId, task.platform)
    await requireCurrentPlatformMapping(task)
    if (isProduction() && !((typeof input.account_id === 'string' && input.account_id.trim()) || task.accountId)) throw new DomainError('PLATFORM_ACCOUNT_REQUIRED', '生产发布必须绑定已授权平台账号', 400)
    const publishAccountId = resolveTaskPublishAccount(task, typeof input.account_id === 'string' ? input.account_id : undefined)
    if (isProduction()) {
      service.getActionablePlatformAccount(workspaceId, publishAccountId!, task.platform)
      if (!platformWriteReady(task.platform)) throw new DomainError('PLATFORM_WRITE_NOT_READY', '平台尚未完成生产写入能力验证，当前不会创建发布任务', 503)
    }
    assertPublishIdempotency(workspaceId, { taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: key })
    let existing = [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === key)
    if (!existing) {
      await hydrateDurableIdempotentJob(workspaceId, 'publish_job', key)
      existing = [...service.publishJobs.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.idempotencyKey === key)
    }
    const authorizationSnapshot = existing ? undefined : requirePublishAuthorizationSnapshot(publishAuthorizationSnapshot(req, workspaceId, task))
    const publishInput = { workspaceId, taskId, contentVersionId, confirmationHash, remoteSnapshotHash, params: input }
    const fencedTicket = existing ? undefined : await reservePublishConfirmationTicket(req, workspaceId, publishInput)
    if (!existing && !fencedTicket) await consumePublishConfirmationTicket(req, workspaceId, publishInput)
    const reservationId = `publish:${key}`
    let reserved = false
    try {
      if (existing) {
        const job = service.confirmPublish({ workspaceId, taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: key, ...(publishAccountId ? { accountId: publishAccountId } : {}), mediaAdapterReady: connectorRuntime.mediaUploadReady(task.platform), authorizationSnapshot: publishAuthorizationSnapshot(req, workspaceId, task) })
        return send(res, 202, workspaceId, jobWithQueueMetadata(job, workspaceId, 'publish'), null, req)
      }
      const job = service.confirmPublish({ workspaceId, taskId, contentVersionId, confirmationHash, remoteSnapshotHash, idempotencyKey: key, ...(publishAccountId ? { accountId: publishAccountId } : {}), mediaAdapterReady: connectorRuntime.mediaUploadReady(task.platform), authorizationSnapshot, deferCommit: true })
      const currentTask = { ...service.getTask(taskId), state: 'publishing' as const, version: service.getTask(taskId).version + 1 }
      const snapshots = [
        { entityType: 'task' as const, entityId: currentTask.id, entityVersion: currentTask.version, payload: currentTask as unknown as Record<string, unknown> },
        { entityType: 'publish_job' as const, entityId: job.id, entityVersion: job.revision, payload: job as unknown as Record<string, unknown> },
      ]
      if (fencedTicket && persistence.persistPublishTransaction) {
        await runFencedSinglePublish({
          ticketRepository: persistence.interactiveConfirmationTickets as TransactionalInteractiveConfirmationTicketRepository,
          ticket: fencedTicket.ticket,
          reservation: fencedTicket.reservation,
          consumedOperationId: job.id,
          slot: {
            reserve: async () => { reserved = await reserveDistributedJobSlot(workspaceId, reservationId) },
            release: async () => { if (reserved) await releaseDistributedJobSlot(workspaceId, reservationId); reserved = false },
          },
          persist: async ({ reservation, finalizeInTransaction }) => {
            await persistence.persistPublishTransaction!({ workspaceId, snapshots, aggregateId: job.id, eventType: 'publish.requested', sequence: 1, eventPayload: await withCommercialWorkerSnapshot(workspaceId, 'publish.requested', publishEventPayload(job)), finalizeTicketInTransaction: finalizeInTransaction })
            return { status: 'committed' as const, value: job }
          },
        })
      } else {
        reserved = existing ? false : await reserveDistributedJobSlot(workspaceId, reservationId)
        await persistSnapshotsAndEvent({ workspaceId, snapshots, aggregateId: job.id, eventType: 'publish.requested', sequence: 1, eventPayload: publishEventPayload(job) })
      }
      service.commitPublishConfirmation(job)
      scheduleFixturePublishObservation(job)
      return send(res, 202, workspaceId, jobWithQueueMetadata(job, workspaceId, 'publish'), null, req)
    } catch (error) {
      if (!(error instanceof PublishCommitStatusUnknownError)) {
        if (reserved) await releaseDistributedJobSlot(workspaceId, reservationId)
      }
      throw error
    }
  }
  return false
}
