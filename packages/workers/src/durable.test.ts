import { describe, expect, it, vi } from 'vitest'
import { DurableOutboxDispatcher, InMemoryQueue, type DurableOutboxEvent, type DurableOutboxStore } from './durable.js'
import { WorkerFailure } from './runner.js'

const event = (overrides: Partial<DurableOutboxEvent> = {}): DurableOutboxEvent => ({
  id: 'evt_1', workspaceId: 'ws_1', aggregateId: 'task_1', eventType: 'task.created', sequence: 1,
  payload: { taskId: 'task_1' }, createdAt: new Date(1_000).toISOString(), ...overrides,
})

class Store implements DurableOutboxStore {
  readonly events = new Map<string, DurableOutboxEvent>()
  claimCount = 0
  constructor(initial: DurableOutboxEvent) { this.events.set(initial.id, initial) }
  async claimPending(): Promise<DurableOutboxEvent[]> {
    this.claimCount += 1
    return [...this.events.values()].filter(candidate => !candidate.unknownAt)
      .map(candidate => ({ ...candidate, leaseToken: `lease_${this.claimCount}` }))
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

describe('durable outbox dispatcher', () => {
  it('rebuilds from pending outbox and idempotently acknowledges success', async () => {
    const store = new Store(event()); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => ({ value: 'ok' }))
    expect(await dispatcher.restore('ws_1')).toBe(1)
    expect(await dispatcher.restore('ws_1')).toBe(0)
    expect((await dispatcher.dispatchOnce()).state).toBe('succeeded')
    expect(store.events.get('evt_1')?.publishedAt).toBeTruthy()
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

  it('requeues when persistence ack fails so a later worker can recover', async () => {
    const store = new Store(event()); const queue = new InMemoryQueue<DurableOutboxEvent>()
    vi.spyOn(store, 'ack').mockRejectedValueOnce(new Error('database unavailable'))
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => ({ value: true }))
    await dispatcher.restore('ws_1')
    await expect(dispatcher.dispatchOnce()).rejects.toThrow('database unavailable')
    expect(queue.size).toBe(1)
  })

  it('backs off when persistence cannot record a handler failure', async () => {
    const store = new Store(event({ id: 'evt_backoff' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const nack = vi.spyOn(queue, 'nack')
    vi.spyOn(store, 'recordFailure').mockRejectedValueOnce(new Error('database unavailable'))
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => { throw new Error('temporary handler failure') }, { baseDelayMs: 17 })
    await dispatcher.restore('ws_1')
    await expect(dispatcher.dispatchOnce()).rejects.toThrow('database unavailable')
    expect(nack).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_backoff' }), 17)
  })

  it('drops stale queue messages when their database lease is gone', async () => {
    const store = new Store(event({ id: 'evt_stale' })); const queue = new InMemoryQueue<DurableOutboxEvent>()
    const ack = vi.spyOn(queue, 'ack'); const nack = vi.spyOn(queue, 'nack')
    vi.spyOn(store, 'ack').mockRejectedValueOnce(Object.assign(new Error('outbox event not found'), { code: 'OUTBOX_EVENT_NOT_FOUND' }))
    const dispatcher = new DurableOutboxDispatcher(store, queue, async () => ({ value: true }))
    await dispatcher.restore('ws_1')
    expect((await dispatcher.dispatchOnce()).state).toBe('dead_letter')
    expect(ack).toHaveBeenCalledOnce()
    expect(nack).not.toHaveBeenCalled()
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
