import { describe, expect, it } from 'vitest'
import { EntitlementConsumptionIdempotencyConflictError, MemoryEntitlementRepository } from './entitlement-repository.js'

describe('MemoryEntitlementRepository', () => {
  it('grants each paid addon once and exposes remaining units', async () => {
    const repository = new MemoryEntitlementRepository()
    const input = { workspaceId: 'ws_entitlement', orderNo: 'SO1', addonCode: 'image_pack', kind: 'image_generation' as const, units: 100 }
    const first = await repository.grant(input)
    const replay = await repository.grant(input)
    expect(replay).toEqual(first)
    expect(await repository.list(input.workspaceId)).toMatchObject([{ addonCode: 'image_pack', grantedUnits: 100, usedUnits: 0, remainingUnits: 100 }])
  })

  it('consumes idempotently and restores units after a failed action', async () => {
    const repository = new MemoryEntitlementRepository()
    await repository.grant({ workspaceId: 'ws_consume', orderNo: 'SO2', addonCode: 'image_pack', kind: 'image_generation', units: 2 })
    const first = await repository.consume({ workspaceId: 'ws_consume', kind: 'image_generation', units: 1, idempotencyKey: 'image-addon:one' })
    const replay = await repository.consume({ workspaceId: 'ws_consume', kind: 'image_generation', units: 1, idempotencyKey: 'image-addon:one' })
    expect(replay).toEqual(first)
    expect((await repository.list('ws_consume'))[0]).toMatchObject({ usedUnits: 1, remainingUnits: 1 })
    expect((await repository.refund({ workspaceId: 'ws_consume', idempotencyKey: 'image-addon:one' })).refunded).toBe(true)
    expect((await repository.list('ws_consume'))[0]).toMatchObject({ usedUnits: 0, remainingUnits: 2 })
  })

  it('rejects idempotency reuse for a different entitlement intent', async () => {
    const repository = new MemoryEntitlementRepository()
    await repository.grant({ workspaceId: 'ws_conflict', orderNo: 'SO3', addonCode: 'image_pack', kind: 'image_generation', units: 3 })
    await repository.consume({ workspaceId: 'ws_conflict', kind: 'image_generation', units: 1, idempotencyKey: 'same-key' })

    await expect(repository.consume({ workspaceId: 'ws_conflict', kind: 'image_generation', units: 2, idempotencyKey: 'same-key' })).rejects.toBeInstanceOf(EntitlementConsumptionIdempotencyConflictError)
  })
})
