import { createHash } from 'node:crypto'
import { createClient } from 'redis'
import { RedisCredentialRefreshLock } from '../../../packages/connectors/src/index.js'
import type { OAuthRedisPort } from '../../../packages/security/src/redis-oauth.js'
import { SCANNER_HEARTBEAT_INDEX_KEY } from '../../../packages/workers/src/scanner-heartbeat.js'
import { redisClientOptions, withRedisOperationTimeout } from './redis-resilience.js'

export function createRedisOAuthPort(url: string | undefined): OAuthRedisPort | undefined {
  if (!url?.trim()) return undefined
  const client = createClient(redisClientOptions(url.trim()))
  client.on('error', () => undefined)
  const ready = client.connect()
  return {
    async set(key, value, ttlSeconds) { await withRedisOperationTimeout(ready); await withRedisOperationTimeout(client.set(key, value, { EX: ttlSeconds })) },
    async get(key) { await withRedisOperationTimeout(ready); return await withRedisOperationTimeout(client.get(key)) },
    async eval(script, keys, args) { await withRedisOperationTimeout(ready); return await withRedisOperationTimeout(client.eval(script, { keys, arguments: args })) },
  }
}

export interface RedisRateLimitPort { increment(key: string, ttlSeconds: number): Promise<number> }
export interface RedisOneTimeNoncePort { consume(nonce: string, ttlSeconds: number): Promise<boolean> }
export interface RedisHealthPort {
  ping(): Promise<void>
  scannerHeartbeats(nowEpochMs: number): Promise<unknown[]>
}

export function createRedisHealth(url: string | undefined): RedisHealthPort | undefined {
  if (!url?.trim()) return undefined
  const client = createClient(redisClientOptions(url.trim()))
  client.on('error', () => undefined)
  const ready = client.connect()
  return {
    async ping() {
      await withRedisOperationTimeout(ready)
      await withRedisOperationTimeout(client.ping())
    },
    async scannerHeartbeats(nowEpochMs) {
      await withRedisOperationTimeout(ready)
      const keys = await withRedisOperationTimeout(client.zRangeByScore(SCANNER_HEARTBEAT_INDEX_KEY, `(${Math.floor(nowEpochMs)}`, '+inf'))
      if (keys.length === 0) return []
      return (await withRedisOperationTimeout(client.mGet(keys))).flatMap(value => {
        if (!value) return []
        try { return [JSON.parse(value) as unknown] } catch { return [] }
      })
    },
  }
}

export function createRedisAssetScannerNonce(url: string | undefined): RedisOneTimeNoncePort | undefined {
  if (!url?.trim()) return undefined
  const client = createClient(redisClientOptions(url.trim()))
  client.on('error', () => undefined)
  const ready = client.connect()
  return {
    async consume(nonce, ttlSeconds) {
      await withRedisOperationTimeout(ready)
      const digest = createHash('sha256').update(nonce).digest('hex')
      const result = await withRedisOperationTimeout(client.set(`merchant:asset-scanner-nonce:${digest}`, '1', { NX: true, EX: ttlSeconds }))
      return result === 'OK'
    },
  }
}

export function createRedisWorkerNonce(url: string | undefined): RedisOneTimeNoncePort | undefined {
  if (!url?.trim()) return undefined
  const client = createClient(redisClientOptions(url.trim()))
  client.on('error', () => undefined)
  const ready = client.connect()
  return {
    async consume(nonce, ttlSeconds) {
      await withRedisOperationTimeout(ready)
      const digest = createHash('sha256').update(nonce).digest('hex')
      const result = await withRedisOperationTimeout(client.set(`merchant:worker-nonce:${digest}`, '1', { NX: true, EX: ttlSeconds }))
      return result === 'OK'
    },
  }
}

export function createRedisRateLimit(url: string | undefined): RedisRateLimitPort | undefined {
  if (!url?.trim()) return undefined
  const client = createClient(redisClientOptions(url.trim()))
  client.on('error', () => undefined)
  const ready = client.connect()
  return {
    async increment(key, ttlSeconds) {
      await withRedisOperationTimeout(ready)
      const result = await withRedisOperationTimeout(client.eval(`
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
        return count
      `, { keys: [key], arguments: [String(ttlSeconds)] }))
      return Number(result)
    },
  }
}

