/**
 * Distributed, fixed-window rate limiting scoped to a workspace.
 *
 * A Redis client is deliberately represented by a tiny port so this package
 * does not depend on a particular Redis client implementation. The Redis
 * script performs INCRBY and EXPIRE in one server-side operation.
 */

export type RateLimitFallback = 'memory' | 'deny'
export type RateLimitMode = 'redis' | 'memory' | 'fail-closed'

export interface RateLimitRedisPort {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>
}

export interface WorkspaceRateLimitOptions {
  /** Maximum requests (or cost units) in one fixed window. */
  limit: number
  /** Window length in seconds. */
  windowSeconds: number
  /** Redis is preferred when supplied. No implicit Redis discovery is done. */
  redis?: RateLimitRedisPort
  /**
   * Redis failure behavior. `deny` is the safe default. `memory` must be
   * explicitly selected because it is only process-local and is not a
   * distributed enforcement boundary.
   */
  fallback?: RateLimitFallback
  keyPrefix?: string
  /** Maximum number of active keys retained by the process-local fallback. */
  maxMemoryKeys?: number
  now?: () => number
}

export type RateLimitReason =
  | 'allowed'
  | 'limit_exceeded'
  | 'redis_unavailable'
  | 'memory_capacity'
  | 'invalid_workspace'
  | 'invalid_cost'

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  retryAfterSeconds: number
  resetAt: number
  mode: RateLimitMode
  fallbackUsed: boolean
  reason: RateLimitReason
}

interface MemoryBucket {
  count: number
  expiresAt: number
}

/** Redis-side fixed-window counter. Return value is {count, ttlSeconds}. */
export const WORKSPACE_RATE_LIMIT_SCRIPT = `
local current = redis.call('INCRBY', KEYS[1], ARGV[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
`

export class WorkspaceRateLimiter {
  private readonly redis?: RateLimitRedisPort
  private readonly fallback: RateLimitFallback
  private readonly keyPrefix: string
  private readonly maxMemoryKeys: number
  private readonly now: () => number
  private readonly buckets = new Map<string, MemoryBucket>()

  readonly limit: number
  readonly windowSeconds: number

  constructor(options: WorkspaceRateLimitOptions) {
    if (!Number.isSafeInteger(options.limit) || options.limit <= 0) {
      throw new RangeError('Rate limit must be a positive safe integer')
    }
    if (!Number.isSafeInteger(options.windowSeconds) || options.windowSeconds <= 0) {
      throw new RangeError('Rate limit window must be a positive safe integer')
    }
    const maxMemoryKeys = options.maxMemoryKeys ?? 10_000
    if (!Number.isSafeInteger(maxMemoryKeys) || maxMemoryKeys <= 0) {
      throw new RangeError('Maximum memory keys must be a positive safe integer')
    }

    this.limit = options.limit
    this.windowSeconds = options.windowSeconds
    this.redis = options.redis
    this.fallback = options.fallback ?? 'deny'
    this.keyPrefix = options.keyPrefix ?? 'merchant:rate-limit:workspace'
    this.maxMemoryKeys = maxMemoryKeys
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Consume `cost` units for one workspace. A workspace ID is never allowed
   * to be empty, preventing accidental use of a shared/global bucket.
   */
  async check(workspaceId: string, cost = 1): Promise<RateLimitDecision> {
    if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
      return this.invalidDecision('invalid_workspace')
    }
    if (!Number.isSafeInteger(cost) || cost <= 0 || cost > this.limit) {
      return this.invalidDecision('invalid_cost')
    }

    if (this.redis) {
      try {
        return await this.checkRedis(workspaceId, cost)
      } catch {
        if (this.fallback === 'memory') {
          return this.checkMemory(workspaceId, cost, true)
        }
        return this.unavailableDecision()
      }
    }

    if (this.fallback === 'memory') {
      return this.checkMemory(workspaceId, cost, false)
    }
    return this.unavailableDecision()
  }

  private async checkRedis(workspaceId: string, cost: number): Promise<RateLimitDecision> {
    const result = await this.redis!.eval(
      WORKSPACE_RATE_LIMIT_SCRIPT,
      [this.redisKey(workspaceId)],
      [String(cost), String(this.windowSeconds)],
    )
    const [rawCount, rawTtl] = Array.isArray(result) ? result : []
    const count = Number(rawCount)
    const ttl = Number(rawTtl)
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(ttl) || ttl < 0) {
      throw new Error('Redis rate-limit response is invalid')
    }
    const now = this.now()
    return {
      allowed: count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - count),
      retryAfterSeconds: count <= this.limit ? 0 : ttl,
      resetAt: now + ttl * 1000,
      mode: 'redis',
      fallbackUsed: false,
      reason: count <= this.limit ? 'allowed' : 'limit_exceeded',
    }
  }

  private checkMemory(workspaceId: string, cost: number, fallbackUsed: boolean): RateLimitDecision {
    const now = this.now()
    this.pruneExpired(now)
    const key = this.redisKey(workspaceId)
    let bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= this.maxMemoryKeys) {
        return {
          allowed: false,
          limit: this.limit,
          remaining: 0,
          retryAfterSeconds: 1,
          resetAt: now + 1000,
          mode: 'fail-closed',
          fallbackUsed,
          reason: 'memory_capacity',
        }
      }
      bucket = { count: 0, expiresAt: now + this.windowSeconds * 1000 }
      this.buckets.set(key, bucket)
    }

    bucket.count += cost
    const allowed = bucket.count <= this.limit
    const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - bucket.count),
      retryAfterSeconds,
      resetAt: bucket.expiresAt,
      mode: 'memory',
      fallbackUsed,
      reason: allowed ? 'allowed' : 'limit_exceeded',
    }
  }

  private pruneExpired(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) this.buckets.delete(key)
    }
  }

  private invalidDecision(reason: 'invalid_workspace' | 'invalid_cost'): RateLimitDecision {
    const now = this.now()
    return {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      retryAfterSeconds: 0,
      resetAt: now,
      mode: 'fail-closed',
      fallbackUsed: false,
      reason,
    }
  }

  private unavailableDecision(): RateLimitDecision {
    const now = this.now()
    return {
      allowed: false,
      limit: this.limit,
      remaining: 0,
      retryAfterSeconds: 1,
      resetAt: now + 1000,
      mode: 'fail-closed',
      fallbackUsed: false,
      reason: 'redis_unavailable',
    }
  }

  private redisKey(workspaceId: string) {
    return `${this.keyPrefix}:${encodeURIComponent(workspaceId)}`
  }
}

export function createWorkspaceRateLimiter(options: WorkspaceRateLimitOptions) {
  return new WorkspaceRateLimiter(options)
}
