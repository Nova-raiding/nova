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
 * client. The connection is closed through `closeRedisClient`, so the fake
 * carries the two fields that chokepoint looks at - the open flag and `quit` -
 * and no `close`: a raw `client.close()` here is the regression the lock's
 * close is pinned against (it waits for the pending command queue to drain, so
 * one abandoned OAuth refresh parks shutdown for the whole grace period).
 */
function fakeClient(overrides: Record<string, unknown> = {}) {
  const state = { connected: false, quit: false, destroyed: false, errorListeners: 0 }
  const client = {
    on: (event: string) => { if (event === 'error') state.errorListeners += 1 },
    connect: async () => { state.connected = true },
    eval: async () => 1,
    isOpen: true,
    quit: async () => { state.quit = true },
    destroy: () => { state.destroyed = true },
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
    expect(state.quit).toBe(false)

    await created!.close()
    expect(state.quit).toBe(true)
  })

  it('returns no connection at all when REDIS_URL is unset', () => {
    expect(createRedisCredentialRefreshLock(undefined)).toBeUndefined()
    expect(createRedisCredentialRefreshLock('   ')).toBeUndefined()
  })

  it('does not turn a connection that is already closed into a shutdown rejection', async () => {
    // node-redis raises `ClientClosedError` from both `quit()` and `destroy()`
    // once its socket is closed. Neither may reach the caller's `finally`.
    const { client } = fakeClient({ isOpen: false })
    const created = createRedisCredentialRefreshLock('redis://127.0.0.1:6379', { clientFactory: () => client as unknown as RedisClientType })
    await expect(created!.close()).resolves.toBeUndefined()
  })

  it('does not turn a QUIT the peer refuses into a shutdown rejection', async () => {
    const { client, state } = fakeClient({
      // A live-looking socket whose QUIT fails is the state the chokepoint's
      // fallback exists for: the teardown has to complete anyway, and it must
      // not surface as a rejection the `finally` cannot distinguish from a real
      // failure.
      quit: async () => { throw new Error('The client is closed') },
    })
    const created = createRedisCredentialRefreshLock('redis://127.0.0.1:6379', { clientFactory: () => client as unknown as RedisClientType })
    await expect(created!.close()).resolves.toBeUndefined()
    expect(state.destroyed).toBe(true)
  })

  it('does not surface a failed connect as an unhandled rejection at shutdown', async () => {
    const { client } = fakeClient({ connect: async () => { throw new Error('connect ECONNREFUSED') } })
    const created = createRedisCredentialRefreshLock('redis://127.0.0.1:6379', { clientFactory: () => client as unknown as RedisClientType })
    await expect(created!.close()).resolves.toBeUndefined()
  })
})
