import type { HandlerResult, WorkerError } from './types.js'
import type { OutboxClaimOptions } from '../../persistence/src/repository.js'

export interface DurableOutboxEvent {
  id: string
  workspaceId: string
  aggregateId: string
  eventType: string
  sequence: number
  payload: Record<string, unknown>
  createdAt: string
  attempts?: number
  nextAttemptAt?: string
  leaseToken?: string
  unknownAt?: string
  lastError?: Record<string, unknown>
  publishedAt?: string
}

export interface DurableOutboxStore<E extends DurableOutboxEvent = DurableOutboxEvent> {
  claimPending(workspaceId: string, options?: OutboxClaimOptions): Promise<E[]>
  ack(workspaceId: string, id: string, leaseToken?: string): Promise<E>
  recordFailure(workspaceId: string, id: string, failure: WorkerError, nextAttemptAt: string, leaseToken?: string): Promise<E>
  markUnknown(workspaceId: string, id: string, failure: WorkerError, leaseToken?: string): Promise<E>
  deadLetter?(workspaceId: string, id: string, failure: WorkerError, leaseToken?: string): Promise<E>
}

export interface QueueMessage<T> {
  id: string
  value: T
}

export interface QueuePort<T> {
  enqueue(message: QueueMessage<T>): Promise<void>
  dequeue(): Promise<QueueMessage<T> | undefined>
  /** A queue implementation may use this to delete an acknowledged message. */
  ack(message: QueueMessage<T>): Promise<void>
  /** Requeue is used only when persistence cannot record the outcome. */
  nack(message: QueueMessage<T>, delayMs?: number): Promise<void>
}

/**
 * Redis is intentionally a port: production can inject ioredis/node-redis,
 * while tests use a deterministic fake and do not require a Redis driver.
 */
export interface RedisQueueTransport {
  push(key: string, value: string): Promise<void>
  /** timeoutSeconds <= 0 means a non-blocking pop; positive values may block. */
  pop(key: string, timeoutSeconds: number): Promise<string | undefined>
  remove?(key: string, value: string): Promise<void>
}

export class RedisQueueAdapter<T> implements QueuePort<T> {
  constructor(private readonly transport: RedisQueueTransport, private readonly key: string, private readonly encode: (value: T) => string = value => JSON.stringify(value), private readonly decode: (value: string) => T = value => JSON.parse(value) as T) {}

  async enqueue(message: QueueMessage<T>): Promise<void> {
    await this.transport.push(this.key, JSON.stringify({ id: message.id, value: this.encode(message.value) }))
  }

  async dequeue(): Promise<QueueMessage<T> | undefined> {
    const raw = await this.transport.pop(this.key, 0)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as { id: string; value: string }
    return { id: parsed.id, value: this.decode(parsed.value) }
  }

  async ack(message: QueueMessage<T>): Promise<void> {
    // BRPOP-style transports remove on dequeue. Reliable queue transports may
    // override remove to clear a pending list/visibility record.
    await this.transport.remove?.(this.key, JSON.stringify({ id: message.id, value: this.encode(message.value) }))
  }

  async nack(message: QueueMessage<T>, delayMs = 0): Promise<void> {
    if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs))
    await this.enqueue(message)
  }
}

export class InMemoryQueue<T> implements QueuePort<T> {
  private readonly messages: QueueMessage<T>[] = []
  async enqueue(message: QueueMessage<T>): Promise<void> {
    if (!this.messages.some(candidate => candidate.id === message.id)) this.messages.push(message)
  }
  async dequeue(): Promise<QueueMessage<T> | undefined> { return this.messages.shift() }
  async ack(_message: QueueMessage<T>): Promise<void> {}
  async nack(message: QueueMessage<T>, delayMs = 0): Promise<void> {
    if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs))
    await this.enqueue(message)
  }
  get size(): number { return this.messages.length }
}

export interface DurableDispatcherOptions {
  leaseMs?: number
  baseDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
  now?: () => number
  claim?: Pick<OutboxClaimOptions, 'eventTypes' | 'snapshotEntityTypes'>
}

export type DurableDispatchResult<E> = { state: 'succeeded' | 'unknown' | 'queued' | 'dead_letter'; event: E } | { state: 'empty' }
export type DurableOutboxHandler<E, R> = (context: { event: E; attempt: number; now: number }) => Promise<HandlerResult<R> | R>

export class DurableOutboxDispatcher<E extends DurableOutboxEvent = DurableOutboxEvent, R = unknown> {
  private readonly queued = new Set<string>()
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly maxAttempts: number
  private readonly claim: DurableDispatcherOptions['claim']

