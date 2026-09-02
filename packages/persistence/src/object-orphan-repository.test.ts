import { describe, expect, it } from 'vitest'
import { MemoryObjectOrphanRepository } from './object-orphan-repository.js'

describe('MemoryObjectOrphanRepository', () => {
  it('deduplicates repeated compensation failures and retains retry evidence', async () => {
    const repository = new MemoryObjectOrphanRepository()
    const first = await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'quarantine/ws_1/asset.bin', reason: 'snapshot failed', lastError: 'delete timeout' })
    const replay = await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'quarantine/ws_1/asset.bin', reason: 'snapshot failed again', lastError: 'provider unavailable' })
    expect(replay.id).toBe(first.id)
    expect(replay).toMatchObject({ attempts: 2, state: 'pending', lastError: 'provider unavailable' })
    expect(await repository.listPending('ws_1')).toHaveLength(1)
    await repository.markCleaned({ workspaceId: 'ws_1', id: first.id })
    expect(await repository.listPending('ws_1')).toEqual([])
  })

  it('claims ready rows with a lease token and blocks unleased completion', async () => {
    const repository = new MemoryObjectOrphanRepository()
    const first = await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'a', reason: 'test' })
    const claimTime = new Date().toISOString()
    const claimed = await repository.claimPending('ws_1', { now: claimTime, leaseMs: 10_000 })

    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ id: first.id, leaseToken: expect.any(String), leaseUntil: new Date(Date.parse(claimTime) + 10_000).toISOString() })
    await expect(repository.markCleaned({ workspaceId: 'ws_1', id: first.id })).rejects.toThrow('ORPHAN_LEASE_LOST')
    await repository.markCleaned({ workspaceId: 'ws_1', id: first.id, leaseToken: claimed[0]!.leaseToken })
    expect(await repository.listPending('ws_1')).toEqual([])
  })

  it('does not claim future or leased rows and allows a new worker after lease expiry', async () => {
    const repository = new MemoryObjectOrphanRepository()
    const claimTime = new Date().toISOString()
    const future = await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'future', reason: 'test' })
    await repository.markRetry({ workspaceId: 'ws_1', id: future.id, error: 'wait', nextAttemptAt: new Date(Date.parse(claimTime) + 86_400_000).toISOString() })
    const ready = await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'ready', reason: 'test' })
    const first = await repository.claimPending('ws_1', { now: claimTime, leaseMs: 10_000 })
    expect(first.map(row => row.id)).toEqual([ready.id])
    expect(await repository.claimPending('ws_1', { now: new Date(Date.parse(claimTime) + 5_000).toISOString(), leaseMs: 10_000 })).toEqual([])

    const second = await repository.claimPending('ws_1', { now: new Date(Date.parse(claimTime) + 11_000).toISOString(), leaseMs: 10_000 })
    expect(second).toHaveLength(1)
    await expect(repository.markRetry({ workspaceId: 'ws_1', id: ready.id, error: 'stale worker', nextAttemptAt: '2026-09-04T00:00:00.000Z', leaseToken: first[0]!.leaseToken })).rejects.toThrow('ORPHAN_LEASE_LOST')
    await repository.markRetry({ workspaceId: 'ws_1', id: ready.id, error: 'new worker', nextAttemptAt: '2026-09-04T00:00:00.000Z', leaseToken: second[0]!.leaseToken })
    const recovered = await repository.claimPending('ws_1', { now: new Date(Date.parse(claimTime) + 2 * 86_400_000).toISOString(), leaseMs: 10_000 })
    expect(recovered.find(row => row.id === ready.id)).toMatchObject({ id: ready.id, attempts: 2, lastError: 'new worker' })
  })

  it('re-enqueues a delayed or manual-attention orphan for immediate retry', async () => {
    const repository = new MemoryObjectOrphanRepository()
    const queued = await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'stuck', reason: 'initial failure', lastError: 'first timeout' })
    const claimed = await repository.claimPending('ws_1', { now: queued.nextAttemptAt, leaseMs: 10_000 })
    await repository.markRetry({
      workspaceId: 'ws_1',
      id: queued.id,
      leaseToken: claimed[0]!.leaseToken,
      error: 'needs review',
      nextAttemptAt: '2026-09-03T00:00:00.000Z',
      manualAttention: true,
    })

    const replay = await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'stuck', reason: 'new cleanup signal', lastError: 'retry now' })
    expect(replay).toMatchObject({ id: queued.id, state: 'pending', attempts: 3, lastError: 'retry now' })
    expect(Date.parse(replay.nextAttemptAt)).toBeGreaterThanOrEqual(Date.parse(replay.updatedAt) - 1_000)
    expect(await repository.claimPending('ws_1', { now: replay.nextAttemptAt, leaseMs: 10_000 })).toHaveLength(1)
  })

  it('does not cross workspace boundaries and validates claim options', async () => {
    const repository = new MemoryObjectOrphanRepository()
    await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'a', reason: 'test' })
    await expect(repository.claimPending('ws_2')).resolves.toEqual([])
    await expect(repository.claimPending('ws_1', { limit: 0 })).rejects.toThrow('invalid orphan claim limit')
    await expect(repository.claimPending('ws_1', { leaseMs: 999 })).rejects.toThrow('invalid orphan lease duration')
    await expect(repository.claimPending('ws_1', { now: 'not-a-date' })).rejects.toThrow('invalid orphan claim time')
  })
})
