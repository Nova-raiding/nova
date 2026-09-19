import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type RedisClientType } from 'redis'
import { connectRedisQueue } from '../../../apps/worker/src/redis-transport.js'
import { DurableOutboxDispatcher, RedisQueueAdapter, type DurableOutboxEvent, type DurableOutboxStore } from './durable.js'

/**
 * Recovery regression coverage on REAL Redis. The queue layer is the production
 * transport (Lua scripts, processing ZSET, membership index); only persistence
 * is modelled, with the same lease semantics the durable repository enforces:
 * claiming rotates the token and increments the claim counter, and an outcome
 * write is rejected unless it carries the current, unexpired token.
 */
const redisUrl = process.env.REDIS_URL
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const staleLeaseError = () => Object.assign(new Error('outbox event not found'), { code: 'OUTBOX_EVENT_NOT_FOUND', name: 'OutboxEventNotFoundError' })
const processGone = () => Object.assign(new Error('worker process is gone'), { code: 'WORKER_PROCESS_GONE' })

class LeaseStore implements DurableOutboxStore {
  readonly rows = new Map<string, DurableOutboxEvent>()
  renewals = 0
  #claims = 0
  constructor(id: string) {
    this.rows.set(id, {
      id, workspaceId: 'ws_1', aggregateId: id, eventType: 'task.created', sequence: 1,
      payload: { taskId: id }, createdAt: new Date(1_000).toISOString(),
    })
  }
  row(id: string): DurableOutboxEvent {
    const row = this.rows.get(id)
    if (!row) throw staleLeaseError()
    return row
  }
  async claimPending(_workspaceId: string, options: { leaseMs?: number; now?: string } = {}): Promise<DurableOutboxEvent[]> {
    const now = Date.parse(options.now ?? new Date().toISOString())
    const claimed: DurableOutboxEvent[] = []
    for (const row of this.rows.values()) {
      if (row.publishedAt || row.unknownAt || (row.leaseUntil && Date.parse(row.leaseUntil) > now)) continue
      this.#claims += 1
      const next = { ...row, attempts: (row.attempts ?? 0) + 1, leaseToken: `lease_${this.#claims}`, leaseUntil: new Date(now + (options.leaseMs ?? 30_000)).toISOString() }
      this.rows.set(row.id, next)
      claimed.push({ ...next })
    }
    return claimed
  }
  async validateLease(_workspaceId: string, id: string, leaseToken: string, now = new Date().toISOString()): Promise<DurableOutboxEvent> {
    const row = this.row(id)
    if (row.publishedAt || row.unknownAt || row.leaseToken !== leaseToken || !row.leaseUntil || Date.parse(row.leaseUntil) <= Date.parse(now)) throw staleLeaseError()
    return { ...row }
  }
  async renewLease(_workspaceId: string, id: string, leaseToken: string, leaseMs: number, now = new Date().toISOString()): Promise<DurableOutboxEvent> {
    const row = await this.validateLease(_workspaceId, id, leaseToken, now)
    this.renewals += 1
    const renewed = { ...row, leaseUntil: new Date(Date.parse(now) + leaseMs).toISOString() }
    this.rows.set(id, renewed)
    return { ...renewed }
  }
  async ack(_workspaceId: string, id: string, leaseToken?: string): Promise<DurableOutboxEvent> {
    const row = this.row(id)
    if (leaseToken !== undefined && row.leaseToken !== leaseToken) throw staleLeaseError()
    const published = { ...row, publishedAt: new Date().toISOString(), leaseToken: undefined, leaseUntil: undefined }
    this.rows.set(id, published)
    return { ...published }
  }
  async recordFailure(_workspaceId: string, id: string, failure: { code: string; message: string }, nextAttemptAt: string): Promise<DurableOutboxEvent> {
    const updated = { ...this.row(id), nextAttemptAt, lastError: failure, leaseToken: undefined, leaseUntil: undefined }
    this.rows.set(id, updated)
    return updated
  }
  async markUnknown(_workspaceId: string, id: string, failure: { code: string; message: string }): Promise<DurableOutboxEvent> {
    const updated = { ...this.row(id), unknownAt: new Date().toISOString(), lastError: failure }
    this.rows.set(id, updated)
    return updated
  }
  async deadLetter(_workspaceId: string, id: string, failure: { code: string; message: string }): Promise<DurableOutboxEvent> {
    const updated = { ...this.row(id), lastError: { ...failure, terminal: true }, leaseToken: undefined, leaseUntil: undefined }
    this.rows.set(id, updated)
    return updated
  }
  async releaseClaim(_workspaceId: string, id: string, leaseToken: string): Promise<DurableOutboxEvent> {
    const row = this.row(id)
    if (row.leaseToken !== leaseToken) throw staleLeaseError()
    const released = { ...row, attempts: Math.max((row.attempts ?? 1) - 1, 0), leaseToken: undefined, leaseUntil: undefined }
    this.rows.set(id, released)
    return released
  }
}

