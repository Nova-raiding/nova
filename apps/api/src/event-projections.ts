import { createHash } from 'node:crypto'
import type { PublishJob, TaskFeedback } from '../../../packages/application/src/service.js'

export function taskFeedbackEventPayload(feedback: TaskFeedback): Record<string, unknown> {
  const payload = feedback as unknown as Record<string, unknown>
  if (feedback.rating !== 'needs_improvement') return payload
  return {
    ...payload,
    knowledge_observation: {
      workspaceId: feedback.workspaceId,
      kind: 'feedback',
      sourceKey: `task_feedback:${feedback.id}`,
      ...(feedback.contentVersionId ? { contentId: feedback.contentVersionId } : {}),
      reason: feedback.reason ?? feedback.comment ?? '商家要求改进内容',
      ...(feedback.comment && feedback.comment !== feedback.reason ? { details: feedback.comment } : {}),
      metadata: { task_id: feedback.taskId, rating: feedback.rating, actor_id: feedback.actorId },
      createdAt: feedback.createdAt,
    },
  }
}

export function publishRejectionKnowledgeObservation(
  job: PublishJob,
  canonicalJson: (value: unknown) => string,
): Record<string, unknown> | undefined {
  if (!job.rejection || job.remoteState !== 'rejected') return undefined
  const rejectionPayload = {
    raw_code: job.rejection.rawCode,
    ...(job.rejection.message ? { message: job.rejection.message } : {}),
    fields: job.rejection.fields.map(field => ({ path: field.path, ...(field.rawCode ? { raw_code: field.rawCode } : {}), message: field.message })),
  }
  const rejectionHash = createHash('sha256').update(canonicalJson(rejectionPayload)).digest('hex').slice(0, 24)
  return {
    workspaceId: job.workspaceId,
    kind: 'platform_rejection',
    sourceKey: `publish_rejection:${job.id}:${rejectionHash}`,
    platform: job.platform,
    contentId: job.contentVersionId,
    reason: job.rejection.message ?? job.rejection.rawCode ?? '平台驳回发布内容',
    ...(job.rejection.fields.length ? { details: job.rejection.fields.map(field => `${field.path}: ${field.message}`).join('\n') } : {}),
    metadata: { task_id: job.taskId, publish_job_id: job.id, ...(job.rejection.rawCode ? { raw_code: job.rejection.rawCode } : {}) },
    createdAt: job.remoteObservedAt ?? job.createdAt,
  }
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
