export type DomainErrorCode =
  | 'INVALID_FACT_TRANSITION'
  | 'FACT_CONFIRMATION_REQUIRED'
  | 'FACT_NOT_USABLE'
  | 'INVALID_TASK_TRANSITION'
  | 'TASK_VERSION_CONFLICT'
  | 'TASK_TERMINAL'
  | 'CONTENT_VERSION_INVALID'
  | 'CONTENT_VERSION_IMMUTABLE'
  | 'PUBLISH_CONFIRMATION_REQUIRED'
  | 'PUBLISH_CONFIRMATION_STALE'
  | 'PUBLISH_CONFIRMATION_EXPIRED'
  | 'PUBLISH_CONFIRMATION_REPLAYED'
  | 'PUBLISH_IDEMPOTENCY_CONFLICT'
  | 'PUBLISH_JOB_NOT_FOUND'
  | 'PUBLISH_INVALID_TRANSITION'
  | 'PUBLISH_UNKNOWN_REQUIRES_RECONCILIATION'
  | 'PUBLISH_RECONCILIATION_REQUIRED'
  | 'ONBOARDING_DATE_INVALID'
  | 'ONBOARDING_WINDOW_INVALID'
  | 'CANONICAL_IDENTITY_INVALID'
  | 'SERVICE_CAPACITY_INVALID'

export interface DomainError {
  readonly code: DomainErrorCode
  readonly message: string
  readonly details?: Readonly<Record<string, string>>
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DomainError }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })

export const err = (
  code: DomainErrorCode,
  message: string,
  details?: Readonly<Record<string, string>>,
): Result<never> => ({ ok: false, error: { code, message, details } })

export const isOk = <T>(result: Result<T>): result is { readonly ok: true; readonly value: T } => result.ok
