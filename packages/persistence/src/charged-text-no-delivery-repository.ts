import { randomUUID } from 'node:crypto'
import { PostgresBusinessRepository } from './business-repository.js'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export class ChargedTextNoDeliveryError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ChargedTextNoDeliveryError' }
}

export interface ChargedTextNoDeliveryResolution {
  workspaceId: string; actionKey: string; reservationId: string; jobId: string; eventId: string
  providerRequestId: string; actorId: string; reason: string; evidenceRef: string; refundedPoints: number
}
type Row = { workspace_id: string; action_key: string; reservation_id: string; job_id: string; event_id: string;
  provider_request_id: string; actor_id: string; reason: string; evidence_ref: string; refunded_points: number }
const mapped = (row: Row): ChargedTextNoDeliveryResolution => ({ workspaceId: row.workspace_id, actionKey: row.action_key,
  reservationId: row.reservation_id, jobId: row.job_id, eventId: row.event_id, providerRequestId: row.provider_request_id,
  actorId: row.actor_id, reason: row.reason, evidenceRef: row.evidence_ref, refundedPoints: row.refunded_points })
const required = (value: string, name: string, max: number): string => {
  if (!value?.trim() || value.trim() !== value || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new ChargedTextNoDeliveryError(`CHARGED_TEXT_${name}_INVALID`)
  return value
}

/** Finance-only caller resolves one proven paid text response with no delivered content.
 * The original provider usage/cost stay recorded; only customer creative points
 * are reversed. All state changes and the audit row commit in one transaction. */
export class PostgresChargedTextNoDeliveryRepository {
  private readonly lifecycle: PostgresCreativePointLifecycleRepository
  private readonly business: PostgresBusinessRepository
  constructor(private readonly pool: SqlPool) {
    this.lifecycle = new PostgresCreativePointLifecycleRepository(pool)
    this.business = new PostgresBusinessRepository(pool, { normalizedProjection: true })
  }

  async resolve(input: { workspaceId: string; actionKey: string; actorId: string; reason: string; evidenceRef: string; expectedJobRevision: number }): Promise<ChargedTextNoDeliveryResolution> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const actionKey = required(input.actionKey, 'ACTION_KEY', 255)
    const actorId = required(input.actorId, 'ACTOR', 128)
    const reason = required(input.reason, 'REASON', 1000)
    const evidenceRef = required(input.evidenceRef, 'EVIDENCE', 255)
    if (reason.length < 4 || !Number.isSafeInteger(input.expectedJobRevision) || input.expectedJobRevision < 1) throw new ChargedTextNoDeliveryError('CHARGED_TEXT_RESOLUTION_INPUT_INVALID')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      // Match the creative-point repository's lock order; parallel operators
      // serialize here and the loser sees the committed immutable resolution.
      const access = await client.query(`SELECT workspace_id FROM creative_point_access_state WHERE workspace_id=$1 FOR UPDATE`, [workspaceId])
      if (!access.rows[0]) throw new ChargedTextNoDeliveryError('CHARGED_TEXT_POINT_ACCESS_MISSING')
      const existing = await client.query<Row>(`SELECT * FROM get_charged_text_no_delivery_resolution($1,$2)`, [workspaceId, actionKey])
      if (existing.rows[0]) return mapped(existing.rows[0])
      const facts = await client.query<{ reservation_id: string; job_id: string; event_id: string; points: string | number; provider_request_id: string; relay_provider: string; job_revision: number; job_payload: Record<string, unknown>; job_state: string; job_content_id: string | null }>(`
        SELECT c.reservation_id,c.job_id,c.event_id,r.settled_points AS points,
          a.provider_request_id,worker.provider AS relay_provider,
          s.entity_version AS job_revision,s.payload AS job_payload,j.state AS job_state,j.content_version_id AS job_content_id
        FROM creative_point_action_claims c
        JOIN creative_point_reservations r ON r.workspace_id=c.workspace_id AND r.id=c.reservation_id
        JOIN generation_jobs j ON j.workspace_id=c.workspace_id AND j.id=c.job_id
        JOIN business_entity_snapshots s ON s.workspace_id=j.workspace_id AND s.entity_type='generation_job' AND s.entity_id=j.id
        JOIN outbox_events e ON e.workspace_id=c.workspace_id AND e.id=c.event_id
        JOIN charged_text_dispatch_attempts a ON a.workspace_id=c.workspace_id AND a.action_key=c.action_key AND a.event_id=c.event_id
        JOIN creative_point_provider_receipts_v2 worker ON worker.workspace_id=r.workspace_id AND worker.operation_id=r.operation_id
          AND worker.provider<>'model-relay' AND worker.provider_request_id=a.provider_request_id
        WHERE c.workspace_id=$1 AND c.action_key=$2 AND c.phase='bound'
          AND r.status='settled' AND j.state IN ('queued','running') AND j.content_version_id IS NULL
          AND e.unknown_at IS NOT NULL AND e.last_error->>'code'='CHARGED_TEXT_SCHEMA_REPAIR_DISABLED'
          AND a.state='completed' AND a.provider_request_id IS NOT NULL
          AND worker.outcome='succeeded' AND worker.verified_at IS NOT NULL
        `, [workspaceId, actionKey])
      const fact = facts.rows[0]
      if (!fact || facts.rows.length !== 1) throw new ChargedTextNoDeliveryError('CHARGED_TEXT_NO_DELIVERY_EVIDENCE_MISMATCH')
      const refundPoints = Number(fact.points)
      if (!Number.isSafeInteger(refundPoints) || refundPoints <= 0) throw new ChargedTextNoDeliveryError('CHARGED_TEXT_POINT_AMOUNT_INVALID')
      if (fact.job_revision !== input.expectedJobRevision || fact.job_payload.state !== fact.job_state || fact.job_payload.contentVersionId || fact.job_content_id) throw new ChargedTextNoDeliveryError('CHARGED_TEXT_JOB_REVISION_CONFLICT')
      const verified = await this.lifecycle.verifyModelUsageDeliverySettlementInTransaction(client, { workspaceId, reservationId: fact.reservation_id, actionId: actionKey, providerRequestId: fact.provider_request_id, relayProvider: fact.relay_provider, allowPartialPoints: true, requireText: true })
      if (!verified) throw new ChargedTextNoDeliveryError('CHARGED_TEXT_SETTLEMENT_EVIDENCE_MISMATCH')
      const observedAt = new Date().toISOString()
      await this.lifecycle.reverseSettlementInTransaction(client, {
        workspaceId, reservationId: fact.reservation_id, points: refundPoints, kind: 'refund',
        idempotencyKey: `charged-text-no-delivery:${actionKey}`, actorId, reason,
        evidence: { action_key: actionKey, event_id: fact.event_id, job_id: fact.job_id, provider_request_id: fact.provider_request_id,
          evidence_ref: evidenceRef, decision: 'refund_no_deliverable' }, at: observedAt,
      })
      const inserted = await client.query<Row>(`SELECT * FROM insert_charged_text_no_delivery_resolution($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [workspaceId, actionKey, fact.reservation_id, fact.job_id, fact.event_id, fact.provider_request_id, actorId, reason, evidenceRef, refundPoints])
      if (!inserted.rows[0]) throw new ChargedTextNoDeliveryError('CHARGED_TEXT_RESOLUTION_CONFLICT')
      const nextPayload = { ...fact.job_payload, state: 'failed', errorCode: 'CHARGED_TEXT_NO_DELIVERY_REFUNDED',
        errorMessage: '模型响应未形成可交付内容，创意点已退还', nextAttemptAt: undefined, waitingReason: undefined,
        revision: fact.job_revision + 1, updatedAt: observedAt }
      const saved = await this.business.saveInTransaction(client, { workspaceId, entityType: 'generation_job', entityId: fact.job_id,
        entityVersion: fact.job_revision + 1, payload: nextPayload })
      if (saved.entityVersion !== fact.job_revision + 1) throw new ChargedTextNoDeliveryError('CHARGED_TEXT_JOB_REVISION_CONFLICT')
      await client.query(`INSERT INTO workspace_operation_audit(id,workspace_id,actor_id,action,resource_type,resource_id,before_json,after_json,reason)
        VALUES($1,$2,$3,'ops.marketing.generation.no_delivery.refund','generation_job',$4,$5::jsonb,$6::jsonb,$7)`,
        [randomUUID(), workspaceId, actorId, fact.job_id, JSON.stringify({ state: fact.job_state, reservation_status: 'settled' }),
          JSON.stringify({ state: 'failed', refunded_points: refundPoints, action_key: actionKey, event_id: fact.event_id,
            provider_request_id: fact.provider_request_id, evidence_ref: evidenceRef }), reason])
      return mapped(inserted.rows[0])
    })
  }
}
