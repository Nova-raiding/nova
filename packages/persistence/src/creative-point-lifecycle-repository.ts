import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

const validEvidenceRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const finiteNonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const validUsageEvidence = (value: unknown): boolean => {
  if (!validEvidenceRecord(value) || typeof value.modality !== 'string' || !['text', 'image', 'image_edit', 'ocr', 'video'].includes(value.modality) || typeof value.model !== 'string' || !value.model.trim()) return false
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens'] as const) if (value[key] !== undefined && (!finiteNonNegative(value[key]) || !Number.isSafeInteger(value[key]))) return false
  return true
}
const validCostEvidence = (value: unknown): boolean => validEvidenceRecord(value) && value.currency === 'CNY' && finiteNonNegative(value.actual)
import { CreativePointRepositoryError, type CreativePointBalance } from './creative-point-repository.js'

type MutationInput = { workspaceId: string; idempotencyKey: string; at: string }
export type CreativePointReversalInput = MutationInput & { reservationId: string; points: number; kind: 'refund' | 'reverse'; actorId: string; reason: string; evidence: Record<string, unknown> }
export type CreativePointExpiryInput = MutationInput & { grantId: string }
export type CreativePointAdjustmentInput = MutationInput & { approvalId: string; pointsDelta: number; expectedAccessRevision: number; actorId: string; approvedByActorId: string; reason: string; evidence: Record<string, unknown>; expiresAt?: string | null }
export type CreativePointProviderReceiptInput = { workspaceId: string; operationId: string; provider: string; providerRequestId: string; outcome: 'succeeded' | 'failed' | 'unknown'; usage?: Record<string, unknown>; cost?: Record<string, unknown>; receiptHash: string; verifiedAt?: string; at: string }
export type ModelUsageDeliverySettlementInput = { workspaceId: string; reservationId: string; actionId: string; providerRequestId: string; relayProvider: string; allowPartialPoints?: boolean; requireText?: boolean }

