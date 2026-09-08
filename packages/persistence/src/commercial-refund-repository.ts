import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type CommercialRefundKind = 'onboarding_pre_deployment' | 'monthly_unused_points' | 'point_pack_unused_points' | 'outage_compensation' | 'custom_milestone'
export type CommercialRefundEventType = 'requested' | 'approved' | 'rejected' | 'completed' | 'reconciliation_required'

export interface CommercialRefundEvent {
  id: string
  workspaceId: string
  orderId: string
  requestId: string
  revision: number
  eventType: CommercialRefundEventType
  refundKind: CommercialRefundKind
  amountFen: number
  pointsToRevoke: number
  reason: string
  actorId: string
  evidence: Record<string, unknown>
  externalRefundId: string | null
  createdAt: string
}

export class CommercialRefundRepositoryError extends Error {
  constructor(readonly code: 'COMMERCIAL_REFUND_ORDER_NOT_FOUND' | 'COMMERCIAL_REFUND_REQUEST_CONFLICT' | 'COMMERCIAL_REFUND_STATE_INVALID' | 'COMMERCIAL_REFUND_INPUT_INVALID', message: string) {
    super(message)
    this.name = 'CommercialRefundRepositoryError'
  }
}

export interface CommercialRefundRepository {
  request(input: { workspaceId: string; orderId: string; requestId: string; refundKind: CommercialRefundKind; amountFen: number; pointsToRevoke: number; reason: string; actorId: string; evidence: Record<string, unknown>; at: string }): Promise<CommercialRefundEvent>
  approve(input: { workspaceId: string; requestId: string; actorId: string; reason: string; policyApproval: Record<string, unknown>; at: string }): Promise<CommercialRefundEvent>
  reject(input: { workspaceId: string; requestId: string; actorId: string; reason: string; evidence: Record<string, unknown>; at: string }): Promise<CommercialRefundEvent>
  complete(input: { workspaceId: string; requestId: string; actorId: string; reason: string; externalRefundId: string; evidence: Record<string, unknown>; at: string }): Promise<CommercialRefundEvent>
  latest(workspaceId: string, requestId: string): Promise<CommercialRefundEvent | null>
  history(workspaceId: string, requestId: string): Promise<CommercialRefundEvent[]>
  list(workspaceId: string, limit?: number): Promise<CommercialRefundEvent[]>
}

