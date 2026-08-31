import { describe, expect, it, vi } from 'vitest'
import { redisClientOptions, withRedisOperationTimeout } from './redis-resilience.js'

describe('Redis API resilience', () => {
  it('disables the offline queue and bounds reconnect attempts', () => {
    const options = redisClientOptions('redis://redis:6379', { REDIS_CONNECT_TIMEOUT_MS: '750' })
    expect(options.disableOfflineQueue).toBe(true)
    expect(options.socket?.connectTimeout).toBe(750)
    const strategy = options.socket?.reconnectStrategy
    expect(typeof strategy).toBe('function')
    expect((strategy as (retries: number) => number)(0)).toBe(50)
    expect((strategy as (retries: number) => number)(20)).toBe(1_000)
  })

  it('rejects a stalled command within the configured deadline', async () => {
    vi.useFakeTimers()
    try {
      const stalled = withRedisOperationTimeout(new Promise<string>(() => undefined), { REDIS_OPERATION_TIMEOUT_MS: '25' })
      const assertion = expect(stalled).rejects.toMatchObject({ code: 'REDIS_OPERATION_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(25)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
