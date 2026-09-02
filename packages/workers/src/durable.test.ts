import { afterEach, describe, expect, it, vi } from 'vitest'
import { DurableOutboxDispatcher, InMemoryQueue, RedisQueueAdapter, type DurableOutboxEvent, type DurableOutboxStore, type RedisQueueTransport } from './durable.js'
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
    return [...this.events.values()].filter(candidate => !candidate.unknownAt && (!candidate.leaseUntil || Date.parse(candidate.leaseUntil) <= now)).map(candidate => {
      const claimed = {
        ...candidate,
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
  async recordFailure(_workspaceId: string, id: string, failure: { code: string; message: string }, nextAttemptAt: string): Promise<DurableOutboxEvent> {
    const updated = { ...this.events.get(id)!, attempts: (this.events.get(id)?.attempts ?? 0) + 1, nextAttemptAt, lastError: failure }
    this.events.set(id, updated); return updated
  }
  async markUnknown(_workspaceId: string, id: string, failure: { code: string; message: string }): Promise<DurableOutboxEvent> {
    const updated = { ...this.events.get(id)!, unknownAt: new Date().toISOString(), lastError: failure }
    this.events.set(id, updated); return updated
  }
}

const staleLeaseError = () => Object.assign(new Error('outbox event not found'), { code: 'OUTBOX_EVENT_NOT_FOUND' })

afterEach(() => vi.useRealTimers())

describe('durable outbox dispatcher', () => {
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

  it('recovers expired Redis claims before acquiring a fresh database lease', async () => {
    const calls: string[] = []
    const queue = new RedisQueueAdapter<DurableOutboxEvent>({
      async push() {},
      async pop() { return undefined },
      async recover(_key, cutoff) { calls.push(`recover:${cutoff}`); return 1 },
    }, 'queue')
    const dispatcher = new DurableOutboxDispatcher(new Store(event()), queue, async () => ({ value: true }), { leaseMs: 30_000, now: () => 60_000 })

    expect(await dispatcher.restore('ws_1')).toBe(1)
    expect(calls).toHaveLength(1)
    expect(Number(calls[0]!.split(':')[1])).toBeGreaterThan(0)
  })

  it('rebuilds from pending outbox and idempotently acknowledges success', async () => {
    const store = new Store(event()); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => ({ value: 'ok' }))
    expect(await dispatcher.restore('ws_1')).toBe(1)
    expect(await dispatcher.restore('ws_1')).toBe(0)
    expect((await dispatcher.dispatchOnce()).state).toBe('succeeded')
    expect(store.events.get('evt_1')?.publishedAt).toBeTruthy()
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
})
