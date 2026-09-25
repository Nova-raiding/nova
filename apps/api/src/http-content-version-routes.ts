import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type ContentVersion, type MerchantService, type Task } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import { reviewProductImages } from '../../../packages/review/src/review.js'

type JsonObject = Record<string, unknown>
type ReviewRules = Parameters<MerchantService['setReviewFindingDecision']>[1]
interface HttpContentVersionDependencies {
  service: MerchantService
  scopeTask: (req: IncomingMessage, taskId: string) => Task
  scopeContentVersion: (req: IncomingMessage, versionId: string) => { task: Task; version: ContentVersion }
  assertCanonicalTaskScopeForAction: (task: Task) => Promise<unknown>
  body: (req: IncomingMessage) => Promise<JsonObject>
  required: (input: JsonObject, key: string) => string
  rulesForTask: (workspaceId: string, task: Task) => Promise<ReviewRules>
  assertReviewDecisionPreflight: (input: { workspaceId: string; contentVersionId: string; code: string; field: string; status: string; reason?: string; expectedRevision?: number; rules?: ReviewRules }) => void
  httpOperation?: { operation: string }
  enforceHttpCommercialAccess: (req: IncomingMessage, workspaceId: string, operation: string) => Promise<unknown>
  requestActor: (req: IncomingMessage) => string
  persistSnapshot: (workspaceId: string, entityType: 'content_version' | 'task', entity: ContentVersion | Task, value: Record<string, unknown>) => Promise<void>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<void>
  persistExpiredDeliveryIfNeeded: (workspaceId: string, contentVersionId: string) => Promise<unknown>
  verifyExportedBundle: (workspaceId: string, contentVersionId: string, binaryBody: Uint8Array) => { artifact_sha256: string; manifest_hash: string; valid: boolean; scope: string }
  send: (res: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, req: IncomingMessage) => true
  sendDownload: (res: ServerResponse, content: { fileName: string; contentType: string; body: string; binaryBody?: Uint8Array }, req: IncomingMessage) => true
}

