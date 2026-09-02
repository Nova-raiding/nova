import type { HandlerResult, WorkerError } from './types.js'
import type { OutboxClaimOptions } from '../../persistence/src/repository.js'

class WorkerTimeoutError extends Error {
  constructor() {
    super('worker handler timed out; outcome requires reconciliation')
    this.name = 'WorkerTimeoutError'
  }
}

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
  leaseUntil?: string
  unknownAt?: string
  lastError?: Record<string, unknown>
  publishedAt?: string
}

export interface DurableOutboxStore<E extends DurableOutboxEvent = DurableOutboxEvent> {
  claimPending(workspaceId: string, options?: OutboxClaimOptions): Promise<E[]>
  validateLease(workspaceId: string, id: string, leaseToken: string, now?: string): Promise<E>
  renewLease(workspaceId: string, id: string, leaseToken: string, leaseMs: number, now?: string): Promise<E>
  ack(workspaceId: string, id: string, leaseToken?: string): Promise<E>
  recordFailure(workspaceId: string, id: string, failure: WorkerError, nextAttemptAt: string, leaseToken?: string): Promise<E>
  markUnknown(workspaceId: string, id: string, failure: WorkerError, leaseToken?: string): Promise<E>
  deadLetter?(workspaceId: string, id: string, failure: WorkerError, leaseToken?: string): Promise<E>
}

export interface QueueMessage<T> {
  id: string
  value: T
  /** Local transports can retain a retry until this epoch. */
  notBefore?: number
}

export interface QueuePort<T> {
  enqueue(message: QueueMessage<T>): Promise<void>
  dequeue(): Promise<QueueMessage<T> | undefined>
  /** A queue implementation may use this to delete an acknowledged message. */
  ack(message: QueueMessage<T>): Promise<void>
  /** Requeue is used only when persistence cannot record the outcome. */
  nack(message: QueueMessage<T>, delayMs?: number): Promise<void>
  /** Requeues claims whose worker lease expired after a crash. */
  recoverStale?(olderThanMs: number): Promise<number>
  /** True only when the durable queue still contains this message. */
  contains?(id: string): Promise<boolean>
}

/**
 * Redis is intentionally a port: production can inject ioredis/node-redis,
 * while tests use a deterministic fake and do not require a Redis driver.
 */
export interface RedisQueueTransport {
  push(key: string, value: string): Promise<void>
  /**
   * Atomically claims into a processing list. timeoutSeconds <= 0 means a
   * non-blocking claim; positive values may block.
   */
  pop(key: string, timeoutSeconds: number): Promise<string | undefined>
  /** Removes an acknowledged claim from the processing list. */
  remove?(key: string, value: string): Promise<void>
  /** Atomically returns claims older than the cutoff to the ready queue. */
  recover?(key: string, olderThanEpochMs: number): Promise<number>
  contains?(key: string, id: string): Promise<boolean>
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
    await this.transport.remove?.(this.key, JSON.stringify({ id: message.id, value: this.encode(message.value) }))
  }

  async nack(message: QueueMessage<T>, delayMs = 0): Promise<void> {
    if (delayMs > 0) await new Promise<void>(resolve => setTimeout(resolve, delayMs))
    // Push before removing the claim. A crash between these operations can
    // duplicate an idempotent outbox message, while the opposite order could
    // lose it until the database lease expires.
    await this.enqueue(message)
    await this.ack(message)
  }

  async recoverStale(olderThanMs: number): Promise<number> {
    return await this.transport.recover?.(this.key, Date.now() - olderThanMs) ?? 0
  }
  async contains(id: string): Promise<boolean> { return await this.transport.contains?.(this.key, id) ?? false }
}

export class InMemoryQueue<T> implements QueuePort<T> {
  private readonly messages: QueueMessage<T>[] = []
  constructor(private readonly now: () => number = () => Date.now()) {}
  async enqueue(message: QueueMessage<T>): Promise<void> {
    if (!this.messages.some(candidate => candidate.id === message.id)) this.messages.push({ ...message })
  }
  async dequeue(): Promise<QueueMessage<T> | undefined> {
    const index = this.messages.findIndex(message => (message.notBefore ?? 0) <= this.now())
    if (index < 0) return undefined
    return this.messages.splice(index, 1)[0]
  }
  async ack(_message: QueueMessage<T>): Promise<void> {}
  async nack(message: QueueMessage<T>, delayMs = 0): Promise<void> {
    await this.enqueue({ ...message, ...(delayMs > 0 ? { notBefore: this.now() + delayMs } : {}) })
  }
  async contains(id: string): Promise<boolean> { return this.messages.some(message => message.id === id) }
  get size(): number { return this.messages.length }
}

export interface DurableDispatcherOptions {
  leaseMs?: number
  /** Hard upper bound for one handler invocation. A timeout is unknown because
   * an external side effect may have started before the handler stopped. */
  handlerTimeoutMs?: number
  baseDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
  now?: () => number
  claim?: Pick<OutboxClaimOptions, 'eventTypes' | 'snapshotEntityTypes'>
}

