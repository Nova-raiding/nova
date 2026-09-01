import { createHash } from 'node:crypto'
import { err, ok, type Result } from './result.js'

export type OnboardingImportOrderState = 'configuring' | 'accepted' | 'rejected' | 'expired'

export interface OnboardingImportWindowInput {
  readonly state: OnboardingImportOrderState
  readonly paidAt: string
  readonly configuringAt: string
  readonly acceptedAt?: string
  readonly now: string
}

export interface OnboardingImportWindow {
  readonly startsAt: string
  readonly endsAt: string
  readonly status: 'not_started' | 'open' | 'closed'
  readonly closeReason?: 'accepted' | 'paid_window_expired' | 'rejected'
}

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000

const parseIso = (value: string, field: string): Result<number> => {
  if (!value.trim()) return err('ONBOARDING_DATE_INVALID', `${field} is required`, { field })
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return err('ONBOARDING_DATE_INVALID', `${field} must be an ISO date`, { field })
  return ok(parsed)
}

/**
 * Resolve the immutable first-import window from the implementation order.
 * The paid 60-day deadline is never extended by a later acceptance.
 */
export const resolveOnboardingImportWindow = (input: OnboardingImportWindowInput): Result<OnboardingImportWindow> => {
  const configuring = parseIso(input.configuringAt, 'configuringAt')
  if (!configuring.ok) return configuring
  const paid = parseIso(input.paidAt, 'paidAt')
  if (!paid.ok) return paid
  const current = parseIso(input.now, 'now')
  if (!current.ok) return current
  if (paid.value < configuring.value) return err('ONBOARDING_WINDOW_INVALID', 'paidAt cannot precede configuringAt')

  const accepted = input.acceptedAt === undefined ? undefined : parseIso(input.acceptedAt, 'acceptedAt')
  if (accepted && !accepted.ok) return accepted
  if (accepted && accepted.value < configuring.value) return err('ONBOARDING_WINDOW_INVALID', 'acceptedAt cannot precede configuringAt')

  const paidDeadline = paid.value + SIXTY_DAYS_MS
  const acceptedDeadline = accepted?.value
  const endsAtMs = Math.min(acceptedDeadline ?? paidDeadline, paidDeadline)
  const startsAt = new Date(configuring.value).toISOString()
  const endsAt = new Date(endsAtMs).toISOString()
  if (input.state === 'rejected') return ok({ startsAt, endsAt, status: 'closed', closeReason: 'rejected' })
  if (current.value < configuring.value) return ok({ startsAt, endsAt, status: 'not_started' })
  if (current.value >= endsAtMs) {
    return ok({ startsAt, endsAt, status: 'closed', closeReason: acceptedDeadline !== undefined && acceptedDeadline <= paidDeadline && acceptedDeadline <= current.value ? 'accepted' : 'paid_window_expired' })
  }
  return ok({ startsAt, endsAt, status: 'open' })
}

const normalizeIdentityPart = (value: string): Result<string> => {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toUpperCase()
  if (!normalized) return err('CANONICAL_IDENTITY_INVALID', 'canonical identity parts must not be empty')
  return ok(normalized)
}

/** Build the stable, non-reversible identity key required for import idempotency. */
export const buildCanonicalIdentityHash = (input: { jurisdiction: string; registrationType: string; registrationNumber: string }): Result<string> => {
  const parts = [input.jurisdiction, input.registrationType, input.registrationNumber].map(normalizeIdentityPart)
  const invalid = parts.find(part => !part.ok)
  if (invalid && !invalid.ok) return invalid
  const canonical = parts.map(part => (part as { readonly ok: true; readonly value: string }).value).join('|')
  return ok(createHash('sha256').update(canonical, 'utf8').digest('hex'))
}
