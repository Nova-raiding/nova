import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
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

type PgRow = Record<string, any>

const compareValues = (left: unknown, right: unknown): number => typeof left === 'number' && typeof right === 'number'
  ? left - right
  : String(left).localeCompare(String(right))

/** Serves both the per-document child reads and the batched `= ANY($n)` form,
 * so the same fixture can pin the combined result as well as the round-trip
 * count of whichever implementation is under test. */
function childRows(rows: readonly PgRow[], values: readonly unknown[], order: readonly string[], readyOnly = false): PgRow[] {
  const selector = values[1]
  const documentIds = Array.isArray(selector) ? selector.map(String) : [String(selector)]
  return rows
    .filter(row => documentIds.includes(String(row.document_id)) && (!readyOnly || row.index_state === 'ready'))
    .map(row => ({ ...row }))
    .sort((left, right) => order.reduce((result, key) => result || compareValues(left[key], right[key]), 0))
}

class BatchedKnowledgePool implements SqlPool {
  readonly statements: string[] = []
  readonly parameters: unknown[][] = []
  constructor(
    private readonly documents: readonly PgRow[],
    private readonly chunks: readonly PgRow[],
    private readonly embeddings: readonly PgRow[],
  ) {}
  /** Honours the `AND id=$n` point lookup, both product predicates and either
   * bound (`LIMIT $n`, or the batch form's per-product `knowledge_product_rank`)
   * so a bounded read is observable, not just a SQL string. */
  private selectDocuments(text: string, values: readonly unknown[]): PgRow[] {
    let rows = [...this.documents]
    const idMatch = / AND id=\$(\d+)/u.exec(text)
    if (idMatch) {
      const id = values[Number(idMatch[1]) - 1]
      rows = rows.filter(row => row.id === id)
    }
    const productMatch = / AND (?:d\.)?product_id=\$(\d+)/u.exec(text)
    if (productMatch) {
      const productId = values[Number(productMatch[1]) - 1]
      rows = rows.filter(row => row.product_id === productId)
    }
    const productSetMatch = /product_id = ANY\(\$(\d+)::text\[\]\)/u.exec(text)
    if (productSetMatch) {
      const productIds = values[Number(productSetMatch[1]) - 1] as readonly string[]
      rows = rows.filter(row => productIds.includes(String(row.product_id)))
    }
    const rankMatch = /knowledge_product_rank <= \$(\d+)/u.exec(text)
    if (rankMatch) {
      const cap = Number(values[Number(rankMatch[1]) - 1])
      const perProduct = new Map<string, PgRow[]>()
      for (const row of rows) {
        const key = String(row.product_id)
        const bucket = perProduct.get(key)
        if (bucket) bucket.push(row)
        else perProduct.set(key, [row])
      }
      return [...perProduct.values()].flatMap(bucket => bucket.slice(0, cap))
    }
    const limitMatch = / LIMIT \$(\d+)$/u.exec(text)
    if (limitMatch) rows = rows.slice(0, Number(values[Number(limitMatch[1]) - 1]))
    return rows
  }
  async connect(): Promise<SqlClient> {
    return {
      query: async <Row>(text: string, values: readonly unknown[] = []) => {
        this.statements.push(text)
        this.parameters.push([...values])
        if (text.includes('FROM knowledge_documents')) return { rows: this.selectDocuments(text, values) as Row[] }
        if (text.includes('FROM knowledge_chunks')) return { rows: childRows(this.chunks, values, ['document_id', 'ordinal']) as Row[] }
        if (text.includes('FROM knowledge_embeddings')) return { rows: childRows(this.embeddings, values, [], true) as Row[] }
        return { rows: [] as Row[] }
      },
      release: () => {},
    }
  }
}

const childQueries = (pool: BatchedKnowledgePool): { documents: number; chunks: number; embeddings: number } => ({
  documents: pool.statements.filter(statement => statement.includes('FROM knowledge_documents')).length,
  chunks: pool.statements.filter(statement => statement.includes('FROM knowledge_chunks')).length,
  embeddings: pool.statements.filter(statement => statement.includes('FROM knowledge_embeddings')).length,
})

/** The transaction wrapper appends BEGIN/COMMIT, so locate the page query by text. */
const lastDocumentCall = (pool: BatchedKnowledgePool): { statement: string; parameters: unknown[] } => {
  const position = pool.statements.reduce((result, statement, index) => statement.includes('FROM knowledge_documents') ? index : result, -1)
  return { statement: pool.statements[position]!, parameters: pool.parameters[position]! }
}

/** The exact statements this repository issued before the batch forms existed.
 * Every call shape that omits `productIds` must still produce these
 * byte-for-byte, so adding a batch read can never quietly rewrite the
 * single-value statement a deployed caller already depends on. */
