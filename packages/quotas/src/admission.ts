export interface QuotaCounterStore {
  increment(key: string, windowSeconds: number): Promise<number>
}

export interface QuotaAdmissionInput {
  namespace: 'platform' | 'model'
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

/**
 * Fixed-window admission is deliberately placed immediately before an
 * external model/platform side effect. The counter store must be atomic in
 * production (Redis INCR or an equivalent provider); the in-memory store is
 * only for local tests.
 */
export class FixedWindowQuotaAdmission {
  constructor(private readonly store: QuotaCounterStore, private readonly now: () => number = () => Date.now()) {}

  async admit(input: QuotaAdmissionInput): Promise<QuotaDecision> {
    const limit = Math.max(1, Math.floor(input.limitPerWindow))
    const windowSeconds = Math.max(1, Math.floor(input.windowSeconds ?? 60))
    const bucket = Math.floor(this.now() / (windowSeconds * 1_000))
    const key = `merchant:quota:${input.namespace}:${input.key}:${bucket}`
    const used = await this.store.increment(key, windowSeconds + 2)
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
