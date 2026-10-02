import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  evaluatePlatformModelGate,
  evaluatePlatformModelRelayGate,
  relayQuotaMonitorTiming,
  startPlatformRelayTokenQuotaMonitor,
  type RelayCredential,
  type RelayQuotaSnapshot,
  type RelayQuotaSnapshotStore,
} from './platform-model-gate.js'

const source = {
  NODE_ENV: 'production',
  MODEL_RELAY_BASE_URL: 'https://relay.example/v1',
  MODEL_RELAY_ALLOWED_HOSTS: 'relay.example',
  MODEL_RELAY_API_KEY: 'model-key',
  // The site uses one relay token for both capabilities in this fixture.
  VIDEO_MODEL_RELAY_API_KEY: 'model-key',
  AI_MODEL: 'text-v1',
  VIDEO_MODEL: 'video-v1',
}

const quotaResponse = () => new Response(JSON.stringify({
  code: true,
  data: { object: 'token_usage', unlimited_quota: false, total_granted: 100, total_used: 20, total_available: 80, expires_at: 0 },
}), { status: 200 })

class MemoryQuotaStore implements RelayQuotaSnapshotStore {
  readonly snapshots = new Map<RelayCredential, RelayQuotaSnapshot>()
  readonly leases = new Map<RelayCredential, { owner: string; expiresAt: number }>()
  fail = false

  async read(credential: RelayCredential): Promise<RelayQuotaSnapshot | undefined> {
    if (this.fail) throw new Error('store unavailable')
    const snapshot = this.snapshots.get(credential)
    return snapshot ? { ...snapshot } : undefined
  }

  async write(credential: RelayCredential, snapshot: RelayQuotaSnapshot, _ttlMs: number, _ownerId: string): Promise<void> {
    if (this.fail) throw new Error('store unavailable')
    const lease = this.leases.get(credential)
    if (!lease || lease.owner !== _ownerId || lease.expiresAt <= Date.now()) throw new Error('relay_quota_lease_lost')
    this.snapshots.set(credential, { ...snapshot })
  }

  async tryAcquire(credential: RelayCredential, owner: string, ttlMs: number): Promise<boolean> {
    if (this.fail) throw new Error('store unavailable')
    const current = this.leases.get(credential)
    if (current && current.expiresAt > Date.now() && current.owner !== owner) return false
    this.leases.set(credential, { owner, expiresAt: Date.now() + ttlMs })
    return true
  }

  async release(credential: RelayCredential, owner: string): Promise<void> {
    if (this.fail) throw new Error('store unavailable')
    if (this.leases.get(credential)?.owner === owner) this.leases.delete(credential)
  }
}

let stopMonitor: (() => void) | undefined

afterEach(() => {
  stopMonitor?.()
  stopMonitor = undefined
  vi.useRealTimers()
})