  constructor(
    private readonly store: DurableOutboxStore<E>,
    private readonly queue: QueuePort<E>,
    private readonly handler: DurableOutboxHandler<E, R>,
    options: DurableDispatcherOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
    this.leaseMs = options.leaseMs ?? 30_000
    this.baseDelayMs = options.baseDelayMs ?? 100
    this.maxDelayMs = options.maxDelayMs ?? 30_000
    this.maxAttempts = options.maxAttempts ?? 5
    this.claim = options.claim
  }

  async restore(workspaceId: string, limit = 100): Promise<number> {
    const events = await this.store.claimPending(workspaceId, { limit, leaseMs: this.leaseMs, now: new Date(this.now()).toISOString(), ...this.claim })
    let added = 0
    for (const event of events) {
      if (this.queued.has(event.id)) continue
      await this.queue.enqueue({ id: event.id, value: event })
      this.queued.add(event.id)
      added += 1
    }
    return added
  }

  async dispatchOnce(): Promise<DurableDispatchResult<E>> {
    const message = await this.queue.dequeue()
    if (!message) return { state: 'empty' }
    this.queued.delete(message.id)
    const event = message.value
    const attempt = (event.attempts ?? 0) + 1
    let normalized: HandlerResult<R>
    try {
      const result = await this.handler({ event, attempt, now: this.now() })
      normalized = result && typeof result === 'object' && ('state' in result || 'value' in result) ? result as HandlerResult<R> : { value: result as R }
    } catch (cause) {
      const failure = normalizeDurableError(cause)
      return this.recordHandlerFailure(event, message, failure)
    }

    try {
      if (normalized.state === 'unknown') {
        const updated = await this.store.markUnknown(event.workspaceId, event.id, { code: 'UNKNOWN', message: 'worker returned unknown outcome', retryable: false, unknown: true }, event.leaseToken)
        await this.queue.ack(message)
        return { state: 'unknown', event: updated }
      }
      const updated = await this.store.ack(event.workspaceId, event.id, event.leaseToken)
      await this.queue.ack(message)
      return { state: 'succeeded', event: updated }
    } catch (persistenceError) {
      if (isStaleOutboxError(persistenceError)) {
        // The database is authoritative; this queue message carries an expired lease.
        await this.queue.ack(message)
        return { state: 'dead_letter', event }
      }
      await this.queue.nack(message, this.baseDelayMs)
      throw persistenceError
    }
  }

  private async recordHandlerFailure(event: E, message: QueueMessage<E>, failure: WorkerError): Promise<DurableDispatchResult<E>> {
    try {
      if (failure.unknown) {
        const updated = await this.store.markUnknown(event.workspaceId, event.id, failure, event.leaseToken)
        await this.queue.ack(message)
        return { state: 'unknown', event: updated }
      }
      if (!failure.retryable || (event.attempts ?? 0) + 1 >= this.maxAttempts) {
        if (this.store.deadLetter) {
          const updated = await this.store.deadLetter(event.workspaceId, event.id, failure, event.leaseToken)
          await this.queue.ack(message)
          return { state: 'dead_letter', event: updated }
        }
        const updated = await this.store.recordFailure(event.workspaceId, event.id, failure, new Date(this.now() + this.maxDelayMs * 1000).toISOString(), event.leaseToken)
        await this.queue.ack(message)
        return { state: 'dead_letter', event: updated }
      }
      const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** ((event.attempts ?? 0)))
      const updated = await this.store.recordFailure(event.workspaceId, event.id, failure, new Date(this.now() + delay).toISOString(), event.leaseToken)
      await this.queue.ack(message)
      return { state: 'queued', event: updated }
    } catch (persistenceError) {
      if (isStaleOutboxError(persistenceError)) {
        // The database is authoritative; this queue message carries an expired lease.
        await this.queue.ack(message)
        return { state: 'dead_letter', event }
      }
      await this.queue.nack(message, this.baseDelayMs)
      throw persistenceError
    }
  }

  async dispatchUntilIdle(limit = 100): Promise<DurableDispatchResult<E>[]> {
    const results: DurableDispatchResult<E>[] = []
    for (let index = 0; index < limit; index += 1) {
      const result = await this.dispatchOnce()
      if (result.state === 'empty') break
      results.push(result)
    }
    return results
  }
}

function isStaleOutboxError(error: unknown): boolean {
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown } | undefined
  return candidate?.code === 'OUTBOX_EVENT_NOT_FOUND'
    || candidate?.name === 'OutboxEventNotFoundError'
    || candidate?.message === 'outbox event not found'
}

function normalizeDurableError(cause: unknown): WorkerError {
  const wrapped = cause as { error?: unknown } | undefined
  const candidate = (wrapped?.error && typeof wrapped.error === 'object' ? wrapped.error : cause) as Partial<WorkerError> | undefined
  return {
    code: candidate?.code ?? 'WORKER_ERROR',
    message: candidate?.message ?? 'Worker execution failed',
    retryable: candidate?.retryable ?? false,
    unknown: candidate?.unknown ?? false,
  }
}
