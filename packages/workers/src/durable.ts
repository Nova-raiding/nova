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
  /**
   * Reverts a claim whose delivery the queue refused (depth limit). Nothing in
   * the queue carries this token, so no handler can ever run under it: leaving
   * the claim counter incremented would spend the event's claim budget on an
   * execution that never started.
   */
  releaseClaim?(workspaceId: string, id: string, leaseToken: string): Promise<E>
}

export interface QueueMessage<T> {
  id: string
  value: T
  /** Local transports can retain a retry until this epoch. */
  notBefore?: number
}

export interface QueuePort<T> {
  /** True when this call really added a delivery the queue did not already hold. */
  enqueue(message: QueueMessage<T>): Promise<boolean>
  dequeue(): Promise<QueueMessage<T> | undefined>
  /** A queue implementation may use this to delete an acknowledged message. */
  ack(message: QueueMessage<T>): Promise<void>
  /** Requeue is used only when persistence cannot record the outcome. */
  nack(message: QueueMessage<T>, delayMs?: number): Promise<void>
  /**
   * Drops claims whose worker stopped proving liveness. A liveness score is
   * only a hint: `isLeaseGone` must confirm against the durable store that the
   * claim each delivery carries is really gone. Dropped deliveries are
   * re-created by restore() from the authoritative claim, so a peer can never
   * be handed a delivery whose lease token a live worker still owns.
   *
   * Implementations that cannot ask the store must fail closed and keep the
   * claim: recovering too eagerly is what let two workers execute one event.
   */
  recoverStale?(olderThanMs: number, isLeaseGone?: (message: QueueMessage<T>) => Promise<boolean>): Promise<number>
  /** True only when the durable queue still contains this message. */
  contains?(id: string): Promise<boolean>
  /**
   * Proves that a claim is still owned by a live worker. Renewed together with
   * the database lease so recovery can never reclaim in-flight work.
   */
  refreshClaim?(message: QueueMessage<T>): Promise<void>
  /** False when the queue is full; claiming more work would only strand leases. */
  hasCapacity?(): Promise<boolean>
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
  /**
   * Read-only view of claims whose liveness proof is older than the cutoff.
   * Recovery must never move a claim back to the ready queue before the
   * durable store confirms the claim is gone, so listing and discarding are
   * deliberately separate operations.
   */
  listStaleClaims?(key: string, olderThanEpochMs: number, limit?: number): Promise<string[]>
  /** Atomically drops one claim from the processing list; 1 when it was still there. */
  discardClaim?(key: string, value: string): Promise<number>
  contains?(key: string, id: string): Promise<boolean>
  /** Schedules a retry that only becomes claimable at notBeforeEpochMs. */
  pushDelayed?(key: string, value: string, notBeforeEpochMs: number): Promise<void>
  /** Refreshes the liveness score of an in-flight claim. */
  refresh?(key: string, value: string): Promise<void>
  /** True when the queue can still accept work without exceeding its depth limit. */
  hasCapacity?(key: string): Promise<boolean>
}

/**
 * Upper bound on stale claims inspected per recovery pass. Every candidate
 * costs one durable-lease check, so the scan stays small; unexamined claims are
 * simply left in processing and re-examined by the next pass.
 */
const STALE_CLAIM_SCAN_LIMIT = 32

/**
 * Upper bound for a dependency-imposed retry window. It matches the largest
 * delay the dispatcher constructor accepts for `leaseMs`/`maxDelayMs`, so a
 * malformed or hostile hint can never park an event beyond the range this
 * module already treats as sane.
 */
const MAX_RETRY_DELAY_MS = 86_400_000

export class RedisQueueAdapter<T> implements QueuePort<T> {
  private readonly pendingFingerprints = new Map<string, string>()

  constructor(private readonly transport: RedisQueueTransport, private readonly key: string, private readonly encode: (value: T) => string = value => JSON.stringify(value), private readonly decode: (value: string) => T = value => JSON.parse(value) as T) {}

