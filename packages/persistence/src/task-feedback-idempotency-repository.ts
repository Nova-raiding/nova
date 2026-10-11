import { PostgresBusinessRepository } from './business-repository.js'
import { PostgresOutboxRepository, withWorkspaceTransaction, type SqlPool } from './repository.js'

export class TaskFeedbackIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED'
  constructor() {
    super('该反馈幂等键已用于不同内容，请刷新后重新提交')
    this.name = 'TaskFeedbackIdempotencyConflictError'
  }
}

export interface DurableTaskFeedback {
  id: string
  workspaceId: string
  taskId: string
  contentVersionId?: string
  rating: 'liked' | 'neutral' | 'needs_improvement'
  reason?: string
  comment?: string
  actorId: string
  createdAt: string
  revision: number
}

export interface IdempotentTaskFeedbackInput {
  workspaceId: string
  keyHash: string
  requestHash: string
  feedback: DurableTaskFeedback
  eventPayload: Record<string, unknown>
}

/** Atomically claims a feedback key, stores its durable projection and snapshot, and appends both outbox events. */
export class TaskFeedbackIdempotencyRepository {
  constructor(private readonly pool: SqlPool, private readonly business: PostgresBusinessRepository, private readonly outbox: PostgresOutboxRepository) {}

  async submit(input: IdempotentTaskFeedbackInput): Promise<{ feedback: DurableTaskFeedback; replayed: boolean }> {
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const feedback = input.feedback
      const inserted = await client.query<{ data: DurableTaskFeedback }>(
        `INSERT INTO task_feedback (id, workspace_id, task_id, content_version_id, rating, reason, comment, actor_id, created_at, data, idempotency_key_hash, request_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::jsonb,$11,$12)
         ON CONFLICT (workspace_id, idempotency_key_hash) WHERE idempotency_key_hash IS NOT NULL DO NOTHING
         RETURNING data`,
        [feedback.id, input.workspaceId, feedback.taskId, feedback.contentVersionId ?? null, feedback.rating, feedback.reason ?? null, feedback.comment ?? null, feedback.actorId, feedback.createdAt, JSON.stringify(feedback), input.keyHash, input.requestHash],
      )
      if (!inserted.rows[0]) {
        const existing = await client.query<{ request_hash: string; data: DurableTaskFeedback }>(
          'SELECT request_hash, data FROM task_feedback WHERE workspace_id=$1 AND idempotency_key_hash=$2 LIMIT 1',
          [input.workspaceId, input.keyHash],
        )
        if (!existing.rows[0]) throw new Error('TASK_FEEDBACK_IDEMPOTENCY_CLAIM_DISAPPEARED')
        if (existing.rows[0].request_hash !== input.requestHash) throw new TaskFeedbackIdempotencyConflictError()
        return { feedback: existing.rows[0].data, replayed: true }
      }

      const saved = await this.business.saveInTransaction(client, {
        workspaceId: input.workspaceId,
        entityType: 'feedback',
        entityId: feedback.id,
        entityVersion: feedback.revision,
        payload: feedback as unknown as Record<string, unknown>,
      })
      if (saved.entityVersion !== feedback.revision) throw new Error('TASK_FEEDBACK_SNAPSHOT_VERSION_CONFLICT')
      await this.outbox.appendInTransaction(client, {
        workspaceId: input.workspaceId, aggregateId: feedback.id, eventType: 'state.snapshot', sequence: feedback.revision,
        payload: { entityType: 'feedback', entity: feedback as unknown as Record<string, unknown> },
      })
      await this.outbox.appendInTransaction(client, {
        workspaceId: input.workspaceId, aggregateId: feedback.id, eventType: 'task_feedback_submitted', sequence: feedback.revision,
        payload: input.eventPayload,
      })
      return { feedback, replayed: false }
    })
  }
}
