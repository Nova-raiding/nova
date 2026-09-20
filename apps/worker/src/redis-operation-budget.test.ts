import { describe, expect, it } from 'vitest'
import type { RedisClientType } from 'redis'
import { connectRedisQueue } from './redis-transport.js'
import { pollOnce } from './main.js'
import { RedisQueueAdapter, type DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import type { PostgresOutboxRepository } from '../../../packages/persistence/src/index.js'

/**
 * The worker's only liveness evidence is the ready file whose mtime it refreshes
 * while a poll iteration is executing (`READY_FILE_HEARTBEAT_MS` in `main.ts`).
 * An await inside that iteration which never settles therefore parks the loop
 * while the probe still reads the marker as fresh: `find <ready-file> -mmin -2`
 * stays true, kubelet never restarts a pod whose queue throughput is zero, and
 * the 15-minute durable lease keeps the parked work from being claimed anywhere
 * else. Every queue round trip has to fail instead, so the iteration reaches the
 * failure path that removes the marker and stops the heartbeat.
 *
 * Redis-free: `clientFactory` supplies the socket, so these cases run without a
 * server (unlike `redis-queue-transport.test.ts`, which is the real-Redis suite
 * and is excluded from the default vitest projects for that reason).
 */
describe('queue transport operation budget', () => {
  const url = 'redis://127.0.0.1:6399'
  const encoded = (id: string) => JSON.stringify({ id, value: JSON.stringify({ id }) })
  const heartbeat = { instanceId: 'instance-budget', expiresAt: new Date(Date.now() + 15_000).toISOString() } as Parameters<Awaited<ReturnType<typeof connectRedisQueue>>['scannerHeartbeat']['publish']>[0]

  const withBudget = async <T>(ms: string, run: () => Promise<T>): Promise<T> => {
    const previous = process.env.REDIS_OPERATION_TIMEOUT_MS
    process.env.REDIS_OPERATION_TIMEOUT_MS = ms
    try {
      return await run()
    } finally {
      if (previous === undefined) delete process.env.REDIS_OPERATION_TIMEOUT_MS
      else process.env.REDIS_OPERATION_TIMEOUT_MS = previous
    }
  }

  /**
   * A MULTI chain whose `exec` never settles, so the queue's heartbeat writes
   * (which build a chain synchronously and then await `exec`) hit the same
   * blackholed socket as every other command.
   */
  const stalledMulti = new Proxy({ exec: () => new Promise(() => undefined) }, {
    get(target, property) {
      const own = Reflect.get(target, property) as unknown
      if (typeof property !== 'string' || own !== undefined) return own
      return () => stalledMulti
    },
  })

  /**
   * A socket that was blackholed (peer node restarted, kube-proxy dropped the
   * flow, no FIN): the command is written and neither a reply nor an error ever
   * arrives, so with no timeout the awaited call never settles.
   */
  const blackholed = () => new Proxy({ on: () => undefined, connect: async () => undefined, destroy: () => undefined, multi: () => stalledMulti }, {
    get(target, property) {
      const own = Reflect.get(target, property) as unknown
      if (typeof property !== 'string' || own !== undefined) return own
      return () => new Promise(() => undefined)
    },
  }) as unknown as RedisClientType

  /** A socket that answers, but slowly: bounded is not the same as instant. */
  const slow = (delayMs: number, value: string) => new Proxy({
    on: () => undefined,
    connect: async () => undefined,
    destroy: () => undefined,
    quit: async () => 'OK',
    eval: () => new Promise(resolve => setTimeout(() => resolve(value), delayMs)),
  }, {
    get(target, property) {
      const own = Reflect.get(target, property) as unknown
      if (typeof property !== 'string' || own !== undefined) return own
      return () => new Promise(() => undefined)
    },
  }) as unknown as RedisClientType

  /** The code the operation failed on, or 'parked' when it never settles - the
   * regression this suite exists for. */
  const outcome = async (operation: Promise<unknown>): Promise<string> => await Promise.race([
    operation.then(() => 'settled', error => (error as { code?: string })?.code ?? 'rejected'),
    new Promise<string>(resolve => setTimeout(() => resolve('parked'), 1_000)),
  ])

  it('abandons every queue round trip a blackholed socket never answers', async () => {
    await withBudget('50', async () => {
      const { transport, scannerHeartbeat, close } = await connectRedisQueue(url, { clientFactory: () => blackholed() })
      const key = 'queue:budget'
      const steps: Array<[string, () => Promise<unknown>]> = [
        ['push', () => transport.push(key, encoded('evt_budget'))],
        ['pushDelayed', () => transport.pushDelayed!(key, encoded('evt_budget'), Date.now() + 1_000)],
        ['pop', () => transport.pop!(key, 0)],
        ['remove', () => transport.remove!(key, encoded('evt_budget'))],
        ['refresh', () => transport.refresh!(key, encoded('evt_budget'))],
        ['listStaleClaims', () => transport.listStaleClaims!(key, Date.now())],
        ['discardClaim', () => transport.discardClaim!(key, encoded('evt_budget'))],
        ['contains', () => transport.contains!(key, 'evt_budget')],
        ['hasCapacity', () => transport.hasCapacity!(key)],
        ['scannerHeartbeat.publish', () => scannerHeartbeat.publish(heartbeat, 15)],
        ['scannerHeartbeat.remove', () => scannerHeartbeat.remove(heartbeat.instanceId)],
        ['scannerHeartbeat.recordCallbackAccepted', () => scannerHeartbeat.recordCallbackAccepted(heartbeat.instanceId, new Date().toISOString(), 15)],
        ['scannerHeartbeat.lastCallbackAcceptedAt', () => scannerHeartbeat.lastCallbackAcceptedAt(heartbeat.instanceId)],
      ]
      for (const [name, step] of steps) expect([name, await outcome(step())]).toEqual([name, 'REDIS_OPERATION_TIMEOUT'])
      // Shutdown rides the same connection: a graceful `quit` that waits for
      // pending commands on a blackholed socket must not outlive the grace
      // period, or SIGTERM ends in a SIGKILL.
      await expect(close()).resolves.toBeUndefined()
    })
  }, 30_000)

  it('fails the poll instead of parking it when the queue socket stops answering', async () => {
    // The hop between the transport budget and the loop: the poll's first wait
    // is a queue call, so a blackholed socket has to surface as a poll failure
    // (which removes the marker and stops the heartbeat) rather than as an await
    // that never returns.
    await withBudget('50', async () => {
      const { transport, close } = await connectRedisQueue(url, { clientFactory: () => blackholed() })
      const event = { id: 'evt_stalled', workspaceId: 'ws_a', aggregateId: 'evt_stalled', eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date(1_000).toISOString(), attempts: 1, leaseToken: 'lease_stalled' } as DurableOutboxEvent
      const repository = {
        claimPending: async () => [event],
        validateLease: async () => event,
      } as unknown as PostgresOutboxRepository
      const outcome = await Promise.race([
        pollOnce(repository, new Map(), { workspaces: ['ws_a'], batchSize: 1, leaseMs: 30_000, role: 'publish' }, () => new RedisQueueAdapter<DurableOutboxEvent>(transport, 'queue:stalled'))
          .then(() => 'settled', error => (error as { code?: string })?.code ?? 'rejected'),
        new Promise<string>(resolve => setTimeout(() => resolve('parked'), 1_000)),
      ])
      expect(outcome).toBe('REDIS_OPERATION_TIMEOUT')
      await close()
    })
  }, 30_000)

  it('does not fail a slow but answering round trip, so a healthy slow cycle is not read as a stall', async () => {
    // No budget override: this pins the shipped default, so a timeout tightened
    // below the slowest healthy round trip fails here - the same false-restart
    // failure mode the ready-file heartbeat exists to prevent.
    const { transport, close } = await connectRedisQueue(url, { clientFactory: () => slow(120, encoded('evt_slow')) })
    const startedAt = Date.now()
    expect(await transport.pop!('queue:slow', 0)).toBe(encoded('evt_slow'))
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
    await close()
  })
})