  async enqueue(message: QueueMessage<T>): Promise<boolean> {
    assertQueueMessageId(message.id)
    const fingerprint = stableQueueSerialization(message.value)
    const existingFingerprint = this.pendingFingerprints.get(message.id)
    if (existingFingerprint !== undefined) {
      if (existingFingerprint !== fingerprint) throw new Error('WORKER_QUEUE_MESSAGE_CONFLICT')
      // The delivery is already represented in this process. Report it as not
      // added: callers count recovered work from this answer.
      return false
    }
    const encoded = JSON.stringify({ id: message.id, value: this.encode(message.value) })
    await this.transport.push(this.key, encoded)
    this.pendingFingerprints.set(message.id, fingerprint)
    return true
  }

  async dequeue(): Promise<QueueMessage<T> | undefined> {
    const raw = await this.transport.pop(this.key, 0)
    if (!raw) return undefined
    try {
      const parsed = JSON.parse(raw) as { id: string; value: string }
      if (typeof parsed.value !== 'string') {
        throw new Error('WORKER_QUEUE_MESSAGE_INVALID')
      }
      assertQueueMessageId(parsed.id)
      const value = this.decode(parsed.value)
      const fingerprint = stableQueueSerialization(value)
      const existingFingerprint = this.pendingFingerprints.get(parsed.id)
      if (existingFingerprint !== undefined && existingFingerprint !== fingerprint) {
        throw new Error('WORKER_QUEUE_MESSAGE_CONFLICT')
      }
      this.pendingFingerprints.set(parsed.id, fingerprint)
      return { id: parsed.id, value }
    } catch (cause) {
      // A claimed poison message cannot be allowed to remain in the
      // processing list: every restart would claim it again and starve the
      // durable queue. Remove only this already-claimed raw value; never
      // acknowledge a different message or turn malformed input into work.
      await this.transport.remove?.(this.key, raw)
      if (cause instanceof Error && isQueueMessageError(cause.message)) throw cause
      throw new Error('WORKER_QUEUE_MESSAGE_INVALID')
    }
  }

  async ack(message: QueueMessage<T>): Promise<void> {
    await this.transport.remove?.(this.key, JSON.stringify({ id: message.id, value: this.encode(message.value) }))
    this.pendingFingerprints.delete(message.id)
  }

  async nack(message: QueueMessage<T>, delayMs = 0): Promise<void> {
    assertQueueRetryDelay(delayMs)
    // Push before removing the claim. A crash between these operations can
    // duplicate an idempotent outbox message, while the opposite order could
    // lose it until the database lease expires. A delayed retry is scheduled in
    // the transport instead of sleeping here: blocking this call stops the
    // worker from serving any tenant for up to a full lease.
    const fingerprint = stableQueueSerialization(message.value)
    const existingFingerprint = this.pendingFingerprints.get(message.id)
    if (existingFingerprint !== undefined && existingFingerprint !== fingerprint) {
      throw new Error('WORKER_QUEUE_MESSAGE_CONFLICT')
    }
    const encoded = JSON.stringify({ id: message.id, value: this.encode(message.value) })
    if (delayMs > 0 && this.transport.pushDelayed) await this.transport.pushDelayed(this.key, encoded, Date.now() + delayMs)
    // A transport without delayed scheduling must still never block the worker
    // loop; it makes the retry claimable immediately instead.
    else await this.transport.push(this.key, encoded)
    this.pendingFingerprints.set(message.id, fingerprint)
    await this.ack(message)
  }

  async refreshClaim(message: QueueMessage<T>): Promise<void> {
    await this.transport.refresh?.(this.key, JSON.stringify({ id: message.id, value: this.encode(message.value) }))
  }

