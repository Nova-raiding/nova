import { describe, expect, it } from 'vitest'
import { MemoryKnowledgeRepository, PostgresKnowledgeRepository } from './knowledge.js'
import type { SqlClient, SqlPool } from './repository.js'

class RecordingKnowledgePool implements SqlPool {
  readonly statements: string[] = []
  readonly parameters: unknown[][] = []
  constructor(private readonly documentRow: Record<string, unknown>, private readonly embeddingRow: Record<string, unknown>) {}
  async connect(): Promise<SqlClient> {
    return {
      query: async <Row>(text: string, values: unknown[] = []) => {
        this.statements.push(text)
        this.parameters.push(values)
        if (text.includes('FROM knowledge_documents')) return { rows: [this.documentRow] as Row[] }
        if (text.includes('FROM knowledge_chunks')) return {
          rows: [{
            id: 'chunk-semantic',
            workspace_id: 'ws-a',
            document_id: 'doc-semantic',
            ordinal: 0,
            content: '锦纶 88%',
            content_hash: 'chunk-hash',
            token_count: 2,
            metadata: {},
            created_at: '2026-09-10T00:00:00.000Z',
          }] as Row[],
        }
        if (text.includes('FROM knowledge_embeddings')) return { rows: [this.embeddingRow] as Row[] }
        return { rows: [] as Row[] }
      },
      release: () => {},
    }
  }
}

const semanticDocumentRow = {
  id: 'doc-semantic',
  workspace_id: 'ws-a',
  knowledge_asset_id: null,
  source_asset_id: null,
  source_version: 1,
  brand_id: null,
  product_id: 'product-a',
  sku_id: 'sku-blue-m',
  knowledge_type: 'product_facts',
  title: '商品事实',
  content_type: 'text/plain',
  content_hash: 'doc-hash',
  extracted_text: '锦纶 88%',
  source_metadata: {},
  approval_status: 'approved',
  rights_status: 'cleared',
  rule_snapshot_version: null,
  embedding_model: 'test',
  embedding_version: '1',
  index_state: 'ready',
  index_error: null,
  expires_at: null,
  revision: 1,
  created_at: '2026-09-10T00:00:00.000Z',
  updated_at: '2026-09-10T00:00:00.000Z',
}

const semanticEmbeddingRow = {
  id: 'embedding-semantic',
  workspace_id: 'ws-a',
  document_id: 'doc-semantic',
  chunk_id: 'chunk-semantic',
  embedding: [0, 1],
  embedding_model: 'test',
  embedding_version: '1',
  vector_metadata: {},
  index_state: 'ready',
  created_at: '2026-09-10T00:00:00.000Z',
  updated_at: '2026-09-10T00:00:00.000Z',
}

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

  it('cascades asset approval and rights updates to linked documents', async () => {
    const repository = new MemoryKnowledgeRepository()
    const asset = await repository.createAsset({
      workspaceId: 'ws-c',
      kind: 'product_facts',
      name: '商品事实',
      content: { title: '轻云外套' },
    })
    const document = await repository.createDocument({
      workspaceId: 'ws-c',
      knowledgeAssetId: asset.id,
      productId: 'product-c',
      knowledgeType: 'product_facts',
      contentHash: 'hash-c',
      extractedText: '轻云外套 蓝色 M',
    })
    await expect(repository.updateAsset('ws-other', asset.id, { approvalStatus: 'approved' })).rejects.toThrow('KNOWLEDGE_ASSET_NOT_FOUND')
    const updated = await repository.updateAsset('ws-c', asset.id, { approvalStatus: 'approved', rightsStatus: 'cleared' })
    expect(updated).toMatchObject({ approvalStatus: 'approved', rightsStatus: 'cleared', revision: asset.revision + 1 })
    expect((await repository.listDocuments('ws-c'))[0]).toMatchObject({
      id: document.id,
      approvalStatus: 'approved',
      rightsStatus: 'cleared',
    })
  })

  it('does not discard semantic Postgres matches with an exact-text prefilter', async () => {
    const pool = new RecordingKnowledgePool(semanticDocumentRow, semanticEmbeddingRow)
    const repository = new PostgresKnowledgeRepository(pool)
    const results = await repository.search({
      workspaceId: 'ws-a',
      query: '轻薄防风外套',
      queryEmbedding: [0, 1],
      productId: 'product-a',
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      document: { id: 'doc-semantic', skuId: 'sku-blue-m' },
      score: 1,
    })
    const documentQuery = pool.statements.find(statement => statement.includes('FROM knowledge_documents'))
    expect(documentQuery).toBeDefined()
    expect(documentQuery).not.toContain('ILIKE')
  })

  it('applies workspace, store and SKU scope before returning durable knowledge', async () => {
    const pool = new RecordingKnowledgePool(semanticDocumentRow, semanticEmbeddingRow)
    const repository = new PostgresKnowledgeRepository(pool)
    await repository.search({
      workspaceId: 'ws-a',
      platform: 'taobao',
      accountId: 'account-north',
      storeName: '北区旗舰店',
      productId: 'product-a',
      skuId: 'sku-blue-m',
      query: '锦纶',
    })

    const documentQuery = pool.statements.find(statement => statement.includes('FROM knowledge_documents'))
    expect(documentQuery).toContain(`d.index_state='ready'`)
    expect(documentQuery).toContain(`d.approval_status='approved'`)
    expect(documentQuery).toContain(`d.rights_status='cleared'`)
    expect(documentQuery).toContain('p.platform=')
    expect(documentQuery).toContain('p.platform_account_id=')
    expect(documentQuery).toContain('lower(p.store_name)=lower(')
    expect(pool.parameters.find(values => values.includes('account-north'))).toBeDefined()
    expect(pool.parameters.find(values => values.includes('sku-blue-m'))).toBeDefined()
  })
})
