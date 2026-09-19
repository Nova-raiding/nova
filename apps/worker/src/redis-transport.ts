import { createClient, type RedisClientType } from 'redis'
import { RedisCredentialRefreshLock } from '../../../packages/connectors/src/index.js'
import type { RedisQueueTransport } from '../../../packages/workers/src/durable.js'
import { SCANNER_HEARTBEAT_INDEX_KEY, scannerHeartbeatKey, type ScannerHeartbeat } from '../../../packages/workers/src/scanner-heartbeat.js'

export interface ScannerHeartbeatRedisPort {
  publish(heartbeat: ScannerHeartbeat, ttlSeconds: number): Promise<void>
  remove(instanceId: string): Promise<void>
  recordCallbackAccepted(instanceId: string, acceptedAt: string, ttlSeconds: number): Promise<void>
  lastCallbackAcceptedAt(instanceId: string): Promise<string | undefined>
}

export interface RedisQueueConnectionOptions {
  /**
   * Hard bound on ready + delayed entries. A deployment runs Redis with
   * `noeviction`, so an unbounded queue eventually turns into a write outage
   * instead of backpressure.
   */
  maxDepth?: number
  /** Test seam: builds the client instead of the default driver. */
  clientFactory?: (url: string) => RedisClientType
}

export const DEFAULT_QUEUE_MAX_DEPTH = 10_000

/**
 * The one place a queue connection is bound to its server.
 *
 * node-redis v5 has no `createClient(url)` overload — the only signature is
 * `createClient(options)`. A bare string is therefore accepted as an options
 * object whose every field is `undefined`, and the client silently dials the
 * driver default (`localhost:6379`) instead of the configured server. Callers
 * that pass a test seam (`options.clientFactory`) must follow the same shape.
 *
 * This is not caught by the type checker at the call sites below, because
 * `(options.clientFactory ?? redisTransportClient)(url)` resolves the call
 * against the seam's signature; the bare `createClient(url)` these call sites
 * used to have would have been a compile error on its own. The binding is
 * therefore pinned by a test instead
 * (`redis-queue-transport.test.ts`: "binds every queue connection to the
 * configured URL instead of the driver default").
 */
export function redisTransportClient(url: string): RedisClientType {
  return createClient({ url }) as RedisClientType
}

export class RedisQueueDepthExceededError extends Error {
  readonly code = 'WORKER_QUEUE_DEPTH_EXCEEDED'
  constructor() {
    super('durable queue is at its configured depth limit')
    this.name = 'RedisQueueDepthExceededError'
  }
}

const DEFAULT_REDIS_OPERATION_TIMEOUT_MS = 1_500