type EventRow = Omit<CommercialRefundEvent, 'amountFen' | 'pointsToRevoke' | 'createdAt'> & { amountFen: string | number; pointsToRevoke: string | number; createdAt: string | Date }
const projection = `id,workspace_id AS "workspaceId",order_id AS "orderId",request_id AS "requestId",revision,event_type AS "eventType",refund_kind AS "refundKind",amount_fen AS "amountFen",points_to_revoke AS "pointsToRevoke",reason,actor_id AS "actorId",evidence,external_refund_id AS "externalRefundId",created_at AS "createdAt"`
const iso = (value: string | Date): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const map = (row: EventRow): CommercialRefundEvent => ({ ...row, amountFen: Number(row.amountFen), pointsToRevoke: Number(row.pointsToRevoke), createdAt: iso(row.createdAt) })
const text = (value: string, field: string): string => { if (typeof value !== 'string' || !value.trim() || value.trim() !== value) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_INPUT_INVALID', `${field} is invalid`); return value }
const evidence = (value: Record<string, unknown>, field = 'evidence'): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_INPUT_INVALID', `${field} is required`); return value }
const at = (value: string): string => { const date = new Date(value); if (Number.isNaN(date.valueOf())) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_INPUT_INVALID', 'at is invalid'); return date.toISOString() }
const positive = (value: number, field: string): number => { if (!Number.isSafeInteger(value) || value <= 0) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_INPUT_INVALID', `${field} is invalid`); return value }
const nonNegative = (value: number, field: string): number => { if (!Number.isSafeInteger(value) || value < 0) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_INPUT_INVALID', `${field} is invalid`); return value }
const hasEvidenceRef = (value: Record<string, unknown>, key: string): boolean => typeof value[key] === 'string' && Boolean((value[key] as string).trim())

export class PostgresCommercialRefundRepository implements CommercialRefundRepository {
  constructor(private readonly pool: SqlPool) {}

  async request(input: Parameters<CommercialRefundRepository['request']>[0]): Promise<CommercialRefundEvent> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const requestId = text(input.requestId, 'requestId'); const actorId = text(input.actorId, 'actorId'); const reason = text(input.reason, 'reason'); const createdAt = at(input.at); const amountFen = positive(input.amountFen, 'amountFen'); const pointsToRevoke = nonNegative(input.pointsToRevoke, 'pointsToRevoke'); const requestEvidence = evidence(input.evidence)
    const evidenceKey = input.refundKind === 'onboarding_pre_deployment' ? 'deployment_status' : input.refundKind === 'monthly_unused_points' ? 'supplement_agreement_ref' : input.refundKind === 'point_pack_unused_points' ? 'expiry_policy_ref' : input.refundKind === 'outage_compensation' ? 'incident_id' : 'milestone_id'
    if (input.refundKind === 'onboarding_pre_deployment' ? requestEvidence.deployment_status !== 'not_started' : !hasEvidenceRef(requestEvidence, evidenceKey)) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_INPUT_INVALID', `${evidenceKey} is required for this refund kind`)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const order = await client.query<{ amountFen: string | number; status: string }>('SELECT amount_fen AS "amountFen",status FROM commercial_orders_v2 WHERE workspace_id=$1 AND id=$2 FOR SHARE', [workspaceId, input.orderId])
      if (!order.rows[0]) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_ORDER_NOT_FOUND', 'commercial order was not found')
      if (order.rows[0].status !== 'paid' || amountFen > Number(order.rows[0].amountFen)) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'only a paid order with a bounded refund amount can be refunded')
      const existing = await this.latestIn(client, workspaceId, requestId)
      if (existing) { if (existing.eventType !== 'requested' || existing.amountFen !== amountFen || existing.pointsToRevoke !== pointsToRevoke) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_REQUEST_CONFLICT', 'refund request id is already bound to another request'); return existing }
      return this.insert(client, workspaceId, { orderId: input.orderId, requestId, revision: 1, eventType: 'requested', refundKind: input.refundKind, amountFen, pointsToRevoke, reason, actorId, evidence: requestEvidence, externalRefundId: null, at: createdAt })
    })
  }

  async approve(input: Parameters<CommercialRefundRepository['approve']>[0]): Promise<CommercialRefundEvent> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const requestId = text(input.requestId, 'requestId'); const actorId = text(input.actorId, 'actorId'); const reason = text(input.reason, 'reason'); const createdAt = at(input.at); const policyApproval = evidence(input.policyApproval, 'policyApproval')
    if (!hasEvidenceRef(policyApproval, 'legal_review_ref')) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_INPUT_INVALID', 'legal_review_ref is required for refund approval')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const prior = await this.latestIn(client, workspaceId, requestId)
      if (!prior || prior.eventType !== 'requested') throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund request is not awaiting approval')
      if (prior.actorId === actorId) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund requester cannot approve their own request')
      return this.insert(client, workspaceId, { ...prior, revision: prior.revision + 1, eventType: 'approved', actorId, reason, evidence: { ...prior.evidence, policy_approval: policyApproval }, externalRefundId: null, at: createdAt })
    })
  }

  async reject(input: Parameters<CommercialRefundRepository['reject']>[0]): Promise<CommercialRefundEvent> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const requestId = text(input.requestId, 'requestId'); const actorId = text(input.actorId, 'actorId'); const reason = text(input.reason, 'reason'); const createdAt = at(input.at); const rejectionEvidence = evidence(input.evidence)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const prior = await this.latestIn(client, workspaceId, requestId)
      if (!prior || prior.eventType !== 'requested') throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund request is not awaiting decision')
      return this.insert(client, workspaceId, { ...prior, revision: prior.revision + 1, eventType: 'rejected', actorId, reason, evidence: { ...prior.evidence, rejection: rejectionEvidence }, externalRefundId: null, at: createdAt })
    })
  }

  async complete(input: Parameters<CommercialRefundRepository['complete']>[0]): Promise<CommercialRefundEvent> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const requestId = text(input.requestId, 'requestId'); const actorId = text(input.actorId, 'actorId'); const reason = text(input.reason, 'reason'); const externalRefundId = text(input.externalRefundId, 'externalRefundId'); const completionEvidence = evidence(input.evidence); const createdAt = at(input.at)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const prior = await this.latestIn(client, workspaceId, requestId)
      if (!prior || prior.eventType !== 'approved') throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund request is not approved')
      const event = await this.insert(client, workspaceId, { ...prior, revision: prior.revision + 1, eventType: 'completed', actorId, reason, evidence: { ...prior.evidence, completion: completionEvidence }, externalRefundId, at: createdAt })
      await client.query("UPDATE commercial_orders_v2 SET status='refunded' WHERE workspace_id=$1 AND id=$2 AND status='paid'", [workspaceId, prior.orderId])
      return event
    })
  }

  async latest(workspaceIdInput: string, requestIdInput: string): Promise<CommercialRefundEvent | null> { const workspaceId = requireWorkspaceScope(workspaceIdInput); const requestId = text(requestIdInput, 'requestId'); return withWorkspaceTransaction(this.pool, workspaceId, client => this.latestIn(client, workspaceId, requestId)) }
  async history(workspaceIdInput: string, requestIdInput: string): Promise<CommercialRefundEvent[]> { const workspaceId = requireWorkspaceScope(workspaceIdInput); const requestId = text(requestIdInput, 'requestId'); return withWorkspaceTransaction(this.pool, workspaceId, async client => (await client.query<EventRow>(`SELECT ${projection} FROM commercial_refund_events_v2 WHERE workspace_id=$1 AND request_id=$2 ORDER BY revision ASC`, [workspaceId, requestId])).rows.map(map)) }
  async list(workspaceIdInput: string, limit = 100): Promise<CommercialRefundEvent[]> { const workspaceId = requireWorkspaceScope(workspaceIdInput); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError('limit must be between 1 and 200'); return withWorkspaceTransaction(this.pool, workspaceId, async client => (await client.query<EventRow>(`SELECT ${projection} FROM commercial_refund_events_v2 WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`, [workspaceId, limit])).rows.map(map)) }

  private async latestIn(client: SqlClient, workspaceId: string, requestId: string): Promise<CommercialRefundEvent | null> { const result = await client.query<EventRow>(`SELECT ${projection} FROM commercial_refund_events_v2 WHERE workspace_id=$1 AND request_id=$2 ORDER BY revision DESC LIMIT 1`, [workspaceId, requestId]); return result.rows[0] ? map(result.rows[0]) : null }
  private async insert(client: SqlClient, workspaceId: string, input: Omit<CommercialRefundEvent, 'id' | 'workspaceId' | 'createdAt'> & { at: string }): Promise<CommercialRefundEvent> {
    const result = await client.query<EventRow>(
      `INSERT INTO commercial_refund_events_v2 (id,workspace_id,order_id,request_id,revision,event_type,refund_kind,amount_fen,points_to_revoke,reason,actor_id,evidence,external_refund_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz) RETURNING ${projection}`,
      [`cre_${randomUUID()}`, workspaceId, input.orderId, input.requestId, input.revision, input.eventType, input.refundKind, input.amountFen, input.pointsToRevoke, input.reason, input.actorId, JSON.stringify(input.evidence), input.externalRefundId, input.at],
    )
    const row = result.rows[0]
    if (!row) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund event was not persisted')
    return map(row)
  }
}
