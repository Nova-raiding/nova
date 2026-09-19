import { createHash, randomUUID } from 'node:crypto'

/**
 * Refresh single-flight port.
 *
 * Rotating OAuth refresh tokens make concurrent refreshes destructive: when a
 * platform account's access token enters the expiry skew window, every replica
 * that serves a request for that account may POST `grant_type=refresh_token`
 * with the *same* refresh token. Providers either reject the loser with
 * `invalid_grant` or hand each caller its own single-use refresh token, so the
 * last writer wins and the other process is left holding a dead credential.
 * The publish lock cannot help: it is sharded by remote product id, so two
 * products of one account refresh concurrently by design.
 *
 * The connector therefore serializes refresh per (workspace, platform, account)
 * through this port. The default implementation is per-process; a host that
 * runs multiple replicas must inject a Redis-backed implementation so the
 * lease is shared across processes.
 */
export interface CredentialRefreshLease {
  /** Releases the lease. Only the holder that acquired it may release it. */
  release(): Promise<void>
}

export interface CredentialRefreshSingleFlight {
  /**
   * Atomically acquires the refresh lease for `key`. Resolves `undefined` when
   * another holder already owns a live lease; throws when the lease store
   * itself is unavailable (callers then fall back to the guarded read-modify-
   * write path instead of failing the request).
   */
  tryAcquire(key: string, ttlMs: number): Promise<CredentialRefreshLease | undefined>
}

/** A refresh is one token round trip plus one vault write; the lease only has
 * to outlive a slow provider, never an outbox retry. */
export const DEFAULT_REFRESH_LEASE_TTL_MS = 15_000

/**
 * Lease keys are derived, not concatenated: the identity contains merchant
 * controlled text (account ids) and must not be able to collide across
 * workspaces by embedding the separator.
 */
export function credentialRefreshKey(input: { platform: string; workspaceId?: string; accountId: string }): string {
  // Serialized as a JSON tuple rather than joined with a separator: merchant
  // account ids are caller controlled and could otherwise shift a separator
  // into another tenant's identity.
  const identity = createHash('sha256').update(JSON.stringify([input.platform, input.workspaceId ?? '', input.accountId])).digest('hex')
  return `merchant:connector:refresh:${identity}`
}

/** Shared by the in-process implementation and by callers that only need the
 * key/value pair for their own atomic primitive. */
export function newRefreshLeaseToken(): string { return randomUUID() }

/** Single-process lease. Correct for one connector instance (and therefore for
 * one worker/API process); it cannot serialize refresh across replicas. */
export class InProcessCredentialRefreshLock implements CredentialRefreshSingleFlight {
  private readonly leases = new Map<string, { token: string; expiresAt: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  async tryAcquire(key: string, ttlMs: number): Promise<CredentialRefreshLease | undefined> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('refresh lease TTL is invalid')
    const now = this.now()
    const existing = this.leases.get(key)
    if (existing && existing.expiresAt > now) return undefined
    const token = newRefreshLeaseToken()
    this.leases.set(key, { token, expiresAt: now + ttlMs })
    return {
      release: async () => {
        // A lease that already expired and was re-acquired by another holder
        // must never be released by the previous owner.
        if (this.leases.get(key)?.token === token) this.leases.delete(key)
      },
    }
  }
}

/**
 * Minimal Redis port. Implement with the same primitives the rest of the
 * codebase already uses (see `createRedisAutomationLease` in
 * `apps/api/src/server.ts`): `SET key value NX PX ttl` for `setIfAbsent` and
 * a compare-and-delete Lua script (`GET` then `DEL`) for `deleteIfValue`.
 * Keeping the port at two methods means this package never depends on a Redis
 * client.
 */
export interface RedisSingleFlightPort {
  setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean>
  deleteIfValue(key: string, value: string): Promise<void>
}

/** Cross-process lease over Redis. Inject one instance per connector runtime. */
export class RedisCredentialRefreshLock implements CredentialRefreshSingleFlight {
  constructor(private readonly redis: RedisSingleFlightPort) {}

  async tryAcquire(key: string, ttlMs: number): Promise<CredentialRefreshLease | undefined> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('refresh lease TTL is invalid')
    const token = newRefreshLeaseToken()
    const acquired = await this.redis.setIfAbsent(key, token, ttlMs)
    if (!acquired) return undefined
    return { release: async () => { await this.redis.deleteIfValue(key, token) } }
  }
}