  /**
   * Drops claims whose liveness proof went stale and whose durable lease the
   * caller confirmed is gone. `isLeaseGone` is mandatory here: without an
   * authoritative answer the claim stays in processing, because a delivery
   * reclaimed too early is a second concurrent execution of live work.
   */
  async recoverStale(olderThanMs: number, isLeaseGone?: (message: QueueMessage<T>) => Promise<boolean>): Promise<number> {
    if (!isLeaseGone || !this.transport.listStaleClaims || !this.transport.discardClaim) return 0
    const stale = await this.transport.listStaleClaims(this.key, Date.now() - olderThanMs, STALE_CLAIM_SCAN_LIMIT)
    const obsolete: string[] = []
    // The durable check is a store round trip per candidate; run a bounded
    // number of them at once so recovery cannot stall the poll loop.
    await forEachWithConcurrency(stale, 8, async raw => {
      let message: QueueMessage<T>
      try {
        const parsed = JSON.parse(raw) as { id: string; value: string }
        if (typeof parsed?.value !== 'string') {
          // A claim that cannot be decoded can never become work; drop it so it
          // cannot occupy queue capacity forever.
          obsolete.push(raw)
          return
        }
        assertQueueMessageId(parsed.id)
        message = { id: parsed.id, value: this.decode(parsed.value) }
      } catch {
        obsolete.push(raw)
        return
      }
      try {
        if (await isLeaseGone(message)) obsolete.push(raw)
      } catch {
        // An unanswerable store must never be read as "the claim is gone".
      }
    })
    let dropped = 0
    for (const raw of obsolete) dropped += await this.transport.discardClaim(this.key, raw)
    return dropped
  }
  async contains(id: string): Promise<boolean> { return await this.transport.contains?.(this.key, id) ?? false }
  async hasCapacity(): Promise<boolean> { return await this.transport.hasCapacity?.(this.key) ?? true }
}

export class InMemoryQueue<T> implements QueuePort<T> {
  private readonly messages: QueueMessage<T>[] = []
  private readonly processingClaims = new Map<string, { fingerprint: string; message: QueueMessage<T>; claimedAt: number }>()
  constructor(private readonly now: () => number = () => Date.now()) {}
  async enqueue(message: QueueMessage<T>): Promise<boolean> {
    assertQueueMessageId(message.id)
    const fingerprint = stableQueueSerialization(message.value)
    const existing = this.messages.find(candidate => candidate.id === message.id)
    if (existing) {
      if (stableQueueSerialization(existing.value) !== fingerprint) {
        throw new Error('WORKER_QUEUE_MESSAGE_CONFLICT')
      }
      return false
    }
    const processingClaim = this.processingClaims.get(message.id)
    if (processingClaim !== undefined) {
      if (processingClaim.fingerprint !== fingerprint) {
        throw new Error('WORKER_QUEUE_MESSAGE_CONFLICT')
      }
      return false
    }
    this.messages.push({ ...message })
    return true
  }
  async dequeue(): Promise<QueueMessage<T> | undefined> {
    const index = this.messages.findIndex(message => (message.notBefore ?? 0) <= this.now())
    if (index < 0) return undefined
    const message = this.messages.splice(index, 1)[0]
    if (!message) return undefined
    this.processingClaims.set(message.id, {
      fingerprint: stableQueueSerialization(message.value),
      message: { ...message },
      claimedAt: this.now(),
    })
    return message
  }
  async ack(message: QueueMessage<T>): Promise<void> {
    this.processingClaims.delete(message.id)
  }
  async nack(message: QueueMessage<T>, delayMs = 0): Promise<void> {
    assertQueueRetryDelay(delayMs)
    const fingerprint = stableQueueSerialization(message.value)
    const processingClaim = this.processingClaims.get(message.id)
    if (processingClaim !== undefined && processingClaim.fingerprint !== fingerprint) {
      throw new Error('WORKER_QUEUE_MESSAGE_CONFLICT')
    }
    // The claim is still represented by processingClaims, so enqueue()
    // would intentionally deduplicate it. Requeue explicitly, then release
    // the in-flight identity only after the retry is present.
    this.messages.push({ ...message, ...(delayMs > 0 ? { notBefore: this.now() + delayMs } : {}) })
    this.processingClaims.delete(message.id)
  }
  /**
   * Mirrors the Redis transport contract: a stale liveness timestamp only makes
   * a claim a *candidate*, and the delivery is dropped only when the caller
   * confirms against the durable store that the claim is really gone.
   */
  async recoverStale(olderThanMs: number, isLeaseGone?: (message: QueueMessage<T>) => Promise<boolean>): Promise<number> {
    const cutoff = this.now() - olderThanMs
    let dropped = 0
    for (const [id, claim] of [...this.processingClaims]) {
      if (claim.claimedAt > cutoff) continue
      let gone = false
      if (isLeaseGone) {
        try {
          gone = await isLeaseGone(claim.message)
        } catch { gone = false }
      }
      if (!gone) continue
      this.processingClaims.delete(id)
      dropped += 1
    }
    return dropped
  }
  async contains(id: string): Promise<boolean> {
    return this.messages.some(message => message.id === id) || this.processingClaims.has(id)
  }
  get size(): number { return this.messages.length }
}