function required(value: string, field: string): string { if (!value || value.trim() !== value) throw new TypeError(`${field} is required`); return value }
function at(value: string): string { const parsed = new Date(value); if (Number.isNaN(parsed.valueOf())) throw new TypeError('at must be an ISO timestamp'); return parsed.toISOString() }
function points(value: number, field = 'points'): number { if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive integer`); return value }
function evidence(value: Record<string, unknown>): Record<string, unknown> { if (!value || Object.keys(value).length === 0) throw new TypeError('evidence is required'); return value }
function integer(value: string | number): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'creative point value is invalid'); return parsed }
function validateAdjustment(input: CreativePointAdjustmentInput) {
  const workspaceId = requireWorkspaceScope(input.workspaceId); const observedAt = at(input.at)
  if (!Number.isSafeInteger(input.pointsDelta) || input.pointsDelta === 0) throw new TypeError('pointsDelta must be a non-zero integer')
  if (!Number.isSafeInteger(input.expectedAccessRevision) || input.expectedAccessRevision < 0) throw new TypeError('expectedAccessRevision is invalid')
  required(input.approvalId, 'approvalId'); required(input.idempotencyKey, 'idempotencyKey'); required(input.actorId, 'actorId'); required(input.approvedByActorId, 'approvedByActorId'); required(input.reason, 'reason'); evidence(input.evidence)
  if (input.actorId === input.approvedByActorId) throw new CommercialAdjustmentApprovalError('adjustment maker and approver must be different actors')
  const request = { approval_id: input.approvalId, points_delta: input.pointsDelta, expected_access_revision: input.expectedAccessRevision, actor_id: input.actorId, approved_by_actor_id: input.approvedByActorId, reason: input.reason, evidence: input.evidence }
  return { workspaceId, observedAt, request }
}

type StateRow = { available: string | number; reserved: string | number; settled: string | number; revision: string | number }
const balance = (workspaceId: string, row: StateRow): CreativePointBalance => ({ workspaceId, availablePoints: integer(row.available), reservedPoints: integer(row.reserved), settledPoints: integer(row.settled), revision: integer(row.revision) })

/** Append-only lifecycle commands not covered by the reserve/settle repository. */
export class PostgresCreativePointLifecycleRepository {
  constructor(private readonly pool: SqlPool) {}

  async reverseSettlement(input: CreativePointReversalInput): Promise<CreativePointBalance> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const observedAt = at(input.at); points(input.points)
    required(input.idempotencyKey, 'idempotencyKey'); required(input.reservationId, 'reservationId'); required(input.actorId, 'actorId'); required(input.reason, 'reason'); evidence(input.evidence)
    const request = { reservation_id: input.reservationId, points: input.points, reason: input.reason, actor_id: input.actorId, evidence: input.evidence }
    return withWorkspaceTransaction(this.pool, workspaceId, client => this.reverseSettlementInTransaction(client, input, observedAt, request))
  }

  /** Used when a generation outcome and its point refund must commit together. */
  async reverseSettlementInTransaction(client: SqlClient, input: CreativePointReversalInput, observedAt = at(input.at), request = { reservation_id: input.reservationId, points: input.points, reason: input.reason, actor_id: input.actorId, evidence: input.evidence }): Promise<CreativePointBalance> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); points(input.points)
    required(input.idempotencyKey, 'idempotencyKey'); required(input.reservationId, 'reservationId'); required(input.actorId, 'actorId'); required(input.reason, 'reason'); evidence(input.evidence)
      // The state lock is taken before the replay lookup, as `expireGrant`
      // already does: a concurrent retry of one idempotency key that read the
      // operation before the winner committed used to block here, re-read the
      // settled reservation and apply a *second* reversal (or die on the
      // operation's unique key with a raw SQLSTATE). Under the lock the loser
      // finds the winner's completed operation and replays its result.
      await this.lockState(client, workspaceId)
      const replay = await this.replay(client, workspaceId, input.kind, input.idempotencyKey, request)
      if (replay) return replay
      const reservation = await client.query<{ settled: string | number }>(`SELECT settled_points AS settled FROM creative_point_reservations WHERE workspace_id=$1 AND id=$2 AND status='settled' FOR UPDATE`, [workspaceId, input.reservationId])
      if (!reservation.rows[0]) throw new CreativePointRepositoryError('CREATIVE_POINT_RESERVATION_NOT_FOUND', 'settled creative point reservation was not found')
      const reversed = await client.query<{ points: string | number }>(`SELECT COALESCE(sum(points),0) AS points FROM creative_point_reversals_v2 WHERE workspace_id=$1 AND original_reservation_id=$2`, [workspaceId, input.reservationId])
      if (integer(reversed.rows[0]?.points ?? 0) + input.points > integer(reservation.rows[0].settled)) throw new CreativePointRepositoryError('CREATIVE_POINT_INSUFFICIENT', 'reversal exceeds settled creative points')
      const operationId = `cpo_${randomUUID()}`
      await this.operation(client, operationId, workspaceId, input.kind, input.idempotencyKey, request, observedAt)
      await this.reverseAllocations(client, workspaceId, input.reservationId, input.points, observedAt)
      const updated = await client.query<StateRow>(`UPDATE creative_point_access_state SET available_points=available_points+$2,settled_points=GREATEST(settled_points-$2,0),revision=revision+1,updated_at=$3::timestamptz WHERE workspace_id=$1 AND available_points IS NOT NULL RETURNING available_points AS available,reserved_points AS reserved,settled_points AS settled,revision`, [workspaceId, input.points, observedAt])
      if (!updated.rows[0]) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'creative point balance is unknown')
      const result = balance(workspaceId, updated.rows[0])
      await client.query(`INSERT INTO creative_point_reversals_v2 (id,workspace_id,operation_id,original_reservation_id,reversal_kind,points,reason,actor_id,evidence,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz)`, [`cprv_${randomUUID()}`, workspaceId, operationId, input.reservationId, input.kind, input.points, input.reason, input.actorId, JSON.stringify(input.evidence), observedAt])
      await this.ledger(client, workspaceId, operationId, input.kind === 'refund' ? 'refunded' : 'reversed', input.points, result, { reservation_id: input.reservationId, actor_id: input.actorId, reason: input.reason }, observedAt)
      await this.complete(client, workspaceId, operationId, result, observedAt)
      return result
  }

  async expireGrant(input: CreativePointExpiryInput): Promise<CreativePointBalance> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const observedAt = at(input.at); required(input.idempotencyKey, 'idempotencyKey'); required(input.grantId, 'grantId')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await this.lockState(client, workspaceId)
      const grant = await client.query<{ remaining: string | number }>(`SELECT g.points-COALESCE((SELECT sum(a.points_delta) FROM creative_point_allocations a WHERE a.workspace_id=g.workspace_id AND a.grant_id=g.id),0) AS remaining FROM creative_point_grants g WHERE g.workspace_id=$1 AND g.id=$2 AND g.expires_at IS NOT NULL AND g.expires_at<=$3::timestamptz`, [workspaceId, input.grantId, observedAt])
      if (!grant.rows[0]) throw new CreativePointRepositoryError('CREATIVE_POINT_RESERVATION_NOT_FOUND', 'expired creative point grant was not found')
      const expiredPoints = integer(grant.rows[0].remaining)
      // The recorded request carries the expired amount this grant still held,
      // so the replay comparison has to happen once that amount is known.
      const request = { grant_id: input.grantId, points: expiredPoints }
      const replay = await this.replay(client, workspaceId, 'expire', input.idempotencyKey, request); if (replay) return replay
      const operationId = `cpo_${randomUUID()}`
      await this.operation(client, operationId, workspaceId, 'expire', input.idempotencyKey, request, observedAt)
      const updated = await client.query<StateRow>(`WITH active AS (SELECT COALESCE(sum(GREATEST(g.points-COALESCE(a.allocated,0),0)),0) AS available FROM creative_point_grants g LEFT JOIN (SELECT workspace_id,grant_id,sum(points_delta) allocated FROM creative_point_allocations WHERE workspace_id=$1 GROUP BY workspace_id,grant_id) a ON a.workspace_id=g.workspace_id AND a.grant_id=g.id WHERE g.workspace_id=$1 AND (g.expires_at IS NULL OR g.expires_at>$2::timestamptz)) UPDATE creative_point_access_state s SET available_points=active.available,revision=s.revision+1,updated_at=$2::timestamptz FROM active WHERE s.workspace_id=$1 AND s.available_points IS NOT NULL RETURNING s.available_points AS available,s.reserved_points AS reserved,s.settled_points AS settled,s.revision`, [workspaceId, observedAt])
      if (!updated.rows[0]) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'creative point balance is unknown')
      const result = balance(workspaceId, updated.rows[0])
      await this.ledger(client, workspaceId, operationId, 'expired', -expiredPoints, result, { grant_id: input.grantId }, observedAt)
      await this.complete(client, workspaceId, operationId, result, observedAt)
      return result
    })
  }

  async adjust(input: CreativePointAdjustmentInput): Promise<CreativePointBalance> {
    const { workspaceId } = validateAdjustment(input)
    return withWorkspaceTransaction(this.pool, workspaceId, client => this.adjustInTransaction(client, input))
  }

  /** Use only inside an existing workspace-scoped transaction. The caller owns commit/rollback. */
  async adjustInTransaction(client: SqlClient, input: CreativePointAdjustmentInput): Promise<CreativePointBalance> {
    const { workspaceId, observedAt, request } = validateAdjustment(input)
      // Lock first, then replay (the order `expireGrant` uses). With the replay
      // lookup first, a retry that raced the original blocked on the lock here
      // and then failed its revision fence with `CREATIVE_POINT_IDEMPOTENCY_CONFLICT`
      // instead of replaying the balance the caller's key already produced.
      await this.lockState(client, workspaceId)
      const replay = await this.replay(client, workspaceId, 'adjust', input.idempotencyKey, request); if (replay) return replay
      const state = await client.query<StateRow>(`SELECT available_points AS available,reserved_points AS reserved,settled_points AS settled,revision FROM creative_point_access_state WHERE workspace_id=$1 FOR UPDATE`, [workspaceId])
      if (!state.rows[0] || integer(state.rows[0].revision) !== input.expectedAccessRevision) throw new CreativePointRepositoryError('CREATIVE_POINT_IDEMPOTENCY_CONFLICT', 'creative point access revision is stale')
      const before = integer(state.rows[0].available)
      if (before + input.pointsDelta < 0) throw new CreativePointRepositoryError('CREATIVE_POINT_INSUFFICIENT', 'adjustment would make available creative points negative')
      const operationId = `cpo_${randomUUID()}`
      await this.operation(client, operationId, workspaceId, 'adjust', input.idempotencyKey, request, observedAt)
      if (input.pointsDelta > 0) {
        const expiresAt = input.expiresAt == null ? null : at(input.expiresAt)
        await client.query(`INSERT INTO creative_point_grants (id,workspace_id,operation_id,source_type,source_id,points,expires_at,metadata,created_at) VALUES ($1,$2,$3,'ops_adjustment',$4,$5,$6::timestamptz,$7::jsonb,$8::timestamptz)`, [`cpg_${randomUUID()}`, workspaceId, operationId, input.approvalId, input.pointsDelta, expiresAt, JSON.stringify({ actor_id: input.actorId, approved_by_actor_id: input.approvedByActorId }), observedAt])
      } else {
        await this.consumeAdjustment(client, workspaceId, operationId, -input.pointsDelta, observedAt)
      }
      const updated = await client.query<StateRow>(`UPDATE creative_point_access_state SET available_points=available_points+$2,settled_points=settled_points+GREATEST(-$2,0),revision=revision+1,updated_at=$3::timestamptz WHERE workspace_id=$1 AND revision=$4 RETURNING available_points AS available,reserved_points AS reserved,settled_points AS settled,revision`, [workspaceId, input.pointsDelta, observedAt, input.expectedAccessRevision])
      if (!updated.rows[0]) throw new CreativePointRepositoryError('CREATIVE_POINT_IDEMPOTENCY_CONFLICT', 'creative point access revision is stale')
      const result = balance(workspaceId, updated.rows[0])
      await client.query(`INSERT INTO creative_point_adjustments_v2 (id,workspace_id,operation_id,approval_id,points_delta,expected_access_revision,access_revision_after,reason,actor_id,approved_by_actor_id,evidence,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::timestamptz)`, [`cpad_${randomUUID()}`, workspaceId, operationId, input.approvalId, input.pointsDelta, input.expectedAccessRevision, result.revision, input.reason, input.actorId, input.approvedByActorId, JSON.stringify(input.evidence), observedAt])
      await this.ledger(client, workspaceId, operationId, 'adjusted', input.pointsDelta, result, { approval_id: input.approvalId, before_available: before, after_available: result.availablePoints, actor_id: input.actorId, approved_by_actor_id: input.approvedByActorId, reason: input.reason }, observedAt)
      await this.complete(client, workspaceId, operationId, result, observedAt)
      return result
  }

  async recordProviderReceipt(input: CreativePointProviderReceiptInput): Promise<void> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const observedAt = at(input.at); required(input.operationId, 'operationId'); required(input.provider, 'provider'); required(input.providerRequestId, 'providerRequestId')
    if (!/^[0-9a-f]{64}$/u.test(input.receiptHash)) throw new TypeError('receiptHash must be sha256 hex')
    if (input.outcome === 'succeeded') {
      if (!input.usage || !input.cost || !input.verifiedAt) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'successful provider receipt requires verified usage and cost')
      if (!validUsageEvidence(input.usage) || !validCostEvidence(input.cost) || Number.isNaN(Date.parse(input.verifiedAt))) throw new CreativePointRepositoryError('CREATIVE_POINT_INPUT_INVALID', 'successful provider receipt requires valid usage, finite non-negative cost and verifiedAt')
    }
    await withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const inserted = await client.query<{ operation_id: string; provider: string; outcome: string; receipt_hash: string }>(`INSERT INTO creative_point_provider_receipts_v2 (id,workspace_id,operation_id,provider,provider_request_id,outcome,usage,cost,receipt_hash,verified_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::timestamptz,$11::timestamptz) ON CONFLICT (provider,provider_request_id) DO NOTHING RETURNING operation_id,provider,outcome,receipt_hash`, [`cppr_${randomUUID()}`, workspaceId, input.operationId, input.provider, input.providerRequestId, input.outcome, input.usage ? JSON.stringify(input.usage) : null, input.cost ? JSON.stringify(input.cost) : null, input.receiptHash, input.verifiedAt ? at(input.verifiedAt) : null, observedAt])
      if (inserted.rowCount) return
      const existing = await client.query<{ operation_id: string; provider: string; outcome: string; receipt_hash: string }>(`SELECT operation_id,provider,outcome,receipt_hash FROM creative_point_provider_receipts_v2 WHERE provider=$1 AND provider_request_id=$2`, [input.provider, input.providerRequestId])
      const row = existing.rows[0]
      if (!row || row.operation_id !== input.operationId || row.provider !== input.provider || row.outcome !== input.outcome || row.receipt_hash !== input.receiptHash) throw new CreativePointRepositoryError('CREATIVE_POINT_IDEMPOTENCY_CONFLICT', 'provider receipt identity is already bound to a different operation or evidence')
    })
  }

  async getProviderReceipt(input: { workspaceId: string; operationId: string; provider: string; providerRequestId: string }): Promise<{ operationId: string; provider: string; providerRequestId: string; outcome: 'succeeded' | 'failed' | 'unknown'; usage: Record<string, unknown> | null; cost: Record<string, unknown> | null; verifiedAt: string | null } | null> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); required(input.operationId, 'operationId'); required(input.provider, 'provider'); required(input.providerRequestId, 'providerRequestId')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<{ operationId: string; provider: string; providerRequestId: string; outcome: 'succeeded' | 'failed' | 'unknown'; usage: Record<string, unknown> | null; cost: Record<string, unknown> | null; verifiedAt: string | Date | null }>(`SELECT operation_id AS "operationId",provider,provider_request_id AS "providerRequestId",outcome,usage,cost,verified_at AS "verifiedAt" FROM creative_point_provider_receipts_v2 WHERE workspace_id=$1 AND operation_id=$2 AND provider=$3 AND provider_request_id=$4`, [workspaceId, input.operationId, input.provider, input.providerRequestId])
      const row = result.rows[0]
      if (!row) return null
      return { ...row, verifiedAt: row.verifiedAt instanceof Date ? row.verifiedAt.toISOString() : row.verifiedAt }
    })
  }

  /** Verify the API-owned usage and point settlement before worker delivery. */
  async verifyModelUsageDeliverySettlement(input: ModelUsageDeliverySettlementInput): Promise<boolean> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    required(input.reservationId, 'reservationId'); required(input.actionId, 'actionId'); required(input.providerRequestId, 'providerRequestId'); required(input.relayProvider, 'relayProvider')
    return withWorkspaceTransaction(this.pool, workspaceId, client => this.verifyModelUsageDeliverySettlementInTransaction(client, input))
  }

  async verifyModelUsageDeliverySettlementInTransaction(client: SqlClient, input: ModelUsageDeliverySettlementInput): Promise<boolean> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    required(input.reservationId, 'reservationId'); required(input.actionId, 'actionId'); required(input.providerRequestId, 'providerRequestId'); required(input.relayProvider, 'relayProvider')
      const result = await client.query<{ matched: number | string }>(`
        SELECT count(*)::int AS matched
          FROM creative_point_reservations r
          JOIN action_ledger a ON a.workspace_id=r.workspace_id AND a.action_key=r.action_key
          JOIN model_usage_ledger m ON m.workspace_id=r.workspace_id AND m.action_id=r.action_key AND m.provider_request_id=$4
          JOIN creative_point_provider_receipts_v2 api_receipt ON api_receipt.workspace_id=r.workspace_id
            AND api_receipt.operation_id=r.operation_id AND api_receipt.provider='model-relay' AND api_receipt.provider_request_id=$4
          JOIN creative_point_provider_receipts_v2 worker_receipt ON worker_receipt.workspace_id=r.workspace_id
            AND worker_receipt.operation_id=r.operation_id AND worker_receipt.provider=$5 AND worker_receipt.provider_request_id=$4
          JOIN creative_point_ledger_events ledger ON ledger.workspace_id=r.workspace_id
            AND ledger.event_type='settled' AND ledger.metadata->>'reservation_id'=r.id
          JOIN creative_point_operations settlement ON settlement.workspace_id=ledger.workspace_id AND settlement.id=ledger.operation_id
         WHERE r.workspace_id=$1 AND r.id=$2 AND r.action_key=$3
           AND r.status='settled' AND r.settled_points>0
           AND (r.settled_points=r.points OR $6::boolean)
           AND a.state='settled' AND a.settlement_status='settled' AND a.provider_request_id=$4
           AND (NOT $7::boolean OR m.modality='text') AND m.settlement_status='settled' AND m.cost_cny IS NOT NULL
           AND api_receipt.outcome='succeeded' AND api_receipt.verified_at IS NOT NULL
           AND worker_receipt.outcome='succeeded' AND worker_receipt.verified_at IS NOT NULL
           AND api_receipt.cost->>'currency'='CNY' AND worker_receipt.cost->>'currency'='CNY'
           AND api_receipt.cost->'actual'=to_jsonb(m.cost_cny)
           AND worker_receipt.cost->'actual'=api_receipt.cost->'actual'
           AND api_receipt.usage->>'modality'=m.modality AND worker_receipt.usage->>'modality'=m.modality
           AND api_receipt.usage->>'model'=m.model AND worker_receipt.usage->>'model'=m.model
           AND COALESCE(api_receipt.usage->'input_tokens','null'::jsonb)=to_jsonb(m.input_tokens)
           AND COALESCE(api_receipt.usage->'output_tokens','null'::jsonb)=to_jsonb(m.output_tokens)
           AND COALESCE(api_receipt.usage->'total_tokens','null'::jsonb)=to_jsonb(m.total_tokens)
           AND COALESCE(worker_receipt.usage->'input_tokens','null'::jsonb)=COALESCE(api_receipt.usage->'input_tokens','null'::jsonb)
           AND COALESCE(worker_receipt.usage->'output_tokens','null'::jsonb)=COALESCE(api_receipt.usage->'output_tokens','null'::jsonb)
           AND COALESCE(worker_receipt.usage->'total_tokens','null'::jsonb)=COALESCE(api_receipt.usage->'total_tokens','null'::jsonb)
           AND ledger.metadata->>'provider_request_id'=$4
           AND ledger.metadata->>'receipt_hash'=api_receipt.receipt_hash
           AND ledger.metadata->'cost_cny'=to_jsonb(m.cost_cny)
           AND ledger.metadata->>'modality'=m.modality
           AND settlement.kind='settle' AND settlement.status='completed'
           AND settlement.idempotency_key='commercial.settle:' || r.action_key
           AND settlement.request->>'reservation_id'=r.id
           AND settlement.request->'actual_points'=to_jsonb(r.settled_points)
           AND settlement.request->'metadata'->>'provider_request_id'=$4
           AND settlement.request->'metadata'->>'receipt_hash'=api_receipt.receipt_hash
           AND settlement.request->'metadata'->'cost_cny'=to_jsonb(m.cost_cny)
           AND settlement.request->'metadata'->>'modality'=m.modality
           AND (SELECT count(*) FROM model_usage_ledger all_usage WHERE all_usage.workspace_id=$1 AND all_usage.provider_request_id=$4)=1
           AND (SELECT count(*) FROM creative_point_ledger_events all_settlements WHERE all_settlements.workspace_id=$1 AND all_settlements.event_type='settled' AND all_settlements.metadata->>'reservation_id'=r.id)=1
           AND NOT EXISTS (SELECT 1 FROM creative_point_reversals_v2 reversal WHERE reversal.workspace_id=$1 AND reversal.original_reservation_id=r.id)
      `, [workspaceId, input.reservationId, input.actionId, input.providerRequestId, input.relayProvider, input.allowPartialPoints === true, input.requireText === true])
      return Number(result.rows[0]?.matched ?? 0) === 1
  }

  private async lockState(client: SqlClient, workspaceId: string) { await client.query(`SELECT workspace_id FROM creative_point_access_state WHERE workspace_id=$1 FOR UPDATE`, [workspaceId]) }
  /** A completed operation only replays for the request that produced it:
   * reusing an idempotency key for a different reservation, grant, point
   * amount or approval is a conflict, never a silent success.
   *
   * `expected_access_revision` is the one recorded field excluded from the
   * comparison. It is an optimistic-concurrency token read from live state at
   * call time, not part of the caller's intent, and it is expected to have
   * advanced by the time the same operation is retried. */
  private async replay(client: SqlClient, workspaceId: string, kind: string, key: string, request: Record<string, unknown>): Promise<CreativePointBalance | null> {
    const result = await client.query<{ result: { balance?: CreativePointBalance }; requestMatches: boolean }>(`SELECT result,(request-'expected_access_revision')=($4::jsonb-'expected_access_revision') AS "requestMatches" FROM creative_point_operations WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3 AND status='completed'`, [workspaceId, kind, key, JSON.stringify(request)])
    if (result.rows[0] && !result.rows[0].requestMatches) throw new CreativePointRepositoryError('CREATIVE_POINT_IDEMPOTENCY_CONFLICT', 'idempotency key was already used for a different creative point intent')
    return result.rows[0]?.result.balance ?? null
  }
  private async operation(client: SqlClient, id: string, workspaceId: string, kind: string, key: string, request: Record<string, unknown>, observedAt: string) { await client.query(`INSERT INTO creative_point_operations (id,workspace_id,kind,idempotency_key,status,request,created_at) VALUES ($1,$2,$3,$4,'pending',$5::jsonb,$6::timestamptz)`, [id, workspaceId, kind, key, JSON.stringify(request), observedAt]) }
  private async complete(client: SqlClient, workspaceId: string, operationId: string, result: CreativePointBalance, observedAt: string) { await client.query(`UPDATE creative_point_operations SET status='completed',result=$3::jsonb,completed_at=$4::timestamptz WHERE workspace_id=$1 AND id=$2`, [workspaceId, operationId, JSON.stringify({ balance: result }), observedAt]) }
  private async ledger(client: SqlClient, workspaceId: string, operationId: string, type: string, delta: number, result: CreativePointBalance, metadata: Record<string, unknown>, observedAt: string) { await client.query(`INSERT INTO creative_point_ledger_events (id,workspace_id,operation_id,event_type,points_delta,available_after,reserved_after,settled_after,access_revision,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz)`, [`cpl_${randomUUID()}`, workspaceId, operationId, type, delta, result.availablePoints, result.reservedPoints, result.settledPoints, result.revision, JSON.stringify(metadata), observedAt]) }
  private async reverseAllocations(client: SqlClient, workspaceId: string, reservationId: string, requested: number, observedAt: string) { let remaining = requested; const rows = await client.query<{ grantId: string; allocated: string | number }>(`SELECT a.grant_id AS "grantId",sum(a.points_delta) AS allocated FROM creative_point_allocations a JOIN creative_point_grants g ON g.workspace_id=a.workspace_id AND g.id=a.grant_id WHERE a.workspace_id=$1 AND a.reservation_id=$2 GROUP BY a.grant_id,g.expires_at,g.created_at HAVING sum(a.points_delta)>0 ORDER BY g.expires_at DESC NULLS FIRST,g.created_at DESC,a.grant_id DESC`, [workspaceId, reservationId]); for (const row of rows.rows) { const amount = Math.min(remaining, integer(row.allocated)); if (amount > 0) await client.query(`INSERT INTO creative_point_allocations (id,workspace_id,reservation_id,grant_id,allocation_type,points_delta,created_at) VALUES ($1,$2,$3,$4,'reverse',$5,$6::timestamptz)`, [`cpa_${randomUUID()}`, workspaceId, reservationId, row.grantId, -amount, observedAt]); remaining -= amount; if (remaining === 0) break } if (remaining !== 0) throw new CreativePointRepositoryError('CREATIVE_POINT_ALLOCATION_FAILED', 'reversal allocations are incomplete') }
  private async consumeAdjustment(client: SqlClient, workspaceId: string, operationId: string, requested: number, observedAt: string) { const reservationId = `cpr_${randomUUID()}`; await client.query(`INSERT INTO creative_point_reservations (id,workspace_id,operation_id,action_key,rate_card_version,points,status,settled_points,created_at,finalized_at) VALUES ($1,$2,$3,'ops.adjust:' || $3,'ops-adjustment',$4,'settled',$4,$5::timestamptz,$5::timestamptz)`, [reservationId, workspaceId, operationId, requested, observedAt]); let remaining = requested; const rows = await client.query<{ id: string; remaining: string | number }>(`SELECT g.id,g.points-COALESCE(a.allocated,0) AS remaining FROM creative_point_grants g LEFT JOIN LATERAL (SELECT sum(points_delta) AS allocated FROM creative_point_allocations WHERE workspace_id=g.workspace_id AND grant_id=g.id) a ON true WHERE g.workspace_id=$1 AND (g.expires_at IS NULL OR g.expires_at>$2::timestamptz) AND g.points-COALESCE(a.allocated,0)>0 ORDER BY g.expires_at NULLS LAST,g.created_at,g.id`, [workspaceId, observedAt]); for (const row of rows.rows) { const amount = Math.min(remaining, integer(row.remaining)); if (amount > 0) await client.query(`INSERT INTO creative_point_allocations (id,workspace_id,reservation_id,grant_id,allocation_type,points_delta,created_at) VALUES ($1,$2,$3,$4,'adjustment',$5,$6::timestamptz)`, [`cpa_${randomUUID()}`, workspaceId, reservationId, row.id, amount, observedAt]); remaining -= amount; if (remaining === 0) break } if (remaining !== 0) throw new CreativePointRepositoryError('CREATIVE_POINT_ALLOCATION_FAILED', 'adjustment allocations are incomplete') }
}

export class CommercialAdjustmentApprovalError extends Error {
  readonly code = 'COMMERCIAL_ADJUSTMENT_APPROVAL_INVALID'
}
