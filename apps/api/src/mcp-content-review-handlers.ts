import type { IncomingMessage } from 'node:http'
import { DomainError, type ContentVersion, type MerchantService, type Task } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

type JsonObject = Record<string, unknown>
type ScopedContent = { version: ContentVersion; task: Task }
type ReviewRules = Parameters<MerchantService['setReviewFindingDecision']>[1]

export interface McpContentReviewDependencies {
  service: MerchantService
  required: (params: JsonObject, name: string) => string
  scopeContentVersion: (req: IncomingMessage, contentVersionId: string) => ScopedContent
  assertCanonicalTaskScopeForAction: (task: Task) => Promise<unknown>
  rulesForTask: (workspaceId: string, task: Task) => Promise<ReviewRules>
  assertReviewDecisionPreflight: (input: { workspaceId: string; contentVersionId: string; code: string; field: string; status: string; reason?: string; expectedRevision?: number; rules?: ReviewRules }) => void
  enforceMcpCommercialAccess: (req: IncomingMessage, workspaceId: string, method: string) => Promise<unknown>
  requestActor: (req: IncomingMessage) => string
  persistSnapshot: (workspaceId: string, entityType: 'content_version', entity: ContentVersion, value: Record<string, unknown>) => Promise<void>
  persistEvent: (workspaceId: string, aggregateId: string, eventType: string, sequence: number, payload: Record<string, unknown>) => Promise<void>
}

export async function handleMcpContentReview(method: string, params: JsonObject, req: IncomingMessage, workspaceId: string, deps: McpContentReviewDependencies): Promise<unknown> {
  const { service, required, scopeContentVersion, assertCanonicalTaskScopeForAction, rulesForTask, assertReviewDecisionPreflight, enforceMcpCommercialAccess, requestActor, persistSnapshot, persistEvent } = deps
  switch (method) {
    case 'content.review': {
      const scoped = scopeContentVersion(req, required(params, 'content_version_id'))
      await assertCanonicalTaskScopeForAction(scoped.task)
      return (service.reviewContentReport(workspaceId, scoped.version.id, await rulesForTask(workspaceId, scoped.task)))
    }
    case 'content.review.decide': {
      const scoped = scopeContentVersion(req, required(params, 'content_version_id'))
      await assertCanonicalTaskScopeForAction(scoped.task)
      const status = required(params, 'status')
      if (!['acknowledged', 'waived'].includes(status)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'status 必须是 acknowledged 或 waived', 400)
      const reviewRules = await rulesForTask(workspaceId, scoped.task)
      assertReviewDecisionPreflight({ workspaceId, contentVersionId: scoped.version.id, code: required(params, 'code'), field: required(params, 'field'), status, ...(typeof params.reason === 'string' ? { reason: params.reason } : {}), ...(typeof params.expected_revision === 'string' && /^\d+$/u.test(params.expected_revision) ? { expectedRevision: Number(params.expected_revision) } : {}), rules: reviewRules })
      // This operation is excluded from the central gate above, so it re-runs
      // the effective gate here, immediately before the durable write. Without
      // it a workspace with an unknown or exhausted balance could still waive
      // blocking review findings and unlock publishing.
      await enforceMcpCommercialAccess(req, workspaceId, method)
      const decided = service.setReviewFindingDecision({ workspaceId, contentVersionId: scoped.version.id, code: required(params, 'code'), field: required(params, 'field'), status: status as 'acknowledged' | 'waived', ...(typeof params.reason === 'string' ? { reason: params.reason } : {}), actorId: requestActor(req), ...(typeof params.expected_revision === 'string' && /^\d+$/u.test(params.expected_revision) ? { expectedRevision: Number(params.expected_revision) } : {}) }, reviewRules)
      await persistSnapshot(workspaceId, 'content_version', decided.version, decided.version as unknown as Record<string, unknown>)
      await persistEvent(workspaceId, decided.version.id, 'content.review_decided', decided.version.revision, { content_version_id: decided.version.id, finding_key: decided.decision.key, status: decided.decision.status, reason: decided.decision.reason, actor_id: decided.decision.actorId })
      return (decided)
    }
    default: throw new DomainError(ERROR_CODES.INVALID_REQUEST, `未知内容审核 MCP 方法: ${method}`, 400)
  }
}
