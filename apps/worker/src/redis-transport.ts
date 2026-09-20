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
 * queues behind a refresh that will never complete.
 *
 * The queue path needs this for a second reason, and a worse one. The poll
 * loop's only liveness evidence is the ready file whose mtime it refreshes
 * while an iteration is executing (`READY_FILE_HEARTBEAT_MS` in `main.ts`), so
 * an await that never settles parks the loop with a marker the probe still
 * reads as fresh: `find <ready-file> -mmin -2` stays true, kubelet never
 * restarts the pod, and that role's throughput goes to zero with every probe
 * green. Every round trip this module performs is bounded for that reason, and
 * a timeout surfaces as a failed iteration, which removes the marker.
 * Mirrors `withRedisOperationTimeout` in `apps/api/src/redis-resilience.ts`.
 */
export async function withRedisOperationTimeout<T>(operation: Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
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
 * The one place a Redis connection is closed. Every connection the worker
 * opens - the queue transport, the quota counters and the credential refresh
 * lock - goes through this function, because the shutdown contract is one
 * thing and not three: it returns within a bounded time, it never throws into
 * the caller's `finally`, and it releases the TCP socket. The last part is what
 * lets the container exit on SIGTERM instead of waiting out
 * `terminationGracePeriodSeconds` and being SIGKILLed, and node-redis makes it
 * the hard part:
 *
 *  - `quit()` is the graceful path, but it flips the socket's open flag to
 *    false *before* it awaits the QUIT reply (`RedisSocket.quit`). A peer that
 *    never answers - the blackholed socket this exists for - leaves that reply
 *    pending, so the budget abandons the call with the flag already false;
 *  - `close()` flips the same flag and then waits for the command queue to
 *    drain, which on a round trip no peer ever answered is never;
 *  - `destroy()` is the only method that rejects the queued commands and drops
 *    the socket without waiting, and it checks that same flag first: it throws
 *    `ClientClosedError` once the flag is false, which is exactly the state a
 *    timed-out `quit()` leaves behind.
 *
 * So the fallback below cannot be a bare `destroy()`: on the connection this
 * function exists for it throws, the socket stays referenced, and the caller's
 * `finally` is interrupted by a rejection it cannot distinguish from a real
 * teardown failure. The socket is released through node-redis' own teardown
 * step instead - `destroySocket()`, the call both `quit()` and `close()` make
 * on their success path, and the one that does not consult the open flag -
 * reached through `_ejectSocket()`, the client's hand-off of the live socket.
 *
 * Three states, all bounded and none of them thrown: an already-closed or
 * never-connected client has nothing to release and returns immediately; a
 * client whose teardown is already in flight (open flag false) returns
 * immediately as well; a live one gets the graceful attempt and then the
 * unconditional release.
 */
export async function closeRedisClient(client: RedisClientType): Promise<void> {
  if (!redisClientIsOpen(client)) return
  const quit = client.quit()
  // The teardown below rejects this command out of the client's queue when the
  // peer never answered. Without a handler that rejection is unhandled, and
  // Node's default policy for an unhandled rejection is to terminate the
  // process - during its own shutdown.
  quit.catch(() => undefined)
  try {
    await withRedisOperationTimeout(quit)
    return
  } catch {
    // The peer did not answer (or refused) the QUIT inside the budget.
  }
  try {
    // Not wasted even though the open flag is already false: `destroy()` flushes
    // the command queue before it looks at the socket, so every round trip the
    // budget abandoned settles with `DisconnectsClientError` instead of hanging
    // forever. When the flag is still open it also drops the socket, making the
    // release below a no-op.
    client.destroy()
  } catch {
    // The open flag was flipped by the QUIT above, so `destroy()` refused to
    // touch the socket; `destroyEjectedSocket` below is what releases it.
    destroyEjectedSocket(client)
  }
}

/** `isOpen` reads the client's socket, which is null after `_ejectSocket`. */
function redisClientIsOpen(client: RedisClientType): boolean {
  try {
    return client.isOpen
  } catch {
    return false
  }
}

/**
 * Destroys the socket of a client node-redis will no longer destroy for us.
 * Guarded end to end: a client that was already released, or never dialled,
 * has nothing here and must not turn shutdown into a rejection.
 */
function destroyEjectedSocket(client: RedisClientType): void {
  try {
    const socket = (client as unknown as { _ejectSocket?: () => { destroySocket(): void } | null })._ejectSocket?.()
    socket?.destroySocket()
  } catch {
    // Nothing left to release.
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
 *
 * The returned `close` is part of the contract, not a convenience: node-redis
 * keeps its socket referenced, so a worker that never closes this connection
 * cannot exit on SIGTERM. A rolling update then waits out the whole
 * `terminationGracePeriodSeconds` before the runtime SIGKILLs the container.
 * `connectRedisQueue` already returns its own `close` for the same reason; this
 * factory previously returned only the lock and left the socket live.
 */
export function createRedisCredentialRefreshLock(url: string | undefined, options: RedisQueueConnectionOptions = {}): { lock: RedisCredentialRefreshLock; close: () => Promise<void> } | undefined {
  if (!url?.trim()) return undefined
  const client = (options.clientFactory ?? redisTransportClient)(url.trim())
  client.on('error', () => undefined)
  const ready = client.connect()
  // A failed connect must not turn shutdown into a rejection that the finally
  // block cannot distinguish from a real teardown failure.
  ready.catch(() => undefined)
  const lock = new RedisCredentialRefreshLock({
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
  return {
    lock,
    // Same chokepoint as the queue and quota connections: a bare `close()` here
    // waits for the command queue to drain, so one abandoned OAuth refresh
    // round trip parks this call until the container is SIGKILLed.
    close: () => closeRedisClient(client),
  }
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
  // Every command below is bounded (see `withRedisOperationTimeout`): a claim,
  // an acknowledgement or a membership probe that never settles parks the poll
  // loop with a marker that still looks fresh to the liveness probe.
  const evaluate = async (script: string, keys: string[], args: Array<string | number>) => await withRedisOperationTimeout(client.eval(script, { keys, arguments: args.map(String) }))
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
      await withRedisOperationTimeout(client.zAdd(processingKey(key), { score: Date.now(), value }, { condition: 'XX' }))
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
    async contains(key, id) { return Number(await withRedisOperationTimeout(client.hExists(indexKey(key), id))) === 1 },
    async hasCapacity(key) {
      const [ready, delayed] = await withRedisOperationTimeout(Promise.all([client.lLen(key), client.zCard(delayedKey(key))]))
      return ready + delayed < maxDepth
    },
  }
  const callbackKey = (instanceId: string) => `${scannerHeartbeatKey(instanceId)}:last-callback-accepted-at`
  const scannerHeartbeat: ScannerHeartbeatRedisPort = {
    async publish(heartbeat, ttlSeconds) {
      const key = scannerHeartbeatKey(heartbeat.instanceId)
      const expiresAtMs = Date.parse(heartbeat.expiresAt)
      await withRedisOperationTimeout(client.multi()
        .set(key, JSON.stringify(heartbeat), { EX: ttlSeconds })
        .zAdd(SCANNER_HEARTBEAT_INDEX_KEY, { score: expiresAtMs, value: key })
        .zRemRangeByScore(SCANNER_HEARTBEAT_INDEX_KEY, 0, Date.now())
        .exec())
    },
    async remove(instanceId) {
      const key = scannerHeartbeatKey(instanceId)
      await withRedisOperationTimeout(client.multi().del(key).zRem(SCANNER_HEARTBEAT_INDEX_KEY, key).exec())
    },
    async recordCallbackAccepted(instanceId, acceptedAt, ttlSeconds) {
      if (!Number.isFinite(Date.parse(acceptedAt))) throw new Error('SCANNER_CALLBACK_ACCEPTED_AT_INVALID')
      await withRedisOperationTimeout(client.set(callbackKey(instanceId), acceptedAt, { EX: ttlSeconds }))
    },
    async lastCallbackAcceptedAt(instanceId) {
      return await withRedisOperationTimeout(client.get(callbackKey(instanceId))) ?? undefined
    },
  }
  return { transport, scannerHeartbeat, close: () => closeRedisClient(client) }
}
