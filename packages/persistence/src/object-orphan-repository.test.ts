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
})