const DOCUMENT_PROJECTION_GOLDEN = 'id, workspace_id, knowledge_asset_id, source_asset_id, source_version, brand_id, product_id, sku_id, knowledge_type, title, content_type, content_hash, extracted_text, source_metadata, approval_status, rights_status, rule_snapshot_version, embedding_model, embedding_version, index_state, index_error, expires_at, revision, created_at, updated_at'
const SCOPED_PROJECTION_GOLDEN = 'd.id,d.workspace_id,d.knowledge_asset_id,d.source_asset_id,d.source_version,d.brand_id,d.product_id,d.sku_id,d.knowledge_type,d.title,d.content_type,d.content_hash,d.extracted_text,d.source_metadata,d.approval_status,d.rights_status,d.rule_snapshot_version,d.embedding_model,d.embedding_version,d.index_state,d.index_error,d.expires_at,d.revision,d.created_at,d.updated_at'
const listDocumentsGolden = (suffix: string): string => `SELECT ${DOCUMENT_PROJECTION_GOLDEN} FROM knowledge_documents ${suffix}`
const searchGolden = (suffix: string): string => `SELECT ${SCOPED_PROJECTION_GOLDEN} FROM knowledge_documents d ${suffix}`

/** Serves the single rebuild statement: the update's `RETURNING` set feeds the
 * audit insert, so the rows it hands back are the audit rows the caller wrote. */
class RebuildKnowledgePool implements SqlPool {
  readonly statements: string[] = []
  readonly parameters: unknown[][] = []
  constructor(private readonly rebuilt: readonly string[]) {}
  async connect(): Promise<SqlClient> {
    return {
      query: async <Row>(text: string, values: readonly unknown[] = []) => {
        this.statements.push(text)
        this.parameters.push([...values])
        if (text.includes('UPDATE knowledge_documents')) return { rows: this.rebuilt.map(id => ({ id, document_id: id })) as Row[] }
        return { rows: [] as Row[] }
      },
      release: () => {},
    }
  }
}

const pgDocument = (id: string, overrides: PgRow = {}): PgRow => ({
  id, workspace_id: 'ws-a', knowledge_asset_id: null, source_asset_id: null, source_version: 1, brand_id: null,
  product_id: 'product-a', sku_id: null, knowledge_type: 'product_facts', title: id, content_type: 'text/plain',
  content_hash: `hash-${id}`, extracted_text: '', source_metadata: {}, approval_status: 'approved',
  rights_status: 'cleared', rule_snapshot_version: null, embedding_model: 'test', embedding_version: '1',
  index_state: 'ready', index_error: null, expires_at: null, revision: 1,
  created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z', ...overrides,
})

const pgChunk = (id: string, documentId: string, ordinal: number, content: string): PgRow => ({
  id, workspace_id: 'ws-a', document_id: documentId, ordinal, content, content_hash: `chunk-hash-${id}`,
  token_count: 2, metadata: {}, created_at: '2026-09-10T00:00:00.000Z',
})

