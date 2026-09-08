import { createHash, randomUUID } from 'node:crypto'
import type { PrivateTrialConversionOrderView, PrivateTrialEligibilityStatus } from '@merchant-marketing/contracts'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'
import type { CommercialCatalogBenefit, CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'
import type { CommercialOrderV2 } from './commercial-contract-repository.js'

interface PrivateTrialEligibilityView {
  id: string
  workspaceId: string
  customerRef: string
  status: PrivateTrialEligibilityStatus
  revision: number
  expiresAt: string | null
}

export interface PrivateTrialInviteRecord {
  id: string
  workspaceId: string
  customerRef: string
  inviteCode: string | null
  status: 'active' | 'redeemed' | 'revoked' | 'expired'
  expiresAt: string
  redeemedAt: string | null
  redeemedEligibilityId: string | null
  issuedByActorId: string
  createdAt: string
}

export type PrivateTrialRepositoryErrorCode =
  | 'PRIVATE_TRIAL_ELIGIBILITY_NOT_FOUND'
  | 'PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID'
  | 'PRIVATE_TRIAL_VALIDATION_UNVERIFIED'
  | 'PRIVATE_TRIAL_WINDOW_EXPIRED'
  | 'PRIVATE_TRIAL_CREDIT_ALREADY_USED'
  | 'PRIVATE_TRIAL_ACCOUNTING_APPROVAL_REQUIRED'
  | 'COMMERCIAL_IDEMPOTENCY_CONFLICT'
  | 'COMMERCIAL_CATALOG_UNAVAILABLE'

export class PrivateTrialRepositoryError extends Error {
  constructor(readonly code: PrivateTrialRepositoryErrorCode, message: string) { super(message); this.name = 'PrivateTrialRepositoryError' }
}

type EligibilityRow = {
  id: string; workspaceId: string; customerRef: string; status: PrivateTrialEligibilityStatus; revision: string | number; expiresAt: string | Date | null
  approvedByActorId: string | null; businessApprovedAt: string | Date | null; validationCompletedAt: string | Date | null; trialOrderId: string | null; paymentSubjectRef: string | null
}
type EligibilityReplayRow = EligibilityRow & { inviteCodeHash: string }
type InviteRow = { id: string; workspaceId: string; customerRef: string; status: PrivateTrialInviteRecord['status']; expiresAt: string | Date; redeemedAt: string | Date | null; redeemedEligibilityId: string | null; issuedByActorId: string; createdAt: string | Date }
type CreditRow = {
  id: string; status: 'pending_accounting_approval' | 'approved' | 'applied' | 'rejected' | 'expired'; eligibilityId: string | null; trialOrderId: string; onboardingOrderId: string | null
  offsetFen: string | number; payableFen: string | number; expiresAt: string | Date | null; paymentSubjectRef: string | null; approvedByActorId: string | null
}
type CatalogRow = Omit<CommercialCatalogSkuSnapshot, 'priceFen' | 'effectiveAt' | 'benefits'> & { priceFen: number | string | null; effectiveAt: string | Date | null; benefits: CommercialCatalogBenefit[] }

interface PrivateTrialConversionPort {
  createEligibility(input: { workspaceId: string; customerRef: string; inviteCode: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }): Promise<PrivateTrialEligibilityView>
  approveEligibility(input: { workspaceId: string; eligibilityId: string; expectedRevision: number; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }): Promise<PrivateTrialEligibilityView>
  bindValidationCompletion(input: { workspaceId: string; eligibilityId: string; trialOrderId: string; completedAt: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }): Promise<PrivateTrialEligibilityView>
  prepareCredit(input: { workspaceId: string; eligibilityId: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown>; now: string }): Promise<{ id: string; status: 'pending_accounting_approval' | 'approved' | 'applied' | 'rejected' | 'expired'; expiresAt: string }>
  approveCredit(input: { workspaceId: string; creditId: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown>; now: string }): Promise<{ id: string; status: 'approved' | 'applied'; expiresAt: string }>
  createConversionOrder(input: { workspaceId: string; creditId: string; actorId: string; idempotencyKey: string; reason: string; now: string }): Promise<PrivateTrialConversionOrderView>
  markCreditApplied(input: { workspaceId: string; creditId: string; orderId: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown>; now: string }): Promise<{ id: string; status: 'applied'; expiresAt: string }>
}

const required = (value: string, field: string) => { if (!value || value.trim() !== value) throw new TypeError(`${field} is required`); return value }
const instant = (value: string, field: string) => { const parsed = new Date(value); if (Number.isNaN(parsed.valueOf())) throw new TypeError(`${field} must be an ISO timestamp`); return parsed.toISOString() }
const integer = (value: string | number, field: string) => { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 0) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', `${field} is invalid`); return parsed }
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}` : JSON.stringify(value)
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const date = (value: string | Date | null) => value === null ? null : new Date(value).toISOString()
const asEligibility = (row: EligibilityRow): PrivateTrialEligibilityView => ({ id: row.id, workspaceId: row.workspaceId, customerRef: row.customerRef, status: row.status, revision: integer(row.revision, 'revision'), expiresAt: date(row.expiresAt) })
const mapInvite = (row: InviteRow, inviteCode: string | null): PrivateTrialInviteRecord => ({ id: row.id, workspaceId: row.workspaceId, customerRef: row.customerRef, inviteCode, status: row.status, expiresAt: date(row.expiresAt)!, redeemedAt: date(row.redeemedAt), redeemedEligibilityId: row.redeemedEligibilityId, issuedByActorId: row.issuedByActorId, createdAt: date(row.createdAt)! })
const nextSevenDays = (completedAt: string) => { const value = new Date(completedAt); value.setUTCDate(value.getUTCDate() + 7); return value.toISOString() }

const eligibilityProjection = `id, workspace_id AS "workspaceId", customer_ref AS "customerRef", status, revision,
  expires_at AS "expiresAt", approved_by_actor_id AS "approvedByActorId", business_approved_at AS "businessApprovedAt",
  validation_completed_at AS "validationCompletedAt", trial_order_id AS "trialOrderId", payment_subject_ref AS "paymentSubjectRef"`

export class PostgresPrivateTrialConversionRepository implements PrivateTrialConversionPort {
  constructor(private readonly pool: SqlPool) {}

  async createInvite(input: { workspaceId: string; customerRef: string; expiresAt: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }): Promise<PrivateTrialInviteRecord> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const customerRef = required(input.customerRef, 'customerRef'); const expiresAt = instant(input.expiresAt, 'expiresAt')
    if (Date.parse(expiresAt) <= Date.now()) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_WINDOW_EXPIRED', 'invite expiry must be in the future')
    if (Object.keys(input.evidence).length === 0) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'invite evidence is required')
    const inviteCode = `ptinvite_${randomUUID().replaceAll('-', '')}`; const inviteCodeHash = createHash('sha256').update(inviteCode).digest('hex'); const now = new Date().toISOString()
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const replay = await client.query<InviteRow>(`SELECT id,workspace_id AS "workspaceId",customer_ref AS "customerRef",status,expires_at AS "expiresAt",redeemed_at AS "redeemedAt",redeemed_eligibility_id AS "redeemedEligibilityId",issued_by_actor_id AS "issuedByActorId",created_at AS "createdAt" FROM private_trial_invites_v2 WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceId, required(input.idempotencyKey, 'idempotencyKey')])
      if (replay.rows[0]) {
        const existing = replay.rows[0]
        if (existing.customerRef !== customerRef || date(existing.expiresAt) !== expiresAt) throw new PrivateTrialRepositoryError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'invite idempotency key is already bound to different inputs')
        return mapInvite(existing, null)
      }
      const inserted = await client.query<InviteRow>(`INSERT INTO private_trial_invites_v2 (id,workspace_id,customer_ref,invite_code_hash,idempotency_key,expires_at,issued_by_actor_id,evidence,created_at) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8::jsonb,$9::timestamptz) RETURNING id,workspace_id AS "workspaceId",customer_ref AS "customerRef",status,expires_at AS "expiresAt",redeemed_at AS "redeemedAt",redeemed_eligibility_id AS "redeemedEligibilityId",issued_by_actor_id AS "issuedByActorId",created_at AS "createdAt"`, [`pti_${randomUUID()}`, workspaceId, customerRef, inviteCodeHash, required(input.idempotencyKey, 'idempotencyKey'), expiresAt, required(input.actorId, 'actorId'), JSON.stringify(input.evidence), now])
      if (!inserted.rows[0]) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'private trial invite was not created')
      await this.inviteEvent(client, workspaceId, inserted.rows[0].id, 'created', input.actorId, input.idempotencyKey, input.reason, input.evidence, now)
      return mapInvite(inserted.rows[0], inviteCode)
    })
  }

  async listInvites(workspaceId: string, limit = 100): Promise<PrivateTrialInviteRecord[]> {
    const scope = requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const rows = await client.query<InviteRow>(`SELECT id,workspace_id AS "workspaceId",customer_ref AS "customerRef",status,expires_at AS "expiresAt",redeemed_at AS "redeemedAt",redeemed_eligibility_id AS "redeemedEligibilityId",issued_by_actor_id AS "issuedByActorId",created_at AS "createdAt" FROM private_trial_invites_v2 WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`, [scope, Math.min(100, Math.max(1, limit))])
      return rows.rows.map(row => mapInvite(row, null))
    })
  }

  async revokeInvite(input: { workspaceId: string; inviteId: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }): Promise<PrivateTrialInviteRecord> {
    const scope = requireWorkspaceScope(input.workspaceId); const now = new Date().toISOString()
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const replay = await client.query<InviteRow & { eventType: string; eventInviteId: string }>(`SELECT i.id,i.workspace_id AS "workspaceId",i.customer_ref AS "customerRef",i.status,i.expires_at AS "expiresAt",i.redeemed_at AS "redeemedAt",i.redeemed_eligibility_id AS "redeemedEligibilityId",i.issued_by_actor_id AS "issuedByActorId",i.created_at AS "createdAt",e.event_type AS "eventType",e.invite_id AS "eventInviteId" FROM private_trial_invite_events_v2 e JOIN private_trial_invites_v2 i ON i.workspace_id=e.workspace_id AND i.id=e.invite_id WHERE e.workspace_id=$1 AND e.idempotency_key=$2`, [scope, required(input.idempotencyKey, 'idempotencyKey')])
      if (replay.rows[0]) {
        if (replay.rows[0].eventType !== 'revoked' || replay.rows[0].eventInviteId !== input.inviteId) throw new PrivateTrialRepositoryError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'invite revocation idempotency key is already bound to another operation')
        return mapInvite(replay.rows[0], null)
      }
      const updated = await client.query<InviteRow>(`UPDATE private_trial_invites_v2 SET status='revoked' WHERE workspace_id=$1 AND id=$2 AND status='active' RETURNING id,workspace_id AS "workspaceId",customer_ref AS "customerRef",status,expires_at AS "expiresAt",redeemed_at AS "redeemedAt",redeemed_eligibility_id AS "redeemedEligibilityId",issued_by_actor_id AS "issuedByActorId",created_at AS "createdAt"`, [scope, required(input.inviteId, 'inviteId')])
      if (!updated.rows[0]) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_NOT_FOUND', 'active private trial invite was not found')
      await this.inviteEvent(client, scope, input.inviteId, 'revoked', input.actorId, input.idempotencyKey, input.reason, input.evidence, now)
      return mapInvite(updated.rows[0], null)
    })
  }

  async createEligibility(input: Parameters<PrivateTrialConversionPort['createEligibility']>[0]): Promise<PrivateTrialEligibilityView> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const now = new Date().toISOString()
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const replay = await client.query<EligibilityReplayRow>(`SELECT e.id,e.workspace_id AS "workspaceId",e.customer_ref AS "customerRef",e.status,e.revision,
        e.expires_at AS "expiresAt",e.approved_by_actor_id AS "approvedByActorId",e.business_approved_at AS "businessApprovedAt",
        e.validation_completed_at AS "validationCompletedAt",e.trial_order_id AS "trialOrderId",e.payment_subject_ref AS "paymentSubjectRef",
        i.invite_code_hash AS "inviteCodeHash"
        FROM private_trial_eligibility_events_v2 x JOIN private_trial_eligibilities_v2 e ON e.workspace_id=x.workspace_id AND e.id=x.eligibility_id
        JOIN private_trial_invites_v2 i ON i.workspace_id=e.workspace_id AND i.redeemed_eligibility_id=e.id
        WHERE x.workspace_id=$1 AND x.idempotency_key=$2`, [workspaceId, input.idempotencyKey])
      if (replay.rows[0]) {
        const inviteCodeHash = createHash('sha256').update(required(input.inviteCode, 'inviteCode')).digest('hex')
        if (replay.rows[0].customerRef !== input.customerRef || replay.rows[0].inviteCodeHash !== inviteCodeHash) throw new PrivateTrialRepositoryError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'eligibility idempotency key is already bound to different inputs')
        return asEligibility(replay.rows[0])
      }
      const id = `pte_${randomUUID()}`
      const invite = await this.lockRedeemableInvite(client, workspaceId, input.inviteCode, input.customerRef, now)
      const inserted = await client.query<EligibilityRow>(`INSERT INTO private_trial_eligibilities_v2 (id,workspace_id,customer_ref,status,evidence,revision,created_at) VALUES ($1,$2,$3,'pending_business_approval',$4::jsonb,1,$5::timestamptz) RETURNING ${eligibilityProjection}`, [id, workspaceId, required(input.customerRef, 'customerRef'), JSON.stringify(input.evidence), now])
      const row = inserted.rows[0]
      if (!row) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'private trial eligibility was not created')
      await this.redeemInvite(client, workspaceId, invite, id, now)
      await this.event(client, workspaceId, row.id, 'created', input.actorId, input.idempotencyKey, input.reason, input.evidence, now)
      return asEligibility(row)
    })
  }

  private async lockRedeemableInvite(client: SqlClient, workspaceId: string, inviteCode: string, customerRef: string, now: string): Promise<InviteRow> {
    const hash = createHash('sha256').update(required(inviteCode, 'inviteCode')).digest('hex')
    const locked = await client.query<InviteRow>(`SELECT id,workspace_id AS "workspaceId",customer_ref AS "customerRef",status,expires_at AS "expiresAt",redeemed_at AS "redeemedAt",redeemed_eligibility_id AS "redeemedEligibilityId",issued_by_actor_id AS "issuedByActorId",created_at AS "createdAt" FROM private_trial_invites_v2 WHERE workspace_id=$1 AND invite_code_hash=$2 FOR UPDATE`, [workspaceId, hash])
    const invite = locked.rows[0]
    if (!invite || invite.customerRef !== customerRef) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'private trial invite is invalid for this customer')
    if (invite.status !== 'active') throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'private trial invite is no longer active')
    if (Date.parse(date(invite.expiresAt)!) <= Date.parse(now)) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_WINDOW_EXPIRED', 'private trial invite has expired')
    return invite
  }

  private async redeemInvite(client: SqlClient, workspaceId: string, invite: InviteRow, eligibilityId: string, now: string) {
    const updated = await client.query(`UPDATE private_trial_invites_v2 SET status='redeemed',redeemed_at=$3::timestamptz,redeemed_eligibility_id=$4 WHERE workspace_id=$1 AND id=$2 AND status='active'`, [workspaceId, invite.id, now, eligibilityId])
    if (updated.rowCount !== 1) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'private trial invite was redeemed concurrently')
    await this.inviteEvent(client, workspaceId, invite.id, 'redeemed', 'system', `redeem:${eligibilityId}`, 'private trial invite redeemed', { eligibility_id: eligibilityId, customer_ref: invite.customerRef }, now)
  }

  async approveEligibility(input: Parameters<PrivateTrialConversionPort['approveEligibility']>[0]): Promise<PrivateTrialEligibilityView> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const now = new Date().toISOString()
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const current = await this.lockEligibility(client, workspaceId, input.eligibilityId)
      if (integer(current.revision, 'revision') !== input.expectedRevision || current.status !== 'pending_business_approval') throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'eligibility is no longer awaiting business approval')
      const updated = await client.query<EligibilityRow>(`UPDATE private_trial_eligibilities_v2 SET status='approved_pending_validation', approved_by_actor_id=$3, business_approved_at=$4::timestamptz, evidence=$5::jsonb, revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND revision=$6 RETURNING ${eligibilityProjection}`, [workspaceId, current.id, input.actorId, now, JSON.stringify(input.evidence), input.expectedRevision])
      if (!updated.rows[0]) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'eligibility approval conflicts with a newer decision')
      await this.event(client, workspaceId, current.id, 'business_approved', input.actorId, input.idempotencyKey, input.reason, input.evidence, now)
      return asEligibility(updated.rows[0])
    })
  }

  async bindValidationCompletion(input: Parameters<PrivateTrialConversionPort['bindValidationCompletion']>[0]): Promise<PrivateTrialEligibilityView> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const completedAt = instant(input.completedAt, 'completedAt')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const current = await this.lockEligibility(client, workspaceId, input.eligibilityId)
      if (current.status === 'approved' && current.trialOrderId === input.trialOrderId) return asEligibility(current)
      if (current.status !== 'approved_pending_validation') throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'eligibility needs an independent business approval before validation can bind')
      const payment = await client.query<{ skuKind: string; orderStatus: string; paidAt: string | Date | null; paymentSubjectRef: string | null }>(
        `SELECT s.kind AS "skuKind", o.status AS "orderStatus", o.paid_at AS "paidAt", p.payment_subject_ref AS "paymentSubjectRef"
           FROM commercial_orders_v2 o
           JOIN commercial_catalog_skus s ON s.id=o.sku_id
           JOIN commercial_payment_events_v2 p ON p.workspace_id=o.workspace_id AND p.order_id=o.id AND p.verified=true
          WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE OF o`, [workspaceId, input.trialOrderId],
      )
      const fact = payment.rows[0]
      if (!fact || fact.skuKind !== 'private_trial' || fact.orderStatus !== 'paid' || !fact.paidAt || !fact.paymentSubjectRef) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_VALIDATION_UNVERIFIED', 'validation must bind to one verified, paid private-trial payment with a provider payment subject')
      const paidAt = instant(date(fact.paidAt)!, 'paidAt')
      if (Date.parse(completedAt) < Date.parse(paidAt) || Date.parse(completedAt) > Date.parse(nextSevenDays(paidAt))) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_WINDOW_EXPIRED', 'validation completion is outside the paid seven-day trial period')
      const expiresAt = nextSevenDays(completedAt)
      const updated = await client.query<EligibilityRow>(`UPDATE private_trial_eligibilities_v2 SET status='approved', trial_order_id=$3, payment_subject_ref=$4, validation_completed_at=$5::timestamptz, expires_at=$6::timestamptz, revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND status='approved_pending_validation' RETURNING ${eligibilityProjection}`, [workspaceId, current.id, input.trialOrderId, fact.paymentSubjectRef, completedAt, expiresAt])
      if (!updated.rows[0]) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'validation binding conflicts with a newer eligibility state')
      await this.event(client, workspaceId, current.id, 'validation_bound', input.actorId, input.idempotencyKey, input.reason, { ...input.evidence, trial_order_id: input.trialOrderId, validation_completed_at: completedAt }, completedAt)
      return asEligibility(updated.rows[0])
    })
  }

  async prepareCredit(input: Parameters<PrivateTrialConversionPort['prepareCredit']>[0]): Promise<{ id: string; status: 'pending_accounting_approval' | 'approved' | 'applied' | 'rejected' | 'expired'; expiresAt: string }> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const now = instant(input.now, 'now')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const eligibility = await this.lockEligibility(client, workspaceId, input.eligibilityId)
      if (eligibility.status !== 'approved' || !eligibility.trialOrderId || !eligibility.paymentSubjectRef || !eligibility.expiresAt) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_VALIDATION_UNVERIFIED', 'an approved validation-bound eligibility is required before creating a credit')
      const expiresAt = instant(date(eligibility.expiresAt)!, 'expiresAt')
      if (Date.parse(expiresAt) <= Date.parse(now)) { await client.query(`UPDATE private_trial_eligibilities_v2 SET status='expired',revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND status='approved'`, [workspaceId, eligibility.id]); throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_WINDOW_EXPIRED', 'private trial conversion window has expired') }
      const existing = await client.query<CreditRow>(`SELECT id,status,eligibility_id AS "eligibilityId",trial_order_id AS "trialOrderId",onboarding_order_id AS "onboardingOrderId",offset_fen AS "offsetFen",payable_fen AS "payableFen",expires_at AS "expiresAt",payment_subject_ref AS "paymentSubjectRef",accounting_approved_by_actor_id AS "approvedByActorId" FROM private_trial_credits_v2 WHERE workspace_id=$1 AND trial_order_id=$2 FOR UPDATE`, [workspaceId, eligibility.trialOrderId])
      if (existing.rows[0]) return this.creditSummary(existing.rows[0])
      const id = `ptc_${randomUUID()}`
      const inserted = await client.query<CreditRow>(`INSERT INTO private_trial_credits_v2 (id,workspace_id,trial_order_id,status,amount_fen,offset_fen,payable_fen,payment_subject_ref,eligibility_id,approval_evidence,idempotency_key,created_at,expires_at) VALUES ($1,$2,$3,'pending_accounting_approval',500000,199900,300100,$4,$5,$6::jsonb,$7,$8::timestamptz,$9::timestamptz) RETURNING id,status,eligibility_id AS "eligibilityId",trial_order_id AS "trialOrderId",onboarding_order_id AS "onboardingOrderId",offset_fen AS "offsetFen",payable_fen AS "payableFen",expires_at AS "expiresAt",payment_subject_ref AS "paymentSubjectRef",accounting_approved_by_actor_id AS "approvedByActorId"`, [id, workspaceId, eligibility.trialOrderId, eligibility.paymentSubjectRef, eligibility.id, JSON.stringify({ eligibility_id: eligibility.id, validation_completed_at: eligibility.validationCompletedAt, source: input.evidence }), input.idempotencyKey, now, expiresAt])
      const credit = inserted.rows[0]
      if (!credit) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'private trial credit was not created')
      await this.creditEvent(client, workspaceId, credit.id, 'prepared', input.actorId, input.idempotencyKey, input.reason, { ...input.evidence, eligibility_id: eligibility.id, list_amount_fen: 500000, offset_amount_fen: 199900, payable_amount_fen: 300100 }, now)
      return this.creditSummary(credit)
    })
  }

  async approveCredit(input: Parameters<PrivateTrialConversionPort['approveCredit']>[0]): Promise<{ id: string; status: 'approved' | 'applied'; expiresAt: string }> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const now = instant(input.now, 'now')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const credit = await this.lockCredit(client, workspaceId, input.creditId)
      if (credit.status === 'applied') return this.creditSummary(credit) as { id: string; status: 'approved' | 'applied'; expiresAt: string }
      if (credit.status !== 'pending_accounting_approval') throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ACCOUNTING_APPROVAL_REQUIRED', 'credit is not pending accounting approval')
      if (!credit.expiresAt || Date.parse(date(credit.expiresAt)!) <= Date.parse(now)) { await client.query(`UPDATE private_trial_credits_v2 SET status='expired' WHERE workspace_id=$1 AND id=$2 AND status='pending_accounting_approval'`, [workspaceId, credit.id]); throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_WINDOW_EXPIRED', 'private trial conversion window has expired') }
      const eligibility = credit.eligibilityId ? await this.lockEligibility(client, workspaceId, credit.eligibilityId) : undefined
      if (!eligibility || eligibility.approvedByActorId === input.actorId) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'accounting approval must be performed by a different actor after business approval')
      const updated = await client.query<CreditRow>(`UPDATE private_trial_credits_v2 SET status='approved', accounting_approved_by_actor_id=$3, accounting_approved_at=$4::timestamptz, approval_evidence=$5::jsonb WHERE workspace_id=$1 AND id=$2 AND status='pending_accounting_approval' RETURNING id,status,eligibility_id AS "eligibilityId",trial_order_id AS "trialOrderId",onboarding_order_id AS "onboardingOrderId",offset_fen AS "offsetFen",payable_fen AS "payableFen",expires_at AS "expiresAt",payment_subject_ref AS "paymentSubjectRef",accounting_approved_by_actor_id AS "approvedByActorId"`, [workspaceId, credit.id, input.actorId, now, JSON.stringify(input.evidence)])
      if (!updated.rows[0]) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ACCOUNTING_APPROVAL_REQUIRED', 'credit approval conflicts with a newer state')
      await this.creditEvent(client, workspaceId, credit.id, 'accounting_approved', input.actorId, input.idempotencyKey, input.reason, input.evidence, now)
      return this.creditSummary(updated.rows[0]) as { id: string; status: 'approved' | 'applied'; expiresAt: string }
    })
  }

  async createConversionOrder(input: Parameters<PrivateTrialConversionPort['createConversionOrder']>[0]): Promise<PrivateTrialConversionOrderView> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const now = instant(input.now, 'now')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const credit = await this.lockCredit(client, workspaceId, input.creditId)
      if (credit.status !== 'approved') throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ACCOUNTING_APPROVAL_REQUIRED', 'only an accounting-approved private trial credit can create a formal order')
      const expiresAt = date(credit.expiresAt)
      if (!expiresAt || Date.parse(expiresAt) <= Date.parse(now)) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_WINDOW_EXPIRED', 'private trial conversion window has expired')
      if (credit.onboardingOrderId) {
        const prior = await client.query<CommercialOrderV2>(`SELECT id,workspace_id AS "workspaceId",sku_id AS "skuId",sku_version_id AS "skuVersionId",amount_fen AS "amountFen",currency,payment_provider AS "paymentProvider",status,idempotency_key AS "idempotencyKey",request_hash AS "requestHash",created_by_actor_id AS "createdByActorId",provider_order_id AS "providerOrderId",created_at AS "createdAt",paid_at AS "paidAt" FROM commercial_orders_v2 WHERE workspace_id=$1 AND id=$2`, [workspaceId, credit.onboardingOrderId])
        if (!prior.rows[0] || prior.rows[0].status !== 'pending') throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_CREDIT_ALREADY_USED', 'private trial credit already has a non-pending formal order')
        return this.orderView(credit, prior.rows[0].id, expiresAt)
      }
      if (integer(credit.offsetFen, 'offsetFen') !== 199900 || integer(credit.payableFen, 'payableFen') !== 300100 || !credit.paymentSubjectRef) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'private trial credit facts are incomplete')
      const sku = await this.onboardingSnapshot(client)
      const intent = { credit_id: credit.id, onboarding_sku_version_id: sku.versionId, list_amount_fen: 500000, offset_amount_fen: 199900, payable_amount_fen: 300100, payment_subject_digest: digest(credit.paymentSubjectRef) }
      const orderId = `cor_${randomUUID()}`
      const inserted = await client.query<CommercialOrderV2>(`INSERT INTO commercial_orders_v2 (id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,created_at) VALUES ($1,$2,$3,$4,300100,'CNY','manual_transfer','pending',$5,$6,$7,$8::timestamptz) RETURNING id,workspace_id AS "workspaceId",sku_id AS "skuId",sku_version_id AS "skuVersionId",amount_fen AS "amountFen",currency,payment_provider AS "paymentProvider",status,idempotency_key AS "idempotencyKey",request_hash AS "requestHash",created_by_actor_id AS "createdByActorId",provider_order_id AS "providerOrderId",created_at AS "createdAt",paid_at AS "paidAt"`, [orderId, workspaceId, sku.id, sku.versionId, input.idempotencyKey, digest(intent), input.actorId, now])
      const order = inserted.rows[0]
      if (!order) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_CREDIT_ALREADY_USED', 'formal order creation conflicts with an existing conversion')
      const snapshot = { schema_version: 'commercial-order.v2', sku, private_trial_conversion: intent }
      await client.query(`INSERT INTO commercial_order_snapshots_v2 (id,workspace_id,order_id,sku_id,sku_version_id,catalog_checksum,snapshot,checksum,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz)`, [`cos_${randomUUID()}`, workspaceId, order.id, sku.id, sku.versionId, sku.checksum, JSON.stringify(snapshot), digest(snapshot), now])
      const linked = await client.query(`UPDATE private_trial_credits_v2 SET onboarding_order_id=$3 WHERE workspace_id=$1 AND id=$2 AND onboarding_order_id IS NULL AND status='approved'`, [workspaceId, credit.id, order.id])
      if (linked.rowCount !== 1) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_CREDIT_ALREADY_USED', 'private trial credit was used concurrently')
      await this.creditEvent(client, workspaceId, credit.id, 'order_created', input.actorId, input.idempotencyKey, input.reason, { onboarding_order_id: order.id, list_amount_fen: 500000, offset_amount_fen: 199900, payable_amount_fen: 300100, payment_status: 'pending_provider_payment' }, now)
      await client.query(`INSERT INTO outbox_events (id,workspace_id,aggregate_id,event_type,sequence,payload) VALUES ($1,$2,$3,'commercial.private_trial_conversion_order_created',1,$4::jsonb)`, [`evt_${randomUUID()}`, workspaceId, order.id, JSON.stringify({ credit_id: credit.id, eligibility_id: credit.eligibilityId, order_id: order.id, payable_amount_fen: 300100 })])
      return this.orderView(credit, order.id, expiresAt)
    })
  }

  async markCreditApplied(input: Parameters<PrivateTrialConversionPort['markCreditApplied']>[0]): Promise<{ id: string; status: 'applied'; expiresAt: string }> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const now = instant(input.now, 'now')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const credit = await this.lockCredit(client, workspaceId, input.creditId)
      if (credit.status === 'applied') return this.creditSummary(credit) as { id: string; status: 'applied'; expiresAt: string }
      if (credit.status !== 'approved' || credit.onboardingOrderId !== input.orderId) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ACCOUNTING_APPROVAL_REQUIRED', 'only the approved conversion order can be marked applied')
      const updated = await client.query<CreditRow>(`UPDATE private_trial_credits_v2 SET status='applied', applied_at=$3::timestamptz WHERE workspace_id=$1 AND id=$2 AND status='approved' RETURNING id,status,eligibility_id AS "eligibilityId",trial_order_id AS "trialOrderId",onboarding_order_id AS "onboardingOrderId",offset_fen AS "offsetFen",payable_fen AS "payableFen",expires_at AS "expiresAt",payment_subject_ref AS "paymentSubjectRef",accounting_approved_by_actor_id AS "approvedByActorId"`, [workspaceId, input.creditId, now])
      if (!updated.rows[0]) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ACCOUNTING_APPROVAL_REQUIRED', 'private trial credit application conflicts with a newer state')
      await this.creditEvent(client, workspaceId, input.creditId, 'applied', input.actorId, input.idempotencyKey, input.reason, { ...input.evidence, order_id: input.orderId, payment_verified: true }, now)
      return this.creditSummary(updated.rows[0]) as { id: string; status: 'applied'; expiresAt: string }
    })
  }

  private async lockEligibility(client: SqlClient, workspaceId: string, eligibilityId: string): Promise<EligibilityRow> {
    const result = await client.query<EligibilityRow>(`SELECT ${eligibilityProjection} FROM private_trial_eligibilities_v2 WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, eligibilityId])
    if (!result.rows[0]) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_NOT_FOUND', 'private trial eligibility was not found in this workspace')
    return result.rows[0]
  }
  private async lockCredit(client: SqlClient, workspaceId: string, creditId: string): Promise<CreditRow> {
    const result = await client.query<CreditRow>(`SELECT id,status,eligibility_id AS "eligibilityId",trial_order_id AS "trialOrderId",onboarding_order_id AS "onboardingOrderId",offset_fen AS "offsetFen",payable_fen AS "payableFen",expires_at AS "expiresAt",payment_subject_ref AS "paymentSubjectRef",accounting_approved_by_actor_id AS "approvedByActorId" FROM private_trial_credits_v2 WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, creditId])
    if (!result.rows[0]) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_NOT_FOUND', 'private trial credit was not found in this workspace')
    return result.rows[0]
  }
  private async event(client: SqlClient, workspaceId: string, eligibilityId: string, eventType: string, actorId: string, idempotencyKey: string, reason: string, evidence: Record<string, unknown>, now: string) { await client.query(`INSERT INTO private_trial_eligibility_events_v2 (id,workspace_id,eligibility_id,event_type,actor_id,idempotency_key,reason,evidence,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz)`, [`ptevt_${randomUUID()}`, workspaceId, eligibilityId, eventType, actorId, idempotencyKey, reason, JSON.stringify(evidence), now]) }
  private async inviteEvent(client: SqlClient, workspaceId: string, inviteId: string, eventType: 'created' | 'redeemed' | 'revoked' | 'expired', actorId: string, idempotencyKey: string, reason: string, evidence: Record<string, unknown>, now: string) { await client.query(`INSERT INTO private_trial_invite_events_v2 (id,workspace_id,invite_id,event_type,actor_id,idempotency_key,reason,evidence,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz)`, [`ptievt_${randomUUID()}`, workspaceId, inviteId, eventType, actorId, idempotencyKey, reason, JSON.stringify(evidence), now]) }
  private async creditEvent(client: SqlClient, workspaceId: string, creditId: string, eventType: string, actorId: string, idempotencyKey: string, reason: string, evidence: Record<string, unknown>, now: string) { await client.query(`INSERT INTO private_trial_credit_events_v2 (id,workspace_id,credit_id,event_type,actor_id,idempotency_key,reason,evidence,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz)`, [`ptcevt_${randomUUID()}`, workspaceId, creditId, eventType, actorId, idempotencyKey, reason, JSON.stringify(evidence), now]) }
  private creditSummary(row: CreditRow) { const expiresAt = date(row.expiresAt); if (!expiresAt) throw new PrivateTrialRepositoryError('PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID', 'credit expiry is missing'); return { id: row.id, status: row.status, expiresAt } }
  private orderView(credit: CreditRow, orderId: string, expiresAt: string): PrivateTrialConversionOrderView { return { eligibility_id: credit.eligibilityId ?? '', credit_id: credit.id, onboarding_order_id: orderId, list_amount_fen: 500000, offset_amount_fen: 199900, payable_amount_fen: 300100, status: 'pending', expires_at: expiresAt } }
  private async onboardingSnapshot(client: SqlClient): Promise<CommercialCatalogSkuSnapshot> {
    const result = await client.query<CatalogRow>(`SELECT s.id,s.code,s.kind,s.visibility,s.required_capability AS "requiredCapability",v.id AS "versionId",v.version,v.lifecycle,v.executable,v.price_fen AS "priceFen",v.currency,v.price_mode AS "priceMode",v.duration_days AS "durationDays",v.payload,v.checksum,v.effective_at AS "effectiveAt",COALESCE((SELECT jsonb_agg(jsonb_build_object('code',b.benefit_code,'quantity',b.quantity,'rawValue',b.raw_value,'rawUnit',b.raw_unit,'normalizedValue',b.normalized_value,'policyRef',b.policy_ref,'metadata',b.metadata) ORDER BY b.benefit_code) FROM commercial_catalog_sku_benefits b WHERE b.sku_version_id=v.id),'[]'::jsonb) AS benefits FROM commercial_catalog_skus s JOIN commercial_catalog_sku_versions v ON v.sku_id=s.id WHERE s.code='onboarding_once' AND s.kind='onboarding' AND v.lifecycle='approved' AND v.executable=true AND v.effective_at <= now() ORDER BY v.version DESC LIMIT 2`)
    if (result.rows.length !== 1) throw new PrivateTrialRepositoryError('COMMERCIAL_CATALOG_UNAVAILABLE', 'exactly one active 5000 onboarding SKU is required for a private conversion')
    const row = result.rows[0]!
    const priceFen = row.priceFen === null ? null : Number(row.priceFen)
    if (priceFen !== 500000 || row.currency !== 'CNY' || row.priceMode !== 'fixed' || !row.effectiveAt) throw new PrivateTrialRepositoryError('COMMERCIAL_CATALOG_UNAVAILABLE', 'onboarding catalog price is not the approved 5000 CNY server snapshot')
    return { ...row, priceFen, effectiveAt: date(row.effectiveAt), payload: structuredClone(row.payload), benefits: structuredClone(row.benefits) }
  }
}
