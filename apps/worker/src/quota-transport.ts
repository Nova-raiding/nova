import { createClient, type RedisClientType } from 'redis'
import { InMemoryQuotaCounterStore, type QuotaCounterStore } from '../../../packages/quotas/src/admission.js'
import { InMemoryLeaseLockStore, KeyedLeaseLock, type LeaseLockStore } from '../../../packages/quotas/src/lock.js'

interface RedisQuotaCounterStore extends QuotaCounterStore {}

export async function createQuotaCounterStore(url: string | undefined): Promise<{ store: QuotaCounterStore; lock: KeyedLeaseLock; close: () => Promise<void>; mode: 'redis_atomic' | 'process_local' }> {
  if (!url?.trim()) return { store: new InMemoryQuotaCounterStore(), lock: new KeyedLeaseLock(new InMemoryLeaseLockStore()), close: async () => undefined, mode: 'process_local' }
  const client = createClient({ url: url.trim() }) as RedisClientType
  client.on('error', () => undefined)
  await client.connect()
  const store: RedisQuotaCounterStore = {
    async increment(key, windowSeconds) {
      const result = await client.eval(`
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
        return count
      `, { keys: [key], arguments: [String(windowSeconds)] })
      return Number(result)
    },
  }
  const lock: LeaseLockStore = {
    async acquire(key, token, ttlMs) {
      const result = await client.set(`merchant:lock:${key}`, token, { NX: true, PX: ttlMs })
      return result === 'OK'
    },
    async release(key, token) {
      await client.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`, { keys: [`merchant:lock:${key}`], arguments: [token] })
    },
  }
  return { store, lock: new KeyedLeaseLock(lock), close: () => client.quit().then(() => undefined), mode: 'redis_atomic' }
}
