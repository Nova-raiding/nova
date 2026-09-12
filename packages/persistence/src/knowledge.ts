import { createHash, randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type KnowledgeIndexState = 'queued' | 'indexing' | 'ready' | 'stale' | 'failed' | 'deleted'
export type KnowledgeApprovalStatus = 'pending' | 'approved' | 'rejected'
export type KnowledgeRightsStatus = 'unknown' | 'cleared' | 'restricted'
export type KnowledgeType = 'product_facts' | 'material' | 'selling_points' | 'brand' | 'customer' | 'rule'

export interface KnowledgeAssetInput {
  id?: string
  workspaceId: string
  kind: KnowledgeType
  name: string
  content: unknown
  sourceAssetId?: string
  productId?: string
  skuId?: string
  sourceVersion?: number
  approvalStatus?: KnowledgeApprovalStatus
  rightsStatus?: KnowledgeRightsStatus
  indexState?: KnowledgeIndexState
  indexError?: string
}

export interface KnowledgeAsset extends Omit<KnowledgeAssetInput, 'id' | 'sourceVersion' | 'approvalStatus' | 'rightsStatus' | 'indexState'> {
  id: string
  sourceVersion: number
  approvalStatus: KnowledgeApprovalStatus
  rightsStatus: KnowledgeRightsStatus
  indexState: KnowledgeIndexState
  revision: number
  createdAt: string
  updatedAt: string
}

export interface KnowledgeDocumentInput {
  id?: string
  workspaceId: string
  knowledgeAssetId?: string
  sourceAssetId?: string
  sourceVersion?: number
  brandId?: string
  productId?: string
  skuId?: string
  knowledgeType: KnowledgeType
  title?: string
  contentType?: string
  contentHash: string
  extractedText: string
  sourceMetadata?: Record<string, unknown>
  approvalStatus?: KnowledgeApprovalStatus
  rightsStatus?: KnowledgeRightsStatus
  ruleSnapshotVersion?: string
  embeddingModel?: string
  embeddingVersion?: string
  indexState?: KnowledgeIndexState
  expiresAt?: string
}

export interface KnowledgeDocument extends Omit<KnowledgeDocumentInput, 'id' | 'sourceVersion' | 'title' | 'contentType' | 'sourceMetadata' | 'approvalStatus' | 'rightsStatus' | 'indexState'> {
  id: string
  sourceVersion: number
  title: string
  contentType: string
  sourceMetadata: Record<string, unknown>
  approvalStatus: KnowledgeApprovalStatus
  rightsStatus: KnowledgeRightsStatus
  indexState: KnowledgeIndexState
  indexError?: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface KnowledgeChunkInput {
  id?: string
  ordinal: number
  content: string
  contentHash?: string
  tokenCount?: number
  metadata?: Record<string, unknown>
}

export interface KnowledgeChunk extends Omit<KnowledgeChunkInput, 'id' | 'contentHash'> {
  id: string
  documentId: string
  workspaceId: string
  contentHash: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface KnowledgeEmbeddingInput {
  id?: string
  documentId: string
  chunkId: string
  embedding: readonly number[]
  embeddingModel: string
  embeddingVersion: string
  vectorMetadata?: Record<string, unknown>
  indexState?: KnowledgeIndexState
}

export interface KnowledgeEmbedding extends Omit<KnowledgeEmbeddingInput, 'embedding' | 'vectorMetadata' | 'indexState'> {
  id: string
  workspaceId: string
  embedding: number[]
  vectorMetadata: Record<string, unknown>
  indexState: KnowledgeIndexState
  createdAt: string
  updatedAt: string
}

export interface KnowledgeAssetBindingInput {
  workspaceId: string
  knowledgeAssetId: string
  sourceAssetId?: string
  productId?: string
  skuId?: string
  sourceVersion?: number
  bindingType?: 'spreadsheet_facts' | 'source_asset' | 'manual'
  approvalStatus?: KnowledgeApprovalStatus
}

export interface KnowledgeAssetBinding extends KnowledgeAssetBindingInput {
  bindingId: string
  createdAt: string
  updatedAt: string
}

export interface KnowledgeSearchInput {
  workspaceId: string
  query?: string
  /** Optional catalog scope. Product/SKU identifiers are authoritative; the
   * platform/account/store predicates are checked against the durable product
   * row so a document cannot leak across stores in one workspace. */
  platform?: string
  accountId?: string
  storeName?: string
  productId?: string
  skuId?: string
  knowledgeTypes?: readonly KnowledgeType[]
  limit?: number
  queryEmbedding?: readonly number[]
}

export interface KnowledgeSearchResult {
  document: KnowledgeDocument
  chunks: KnowledgeChunk[]
  score: number
}

export interface KnowledgeDeletionProof {
  id: string
  workspaceId: string
  documentId: string
  deletedAt: string
  chunksDeleted: number
  embeddingsDeleted: number
  deletionDigest: string
}

export interface KnowledgeRepository {
  createAsset(input: KnowledgeAssetInput): Promise<KnowledgeAsset>
  getAsset(workspaceId: string, assetId: string): Promise<KnowledgeAsset | undefined>
  updateAsset(workspaceId: string, assetId: string, patch: { name?: string; content?: unknown; approvalStatus?: KnowledgeApprovalStatus; rightsStatus?: KnowledgeRightsStatus; indexState?: KnowledgeIndexState; indexError?: string }): Promise<KnowledgeAsset>
  bindAsset(input: KnowledgeAssetBindingInput): Promise<KnowledgeAssetBinding>
  createDocument(input: KnowledgeDocumentInput): Promise<KnowledgeDocument>
  listDocuments(workspaceId: string, filters?: { productId?: string; skuId?: string; indexState?: KnowledgeIndexState; knowledgeType?: KnowledgeType }): Promise<KnowledgeDocument[]>
  replaceChunks(workspaceId: string, documentId: string, chunks: readonly KnowledgeChunkInput[]): Promise<KnowledgeChunk[]>
  upsertEmbedding(workspaceId: string, input: KnowledgeEmbeddingInput): Promise<KnowledgeEmbedding>
  transitionIndexState(workspaceId: string, documentId: string, state: KnowledgeIndexState, reason?: string): Promise<KnowledgeDocument>
  rebuildIndex(workspaceId: string, documentId?: string, reason?: string): Promise<number>
  deleteDocument(workspaceId: string, documentId: string, reason?: string): Promise<KnowledgeDeletionProof>
  search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]>
}

const clone = <T>(value: T): T => structuredClone(value)
const now = (): string => new Date().toISOString()
const text = (value: string | undefined, field: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}_REQUIRED`)
  return value.trim()
}
const positive = (value: number | undefined, field: string): number => {
  const result = value ?? 1
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${field}_INVALID`)
  return result
}
const assertState = (value: KnowledgeIndexState): void => {
  if (!['queued', 'indexing', 'ready', 'stale', 'failed', 'deleted'].includes(value)) throw new Error('KNOWLEDGE_INDEX_STATE_INVALID')
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const contentHash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')
const vectorScore = (left: readonly number[], right: readonly number[]): number => {
  if (!left.length || left.length !== right.length || left.some(item => !Number.isFinite(item)) || right.some(item => !Number.isFinite(item))) return 0
  let dot = 0; let leftNorm = 0; let rightNorm = 0
  left.forEach((item, index) => { dot += item * right[index]!; leftNorm += item * item; rightNorm += right[index]! * right[index]! })
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0
}

export class MemoryKnowledgeRepository implements KnowledgeRepository {
  private readonly assets = new Map<string, KnowledgeAsset>()
  private readonly bindings = new Map<string, KnowledgeAssetBinding>()
  private readonly documents = new Map<string, KnowledgeDocument>()
  private readonly chunks = new Map<string, KnowledgeChunk>()
  private readonly embeddings = new Map<string, KnowledgeEmbedding>()
  private readonly proofs = new Map<string, KnowledgeDeletionProof>()

  async createAsset(input: KnowledgeAssetInput): Promise<KnowledgeAsset> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const asset: KnowledgeAsset = { ...input, id: input.id ?? `knowledge_asset_${randomUUID()}`, workspaceId, name: text(input.name, 'KNOWLEDGE_ASSET_NAME'), sourceVersion: positive(input.sourceVersion, 'KNOWLEDGE_SOURCE_VERSION'), approvalStatus: input.approvalStatus ?? 'pending', rightsStatus: input.rightsStatus ?? 'unknown', indexState: input.indexState ?? 'queued', revision: 1, createdAt: now(), updatedAt: now() }
    if (this.assets.has(asset.id)) return clone(this.assets.get(asset.id)!)
    this.assets.set(asset.id, asset); return clone(asset)
  }
  async getAsset(workspaceId: string, assetId: string): Promise<KnowledgeAsset | undefined> {
    const scope = requireWorkspaceScope(workspaceId)
    const asset = this.assets.get(assetId)
    return asset && asset.workspaceId === scope ? clone(asset) : undefined
  }
  async updateAsset(workspaceId: string, assetId: string, patch: { name?: string; content?: unknown; approvalStatus?: KnowledgeApprovalStatus; rightsStatus?: KnowledgeRightsStatus; indexState?: KnowledgeIndexState; indexError?: string }): Promise<KnowledgeAsset> {
    const scope = requireWorkspaceScope(workspaceId)
    const current = this.assets.get(assetId)
    if (!current || current.workspaceId !== scope) throw new Error('KNOWLEDGE_ASSET_NOT_FOUND')
    if (patch.name !== undefined) current.name = text(patch.name, 'KNOWLEDGE_ASSET_NAME')
    if (patch.content !== undefined) current.content = clone(patch.content)
    if (patch.approvalStatus !== undefined) current.approvalStatus = patch.approvalStatus
    if (patch.rightsStatus !== undefined) current.rightsStatus = patch.rightsStatus
    if (patch.indexState !== undefined) { assertState(patch.indexState); current.indexState = patch.indexState }
    if (patch.indexError !== undefined) current.indexError = patch.indexError
    current.revision += 1
    current.updatedAt = now()
    for (const document of this.documents.values()) {
      if (document.workspaceId !== scope || document.knowledgeAssetId !== assetId) continue
      if (patch.approvalStatus !== undefined) document.approvalStatus = patch.approvalStatus
      if (patch.rightsStatus !== undefined) document.rightsStatus = patch.rightsStatus
      if (patch.indexState !== undefined) document.indexState = patch.indexState
      if (patch.indexError !== undefined) document.indexError = patch.indexError
      document.revision += 1
      document.updatedAt = current.updatedAt
    }
    return clone(current)
  }
  async bindAsset(input: KnowledgeAssetBindingInput): Promise<KnowledgeAssetBinding> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const knowledgeAssetId = text(input.knowledgeAssetId, 'KNOWLEDGE_ASSET_ID')
    const asset = this.assets.get(knowledgeAssetId)
    if (!asset || asset.workspaceId !== workspaceId) throw new Error('KNOWLEDGE_ASSET_NOT_FOUND')
    const key = `${workspaceId}:${knowledgeAssetId}:${input.sourceAssetId ?? ''}:${input.productId ?? ''}:${input.skuId ?? ''}`
    const existing = this.bindings.get(key); if (existing) return clone(existing)
    const timestamp = now(); const binding: KnowledgeAssetBinding = { ...input, workspaceId, knowledgeAssetId, bindingId: `knowledge_binding_${randomUUID()}`, sourceVersion: positive(input.sourceVersion, 'KNOWLEDGE_SOURCE_VERSION'), bindingType: input.bindingType ?? 'spreadsheet_facts', approvalStatus: input.approvalStatus ?? 'pending', createdAt: timestamp, updatedAt: timestamp }
    this.bindings.set(key, binding); return clone(binding)
  }
  async createDocument(input: KnowledgeDocumentInput): Promise<KnowledgeDocument> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const id = input.id ?? `knowledge_document_${randomUUID()}`
    if (input.knowledgeAssetId) { const asset = this.assets.get(input.knowledgeAssetId); if (!asset || asset.workspaceId !== workspaceId) throw new Error('KNOWLEDGE_ASSET_NOT_FOUND') }
    const existing = this.documents.get(id); if (existing) return clone(existing)
    const document: KnowledgeDocument = { ...input, id, workspaceId, sourceVersion: positive(input.sourceVersion, 'KNOWLEDGE_SOURCE_VERSION'), title: input.title?.trim() ?? '', contentType: input.contentType?.trim() || 'text/plain', contentHash: text(input.contentHash, 'KNOWLEDGE_CONTENT_HASH'), extractedText: input.extractedText, sourceMetadata: clone(input.sourceMetadata ?? {}), approvalStatus: input.approvalStatus ?? 'pending', rightsStatus: input.rightsStatus ?? 'unknown', indexState: input.indexState ?? 'queued', revision: 1, createdAt: now(), updatedAt: now() }
    assertState(document.indexState); this.documents.set(id, document); return clone(document)
  }
  async listDocuments(workspaceId: string, filters: { productId?: string; skuId?: string; indexState?: KnowledgeIndexState; knowledgeType?: KnowledgeType } = {}): Promise<KnowledgeDocument[]> { const scope = requireWorkspaceScope(workspaceId); return [...this.documents.values()].filter(item => item.workspaceId === scope && (!filters.productId || item.productId === filters.productId) && (!filters.skuId || item.skuId === filters.skuId) && (!filters.indexState || item.indexState === filters.indexState) && (!filters.knowledgeType || item.knowledgeType === filters.knowledgeType)).map(clone) }
  async replaceChunks(workspaceId: string, documentId: string, chunks: readonly KnowledgeChunkInput[]): Promise<KnowledgeChunk[]> {
    const scope = requireWorkspaceScope(workspaceId); const document = this.documents.get(documentId); if (!document || document.workspaceId !== scope) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND')
    for (const chunk of [...this.chunks.values()]) if (chunk.workspaceId === scope && chunk.documentId === documentId) { this.chunks.delete(chunk.id); for (const embedding of [...this.embeddings.values()]) if (embedding.chunkId === chunk.id) this.embeddings.delete(embedding.id) }
    const output = chunks.map(input => { if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) throw new Error('KNOWLEDGE_CHUNK_ORDINAL_INVALID'); const result: KnowledgeChunk = { ...input, id: input.id ?? `knowledge_chunk_${randomUUID()}`, workspaceId: scope, documentId, content: text(input.content, 'KNOWLEDGE_CHUNK_CONTENT'), contentHash: input.contentHash ?? contentHash(input.content), metadata: clone(input.metadata ?? {}), createdAt: now() }; this.chunks.set(result.id, result); return result })
    return clone(output)
  }
  async upsertEmbedding(workspaceId: string, input: KnowledgeEmbeddingInput): Promise<KnowledgeEmbedding> { const scope = requireWorkspaceScope(workspaceId); const document = this.documents.get(input.documentId); const chunk = this.chunks.get(input.chunkId); if (!document || document.workspaceId !== scope || !chunk || chunk.workspaceId !== scope || chunk.documentId !== input.documentId) throw new Error('KNOWLEDGE_EMBEDDING_SCOPE_INVALID'); if (!input.embedding.length || input.embedding.some(item => !Number.isFinite(item))) throw new Error('KNOWLEDGE_EMBEDDING_INVALID'); const existing = [...this.embeddings.values()].find(item => item.workspaceId === scope && item.chunkId === input.chunkId && item.embeddingModel === input.embeddingModel && item.embeddingVersion === input.embeddingVersion); const result: KnowledgeEmbedding = { ...input, id: existing?.id ?? input.id ?? `knowledge_embedding_${randomUUID()}`, workspaceId: scope, embedding: [...input.embedding], vectorMetadata: clone(input.vectorMetadata ?? {}), indexState: input.indexState ?? 'queued', createdAt: existing?.createdAt ?? now(), updatedAt: now() }; assertState(result.indexState); this.embeddings.set(result.id, result); return clone(result) }
  async transitionIndexState(workspaceId: string, documentId: string, state: KnowledgeIndexState, reason = ''): Promise<KnowledgeDocument> { const scope = requireWorkspaceScope(workspaceId); assertState(state); const current = this.documents.get(documentId); if (!current || current.workspaceId !== scope) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND'); const next = { ...current, indexState: state, indexError: state === 'failed' ? reason : undefined, revision: current.revision + 1, updatedAt: now() }; this.documents.set(documentId, next); return clone(next) }
  async rebuildIndex(workspaceId: string, documentId?: string, _reason = 'rebuild requested'): Promise<number> { const scope = requireWorkspaceScope(workspaceId); const targets = [...this.documents.values()].filter(item => item.workspaceId === scope && (!documentId || item.id === documentId) && item.indexState !== 'deleted'); for (const item of targets) { item.indexState = 'queued'; item.revision += 1; item.updatedAt = now() } return targets.length }
  async deleteDocument(workspaceId: string, documentId: string, _reason = 'document deleted'): Promise<KnowledgeDeletionProof> { const scope = requireWorkspaceScope(workspaceId); const document = this.documents.get(documentId); if (!document || document.workspaceId !== scope) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND'); const chunks = [...this.chunks.values()].filter(item => item.workspaceId === scope && item.documentId === documentId); const embeddings = [...this.embeddings.values()].filter(item => item.workspaceId === scope && item.documentId === documentId); chunks.forEach(item => this.chunks.delete(item.id)); embeddings.forEach(item => this.embeddings.delete(item.id)); document.indexState = 'deleted'; document.revision += 1; document.updatedAt = now(); const proof: KnowledgeDeletionProof = { id: `knowledge_deletion_${randomUUID()}`, workspaceId: scope, documentId, deletedAt: now(), chunksDeleted: chunks.length, embeddingsDeleted: embeddings.length, deletionDigest: digest({ scope, documentId, chunks: chunks.map(item => item.id), embeddings: embeddings.map(item => item.id) }) }; this.proofs.set(proof.id, proof); return clone(proof) }
  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]> { const scope = requireWorkspaceScope(input.workspaceId); const limit = Math.min(Math.max(input.limit ?? 20, 1), 100); const terms = (input.query ?? '').trim().toLocaleLowerCase(); return [...this.documents.values()].filter(item => item.workspaceId === scope && item.indexState === 'ready' && item.approvalStatus === 'approved' && item.rightsStatus === 'cleared' && (!input.productId || item.productId === input.productId) && (!input.skuId || item.skuId === input.skuId) && (!input.knowledgeTypes?.length || input.knowledgeTypes.includes(item.knowledgeType))).map(document => { const chunks = [...this.chunks.values()].filter(chunk => chunk.workspaceId === scope && chunk.documentId === document.id); const embeddings = [...this.embeddings.values()].filter(embedding => embedding.workspaceId === scope && embedding.documentId === document.id && embedding.indexState === 'ready'); const lexical = terms ? (document.extractedText.toLocaleLowerCase().includes(terms) ? 1 : chunks.some(chunk => chunk.content.toLocaleLowerCase().includes(terms)) ? .5 : 0) : 0; const score = input.queryEmbedding ? Math.max(lexical, ...embeddings.map(embedding => vectorScore(input.queryEmbedding!, embedding.embedding)), 0) : lexical; return { document: clone(document), chunks: clone(chunks), score } }).filter(item => !terms || item.score > 0).sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id)).slice(0, limit).map(clone) }
}

