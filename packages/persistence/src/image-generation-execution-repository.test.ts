import { describe, expect, it } from 'vitest'
import { ImageGenerationExecutionError, MemoryImageGenerationExecutionRepository } from './image-generation-execution-repository.js'

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