function positiveMilliseconds(raw: string | undefined, fallback: number): number {
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Bounds a single Redis round trip. Without it a stalled socket — or a command
 * parked in node-redis' default offline queue while the connection is down —
 * makes the awaited call below never settle, so every publish on this replica
 * queues behind a refresh that will never complete. Mirrors
 * `withRedisOperationTimeout` in `apps/api/src/redis-resilience.ts`.
 */
async function withRedisOperationTimeout<T>(operation: Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const timeoutMs = positiveMilliseconds(env.REDIS_OPERATION_TIMEOUT_MS, DEFAULT_REDIS_OPERATION_TIMEOUT_MS)
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(Object.assign(new Error(`Redis operation timed out after ${timeoutMs}ms`), { code: 'REDIS_OPERATION_TIMEOUT' })), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

/**
 * Cross-replica single-flight for OAuth credential refresh, so two worker pods
 * cannot rotate the same refresh token concurrently and invalidate each other.
 *
 * Deliberately duplicated with the API's factory of the same name
 * (`apps/api/src/server.ts`): the connectors package deliberately owns only the
 * two-method `RedisSingleFlightPort` so it stays free of a `redis` dependency,
 * and neither application can import the other's module. The two Lua scripts
 * and the per-operation timeout are kept identical in behaviour — this is the
 * part that must not drift, since a bare `await` here degrades the refresh path
 * (and every request waiting on it) without bound while the API fails closed.
 *
 * Remaining, deliberate differences:
 *  - this factory accepts `options.clientFactory` (test seam) and reads
 *    `REDIS_OPERATION_TIMEOUT_MS`, which the API's does not;
 *  - it still leaves node-redis' socket and offline-queue defaults alone, where
 *    the API's `redisClientOptions(url)` sets a connect timeout, a reconnect
 *    backoff and `disableOfflineQueue`, so this connection keeps those defaults.
 *    The timeout above is what keeps that from becoming an unbounded wait;
 *    tightening the socket options to match the API is a separate change.
 */
export function createRedisCredentialRefreshLock(url: string | undefined, options: RedisQueueConnectionOptions = {}) {
  if (!url?.trim()) return undefined
  const client = (options.clientFactory ?? redisTransportClient)(url.trim())
  client.on('error', () => undefined)
  const ready = client.connect()
  return new RedisCredentialRefreshLock({
    async setIfAbsent(key, value, ttlMs) {
      await withRedisOperationTimeout(ready)
      const result = await withRedisOperationTimeout(client.eval(`
        if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
        return 0
      `, { keys: [key], arguments: [value, String(ttlMs)] }))
      return Number(result) === 1
    },
    async deleteIfValue(key, value) {
      await withRedisOperationTimeout(ready)
      await withRedisOperationTimeout(client.eval(`
        if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
        return 1
      `, { keys: [key], arguments: [value] }))
    },
  })
}

export async function connectRedisQueue(url: string, options: RedisQueueConnectionOptions = {}): Promise<{ transport: RedisQueueTransport; scannerHeartbeat: ScannerHeartbeatRedisPort; close: () => Promise<void> }> {
  const client = (options.clientFactory ?? redisTransportClient)(url)
  const maxDepth = options.maxDepth ?? DEFAULT_QUEUE_MAX_DEPTH
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new RangeError('maxDepth must be a positive integer')
  // node-redis emits connection failures as EventEmitter errors; without a
  // listener a transient failover terminates the worker process.
  client.on('error', () => undefined)
  await client.connect()
  const processingKey = (key: string) => `${key}:processing`
  const delayedKey = (key: string) => `${key}:delayed`
  const indexKey = (key: string) => `${key}:ids`
  // Claims are scored with the time of their last liveness proof: the claim
  // itself, then every heartbeat. Recovery therefore only reclaims work whose
  // worker stopped proving it was alive, never a handler that is still writing
  // to a platform. A retry also becomes claimable here instead of blocking the
  // worker (and every other tenant on it) for the length of its backoff.
  const claimScript = `
local now = ARGV[1]
local value = redis.call('RPOP', KEYS[1])
if not value then
  local due = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now, 'LIMIT', 0, 1)
  if due[1] then
    redis.call('ZREM', KEYS[3], due[1])
    value = due[1]
  end
end
if value then redis.call('ZADD', KEYS[2], now, value) end
return value`
  const pushScript = `
if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('LPUSH', KEYS[1], ARGV[1])
local ok, decoded = pcall(cjson.decode, ARGV[1])
if ok and decoded['id'] then redis.call('HINCRBY', KEYS[4], decoded['id'], 1) end
return 1`
  const pushDelayedScript = `
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[3]) then return 0 end
if redis.call('ZADD', KEYS[3], 'NX', ARGV[2], ARGV[1]) == 0 then
  redis.call('ZADD', KEYS[3], 'XX', ARGV[2], ARGV[1])
else
  local ok, decoded = pcall(cjson.decode, ARGV[1])
  if ok and decoded['id'] then redis.call('HINCRBY', KEYS[4], decoded['id'], 1) end
end
return 1`
  // ZREM is the guard, exactly as in discardClaimScript below: removing a claim
  // that was already acknowledged (or already discarded by a peer) must not
  // decrement the membership index a second time. The index backs contains(),
  // and restore() uses that answer to decide whether the event is already
  // queued; a count driven to zero while another delivery is still sitting in
  // the ready list would make restore() push a second delivery for an event
  // whose lease a live worker still owns.
  const removeScript = `
local removed = redis.call('ZREM', KEYS[2], ARGV[1])
if removed == 1 then
  local ok, decoded = pcall(cjson.decode, ARGV[1])
  if ok and decoded['id'] then
    local remaining = redis.call('HINCRBY', KEYS[3], decoded['id'], -1)
    if remaining <= 0 then redis.call('HDEL', KEYS[3], decoded['id']) end
  end
end
return 1`
  // Recovery is deliberately two separate steps. A stale liveness score is a
  // candidate, not proof the work stopped: moving it back to the ready queue
  // before the durable lease says the claim is gone is what allowed a peer to
  // pick up an event whose original handler was still writing. The caller
  // confirms each candidate against the database and only then discards it.
  const listStaleClaimsScript = `
return redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])`
  const discardClaimScript = `
local removed = redis.call('ZREM', KEYS[2], ARGV[1])
if removed == 1 then
  local ok, decoded = pcall(cjson.decode, ARGV[1])
  if ok and decoded['id'] then
    local remaining = redis.call('HINCRBY', KEYS[3], decoded['id'], -1)
    if remaining <= 0 then redis.call('HDEL', KEYS[3], decoded['id']) end
  end
end
return removed`
  const evaluate = async (script: string, keys: string[], args: Array<string | number>) => await client.eval(script, { keys, arguments: args.map(String) })
  const claim = async (key: string) => await evaluate(claimScript, [key, processingKey(key), delayedKey(key)], [Date.now()]) as string | null
  const transport: RedisQueueTransport = {
    async push(key, value) {
      const pushed = Number(await evaluate(pushScript, [key, processingKey(key), delayedKey(key), indexKey(key)], [value, maxDepth]))
      if (pushed !== 1) throw new RedisQueueDepthExceededError()
    },
    async pushDelayed(key, value, notBeforeEpochMs) {
      const pushed = Number(await evaluate(pushDelayedScript, [key, processingKey(key), delayedKey(key), indexKey(key)], [value, notBeforeEpochMs, maxDepth]))
      if (pushed !== 1) throw new RedisQueueDepthExceededError()
    },
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
    async remove(key, value) { await evaluate(removeScript, [key, processingKey(key), indexKey(key)], [value]) },
    async refresh(key, value) {
      // XX: never resurrect a claim that was already acknowledged.
      await client.zAdd(processingKey(key), { score: Date.now(), value }, { condition: 'XX' })
    },
    async listStaleClaims(key, olderThanEpochMs, limit = 32) {
      return await evaluate(listStaleClaimsScript, [key, processingKey(key)], [olderThanEpochMs, limit]) as string[]
    },
    // ZREM is the guard: a claim that was already acknowledged or already
    // discarded by a peer decrements the membership index exactly once.
    async discardClaim(key, value) {
      return Number(await evaluate(discardClaimScript, [key, processingKey(key), indexKey(key)], [value]))
    },
    // O(1) membership over ready + processing + delayed entries instead of
    // parsing both collections on every poll.
    async contains(key, id) { return Number(await client.hExists(indexKey(key), id)) === 1 },
    async hasCapacity(key) {
      return (await client.lLen(key)) + (await client.zCard(delayedKey(key))) < maxDepth
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
