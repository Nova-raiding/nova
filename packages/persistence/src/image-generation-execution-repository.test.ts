import { describe, expect, it } from 'vitest'
import { ImageGenerationExecutionError, MemoryImageGenerationExecutionRepository, PostgresImageGenerationExecutionRepository, type ImageGenerationExecutionState } from './image-generation-execution-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

describe('memory image generation execution repository', () => {
  it('allows takeover only before provider start', async () => {
    const repository = new MemoryImageGenerationExecutionRepository()
    const first = await repository.claim({ workspaceId: 'ws_image', jobId: 'job_1', eventId: 'evt_1', leaseMs: 100, now: '2026-08-31T00:00:00.000Z' })
    await expect(repository.claim({ workspaceId: 'ws_image', jobId: 'job_1', eventId: 'evt_1', leaseMs: 100, now: '2026-08-31T00:00:00.050Z' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_BUSY' })
    const takeover = await repository.claim({ workspaceId: 'ws_image', jobId: 'job_1', eventId: 'evt_1', leaseMs: 100, now: '2026-08-31T00:00:00.101Z' })
    expect(takeover.attempt).toBe(2)
    const reserved = await repository.reserveProviderOperation({ workspaceId: 'ws_image', jobId: 'job_1', ownerToken: takeover.ownerToken, now: '2026-08-31T00:00:00.105Z' })
    const dispatching = await repository.beginProviderDispatch({ workspaceId: 'ws_image', jobId: 'job_1', ownerToken: reserved.ownerToken, now: '2026-08-31T00:00:00.107Z' })
    const started = await repository.markProviderStarted({ workspaceId: 'ws_image', jobId: 'job_1', ownerToken: dispatching.ownerToken, providerRequestId: 'provider_1', now: '2026-08-31T00:00:00.110Z' })
    await expect(repository.claim({ workspaceId: 'ws_image', jobId: 'job_1', eventId: 'evt_1', leaseMs: 100, now: '2026-08-31T00:01:00.000Z' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_PROVIDER_OUTCOME_UNKNOWN', execution: started })
  })

  it('blocks expired lease takeover once a durable provider operation is reserved', async () => {
    const repository = new MemoryImageGenerationExecutionRepository()
    const first = await repository.claim({ workspaceId: 'ws_image', jobId: 'job_reserved', eventId: 'evt_reserved', leaseMs: 100, now: '2026-08-31T00:00:00.000Z' })
    const reserved = await repository.reserveProviderOperation({ workspaceId: 'ws_image', jobId: 'job_reserved', ownerToken: first.ownerToken, now: '2026-08-31T00:00:00.010Z' })
    await expect(repository.claim({ workspaceId: 'ws_image', jobId: 'job_reserved', eventId: 'evt_reserved', leaseMs: 100, now: '2026-08-31T00:00:00.101Z' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_PROVIDER_OUTCOME_UNKNOWN', execution: reserved })
    await expect(repository.reserveProviderOperation({ workspaceId: 'ws_image', jobId: 'job_reserved', ownerToken: first.ownerToken })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
  })

  it('rejects a different event for the same scoped job', async () => {
    const repository = new MemoryImageGenerationExecutionRepository()
    await repository.claim({ workspaceId: 'ws_image', jobId: 'job_2', eventId: 'evt_1', leaseMs: 100, now: '2026-08-31T00:00:00.000Z' })
    await expect(repository.claim({ workspaceId: 'ws_image', jobId: 'job_2', eventId: 'evt_2', leaseMs: 100, now: '2026-08-31T00:00:01.000Z' })).rejects.toBeInstanceOf(ImageGenerationExecutionError)
  })

  it('reconciles an unknown provider outcome only from durable terminal job evidence', async () => {
    const repository = new MemoryImageGenerationExecutionRepository()
    const lease = await repository.claim({ workspaceId: 'ws_image', jobId: 'job_3', eventId: 'evt_3', leaseMs: 100, now: '2026-08-31T00:00:00.000Z' })
    const reserved = await repository.reserveProviderOperation({ workspaceId: 'ws_image', jobId: 'job_3', ownerToken: lease.ownerToken, now: '2026-08-31T00:00:00.000Z' })
    const dispatching = await repository.beginProviderDispatch({ workspaceId: 'ws_image', jobId: 'job_3', ownerToken: reserved.ownerToken, now: '2026-08-31T00:00:00.001Z' })
    const started = await repository.markProviderStarted({ workspaceId: 'ws_image', jobId: 'job_3', ownerToken: dispatching.ownerToken, providerRequestId: 'provider_3', now: '2026-08-31T00:00:00.002Z' })
    await repository.markOutcomeUnknown({ workspaceId: 'ws_image', jobId: 'job_3', ownerToken: started.ownerToken, errorCode: 'CALLBACK_TIMEOUT', errorMessage: 'callback timed out', now: '2026-08-31T00:00:00.002Z' })
    const reconciled = await repository.reconcileCompleted({ workspaceId: 'ws_image', jobId: 'job_3', now: '2026-08-31T00:00:00.003Z' })
    expect(reconciled).toMatchObject({ state: 'completed', providerRequestId: 'provider_3' })
    expect(reconciled.ownerToken).toBeUndefined()
    await expect(repository.reconcileFailed({ workspaceId: 'ws_image', jobId: 'job_3', errorCode: 'NOPE', errorMessage: 'must not rewrite terminal state' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
  })

  it('lists only the requested tenant and execution states', async () => {
    const repository = new MemoryImageGenerationExecutionRepository()
    await repository.claim({ workspaceId: 'ws_image', jobId: 'job_4', eventId: 'evt_4', leaseMs: 100, now: '2026-08-31T00:00:00.000Z' })
    await repository.claim({ workspaceId: 'ws_other', jobId: 'job_4', eventId: 'evt_4', leaseMs: 100, now: '2026-08-31T00:00:00.000Z' })
    expect(await repository.list({ workspaceId: 'ws_image', states: ['leased'] })).toHaveLength(1)
    expect(await repository.list({ workspaceId: 'ws_image', states: ['provider_started'] })).toHaveLength(0)
  })

  it('scans with a stable workspace-bound cursor without skipping equal timestamps', async () => {
    const repository = new MemoryImageGenerationExecutionRepository()
    for (const jobId of ['job_a', 'job_b', 'job_c']) {
      const lease = await repository.claim({ workspaceId: 'ws_cursor', jobId, eventId: `evt_${jobId}`, leaseMs: 100, now: '2026-08-31T00:00:00.000Z' })
      const reserved = await repository.reserveProviderOperation({ workspaceId: 'ws_cursor', jobId, ownerToken: lease.ownerToken, now: '2026-08-31T00:00:00.001Z' })
      const dispatching = await repository.beginProviderDispatch({ workspaceId: 'ws_cursor', jobId, ownerToken: reserved.ownerToken, now: '2026-08-31T00:00:00.002Z' })
      await repository.markProviderStarted({ workspaceId: 'ws_cursor', jobId, ownerToken: dispatching.ownerToken, providerRequestId: `provider_${jobId}`, now: '2026-08-31T00:00:01.000Z' })
    }
    const first = await repository.listPage({ workspaceId: 'ws_cursor', states: ['provider_started'], limit: 2 })
    expect(first.items.map(row => row.jobId)).toEqual(['job_a', 'job_b'])
    expect(first.nextCursor).toBeTruthy()
    const second = await repository.listPage({ workspaceId: 'ws_cursor', states: ['provider_started'], limit: 2, cursor: first.nextCursor })
    expect(second.items.map(row => row.jobId)).toEqual(['job_c'])
    await expect(repository.listPage({ workspaceId: 'ws_other', cursor: first.nextCursor })).rejects.toThrow('cursor is invalid')
    await expect(repository.listPage({ workspaceId: 'ws_cursor', cursor: `${first.nextCursor}tampered` })).rejects.toThrow('cursor is invalid')
  })
})

const preflightFailure = {
  workspaceId: 'ws_preflight', jobId: 'generation_preflight', eventId: 'event_preflight',
  errorCode: 'WORKSPACE_ACCOUNT_INACTIVE', errorMessage: 'Account was deactivated before provider invocation', now: '2026-09-15T00:00:02.000Z',
}
async function preparedMemory(state: ImageGenerationExecutionState = 'provider_reserved') {
  const repository = new MemoryImageGenerationExecutionRepository()
  const claim = await repository.claim({ ...preflightFailure, leaseMs: 100, now: '2026-09-15T00:00:00.000Z' })
  const input = { ...preflightFailure, ownerToken: claim.ownerToken }
  if (state !== 'leased' && state !== 'available') {
    await repository.reserveProviderOperation(input)
    if (state !== 'provider_reserved') {
      await repository.beginProviderDispatch(input)
      if (state === 'outcome_unknown') await repository.markOutcomeUnknown({ ...input, errorCode: 'NETWORK_OUTCOME_UNKNOWN', errorMessage: 'No response after invoking provider' })
      else if (state !== 'provider_dispatching') {
        await repository.markProviderStarted({ ...input, providerRequestId: 'real_provider_request' })
        if (state === 'completed') await repository.markCompleted(input)
        if (state === 'failed') await repository.markFailed({ ...input, errorCode: 'PROVIDER_REJECTED', errorMessage: 'Provider returned a failure' })
      }
    }
  }
  // Only the memory fixture can represent a persisted available row directly;
  // its API intentionally never releases a reserved operation for retry.
  if (state === 'available') (await repository.get(input))!.state = 'available'
  return { repository, input }
}

describe('known image generation failure before provider invocation', () => {
  it.each(['provider_reserved', 'provider_dispatching'] as const)('fails %s once, preserving its durable fence without inventing a request', async state => {
    const { repository, input } = await preparedMemory(state)
    const before = structuredClone(await repository.get(input))!
    const failed = await repository.failBeforeProvider(input)
    expect(failed).toMatchObject({ workspaceId: input.workspaceId, jobId: input.jobId, eventId: input.eventId, state: 'failed',
      attempt: before.attempt, providerOperationKey: before.providerOperationKey, errorCode: input.errorCode, errorMessage: input.errorMessage, updatedAt: input.now })
    expect(failed.ownerToken).toBeUndefined(); expect(failed.leaseExpiresAt).toBeUndefined()
    expect(failed.providerStartedAt).toBeUndefined(); expect(failed.providerRequestId).toBeUndefined()
    // The caller still owns the reservation after lease expiry; no lease
    // freshness claim or automated retry of a reserved operation is made.
    expect(Date.parse(before.leaseExpiresAt!)).toBeLessThan(Date.parse(input.now))
    await expect(repository.failBeforeProvider({ ...input, errorCode: 'REWRITTEN', now: '2026-09-15T00:00:03.000Z' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
    expect(await repository.get(input)).toEqual(failed)
    await expect(repository.claim({ ...input, leaseMs: 100 })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_FAILED', execution: failed })
    await expect(repository.beginProviderDispatch(input)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
  })

  it.each(['workspaceId', 'jobId', 'eventId', 'ownerToken'] as const)('rejects a mismatched %s without changing either tenant', async field => {
    const { repository, input } = await preparedMemory('provider_dispatching')
    const before = structuredClone(await repository.get(input))
    await expect(repository.failBeforeProvider({ ...input, [field]: `${input[field]}_other` })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
    expect(await repository.get(input)).toEqual(before)
    expect(await repository.get({ workspaceId: `${input.workspaceId}_other`, jobId: input.jobId })).toBeUndefined()
  })

  it('cannot use one tenant owner to fail an existing same-job reservation in another tenant', async () => {
    const { repository, input } = await preparedMemory()
    const otherScope = { ...input, workspaceId: 'ws_another_tenant' }
    const otherClaim = await repository.claim({ ...otherScope, leaseMs: 100 })
    const other = await repository.reserveProviderOperation({ ...otherScope, ownerToken: otherClaim.ownerToken })
    const original = structuredClone(await repository.get(input)), otherBefore = structuredClone(other)
    await expect(repository.failBeforeProvider(otherScope)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
    expect(await repository.get(input)).toEqual(original); expect(await repository.get(otherScope)).toEqual(otherBefore)
  })

  it.each(['available', 'leased', 'provider_started', 'outcome_unknown', 'completed', 'failed'] as const)('cannot rewrite %s into an unsent failure', async state => {
    const { repository, input } = await preparedMemory(state)
    const before = structuredClone(await repository.get(input))
    await expect(repository.failBeforeProvider(input)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
    expect(await repository.get(input)).toEqual(before)
  })

  it.each([
    ['provider_reserved', 'providerRequestId'], ['provider_dispatching', 'providerRequestId'],
    ['provider_reserved', 'providerStartedAt'], ['provider_dispatching', 'providerStartedAt'],
  ] as const)('preserves an existing %s %s even on an inconsistent pre-start row', async (state, field) => {
    const { repository, input } = await preparedMemory(state)
    const row = (await repository.get(input))!
    // Admission is deliberately stricter than the old DB phase constraint:
    // provider_request_id could exist on reserved/dispatching legacy rows.
    row[field] = field === 'providerStartedAt' ? input.now : 'existing_request'
    const before = structuredClone(row)
    await expect(repository.failBeforeProvider(input)).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
    expect(await repository.get(input)).toEqual(before)
  })

  it('preserves started evidence when markProviderStarted wins, and prevents start when the failure wins', async () => {
    for (const first of ['start', 'fail'] as const) {
      const { repository, input } = await preparedMemory('provider_dispatching')
      const start = () => repository.markProviderStarted({ ...input, providerRequestId: 'real_request' })
      const fail = () => repository.failBeforeProvider(input)
      const results = await Promise.allSettled(first === 'start' ? [start(), fail()] : [fail(), start()])
      expect(results[0].status).toBe('fulfilled'); expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' } })
      const row = await repository.get(input)
      expect(row?.state).toBe(first === 'start' ? 'provider_started' : 'failed')
      expect(row?.providerRequestId).toBe(first === 'start' ? 'real_request' : undefined)
    }
  })

  it.each(['eventId', 'ownerToken', 'errorCode', 'errorMessage'] as const)('requires nonempty %s before any state change', async field => {
    const { repository, input } = await preparedMemory()
    const before = structuredClone(await repository.get(input))
    await expect(repository.failBeforeProvider({ ...input, [field]: ' ' })).rejects.toThrow(/REQUIRED/u)
    expect(await repository.get(input)).toEqual(before)
  })
})

// SQL adapter contract tests only: this fake does not claim PostgreSQL/RLS or
// inter-process lock verification. A real isolated PG acceptance is separate.
describe('postgres image generation pre-provider failure SQL contract', () => {
  const dbRow = (state: ImageGenerationExecutionState) => ({ workspace_id: preflightFailure.workspaceId, job_id: preflightFailure.jobId,
    event_id: preflightFailure.eventId, state, attempt: 3, owner_token: 'owner_fenced', lease_expires_at: '2026-09-15T00:00:01.000Z',
    provider_operation_key: 'durable_operation_key', provider_request_id: null, provider_started_at: null, error_code: null, error_message: null, updated_at: '2026-09-15T00:00:00.000Z' })
  const adapter = (current: ReturnType<typeof dbRow> | undefined, updated: Record<string, unknown> | undefined) => {
    const queries: { sql: string; params: readonly unknown[] }[] = []
    let released = false
    const client: SqlClient = { query: async <Row>(sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params })
      const rows = sql.startsWith('UPDATE image_generation_executions') ? updated ? [updated] : []
        : sql.includes('FROM image_generation_executions') ? current ? [current] : [] : []
      return { rows: rows as Row[] }
    }, release: () => { released = true } }
    const pool: SqlPool = { connect: async () => client }
    return { repository: new PostgresImageGenerationExecutionRepository(pool), queries, released: () => released }
  }
  it.each(['provider_reserved', 'provider_dispatching'] as const)('uses a single scoped CAS for %s with event, owner and both no-provider-evidence predicates', async state => {
    const input = { ...preflightFailure, ownerToken: 'owner_fenced' }, current = dbRow(state)
    const updated = { ...current, state: 'failed', owner_token: null, lease_expires_at: null, error_code: input.errorCode, error_message: input.errorMessage, updated_at: input.now }
    const { repository, queries, released } = adapter(current, updated)
    const result = await repository.failBeforeProvider(input)
    expect(result).toMatchObject({ state: 'failed', attempt: 3, eventId: input.eventId, providerOperationKey: current.provider_operation_key, errorCode: input.errorCode, errorMessage: input.errorMessage })
    expect(result.ownerToken).toBeUndefined(); expect(result.providerStartedAt).toBeUndefined(); expect(result.providerRequestId).toBeUndefined()
    const writes = queries.filter(query => query.sql.startsWith('UPDATE'))
    expect(writes).toHaveLength(1)
    const sql = writes[0]!.sql.replace(/\s+/gu, ' ')
    expect(sql).toContain("WHERE workspace_id=$1 AND job_id=$2 AND event_id=$3 AND owner_token=$4 AND state IN ('provider_reserved','provider_dispatching') AND provider_request_id IS NULL AND provider_started_at IS NULL RETURNING")
    expect(sql.split(' WHERE ')[0]).toBe("UPDATE image_generation_executions SET state='failed',owner_token=NULL,lease_expires_at=NULL,error_code=$5,error_message=$6,updated_at=$7")
    expect(writes[0]!.params).toEqual([input.workspaceId, input.jobId, input.eventId, input.ownerToken, input.errorCode, input.errorMessage, input.now])
    expect(queries[0]!.sql).toBe('BEGIN'); expect(queries[1]).toEqual({ sql: "SELECT set_config('app.workspace_id', $1, true)", params: [input.workspaceId] })
    expect(queries.at(-1)!.sql).toBe('COMMIT'); expect(released()).toBe(true)
  })

  it.each(['available', 'leased', 'provider_reserved', 'provider_dispatching', 'provider_started', 'outcome_unknown', 'completed', 'failed', undefined] as const)('rolls back a database CAS miss with current state %s, without a retry or repair write', async state => {
    const current = state === undefined ? undefined : dbRow(state)
    const before = structuredClone(current)
    const { repository, queries, released } = adapter(current, undefined)
    await expect(repository.failBeforeProvider({ ...preflightFailure, ownerToken: 'owner_fenced' })).rejects.toMatchObject({ code: 'IMAGE_GENERATION_EXECUTION_LEASE_LOST' })
    expect(current).toEqual(before); expect(queries.filter(query => query.sql.startsWith('UPDATE'))).toHaveLength(1)
    expect(queries.at(-1)!.sql).toBe('ROLLBACK'); expect(released()).toBe(true)
  })
})
