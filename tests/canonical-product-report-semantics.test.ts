import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { CanonicalProductConsistencySection } from '../apps/ops-console/src/components/stores/CanonicalProductConsistencySection.js'
import type { CanonicalProductConsistencyReport } from '../apps/ops-console/src/types/ops.js'
import { buildCanonicalChainConsistencyReport } from '../packages/application/src/canonical-product-consistency.js'

const emptyInput = (workspaceId = 'ws_report') => ({
  workspaceId,
  legacyProducts: [],
  canonicalProducts: [],
  listings: [],
  campaignItems: [],
  tasks: [],
  publishJobs: [],
})

const linkedInput = {
  workspaceId: 'ws_report',
  legacyProducts: [{ id: 'legacy_verified', workspaceId: 'ws_report', brandId: 'brand_1', platform: 'taobao', accountId: 'store_1' }],
  canonicalProducts: [{ id: 'canonical_verified', workspaceId: 'ws_report', brandId: 'brand_1', legacyProductId: 'legacy_verified' }],
  listings: [{ id: 'listing_verified', workspaceId: 'ws_report', brandId: 'brand_1', canonicalProductId: 'canonical_verified', platform: 'taobao', accountId: 'store_1' }],
  campaignItems: [{ id: 'campaign_verified', workspaceId: 'ws_report', brandId: 'brand_1', canonicalProductId: 'canonical_verified', listingId: 'listing_verified', platform: 'taobao', accountId: 'store_1' }],
  tasks: [{ id: 'task_verified', workspaceId: 'ws_report', productId: 'legacy_verified', brandId: 'brand_1', canonicalProductId: 'canonical_verified', listingId: 'listing_verified', campaignItemId: 'campaign_verified', platform: 'taobao', accountId: 'store_1' }],
}

const asOpsReport = (report: ReturnType<typeof buildCanonicalChainConsistencyReport>): CanonicalProductConsistencyReport => report

