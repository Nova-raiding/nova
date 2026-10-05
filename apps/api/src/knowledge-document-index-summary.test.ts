import { handleMcpKnowledgeMethod } from './mcp-knowledge-handlers.js'
import type { IncomingMessage } from 'node:http'
import { describe, it, expect } from 'vitest'
import { MemoryKnowledgeRepository } from '../../../packages/persistence/src/knowledge.js'
import { withDocumentIndexSummary } from './knowledge-document-index-summary.js'

describe('read-only document index summary', () => {
  async function fixture() {
    const repository = new MemoryKnowledgeRepository()
    const asset = await repository.createAsset({ id: 'a', workspaceId: 'w', kind: 'product_facts', name: 'QA', content: {} })
    await repository.createDocument({ id: 'd', workspaceId: 'w', knowledgeAssetId: 'a', knowledgeType: 'product_facts', extractedText: 'QA', contentHash: 'h', approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
    return { repository, asset }
  }
  it('exposes summary through the authorized MCP list without persisting events', async () => {
    const { repository, asset } = await fixture()
    let checks = 0
    const deps = {
      knowledgeRepository: repository,
      knowledgeForWorkspace: () => ({ queryAssets: () => [asset] }),
      requireOperationsRole: () => { checks++; return 'owner' },
      persistEvent: () => { throw new Error('unexpected write') },
    } as unknown as Parameters<typeof handleMcpKnowledgeMethod>[4]
    const output = await handleMcpKnowledgeMethod('knowledge.asset.list', {}, {} as IncomingMessage, 'w', deps)
    expect(checks).toBe(1)
    expect(output).toMatchObject([{ indexState: 'queued', documentIndexSummary: { complete: true } }])
  })
  it('reports ready documents without changing queued asset or its revision', async () => {
    const { repository, asset } = await fixture()
    const result = await withDocumentIndexSummary(repository, 'w', [asset])
    expect(result[0]).toMatchObject({ indexState: 'queued', documentIndexSummary: { complete: true, liveCount: 1, counts: { ready: 1 } } })
    expect(await repository.getAsset('w', 'a')).toEqual(asset)
  })
  it('does not hide pending siblings, revoked rights or deleted children', async () => {
    const { repository, asset } = await fixture()
    await repository.createDocument({ id: 'pending', workspaceId: 'w', knowledgeAssetId: 'a', knowledgeType: 'product_facts', extractedText: 'QA', contentHash: 'h' })
    expect((await withDocumentIndexSummary(repository, 'w', [asset]))[0]).toMatchObject({ documentIndexSummary: { complete: false, reviewRequired: 1, liveCount: 2 } })
    await repository.transitionIndexState('w', 'pending', 'deleted')
    expect((await withDocumentIndexSummary(repository, 'w', [asset]))[0]).toMatchObject({ documentIndexSummary: { complete: true, counts: { deleted: 1, ready: 1 } } })
    await repository.updateAsset('w', 'a', { rightsStatus: 'restricted' })
    expect((await withDocumentIndexSummary(repository, 'w', [asset]))[0]).toMatchObject({ documentIndexSummary: { complete: false, reviewRequired: 1 } })
  })
  it('never treats empty, foreign or truncated document sets as complete', async () => {
    const { repository, asset } = await fixture()
    expect(await repository.listDocuments('w', { knowledgeAssetIds: [] })).toEqual([])
    expect((await withDocumentIndexSummary(repository, 'other', [asset]))[0]).toMatchObject({ documentIndexSummary: { complete: false, documentCount: 0 } })
    for (let n = 0; n < 1000; n++) await repository.createDocument({ id: `d${n}`, workspaceId: 'w', knowledgeAssetId: 'a', knowledgeType: 'product_facts', extractedText: 'QA', contentHash: 'h', approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready' })
    expect((await withDocumentIndexSummary(repository, 'w', [asset]))[0]).toMatchObject({ documentIndexSummary: { complete: false, truncated: true } })
  })
  it('does not report expired documents as usable', async () => {
    const { repository, asset } = await fixture()
    await repository.createDocument({ id: 'expired', workspaceId: 'w', knowledgeAssetId: 'a', knowledgeType: 'product_facts', extractedText: 'QA', contentHash: 'h', approvalStatus: 'approved', rightsStatus: 'cleared', indexState: 'ready', expiresAt: '2000-01-01T00:00:00Z' })
    expect((await withDocumentIndexSummary(repository, 'w', [asset]))[0]).toMatchObject({ documentIndexSummary: { complete: false, expiredCount: 1 } })
  })
  it('reflects failure and rebuild without asset writes', async () => {
    const { repository, asset } = await fixture()
    await repository.transitionIndexState('w', 'd', 'failed')
    expect((await withDocumentIndexSummary(repository, 'w', [asset]))[0]).toMatchObject({ documentIndexSummary: { complete: false, counts: { failed: 1 } } })
    await repository.rebuildIndex('w')
    expect((await withDocumentIndexSummary(repository, 'w', [asset]))[0]).toMatchObject({ documentIndexSummary: { complete: false, counts: { queued: 1 } } })
  })
})
