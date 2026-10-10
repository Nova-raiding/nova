import { describe, expect, it, vi } from 'vitest'
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

  it('rejects cross-workspace products before writing any knowledge records', async () => {
    const repository = new MemoryKnowledgeRepository()
    const createAsset = vi.spyOn(repository, 'createAsset')

    await expect(projectImportedProductsToKnowledge({
      repository,
      workspaceId: 'ws_target',
      products: [
        { id: 'p_valid', workspaceId: 'ws_target', title: '本租户商品', platform: 'jd' },
        { id: 'p_foreign', workspaceId: 'ws_other', title: '其他租户商品', platform: 'jd' },
      ],
    })).rejects.toThrow('商品 p_foreign 不属于目标工作区')

    expect(createAsset).not.toHaveBeenCalled()
    expect(await repository.listDocuments('ws_target')).toEqual([])
    expect(await repository.listDocuments('ws_other')).toEqual([])
  })

  it('projects material, specifications and pending selling points from product facts', async () => {
    const repository = new MemoryKnowledgeRepository()
    const result = await projectImportedProductsToKnowledge({ repository, workspaceId: 'ws_3', products: [{ id: 'p_3', workspaceId: 'ws_3', title: '运动鞋', platform: 'jd', attributes: { brand: '贵人鸟', material: '网布', specification: '42码' }, sellingPoints: [{ id: 'sp_1', text: '轻便', proofStatus: 'pending' }] }] })
    expect(result.documents[0]?.extractedText).toContain('material')
    expect(result.documents[0]?.extractedText).toContain('轻便（pending）')
    expect(result.documents[0]?.approvalStatus).toBe('pending')
  })
})
