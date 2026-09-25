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
  expectedDocumentRevision: number
  expectedDocumentContentHash: string
  expectedChunkContentHash: string
  embedding: readonly number[]
  embeddingModel: string
  embeddingVersion: string
  vectorMetadata?: Record<string, unknown>
  indexState?: KnowledgeIndexState
}

export interface KnowledgeEmbedding extends Omit<KnowledgeEmbeddingInput, 'embedding' | 'vectorMetadata' | 'indexState' | 'expectedDocumentRevision' | 'expectedDocumentContentHash' | 'expectedChunkContentHash'> {
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
  /** Batch form of `productId`: a caller that needs the same bounded result for
   * a whole page of products issues one call instead of one call per product.
   * Every other filter is shared by the whole batch, and `limit` (plus the
   * 100-candidate embedding cap) stays a *per product* bound, so the response is
   * exactly what `productIds.length` single-product calls would have returned,
   * concatenated in the order of this array. Only sound when `platform`,
   * `accountId`, `storeName`, `skuId`, `query`, `knowledgeTypes` and
   * `queryEmbedding` are equal for every listed product; group a page by those
   * values first. Both forms are a conjunction, so passing `productId` and
   * `productIds` intersects them. An empty array scopes to no product and
   * returns no result (fail closed) instead of falling back to the workspace. */
  productIds?: readonly string[]
  skuId?: string
  knowledgeTypes?: readonly KnowledgeType[]
  limit?: number
  queryEmbedding?: readonly number[]
}

export interface KnowledgeDocumentFilters {
  /** Point read: takes precedence over `limit` and reads at most one row. */
  id?: string
  productId?: string
  /** Batch form of `productId`, ANDed with it. An empty array matches nothing. */
  productIds?: readonly string[]
  skuId?: string
  indexState?: KnowledgeIndexState
  knowledgeType?: KnowledgeType
  limit?: number
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

export interface KnowledgeGenerationExpectedDocument {
  documentId: string
  revision: number
  /** SHA-256 of the exact extracted text frozen into the generation input. */
  contentSha256: string
}

export interface KnowledgeGenerationClaimInput {
  workspaceId: string
  claimId?: string
  eventId: string
  aggregateId: string
  taskId: string
  logicalAttempt: number
  providerAttemptId: string
  providerAttemptKey: string
  requestBodySha256: string
  requestNonce: string
  productId: string
  contextHash: string
  expectedDocuments: readonly KnowledgeGenerationExpectedDocument[]
}

export interface KnowledgeGenerationClaimResult {
  claimed: boolean
  claimId?: string
  state?: 'claimed' | 'provider_started' | 'outcome_unknown' | 'completed' | 'rejected'
  claimedAt?: string
  reason?: 'snapshot_changed' | 'active_claim' | 'attempt_conflict'
}

export interface KnowledgeGenerationClaimSettlement {
  workspaceId: string
  claimId: string
  providerAttemptId: string
  providerAttemptKey: string
  requestBodySha256: string
  requestNonce: string
  to: 'provider_started' | 'outcome_unknown' | 'completed' | 'rejected'
}

export interface KnowledgeRepository {
  createAsset(input: KnowledgeAssetInput): Promise<KnowledgeAsset>
  getAsset(workspaceId: string, assetId: string): Promise<KnowledgeAsset | undefined>
  updateAsset(workspaceId: string, assetId: string, patch: { name?: string; content?: unknown; approvalStatus?: KnowledgeApprovalStatus; rightsStatus?: KnowledgeRightsStatus; indexState?: KnowledgeIndexState; indexError?: string }): Promise<KnowledgeAsset>
  bindAsset(input: KnowledgeAssetBindingInput): Promise<KnowledgeAssetBinding>
  createDocument(input: KnowledgeDocumentInput): Promise<KnowledgeDocument>
  /** `filters.id` is a point read (LIMIT 1); `filters.limit` bounds the page;
   * omitting both keeps the historical unbounded read. `filters.productIds` is
   * the batch form of `filters.productId`. */
  listDocuments(workspaceId: string, filters?: KnowledgeDocumentFilters): Promise<KnowledgeDocument[]>
  listChunks(workspaceId: string, documentId: string): Promise<KnowledgeChunk[]>
  replaceChunks(workspaceId: string, documentId: string, chunks: readonly KnowledgeChunkInput[]): Promise<KnowledgeChunk[]>
  upsertEmbedding(workspaceId: string, input: KnowledgeEmbeddingInput): Promise<KnowledgeEmbedding>
  transitionIndexState(workspaceId: string, documentId: string, state: KnowledgeIndexState, reason?: string): Promise<KnowledgeDocument>
  transitionQueuedIndexState(workspaceId: string, documentId: string, state: 'ready' | 'failed', expected: { revision: number; contentHash: string }, reason?: string): Promise<KnowledgeDocument | undefined>
  rebuildIndex(workspaceId: string, documentId?: string, reason?: string): Promise<number>
  deleteDocument(workspaceId: string, documentId: string, reason?: string): Promise<KnowledgeDeletionProof>
  claimGenerationKnowledge(input: KnowledgeGenerationClaimInput): Promise<KnowledgeGenerationClaimResult>
  settleGenerationKnowledgeClaim(input: KnowledgeGenerationClaimSettlement): Promise<{ state: KnowledgeGenerationClaimResult['state']; claimedAt: string; updatedAt: string } | undefined>
  search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]>
}

const clone = <T>(value: T): T => structuredClone(value)
/** Groups batched child rows by their owning column without reordering them. */
const groupRowsBy = (rows: readonly Row[], column: string): Map<string, Row[]> => {
  const grouped = new Map<string, Row[]>()
  for (const row of rows) {
    const key = String(row[column])
    const existing = grouped.get(key)
    if (existing) existing.push(row)
    else grouped.set(key, [row])
  }
  return grouped
}
const groupByDocument = (rows: readonly Row[]): Map<string, Row[]> => groupRowsBy(rows, 'document_id')
/** One ranking rule for both the single-product and the batch form, so a batch
 * response is the concatenation of the per-product responses it replaces. */
