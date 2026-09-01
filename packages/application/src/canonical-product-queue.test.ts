import { describe, expect, it } from 'vitest'
import { buildCanonicalChainConsistencyReport } from './canonical-product-consistency.js'
import { buildCanonicalProductQueue } from './canonical-product-queue.js'

const input = {
  workspaceId: 'ws_1',
  legacyProducts: [{ id: 'product_1', workspaceId: 'ws_1', brandId: 'brand_1', platform: 'taobao', accountId: 'account_1' }],
  canonicalProducts: [{ id: 'canonical_1', workspaceId: 'ws_1', brandId: 'brand_1', legacyProductId: 'product_1' }],
  listings: [{ id: 'listing_1', workspaceId: 'ws_1', brandId: 'brand_1', canonicalProductId: 'canonical_1', platform: 'taobao', accountId: 'account_1' }],
  campaignItems: [],
  tasks: [],
} as const

describe('canonical product queue', () => {
  it('is idempotent when a dry-run report is replayed', () => {
    const report = buildCanonicalChainConsistencyReport(input)
    const page = buildCanonicalProductQueue(input, {
      ...report,
      findings: [...report.findings, ...report.findings],
      orphanFindings: [...report.orphanFindings, ...report.orphanFindings],
    }, { limit: 100 })

    expect(page.items.map(item => item.queueKey)).toEqual([...new Set(page.items.map(item => item.queueKey))])
    expect(page.items).toHaveLength(1)
  })

  it('fails closed for a report from another workspace or an unknown finding', () => {
    const report = buildCanonicalChainConsistencyReport(input)
    expect(() => buildCanonicalProductQueue(input, { ...report, workspaceId: 'ws_other' }, {})).toThrow('CANONICAL_QUEUE_WORKSPACE_MISMATCH')
    expect(() => buildCanonicalProductQueue(input, {
      ...report,
      findings: [{ ...report.findings[0]!, legacyProductId: 'product_other' }],
    }, {})).toThrow('CANONICAL_QUEUE_FINDING_OUTSIDE_WORKSPACE')
  })

  it('fails closed for conflicting duplicate queue entries and invalid cursors', () => {
    const report = buildCanonicalChainConsistencyReport(input)
    const conflicting = { ...report.findings[0]!, status: report.findings[0]!.status === 'verified' ? 'blocked' : 'verified' } as typeof report.findings[number]
    expect(() => buildCanonicalProductQueue(input, { ...report, findings: [report.findings[0]!, conflicting] }, {})).toThrow('CANONICAL_QUEUE_CONFLICTING_DUPLICATE')
    expect(() => buildCanonicalProductQueue(input, report, { cursor: 'not-a-cursor' })).toThrow('CANONICAL_QUEUE_INVALID_CURSOR')
  })

  it('keeps orphan descendant scope available to filters', () => {
    const orphanInput = {
      ...input,
      campaignItems: [{ id: 'campaign_orphan', workspaceId: 'ws_1', brandId: 'brand_1', canonicalProductId: 'canonical_missing', platform: 'taobao', accountId: 'account_1' }],
      tasks: [{ id: 'task_orphan', workspaceId: 'ws_1', productId: 'product_1', campaignItemId: 'campaign_missing', platform: 'taobao', accountId: 'account_1' }],
    }
    const report = buildCanonicalChainConsistencyReport(orphanInput)
    const page = buildCanonicalProductQueue(orphanInput, report, { filters: { platform: 'taobao', accountId: 'account_1' }, limit: 100 })

    expect(page.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ queueKey: 'campaign_item:campaign_orphan', brandId: 'brand_1', platform: 'taobao', accountId: 'account_1' }),
      expect.objectContaining({ queueKey: 'task:task_orphan', legacyProductId: 'product_1', platform: 'taobao', accountId: 'account_1' }),
    ]))
  })
})
