import { describe, expect, it } from 'vitest'
import {
  WorkspaceRateLimiter,
  WORKSPACE_RATE_LIMIT_SCRIPT,
  type RateLimitRedisPort,
} from './workspace-rate-limit.js'

describe('workspace rate limiter', () => {
  it('uses Redis atomic INCRBY/EXPIRE semantics and isolates workspaces', async () => {
    const calls: Array<{ script: string; keys: string[]; args: string[] }> = []
    const counts = new Map<string, number>()
    const redis: RateLimitRedisPort = {
      async eval(script, keys, args) {
        calls.push({ script, keys, args })
        const key = keys[0]!
        const next = (counts.get(key) ?? 0) + Number(args[0])
        counts.set(key, next)
        return [next, 30]
      },
    }
    const limiter = new WorkspaceRateLimiter({ limit: 2, windowSeconds: 60, redis })

    await expect(limiter.check('ws/a')).resolves.toMatchObject({ allowed: true, remaining: 1, mode: 'redis' })
    await expect(limiter.check('ws/a')).resolves.toMatchObject({ allowed: true, remaining: 0 })
    await expect(limiter.check('ws/a')).resolves.toMatchObject({ allowed: false, reason: 'limit_exceeded', retryAfterSeconds: 30 })
    await expect(limiter.check('ws/b')).resolves.toMatchObject({ allowed: true, remaining: 1 })
    expect(calls).toHaveLength(4)
    expect(calls[0]!.script).toContain('INCRBY')
    expect(calls[0]!.script).toContain('EXPIRE')
    expect(calls[0]!.keys[0]).toContain('ws%2Fa')
  })

  it('fails closed by default when Redis is unavailable or malformed', async () => {
    const redis: RateLimitRedisPort = {
      async eval() { throw new Error('connection refused') },
    }
    const limiter = new WorkspaceRateLimiter({ limit: 5, windowSeconds: 60, redis })
    await expect(limiter.check('ws_1')).resolves.toMatchObject({
      allowed: false,
      mode: 'fail-closed',
      fallbackUsed: false,
      reason: 'redis_unavailable',
    })

    const malformed = new WorkspaceRateLimiter({
      limit: 5,
      windowSeconds: 60,
      redis: { async eval() { return ['not-a-count', '60'] } },
    })
    await expect(malformed.check('ws_1')).resolves.toMatchObject({ allowed: false, reason: 'redis_unavailable' })
  })

  it('uses memory only when explicitly selected and marks degraded decisions', async () => {
    let now = 1_000
    const limiter = new WorkspaceRateLimiter({ limit: 2, windowSeconds: 10, fallback: 'memory', now: () => now })
    await expect(limiter.check('ws_1')).resolves.toMatchObject({ allowed: true, mode: 'memory', fallbackUsed: false })
    await expect(limiter.check('ws_1')).resolves.toMatchObject({ allowed: true, remaining: 0 })
    await expect(limiter.check('ws_1')).resolves.toMatchObject({ allowed: false, reason: 'limit_exceeded', retryAfterSeconds: 10 })
    now = 11_001
    await expect(limiter.check('ws_1')).resolves.toMatchObject({ allowed: true, remaining: 1 })

    const degraded = new WorkspaceRateLimiter({
      limit: 1,
      windowSeconds: 60,
      fallback: 'memory',
      redis: { async eval() { throw new Error('down') } },
    })
    await expect(degraded.check('ws_2')).resolves.toMatchObject({ allowed: true, mode: 'memory', fallbackUsed: true })
  })

  it('fails closed when the memory fallback reaches its key capacity', async () => {
    const limiter = new WorkspaceRateLimiter({ limit: 2, windowSeconds: 60, fallback: 'memory', maxMemoryKeys: 1 })
    await expect(limiter.check('ws_1')).resolves.toMatchObject({ allowed: true })
    await expect(limiter.check('ws_2')).resolves.toMatchObject({
      allowed: false,
      mode: 'fail-closed',
      reason: 'memory_capacity',
    })
  })

  it('rejects invalid workspace/cost inputs and prevents accidental global buckets', async () => {
    const limiter = new WorkspaceRateLimiter({ limit: 2, windowSeconds: 60, fallback: 'memory' })
    await expect(limiter.check('')).resolves.toMatchObject({ allowed: false, reason: 'invalid_workspace' })
    await expect(limiter.check('   ')).resolves.toMatchObject({ allowed: false, reason: 'invalid_workspace' })
    await expect(limiter.check('ws_1', 0)).resolves.toMatchObject({ allowed: false, reason: 'invalid_cost' })
    await expect(limiter.check('ws_1', 3)).resolves.toMatchObject({ allowed: false, reason: 'invalid_cost' })
  })

  it('validates configuration', () => {
    expect(() => new WorkspaceRateLimiter({ limit: 0, windowSeconds: 60 })).toThrow(/positive/)
    expect(() => new WorkspaceRateLimiter({ limit: 1, windowSeconds: 0 })).toThrow(/positive/)
    expect(WORKSPACE_RATE_LIMIT_SCRIPT).toContain("redis.call('TTL'")
  })
})