describe('platform relay quota polling boundary', () => {
  it('uses one site poll every five minutes with a fifteen-minute freshness window by default', () => {
    expect(relayQuotaMonitorTiming({})).toEqual({ refreshIntervalMs: 5 * 60_000, maxAgeMs: 15 * 60_000, cacheTtlMs: 20 * 60_000 })
    expect(relayQuotaMonitorTiming({ MODEL_RELAY_QUOTA_REFRESH_MS: '120000', MODEL_RELAY_QUOTA_MAX_AGE_MS: '300000' })).toEqual({ refreshIntervalMs: 120_000, maxAgeMs: 300_000, cacheTtlMs: 20 * 60_000 })
  })

  it('does not query the relay for repeated user/readiness evaluations and deduplicates one shared token', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => quotaResponse()) as unknown as typeof fetch
    stopMonitor = startPlatformRelayTokenQuotaMonitor(source, fetcher, { refreshIntervalMs: 30_000, maxAgeMs: 90_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)

    for (let index = 0; index < 100; index += 1) {
      expect(evaluatePlatformModelGate(source, 'text').ready).toBe(true)
      expect(evaluatePlatformModelGate(source, 'video').ready).toBe(true)
      expect(evaluatePlatformModelRelayGate(source).ready).toBe(true)
    }
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('lets one monitor refresh a site-wide snapshot while a second monitor only reads it', async () => {
    vi.useFakeTimers()
    const store = new MemoryQuotaStore()
    const firstFetcher = vi.fn(async () => quotaResponse()) as unknown as typeof fetch
    const secondFetcher = vi.fn(async () => quotaResponse()) as unknown as typeof fetch
    const firstStop = startPlatformRelayTokenQuotaMonitor(source, firstFetcher, { store, ownerId: 'api-a', refreshIntervalMs: 1_000, maxAgeMs: 2_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(firstFetcher).toHaveBeenCalledTimes(1)
    // Starting a second API/worker process must not cause another upstream read.
    stopMonitor = startPlatformRelayTokenQuotaMonitor(source, secondFetcher, { store, ownerId: 'api-b', refreshIntervalMs: 1_000, maxAgeMs: 2_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(secondFetcher).toHaveBeenCalledTimes(0)
    expect(evaluatePlatformModelGate(source, 'text').ready).toBe(true)
    expect(evaluatePlatformModelGate(source, 'video').ready).toBe(true)
    firstStop()
  })

  it('keeps a fresh finite snapshot usable when the next quota poll is rate limited', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn()
      .mockResolvedValueOnce(quotaResponse())
      .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '120' } })) as unknown as typeof fetch
    const store = new MemoryQuotaStore()
    stopMonitor = startPlatformRelayTokenQuotaMonitor(source, fetcher, { store, ownerId: 'api-a', refreshIntervalMs: 30_000, maxAgeMs: 90_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(evaluatePlatformModelRelayGate(source).ready).toBe(true)
    const firstSnapshot = store.snapshots.get('model')
    expect(firstSnapshot).toBeDefined()

    await vi.advanceTimersByTimeAsync(60_001)
    expect(fetcher).toHaveBeenCalledTimes(2)
    // The failed read must not replace the still-fresh finite snapshot.
    expect(evaluatePlatformModelRelayGate(source).ready).toBe(true)
    expect(store.snapshots.get('model')).toMatchObject({
      checkedAt: firstSnapshot!.checkedAt,
      expiresAt: firstSnapshot!.expiresAt,
      available: firstSnapshot!.available,
      nextRetryAt: expect.any(Number),
    })

    await vi.advanceTimersByTimeAsync(30_001)
    expect(evaluatePlatformModelRelayGate(source).ready).toBe(false)
    expect(evaluatePlatformModelRelayGate(source).reasons).toContain('relay_token_quota_stale')
  })

  it('blocks immediately when a rate-limited poll has no successful snapshot to retain', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '120' } })) as unknown as typeof fetch
    stopMonitor = startPlatformRelayTokenQuotaMonitor(source, fetcher, { refreshIntervalMs: 30_000, maxAgeMs: 90_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(evaluatePlatformModelRelayGate(source).ready).toBe(false)
    expect(evaluatePlatformModelRelayGate(source).reasons).toContain('relay_token_quota_rate_limited')
  })

  it('fails closed when a required shared store is unavailable instead of falling back to per-process polling', async () => {
    vi.useFakeTimers()
    const store = new MemoryQuotaStore()
    store.fail = true
    const fetcher = vi.fn(async () => quotaResponse()) as unknown as typeof fetch
    stopMonitor = startPlatformRelayTokenQuotaMonitor(source, fetcher, { store, requireSharedStore: true, refreshIntervalMs: 1_000, maxAgeMs: 2_000 })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fetcher).toHaveBeenCalledTimes(0)
    expect(evaluatePlatformModelRelayGate(source).ready).toBe(false)
    expect(evaluatePlatformModelRelayGate(source).reasons).toEqual(expect.arrayContaining(['relay_token_quota_shared_store_unavailable']))
  })

  it('does not keep serving a previously fresh snapshot after a required store read fails', async () => {
    vi.useFakeTimers()
    const store = new MemoryQuotaStore()
    const fetcher = vi.fn(async () => quotaResponse()) as unknown as typeof fetch
    stopMonitor = startPlatformRelayTokenQuotaMonitor(source, fetcher, { store, requireSharedStore: true, refreshIntervalMs: 30_000, maxAgeMs: 90_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(evaluatePlatformModelRelayGate(source).ready).toBe(true)

    store.fail = true
    await vi.advanceTimersByTimeAsync(30_000)
    expect(evaluatePlatformModelRelayGate(source).ready).toBe(false)
    expect(evaluatePlatformModelRelayGate(source).reasons).toEqual(expect.arrayContaining(['relay_token_quota_shared_store_unavailable']))
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
