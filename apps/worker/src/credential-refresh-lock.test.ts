import { describe, expect, it } from 'vitest'
import type { RedisClientType } from 'redis'
import { createRedisCredentialRefreshLock } from './redis-transport.js'

/**
 * The credential refresh lock opens its own Redis connection for every worker
 * that runs a connector role (`all`, `sync`, `publish`, `reconcile`).
 * node-redis keeps that socket referenced, so a lock factory that hands back no
 * way to close it keeps the process alive after SIGTERM: the poll loop returns,
 * the pg pool ends, and the container still waits out the full
 * `terminationGracePeriodSeconds` before the runtime SIGKILLs it.
 *
 * These cases need no server: the factory's `clientFactory` seam builds the
 * client.
 */
function fakeClient(overrides: Record<string, unknown> = {}) {
  const state = { connected: false, closed: false, errorListeners: 0 }
  const client = {
    on: (event: string) => { if (event === 'error') state.errorListeners += 1 },
    connect: async () => { state.connected = true },
    eval: async () => 1,
    close: async () => { state.closed = true },
    ...overrides,
  }
  return { client, state }
}

describe('worker credential refresh lock lifecycle', () => {
  it('exposes a close that releases the socket instead of leaving the worker unable to exit', async () => {
    const { client, state } = fakeClient()
    const created = createRedisCredentialRefreshLock('redis://127.0.0.1:6379', { clientFactory: () => client as unknown as RedisClientType })
    expect(created).toBeDefined()

    // The lock stays usable for the whole process lifetime, and a connection
    // error listener is attached so a failover cannot terminate the worker.
    await expect(created!.lock.tryAcquire('refresh:jd', 1_000)).resolves.toBeDefined()
    expect(state.errorListeners).toBe(1)
    expect(state.connected).toBe(true)
    expect(state.closed).toBe(false)

    await created!.close()
    expect(state.closed).toBe(true)
  })

  it('returns no connection at all when REDIS_URL is unset', () => {
    expect(createRedisCredentialRefreshLock(undefined)).toBeUndefined()
    expect(createRedisCredentialRefreshLock('   ')).toBeUndefined()
  })

  it('does not turn an already-closed connection into a shutdown rejection', async () => {
    const { client, state } = fakeClient({
      close: async () => { state.closed = true; throw new Error('The client is closed') },
    })
    const created = createRedisCredentialRefreshLock('redis://127.0.0.1:6379', { clientFactory: () => client as unknown as RedisClientType })
    await expect(created!.close()).resolves.toBeUndefined()
    expect(state.closed).toBe(true)
  })

  it('does not surface a failed connect as an unhandled rejection at shutdown', async () => {
    const { client } = fakeClient({ connect: async () => { throw new Error('connect ECONNREFUSED') } })
    const created = createRedisCredentialRefreshLock('redis://127.0.0.1:6379', { clientFactory: () => client as unknown as RedisClientType })
    await expect(created!.close()).resolves.toBeUndefined()
  })
})
