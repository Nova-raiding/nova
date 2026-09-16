import { createHash } from 'node:crypto'
import type { KnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** Promote only reviewed, rights-cleared and hash-verified text to lexical search. */
export async function indexApprovedKnowledge(input: {
  repository: KnowledgeRepository
  workspaceId: string
  limit?: number
  embedding?: {
    model: string
    version: string
    admit?(input: { workspaceId: string; documentId: string; documentRevision: number; contentHash: string; actionId: string; runKey: string }): Promise<void>
    reportOutcome?(input: { workspaceId: string; documentId: string; documentRevision: number; contentHash: string; actionId: string; runKey: string; outcome: 'failed_before_provider' | 'unknown' }): Promise<void>
    embed(input: { texts: readonly string[]; usageContext?: { workspaceId?: string; actionId?: string; runKey?: string } }): Promise<{ embeddings: number[][]; dimensions: number }>
  }
}): Promise<{ ready: number; blocked: number; failed: number }> {
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100)
  const queued = (await input.repository.listDocuments(input.workspaceId, { indexState: 'queued' })).slice(0, limit)
  const result = { ready: 0, blocked: 0, failed: 0 }
  for (const document of queued) {
    if (document.approvalStatus !== 'approved' || document.rightsStatus !== 'cleared') { result.blocked++; continue }
    try {
      const chunks = await input.repository.listChunks(input.workspaceId, document.id)
      const valid = /^[a-f0-9]{64}$/u.test(document.contentHash)
        && sha256(document.extractedText) === document.contentHash
        && chunks.length > 0
        && chunks.every(chunk => chunk.workspaceId === input.workspaceId && chunk.documentId === document.id
          && /^[a-f0-9]{64}$/u.test(chunk.contentHash) && sha256(chunk.content) === chunk.contentHash)
      if (!valid) {
        const failed = await input.repository.transitionQueuedIndexState(input.workspaceId, document.id, 'failed', { revision: document.revision, contentHash: document.contentHash }, 'KNOWLEDGE_CONTENT_HASH_MISMATCH')
        if (failed) result.failed++
        else result.blocked++
        continue
      }
      // Re-read approval after chunk validation; revoked rights never become searchable.
      const current = (await input.repository.listDocuments(input.workspaceId)).find(item => item.id === document.id)
      if (!current || current.indexState !== 'queued' || current.approvalStatus !== 'approved' || current.rightsStatus !== 'cleared' || current.contentHash !== document.contentHash || current.revision !== document.revision) { result.blocked++; continue }
      if (input.embedding) {
        const actionId = `knowledge-embedding:${document.id}:${document.revision}`
        const runKey = `knowledge-index:${document.id}:${document.revision}`
        const binding = { workspaceId: input.workspaceId, documentId: document.id, documentRevision: document.revision, contentHash: document.contentHash, actionId, runKey }
        await input.embedding.admit?.(binding)
        let generated: Awaited<ReturnType<typeof input.embedding.embed>>
        try {
          generated = await input.embedding.embed({ texts: chunks.map(chunk => chunk.content), usageContext: { workspaceId: input.workspaceId, actionId, runKey } })
        } catch (error) {
          const candidate = error as { providerSucceeded?: unknown; providerOutcome?: unknown; providerRequests?: unknown; reconciliationRequired?: unknown; code?: unknown }
          // Release the reservation only with explicit local proof that no
          // provider request was attempted. Every ambiguous failure remains
          // open for reconciliation so replay cannot double-spend.
          const definitelyNotSent = candidate.providerOutcome === 'not_sent' || candidate.providerRequests === 0
          await input.embedding.reportOutcome?.({ ...binding, outcome: definitelyNotSent ? 'failed_before_provider' : 'unknown' })
          throw error
        }
        if (generated.embeddings.length !== chunks.length) throw new Error('KNOWLEDGE_EMBEDDING_COUNT_MISMATCH')
        for (let index = 0; index < chunks.length; index++) {
          const chunk = chunks[index]!
          await input.repository.upsertEmbedding(input.workspaceId, { documentId: document.id, chunkId: chunk.id, expectedDocumentRevision: document.revision, expectedDocumentContentHash: document.contentHash, expectedChunkContentHash: chunk.contentHash, embedding: generated.embeddings[index]!, embeddingModel: input.embedding.model, embeddingVersion: input.embedding.version, vectorMetadata: { dimensions: generated.dimensions, document_revision: document.revision, content_hash: document.contentHash, chunk_hash: chunk.contentHash }, indexState: 'ready' })
        }
      }
      const ready = await input.repository.transitionQueuedIndexState(input.workspaceId, document.id, 'ready', { revision: document.revision, contentHash: document.contentHash }, input.embedding ? 'hash-verified relay vector index' : 'hash-verified lexical index')
      if (ready) result.ready++
      else result.blocked++
    } catch {
      // Database/lease failures must be retried; never report ready on an error.
      result.failed++
    }
  }
  return result
}