describe('canonical product report release semantics', () => {
  it('keeps the four implemented states independently observable and countable', () => {
    const report = buildCanonicalChainConsistencyReport({
      workspaceId: 'ws_report',
      legacyProducts: [
        ...linkedInput.legacyProducts,
        { id: 'legacy_only', workspaceId: 'ws_report', brandId: 'brand_1' },
        { id: 'legacy_conflict', workspaceId: 'ws_report', brandId: 'brand_1' },
        { id: 'legacy_blocked', workspaceId: 'ws_report', brandId: 'brand_1', platform: 'jd', accountId: 'store_2' },
      ],
      canonicalProducts: [
        ...linkedInput.canonicalProducts,
        { id: 'canonical_conflict_a', workspaceId: 'ws_report', brandId: 'brand_1', legacyProductId: 'legacy_conflict' },
        { id: 'canonical_conflict_b', workspaceId: 'ws_report', brandId: 'brand_1', legacyProductId: 'legacy_conflict' },
        { id: 'canonical_blocked', workspaceId: 'ws_report', brandId: 'brand_1', legacyProductId: 'legacy_blocked' },
      ],
      listings: linkedInput.listings,
      campaignItems: linkedInput.campaignItems,
      tasks: linkedInput.tasks,
      publishJobs: [],
    })

    expect(report.counts).toEqual({ verified: 1, legacy_only: 1, conflict: 1, blocked: 1 })
    expect(new Set(report.findings.map(finding => finding.status))).toEqual(new Set(['verified', 'legacy_only', 'conflict', 'blocked']))
    expect(report.findings.find(finding => finding.status === 'legacy_only')?.codes).toContain('CANONICAL_MAPPING_MISSING')
    expect(report.findings.find(finding => finding.status === 'conflict')?.codes).toContain('CANONICAL_MAPPING_AMBIGUOUS')
    expect(report.findings.find(finding => finding.status === 'blocked')?.codes).toContain('LISTING_MAPPING_MISSING')
  })

  it('treats a real empty result as clean with zero findings, without inventing products', () => {
    expect(buildCanonicalChainConsistencyReport(emptyInput())).toEqual({
      workspaceId: 'ws_report',
      contractVersion: 1,
      contractStatus: 'clean',
      generatedAt: null,
      readMode: 'snapshot',
      freshness: 'unknown',
      revision: null,
      availability: 'available',
      blocking: null,
      status: 'clean',
      counts: { verified: 0, legacy_only: 0, conflict: 0, blocked: 0 },
      findings: [],
      orphanFindings: [],
    })
  })

  it('keeps an absent report visibly distinct from an empty report', () => {
    const markup = renderToStaticMarkup(createElement(CanonicalProductConsistencySection))
    expect(markup).toContain('暂无可验证的一致性报告')
    expect(markup).not.toContain('已验证')
  })

  it('renders every implemented state as text, not color-only status', () => {
    const report = buildCanonicalChainConsistencyReport({
      workspaceId: 'ws_report',
      legacyProducts: [
        ...linkedInput.legacyProducts,
        { id: 'legacy_only', workspaceId: 'ws_report', brandId: 'brand_1' },
        { id: 'legacy_conflict', workspaceId: 'ws_report', brandId: 'brand_1' },
        { id: 'legacy_blocked', workspaceId: 'ws_report', brandId: 'brand_1', platform: 'jd', accountId: 'store_2' },
      ],
      canonicalProducts: [
        ...linkedInput.canonicalProducts,
        { id: 'canonical_conflict_a', workspaceId: 'ws_report', brandId: 'brand_1', legacyProductId: 'legacy_conflict' },
        { id: 'canonical_conflict_b', workspaceId: 'ws_report', brandId: 'brand_1', legacyProductId: 'legacy_conflict' },
        { id: 'canonical_blocked', workspaceId: 'ws_report', brandId: 'brand_1', legacyProductId: 'legacy_blocked' },
      ],
      listings: linkedInput.listings,
      campaignItems: linkedInput.campaignItems,
      tasks: linkedInput.tasks,
      publishJobs: [],
    })
    const markup = renderToStaticMarkup(createElement(CanonicalProductConsistencySection, { report: asOpsReport(report) }))
    for (const label of ['已验证', '仅旧商品', '存在冲突', '已阻断']) expect(markup).toContain(label)
    expect(markup).toContain('存在多个规范商品映射，无法自动判断')
  })

  it('exposes generated_at/read_mode/freshness and finding evidence in the produced report', () => {
    const report = buildCanonicalChainConsistencyReport({
      ...linkedInput,
      evaluation: { generatedAt: '2026-08-31T04:00:00.000Z', readMode: 'live', freshness: 'fresh', revision: 'rev-7' },
    })
    expect(report).toMatchObject({
      generatedAt: '2026-08-31T04:00:00.000Z',
      readMode: 'live',
      freshness: 'fresh',
      revision: 'rev-7',
      availability: 'available',
      findings: [expect.objectContaining({
        contractStatus: 'verified',
        blocking: null,
        nextAction: null,
        evidence: { codes: [], generatedAt: '2026-08-31T04:00:00.000Z', revision: 'rev-7' },
      })],
    })
  })

  it('does not present a clean/verified UI when the report is expired', () => {
    const expired = { ...asOpsReport(buildCanonicalChainConsistencyReport(linkedInput)), status: 'clean' as const, freshness: 'expired' as const }
    const markup = renderToStaticMarkup(createElement(CanonicalProductConsistencySection, { report: expired }))
    expect(markup).toContain('报告已过期')
    expect(markup).toContain('需处理')
  })

  it('distinguishes canonical read failure and missing permission from a truthful empty report', () => {
    const unavailable = { ...asOpsReport(buildCanonicalChainConsistencyReport(emptyInput())), status: 'unavailable' as const, error: { code: 'CANONICAL_READ_FORBIDDEN', message: '当前角色无权读取一致性报告' } }
    const markup = renderToStaticMarkup(createElement(CanonicalProductConsistencySection, { report: unavailable as unknown as CanonicalProductConsistencyReport }))
    expect(markup).toContain('当前角色无权读取一致性报告')
    expect(markup).not.toContain('暂无可验证的一致性报告')
  })
})
