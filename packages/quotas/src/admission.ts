export interface QuotaCounterStore {
  increment(key: string, windowSeconds: number): Promise<number>
}

export interface QuotaAdmissionInput {
  namespace: 'platform' | 'model'
  /** The tenant/workspace owning the quota. Cross-tenant sharing is never implicit. */
  tenantId?: string
  key: string
  limitPerWindow: number
  windowSeconds?: number
}

export interface QuotaDecision {
  allowed: boolean
  retryAfterSeconds: number
  limitPerWindow: number
  used: number
}

export class QuotaExceededError extends Error {
  readonly code = 'QUOTA_EXHAUSTED'
  readonly retryable = true
  readonly unknown = false
  constructor(readonly decision: QuotaDecision) {
    super(`quota exhausted; retry after ${decision.retryAfterSeconds}s`)
    this.name = 'QuotaExceededError'
  }
}

export class InvalidQuotaInputError extends Error {
  readonly code = 'QUOTA_INPUT_INVALID'
  readonly retryable = false
  readonly unknown = false

  constructor(readonly field: string) {
    super(`quota input is invalid: ${field}`)
    this.name = 'InvalidQuotaInputError'
  }
}

export class QuotaStateUnavailableError extends Error {
  readonly code = 'QUOTA_STATE_UNAVAILABLE'
  readonly retryable = true
  readonly unknown = true

  constructor(cause: unknown) {
    super('quota state is unavailable')
    this.name = 'QuotaStateUnavailableError'
    this.cause = cause
  }
}

function validateSegment(value: string | undefined, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new InvalidQuotaInputError(field)
  }
  return value
}

function validatePositiveInteger(value: number, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new InvalidQuotaInputError(field)
  return value
}

function quotaKey(tenantId: string, namespace: QuotaAdmissionInput['namespace'], resourceKey: string, bucket: number): string {
  // Length-prefixing prevents delimiter-based collisions even when resource keys contain ':' or '%'.
  const encode = (value: string) => `${value.length}:${encodeURIComponent(value)}`
  return `merchant:quota:t=${encode(tenantId)}:n=${encode(namespace)}:r=${encode(resourceKey)}:b=${bucket}`
}

/**
 * Fixed-window admission is deliberately placed immediately before an
 * external model/platform side effect. The counter store must be atomic in
 * production (Redis INCR or an equivalent provider); the in-memory store is
 * only for local tests.
 */
export class FixedWindowQuotaAdmission {
  constructor(private readonly store: QuotaCounterStore, private readonly now: () => number = () => Date.now()) {}

  async admit(input: QuotaAdmissionInput): Promise<QuotaDecision> {
    const tenantId = validateSegment(input.tenantId, 'tenantId')
    const resourceKey = validateSegment(input.key, 'key')
    if (input.namespace !== 'platform' && input.namespace !== 'model') throw new InvalidQuotaInputError('namespace')
    const limit = validatePositiveInteger(input.limitPerWindow, 'limitPerWindow', 10_000_000)
    const windowSeconds = validatePositiveInteger(input.windowSeconds ?? 60, 'windowSeconds', 86_400)
    const bucket = Math.floor(this.now() / (windowSeconds * 1_000))
    const key = quotaKey(tenantId, input.namespace, resourceKey, bucket)
    let used: number
    try {
      used = await this.store.increment(key, windowSeconds + 2)
    } catch (error) {
      throw new QuotaStateUnavailableError(error)
    }
    if (!Number.isSafeInteger(used) || used < 1) throw new QuotaStateUnavailableError(new Error('counter returned an invalid value'))
    const allowed = used <= limit
    const elapsed = Math.floor(this.now() / 1_000) % windowSeconds
    const retryAfterSeconds = allowed ? 0 : Math.max(1, windowSeconds - elapsed)
    const decision = { allowed, retryAfterSeconds, limitPerWindow: limit, used }
    if (!allowed) throw new QuotaExceededError(decision)
    return decision
  }
}

export class InMemoryQuotaCounterStore implements QuotaCounterStore {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>()
  constructor(private readonly now: () => number = () => Date.now()) {}

  async increment(key: string, windowSeconds: number): Promise<number> {
    const current = this.counters.get(key)
    const now = this.now()
    if (!current || current.expiresAt <= now) {
      this.counters.set(key, { count: 1, expiresAt: now + windowSeconds * 1_000 })
      return 1
    }
    current.count += 1
    return current.count
  }
}
