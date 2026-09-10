import { describe, expect, it } from 'vitest'
import { MemoryKnowledgeRepository } from './knowledge.js'

describe('knowledge persistence contract', () => {
  it('binds an Excel-derived asset, indexes chunks, filters unapproved content, rebuilds and records deletion', async () => {
    const repository = new MemoryKnowledgeRepository()
    const asset = await repository.createAsset({ workspaceId: 'ws-a', kind: 'product_facts', name: 'Excel 商品事实', content: { title: '轻薄外套' }, productId: 'product-a', approvalStatus: 'approved', rightsStatus: 'cleared' })
    const binding = await repository.bindAsset({ workspaceId: 'ws-a', knowledgeAssetId: asset.id, productId: 'product-a', skuId: 'sku-blue-m', sourceVersion: 3 })
    expect(binding.bindingType).toBe('spreadsheet_facts')
    const document = await repository.createDocument({ workspaceId: 'ws-a', knowledgeAssetId: asset.id, productId: 'product-a', skuId: 'sku-blue-m', knowledgeType: 'product_facts', contentHash: 'hash-a', extractedText: '锦纶 88%，蓝色 M', approvalStatus: 'approved', rightsStatus: 'cleared' })
    const [chunk] = await repository.replaceChunks('ws-a', document.id, [{ ordinal: 0, content: '锦纶 88%，蓝色 M' }])
    await repository.upsertEmbedding('ws-a', { documentId: document.id, chunkId: chunk!.id, embedding: [1, 0], embeddingModel: 'test', embeddingVersion: '1', indexState: 'ready' })
    await repository.transitionIndexState('ws-a', document.id, 'ready')
    expect((await repository.search({ workspaceId: 'ws-a', query: '蓝色', productId: 'product-a' }))[0]?.document.skuId).toBe('sku-blue-m')
    expect(await repository.search({ workspaceId: 'ws-b', query: '蓝色' })).toEqual([])
    expect(await repository.rebuildIndex('ws-a', document.id)).toBe(1)
    expect((await repository.listDocuments('ws-a', { indexState: 'queued' })).map(item => item.id)).toEqual([document.id])
    const proof = await repository.deleteDocument('ws-a', document.id, 'merchant requested deletion')
    expect(proof).toMatchObject({ documentId: document.id, chunksDeleted: 1, embeddingsDeleted: 1 })
    expect(await repository.search({ workspaceId: 'ws-a', query: '蓝色' })).toEqual([])
  })

  it('fails closed for a missing workspace scope and never indexes pending rights', async () => {
    const repository = new MemoryKnowledgeRepository()
    await expect(repository.listDocuments('')).rejects.toThrow('workspace scope is required')
    const document = await repository.createDocument({ workspaceId: 'ws-a', knowledgeType: 'material', contentHash: 'hash-b', extractedText: '仅待审批内容', approvalStatus: 'pending', rightsStatus: 'unknown', indexState: 'ready' })
    expect(await repository.search({ workspaceId: 'ws-a', query: '待审批' })).toEqual([])
    expect((await repository.listDocuments('ws-a'))[0]).toMatchObject({ id: document.id, indexState: 'ready' })
  })
})
