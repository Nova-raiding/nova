import { describe, expect, it } from 'vitest'
import { MemoryStorageQuotaRepository, StorageQuotaActualExceededError, StorageQuotaExceededError } from './storage-quota-repository.js'

describe('MemoryStorageQuotaRepository', () => {
  const base = { workspaceId: 'ws_storage', assetId: 'asset_1', bytes: 60, limitBytes: 100 }

  it('reserves idempotently, settles logical bytes, and releases unused reservations', async () => {
    const repository = new MemoryStorageQuotaRepository()
    const first = await repository.reserve({ ...base, reservationKey: 'upload_1' })
    const replay = await repository.reserve({ ...base, reservationKey: 'upload_1' })
    expect(replay).toMatchObject({ reused: true, reservation: { revision: first.reservation.revision } })
    const settled = await repository.settle({ workspaceId: base.workspaceId, reservationKey: 'upload_1', actualBytes: 40 })
    expect(settled.reservation).toMatchObject({ status: 'settled', actualBytes: 40, reservedBytes: 0 })
    const second = await repository.reserve({ ...base, assetId: 'asset_2', bytes: 60, reservationKey: 'upload_2' })
    expect(second.reservation.status).toBe('active')
    await expect(repository.reserve({ ...base, assetId: 'asset_3', bytes: 1, reservationKey: 'upload_3' })).rejects.toBeInstanceOf(StorageQuotaExceededError)
    expect(await repository.release({ workspaceId: base.workspaceId, reservationKey: 'upload_2' })).toMatchObject({ status: 'released', reservedBytes: 0 })
    await expect(repository.release({ workspaceId: base.workspaceId, reservationKey: 'upload_1' })).rejects.toThrow('STORAGE_QUOTA_SETTLED_RELEASE_REQUIRES_PHYSICAL_DELETION')
    expect(await repository.releaseAfterPhysicalDeletion({ workspaceId: base.workspaceId, reservationKey: 'upload_1', receipt: { objectKey: 'clean/ws_storage/asset_1.bin', deletedAt: '2026-08-29T00:00:00.000Z', verification: 'delete_ack' } })).toMatchObject({ status: 'released', actualBytes: undefined })
    await expect(repository.reserve({ ...base, bytes: 100, reservationKey: 'upload_4' })).resolves.toMatchObject({ reused: false })
    expect(await repository.release({ workspaceId: base.workspaceId, reservationKey: 'upload_4' })).toMatchObject({ status: 'released' })
  })

  it('keeps an actual over-limit result durable and fail-closed', async () => {
    const repository = new MemoryStorageQuotaRepository()
    await repository.reserve({ ...base, bytes: 10, reservationKey: 'over_1' })
    await expect(repository.settle({ workspaceId: base.workspaceId, reservationKey: 'over_1', actualBytes: 101 })).rejects.toBeInstanceOf(StorageQuotaActualExceededError)
    await expect(repository.reserve({ ...base, bytes: 1, reservationKey: 'after_over' })).rejects.toBeInstanceOf(StorageQuotaExceededError)
    await expect(repository.release({ workspaceId: base.workspaceId, reservationKey: 'over_1' })).rejects.toThrow('STORAGE_QUOTA_SETTLED_RELEASE_REQUIRES_PHYSICAL_DELETION')
    expect(await repository.releaseAfterPhysicalDeletion({ workspaceId: base.workspaceId, reservationKey: 'over_1', receipt: { objectKey: 'quarantine/ws_storage/asset_over.bin', deletedAt: '2026-08-29T00:00:00.000Z', verification: 'head_absent' } })).toMatchObject({ status: 'released', actualBytes: undefined })
    await expect(repository.reserve({ ...base, bytes: 100, reservationKey: 'after_release' })).resolves.toMatchObject({ reused: false })
  })

  it('rejects conflicting keys and cross-workspace access', async () => {
    const repository = new MemoryStorageQuotaRepository()
    await repository.reserve({ ...base, reservationKey: 'same_key' })
    await expect(repository.reserve({ ...base, assetId: 'other_asset', reservationKey: 'same_key' })).rejects.toThrow('STORAGE_QUOTA_IDEMPOTENCY_CONFLICT')
    expect(await repository.release({ workspaceId: 'ws_other', reservationKey: 'same_key' })).toBeUndefined()
  })
})
