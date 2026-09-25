import { DomainError } from '../../../packages/application/src/service.js'
import { ChargedTextNoDeliveryError, type PostgresChargedTextNoDeliveryRepository } from '../../../packages/persistence/src/charged-text-no-delivery-repository.js'

/** Called only after the MCP authorization policy and finance role check. */
export async function resolveChargedTextNoDelivery(input: {
  workspaceId: string
  params: Record<string, unknown>
  actorId: string
  repository?: Pick<PostgresChargedTextNoDeliveryRepository, 'resolve'>
}) {
  if (!input.repository) throw new DomainError('CHARGED_TEXT_RESOLUTION_UNAVAILABLE', '收费生成裁决仓储未配置', 503)
  const field = (name: string) => {
    const value = input.params[name]
    if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_REQUEST', `${name} 必须填写`, 400)
    return value.trim()
  }
  const revisionText = field('job_revision')
  if (!/^\d+$/u.test(revisionText) || !Number.isSafeInteger(Number(revisionText))) throw new DomainError('INVALID_REQUEST', 'job_revision 必须是正整数', 400)
  try {
    const resolution = await input.repository.resolve({ workspaceId: input.workspaceId, actorId: input.actorId,
      actionKey: field('action_key'), reason: field('reason'), evidenceRef: field('evidence_ref'), expectedJobRevision: Number(revisionText) })
    return { decision: 'refund_no_deliverable' as const, action_key: resolution.actionKey, job_id: resolution.jobId,
      event_id: resolution.eventId, reservation_id: resolution.reservationId, refunded_points: resolution.refundedPoints,
      provider_request_id: resolution.providerRequestId, evidence_ref: resolution.evidenceRef }
  } catch (error) {
    if (error instanceof ChargedTextNoDeliveryError) throw new DomainError(error.code, '无交付退款证据不完整或任务状态已变化，创意点保持原状态', 409)
    throw error
  }
}
