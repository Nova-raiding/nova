import { describe, expect, it } from 'vitest'
import { buildBoundedKnowledgeGenerationContext } from './knowledge-context-runtime.js'
import { MerchantService } from '../../../packages/application/src/service.js'
import { assertGenerationInput } from '../../worker/src/generation-input.js'
import { contextEnvelopeHash } from '../../../packages/persistence/src/context-snapshot-repository.js'

const rawAssets = () => JSON.parse(JSON.stringify([
  { id: 'other-jd-product', kind: 'product_facts', name: '其他商品鞋', content: { size: '42', price_cny: 399.2 }, confirmed: false },
  { id: 'brand', kind: 'brand', name: '品牌表达', content: '谨慎表达', confirmed: false },
  { id: 'customer', kind: 'customer', name: '用户参考', content: '参考意见，不是事实', confirmed: false },
  { id: 'mislabelled-confirmed', kind: 'customer', name: '错误确认标记', content: '不应成为事实', confirmed: true },
]))

describe('generation knowledge runtime kind boundary', () => {
  it('excludes legacy product facts and unsupported kinds before selecting the reference budget', () => {
    const assets = rawAssets().map((asset: Record<string, unknown>) => ({ ...asset, workspaceId: 'ws', approvalStatus: 'approved', rightsStatus: 'cleared', tags: [], revision: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' }))
    const context = buildBoundedKnowledgeGenerationContext({ rules: [], learningSuggestions: [], assets })
    expect(context.assets.map(asset => asset.id)).toEqual(['brand', 'customer', 'mislabelled-confirmed'])
    expect(context.assets.every(asset => asset.confirmed === false)).toBe(true)
    expect(JSON.stringify(context)).not.toContain('399.2')
  })
  it('filters historical frozen snapshots for both queued relay and local host input without rewriting history', async () => {
    const historic = { rules: [], assets: rawAssets().map((asset: Record<string, unknown>) => ({ ...asset, revision: 1 })), confirmedLearningSuggestions: [] }
    let persistedEnvelope: unknown
    const service = new MerchantService({ fixtureMode: true, seedFixture: false,
      knowledgeContextProvider: () => historic,
      contextSnapshotSink: async ({ envelope }) => { persistedEnvelope = structuredClone(envelope) },
    })
    const product = service.importProduct({ workspaceId: 'ws', platform: 'taobao', remoteId: 'qa', title: 'QA主题', stock: 0, skuCount: 0 })
    service.confirmProductFacts('ws', product.id)
    const task = service.createTask({ workspaceId: 'ws', productId: product.id, platform: 'taobao', candidateOnly: true, requestText: '只要纯文本' })
    service.selectDirection(task.id, 'A'); service.confirmProductionPlan('ws', task.id, 'merchant', task.version)
    const before = JSON.stringify(task.inputSnapshot)
    expect(task.inputSnapshot?.knowledgeContext?.assets).toHaveLength(4)
    const prepared = await service.prepareGenerationContext(task.id, 'action')
    expect(prepared.input.knowledgeContext?.assets.map(asset => asset.id)).toEqual(['brand', 'customer'])
    expect(persistedEnvelope).toEqual(prepared.input)
    const parsed = assertGenerationInput(persistedEnvelope, 'ws', 'action', task.id)
    expect(contextEnvelopeHash(parsed as unknown as Record<string, unknown>)).toBe(contextEnvelopeHash(prepared.input as unknown as Record<string, unknown>))
    expect(service.prepareCodexDraft(task.id).knowledgeContext?.assets.map(asset => asset.id)).toEqual(['brand', 'customer'])
    expect(JSON.stringify(task.inputSnapshot)).toBe(before)
    expect(JSON.stringify(prepared.input)).not.toContain('399.2')
  })
})