/** Bounded fan-out so a batch of store round trips cannot serialize a poll loop. */
async function forEachWithConcurrency<T>(items: readonly T[], limit: number, visit: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      if (item === undefined) continue
      await visit(item)
    }
  })
  await Promise.all(runners)
}

function stableQueueSerialization(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'bigint') return `bigint:${value.toString()}`
  if (typeof value === 'function' || typeof value === 'symbol') throw new Error('WORKER_QUEUE_MESSAGE_UNSUPPORTED')
  if (Array.isArray(value)) return `[${value.map(stableQueueSerialization).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableQueueSerialization(entry)}`).join(',')}}`
  }
  throw new Error('WORKER_QUEUE_MESSAGE_UNSUPPORTED')
}

function assertQueueMessageId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('WORKER_QUEUE_MESSAGE_INVALID')
  }
}

function assertQueueRetryDelay(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 86_400_000) {
    throw new Error('WORKER_QUEUE_RETRY_DELAY_INVALID')
  }
}

function isQueueMessageError(message: string): boolean {
  return message === 'WORKER_QUEUE_MESSAGE_INVALID'
    || message === 'WORKER_QUEUE_MESSAGE_CONFLICT'
    || message === 'WORKER_QUEUE_MESSAGE_UNSUPPORTED'
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
  /** Injectable jitter source so retry spread is deterministic in tests. */
  random?: () => number
  claim?: Pick<OutboxClaimOptions, 'eventTypes' | 'snapshotEntityTypes'>
  /**
   * Claim routing re-evaluated on every `restore()`, for a worker that owns
   * several queues in one process and must narrow what it claims when one of
   * them is temporarily unable to run. Returning `undefined` falls back to the
   * static `claim`. This exists because a static filter cannot express
   * "everything except the queue that is gated", and freezing the whole worker
   * instead takes the healthy queues down with the gated one.
   */
  claimFor?: () => Pick<OutboxClaimOptions, 'eventTypes' | 'snapshotEntityTypes'> | undefined
  /**
   * Called once when a delivery is claimed for execution (`started`) and once
   * per terminal or retry outcome. The production worker wires this to
   * `writeWorkerDispatchLog` so every dead letter and retry leaves a
   * structured, joinable line. Defaulting to a no-op keeps this module a pure
   * queue component.
   */
  onDispatch?: (observation: WorkerDispatchObservation) => void
}

/**
 * One observable dispatch transition. `event` is the authoritative durable row
 * the outcome was written against, so its payload carries the authorization
 * snapshot used to correlate the line with the originating API request.
 */
export interface WorkerDispatchObservation<E extends DurableOutboxEvent = DurableOutboxEvent> {
  state: 'started' | 'succeeded' | 'unknown' | 'queued' | 'dead_letter'
  event: E
  attempt: number
  failure?: WorkerError
  retryAt?: string
}

export type DurableDispatchResult<E> =
  | {
    state: 'succeeded' | 'unknown' | 'queued' | 'dead_letter'
    event: E
    /**
     * Failure evidence for an outcome the store did not write, so it cannot be
     * read back from `event.lastError`. An unrecorded outcome is still an
     * observable one: without this the dispatch log line for it would carry no
     * code at all.
     */
    failure?: WorkerError
  }
  | { state: 'empty' }

/**
 * The handler completed and produced a result, but the durable store refused to
 * record it because this delivery no longer owned the claim. The event is *not*
 * terminal - it stays pending and will be re-executed - so the outcome is
 * unknown and needs reconciliation rather than a silent dead letter. The code
 * is what makes the two indistinguishable cases distinguishable in the dispatch
 * log, the poll counters and any alert built on them.
 */
const UNRECORDED_OUTCOME_LEASE_LOST: WorkerError = {
  code: 'WORKER_OUTCOME_NOT_RECORDED_LEASE_LOST',
  message: 'handler completed but its outcome was not recorded: the durable claim was no longer owned by this delivery; the event remains pending and will be re-executed, so the result requires reconciliation',
  retryable: false,
  unknown: true,
}
export type DurableOutboxHandler<E, R> = (context: { event: E; attempt: number; now: number; signal?: AbortSignal }) => Promise<HandlerResult<R> | R>

export class DurableOutboxDispatcher<E extends DurableOutboxEvent = DurableOutboxEvent, R = unknown> {
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly handlerTimeoutMs: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly maxAttempts: number
  private readonly random: () => number
  private readonly claim: DurableDispatcherOptions['claim']
  private readonly claimFor: DurableDispatcherOptions['claimFor']
  private readonly onDispatch: ((observation: WorkerDispatchObservation<E>) => void) | undefined

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
    if (options.random !== undefined && typeof options.random !== 'function') {
      throw new RangeError('random must be a function')
    }
    this.random = options.random ?? Math.random
    this.claim = options.claim
    this.claimFor = options.claimFor
    this.onDispatch = options.onDispatch
  }

  async restore(workspaceId: string, limit = 100): Promise<number> {
    const now = new Date(this.now()).toISOString()
    // Recovery is gated on the durable lease, never on a queue timestamp. A
    // worker whose claim refresh fails keeps renewing its database lease while
    // its handler is still writing to a platform, so a stale queue score alone
    // is not evidence that the work stopped. Handing such a delivery to a peer
    // is exactly what let two workers execute one event with one lease token.
    await this.queue.recoverStale?.(this.leaseMs, async message => {
      if (message.value.workspaceId !== workspaceId) return true
      try {
        // Still the current, unexpired claim: its owner is alive. Keep the
        // delivery and re-examine it on the next pass.
        await this.store.validateLease(workspaceId, message.id, message.value.leaseToken ?? '', now)
        return false
      } catch (cause) {
        // Only a definitive "this claim is gone" answer may drop a delivery;
        // an unreachable store must never be read as a lost claim.
        return isStaleOutboxError(cause)
      }
    })
    // Backpressure: a database lease that cannot be handed to the queue would
    // strand the event until the lease expires, so never claim more work than
    // the queue can hold.
    if (this.queue.hasCapacity && !await this.queue.hasCapacity()) return 0
    const events = await this.store.claimPending(workspaceId, { limit, leaseMs: this.leaseMs, now, ...(this.claimFor?.() ?? this.claim) })
    let added = 0
    // A depth limit refuses the delivery, not this event: every remaining claim
    // of the batch would be refused too. Releasing only the one that hit the
    // limit would leave the rest leased with no delivery and their attempt
    // counted, so they would be reclaimed later and dead-letter as
    // WORKER_CLAIM_ATTEMPTS_EXHAUSTED without a handler ever running.
    let queueFull = false
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
      if (queueFull) {
        await this.store.releaseClaim?.(workspaceId, event.id, event.leaseToken ?? '')
        continue
      }
      if (await this.queue.contains?.(event.id)) {
        // The queue already holds a delivery for this id, but that delivery was
        // created under an earlier claim and this claim minted a new lease
        // token, so the handler holding it can never be executed: lease
        // validation rejects the outdated token. This claim therefore produced
        // no delivery, exactly like one the queue refused, and keeping it would
        // spend the event's claim budget on an execution that cannot start -
        // an event whose delivery outlives its lease (a persistence-failure
        // retry parked until the lease expires, or a worker too busy to drain
        // its queue) would then dead-letter as
        // WORKER_CLAIM_ATTEMPTS_EXHAUSTED with no handler ever running under
        // those attempts. Give the attempt back instead: the stale delivery is
        // dropped by the next dispatch and restore() re-creates it under the
        // fresh claim.
        await this.store.releaseClaim?.(workspaceId, event.id, event.leaseToken ?? '')
        continue
      }
      try {
        // The claim is only real once its delivery exists: a queue that refuses
        // the delivery (depth limit) must not leave a leased event with no
        // handler to run it, and must not spend the claim budget for that.
        if (await this.queue.enqueue({ id: event.id, value: event })) added += 1
      } catch (cause) {
        if (!isQueueDepthExceeded(cause)) throw cause
        queueFull = true
        await this.store.releaseClaim?.(workspaceId, event.id, event.leaseToken ?? '')
      }
    }
    return added
  }

  /**
   * Dispatches one delivery and reports the transition. Logging lives in the
   * wrapper so a throw from the store or the queue (which callers handle as a
   * poll failure) cannot be mistaken for an outcome that was recorded.
   */
  async dispatchOnce(): Promise<DurableDispatchResult<E>> {
    const result = await this.dispatchDelivery()
    if (result.state !== 'empty') this.observeDispatch(result)
    return result
  }

  private observeDispatch(result: Exclude<DurableDispatchResult<E>, { state: 'empty' }>): void {
    if (!this.onDispatch) return
    // An outcome the store refused has no recorded `lastError`; the dispatcher
    // supplies its own evidence for it rather than reporting a bare state.
    const failure = result.failure ?? result.event.lastError as WorkerError | undefined
    try {
      this.onDispatch({
        state: result.state,
        event: result.event,
        attempt: Math.max(0, result.event.attempts ?? 0),
        ...(failure && typeof failure === 'object' ? { failure } : {}),
        // `nextAttemptAt` is the durable retry deadline the repository wrote;
        // it is the only honest answer for when the retry becomes claimable.
        ...(result.state === 'queued' && typeof result.event.nextAttemptAt === 'string' ? { retryAt: result.event.nextAttemptAt } : {}),
      })
    } catch {
      // A broken observer must never change a recorded outcome.
    }
  }

  private async dispatchDelivery(): Promise<DurableDispatchResult<E>> {
    const message = await this.queue.dequeue()
    if (!message) return { state: 'empty' }
    let event = message.value
    // The queue envelope is part of the durable execution identity. A
    // transport bug or poisoned message must never make us execute one event
    // while acknowledging another id; discard only the malformed delivery so
    // restore() can rebuild the authoritative event by its own id.
    if (message.id !== event.id) {
      await this.queue.ack(message)
      return { state: 'dead_letter', event }
    }
    // `attempts` is the claim counter: the repository increments it atomically
    // with the lease, so it also counts attempts that ended in a crash.
    const attempt = Math.max(1, event.attempts ?? 0)
    const leaseToken = event.leaseToken
    if (!leaseToken) {
      await this.queue.ack(message)
      return { state: 'dead_letter', event }
    }

    try {
      const leasedEvent = await this.store.validateLease(event.workspaceId, event.id, leaseToken, new Date(this.now()).toISOString())
      // The queue is only a delivery hint. The lease validation response is
      // the authoritative durable payload and must be the one executed.
      event = leasedEvent
      // A transport can deliver a duplicate after the first delivery was
      // acknowledged (for example, when a Redis claim was copied before the
      // processing entry was removed). The database is authoritative: do not
      // invoke the handler again once the durable outcome is already recorded.
      if (leasedEvent.publishedAt || leasedEvent.unknownAt) {
        await this.queue.ack(message)
        return { state: 'dead_letter', event: leasedEvent }
      }
      // A worker that dies mid-handler never records an outcome, so `attempts`
      // kept by failures alone can never bound the retries. The claim counter
      // is the only evidence such an attempt ever happened: once it exceeds the
      // budget the event is terminal instead of being reclaimed forever.
      if ((leasedEvent.attempts ?? 0) > this.maxAttempts) {
        return await this.exhaustClaimBudget(leasedEvent, message)
      }
    } catch (leaseError) {
      return this.handleLeaseError(event, message, leaseError)
    }

    // The lease is now provably this worker's, so this is the first point where
    // a line may honestly claim the worker started executing the event.
    try {
      this.onDispatch?.({ state: 'started', event, attempt: Math.max(1, event.attempts ?? 0) })
    } catch {
      // A broken observer must never stop an authorized execution.
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
        // The database lease is the only proof this worker owns the event:
        // without it the outcome write is rejected, so stop the handler.
        leaseError = cause
        abortController.abort(cause)
        return
      }
      try {
        // The queue claim is a delivery hint, not the ownership proof. Recovery
        // re-checks every reclaimed delivery against the database lease, so a
        // failed hint refresh can never hand this work to a peer. Aborting the
        // handler (and the lease renewal that keeps peers out) on a hint outage
        // would instead discard the outcome of a handler that is still writing.
        await this.queue.refreshClaim?.(message)
      } catch { /* hint only: the durable lease still owns this claim */ }
      if (!stopped && leaseError === undefined) heartbeatTimer = setTimeout(runHeartbeat, heartbeatIntervalMs)
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
        // The database is authoritative; this queue message carries an expired
        // lease, so the outcome of a handler that already completed could not be
        // recorded. That outcome is *not* a dead letter: `ack` only ever refuses
        // while `published_at IS NULL`, so the row is still pending, restore()
        // re-delivers it under a fresh claim, and the handler runs again - which
        // is exactly why this must not be reported as terminal. A silent
        // `dead_letter` both discards the completed result and hides the
        // duplicate external side effect that is now possible. Report an
        // unknown outcome under its own code instead, keeping the authorization
        // correlation so the event stays joinable with the request that queued
        // it. The delivery is still dropped (the peer's claim is authoritative)
        // and no store write is attempted: every write in `DurableOutboxStore`
        // is lease-scoped, so it would fail with the very error just caught.
        await this.queue.ack(message)
        return { state: 'unknown', event, failure: withAuthorizationCorrelation(event, UNRECORDED_OUTCOME_LEASE_LOST) }
      }
      await this.queue.nack(message, retryAfterLeaseMs(event, this.now(), this.baseDelayMs))
      throw persistenceError
    }
  }

  private async handleLeaseError(event: E, message: QueueMessage<E>, leaseError: unknown): Promise<DurableDispatchResult<E>> {
    // A claim that could not be renewed is not provably this worker's any more.
    // Requeueing this delivery only parks a token that the next claim
    // invalidates - in the poll loop that claim always runs first - and the
    // dead delivery then costs a claim and delays the retry. Drop it instead:
    // the durable row stays pending, so restore() re-delivers the event with a
    // fresh claim once the lease is genuinely reclaimable.
    await this.queue.ack(message)
    if (isStaleOutboxError(leaseError)) return { state: 'dead_letter', event }
    throw leaseError
  }

  /**
   * Terminal outcome for an event that consumed its whole claim budget: the
   * handler may never have returned (poison payload, OOM kill, hard restart),
   * but the claim counter proves the attempts were spent.
   */
  private async exhaustClaimBudget(event: E, message: QueueMessage<E>): Promise<DurableDispatchResult<E>> {
    const failure = withAuthorizationCorrelation(event, {
      code: 'WORKER_CLAIM_ATTEMPTS_EXHAUSTED',
      message: `worker claimed this event ${event.attempts ?? 0} times without recording an outcome`,
      retryable: false,
      unknown: false,
    })
    if (this.store.deadLetter) {
      const updated = await this.store.deadLetter(event.workspaceId, event.id, failure, event.leaseToken)
      await this.queue.ack(message)
      return { state: 'dead_letter', event: updated }
    }
    const updated = await this.store.recordFailure(event.workspaceId, event.id, failure, new Date(this.now() + this.maxDelayMs).toISOString(), event.leaseToken)
    await this.queue.ack(message)
    return { state: 'dead_letter', event: updated }
  }

  /**
   * Full jitter spreads a platform-wide failure across the retry window instead
   * of re-hitting the provider in lockstep. baseDelayMs stays the floor so
   * jitter can never collapse a retry into an immediate hot loop.
   */
  private retryDelayMs(attempts: number, failure?: WorkerError): number {
    // A backpressure window named by the failing dependency is not a congestion
    // signal: waiting less than it asked guarantees another certain failure, and
    // jitter could only make that worse. It replaces the backoff outright and is
    // deliberately allowed to exceed maxDelayMs, which bounds *backoff*, not a
    // wall-clock window the provider set. baseDelayMs stays the floor and
    // MAX_RETRY_DELAY_MS the ceiling.
    const retryAfterMs = failure?.retryAfterMs
    if (typeof retryAfterMs === 'number' && Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(this.baseDelayMs, retryAfterMs))
    }
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempts - 1))
    if (ceiling <= 0) return 0
    const floor = Math.min(this.baseDelayMs, ceiling)
    return Math.min(ceiling, Math.max(floor, Math.floor(this.random() * ceiling)))
  }

  private async recordHandlerFailure(event: E, message: QueueMessage<E>, failure: WorkerError): Promise<DurableDispatchResult<E>> {
    try {
      if (failure.unknown) {
        const updated = await this.store.markUnknown(event.workspaceId, event.id, failure, event.leaseToken)
        await this.queue.ack(message)
        return { state: 'unknown', event: updated }
      }
      if (!failure.retryable || (event.attempts ?? 0) >= this.maxAttempts) {
        if (this.store.deadLetter) {
          const updated = await this.store.deadLetter(event.workspaceId, event.id, failure, event.leaseToken)
          await this.queue.ack(message)
          return { state: 'dead_letter', event: updated }
        }
        const updated = await this.store.recordFailure(event.workspaceId, event.id, failure, new Date(this.now() + this.maxDelayMs).toISOString(), event.leaseToken)
        await this.queue.ack(message)
        return { state: 'dead_letter', event: updated }
      }
      const delay = this.retryDelayMs(event.attempts ?? 0, failure)
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

/**
 * The depth limit is enforced by the transport when it accepts a delivery, so
 * a full queue surfaces here after the claim was already taken. It is the only
 * error restore() treats as backpressure instead of a failure.
 */
function isQueueDepthExceeded(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'WORKER_QUEUE_DEPTH_EXCEEDED'
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
  // The backpressure hint is copied, never trusted: a retry delay is only
  // accepted as a positive bounded integer, so a malformed field degrades to
  // the ordinary backoff instead of an unbounded park.
  const retryAfterMs = candidate?.retryAfterMs
  const retryAfterHint = typeof retryAfterMs === 'number' && Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0 && retryAfterMs <= MAX_RETRY_DELAY_MS
    ? { retryAfterMs }
    : {}
  return {
    code,
    message: rawMessage.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 2_000),
    retryable: candidate?.retryable === true,
    unknown: candidate?.unknown === true,
    ...retryAfterHint,
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
