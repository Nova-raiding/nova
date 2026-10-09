import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'
import { CreativePointRepositoryError } from './creative-point-repository.js'
import type { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'

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

export interface CommercialRefundPage {
  items: CommercialRefundEvent[]
  total: number
  nextCursor: string | null
  truncated: boolean
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
  completeWithPointRevoke(input: Parameters<CommercialRefundRepository['complete']>[0], lifecycle: PostgresCreativePointLifecycleRepository): Promise<CommercialRefundEvent>
  latest(workspaceId: string, requestId: string): Promise<CommercialRefundEvent | null>
  history(workspaceId: string, requestId: string): Promise<CommercialRefundEvent[]>
  list(workspaceId: string, options?: { limit?: number; cursor?: string }): Promise<CommercialRefundPage>
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
  constructor(private readonly pool: SqlPool, private readonly sourceRecovery?: (client: SqlClient, input: { workspaceId: string; orderId: string; requestId: string; amountFen: number; pointsToRevoke: number; policyVersion: string; phase: 'approve' | 'complete' | 'reject'; now: string }) => Promise<unknown>) {}

  async request(input: Parameters<CommercialRefundRepository['request']>[0]): Promise<CommercialRefundEvent> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const requestId = text(input.requestId, 'requestId'); const actorId = text(input.actorId, 'actorId'); const reason = text(input.reason, 'reason'); const createdAt = at(input.at); const amountFen = positive(input.amountFen, 'amountFen'); const pointsToRevoke = nonNegative(input.pointsToRevoke, 'pointsToRevoke'); const requestEvidence = evidence(input.evidence)
    const evidenceKey = input.refundKind === 'onboarding_pre_deployment' ? 'deployment_status' : input.refundKind === 'monthly_unused_points' ? 'supplement_agreement_ref' : input.refundKind === 'point_pack_unused_points' ? 'expiry_policy_ref' : input.refundKind === 'outage_compensation' ? 'incident_id' : 'milestone_id'
    if (input.refundKind === 'onboarding_pre_deployment' ? requestEvidence.deployment_status !== 'not_started' : !hasEvidenceRef(requestEvidence, evidenceKey)) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_INPUT_INVALID', `${evidenceKey} is required for this refund kind`)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await this.lockWorkspace(client, workspaceId)
      // Serialize every refund decision for this order: the cumulative bound is
      // only sound while concurrent requests cannot both read the same
      // unrefunded order snapshot.
      const order = await client.query<{ amountFen: string | number; status: string }>('SELECT amount_fen AS "amountFen",status FROM commercial_orders_v2 WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, input.orderId])
      if (!order.rows[0]) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_ORDER_NOT_FOUND', 'commercial order was not found')
      const existing = await this.latestIn(client, workspaceId, requestId)
      if (existing) { if (existing.orderId !== input.orderId || existing.eventType !== 'requested' || existing.amountFen !== amountFen || existing.pointsToRevoke !== pointsToRevoke) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_REQUEST_CONFLICT', 'refund request id is already bound to another request'); return existing }
      if (order.rows[0].status !== 'paid') throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'only a paid order can be refunded')
      const committedFen = await this.committedIn(client, workspaceId, input.orderId)
      if (amountFen + committedFen > Number(order.rows[0].amountFen)) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund amount exceeds the remaining refundable order amount')
      return this.insert(client, workspaceId, { orderId: input.orderId, requestId, revision: 1, eventType: 'requested', refundKind: input.refundKind, amountFen, pointsToRevoke, reason, actorId, evidence: requestEvidence, externalRefundId: null, at: createdAt })
    })
  }

  async approve(input: Parameters<CommercialRefundRepository['approve']>[0]): Promise<CommercialRefundEvent> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const requestId = text(input.requestId, 'requestId'); const actorId = text(input.actorId, 'actorId'); const reason = text(input.reason, 'reason'); const createdAt = at(input.at); const policyApproval = evidence(input.policyApproval, 'policyApproval')
    if (!hasEvidenceRef(policyApproval, 'legal_review_ref')) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_INPUT_INVALID', 'legal_review_ref is required for refund approval')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await this.lockWorkspace(client, workspaceId)
      const prior = await this.latestIn(client, workspaceId, requestId)
      if (!prior || prior.eventType !== 'requested') throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund request is not awaiting approval')
      if (prior.actorId === actorId) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund requester cannot approve their own request')
      // Approval commits the money, so it carries the same cumulative bound as
      // request and completion: the database trigger enforces it for every
      // writer, and checking it here keeps the refusal a mapped
      // COMMERCIAL_REFUND_STATE_INVALID instead of a raw constraint error.
      const order = await client.query<{ amountFen: string | number; status: string }>('SELECT amount_fen AS "amountFen",status FROM commercial_orders_v2 WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, prior.orderId])
      if (!order.rows[0]) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_ORDER_NOT_FOUND', 'commercial order was not found')
      const committedFen = await this.committedIn(client, workspaceId, prior.orderId, requestId)
      if (order.rows[0].status !== 'paid' || prior.amountFen + committedFen > Number(order.rows[0].amountFen)) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund amount exceeds the remaining refundable order amount')
      await this.recoverSource(client, { workspaceId, orderId: prior.orderId, requestId: prior.requestId, amountFen: prior.amountFen, pointsToRevoke: prior.pointsToRevoke, policyVersion: typeof policyApproval.policy_version === 'string' ? policyApproval.policy_version : String(policyApproval.legal_review_ref), phase: 'approve', now: createdAt })
      if (prior.pointsToRevoke > 0) await this.freezeSourcePoints(client, prior, createdAt)
      return this.insert(client, workspaceId, { ...prior, revision: prior.revision + 1, eventType: 'approved', actorId, reason, evidence: { ...prior.evidence, policy_approval: policyApproval }, externalRefundId: null, at: createdAt })
    })
  }

  async reject(input: Parameters<CommercialRefundRepository['reject']>[0]): Promise<CommercialRefundEvent> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const requestId = text(input.requestId, 'requestId'); const actorId = text(input.actorId, 'actorId'); const reason = text(input.reason, 'reason'); const createdAt = at(input.at); const rejectionEvidence = evidence(input.evidence)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      await this.lockWorkspace(client, workspaceId)
      const prior = await this.latestIn(client, workspaceId, requestId)
      if (!prior || prior.eventType !== 'requested') throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund request is not awaiting decision')
      const policy = prior.evidence.policy_approval as Record<string, unknown> | undefined
      await this.recoverSource(client, { workspaceId, orderId: prior.orderId, requestId: prior.requestId, amountFen: prior.amountFen, pointsToRevoke: prior.pointsToRevoke, policyVersion: String(policy?.policy_version ?? policy?.legal_review_ref ?? ''), phase: 'reject', now: createdAt })
      return this.insert(client, workspaceId, { ...prior, revision: prior.revision + 1, eventType: 'rejected', actorId, reason, evidence: { ...prior.evidence, rejection: rejectionEvidence }, externalRefundId: null, at: createdAt })
    })
  }

  async complete(input: Parameters<CommercialRefundRepository['complete']>[0]): Promise<CommercialRefundEvent> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const requestId = text(input.requestId, 'requestId'); const actorId = text(input.actorId, 'actorId'); const reason = text(input.reason, 'reason'); const externalRefundId = text(input.externalRefundId, 'externalRefundId'); const completionEvidence = evidence(input.evidence); const createdAt = at(input.at)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => { await this.lockWorkspace(client, workspaceId); return this.completeIn(client, { workspaceId, requestId, actorId, reason, externalRefundId, completionEvidence, createdAt }) })
  }

  async completeWithPointRevoke(input: Parameters<CommercialRefundRepository['complete']>[0], lifecycle: PostgresCreativePointLifecycleRepository): Promise<CommercialRefundEvent> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const requestId = text(input.requestId, 'requestId'); const actorId = text(input.actorId, 'actorId'); const reason = text(input.reason, 'reason'); const externalRefundId = text(input.externalRefundId, 'externalRefundId'); const completionEvidence = evidence(input.evidence); const createdAt = at(input.at)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => { await this.lockWorkspace(client, workspaceId); return this.completeIn(client, { workspaceId, requestId, actorId, reason, externalRefundId, completionEvidence, createdAt }, async approved => {
      const requested = await client.query<EventRow>(`SELECT ${projection} FROM commercial_refund_events_v2 WHERE workspace_id=$1 AND request_id=$2 AND event_type='requested' ORDER BY revision ASC LIMIT 1`, [workspaceId, requestId])
      const maker = requested.rows[0] ? map(requested.rows[0]) : null
      if (!maker || maker.orderId !== approved.orderId || maker.pointsToRevoke !== approved.pointsToRevoke || maker.actorId === approved.actorId) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund is missing a consistent request and distinct approver')
      if (approved.pointsToRevoke === 0) return
      await client.query(`SELECT workspace_id FROM creative_point_access_state WHERE workspace_id=$1 FOR UPDATE`, [workspaceId])
      const released = await client.query<{ points: string | number }>(`UPDATE commercial_refund_source_holds_v2 SET released_at=$3::timestamptz WHERE workspace_id=$1 AND request_id=$2 AND released_at IS NULL RETURNING points`, [workspaceId, requestId, createdAt])
      const frozen = released.rows.reduce((sum, row) => sum + Number(row.points), 0)
      if (frozen !== approved.pointsToRevoke) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund must have a complete source-bound preflight freeze before external payout')
      await client.query(`UPDATE creative_point_access_state SET available_points=available_points+$2,revision=revision+1 WHERE workspace_id=$1 AND available_points IS NOT NULL`, [workspaceId, frozen])
      const state = await client.query<{ revision: string | number; available: string | number | null }>(`SELECT revision,available_points AS available FROM creative_point_access_state WHERE workspace_id=$1`, [workspaceId])
      const current = state.rows[0]
      if (!current || current.available === null || !Number.isSafeInteger(Number(current.revision))) throw new CreativePointRepositoryError('CREATIVE_POINT_BALANCE_UNKNOWN', 'creative point balance is unknown')
      await lifecycle.adjustInTransaction(client, { workspaceId, sourceOrderId: approved.orderId, approvalId: `refund:${requestId}`, pointsDelta: -approved.pointsToRevoke, expectedAccessRevision: Number(current.revision), actorId: maker.actorId, approvedByActorId: approved.actorId, reason, evidence: { refund_request_id: requestId, external_refund_id: externalRefundId, refund: completionEvidence }, idempotencyKey: `commercial.refund.points:${requestId}`, at: createdAt })
    }) })
  }

  private async completeIn(client: SqlClient, input: { workspaceId: string; requestId: string; actorId: string; reason: string; externalRefundId: string; completionEvidence: Record<string, unknown>; createdAt: string }, beforeInsert?: (approved: CommercialRefundEvent) => Promise<void>): Promise<CommercialRefundEvent> {
      const { workspaceId, requestId, actorId, reason, externalRefundId, completionEvidence, createdAt } = input
      const prior = await this.latestIn(client, workspaceId, requestId)
      if (prior?.eventType === 'completed') { if (prior.externalRefundId !== externalRefundId) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_REQUEST_CONFLICT', 'refund external fact changed'); return prior }
      if (!prior || prior.eventType !== 'approved') throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'refund request is not approved')
      const order = await client.query<{ amountFen: string | number; status: string }>('SELECT amount_fen AS "amountFen",status FROM commercial_orders_v2 WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, prior.orderId])
      if (!order.rows[0]) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_ORDER_NOT_FOUND', 'commercial order was not found')
      // Refunding a request is only sound while every other request for the
      // same order still fits inside the amount the customer actually paid.
      const committedFen = await this.committedIn(client, workspaceId, prior.orderId, requestId)
      if (order.rows[0].status !== 'paid' || prior.amountFen + committedFen > Number(order.rows[0].amountFen)) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'commercial order is no longer refundable within its paid amount')
      { const policy = prior.evidence.policy_approval as Record<string, unknown>; await this.recoverSource(client, { workspaceId, orderId: prior.orderId, requestId: prior.requestId, amountFen: prior.amountFen, pointsToRevoke: prior.pointsToRevoke, policyVersion: typeof policy?.policy_version === 'string' ? policy.policy_version : String(policy?.legal_review_ref ?? ''), phase: 'complete', now: createdAt }) }
      if (prior.pointsToRevoke > 0 && !beforeInsert) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'point recovery must commit with cash completion')
      await beforeInsert?.(prior)
      const event = await this.insert(client, workspaceId, { ...prior, revision: prior.revision + 1, eventType: 'completed', actorId, reason, evidence: { ...prior.evidence, completion: completionEvidence }, externalRefundId, at: createdAt })
      // The order leaves 'paid' only once the money actually paid out equals
      // what the customer paid. A first partial refund must keep the order
      // 'paid', otherwise every other approved request for the same order would
      // be refused by this check (and by the database trigger) while it is
      // still legitimately refundable, and could no longer be completed or
      // rejected — the request would be stuck with no legal exit.
      const refundedFen = await this.completedIn(client, workspaceId, prior.orderId)
      if (refundedFen >= Number(order.rows[0].amountFen)) {
        const settled = await client.query("UPDATE commercial_orders_v2 SET status='refunded' WHERE workspace_id=$1 AND id=$2 AND status='paid'", [workspaceId, prior.orderId])
        // The conditional update is the last line of defence: a completion that
        // matched no paid order row must never be reported as a success.
        if (settled.rowCount !== 1) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'commercial order was already refunded')
      }
      return event
  }

  private async recoverSource(client: SqlClient, input: { workspaceId: string; orderId: string; requestId: string; amountFen: number; pointsToRevoke: number; policyVersion: string; phase: 'approve' | 'complete' | 'reject'; now: string }) {
    if (this.sourceRecovery) return this.sourceRecovery(client, input)
    const v3 = await client.query(`SELECT order_id FROM commercial_order_terms_v3 WHERE workspace_id=$1 AND order_id=$2`, [input.workspaceId, input.orderId])
    if (v3.rows.length) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'source contract recovery executor is not configured; automatic refund is blocked')
  }

  private async lockWorkspace(client: SqlClient, workspaceId: string) { await client.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1),pg_catalog.hashtext($2))`, ['workspace_subscription_periods_v2', workspaceId]) }

  /** Approval is the preflight: freeze only source-order unused points before any external payout. */
  private async freezeSourcePoints(client: SqlClient, prior: CommercialRefundEvent, observedAt: string) {
    await client.query(`SELECT workspace_id FROM creative_point_access_state WHERE workspace_id=$1 FOR UPDATE`, [prior.workspaceId])
    const grants = await client.query<{ id: string; remaining: string | number }>(`SELECT g.id,g.points-COALESCE(a.points,0)-COALESCE(h.points,0) AS remaining FROM creative_point_grants g LEFT JOIN LATERAL(SELECT sum(points_delta) AS points FROM creative_point_allocations WHERE workspace_id=g.workspace_id AND grant_id=g.id) a ON true LEFT JOIN LATERAL(SELECT sum(points) AS points FROM commercial_refund_source_holds_v2 WHERE workspace_id=g.workspace_id AND grant_id=g.id AND released_at IS NULL) h ON true WHERE g.workspace_id=$1 AND ((g.source_type='commercial_order_v2' AND g.source_id=$2) OR (g.source_type='commercial_schedule_v3' AND EXISTS(SELECT 1 FROM commercial_point_grant_schedules_v3 cs WHERE cs.workspace_id=g.workspace_id AND cs.id=g.source_id AND cs.order_id=$2)) OR (g.source_type='onboarding_schedule_v2' AND EXISTS(SELECT 1 FROM onboarding_point_grant_schedules_v2 os WHERE os.workspace_id=g.workspace_id AND os.id=g.source_id AND os.onboarding_order_id=$2))) AND (g.expires_at IS NULL OR g.expires_at>$3::timestamptz) ORDER BY g.id FOR UPDATE OF g`, [prior.workspaceId, prior.orderId, observedAt])
    let remaining = prior.pointsToRevoke
    for (const grant of grants.rows) { const amount = Math.min(remaining, Math.max(0, Number(grant.remaining))); if (amount > 0) await client.query(`INSERT INTO commercial_refund_source_holds_v2(workspace_id,request_id,order_id,grant_id,points,created_at) VALUES($1,$2,$3,$4,$5,$6::timestamptz)`, [prior.workspaceId, prior.requestId, prior.orderId, grant.id, amount, observedAt]); remaining -= amount; if (!remaining) break }
    if (remaining) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'source order unused and unreserved points cannot cover refund; controlled compensation is required')
    const state = await client.query(`UPDATE creative_point_access_state SET available_points=available_points-$2,revision=revision+1,updated_at=$3::timestamptz WHERE workspace_id=$1 AND available_points >= $2`, [prior.workspaceId, prior.pointsToRevoke, observedAt])
    if (state.rowCount !== 1) throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_STATE_INVALID', 'source refund balance cannot be frozen')
  }

  async latest(workspaceIdInput: string, requestIdInput: string): Promise<CommercialRefundEvent | null> { const workspaceId = requireWorkspaceScope(workspaceIdInput); const requestId = text(requestIdInput, 'requestId'); return withWorkspaceTransaction(this.pool, workspaceId, client => this.latestIn(client, workspaceId, requestId)) }
  async history(workspaceIdInput: string, requestIdInput: string): Promise<CommercialRefundEvent[]> { const workspaceId = requireWorkspaceScope(workspaceIdInput); const requestId = text(requestIdInput, 'requestId'); return withWorkspaceTransaction(this.pool, workspaceId, async client => (await client.query<EventRow>(`SELECT ${projection} FROM commercial_refund_events_v2 WHERE workspace_id=$1 AND request_id=$2 ORDER BY revision ASC`, [workspaceId, requestId])).rows.map(map)) }
  async list(workspaceIdInput: string, options: { limit?: number; cursor?: string } = {}): Promise<CommercialRefundPage> {
    const workspaceId = requireWorkspaceScope(workspaceIdInput)
    const limit = options.limit ?? 100
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('limit must be between 1 and 100')
    let cursor: { createdAt: string; id: string } | undefined
    if (options.cursor) {
      try {
        if (typeof options.cursor !== 'string' || options.cursor.length > 4_096) throw new Error('invalid cursor')
        const decoded = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8')) as { workspaceId?: unknown; createdAt?: unknown; id?: unknown }
        if (decoded.workspaceId !== workspaceId || typeof decoded.createdAt !== 'string' || !Number.isFinite(Date.parse(decoded.createdAt)) || typeof decoded.id !== 'string' || !decoded.id.trim()) throw new Error('invalid cursor')
        cursor = { createdAt: new Date(decoded.createdAt).toISOString(), id: decoded.id }
      } catch { throw new CommercialRefundRepositoryError('COMMERCIAL_REFUND_INPUT_INVALID', '退款事件分页游标无效或与当前工作区不匹配') }
    }
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const [rows, count] = await Promise.all([
        client.query<EventRow>(`SELECT ${projection} FROM commercial_refund_events_v2 WHERE workspace_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text)) ORDER BY created_at DESC,id DESC LIMIT $4`, [workspaceId, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1]),
        client.query<{ total: number | string }>('SELECT count(*)::int AS total FROM commercial_refund_events_v2 WHERE workspace_id=$1', [workspaceId]),
      ])
      const hasMore = rows.rows.length > limit
      const items = rows.rows.slice(0, limit).map(map)
      const last = items.at(-1)
      return { items, total: Number(count.rows[0]?.total ?? 0), truncated: hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ workspaceId, createdAt: last.createdAt, id: last.id })).toString('base64url') : null }
    })
  }

  /** Money already committed against one order. Each request contributes the
   * largest amount it was ever approved or completed for, so an
   * approved-then-completed request is counted once (both revisions carry the
   * same amount) and the request currently being decided is excluded.
   *
   * The bound is deliberately keyed on the amount and not on the identity of a
   * request's highest revision: the event table is append-only, so a later
   * non-money revision ('requested', 'rejected', 'reconciliation_required')
   * must never erase money an earlier revision already committed. It mirrors
   * enforce_commercial_refund_cumulative_bound(), the database backstop. */
  private async committedIn(client: SqlClient, workspaceId: string, orderId: string, excludeRequestId?: string): Promise<number> {
    const result = await client.query<{ committedFen: string | number }>(
      `SELECT COALESCE(SUM(chain.amount_fen),0) AS "committedFen"
         FROM (
           SELECT request_id, MAX(amount_fen) AS amount_fen
             FROM commercial_refund_events_v2
            WHERE workspace_id=$1 AND order_id=$2 AND event_type IN ('approved','completed')
            GROUP BY request_id
         ) chain
        WHERE ($3::text IS NULL OR chain.request_id <> $3::text)`,
      [workspaceId, orderId, excludeRequestId ?? null],
    )
    return Number(result.rows[0]?.committedFen ?? 0)
  }

  /** Money actually paid out for one order: every 'completed' revision counts,
   * and each request can only ever reach one of them. */
  private async completedIn(client: SqlClient, workspaceId: string, orderId: string): Promise<number> {
    const result = await client.query<{ refundedFen: string | number }>(
      `SELECT COALESCE(SUM(amount_fen),0) AS "refundedFen"
         FROM commercial_refund_events_v2
        WHERE workspace_id=$1 AND order_id=$2 AND event_type='completed'`,
      [workspaceId, orderId],
    )
    return Number(result.rows[0]?.refundedFen ?? 0)
  }

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
