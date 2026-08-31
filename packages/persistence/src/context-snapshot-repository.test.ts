import { describe, expect, it } from 'vitest'
import { contextEnvelopeHash, MemoryContextSnapshotRepository } from './context-snapshot-repository.js'

describe('context snapshot repository', () => {
  it('deduplicates canonical envelopes while retaining one link per task', async () => {
    const repository = new MemoryContextSnapshotRepository()
    const envelopeA = { product: { stock: 2, title: '商品' }, rules: ['r1'] }
    const envelopeB = { rules: ['r1'], product: { title: '商品', stock: 2 } }
    expect(contextEnvelopeHash(envelopeA)).toBe(contextEnvelopeHash(envelopeB))
    const first = await repository.save({ workspaceId: 'ws_1', brandId: 'brand_1', taskId: 'task_1', envelope: envelopeA, inputTokensEstimate: 20, maxInputTokens: 100, linkId: 'link_1' })
    const second = await repository.save({ workspaceId: 'ws_1', brandId: 'brand_1', taskId: 'task_2', envelope: envelopeB, inputTokensEstimate: 20, maxInputTokens: 100, linkId: 'link_2' })
    expect(second.contextHash).toBe(first.contextHash)
    await expect(repository.getByTask({ workspaceId: 'ws_1', taskId: 'task_2' })).resolves.toMatchObject({ id: 'link_2', brandId: 'brand_1' })
  })

  it('reuses the business blob when only the action audit id changes', async () => {
    const first = { product: { title: '商品', stock: 2 }, usageContext: { workspaceId: 'ws_1', actionId: 'generation:first' } }
    const second = { usageContext: { workspaceId: 'ws_1', actionId: 'generation:retry' }, product: { stock: 2, title: '商品' } }
    expect(contextEnvelopeHash(first)).toBe(contextEnvelopeHash(second))
    const repository = new MemoryContextSnapshotRepository()
    const savedFirst = await repository.save({ workspaceId: 'ws_1', taskId: 'task_1', envelope: first, inputTokensEstimate: 20, maxInputTokens: 100, linkId: 'link_1' })
    const savedSecond = await repository.save({ workspaceId: 'ws_1', taskId: 'task_2', envelope: second, inputTokensEstimate: 20, maxInputTokens: 100, linkId: 'link_2' })
    expect(savedSecond.contextHash).toBe(savedFirst.contextHash)
    expect(savedSecond.envelope).not.toHaveProperty('usageContext')
  })

  it('fails closed on incomplete campaign scope and token budget overflow', async () => {
    const repository = new MemoryContextSnapshotRepository()
    await expect(repository.save({ workspaceId: 'ws_1', brandId: 'brand_1', campaignId: 'campaign_1', envelope: {}, inputTokensEstimate: 1, maxInputTokens: 10 })).rejects.toThrow('CONTEXT_SNAPSHOT_CAMPAIGN_PAIR_REQUIRED')
    await expect(repository.save({ workspaceId: 'ws_1', brandId: 'brand_1', envelope: {}, inputTokensEstimate: 11, maxInputTokens: 10 })).rejects.toThrow('CONTEXT_SNAPSHOT_TOKEN_BUDGET_INVALID')
  })

  it('persists workspace-scoped generation context before brand assignment', async () => {
    const repository = new MemoryContextSnapshotRepository()
    const saved = await repository.save({ workspaceId: 'ws_legacy', taskId: 'task_legacy', envelope: { product: { title: '待归品牌商品' } }, inputTokensEstimate: 12, maxInputTokens: 100 })
    expect(saved).toMatchObject({ workspaceId: 'ws_legacy', taskId: 'task_legacy' })
    expect(saved.brandId).toBeUndefined()
    await expect(repository.getByTask({ workspaceId: 'ws_legacy', taskId: 'task_legacy' })).resolves.toMatchObject({ contextHash: saved.contextHash })
  })
})
