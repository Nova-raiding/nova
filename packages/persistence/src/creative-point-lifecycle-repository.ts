import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'
import { CreativePointRepositoryError, type CreativePointBalance } from './creative-point-repository.js'

type MutationInput = { workspaceId: string; idempotencyKey: string; at: string }
export type CreativePointReversalInput = MutationInput & { reservationId: string; points: number; kind: 'refund' | 'reverse'; actorId: string; reason: string; evidence: Record<string, unknown> }
export type CreativePointExpiryInput = MutationInput & { grantId: string }
export type CreativePointAdjustmentInput = MutationInput & { approvalId: string; pointsDelta: number; expectedAccessRevision: number; actorId: string; approvedByActorId: string; reason: string; evidence: Record<string, unknown>; expiresAt?: string | null }
export type CreativePointProviderReceiptInput = { workspaceId: string; operationId: string; provider: string; providerRequestId: string; outcome: 'succeeded' | 'failed' | 'unknown'; usage?: Record<string, unknown>; cost?: Record<string, unknown>; receiptHash: string; verifiedAt?: string; at: string }

function required(value: string, field: string): string { if (!value || value.trim() !== value) throw new TypeError(`${field} is required`); return value }
function at(value: string): string { const parsed = new Date(value); if (Number.isNaN(parsed.valueOf())) throw new TypeError('at must be an ISO timestamp'); return parsed.toISOString() }
function points(value: number, field = 'points'): number { if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive integer`); return value }
function evidence(value: Record<string, unknown>): Record<string, unknown> { if (!value || Object.keys(value).length === 0) throw new TypeError('evidence is required'); return value }
function integer(value: string | number): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'creative point value is invalid'); return parsed }

type StateRow = { available: string | number; reserved: string | number; settled: string | number; revision: string | number }
const balance = (workspaceId: string, row: StateRow): CreativePointBalance => ({ workspaceId, availablePoints: integer(row.available), reservedPoints: integer(row.reserved), settledPoints: integer(row.settled), revision: integer(row.revision) })

/** Append-only lifecycle commands not covered by the reserve/settle repository. */
export class PostgresCreativePointLifecycleRepository {
  constructor(private readonly pool: SqlPool) {}

  async reverseSettlement(input: CreativePointReversalInput): Promise<CreativePointBalance> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const observedAt = at(input.at); points(input.points)
    required(input.idempotencyKey, 'idempotencyKey'); required(input.reservationId, 'reservationId'); required(input.actorId, 'actorId'); required(input.reason, 'reason'); evidence(input.evidence)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const replay = await this.replay(client, workspaceId, input.kind, input.idempotencyKey)
      if (replay) return replay
      const reservation = await client.query<{ settled: string | number }>(`SELECT settled_points AS settled FROM creative_point_reservations WHERE workspace_id=$1 AND id=$2 AND status='settled' FOR UPDATE`, [workspaceId, input.reservationId])
      if (!reservation.rows[0]) throw new CreativePointRepositoryError('CREATIVE_POINT_RESERVATION_NOT_FOUND', 'settled creative point reservation was not found')
      const reversed = await client.query<{ points: string | number }>(`SELECT COALESCE(sum(points),0) AS points FROM creative_point_reversals_v2 WHERE workspace_id=$1 AND original_reservation_id=$2`, [workspaceId, input.reservationId])
      if (integer(reversed.rows[0]?.points ?? 0) + input.points > integer(reservation.rows[0].settled)) throw new CreativePointRepositoryError('CREATIVE_POINT_INSUFFICIENT', 'reversal exceeds settled creative points')
      await this.lockState(client, workspaceId)
      const operationId = `cpo_${randomUUID()}`
      await this.operation(client, operationId, workspaceId, input.kind, input.idempotencyKey, { reservation_id: input.reservationId, points: input.points, reason: input.reason, actor_id: input.actorId, evidence: input.evidence }, observedAt)
      await this.reverseAllocations(client, workspaceId, input.reservationId, input.points, observedAt)
      const updated = await client.query<StateRow>(`UPDATE creative_point_access_state SET available_points=available_points+$2,settled_points=GREATEST(settled_points-$2,0),revision=revision+1,updated_at=$3::timestamptz WHERE workspace_id=$1 AND available_points IS NOT NULL RETURNING available_points AS available,reserved_points AS reserved,settled_points AS settled,revision`, [workspaceId, input.points, observedAt])
      if (!updated.rows[0]) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'creative point balance is unknown')
      const result = balance(workspaceId, updated.rows[0])
      await client.query(`INSERT INTO creative_point_reversals_v2 (id,workspace_id,operation_id,original_reservation_id,reversal_kind,points,reason,actor_id,evidence,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz)`, [`cprv_${randomUUID()}`, workspaceId, operationId, input.reservationId, input.kind, input.points, input.reason, input.actorId, JSON.stringify(input.evidence), observedAt])
      await this.ledger(client, workspaceId, operationId, input.kind === 'refund' ? 'refunded' : 'reversed', input.points, result, { reservation_id: input.reservationId, actor_id: input.actorId, reason: input.reason }, observedAt)
      await this.complete(client, workspaceId, operationId, result, observedAt)
      return result
    })
  }

  async expireGrant(input: CreativePointExpiryInput): Promise<CreativePointBalance> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const observedAt = at(input.at); required(input.idempotencyKey, 'idempotencyKey'); required(input.grantId, 'grantId')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const replay = await this.replay(client, workspaceId, 'expire', input.idempotencyKey); if (replay) return replay
      await this.lockState(client, workspaceId)
      const grant = await client.query<{ remaining: string | number }>(`SELECT g.points-COALESCE((SELECT sum(a.points_delta) FROM creative_point_allocations a WHERE a.workspace_id=g.workspace_id AND a.grant_id=g.id),0) AS remaining FROM creative_point_grants g WHERE g.workspace_id=$1 AND g.id=$2 AND g.expires_at IS NOT NULL AND g.expires_at<=$3::timestamptz`, [workspaceId, input.grantId, observedAt])
      if (!grant.rows[0]) throw new CreativePointRepositoryError('CREATIVE_POINT_RESERVATION_NOT_FOUND', 'expired creative point grant was not found')
      const expiredPoints = integer(grant.rows[0].remaining)
      const operationId = `cpo_${randomUUID()}`
      await this.operation(client, operationId, workspaceId, 'expire', input.idempotencyKey, { grant_id: input.grantId, points: expiredPoints }, observedAt)
      const updated = await client.query<StateRow>(`WITH active AS (SELECT COALESCE(sum(GREATEST(g.points-COALESCE(a.allocated,0),0)),0) AS available FROM creative_point_grants g LEFT JOIN (SELECT workspace_id,grant_id,sum(points_delta) allocated FROM creative_point_allocations WHERE workspace_id=$1 GROUP BY workspace_id,grant_id) a ON a.workspace_id=g.workspace_id AND a.grant_id=g.id WHERE g.workspace_id=$1 AND (g.expires_at IS NULL OR g.expires_at>$2::timestamptz)) UPDATE creative_point_access_state s SET available_points=active.available,revision=s.revision+1,updated_at=$2::timestamptz FROM active WHERE s.workspace_id=$1 AND s.available_points IS NOT NULL RETURNING s.available_points AS available,s.reserved_points AS reserved,s.settled_points AS settled,s.revision`, [workspaceId, observedAt])
      if (!updated.rows[0]) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'creative point balance is unknown')
      const result = balance(workspaceId, updated.rows[0])
      await this.ledger(client, workspaceId, operationId, 'expired', -expiredPoints, result, { grant_id: input.grantId }, observedAt)
      await this.complete(client, workspaceId, operationId, result, observedAt)
      return result
    })
  }

  async adjust(input: CreativePointAdjustmentInput): Promise<CreativePointBalance> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const observedAt = at(input.at)
    if (!Number.isSafeInteger(input.pointsDelta) || input.pointsDelta === 0) throw new TypeError('pointsDelta must be a non-zero integer')
    if (!Number.isSafeInteger(input.expectedAccessRevision) || input.expectedAccessRevision < 0) throw new TypeError('expectedAccessRevision is invalid')
    required(input.approvalId, 'approvalId'); required(input.idempotencyKey, 'idempotencyKey'); required(input.actorId, 'actorId'); required(input.approvedByActorId, 'approvedByActorId'); required(input.reason, 'reason'); evidence(input.evidence)
    if (input.actorId === input.approvedByActorId) throw new CommercialAdjustmentApprovalError('adjustment maker and approver must be different actors')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const replay = await this.replay(client, workspaceId, 'adjust', input.idempotencyKey); if (replay) return replay
      await this.lockState(client, workspaceId)
      const state = await client.query<StateRow>(`SELECT available_points AS available,reserved_points AS reserved,settled_points AS settled,revision FROM creative_point_access_state WHERE workspace_id=$1 FOR UPDATE`, [workspaceId])
      if (!state.rows[0] || integer(state.rows[0].revision) !== input.expectedAccessRevision) throw new CreativePointRepositoryError('CREATIVE_POINT_IDEMPOTENCY_CONFLICT', 'creative point access revision is stale')
      const before = integer(state.rows[0].available)
      if (before + input.pointsDelta < 0) throw new CreativePointRepositoryError('CREATIVE_POINT_INSUFFICIENT', 'adjustment would make available creative points negative')
      const operationId = `cpo_${randomUUID()}`
      await this.operation(client, operationId, workspaceId, 'adjust', input.idempotencyKey, { approval_id: input.approvalId, points_delta: input.pointsDelta, expected_access_revision: input.expectedAccessRevision, actor_id: input.actorId, approved_by_actor_id: input.approvedByActorId, reason: input.reason, evidence: input.evidence }, observedAt)
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
    })
  }

  async recordProviderReceipt(input: CreativePointProviderReceiptInput): Promise<void> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const observedAt = at(input.at); required(input.operationId, 'operationId'); required(input.provider, 'provider'); required(input.providerRequestId, 'providerRequestId')
    if (!/^[0-9a-f]{64}$/u.test(input.receiptHash)) throw new TypeError('receiptHash must be sha256 hex')
    if (input.outcome === 'succeeded' && (!input.usage || !input.cost || !input.verifiedAt)) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'successful provider receipt requires verified usage and cost')
    await withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await client.query(`INSERT INTO creative_point_provider_receipts_v2 (id,workspace_id,operation_id,provider,provider_request_id,outcome,usage,cost,receipt_hash,verified_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::timestamptz,$11::timestamptz) ON CONFLICT (provider,provider_request_id) DO NOTHING`, [`cppr_${randomUUID()}`, workspaceId, input.operationId, input.provider, input.providerRequestId, input.outcome, input.usage ? JSON.stringify(input.usage) : null, input.cost ? JSON.stringify(input.cost) : null, input.receiptHash, input.verifiedAt ? at(input.verifiedAt) : null, observedAt])
    })
  }

  private async lockState(client: SqlClient, workspaceId: string) { await client.query(`SELECT workspace_id FROM creative_point_access_state WHERE workspace_id=$1 FOR UPDATE`, [workspaceId]) }
  private async replay(client: SqlClient, workspaceId: string, kind: string, key: string): Promise<CreativePointBalance | null> { const result = await client.query<{ result: { balance?: CreativePointBalance } }>(`SELECT result FROM creative_point_operations WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3 AND status='completed'`, [workspaceId, kind, key]); return result.rows[0]?.result.balance ?? null }
  private async operation(client: SqlClient, id: string, workspaceId: string, kind: string, key: string, request: Record<string, unknown>, observedAt: string) { await client.query(`INSERT INTO creative_point_operations (id,workspace_id,kind,idempotency_key,status,request,created_at) VALUES ($1,$2,$3,$4,'pending',$5::jsonb,$6::timestamptz)`, [id, workspaceId, kind, key, JSON.stringify(request), observedAt]) }
  private async complete(client: SqlClient, workspaceId: string, operationId: string, result: CreativePointBalance, observedAt: string) { await client.query(`UPDATE creative_point_operations SET status='completed',result=$3::jsonb,completed_at=$4::timestamptz WHERE workspace_id=$1 AND id=$2`, [workspaceId, operationId, JSON.stringify({ balance: result }), observedAt]) }
  private async ledger(client: SqlClient, workspaceId: string, operationId: string, type: string, delta: number, result: CreativePointBalance, metadata: Record<string, unknown>, observedAt: string) { await client.query(`INSERT INTO creative_point_ledger_events (id,workspace_id,operation_id,event_type,points_delta,available_after,reserved_after,settled_after,access_revision,metadata,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::timestamptz)`, [`cpl_${randomUUID()}`, workspaceId, operationId, type, delta, result.availablePoints, result.reservedPoints, result.settledPoints, result.revision, JSON.stringify(metadata), observedAt]) }
  private async reverseAllocations(client: SqlClient, workspaceId: string, reservationId: string, requested: number, observedAt: string) { let remaining = requested; const rows = await client.query<{ grantId: string; allocated: string | number }>(`SELECT a.grant_id AS "grantId",sum(a.points_delta) AS allocated FROM creative_point_allocations a JOIN creative_point_grants g ON g.workspace_id=a.workspace_id AND g.id=a.grant_id WHERE a.workspace_id=$1 AND a.reservation_id=$2 GROUP BY a.grant_id,g.expires_at,g.created_at HAVING sum(a.points_delta)>0 ORDER BY g.expires_at DESC NULLS FIRST,g.created_at DESC,a.grant_id DESC`, [workspaceId, reservationId]); for (const row of rows.rows) { const amount = Math.min(remaining, integer(row.allocated)); if (amount > 0) await client.query(`INSERT INTO creative_point_allocations (id,workspace_id,reservation_id,grant_id,allocation_type,points_delta,created_at) VALUES ($1,$2,$3,$4,'reverse',$5,$6::timestamptz)`, [`cpa_${randomUUID()}`, workspaceId, reservationId, row.grantId, -amount, observedAt]); remaining -= amount; if (remaining === 0) break } if (remaining !== 0) throw new CreativePointRepositoryError('CREATIVE_POINT_ALLOCATION_FAILED', 'reversal allocations are incomplete') }
  private async consumeAdjustment(client: SqlClient, workspaceId: string, operationId: string, requested: number, observedAt: string) { const reservationId = `cpr_${randomUUID()}`; await client.query(`INSERT INTO creative_point_reservations (id,workspace_id,operation_id,action_key,rate_card_version,points,status,settled_points,created_at,finalized_at) VALUES ($1,$2,$3,'ops.adjust','ops-adjustment',$4,'settled',$4,$5::timestamptz,$5::timestamptz)`, [reservationId, workspaceId, operationId, requested, observedAt]); let remaining = requested; const rows = await client.query<{ id: string; remaining: string | number }>(`SELECT g.id,g.points-COALESCE(a.allocated,0) AS remaining FROM creative_point_grants g LEFT JOIN LATERAL (SELECT sum(points_delta) AS allocated FROM creative_point_allocations WHERE workspace_id=g.workspace_id AND grant_id=g.id) a ON true WHERE g.workspace_id=$1 AND (g.expires_at IS NULL OR g.expires_at>$2::timestamptz) AND g.points-COALESCE(a.allocated,0)>0 ORDER BY g.expires_at NULLS LAST,g.created_at,g.id`, [workspaceId, observedAt]); for (const row of rows.rows) { const amount = Math.min(remaining, integer(row.remaining)); if (amount > 0) await client.query(`INSERT INTO creative_point_allocations (id,workspace_id,reservation_id,grant_id,allocation_type,points_delta,created_at) VALUES ($1,$2,$3,$4,'adjustment',$5,$6::timestamptz)`, [`cpa_${randomUUID()}`, workspaceId, reservationId, row.id, amount, observedAt]); remaining -= amount; if (remaining === 0) break } if (remaining !== 0) throw new CreativePointRepositoryError('CREATIVE_POINT_ALLOCATION_FAILED', 'adjustment allocations are incomplete') }
}

export class CommercialAdjustmentApprovalError extends Error {
  readonly code = 'COMMERCIAL_ADJUSTMENT_APPROVAL_INVALID'
}
