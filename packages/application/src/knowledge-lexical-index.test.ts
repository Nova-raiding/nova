import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { MemoryKnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'
import { projectImportedProductsToKnowledge } from './knowledge-import.js'
import { indexApprovedKnowledge } from './knowledge-lexical-index.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

describe('reviewed knowledge lexical index', () => {
  it('persists relay embeddings with revision/hash fencing before marking ready', async () => {
    const repository = new MemoryKnowledgeRepository()
    const text = '向量知识内容'
    const asset = await repository.createAsset({ id: 'asset-vector', workspaceId: 'ws-vector', kind: 'brand', name: '品牌', content: {}, approvalStatus: 'approved', rightsStatus: 'cleared' })
    const document = await repository.createDocument({ id: 'doc-vector', workspaceId: 'ws-vector', knowledgeAssetId: asset.id, sourceVersion: 1, knowledgeType: 'brand', contentHash: sha(text), extractedText: text, approvalStatus: 'approved', rightsStatus: 'cleared' })
    await repository.replaceChunks('ws-vector', document.id, [{ id: 'chunk-vector', ordinal: 0, content: text }])
    await repository.updateAsset('ws-vector', asset.id, { approvalStatus: 'approved', rightsStatus: 'cleared' })
    const embed = async () => ({ embeddings: [[0.1, 0.2]], dimensions: 2 })
    expect(await indexApprovedKnowledge({ repository, workspaceId: 'ws-vector', embedding: { model: 'embed-v1', version: '2026-09', embed } })).toEqual({ ready: 1, blocked: 0, failed: 0 })
    expect((await repository.search({ workspaceId: 'ws-vector', queryEmbedding: [0.1, 0.2] }))[0]).toMatchObject({ document: { id: 'doc-vector' }, score: 1 })
  })

  it('admits before dispatch and never writes vectors when settlement is unknown', async () => {
    const repository = new MemoryKnowledgeRepository()
    const text = '需要计费的向量内容'
    const asset = await repository.createAsset({ id: 'asset-billed', workspaceId: 'ws-billed', kind: 'brand', name: '品牌', content: {}, approvalStatus: 'approved', rightsStatus: 'cleared' })
    const document = await repository.createDocument({ id: 'doc-billed', workspaceId: 'ws-billed', knowledgeAssetId: asset.id, sourceVersion: 1, knowledgeType: 'brand', contentHash: sha(text), extractedText: text, approvalStatus: 'approved', rightsStatus: 'cleared' })
    await repository.replaceChunks('ws-billed', document.id, [{ id: 'chunk-billed', ordinal: 0, content: text }])
    await repository.updateAsset('ws-billed', asset.id, { approvalStatus: 'approved', rightsStatus: 'cleared' })
    const events: string[] = []
    const unknown = Object.assign(new Error('settlement pending'), { code: 'MODEL_USAGE_SETTLEMENT_PENDING', providerSucceeded: true })
    expect(await indexApprovedKnowledge({ repository, workspaceId: 'ws-billed', embedding: {
      model: 'embed-v1', version: '2026-09',
      admit: async binding => { events.push(`admit:${binding.runKey}`) },
      embed: async () => { events.push('provider'); throw unknown },
      reportOutcome: async outcome => { events.push(`outcome:${outcome.outcome}`) },
    } })).toEqual({ ready: 0, blocked: 0, failed: 1 })
    expect(events[0]).toMatch(/^admit:knowledge-index:doc-billed:\d+$/u)
    expect(events.slice(1)).toEqual(['provider', 'outcome:unknown'])
    expect((await repository.listDocuments('ws-billed'))[0]).toMatchObject({ indexState: 'queued' })
    expect(await repository.search({ workspaceId: 'ws-billed', queryEmbedding: [0.1, 0.2] })).toEqual([])
  })

  it('holds pending import, then indexes hash-verified product and SKU after approval and rights clearance', async () => {
    const repository = new MemoryKnowledgeRepository()
    const projected = await projectImportedProductsToKnowledge({ repository, workspaceId: 'ws_a', products: [{ id: 'p_a', workspaceId: 'ws_a', title: '羽绒服', platform: 'taobao', skus: [{ id: 'sku_a', name: '蓝色', price: 100, stock: 2 }] }] })
    expect(await indexApprovedKnowledge({ repository, workspaceId: 'ws_a' })).toEqual({ ready: 0, blocked: 2, failed: 0 })
    expect(await repository.search({ workspaceId: 'ws_a', query: '羽绒服' })).toEqual([])
    await repository.updateAsset('ws_a', projected.assets[0]!.id, { approvalStatus: 'approved', rightsStatus: 'cleared' })
    expect(await indexApprovedKnowledge({ repository, workspaceId: 'ws_a' })).toEqual({ ready: 2, blocked: 0, failed: 0 })
    expect((await repository.search({ workspaceId: 'ws_a', query: '羽绒服' })).map(item => item.document.id)).toHaveLength(2)
    expect(await repository.listChunks('ws_b', projected.documents[0]!.id)).toEqual([])
  })

  it('fails closed when document or chunk content no longer matches the stored hash', async () => {
    const repository = new MemoryKnowledgeRepository()
    const asset = await repository.createAsset({ workspaceId: 'ws_a', kind: 'product_facts', name: '事实', content: {}, approvalStatus: 'approved', rightsStatus: 'cleared' })
    const document = await repository.createDocument({ workspaceId: 'ws_a', knowledgeAssetId: asset.id, knowledgeType: 'product_facts', contentHash: sha('真实内容'), extractedText: '真实内容', approvalStatus: 'approved', rightsStatus: 'cleared' })
    await repository.replaceChunks('ws_a', document.id, [{ ordinal: 0, content: '已被篡改', contentHash: sha('真实内容') }])
    await repository.updateAsset('ws_a', asset.id, { approvalStatus: 'approved', rightsStatus: 'cleared' })
    expect(await indexApprovedKnowledge({ repository, workspaceId: 'ws_a' })).toEqual({ ready: 0, blocked: 0, failed: 1 })
    expect((await repository.listDocuments('ws_a'))[0]).toMatchObject({ indexState: 'failed', indexError: 'KNOWLEDGE_CONTENT_HASH_MISMATCH' })
  })

  it('does not mark ready when rights are revoked at the final state transition', async () => {
    class RevokingRepository extends MemoryKnowledgeRepository {
      override async transitionQueuedIndexState(workspaceId: string, documentId: string, state: 'ready' | 'failed', expected: { revision: number; contentHash: string }, reason = '') {
        if (state === 'ready') await this.updateAsset(workspaceId, 'asset_a', { rightsStatus: 'restricted' })
        return super.transitionQueuedIndexState(workspaceId, documentId, state, expected, reason)
      }
    }
    const repository = new RevokingRepository()
    await repository.createAsset({ id: 'asset_a', workspaceId: 'ws_a', kind: 'product_facts', name: '事实', content: {}, approvalStatus: 'approved', rightsStatus: 'cleared' })
    const document = await repository.createDocument({ id: 'doc_a', workspaceId: 'ws_a', knowledgeAssetId: 'asset_a', knowledgeType: 'product_facts', contentHash: sha('真实内容'), extractedText: '真实内容', approvalStatus: 'approved', rightsStatus: 'cleared' })
    await repository.replaceChunks('ws_a', document.id, [{ ordinal: 0, content: '真实内容', contentHash: sha('真实内容') }])
    await repository.updateAsset('ws_a', 'asset_a', { approvalStatus: 'approved', rightsStatus: 'cleared' })
    expect(await indexApprovedKnowledge({ repository, workspaceId: 'ws_a' })).toEqual({ ready: 0, blocked: 1, failed: 0 })
    expect((await repository.listDocuments('ws_a'))[0]).toMatchObject({ indexState: 'queued', rightsStatus: 'restricted' })
  })
})