type Row = Record<string, any>
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value)
const json = <T>(value: T | string | null | undefined, fallback: T): T => typeof value === 'string' ? JSON.parse(value) as T : value == null ? fallback : value as T
const mapAsset = (row: Row): KnowledgeAsset => ({ id: row.id, workspaceId: row.workspace_id, kind: row.kind, name: row.name, content: json(row.content, {}), ...(row.source_asset_id ? { sourceAssetId: row.source_asset_id } : {}), ...(row.product_id ? { productId: row.product_id } : {}), ...(row.sku_id ? { skuId: row.sku_id } : {}), sourceVersion: Number(row.source_version), approvalStatus: row.approval_status, rightsStatus: row.rights_status, indexState: row.index_state, revision: Number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const mapDocument = (row: Row): KnowledgeDocument => ({ id: row.id, workspaceId: row.workspace_id, ...(row.knowledge_asset_id ? { knowledgeAssetId: row.knowledge_asset_id } : {}), ...(row.source_asset_id ? { sourceAssetId: row.source_asset_id } : {}), sourceVersion: Number(row.source_version), ...(row.brand_id ? { brandId: row.brand_id } : {}), ...(row.product_id ? { productId: row.product_id } : {}), ...(row.sku_id ? { skuId: row.sku_id } : {}), knowledgeType: row.knowledge_type, title: row.title, contentType: row.content_type, contentHash: row.content_hash, extractedText: row.extracted_text, sourceMetadata: json(row.source_metadata, {}), approvalStatus: row.approval_status, rightsStatus: row.rights_status, ...(row.rule_snapshot_version ? { ruleSnapshotVersion: row.rule_snapshot_version } : {}), ...(row.embedding_model ? { embeddingModel: row.embedding_model } : {}), ...(row.embedding_version ? { embeddingVersion: row.embedding_version } : {}), indexState: row.index_state, ...(row.index_error ? { indexError: row.index_error } : {}), ...(row.expires_at ? { expiresAt: iso(row.expires_at) } : {}), revision: Number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const mapChunk = (row: Row): KnowledgeChunk => ({ id: row.id, workspaceId: row.workspace_id, documentId: row.document_id, ordinal: Number(row.ordinal), content: row.content, contentHash: row.content_hash, ...(row.token_count == null ? {} : { tokenCount: Number(row.token_count) }), metadata: json(row.metadata, {}), createdAt: iso(row.created_at) })
const mapEmbedding = (row: Row): KnowledgeEmbedding => ({ id: row.id, workspaceId: row.workspace_id, documentId: row.document_id, chunkId: row.chunk_id, embedding: json(row.embedding, []), embeddingModel: row.embedding_model, embeddingVersion: row.embedding_version, vectorMetadata: json(row.vector_metadata, {}), indexState: row.index_state, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const documentProjection = `id, workspace_id, knowledge_asset_id, source_asset_id, source_version, brand_id, product_id, sku_id, knowledge_type, title, content_type, content_hash, extracted_text, source_metadata, approval_status, rights_status, rule_snapshot_version, embedding_model, embedding_version, index_state, index_error, expires_at, revision, created_at, updated_at`

export class PostgresKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly pool: SqlPool) {}
  async createAsset(input: KnowledgeAssetInput): Promise<KnowledgeAsset> { const scope = requireWorkspaceScope(input.workspaceId); const id = input.id ?? `knowledge_asset_${randomUUID()}`; return withWorkspaceTransaction(this.pool, scope, async client => { const result = await client.query<Row>(`INSERT INTO knowledge_assets (id,workspace_id,kind,name,content,source_asset_id,product_id,sku_id,source_version,approval_status,rights_status,index_state) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (workspace_id,id) DO UPDATE SET updated_at=knowledge_assets.updated_at RETURNING *`, [id, scope, input.kind, text(input.name, 'KNOWLEDGE_ASSET_NAME'), JSON.stringify(input.content), input.sourceAssetId ?? null, input.productId ?? null, input.skuId ?? null, positive(input.sourceVersion, 'KNOWLEDGE_SOURCE_VERSION'), input.approvalStatus ?? 'pending', input.rightsStatus ?? 'unknown', input.indexState ?? 'queued']); return mapAsset(result.rows[0]!) }) }
  async getAsset(workspaceId: string, assetId: string): Promise<KnowledgeAsset | undefined> { const scope = requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, scope, async client => { const result = await client.query<Row>('SELECT * FROM knowledge_assets WHERE workspace_id=$1 AND id=$2', [scope, assetId]); return result.rows[0] ? mapAsset(result.rows[0]) : undefined }) }
  async updateAsset(workspaceId: string, assetId: string, patch: { name?: string; content?: unknown; approvalStatus?: KnowledgeApprovalStatus; rightsStatus?: KnowledgeRightsStatus; indexState?: KnowledgeIndexState; indexError?: string }): Promise<KnowledgeAsset> {
    const scope = requireWorkspaceScope(workspaceId)
    if (patch.indexState !== undefined) assertState(patch.indexState)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const current = await client.query<Row>('SELECT * FROM knowledge_assets WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [scope, assetId])
      if (!current.rows[0]) throw new Error('KNOWLEDGE_ASSET_NOT_FOUND')
      const values: unknown[] = [scope, assetId]
      const assignments: string[] = []
      const add = (column: string, value: unknown, cast?: string) => { values.push(value); assignments.push(`${column}=$${values.length}${cast ?? ''}`) }
      if (patch.name !== undefined) add('name', text(patch.name, 'KNOWLEDGE_ASSET_NAME'))
      if (patch.content !== undefined) add('content', JSON.stringify(patch.content), '::jsonb')
      if (patch.approvalStatus !== undefined) add('approval_status', patch.approvalStatus)
      if (patch.rightsStatus !== undefined) add('rights_status', patch.rightsStatus)
      if (patch.indexState !== undefined) add('index_state', patch.indexState)
      if (assignments.length) {
        const result = await client.query<Row>(`UPDATE knowledge_assets SET ${assignments.join(',')},revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING *`, values)
        if (patch.approvalStatus !== undefined || patch.rightsStatus !== undefined || patch.indexState !== undefined || patch.indexError !== undefined) {
          const documentAssignments: string[] = []
          const documentValues: unknown[] = [scope, assetId]
          const addDocument = (column: string, value: unknown) => { documentValues.push(value); documentAssignments.push(`${column}=$${documentValues.length}`) }
          if (patch.approvalStatus !== undefined) addDocument('approval_status', patch.approvalStatus)
          if (patch.rightsStatus !== undefined) addDocument('rights_status', patch.rightsStatus)
          if (patch.indexState !== undefined) addDocument('index_state', patch.indexState)
          if (patch.indexError !== undefined) addDocument('index_error', patch.indexError)
          if (documentAssignments.length) await client.query(`UPDATE knowledge_documents SET ${documentAssignments.join(',')},revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND knowledge_asset_id=$2`, documentValues)
        }
        return mapAsset(result.rows[0]!)
      }
      return mapAsset(current.rows[0]!)
    })
  }
  async bindAsset(input: KnowledgeAssetBindingInput): Promise<KnowledgeAssetBinding> { const scope = requireWorkspaceScope(input.workspaceId); return withWorkspaceTransaction(this.pool, scope, async client => { const result = await client.query<Row>(`INSERT INTO knowledge_asset_bindings (binding_id,workspace_id,knowledge_asset_id,source_asset_id,product_id,sku_id,source_version,binding_type,approval_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (workspace_id,knowledge_asset_id,COALESCE(source_asset_id,''),COALESCE(product_id,''),COALESCE(sku_id,'')) DO UPDATE SET source_version=EXCLUDED.source_version,approval_status=EXCLUDED.approval_status,updated_at=now() RETURNING *`, [`knowledge_binding_${randomUUID()}`, scope, input.knowledgeAssetId, input.sourceAssetId ?? null, input.productId ?? null, input.skuId ?? null, positive(input.sourceVersion, 'KNOWLEDGE_SOURCE_VERSION'), input.bindingType ?? 'spreadsheet_facts', input.approvalStatus ?? 'pending']); const row = result.rows[0]!; return { bindingId: row.binding_id, workspaceId: row.workspace_id, knowledgeAssetId: row.knowledge_asset_id, ...(row.source_asset_id ? { sourceAssetId: row.source_asset_id } : {}), ...(row.product_id ? { productId: row.product_id } : {}), ...(row.sku_id ? { skuId: row.sku_id } : {}), sourceVersion: Number(row.source_version), bindingType: row.binding_type, approvalStatus: row.approval_status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) } }) }
  async createDocument(input: KnowledgeDocumentInput): Promise<KnowledgeDocument> { const scope = requireWorkspaceScope(input.workspaceId); const id = input.id ?? `knowledge_document_${randomUUID()}`; return withWorkspaceTransaction(this.pool, scope, async client => { const result = await client.query<Row>(`INSERT INTO knowledge_documents (id,workspace_id,knowledge_asset_id,source_asset_id,source_version,brand_id,product_id,sku_id,knowledge_type,title,content_type,content_hash,extracted_text,source_metadata,approval_status,rights_status,rule_snapshot_version,embedding_model,embedding_version,index_state,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21::timestamptz) ON CONFLICT (workspace_id,id) DO UPDATE SET extracted_text=EXCLUDED.extracted_text,content_hash=EXCLUDED.content_hash,source_metadata=EXCLUDED.source_metadata,updated_at=now(),revision=knowledge_documents.revision+1 RETURNING ${documentProjection}`, [id, scope, input.knowledgeAssetId ?? null, input.sourceAssetId ?? null, positive(input.sourceVersion, 'KNOWLEDGE_SOURCE_VERSION'), input.brandId ?? null, input.productId ?? null, input.skuId ?? null, input.knowledgeType, input.title?.trim() ?? '', input.contentType?.trim() || 'text/plain', text(input.contentHash, 'KNOWLEDGE_CONTENT_HASH'), input.extractedText, JSON.stringify(input.sourceMetadata ?? {}), input.approvalStatus ?? 'pending', input.rightsStatus ?? 'unknown', input.ruleSnapshotVersion ?? null, input.embeddingModel ?? null, input.embeddingVersion ?? null, input.indexState ?? 'queued', input.expiresAt ?? null]); return mapDocument(result.rows[0]!) }) }
  async listDocuments(workspaceId: string, filters: { productId?: string; skuId?: string; indexState?: KnowledgeIndexState; knowledgeType?: KnowledgeType } = {}): Promise<KnowledgeDocument[]> { const scope = requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, scope, async client => { const values: unknown[] = [scope]; const where = ['workspace_id=$1']; for (const [column, value] of [['product_id', filters.productId], ['sku_id', filters.skuId], ['index_state', filters.indexState], ['knowledge_type', filters.knowledgeType] ] as const) if (value) { values.push(value); where.push(`${column}=$${values.length}`) } const result = await client.query<Row>(`SELECT ${documentProjection} FROM knowledge_documents WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id`, values); return result.rows.map(mapDocument) }) }
  async replaceChunks(workspaceId: string, documentId: string, chunks: readonly KnowledgeChunkInput[]): Promise<KnowledgeChunk[]> { const scope = requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, scope, async client => { const document = await client.query(`SELECT 1 FROM knowledge_documents WHERE workspace_id=$1 AND id=$2`, [scope, documentId]); if (!document.rows[0]) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND'); await client.query(`DELETE FROM knowledge_chunks WHERE workspace_id=$1 AND document_id=$2`, [scope, documentId]); const output: KnowledgeChunk[] = []; for (const input of chunks) { if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) throw new Error('KNOWLEDGE_CHUNK_ORDINAL_INVALID'); const result = await client.query<Row>(`INSERT INTO knowledge_chunks (id,workspace_id,document_id,ordinal,content,content_hash,token_count,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`, [input.id ?? `knowledge_chunk_${randomUUID()}`, scope, documentId, input.ordinal, text(input.content, 'KNOWLEDGE_CHUNK_CONTENT'), input.contentHash ?? contentHash(input.content), input.tokenCount ?? null, JSON.stringify(input.metadata ?? {})]); output.push(mapChunk(result.rows[0]!)) } return output }) }
  async upsertEmbedding(workspaceId: string, input: KnowledgeEmbeddingInput): Promise<KnowledgeEmbedding> { const scope = requireWorkspaceScope(workspaceId); if (!input.embedding.length || input.embedding.some(item => !Number.isFinite(item))) throw new Error('KNOWLEDGE_EMBEDDING_INVALID'); return withWorkspaceTransaction(this.pool, scope, async client => { const result = await client.query<Row>(`INSERT INTO knowledge_embeddings (id,workspace_id,document_id,chunk_id,embedding,embedding_model,embedding_version,vector_metadata,index_state) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9) ON CONFLICT (workspace_id,chunk_id,embedding_model,embedding_version) DO UPDATE SET embedding=EXCLUDED.embedding,vector_metadata=EXCLUDED.vector_metadata,index_state=EXCLUDED.index_state,updated_at=now() RETURNING *`, [input.id ?? `knowledge_embedding_${randomUUID()}`, scope, input.documentId, input.chunkId, JSON.stringify(input.embedding), input.embeddingModel, input.embeddingVersion, JSON.stringify(input.vectorMetadata ?? {}), input.indexState ?? 'queued']); return mapEmbedding(result.rows[0]!) }) }
  async transitionIndexState(workspaceId: string, documentId: string, state: KnowledgeIndexState, reason = ''): Promise<KnowledgeDocument> { const scope = requireWorkspaceScope(workspaceId); assertState(state); return withWorkspaceTransaction(this.pool, scope, async client => { const result = await client.query<Row>(`UPDATE knowledge_documents SET index_state=$3,index_error=$4,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING ${documentProjection}`, [scope, documentId, state, state === 'failed' ? reason : null]); if (!result.rows[0]) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND'); await client.query(`INSERT INTO knowledge_index_events (id,workspace_id,document_id,operation,previous_state,next_state,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [`knowledge_index_event_${randomUUID()}`, scope, documentId, state, null, state, reason]); return mapDocument(result.rows[0]!) }) }
  async rebuildIndex(workspaceId: string, documentId?: string, reason = 'rebuild requested'): Promise<number> { const scope = requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, scope, async client => { const result = await client.query<Row>(`UPDATE knowledge_documents SET index_state='queued',index_error=NULL,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND index_state <> 'deleted' AND ($2::text IS NULL OR id=$2) RETURNING id`, [scope, documentId ?? null]); for (const row of result.rows) await client.query(`INSERT INTO knowledge_index_events (id,workspace_id,document_id,operation,previous_state,next_state,reason) VALUES ($1,$2,$3,'rebuild','stale','queued',$4)`, [`knowledge_index_event_${randomUUID()}`, scope, row.id, reason]); return result.rows.length }) }
  async deleteDocument(workspaceId: string, documentId: string, reason = 'document deleted'): Promise<KnowledgeDeletionProof> { const scope = requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, scope, async client => { const document = await client.query<Row>(`SELECT id,index_state FROM knowledge_documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [scope, documentId]); if (!document.rows[0]) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND'); const counts = await client.query<{ chunks: number; embeddings: number }>(`SELECT (SELECT count(*)::int FROM knowledge_chunks WHERE workspace_id=$1 AND document_id=$2) AS chunks,(SELECT count(*)::int FROM knowledge_embeddings WHERE workspace_id=$1 AND document_id=$2) AS embeddings`, [scope, documentId]); const chunksDeleted = Number(counts.rows[0]?.chunks ?? 0); const embeddingsDeleted = Number(counts.rows[0]?.embeddings ?? 0); const chunkIds = await client.query<{ id: string }>(`SELECT id FROM knowledge_chunks WHERE workspace_id=$1 AND document_id=$2 ORDER BY id`, [scope, documentId]); const embeddingIds = await client.query<{ id: string }>(`SELECT id FROM knowledge_embeddings WHERE workspace_id=$1 AND document_id=$2 ORDER BY id`, [scope, documentId]); const deletionDigest = digest({ scope, documentId, chunks: chunkIds.rows.map(item => item.id), embeddings: embeddingIds.rows.map(item => item.id) }); await client.query(`DELETE FROM knowledge_chunks WHERE workspace_id=$1 AND document_id=$2`, [scope, documentId]); await client.query(`UPDATE knowledge_documents SET index_state='deleted',index_error=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`, [scope, documentId, reason]); const result = await client.query<Row>(`INSERT INTO knowledge_deletion_proofs (id,workspace_id,document_id,chunks_deleted,embeddings_deleted,deletion_digest) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [`knowledge_deletion_${randomUUID()}`, scope, documentId, chunksDeleted, embeddingsDeleted, deletionDigest]); await client.query(`INSERT INTO knowledge_index_events (id,workspace_id,document_id,operation,previous_state,next_state,reason) VALUES ($1,$2,$3,'deleted',$4,'deleted',$5)`, [`knowledge_index_event_${randomUUID()}`, scope, documentId, document.rows[0].index_state, reason]); return { id: result.rows[0]!.id, workspaceId: result.rows[0]!.workspace_id, documentId: result.rows[0]!.document_id, deletedAt: iso(result.rows[0]!.deleted_at), chunksDeleted: Number(result.rows[0]!.chunks_deleted), embeddingsDeleted: Number(result.rows[0]!.embeddings_deleted), deletionDigest: result.rows[0]!.deletion_digest } }) }
  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]> { const scope = requireWorkspaceScope(input.workspaceId); const limit = Math.min(Math.max(input.limit ?? 20, 1), 100); return withWorkspaceTransaction(this.pool, scope, async client => { const values: unknown[] = [scope]; const where = [`d.workspace_id=$1`, `d.index_state='ready'`, `d.approval_status='approved'`, `d.rights_status='cleared'`]; if (input.productId) { values.push(input.productId); where.push(`d.product_id=$${values.length}`) } if (input.skuId) { values.push(input.skuId); where.push(`d.sku_id=$${values.length}`) } if (input.knowledgeTypes?.length) { values.push(input.knowledgeTypes); where.push(`d.knowledge_type = ANY($${values.length}::text[])`) } const terms = input.query?.trim().toLocaleLowerCase() ?? ''; // With an embedding, lexical matching is only a ranking signal. Applying ILIKE here would discard semantically relevant documents before the JSONB vectors are scored. Keep the SQL pre-filter only for lexical-only searches.
      if (input.platform?.trim()) { values.push(input.platform.trim()); where.push(`EXISTS (SELECT 1 FROM products p WHERE p.workspace_id=d.workspace_id AND p.id=d.product_id AND p.platform=$${values.length})`) }
      if (input.accountId?.trim()) { values.push(input.accountId.trim()); where.push(`EXISTS (SELECT 1 FROM products p WHERE p.workspace_id=d.workspace_id AND p.id=d.product_id AND p.platform_account_id=$${values.length})`) }
      if (input.storeName?.trim()) { values.push(input.storeName.trim()); where.push(`EXISTS (SELECT 1 FROM products p WHERE p.workspace_id=d.workspace_id AND p.id=d.product_id AND lower(p.store_name)=lower($${values.length}))`) }
      if (terms && !input.queryEmbedding) { values.push(`%${input.query!.trim()}%`); where.push(`(d.extracted_text ILIKE $${values.length} OR EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.workspace_id=d.workspace_id AND c.document_id=d.id AND c.content ILIKE $${values.length}))`) } // Vector ranking happens in application code because embeddings are stored as JSONB. Fetch the bounded candidate set before ranking so semantic matches are not lost to updated_at ordering.
      const candidateLimit = input.queryEmbedding ? 100 : limit
      values.push(candidateLimit)
      const result = await client.query<Row>(`SELECT ${documentProjection.split(',').map(column => `d.${column.trim()}`).join(',')} FROM knowledge_documents d WHERE ${where.join(' AND ')} ORDER BY d.updated_at DESC,d.id LIMIT $${values.length}`, values)
      const output: KnowledgeSearchResult[] = []
      for (const row of result.rows) {
        const chunks = await client.query<Row>(`SELECT * FROM knowledge_chunks WHERE workspace_id=$1 AND document_id=$2 ORDER BY ordinal`, [scope, row.id])
        const embeddings = input.queryEmbedding
          ? await client.query<Row>(`SELECT * FROM knowledge_embeddings WHERE workspace_id=$1 AND document_id=$2 AND index_state='ready'`, [scope, row.id])
          : { rows: [] as Row[] }
        const lexical = terms
          ? (String(row.extracted_text ?? '').toLocaleLowerCase().includes(terms) ? 1 : chunks.rows.some(chunk => String(chunk.content ?? '').toLocaleLowerCase().includes(terms)) ? .5 : 0)
          : 0
        const vector = input.queryEmbedding
          ? Math.max(...embeddings.rows.map(embedding => vectorScore(input.queryEmbedding!, json(embedding.embedding, []))), 0)
          : 0
        output.push({ document: mapDocument(row), chunks: chunks.rows.map(mapChunk), score: Math.max(lexical, vector) })
      }
      return output.sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id)).slice(0, limit)
    }) }
}