const rankResults = (results: readonly KnowledgeSearchResult[], limit: number): KnowledgeSearchResult[] =>
  [...results].sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id)).slice(0, limit)
/** `undefined` keeps the historical unbounded read. */
const listLimit = (value: number | undefined): number | undefined => {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('KNOWLEDGE_LIST_LIMIT_INVALID')
  return value
}
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
  private readonly generationClaims = new Map<string, { input: KnowledgeGenerationClaimInput; state: NonNullable<KnowledgeGenerationClaimResult['state']>; claimedAt: string; updatedAt: string }>()

  private assertGenerationMutable(workspaceId: string, productId: string | undefined) {
    if (productId && [...this.generationClaims.values()].some(item => item.input.workspaceId === workspaceId && item.input.productId === productId && ['claimed', 'provider_started', 'outcome_unknown'].includes(item.state))) throw new Error('KNOWLEDGE_GENERATION_ACTIVE')
  }

  async createAsset(input: KnowledgeAssetInput): Promise<KnowledgeAsset> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    this.assertGenerationMutable(workspaceId, input.productId)
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
    this.assertGenerationMutable(scope, current.productId)
    for (const document of this.documents.values()) if (document.workspaceId === scope && document.knowledgeAssetId === assetId) this.assertGenerationMutable(scope, document.productId)
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
    this.assertGenerationMutable(workspaceId, input.productId)
    const key = `${workspaceId}:${knowledgeAssetId}:${input.sourceAssetId ?? ''}:${input.productId ?? ''}:${input.skuId ?? ''}`
    const existing = this.bindings.get(key); if (existing) return clone(existing)
    const timestamp = now(); const binding: KnowledgeAssetBinding = { ...input, workspaceId, knowledgeAssetId, bindingId: `knowledge_binding_${randomUUID()}`, sourceVersion: positive(input.sourceVersion, 'KNOWLEDGE_SOURCE_VERSION'), bindingType: input.bindingType ?? 'spreadsheet_facts', approvalStatus: input.approvalStatus ?? 'pending', createdAt: timestamp, updatedAt: timestamp }
    this.bindings.set(key, binding); return clone(binding)
  }
  async createDocument(input: KnowledgeDocumentInput): Promise<KnowledgeDocument> {
    const workspaceId = requireWorkspaceScope(input.workspaceId); const id = input.id ?? `knowledge_document_${randomUUID()}`
    this.assertGenerationMutable(workspaceId, input.productId)
    if (input.knowledgeAssetId) { const asset = this.assets.get(input.knowledgeAssetId); if (!asset || asset.workspaceId !== workspaceId) throw new Error('KNOWLEDGE_ASSET_NOT_FOUND') }
    const existing = this.documents.get(id); if (existing) {
      if (existing.indexState === 'deleted') throw new Error('KNOWLEDGE_DOCUMENT_DELETED')
      const nextHash = text(input.contentHash, 'KNOWLEDGE_CONTENT_HASH')
      const nextMetadata = clone(input.sourceMetadata ?? {})
      if (existing.extractedText === input.extractedText && existing.contentHash === nextHash && JSON.stringify(existing.sourceMetadata) === JSON.stringify(nextMetadata)) return clone(existing)
      const updated = { ...existing, extractedText: input.extractedText, contentHash: nextHash, sourceMetadata: nextMetadata, approvalStatus: 'pending' as const, rightsStatus: 'unknown' as const, indexState: 'queued' as const, indexError: undefined, revision: existing.revision + 1, updatedAt: now() }
      this.documents.set(id, updated)
      // Embeddings belong to the old content revision. Reapproval must not
      // revive vectors generated from superseded source text.
      for (const embedding of [...this.embeddings.values()]) if (embedding.workspaceId === workspaceId && embedding.documentId === id) this.embeddings.delete(embedding.id)
      return clone(updated)
    }
    const document: KnowledgeDocument = { ...input, id, workspaceId, sourceVersion: positive(input.sourceVersion, 'KNOWLEDGE_SOURCE_VERSION'), title: input.title?.trim() ?? '', contentType: input.contentType?.trim() || 'text/plain', contentHash: text(input.contentHash, 'KNOWLEDGE_CONTENT_HASH'), extractedText: input.extractedText, sourceMetadata: clone(input.sourceMetadata ?? {}), approvalStatus: input.approvalStatus ?? 'pending', rightsStatus: input.rightsStatus ?? 'unknown', indexState: input.indexState ?? 'queued', revision: 1, createdAt: now(), updatedAt: now() }
    assertState(document.indexState); this.documents.set(id, document); return clone(document)
  }
  async listDocuments(workspaceId: string, filters: KnowledgeDocumentFilters = {}): Promise<KnowledgeDocument[]> { const scope = requireWorkspaceScope(workspaceId); const bound = filters.id ? 1 : listLimit(filters.limit); const rows = [...this.documents.values()].filter(item => item.workspaceId === scope && (!filters.id || item.id === filters.id) && (!filters.productId || item.productId === filters.productId) && (!filters.productIds || (item.productId !== undefined && filters.productIds.includes(item.productId))) && (!filters.skuId || item.skuId === filters.skuId) && (!filters.indexState || item.indexState === filters.indexState) && (!filters.knowledgeType || item.knowledgeType === filters.knowledgeType)).map(clone); return bound === undefined ? rows : rows.slice(0, bound) }
  async listChunks(workspaceId: string, documentId: string): Promise<KnowledgeChunk[]> { const scope = requireWorkspaceScope(workspaceId); return [...this.chunks.values()].filter(item => item.workspaceId === scope && item.documentId === documentId).sort((a, b) => a.ordinal - b.ordinal).map(clone) }
  async replaceChunks(workspaceId: string, documentId: string, chunks: readonly KnowledgeChunkInput[]): Promise<KnowledgeChunk[]> {
    const scope = requireWorkspaceScope(workspaceId); const document = this.documents.get(documentId); if (!document || document.workspaceId !== scope) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND'); if (document.indexState === 'deleted') throw new Error('KNOWLEDGE_DOCUMENT_DELETED')
    this.assertGenerationMutable(scope, document.productId)
    const previous = await this.listChunks(scope, documentId)
    if (previous.length === chunks.length && previous.every((item, index) => item.ordinal === chunks[index]?.ordinal && item.content === chunks[index]?.content && item.contentHash === (chunks[index]?.contentHash ?? contentHash(chunks[index]!.content)) && item.tokenCount === chunks[index]?.tokenCount && JSON.stringify(item.metadata) === JSON.stringify(chunks[index]?.metadata ?? {}))) return previous
    for (const chunk of [...this.chunks.values()]) if (chunk.workspaceId === scope && chunk.documentId === documentId) { this.chunks.delete(chunk.id); for (const embedding of [...this.embeddings.values()]) if (embedding.chunkId === chunk.id) this.embeddings.delete(embedding.id) }
    const output = chunks.map(input => { if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) throw new Error('KNOWLEDGE_CHUNK_ORDINAL_INVALID'); const result: KnowledgeChunk = { ...input, id: input.id ?? `knowledge_chunk_${randomUUID()}`, workspaceId: scope, documentId, content: text(input.content, 'KNOWLEDGE_CHUNK_CONTENT'), contentHash: input.contentHash ?? contentHash(input.content), metadata: clone(input.metadata ?? {}), createdAt: now() }; this.chunks.set(result.id, result); return result })
    this.documents.set(documentId, { ...document, approvalStatus: 'pending', rightsStatus: 'unknown', indexState: 'queued', indexError: undefined, revision: document.revision + 1, updatedAt: now() })
    return clone(output)
  }
  async upsertEmbedding(workspaceId: string, input: KnowledgeEmbeddingInput): Promise<KnowledgeEmbedding> { const scope = requireWorkspaceScope(workspaceId); const document = this.documents.get(input.documentId); const chunk = this.chunks.get(input.chunkId); if (!document || document.workspaceId !== scope || !chunk || chunk.workspaceId !== scope || chunk.documentId !== input.documentId) throw new Error('KNOWLEDGE_EMBEDDING_SCOPE_INVALID'); this.assertGenerationMutable(scope, document.productId); if (document.revision !== input.expectedDocumentRevision || document.contentHash !== input.expectedDocumentContentHash || chunk.contentHash !== input.expectedChunkContentHash || document.approvalStatus !== 'approved' || document.rightsStatus !== 'cleared' || document.indexState === 'deleted') throw new Error('KNOWLEDGE_EMBEDDING_STALE'); if (!input.embedding.length || input.embedding.some(item => !Number.isFinite(item))) throw new Error('KNOWLEDGE_EMBEDDING_INVALID'); const existing = [...this.embeddings.values()].find(item => item.workspaceId === scope && item.chunkId === input.chunkId && item.embeddingModel === input.embeddingModel && item.embeddingVersion === input.embeddingVersion); const result: KnowledgeEmbedding = { id: existing?.id ?? input.id ?? `knowledge_embedding_${randomUUID()}`, workspaceId: scope, documentId: input.documentId, chunkId: input.chunkId, embedding: [...input.embedding], embeddingModel: input.embeddingModel, embeddingVersion: input.embeddingVersion, vectorMetadata: clone(input.vectorMetadata ?? {}), indexState: input.indexState ?? 'queued', createdAt: existing?.createdAt ?? now(), updatedAt: now() }; assertState(result.indexState); this.embeddings.set(result.id, result); return clone(result) }
  async transitionIndexState(workspaceId: string, documentId: string, state: KnowledgeIndexState, reason = ''): Promise<KnowledgeDocument> { const scope = requireWorkspaceScope(workspaceId); assertState(state); const current = this.documents.get(documentId); if (!current || current.workspaceId !== scope) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND'); this.assertGenerationMutable(scope, current.productId); const next = { ...current, indexState: state, indexError: state === 'failed' ? reason : undefined, revision: current.revision + 1, updatedAt: now() }; this.documents.set(documentId, next); return clone(next) }
  async transitionQueuedIndexState(workspaceId: string, documentId: string, state: 'ready' | 'failed', expected: { revision: number; contentHash: string }, reason = ''): Promise<KnowledgeDocument | undefined> { const scope = requireWorkspaceScope(workspaceId); const current = this.documents.get(documentId); if (!current || current.workspaceId !== scope || current.indexState !== 'queued' || current.revision !== expected.revision || current.contentHash !== expected.contentHash || (state === 'ready' && (current.approvalStatus !== 'approved' || current.rightsStatus !== 'cleared'))) return undefined; this.assertGenerationMutable(scope, current.productId); const next = { ...current, indexState: state, indexError: state === 'failed' ? reason : undefined, revision: current.revision + 1, updatedAt: now() }; this.documents.set(documentId, next); return clone(next) }
  async rebuildIndex(workspaceId: string, documentId?: string, _reason = 'rebuild requested'): Promise<number> { const scope = requireWorkspaceScope(workspaceId); const targets = [...this.documents.values()].filter(item => item.workspaceId === scope && (!documentId || item.id === documentId) && item.indexState !== 'deleted'); for (const item of targets) this.assertGenerationMutable(scope, item.productId); for (const item of targets) { item.indexState = 'queued'; item.revision += 1; item.updatedAt = now() } return targets.length }
  async deleteDocument(workspaceId: string, documentId: string, _reason = 'document deleted'): Promise<KnowledgeDeletionProof> { const scope = requireWorkspaceScope(workspaceId); const document = this.documents.get(documentId); if (!document || document.workspaceId !== scope) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND'); this.assertGenerationMutable(scope, document.productId); const chunks = [...this.chunks.values()].filter(item => item.workspaceId === scope && item.documentId === documentId); const embeddings = [...this.embeddings.values()].filter(item => item.workspaceId === scope && item.documentId === documentId); chunks.forEach(item => this.chunks.delete(item.id)); embeddings.forEach(item => this.embeddings.delete(item.id)); document.indexState = 'deleted'; document.revision += 1; document.updatedAt = now(); const proof: KnowledgeDeletionProof = { id: `knowledge_deletion_${randomUUID()}`, workspaceId: scope, documentId, deletedAt: now(), chunksDeleted: chunks.length, embeddingsDeleted: embeddings.length, deletionDigest: digest({ scope, documentId, chunks: chunks.map(item => item.id), embeddings: embeddings.map(item => item.id) }) }; this.proofs.set(proof.id, proof); return clone(proof) }
  async claimGenerationKnowledge(input: KnowledgeGenerationClaimInput): Promise<KnowledgeGenerationClaimResult> {
    const scope = requireWorkspaceScope(input.workspaceId)
    if (!input.productId.trim() || !input.eventId.trim() || !input.providerAttemptId.trim() || input.expectedDocuments.length > 8) throw new Error('KNOWLEDGE_GENERATION_CLAIM_INVALID')
    const claimId = input.claimId ?? `knowledge_claim_${randomUUID()}`
    const key = `${scope}:${input.eventId}:${input.logicalAttempt}:${input.providerAttemptId}`
    const existing = this.generationClaims.get(key)
    if (existing) {
      const { claimId: _storedClaimId, ...storedInput } = existing.input
      const { claimId: _requestedClaimId, ...requestedInput } = input
      if (JSON.stringify(storedInput) !== JSON.stringify(requestedInput)) return { claimed: false, reason: 'attempt_conflict' }
      return { claimed: true, claimId: existing.input.claimId, state: existing.state, claimedAt: existing.claimedAt }
    }
    if ([...this.generationClaims.values()].some(item => item.input.workspaceId === scope && item.input.productId === input.productId && ['claimed', 'provider_started', 'outcome_unknown'].includes(item.state))) return { claimed: false, reason: 'active_claim' }
    const productDocuments = [...this.documents.values()].filter(document => document.workspaceId === scope
      && document.productId === input.productId && document.indexState !== 'deleted')
    if (productDocuments.some(document => document.indexState !== 'ready'
      || document.approvalStatus !== 'approved' || document.rightsStatus !== 'cleared')) return { claimed: false, reason: 'snapshot_changed' }
    const selected = productDocuments.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)
      || left.id.localeCompare(right.id)).slice(0, 8)
    if (selected.length !== input.expectedDocuments.length
      || new Set(input.expectedDocuments.map(item => item.documentId)).size !== input.expectedDocuments.length) {
      return { claimed: false, reason: 'snapshot_changed' }
    }
    const selectedById = new Map(selected.map(document => [document.id, document]))
    const valid = input.expectedDocuments.every(expected => {
      const document = selectedById.get(expected.documentId)
      const chunks = document && [...this.chunks.values()].filter(chunk => chunk.workspaceId === scope && chunk.documentId === document.id)
        .sort((left, right) => left.ordinal - right.ordinal)
      const frozenContent = chunks?.length ? chunks.map(chunk => chunk.content).join('\n') : document?.extractedText
      return document && document.revision === expected.revision
        && contentHash(frozenContent ?? '') === expected.contentSha256
        && (!document.expiresAt || Date.parse(document.expiresAt) > Date.now())
    })
    if (!valid) return { claimed: false, reason: 'snapshot_changed' }
    const claimedAt = now()
    this.generationClaims.set(key, { input: clone({ ...input, claimId }), state: 'claimed', claimedAt, updatedAt: claimedAt })
    return { claimed: true, claimId, state: 'claimed', claimedAt }
  }
  async settleGenerationKnowledgeClaim(input: KnowledgeGenerationClaimSettlement): Promise<{ state: KnowledgeGenerationClaimResult['state']; claimedAt: string; updatedAt: string } | undefined> {
    const scope = requireWorkspaceScope(input.workspaceId)
    const claim = [...this.generationClaims.values()].find(item => item.input.workspaceId === scope && item.input.claimId === input.claimId
      && item.input.providerAttemptId === input.providerAttemptId && item.input.providerAttemptKey === input.providerAttemptKey
      && item.input.requestBodySha256 === input.requestBodySha256 && item.input.requestNonce === input.requestNonce)
    if (!claim) return undefined
    if (claim.state === input.to) return { state: claim.state, claimedAt: claim.claimedAt, updatedAt: claim.updatedAt }
    const allowed = (claim.state === 'claimed' && ['provider_started', 'rejected'].includes(input.to))
      || (claim.state === 'provider_started' && ['outcome_unknown', 'completed', 'rejected'].includes(input.to))
    if (claim.state !== input.to && !allowed) return undefined
    claim.state = input.to
    claim.updatedAt = now()
    return { state: claim.state, claimedAt: claim.claimedAt, updatedAt: claim.updatedAt }
  }
  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]> {
    const scope = requireWorkspaceScope(input.workspaceId)
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
    const terms = (input.query ?? '').trim().toLocaleLowerCase()
    const batch = input.productIds
    const rank = (documents: readonly KnowledgeDocument[]): KnowledgeSearchResult[] => rankResults(documents.map(document => {
      const chunks = [...this.chunks.values()].filter(chunk => chunk.workspaceId === scope && chunk.documentId === document.id)
      const embeddings = [...this.embeddings.values()].filter(embedding => embedding.workspaceId === scope && embedding.documentId === document.id && embedding.indexState === 'ready')
      const lexical = terms ? (document.extractedText.toLocaleLowerCase().includes(terms) ? 1 : chunks.some(chunk => chunk.content.toLocaleLowerCase().includes(terms)) ? .5 : 0) : 0
      const score = input.queryEmbedding ? Math.max(lexical, ...embeddings.map(embedding => vectorScore(input.queryEmbedding!, embedding.embedding)), 0) : lexical
      return { document: clone(document), chunks: clone(chunks), score }
    }).filter(item => !terms || item.score > 0), limit)
    const candidates = [...this.documents.values()].filter(item => item.workspaceId === scope && item.indexState === 'ready' && item.approvalStatus === 'approved' && item.rightsStatus === 'cleared' && (!input.productId || item.productId === input.productId) && (!batch || (item.productId !== undefined && batch.includes(item.productId))) && (!input.skuId || item.skuId === input.skuId) && (!input.knowledgeTypes?.length || input.knowledgeTypes.includes(item.knowledgeType)))
    if (!batch) return rank(candidates).map(clone)
    const byProduct = new Map<string, KnowledgeDocument[]>()
    for (const document of candidates) { const key = document.productId!; const bucket = byProduct.get(key); if (bucket) bucket.push(document); else byProduct.set(key, [document]) }
    return batch.flatMap(productId => rank(byProduct.get(productId) ?? [])).map(clone)
  }
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
  async claimGenerationKnowledge(input: KnowledgeGenerationClaimInput): Promise<KnowledgeGenerationClaimResult> {
    const scope = requireWorkspaceScope(input.workspaceId)
    if (!input.productId.trim() || !input.eventId.trim() || !input.aggregateId.trim() || !input.taskId.trim()
      || !input.providerAttemptId.trim() || !input.providerAttemptKey.trim()
      || !/^[a-f0-9]{64}$/u.test(input.requestBodySha256) || !/^[a-f0-9]{64}$/u.test(input.contextHash)
      || !/^[0-9a-f-]{36}$/iu.test(input.requestNonce) || !Number.isSafeInteger(input.logicalAttempt) || input.logicalAttempt < 1
      || input.expectedDocuments.length > 8
      || new Set(input.expectedDocuments.map(document => document.documentId)).size !== input.expectedDocuments.length
      || input.expectedDocuments.some(document => !document.documentId.trim() || !Number.isSafeInteger(document.revision) || document.revision < 1 || !/^[a-f0-9]{64}$/u.test(document.contentSha256))) {
      throw new Error('KNOWLEDGE_GENERATION_CLAIM_INVALID')
    }
    const claimId = input.claimId ?? `knowledge_claim_${randomUUID()}`
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const expected = input.expectedDocuments.map(document => ({ document_id: document.documentId, revision: document.revision, content_sha256: document.contentSha256 }))
      const result = await client.query<Row>(`SELECT * FROM claim_knowledge_generation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`, [
        scope, claimId, input.eventId, input.aggregateId, input.taskId, input.logicalAttempt, input.providerAttemptId,
        input.providerAttemptKey, input.requestBodySha256, input.requestNonce, input.productId, input.contextHash, JSON.stringify(expected),
      ])
      const row = result.rows[0]
      if (!row) return { claimed: false, reason: 'snapshot_changed' }
      if (row.refusal) return { claimed: false, reason: row.refusal as KnowledgeGenerationClaimResult['reason'] }
      return { claimed: true, claimId: row.claim_id, state: row.claim_state, claimedAt: iso(row.claimed_at) }
    })
  }
  async settleGenerationKnowledgeClaim(input: KnowledgeGenerationClaimSettlement): Promise<{ state: KnowledgeGenerationClaimResult['state']; claimedAt: string; updatedAt: string } | undefined> {
    const scope = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, scope, async client => {
      const result = await client.query<Row>(`SELECT * FROM settle_knowledge_generation_claim($1,$2,$3,$4,$5,$6,$7)`, [scope, input.claimId, input.providerAttemptId, input.providerAttemptKey, input.requestBodySha256, input.requestNonce, input.to])
      const row = result.rows[0]
      return row ? { state: row.claim_state, claimedAt: iso(row.claimed_at), updatedAt: iso(row.updated_at) } : undefined
    })
  }
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
  async createDocument(input: KnowledgeDocumentInput): Promise<KnowledgeDocument> { const scope = requireWorkspaceScope(input.workspaceId); const id = input.id ?? `knowledge_document_${randomUUID()}`; return withWorkspaceTransaction(this.pool, scope, async client => { const result = await client.query<Row>(`INSERT INTO knowledge_documents (id,workspace_id,knowledge_asset_id,source_asset_id,source_version,brand_id,product_id,sku_id,knowledge_type,title,content_type,content_hash,extracted_text,source_metadata,approval_status,rights_status,rule_snapshot_version,embedding_model,embedding_version,index_state,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21::timestamptz) ON CONFLICT (workspace_id,id) DO UPDATE SET extracted_text=EXCLUDED.extracted_text,content_hash=EXCLUDED.content_hash,source_metadata=EXCLUDED.source_metadata,approval_status='pending',rights_status='unknown',index_state='queued',index_error=NULL,updated_at=now(),revision=knowledge_documents.revision+1 WHERE knowledge_documents.index_state <> 'deleted' AND (knowledge_documents.extracted_text IS DISTINCT FROM EXCLUDED.extracted_text OR knowledge_documents.content_hash IS DISTINCT FROM EXCLUDED.content_hash OR knowledge_documents.source_metadata IS DISTINCT FROM EXCLUDED.source_metadata) RETURNING ${documentProjection}`, [id, scope, input.knowledgeAssetId ?? null, input.sourceAssetId ?? null, positive(input.sourceVersion, 'KNOWLEDGE_SOURCE_VERSION'), input.brandId ?? null, input.productId ?? null, input.skuId ?? null, input.knowledgeType, input.title?.trim() ?? '', input.contentType?.trim() || 'text/plain', text(input.contentHash, 'KNOWLEDGE_CONTENT_HASH'), input.extractedText, JSON.stringify(input.sourceMetadata ?? {}), input.approvalStatus ?? 'pending', input.rightsStatus ?? 'unknown', input.ruleSnapshotVersion ?? null, input.embeddingModel ?? null, input.embeddingVersion ?? null, input.indexState ?? 'queued', input.expiresAt ?? null]); if (result.rows[0]) { const updated = mapDocument(result.rows[0]); if (updated.revision > 1) await client.query(`DELETE FROM knowledge_embeddings WHERE workspace_id=$1 AND document_id=$2`, [scope, id]); return updated }; const existing = await client.query<Row>(`SELECT ${documentProjection} FROM knowledge_documents WHERE workspace_id=$1 AND id=$2`, [scope, id]); if (!existing.rows[0] || existing.rows[0].index_state === 'deleted') throw new Error('KNOWLEDGE_DOCUMENT_DELETED'); return mapDocument(existing.rows[0]) }) }
  async listDocuments(workspaceId: string, filters: KnowledgeDocumentFilters = {}): Promise<KnowledgeDocument[]> { const scope = requireWorkspaceScope(workspaceId); const bound = filters.id ? 1 : listLimit(filters.limit); return withWorkspaceTransaction(this.pool, scope, async client => { const values: unknown[] = [scope]; const where = ['workspace_id=$1']; for (const [column, value] of [['id', filters.id], ['product_id', filters.productId], ['sku_id', filters.skuId], ['index_state', filters.indexState], ['knowledge_type', filters.knowledgeType] ] as const) if (value) { values.push(value); where.push(`${column}=$${values.length}`) } // The batch form is ANDed with the single value, so an empty array stays an empty scope. Absent, the statement below is byte-identical to the historical one.
    if (filters.productIds !== undefined) { values.push([...filters.productIds]); where.push(`product_id = ANY($${values.length}::text[])`) } if (bound !== undefined) values.push(bound); const result = await client.query<Row>(`SELECT ${documentProjection} FROM knowledge_documents WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id${bound === undefined ? '' : ` LIMIT $${values.length}`}`, values); return result.rows.map(mapDocument) }) }
  async listChunks(workspaceId: string, documentId: string): Promise<KnowledgeChunk[]> { const scope = requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, scope, async client => { const result = await client.query<Row>('SELECT * FROM knowledge_chunks WHERE workspace_id=$1 AND document_id=$2 ORDER BY ordinal,id', [scope, documentId]); return result.rows.map(mapChunk) }) }
  async replaceChunks(workspaceId: string, documentId: string, chunks: readonly KnowledgeChunkInput[]): Promise<KnowledgeChunk[]> { const scope = requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, scope, async client => { const document = await client.query<Row>(`SELECT index_state FROM knowledge_documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [scope, documentId]); if (!document.rows[0]) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND'); if (document.rows[0].index_state === 'deleted') throw new Error('KNOWLEDGE_DOCUMENT_DELETED'); const oldRows = await client.query<Row>(`SELECT * FROM knowledge_chunks WHERE workspace_id=$1 AND document_id=$2 ORDER BY ordinal,id`, [scope, documentId]); const previous = oldRows.rows.map(mapChunk); if (previous.length === chunks.length && previous.every((item, index) => item.ordinal === chunks[index]?.ordinal && item.content === chunks[index]?.content && item.contentHash === (chunks[index]?.contentHash ?? contentHash(chunks[index]!.content)) && item.tokenCount === chunks[index]?.tokenCount && JSON.stringify(item.metadata) === JSON.stringify(chunks[index]?.metadata ?? {}))) return previous; await client.query(`DELETE FROM knowledge_chunks WHERE workspace_id=$1 AND document_id=$2`, [scope, documentId]); const output: KnowledgeChunk[] = []; for (const input of chunks) { if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0) throw new Error('KNOWLEDGE_CHUNK_ORDINAL_INVALID'); const result = await client.query<Row>(`INSERT INTO knowledge_chunks (id,workspace_id,document_id,ordinal,content,content_hash,token_count,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING *`, [input.id ?? `knowledge_chunk_${randomUUID()}`, scope, documentId, input.ordinal, text(input.content, 'KNOWLEDGE_CHUNK_CONTENT'), input.contentHash ?? contentHash(input.content), input.tokenCount ?? null, JSON.stringify(input.metadata ?? {})]); output.push(mapChunk(result.rows[0]!)) } await client.query(`UPDATE knowledge_documents SET approval_status='pending',rights_status='unknown',index_state='queued',index_error=NULL,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`, [scope, documentId]); return output }) }
  async upsertEmbedding(workspaceId: string, input: KnowledgeEmbeddingInput): Promise<KnowledgeEmbedding> { const scope = requireWorkspaceScope(workspaceId); if (!input.embedding.length || input.embedding.some(item => !Number.isFinite(item))) throw new Error('KNOWLEDGE_EMBEDDING_INVALID'); return withWorkspaceTransaction(this.pool, scope, async client => { const document = await client.query<Row>(`SELECT revision,content_hash,approval_status,rights_status,index_state FROM knowledge_documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [scope, input.documentId]); const row = document.rows[0]; if (!row || Number(row.revision) !== input.expectedDocumentRevision || row.content_hash !== input.expectedDocumentContentHash || row.approval_status !== 'approved' || row.rights_status !== 'cleared' || row.index_state === 'deleted') throw new Error('KNOWLEDGE_EMBEDDING_STALE'); const chunk = await client.query<Row>(`SELECT content_hash FROM knowledge_chunks WHERE workspace_id=$1 AND document_id=$2 AND id=$3`, [scope, input.documentId, input.chunkId]); if (chunk.rows[0]?.content_hash !== input.expectedChunkContentHash) throw new Error('KNOWLEDGE_EMBEDDING_STALE'); const result = await client.query<Row>(`INSERT INTO knowledge_embeddings (id,workspace_id,document_id,chunk_id,embedding,embedding_model,embedding_version,vector_metadata,index_state) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9) ON CONFLICT (workspace_id,chunk_id,embedding_model,embedding_version) DO UPDATE SET embedding=EXCLUDED.embedding,vector_metadata=EXCLUDED.vector_metadata,index_state=EXCLUDED.index_state,updated_at=now() RETURNING *`, [input.id ?? `knowledge_embedding_${randomUUID()}`, scope, input.documentId, input.chunkId, JSON.stringify(input.embedding), input.embeddingModel, input.embeddingVersion, JSON.stringify(input.vectorMetadata ?? {}), input.indexState ?? 'queued']); return mapEmbedding(result.rows[0]!) }) }
  async transitionIndexState(workspaceId: string, documentId: string, state: KnowledgeIndexState, reason = ''): Promise<KnowledgeDocument> { const scope = requireWorkspaceScope(workspaceId); assertState(state); return withWorkspaceTransaction(this.pool, scope, async client => { const result = await client.query<Row>(`UPDATE knowledge_documents SET index_state=$3,index_error=$4,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING ${documentProjection}`, [scope, documentId, state, state === 'failed' ? reason : null]); if (!result.rows[0]) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND'); await client.query(`INSERT INTO knowledge_index_events (id,workspace_id,document_id,operation,previous_state,next_state,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [`knowledge_index_event_${randomUUID()}`, scope, documentId, state, null, state, reason]); return mapDocument(result.rows[0]!) }) }
  async transitionQueuedIndexState(workspaceId: string, documentId: string, state: 'ready' | 'failed', expected: { revision: number; contentHash: string }, reason = ''): Promise<KnowledgeDocument | undefined> { const scope = requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, scope, async client => { const result = await client.query<Row>(`UPDATE knowledge_documents SET index_state=$3,index_error=$4,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND index_state='queued' AND revision=$5 AND content_hash=$6 ${state === 'ready' ? "AND approval_status='approved' AND rights_status='cleared'" : ''} RETURNING ${documentProjection}`, [scope, documentId, state, state === 'failed' ? reason : null, expected.revision, expected.contentHash]); if (!result.rows[0]) return undefined; await client.query(`INSERT INTO knowledge_index_events (id,workspace_id,document_id,operation,previous_state,next_state,reason) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [`knowledge_index_event_${randomUUID()}`, scope, documentId, state, 'queued', state, reason]); return mapDocument(result.rows[0]!) }) }
  /** One statement instead of one event INSERT per rebuilt document: the update
   * is a data-modifying CTE and the audit rows are inserted `INSERT ... SELECT`
   * from its `RETURNING` set, so the event rows are the same rows in the same
   * order with the same `workspace_id` predicate and RLS check. Splitting the
   * write out is not an option: `knowledge_index_events` carries a per-worker
   * audit trail and a rebuild of a large workspace issued one round trip per
   * document inside a single transaction. */
  async rebuildIndex(workspaceId: string, documentId?: string, reason = 'rebuild requested'): Promise<number> { const scope = requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, scope, async client => { const result = await client.query<{ document_id: string }>(`WITH rebuilt AS (UPDATE knowledge_documents SET index_state='queued',index_error=NULL,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND index_state <> 'deleted' AND ($2::text IS NULL OR id=$2) RETURNING id) INSERT INTO knowledge_index_events (id,workspace_id,document_id,operation,previous_state,next_state,reason) SELECT 'knowledge_index_event_'||pg_catalog.gen_random_uuid()::text,$1,rebuilt.id,'rebuild','stale','queued',$3 FROM rebuilt RETURNING document_id`, [scope, documentId ?? null, reason]); return result.rows.length }) }
  async deleteDocument(workspaceId: string, documentId: string, reason = 'document deleted'): Promise<KnowledgeDeletionProof> { const scope = requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, scope, async client => { const document = await client.query<Row>(`SELECT id,index_state FROM knowledge_documents WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [scope, documentId]); if (!document.rows[0]) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND'); const counts = await client.query<{ chunks: number; embeddings: number }>(`SELECT (SELECT count(*)::int FROM knowledge_chunks WHERE workspace_id=$1 AND document_id=$2) AS chunks,(SELECT count(*)::int FROM knowledge_embeddings WHERE workspace_id=$1 AND document_id=$2) AS embeddings`, [scope, documentId]); const chunksDeleted = Number(counts.rows[0]?.chunks ?? 0); const embeddingsDeleted = Number(counts.rows[0]?.embeddings ?? 0); const chunkIds = await client.query<{ id: string }>(`SELECT id FROM knowledge_chunks WHERE workspace_id=$1 AND document_id=$2 ORDER BY id`, [scope, documentId]); const embeddingIds = await client.query<{ id: string }>(`SELECT id FROM knowledge_embeddings WHERE workspace_id=$1 AND document_id=$2 ORDER BY id`, [scope, documentId]); const deletionDigest = digest({ scope, documentId, chunks: chunkIds.rows.map(item => item.id), embeddings: embeddingIds.rows.map(item => item.id) }); await client.query(`DELETE FROM knowledge_chunks WHERE workspace_id=$1 AND document_id=$2`, [scope, documentId]); await client.query(`UPDATE knowledge_documents SET index_state='deleted',index_error=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2`, [scope, documentId, reason]); const result = await client.query<Row>(`INSERT INTO knowledge_deletion_proofs (id,workspace_id,document_id,chunks_deleted,embeddings_deleted,deletion_digest) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [`knowledge_deletion_${randomUUID()}`, scope, documentId, chunksDeleted, embeddingsDeleted, deletionDigest]); await client.query(`INSERT INTO knowledge_index_events (id,workspace_id,document_id,operation,previous_state,next_state,reason) VALUES ($1,$2,$3,'deleted',$4,'deleted',$5)`, [`knowledge_index_event_${randomUUID()}`, scope, documentId, document.rows[0].index_state, reason]); return { id: result.rows[0]!.id, workspaceId: result.rows[0]!.workspace_id, documentId: result.rows[0]!.document_id, deletedAt: iso(result.rows[0]!.deleted_at), chunksDeleted: Number(result.rows[0]!.chunks_deleted), embeddingsDeleted: Number(result.rows[0]!.embeddings_deleted), deletionDigest: result.rows[0]!.deletion_digest } }) }
  async search(input: KnowledgeSearchInput): Promise<KnowledgeSearchResult[]> { const scope = requireWorkspaceScope(input.workspaceId); const limit = Math.min(Math.max(input.limit ?? 20, 1), 100); const batch = input.productIds; return withWorkspaceTransaction(this.pool, scope, async client => { const values: unknown[] = [scope]; const where = [`d.workspace_id=$1`, `d.index_state='ready'`, `d.approval_status='approved'`, `d.rights_status='cleared'`]; if (input.productId) { values.push(input.productId); where.push(`d.product_id=$${values.length}`) } // Batch form: ANDed with the single value, so passing both intersects. Absent, the statement below is byte-identical to the historical one.
      if (batch) { values.push([...batch]); where.push(`d.product_id = ANY($${values.length}::text[])`) }
      if (input.skuId) { values.push(input.skuId); where.push(`d.sku_id=$${values.length}`) } if (input.knowledgeTypes?.length) { values.push(input.knowledgeTypes); where.push(`d.knowledge_type = ANY($${values.length}::text[])`) } const terms = input.query?.trim().toLocaleLowerCase() ?? ''; // With an embedding, lexical matching is only a ranking signal. Applying ILIKE here would discard semantically relevant documents before the JSONB vectors are scored. Keep the SQL pre-filter only for lexical-only searches.
      if (input.platform?.trim()) { values.push(input.platform.trim()); where.push(`EXISTS (SELECT 1 FROM products p WHERE p.workspace_id=d.workspace_id AND p.id=d.product_id AND p.platform=$${values.length})`) }
      if (input.accountId?.trim()) { values.push(input.accountId.trim()); where.push(`EXISTS (SELECT 1 FROM products p WHERE p.workspace_id=d.workspace_id AND p.id=d.product_id AND p.platform_account_id=$${values.length})`) }
      if (input.storeName?.trim()) { values.push(input.storeName.trim()); where.push(`EXISTS (SELECT 1 FROM products p WHERE p.workspace_id=d.workspace_id AND p.id=d.product_id AND lower(p.store_name)=lower($${values.length}))`) }
      if (terms && !input.queryEmbedding) { values.push(`%${input.query!.trim()}%`); where.push(`(d.extracted_text ILIKE $${values.length} OR EXISTS (SELECT 1 FROM knowledge_chunks c WHERE c.workspace_id=d.workspace_id AND c.document_id=d.id AND c.content ILIKE $${values.length}))`) } // Vector ranking happens in application code because embeddings are stored as JSONB. Fetch the bounded candidate set before ranking so semantic matches are not lost to updated_at ordering.
      const candidateLimit = input.queryEmbedding ? 100 : limit
      values.push(candidateLimit)
      const projection = documentProjection.split(',').map(column => column.trim())
      const scopedProjection = projection.map(column => `d.${column}`).join(',')
      // The batch form caps the candidates *per product* with a window function.
      // A single global `LIMIT` would keep the newest `candidateLimit` rows of
      // the whole page and silently starve every product that sorts later, so
      // the batch response would not be the concatenation of the per-product
      // responses it replaces.
      const result = batch
        ? await client.query<Row>(`SELECT ${projection.join(',')} FROM (SELECT ${scopedProjection}, row_number() OVER (PARTITION BY d.product_id ORDER BY d.updated_at DESC,d.id) AS knowledge_product_rank FROM knowledge_documents d WHERE ${where.join(' AND ')}) ranked WHERE knowledge_product_rank <= $${values.length}`, values)
        : await client.query<Row>(`SELECT ${scopedProjection} FROM knowledge_documents d WHERE ${where.join(' AND ')} ORDER BY d.updated_at DESC,d.id LIMIT $${values.length}`, values)
      if (!result.rows.length) return []
      // One batched read per child table instead of one read per candidate: a
      // vector search ranks up to `candidateLimit` documents (100), so the
      // per-document loop cost up to 200 round trips inside one transaction.
      const documentIds = result.rows.map(row => row.id)
      const chunks = await client.query<Row>(`SELECT * FROM knowledge_chunks WHERE workspace_id=$1 AND document_id = ANY($2::text[]) ORDER BY document_id, ordinal`, [scope, documentIds])
      const embeddings = input.queryEmbedding
        ? await client.query<Row>(`SELECT * FROM knowledge_embeddings WHERE workspace_id=$1 AND document_id = ANY($2::text[]) AND index_state='ready'`, [scope, documentIds])
        : { rows: [] as Row[] }
      const chunksByDocument = groupByDocument(chunks.rows)
      const embeddingsByDocument = groupByDocument(embeddings.rows)
      const rank = (rows: readonly Row[]): KnowledgeSearchResult[] => rankResults(rows.map(row => {
        const rowChunks = chunksByDocument.get(row.id) ?? []
        const rowEmbeddings = embeddingsByDocument.get(row.id) ?? []
        const lexical = terms
          ? (String(row.extracted_text ?? '').toLocaleLowerCase().includes(terms) ? 1 : rowChunks.some(chunk => String(chunk.content ?? '').toLocaleLowerCase().includes(terms)) ? .5 : 0)
          : 0
        const vector = input.queryEmbedding
          ? Math.max(...rowEmbeddings.map(embedding => vectorScore(input.queryEmbedding!, json(embedding.embedding, []))), 0)
          : 0
        return { document: mapDocument(row), chunks: rowChunks.map(mapChunk), score: Math.max(lexical, vector) }
      }), limit)
      if (!batch) return rank(result.rows)
      // Rank each product's slice on its own, then concatenate in the order the
      // caller listed the products: exactly what the per-product calls returned.
      const byProduct = groupRowsBy(result.rows, 'product_id')
      return batch.flatMap(productId => rank(byProduct.get(productId) ?? []))
    }) }
}