export type DurableDispatchResult<E> = { state: 'succeeded' | 'unknown' | 'queued' | 'dead_letter'; event: E } | { state: 'empty' }
export type DurableOutboxHandler<E, R> = (context: { event: E; attempt: number; now: number; signal?: AbortSignal }) => Promise<HandlerResult<R> | R>

export class DurableOutboxDispatcher<E extends DurableOutboxEvent = DurableOutboxEvent, R = unknown> {
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly handlerTimeoutMs: number
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
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? this.leaseMs
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0 || this.leaseMs > 86_400_000) {
      throw new RangeError('leaseMs must be a positive integer within one day')
    }
    if (!Number.isSafeInteger(this.handlerTimeoutMs) || this.handlerTimeoutMs <= 0) {
      throw new RangeError('handlerTimeoutMs must be a positive integer')
    }
    this.baseDelayMs = options.baseDelayMs ?? 100
    this.maxDelayMs = options.maxDelayMs ?? 30_000
    this.maxAttempts = options.maxAttempts ?? 5
    if (!Number.isSafeInteger(this.baseDelayMs) || this.baseDelayMs < 0 || this.baseDelayMs > 86_400_000) {
      throw new RangeError('baseDelayMs must be a non-negative integer within one day')
    }
    if (!Number.isSafeInteger(this.maxDelayMs) || this.maxDelayMs < 0 || this.maxDelayMs > 86_400_000) {
      throw new RangeError('maxDelayMs must be a non-negative integer within one day')
    }
    if (this.maxDelayMs < this.baseDelayMs) throw new RangeError('maxDelayMs must be greater than or equal to baseDelayMs')
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 100) {
      throw new RangeError('maxAttempts must be an integer between 1 and 100')
    }
    this.claim = options.claim
  }

  async restore(workspaceId: string, limit = 100): Promise<number> {
    await this.queue.recoverStale?.(this.leaseMs)
    const events = await this.store.claimPending(workspaceId, { limit, leaseMs: this.leaseMs, now: new Date(this.now()).toISOString(), ...this.claim })
    let added = 0
    for (const event of events) {
      // RLS/repository scope is a defense-in-depth boundary, not an implicit
      // trust boundary. A faulty store must never hydrate another tenant's
      // event into this worker's queue.
      if (event.workspaceId !== workspaceId) {
        throw Object.assign(new Error('outbox event workspace scope mismatch'), {
          code: 'OUTBOX_EVENT_SCOPE_MISMATCH',
          workspaceId,
          eventId: event.id,
          eventWorkspaceId: event.workspaceId,
        })
      }
      if (await this.queue.contains?.(event.id)) continue
      await this.queue.enqueue({ id: event.id, value: event })
      added += 1
    }
    return added
  }

  async dispatchOnce(): Promise<DurableDispatchResult<E>> {
    const message = await this.queue.dequeue()
    if (!message) return { state: 'empty' }
    const event = message.value
    // The queue envelope is part of the durable execution identity. A
    // transport bug or poisoned message must never make us execute one event
    // while acknowledging another id; discard only the malformed delivery so
    // restore() can rebuild the authoritative event by its own id.
    if (message.id !== event.id) {
      await this.queue.ack(message)
      return { state: 'dead_letter', event }
    }
    const attempt = (event.attempts ?? 0) + 1
    const leaseToken = event.leaseToken
    if (!leaseToken) {
      await this.queue.ack(message)
      return { state: 'dead_letter', event }
    }

    try {
      const leasedEvent = await this.store.validateLease(event.workspaceId, event.id, leaseToken, new Date(this.now()).toISOString())
      // A transport can deliver a duplicate after the first delivery was
      // acknowledged (for example, when a Redis claim was copied before the
      // processing entry was removed). The database is authoritative: do not
      // invoke the handler again once the durable outcome is already recorded.
      if (leasedEvent.publishedAt || leasedEvent.unknownAt) {
        await this.queue.ack(message)
        return { state: 'dead_letter', event: leasedEvent }
      }
    } catch (leaseError) {
      return this.handleLeaseError(event, message, leaseError)
    }

    const abortController = new AbortController()
    const heartbeatIntervalMs = Math.max(1, Math.floor(this.leaseMs / 3))
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
    let heartbeatInFlight: Promise<void> | undefined
    let stopped = false
    let leaseError: unknown
    let handlerTimedOut = false

    const heartbeat = async (): Promise<void> => {
      if (stopped) return
      try {
        await this.store.renewLease(event.workspaceId, event.id, leaseToken, this.leaseMs, new Date(this.now()).toISOString())
      } catch (cause) {
        leaseError = cause
        abortController.abort(cause)
      } finally {
        if (!stopped && leaseError === undefined) heartbeatTimer = setTimeout(runHeartbeat, heartbeatIntervalMs)
      }
    }
    const runHeartbeat = () => { heartbeatInFlight = heartbeat() }
    heartbeatTimer = setTimeout(runHeartbeat, heartbeatIntervalMs)

    const stopHeartbeat = async () => {
      stopped = true
      if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer)
      await heartbeatInFlight
    }

    let normalized: HandlerResult<R>
    let timeoutRejectTimer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutRejectTimer = setTimeout(() => {
        handlerTimedOut = true
        abortController.abort(new DOMException('worker handler timed out', 'TimeoutError'))
        reject(new WorkerTimeoutError())
      }, this.handlerTimeoutMs)
    })
    try {
      const result = await Promise.race([
        this.handler({ event, attempt, now: this.now(), signal: abortController.signal }),
        timeoutPromise,
      ])
      normalized = result && typeof result === 'object' && ('state' in result || 'value' in result) ? result as HandlerResult<R> : { value: result as R }
    } catch (cause) {
      if (timeoutRejectTimer !== undefined) clearTimeout(timeoutRejectTimer)
      await stopHeartbeat()
      if (leaseError !== undefined) return this.handleLeaseError(event, message, leaseError)
      if (handlerTimedOut || cause instanceof WorkerTimeoutError) {
        return this.recordHandlerFailure(event, message, withAuthorizationCorrelation(event, { code: 'WORKER_HANDLER_TIMEOUT', message: 'worker handler timed out; outcome requires reconciliation', retryable: false, unknown: true }))
      }
      const failure = withAuthorizationCorrelation(event, normalizeDurableError(cause))
      return this.recordHandlerFailure(event, message, failure)
    }
    if (timeoutRejectTimer !== undefined) clearTimeout(timeoutRejectTimer)
    await stopHeartbeat()
    if (leaseError !== undefined) return this.handleLeaseError(event, message, leaseError)

    try {
      if (normalized.state === 'unknown') {
        const updated = await this.store.markUnknown(event.workspaceId, event.id, withAuthorizationCorrelation(event, { code: 'UNKNOWN', message: 'worker returned unknown outcome', retryable: false, unknown: true }), event.leaseToken)
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
      await this.queue.nack(message, retryAfterLeaseMs(event, this.now(), this.baseDelayMs))
      throw persistenceError
    }
  }

  private async handleLeaseError(event: E, message: QueueMessage<E>, leaseError: unknown): Promise<DurableDispatchResult<E>> {
    if (isStaleOutboxError(leaseError)) {
      await this.queue.ack(message)
      return { state: 'dead_letter', event }
    }
    await this.queue.nack(message, retryAfterLeaseMs(event, this.now(), this.baseDelayMs))
    throw leaseError
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
      await this.queue.nack(message, retryAfterLeaseMs(event, this.now(), this.baseDelayMs))
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

/**
 * A queue retry must not outrun the database lease. If persistence failed
 * after the handler ran, replaying while the old lease is still valid can
 * repeat an external image/provider side effect. Keep the old short backoff
 * when no lease deadline is available (for example, a transport-only test),
 * but otherwise wait until the authoritative lease can be reclaimed.
 */
function retryAfterLeaseMs(event: DurableOutboxEvent, now: number, baseDelayMs: number): number {
  const leaseUntil = event.leaseUntil ? Date.parse(event.leaseUntil) : NaN
  if (!Number.isFinite(leaseUntil)) return baseDelayMs
  return Math.max(baseDelayMs, leaseUntil - now + 1)
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
  const code = typeof candidate?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(candidate.code)
    ? candidate.code
    : 'WORKER_ERROR'
  const rawMessage = typeof candidate?.message === 'string' && candidate.message.trim()
    ? candidate.message
    : 'Worker execution failed'
  return {
    code,
    message: rawMessage.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 2_000),
    retryable: candidate?.retryable === true,
    unknown: candidate?.unknown === true,
  }
}

