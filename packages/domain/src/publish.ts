import { err, ok, type Result } from './result.js'
import type { DomainRuntime } from './clock.js'

export type PublishState = 'prepared' | 'confirmed' | 'queued' | 'submitting' | 'submitted' | 'reviewing' | 'published' | 'rejected' | 'unknown' | 'reconciling' | 'manual_attention'
export type ReconcileRemoteStatus = 'absent' | 'accepted' | 'reviewing' | 'published' | 'rejected' | 'unknown'

export interface ConfirmationToken {
  readonly value: string
  readonly workspaceId: string
  readonly platform: string
  readonly taskId: string
  readonly contentVersionId: string
  readonly remoteSnapshotHash: string
  readonly confirmationHash: string
  readonly issuedAt: string
  readonly expiresAt: string
}

export interface PublishJob {
  readonly id: string
  readonly workspaceId: string
  readonly taskId: string
  readonly contentVersionId: string
  readonly platform: string
  readonly idempotencyKey: string
  readonly confirmationHash: string
  readonly remoteSnapshotHash: string
  readonly confirmationTokenValue: string
  readonly state: PublishState
  readonly attempt: number
  readonly createdAt: string
}

const transitions: Readonly<Record<PublishState, readonly PublishState[]>> = {
  prepared: ['confirmed'], confirmed: ['queued'], queued: ['submitting'], submitting: ['submitted', 'rejected', 'unknown'],
  submitted: ['reviewing', 'published'], reviewing: ['published', 'rejected'], published: [], rejected: [],
  unknown: ['reconciling'], reconciling: ['submitted', 'reviewing', 'published', 'rejected', 'manual_attention'], manual_attention: [],
}

export const issueConfirmationToken = (input: Omit<ConfirmationToken, 'value' | 'issuedAt'>, runtime: DomainRuntime): ConfirmationToken =>
  Object.freeze({ ...input, value: runtime.nextId('confirm'), issuedAt: runtime.now() })

export const confirmPublish = (
  token: ConfirmationToken,
  input: { workspaceId: string; taskId: string; contentVersionId: string; confirmationHash: string; remoteSnapshotHash: string; idempotencyKey: string },
  existingByIdempotency: ReadonlyMap<string, PublishJob>,
  runtime: DomainRuntime,
  existingByToken: ReadonlyMap<string, PublishJob>,
): Result<PublishJob> => {
  const existing = existingByIdempotency.get(input.idempotencyKey)
  if (existing) {
    const sameIntent = existing.taskId === input.taskId && existing.contentVersionId === input.contentVersionId && existing.confirmationHash === input.confirmationHash && existing.remoteSnapshotHash === input.remoteSnapshotHash
    return sameIntent ? ok(existing) : err('PUBLISH_IDEMPOTENCY_CONFLICT', 'idempotency key is already bound to another publish intent')
  }
  if (token.workspaceId !== input.workspaceId || token.taskId !== input.taskId || token.contentVersionId !== input.contentVersionId || token.confirmationHash !== input.confirmationHash || token.remoteSnapshotHash !== input.remoteSnapshotHash) {
    return err('PUBLISH_CONFIRMATION_STALE', 'confirmation token does not match the current content or remote snapshot')
  }
  if (existingByToken.has(token.value)) return err('PUBLISH_CONFIRMATION_REPLAYED', 'confirmation token has already been consumed')
  if (!input.workspaceId || !input.idempotencyKey.trim()) return err('PUBLISH_CONFIRMATION_REQUIRED', 'workspace and idempotency key are required')
  if (!token.value) return err('PUBLISH_CONFIRMATION_REQUIRED', 'a one-time confirmation token is required')
  if (runtime.now() >= token.expiresAt) return err('PUBLISH_CONFIRMATION_EXPIRED', 'confirmation token has expired')
  return ok(Object.freeze({
    id: runtime.nextId('publish'), workspaceId: input.workspaceId, taskId: input.taskId, contentVersionId: input.contentVersionId,
    platform: token.platform, idempotencyKey: input.idempotencyKey, confirmationHash: input.confirmationHash,
    remoteSnapshotHash: input.remoteSnapshotHash, confirmationTokenValue: token.value, state: 'confirmed', attempt: 1, createdAt: runtime.now(),
  }))
}

export const transitionPublishJob = (job: PublishJob, next: PublishState): Result<PublishJob> => {
  if (!transitions[job.state].includes(next)) {
    return err('PUBLISH_INVALID_TRANSITION', `publish job ${job.state} cannot transition to ${next}`, { from: job.state, to: next })
  }
  return ok(Object.freeze({ ...job, state: next }))
}

export const retryPublishJob = (job: PublishJob): Result<PublishJob> => {
  if (job.state === 'unknown') return err('PUBLISH_UNKNOWN_REQUIRES_RECONCILIATION', 'unknown publish jobs must be reconciled before retry')
  return err('PUBLISH_INVALID_TRANSITION', `publish job ${job.state} is not retryable by this command`)
}

export const startReconciliation = (job: PublishJob): Result<PublishJob> => {
  if (job.state !== 'unknown') return err('PUBLISH_RECONCILIATION_REQUIRED', 'only unknown jobs can enter reconciliation')
  return transitionPublishJob(job, 'reconciling')
}

export const reconcilePublishJob = (job: PublishJob, remote: ReconcileRemoteStatus): Result<PublishJob> => {
  if (job.state !== 'reconciling') return err('PUBLISH_RECONCILIATION_REQUIRED', 'job must be reconciling before a remote result is applied')
  const next: PublishState = remote === 'absent' ? 'manual_attention' : remote === 'accepted' ? 'submitted' : remote
  if (next === 'unknown') return ok(job)
  return transitionPublishJob(job, next)
}