/** A worker process that died: every durable and queue write is now impossible. */
class CrashedStore implements DurableOutboxStore {
  crashed = false
  constructor(private readonly inner: LeaseStore) {}
  #guard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.crashed) return Promise.reject(processGone())
    return operation()
  }
  claimPending(workspaceId: string, options?: { leaseMs?: number; now?: string }) { return this.inner.claimPending(workspaceId, options) }
  validateLease(workspaceId: string, id: string, leaseToken: string, now?: string) { return this.inner.validateLease(workspaceId, id, leaseToken, now) }
  renewLease(workspaceId: string, id: string, leaseToken: string, leaseMs: number, now?: string) { return this.#guard(() => this.inner.renewLease(workspaceId, id, leaseToken, leaseMs, now)) }
  ack(workspaceId: string, id: string, leaseToken?: string) { return this.#guard(() => this.inner.ack(workspaceId, id, leaseToken)) }
  recordFailure(workspaceId: string, id: string, failure: { code: string; message: string }, nextAttemptAt: string) { return this.#guard(() => this.inner.recordFailure(workspaceId, id, failure, nextAttemptAt)) }
  markUnknown(workspaceId: string, id: string, failure: { code: string; message: string }) { return this.#guard(() => this.inner.markUnknown(workspaceId, id, failure)) }
  deadLetter(workspaceId: string, id: string, failure: { code: string; message: string }) { return this.#guard(() => this.inner.deadLetter(workspaceId, id, failure)) }
  releaseClaim(workspaceId: string, id: string, leaseToken: string) { return this.#guard(() => this.inner.releaseClaim(workspaceId, id, leaseToken)) }
}

describe.skipIf(!redisUrl)('durable queue recovery against the durable lease (real Redis)', () => {
  let connection: Awaited<ReturnType<typeof connectRedisQueue>> | undefined
  let peerConnection: Awaited<ReturnType<typeof connectRedisQueue>> | undefined
  let inspector: RedisClientType | undefined
  const prefix = `worker_lease_recovery_${randomUUID()}`
  const keys: string[] = []
  const newQueueKey = (name: string) => {
    const key = `${prefix}:${name}:${randomUUID()}`
    keys.push(key, `${key}:processing`, `${key}:delayed`, `${key}:ids`)
    return key
  }

  beforeAll(async () => {
    connection = await connectRedisQueue(redisUrl!, { maxDepth: 1_000 })
    peerConnection = await connectRedisQueue(redisUrl!, { maxDepth: 1_000 })
    inspector = createClient({ url: redisUrl! })
    inspector.on('error', () => undefined)
    await inspector.connect()
  }, 30_000)

  afterAll(async () => {
    if (inspector) {
      await inspector.del(keys).catch(() => undefined)
      await inspector.quit()
    }
    await peerConnection?.close()
    await connection?.close()
  })

  it('never delivers a claim whose durable lease is still live to a peer worker', async () => {
    const store = new LeaseStore('evt_live_lease')
    const queueKey = newQueueKey('live_lease')
    const leaseMs = 300
    const log: string[] = []
    let releaseHandler!: () => void
    let handlerEntered!: () => void
    const entered = new Promise<void>(resolve => { handlerEntered = resolve })
    let handlerInFlight = false
    let refreshOutages = 0

    // Worker A: the queue-claim refresh can never reach Redis, while the
    // database lease keeps being renewed normally.
    const hintOutageTransport = {
      ...connection!.transport,
      async refresh(key: string, value: string): Promise<void> {
        refreshOutages += 1
        throw Object.assign(new Error('redis refresh outage'), { code: 'REDIS_REFRESH_OUTAGE' })
      },
    }
    const workerA = new DurableOutboxDispatcher(store, new RedisQueueAdapter<DurableOutboxEvent>(hintOutageTransport, queueKey), async ({ event: claimed }) => {
      handlerInFlight = true
      log.push(`A:entered:${claimed.leaseToken}`)
      handlerEntered()
      await new Promise<void>(resolve => { releaseHandler = resolve })
      handlerInFlight = false
      log.push('A:done')
      return { value: 'A' }
    }, { leaseMs, handlerTimeoutMs: 60_000, now: () => Date.now() })

    expect(await workerA.restore('ws_1')).toBe(1)
    const claimToken = store.row('evt_live_lease').leaseToken!
    let peerRanConcurrently = false
    let peerToken: string | undefined
    const workerB = new DurableOutboxDispatcher(store, new RedisQueueAdapter<DurableOutboxEvent>(peerConnection!.transport, queueKey), async ({ event: claimed }) => {
      peerToken = claimed.leaseToken
      peerRanConcurrently = handlerInFlight
      log.push(`B:entered:${claimed.leaseToken}`)
      return { value: 'B' }
    }, { leaseMs, handlerTimeoutMs: 60_000, now: () => Date.now() })

    const dispatchA = workerA.dispatchOnce().then(result => result.state).catch(error => `rejected:${(error as { code?: string }).code ?? 'unknown'}`)
    await entered
    // Past the moment the frozen claim score counts as stale: this is exactly
    // the window the adversarial run used to let a peer execute the event.
    await sleep(leaseMs + 40)
    const peerPolledAt = Date.now()
    const claimedValues = await inspector!.zRange(`${queueKey}:processing`, 0, -1)
    expect(claimedValues).toHaveLength(1)
    const frozenScore = await inspector!.zScore(`${queueKey}:processing`, claimedValues[0]!)
    const leaseUntil = Date.parse(store.row('evt_live_lease').leaseUntil!)
    expect(JSON.parse(JSON.parse(claimedValues[0]!).value).leaseToken).toBe(claimToken)
    expect(store.renewals).toBeGreaterThan(0)
    expect(refreshOutages).toBeGreaterThan(0)
    // The reproduction precondition: a stale liveness score on a live lease.
    expect(frozenScore).not.toBeNull()
    expect(frozenScore!).toBeLessThanOrEqual(peerPolledAt - leaseMs)
    expect(leaseUntil).toBeGreaterThan(peerPolledAt)

    const restoredByPeer = await workerB.restore('ws_1')
    const peerResult = await workerB.dispatchOnce()
    releaseHandler()
    const outcomeA = await dispatchA
    const row = store.row('evt_live_lease')

    expect(peerRanConcurrently).toBe(false)
    expect(peerToken).toBeUndefined()
    expect(restoredByPeer).toBe(0)
    expect(peerResult.state).toBe('empty')
    expect(outcomeA).toBe('succeeded')
    expect(row.publishedAt).toBeTruthy()
    expect(row.attempts).toBe(1)
    expect(log).toEqual([`A:entered:${claimToken}`, 'A:done'])
    // The delivery A owns is still claimed, not lost.
    expect(await inspector!.zCard(`${queueKey}:processing`)).toBe(0)
  })

  it('re-delivers an event with a fresh claim after a worker loses its lease mid-handler', async () => {
    const store = new LeaseStore('evt_lost_lease')
    const queueKey = newQueueKey('lost_lease')
    const leaseMs = 300
    let renewals = 0
    // The worker loses its claim: the database cannot renew, and the handler
    // returns anyway, so no outcome can be recorded for that claim.
    const lostStore: DurableOutboxStore = {
      claimPending: (workspaceId, options) => store.claimPending(workspaceId, options),
      validateLease: (workspaceId, id, leaseToken, now) => store.validateLease(workspaceId, id, leaseToken, now),
      renewLease: async (workspaceId, id, leaseToken, leaseMsOption, now) => {
        renewals += 1
        if (renewals === 1) throw processGone()
        return await store.renewLease(workspaceId, id, leaseToken, leaseMsOption, now)
      },
      ack: (workspaceId, id, leaseToken) => store.ack(workspaceId, id, leaseToken),
      recordFailure: (workspaceId, id, failure, nextAttemptAt) => store.recordFailure(workspaceId, id, failure, nextAttemptAt),
      markUnknown: (workspaceId, id, failure) => store.markUnknown(workspaceId, id, failure),
      deadLetter: (workspaceId, id, failure) => store.deadLetter(workspaceId, id, failure),
      releaseClaim: (workspaceId, id, leaseToken) => store.releaseClaim(workspaceId, id, leaseToken),
    }
    const firstToken = await (async () => {
      const handler = async ({ signal }: { signal?: AbortSignal }) => {
        await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }))
        return { value: 'never-recorded' }
      }
      const dispatcher = new DurableOutboxDispatcher(lostStore, new RedisQueueAdapter<DurableOutboxEvent>(connection!.transport, queueKey), handler, { leaseMs, handlerTimeoutMs: leaseMs, now: () => Date.now() })
      expect(await dispatcher.restore('ws_1')).toBe(1)
      await expect(dispatcher.dispatchOnce()).rejects.toMatchObject({ code: 'WORKER_PROCESS_GONE' })
      return store.row('evt_lost_lease').leaseToken
    })()

    // The dead delivery is gone from Redis instead of parking a token that the
    // next claim invalidates.
    await sleep(leaseMs + 40)
    expect(await inspector!.zCard(`${queueKey}:processing`)).toBe(0)
    const peerHandler = async () => ({ value: 'ok' })
    const peer = new DurableOutboxDispatcher(store, new RedisQueueAdapter<DurableOutboxEvent>(peerConnection!.transport, queueKey), peerHandler, { leaseMs, handlerTimeoutMs: leaseMs, now: () => Date.now() })
    expect(await peer.restore('ws_1')).toBe(1)
    const result = await peer.dispatchOnce()
    const row = store.row('evt_lost_lease')
    expect(result).toMatchObject({ state: 'succeeded' })
    expect(row.publishedAt).toBeTruthy()
    expect(row.attempts).toBe(2)
    expect(row.leaseToken).toBeUndefined()
    expect(firstToken).toBeTruthy()
    expect(await inspector!.lLen(queueKey)).toBe(0)
    expect(await inspector!.zCard(`${queueKey}:processing`)).toBe(0)
    expect(await inspector!.hLen(`${queueKey}:ids`)).toBe(0)
  })

  it('executes exactly maxAttempts times across crashing workers sharing one Redis queue', async () => {
    const store = new LeaseStore('evt_crash_loop')
    const queueKey = newQueueKey('crash_loop')
    const leaseMs = 250
    const maxAttempts = 3
    const attemptsSeen: number[] = []
    const outcomes: string[] = []

    for (let round = 1; round <= 6; round += 1) {
      if (store.row('evt_crash_loop').lastError?.terminal === true) break
      const crashable = new CrashedStore(store)
      // The crashed worker cannot push either: no requeue happens behind its back.
      const processTransport = {
        ...connection!.transport,
        async push(key: string, value: string): Promise<void> {
          if (crashable.crashed) throw processGone()
          await connection!.transport.push!(key, value)
        },
        async pushDelayed(key: string, value: string, notBeforeEpochMs: number): Promise<void> {
          if (crashable.crashed) throw processGone()
          await connection!.transport.pushDelayed!(key, value, notBeforeEpochMs)
        },
        async remove(key: string, value: string): Promise<void> {
          if (crashable.crashed) throw processGone()
          await connection!.transport.remove!(key, value)
        },
      }
      const dispatcher = new DurableOutboxDispatcher(crashable, new RedisQueueAdapter<DurableOutboxEvent>(processTransport, queueKey), async ({ attempt }) => {
        attemptsSeen.push(attempt)
        crashable.crashed = true
        // A worker that dies inside the handler records nothing and renews
        // nothing; the delivery stays claimed in Redis.
        return await new Promise<boolean>(() => undefined)
      }, { leaseMs, maxAttempts, handlerTimeoutMs: leaseMs, now: () => Date.now() })

      await dispatcher.restore('ws_1')
      const settled = await Promise.race([
        dispatcher.dispatchOnce().then(result => result.state).catch(error => `rejected:${(error as { code?: string }).code ?? 'unknown'}`),
        sleep(leaseMs * 3).then(() => 'hung'),
      ])
      outcomes.push(settled)
      await sleep(leaseMs + 40)
    }

    const row = store.row('evt_crash_loop')
    expect(attemptsSeen).toEqual([1, 2, 3])
    expect(attemptsSeen).toHaveLength(maxAttempts)
    expect(row.attempts).toBe(4)
    expect(row.publishedAt).toBeUndefined()
    expect(row.lastError).toMatchObject({ code: 'WORKER_CLAIM_ATTEMPTS_EXHAUSTED', terminal: true })
    // Nothing is left claimed or queued: every dead delivery was cleaned up
    // instead of stranding a lease that no worker could use.
    expect(await inspector!.lLen(queueKey)).toBe(0)
    expect(await inspector!.zCard(`${queueKey}:processing`)).toBe(0)
    expect(await inspector!.hLen(`${queueKey}:ids`)).toBe(0)
  }, 30_000)
})