const pgEmbedding = (id: string, documentId: string, chunkId: string, embedding: readonly number[], indexState = 'ready'): PgRow => ({
  id, workspace_id: 'ws-a', document_id: documentId, chunk_id: chunkId, embedding, embedding_model: 'test',
  embedding_version: '1', vector_metadata: {}, index_state: indexState,
  created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z',
})

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
  it('discards vectors for superseded content before later approval', async () => {
    const repository = new MemoryKnowledgeRepository()
    const asset = await repository.createAsset({ workspaceId: 'ws-a', kind: 'material', name: '旧材料', content: 'old' })
    const document = await repository.createDocument({ id: 'doc-vector', workspaceId: 'ws-a', knowledgeAssetId: asset.id, knowledgeType: 'material', contentHash: 'old', extractedText: 'old', approvalStatus: 'approved', rightsStatus: 'cleared' })
    const [chunk] = await repository.replaceChunks('ws-a', document.id, [{ ordinal: 0, content: 'old' }])
    await repository.updateAsset('ws-a', asset.id, { approvalStatus: 'approved', rightsStatus: 'cleared' })
    const approved = (await repository.listDocuments('ws-a')).find(item => item.id === document.id)!
    const vectorInput = { documentId: document.id, chunkId: chunk!.id, expectedDocumentRevision: approved.revision, expectedDocumentContentHash: approved.contentHash, expectedChunkContentHash: chunk!.contentHash, embedding: [1, 0], embeddingModel: 'model', embeddingVersion: '1', indexState: 'ready' as const }
    const stored = await repository.upsertEmbedding('ws-a', vectorInput)
    expect(stored).not.toHaveProperty('expectedDocumentRevision')
    expect(stored).not.toHaveProperty('expectedDocumentContentHash')
    expect(stored).not.toHaveProperty('expectedChunkContentHash')
    await expect(repository.upsertEmbedding('ws-a', { ...vectorInput, expectedChunkContentHash: 'wrong' })).rejects.toThrow('KNOWLEDGE_EMBEDDING_STALE')
    await repository.updateAsset('ws-a', asset.id, { rightsStatus: 'restricted' })
    await expect(repository.upsertEmbedding('ws-a', vectorInput)).rejects.toThrow('KNOWLEDGE_EMBEDDING_STALE')
    await repository.updateAsset('ws-a', asset.id, { rightsStatus: 'cleared' })
    await expect(repository.upsertEmbedding('ws-a', vectorInput)).rejects.toThrow('KNOWLEDGE_EMBEDDING_STALE')
    await repository.createDocument({ id: document.id, workspaceId: 'ws-a', knowledgeType: 'material', contentHash: 'new', extractedText: 'new' })
    await repository.updateAsset('ws-a', asset.id, { approvalStatus: 'approved', rightsStatus: 'cleared' })
    await expect(repository.upsertEmbedding('ws-a', vectorInput)).rejects.toThrow('KNOWLEDGE_EMBEDDING_STALE')
    const proof = await repository.deleteDocument('ws-a', document.id)
    expect(proof.embeddingsDeleted).toBe(0)
  })
  it('binds an Excel-derived asset, indexes chunks, filters unapproved content, rebuilds and records deletion', async () => {
    const repository = new MemoryKnowledgeRepository()
    const asset = await repository.createAsset({ workspaceId: 'ws-a', kind: 'product_facts', name: 'Excel 商品事实', content: { title: '轻薄外套' }, productId: 'product-a', approvalStatus: 'approved', rightsStatus: 'cleared' })
    const binding = await repository.bindAsset({ workspaceId: 'ws-a', knowledgeAssetId: asset.id, productId: 'product-a', skuId: 'sku-blue-m', sourceVersion: 3 })
    expect(binding.bindingType).toBe('spreadsheet_facts')
    const document = await repository.createDocument({ workspaceId: 'ws-a', knowledgeAssetId: asset.id, productId: 'product-a', skuId: 'sku-blue-m', knowledgeType: 'product_facts', contentHash: 'hash-a', extractedText: '锦纶 88%，蓝色 M', approvalStatus: 'approved', rightsStatus: 'cleared' })
    const [chunk] = await repository.replaceChunks('ws-a', document.id, [{ ordinal: 0, content: '锦纶 88%，蓝色 M' }])
    await repository.updateAsset('ws-a', asset.id, { approvalStatus: 'approved', rightsStatus: 'cleared' })
    const approved = (await repository.listDocuments('ws-a')).find(item => item.id === document.id)!
    await repository.upsertEmbedding('ws-a', { documentId: document.id, chunkId: chunk!.id, expectedDocumentRevision: approved.revision, expectedDocumentContentHash: approved.contentHash, expectedChunkContentHash: chunk!.contentHash, embedding: [1, 0], embeddingModel: 'test', embeddingVersion: '1', indexState: 'ready' })
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

  it('reads the candidate documents, chunks and vectors in three fixed queries instead of one child query per document', async () => {
    const chunks = [
      pgChunk('chunk-1a', 'doc-1', 0, '锦纶 88%'),
      pgChunk('chunk-2b', 'doc-2', 0, '其他'),
      pgChunk('chunk-2a', 'doc-2', 1, '锦纶 面料'),
    ]
    const embeddings = [
      pgEmbedding('embedding-1a', 'doc-1', 'chunk-1a', [1, 0]),
      pgEmbedding('embedding-2a', 'doc-2', 'chunk-2a', [0, 1]),
      pgEmbedding('embedding-2b', 'doc-2', 'chunk-2b', [0.5, 0.5]),
      pgEmbedding('embedding-3a', 'doc-3', 'chunk-3a', [0, 1], 'stale'),
    ]
    // The candidate set grows with the workspace, the round trips must not.
    const single = new BatchedKnowledgePool([pgDocument('doc-1', { extracted_text: '锦纶 88%' })], chunks, embeddings)
    await new PostgresKnowledgeRepository(single).search({ workspaceId: 'ws-a', query: '锦纶', queryEmbedding: [0, 1] })
    expect(childQueries(single)).toEqual({ documents: 1, chunks: 1, embeddings: 1 })

    const many = new BatchedKnowledgePool(
      [pgDocument('doc-1', { extracted_text: '锦纶 88%' }), pgDocument('doc-2'), pgDocument('doc-3', { extracted_text: '无关内容' })],
      chunks,
      embeddings,
    )
    expect(await new PostgresKnowledgeRepository(many).search({ workspaceId: 'ws-a', query: '锦纶', queryEmbedding: [0, 1] })).toHaveLength(3)
    expect(childQueries(many)).toEqual({ documents: 1, chunks: 1, embeddings: 1 })

    // No candidate documents: never issue an empty `= ANY('{}')` child read.
    const none = new BatchedKnowledgePool([], chunks, embeddings)
    expect(await new PostgresKnowledgeRepository(none).search({ workspaceId: 'ws-a', queryEmbedding: [0, 1] })).toEqual([])
    expect(childQueries(none)).toEqual({ documents: 1, chunks: 0, embeddings: 0 })
  })

  it('keeps every candidate on its own chunk and vector rows when the child reads are batched', async () => {
    const pool = new BatchedKnowledgePool(
      [pgDocument('doc-1', { extracted_text: '锦纶 88%' }), pgDocument('doc-2'), pgDocument('doc-3', { extracted_text: '无关内容' })],
      [pgChunk('chunk-1a', 'doc-1', 0, '锦纶 88%'), pgChunk('chunk-2b', 'doc-2', 0, '其他'), pgChunk('chunk-2a', 'doc-2', 1, '锦纶 面料')],
      [
        pgEmbedding('embedding-1a', 'doc-1', 'chunk-1a', [1, 0]),
        pgEmbedding('embedding-2a', 'doc-2', 'chunk-2a', [0, 1]),
        pgEmbedding('embedding-2b', 'doc-2', 'chunk-2b', [0.5, 0.5]),
        pgEmbedding('embedding-3a', 'doc-3', 'chunk-3a', [0, 1], 'stale'),
      ],
    )
    const results = await new PostgresKnowledgeRepository(pool).search({ workspaceId: 'ws-a', query: '锦纶', queryEmbedding: [0, 1] })

    expect(results.map(item => ({ id: item.document.id, chunks: item.chunks.map(chunk => chunk.id), score: item.score }))).toEqual([
      { id: 'doc-1', chunks: ['chunk-1a'], score: 1 },
      // chunks stay ordered by ordinal, not by the batch row order
      { id: 'doc-2', chunks: ['chunk-2b', 'chunk-2a'], score: 1 },
      // no chunks and only a stale vector: still returned with a zero score
      { id: 'doc-3', chunks: [], score: 0 },
    ])
    expect(results.every(item => item.chunks.every(chunk => chunk.documentId === item.document.id && chunk.workspaceId === 'ws-a'))).toBe(true)
    expect(results[2]!.document.extractedText).toBe('无关内容')

    const chunkQuery = pool.statements.find(statement => statement.includes('FROM knowledge_chunks'))!
    const embeddingQuery = pool.statements.find(statement => statement.includes('FROM knowledge_embeddings'))!
    expect(chunkQuery).toContain('document_id = ANY(')
    expect(chunkQuery).toContain('ORDER BY document_id, ordinal')
    expect(chunkQuery).toContain('workspace_id=$1')
    expect(embeddingQuery).toContain('document_id = ANY(')
    expect(embeddingQuery).toContain("index_state='ready'")
    expect(embeddingQuery).toContain('workspace_id=$1')
  })

  it('bounds listDocuments on request and reads a single document by id without changing the unbounded default', async () => {
    const pool = new BatchedKnowledgePool([pgDocument('doc-a'), pgDocument('doc-b'), pgDocument('doc-c')], [], [])
    const repository = new PostgresKnowledgeRepository(pool)

    expect((await repository.listDocuments('ws-a')).map(item => item.id)).toEqual(['doc-a', 'doc-b', 'doc-c'])
    expect(lastDocumentCall(pool)).toEqual({
      statement: expect.stringContaining('ORDER BY updated_at DESC,id'),
      parameters: ['ws-a'],
    })
    expect(lastDocumentCall(pool).statement).not.toContain('LIMIT')

    expect((await repository.listDocuments('ws-a', { limit: 2 })).map(item => item.id)).toEqual(['doc-a', 'doc-b'])
    expect(lastDocumentCall(pool).statement).toContain('ORDER BY updated_at DESC,id LIMIT $2')
    expect(lastDocumentCall(pool).parameters).toEqual(['ws-a', 2])

    expect((await repository.listDocuments('ws-a', { id: 'doc-b' })).map(item => item.id)).toEqual(['doc-b'])
    expect(lastDocumentCall(pool).statement).toContain('AND id=$2 ORDER BY updated_at DESC,id LIMIT $3')
    expect(lastDocumentCall(pool).parameters).toEqual(['ws-a', 'doc-b', 1])

    expect((await repository.listDocuments('ws-a', { id: 'doc-missing' }))).toEqual([])
    await expect(repository.listDocuments('ws-a', { limit: 0 })).rejects.toThrow('KNOWLEDGE_LIST_LIMIT_INVALID')

    const memory = new MemoryKnowledgeRepository()
    for (const id of ['doc-a', 'doc-b', 'doc-c']) await memory.createDocument({ id, workspaceId: 'ws-a', knowledgeType: 'product_facts', contentHash: `hash-${id}`, extractedText: id })
    expect((await memory.listDocuments('ws-a', { limit: 2 })).map(item => item.id)).toEqual(['doc-a', 'doc-b'])
    expect((await memory.listDocuments('ws-a', { id: 'doc-c' })).map(item => item.id)).toEqual(['doc-c'])
    expect((await memory.listDocuments('ws-a')).map(item => item.id)).toEqual(['doc-a', 'doc-b', 'doc-c'])
    await expect(memory.listDocuments('ws-a', { limit: 0 })).rejects.toThrow('KNOWLEDGE_LIST_LIMIT_INVALID')
  })

  it('records a whole-workspace rebuild with one audit insert instead of one insert per document', async () => {
    const pool = new RebuildKnowledgePool(['doc-1', 'doc-2', 'doc-3'])
    const repository = new PostgresKnowledgeRepository(pool)

    expect(await repository.rebuildIndex('ws-a')).toBe(3)

    // One statement for the transition and one for the audit trail, whatever the
    // size of the rebuilt set: the audit rows come from the update's own
    // `RETURNING` set through a data-modifying CTE.
    expect(pool.statements.filter(statement => statement.includes('UPDATE knowledge_documents'))).toHaveLength(1)
    const auditStatements = pool.statements.filter(statement => statement.includes('INSERT INTO knowledge_index_events'))
    expect(auditStatements).toHaveLength(1)
    expect(auditStatements[0]).toContain('WITH rebuilt AS (UPDATE knowledge_documents')
    expect(auditStatements[0]).toContain('FROM rebuilt RETURNING document_id')
    // The row set and the scope predicate cannot drift from the update, and the
    // reason is bound once for the batch rather than once per document.
    expect(auditStatements[0]).toContain("WHERE workspace_id=$1 AND index_state <> 'deleted' AND ($2::text IS NULL OR id=$2)")
    expect(auditStatements[0]).toContain("'knowledge_index_event_'||pg_catalog.gen_random_uuid()::text,$1,rebuilt.id,'rebuild','stale','queued',$3")
    expect(pool.parameters[pool.statements.indexOf(auditStatements[0]!)]).toEqual(['ws-a', null, 'rebuild requested'])
    expect(pool.statements.filter(statement => statement.includes('knowledge_index_events'))).toHaveLength(1)

    const scopedPool = new RebuildKnowledgePool(['doc-9'])
    expect(await new PostgresKnowledgeRepository(scopedPool).rebuildIndex('ws-a', 'doc-9', 'operator asked')).toBe(1)
    expect(scopedPool.parameters[scopedPool.statements.findIndex(statement => statement.includes('INSERT INTO knowledge_index_events'))]).toEqual(['ws-a', 'doc-9', 'operator asked'])
  })

  it('reads a product page with the productIds batch form without changing any single-value statement', async () => {
    const pool = new BatchedKnowledgePool([
      pgDocument('doc-a', { product_id: 'product-a' }),
      pgDocument('doc-b', { product_id: 'product-b' }),
      pgDocument('doc-c', { product_id: 'product-c' }),
    ], [], [])
    const repository = new PostgresKnowledgeRepository(pool)

    expect((await repository.listDocuments('ws-a', { productIds: ['product-c', 'product-a'] })).map(item => item.id)).toEqual(['doc-a', 'doc-c'])
    expect(lastDocumentCall(pool)).toEqual({ statement: listDocumentsGolden('WHERE workspace_id=$1 AND product_id = ANY($2::text[]) ORDER BY updated_at DESC,id'), parameters: ['ws-a', ['product-c', 'product-a']] })

    // The batch form is a scope, not an escape hatch: an empty set stays empty
    // and the single value is ANDed with it instead of being widened.
    expect(await repository.listDocuments('ws-a', { productIds: [] })).toEqual([])
    expect(await repository.listDocuments('ws-a', { productId: 'product-b', productIds: ['product-c'] })).toEqual([])

    // Every statement that does not use the new parameter is byte-identical to
    // the one this repository issued before the batch form existed.
    expect((await repository.listDocuments('ws-a')).map(item => item.id)).toEqual(['doc-a', 'doc-b', 'doc-c'])
    expect(lastDocumentCall(pool)).toEqual({ statement: listDocumentsGolden('WHERE workspace_id=$1 ORDER BY updated_at DESC,id'), parameters: ['ws-a'] })
    expect(lastDocumentCall(pool).statement).not.toContain('ANY(')
    expect((await repository.listDocuments('ws-a', { limit: 2 })).map(item => item.id)).toEqual(['doc-a', 'doc-b'])
    expect(lastDocumentCall(pool)).toEqual({ statement: listDocumentsGolden('WHERE workspace_id=$1 ORDER BY updated_at DESC,id LIMIT $2'), parameters: ['ws-a', 2] })
    expect((await repository.listDocuments('ws-a', { id: 'doc-b' })).map(item => item.id)).toEqual(['doc-b'])
    expect(lastDocumentCall(pool)).toEqual({ statement: listDocumentsGolden('WHERE workspace_id=$1 AND id=$2 ORDER BY updated_at DESC,id LIMIT $3'), parameters: ['ws-a', 'doc-b', 1] })
    expect((await repository.listDocuments('ws-a', { productId: 'product-a' })).map(item => item.id)).toEqual(['doc-a'])
    expect(lastDocumentCall(pool)).toEqual({ statement: listDocumentsGolden('WHERE workspace_id=$1 AND product_id=$2 ORDER BY updated_at DESC,id'), parameters: ['ws-a', 'product-a'] })
    expect((await repository.listDocuments('ws-a', { productId: 'product-a', skuId: 'sku-a', indexState: 'ready', knowledgeType: 'product_facts', limit: 5 })).map(item => item.id)).toEqual(['doc-a'])
    expect(lastDocumentCall(pool)).toEqual({
      statement: listDocumentsGolden('WHERE workspace_id=$1 AND product_id=$2 AND sku_id=$3 AND index_state=$4 AND knowledge_type=$5 ORDER BY updated_at DESC,id LIMIT $6'),
      parameters: ['ws-a', 'product-a', 'sku-a', 'ready', 'product_facts', 5],
    })

    const memory = new MemoryKnowledgeRepository()
    for (const [id, productId] of [['doc-a', 'product-a'], ['doc-b', 'product-b'], ['doc-c', 'product-c']] as const) {
      await memory.createDocument({ id, workspaceId: 'ws-a', productId, knowledgeType: 'product_facts', contentHash: `hash-${id}`, extractedText: id })
    }
    expect((await memory.listDocuments('ws-a', { productIds: ['product-c', 'product-a'] })).map(item => item.id)).toEqual(['doc-a', 'doc-c'])
    expect(await memory.listDocuments('ws-a', { productIds: [] })).toEqual([])
    expect(await memory.listDocuments('ws-a', { productId: 'product-b', productIds: ['product-c'] })).toEqual([])
    expect((await memory.listDocuments('ws-a')).map(item => item.id)).toEqual(['doc-a', 'doc-b', 'doc-c'])
  })

  it('answers a page of products with one bounded search per product in three queries instead of three queries per product', async () => {
    // `doc-a` is over the per-product bound, `doc-c` has no lexical match at
    // all: a single global LIMIT would drop `doc-b` rather than keep it.
    const documents = [
      pgDocument('doc-a1', { product_id: 'product-a', extracted_text: '锦纶 88%' }),
      pgDocument('doc-a2', { product_id: 'product-a', extracted_text: '锦纶 面料' }),
      pgDocument('doc-a3', { product_id: 'product-a', extracted_text: '锦纶 里料' }),
      pgDocument('doc-b1', { product_id: 'product-b', extracted_text: '锦纶 外套' }),
      pgDocument('doc-c1', { product_id: 'product-c', extracted_text: '无关内容' }),
    ]
    const chunks = [pgChunk('chunk-a1', 'doc-a1', 0, '锦纶 88%'), pgChunk('chunk-b1', 'doc-b1', 0, '锦纶 外套')]
    const embeddings = [
      pgEmbedding('embedding-a1', 'doc-a1', 'chunk-a1', [1, 0]),
      pgEmbedding('embedding-a2', 'doc-a2', 'chunk-a1', [0, 1]),
      pgEmbedding('embedding-b1', 'doc-b1', 'chunk-b1', [0, 1]),
    ]

    const batched = new BatchedKnowledgePool(documents, chunks, embeddings)
    const batchedResults = await new PostgresKnowledgeRepository(batched).search({
      workspaceId: 'ws-a',
      query: '锦纶',
      queryEmbedding: [0, 1],
      productIds: ['product-c', 'product-a', 'product-b'],
      limit: 2,
    })
    // The per-product calls this batch replaces, same filters and same bound.
    const singles: Awaited<ReturnType<PostgresKnowledgeRepository['search']>> = []
    for (const productId of ['product-c', 'product-a', 'product-b']) {
      singles.push(...await new PostgresKnowledgeRepository(new BatchedKnowledgePool(documents, chunks, embeddings)).search({
        workspaceId: 'ws-a',
        query: '锦纶',
        queryEmbedding: [0, 1],
        productId,
        limit: 2,
      }))
    }
    expect(batchedResults).toEqual(singles)
    expect(batchedResults.map(item => item.document.id)).toEqual(['doc-c1', 'doc-a1', 'doc-a2', 'doc-b1'])
    // Three queries for the whole page, not three per product.
    expect(childQueries(batched)).toEqual({ documents: 1, chunks: 1, embeddings: 1 })

    // The bound is per product: a page-level top-2 would silently drop doc-b1.
    const bounded = new BatchedKnowledgePool(documents, [], [])
    expect((await new PostgresKnowledgeRepository(bounded).search({ workspaceId: 'ws-a', query: '锦纶', productIds: ['product-a', 'product-b'], limit: 1 })).map(item => item.document.id)).toEqual(['doc-a1', 'doc-b1'])
    expect((await new PostgresKnowledgeRepository(new BatchedKnowledgePool(documents, [], [])).search({ workspaceId: 'ws-a', query: '锦纶', productIds: ['product-a', 'product-b'], limit: 2 })).map(item => item.document.id)).toEqual(['doc-a1', 'doc-a2', 'doc-b1'])

    // An empty batch stays an empty scope, and no batch call is issued for it.
    const empty = new BatchedKnowledgePool(documents, [], [])
    expect(await new PostgresKnowledgeRepository(empty).search({ workspaceId: 'ws-a', query: '锦纶', productIds: [] })).toEqual([])

    // The single-product statement is byte-identical to the pre-batch one, and
    // the batch statement is the only place the per-product window appears.
    const legacy = new BatchedKnowledgePool(documents, [], [])
    const legacyRepository = new PostgresKnowledgeRepository(legacy)
    expect((await legacyRepository.search({ workspaceId: 'ws-a' })).map(item => item.document.id)).toEqual(['doc-a1', 'doc-a2', 'doc-a3', 'doc-b1', 'doc-c1'])
    expect(legacy.statements.find(statement => statement.includes('FROM knowledge_documents'))).toBe(searchGolden("WHERE d.workspace_id=$1 AND d.index_state='ready' AND d.approval_status='approved' AND d.rights_status='cleared' ORDER BY d.updated_at DESC,d.id LIMIT $2"))
    expect((await legacyRepository.search({ workspaceId: 'ws-a', productId: 'product-a' })).map(item => item.document.id)).toEqual(['doc-a1', 'doc-a2', 'doc-a3'])
    const lastSearchCall = (pool: BatchedKnowledgePool) => {
      const position = pool.statements.reduce((result, statement, index) => statement.includes('FROM knowledge_documents d') ? index : result, -1)
      return { statement: pool.statements[position]!, parameters: pool.parameters[position]! }
    }
    expect(lastSearchCall(legacy)).toEqual({
      statement: searchGolden("WHERE d.workspace_id=$1 AND d.index_state='ready' AND d.approval_status='approved' AND d.rights_status='cleared' AND d.product_id=$2 ORDER BY d.updated_at DESC,d.id LIMIT $3"),
      parameters: ['ws-a', 'product-a', 20],
    })
    expect(lastSearchCall(legacy).statement).not.toContain('ANY(')
    expect(lastSearchCall(legacy).statement).not.toContain('ranked')
    expect(lastSearchCall(batched).statement).toContain('row_number() OVER (PARTITION BY d.product_id ORDER BY d.updated_at DESC,d.id) AS knowledge_product_rank')

    const memory = new MemoryKnowledgeRepository()
    for (const [id, productId, extractedText] of [
      ['doc-a1', 'product-a', '锦纶 88%'],
      ['doc-a2', 'product-a', '锦纶 面料'],
      ['doc-b1', 'product-b', '锦纶 外套'],
      ['doc-c1', 'product-c', '无关内容'],
    ] as const) {
      await memory.createDocument({ id, workspaceId: 'ws-a', productId, knowledgeType: 'product_facts', contentHash: `hash-${id}`, extractedText, approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
    }
    const memoryBatch = await memory.search({ workspaceId: 'ws-a', query: '锦纶', productIds: ['product-c', 'product-a', 'product-b'], limit: 1 })
    const memorySingles: Awaited<ReturnType<MemoryKnowledgeRepository['search']>> = []
    for (const productId of ['product-c', 'product-a', 'product-b']) memorySingles.push(...await memory.search({ workspaceId: 'ws-a', query: '锦纶', productId, limit: 1 }))
    expect(memoryBatch).toEqual(memorySingles)
    expect(memoryBatch.map(item => item.document.id)).toEqual(['doc-a1', 'doc-b1'])
    expect(await memory.search({ workspaceId: 'ws-a', query: '锦纶', productIds: [] })).toEqual([])
  })

  it('holds generation claim fences across provider unknown and releases only a proven pre-dispatch rejection', async () => {
    const memory = new MemoryKnowledgeRepository()
    const content = 'approved generation facts'
    const sha = createHash('sha256').update(content).digest('hex')
    const document = await memory.createDocument({ workspaceId: 'ws-a', productId: 'product-a', knowledgeType: 'product_facts', title: 'facts', extractedText: content, contentHash: sha, approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
    const input = {
      workspaceId: 'ws-a', eventId: 'event-a', aggregateId: 'aggregate-a', taskId: 'task-a', logicalAttempt: 1,
      providerAttemptId: 'attempt-a', providerAttemptKey: `mm-${'a'.repeat(64)}`, requestBodySha256: 'b'.repeat(64), requestNonce: '00000000-0000-4000-8000-000000000000',
      productId: 'product-a', contextHash: 'c'.repeat(64), expectedDocuments: [{ documentId: document.id, revision: document.revision, contentSha256: sha }],
    }
    const claim = await memory.claimGenerationKnowledge(input)
    expect(claim).toMatchObject({ claimed: true, state: 'claimed' })
    await expect(memory.createDocument({ id: document.id, workspaceId: 'ws-a', productId: 'product-a', knowledgeType: 'product_facts', title: 'facts', extractedText: 'revoked', contentHash: 'd'.repeat(64) })).rejects.toThrow('KNOWLEDGE_GENERATION_ACTIVE')
    const settlementIdentity = { workspaceId: 'ws-a', claimId: claim.claimId!, providerAttemptId: input.providerAttemptId, providerAttemptKey: input.providerAttemptKey, requestBodySha256: input.requestBodySha256, requestNonce: input.requestNonce }
    expect(await memory.settleGenerationKnowledgeClaim({ ...settlementIdentity, to: 'provider_started' })).toMatchObject({ state: 'provider_started', claimedAt: claim.claimedAt })
    expect(await memory.settleGenerationKnowledgeClaim({ ...settlementIdentity, to: 'outcome_unknown' })).toMatchObject({ state: 'outcome_unknown', claimedAt: claim.claimedAt })
    expect(await memory.claimGenerationKnowledge(input)).toEqual({ claimed: true, claimId: claim.claimId, state: 'outcome_unknown', claimedAt: claim.claimedAt })
    expect(await memory.settleGenerationKnowledgeClaim({ ...settlementIdentity, to: 'completed' })).toBeUndefined()
    await expect(memory.createDocument({ id: document.id, workspaceId: 'ws-a', productId: 'product-a', knowledgeType: 'product_facts', title: 'facts', extractedText: 'revoked', contentHash: 'd'.repeat(64) })).rejects.toThrow('KNOWLEDGE_GENERATION_ACTIVE')
    expect(await memory.claimGenerationKnowledge({ ...input, providerAttemptId: 'attempt-a-retry', requestNonce: '00000000-0000-4000-8000-000000000001' })).toEqual({ claimed: false, reason: 'active_claim' })

    const secondDocument = await memory.createDocument({ workspaceId: 'ws-a', productId: 'product-b', knowledgeType: 'product_facts', extractedText: content, contentHash: sha, approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
    const preDispatch = await memory.claimGenerationKnowledge({ ...input, eventId: 'event-b', aggregateId: 'aggregate-b', taskId: 'task-b', providerAttemptId: 'attempt-b', productId: 'product-b', expectedDocuments: [{ documentId: secondDocument.id, revision: secondDocument.revision, contentSha256: sha }] })
    expect(preDispatch.claimed).toBe(true)
    expect(await memory.settleGenerationKnowledgeClaim({ ...settlementIdentity, claimId: preDispatch.claimId!, providerAttemptId: 'attempt-b', to: 'rejected' })).toMatchObject({ state: 'rejected' })
    await memory.createDocument({ id: secondDocument.id, workspaceId: 'ws-a', productId: 'product-b', knowledgeType: 'product_facts', extractedText: 'updated after proven no-dispatch', contentHash: 'e'.repeat(64) })
  })

  it('keeps memory generation claims aligned with postgres snapshot and creation-time semantics', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T04:00:00.000Z'))
    try {
      const memory = new MemoryKnowledgeRepository()
      const docs = []
      for (let index = 0; index < 9; index += 1) {
        const content = `approved-${index}`
        docs.push(await memory.createDocument({ id: `doc-parity-${index}`, workspaceId: 'ws-parity', productId: 'product-parity', knowledgeType: 'product_facts', extractedText: content, contentHash: createHash('sha256').update(content).digest('hex'), approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' }))
      }
      const claimInput = {
        workspaceId: 'ws-parity', eventId: 'event-parity', aggregateId: 'aggregate-parity', taskId: 'task-parity', logicalAttempt: 1,
        providerAttemptId: 'attempt-parity', providerAttemptKey: `mm-${'a'.repeat(64)}`, requestBodySha256: 'b'.repeat(64), requestNonce: '00000000-0000-4000-8000-000000000000',
        productId: 'product-parity', contextHash: 'c'.repeat(64),
        expectedDocuments: [{ documentId: docs[0]!.id, revision: docs[0]!.revision, contentSha256: docs[0]!.contentHash }],
      }
      expect(await memory.claimGenerationKnowledge(claimInput)).toEqual({ claimed: false, reason: 'snapshot_changed' })

      const single = new MemoryKnowledgeRepository()
      const content = 'one approved document'
      const document = await single.createDocument({ id: 'doc-single-parity', workspaceId: 'ws-parity', productId: 'product-single', knowledgeType: 'product_facts', extractedText: content, contentHash: createHash('sha256').update(content).digest('hex'), approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
      const singleInput = { ...claimInput, eventId: 'event-single', aggregateId: 'aggregate-single', taskId: 'task-single', providerAttemptId: 'attempt-single', productId: 'product-single', expectedDocuments: [{ documentId: document.id, revision: document.revision, contentSha256: document.contentHash }] }
      const claim = await single.claimGenerationKnowledge(singleInput)
      expect(claim.claimed).toBe(true)
      vi.setSystemTime(new Date('2026-09-25T04:00:01.000Z'))
      const settlement = { workspaceId: 'ws-parity', claimId: claim.claimId!, providerAttemptId: 'attempt-single', providerAttemptKey: singleInput.providerAttemptKey, requestBodySha256: singleInput.requestBodySha256, requestNonce: singleInput.requestNonce }
      await single.settleGenerationKnowledgeClaim({ ...settlement, to: 'provider_started' })
      expect(await single.claimGenerationKnowledge(singleInput)).toMatchObject({ claimed: true, state: 'provider_started', claimedAt: '2026-09-25T04:00:00.000Z' })

      const expired = new MemoryKnowledgeRepository()
      const expiredDocument = await expired.createDocument({ id: 'doc-expired-parity', workspaceId: 'ws-parity', productId: 'product-expired', knowledgeType: 'product_facts', extractedText: content, contentHash: createHash('sha256').update(content).digest('hex'), approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready', expiresAt: '2026-09-25T03:59:59.000Z' })
      expect(await expired.claimGenerationKnowledge({ ...singleInput, eventId: 'event-expired', aggregateId: 'aggregate-expired', taskId: 'task-expired', providerAttemptId: 'attempt-expired', productId: 'product-expired', expectedDocuments: [{ documentId: expiredDocument.id, revision: expiredDocument.revision, contentSha256: expiredDocument.contentHash }] })).toEqual({ claimed: false, reason: 'snapshot_changed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('claims an empty knowledge snapshot only while the product has no documents', async () => {
    const input = {
      workspaceId: 'ws-a', eventId: 'event-empty', aggregateId: 'aggregate-empty', taskId: 'task-empty', logicalAttempt: 1,
      providerAttemptId: 'attempt-empty', providerAttemptKey: `mm-${'a'.repeat(64)}`, requestBodySha256: 'b'.repeat(64),
      requestNonce: '00000000-0000-4000-8000-000000000000', productId: 'product-empty', contextHash: 'c'.repeat(64),
      expectedDocuments: [],
    }
    const memory = new MemoryKnowledgeRepository()
    expect(await memory.claimGenerationKnowledge(input)).toMatchObject({ claimed: true, state: 'claimed' })

    const changed = new MemoryKnowledgeRepository()
    await changed.createDocument({ workspaceId: 'ws-a', productId: 'product-empty', knowledgeType: 'product_facts',
      extractedText: 'new facts', contentHash: 'd'.repeat(64), approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
    expect(await changed.claimGenerationKnowledge(input)).toEqual({ claimed: false, reason: 'snapshot_changed' })

    const unapproved = new MemoryKnowledgeRepository()
    await unapproved.createDocument({ workspaceId: 'ws-a', productId: 'product-empty', knowledgeType: 'product_facts',
      extractedText: 'awaiting review', contentHash: 'e'.repeat(64), approvalStatus: 'pending', rightsStatus: 'cleared', indexState: 'queued' })
    expect(await unapproved.claimGenerationKnowledge(input)).toEqual({ claimed: false, reason: 'snapshot_changed' })

    const pool = new RecordingKnowledgePool({}, {})
    expect(await new PostgresKnowledgeRepository(pool).claimGenerationKnowledge(input)).toEqual({ claimed: false, reason: 'snapshot_changed' })
    const claimIndex = pool.statements.findIndex(statement => statement.includes('claim_knowledge_generation('))
    expect(claimIndex).toBeGreaterThanOrEqual(0)
    expect(pool.parameters[claimIndex]?.at(-1)).toBe('[]')
  })
})
