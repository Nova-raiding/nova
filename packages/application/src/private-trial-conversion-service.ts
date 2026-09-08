import type { PrivateTrialConversionOrderView, PrivateTrialEligibilityStatus } from '@merchant-marketing/contracts'

export type PrivateTrialConversionErrorCode =
  | 'PRIVATE_TRIAL_ELIGIBILITY_NOT_FOUND'
  | 'PRIVATE_TRIAL_ELIGIBILITY_STATE_INVALID'
  | 'PRIVATE_TRIAL_VALIDATION_UNVERIFIED'
  | 'PRIVATE_TRIAL_WINDOW_EXPIRED'
  | 'PRIVATE_TRIAL_PAYMENT_SUBJECT_MISMATCH'
  | 'PRIVATE_TRIAL_CREDIT_ALREADY_USED'
  | 'PRIVATE_TRIAL_ACCOUNTING_APPROVAL_REQUIRED'
  | 'COMMERCIAL_IDEMPOTENCY_CONFLICT'

export class PrivateTrialConversionError extends Error {
  constructor(readonly code: PrivateTrialConversionErrorCode, message: string) {
    super(message)
    this.name = 'PrivateTrialConversionError'
  }
}

export interface PrivateTrialEligibilityView {
  id: string
  workspaceId: string
  customerRef: string
  status: PrivateTrialEligibilityStatus
  revision: number
  expiresAt: string | null
}

export interface PrivateTrialConversionPort {
  createEligibility(input: { workspaceId: string; customerRef: string; inviteCode: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }): Promise<PrivateTrialEligibilityView>
  approveEligibility(input: { workspaceId: string; eligibilityId: string; expectedRevision: number; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }): Promise<PrivateTrialEligibilityView>
  bindValidationCompletion(input: { workspaceId: string; eligibilityId: string; trialOrderId: string; completedAt: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }): Promise<PrivateTrialEligibilityView>
  prepareCredit(input: { workspaceId: string; eligibilityId: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown>; now: string }): Promise<{ id: string; status: 'pending_accounting_approval' | 'approved' | 'applied' | 'rejected' | 'expired'; expiresAt: string }>
  approveCredit(input: { workspaceId: string; creditId: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown>; now: string }): Promise<{ id: string; status: 'approved' | 'applied'; expiresAt: string }>
  createConversionOrder(input: { workspaceId: string; creditId: string; actorId: string; idempotencyKey: string; reason: string; now: string }): Promise<PrivateTrialConversionOrderView>
  markCreditApplied(input: { workspaceId: string; creditId: string; orderId: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown>; now: string }): Promise<{ id: string; status: 'applied'; expiresAt: string }>
}

const text = (value: string, name: string) => {
  if (!value || value.trim() !== value) throw new TypeError(`${name} is required`)
  return value
}
const revision = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('expectedRevision must be a positive integer')
  return value
}
const evidence = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value as object).length === 0) throw new TypeError('evidence is required')
  return value as Record<string, unknown>
}
const iso = (value: string, name: string) => {
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${name} must be an ISO timestamp`)
  return new Date(value).toISOString()
}

/** Operations orchestration only: payment remains pending until a verified provider callback. */
export class PrivateTrialConversionService {
  constructor(private readonly port: PrivateTrialConversionPort, private readonly clock: () => Date = () => new Date()) {}

  createEligibility(input: { workspaceId: string; customerRef: string; inviteCode: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }) {
    return this.port.createEligibility({ ...input, inviteCode: text(input.inviteCode, 'inviteCode'), workspaceId: text(input.workspaceId, 'workspaceId'), customerRef: text(input.customerRef, 'customerRef'), actorId: text(input.actorId, 'actorId'), idempotencyKey: text(input.idempotencyKey, 'idempotencyKey'), reason: text(input.reason, 'reason'), evidence: evidence(input.evidence) })
  }

  approveEligibility(input: { workspaceId: string; eligibilityId: string; expectedRevision: number; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }) {
    return this.port.approveEligibility({ ...input, workspaceId: text(input.workspaceId, 'workspaceId'), eligibilityId: text(input.eligibilityId, 'eligibilityId'), expectedRevision: revision(input.expectedRevision), actorId: text(input.actorId, 'actorId'), idempotencyKey: text(input.idempotencyKey, 'idempotencyKey'), reason: text(input.reason, 'reason'), evidence: evidence(input.evidence) })
  }

  bindValidationCompletion(input: { workspaceId: string; eligibilityId: string; trialOrderId: string; completedAt: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }) {
    return this.port.bindValidationCompletion({ ...input, workspaceId: text(input.workspaceId, 'workspaceId'), eligibilityId: text(input.eligibilityId, 'eligibilityId'), trialOrderId: text(input.trialOrderId, 'trialOrderId'), completedAt: iso(input.completedAt, 'completedAt'), actorId: text(input.actorId, 'actorId'), idempotencyKey: text(input.idempotencyKey, 'idempotencyKey'), reason: text(input.reason, 'reason'), evidence: evidence(input.evidence) })
  }

  prepareCredit(input: { workspaceId: string; eligibilityId: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }) {
    return this.port.prepareCredit({ ...input, workspaceId: text(input.workspaceId, 'workspaceId'), eligibilityId: text(input.eligibilityId, 'eligibilityId'), actorId: text(input.actorId, 'actorId'), idempotencyKey: text(input.idempotencyKey, 'idempotencyKey'), reason: text(input.reason, 'reason'), evidence: evidence(input.evidence), now: this.clock().toISOString() })
  }

  approveCredit(input: { workspaceId: string; creditId: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }) {
    return this.port.approveCredit({ ...input, workspaceId: text(input.workspaceId, 'workspaceId'), creditId: text(input.creditId, 'creditId'), actorId: text(input.actorId, 'actorId'), idempotencyKey: text(input.idempotencyKey, 'idempotencyKey'), reason: text(input.reason, 'reason'), evidence: evidence(input.evidence), now: this.clock().toISOString() })
  }

  createConversionOrder(input: { workspaceId: string; creditId: string; actorId: string; idempotencyKey: string; reason: string }) {
    return this.port.createConversionOrder({ ...input, workspaceId: text(input.workspaceId, 'workspaceId'), creditId: text(input.creditId, 'creditId'), actorId: text(input.actorId, 'actorId'), idempotencyKey: text(input.idempotencyKey, 'idempotencyKey'), reason: text(input.reason, 'reason'), now: this.clock().toISOString() })
  }

  markCreditApplied(input: { workspaceId: string; creditId: string; orderId: string; actorId: string; idempotencyKey: string; reason: string; evidence: Record<string, unknown> }) {
    return this.port.markCreditApplied({ ...input, workspaceId: text(input.workspaceId, 'workspaceId'), creditId: text(input.creditId, 'creditId'), orderId: text(input.orderId, 'orderId'), actorId: text(input.actorId, 'actorId'), idempotencyKey: text(input.idempotencyKey, 'idempotencyKey'), reason: text(input.reason, 'reason'), evidence: evidence(input.evidence), now: this.clock().toISOString() })
  }
}
