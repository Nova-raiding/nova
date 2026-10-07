import { describe, expect, it } from 'vitest'
import { hashCatalogBatchImportIntent, MemoryCatalogBatchImportIdempotencyRepository } from './catalog-batch-import-idempotency-repository.js'

describe('catalog batch import idempotency repository', () => {
  const input = { workspaceId: 'ws_catalog_idempotency', actorId: 'merchant-a', key: 'catalog-import-key-1', requestHash: 'a'.repeat(64) }

  it('serially claims once and replays only the completed response', async () => {
    const repository = new MemoryCatalogBatchImportIdempotencyRepository()
    const first = await repository.claim(input)
    expect(first.kind).toBe('claimed')
    expect(await repository.claim(input)).toEqual({ kind: 'in_progress' })
    if (first.kind !== 'claimed') throw new Error('expected first claim')
    await repository.start({ ...input, token: first.token })
    await repository.complete({ ...input, token: first.token, result: { batchId: 'batch-1', count: 1 } })
    expect(await repository.claim(input)).toEqual({ kind: 'completed', result: { batchId: 'batch-1', count: 1 } })
  })

  it('rejects key reuse with a different payload and scopes keys to actor and workspace', async () => {
    const repository = new MemoryCatalogBatchImportIdempotencyRepository()
    await repository.claim(input)
    await expect(repository.claim({ ...input, requestHash: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'PRODUCT_IMPORT_IDEMPOTENCY_CONFLICT' })
    expect((await repository.claim({ ...input, actorId: 'merchant-b' })).kind).toBe('claimed')
    expect((await repository.claim({ ...input, workspaceId: 'ws_other' })).kind).toBe('claimed')
  })

  it('blocks automatic replay after an uncertain side effect', async () => {
    const repository = new MemoryCatalogBatchImportIdempotencyRepository()
    const claim = await repository.claim(input)
    if (claim.kind !== 'claimed') throw new Error('expected first claim')
    await repository.start({ ...input, token: claim.token })
    await repository.markNeedsReconciliation({ ...input, token: claim.token })
    expect(await repository.claim(input)).toEqual({ kind: 'needs_reconciliation' })
  })

  it('allows a safe retry when failure is recorded before durable effects begin', async () => {
    const repository = new MemoryCatalogBatchImportIdempotencyRepository()
    const claim = await repository.claim(input)
    if (claim.kind !== 'claimed') throw new Error('expected first claim')
    await repository.releaseBeforeSideEffects({ ...input, token: claim.token })
    expect((await repository.claim(input)).kind).toBe('claimed')
  })

  it('hashes equivalent REST and MCP normalized intents identically', () => {
    const mcpItems = [{ platform: 'jd', title: '蓝鞋', skuCount: 1, skus: [{ id: 's1', name: '蓝色', price: 129, stock: 5 }] }]
    const restItems = [{ skus: [{ stock: 5, price: 129, name: '蓝色', id: 's1' }], skuCount: 1, title: '蓝鞋', platform: 'jd' }]
    expect(hashCatalogBatchImportIntent({ items: mcpItems })).toBe(hashCatalogBatchImportIntent({ items: restItems, draftOnly: false, sourceAssetId: null, manualSource: null }))
  })
})
