import type { KnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'

export interface DocumentIndexSummary {
  documentCount: number
  liveCount: number
  counts: Record<string, number>
  expiredCount: number
  reviewRequired: number
  truncated: boolean
  complete: boolean
}

/** Read projection only. Stored asset state is a request, not document completion. */
export async function withDocumentIndexSummary<T extends { id: string }>(repository: KnowledgeRepository | undefined, workspaceId: string, assets: readonly T[]): Promise<Array<T & { documentIndexSummary?: DocumentIndexSummary }>> {
  if (!repository || !assets.length) return [...assets]
  const documents = await repository.listDocuments(workspaceId, { knowledgeAssetIds: assets.map(asset => asset.id), limit: 1001 })
  const truncated = documents.length > 1000
  return assets.map(asset => {
    const related = documents.slice(0, 1000).filter(document => document.workspaceId === workspaceId && document.knowledgeAssetId === asset.id)
    const live = related.filter(document => document.indexState !== 'deleted')
    const counts: Record<string, number> = {}
    for (const document of related) counts[document.indexState] = (counts[document.indexState] ?? 0) + 1
    const expiredCount = live.filter(document => document.expiresAt !== undefined && (!Number.isFinite(Date.parse(document.expiresAt)) || Date.parse(document.expiresAt) <= Date.now())).length
    const reviewRequired = live.filter(document => document.approvalStatus !== 'approved' || document.rightsStatus !== 'cleared').length
    return { ...asset, documentIndexSummary: {
      documentCount: related.length, liveCount: live.length, counts, expiredCount, reviewRequired, truncated,
      complete: !truncated && live.length > 0 && expiredCount === 0 && reviewRequired === 0 && live.every(document => document.indexState === 'ready'),
    } }
  })
}