export async function handleHttpContentVersionRoutes(req: IncomingMessage, res: ServerResponse, path: string, url: URL, deps: HttpContentVersionDependencies): Promise<boolean> {
  const { service, scopeTask, scopeContentVersion, assertCanonicalTaskScopeForAction, body, required, assertReviewDecisionPreflight, enforceHttpCommercialAccess, requestActor, persistSnapshot, persistEvent, persistExpiredDeliveryIfNeeded, verifyExportedBundle, send, sendDownload } = deps
  const evaluationRules = (workspaceId: string, task: Task) => deps.rulesForTask(workspaceId, task)
  const httpOperationPolicy = deps.httpOperation
  const approvalMatch = path.match(/^\/v1\/tasks\/([^/]+)\/approve$/)
  if (req.method === 'POST' && approvalMatch) {
    const task = scopeTask(req, approvalMatch[1]!)
    await assertCanonicalTaskScopeForAction(task)
    const input = await body(req)
    const approved = service.approveContent(approvalMatch[1]!, required(input, 'content_version_id'), await evaluationRules(task.workspaceId, task), typeof input.expected_version === 'number' ? input.expected_version : undefined)
    await persistSnapshot(task.workspaceId, 'content_version', approved.version, approved.version as unknown as Record<string, unknown>)
    await persistSnapshot(task.workspaceId, 'task', approved.task, approved.task as unknown as Record<string, unknown>)
    await persistEvent(task.workspaceId, approved.version.id, 'content.approved', approved.version.revision, { task_id: approved.task.id, content_version_id: approved.version.id, version: approved.version.version })
    return send(res, 200, task.workspaceId, approved, null, req)
  }
  const versionDiffMatch = path.match(/^\/v1\/content-versions\/([^/]+)\/diff$/)
  if (req.method === 'GET' && versionDiffMatch) {
    const scoped = scopeContentVersion(req, versionDiffMatch[1]!)
    const against = url.searchParams.get('against') ?? url.searchParams.get('against_version_id') ?? undefined
    return send(res, 200, scoped.task.workspaceId, service.diffContentVersions(scoped.task.workspaceId, scoped.version.id, against), null, req)
  }
  const versionModifyMatch = path.match(/^\/v1\/content-versions\/([^/]+)\/modify$/)
  if (req.method === 'POST' && versionModifyMatch) {
    const scoped = scopeContentVersion(req, versionModifyMatch[1]!)
    await assertCanonicalTaskScopeForAction(scoped.task)
    const input = await body(req)
    const lockedFields = Array.isArray(input.locked_fields) ? input.locked_fields.filter((value): value is string => typeof value === 'string') : undefined
    const reason = typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : 'user_edit'
    const modified = typeof input.module_key === 'string' && input.module_key.trim()
      ? service.regenerateContentModule({ workspaceId: scoped.task.workspaceId, sourceVersionId: scoped.version.id, moduleKey: input.module_key, ...(lockedFields ? { lockedFields } : {}), reason, ...(typeof input.expected_revision === 'number' ? { expectedRevision: input.expected_revision } : {}) })
      : (() => {
        if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'changes 必须是对象', 400)
        return service.modifyContentVersion({ workspaceId: scoped.task.workspaceId, sourceVersionId: scoped.version.id, changes: input.changes as Partial<import('../../../packages/application/src/service.js').ContentVersion['body']>, ...(lockedFields ? { lockedFields } : {}), reason, ...(typeof input.expected_revision === 'number' ? { expectedRevision: input.expected_revision } : {}) })
      })()
    await persistSnapshot(scoped.task.workspaceId, 'content_version', modified.version, modified.version as unknown as Record<string, unknown>)
    await persistSnapshot(scoped.task.workspaceId, 'task', modified.task, modified.task as unknown as Record<string, unknown>)
    await persistEvent(scoped.task.workspaceId, modified.version.id, 'content.version_modified', modified.version.revision, { task_id: modified.task.id, source_version_id: modified.source.id, content_version_id: modified.version.id, reason: modified.version.versionVector?.reason, locked_fields: modified.version.lockedFields ?? [] })
    return send(res, 201, scoped.task.workspaceId, modified, null, req)
  }
  const versionReviewMatch = path.match(/^\/v1\/content-versions\/([^/]+)\/review$/)
  if (req.method === 'GET' && versionReviewMatch) {
    const scoped = scopeContentVersion(req, versionReviewMatch[1]!)
    await assertCanonicalTaskScopeForAction(scoped.task)
    const report = service.reviewContentReport(scoped.task.workspaceId, scoped.version.id, await evaluationRules(scoped.task.workspaceId, scoped.task))
    const imageFindings = reviewProductImages(service.products.get(scoped.task.productId)?.images)
    const existingKeys = new Set(report.findings.map(finding => `${finding.code}:${finding.field}`))
    return send(res, 200, scoped.task.workspaceId, { ...report, findings: [...report.findings, ...imageFindings.filter(finding => !existingKeys.has(`${finding.code}:${finding.field}`))] }, null, req)
  }
  const versionReviewDecisionMatch = path.match(/^\/v1\/content-versions\/([^/]+)\/review-decisions$/)
  if (req.method === 'POST' && versionReviewDecisionMatch) {
    const scoped = scopeContentVersion(req, versionReviewDecisionMatch[1]!)
    await assertCanonicalTaskScopeForAction(scoped.task)
    const input = await body(req)
    const status = required(input, 'status')
    if (!['acknowledged', 'waived'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'status 必须是 acknowledged 或 waived', 400)
    const reviewRules = await evaluationRules(scoped.task.workspaceId, scoped.task)
    assertReviewDecisionPreflight({ workspaceId: scoped.task.workspaceId, contentVersionId: scoped.version.id, code: required(input, 'code'), field: required(input, 'field'), status, ...(typeof input.reason === 'string' ? { reason: input.reason } : {}), ...(typeof input.expected_revision === 'number' ? { expectedRevision: input.expected_revision } : {}), rules: reviewRules })
    // `POST /v1/content-versions/{id}/review-decisions` is deferred from the
    // shared HTTP gate, so it re-runs the same effective gate here, before the
    // durable write, exactly like `PUT /v1/assets/{id}/preference`.
    if (httpOperationPolicy) await enforceHttpCommercialAccess(req, scoped.task.workspaceId, httpOperationPolicy.operation)
    const decided = service.setReviewFindingDecision({ workspaceId: scoped.task.workspaceId, contentVersionId: scoped.version.id, code: required(input, 'code'), field: required(input, 'field'), status: status as 'acknowledged' | 'waived', ...(typeof input.reason === 'string' ? { reason: input.reason } : {}), actorId: requestActor(req), ...(typeof input.expected_revision === 'number' ? { expectedRevision: input.expected_revision } : {}) }, reviewRules)
    await persistSnapshot(scoped.task.workspaceId, 'content_version', decided.version, decided.version as unknown as Record<string, unknown>)
    await persistEvent(scoped.task.workspaceId, decided.version.id, 'content.review_decided', decided.version.revision, { content_version_id: decided.version.id, finding_key: decided.decision.key, status: decided.decision.status, reason: decided.decision.reason, actor_id: decided.decision.actorId })
    return send(res, 200, scoped.task.workspaceId, decided, null, req)
  }
  const versionRestoreMatch = path.match(/^\/v1\/content-versions\/([^/]+)\/restore$/)
  if (req.method === 'POST' && versionRestoreMatch) {
    const scoped = scopeContentVersion(req, versionRestoreMatch[1]!)
    await assertCanonicalTaskScopeForAction(scoped.task)
    const input = await body(req)
    const restored = service.restoreContentVersion(scoped.task.workspaceId, scoped.version.id, typeof input.expected_version === 'number' ? input.expected_version : undefined)
    await persistSnapshot(scoped.task.workspaceId, 'content_version', restored.version, restored.version as unknown as Record<string, unknown>)
    await persistSnapshot(scoped.task.workspaceId, 'task', restored.task, restored.task as unknown as Record<string, unknown>)
    await persistEvent(scoped.task.workspaceId, restored.version.id, 'content.version_restored', restored.version.revision, { task_id: restored.task.id, source_version_id: restored.source.id, content_version_id: restored.version.id, version: restored.version.version })
    return send(res, 201, scoped.task.workspaceId, restored, null, req)
  }
  const versionExportMatch = path.match(/^\/v1\/content-versions\/([^/]+)\/export$/)
  if (req.method === 'GET' && versionExportMatch) {
    const scoped = scopeContentVersion(req, versionExportMatch[1]!)
    const requestedFormat = url.searchParams.get('format') ?? 'bundle'
    if (!['manifest', 'json', 'markdown', 'bundle'].includes(requestedFormat)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'format 必须是 manifest、json、markdown 或 bundle', 400)
    await persistExpiredDeliveryIfNeeded(scoped.task.workspaceId, scoped.version.id)
    const exported = service.exportContent(scoped.task.workspaceId, scoped.version.id, requestedFormat as 'manifest' | 'json' | 'markdown' | 'bundle')
    if (exported.binaryBody) {
      const verification = verifyExportedBundle(scoped.task.workspaceId, scoped.version.id, exported.binaryBody)
      res.setHeader('x-delivery-bundle-sha256', verification.artifact_sha256)
      res.setHeader('x-delivery-manifest-sha256', verification.manifest_hash)
      res.setHeader('x-delivery-bundle-verified', String(verification.valid))
      res.setHeader('x-delivery-verification-scope', verification.scope)
    }
    return sendDownload(res, exported, req)
  }
  return false
}
