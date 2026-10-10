import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { hashCatalogBatchImportIntent, hashCatalogBatchImportRequest, MemoryCatalogBatchImportIdempotencyRepository } from './catalog-batch-import-idempotency-repository.js'

describe('catalog batch import idempotency repository', () => {
  const input = { workspaceId: 'ws_catalog_idempotency', actorId: 'merchant-a', key: 'catalog-import-key-1', requestHash: 'a'.repeat(64) }

  afterEach(() => vi.useRealTimers())

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

  it('fences an expired claim owner after another request takes over the key', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'))
    const repository = new MemoryCatalogBatchImportIdempotencyRepository()
    const expiredOwner = await repository.claim(input)
    if (expiredOwner.kind !== 'claimed') throw new Error('expected first claim')

    vi.advanceTimersByTime(5 * 60_000 + 1)
    const currentOwner = await repository.claim(input)
    if (currentOwner.kind !== 'claimed') throw new Error('expected expired claim takeover')

    await expect(repository.start({ ...input, token: expiredOwner.token })).rejects.toMatchObject({ code: 'PRODUCT_IMPORT_IDEMPOTENCY_CLAIM_LOST' })
    await repository.start({ ...input, token: currentOwner.token })
    await repository.complete({ ...input, token: currentOwner.token, result: { batchId: 'current-owner' } })
    await expect(repository.complete({ ...input, token: expiredOwner.token, result: { batchId: 'stale-owner' } })).rejects.toMatchObject({ code: 'PRODUCT_IMPORT_IDEMPOTENCY_CLAIM_LOST' })
    await expect(repository.claim(input)).resolves.toEqual({ kind: 'completed', result: { batchId: 'current-owner' } })
  })

  it('hashes equivalent REST and MCP normalized intents identically', () => {
    const mcpItems = [{ platform: 'jd', title: '蓝鞋', skuCount: 1, skus: [{ id: 's1', name: '蓝色', price: 129, stock: 5 }] }]
    const restItems = [{ skus: [{ stock: 5, price: 129, name: '蓝色', id: 's1' }], skuCount: 1, title: '蓝鞋', platform: 'jd' }]
    expect(hashCatalogBatchImportIntent({ items: mcpItems })).toBe(hashCatalogBatchImportIntent({ items: restItems, draftOnly: false, sourceAssetId: null, manualSource: null }))
  })

  it('uses locale-independent code-point ordering for payload object keys', () => {
    const payload = { 'ä': 4, z: 3, a: 2, A: 1 }
    const expected = createHash('sha256').update('{"A":1,"a":2,"z":3,"ä":4}').digest('hex')
    expect(hashCatalogBatchImportRequest(payload)).toBe(expected)
    expect(hashCatalogBatchImportIntent({ items: payload })).toBe(hashCatalogBatchImportIntent({ items: { A: 1, a: 2, z: 3, 'ä': 4 } }))
  })
})
