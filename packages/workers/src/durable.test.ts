import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableOutboxDispatcher, InMemoryQueue, RedisQueueAdapter, type DurableOutboxEvent, type DurableOutboxStore, type QueueMessage, type QueuePort, type RedisQueueTransport } from './durable.js'
import { WorkerFailure } from './runner.js'

const event = (overrides: Partial<DurableOutboxEvent> = {}): DurableOutboxEvent => ({
  id: 'evt_1', workspaceId: 'ws_1', aggregateId: 'task_1', eventType: 'task.created', sequence: 1,
  payload: { taskId: 'task_1' }, createdAt: new Date(1_000).toISOString(), ...overrides,
})

const authorizedEvent = (overrides: Partial<DurableOutboxEvent> = {}): DurableOutboxEvent => event({
  id: 'evt_authorized', aggregateId: 'publish_1', eventType: 'publish.requested',
  payload: {
    authorization_snapshot: {
      decision_id: 'decision_enqueue', trace_id: 'trace_enqueue',
    },
  },
  ...overrides,
})

class Store implements DurableOutboxStore {
  readonly events = new Map<string, DurableOutboxEvent>()
  claimCount = 0
  renewCount = 0
  constructor(initial: DurableOutboxEvent) { this.events.set(initial.id, initial) }
  async claimPending(_workspaceId?: string, options: { leaseMs?: number; now?: string } = {}): Promise<DurableOutboxEvent[]> {
    this.claimCount += 1
    const now = Date.parse(options.now ?? new Date().toISOString())
    return [...this.events.values()].filter(candidate => !candidate.unknownAt && candidate.lastError?.terminal !== true && (!candidate.leaseUntil || Date.parse(candidate.leaseUntil) <= now)).map(candidate => {
      const claimed = {
        ...candidate,
        // Mirrors the durable repository: the claim counter advances atomically
        // with the lease so a worker that dies mid-handler still consumes its
        // retry budget.
        attempts: (candidate.attempts ?? 0) + 1,
        leaseToken: `lease_${this.claimCount}`,
        leaseUntil: new Date(now + (options.leaseMs ?? 30_000)).toISOString(),
      }
      this.events.set(candidate.id, claimed)
      return { ...claimed }
    })
  }
  async validateLease(_workspaceId: string, id: string, leaseToken: string, now = new Date().toISOString()): Promise<DurableOutboxEvent> {
    const current = this.events.get(id)
    if (!current || current.leaseToken !== leaseToken || !current.leaseUntil || Date.parse(current.leaseUntil) <= Date.parse(now)) throw staleLeaseError()
    return { ...current }
  }
  async renewLease(_workspaceId: string, id: string, leaseToken: string, leaseMs: number, now = new Date().toISOString()): Promise<DurableOutboxEvent> {
    const current = await this.validateLease(_workspaceId, id, leaseToken, now)
    this.renewCount += 1
    const renewed = { ...current, leaseUntil: new Date(Date.parse(now) + leaseMs).toISOString() }
    this.events.set(id, renewed)
    return { ...renewed }
  }
  async ack(_workspaceId: string, id: string): Promise<DurableOutboxEvent> {
    const updated = { ...this.events.get(id)!, publishedAt: new Date().toISOString() }
    this.events.set(id, updated); return updated
  }
  async releaseClaim(_workspaceId: string, id: string, leaseToken?: string): Promise<DurableOutboxEvent> {
    const current = this.events.get(id)
    if (!current || (leaseToken !== undefined && current.leaseToken !== leaseToken)) throw staleLeaseError()
    // Mirrors the durable repository: the claim never delivered any work, so
    // the attempt it counted is given back.
    const released = { ...current, attempts: Math.max((current.attempts ?? 1) - 1, 0), leaseToken: undefined, leaseUntil: undefined }
    this.events.set(id, released); return { ...released }
  }
  async recordFailure(_workspaceId: string, id: string, failure: { code: string; message: string }, nextAttemptAt: string): Promise<DurableOutboxEvent> {
    // The attempt was already counted when the event was claimed.
    const updated = { ...this.events.get(id)!, nextAttemptAt, lastError: failure }
    this.events.set(id, updated); return updated
  }
  async markUnknown(_workspaceId: string, id: string, failure: { code: string; message: string }): Promise<DurableOutboxEvent> {
    const updated = { ...this.events.get(id)!, unknownAt: new Date().toISOString(), lastError: failure }
    this.events.set(id, updated); return updated
  }
}

/** Terminal recording, mirroring the durable repository dead-letter write. */
class DeadLetterStore extends Store {
  async deadLetter(_workspaceId: string, id: string, failure: { code: string; message: string }): Promise<DurableOutboxEvent> {
    const updated = { ...this.events.get(id)!, lastError: { ...failure, terminal: true } as unknown as Record<string, unknown> }
    this.events.set(id, updated); return updated
  }
}

/**
 * Models the shared Redis transport contract (one queue per role+workspace, not
 * one per worker): a claim is scored with the time of its last liveness proof,
 * and a stale score only makes the claim a candidate. The delivery is dropped
 * -- never requeued -- and only when the caller confirms against the durable
 * store that the claim is gone. Dropped claims come back through restore(),
 * which re-creates them from the authoritative database claim.
 */
class RecoveryQueue<T> implements QueuePort<T> {
  private readonly ready: QueueMessage<T>[] = []
  private readonly claims = new Map<string, { message: QueueMessage<T>; liveness: number }>()
  refreshed = 0
  dropped = 0
  staleCandidates = 0
  constructor(private readonly now: () => number = () => Date.now()) {}
  async enqueue(message: QueueMessage<T>): Promise<boolean> {
    if (await this.contains(message.id)) return false
    this.ready.push({ ...message })
    return true
  }
  async dequeue() {
    const index = this.ready.findIndex(message => (message.notBefore ?? 0) <= this.now())
    if (index < 0) return undefined
    const message = this.ready.splice(index, 1)[0]!
    this.claims.set(message.id, { message, liveness: this.now() })
    return message
  }
  async ack(message: QueueMessage<T>) { this.claims.delete(message.id) }
  async nack(message: QueueMessage<T>, delayMs = 0) {
    this.claims.delete(message.id)
    this.ready.push({ ...message, ...(delayMs > 0 ? { notBefore: this.now() + delayMs } : {}) })
  }
  async refreshClaim(message: QueueMessage<T>) {
    this.refreshed += 1
    const claim = this.claims.get(message.id)
    if (claim) claim.liveness = this.now()
  }
  async recoverStale(olderThanMs: number, isLeaseGone?: (message: QueueMessage<T>) => Promise<boolean>) {
    const cutoff = this.now() - olderThanMs
    let dropped = 0
    for (const [id, claim] of [...this.claims]) {
      if (claim.liveness > cutoff) continue
      this.staleCandidates += 1
      // Fail closed: without an authoritative answer a stale score proves
      // nothing about whether the work is still running.
      if (!isLeaseGone) continue
      let gone = false
      try { gone = await isLeaseGone(claim.message) } catch { gone = false }
      if (!gone) continue
      this.claims.delete(id)
      dropped += 1
    }
    this.dropped += dropped
    return dropped
  }
  async contains(id: string) { return this.ready.some(message => message.id === id) || this.claims.has(id) }
}