/**
 * Durable outcomes are also the audit trail for work that never reaches a
 * connector. Keep the authorization decision attached to retries, unknown
 * outcomes, and dead letters even when the handler threw a generic error.
 * Only copy bounded, printable identifiers from the event payload; malformed
 * snapshots must not become a new trust boundary or log-injection vector.
 */
function withAuthorizationCorrelation(event: DurableOutboxEvent, failure: WorkerError): WorkerError {
  const raw = event.payload.authorization_snapshot
  const snapshot = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
  const safeId = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001F\u007F]/u.test(value) ? value : undefined
  const decisionId = safeId(snapshot?.decision_id)
  const actorId = safeId(snapshot?.actor_id)
  const identityId = safeId(snapshot?.identity_id)
  const capability = safeId(snapshot?.capability)
  const policyVersion = safeId(snapshot?.policy_version)
  const requestId = safeId(snapshot?.request_id)
  const traceId = safeId(snapshot?.trace_id)
  return {
    ...failure,
    eventId: failure.eventId ?? event.id,
    workspaceId: failure.workspaceId ?? event.workspaceId,
    ...(decisionId && !failure.decisionId ? { decisionId } : {}),
    ...(actorId && !failure.actorId ? { actorId } : {}),
    ...(identityId && !failure.identityId ? { identityId } : {}),
    ...(capability && !failure.capability ? { capability } : {}),
    ...(policyVersion && !failure.policyVersion ? { policyVersion } : {}),
    ...(requestId && !failure.requestId ? { requestId } : {}),
    ...(traceId && !failure.traceId ? { traceId } : {}),
  }
}
