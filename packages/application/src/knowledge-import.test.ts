import { describe, expect, it } from 'vitest'
import { MemoryKnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'
import { projectImportedProductsToKnowledge } from './knowledge-import.js'

describe('projectImportedProductsToKnowledge', () => {
  it('creates product facts, SKU documents, chunks and idempotent bindings', async () => {
    const repository = new MemoryKnowledgeRepository()
    const product = { id: 'p_1', workspaceId: 'ws_1', title: '轻云外套', platform: 'taobao', category: '女装', skus: [{ id: 'sku_blue_m', name: '蓝色/M', price: 99, stock: 10, attributes: { color: '蓝色', size: 'M' } }] }
    const first = await projectImportedProductsToKnowledge({ repository, workspaceId: 'ws_1', products: [product], sourceAssetId: 'asset_sheet', sourceMetadata: { batchId: 'batch_1' } })
    expect(first.assets).toHaveLength(1)
    expect(first.documents).toHaveLength(2)
    expect(first.chunks).toHaveLength(2)
    expect(first.bindings).toHaveLength(2)
    expect(first.documents[1]).toMatchObject({ productId: 'p_1', skuId: 'sku_blue_m', indexState: 'queued', approvalStatus: 'pending' })
    expect(first.chunks[1]?.content).toContain('蓝色/M')
    const second = await projectImportedProductsToKnowledge({ repository, workspaceId: 'ws_1', products: [product], sourceAssetId: 'asset_sheet' })
    expect(second.assets[0]?.id).toBe(first.assets[0]?.id)
    expect(second.documents[0]?.id).toBe(first.documents[0]?.id)
    expect((await repository.listDocuments('ws_1')).length).toBe(2)
  })

  it('keeps imported knowledge fail-closed until approval, rights and indexing gates pass', async () => {
    const repository = new MemoryKnowledgeRepository()
    await projectImportedProductsToKnowledge({ repository, workspaceId: 'ws_2', products: [{ id: 'p_2', workspaceId: 'ws_2', title: '商品', platform: 'jd' }] })
    expect(await repository.search({ workspaceId: 'ws_2', query: '商品' })).toEqual([])
  })
})
