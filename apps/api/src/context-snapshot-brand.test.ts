import { describe, expect, it, vi } from 'vitest'
import { MemoryContextSnapshotRepository } from '../../../packages/persistence/src/context-snapshot-repository.js'
import { legacyTaskBrandScopeCompatible, resolveContextSnapshotBrandId } from './context-snapshot-brand.js'

describe('context snapshot durable brand binding', () => {
  it('omits a legacy brand while retaining the task and workspace link', async () => {
    const brandUnits = { listBrands: vi.fn().mockResolvedValue([]) }
    const workspaceId = 'ws_legacy'
    const brandId = await resolveContextSnapshotBrandId({
      persistenceMode: 'postgres',
      workspaceId,
      brandId: 'brand_legacy',
      brandUnits,
    })

    expect(brandId).toBeUndefined()
    expect(brandUnits.listBrands).toHaveBeenCalledWith({ workspaceId, brandId: 'brand_legacy' })

    const repository = new MemoryContextSnapshotRepository()
    const saved = await repository.save({
      workspaceId,
      ...(brandId ? { brandId } : {}),
      taskId: 'task_legacy',
      envelope: { product: { title: '待归品牌商品' } },
      inputTokensEstimate: 12,
      maxInputTokens: 100,
    })
    expect(saved).toMatchObject({ workspaceId, taskId: 'task_legacy' })
    expect(saved.brandId).toBeUndefined()
  })

  it('does not accept a same-id brand from another workspace', async () => {
    const brandUnits = { listBrands: vi.fn().mockResolvedValue([{ id: 'brand_1', workspaceId: 'ws_other' }]) }
    await expect(resolveContextSnapshotBrandId({
      persistenceMode: 'postgres',
      workspaceId: 'ws_owner',
      brandId: 'brand_1',
      brandUnits,
    })).resolves.toBeUndefined()
  })

  it('preserves the memory fallback brand behavior', async () => {
    await expect(resolveContextSnapshotBrandId({
      persistenceMode: 'memory',
      workspaceId: 'ws_memory',
      brandId: ' brand_legacy ',
      brandUnits: { listBrands: vi.fn().mockResolvedValue([]) },
    })).resolves.toBe(' brand_legacy ')
  })

  it('allows only an exact frozen legacy brand scope', () => {
    expect(legacyTaskBrandScopeCompatible({ workspaceId: 'ws_owner', taskBrandId: 'brand_legacy', frozenBrandId: 'brand_legacy', frozenBrandWorkspaceId: 'ws_owner' })).toBe(true)
    expect(legacyTaskBrandScopeCompatible({ workspaceId: 'ws_owner', taskBrandId: 'brand_foreign', frozenBrandId: 'brand_legacy', frozenBrandWorkspaceId: 'ws_owner' })).toBe(false)
    expect(legacyTaskBrandScopeCompatible({ workspaceId: 'ws_owner', taskBrandId: 'brand_legacy', frozenBrandId: 'brand_legacy', frozenBrandWorkspaceId: 'ws_other' })).toBe(false)
  })
})
