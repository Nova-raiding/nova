import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PostgresOutboxRepository } from '../../../packages/persistence/src/index.js'
import { InMemoryQueue, type DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import { WORKER_DISPATCH_LOG_FIELDS, workerDispatchCorrelation } from '../../../packages/workers/src/dispatch-observability.js'
import type { WorkerCommercialAccessGuard } from '../../../packages/workers/src/commercial-access.js'
import type { WorkerExecutionAuthorizationGuard } from '../../../packages/workers/src/execution-authorization.js'
import { pollOnce } from './main.js'

/**
 * The production ops runbook requires worker lines to correlate `trace_id`,
 * `request_id`, `workspace_id`, `task_id`, `job_id`, `platform` and
 * `account_id`. Before this suite existed `pollOnce` returned the
 * succeeded/unknown/queued/deadLetter counters without writing a single line,
 * so a dead letter was only observable by querying `outbox_events.last_error`.
 * Every assertion here fails on that older behaviour: no line is emitted at all.
 */

const WORKSPACE_ID = 'ws_dispatch_observed'
const JOB_ID = 'gen_job_observed_1'
const REQUEST_ID = 'req_dispatch_observed'
const TRACE_ID = 'trace_dispatch_observed'
const SECRET_TOKEN = 'sk-live-should-never-be-logged'
const SECRET_COOKIE = 'session=should-never-be-logged'

const executionAuthorization: WorkerExecutionAuthorizationGuard = {
  assertAuthorized: async (event, operation) => ({
    recheckId: `recheck_${event.id}`,
    actorId: 'actor_dispatch',
    identityId: 'identity_dispatch',
    workspaceId: event.workspaceId,
    workbench: 'workspace',
    contextId: `workspace:${event.workspaceId}`,
    contextVersion: 'ctx_v1',
    policyVersion: 'policy_v1',
    grantRevision: 'grant_v1',
    grantIds: [],
    scopeHash: 'a'.repeat(64),
    capability: operation,
    resourceId: event.aggregateId,
    resourceRevision: 'resource_v1',
    requestId: REQUEST_ID,
    traceId: TRACE_ID,
    authorized: true,
    checkedAt: new Date().toISOString(),
  }),
}

const commercialAccess: WorkerCommercialAccessGuard = {
  assertCommercialAccess: async (event, operation) => ({
    recheckId: `commercial_${event.id}`,
    workspaceId: event.workspaceId,
    operation,
    accessMode: 'POINT_CHARGED',
    accessRevision: 'access_v1',
    balanceState: 'known',
    entitlementSnapshotId: 'entitlement_v1',
    entitlementSnapshotChecksum: 'b'.repeat(64),
    rateVersion: 'rate_v1',
    quotedPoints: 1,
    reservationId: `reservation_${event.id}`,
    reservationState: 'active',
    allowed: true,
    ready: true,
    checkedAt: new Date().toISOString(),
  }),
}

function outboxEvent(overrides: Partial<DurableOutboxEvent> = {}): DurableOutboxEvent {
  return {
    id: 'evt_dispatch_dead_letter',
    workspaceId: WORKSPACE_ID,
    aggregateId: JOB_ID,
    eventType: 'generation.requested',
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload: {
      job_id: JOB_ID,
      task_id: 'task_dispatch_observed',
      platform: 'taobao',
      account_id: 'acct_dispatch_observed',
      authorization_snapshot: {
        schema_version: 1,
        decision_id: 'decision_dispatch',
        actor_id: 'actor_dispatch',
        identity_id: 'identity_dispatch',
        workspace_id: WORKSPACE_ID,
        workbench: 'workspace',
        context_id: `workspace:${WORKSPACE_ID}`,
        context_version: 'ctx_v1',
        policy_version: 'policy_v1',
        grant_revision: 'grant_v1',
        grant_ids: [],
        scope_hash: 'a'.repeat(64),
        capability: 'generation.execute',
        resource_id: JOB_ID,
        resource_revision: 'resource_v1',
        request_id: REQUEST_ID,
        trace_id: TRACE_ID,
        authorized: true,
        decided_at: new Date().toISOString(),
      },
      // Credentials and raw bodies must never reach a log line even when the
      // durable payload carries them.
      credential_ref: SECRET_TOKEN,
      cookie: SECRET_COOKIE,
      input: { prompt: SECRET_TOKEN },
    },
    ...overrides,
  }
}

/**
 * Minimal durable outbox store. `recordFailure` is the terminal write the
 * dispatcher performs when a handler fails non-retryably without a
 * `deadLetter` port.
 */
function outboxRepository(event: DurableOutboxEvent, recorded: Array<{ id: string; failure: Record<string, unknown> }>) {
  const pending = [event]
  return {
    claimPending: async (workspaceId: string, options: { limit?: number; leaseMs?: number; now?: string } = {}) =>
      pending
        .filter(candidate => candidate.workspaceId === workspaceId && !candidate.publishedAt)
        .slice(0, options.limit ?? 100)
        .map(candidate => Object.assign(candidate, { leaseToken: `lease_${candidate.id}`, leaseUntil: new Date(Date.now() + (options.leaseMs ?? 30_000)).toISOString() })),
    validateLease: async (workspaceId: string, id: string, leaseToken: string) => {
      const match = pending.find(candidate => candidate.workspaceId === workspaceId && candidate.id === id && candidate.leaseToken === leaseToken)
      if (!match) throw Object.assign(new Error('outbox event not found'), { code: 'OUTBOX_EVENT_NOT_FOUND' })
      return match
    },
    renewLease: async (workspaceId: string, id: string, leaseToken: string) => {
      const match = pending.find(candidate => candidate.workspaceId === workspaceId && candidate.id === id && candidate.leaseToken === leaseToken)
      if (!match) throw Object.assign(new Error('outbox event not found'), { code: 'OUTBOX_EVENT_NOT_FOUND' })
      return match
    },
    ack: async (workspaceId: string, id: string) => {
      const match = pending.find(candidate => candidate.workspaceId === workspaceId && candidate.id === id)!
      match.publishedAt = new Date().toISOString()
      return match
    },
    recordFailure: async (workspaceId: string, id: string, failure: Record<string, unknown>, nextAttemptAt: string) => {
      const match = pending.find(candidate => candidate.workspaceId === workspaceId && candidate.id === id)!
      recorded.push({ id, failure })
      match.lastError = failure
      match.nextAttemptAt = nextAttemptAt
      match.attempts = (match.attempts ?? 0) + 1
      return match
    },
    markUnknown: async () => { throw new Error('unexpected markUnknown') },
  } as unknown as PostgresOutboxRepository
}

function captureLogLines(): string[] {
  const lines: string[] = []
  vi.spyOn(console, 'info').mockImplementation(value => { lines.push(String(value)) })
  return lines
}

function parseLines(lines: string[]): Array<Record<string, unknown>> {
  return lines.map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('worker outbox dispatch observability', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('emits a correlated structured line when an event dead-letters', async () => {
    const lines = captureLogLines()
    const recorded: Array<{ id: string; failure: Record<string, unknown> }> = []
    const event = outboxEvent()
    const repository = outboxRepository(event, recorded)

    const result = await pollOnce(
      repository,
      new Map(),
      { workspaces: [WORKSPACE_ID], batchSize: 1, leaseMs: 30_000 },
      () => new InMemoryQueue<DurableOutboxEvent>(),
      {
        executionAuthorization,
        commercialAccess,
        generationRequested: async () => { throw Object.assign(new Error('provider rejected the generation'), { code: 'GENERATION_JOB_TERMINAL' }) },
      },
    )

    expect(result.deadLetter).toBe(1)
    expect(recorded).toHaveLength(1)
    expect(lines.length).toBeGreaterThan(0)

    const deadLetter = parseLines(lines).find(line => line.event === 'worker.outbox.dead_letter')
    expect(deadLetter).toBeDefined()
    // The runbook join keys, taken from the authorization snapshot the API wrote
    // at enqueue time — not from the outbox row id or an in-process job id.
    expect(deadLetter).toMatchObject({
      workspace_id: WORKSPACE_ID,
      job_id: JOB_ID,
      task_id: 'task_dispatch_observed',
      request_id: REQUEST_ID,
      trace_id: TRACE_ID,
      platform: 'taobao',
      account_id: 'acct_dispatch_observed',
      outbox_event_type: 'generation.requested',
      attempt: 1,
      error_code: 'GENERATION_JOB_TERMINAL',
    })
    expect(deadLetter?.outbox_event_id).toBe(event.id)
    // A trace id that merely repeats the outbox row id would not join with the
    // API request stream.
    expect(deadLetter?.trace_id).not.toBe(deadLetter?.outbox_event_id)
  })

  it('emits the whitelisted field set only and never leaks credentials, cookies or request bodies', async () => {
    const lines = captureLogLines()
    const repository = outboxRepository(outboxEvent(), [])

    await pollOnce(
      repository,
      new Map(),
      { workspaces: [WORKSPACE_ID], batchSize: 1, leaseMs: 30_000 },
      () => new InMemoryQueue<DurableOutboxEvent>(),
      {
        executionAuthorization,
        commercialAccess,
        generationRequested: async () => { throw Object.assign(new Error('provider rejected the generation'), { code: 'GENERATION_JOB_TERMINAL' }) },
      },
    )

    const parsed = parseLines(lines)
    expect(parsed.length).toBeGreaterThan(0)
    for (const line of parsed) {
      expect(Object.keys(line)).toEqual([...WORKER_DISPATCH_LOG_FIELDS])
    }
    expect(lines.join('\n')).not.toMatch(new RegExp(`${SECRET_TOKEN}|should-never-be-logged|credential_ref|cookie|Bearer`, 'u'))
  })

  it('reports dispatch start and success transitions with the same correlation', async () => {
    const lines = captureLogLines()
    const repository = outboxRepository(outboxEvent(), [])

    await pollOnce(
      repository,
      new Map(),
      { workspaces: [WORKSPACE_ID], batchSize: 1, leaseMs: 30_000 },
      () => new InMemoryQueue<DurableOutboxEvent>(),
      { executionAuthorization, commercialAccess, generationRequested: async () => ({ title: '观测内容', detail: '正文', sellingPoints: ['观测'] }) },
    )

    const events = parseLines(lines).map(line => line.event)
    expect(events).toContain('worker.outbox.dispatch_started')
    expect(events).toContain('worker.outbox.succeeded')
    const succeeded = parseLines(lines).find(line => line.event === 'worker.outbox.succeeded')
    expect(succeeded).toMatchObject({ workspace_id: WORKSPACE_ID, job_id: JOB_ID, trace_id: TRACE_ID, request_id: REQUEST_ID })
  })

  it('reports a retry with the durable next attempt time instead of a silent counter', async () => {
    const lines = captureLogLines()
    const repository = outboxRepository(outboxEvent({
      id: 'evt_dispatch_retry',
      aggregateId: 'sync_job_observed_1',
      eventType: 'sync.requested',
      payload: {
        job_id: 'sync_job_observed_1',
        task_id: 'task_dispatch_observed',
        platform: 'taobao',
        account_id: 'acct_dispatch_observed',
        authorization_snapshot: { request_id: REQUEST_ID, trace_id: TRACE_ID },
      },
    }), [])

    const result = await pollOnce(
      repository,
      new Map(),
      { workspaces: [WORKSPACE_ID], batchSize: 1, leaseMs: 30_000 },
      () => new InMemoryQueue<DurableOutboxEvent>(),
      {
        executionAuthorization,
        commercialAccess,
        syncRequested: async () => { throw Object.assign(new Error('connector is rate limited'), { code: 'SYNC_EXECUTION_FAILED', retryable: true }) },
      },
    )

    expect(result.queued).toBe(1)
    const retry = parseLines(lines).find(line => line.event === 'worker.outbox.retry_scheduled')
    expect(retry).toBeDefined()
    expect(retry).toMatchObject({ job_id: 'sync_job_observed_1', trace_id: TRACE_ID, error_code: 'SYNC_EXECUTION_FAILED' })
    expect(typeof retry?.retry_at).toBe('string')
  })

  it('derives the correlation from the authorization snapshot rather than the aggregate id', () => {
    const withSnapshot = outboxEvent()
    expect(workerDispatchCorrelation(withSnapshot)).toMatchObject({
      workspaceId: WORKSPACE_ID,
      requestId: REQUEST_ID,
      traceId: TRACE_ID,
      jobId: JOB_ID,
      platform: 'taobao',
      accountId: 'acct_dispatch_observed',
    })

    // A scan event's aggregate id is an asset id: reporting it as `job_id`
    // would write a wrong join key into the ops stream.
    const scanEvent = outboxEvent({ eventType: 'asset.uploaded', aggregateId: 'asset_1', payload: {} })
    expect(workerDispatchCorrelation(scanEvent).jobId).toBeNull()

    // Event types that do carry a durable job identity in aggregate id still
    // resolve a job id when the payload omits it.
    const publishEvent = outboxEvent({ eventType: 'publish.requested', aggregateId: 'publish_job_9', payload: {} })
    expect(workerDispatchCorrelation(publishEvent).jobId).toBe('publish_job_9')
  })

  it('drops control characters and oversize identifiers instead of writing them into the stream', () => {
    const hostile = outboxEvent({
      // Not a job-identity event type, so no aggregate-id fallback masks a
      // rejected payload identifier.
      eventType: 'asset.uploaded',
      aggregateId: 'asset_1',
      payload: {
        job_id: 'job\ninjected',
        task_id: 'x'.repeat(4096),
        authorization_snapshot: { request_id: `req${String.fromCharCode(27)}[31m`, trace_id: TRACE_ID },
      },
    })
    const correlation = workerDispatchCorrelation(hostile)
    expect(correlation.jobId).toBeNull()
    expect(correlation.taskId).toBeNull()
    expect(correlation.requestId).toBeNull()
    expect(correlation.traceId).toBe(TRACE_ID)
  })
})