export interface RedisJobAdmissionPort {
  acquire(workspaceId: string, reservationId: string, limit: number, ttlSeconds: number): Promise<'owned' | 'existing' | 'quota'>
  release(workspaceId: string, reservationId: string): Promise<void>
}

export interface RedisAutomationLeasePort {
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>
  renew(key: string, token: string, ttlMs: number): Promise<boolean>
  release(key: string, token: string): Promise<void>
}

/**
 * Cross-replica single-flight for OAuth credential refresh. Without it each
 * process serializes only against itself, so two pods can refresh the same
 * rotating refresh token concurrently and the loser's token is invalidated —
 * every later request from that side then fails until a manual reconnect.
 * Returns undefined without a Redis URL; the connector then falls back to its
 * in-process lock plus a best-effort read-check-write on the stored credential
 * (re-read, and adopt a peer's newer token instead of overwriting it). That is
 * NOT an atomic compare-and-swap: a peer that writes between the read and the
 * store is still overwritten. This lock is the only cross-replica mutual
 * exclusion; the read-check-write merely narrows the window.
 */
export function createRedisCredentialRefreshLock(url: string | undefined) {
  if (!url?.trim()) return undefined
  const client = createClient(redisClientOptions(url.trim()))
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

export function createRedisAutomationLease(url: string | undefined): RedisAutomationLeasePort | undefined {
  if (!url?.trim()) return undefined
  const client = createClient(redisClientOptions(url.trim()))
  client.on('error', () => undefined)
  const ready = client.connect()
  return {
    async acquire(key, token, ttlMs) {
      await withRedisOperationTimeout(ready)
      const result = await withRedisOperationTimeout(client.eval(`
        if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
        return 0
      `, { keys: [key], arguments: [token, String(ttlMs)] }))
      return Number(result) === 1
    },
    async renew(key, token, ttlMs) {
      await withRedisOperationTimeout(ready)
      const result = await withRedisOperationTimeout(client.eval(`
        if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
        return 0
      `, { keys: [key], arguments: [token, String(ttlMs)] }))
      return Number(result) === 1
    },
    async release(key, token) {
      await withRedisOperationTimeout(ready)
      await withRedisOperationTimeout(client.eval(`
        if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
        return 1
      `, { keys: [key], arguments: [token] }))
    },
  }
}

function admissionKey(workspaceId: string, reservationId: string) {
  return createHash('sha256').update(`${workspaceId}\n${reservationId}`).digest('hex')
}

export function createRedisJobAdmission(url: string | undefined): RedisJobAdmissionPort | undefined {
  if (!url?.trim()) return undefined
  const client = createClient(redisClientOptions(url.trim()))
  client.on('error', () => undefined)
  const ready = client.connect()
  return {
    async acquire(workspaceId, reservationId, limit, ttlSeconds) {
      await withRedisOperationTimeout(ready)
      const digest = admissionKey(workspaceId, reservationId)
      const result = await withRedisOperationTimeout(client.eval(`
        local reservation = KEYS[1]
        local counter = KEYS[2]
        if redis.call('EXISTS', reservation) == 1 then return 2 end
        local current = tonumber(redis.call('GET', counter) or '0')
        if current >= tonumber(ARGV[1]) then return 0 end
        redis.call('SET', reservation, '1', 'EX', ARGV[2])
        redis.call('INCR', counter)
        redis.call('EXPIRE', counter, ARGV[2])
        return 1
      `, { keys: [`merchant:job-admission:${digest}`, `merchant:job-admission-count:${createHash('sha256').update(workspaceId).digest('hex')}`], arguments: [String(limit), String(ttlSeconds)] }))
      return Number(result) === 1 ? 'owned' : Number(result) === 2 ? 'existing' : 'quota'
    },
    async release(workspaceId, reservationId) {
      await withRedisOperationTimeout(ready)
      const digest = admissionKey(workspaceId, reservationId)
      await withRedisOperationTimeout(client.eval(`
        if redis.call('DEL', KEYS[1]) == 1 then
          local current = tonumber(redis.call('DECR', KEYS[2]) or '0')
          if current <= 0 then redis.call('DEL', KEYS[2]) end
        end
        return 1
      `, { keys: [`merchant:job-admission:${digest}`, `merchant:job-admission-count:${createHash('sha256').update(workspaceId).digest('hex')}`], arguments: [] }))
    },
  }
}

