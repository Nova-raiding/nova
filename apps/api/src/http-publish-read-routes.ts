import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type MerchantService, type PublishJob, type Task, type Platform } from '../../../packages/application/src/service.js'

type Snapshot = { entityType: 'task'; entityId: string; entityVersion: number; payload: Record<string, unknown> }
interface HttpPublishReadDependencies {
  service: MerchantService
  scopeTask: (req: IncomingMessage, taskId: string) => Task
  assertCanonicalTaskScopeForAction: (task: Task) => Promise<{ canonicalReadRevision?: string } | undefined>
  requireEnabledPlatform: (workspaceId: string, platform: Platform) => Promise<unknown>
  requireCurrentPlatformMapping: (task: Task) => Promise<{ mappedPayloadHash: string } | undefined>
  requireCurrentPublishReview: (workspaceId: string, task: Task) => Promise<unknown>
  isProduction: () => boolean
  fixtureMode: boolean
  persistSnapshotsAndEvent: (input: { workspaceId: string; snapshots: Snapshot[]; aggregateId: string; eventType: string; sequence: number; eventPayload: Record<string, unknown> }) => Promise<unknown>
  resolveWorkspace: (req: IncomingMessage, workspaceId?: string) => string
  enforceTaskBrandAccess: (req: IncomingMessage, task: Task, role: 'viewer') => Promise<unknown>
  jobWithQueueMetadata: (job: PublishJob, workspaceId: string, type: 'publish') => Record<string, unknown>
  projectPublishWorkflow: (workspaceId: string, job: PublishJob) => unknown
  send: (res: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, req: IncomingMessage) => true
}

export async function handleHttpPublishReadRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: HttpPublishReadDependencies): Promise<boolean> {
  const { service, scopeTask, assertCanonicalTaskScopeForAction, requireEnabledPlatform, requireCurrentPlatformMapping, requireCurrentPublishReview, isProduction, fixtureMode, persistSnapshotsAndEvent, resolveWorkspace, enforceTaskBrandAccess, jobWithQueueMetadata, projectPublishWorkflow, send } = deps
  const prepareMatch = path.match(/^\/v1\/tasks\/([^/]+)\/publish-preview$/)
  if (req.method === 'POST' && prepareMatch) {
    const task = scopeTask(req, prepareMatch[1]!)
    const canonicalProof = await assertCanonicalTaskScopeForAction(task)
    await requireEnabledPlatform(task.workspaceId, task.platform)
    const mappingPreflight = await requireCurrentPlatformMapping(task)
    if ((isProduction() || fixtureMode) && !task.accountId) throw new DomainError('STORE_SELECTION_REQUIRED', '发布前必须明确选择商品所属店铺', 409)
    const currentRuleReview = await requireCurrentPublishReview(task.workspaceId, task)
    const taskBeforePrepare = structuredClone(task)
    const preview = service.preparePublish(prepareMatch[1]!)
    if (canonicalProof?.canonicalReadRevision && preview.task.pendingPublish) preview.task.pendingPublish.canonicalReadRevision = canonicalProof.canonicalReadRevision
    try {
      await persistSnapshotsAndEvent({ workspaceId: task.workspaceId, snapshots: [{ entityType: 'task', entityId: preview.task.id, entityVersion: preview.task.version, payload: preview.task as unknown as Record<string, unknown> }], aggregateId: preview.task.id, eventType: 'publish.prepared', sequence: preview.task.version, eventPayload: { task_id: preview.task.id, content_version_id: preview.version.id, confirmation_hash: preview.confirmationHash, remote_snapshot_hash: preview.remoteSnapshotHash, payload_hash: preview.payloadHash, selection_hash: preview.selectionHash, selected_count: preview.visualPreview.count, image_mode: preview.visualPreview.imageMode } })
    } catch (error) {
      service.tasks.set(task.id, taskBeforePrepare)
      throw error
    }
    return send(res, 200, task.workspaceId, { ...preview, currentRuleReview, ...(mappingPreflight ? { mappingPreflight: { publishable: true, confirmationValid: true, mappedPayloadHash: mappingPreflight.mappedPayloadHash } } : {}) }, null, req)
  }
  const publishGetMatch = path.match(/^\/v1\/publish-jobs\/([^/]+)$/)
  if (req.method === 'GET' && publishGetMatch) {
    const job = service.getPublishJob(publishGetMatch[1]!)
    const workspaceId = resolveWorkspace(req, job.workspaceId)
    await enforceTaskBrandAccess(req, service.getTask(job.taskId), 'viewer')
    return send(res, 200, workspaceId, { ...jobWithQueueMetadata(job, workspaceId, 'publish'), workflow: projectPublishWorkflow(workspaceId, job) }, null, req)
  }
  return false
}
