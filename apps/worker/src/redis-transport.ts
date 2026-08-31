import { createClient, type RedisClientType } from 'redis'
import type { RedisQueueTransport } from '../../../packages/workers/src/durable.js'
import { SCANNER_HEARTBEAT_INDEX_KEY, scannerHeartbeatKey, type ScannerHeartbeat } from '../../../packages/workers/src/scanner-heartbeat.js'

export interface ScannerHeartbeatRedisPort {
  publish(heartbeat: ScannerHeartbeat, ttlSeconds: number): Promise<void>
  remove(instanceId: string): Promise<void>
  recordCallbackAccepted(instanceId: string, acceptedAt: string, ttlSeconds: number): Promise<void>
  lastCallbackAcceptedAt(instanceId: string): Promise<string | undefined>
}

export async function connectRedisQueue(url: string): Promise<{ transport: RedisQueueTransport; scannerHeartbeat: ScannerHeartbeatRedisPort; close: () => Promise<void> }> {
  const client = createClient({ url }) as RedisClientType
  // node-redis emits connection failures as EventEmitter errors; without a
  // listener a transient failover terminates the worker process.
  client.on('error', () => undefined)
  await client.connect()
  const processingKey = (key: string) => `${key}:processing`
  const claimScript = `
local value = redis.call('RPOP', KEYS[1])
if value then redis.call('ZADD', KEYS[2], ARGV[1], value) end
return value`
  const recoverScript = `
local values = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, 1000)
for _, value in ipairs(values) do
  redis.call('LPUSH', KEYS[1], value)
  redis.call('ZREM', KEYS[2], value)
end
return #values`
  const claim = async (key: string) => await client.eval(claimScript, { keys: [key, processingKey(key)], arguments: [String(Date.now())] }) as string | null
  const transport: RedisQueueTransport = {
    async push(key, value) { await client.lPush(key, value) },
    async pop(key, timeoutSeconds) {
      if (timeoutSeconds <= 0) return (await claim(key)) ?? undefined
      const deadline = Date.now() + timeoutSeconds * 1000
      do {
        const value = await claim(key)
        if (value) return value
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))))
      } while (Date.now() < deadline)
      return undefined
    },
    async remove(key, value) { await client.zRem(processingKey(key), value) },
    async recover(key, olderThanEpochMs) {
      return Number(await client.eval(recoverScript, { keys: [key, processingKey(key)], arguments: [String(olderThanEpochMs)] }))
    },
    async contains(key, id) {
      const ready = await client.lRange(key, 0, -1)
      if (ready.some(value => { try { return (JSON.parse(value) as { id?: unknown }).id === id } catch { return false } })) return true
      const processing = await client.zRange(processingKey(key), 0, -1)
      return processing.some(value => { try { return (JSON.parse(value) as { id?: unknown }).id === id } catch { return false } })
    },
  }
  const callbackKey = (instanceId: string) => `${scannerHeartbeatKey(instanceId)}:last-callback-accepted-at`
  const scannerHeartbeat: ScannerHeartbeatRedisPort = {
    async publish(heartbeat, ttlSeconds) {
      const key = scannerHeartbeatKey(heartbeat.instanceId)
      const expiresAtMs = Date.parse(heartbeat.expiresAt)
      await client.multi()
        .set(key, JSON.stringify(heartbeat), { EX: ttlSeconds })
        .zAdd(SCANNER_HEARTBEAT_INDEX_KEY, { score: expiresAtMs, value: key })
        .zRemRangeByScore(SCANNER_HEARTBEAT_INDEX_KEY, 0, Date.now())
        .exec()
    },
    async remove(instanceId) {
      const key = scannerHeartbeatKey(instanceId)
      await client.multi().del(key).zRem(SCANNER_HEARTBEAT_INDEX_KEY, key).exec()
    },
    async recordCallbackAccepted(instanceId, acceptedAt, ttlSeconds) {
      if (!Number.isFinite(Date.parse(acceptedAt))) throw new Error('SCANNER_CALLBACK_ACCEPTED_AT_INVALID')
      await client.set(callbackKey(instanceId), acceptedAt, { EX: ttlSeconds })
    },
    async lastCallbackAcceptedAt(instanceId) {
      return await client.get(callbackKey(instanceId)) ?? undefined
    },
  }
  return { transport, scannerHeartbeat, close: () => client.quit().then(() => undefined) }
}
