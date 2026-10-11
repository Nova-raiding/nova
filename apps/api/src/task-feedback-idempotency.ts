import { createHash } from 'node:crypto'
import { DomainError, type MerchantService, type TaskFeedback } from '../../../packages/application/src/service.js'

export type TaskFeedbackIdempotencyPort = {
  submit(input: { workspaceId: string; keyHash: string; requestHash: string; feedback: TaskFeedback; eventPayload: Record<string, unknown> }): Promise<{ feedback: TaskFeedback; replayed: boolean }>
}
type InMemoryFeedbackClaim = {
  requestHash: string
  result: Promise<TaskFeedback>
}
const inMemoryFeedbackClaims = new WeakMap<MerchantService, Map<string, InMemoryFeedbackClaim>>()

export async function submitTaskFeedbackIdempotently(input: {
  service: MerchantService
  repository?: TaskFeedbackIdempotencyPort
  workspaceId: string
  taskId: string
  contentVersionId?: string
  rating: 'liked' | 'neutral' | 'needs_improvement'
  reason?: string
  comment?: string
  actorId: string
  idempotencyKey: string
  production: boolean
  persistFallback: (feedback: TaskFeedback) => Promise<void>
  eventPayload: (feedback: TaskFeedback) => Record<string, unknown>
}): Promise<{ feedback: TaskFeedback; replayed: boolean }> {
  const key = input.idempotencyKey.trim()
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw new DomainError('IDEMPOTENCY_KEY_INVALID', '反馈提交必须携带 8 至 200 位字母、数字、点、下划线、冒号或短横线幂等键', 400)
  if (!input.repository) {
    if (input.production) throw new DomainError('TASK_FEEDBACK_IDEMPOTENCY_UNAVAILABLE', '反馈幂等持久化未配置，已阻断提交', 503)
    const keyHash = createHash('sha256').update(key).digest('hex')
    const normalized = { workspaceId: input.workspaceId, taskId: input.taskId, contentVersionId: input.contentVersionId ?? null, rating: input.rating, reason: input.reason?.trim() || null, comment: input.comment?.trim() || null, actorId: input.actorId.trim() || 'system' }
    const requestHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
    let claims = inMemoryFeedbackClaims.get(input.service)
    if (!claims) { claims = new Map(); inMemoryFeedbackClaims.set(input.service, claims) }
    const claimKey = `${input.workspaceId}:${keyHash}`
    const existing = claims.get(claimKey)
    if (existing) {
      if (existing.requestHash !== requestHash) throw new DomainError('IDEMPOTENCY_KEY_REUSED', '相同反馈幂等键已用于不同内容', 409)
      return { feedback: await existing.result, replayed: true }
    }
    const feedbackId = `feedback_${createHash('sha256').update(`${input.workspaceId}:${keyHash}`).digest('hex').slice(0, 32)}`
    const feedback = input.service.prepareFeedback({ workspaceId: input.workspaceId, taskId: input.taskId, ...(input.contentVersionId ? { contentVersionId: input.contentVersionId } : {}), rating: input.rating, ...(input.reason !== undefined ? { reason: input.reason } : {}), ...(input.comment !== undefined ? { comment: input.comment } : {}), actorId: input.actorId }, feedbackId)
    const result = (async () => {
      await input.persistFallback(feedback)
      input.service.hydrateSnapshot({ entityType: 'feedback', entity: feedback })
      return feedback
    })()
    const claim: InMemoryFeedbackClaim = { requestHash, result }
    claims.set(claimKey, claim)
    try {
      return { feedback: await result, replayed: false }
    } catch (error) {
      if (claims.get(claimKey) === claim) claims.delete(claimKey)
      throw error
    }
  }
  const keyHash = createHash('sha256').update(key).digest('hex')
  const normalized = {
    workspaceId: input.workspaceId, taskId: input.taskId, contentVersionId: input.contentVersionId ?? null,
    rating: input.rating, reason: input.reason?.trim() || null, comment: input.comment?.trim() || null,
    actorId: input.actorId.trim() || 'system',
  }
  const requestHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
  const feedbackId = `feedback_${createHash('sha256').update(`${input.workspaceId}:${keyHash}`).digest('hex').slice(0, 32)}`
  const feedback = input.service.prepareFeedback({
    workspaceId: input.workspaceId, taskId: input.taskId, ...(input.contentVersionId ? { contentVersionId: input.contentVersionId } : {}), rating: input.rating,
    ...(input.reason !== undefined ? { reason: input.reason } : {}), ...(input.comment !== undefined ? { comment: input.comment } : {}), actorId: input.actorId,
  }, feedbackId)
  const result = await input.repository.submit({ workspaceId: input.workspaceId, keyHash, requestHash, feedback, eventPayload: input.eventPayload(feedback) })
  input.service.hydrateSnapshot({ entityType: 'feedback', entity: result.feedback })
  return result
}
