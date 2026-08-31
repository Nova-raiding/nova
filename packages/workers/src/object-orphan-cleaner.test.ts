import { describe, expect, it, vi } from 'vitest'
import { MemoryObjectOrphanRepository } from '../../persistence/src/object-orphan-repository.js'
import { cleanObjectStorageOrphans } from './object-orphan-cleaner.js'

describe('object orphan cleaner', () => {
  it('cleans deletable objects and reschedules transient failures', async () => {
    const repository = new MemoryObjectOrphanRepository()
    await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'ok', reason: 'rollback' })
    await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'fail', reason: 'rollback' })
    const result = await cleanObjectStorageOrphans({ workspaceId: 'ws_1', repository, now: new Date(), deleteObject: vi.fn(async key => { if (key === 'fail') throw new Error('timeout') }) })
    expect(result).toEqual({ scanned: 2, cleaned: 1, retrying: 1, manualAttention: 0 })
    expect(await repository.listPending('ws_1')).toEqual([])
  })

  it('runs quota recovery only after physical deletion succeeds', async () => {
    const repository = new MemoryObjectOrphanRepository()
    await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'clean/ws_1/asset-1/file.bin', reason: 'rollback' })
    const onDeleted = vi.fn(async () => undefined)
    await cleanObjectStorageOrphans({ workspaceId: 'ws_1', repository, deleteObject: async () => undefined, onDeleted })
    expect(onDeleted).toHaveBeenCalledWith(expect.objectContaining({ objectKey: 'clean/ws_1/asset-1/file.bin' }))

    await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'clean/ws_1/asset-2/file.bin', reason: 'rollback' })
    const failedDeleteCallback = vi.fn(async () => undefined)
    await cleanObjectStorageOrphans({ workspaceId: 'ws_1', repository, deleteObject: async () => { throw new Error('delete failed') }, onDeleted: failedDeleteCallback })
    expect(failedDeleteCallback).not.toHaveBeenCalled()
  })

  it('moves exhausted failures to manual attention', async () => {
    const repository = new MemoryObjectOrphanRepository()
    const row = await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'fail', reason: 'rollback' })
    await repository.markRetry({ workspaceId: 'ws_1', id: row.id, error: 'again', nextAttemptAt: '2020-01-01T00:00:00.000Z' })
    const result = await cleanObjectStorageOrphans({ workspaceId: 'ws_1', repository, maxAttempts: 3, deleteObject: async () => { throw new Error('still unavailable') } })
    expect(result.manualAttention).toBe(1)
    expect(await repository.listPending('ws_1')).toEqual([])
  })

  it('single-flights the same orphan across concurrent cleaners in one process', async () => {
    const repository = new MemoryObjectOrphanRepository()
    await repository.enqueue({ workspaceId: 'ws_1', objectKey: 'shared', reason: 'rollback' })
    let releaseDelete!: () => void
    const deleteStarted = new Promise<void>(resolve => { releaseDelete = resolve })
    const deleteObject = vi.fn(async () => {
      releaseDelete()
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    const onDeleted = vi.fn(async () => undefined)

    const first = cleanObjectStorageOrphans({ workspaceId: 'ws_1', repository, deleteObject, onDeleted })
    await deleteStarted
    const second = cleanObjectStorageOrphans({ workspaceId: 'ws_1', repository, deleteObject, onDeleted })
    await Promise.all([first, second])

    expect(deleteObject).toHaveBeenCalledOnce()
    expect(onDeleted).toHaveBeenCalledOnce()
    expect(await repository.listPending('ws_1')).toEqual([])
  })
})