const staleLeaseError = () => Object.assign(new Error('outbox event not found'), { code: 'OUTBOX_EVENT_NOT_FOUND' })

afterEach(() => vi.useRealTimers())

describe('durable outbox dispatcher', () => {
  it('rejects invalid lease and retry configuration before claiming work', () => {
    const handler = async () => ({ value: true })
    expect(() => new DurableOutboxDispatcher(new Store(event()), new InMemoryQueue(), handler, { leaseMs: 0 })).toThrow('leaseMs')
    expect(() => new DurableOutboxDispatcher(new Store(event()), new InMemoryQueue(), handler, { leaseMs: 86_400_001 })).toThrow('leaseMs')
    expect(() => new DurableOutboxDispatcher(new Store(event()), new InMemoryQueue(), handler, { baseDelayMs: -1 })).toThrow('baseDelayMs')
    expect(() => new DurableOutboxDispatcher(new Store(event()), new InMemoryQueue(), handler, { baseDelayMs: 200, maxDelayMs: 100 })).toThrow('maxDelayMs')
    expect(() => new DurableOutboxDispatcher(new Store(event()), new InMemoryQueue(), handler, { maxAttempts: 0 })).toThrow('maxAttempts')
  })

  it('keeps Redis claims in processing until ack and requeues before removing on nack', async () => {
    const calls: string[] = []
    const encoded = JSON.stringify({ id: 'evt_1', value: JSON.stringify(event()) })
    const transport: RedisQueueTransport = {
      async push(_key, value) { calls.push(`push:${value}`) },
      async pop() { calls.push('claim'); return encoded },
      async remove(_key, value) { calls.push(`remove:${value}`) },
    }
    const queue = new RedisQueueAdapter<DurableOutboxEvent>(transport, 'queue')
    const message = await queue.dequeue()
    expect(message?.id).toBe('evt_1')
    expect(calls).toEqual(['claim'])
    await queue.nack(message!)
    expect(calls).toEqual(['claim', `push:${encoded}`, `remove:${encoded}`])
  })

  it('discards a malformed Redis claim so the next durable message can be consumed', async () => {
    const claims = ['not-json', JSON.stringify({ id: 'evt_1', value: JSON.stringify(event()) })]
    const removed: string[] = []
    const queue = new RedisQueueAdapter<DurableOutboxEvent>({
      async push() {},
      async pop() { return claims.shift() },
      async remove(_key, value) { removed.push(value) },
    }, 'queue')

    await expect(queue.dequeue()).rejects.toThrow('WORKER_QUEUE_MESSAGE_INVALID')
    expect(removed).toEqual(['not-json'])
    await expect(queue.dequeue()).resolves.toMatchObject({ id: 'evt_1' })
  })

  it('rejects conflicting Redis queue payloads for the same durable message id', async () => {
    const pushed: string[] = []
    const queue = new RedisQueueAdapter<DurableOutboxEvent>({
      async push(_key, value) { pushed.push(value) },
      async pop() { return undefined },
    }, 'queue')
    const first = event({ payload: { taskId: 'task_a' } })
    const equivalent = event({ payload: { taskId: 'task_a' } })
    const conflicting = event({ payload: { taskId: 'task_b' } })

    await queue.enqueue({ id: first.id, value: first })
    await expect(queue.enqueue({ id: equivalent.id, value: equivalent })).resolves.toBe(false)
    await expect(queue.enqueue({ id: conflicting.id, value: conflicting })).rejects.toThrow('WORKER_QUEUE_MESSAGE_CONFLICT')
    expect(pushed).toHaveLength(1)
  })

  it('rejects unsafe queue message ids before transport or in-memory state changes', async () => {
    const push = vi.fn(async () => {})
    const redisQueue = new RedisQueueAdapter<DurableOutboxEvent>({ push, async pop() { return undefined } }, 'queue')
    for (const id of ['', '   ', 'evt\nforged', 'x'.repeat(257)]) {
      await expect(redisQueue.enqueue({ id, value: event() })).rejects.toThrow('WORKER_QUEUE_MESSAGE_INVALID')
    }
    expect(push).not.toHaveBeenCalled()

    const memoryQueue = new InMemoryQueue<DurableOutboxEvent>()
    await expect(memoryQueue.enqueue({ id: 'evt\u0000forged', value: event() })).rejects.toThrow('WORKER_QUEUE_MESSAGE_INVALID')
    expect(memoryQueue.size).toBe(0)
  })

  it('rejects unsafe retry delays before Redis or in-memory state changes', async () => {
    const push = vi.fn(async () => {})
    const redisQueue = new RedisQueueAdapter<DurableOutboxEvent>({ push, async pop() { return undefined } }, 'queue')
    const message = { id: 'evt_retry_delay', value: event() }
    for (const delay of [-1, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(redisQueue.nack(message, delay)).rejects.toThrow('WORKER_QUEUE_RETRY_DELAY_INVALID')
    }
    expect(push).not.toHaveBeenCalled()

    const memoryQueue = new InMemoryQueue<DurableOutboxEvent>()
    for (const delay of [-1, Number.NaN, Number.POSITIVE_INFINITY, 86_400_001]) {
      await expect(memoryQueue.nack(message, delay)).rejects.toThrow('WORKER_QUEUE_RETRY_DELAY_INVALID')
    }
    expect(memoryQueue.size).toBe(0)
  })

  it('discards a stale Redis claim only when the durable lease is really gone', async () => {
    const store = new Store(event({ id: 'evt_stale_claim' }))
    const discarded: string[] = []
    const scans: number[] = []
    // A live worker renews its database lease while its queue liveness proof is
    // stale (the refresh failed). The claim must stay in processing.
    await store.claimPending('ws_1', { leaseMs: 30_000, now: new Date(60_000).toISOString() })
    const stale = JSON.stringify({ id: 'evt_stale_claim', value: JSON.stringify(store.events.get('evt_stale_claim')) })
    const queue = new RedisQueueAdapter<DurableOutboxEvent>({
      async push() {},
      async pop() { return undefined },
      async listStaleClaims(_key, cutoff) { scans.push(cutoff); return [stale] },
      async discardClaim(_key, value) { discarded.push(value); return 1 },
    }, 'queue')
    const live = new DurableOutboxDispatcher(store, queue, async () => ({ value: true }), { leaseMs: 30_000, now: () => 60_100 })
    expect(await live.restore('ws_1')).toBe(0)
    expect(discarded).toEqual([])
    expect(scans).toHaveLength(1)

    // Once the durable lease is gone the same claim is obsolete: it is dropped
    // and re-created from the authoritative database claim.
    const expired = new DurableOutboxDispatcher(store, queue, async () => ({ value: true }), { leaseMs: 30_000, now: () => 10_000_000 })
    expect(await expired.restore('ws_1')).toBe(1)
    expect(discarded).toEqual([stale])
  })

  it('keeps a claim whose durable lease is still live out of a peer worker reach', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-19T00:00:00.000Z'))
    const store = new Store(event({ id: 'evt_live_claim' }))
    // The queue liveness proof can no longer be refreshed, exactly as it stays
    // frozen when a heartbeat cannot reach Redis.
    class HintOutageQueue extends RecoveryQueue<DurableOutboxEvent> {
      async refreshClaim(): Promise<void> { throw new Error('redis refresh outage') }
    }
    const queue = new HintOutageQueue(() => Date.now())
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const handler = vi.fn(async () => {
      started()
      await new Promise<void>(resolve => { release = resolve })
      return { value: 'first' }
    })
    const worker = new DurableOutboxDispatcher(store, queue, handler, { leaseMs: 300, handlerTimeoutMs: 60_000, now: () => Date.now() })
    expect(await worker.restore('ws_1')).toBe(1)
    const dispatch = worker.dispatchOnce()
    await entered
    await vi.advanceTimersByTimeAsync(200)
    // The database lease keeps being renewed while the queue hint fails.
    expect(store.renewCount).toBe(2)
    expect(queue.refreshed).toBe(0)

    // The claim score is now older than the lease window and the durable lease
    // is still live: a peer must neither reclaim nor execute this event.
    const peerHandler = vi.fn(async () => ({ value: 'peer' }))
    const peer = new DurableOutboxDispatcher(store, queue, peerHandler, { leaseMs: 300, handlerTimeoutMs: 60_000, now: () => Date.now() })
    await vi.advanceTimersByTimeAsync(200)
    expect(await peer.restore('ws_1')).toBe(0)
    expect(queue.staleCandidates).toBeGreaterThan(0)
    expect(queue.dropped).toBe(0)
    await expect(peer.dispatchOnce()).resolves.toEqual({ state: 'empty' })
    expect(peerHandler).not.toHaveBeenCalled()

    release()
    await expect(dispatch).resolves.toMatchObject({ state: 'succeeded' })
    expect(store.events.get('evt_live_claim')?.publishedAt).toBeTruthy()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('rebuilds from pending outbox and idempotently acknowledges success', async () => {
    const store = new Store(event()); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => ({ value: 'ok' }))
    expect(await dispatcher.restore('ws_1')).toBe(1)
    expect(await dispatcher.restore('ws_1')).toBe(0)
    expect((await dispatcher.dispatchOnce()).state).toBe('succeeded')
    expect(store.events.get('evt_1')?.publishedAt).toBeTruthy()
  })

  it('re-evaluates dynamic claim routing on every restore so a narrowed worker recovers', async () => {
    // A worker that owns several queues may have to withhold one of them while
    // it cannot run (an unready local scanner, for example). `claim` is fixed
    // when the dispatcher is built, so a static filter could only express the
    // narrow case permanently; `claimFor` is consulted per restore.
    const claims: Array<{ eventTypes?: readonly string[] }> = []
    const store: DurableOutboxStore = {
      claimPending: async (_workspaceId, options = {}) => { claims.push(options); return [] },
      validateLease: async () => event(), renewLease: async () => event(), ack: async () => event(),
      recordFailure: async () => event(), markUnknown: async () => event(),
    }
    let withheld = true
    const dispatcher = new DurableOutboxDispatcher(store, new InMemoryQueue<DurableOutboxEvent>(), async () => ({ value: true }), {
      claim: { eventTypes: ['publish.requested'] },
      claimFor: () => withheld ? { eventTypes: ['state.snapshot'] } : undefined,
    })
    await dispatcher.restore('ws_1')
    expect(claims.at(-1)?.eventTypes).toEqual(['state.snapshot'])
    withheld = false
    await dispatcher.restore('ws_1')
    // Returning `undefined` falls back to the static claim rather than opening
    // the filter to everything.
    expect(claims.at(-1)?.eventTypes).toEqual(['publish.requested'])
  })

  it('rejects a duplicate queue id whose durable payload intent changed', async () => {
    const queue = new InMemoryQueue<DurableOutboxEvent>()
    await queue.enqueue({ id: 'evt_same', value: event({ payload: { taskId: 'task_a' } }) })

    await expect(queue.enqueue({ id: 'evt_same', value: event({ payload: { taskId: 'task_b' } }) }))
      .rejects.toThrow('WORKER_QUEUE_MESSAGE_CONFLICT')
    expect(queue.size).toBe(1)
    await expect(queue.enqueue({ id: 'evt_same', value: event({ payload: { taskId: 'task_a' } }) })).resolves.toBe(false)
    expect(queue.size).toBe(1)
  })

  it('keeps in-flight message identity while a worker claim is outstanding', async () => {
    const queue = new InMemoryQueue<DurableOutboxEvent>()
    const original = event({ id: 'evt_in_flight', payload: { taskId: 'task_a' } })
    const conflicting = event({ id: 'evt_in_flight', payload: { taskId: 'task_b' } })

    await queue.enqueue({ id: original.id, value: original })
    const claimed = await queue.dequeue()
    await expect(queue.contains(original.id)).resolves.toBe(true)
    await expect(queue.enqueue({ id: conflicting.id, value: conflicting }))
      .rejects.toThrow('WORKER_QUEUE_MESSAGE_CONFLICT')
    await expect(queue.enqueue({ id: original.id, value: original })).resolves.toBe(false)
    expect(queue.size).toBe(0)

    await queue.nack(claimed!, 0)
    expect(queue.size).toBe(1)
    const retry = await queue.dequeue()
    await queue.ack(retry!)
    await expect(queue.enqueue({ id: conflicting.id, value: conflicting })).resolves.toBe(true)
    expect(queue.size).toBe(1)
  })

  it('does not re-run a duplicate transport delivery after the durable outcome is acknowledged', async () => {
    const store = new Store(event({ id: 'evt_duplicate' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const handler = vi.fn(async () => ({ value: 'ok' }))
    const dispatcher = new DurableOutboxDispatcher(store, queue, handler)
    await dispatcher.restore('ws_1')
    const first = await dispatcher.dispatchOnce()
    expect(first.state).toBe('succeeded')

    // Simulate a duplicate transport delivery carrying the pre-ack claim.
    await queue.enqueue({ id: 'evt_duplicate', value: { ...event({ id: 'evt_duplicate' }), leaseToken: store.events.get('evt_duplicate')?.leaseToken, leaseUntil: store.events.get('evt_duplicate')?.leaseUntil } })
    const duplicate = await dispatcher.dispatchOnce()
    expect(duplicate.state).toBe('dead_letter')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('executes the authoritative payload returned by lease validation', async () => {
    const queued = event({ id: 'evt_authoritative_payload', leaseToken: 'lease_1', leaseUntil: new Date(Date.now() + 30_000).toISOString(), payload: { taskId: 'queued' } })
    const authoritative = { ...queued, payload: { taskId: 'authoritative' } }
    const queue = new InMemoryQueue<DurableOutboxEvent>()
    await queue.enqueue({ id: queued.id, value: queued })
    const store: DurableOutboxStore = {
      claimPending: async () => [],
      validateLease: async () => authoritative,
      renewLease: async () => authoritative,
      ack: async () => authoritative,
      recordFailure: async () => authoritative,
      markUnknown: async () => authoritative,
    }
    const seen: unknown[] = []
    const dispatcher = new DurableOutboxDispatcher(store, queue, async ({ event: received }) => {
      seen.push(received.payload)
      return { value: true }
    })
    await expect(dispatcher.dispatchOnce()).resolves.toMatchObject({ state: 'succeeded' })
    expect(seen).toEqual([{ taskId: 'authoritative' }])
  })

  it('discards a queue envelope whose id is not bound to the durable event', async () => {
    const store = new Store(event({ id: 'evt_authoritative' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const handler = vi.fn(async () => ({ value: 'must-not-run' }))
    const acknowledge = vi.spyOn(queue, 'ack')
    const dispatcher = new DurableOutboxDispatcher(store, queue, handler)

    await queue.enqueue({ id: 'evt_other', value: { ...event({ id: 'evt_authoritative' }), leaseToken: 'lease_1', leaseUntil: new Date(Date.now() + 30_000).toISOString() } })
    const result = await dispatcher.dispatchOnce()

    expect(result).toMatchObject({ state: 'dead_letter', event: { id: 'evt_authoritative' } })
    expect(handler).not.toHaveBeenCalled()
    expect(acknowledge).toHaveBeenCalledOnce()
    expect(store.events.get('evt_authoritative')?.publishedAt).toBeUndefined()
  })

  it('fails closed when persistence returns an event outside the requested RLS workspace', async () => {
    const store = new Store(event({ workspaceId: 'ws_other' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => ({ value: true }))

    await expect(dispatcher.restore('ws_1')).rejects.toMatchObject({ code: 'OUTBOX_EVENT_SCOPE_MISMATCH', eventId: 'evt_1', workspaceId: 'ws_1', eventWorkspaceId: 'ws_other' })
    expect(queue.size).toBe(0)
  })

  it('persists retry backoff and does not write/ack unknown outcomes', async () => {
    const store = new Store(event({ id: 'evt_unknown' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const handler = vi.fn(async () => { throw Object.assign(new Error('timeout'), { code: 'TIMEOUT', retryable: true, unknown: true }) })
    const dispatcher = new DurableOutboxDispatcher(store, queue, handler, { now: () => 1_000, baseDelayMs: 100 })
    await dispatcher.restore('ws_1'); expect((await dispatcher.dispatchOnce()).state).toBe('unknown')
    expect(store.events.get('evt_unknown')?.publishedAt).toBeUndefined()
    expect(store.events.get('evt_unknown')?.unknownAt).toBeTruthy()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('reports a completed handler whose outcome could not be recorded as unknown, never as a silent dead letter', async () => {
    const store = new Store(event({ id: 'evt_unrecorded' }))
    const queue = new InMemoryQueue<DurableOutboxEvent>()
    const observations: Array<{ state: string; failure?: { code?: string } }> = []
    // The repository's `ack` only refuses while `published_at IS NULL`: the row
    // is still pending, so this delivery lost the claim rather than terminating
    // the event.
    vi.spyOn(store, 'ack').mockRejectedValueOnce(staleLeaseError())
    const handler = vi.fn(async () => ({ value: 'generated-content' }))
    const dispatcher = new DurableOutboxDispatcher(store, queue, handler, { onDispatch: observation => observations.push(observation) })

    await dispatcher.restore('ws_1')
    const result = await dispatcher.dispatchOnce()

    // The handler really ran and succeeded; its result must not be re-labelled
    // as a terminal outcome, because restore() re-delivers the row and the
    // handler runs again.
    expect(handler).toHaveBeenCalledOnce()
    expect(result.state).toBe('unknown')
    expect(result).toMatchObject({ failure: { code: 'WORKER_OUTCOME_NOT_RECORDED_LEASE_LOST', retryable: false, unknown: true } })
    expect(observations.at(-1)).toMatchObject({ state: 'unknown', failure: { code: 'WORKER_OUTCOME_NOT_RECORDED_LEASE_LOST' } })
    // The delivery is still dropped - the next claim is authoritative - and the
    // durable row is left untouched and pending, so the work is recoverable.
    await expect(queue.contains('evt_unrecorded')).resolves.toBe(false)
    expect(store.events.get('evt_unrecorded')?.publishedAt).toBeUndefined()
    expect(store.events.get('evt_unrecorded')?.unknownAt).toBeUndefined()
  })

  it('retries at the backpressure window the failure named instead of the generic backoff', async () => {
    const store = new Store(event({ id: 'evt_quota_window' }))
    const queue = new InMemoryQueue<DurableOutboxEvent>()
    const failure = new WorkerFailure({ code: 'QUOTA_EXHAUSTED', message: 'quota exhausted; retry after 45s', retryable: true, unknown: false, retryAfterMs: 45_000 })
    // maxDelayMs is 30s: a window longer than the backoff ceiling must still be
    // honoured, otherwise every retry lands inside the closed window.
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => { throw failure }, { now: () => 10_000, baseDelayMs: 100, maxDelayMs: 30_000, random: () => 0 })

    await dispatcher.restore('ws_1')
    expect((await dispatcher.dispatchOnce()).state).toBe('queued')
    expect(store.events.get('evt_quota_window')?.nextAttemptAt).toBe(new Date(55_000).toISOString())
    expect(store.events.get('evt_quota_window')?.lastError).toMatchObject({ code: 'QUOTA_EXHAUSTED', retryAfterMs: 45_000 })
  })

  it('ignores a malformed backpressure window and falls back to the ordinary backoff', async () => {
    for (const retryAfterMs of [-1, 0, 1.5, 86_400_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const store = new Store(event({ id: 'evt_bad_window' }))
      const queue = new InMemoryQueue<DurableOutboxEvent>()
      const dispatcher = new DurableOutboxDispatcher(store, queue, async () => {
        throw { code: 'QUOTA_EXHAUSTED', message: 'quota exhausted', retryable: true, unknown: false, retryAfterMs }
      }, { now: () => 10_000, baseDelayMs: 100, maxDelayMs: 30_000, random: () => 0 })

      await dispatcher.restore('ws_1')
      expect((await dispatcher.dispatchOnce()).state).toBe('queued')
      expect(store.events.get('evt_bad_window')?.nextAttemptAt).toBe(new Date(10_100).toISOString())
      expect(store.events.get('evt_bad_window')?.lastError).not.toHaveProperty('retryAfterMs')
    }
  })

  it('persists dead-letter retry timing in milliseconds without inflating the delay', async () => {
    const store = new Store(event({ id: 'evt_dead_letter_timing', attempts: 4 }))
    const queue = new InMemoryQueue<DurableOutboxEvent>()
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => {
      throw new WorkerFailure({ code: 'PERMANENT_FAILURE', message: 'retry exhausted', retryable: true, unknown: false })
    }, { now: () => 10_000, maxAttempts: 5, maxDelayMs: 30_000 })

    await dispatcher.restore('ws_1')
    expect((await dispatcher.dispatchOnce()).state).toBe('dead_letter')
    expect(store.events.get('evt_dead_letter_timing')?.nextAttemptAt).toBe(new Date(40_000).toISOString())
  })

  it('sanitizes malformed durable error evidence before deciding retry', async () => {
    const store = new Store(event({ id: 'evt_malformed_error' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => {
      throw { code: 'not-a-code', message: `line\nitem\u0000${'x'.repeat(2_100)}`, retryable: 'yes', unknown: 1 }
    })
    await dispatcher.restore('ws_1')
    const result = await dispatcher.dispatchOnce()
    expect(result.state).toBe('dead_letter')
    expect(store.events.get('evt_malformed_error')?.lastError).toEqual({
      code: 'WORKER_ERROR', message: `line item ${'x'.repeat(2_000 - 'line item '.length)}`, retryable: false, unknown: false,
      eventId: 'evt_malformed_error', workspaceId: 'ws_1',
    })
  })

  it('keeps authorization correlation on unknown and dead-letter outcomes', async () => {
    const correlationSnapshot = { decision_id: 'decision_enqueue', actor_id: 'merchant_1', identity_id: 'identity_1', capability: 'publish.execute', policy_version: 'policy_3', request_id: 'req_1', trace_id: 'trace_enqueue' }
    const unknownStore = new Store(authorizedEvent({ id: 'evt_unknown_correlated', payload: { authorization_snapshot: correlationSnapshot } })); const unknownQueue = new InMemoryQueue<DurableOutboxEvent>()
    const unknownDispatcher = new DurableOutboxDispatcher(unknownStore, unknownQueue, async () => ({ state: 'unknown' as const }))
    await unknownDispatcher.restore('ws_1')
    expect((await unknownDispatcher.dispatchOnce()).state).toBe('unknown')
    expect(unknownStore.events.get('evt_unknown_correlated')?.lastError).toMatchObject({ code: 'UNKNOWN', decisionId: 'decision_enqueue', actorId: 'merchant_1', identityId: 'identity_1', capability: 'publish.execute', policyVersion: 'policy_3', requestId: 'req_1', eventId: 'evt_unknown_correlated', workspaceId: 'ws_1', traceId: 'trace_enqueue' })

    const deadStore = new Store(authorizedEvent({ id: 'evt_dead_correlated', attempts: 4, payload: { authorization_snapshot: correlationSnapshot } })); const deadQueue = new InMemoryQueue<DurableOutboxEvent>()
    const deadDispatcher = new DurableOutboxDispatcher(deadStore, deadQueue, async () => { throw new WorkerFailure({ code: 'TEMPORARY_FAILURE', message: 'retry exhausted', retryable: true, unknown: false }) })
    await deadDispatcher.restore('ws_1')
    expect((await deadDispatcher.dispatchOnce()).state).toBe('dead_letter')
    expect(deadStore.events.get('evt_dead_correlated')?.lastError).toMatchObject({ code: 'TEMPORARY_FAILURE', decisionId: 'decision_enqueue', actorId: 'merchant_1', identityId: 'identity_1', capability: 'publish.execute', policyVersion: 'policy_3', requestId: 'req_1', eventId: 'evt_dead_correlated', workspaceId: 'ws_1', traceId: 'trace_enqueue' })
  })

  it('does not copy malformed authorization identities into durable failure evidence', async () => {
    const store = new Store(authorizedEvent({
      id: 'evt_malformed_correlation',
      payload: { authorization_snapshot: { decision_id: 'decision_safe', actor_id: 'actor\nforged', request_id: 'request_safe', trace_id: 'trace_safe' } },
    }))
    const queue = new InMemoryQueue<DurableOutboxEvent>()
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => ({ state: 'unknown' as const }))
    await dispatcher.restore('ws_1')
    await dispatcher.dispatchOnce()
    expect(store.events.get('evt_malformed_correlation')?.lastError).toMatchObject({ decisionId: 'decision_safe', requestId: 'request_safe', traceId: 'trace_safe' })
    expect(store.events.get('evt_malformed_correlation')?.lastError).not.toHaveProperty('actorId')
  })

  it('requeues when persistence ack fails so a later worker can recover', async () => {
    const store = new Store(event()); const queue = new InMemoryQueue<DurableOutboxEvent>()
    vi.spyOn(store, 'ack').mockRejectedValueOnce(new Error('database unavailable'))
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => ({ value: true }))
    await dispatcher.restore('ws_1')
    await expect(dispatcher.dispatchOnce()).rejects.toThrow('database unavailable')
    expect(queue.size).toBe(1)
  })

  it('does not replay a side effect before the failed lease expires', async () => {
    const store = new Store(event()); const queue = new InMemoryQueue<DurableOutboxEvent>(() => 1_000)
    vi.spyOn(store, 'ack').mockRejectedValueOnce(new Error('database unavailable'))
    const nack = vi.spyOn(queue, 'nack')
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => ({ value: true }), { now: () => 1_000, leaseMs: 500, baseDelayMs: 17 })
    await dispatcher.restore('ws_1')
    await expect(dispatcher.dispatchOnce()).rejects.toThrow('database unavailable')
    expect(nack).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_1' }), 501)
  })

  it('backs off when persistence cannot record a handler failure', async () => {
    const store = new Store(event({ id: 'evt_backoff' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const nack = vi.spyOn(queue, 'nack')
    vi.spyOn(store, 'recordFailure').mockRejectedValueOnce(new Error('database unavailable'))
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => { throw new Error('temporary handler failure') }, { baseDelayMs: 17 })
    await dispatcher.restore('ws_1')
    await expect(dispatcher.dispatchOnce()).rejects.toThrow('database unavailable')
    expect(nack).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_backoff' }), expect.any(Number))
    expect(nack.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(17)
  })

  it('does not execute a stale handler when its database lease is gone', async () => {
    const store = new Store(event({ id: 'evt_stale' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const ack = vi.spyOn(queue, 'ack'); const nack = vi.spyOn(queue, 'nack')
    const handler = vi.fn(async () => ({ value: true }))
    let now = 1_000
    const dispatcher = new DurableOutboxDispatcher(store, queue, handler, { leaseMs: 300, now: () => now })
    await dispatcher.restore('ws_1')
    now += 301
    expect((await dispatcher.dispatchOnce()).state).toBe('dead_letter')
    expect(handler).not.toHaveBeenCalled()
    expect(ack).toHaveBeenCalledOnce()
    expect(nack).not.toHaveBeenCalled()
  })

  it('renews a live lease every leaseMs/3 while a long handler is running', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-29T00:00:00.000Z'))
    const store = new Store(event({ id: 'evt_long' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    let finishHandler!: () => void
    let handlerStarted!: () => void
    const started = new Promise<void>(resolve => { handlerStarted = resolve })
    const handler = vi.fn(async () => {
      handlerStarted()
      await new Promise<void>(resolve => { finishHandler = resolve })
      return { value: true }
    })
    const dispatcher = new DurableOutboxDispatcher(store, queue, handler, { leaseMs: 300 })
    await dispatcher.restore('ws_1')

    const dispatched = dispatcher.dispatchOnce()
    await started
    await vi.advanceTimersByTimeAsync(100)
    expect(store.renewCount).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(store.renewCount).toBe(2)
    finishHandler()

    await expect(dispatched).resolves.toMatchObject({ state: 'succeeded' })
  })

  it('aborts the handler and never records success after heartbeat lease loss', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-29T00:00:00.000Z'))
    const store = new Store(event({ id: 'evt_lost' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const acknowledgeSuccess = vi.spyOn(store, 'ack')
    vi.spyOn(store, 'renewLease').mockRejectedValueOnce(staleLeaseError())
    const handler = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }))
      return { value: true }
    })
    const dispatcher = new DurableOutboxDispatcher(store, queue, handler, { leaseMs: 300 })
    await dispatcher.restore('ws_1')

    const dispatched = dispatcher.dispatchOnce()
    await vi.advanceTimersByTimeAsync(100)

    await expect(dispatched).resolves.toMatchObject({ state: 'dead_letter' })
    expect(handler).toHaveBeenCalledOnce()
    expect(acknowledgeSuccess).not.toHaveBeenCalled()
  })

  it('drops a delivery it can no longer prove is ours and re-delivers it under a fresh claim', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-19T00:00:00.000Z'))
    const store = new Store(event({ id: 'evt_lost_lease' }))
    const queue = new RecoveryQueue<DurableOutboxEvent>(() => Date.now())
    vi.spyOn(store, 'renewLease').mockRejectedValueOnce(Object.assign(new Error('database unavailable'), { code: 'DB_UNAVAILABLE' }))
    const handler = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }))
      return { value: true }
    })
    const dispatcher = new DurableOutboxDispatcher(store, queue, handler, { leaseMs: 300, handlerTimeoutMs: 60_000, now: () => Date.now() })
    await dispatcher.restore('ws_1')

    // Attach the handler before advancing timers: the rejection happens while
    // the fake clock runs, and an unhandled rejection would be reported.
    const dispatched = dispatcher.dispatchOnce().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    await expect(dispatched).resolves.toMatchObject({ code: 'DB_UNAVAILABLE' })
    expect(handler).toHaveBeenCalledOnce()
    // Requeueing this delivery would only park a token that the next claim
    // invalidates, so it must be gone instead of wasting a later claim.
    await expect(queue.contains('evt_lost_lease')).resolves.toBe(false)

    // The durable row is untouched: the event returns with a fresh claim.
    await vi.advanceTimersByTimeAsync(300)
    const peerHandler = vi.fn(async () => ({ value: 'ok' }))
    const peer = new DurableOutboxDispatcher(store, queue, peerHandler, { leaseMs: 300, handlerTimeoutMs: 60_000, now: () => Date.now() })
    expect(await peer.restore('ws_1')).toBe(1)
    await expect(peer.dispatchOnce()).resolves.toMatchObject({ state: 'succeeded' })
    expect(peerHandler).toHaveBeenCalledOnce()
    expect(store.events.get('evt_lost_lease')?.publishedAt).toBeTruthy()
  })

  it('bounds a handler that ignores abort and fails closed as unknown', async () => {
    vi.useFakeTimers()
    const store = new Store(event({ id: 'evt_timeout' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const handler = vi.fn(async () => await new Promise<boolean>(() => undefined))
    const dispatcher = new DurableOutboxDispatcher(store, queue, handler, { leaseMs: 300, handlerTimeoutMs: 50, now: () => 1_000 })
    await dispatcher.restore('ws_1')

    const dispatched = dispatcher.dispatchOnce()
    await vi.advanceTimersByTimeAsync(50)

    await expect(dispatched).resolves.toMatchObject({ state: 'unknown' })
    expect(handler).toHaveBeenCalledOnce()
    expect(store.events.get('evt_timeout')?.unknownAt).toBeTruthy()
    expect(store.events.get('evt_timeout')?.publishedAt).toBeUndefined()
  })

  it('preserves WorkerFailure unknown semantics for manual reconciliation', async () => {
    const store = new Store(event({ id: 'evt_connector_unknown' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => {
      throw new WorkerFailure({ code: 'CONNECTOR_HANDLER_UNAVAILABLE', message: 'manual reconciliation', retryable: false, unknown: true })
    })
    await dispatcher.restore('ws_1')
    const result = await dispatcher.dispatchOnce()
    expect(result.state).toBe('unknown')
    expect(store.events.get('evt_connector_unknown')?.unknownAt).toBeTruthy()
    expect(store.events.get('evt_connector_unknown')?.publishedAt).toBeUndefined()
  })

  it('keeps a heartbeating claim out of stale recovery so a peer cannot execute it twice', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-01T00:00:00.000Z'))
    const store = new Store(event({ id: 'evt_heartbeat_claim' }))
    const queue = new RecoveryQueue<DurableOutboxEvent>(() => Date.now())
    let release!: () => void
    let handlerStarted!: () => void
    const started = new Promise<void>(resolve => { handlerStarted = resolve })
    const handler = vi.fn(async () => {
      handlerStarted()
      await new Promise<void>(resolve => { release = resolve })
      return { value: 'first' }
    })
    const dispatcher = new DurableOutboxDispatcher(store, queue, handler, { leaseMs: 300, handlerTimeoutMs: 60_000, now: () => Date.now() })
    expect(await dispatcher.restore('ws_1')).toBe(1)

    const inFlight = dispatcher.dispatchOnce()
    await started
    expect(handler).toHaveBeenCalledOnce()

    // Two heartbeats renew the database lease while the platform write is
    // still in flight. The queue claim must be renewed with it.
    await vi.advanceTimersByTimeAsync(200)
    expect(store.renewCount).toBe(2)
    expect(queue.refreshed).toBe(2)

    // A peer worker polls exactly when the original claim timestamp would have
    // been stale (claim time + leaseMs) and must not reclaim live work.
    await vi.advanceTimersByTimeAsync(100)
    const peerHandler = vi.fn(async () => ({ value: 'peer' }))
    const peer = new DurableOutboxDispatcher(store, queue, peerHandler, { leaseMs: 300, now: () => Date.now() })
    expect(await peer.restore('ws_1')).toBe(0)
    await expect(peer.dispatchOnce()).resolves.toEqual({ state: 'empty' })
    expect(peerHandler).not.toHaveBeenCalled()
    expect(queue.staleCandidates).toBe(0)
    expect(queue.dropped).toBe(0)
    expect(handler).toHaveBeenCalledOnce()

    release()
    await expect(inFlight).resolves.toMatchObject({ state: 'succeeded' })
  })

  it('dead-letters an event that exhausted its claim budget instead of executing it again', async () => {
    const store = new DeadLetterStore(event({ id: 'evt_claim_budget', attempts: 5 }))
    const queue = new InMemoryQueue<DurableOutboxEvent>()
    const handler = vi.fn(async () => ({ value: 'must-not-run' }))
    const dispatcher = new DurableOutboxDispatcher(store, queue, handler, { leaseMs: 300, maxAttempts: 5, now: () => 1_000 })
    await dispatcher.restore('ws_1')

    const result = await dispatcher.dispatchOnce()
    expect(result).toMatchObject({ state: 'dead_letter', event: { id: 'evt_claim_budget' } })
    expect(handler).not.toHaveBeenCalled()
    expect(store.events.get('evt_claim_budget')?.lastError).toMatchObject({ code: 'WORKER_CLAIM_ATTEMPTS_EXHAUSTED', terminal: true })
    expect(store.events.get('evt_claim_budget')?.publishedAt).toBeUndefined()
    expect(await dispatcher.restore('ws_1')).toBe(0)
  })

  it('executes exactly maxAttempts times when crashing workers share one durable queue', async () => {
    vi.useFakeTimers()
    const store = new DeadLetterStore(event({ id: 'evt_crash_loop' }))
    let now = 1_000
    // One queue per role+workspace, exactly like production: the claim a
    // crashed worker left behind is visible to every later round.
    const queue = new RecoveryQueue<DurableOutboxEvent>(() => now)
    let handlerStarted = false
    let markStarted: (() => void) | undefined
    const attemptsSeen: number[] = []
    // A crashed worker enters the handler and never records an outcome: the
    // only durable evidence of the attempt is the lease itself.
    const handler = vi.fn(async ({ attempt }: { attempt: number }) => {
      attemptsSeen.push(attempt)
      handlerStarted = true
      markStarted?.()
      return await new Promise<boolean>(() => undefined)
    })
    let claims = 0
    for (let index = 0; index < 12; index += 1) {
      now += 301
      const dispatcher = new DurableOutboxDispatcher(store, queue, handler, { leaseMs: 300, maxAttempts: 3, handlerTimeoutMs: 60_000, now: () => now })
      if (await dispatcher.restore('ws_1') === 0) break
      claims += 1
      handlerStarted = false
      const started = new Promise<void>(resolve => { markStarted = resolve })
      const dispatch = dispatcher.dispatchOnce()
      await Promise.race([started, dispatch.then(() => undefined)])
      if (!handlerStarted) break
    }

    expect(claims).toBe(4)
    // Exactly maxAttempts handlers ran, no claim was burned on a delivery the
    // worker could not use, and the attempts the handler observed are the
    // contiguous claim numbers.
    expect(handler).toHaveBeenCalledTimes(3)
    expect(attemptsSeen).toEqual([1, 2, 3])
    expect(queue.dropped).toBe(3)
    expect(store.events.get('evt_crash_loop')?.attempts).toBe(4)
    expect(store.events.get('evt_crash_loop')?.lastError).toMatchObject({ code: 'WORKER_CLAIM_ATTEMPTS_EXHAUSTED', terminal: true })
    const finalQueue = new RecoveryQueue<DurableOutboxEvent>(() => now)
    expect(await new DurableOutboxDispatcher(store, finalQueue, handler, { now: () => now }).restore('ws_1')).toBe(0)
  })

  it('schedules a delayed retry without blocking the poll loop', async () => {
    const delayed: Array<{ value: string; notBefore: number }> = []
    const transport = {
      async push() { throw new Error('an unexpired retry must not be pushed as immediately ready') },
      async pop() { return undefined },
      async remove() {},
      async pushDelayed(_key: string, value: string, notBeforeEpochMs: number) { delayed.push({ value, notBefore: notBeforeEpochMs }) },
    } as RedisQueueTransport
    const queue = new RedisQueueAdapter<DurableOutboxEvent>(transport, 'queue')
    const message = { id: 'evt_delayed_retry', value: event({ id: 'evt_delayed_retry' }) }

    // A blocking implementation is still asleep when this race settles.
    const outcome = await Promise.race([
      queue.nack(message, 500).then(() => 'resolved' as const),
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 50)),
    ])
    expect(outcome).toBe('resolved')
    expect(delayed).toEqual([{ value: JSON.stringify({ id: message.id, value: JSON.stringify(message.value) }), notBefore: expect.any(Number) }])
    expect(delayed[0]!.notBefore).toBeGreaterThan(Date.now() + 400)
  })

  it('reports only the deliveries the queue really accepted', async () => {
    const pushes: string[] = []
    const adapter = new RedisQueueAdapter<DurableOutboxEvent>({
      async push(_key, value) { pushes.push(value) },
      async pop() { return undefined },
    }, 'queue')
    const message = { id: 'evt_delivery_accounting', value: event({ id: 'evt_delivery_accounting' }) }
    expect(await adapter.enqueue(message)).toBe(true)
    // The same delivery is already represented: nothing was pushed, so nothing
    // may be counted as recovered.
    expect(await adapter.enqueue({ id: message.id, value: { ...message.value } })).toBe(false)
    expect(pushes).toHaveLength(1)

    const memory = new InMemoryQueue<DurableOutboxEvent>()
    expect(await memory.enqueue(message)).toBe(true)
    expect(await memory.enqueue({ id: message.id, value: { ...message.value } })).toBe(false)
    expect(memory.size).toBe(1)
  })

  it('does not count a recovery whose delivery the queue refused to hold', async () => {
    class RefusingQueue extends InMemoryQueue<DurableOutboxEvent> {
      async enqueue(): Promise<boolean> { return false }
    }
    const store = new Store(event({ id: 'evt_refused' }))
    const dispatcher = new DurableOutboxDispatcher(store, new RefusingQueue(), async () => ({ value: true }))
    expect(await dispatcher.restore('ws_1')).toBe(0)
    // The claim is still real, so a later worker can still recover it.
    expect(store.events.get('evt_refused')?.leaseToken).toBeTruthy()
  })

  it('releases a claim whose delivery a full queue refused instead of spending its budget', async () => {
    const store = new Store(event({ id: 'evt_backpressure_claim' }))
    class FullQueue extends InMemoryQueue<DurableOutboxEvent> {
      async enqueue(): Promise<boolean> { throw Object.assign(new Error('durable queue is at its configured depth limit'), { code: 'WORKER_QUEUE_DEPTH_EXCEEDED' }) }
    }
    const handler = vi.fn(async () => ({ value: true }))
    const dispatcher = new DurableOutboxDispatcher(store, new FullQueue(), handler, { leaseMs: 300, maxAttempts: 3, now: () => 1_000 })

    expect(await dispatcher.restore('ws_1')).toBe(0)
    // The claim never became work: the attempt is given back and the event is
    // immediately reclaimable instead of dead-lettering without ever running.
    expect(store.events.get('evt_backpressure_claim')?.attempts).toBe(0)
    expect(store.events.get('evt_backpressure_claim')?.leaseToken).toBeUndefined()
    expect(await dispatcher.restore('ws_1')).toBe(0)
    expect(store.events.get('evt_backpressure_claim')?.attempts).toBe(0)
    expect(handler).not.toHaveBeenCalled()
  })

  it('gives back a claim whose delivery the queue was already holding instead of spending its budget', async () => {
    // A delivery can outlive the claim that created it: the worker may be too
    // busy to drain the queue, and a persistence failure parks the retry to
    // become claimable exactly when the lease expires. That delivery carries a
    // token the next claim invalidates, so no handler can run under it. Keeping
    // that claim would spend an attempt on an execution that cannot start, and
    // an event can then dead-letter as WORKER_CLAIM_ATTEMPTS_EXHAUSTED with the
    // handler never having run once.
    let now = 1_000
    const store = new Store(event({ id: 'evt_stale_delivery' }))
    const queue = new InMemoryQueue<DurableOutboxEvent>(() => now)
    const handler = vi.fn(async () => ({ value: 'ok' }))
    const dispatcher = new DurableOutboxDispatcher(store, queue, handler, { leaseMs: 300, maxAttempts: 2, handlerTimeoutMs: 60_000, now: () => now })
    expect(await dispatcher.restore('ws_1')).toBe(1)

    // The claim expires while its delivery is still waiting in the queue.
    now += 301
    expect(await dispatcher.restore('ws_1')).toBe(0)
    expect(store.events.get('evt_stale_delivery')?.attempts).toBe(1)
    expect(store.events.get('evt_stale_delivery')?.leaseToken).toBeUndefined()
    // The delivery the queue still holds predates this claim, so dispatching it
    // only drops it - the handler must not run under an invalidated token.
    expect((await dispatcher.dispatchOnce()).state).toBe('dead_letter')
    expect(handler).not.toHaveBeenCalled()

    // The event still has its whole budget and a fresh delivery.
    now += 301
    expect(await dispatcher.restore('ws_1')).toBe(1)
    expect((await dispatcher.dispatchOnce()).state).toBe('succeeded')
    expect(handler).toHaveBeenCalledOnce()
    expect(store.events.get('evt_stale_delivery')?.publishedAt).toBeTruthy()
    expect(store.events.get('evt_stale_delivery')?.lastError).toBeUndefined()
  })

  it('releases every claim a full queue refused instead of dead-lettering a batch no handler ever saw', async () => {
    // Mirrors the durable repository: a published event is terminal evidence
    // and is never leased again.
    class PendingStore extends Store {
      async claimPending(workspaceId: string, options: { leaseMs?: number; now?: string } = {}): Promise<DurableOutboxEvent[]> {
        const now = Date.parse(options.now ?? new Date().toISOString())
        this.claimCount += 1
        return [...this.events.values()]
          .filter(candidate => !candidate.publishedAt && !candidate.unknownAt && candidate.lastError?.terminal !== true && (!candidate.leaseUntil || Date.parse(candidate.leaseUntil) <= now))
          .map(candidate => {
            const claimed = { ...candidate, attempts: (candidate.attempts ?? 0) + 1, leaseToken: `lease_${this.claimCount}`, leaseUntil: new Date(now + (options.leaseMs ?? 30_000)).toISOString() }
            this.events.set(candidate.id, claimed)
            return { ...claimed }
          })
      }
    }
    /** Depth is what the queue is holding: a delivery past the limit is refused. */
    class DepthLimitedQueue extends InMemoryQueue<DurableOutboxEvent> {
      held = 0
      constructor(public capacity: number, now: () => number = () => Date.now()) { super(now) }
      async enqueue(message: QueueMessage<DurableOutboxEvent>): Promise<boolean> {
        if (this.held >= this.capacity) throw Object.assign(new Error('durable queue is at its configured depth limit'), { code: 'WORKER_QUEUE_DEPTH_EXCEEDED' })
        const added = await super.enqueue(message)
        if (added) this.held += 1
        return added
      }
      async dequeue(): Promise<QueueMessage<DurableOutboxEvent> | undefined> {
        const message = await super.dequeue()
        if (message) this.held -= 1
        return message
      }
      async hasCapacity(): Promise<boolean> { return this.held < this.capacity }
    }

    const store = new PendingStore(event({ id: 'evt_batch_1' }))
    for (const id of ['evt_batch_2', 'evt_batch_3']) store.events.set(id, event({ id }))
    let now = 1_000
    const handled: string[] = []
    const queue = new DepthLimitedQueue(1, () => now)
    const dispatcher = new DurableOutboxDispatcher(store, queue, async ({ event: claimed }) => { handled.push(claimed.id); return { value: true } }, { leaseMs: 300, maxAttempts: 1, now: () => now })

    // The queue accepts one delivery of the batch and refuses the rest.
    expect(await dispatcher.restore('ws_1', 3)).toBe(1)
    // A refused delivery must not leave its claim behind: every event the queue
    // did not accept gives its attempt back and is immediately reclaimable,
    // instead of spending the batch's claim budget on work that never ran.
    for (const id of ['evt_batch_2', 'evt_batch_3']) {
      expect(store.events.get(id)?.attempts).toBe(0)
      expect(store.events.get(id)?.leaseToken).toBeUndefined()
      expect(await queue.contains(id)).toBe(false)
    }

    // Drain the delivery the queue did accept; the queue then has room again and
    // every remaining event is recovered with a fresh claim.
    while ((await dispatcher.dispatchOnce()).state !== 'empty') { /* drain */ }
    now += 10_000
    queue.capacity = 3
    expect(await dispatcher.restore('ws_1', 3)).toBe(2)
    while ((await dispatcher.dispatchOnce()).state !== 'empty') { /* drain */ }

    expect(handled).toEqual(['evt_batch_1', 'evt_batch_2', 'evt_batch_3'])
    for (const id of ['evt_batch_1', 'evt_batch_2', 'evt_batch_3']) {
      expect(store.events.get(id)?.lastError).toBeUndefined()
      expect(store.events.get(id)?.publishedAt).toBeTruthy()
    }
  })

  it('stops claiming when the durable queue is at its depth limit', async () => {
    const store = new Store(event({ id: 'evt_backpressure' }))
    class FullQueue extends InMemoryQueue<DurableOutboxEvent> { async hasCapacity() { return false } }
    const handler = vi.fn(async () => ({ value: true }))
    const dispatcher = new DurableOutboxDispatcher(store, new FullQueue(), handler)

    expect(await dispatcher.restore('ws_1')).toBe(0)
    expect(store.claimCount).toBe(0)
    await expect(dispatcher.dispatchOnce()).resolves.toEqual({ state: 'empty' })
  })

  it('spreads retry delays with full jitter instead of a synchronized backoff', async () => {
    const delays: number[] = []
    for (const random of [() => 0, () => 0.999]) {
      const store = new Store(event({ id: 'evt_jitter', attempts: 1 }))
      const dispatcher = new DurableOutboxDispatcher(store, new InMemoryQueue<DurableOutboxEvent>(), async () => {
        throw new WorkerFailure({ code: 'RATE_LIMITED', message: 'slow down', retryable: true, unknown: false })
      }, { now: () => 1_000, baseDelayMs: 1_000, maxDelayMs: 60_000, random })
      await dispatcher.restore('ws_1')
      expect((await dispatcher.dispatchOnce()).state).toBe('queued')
      delays.push(Date.parse(store.events.get('evt_jitter')!.nextAttemptAt!) - 1_000)
    }
    expect(delays[0]).toBeGreaterThanOrEqual(1_000)
    expect(delays[1]).toBeLessThanOrEqual(2_000)
    expect(delays[0]).toBeLessThan(delays[1]!)
  })
})
