import { createHash, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { DomainError, type Task } from '../../../packages/application/src/service.js'
import { AUTHZ_POLICY_VERSION, capabilitiesForRoles, canonicalizeRole, type AuthorizationDecision, type CapabilityId } from '../../../packages/contracts/src/index.js'
import { AuthorizationRepositoryError, type AuthorizationGrant, type AuthorizationRepository, type WorkspaceMember } from '../../../packages/persistence/src/index.js'
import type { CriticalWorkerOperation, WorkerAuthorizationSnapshot } from '../../../packages/workers/src/execution-authorization.js'

type Principal = { actorId: string; identityId?: string; authorizationRevision?: number }

export interface WorkerAuthorizationRuntimeDependencies {
  getDecision: (req: IncomingMessage) => AuthorizationDecision | undefined
  getPrincipal: (req: IncomingMessage) => Principal | undefined
  getTrustedTask: (taskId: string) => Task | undefined
  getConsumedGrant: (req: IncomingMessage, workspaceId: string, capability: CapabilityId) => AuthorizationGrant | undefined
  getRequestId: (req: IncomingMessage) => string
  getTraceId: (req: IncomingMessage) => string
  getAuthorizationRepository: () => AuthorizationRepository | undefined
  requireActiveWorkspace: (workspaceId: string, method: string) => Promise<unknown>
  checkCustomerDeliveryAccess: (workspaceId: string, identityId: string) => Promise<void>
  listMembers: (workspaceId: string) => Promise<WorkspaceMember[]>
  hasBrandAccess: (input: { workspaceId: string; brandId: string; externalSubject: string; minimumRole: 'publisher' }) => Promise<boolean>
}

export function createWorkerAuthorizationRuntime(deps: WorkerAuthorizationRuntimeDependencies) {
  const { getDecision, getPrincipal, getTrustedTask, getConsumedGrant, getRequestId, getTraceId, getAuthorizationRepository, requireActiveWorkspace, checkCustomerDeliveryAccess, listMembers, hasBrandAccess } = deps
const workerOperationCapabilities: Record<CriticalWorkerOperation, CapabilityId> = {
  'publish.execute': 'customer.publish.execute',
  'publish.reconcile': 'customer.content.read',
  'generation.execute': 'customer.content.update',
  'image_generation.execute': 'customer.content.update',
  'catalog.sync.execute': 'customer.content.update',
  'asset.scan.execute': 'marketing.queue.update',
  'asset.continuation.execute': 'customer.content.update',
}

function workerAuthorizationDecisionMatches(decision: AuthorizationDecision | undefined, workspaceId: string, requiredCapability: CapabilityId, taskScope?: Pick<Task, 'id' | 'workspaceId' | 'brandId'>) {
  const resolvedScopes = decision?.scope.resolved ?? []
  const workspaceResolutionMatches = resolvedScopes.some(scope => scope.type === 'workspace' && scope.ids.includes(workspaceId))
  // Content generation is a brand-scoped MCP write. Bind that decision to
  // the already loaded task in this workspace; a caller-supplied brand ID or
  // an unrelated brand decision cannot mint a worker credential.
  const taskBrandMatches = requiredCapability === 'customer.content.update'
    && taskScope?.workspaceId === workspaceId
    && decision?.scope.required === 'brand'
    && decision.scope.resource_id === (taskScope.brandId ?? `task:${taskScope.id}`)
    && workspaceResolutionMatches
  const scopeMatches = decision?.scope.required === 'workspace'
    ? decision.scope.resource_id === workspaceId && workspaceResolutionMatches
    : taskBrandMatches || (requiredCapability === 'customer.publish.execute'
      && decision?.scope.required === 'brand'
      && typeof decision.scope.resource_id === 'string'
      && decision.scope.resource_id.trim().length > 0
      && workspaceResolutionMatches)
  return Boolean(decision
    && decision.authorized
    && decision.capability === requiredCapability
    && decision.workbench === 'workspace'
    && scopeMatches)
}

function workerAuthorizationSnapshot<T extends CriticalWorkerOperation>(req: IncomingMessage, workspaceId: string, resourceId: string, capability: T, binding: Record<string, unknown>): (WorkerAuthorizationSnapshot & { capability: T }) | undefined {
  const decision = getDecision(req)
  const principal = getPrincipal(req)
  if (!decision || !principal?.actorId || !principal.identityId || principal.authorizationRevision === undefined) return undefined
  const requiredCapability = workerOperationCapabilities[capability]
  // Worker authorization is an execution credential, not an observation of a
  // shadow deny. A shadow-mode decision may mint a snapshot only when the
  // underlying permission evaluation itself authorized the exact capability;
  // rollout mode never turns an unauthorized observation into authority.
  const taskId = typeof binding.task_id === 'string' ? binding.task_id : undefined
  const trustedTask = taskId ? getTrustedTask(taskId) : undefined
  if (!workerAuthorizationDecisionMatches(decision, workspaceId, requiredCapability, trustedTask)) return undefined
  const actionScopeHash = createHash('sha256').update(JSON.stringify({ workspaceId, resourceId, capability, binding, scope: decision.scope.required, workbench: decision.workbench })).digest('hex')
  // Bind the worker continuation to the exact grant atomically consumed by
  // this request. Selecting another active grant with the same capability can
  // create a snapshot that was never authorized by the current decision.
  const grant = getConsumedGrant(req, workspaceId, requiredCapability)
  const scopeHash = grant?.scopeHash ?? actionScopeHash
  // This opaque token is a real, repository-backed subject authorization
  // revision. It deliberately records the authority source so execution can
  // independently re-check either the membership or the temporary grant.
  const grantRevision = grant
    ? `grant:${grant.id}:${grant.revision}:${principal.identityId}:${principal.authorizationRevision}`
    : `membership:${principal.identityId}:${principal.authorizationRevision}`
  const resourceRevision = binding.resource_revision ?? binding.job_revision ?? binding.expected_asset_revision ?? binding.source_product_version ?? binding.task_version
  if (typeof resourceRevision !== 'number' && typeof resourceRevision !== 'string' || String(resourceRevision).trim() === '') return undefined
  return {
    schemaVersion: 1 as const,
    decisionId: decision.decision_id,
    actorId: principal.actorId,
    identityId: principal.identityId,
    workspaceId,
    workbench: 'workspace' as const,
    contextId: decision.scope.required === 'brand' ? `brand:${decision.scope.resource_id}` : `workspace:${workspaceId}`,
    contextVersion: decision.policy_version,
    policyVersion: decision.policy_version,
    grantRevision,
    grantIds: grant ? [grant.id] : [],
    capability,
    resourceId,
    resourceRevision: String(resourceRevision),
    requestId: getRequestId(req),
    traceId: getTraceId(req),
    authorized: true as const,
    decidedAt: new Date().toISOString(),
    scopeHash,
  }
}

function publishAuthorizationSnapshot(req: IncomingMessage, workspaceId: string, task: { version: number; id: string }) {
  return workerAuthorizationSnapshot(req, workspaceId, `pub-intent:${task.id}`, 'publish.execute', { method: 'publish.confirm', task_id: task.id, resource_revision: task.version })
}

function requirePublishAuthorizationSnapshot(snapshot: ReturnType<typeof publishAuthorizationSnapshot>, required: boolean) {
  if (!snapshot && required) throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_REQUIRED', '发布确认缺少持久身份授权快照，已拒绝扣款、占槽和入队', 503)
  return snapshot
}

function serializedWorkerAuthorizationSnapshot<T extends CriticalWorkerOperation>(snapshot: WorkerAuthorizationSnapshot & { capability: T }) {
  return { schema_version: snapshot.schemaVersion, decision_id: snapshot.decisionId, actor_id: snapshot.actorId, identity_id: snapshot.identityId, workspace_id: snapshot.workspaceId, workbench: snapshot.workbench, context_id: snapshot.contextId, context_version: snapshot.contextVersion, policy_version: snapshot.policyVersion, grant_revision: snapshot.grantRevision, grant_ids: snapshot.grantIds, scope_hash: snapshot.scopeHash, capability: snapshot.capability, resource_id: snapshot.resourceId, resource_revision: snapshot.resourceRevision, request_id: snapshot.requestId, trace_id: snapshot.traceId, authorized: snapshot.authorized, decided_at: snapshot.decidedAt }
}

const workerEventOperations: Record<string, CriticalWorkerOperation> = {
  'publish.requested': 'publish.execute',
  'publish.reconcile_requested': 'publish.reconcile',
  'generation.requested': 'generation.execute',
  'image.generation.requested': 'image_generation.execute',
  'sync.requested': 'catalog.sync.execute',
  'asset.uploaded': 'asset.scan.execute',
  'asset.generated_quarantined': 'asset.scan.execute',
  'asset.video_quarantined': 'asset.scan.execute',
  'asset.scan_redrive_requested': 'asset.scan.execute',
  'asset.generation_continuations.ready': 'asset.continuation.execute',
}

function requiresWorkerActorAuthorization(eventType: string, operation: CriticalWorkerOperation): boolean {
  return !(operation === 'asset.scan.execute'
    && ['asset.uploaded', 'asset.generated_quarantined', 'asset.video_quarantined'].includes(eventType))
}

async function recheckWorkerAuthorizationSnapshot(snapshot: WorkerAuthorizationSnapshot, workspaceId: string, resourceId: string, execution?: { eventId: string }) {
  const membershipMatch = /^membership:([^:]+):(\d+)$/u.exec(snapshot.grantRevision)
  const grantMatch = /^grant:([^:]+):(\d+):([^:]+):(\d+)$/u.exec(snapshot.grantRevision)
  if (!membershipMatch && !grantMatch) throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', '执行授权来源格式无效', 403)
  const subjectIdentityId = (membershipMatch?.[1] ?? grantMatch?.[3])!
  const expectedAuthorizationRevision = Number(membershipMatch?.[2] ?? grantMatch?.[4])
  if (snapshot.identityId !== subjectIdentityId || snapshot.workspaceId !== workspaceId || snapshot.resourceId !== resourceId) {
    throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', '执行授权快照未绑定当前身份、工作区或资源，已拒绝执行', 403)
  }
  const authzRepository = getAuthorizationRepository()
  if (!authzRepository) throw new DomainError('AUTHORIZATION_REPOSITORY_UNAVAILABLE', '执行前授权仓储不可用，已拒绝执行', 503)
  const currentAuthorizationRevision = await authzRepository.getAuthorizationRevision(subjectIdentityId)
  if (currentAuthorizationRevision !== expectedAuthorizationRevision) throw new DomainError('AUTHZ_EXECUTION_REVOKED', '入队后授权修订已变化，已拒绝执行', 403)
  // Already-dispatched receipts and security scans must still converge. New
  // merchant execution checks use the currently bound account's live evidence.
  if (!['publish.reconcile', 'asset.scan.execute'].includes(snapshot.capability)) {
    await requireActiveWorkspace(workspaceId, 'worker.dispatch')
    await checkCustomerDeliveryAccess(workspaceId, subjectIdentityId)
  }
  if (membershipMatch) {
    const members = (await listMembers(workspaceId)).filter(candidate => candidate.identityId === subjectIdentityId)
    if (members.length !== 1) throw new DomainError('AUTHZ_EXECUTION_REVOKED', '执行身份缺少唯一的当前工作区成员关系，已拒绝执行', 403)
    const member = members[0]!
    if (!member || member.status !== 'active' || member.identityId !== subjectIdentityId) throw new DomainError('AUTHZ_EXECUTION_REVOKED', '入队成员资格已失效，已拒绝执行', 403)
    const canonicalMemberRole = canonicalizeRole(member.role, 'membership')
    const requiredCapability = workerOperationCapabilities[snapshot.capability]
    if (!canonicalMemberRole || !capabilitiesForRoles([canonicalMemberRole]).includes(requiredCapability)) throw new DomainError('AUTHZ_EXECUTION_REVOKED', '当前成员角色不再具备该 worker 操作能力，已拒绝执行', 403)
    const brandContext = snapshot.capability === 'publish.execute' ? /^brand:(.+)$/u.exec(snapshot.contextId) : undefined
    if (brandContext && member.role !== 'workspace_owner') {
      const stillPublisher = await hasBrandAccess({ workspaceId, brandId: brandContext[1]!, externalSubject: member.externalSubject, minimumRole: 'publisher' })
      if (!stillPublisher) throw new DomainError('AUTHZ_EXECUTION_REVOKED', '入队后品牌发布权限已撤销，已拒绝执行', 403)
    }
  } else {
    const grant = await authzRepository.getGrant(grantMatch![1]!, subjectIdentityId)
    const expectedGrantRevision = Number(grantMatch![2])
    const requiredCapability = workerOperationCapabilities[snapshot.capability]
    if (!grant
      || !Array.isArray(snapshot.grantIds)
      || snapshot.grantIds.length !== 1
      || snapshot.grantIds[0] !== grant.id
      || grant.revision !== expectedGrantRevision
      || grant.subjectIdentityId !== subjectIdentityId
      || grant.workspaceId !== workspaceId
      || !grant.capabilities.includes(requiredCapability)
      || grant.scopeHash !== snapshot.scopeHash
      || grant.revokedAt
      || Date.parse(grant.issuedAt) > Date.now()
      || Date.parse(grant.expiresAt) <= Date.now()) {
      throw new DomainError('AUTHZ_EXECUTION_REVOKED', '入队临时授权已撤销、过期或范围变化，已拒绝执行', 403)
    }
  }
  const recheck = { recheck_id: `authz_recheck_${randomUUID()}`, actor_id: snapshot.actorId, identity_id: snapshot.identityId, workspace_id: workspaceId, workbench: snapshot.workbench, context_id: snapshot.contextId, context_version: `${AUTHZ_POLICY_VERSION}:${currentAuthorizationRevision}`, policy_version: AUTHZ_POLICY_VERSION, grant_revision: snapshot.grantRevision, grant_ids: snapshot.grantIds, scope_hash: snapshot.scopeHash, capability: snapshot.capability, resource_id: resourceId, resource_revision: snapshot.resourceRevision, request_id: snapshot.requestId, trace_id: snapshot.traceId, authorized: true, checked_at: new Date().toISOString() }
  if (!execution) return recheck
  if (!execution.eventId.trim()) throw new DomainError('AUTHZ_EXECUTION_EVENT_REQUIRED', '执行授权预留缺少持久事件标识，已拒绝执行', 503)
  let reservation: Awaited<ReturnType<AuthorizationRepository['reserveExecution']>>
  try {
    reservation = await authzRepository.reserveExecution({
      reservationId: `worker-execution:${execution.eventId}:${snapshot.capability}`,
      eventId: execution.eventId,
      decisionId: snapshot.decisionId,
      subjectIdentityId,
      workspaceId,
      capability: workerOperationCapabilities[snapshot.capability],
      resourceId,
      scopeHash: snapshot.scopeHash,
      expectedAuthorizationRevision,
      ...(grantMatch ? { grantId: grantMatch[1]!, expectedGrantRevision: Number(grantMatch[2]) } : {}),
    })
  } catch (error) {
    if (error instanceof AuthorizationRepositoryError && error.code === 'AUTHORIZATION_EXECUTION_RESERVATION_CONFLICT') {
      throw new DomainError('AUTHZ_EXECUTION_SNAPSHOT_INVALID', '执行授权预留已绑定其他决策或范围，已拒绝执行', 403, { event_id: execution.eventId, reservation_id: `worker-execution:${execution.eventId}:${snapshot.capability}` })
    }
    if (error instanceof DomainError) throw error
    throw new DomainError('AUTHZ_EXECUTION_RESERVATION_UNAVAILABLE', '执行授权预留仓储不可用，Provider 未调用', 503)
  }
  if (!reservation) throw new DomainError('AUTHZ_EXECUTION_REVOKED', '执行授权在预留提交前已变化，Provider 未调用', 403, { event_id: execution.eventId, reservation_id: `worker-execution:${execution.eventId}:${snapshot.capability}` })
  return { ...recheck, reservation_id: reservation.reservationId, event_id: reservation.eventId }
}

async function deriveWorkerContinuationAuthorizationSnapshot(
  source: WorkerAuthorizationSnapshot,
  workspaceId: string,
  resourceId: string,
  capability: CriticalWorkerOperation,
  binding: Record<string, unknown>,
): Promise<WorkerAuthorizationSnapshot> {
  if (source.capability !== 'publish.execute' || capability !== 'publish.reconcile') throw new DomainError('AUTHZ_EXECUTION_DELEGATION_INVALID', 'worker continuation 授权来源或目标操作无效', 403)
  const grantBound = source.grantRevision.startsWith('grant:')
  const candidate: WorkerAuthorizationSnapshot = {
    ...source,
    decisionId: `authz_continuation_${randomUUID()}`,
    capability,
    resourceId,
    decidedAt: new Date().toISOString(),
    scopeHash: grantBound
      ? source.scopeHash
      : createHash('sha256').update(JSON.stringify({ workspaceId, resourceId, capability, binding, sourceDecisionId: source.decisionId })).digest('hex'),
  }
  const current = await recheckWorkerAuthorizationSnapshot(candidate, workspaceId, resourceId)
  return {
    ...candidate,
    contextVersion: current.context_version,
    policyVersion: current.policy_version,
    grantRevision: current.grant_revision,
    scopeHash: current.scope_hash,
    decidedAt: current.checked_at,
  }
}

  return { workerAuthorizationDecisionMatches, workerAuthorizationSnapshot, publishAuthorizationSnapshot, requirePublishAuthorizationSnapshot, serializedWorkerAuthorizationSnapshot, workerEventOperations, requiresWorkerActorAuthorization, recheckWorkerAuthorizationSnapshot, deriveWorkerContinuationAuthorizationSnapshot }
}
